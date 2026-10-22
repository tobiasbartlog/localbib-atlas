"""A cross-week Uebertrag is all or nothing (architecture review 2026-10-18).

Moving a Task into another week writes two week files, and so does taking the
move back. A week file can be locked (OneDrive sync, an open editor) — then
the second write fails. The rule: no moment and no failure leaves the Task
open nowhere. The write that keeps it open goes first (move: the target week
gets the carried line; undo: the source loses its ``→``); when the second
write fails, the first file gets its exact previous bytes back and the error
goes up (the API answers 423 ``error.atlas.document_locked``). If even that
fails, the worst case is the Task open twice — never lost.
"""
from __future__ import annotations

import logging
from pathlib import Path
from types import SimpleNamespace

import pytest

from atlas import config as atlas_config
from atlas import config
from atlas.store import AtlasStore
from atlas.weeks import week_id

WEDNESDAY = "2026-09-23"
FRIDAY = "2026-09-25"
SUNDAY = "2026-09-27"
NEXT_MONDAY = "2026-09-28"
WEEK = week_id(WEDNESDAY)
NEXT_WEEK = week_id(NEXT_MONDAY)
LOCKED = "error.atlas.document_locked"


@pytest.fixture
def locks(monkeypatch):
    """Week files a writer holds: writing or deleting a locked path raises
    ``PermissionError``. ``locks.lock(path, after=n)`` lets n writes through
    first — the lock grabs the file in the middle of the operation."""
    allowed: dict[Path, int] = {}

    def guard(method: str) -> None:
        original = getattr(Path, method)

        def wrapper(self, *args, **kwargs):
            key = Path(self)
            if key in allowed:
                if allowed[key] <= 0:
                    raise PermissionError(13, "gesperrt", str(self))
                allowed[key] -= 1
            return original(self, *args, **kwargs)

        monkeypatch.setattr(Path, method, wrapper)

    for method in ("write_text", "write_bytes", "unlink"):
        guard(method)
    return SimpleNamespace(
        lock=lambda path, after=0: allowed.__setitem__(Path(path), after),
        unlock=lambda path: allowed.pop(Path(path), None),
    )


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(atlas_config, "_base_dir", str(tmp_path))
    config.ensure_dirs()
    return AtlasStore()


def week_file(week: str) -> Path:
    return config.journal_dir() / f"{week}.md"


def snapshot(*weeks: str) -> dict:
    """The bytes of each week file (None: no file)."""
    return {w: week_file(w).read_bytes() if week_file(w).exists() else None for w in weeks}


def indexed(store) -> list[tuple]:
    return [(t["week"], t["text"], t["open"]) for t in store.list_journal_tasks()]


# --- move ----------------------------------------------------------------------

def test_a_failed_source_write_removes_the_target_week_it_just_created(store, locks):
    store.add_task(WEEK, WEDNESDAY, "Mail an Betreuer")
    before = snapshot(WEEK, NEXT_WEEK)
    locks.lock(week_file(WEEK))

    with pytest.raises(PermissionError):
        store.move_task(WEEK, 0, NEXT_MONDAY)

    assert snapshot(WEEK, NEXT_WEEK) == before  # the new week file is gone again
    assert indexed(store) == [(WEEK, "Mail an Betreuer", True)]
    assert [w["week"] for w in store.list_journal_weeks()] == [WEEK]


def test_a_failed_source_write_restores_an_existing_target_week_byte_for_byte(store, locks):
    store.add_task(NEXT_WEEK, NEXT_MONDAY, "Schon da")
    store.add_task(WEEK, WEDNESDAY, "Mail an Betreuer")
    before = snapshot(WEEK, NEXT_WEEK)
    locks.lock(week_file(WEEK))

    with pytest.raises(PermissionError):
        store.move_task(WEEK, 0, NEXT_MONDAY)

    assert snapshot(WEEK, NEXT_WEEK) == before
    assert sorted(indexed(store)) == sorted([
        (NEXT_WEEK, "Schon da", True), (WEEK, "Mail an Betreuer", True),
    ])


def test_a_failed_target_write_changes_nothing(store, locks):
    store.add_task(WEEK, WEDNESDAY, "Mail an Betreuer")
    before = snapshot(WEEK, NEXT_WEEK)
    locks.lock(week_file(NEXT_WEEK))

    with pytest.raises(PermissionError):
        store.move_task(WEEK, 0, NEXT_MONDAY)

    assert snapshot(WEEK, NEXT_WEEK) == before
    assert indexed(store) == [(WEEK, "Mail an Betreuer", True)]


def test_when_the_take_back_fails_too_the_task_stands_open_twice(store, locks, caplog):
    store.add_task(WEEK, WEDNESDAY, "Mail an Betreuer")
    locks.lock(week_file(WEEK))
    locks.lock(week_file(NEXT_WEEK), after=1)  # the carried line lands, then the lock

    with caplog.at_level(logging.ERROR), pytest.raises(PermissionError):
        store.move_task(WEEK, 0, NEXT_MONDAY)

    assert "→" not in week_file(WEEK).read_text(encoding="utf-8")
    assert f"Mail an Betreuer ←{WEDNESDAY}" in week_file(NEXT_WEEK).read_text(encoding="utf-8")
    # Index and files agree: open in both weeks — duplicated, never lost.
    assert sorted(indexed(store)) == sorted([
        (NEXT_WEEK, "Mail an Betreuer", True), (WEEK, "Mail an Betreuer", True),
    ])
    assert any(NEXT_WEEK in r.getMessage() for r in caplog.records)


def test_a_move_inside_the_week_still_works(store, locks):
    store.add_task(WEEK, WEDNESDAY, "Verschiebt sich")
    store.move_task(WEEK, 0, FRIDAY)
    text = week_file(WEEK).read_text(encoding="utf-8")
    assert f"Verschiebt sich →{FRIDAY}" in text and f"Verschiebt sich ←{WEDNESDAY}" in text
    assert not week_file(NEXT_WEEK).exists()

    locks.lock(week_file(WEEK))
    before = snapshot(WEEK)
    with pytest.raises(PermissionError):
        store.move_task(WEEK, 1, SUNDAY)  # one file, one write: nothing to take back
    assert snapshot(WEEK) == before


# --- undo move -------------------------------------------------------------------

def _moved(store) -> dict:
    store.add_task(WEEK, WEDNESDAY, "Kapitel schreiben")
    return store.move_task(WEEK, 0, NEXT_MONDAY)


def _undo(store, moved: dict) -> dict:
    return store.undo_move(moved["source_week"], moved["source_index"], moved["week"], moved["body_index"])


def test_undo_with_a_failed_target_write_puts_the_marker_back(store, locks):
    moved = _moved(store)
    before = snapshot(WEEK, NEXT_WEEK)
    locks.lock(week_file(NEXT_WEEK))

    with pytest.raises(PermissionError):
        _undo(store, moved)

    assert snapshot(WEEK, NEXT_WEEK) == before
    assert sorted(indexed(store)) == sorted([
        (NEXT_WEEK, "Kapitel schreiben", True), (WEEK, "Kapitel schreiben", False),
    ])


def test_undo_with_a_failed_source_write_changes_nothing(store, locks):
    moved = _moved(store)
    before = snapshot(WEEK, NEXT_WEEK)
    locks.lock(week_file(WEEK))

    with pytest.raises(PermissionError):
        _undo(store, moved)

    assert snapshot(WEEK, NEXT_WEEK) == before


def test_undo_whose_take_back_fails_too_leaves_the_task_open_twice(store, locks):
    moved = _moved(store)
    locks.lock(week_file(NEXT_WEEK))
    locks.lock(week_file(WEEK), after=1)  # the marker goes, then the lock

    with pytest.raises(PermissionError):
        _undo(store, moved)

    assert "→" not in week_file(WEEK).read_text(encoding="utf-8")
    assert "←" in week_file(NEXT_WEEK).read_text(encoding="utf-8")
    assert sorted(indexed(store)) == sorted([
        (NEXT_WEEK, "Kapitel schreiben", True), (WEEK, "Kapitel schreiben", True),
    ])


def test_undo_across_the_week_boundary_still_works(store):
    moved = _moved(store)
    assert _undo(store, moved) == {"week": WEEK, "body_index": 0}
    assert indexed(store) == [(WEEK, "Kapitel schreiben", True)]
    assert "Kapitel schreiben" not in week_file(NEXT_WEEK).read_text(encoding="utf-8")


# --- HTTP ------------------------------------------------------------------------

BASE = "/api/plugins/atlas/journal"


def test_a_locked_week_file_answers_423_on_move_undo_and_carry_over(atlas_client, tmp_path, locks):
    client = atlas_client
    source, target = tmp_path / "journal" / f"{WEEK}.md", tmp_path / "journal" / f"{NEXT_WEEK}.md"
    client.post(f"{BASE}/{WEEK}/tasks", json={"day": WEDNESDAY, "text": "Mail"})
    before = source.read_bytes()

    locks.lock(source)
    resp = client.post(f"{BASE}/{WEEK}/tasks/0/move", json={"to": NEXT_MONDAY})
    assert (resp.status_code, resp.json()["detail"]) == (423, LOCKED)
    assert source.read_bytes() == before and not target.exists()

    resp = client.post(f"{BASE}/{WEEK}/carry-over", json={"to": NEXT_MONDAY})
    assert (resp.status_code, resp.json()["detail"]) == (423, LOCKED)
    assert source.read_bytes() == before and not target.exists()

    locks.unlock(source)
    moved = client.post(f"{BASE}/{WEEK}/tasks/0/move", json={"to": NEXT_MONDAY}).json()
    locks.lock(target)
    resp = client.post(
        f"{BASE}/{moved['source_week']}/tasks/{moved['source_index']}/undo-move",
        json={"to_week": moved["week"], "to_index": moved["body_index"]},
    )
    assert (resp.status_code, resp.json()["detail"]) == (423, LOCKED)
    assert "→" in source.read_text(encoding="utf-8")


# --- carry-over announces what it moved, however it ends (review 2026-10-18, A8) ---

PREV_WEEK = week_id("2026-09-18")
LAST_FRIDAY = "2026-09-18"
CHANGED = {"type": "archive-changed", "kind": "journal"}


@pytest.fixture
def journal_api(store):
    """The Journal router on ``store``, its broadcaster recording each event."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from atlas.api_journal import build_journal_router

    events: list[dict] = []
    app = FastAPI()
    app.include_router(build_journal_router(store, SimpleNamespace(publish=events.append)),
                       prefix="/api/plugins/atlas")
    return SimpleNamespace(client=TestClient(app), events=events)


def test_carry_over_announces_moved_tasks_when_the_next_source_week_is_locked(
        store, journal_api, monkeypatch):
    store.add_task(PREV_WEEK, LAST_FRIDAY, "Vorwoche offen")
    read = store.read_journal

    def read_journal(week):  # this week's file: held by OneDrive once the move is done
        if week == WEEK:
            raise PermissionError(13, "gesperrt", str(week_file(WEEK)))
        return read(week)

    monkeypatch.setattr(store, "read_journal", read_journal)
    resp = journal_api.client.post(f"{BASE}/{WEEK}/carry-over", json={"to": WEDNESDAY})

    assert (resp.status_code, resp.json()["detail"]) == (423, LOCKED)
    assert f"Vorwoche offen ←{LAST_FRIDAY}" in week_file(WEEK).read_text(encoding="utf-8")
    assert journal_api.events == [CHANGED]


def test_carry_over_announces_once_when_a_later_move_is_locked(store, journal_api, locks):
    store.add_task(PREV_WEEK, LAST_FRIDAY, "Erste")
    store.add_task(PREV_WEEK, LAST_FRIDAY, "Zweite")
    locks.lock(week_file(PREV_WEEK), after=1)  # the first move's → lands, then the lock

    resp = journal_api.client.post(f"{BASE}/{WEEK}/carry-over", json={"to": WEDNESDAY})

    assert (resp.status_code, resp.json()["detail"]) == (423, LOCKED)
    assert [t["text"] for t in store.list_journal_tasks(weeks=[WEEK])] == ["Erste"]
    assert journal_api.events == [CHANGED]


def test_carry_over_announces_once_and_nothing_without_a_move(store, journal_api):
    store.add_task(PREV_WEEK, LAST_FRIDAY, "Erste")
    store.add_task(PREV_WEEK, LAST_FRIDAY, "Zweite")

    resp = journal_api.client.post(f"{BASE}/{WEEK}/carry-over", json={"to": WEDNESDAY})
    assert (resp.status_code, resp.json()["moved"]) == (200, 2)
    assert journal_api.events == [CHANGED]

    resp = journal_api.client.post(f"{BASE}/{WEEK}/carry-over", json={"to": WEDNESDAY})
    assert (resp.status_code, resp.json()["moved"]) == (200, 0)
    assert journal_api.events == [CHANGED]
