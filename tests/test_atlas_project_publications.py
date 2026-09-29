"""Atlas Project<->Publication linking tests (issue #50, ADR-0004).

The link is stored downstream on the Publication (``projects`` field); the
Project page derives its publication list by reverse lookup. Both UI
directions write the Publication's Markdown file, never the project file.
Store tests are pure; API tests follow test_atlas_api.py (the ``atlas_client``
host of conftest.py on a temp dir).
"""
from __future__ import annotations

import pytest

from atlas import config as atlas_config
from atlas import config
from atlas.domain import Publication, new_project
from atlas.store import AtlasStore


# =============================================================================
# Store: reverse lookup
# =============================================================================

@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(atlas_config, "_base_dir", str(tmp_path))
    config.ensure_dirs()
    return AtlasStore()


def test_publications_for_project_reverse_lookup(store):
    store.index_publication(Publication(id="a", title="A", projects=["fgc"]))
    store.index_publication(Publication(id="b", title="B", projects=["fgc", "other"]))
    store.index_publication(Publication(id="c", title="C", projects=["other"]))
    store.index_publication(Publication(id="d", title="D"))
    assert sorted(p.id for p in store.publications_for_project("fgc")) == ["a", "b"]
    assert sorted(p.id for p in store.publications_for_project("other")) == ["b", "c"]
    assert store.publications_for_project("nope") == []
    assert store.publications_for_project("") == []


def test_reverse_lookup_reads_only_the_publication_side(store):
    """The project file carries no link — the lookup works without any project
    indexed at all (link stored downstream, ADR-0004)."""
    store.index_publication(Publication(id="p", title="P", projects=["ghost-projekt"]))
    assert [p.id for p in store.publications_for_project("ghost-projekt")] == ["p"]


# =============================================================================
# API (style of test_atlas_api.py)
# =============================================================================

def _create_project(client, title="FGC Projekt"):
    return client.post("/api/plugins/atlas/projects", json={"title": title}).json()


def _create_publication(client, title="FGC Paper", **fields):
    return client.post(
        "/api/plugins/atlas/publications", json={"title": title, **fields}
    ).json()


def test_project_detail_lists_publications_via_reverse_lookup(atlas_client):
    project = _create_project(atlas_client)
    _create_publication(atlas_client, "Aus dem Projekt", projects=[project["id"]],
                        status="drafting", venue="AutCon")
    _create_publication(atlas_client, "Auch aus dem Projekt", projects=[project["id"]])
    _create_publication(atlas_client, "Ohne Bezug")

    got = atlas_client.get(f"/api/plugins/atlas/projects/{project['id']}").json()
    assert sorted(p["title"] for p in got["publications"]) == [
        "Auch aus dem Projekt", "Aus dem Projekt",
    ]
    by_title = {p["title"]: p for p in got["publications"]}
    assert by_title["Aus dem Projekt"]["status"] == "drafting"
    assert by_title["Aus dem Projekt"]["venue"] == "AutCon"


def test_link_from_project_writes_the_publication_file_only(atlas_client, tmp_path):
    project = _create_project(atlas_client)
    publication = _create_publication(atlas_client)
    project_md = tmp_path / "projekte" / f"{project['id']}.md"
    publication_md = tmp_path / "veroeffentlichungen" / f"{publication['id']}.md"
    project_before = project_md.read_text(encoding="utf-8")

    resp = atlas_client.post(
        f"/api/plugins/atlas/projects/{project['id']}/publications",
        json={"publication_id": publication["id"]},
    )
    assert resp.status_code == 200
    assert [p["id"] for p in resp.json()["publications"]] == [publication["id"]]

    # Link stored downstream: the Publication's frontmatter carries the project
    # id, the project file is byte-for-byte untouched (ADR-0004).
    assert project["id"] in publication_md.read_text(encoding="utf-8")
    assert project_md.read_text(encoding="utf-8") == project_before
    got = atlas_client.get(f"/api/plugins/atlas/publications/{publication['id']}").json()
    assert got["projects"] == [project["id"]]


def test_link_is_idempotent(atlas_client):
    project = _create_project(atlas_client)
    publication = _create_publication(atlas_client)
    for _ in range(2):
        resp = atlas_client.post(
            f"/api/plugins/atlas/projects/{project['id']}/publications",
            json={"publication_id": publication["id"]},
        )
        assert resp.status_code == 200
    got = atlas_client.get(f"/api/plugins/atlas/publications/{publication['id']}").json()
    assert got["projects"] == [project["id"]]


def test_link_keeps_existing_projects(atlas_client):
    project = _create_project(atlas_client)
    publication = _create_publication(atlas_client, projects=["anderes-projekt"])
    atlas_client.post(
        f"/api/plugins/atlas/projects/{project['id']}/publications",
        json={"publication_id": publication["id"]},
    )
    got = atlas_client.get(f"/api/plugins/atlas/publications/{publication['id']}").json()
    assert got["projects"] == ["anderes-projekt", project["id"]]


def test_link_unknown_project_or_publication_404(atlas_client):
    project = _create_project(atlas_client)
    publication = _create_publication(atlas_client)
    # Hanging links are never created by the assignment action: a nonexistent
    # project cannot be linked (free-text editing stays possible via PUT).
    assert atlas_client.post(
        "/api/plugins/atlas/projects/nope/publications",
        json={"publication_id": publication["id"]},
    ).status_code == 404
    assert atlas_client.post(
        f"/api/plugins/atlas/projects/{project['id']}/publications",
        json={"publication_id": "nope"},
    ).status_code == 404
    assert atlas_client.get(
        f"/api/plugins/atlas/publications/{publication['id']}"
    ).json()["projects"] == []


def test_unlink_removes_the_link_from_the_publication_file(atlas_client, tmp_path):
    project = _create_project(atlas_client)
    publication = _create_publication(atlas_client, projects=[project["id"]])
    resp = atlas_client.delete(
        f"/api/plugins/atlas/projects/{project['id']}/publications/{publication['id']}"
    )
    assert resp.status_code == 200
    assert resp.json()["publications"] == []
    md = (tmp_path / "veroeffentlichungen" / f"{publication['id']}.md").read_text(encoding="utf-8")
    assert project["id"] not in md
    assert atlas_client.get(
        f"/api/plugins/atlas/publications/{publication['id']}"
    ).json()["projects"] == []


def test_unlink_works_for_hanging_project_ids(atlas_client):
    """Removing a link is an explicit user action, not an auto-repair — it
    works even when the project file no longer exists."""
    publication = _create_publication(atlas_client, projects=["ghost-projekt"])
    resp = atlas_client.delete(
        f"/api/plugins/atlas/projects/ghost-projekt/publications/{publication['id']}"
    )
    assert resp.status_code == 200
    assert atlas_client.get(
        f"/api/plugins/atlas/publications/{publication['id']}"
    ).json()["projects"] == []


def test_unlink_unknown_link_or_publication_404(atlas_client):
    project = _create_project(atlas_client)
    publication = _create_publication(atlas_client)  # not linked
    assert atlas_client.delete(
        f"/api/plugins/atlas/projects/{project['id']}/publications/{publication['id']}"
    ).status_code == 404
    assert atlas_client.delete(
        f"/api/plugins/atlas/projects/{project['id']}/publications/nope"
    ).status_code == 404


def test_publication_side_edit_updates_the_reverse_lookup(atlas_client):
    """The other UI direction: editing the projects field on the Publication
    detail (PUT) is the same downstream write — the project page follows."""
    project = _create_project(atlas_client)
    publication = _create_publication(atlas_client)

    atlas_client.put(
        f"/api/plugins/atlas/publications/{publication['id']}",
        json={"projects": [project["id"]]},
    )
    got = atlas_client.get(f"/api/plugins/atlas/projects/{project['id']}").json()
    assert [p["id"] for p in got["publications"]] == [publication["id"]]

    atlas_client.put(
        f"/api/plugins/atlas/publications/{publication['id']}", json={"projects": []}
    )
    got = atlas_client.get(f"/api/plugins/atlas/projects/{project['id']}").json()
    assert got["publications"] == []


def test_hanging_project_ids_stay_visible_as_warnings(atlas_client, tmp_path):
    """Hanging project ids warn (publication detail + /check), never repaired."""
    publication = _create_publication(atlas_client, projects=["ghost-projekt"])
    got = atlas_client.get(f"/api/plugins/atlas/publications/{publication['id']}").json()
    assert got["projects_resolved"] == [
        {"id": "ghost-projekt", "found": False, "title": "ghost-projekt"}
    ]
    report = atlas_client.get("/api/plugins/atlas/check").json()["report"]
    issues = {e["id"]: e["issues"] for e in report}.get(publication["id"], [])
    assert any("projects-Verweis" in i and "ghost-projekt" in i for i in issues)
    # never auto-repaired
    md = (tmp_path / "veroeffentlichungen" / f"{publication['id']}.md").read_text(encoding="utf-8")
    assert "ghost-projekt" in md
    assert atlas_client.get(
        f"/api/plugins/atlas/publications/{publication['id']}"
    ).json()["projects"] == ["ghost-projekt"]


def test_chain_idea_publication_paper_stays_navigable(atlas_client):
    """Idea -> Publication -> own Paper: the detail payload resolves each hop
    so the SPA can navigate the chain (issue #50)."""
    idea = atlas_client.post("/api/plugins/atlas/ideas", json={"title": "Keimzelle"}).json()
    project = _create_project(atlas_client)
    publication = _create_publication(
        atlas_client, "Kette",
        derived_from=[idea["id"]], projects=[project["id"]], paper="own2026",
    )
    got = atlas_client.get(f"/api/plugins/atlas/publications/{publication['id']}").json()
    assert got["origins"] == [{"id": idea["id"], "kind": "idea", "title": "Keimzelle"}]
    assert got["projects_resolved"] == [
        {"id": project["id"], "found": True, "title": project["title"]}
    ]
    assert got["paper_resolved"] is not None  # cite-key hop resolved (hanging -> warning)
