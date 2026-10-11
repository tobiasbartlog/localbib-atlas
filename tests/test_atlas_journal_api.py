"""Atlas Journal REST tests (issue #180, slice 3) — Naht 1.

Behaviour only: a request goes in, and what comes back plus what stands in the
Markdown file afterwards is what is checked. No SQL, no table shapes, no
internal call order. Companion of ``test_atlas_werkbank_store.py``, which does
the same one layer down.

"Heute" is pinned (``atlas.api_journal._today``) so nothing depends on which
day the suite happens to run — a week boundary must never make a test flaky.
"""
from __future__ import annotations

import difflib
import os
from datetime import date, datetime

import pytest

from atlas import api_journal, documents

TODAY = date(2026, 9, 23)        # Mittwoch
WEEK = "2026-W39"                # 2026-09-21 .. 2026-09-27
PREV_WEEK = "2026-W38"           # 2026-09-14 .. 2026-09-20
NEXT_WEEK = "2026-W40"
MONDAY = "2026-09-21"
TUESDAY = "2026-09-22"
WEDNESDAY = "2026-09-23"
FRIDAY = "2026-09-25"
NEXT_MONDAY = "2026-09-28"
LAST_FRIDAY = "2026-09-18"

BASE = "/api/plugins/atlas/journal"


@pytest.fixture
def atlas_client(atlas_app, monkeypatch):
    monkeypatch.setattr(api_journal, "_today", lambda: TODAY)
    with atlas_app() as c:
        yield c


def journal_file(tmp_path, week: str = WEEK):
    return tmp_path / "journal" / f"{week}.md"


def journal_text(tmp_path, week: str = WEEK) -> str:
    return journal_file(tmp_path, week).read_text(encoding="utf-8")


def line_diff(before: str, after: str) -> tuple[list[str], list[str]]:
    """(removed, added) lines — the byte-identity check of ADR-0020."""
    diff = list(difflib.ndiff(before.split("\n"), after.split("\n")))
    return (
        [d[2:] for d in diff if d.startswith("- ")],
        [d[2:] for d in diff if d.startswith("+ ")],
    )


def add_task(client, text: str, *, day: str = WEDNESDAY, week: str = WEEK) -> dict:
    resp = client.post(f"{BASE}/{week}/tasks", json={"day": day, "text": text})
    assert resp.status_code == 200, resp.text
    return resp.json()


# --- creating Tasks -----------------------------------------------------------

def test_create_task_writes_week_file_with_day_heading_and_line(atlas_client, tmp_path):
    created = add_task(atlas_client, "Abschnitt 3 ueberarbeiten [[kap-methodik]] #schreiben")

    text = journal_text(tmp_path)
    assert "week: 2026-W39" in text
    assert "## Mittwoch 2026-09-23" in text
    assert "- [ ] Abschnitt 3 ueberarbeiten [[kap-methodik]] #schreiben" in text

    assert created["body_index"] == 0
    assert created["week"] == WEEK
    assert created["day"] == WEDNESDAY
    assert created["text"] == "Abschnitt 3 ueberarbeiten"  # display text
    assert created["anchors"] == ["kap-methodik"]
    assert created["tags"] == ["schreiben"]
    assert created["open"] is True


def test_second_task_same_day_joins_the_same_heading(atlas_client, tmp_path):
    add_task(atlas_client, "Erster")
    second = add_task(atlas_client, "Zweiter")

    text = journal_text(tmp_path)
    assert text.count("## Mittwoch 2026-09-23") == 1
    assert text.index("- [ ] Erster") < text.index("- [ ] Zweiter")
    assert second["body_index"] == 1


def test_other_day_creates_a_second_sorted_heading(atlas_client, tmp_path):
    add_task(atlas_client, "Mittwoch-Task", day=WEDNESDAY)
    add_task(atlas_client, "Montag-Task", day=MONDAY)

    text = journal_text(tmp_path)
    assert text.index("## Montag 2026-09-21") < text.index("## Mittwoch 2026-09-23")


def test_day_outside_the_week_is_a_validation_error_code(atlas_client):
    resp = atlas_client.post(f"{BASE}/{WEEK}/tasks", json={"day": NEXT_MONDAY, "text": "x"})
    assert resp.status_code == 422
    assert resp.json()["detail"] == "error.atlas.day_outside_week"


def test_unknown_week_id_is_a_404_code(atlas_client):
    resp = atlas_client.get(f"{BASE}/2026-W99")
    assert resp.status_code == 404
    assert resp.json()["detail"] == "error.atlas.week_invalid"


# --- one line changes, the rest stays byte-identical --------------------------

def test_toggle_changes_exactly_one_line(atlas_client, tmp_path):
    add_task(atlas_client, "Erster")
    add_task(atlas_client, "Zweiter")
    before = journal_text(tmp_path)

    toggled = atlas_client.post(f"{BASE}/{WEEK}/tasks/0/toggle").json()
    assert toggled["done"] is True

    removed, added = line_diff(before, journal_text(tmp_path))
    assert removed == ["- [ ] Erster"]
    assert added == ["- [x] Erster"]


def test_edit_changes_exactly_one_line(atlas_client, tmp_path):
    add_task(atlas_client, "Erster")
    add_task(atlas_client, "Zweiter")
    before = journal_text(tmp_path)

    atlas_client.put(f"{BASE}/{WEEK}/tasks/1", json={"text": "Zweiter, korrigiert"})

    removed, added = line_diff(before, journal_text(tmp_path))
    assert removed == ["- [ ] Zweiter"]
    assert added == ["- [ ] Zweiter, korrigiert"]


def test_delete_removes_exactly_one_line(atlas_client, tmp_path):
    add_task(atlas_client, "Erster")
    add_task(atlas_client, "Zweiter")
    before = journal_text(tmp_path)

    assert atlas_client.delete(f"{BASE}/{WEEK}/tasks/0").status_code == 200

    removed, added = line_diff(before, journal_text(tmp_path))
    assert removed == ["- [ ] Erster"]
    assert added == []


def test_reorder_moves_one_line_within_the_day(atlas_client, tmp_path):
    add_task(atlas_client, "Erster")
    add_task(atlas_client, "Zweiter")
    add_task(atlas_client, "Dritter")

    resp = atlas_client.post(f"{BASE}/{WEEK}/tasks/2/reorder", json={"position": 0})
    assert resp.status_code == 200
    assert [t["text"] for t in resp.json()["tasks"]] == ["Dritter", "Erster", "Zweiter"]

    body = journal_text(tmp_path)
    assert body.index("Dritter") < body.index("Erster") < body.index("Zweiter")


def test_editing_an_unknown_task_is_a_404_code(atlas_client):
    add_task(atlas_client, "Erster")
    resp = atlas_client.put(f"{BASE}/{WEEK}/tasks/9", json={"text": "x"})
    assert resp.status_code == 404
    assert resp.json()["detail"] == "error.atlas.task_not_found"


# --- Uebertrag ----------------------------------------------------------------

def test_move_marks_the_source_and_appends_the_target(atlas_client, tmp_path):
    add_task(atlas_client, "Mail an Betreuer", day=WEDNESDAY)

    moved = atlas_client.post(f"{BASE}/{WEEK}/tasks/0/move", json={"to": FRIDAY}).json()
    assert moved["week"] == WEEK
    assert moved["day"] == FRIDAY
    assert moved["source_week"] == WEEK

    text = journal_text(tmp_path)
    assert "- [ ] Mail an Betreuer →2026-09-25" in text
    assert "- [ ] Mail an Betreuer ←2026-09-23" in text
    assert "## Freitag 2026-09-25" in text


# --- Übertrag zurücknehmen (#224) ----------------------------------------------

def _undo(client, moved: dict):
    return client.post(
        f"{BASE}/{moved['source_week']}/tasks/{moved['source_index']}/undo-move",
        json={"to_week": moved["week"], "to_index": moved["body_index"]},
    )


def test_undo_move_restores_the_file_byte_for_byte_in_the_same_week(atlas_client, tmp_path):
    add_task(atlas_client, "Vorher", day=MONDAY)
    add_task(atlas_client, "Mail an Betreuer #mail", day=WEDNESDAY)
    add_task(atlas_client, "Danach", day=WEDNESDAY)
    before = journal_text(tmp_path)

    moved = atlas_client.post(f"{BASE}/{WEEK}/tasks/1/move", json={"to": FRIDAY}).json()
    assert journal_text(tmp_path) != before
    resp = _undo(atlas_client, moved)
    assert resp.status_code == 200
    assert resp.json() == {"week": WEEK, "body_index": 1}
    after = journal_text(tmp_path)
    removed, added = line_diff(before, after)
    # Only the (now empty) Friday heading the move created may remain.
    assert removed == [] and all(a.startswith("## Freitag") or a == "" for a in added)
    assert "- [ ] Mail an Betreuer #mail" in after and "→" not in after and "←" not in after


def test_undo_move_to_an_earlier_day_keeps_the_source_addressable(atlas_client, tmp_path):
    add_task(atlas_client, "Spaeter", day=FRIDAY)
    moved = atlas_client.post(f"{BASE}/{WEEK}/tasks/0/move", json={"to": MONDAY}).json()
    assert moved["body_index"] == 0  # the carried line sits before the source
    assert moved["source_index"] == 1  # ... so the source moved one index down
    resp = _undo(atlas_client, moved)
    assert resp.json() == {"week": WEEK, "body_index": 0}
    week = atlas_client.get(f"{BASE}/{WEEK}").json()
    assert [(t["text"], t["day"], t["open"]) for t in week["tasks"]] == [("Spaeter", FRIDAY, True)]


def test_undo_move_across_the_week_boundary_writes_both_files(atlas_client, tmp_path):
    add_task(atlas_client, "Kapitel schreiben", day=FRIDAY)
    moved = atlas_client.post(f"{BASE}/{WEEK}/tasks/0/move", json={"to": NEXT_MONDAY}).json()
    assert _undo(atlas_client, moved).status_code == 200
    assert "- [ ] Kapitel schreiben\n" in journal_text(tmp_path) + "\n"
    assert "→" not in journal_text(tmp_path)
    assert "Kapitel schreiben" not in journal_text(tmp_path, NEXT_WEEK)
    today = atlas_client.get(f"{BASE}/{WEEK}").json()
    assert [t["open"] for t in today["tasks"]] == [True]


def test_undo_move_is_refused_once_a_line_was_changed(atlas_client, tmp_path):
    add_task(atlas_client, "Mail an Betreuer", day=WEDNESDAY)
    moved = atlas_client.post(f"{BASE}/{WEEK}/tasks/0/move", json={"to": FRIDAY}).json()
    # The carried line is ticked off meanwhile.
    atlas_client.post(f"{BASE}/{WEEK}/tasks/{moved['body_index']}/toggle")
    before = journal_text(tmp_path)
    resp = _undo(atlas_client, moved)
    assert resp.status_code == 409
    assert resp.json()["detail"] == "error.atlas.move_changed"
    assert journal_text(tmp_path) == before

    add_task(atlas_client, "Zweite", day=WEDNESDAY)
    second = atlas_client.post(f"{BASE}/{WEEK}/tasks/1/move", json={"to": FRIDAY}).json()
    atlas_client.put(f"{BASE}/{WEEK}/tasks/{second['body_index']}", json={"text": "Zweite, geaendert ←2026-09-23"})
    assert _undo(atlas_client, second).status_code == 409


def test_undo_move_of_a_line_that_is_gone_is_404(atlas_client):
    add_task(atlas_client, "Mail", day=WEDNESDAY)
    moved = atlas_client.post(f"{BASE}/{WEEK}/tasks/0/move", json={"to": FRIDAY}).json()
    atlas_client.delete(f"{BASE}/{WEEK}/tasks/{moved['body_index']}")
    assert _undo(atlas_client, moved).status_code == 404


def test_move_across_the_week_boundary_creates_the_second_file(atlas_client, tmp_path):
    add_task(atlas_client, "Kapitel schreiben", day=FRIDAY)

    moved = atlas_client.post(
        f"{BASE}/{WEEK}/tasks/0/move", json={"to": NEXT_MONDAY}
    ).json()
    assert moved["week"] == NEXT_WEEK
    assert moved["source_week"] == WEEK

    assert "- [ ] Kapitel schreiben →2026-09-28" in journal_text(tmp_path)
    next_text = journal_text(tmp_path, NEXT_WEEK)
    assert "week: 2026-W40" in next_text
    assert "## Montag 2026-09-28" in next_text
    assert "- [ ] Kapitel schreiben ←2026-09-25" in next_text


def test_today_no_longer_counts_a_moved_task_as_open(atlas_client):
    add_task(atlas_client, "Verschoben", day=WEDNESDAY)
    atlas_client.post(f"{BASE}/{WEEK}/tasks/0/move", json={"to": FRIDAY})

    today = atlas_client.get(f"{BASE}/today").json()
    assert [t["text"] for t in today["tasks"]] == ["Verschoben"]
    assert today["tasks"][0]["open"] is False
    assert today["tasks"][0]["moved_to"] == FRIDAY
    assert today["carry_over"] == []
    assert today["open_count"] == 0


# --- Heute --------------------------------------------------------------------

def test_today_lists_open_previous_days_of_this_and_the_previous_week(atlas_client):
    add_task(atlas_client, "Montag offen", day=MONDAY)
    add_task(atlas_client, "Vorwoche offen", day=LAST_FRIDAY, week=PREV_WEEK)
    add_task(atlas_client, "Heute", day=WEDNESDAY)

    today = atlas_client.get(f"{BASE}/today").json()
    assert today["date"] == WEDNESDAY
    assert today["weekday"] == "Mittwoch"
    assert today["week"] == WEEK
    assert [t["text"] for t in today["tasks"]] == ["Heute"]
    assert {t["text"] for t in today["carry_over"]} == {"Montag offen", "Vorwoche offen"}
    assert {t["week"] for t in today["carry_over"]} == {WEEK, PREV_WEEK}
    assert today["open_count"] == 3


def test_today_creates_no_file(atlas_client, tmp_path):
    assert atlas_client.get(f"{BASE}/today").status_code == 200
    assert not journal_file(tmp_path).exists()


def test_today_reports_goal_progress_by_anchor_and_by_tag(atlas_client):
    atlas_client.put(
        f"{BASE}/{WEEK}/goals",
        json={
            "goals": [
                {"title": "Kapitel 3 fertig", "anchor": "kap-3"},
                {"title": "Lesen", "tag": "lesen"},
            ]
        },
    )
    add_task(atlas_client, "Abschnitt [[kap-3]]")
    add_task(atlas_client, "Noch ein Abschnitt [[kap-3]]")
    add_task(atlas_client, "Paper #lesen")
    atlas_client.post(f"{BASE}/{WEEK}/tasks/0/toggle")

    goals = atlas_client.get(f"{BASE}/today").json()["goals"]
    assert goals[0]["total"] == 2 and goals[0]["done_count"] == 1
    assert goals[1]["total"] == 1 and goals[1]["done_count"] == 0


def test_today_shows_whats_due_from_a_milestone_and_a_stale_chapter(atlas_client, tmp_path):
    atlas_client.post(
        "/api/plugins/atlas/projects",
        json={
            "title": "DFG-Projekt",
            "milestones": [{"title": "Zwischenbericht", "date": FRIDAY, "done": False}],
        },
    )
    chapter = atlas_client.post("/api/plugins/atlas/diss", json={"title": "Methodik"}).json()
    stale = datetime(2026, 8, 20).timestamp()  # 34 days before the pinned today
    os.utime(tmp_path / "dissertation" / f"{chapter['id']}.md", (stale, stale))

    due = atlas_client.get(f"{BASE}/today").json()["due"]
    assert [m["title"] for m in due["milestones"]] == ["Zwischenbericht"]
    assert due["milestones"][0]["project_title"] == "DFG-Projekt"
    assert [c["id"] for c in due["stale_chapters"]] == [chapter["id"]]


def test_today_lists_publication_deadlines_overdue_and_within_two_weeks(atlas_client):
    """#223: a Frist (`due`) of an open Veroeffentlichung is "was liegt an" when
    it is overdue or within 14 days; a closed status or a far date is not."""
    pubs = "/api/plugins/atlas/publications"
    atlas_client.post(pubs, json={"title": "Abstract", "status": "drafting", "due": FRIDAY})
    atlas_client.post(pubs, json={"title": "Revision", "status": "in-revision", "due": MONDAY})
    atlas_client.post(pubs, json={"title": "Zu weit", "status": "planned", "due": "2026-10-08"})
    atlas_client.post(pubs, json={"title": "Grenze", "status": "planned", "due": "2026-10-07"})
    atlas_client.post(pubs, json={"title": "Fertig", "status": "published", "due": MONDAY})
    atlas_client.post(pubs, json={"title": "Abgelehnt", "status": "rejected", "due": FRIDAY})
    atlas_client.post(pubs, json={"title": "Ohne Frist", "status": "drafting"})

    due = atlas_client.get(f"{BASE}/today").json()["due"]
    assert [d["title"] for d in due["deadlines"]] == ["Revision", "Abstract", "Grenze"]
    assert [d["state"] for d in due["deadlines"]] == ["overdue", "upcoming", "upcoming"]
    assert [d["days"] for d in due["deadlines"]] == [-2, 2, 14]


def test_today_nudges_publications_submitted_more_than_eight_weeks_ago(atlas_client):
    """#223: more than 56 days in `submitted` -> "nachfragen?"; exactly 56 days
    is not yet, and another status never is."""
    pubs = "/api/plugins/atlas/publications"
    atlas_client.post(pubs, json={"title": "Lange", "status": "submitted",
                                  "submitted": "2026-07-28", "venue": "J. Test"})   # 57 Tage
    atlas_client.post(pubs, json={"title": "Genau", "status": "submitted",
                                  "submitted": "2026-07-29"})                      # 56 Tage
    atlas_client.post(pubs, json={"title": "Revision", "status": "in-revision",
                                  "submitted": "2026-01-01"})
    atlas_client.post(pubs, json={"title": "Ohne Datum", "status": "submitted"})

    due = atlas_client.get(f"{BASE}/today").json()["due"]
    assert [f["title"] for f in due["follow_ups"]] == ["Lange"]
    assert due["follow_ups"][0]["days"] == -57
    assert due["follow_ups"][0]["venue"] == "J. Test"


def test_today_lists_the_newest_zettel(atlas_client):
    from atlas.store import AtlasStore
    from atlas.zettel import new_zettel

    store = AtlasStore()
    for n in range(7):
        zettel = new_zettel(f"Zettel {n}", today=date(2026, 9, 10 + n))
        store.index_zettel_file(store.save_zettel_file(zettel))

    rows = atlas_client.get(f"{BASE}/today").json()["zettel"]
    assert len(rows) == 5
    assert [r["title"] for r in rows] == [f"Zettel {n}" for n in (6, 5, 4, 3, 2)]


# --- Woche --------------------------------------------------------------------

def test_week_returns_seven_days_and_paging_ids(atlas_client, tmp_path):
    payload = atlas_client.get(f"{BASE}/{WEEK}").json()
    assert payload["week"] == WEEK
    assert payload["previous"] == PREV_WEEK
    assert payload["next"] == NEXT_WEEK
    assert payload["exists"] is False
    assert [d["date"] for d in payload["days"]] == [
        "2026-09-21", "2026-09-22", "2026-09-23",
        "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27",
    ]
    assert payload["days"][0]["weekday"] == "Montag"
    assert not journal_file(tmp_path).exists()  # a read never creates a file


def test_week_counts_done_of_total_per_day_and_derives_the_review(atlas_client):
    add_task(atlas_client, "Eins", day=MONDAY)
    add_task(atlas_client, "Zwei", day=MONDAY)
    atlas_client.post(f"{BASE}/{WEEK}/tasks/0/toggle")

    payload = atlas_client.get(f"{BASE}/{WEEK}").json()
    monday = payload["days"][0]
    assert (monday["total"], monday["done"], monday["open"]) == (2, 1, 1)
    assert payload["review"]["tasks"] == {"total": 2, "done": 1, "open": 1, "moved": 0}


# --- carry-over ---------------------------------------------------------------

def test_carry_over_moves_every_open_previous_day_task_only(atlas_client, tmp_path):
    add_task(atlas_client, "Vorwoche offen", day=LAST_FRIDAY, week=PREV_WEEK)
    add_task(atlas_client, "Offen A", day=MONDAY)
    add_task(atlas_client, "Erledigt B", day=MONDAY)
    add_task(atlas_client, "Verschoben C", day=TUESDAY)
    atlas_client.post(f"{BASE}/{WEEK}/tasks/1/toggle")          # Erledigt B
    atlas_client.post(f"{BASE}/{WEEK}/tasks/2/move", json={"to": FRIDAY})  # C

    resp = atlas_client.post(f"{BASE}/{WEEK}/carry-over", json={"to": WEDNESDAY})
    assert resp.status_code == 200
    assert resp.json()["moved"] == 2
    assert resp.json()["to"] == WEDNESDAY

    text = journal_text(tmp_path)
    assert "- [ ] Offen A ←2026-09-21" in text
    assert "- [ ] Vorwoche offen ←2026-09-18" in text
    assert "Erledigt B ←" not in text                  # done is not open
    assert "Verschoben C ←2026-09-23" not in text      # its Uebertrag already happened
    assert "- [ ] Verschoben C →2026-09-25" in text    # the source keeps its marker
    assert "- [ ] Offen A →2026-09-23" in text
    assert "- [ ] Vorwoche offen →2026-09-23" in journal_text(tmp_path, PREV_WEEK)

    today = atlas_client.get(f"{BASE}/today").json()
    assert today["carry_over"] == []
    assert {t["text"] for t in today["tasks"]} == {"Offen A", "Vorwoche offen"}


# --- Wochenziele --------------------------------------------------------------

def test_goals_put_rewrites_the_frontmatter_and_leaves_the_body_identical(atlas_client, tmp_path):
    from atlas.journal import parse_journal

    add_task(atlas_client, "Abschnitt 3 [[kap-3]] #schreiben")
    body_before = parse_journal(journal_text(tmp_path))[1]

    resp = atlas_client.put(
        f"{BASE}/{WEEK}/goals",
        json={"goals": [{"title": "Kapitel 3 fertig", "anchor": "kap-3"}]},
    )
    assert resp.status_code == 200
    assert [g["title"] for g in resp.json()["goals"]] == ["Kapitel 3 fertig"]

    text = journal_text(tmp_path)
    assert "goals:" in text and "title: Kapitel 3 fertig" in text
    assert parse_journal(text)[1] == body_before  # byte-identical


def test_more_than_five_goals_is_a_validation_error_code(atlas_client):
    resp = atlas_client.put(
        f"{BASE}/{WEEK}/goals",
        json={"goals": [{"title": f"Ziel {n}"} for n in range(6)]},
    )
    assert resp.status_code == 422
    assert resp.json()["detail"] == "error.atlas.goals_too_many"


def test_a_goal_without_a_title_is_a_validation_error_code(atlas_client):
    resp = atlas_client.put(f"{BASE}/{WEEK}/goals", json={"goals": [{"title": "  "}]})
    assert resp.status_code == 422
    assert resp.json()["detail"] == "error.atlas.goal_title_required"


def test_goal_toggle_flips_exactly_that_goal(atlas_client):
    atlas_client.put(
        f"{BASE}/{WEEK}/goals",
        json={"goals": [{"title": "Eins"}, {"title": "Zwei"}]},
    )
    goals = atlas_client.post(f"{BASE}/{WEEK}/goals/1/toggle").json()["goals"]
    assert [g["done"] for g in goals] == [False, True]

    resp = atlas_client.post(f"{BASE}/{WEEK}/goals/7/toggle")
    assert resp.status_code == 404
    assert resp.json()["detail"] == "error.atlas.goal_not_found"


def test_adopt_takes_only_the_open_goals_of_the_previous_week(atlas_client):
    atlas_client.put(
        f"{BASE}/{PREV_WEEK}/goals",
        json={
            "goals": [
                {"title": "Halb erreicht"},
                {"title": "Fertig", "done": True},
            ]
        },
    )
    resp = atlas_client.post(f"{BASE}/{WEEK}/goals/adopt")
    assert resp.status_code == 200
    assert resp.json()["adopted"] == 1
    assert [g["title"] for g in resp.json()["goals"]] == ["Halb erreicht"]

    # Standing goals are not duplicated by a second adopt.
    again = atlas_client.post(f"{BASE}/{WEEK}/goals/adopt").json()
    assert again["adopted"] == 0
    assert len(again["goals"]) == 1


def test_adopting_beyond_five_goals_is_a_validation_error_code(atlas_client):
    atlas_client.put(
        f"{BASE}/{PREV_WEEK}/goals",
        json={"goals": [{"title": f"Alt {n}"} for n in range(3)]},
    )
    atlas_client.put(
        f"{BASE}/{WEEK}/goals",
        json={"goals": [{"title": f"Neu {n}"} for n in range(4)]},
    )
    resp = atlas_client.post(f"{BASE}/{WEEK}/goals/adopt")
    assert resp.status_code == 422
    assert resp.json()["detail"] == "error.atlas.goals_too_many"


# --- Rueckblick als Zettel ----------------------------------------------------

def test_review_zettel_is_created_with_type_review_and_the_week_title(atlas_client, tmp_path):
    add_task(atlas_client, "Eins", day=MONDAY)
    atlas_client.post(f"{BASE}/{WEEK}/tasks/0/toggle")

    resp = atlas_client.post(f"{BASE}/{WEEK}/review/zettel")
    assert resp.status_code == 200
    zettel = resp.json()
    assert zettel["type"] == "review"
    assert zettel["title"] == "Rückblick KW 39"

    text = (tmp_path / "zettel" / f"{zettel['id']}.md").read_text(encoding="utf-8")
    assert "type: review" in text
    assert "# Rückblick KW 39" in text
    assert "- Erledigt: 1 von 1" in text

    listed = atlas_client.get(f"{BASE}/today").json()["zettel"]
    assert listed[0]["id"] == zettel["id"]


# --- Tasks an einem Anker -----------------------------------------------------

def test_tasks_filter_by_anchor_and_open(atlas_client):
    add_task(atlas_client, "Kapitelarbeit [[kap-3]]", day=MONDAY)
    add_task(atlas_client, "Noch mehr [[kap-3]]", day=TUESDAY)
    add_task(atlas_client, "Vorwoche [[kap-3]]", day=LAST_FRIDAY, week=PREV_WEEK)
    add_task(atlas_client, "Ohne Anker", day=MONDAY)
    atlas_client.post(f"{BASE}/{WEEK}/tasks/0/toggle")

    all_tasks = atlas_client.get(f"{BASE}/tasks", params={"anchor": "kap-3"}).json()
    assert {t["text"] for t in all_tasks["tasks"]} == {
        "Kapitelarbeit", "Noch mehr", "Vorwoche"
    }

    open_tasks = atlas_client.get(
        f"{BASE}/tasks", params={"anchor": "kap-3", "open": "true"}
    ).json()
    assert {t["text"] for t in open_tasks["tasks"]} == {"Noch mehr", "Vorwoche"}


# --- Journal-Datei im Systemeditor -------------------------------------------

def test_open_creates_the_week_file_and_hands_it_to_the_system_editor(
    atlas_client, tmp_path, monkeypatch
):
    opened: list = []
    monkeypatch.setattr(documents, "open_in_viewer", lambda path: opened.append(path))

    resp = atlas_client.post(f"{BASE}/{WEEK}/open")
    assert resp.status_code == 200
    assert journal_file(tmp_path).exists()
    assert [str(p) for p in opened] == [str(journal_file(tmp_path))]
