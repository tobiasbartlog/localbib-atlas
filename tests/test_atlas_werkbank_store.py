"""Atlas Werkbank store tests (issue #180, slice 2).

Behaviour only: what a store call puts into the Markdown file and what the
index answers afterwards — never SQL, never table shapes. Companion of
``test_atlas_store.py`` (the four classic entities) for Journal, Zettel and
the Verweis edges.
"""
from __future__ import annotations

import pytest

from atlas import config as atlas_config
from atlas import config
from atlas.domain import DissNode, new_idea
from atlas.journal import Journal
from atlas.store import AtlasStore
from atlas.weeks import week_id
from atlas.zettel import Zettel, new_zettel

WEDNESDAY = "2026-09-23"
THURSDAY = "2026-09-24"
NEXT_MONDAY = "2026-09-28"
WEEK = week_id(WEDNESDAY)
NEXT_WEEK = week_id(NEXT_MONDAY)


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(atlas_config, "_base_dir", str(tmp_path))
    config.ensure_dirs()
    return AtlasStore()


def journal_text(week: str = WEEK) -> str:
    return (config.journal_dir() / f"{week}.md").read_text(encoding="utf-8")


# --- folders -----------------------------------------------------------------

def test_ensure_dirs_creates_journal_and_zettel(store):
    assert config.journal_dir().is_dir()
    assert config.zettel_dir().is_dir()


# --- Zettel ------------------------------------------------------------------

def test_creating_a_zettel_writes_markdown_with_schema_and_default_type(store):
    zettel = new_zettel("Betreuergespraech Mai")
    path = store.save_zettel_file(zettel)
    store.index_zettel_file(path)

    text = path.read_text(encoding="utf-8")
    assert path.parent == config.zettel_dir()
    assert "schema: atlas.zettel/1" in text
    assert "type: fleeting" in text

    indexed = store.get_zettel(zettel.id)
    assert indexed.title == "Betreuergespraech Mai"
    assert indexed.type == "fleeting"


def test_zettel_list_filters_by_type_and_searches(store):
    reading = new_zettel("Lektuere Latour", type="reading", refs=["latour2005"])
    reading.body = "Akteur-Netzwerk und die Rolle der Objekte."
    meeting = new_zettel("Besprechung", type="meeting", tags=["methodik"])
    for z in (reading, meeting):
        store.index_zettel_file(store.save_zettel_file(z))

    assert [z.id for z in store.list_zettel(type="reading")] == [reading.id]
    assert [z.id for z in store.list_zettel(q="akteur-netzwerk")] == [reading.id]
    assert [z.id for z in store.list_zettel(q="latour2005")] == [reading.id]
    assert [z.id for z in store.list_zettel(q="methodik")] == [meeting.id]
    assert store.list_zettel(q="nirgendwo") == []
    assert len(store.list_zettel()) == 2


def test_zettel_for_citekey(store):
    hit = new_zettel("Lektuere", type="reading", refs=["doe2024", "smith2023"])
    miss = new_zettel("Anderes", type="fleeting")
    for z in (hit, miss):
        store.index_zettel_file(store.save_zettel_file(z))

    assert [z.id for z in store.zettel_for_citekey("doe2024")] == [hit.id]
    assert store.zettel_for_citekey("missing2030") == []
    assert store.zettel_for_citekey("") == []


# --- Journal write primitives ------------------------------------------------

def test_add_task_creates_week_file_with_day_heading(store):
    task = store.add_task(WEEK, WEDNESDAY, "Abschnitt 3 ueberarbeiten [[kap-methodik]] #schreiben")

    text = journal_text()
    assert "week: " + WEEK in text
    assert "## Mittwoch 2026-09-23" in text
    assert "- [ ] Abschnitt 3 ueberarbeiten [[kap-methodik]] #schreiben" in text
    assert task["body_index"] == 0
    assert task["anchors"] == ["kap-methodik"]
    assert task["tags"] == ["schreiben"]

    indexed = store.list_journal_tasks()
    assert [t["day"] for t in indexed] == [WEDNESDAY]
    assert indexed[0]["text"] == "Abschnitt 3 ueberarbeiten"


def test_second_task_joins_the_day_a_new_day_gets_its_own_heading(store):
    store.add_task(WEEK, THURSDAY, "Donnerstag zuerst angelegt")
    store.add_task(WEEK, WEDNESDAY, "Mittwoch danach")
    store.add_task(WEEK, WEDNESDAY, "Mittwoch zweiter Task")

    lines = [ln for ln in journal_text().splitlines() if ln.strip()]
    body = lines[lines.index("## Mittwoch 2026-09-23"):]
    assert body[:3] == [
        "## Mittwoch 2026-09-23",
        "- [ ] Mittwoch danach",
        "- [ ] Mittwoch zweiter Task",
    ]
    # Days are sorted ascending, so Mittwoch stands before Donnerstag.
    assert lines.index("## Mittwoch 2026-09-23") < lines.index("## Donnerstag 2026-09-24")
    assert [t["day"] for t in store.list_journal_tasks()] == [
        WEDNESDAY, WEDNESDAY, THURSDAY,
    ]


def test_toggle_changes_one_line_and_the_index(store):
    store.add_task(WEEK, WEDNESDAY, "Erster")
    store.add_task(WEEK, WEDNESDAY, "Zweiter")
    before = journal_text()

    store.toggle_task(WEEK, 1)

    after = journal_text()
    assert after == before.replace("- [ ] Zweiter", "- [x] Zweiter")
    assert [t["done"] for t in store.list_journal_tasks()] == [False, True]


def test_update_and_delete_task(store):
    store.add_task(WEEK, WEDNESDAY, "Tippfehla")
    store.add_task(WEEK, WEDNESDAY, "Bleibt stehen")

    store.update_task(WEEK, 0, "Tippfehler behoben")
    assert "- [ ] Tippfehler behoben" in journal_text()

    store.delete_task(WEEK, 0)
    text = journal_text()
    assert "Tippfehler behoben" not in text
    assert "- [ ] Bleibt stehen" in text
    assert [t["text"] for t in store.list_journal_tasks()] == ["Bleibt stehen"]


def test_move_across_the_week_boundary_creates_the_second_file(store):
    store.add_task(WEEK, WEDNESDAY, "Mail an Betreuer")

    result = store.move_task(WEEK, 0, NEXT_MONDAY)

    source = journal_text()
    assert f"- [ ] Mail an Betreuer →{NEXT_MONDAY}" in source
    target = journal_text(NEXT_WEEK)
    assert "## Montag 2026-09-28" in target
    assert f"- [ ] Mail an Betreuer ←{WEDNESDAY}" in target
    assert result["week"] == NEXT_WEEK
    assert result["body_index"] == 0

    # The source line is no longer open, the carried one is.
    by_week = {(t["week"], t["body_index"]): t for t in store.list_journal_tasks()}
    assert by_week[(WEEK, 0)]["open"] is False
    assert by_week[(WEEK, 0)]["moved_to"] == NEXT_MONDAY
    assert by_week[(NEXT_WEEK, 0)]["open"] is True
    assert by_week[(NEXT_WEEK, 0)]["moved_from"] == WEDNESDAY


def test_move_inside_the_week_stays_in_one_file(store):
    store.add_task(WEEK, WEDNESDAY, "Verschiebt sich")
    store.move_task(WEEK, 0, THURSDAY)

    text = journal_text()
    assert f"- [ ] Verschiebt sich →{THURSDAY}" in text
    assert f"- [ ] Verschiebt sich ←{WEDNESDAY}" in text
    assert not (config.journal_dir() / f"{NEXT_WEEK}.md").exists()


def test_reorder_task_within_the_day(store):
    for text in ("Erster", "Zweiter", "Dritter"):
        store.add_task(WEEK, WEDNESDAY, text)

    store.reorder_task(WEEK, 2, 0)

    assert [t["text"] for t in store.list_journal_tasks()] == ["Dritter", "Erster", "Zweiter"]


def test_set_goals_keeps_the_body_byte_identical(store):
    store.add_task(WEEK, WEDNESDAY, "Task bleibt unberuehrt [[kap-methodik]]")
    body_before = journal_text().split("---\n", 2)[2]

    store.set_goals(WEEK, [{"title": "Kapitel 3 fertig", "anchor": "kap-methodik"}])

    text = journal_text()
    assert text.split("---\n", 2)[2] == body_before
    assert "Kapitel 3 fertig" in text
    assert store.read_journal(WEEK).goals[0]["anchor"] == "kap-methodik"
    assert store.list_journal_weeks()[0]["goals"][0]["title"] == "Kapitel 3 fertig"

    store.toggle_goal(WEEK, 0)
    assert store.read_journal(WEEK).goals[0]["done"] is True


def test_set_goals_refuses_more_than_five(store):
    with pytest.raises(ValueError):
        store.set_goals(WEEK, [{"title": f"Ziel {i}"} for i in range(6)])


def test_reading_a_missing_week_creates_no_file(store):
    journal = store.read_journal(WEEK)
    assert journal.week == WEEK
    assert journal.tasks == []
    assert not (config.journal_dir() / f"{WEEK}.md").exists()


def test_add_task_refuses_a_day_outside_the_week(store):
    with pytest.raises(ValueError):
        store.add_task(WEEK, NEXT_MONDAY, "Falsche Woche")


# --- Verweise ----------------------------------------------------------------

def _chapter(store, node_id: str, title: str, body: str = "") -> DissNode:
    node = DissNode(id=node_id, title=title, order=1, status="draft", body=body)
    store.index_diss_file(store.save_node_file(node))
    return node


def test_backlinks_group_zettel_chapters_and_tasks(store):
    chapter = _chapter(store, "kap-methodik", "Methodik", "Siehe [[gespraech]].")
    zettel = Zettel(id="gespraech", title="Betreuergespraech", type="meeting",
                    date=WEDNESDAY, body="Betrifft [[kap-methodik]].")
    store.index_zettel_file(store.save_zettel_file(zettel))
    store.add_task(WEEK, WEDNESDAY, "Abschnitt 3 [[kap-methodik]]")

    back = store.backlinks("kap-methodik")
    assert [z["id"] for z in back["zettel"]] == ["gespraech"]
    assert [t["day"] for t in back["tasks"]] == [WEDNESDAY]
    assert back["tasks"][0]["text"] == "Abschnitt 3"
    assert back["tasks"][0]["week"] == WEEK
    assert back["tasks"][0]["done"] is False
    assert back["chapters"] == []

    assert [c["title"] for c in store.backlinks("gespraech")["chapters"]] == ["Methodik"]
    assert chapter.id in {e["id"] for e in store.entities()}


def test_tasks_for_anchor_across_weeks(store):
    store.add_task(WEEK, WEDNESDAY, "Offen [[kap-methodik]]")
    store.add_task(WEEK, WEDNESDAY, "Erledigt [[kap-methodik]]")
    store.toggle_task(WEEK, 1)
    store.add_task(NEXT_WEEK, NEXT_MONDAY, "Naechste Woche [[kap-methodik]]")
    store.add_task(WEEK, WEDNESDAY, "Ohne Anker")

    all_tasks = store.tasks_for_anchor("kap-methodik")
    assert [t["text"] for t in all_tasks] == ["Offen", "Erledigt", "Naechste Woche"]
    assert [t["text"] for t in store.tasks_for_anchor("kap-methodik", open_only=True)] == [
        "Offen", "Naechste Woche",
    ]
    assert store.tasks_for_anchor("unbekannt") == []


def test_entities_lists_every_kind_for_the_autocomplete(store):
    _chapter(store, "kap-1", "Einleitung")
    idea = new_idea("Eine Idee")
    store.index_file(store.save_idea_file(idea))
    zettel = new_zettel("Ein Zettel")
    store.index_zettel_file(store.save_zettel_file(zettel))

    entities = {e["id"]: e for e in store.entities()}
    assert entities["kap-1"]["kind"] == "diss_node"
    assert entities[idea.id]["kind"] == "idea"
    assert entities[zettel.id]["kind"] == "zettel"
    assert entities["kap-1"]["title"] == "Einleitung"


def test_deleting_a_file_removes_its_edges(store):
    zettel = Zettel(id="gespraech", title="Gespraech", type="meeting",
                    body="Betrifft [[kap-methodik]].")
    path = store.save_zettel_file(zettel)
    store.index_zettel_file(path)
    _chapter(store, "kap-methodik", "Methodik")
    assert store.backlinks("kap-methodik")["zettel"]

    path.unlink()
    store.remove_path(path)

    assert store.get_zettel("gespraech") is None
    assert store.backlinks("kap-methodik")["zettel"] == []


def test_deleting_a_zettel_by_id_removes_its_edges(store):
    _chapter(store, "kap-methodik", "Methodik")
    zettel = Zettel(id="fluechtig", title="Fluechtig", body="Zu [[kap-methodik]]")
    store.index_zettel_file(store.save_zettel_file(zettel))

    store.delete_zettel("fluechtig")

    assert store.backlinks("kap-methodik")["zettel"] == []


def test_check_reports_a_dangling_verweis_with_source_and_target(store):
    zettel = Zettel(id="gespraech", title="Gespraech", body="Betrifft [[kap-geloescht]].")
    store.index_zettel_file(store.save_zettel_file(zettel))
    store.add_task(WEEK, WEDNESDAY, "Task [[kap-geloescht]]")

    report = store.check()
    dangling = [e for e in report if any("kap-geloescht" in i for i in e["issues"])]
    sources = {e["id"] for e in dangling}
    assert "gespraech" in sources
    assert f"{WEEK}#0" in sources
    assert all("haengender Verweis" in i for e in dangling for i in e["issues"])

    # ... and it disappears once the target exists — never repaired, just gone.
    _chapter(store, "kap-geloescht", "Doch da")
    assert store.dangling_links() == []


# --- full rebuild ------------------------------------------------------------

def test_reindex_from_scratch_restores_journal_zettel_and_links(store):
    _chapter(store, "kap-methodik", "Methodik")
    zettel = Zettel(id="gespraech", title="Gespraech", type="meeting",
                    body="Betrifft [[kap-methodik]].")
    store.save_zettel_file(zettel)
    store.add_task(WEEK, WEDNESDAY, "Abschnitt 3 [[kap-methodik]]")
    store.toggle_task(WEEK, 0)

    # atlas.db is disposable (P1): throw it away and rebuild from the files.
    config.db_path().unlink()
    fresh = AtlasStore()
    stats = fresh.reindex()

    assert stats["zettel_indexed"] == 1
    assert stats["journals_indexed"] == 1
    assert fresh.get_zettel("gespraech").title == "Gespraech"
    tasks = fresh.list_journal_tasks()
    assert [(t["text"], t["done"]) for t in tasks] == [("Abschnitt 3", True)]
    back = fresh.backlinks("kap-methodik")
    assert [z["id"] for z in back["zettel"]] == ["gespraech"]
    assert len(back["tasks"]) == 1
    assert fresh.reindex() == stats


def test_reindex_picks_up_a_hand_written_journal(store):
    """User story 60/61: an externally written week file is fully indexed."""
    (config.journal_dir() / f"{WEEK}.md").write_text(
        Journal(
            week=WEEK,
            goals=[{"title": "Kapitel 3", "anchor": "kap-methodik"}],
            body="## Mittwoch 2026-09-23\n- [x] Von Hand [[kap-methodik]]\n- [ ] Offen\n",
        ).to_markdown(),
        encoding="utf-8",
    )

    store.reindex()

    tasks = store.list_journal_tasks()
    assert [(t["text"], t["done"], t["open"]) for t in tasks] == [
        ("Von Hand", True, False),
        ("Offen", False, True),
    ]
    assert store.list_journal_weeks()[0]["goals"][0]["anchor"] == "kap-methodik"
    assert len(store.backlinks("kap-methodik")["tasks"]) == 1
