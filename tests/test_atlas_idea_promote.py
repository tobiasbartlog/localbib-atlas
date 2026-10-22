"""Idea statuses v2 + Promote (Idea -> Publication) — issue #46 / ADR-0004.

Domain tests are pure; the migration planner gets scenario tests and the
executor a temp-dir filesystem test (style of test_atlas_migration.py);
the promote flow is exercised through the ``atlas_client`` host (conftest.py).
"""
from __future__ import annotations

from pathlib import Path

import pytest

from atlas import config as atlas_config
from atlas import config
from atlas.domain import IDEA_STATUSES, Idea, new_idea, publication_from_idea
from atlas.migration import migrate_legacy_ideas, plan_idea_migration


def _legacy_idea_md(
    *, pid="2025-01-01-fgc-idee", title="FGC Idee", status="drafting",
    extra="", body="## Skizze\n\nText.\n",
) -> str:
    return (
        f"---\nschema: atlas.idea/1\nid: {pid}\ntitle: {title}\n"
        f"type: paper-idea\nstatus: {status}\n{extra}---\n\n{body}"
    )


# =============================================================================
# Domain (atlas.idea/2)
# =============================================================================

def test_idea_statuses_v2_enum():
    assert IDEA_STATUSES == {"seed", "developing", "promoted", "parked"}


def test_new_idea_serialises_as_schema_v2():
    assert "schema: atlas.idea/2" in new_idea("Frisch").to_markdown()


@pytest.mark.parametrize("status", ["seed", "developing", "promoted", "parked"])
def test_validate_accepts_v2_statuses(status):
    idea = new_idea("Ok")
    idea.status = status
    assert idea.validate() == []


@pytest.mark.parametrize("status", ["drafting", "published"])
def test_validate_rejects_retired_v1_statuses(status):
    idea = new_idea("Alt")
    idea.status = status
    assert any("status" in e for e in idea.validate())


def test_publication_from_idea_copies_refs_tags_body_and_links_back():
    idea = Idea(
        id="2025-01-01-fgc-idee", title="FGC Idee", status="developing",
        tags=["fgc", "robotik"], refs=["Smith2020", "Doe2021"],
        body="## Skizze\n\nText.",
    )
    pub = publication_from_idea(idea)
    assert pub.id == "fgc-idee"
    assert pub.title == "FGC Idee"
    assert pub.status == "planned"
    assert pub.tags == ["fgc", "robotik"]
    assert pub.refs == ["Smith2020", "Doe2021"]
    assert pub.derived_from == ["2025-01-01-fgc-idee"]
    assert pub.body == idea.body
    assert pub.validate() == []
    # copies, not aliases — later edits must not bleed between the entities
    pub.refs.append("New2026")
    assert idea.refs == ["Smith2020", "Doe2021"]


# =============================================================================
# Migration planner (pure)
# =============================================================================

@pytest.mark.parametrize("old,new", [
    ("drafting", "developing"),
    ("published", "promoted"),
    ("seed", "seed"),
    ("developing", "developing"),
    ("parked", "parked"),
])
def test_plan_maps_legacy_statuses_and_bumps_schema(old, new):
    plan = plan_idea_migration([("i.md", _legacy_idea_md(pid="i", status=old))])
    action = plan.actions[0]
    assert (action.old_status, action.new_status) == (old, new)
    assert action.name == "i.md"  # rewritten in place, no move
    migrated = Idea.from_markdown(action.content, id_hint="i")
    assert migrated.status == new
    assert "schema: atlas.idea/2" in action.content
    assert migrated.validate() == []
    assert plan.warnings == []


def test_plan_keeps_all_other_fields():
    md = _legacy_idea_md(
        pid="i", status="published",
        extra=(
            "tags:\n- fgc\nrefs:\n- Smith2020\ndiss:\n- kapitel-3\n"
            "venue: ICRA\ncreated: '2025-01-01'\nupdated: '2025-02-02'\n"
        ),
    )
    plan = plan_idea_migration([("i.md", md)])
    migrated = Idea.from_markdown(plan.actions[0].content, id_hint="i")
    assert migrated.tags == ["fgc"]
    assert migrated.refs == ["Smith2020"]
    assert migrated.diss == ["kapitel-3"]
    assert migrated.venue == "ICRA"
    assert migrated.created == "2025-01-01"
    assert migrated.updated == "2025-02-02"
    assert migrated.body.startswith("## Skizze")


def test_plan_keeps_unknown_status_verbatim_with_warning():
    plan = plan_idea_migration([("i.md", _legacy_idea_md(pid="i", status="komisch"))])
    assert plan.actions[0].new_status == "komisch"
    assert any("komisch" in w for w in plan.warnings)


def test_plan_skips_non_legacy_files_untouched():
    v2 = "---\nschema: atlas.idea/2\nid: neu\ntitle: Neu\ntype: paper-idea\nstatus: seed\n---\n"
    noschema = "---\ntitle: Lose Notiz\n---\nText.\n"
    plan = plan_idea_migration([("neu.md", v2), ("notiz.md", noschema)])
    assert plan.empty
    assert sorted(plan.skipped) == ["neu.md", "notiz.md"]


def test_plan_skips_unreadable_frontmatter_with_warning():
    plan = plan_idea_migration([("kaputt.md", "---\n{ kein: [yaml\n---\nx\n")])
    assert plan.empty
    assert plan.skipped == ["kaputt.md"]
    assert any("kaputt.md" in w for w in plan.warnings)


def test_plan_is_idempotent_after_apply():
    first = plan_idea_migration([("i.md", _legacy_idea_md(pid="i"))])
    assert not first.empty
    second = plan_idea_migration([("i.md", first.actions[0].content)])
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


def test_executor_rewrites_in_place_backs_up_and_is_idempotent(atlas_dir):
    legacy = atlas_dir / "ideen" / "alte-idee.md"
    legacy.write_text(_legacy_idea_md(pid="alte-idee", status="published"), encoding="utf-8")
    keeper = atlas_dir / "ideen" / "neue-idee.md"
    keeper_md = "---\nschema: atlas.idea/2\nid: neue-idee\ntitle: Neu\ntype: paper-idea\nstatus: seed\n---\n"
    keeper.write_text(keeper_md, encoding="utf-8")

    report = migrate_legacy_ideas()
    assert report["migrated"] == 1
    assert report["mappings"] == [
        {"file": "alte-idee.md", "from": "published", "to": "promoted"}
    ]

    # backup taken before the write: it still contains the legacy original
    backups = _backups(atlas_dir)
    assert len(backups) == 1
    assert report["backup"] == str(backups[0])
    backed_up = (backups[0] / "ideen" / "alte-idee.md").read_text(encoding="utf-8")
    assert "schema: atlas.idea/1" in backed_up

    # rewritten in place; non-legacy file untouched
    migrated = Idea.from_file(legacy)
    assert migrated.id == "alte-idee"
    assert migrated.status == "promoted"
    assert migrated.validate() == []
    assert keeper.read_text(encoding="utf-8") == keeper_md

    # second run: empty plan, no write, no second backup
    second = migrate_legacy_ideas()
    assert second["migrated"] == 0
    assert second["backup"] is None
    assert len(_backups(atlas_dir)) == 1


def test_executor_without_legacy_files_takes_no_backup(atlas_dir):
    report = migrate_legacy_ideas()
    assert report["migrated"] == 0
    assert report["backup"] is None
    assert _backups(atlas_dir) == []


# =============================================================================
# Startup + Promote flow (TestClient)
# =============================================================================

@pytest.fixture
def atlas_base(tmp_path, monkeypatch):
    base = tmp_path / "atlas"
    monkeypatch.setattr(atlas_config, "_base_dir", str(base))
    return base


def test_startup_migrates_legacy_idea_statuses(atlas_app, atlas_base):
    ideen = atlas_base / "ideen"
    ideen.mkdir(parents=True)
    (ideen / "entwurf.md").write_text(
        _legacy_idea_md(pid="entwurf", status="drafting"), encoding="utf-8"
    )
    (ideen / "fertig.md").write_text(
        _legacy_idea_md(pid="fertig", status="published"), encoding="utf-8"
    )

    with atlas_app(atlas_base) as client:
        ideas = {i["id"]: i for i in client.get("/api/plugins/atlas/ideas").json()["ideas"]}
        assert ideas["entwurf"]["status"] == "developing"
        assert ideas["fertig"]["status"] == "promoted"
        assert ideas["entwurf"]["errors"] == []

    assert "schema: atlas.idea/2" in (ideen / "entwurf.md").read_text(encoding="utf-8")

    # restart: idempotent — nothing new to migrate, no second backup
    with atlas_app(atlas_base) as client:
        ideas = {i["id"]: i for i in client.get("/api/plugins/atlas/ideas").json()["ideas"]}
        assert ideas["entwurf"]["status"] == "developing"
    assert len(sorted(atlas_base.parent.glob(f"{atlas_base.name}-backup-*"))) == 1


def test_promote_creates_publication_and_marks_idea(atlas_client, tmp_path):
    idea = atlas_client.post("/api/plugins/atlas/ideas", json={
        "title": "FGC Bahnplanung", "tags": ["fgc"], "refs": ["Smith2020"],
        "body": "## Skizze\n\nText.",
    }).json()

    res = atlas_client.post(f"/api/plugins/atlas/ideas/{idea['id']}/promote")
    assert res.status_code == 200
    data = res.json()

    pub = data["publication"]
    assert pub["title"] == "FGC Bahnplanung"
    assert pub["status"] == "planned"
    assert pub["tags"] == ["fgc"]
    assert pub["refs"] == ["Smith2020"]
    assert pub["derived_from"] == [idea["id"]]
    assert pub["body"].strip().startswith("## Skizze")
    assert pub["errors"] == []

    # the idea stays (P1) — file in place, status promoted
    assert data["idea"]["status"] == "promoted"
    idea_file = tmp_path / "ideen" / f"{idea['id']}.md"
    assert idea_file.exists()
    assert "status: promoted" in idea_file.read_text(encoding="utf-8")
    assert (tmp_path / "veroeffentlichungen" / f"{pub['id']}.md").exists()

    # both sides visible through the API; the publication shows the back-link
    listed = atlas_client.get("/api/plugins/atlas/publications").json()["publications"]
    assert [p["id"] for p in listed] == [pub["id"]]
    detail = atlas_client.get(f"/api/plugins/atlas/publications/{pub['id']}").json()
    assert detail["origins"] == [
        {"id": idea["id"], "kind": "idea", "title": "FGC Bahnplanung"}
    ]
    assert atlas_client.get(f"/api/plugins/atlas/ideas/{idea['id']}").json()["status"] == "promoted"


def test_promote_unknown_idea_returns_404(atlas_client):
    assert atlas_client.post("/api/plugins/atlas/ideas/gibt-es-nicht/promote").status_code == 404


def test_a_failed_publication_write_leaves_the_idea_unpromoted(atlas_client, tmp_path, monkeypatch):
    """Review 2026-10-18 (A3): the Publication is written before the idea is
    marked — a lock on the new file (OneDrive) answers 423 and leaves the
    idea exactly as it was, never ``promoted`` without its Publication."""
    idea = atlas_client.post("/api/plugins/atlas/ideas", json={"title": "FGC Bahnplanung"}).json()
    idea_file = tmp_path / "ideen" / f"{idea['id']}.md"
    before = idea_file.read_bytes()
    publications = tmp_path / "veroeffentlichungen"
    real = Path.write_text

    def write_text(self, *args, **kwargs):
        if Path(self).parent == publications:
            raise PermissionError(13, "gesperrt", str(self))
        return real(self, *args, **kwargs)

    monkeypatch.setattr(Path, "write_text", write_text)
    res = atlas_client.post(f"/api/plugins/atlas/ideas/{idea['id']}/promote")
    monkeypatch.setattr(Path, "write_text", real)

    assert (res.status_code, res.json()["detail"]) == (423, "error.atlas.document_locked")
    assert idea_file.read_bytes() == before
    assert list(publications.glob("*.md")) == []
    assert atlas_client.get(f"/api/plugins/atlas/ideas/{idea['id']}").json()["status"] == idea["status"]
    assert atlas_client.get("/api/plugins/atlas/publications").json()["publications"] == []


def test_promote_two_ideas_with_same_title_get_unique_publication_ids(atlas_client):
    a = atlas_client.post("/api/plugins/atlas/ideas", json={"title": "Gleicher Titel"}).json()
    b = atlas_client.post("/api/plugins/atlas/ideas", json={"title": "Gleicher Titel"}).json()
    pub_a = atlas_client.post(f"/api/plugins/atlas/ideas/{a['id']}/promote").json()["publication"]
    pub_b = atlas_client.post(f"/api/plugins/atlas/ideas/{b['id']}/promote").json()["publication"]
    assert pub_a["id"] != pub_b["id"]
    assert pub_a["derived_from"] == [a["id"]]
    assert pub_b["derived_from"] == [b["id"]]
