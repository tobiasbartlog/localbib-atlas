"""Atlas Verweise HTTP API (issue #180, slice 5): ``GET /backlinks/{id}`` and
``GET /entities``, plus the chapter-hub Kennzahlen helper the ``/diss/{id}``
route in :mod:`atlas.api` calls into.

Its own module for the same line-budget reason as ``atlas/api_journal.py`` /
``atlas/api_zettel.py``: ``atlas/api.py`` is the one file on the line-budget
allowlist and must not grow further. ``api.py`` mounts this sub-router with
``router.include_router(build_links_router(store))`` under the same
``/api/plugins/atlas`` prefix, giving routes ``/api/plugins/atlas/backlinks/{id}`` and
``/api/plugins/atlas/entities``.

Orchestration only — the heavy lifting (the ``links`` edge table, grouping by
source kind) already lives in ``AtlasStore.backlinks``/``AtlasStore.entities``
(``atlas/index_links.py``, ADR-0020). This module adds the wire shape on top:
``exists`` on a backlinks response (an unknown target is not a 404 — a
Rueckverweis to a deleted entity is exactly the interesting case, so the
caller learns "dangling" from ``exists: false``, not from an error) and the
``q`` substring filter on entities (id or title, case-insensitive).

``POST /entities/{kind}/{id}/open`` and ``…/reveal`` hand an entity's own
Markdown file to the system (open it in the default app / show it selected in
the file manager) — the "⋯" menu of every detail page. Explicit user actions,
nothing is read or written; ids are only unique per kind, hence the kind.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from atlas import documents

ERR_ENTITY_NOT_FOUND = "error.atlas.entity_not_found"
ERR_KIND_INVALID = "error.atlas.kind_invalid"


def chapter_metrics(store, node) -> dict:
    """Kennzahlen for the chapter hub (story 52): ``zettel_count`` (Zettel
    linking to this chapter via ``[[id]]``), ``open_task_count`` (open Tasks
    anchored on it, a done Task does not count), ``ref_count``/``refs_all``
    (distinct cite keys, story 51: the chapter's own literature — the
    bibliography (``refs``) of every Publication assigned to it — merged with
    the ``refs`` of every Zettel linking to it) and ``modified_at`` (the
    file's mtime, ISO 8601)."""
    backlinks = store.backlinks(node.id)
    zettel_ids = [z["id"] for z in backlinks.get("zettel", [])]

    own_refs: set[str] = set()
    for pub_id in node.publications:
        publication = store.get_publication(pub_id)
        if publication is not None:
            own_refs.update(publication.refs)

    zettel_refs: set[str] = set()
    for zettel_id in zettel_ids:
        zettel = store.get_zettel(zettel_id)
        if zettel is not None:
            zettel_refs.update(zettel.refs)

    refs_all = sorted(own_refs | zettel_refs)

    modified_at: Optional[str] = None
    if node.path:
        try:
            mtime = Path(node.path).stat().st_mtime
        except OSError:
            mtime = None
        if mtime is not None:
            modified_at = datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat()

    return {
        "zettel_count": len(zettel_ids),
        "open_task_count": len(store.tasks_for_anchor(node.id, open_only=True)),
        "ref_count": len(refs_all),
        "refs_all": refs_all,
        "modified_at": modified_at,
    }


def build_links_router(store) -> APIRouter:
    """The Verweise part of the Atlas API. Mounted by ``api.build_router``."""
    router = APIRouter(tags=["atlas-links"])

    @router.get("/backlinks/{target_id}")
    async def get_backlinks(target_id: str):
        """Rueckverweise of ``target_id``, grouped by source kind
        (``chapters``, ``publications``, ``projects``, ``ideas``, ``zettel``,
        ``tasks``). An unknown id is not a 404 — Rueckverweise to a deleted
        entity are exactly the interesting case (ADR-0020) — so callers check
        ``exists`` instead to flag a dangling target on a detail page."""
        groups = store.backlinks(target_id)
        known = {e["id"] for e in store.entities()}
        return {**groups, "exists": target_id in known}

    @router.get("/entities")
    async def list_entities(q: Optional[str] = Query(None)):
        """``{id, kind, title}`` of every Atlas entity — the source of the
        ``[[`` suggestion list. The SPA caches the full list, so an empty
        ``q`` intentionally returns everything (no cap), sorted by title;
        ``q`` filters case-insensitively on id and title (substring)."""
        items = store.entities()
        needle = (q or "").strip().lower()
        if needle:
            items = [
                e for e in items
                if needle in e["id"].lower() or needle in e["title"].lower()
            ]
        items = sorted(items, key=lambda e: (e["title"] or "").lower())
        return {"entities": items}

    getters = {
        "publication": store.get_publication,
        "project": store.get_project,
        "idea": store.get_idea,
        "diss_node": store.get_node,
        "zettel": store.get_zettel,
    }

    def _entity_file(kind: str, entity_id: str) -> Path:
        getter = getters.get(kind)
        if getter is None:
            raise HTTPException(status_code=422, detail=ERR_KIND_INVALID)
        entity = getter(entity_id)
        path = Path(entity.path) if entity is not None and entity.path else None
        if path is None or not path.is_file():
            raise HTTPException(status_code=404, detail=ERR_ENTITY_NOT_FOUND)
        return path

    @router.post("/entities/{kind}/{entity_id}/open")
    async def open_entity_file(kind: str, entity_id: str):
        documents.open_in_viewer(_entity_file(kind, entity_id))
        return {"status": "ok"}

    @router.post("/entities/{kind}/{entity_id}/reveal")
    async def reveal_entity_file(kind: str, entity_id: str):
        documents.reveal_in_folder(_entity_file(kind, entity_id))
        return {"status": "ok"}

    return router
