"""Atlas file watcher — keeps atlas.db in sync with the archive folder.

Atlas runs its own ``watchdog.Observer`` (discovery OD-1/A3: the core watcher is
CLI-only and inactive in the web server, so Atlas owns one for its archive). Any
change to a ``*.md`` file routes through the store's single write path, then
fires ``on_change(kind)`` so the SSE broadcaster can notify the SPA —
implementing the "externer Edit → UI aktualisiert" acceptance of Phase 1.

``kind`` is the entity art of the changed file (``journal``, ``zettel``,
``idea``, …, ``archive`` when the folder says nothing). The SPA uses it to
reload Heute/Woche selectively instead of everything (issue #180).

A single save is several filesystem events: an in-place write is a truncate
(``modified``, file empty) and then the content (``modified`` again), a
safe-save is create + delete + rename. Indexing on the first event reads a
half-written file and can commit it *after* the writer's own index. So events
are **debounced per path**: every event (re)starts a short timer, and only when
the path has been quiet for ``DEBOUNCE_SECONDS`` is it synced once — indexed if
it exists, removed from the index if it does not. The sync runs under the
store's write lock (``AtlasStore.index_path``/``remove_path``), so it can never
interleave with Atlas' own save-then-index.
"""

from __future__ import annotations

import logging
import os
import threading
from pathlib import Path
from typing import Callable

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from atlas import config

logger = logging.getLogger(__name__)

KIND_ARCHIVE = "archive"

# How long a path must be quiet before it is synced. Long enough to cover the
# gap between the events of one save, short enough to feel immediate.
DEBOUNCE_SECONDS = 0.2

# Folder → entity kind. The Journal and the Zettel folders join the four
# classic entity folders here (issue #180); everything else stays "archive".
def _kind_for(path) -> str:
    parent = Path(path).parent
    for dir_fn, kind in (
        (config.ideas_dir, "idea"),
        (config.diss_dir, "diss_node"),
        (config.projects_dir, "project"),
        (config.publications_dir, "publication"),
        (config.zettel_dir, "zettel"),
        (config.journal_dir, "journal"),
        (config.manuscripts_dir, "manuscript"),
    ):
        if parent == dir_fn():
            return kind
    if parent.parent == config.projects_dir():
        return "project_document"
    return KIND_ARCHIVE


class _IdeaEventHandler(FileSystemEventHandler):
    def __init__(
        self, store, on_change: Callable[[str], None], delay: float = DEBOUNCE_SECONDS
    ) -> None:
        self._store = store
        self._on_change = on_change
        self._delay = delay
        self._timers: dict[str, threading.Timer] = {}
        self._lock = threading.Lock()
        self._closed = False

    @staticmethod
    def _is_markdown(path) -> bool:
        return str(path).lower().endswith(".md")

    @staticmethod
    def _is_manuscript(path) -> bool:
        # .tex manuscripts are not indexed (no DB), but external edits still
        # need an SSE ping so an open editor can offer to reload.
        return str(path).lower().endswith(".tex")

    @staticmethod
    def _is_project_document(path) -> bool:
        # Project documents live in projekte/<id>/ (issue #49). They are never
        # indexed — the listing reads the directory — but external drops get an
        # SSE ping so an open detail page refreshes. Only direct children of a
        # project subfolder count; .atlas/ etc. stay silent.
        return Path(path).parent.parent == config.projects_dir()

    def on_created(self, event) -> None:
        if not event.is_directory:
            self._schedule(event.src_path)

    def on_modified(self, event) -> None:
        if not event.is_directory:
            self._schedule(event.src_path)

    def on_deleted(self, event) -> None:
        if not event.is_directory:
            self._schedule(event.src_path)

    def on_moved(self, event) -> None:
        if not event.is_directory:
            self._schedule(event.src_path)
            self._schedule(event.dest_path)

    # --- debounce -----------------------------------------------------------
    def _schedule(self, path) -> None:
        """(Re)start the quiet timer of ``path``; the sync runs when it fires."""
        path = str(path)
        try:
            relevant = (
                self._is_markdown(path)
                or self._is_manuscript(path)
                or self._is_project_document(path)
            )
        except RuntimeError:
            return  # Atlas deactivated meanwhile: no folder, nothing to sync
        if not relevant:
            return
        with self._lock:
            if self._closed:
                return
            pending = self._timers.get(path)
            if pending is not None:
                pending.cancel()
            timer = threading.Timer(self._delay, self._fire, args=(path,))
            timer.daemon = True
            self._timers[path] = timer
            timer.start()

    def _fire(self, path: str) -> None:
        me = threading.current_thread()
        with self._lock:
            if self._closed or self._timers.get(path) is not me:
                return  # superseded by a newer event, or the watcher stopped
        try:
            self._sync(path)
        except Exception as exc:  # noqa: BLE001 - never let a bad file kill the watcher
            logger.warning("Atlas sync failed for %s: %s", path, exc)
        finally:
            with self._lock:
                if self._timers.get(path) is me:
                    del self._timers[path]

    def close(self) -> None:
        """Drop pending syncs and wait for a running one (residue-free stop)."""
        with self._lock:
            self._closed = True
            timers = list(self._timers.values())
            self._timers.clear()
        for timer in timers:
            timer.cancel()
            if timer is not threading.current_thread():
                timer.join(timeout=2)

    # --- sync ---------------------------------------------------------------
    def _sync(self, path: str) -> None:
        """Bring the index in line with what is on disk *now* — one event."""
        if self._is_manuscript(path) or self._is_project_document(path):
            self._on_change(_kind_for(path))
            return
        if not self._is_markdown(path):
            return
        try:
            if os.path.exists(path):
                self._store.index_path(path)  # routes by folder (ideas … journal)
            else:
                self._store.remove_path(path)
        except FileNotFoundError:
            self._store.remove_path(path)  # deleted between the check and the read
        except Exception as exc:  # noqa: BLE001 - never let a bad file kill the watcher
            logger.warning("Atlas index failed for %s: %s", path, exc)
        self._on_change(_kind_for(path))


class IdeaWatcher:
    """Lifecycle wrapper around a watchdog Observer (start/stop, residue-free).

    Watch the whole archive recursively (recursive=True) so every entity folder
    — ideen/, dissertation/, projekte/, veroeffentlichungen/, journal/, zettel/
    — is covered; the store routes each file by folder. The derived
    .atlas/atlas.db is never a .md file, so DB writes don't trigger re-indexing."""

    def __init__(self, store, directory, on_change: Callable[[str], None], recursive: bool = False) -> None:
        self._observer = Observer()
        self._handler = _IdeaEventHandler(store, on_change)
        self._directory = str(directory)
        self._recursive = recursive

    def start(self) -> None:
        self._observer.schedule(self._handler, self._directory, recursive=self._recursive)
        self._observer.start()

    def stop(self) -> None:
        try:
            self._observer.stop()
            self._observer.join(timeout=2)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Atlas watcher stop failed: %s", exc)
        self._handler.close()
