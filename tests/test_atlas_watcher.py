"""Atlas watcher integration test — the Phase 1 acceptance behaviour:
an external edit to a Markdown file updates the index and emits an SSE event.

Uses a real watchdog Observer; allows a generous timeout for filesystem-event
latency. asyncio is driven via asyncio.run (no pytest-asyncio dependency).
"""
from __future__ import annotations

import asyncio

import pytest

from atlas import config as atlas_config
from atlas import config
from atlas.domain import Idea
from atlas.events import EventBroadcaster
from atlas.journal import Journal
from atlas.store import AtlasStore
from atlas.watcher import IdeaWatcher
from atlas.zettel import new_zettel


@pytest.fixture
def atlas_env(tmp_path, monkeypatch):
    monkeypatch.setattr(atlas_config, "_base_dir", str(tmp_path))
    config.ensure_dirs()
    return tmp_path


def _watch(store, directory, write, *, recursive=False) -> list[dict]:
    """Run ``write()`` under a live watcher and return the events it produced."""
    received: list[dict] = []

    async def scenario():
        broadcaster = EventBroadcaster()
        broadcaster.bind_loop(asyncio.get_running_loop())
        watcher = IdeaWatcher(
            store, directory,
            lambda kind: broadcaster.publish({"type": "archive-changed", "kind": kind}),
            recursive=recursive,
        )
        watcher.start()
        try:
            async def collect():
                async for event in broadcaster.subscribe():
                    received.append(event)
                    return

            task = asyncio.create_task(collect())
            await asyncio.sleep(0.3)  # let the observer settle
            write()
            await asyncio.wait_for(task, timeout=8)
        finally:
            watcher.stop()

    asyncio.run(scenario())
    return received


def test_external_edit_indexes_and_emits_event(atlas_env):
    store = AtlasStore()

    def write():
        (config.ideas_dir() / "extern.md").write_text(
            Idea(id="extern", title="Extern", type="paper-idea", status="seed").to_markdown(),
            encoding="utf-8",
        )

    received = _watch(store, config.ideas_dir(), write)

    assert received == [{"type": "archive-changed", "kind": "idea"}]
    indexed = store.get_idea("extern")
    assert indexed is not None
    assert indexed.title == "Extern"


def test_external_zettel_is_indexed_and_event_carries_kind(atlas_env):
    """User story 47: a Zettel written in Obsidian is picked up by Atlas."""
    store = AtlasStore()
    zettel = new_zettel("Betreuergespraech")

    def write():
        (config.zettel_dir() / f"{zettel.id}.md").write_text(
            zettel.to_markdown(), encoding="utf-8"
        )

    received = _watch(store, config.base_dir(), write, recursive=True)

    assert received == [{"type": "archive-changed", "kind": "zettel"}]
    assert store.get_zettel(zettel.id).title == "Betreuergespraech"


def test_external_journal_edit_is_indexed_and_event_carries_kind(atlas_env):
    """User story 60/64: a week file edited by hand shows up in the index."""
    store = AtlasStore()
    journal = Journal(week="2026-W39", body="## Mittwoch 2026-09-23\n- [x] Von Hand\n")

    def write():
        (config.journal_dir() / "2026-W39.md").write_text(
            journal.to_markdown(), encoding="utf-8"
        )

    received = _watch(store, config.base_dir(), write, recursive=True)

    assert received == [{"type": "archive-changed", "kind": "journal"}]
    tasks = store.list_journal_tasks()
    assert [(t["text"], t["done"]) for t in tasks] == [("Von Hand", True)]
