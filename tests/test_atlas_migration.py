"""Atlas startup migration tests — legacy atlas.project/1|2 -> atlas.publication/1.

Issue #43 / ADR-0004. The planner is pure (scenario tests: legacy variants,
status mapping, collisions, idempotence); the executor gets filesystem tests
against a temp dir; the startup path is exercised through the
``atlas_app`` host of conftest.py (a ``with`` block is one app run).
"""
from __future__ import annotations

import pytest

from atlas import config as atlas_config
from atlas import config
from atlas.domain import Publication
from atlas.migration import migrate_legacy_projects, plan_migration


def _legacy_md(
    *, schema="atlas.project/2", pid="altes-paper", title="Altes Paper",
    status="active", extra="", body="## Notizen\n\n- [x] BibTeX importiert\n",
) -> str:
    return (
        f"---\nschema: {schema}\nid: {pid}\ntitle: {title}\n"
        f"status: {status}\n{extra}---\n\n{body}"
    )


# =============================================================================
# Planner (pure)
# =============================================================================

def test_plan_converts_legacy_v1_and_v2_to_valid_publications():
    v1 = "---\nschema: atlas.project/1\nid: p-eins\ntitle: P1\nstatus: idea\n---\nBody 1.\n"
    v2 = _legacy_md(schema="atlas.project/2", pid="p-zwei", title="P2", status="done")
    plan = plan_migration([("p-eins.md", v1), ("p-zwei.md", v2)], set())
    assert [a.target_name for a in plan.actions] == ["p-eins.md", "p-zwei.md"]
    assert plan.skipped == [] and plan.warnings == []
    for action in plan.actions:
        pub = Publication.from_markdown(action.content)
        assert pub.validate() == []
        assert "schema: atlas.publication/3" in action.content


def test_plan_carries_all_legacy_fields_over():
    md = _legacy_md(
        pid="fgc", title="FGC Paper", status="active",
        extra=(
            "derived_from:\n- 2025-01-01-fgc-idee\n- kapitel-3\n"
            "refs:\n- Smith2020\n- Doe2021\n"
            "due: '2026-09-01'\n"
            "tags:\n- fgc\n- robotik\n"
        ),
        body="## Abstract\n\nEntwurf.\n",
    )
    plan = plan_migration([("fgc.md", md)], set())
    pub = Publication.from_markdown(plan.actions[0].content)
    assert pub.id == "fgc"
    assert pub.title == "FGC Paper"
    assert pub.refs == ["Smith2020", "Doe2021"]
    # derived_from kept verbatim — a diss-node entry stays a hanging-link
    # warning (store.check()), never silently dropped or repaired.
    assert pub.derived_from == ["2025-01-01-fgc-idee", "kapitel-3"]
    assert pub.due == "2026-09-01"
    assert pub.tags == ["fgc", "robotik"]
    assert pub.body.startswith("## Abstract")


@pytest.mark.parametrize("old,new,lossy", [
    ("idea", "planned", True),
    ("active", "drafting", False),
    ("paused", "planned", True),
    ("done", "published", False),
])
def test_plan_status_mapping_and_lossy_flag(old, new, lossy):
    plan = plan_migration([("p.md", _legacy_md(pid="p", status=old))], set())
    action = plan.actions[0]
    assert (action.old_status, action.new_status, action.lossy) == (old, new, lossy)
    assert Publication.from_markdown(action.content).status == new


def test_plan_unknown_status_maps_to_planned_with_warning():
    plan = plan_migration([("p.md", _legacy_md(pid="p", status="komisch"))], set())
    assert plan.actions[0].new_status == "planned"
    assert any("komisch" in w for w in plan.warnings)


def test_plan_skips_non_legacy_files_untouched():
    v3 = "---\nschema: atlas.project/3\nid: forschung\ntitle: F\nstatus: active\n---\n"
    pub = "---\nschema: atlas.publication/1\nid: fertig\ntitle: Fertig\nstatus: planned\n---\n"
    noschema = "---\ntitle: Lose Notiz\n---\nText.\n"
    plan = plan_migration(
        [("forschung.md", v3), ("fertig.md", pub), ("notiz.md", noschema)], set()
    )
    assert plan.empty
    assert sorted(plan.skipped) == ["fertig.md", "forschung.md", "notiz.md"]


def test_plan_skips_unreadable_frontmatter_with_warning():
    plan = plan_migration([("kaputt.md", "---\n{ kein: [yaml\n---\nx\n")], set())
    assert plan.empty
    assert plan.skipped == ["kaputt.md"]
    assert any("kaputt.md" in w for w in plan.warnings)


def test_plan_renames_on_id_collision_with_existing_publication():
    plan = plan_migration(
        [("doppelt.md", _legacy_md(pid="doppelt"))],
        {"doppelt", "doppelt-2"},
    )
    action = plan.actions[0]
    assert action.target_name == "doppelt-3.md"
    assert Publication.from_markdown(action.content).id == "doppelt-3"
    assert any("kollidiert" in w for w in plan.warnings)


def test_plan_counts_an_existing_name_in_another_case_as_taken():
    """Windows/macOS file names ignore case: ``foo.md`` would open and
    truncate a hand-named ``Foo.md`` (review 2026-10-18)."""
    plan = plan_migration(
        [("a.md", _legacy_md(pid="foo")), ("b.md", _legacy_md(pid="FOO-2"))], {"Foo"}
    )
    assert [a.target_name for a in plan.actions] == ["foo-2.md", "FOO-2-2.md"]
    assert sum("kollidiert" in w for w in plan.warnings) == 2


def test_plan_is_idempotent_after_apply():
    """Simulated apply: legacy files gone, their ids now taken — empty 2nd plan."""
    first = plan_migration([("p.md", _legacy_md(pid="p"))], set())
    assert not first.empty
    migrated_ids = {a.target_name[:-3] for a in first.actions}
    second = plan_migration([], migrated_ids)
    assert second.empty and second.warnings == []


# =============================================================================
# Executor (temp dir)
# =============================================================================

@pytest.fixture
def atlas_dir(tmp_path, monkeypatch):
    base = tmp_path / "atlas"
    monkeypatch.setattr(atlas_config, "_base_dir", str(base))
    config.ensure_dirs()
    return base


def _backups(base):
    return sorted(base.parent.glob(f"{base.name}-backup-*"))


def test_executor_migrates_backs_up_and_is_idempotent(atlas_dir):
    legacy = atlas_dir / "projekte" / "altes-paper.md"
    legacy.write_text(_legacy_md(status="paused"), encoding="utf-8")
    keeper = atlas_dir / "projekte" / "forschung.md"
    keeper.write_text(
        "---\nschema: atlas.project/3\nid: forschung\ntitle: F\nstatus: active\n---\n",
        encoding="utf-8",
    )

    report = migrate_legacy_projects()
    assert report["migrated"] == 1
    assert report["mappings"] == [
        {"file": "altes-paper.md", "from": "paused", "to": "planned", "lossy": True}
    ]
    assert report["lossy_mappings"] == report["mappings"]

    # backup taken before the write: it still contains the legacy original
    backups = _backups(atlas_dir)
    assert len(backups) == 1
    assert report["backup"] == str(backups[0])
    backed_up = (backups[0] / "projekte" / "altes-paper.md").read_text(encoding="utf-8")
    assert "schema: atlas.project/2" in backed_up

    # moved + rewritten; non-legacy file untouched
    assert not legacy.exists()
    assert keeper.exists()
    migrated = atlas_dir / "veroeffentlichungen" / "altes-paper.md"
    pub = Publication.from_file(migrated)
    assert pub.validate() == []
    assert pub.status == "planned"

    # second run: empty plan, no write, no second backup
    second = migrate_legacy_projects()
    assert second["migrated"] == 0
    assert second["backup"] is None
    assert len(_backups(atlas_dir)) == 1


def test_executor_without_legacy_files_takes_no_backup(atlas_dir):
    report = migrate_legacy_projects()
    assert report["migrated"] == 0
    assert report["backup"] is None
    assert _backups(atlas_dir) == []


def test_executor_resolves_id_collision_against_existing_publication(atlas_dir):
    (atlas_dir / "veroeffentlichungen" / "doppelt.md").write_text(
        "---\nschema: atlas.publication/1\nid: doppelt\ntitle: Schon da\nstatus: planned\n---\n",
        encoding="utf-8",
    )
    (atlas_dir / "projekte" / "doppelt.md").write_text(
        _legacy_md(pid="doppelt", title="Legacy"), encoding="utf-8"
    )
    report = migrate_legacy_projects()
    assert report["migrated"] == 1
    assert any("kollidiert" in w for w in report["warnings"])
    survivor = atlas_dir / "veroeffentlichungen" / "doppelt.md"
    assert "Schon da" in survivor.read_text(encoding="utf-8")
    renamed = Publication.from_file(atlas_dir / "veroeffentlichungen" / "doppelt-2.md")
    assert renamed.id == "doppelt-2" and renamed.title == "Legacy"
    assert renamed.validate() == []


# =============================================================================
# Startup (atlas_app host — migration runs in activate, before reindex)
# =============================================================================

@pytest.fixture
def atlas_base(tmp_path, monkeypatch):
    base = tmp_path / "atlas"
    monkeypatch.setattr(atlas_config, "_base_dir", str(base))
    return base


def test_startup_migrates_legacy_projects_into_publications_ui(atlas_app, atlas_base):
    projekte = atlas_base / "projekte"
    projekte.mkdir(parents=True)
    (projekte / "altes-paper.md").write_text(
        _legacy_md(status="done", extra="refs:\n- Smith2020\n"), encoding="utf-8"
    )

    with atlas_app(atlas_base) as client:
        pubs = client.get("/api/plugins/atlas/publications").json()["publications"]
        assert [p["id"] for p in pubs] == ["altes-paper"]
        assert pubs[0]["status"] == "published"
        assert pubs[0]["refs"] == ["Smith2020"]
        # the legacy entity is gone from the projects area
        projects = client.get("/api/plugins/atlas/projects").json()["projects"]
        assert projects == []

    assert not (projekte / "altes-paper.md").exists()
    assert (atlas_base / "veroeffentlichungen" / "altes-paper.md").exists()
    assert len(_backups(atlas_base)) == 1

    # restart: idempotent — nothing new to migrate, no second backup
    with atlas_app(atlas_base) as client:
        pubs = client.get("/api/plugins/atlas/publications").json()["publications"]
        assert [p["id"] for p in pubs] == ["altes-paper"]
    assert len(_backups(atlas_base)) == 1
