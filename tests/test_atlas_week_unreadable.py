"""A week file Atlas cannot parse is never written (architecture review 2026-10-18).

A hand edit can break the frontmatter of ``journal/<YYYY-Www>.md`` — a weekly
goal ``- title: Kapitel 3: Methodik`` without quotes is enough. So can a
copy of last week's file whose ``week:`` still names last week: it parses,
but every write would go to that other week's file. Since fix 1 the reindex
skips a file that does not parse; here the rest of the Journal follows suit:

- **Reads** answer ``409 {code: error.atlas.week_unreadable, params: {week,
  file}}`` for that week; ``/journal/today`` and carry-over, which only need
  that week next to others, skip it and name it in ``unreadable``.
- **Writes** refuse with the same code BEFORE they write anything: rewriting a
  file Atlas cannot read would destroy the user's edit (P1). Every write path
  is checked byte for byte.
- A **locked** week file is 423 ``error.atlas.document_locked`` on every week
  write, not only on move/undo/carry-over.
"""
from __future__ import annotations

from datetime import date
from pathlib import Path
from types import SimpleNamespace

import pytest

from atlas import api_journal, api_zettel, documents
from atlas import config as atlas_config
from atlas import config
from atlas.journal_store import WeekUnreadable
from atlas.store import AtlasStore

TODAY = date(2026, 9, 23)        # Mittwoch, KW 39
PREV_WEEK, WEEK, NEXT_WEEK = "2026-W38", "2026-W39", "2026-W40"
LAST_FRIDAY = "2026-09-18"
MONDAY, WEDNESDAY, FRIDAY = "2026-09-21", "2026-09-23", "2026-09-25"
NEXT_MONDAY = "2026-09-28"
FIRST_DAY = {PREV_WEEK: "2026-09-14", WEEK: MONDAY, NEXT_WEEK: NEXT_MONDAY}

API = "/api/plugins/atlas"
BASE = f"{API}/journal"
UNREADABLE = "error.atlas.week_unreadable"
LOCKED = "error.atlas.document_locked"


def broken(week: str) -> str:
    """The hand edit of the review: ``: `` inside an unquoted goal title."""
    return (
        f"---\nschema: atlas.journal/1\nweek: {week}\ngoals:\n"
        f"- title: Kapitel 3: Methodik\n---\n\n"
        f"## Montag {FIRST_DAY[week]}\n- [ ] Von Hand\n"
    )


def copied(week: str) -> str:
    """Last week's file copied as a template, its ``week:`` left as it was:
    it parses, but every write would land in that other week's file."""
    return (
        f"---\nschema: atlas.journal/1\nweek: {PREV_WEEK if week == WEEK else WEEK}\n---\n\n"
        f"## Montag {FIRST_DAY[week]}\n- [ ] Von Hand\n"
    )


# How a hand edit leaves a week file Atlas must not write.
BREAKS = {"colon in a goal title": broken, "copied with the old week": copied}


def unreadable(week: str) -> dict:
    return {"week": week, "file": f"journal/{week}.md"}


def week_file(week: str) -> Path:
    return config.journal_dir() / f"{week}.md"


def break_week(week: str, how=broken) -> bytes:
    path = week_file(week)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(how(week), encoding="utf-8")
    return path.read_bytes()


def snapshot(*weeks: str) -> dict:
    """The bytes of each week file (None: no file)."""
    return {w: week_file(w).read_bytes() if week_file(w).exists() else None for w in weeks}


# --- the store: every write refuses and leaves the bytes alone -----------------

@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(atlas_config, "_base_dir", str(tmp_path))
    config.ensure_dirs()
    return AtlasStore()


# Shapes a hand edit can leave behind that do not parse.
BROKEN_SHAPES = {
    "colon in a goal title": broken(WEEK).encode("utf-8"),
    "goals is no list": (
        f"---\nweek: {WEEK}\ngoals:\n  title: Kapitel 3\n---\n\n"
        f"## Montag {MONDAY}\n- [ ] Von Hand\n"
    ).encode("utf-8"),
    "frontmatter is no mapping": (
        f"---\n- {WEEK}\n---\n\n## Montag {MONDAY}\n- [ ] Von Hand\n"
    ).encode("utf-8"),
    "not UTF-8": (
        f"---\nweek: {WEEK}\n---\n\n## Montag {MONDAY}\n- [ ] Gr\xfc\xdfe\n"
    ).encode("latin-1"),
    "week names another week": copied(WEEK).encode("utf-8"),
}


@pytest.mark.parametrize("shape", sorted(BROKEN_SHAPES))
def test_reading_a_broken_week_names_week_and_file(store, shape):
    week_file(WEEK).write_bytes(BROKEN_SHAPES[shape])

    with pytest.raises(WeekUnreadable) as caught:
        store.read_journal(WEEK)

    assert (caught.value.week, caught.value.file) == (WEEK, f"journal/{WEEK}.md")
    with pytest.raises(WeekUnreadable):
        store.toggle_task(WEEK, 0)
    assert week_file(WEEK).read_bytes() == BROKEN_SHAPES[shape]


# Every write primitive of journal_store, with the broken week as the one it
# writes, as the source and as the target of a cross-week Uebertrag.
STORE_WRITES = {
    "add_task": lambda s: s.add_task(WEEK, WEDNESDAY, "Neu"),
    "update_task text": lambda s: s.update_task(WEEK, 0, "Neu"),
    "update_task note": lambda s: s.update_task(WEEK, 0, None, "Notiz"),
    "toggle_task": lambda s: s.toggle_task(WEEK, 0),
    "delete_task": lambda s: s.delete_task(WEEK, 0),
    "reorder_task": lambda s: s.reorder_task(WEEK, 0, 0),
    "move_task in the week": lambda s: s.move_task(WEEK, 0, FRIDAY),
    "move_task from it": lambda s: s.move_task(WEEK, 0, NEXT_MONDAY),
    "move_task into it": lambda s: s.move_task(NEXT_WEEK, 0, WEDNESDAY),
    "undo_move at its source": lambda s: s.undo_move(WEEK, 0, NEXT_WEEK, 0),
    "undo_move at its target": lambda s: s.undo_move(NEXT_WEEK, 0, WEEK, 0),
    "set_goals": lambda s: s.set_goals(WEEK, [{"title": "Neu"}]),
    "toggle_goal": lambda s: s.toggle_goal(WEEK, 0),
}


@pytest.mark.parametrize("how", sorted(BREAKS))
@pytest.mark.parametrize("op", sorted(STORE_WRITES))
def test_no_store_write_touches_a_broken_week_file(store, op, how):
    store.add_task(PREV_WEEK, LAST_FRIDAY, "Echte Vorwoche")
    store.add_task(NEXT_WEEK, NEXT_MONDAY, "Gut")
    break_week(WEEK, BREAKS[how])
    before = snapshot(PREV_WEEK, WEEK, NEXT_WEEK)

    with pytest.raises(WeekUnreadable) as caught:
        STORE_WRITES[op](store)

    assert caught.value.week == WEEK
    assert snapshot(PREV_WEEK, WEEK, NEXT_WEEK) == before


# --- HTTP ------------------------------------------------------------------------

@pytest.fixture
def client(atlas_app, monkeypatch):
    monkeypatch.setattr(api_journal, "_today", lambda: TODAY)
    monkeypatch.setattr(api_zettel, "_today", lambda: TODAY)
    with atlas_app() as c:
        yield c


def add_task(client, week: str, day: str, text: str) -> dict:
    resp = client.post(f"{BASE}/{week}/tasks", json={"day": day, "text": text})
    assert resp.status_code == 200, resp.text
    return resp.json()


def assert_unreadable(resp, week: str) -> None:
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"] == {"code": UNREADABLE, "params": unreadable(week)}


@pytest.mark.parametrize("how", sorted(BREAKS))
def test_get_week_names_the_file_to_fix(client, how):
    break_week(WEEK, BREAKS[how])
    assert_unreadable(client.get(f"{BASE}/{WEEK}"), WEEK)


def test_today_skips_an_unreadable_previous_week_and_names_it(client):
    add_task(client, WEEK, MONDAY, "Montag offen")
    add_task(client, WEEK, WEDNESDAY, "Heute")
    before = break_week(PREV_WEEK)

    resp = client.get(f"{BASE}/today")

    assert resp.status_code == 200, resp.text
    today = resp.json()
    assert [t["text"] for t in today["tasks"]] == ["Heute"]
    assert [t["text"] for t in today["carry_over"]] == ["Montag offen"]
    assert today["open_count"] == 2
    assert today["unreadable"] == [unreadable(PREV_WEEK)]
    assert week_file(PREV_WEEK).read_bytes() == before


def test_today_with_an_unreadable_current_week_still_shows_the_rest(client):
    client.post(f"{API}/zettel", json={"title": "Gruppenbesprechung"})
    before = break_week(WEEK)

    resp = client.get(f"{BASE}/today")

    assert resp.status_code == 200, resp.text
    today = resp.json()
    assert (today["week"], today["tasks"], today["goals"], today["open_count"]) == (WEEK, [], [], 0)
    assert [z["title"] for z in today["zettel"]] == ["Gruppenbesprechung"]
    assert "due" in today
    assert today["unreadable"] == [unreadable(WEEK)]
    assert week_file(WEEK).read_bytes() == before


def test_today_reports_no_unreadable_week_when_all_parse(client):
    assert client.get(f"{BASE}/today").json()["unreadable"] == []


def test_carry_over_skips_an_unreadable_source_week_and_names_it(client):
    add_task(client, WEEK, MONDAY, "Montag offen")
    before = break_week(PREV_WEEK)

    resp = client.post(f"{BASE}/{WEEK}/carry-over", json={"to": WEDNESDAY})

    assert resp.status_code == 200, resp.text
    assert resp.json()["moved"] == 1
    assert resp.json()["unreadable"] == [unreadable(PREV_WEEK)]
    assert week_file(PREV_WEEK).read_bytes() == before


def test_carry_over_into_an_unreadable_week_writes_nothing(client):
    add_task(client, PREV_WEEK, LAST_FRIDAY, "Vorwoche offen")
    before = {PREV_WEEK: week_file(PREV_WEEK).read_bytes(), WEEK: break_week(WEEK)}

    resp = client.post(f"{BASE}/{WEEK}/carry-over", json={"to": WEDNESDAY})

    assert_unreadable(resp, WEEK)
    assert snapshot(PREV_WEEK, WEEK) == before


# Every write endpoint into a week file, with the broken current week as the
# week it writes (or reads to write: adopt's previous week, review's numbers).
HTTP_WRITES = {
    "create task": ("POST", f"{BASE}/{WEEK}/tasks", {"day": WEDNESDAY, "text": "Neu"}),
    "edit task text": ("PUT", f"{BASE}/{WEEK}/tasks/0", {"text": "Neu"}),
    "edit task note": ("PUT", f"{BASE}/{WEEK}/tasks/0", {"note": "Notiz"}),
    "delete task": ("DELETE", f"{BASE}/{WEEK}/tasks/0", None),
    "toggle task": ("POST", f"{BASE}/{WEEK}/tasks/0/toggle", None),
    "reorder task": ("POST", f"{BASE}/{WEEK}/tasks/0/reorder", {"position": 0}),
    "move in the week": ("POST", f"{BASE}/{WEEK}/tasks/0/move", {"to": FRIDAY}),
    "move out of it": ("POST", f"{BASE}/{WEEK}/tasks/0/move", {"to": NEXT_MONDAY}),
    "move into it": ("POST", f"{BASE}/{NEXT_WEEK}/tasks/0/move", {"to": WEDNESDAY}),
    "undo-move at its source": (
        "POST", f"{BASE}/{WEEK}/tasks/0/undo-move", {"to_week": NEXT_WEEK, "to_index": 0}),
    "undo-move at its target": (
        "POST", f"{BASE}/{NEXT_WEEK}/tasks/0/undo-move", {"to_week": WEEK, "to_index": 0}),
    "put goals": ("PUT", f"{BASE}/{WEEK}/goals", {"goals": [{"title": "Neu"}]}),
    "toggle goal": ("POST", f"{BASE}/{WEEK}/goals/0/toggle", None),
    "adopt into it": ("POST", f"{BASE}/{WEEK}/goals/adopt", None),
    "adopt from it": ("POST", f"{BASE}/{NEXT_WEEK}/goals/adopt", None),
    "review zettel": ("POST", f"{BASE}/{WEEK}/review/zettel", None),
}


@pytest.mark.parametrize("how", sorted(BREAKS))
@pytest.mark.parametrize("name", sorted(HTTP_WRITES))
def test_no_write_endpoint_touches_a_broken_week_file(client, name, how):
    add_task(client, PREV_WEEK, LAST_FRIDAY, "Echte Vorwoche")
    add_task(client, NEXT_WEEK, NEXT_MONDAY, "Gut")
    break_week(WEEK, BREAKS[how])
    zettel_before = sorted(p.name for p in config.zettel_dir().glob("*.md"))
    before = snapshot(PREV_WEEK, WEEK, NEXT_WEEK)
    method, url, payload = HTTP_WRITES[name]

    resp = client.request(method, url, json=payload)

    assert_unreadable(resp, WEEK)
    assert snapshot(PREV_WEEK, WEEK, NEXT_WEEK) == before
    assert sorted(p.name for p in config.zettel_dir().glob("*.md")) == zettel_before


def test_derive_tasks_into_an_unreadable_week_writes_nothing(client):
    zettel = client.post(
        f"{API}/zettel", json={"title": "Besprechung", "body": "- [ ] Kapitel 3 ueberarbeiten\n"}
    ).json()
    before = break_week(WEEK)

    resp = client.post(f"{API}/zettel/{zettel['id']}/derive-tasks", json={"indices": [0]})

    assert_unreadable(resp, WEEK)
    assert week_file(WEEK).read_bytes() == before


def test_open_hands_a_broken_week_file_to_the_editor_unchanged(client, monkeypatch):
    opened: list = []
    monkeypatch.setattr(documents, "open_in_viewer", lambda path: opened.append(path))
    before = break_week(WEEK)

    resp = client.post(f"{BASE}/{WEEK}/open")

    assert resp.status_code == 200, resp.text
    assert [Path(p) for p in opened] == [week_file(WEEK)]
    assert week_file(WEEK).read_bytes() == before


# --- a locked week file is 423 on every week write --------------------------------

@pytest.fixture
def locks(monkeypatch):
    """Week files a writer holds: writing a locked path raises ``PermissionError``."""
    locked: set[Path] = set()

    def guard(method: str) -> None:
        original = getattr(Path, method)

        def wrapper(self, *args, **kwargs):
            if Path(self) in locked:
                raise PermissionError(13, "gesperrt", str(self))
            return original(self, *args, **kwargs)

        monkeypatch.setattr(Path, method, wrapper)

    for method in ("write_text", "write_bytes", "unlink"):
        guard(method)
    return SimpleNamespace(lock=lambda path: locked.add(Path(path)))


LOCKED_WRITES = {
    "create task": ("POST", f"{BASE}/{WEEK}/tasks", {"day": WEDNESDAY, "text": "Neu"}),
    "put goals": ("PUT", f"{BASE}/{WEEK}/goals", {"goals": [{"title": "Neu"}]}),
    "toggle goal": ("POST", f"{BASE}/{WEEK}/goals/0/toggle", None),
    "adopt": ("POST", f"{BASE}/{WEEK}/goals/adopt", None),
    "edit task": ("PUT", f"{BASE}/{WEEK}/tasks/0", {"text": "Neu"}),
    "toggle task": ("POST", f"{BASE}/{WEEK}/tasks/0/toggle", None),
}


@pytest.mark.parametrize("name", sorted(LOCKED_WRITES))
def test_a_locked_week_file_answers_423_on_every_week_write(client, locks, name):
    add_task(client, WEEK, MONDAY, "Montag")
    client.put(f"{BASE}/{WEEK}/goals", json={"goals": [{"title": "Kapitel 3"}]})
    before = week_file(WEEK).read_bytes()
    locks.lock(week_file(WEEK))
    method, url, payload = LOCKED_WRITES[name]

    resp = client.request(method, url, json=payload)

    assert (resp.status_code, resp.json()["detail"]) == (423, LOCKED)
    assert week_file(WEEK).read_bytes() == before


def test_derive_tasks_into_a_locked_week_answers_423(client, locks):
    zettel = client.post(
        f"{API}/zettel", json={"title": "Besprechung", "body": "- [ ] Kapitel 3 ueberarbeiten\n"}
    ).json()
    locks.lock(week_file(WEEK))

    resp = client.post(f"{API}/zettel/{zettel['id']}/derive-tasks", json={"indices": [0]})

    assert (resp.status_code, resp.json()["detail"]) == (423, LOCKED)
    assert not week_file(WEEK).exists()


def test_opening_a_new_week_file_that_is_locked_answers_423(client, locks, monkeypatch):
    monkeypatch.setattr(documents, "open_in_viewer", lambda path: None)
    locks.lock(week_file(NEXT_WEEK))

    resp = client.post(f"{BASE}/{NEXT_WEEK}/open")

    assert (resp.status_code, resp.json()["detail"]) == (423, LOCKED)
