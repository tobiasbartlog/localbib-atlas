"""Atlas research-project domain tests (atlas.project/3, ADR-0004) —
entity round-trip, validation, milestones timeline, checklist parsing.

Beware: atlas.project/3 is a different entity than /1|/2 (legacy Publications,
see test_atlas_migration.py)."""
from __future__ import annotations

from datetime import date

from atlas import config as atlas_config
from atlas.domain import (
    Project,
    annotate_milestones,
    new_project,
    normalize_milestone,
    parse_checklist,
    parse_sections,
)


def test_parse_checklist_counts_and_fence_aware():
    body = (
        "## AP1 Aufbau\n"
        "- [x] Testprogramm schreiben\n"
        "- [ ] Latenz messen\n"
        "- [X] Ergebnis eintragen\n"
        "```\n- [ ] nicht zaehlen (im Codeblock)\n```\n"
    )
    cl = parse_checklist(body)
    assert cl["total"] == 3
    assert cl["done"] == 2
    assert cl["items"][1] == {"text": "Latenz messen", "done": False}


# --- work-package sections (issue #48, pure) ----------------------------------

def test_parse_sections_per_heading_stats():
    body = (
        "Projektkontext, keine Aufgabe.\n\n"
        "## AP1 Aufbau\n"
        "- [x] eins\n"
        "- [ ] zwei\n\n"
        "## AP2 Auswertung\n"
        "Prosa im AP.\n"
        "- [x] drei\n"
    )
    secs = parse_sections(body)
    assert [s["title"] for s in secs] == ["AP1 Aufbau", "AP2 Auswertung"]
    assert (secs[0]["done"], secs[0]["total"]) == (1, 2)
    assert (secs[1]["done"], secs[1]["total"]) == (1, 1)
    assert secs[0]["items"][1] == {"text": "zwei", "done": False}


def test_parse_sections_preamble_only_when_it_has_items():
    # checklist before the first heading -> title-less preamble section
    secs = parse_sections("- [ ] lose Aufgabe\n\n## AP1\n- [x] a\n")
    assert [s["title"] for s in secs] == [None, "AP1"]
    assert (secs[0]["done"], secs[0]["total"]) == (0, 1)
    # prose-only preamble is dropped
    secs = parse_sections("Nur Prosa.\n\n## AP1\n- [x] a\n")
    assert [s["title"] for s in secs] == ["AP1"]


def test_parse_sections_keeps_empty_work_packages():
    secs = parse_sections("## AP1\n- [ ] a\n\n## AP2 (noch leer)\nProsa.\n")
    assert [(s["title"], s["total"]) for s in secs] == [("AP1", 1), ("AP2 (noch leer)", 0)]


def test_parse_sections_fence_aware():
    body = (
        "## AP1\n"
        "- [x] echt\n"
        "```\n"
        "## Kein AP (Codeblock)\n"
        "- [ ] nicht zaehlen\n"
        "```\n"
        "- [ ] auch echt\n"
    )
    secs = parse_sections(body)
    assert [s["title"] for s in secs] == ["AP1"]
    assert (secs[0]["done"], secs[0]["total"]) == (1, 2)


def test_parse_sections_nested_headings_stay_in_their_ap():
    body = (
        "## AP1\n"
        "- [ ] a\n"
        "### Teilaufgaben\n"
        "- [x] b\n"
        "## AP2\n"
        "- [ ] c\n"
    )
    secs = parse_sections(body)
    assert [s["title"] for s in secs] == ["AP1", "AP2"]
    assert (secs[0]["done"], secs[0]["total"]) == (1, 2)  # incl. ### sub-heading
    assert (secs[1]["done"], secs[1]["total"]) == (0, 1)


def test_parse_sections_splits_at_topmost_level_present():
    # body that uses "# AP1" instead of "## AP1" splits at level 1
    secs = parse_sections("# AP1\n- [ ] a\n## Detail\n- [x] b\n# AP2\n- [ ] c\n")
    assert [(s["title"], s["level"]) for s in secs] == [("AP1", 1), ("AP2", 1)]
    assert secs[0]["total"] == 2


def test_parse_sections_empty_and_headingless_bodies():
    assert parse_sections("") == []
    assert parse_sections("Nur Prosa, nichts zu tun.") == []
    secs = parse_sections("- [x] a\n- [ ] b\n")
    assert [s["title"] for s in secs] == [None]
    assert (secs[0]["done"], secs[0]["total"]) == (1, 2)


def test_parse_checklist_is_flat_concatenation_of_sections():
    # the toggle endpoint indexes into the flat list — order must match the
    # concatenated section items in document order
    body = "- [ ] null\n## AP1\n- [x] eins\n## AP2\n- [ ] zwei\n"
    flat = parse_checklist(body)
    concatenated = [it for s in parse_sections(body) for it in s["items"]]
    assert flat["items"] == concatenated
    assert [it["text"] for it in flat["items"]] == ["null", "eins", "zwei"]
    assert (flat["done"], flat["total"]) == (1, 3)


def test_project_round_trip_preserves_all_fields():
    proj = Project(
        id="fgc-robotik", title="FGC Robotik", status="active",
        start="2026-01-01", end="2028-12-31",
        funder="DFG", grant_id="BA 1234/5-1", role="PI",
        tags=["robotik"], refs=["Smith2020"],
        milestones=[
            {"title": "Kickoff", "date": "2026-02-01", "done": True},
            {"title": "Zwischenbericht", "date": "2027-06-30", "done": False},
        ],
        body="## AP1 Aufbau\n- [ ] tun",
    )
    reparsed = Project.from_markdown(proj.to_markdown())
    assert reparsed.to_frontmatter() == proj.to_frontmatter()
    assert reparsed.start == "2026-01-01" and reparsed.end == "2028-12-31"
    assert reparsed.funder == "DFG"
    assert reparsed.grant_id == "BA 1234/5-1"
    assert reparsed.role == "PI"
    assert reparsed.refs == ["Smith2020"]
    assert reparsed.milestones == [
        {"title": "Kickoff", "date": "2026-02-01", "done": True},
        {"title": "Zwischenbericht", "date": "2027-06-30", "done": False},
    ]
    assert reparsed.body.strip().startswith("## AP1")
    # round-trip is stable (content_hash / watcher re-index)
    assert reparsed.to_markdown() == proj.to_markdown()


def test_project_minimal_frontmatter_omits_empty_optionals():
    proj = new_project("Nur Titel")
    assert proj.to_frontmatter() == {
        "schema": "atlas.project/5",
        "id": "nur-titel",
        "title": "Nur Titel",
        "status": "planned",
    }
    assert proj.validate() == []


def test_project_validate_matches_schema_enums():
    assert new_project("Ein Projekt", status="applied").validate() == []
    bad = Project(id="x", title="", status="done")  # "done" was /2, not /3
    errs = bad.validate()
    assert any("title" in e for e in errs)
    assert any("status" in e for e in errs)


def test_project_validate_dates_and_milestones():
    bad = Project(
        id="p", title="P", status="planned",
        start="Januar 2026",
        milestones=[
            {"title": "", "date": "2026-01-01", "done": False},
            {"title": "Krummes Datum", "date": "bald", "done": False},
        ],
    )
    errs = bad.validate()
    assert any("start" in e and "ISO" in e for e in errs)
    assert any("Meilenstein 1" in e and "title" in e for e in errs)
    assert any("Meilenstein 2" in e and "ISO" in e for e in errs)


def test_project_tolerant_parse_normalizes_milestones():
    md = (
        "---\nschema: atlas.project/3\nid: p\ntitle: P\nstatus: planned\n"
        "milestones:\n"
        "- title: Kickoff\n  date: 2026-02-01\n  done: true\n"
        "- Nur ein String\n"
        "---\nBody.\n"
    )
    proj = Project.from_markdown(md, id_hint="p")
    # YAML date object -> ISO string; bare string -> title-only milestone
    assert proj.milestones == [
        {"title": "Kickoff", "date": "2026-02-01", "done": True},
        {"title": "Nur ein String", "date": None, "done": False},
    ]


def test_project_id_must_match_filename():
    proj = new_project("Mein Projekt")
    proj.path = "C:/somewhere/anderer-name.md"
    assert any("Dateiname" in e for e in proj.validate())


def test_new_project_id_is_slug():
    assert new_project("FGC: Robotik AO").id == "fgc-robotik-ao"


def test_normalize_milestone_defaults():
    assert normalize_milestone({}) == {"title": "", "date": None, "done": False}
    assert normalize_milestone({"title": "M", "done": 1}) == {
        "title": "M", "date": None, "done": True,
    }


# --- milestones timeline (pure) ----------------------------------------------

def test_annotate_milestones_states_and_next():
    today = date(2026, 6, 12)
    milestones = [
        {"title": "Abschluss", "date": "2027-01-01", "done": False},
        {"title": "Kickoff", "date": "2026-01-01", "done": True},
        {"title": "Verpasst", "date": "2026-06-01", "done": False},
        {"title": "Irgendwann", "date": None, "done": False},
        {"title": "Review", "date": "2026-07-01", "done": False},
    ]
    annotated = annotate_milestones(milestones, today=today)
    # timeline order: dated chronologically, undated last
    assert [m["title"] for m in annotated] == [
        "Kickoff", "Verpasst", "Review", "Abschluss", "Irgendwann",
    ]
    by_title = {m["title"]: m for m in annotated}
    assert by_title["Kickoff"]["state"] == "done"
    assert by_title["Verpasst"]["state"] == "overdue"
    assert by_title["Review"]["state"] == "upcoming"
    assert by_title["Abschluss"]["state"] == "upcoming"
    assert by_title["Irgendwann"]["state"] == "undated"
    # exactly one "next": the earliest upcoming
    assert [m["title"] for m in annotated if m["next"]] == ["Review"]
    # index points back into the frontmatter list (stable handle for edits)
    assert by_title["Verpasst"]["index"] == 2


def test_annotate_milestones_today_is_not_overdue():
    today = date(2026, 6, 12)
    annotated = annotate_milestones(
        [{"title": "Heute", "date": "2026-06-12", "done": False}], today=today
    )
    assert annotated[0]["state"] == "upcoming"
    assert annotated[0]["next"] is True


def test_annotate_milestones_empty_and_done_only():
    assert annotate_milestones([], today=date(2026, 1, 1)) == []
    annotated = annotate_milestones(
        [{"title": "Fertig", "date": "2020-01-01", "done": True}],
        today=date(2026, 1, 1),
    )
    assert annotated[0]["state"] == "done"
    assert not any(m["next"] for m in annotated)


def test_project_to_dict_progress_and_milestones():
    proj = Project(
        id="p", title="P", status="active",
        milestones=[{"title": "M1", "date": "2026-01-01", "done": False}],
        body="- [x] a\n- [ ] b",
    )
    d = proj.to_dict()
    assert d["checklist"]["total"] == 2 and d["checklist"]["done"] == 1
    assert d["progress"] == 0.5
    assert d["milestones"] == [{"title": "M1", "date": "2026-01-01", "done": False}]


# --- store ------------------------------------------------------------------

import pytest

from atlas import config
from atlas.store import AtlasStore


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(atlas_config, "_base_dir", str(tmp_path))
    config.ensure_dirs()
    return AtlasStore()


def test_index_and_get_project_round_trips_all_fields(store):
    store.index_project(Project(
        id="p1", title="P1", status="active",
        start="2026-01-01", end="2028-12-31",
        funder="DFG", grant_id="BA 1/1", role="PI",
        refs=["Smith2020", "Doe2021"],
        milestones=[{"title": "Kickoff", "date": "2026-02-01", "done": True}],
        body="- [x] a\n- [ ] b",
    ))
    loaded = store.get_project("p1")
    assert loaded is not None
    assert (loaded.start, loaded.end) == ("2026-01-01", "2028-12-31")
    assert (loaded.funder, loaded.grant_id, loaded.role) == ("DFG", "BA 1/1", "PI")
    assert loaded.refs == ["Smith2020", "Doe2021"]
    assert loaded.milestones == [{"title": "Kickoff", "date": "2026-02-01", "done": True}]
    assert loaded.checklist["total"] == 2 and loaded.checklist["done"] == 1


def test_reindex_includes_projects(store):
    store.save_project_file(new_project("Erstes Projekt"))
    stats = store.reindex()
    assert stats["projects_indexed"] == 1
    assert stats["projects_invalid"] == 0


def test_projects_for_citekey(store):
    store.index_project(Project(id="a", title="A", refs=["Smith2020"]))
    store.index_project(Project(id="b", title="B"))
    assert [p.id for p in store.projects_for_citekey("Smith2020")] == ["a"]
    assert store.projects_for_citekey("nope") == []
    assert store.projects_for_citekey("") == []


def test_check_reports_hanging_project_refs(store):
    store.save_project_file(Project(id="p", title="P", status="active",
                                    refs=["Known2020", "Ghost2020"]))
    store.reindex()
    report = {e["id"]: e["issues"] for e in store.check(resolve_citekey=lambda k: k == "Known2020")}
    issues = report.get("p", [])
    assert any("haengender ref" in i and "Ghost2020" in i for i in issues)
    assert not any("Known2020" in i for i in issues)


def test_check_never_repairs_hanging_project_refs(store):
    path = store.save_project_file(Project(id="p", title="P", refs=["Ghost2020"]))
    store.reindex()
    store.check(resolve_citekey=lambda k: False)
    assert "Ghost2020" in path.read_text(encoding="utf-8")
    assert store.get_project("p").refs == ["Ghost2020"]


def test_external_body_edit_updates_sections_after_reindex(store):
    """AC issue #48: editing the Markdown body externally updates the per-AP
    progress after reindex (Markdown is the source of truth, P1)."""
    path = store.save_project_file(Project(
        id="p", title="P", status="active",
        body="## AP1 Aufbau\n- [ ] eins\n",
    ))
    store.reindex()
    before = store.get_project("p").to_dict()["sections"]
    assert [(s["title"], s["done"], s["total"]) for s in before] == [("AP1 Aufbau", 0, 1)]

    # external edit: tick the task, add a second one and a whole new AP
    text = path.read_text(encoding="utf-8").replace(
        "- [ ] eins",
        "- [x] eins\n- [ ] zwei\n\n## AP2 Auswertung\n- [x] drei",
    )
    path.write_text(text, encoding="utf-8")
    store.reindex()

    after = store.get_project("p").to_dict()
    assert [(s["title"], s["done"], s["total"]) for s in after["sections"]] == [
        ("AP1 Aufbau", 1, 2), ("AP2 Auswertung", 1, 1),
    ]
    assert after["checklist"]["done"] == 2 and after["checklist"]["total"] == 3
    assert after["progress"] == 2 / 3


def test_store_drops_legacy_projects_table_layout(tmp_path, monkeypatch):
    """A pre-/3 atlas.db (old projects columns) is rebuilt, not ALTERed —
    the index is derived (P1) and repopulated by the post-activation reindex."""
    import sqlite3

    monkeypatch.setattr(atlas_config, "_base_dir", str(tmp_path))
    config.ensure_dirs()
    db = config.db_path()
    db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db))
    conn.execute(
        "CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT, status TEXT,"
        " derived_from TEXT, refs TEXT, due TEXT, tags TEXT, body TEXT, path TEXT,"
        " content_hash TEXT, valid INTEGER, errors TEXT)"
    )
    conn.execute(
        "INSERT INTO projects (id, title) VALUES ('alt', 'Altes Projekt')"
    )
    conn.commit()
    conn.close()

    store = AtlasStore()
    assert store.list_projects() == []  # old rows dropped with the old layout
    store.index_project(new_project("Neues Projekt", milestones=[{"title": "M"}]))
    assert store.get_project("neues-projekt").milestones == [
        {"title": "M", "date": None, "done": False}
    ]
