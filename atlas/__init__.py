"""Atlas — LocalBib Add-on (Ideen-Kern), shipped as a Bundle under ``plugins/atlas``.

Ideen · Dissertationsstruktur · Projekte · Werkbank.
The Manifest is ``plugin.json`` at the Bundle root (ADR-0021); the core loads
this package from an installed Bundle or a Dev-Suchpfad and mounts its router
under ``/api/plugins/atlas/``.

activate() reindexes the archive, starts the file watcher, and registers the
"Atlas" nav item + the HTTP router. deactivate() stops the watcher; the core
registry drops the nav item and unmounts the router (residue-free).

P3 boundary: this package imports **only** from ``plugin_api`` (plus stdlib and
third-party libs like fastapi/watchdog/yaml), never from the core (``webapp``,
``literature_manager``, ...). Enforced by ``.importlinter``.

Heavy imports (store/watcher/api) live inside ``activate`` so that, while Atlas
is disabled, the package is never imported at all and pulls in nothing.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from plugin_api import PluginApi, load_manifest

logger = logging.getLogger(__name__)

BUNDLE_ROOT = Path(__file__).resolve().parent.parent

# The nav item (label key, compass icon, route ``/atlas``, view ``atlas.today``)
# is the Manifest's ``nav``; the view itself is registered by the Bundle's
# frontend script (``frontend/atlas.js``, #192).


class AtlasPlugin:
    manifest = load_manifest(BUNDLE_ROOT)

    def __init__(self) -> None:
        self._store = None
        self._watcher = None
        self._broadcaster = None
        self._collection_sync = None
        self._unsubscribe = None

    async def activate(self, api: PluginApi) -> None:
        from atlas import config
        from atlas.api import build_router
        from atlas.collection_entries import CollectionSource
        from atlas.collection_sync import CollectionSync, reconcile_tombstones
        from atlas.events import EventBroadcaster
        from atlas.migration import (
            migrate_core_projects,
            migrate_legacy_dissnodes,
            migrate_legacy_ideas,
            migrate_legacy_projects,
        )
        from atlas.store import AtlasStore
        from atlas.watcher import IdeaWatcher

        settings = getattr(api, "settings", None)
        core = settings.core() if settings is not None else None
        base = config.resolve_base_dir(
            settings.get("base_dir") if settings is not None else None,
            core.base_dir if core is not None else None,
        )
        if base is None:
            raise RuntimeError(
                "Atlas: kein Ordner konfiguriert (Einstellung base_dir leer, "
                "kein Basisordner vom Kern)"
            )
        config.configure(base)
        config.ensure_dirs()

        # Startup migration (ADR-0004, issue #43): legacy atlas.project/1|2
        # files become atlas.publication/1 in veroeffentlichungen/. Runs before
        # the first reindex (so migrated files index as publications) and before
        # the watcher starts. Idempotent; backs up the Atlas folder before the
        # first write. A failure must never block activation — legacy files
        # stay untouched and are retried on the next startup.
        try:
            report = migrate_legacy_projects()
            if report["migrated"]:
                logger.info(
                    "Atlas-Migration: %d Legacy-Projekt(e) nach Veroeffentlichungen "
                    "verschoben (Backup: %s)",
                    report["migrated"],
                    report["backup"],
                )
                for mapping in report["lossy_mappings"]:
                    logger.warning(
                        "Atlas-Migration: verlustbehaftetes Status-Mapping %s: "
                        "'%s' -> '%s'",
                        mapping["file"],
                        mapping["from"],
                        mapping["to"],
                    )
            for warning in report["warnings"]:
                logger.warning("Atlas-Migration: %s", warning)
        except Exception:  # noqa: BLE001 - never block activate
            logger.exception(
                "Atlas-Migration fehlgeschlagen — Legacy-Dateien bleiben unveraendert"
            )

        # Idea statuses v2 (issue #46): atlas.idea/1 files are rewritten in
        # place (drafting -> developing, published -> promoted). Same contract
        # as above: idempotent, backup before the first write, failures never
        # block activation.
        try:
            idea_report = migrate_legacy_ideas()
            if idea_report["migrated"]:
                logger.info(
                    "Atlas-Migration: %d Idee(n) auf atlas.idea/2 aktualisiert "
                    "(Backup: %s)",
                    idea_report["migrated"],
                    idea_report["backup"],
                )
            for warning in idea_report["warnings"]:
                logger.warning("Atlas-Migration: %s", warning)
        except Exception:  # noqa: BLE001 - never block activate
            logger.exception(
                "Atlas-Ideen-Migration fehlgeschlagen — Legacy-Dateien bleiben "
                "unveraendert"
            )

        # Dissertation flattening v3 (issue #57, ADR-0005): atlas.dissnode/1|2
        # files are flattened depth-first into a single ``order`` sequence and
        # rewritten in place as /3 (kind/parent dropped). Legacy /1 paper_ref
        # values are surfaced as a warning list for manual re-linking — never
        # auto-converted into publication links. Same contract as above:
        # idempotent, backup before the first write, failures never block
        # activation.
        try:
            diss_report = migrate_legacy_dissnodes()
            if diss_report["migrated"]:
                logger.info(
                    "Atlas-Migration: %d Diss-Knoten auf atlas.dissnode/3 "
                    "abgeflacht (Backup: %s)",
                    diss_report["migrated"],
                    diss_report["backup"],
                )
            for entry in diss_report["paper_refs"]:
                logger.warning(
                    "Atlas-Migration: Knoten '%s' verlor paper_ref '%s' — "
                    "bitte manuell als Veroeffentlichung neu verknuepfen "
                    "(Hinweis steht im Knoten-Text)",
                    entry["id"],
                    entry["paper_ref"],
                )
            for warning in diss_report["warnings"]:
                logger.warning("Atlas-Migration: %s", warning)
        except Exception:  # noqa: BLE001 - never block activate
            logger.exception(
                "Atlas-Diss-Knoten-Migration fehlgeschlagen — Legacy-Dateien "
                "bleiben unveraendert"
            )

        # Core paper-grouping projects (issue #51, ADR-0004): each becomes an
        # atlas.project/3 research project with refs = the grouped papers' Cite
        # Keys. Read access strictly via the PluginApi library facade (P3); the
        # core rows stay as dead data. One-shot via marker file in the Atlas
        # folder; same contract as above — backup before the first write,
        # failures never block activation.
        try:
            core_report = migrate_core_projects(getattr(api, "library", None))
            if core_report["migrated"]:
                logger.info(
                    "Atlas-Migration: %d Kern-Projekt(e) als Forschungsprojekte "
                    "angelegt (Backup: %s)",
                    core_report["migrated"],
                    core_report["backup"],
                )
            for warning in core_report["warnings"]:
                logger.warning("Atlas-Migration: %s", warning)
        except Exception:  # noqa: BLE001 - never block activate
            logger.exception(
                "Atlas-Kern-Projekt-Migration fehlgeschlagen — Kern-Projekte "
                "bleiben unveraendert"
            )

        self._store = AtlasStore()
        self._store.reindex()

        self._broadcaster = EventBroadcaster()
        try:
            self._broadcaster.bind_loop(asyncio.get_running_loop())
        except RuntimeError:
            pass  # no running loop (e.g. sync activation) — publish() degrades gracefully

        # The core's Collections (ADR-0022, issue #205): read live at every
        # list/detail (so all of them show up right after installing Atlas),
        # followed through on_change. A host before contract 2.1 has neither —
        # Atlas then simply shows no Collection entries.
        library = getattr(api, "library", None)
        source = CollectionSource(library)
        self._store.attach_collections(source)
        try:
            reconcile_tombstones(self._store, self._store.collections)
        except Exception:  # noqa: BLE001 - never block activate; retried on the next event/start
            logger.exception("Atlas: Abgleich geloeschter Sammlungen fehlgeschlagen")
        store, broadcaster = self._store, self._broadcaster
        self._collection_sync = CollectionSync(
            lambda: reconcile_tombstones(store, store.collections),
            broadcaster.publish,
        )
        subscribe = getattr(library, "on_change", None) if source.available else None
        if callable(subscribe):
            self._unsubscribe = subscribe(self._collection_sync.on_event)

        self._watcher = IdeaWatcher(
            self._store,
            config.base_dir(),
            # The event carries the entity kind of the changed file so the SPA
            # can reload Heute/Woche selectively (issue #180).
            lambda kind: self._broadcaster.publish(
                {"type": "archive-changed", "kind": kind}
            ),
            recursive=True,  # covers every entity folder, journal/ and zettel/ included
        )
        try:
            self._watcher.start()
        except Exception as exc:  # noqa: BLE001 - watcher is best-effort, never block activate
            logger.warning("Atlas-Watcher konnte nicht starten: %s", exc)
            self._watcher = None

        api.routes.register_router(
            build_router(
                self._store,
                self._broadcaster,
                # Host services (Phase 4) — absent on hosts older than the contract.
                llm=getattr(api, "llm", None),
                library=getattr(api, "library", None),
                settings=settings,  # "Dein Name" of the Publikationsliste (#228)
            )
        )
        if self.manifest.nav is not None:
            api.ui.register_nav_item(self.manifest.nav)

    async def deactivate(self) -> None:
        # Stop our own resources; the registry drops nav item + router.
        # The Collection listener goes first, so no event can arm a new pass.
        if self._unsubscribe is not None:
            try:
                self._unsubscribe()
            except Exception:  # noqa: BLE001 - deactivate must always finish
                logger.exception("Atlas: Sammlungs-Listener nicht abgemeldet")
            self._unsubscribe = None
        if self._collection_sync is not None:
            self._collection_sync.close()
            self._collection_sync = None
        if self._watcher is not None:
            self._watcher.stop()
            self._watcher = None
        self._store = None
        self._broadcaster = None
        from atlas import config

        config.configure(None)


# The core registry loads this module and reads ``plugin``.
plugin = AtlasPlugin()
