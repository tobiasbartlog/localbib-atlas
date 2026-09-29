"""Atlas Werkbank — "Was liegt an" thresholds and the derived Rueckblick."""
from __future__ import annotations

from datetime import date, timedelta

from atlas.agenda import (
    CHAPTER_STALE_DAYS,
    DUE_SOON_DAYS,
    IDEA_SEED_STALE_DAYS,
    carried_tasks,
    open_tasks_before,
    review,
    whats_due,
)
from atlas.journal import parse_tasks

TODAY = date(2026, 9, 23)


def days_ago(n: int) -> str:
    return (TODAY - timedelta(days=n)).isoformat()


def in_days(n: int) -> str:
    return (TODAY + timedelta(days=n)).isoformat()


# =============================================================================
# Was liegt an
# =============================================================================

def test_milestones_inside_the_horizon_and_overdue_ones_are_listed():
    projects = [
        {
            "id": "dfg-lehm",
            "title": "DFG Lehm",
            "milestones": [
                {"title": "Zwischenbericht", "date": days_ago(3)},
                {"title": "Antrag", "date": in_days(DUE_SOON_DAYS - 1)},
                {"title": "Zu weit weg", "date": in_days(DUE_SOON_DAYS + 1)},
                {"title": "Erledigt", "date": days_ago(1), "done": True},
                {"title": "Ohne Datum"},
            ],
        }
    ]
    found = whats_due(projects=projects, today=TODAY)["milestones"]
    assert [m["title"] for m in found] == ["Zwischenbericht", "Antrag"]
    assert [m["state"] for m in found] == ["overdue", "upcoming"]
    assert found[0]["days"] == -3
    assert found[0]["project_id"] == "dfg-lehm"


def test_stale_chapters_start_at_the_threshold():
    chapters = [
        {"id": "kap-1", "title": "Frisch", "modified_at": days_ago(CHAPTER_STALE_DAYS - 1)},
        {"id": "kap-2", "title": "Genau alt", "modified_at": days_ago(CHAPTER_STALE_DAYS)},
        {"id": "kap-3", "title": "Sehr alt", "modified_at": days_ago(90)},
        {"id": "kap-4", "title": "Ohne mtime", "modified_at": None},
    ]
    found = whats_due(chapters=chapters, today=TODAY)["stale_chapters"]
    assert [c["id"] for c in found] == ["kap-3", "kap-2"]  # oldest first
    assert found[0]["days"] == -90


def test_stale_chapters_accept_a_datetime_string():
    chapters = [{"id": "k", "title": "K", "modified_at": f"{days_ago(30)}T08:15:00"}]
    assert whats_due(chapters=chapters, today=TODAY)["stale_chapters"][0]["days"] == -30


def test_stale_seed_ideas_use_the_date_in_their_id():
    old = days_ago(IDEA_SEED_STALE_DAYS)
    ideas = [
        {"id": f"{old}-alte-idee", "title": "Alte Idee", "status": "seed"},
        {"id": f"{days_ago(IDEA_SEED_STALE_DAYS - 1)}-junge-idee", "title": "Jung", "status": "seed"},
        {"id": f"{old}-entwickelt", "title": "Entwickelt", "status": "developing"},
    ]
    found = whats_due(ideas=ideas, today=TODAY)["stale_ideas"]
    assert [i["title"] for i in found] == ["Alte Idee"]
    assert found[0]["created"] == old


def test_an_explicit_created_field_beats_the_id_prefix():
    ideas = [{"id": "2020-01-01-uralt", "title": "X", "status": "seed", "created": days_ago(3)}]
    assert whats_due(ideas=ideas, today=TODAY)["stale_ideas"] == []


def test_whats_due_without_data_is_empty_but_shaped():
    assert whats_due(today=TODAY) == {
        "milestones": [], "stale_chapters": [], "stale_ideas": []
    }


# =============================================================================
# Vortage und Rueckblick
# =============================================================================

WEEK_BODY = "\n".join(
    [
        "## Montag 2026-09-21",
        "- [x] Erledigt #schreiben",
        "- [ ] Dauerbrenner →2026-09-22",
        "## Dienstag 2026-09-22",
        "- [ ] Dauerbrenner ←2026-09-21 →2026-09-23",
        "- [ ] Offen geblieben",
        "## Mittwoch 2026-09-23",
        "- [ ] Dauerbrenner ←2026-09-22",
        "",
    ]
)


def test_open_tasks_before_skips_done_and_moved_tasks():
    tasks = parse_tasks(WEEK_BODY)
    found = open_tasks_before(tasks, "2026-09-23")
    assert [t["text"] for t in found] == ["Offen geblieben"]


def test_carried_tasks_counts_how_often_a_task_was_pushed():
    carried = carried_tasks(parse_tasks(WEEK_BODY))
    assert len(carried) == 1
    assert carried[0]["text"] == "Dauerbrenner"
    assert carried[0]["moves"] == 2
    assert carried[0]["days"] == ["2026-09-21", "2026-09-22", "2026-09-23"]


def test_review_counts_tasks_zettel_goals_and_chapters():
    tasks = parse_tasks(WEEK_BODY)
    result = review(
        "2026-W39",
        tasks=tasks,
        zettel=[
            {"id": "2026-09-22-gespraech", "title": "Gespraech", "type": "meeting", "date": "2026-09-22"},
            {"id": "2026-09-14-alt", "title": "Alt", "type": "fleeting", "date": "2026-09-14"},
        ],
        goals=[
            {"title": "Schreiben", "tag": "schreiben"},
            {"title": "Manuell", "done": True},
            {"title": "Offen"},
        ],
        chapters=[
            {"id": "kap-1", "title": "In der Woche", "modified_at": "2026-09-22T10:00:00"},
            {"id": "kap-2", "title": "Vorwoche", "modified_at": "2026-09-14"},
        ],
    )
    assert result["week"] == "2026-W39"
    assert result["tasks"] == {"total": 5, "done": 1, "open": 2, "moved": 2}
    assert [c["text"] for c in result["carried"]] == ["Dauerbrenner"]
    assert [z["id"] for z in result["zettel"]] == ["2026-09-22-gespraech"]
    assert result["goals"]["total"] == 3
    assert result["goals"]["reached"] == 2  # #schreiben fully done + the manual one
    assert [c["id"] for c in result["chapters"]] == ["kap-1"]


def test_review_of_an_empty_week():
    result = review("2026-W39")
    assert result["tasks"] == {"total": 0, "done": 0, "open": 0, "moved": 0}
    assert result["carried"] == [] and result["zettel"] == []
    assert result["goals"] == {"total": 0, "reached": 0, "items": []}
