"""Core-project migration tests — core paper groupings -> atlas.project/3.

Issue #51 / ADR-0004. The planner is pure (scenario tests: with/without
papers, id collisions with existing Atlas projects and within the batch); the
executor gets filesystem tests against a temp dir with a fake library facade
(marker idempotence, backup, missing facade); the startup path runs through
the ``atlas_app`` host with the contract's ``InMemoryLibrary`` as facade. The
core's own facade (``get_core_projects`` over the core DB) is tested in the
core suite (``tests/test_atlas_bundle.py``).
"""
from __future__ import annotations

import json

import pytest
from plugin_api.testing import InMemoryLibrary

from atlas import config
from atlas import config as atlas_config
from atlas.domain import Project
from atlas.migration import (
    core_migration_marker,
    migrate_core_projects,
    plan_core_project_migration,
)


def _core(pid=1, name="FGC Robotik", description="", refs=None) -> dict:
    return {"id": pid, "name": name, "description": description, "refs": refs or []}


class _FakeLibrary:
    """Library facade stub: only the slice the migration needs."""

    def __init__(self, projects):
        self._projects = projects

    def get_core_projects(self):
        return self._projects


# =============================================================================
# Planner (pure)
# =============================================================================

def test_plan_creates_one_research_project_per_core_project():
    plan = plan_core_project_migration(
        [
            _core(1, "FGC Robotik", "Foerderprojekt.", ["Smith2020", "Doe2021"]),
            _core(2, "Leseliste"),  # without papers -> empty refs, still created
        ],
        set(),
    )
    assert plan.warnings == []
    assert [a.target_name for a in plan.actions] == ["fgc-robotik.md", "leseliste.md"]

    fgc = Project.from_markdown(plan.actions[0].content, id_hint="fgc-robotik")
    assert fgc.validate() == []
    assert fgc.title == "FGC Robotik"
    assert fgc.status == "active"
    assert fgc.refs == ["Smith2020", "Doe2021"]
    assert fgc.body == "Foerderprojekt."
    assert "schema: atlas.project/4" in plan.actions[0].content

    empty = Project.from_markdown(plan.actions[1].content, id_hint="leseliste")
    assert empty.validate() == []
    assert empty.refs == []


def test_plan_dedupes_refs_preserving_order():
    plan = plan_core_project_migration(
        [_core(1, "P", refs=["Smith2020", "Doe2021", "Smith2020"])], set()
    )
    project = Project.from_markdown(plan.actions[0].content, id_hint="p")
    assert project.refs == ["Smith2020", "Doe2021"]


def test_plan_renames_on_collision_with_existing_atlas_project():
    plan = plan_core_project_migration(
        [_core(1, "FGC Robotik")], {"fgc-robotik", "fgc-robotik-2"}
    )
    action = plan.actions[0]
    assert action.target_name == "fgc-robotik-3.md"
    assert Project.from_markdown(action.content, id_hint="x").id == "fgc-robotik-3"
    assert any("kollidiert" in w for w in plan.warnings)


def test_plan_resolves_collisions_within_the_batch():
    plan = plan_core_project_migration(
        [_core(1, "Mein Projekt"), _core(2, "Mein  Projekt")], set()
    )
    assert [a.target_name for a in plan.actions] == [
        "mein-projekt.md",
        "mein-projekt-2.md",
    ]
    assert any("kollidiert" in w for w in plan.warnings)


def test_plan_falls_back_to_core_id_when_name_has_no_slug():
    plan = plan_core_project_migration([_core(7, "???")], set())
    action = plan.actions[0]
    assert action.target_name == "projekt-7.md"
    assert any("Slug" in w for w in plan.warnings)
    project = Project.from_markdown(action.content, id_hint="projekt-7")
    assert project.id == "projekt-7"


def test_plan_is_deterministic_sorted_by_name():
    plan = plan_core_project_migration(
        [_core(2, "Zeta"), _core(1, "Alpha")], set()
    )
    assert [a.name for a in plan.actions] == ["Alpha", "Zeta"]


# =============================================================================
# Executor (temp dir, fake facade)
# =============================================================================

@pytest.fixture
def atlas_dir(tmp_path, monkeypatch):
    base = tmp_path / "atlas"
    monkeypatch.setattr(atlas_config, "_base_dir", str(base))
    config.ensure_dirs()
    return base


def _backups(base):
    return sorted(base.parent.glob(f"{base.name}-backup-*"))


def test_executor_writes_projects_backup_and_marker(atlas_dir):
    library = _FakeLibrary([_core(1, "FGC Robotik", "Beschreibung.", ["Smith2020"])])

    report = migrate_core_projects(library)
    assert report["migrated"] == 1
    assert report["already_migrated"] is False
    assert report["mappings"] == [
        {"core_id": 1, "name": "FGC Robotik", "file": "fgc-robotik.md"}
    ]

    project = Project.from_file(atlas_dir / "projekte" / "fgc-robotik.md")
    assert project.validate() == []
    assert project.status == "active"
    assert project.refs == ["Smith2020"]

    # backup taken before the write: the new file is NOT in the backup
    backups = _backups(atlas_dir)
    assert len(backups) == 1
    assert report["backup"] == str(backups[0])
    assert not (backups[0] / "projekte" / "fgc-robotik.md").exists()

    marker = core_migration_marker()
    assert marker.exists() and report["marker"] == str(marker)
    assert json.loads(marker.read_text(encoding="utf-8"))["mappings"] == report["mappings"]

    # second run: marker short-circuits — no write, no second backup
    second = migrate_core_projects(library)
    assert second["migrated"] == 0
    assert second["already_migrated"] is True
    assert second["backup"] is None
    assert len(_backups(atlas_dir)) == 1


def test_executor_never_recreates_a_user_deleted_project(atlas_dir):
    library = _FakeLibrary([_core(1, "FGC Robotik")])
    assert migrate_core_projects(library)["migrated"] == 1

    (atlas_dir / "projekte" / "fgc-robotik.md").unlink()
    report = migrate_core_projects(library)
    assert report["already_migrated"] is True
    assert not (atlas_dir / "projekte" / "fgc-robotik.md").exists()


def test_executor_without_core_projects_writes_nothing_and_no_marker(atlas_dir):
    report = migrate_core_projects(_FakeLibrary([]))
    assert report["migrated"] == 0
    assert report["backup"] is None
    assert not core_migration_marker().exists()
    assert _backups(atlas_dir) == []


def test_executor_degrades_without_library_facade(atlas_dir):
    report = migrate_core_projects(None)
    assert report["migrated"] == 0
    assert any("get_core_projects" in w for w in report["warnings"])
    assert not core_migration_marker().exists()
    assert _backups(atlas_dir) == []


def test_executor_suffixes_id_on_collision_with_existing_project_file(atlas_dir):
    (atlas_dir / "projekte" / "fgc-robotik.md").write_text(
        "---\nschema: atlas.project/3\nid: fgc-robotik\ntitle: Schon da\nstatus: active\n---\n",
        encoding="utf-8",
    )
    report = migrate_core_projects(_FakeLibrary([_core(1, "FGC Robotik")]))
    assert report["migrated"] == 1
    assert any("kollidiert" in w for w in report["warnings"])
    survivor = atlas_dir / "projekte" / "fgc-robotik.md"
    assert "Schon da" in survivor.read_text(encoding="utf-8")
    renamed = Project.from_file(atlas_dir / "projekte" / "fgc-robotik-2.md")
    assert renamed.id == "fgc-robotik-2" and renamed.title == "FGC Robotik"


# =============================================================================
# Startup (TestClient — migration runs in activate, before reindex)
# =============================================================================

@pytest.fixture
def atlas_base(tmp_path):
    return tmp_path / "atlas"


def test_startup_migrates_core_projects_into_atlas(atlas_app, atlas_base):
    library = InMemoryLibrary(projects=[
        {"id": 1, "name": "FGC Robotik", "description": "", "refs": ["Smith2020"]},
    ])

    with atlas_app(atlas_base, library=library) as client:
        projects = client.get("/api/plugins/atlas/projects").json()["projects"]
        assert [p["id"] for p in projects] == ["fgc-robotik"]
        assert projects[0]["title"] == "FGC Robotik"
        assert projects[0]["status"] == "active"
        assert projects[0]["refs"] == ["Smith2020"]

    # the core rows are never touched (read-only facade); the only new
    # artefacts live in the Atlas folder
    assert len(library.get_core_projects()) == 1
    assert (atlas_base / "projekte" / "fgc-robotik.md").exists()
    assert (atlas_base / ".core-projects-migrated.json").exists()
    assert len(_backups(atlas_base)) == 1

    # restart: marker makes the second run a no-op — no duplicate, no backup
    with atlas_app(atlas_base, library=library) as client:
        projects = client.get("/api/plugins/atlas/projects").json()["projects"]
        assert [p["id"] for p in projects] == ["fgc-robotik"]
    assert len(_backups(atlas_base)) == 1
