"""In-process SSE broadcaster for Atlas.

The watcher runs in a watchdog thread; SSE subscribers are async generators on
the server event loop. ``publish`` bridges the two with
``loop.call_soon_threadsafe``. Reuses the project's established SSE transport
(discovery OD-1: server→browser push already happens via text/event-stream).
"""

from __future__ import annotations

import asyncio
import logging

logger = logging.getLogger(__name__)


class EventBroadcaster:
    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue] = set()
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Remember the server loop so the watcher thread can hand events to it."""
        self._loop = loop

    async def subscribe(self):
        """Async generator of events for one SSE connection."""
        queue: asyncio.Queue = asyncio.Queue()
        self._subscribers.add(queue)
        try:
            while True:
                yield await queue.get()
        finally:
            self._subscribers.discard(queue)

    def publish(self, event: dict) -> None:
        """Fan out an event. Safe to call from any thread."""
        loop = self._loop
        for queue in list(self._subscribers):
            if loop is not None and loop.is_running():
                loop.call_soon_threadsafe(queue.put_nowait, event)
            else:
                try:
                    queue.put_nowait(event)
                except Exception:  # pragma: no cover - full queue is harmless here
                    logger.debug("Atlas event dropped (no running loop)")
