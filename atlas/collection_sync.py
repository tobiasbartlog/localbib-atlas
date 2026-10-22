"""Following the core's Collections (ADR-0022, issue #205).

Two jobs, both small:

- :func:`reconcile_tombstones` — a Collection the core has deleted (tombstone)
  turns an existing Atlas file into a normal Publication/Project once: the
  frozen membership becomes Cite-Key ``refs``, the Collection link goes. Runs
  at activation (Atlas may have been off while the Collection was deleted)
  and after Collection events. Idempotent: a converted file has no
  ``collection_id`` any more, so a second pass finds nothing. Without a file
  there is nothing to do — an unplanned Collection was never an entry
  (ADR-0025). A file is never deleted here.
- :class:`CollectionSync` — the ``LibraryApi.on_change`` listener. The core
  calls it synchronously right after its commit, and events come in bursts (a
  migration emits one ``members_changed`` per Item), so the callback only
  arms a short timer; the timer coalesces the burst into ONE reconcile and ONE
  ``archive-changed`` broadcast (kind ``collection``) that makes the SPA
  reload. Nothing heavy, nothing raising, inside the callback.
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Callable, Optional

try:
    from plugin_api import COLLECTION_EVENT
except ImportError:  # a host before contract 2.1 — it never sends these events
    COLLECTION_EVENT = "collection"

from atlas import collection_entries
from atlas.domain import Project
from atlas.entity_store import FileChanged

logger = logging.getLogger(__name__)

DEBOUNCE_SECONDS = 0.4


def reconcile_tombstones(store, source) -> list[str]:
    """Freeze every Collection-linked file whose Collection is deleted.
    Returns the ids of the converted files (empty on a second pass). A file
    with a hand edit the index has not read is skipped (logged) and the rest
    converted; it follows on a later pass, once the edit is read."""
    if source is None or not source.available:
        return []
    converted: list[str] = []
    for entity in store.collection_files():
        collection = source.get(entity.collection_id)
        if not collection or not collection.get("deleted"):
            continue
        frozen = collection_entries.freeze(entity, collection, source.refs(entity.collection_id))
        try:
            if isinstance(frozen, Project):
                store.index_project_file(store.save_project_file(frozen))
            else:
                store.index_publication_file(store.save_publication_file(frozen))
        except FileChanged as exc:
            logger.warning("Atlas: %s nicht eingefroren, Hand-Edit noch nicht eingelesen: %s",
                           exc.file, exc.reason)
            continue
        converted.append(frozen.id)
        logger.info(
            "Atlas: Sammlung %s geloescht — %s ist jetzt ein normaler Eintrag "
            "mit %d refs", collection.get("id"), frozen.id, len(frozen.refs),
        )
    return converted


class CollectionSync:
    """Debounced follower of the core's Collection events."""

    def __init__(
        self,
        reconcile: Callable[[], Any],
        publish: Callable[[dict], None],
        *,
        delay: float = DEBOUNCE_SECONDS,
        timer_factory: Callable[..., Any] = threading.Timer,
    ) -> None:
        self._reconcile = reconcile
        self._publish = publish
        self._delay = delay
        self._timer_factory = timer_factory
        self._lock = threading.Lock()
        self._timer: Optional[Any] = None
        self._closed = False
        self.runs = 0  # how many coalesced passes ran — for tests and logs

    def on_event(self, event: dict) -> None:
        """The ``on_change`` callback: cheap, never raises."""
        try:
            if not isinstance(event, dict) or event.get("type") != COLLECTION_EVENT:
                return
            with self._lock:
                if self._closed or self._timer is not None:
                    return  # already scheduled — the burst is coalesced
                timer = self._timer_factory(self._delay, self._fire)
                if hasattr(timer, "daemon"):
                    timer.daemon = True
                self._timer = timer
            timer.start()
        except Exception:  # noqa: BLE001 - must never raise into the core's commit path
            logger.exception("Atlas: Sammlungs-Ereignis nicht verarbeitet")

    @property
    def pending(self) -> bool:
        return self._timer is not None

    def flush(self) -> None:
        """Run a pending pass now (instead of waiting for the timer)."""
        with self._lock:
            timer, self._timer = self._timer, None
        if timer is None:
            return
        cancel = getattr(timer, "cancel", None)
        if cancel is not None:
            cancel()
        self._run()

    def close(self) -> None:
        """Stop for good (deactivate): cancel a pending pass, ignore events."""
        with self._lock:
            self._closed = True
            timer, self._timer = self._timer, None
        if timer is not None and hasattr(timer, "cancel"):
            timer.cancel()

    def _fire(self) -> None:
        with self._lock:
            if self._closed or self._timer is None:
                return
            self._timer = None
        self._run()

    def _run(self) -> None:
        self.runs += 1
        try:
            self._reconcile()
        except Exception:  # noqa: BLE001 - a failed pass is retried on the next event/start
            logger.exception("Atlas: Abgleich mit den Sammlungen fehlgeschlagen")
        try:
            self._publish({"type": "archive-changed", "kind": "collection"})
        except Exception:  # noqa: BLE001
            logger.exception("Atlas: Sammlungs-Ereignis nicht gesendet")
