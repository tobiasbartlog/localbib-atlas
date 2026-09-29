"""Atlas Publication tests — domain round-trip, store/index, CRUD API.

Issue #42 / ADR-0004: the Publication entity (atlas.publication/1) end-to-end.
Domain tests are pure; API tests follow test_atlas_api.py (the ``atlas_client``
host of conftest.py on a temp dir).
"""
from __future__ import annotations

import pytest

from atlas import config as atlas_config
from atlas.domain import Publication, new_publication


# =============================================================================
# Domain
# =============================================================================

def test_publication_round_trip_preserves_all_fields():
    pub = Publication(
        id="fgc-paper", title="FGC Paper", status="in-revision",
        venue="Automation in Construction", type="journal-article",
        authors=["T. Bartlog", "A. Coauthor"],
        submitted="2026-01-15", published="2026-05-01", due="2025-12-31",
        tags=["fgc", "robotik"], refs=["Smith2020", "Doe2021"],
        derived_from=["2025-01-01-fgc-idee"], manuscripts=["fgc-paper.tex"],
        projects=["fgc-projekt"], paper="bartlog2026fgc",
        body="## Abstract\n\nEntwurf.",
    )
    reparsed = Publication.from_markdown(pub.to_markdown())
    assert reparsed.to_frontmatter() == pub.to_frontmatter()
    assert reparsed.authors == ["T. Bartlog", "A. Coauthor"]
    assert reparsed.refs == ["Smith2020", "Doe2021"]
    assert reparsed.manuscripts == ["fgc-paper.tex"]
    assert reparsed.projects == ["fgc-projekt"]
    assert reparsed.paper == "bartlog2026fgc"
    assert reparsed.body.strip().startswith("## Abstract")
    # round-trip is stable (content_hash / watcher re-index)
    assert reparsed.to_markdown() == pub.to_markdown()


def test_publication_minimal_frontmatter_omits_empty_optionals():
    pub = new_publication("Nur Titel")
    fm = pub.to_frontmatter()
    assert fm == {
        "schema": "atlas.publication/1",
        "id": "nur-titel",
        "title": "Nur Titel",
        "status": "planned",
    }


def test_publication_validate_matches_schema_enums():
    assert new_publication("Ein Paper").validate() == []
    ok = new_publication("Typed", type="conference-paper", status="submitted")
    assert ok.validate() == []
    bad = Publication(id="x", title="", status="bogus", type="poster")
    errs = bad.validate()
    assert any("title" in e for e in errs)
    assert any("status" in e for e in errs)
    assert any("type" in e for e in errs)


def test_publication_id_must_match_filename():
    pub = new_publication("Mein Paper")
    pub.path = "C:/somewhere/anderer-name.md"
    assert any("Dateiname" in e for e in pub.validate())


def test_publication_tolerant_parse_of_minimal_file():
    md = "---\nschema: atlas.publication/1\ntitle: Alt\n---\nBody.\n"
    pub = Publication.from_markdown(md, id_hint="alt")
    assert pub.id == "alt"
    assert pub.status == "planned"
    assert pub.refs == [] and pub.manuscripts == [] and pub.projects == []
    assert pub.paper is None


# =============================================================================
# Store
# =============================================================================

from atlas import config
from atlas.domain import new_idea
from atlas.store import AtlasStore


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(atlas_config, "_base_dir", str(tmp_path))
    config.ensure_dirs()
    return AtlasStore()


def test_index_and_get_publication(store):
    store.index_publication(Publication(
        id="p1", title="P1", status="drafting", refs=["Smith2020"], paper="own2026",
    ))
    loaded = store.get_publication("p1")
    assert loaded is not None
    assert loaded.status == "drafting"
    assert loaded.refs == ["Smith2020"]
    assert loaded.paper == "own2026"


def test_reindex_includes_publications(store):
    store.save_publication_file(new_publication("Erste Veroeffentlichung"))
    stats = store.reindex()
    assert stats["publications_indexed"] == 1
    assert stats["publications_invalid"] == 0


def test_publications_for_citekey_via_refs_and_paper_selflink(store):
    store.index_publication(Publication(id="a", title="A", refs=["Smith2020"]))
    store.index_publication(Publication(id="b", title="B", paper="Smith2020"))
    store.index_publication(Publication(id="c", title="C"))
    assert sorted(p.id for p in store.publications_for_citekey("Smith2020")) == ["a", "b"]
    assert store.publications_for_citekey("nope") == []


def test_check_reports_hanging_publication_links(store):
    idea = new_idea("Echte Idee")
    store.save_idea_file(idea)
    real_idea = idea.id
    (config.manuscripts_dir() / "vorhanden.tex").write_text("x", encoding="utf-8")
    store.save_publication_file(Publication(
        id="p", title="P",
        refs=["Known2020", "Ghost2020"],
        paper="GhostSelf2026",
        derived_from=[real_idea, "ghost-idea"],
        manuscripts=["vorhanden.tex", "fehlt.tex"],
        projects=["ghost-projekt"],
    ))
    store.reindex()
    report = {e["id"]: e["issues"] for e in store.check(resolve_citekey=lambda k: k == "Known2020")}
    issues = report.get("p", [])
    assert any("haengender ref" in i and "Ghost2020" in i for i in issues)
    assert not any("Known2020" in i for i in issues)
    assert any("paper-Selbstlink" in i and "GhostSelf2026" in i for i in issues)
    assert any("derived_from" in i and "ghost-idea" in i for i in issues)
    assert not any(real_idea in i and "derived_from" in i for i in issues)
    assert any("Manuskript" in i and "fehlt.tex" in i for i in issues)
    assert not any("vorhanden.tex" in i for i in issues)
    assert any("projects-Verweis" in i and "ghost-projekt" in i for i in issues)


def test_check_never_repairs_hanging_links(store):
    """Warnings only: the file on disk keeps the hanging refs untouched."""
    path = store.save_publication_file(Publication(id="p", title="P", refs=["Ghost2020"]))
    store.reindex()
    store.check(resolve_citekey=lambda k: False)
    assert "Ghost2020" in path.read_text(encoding="utf-8")
    assert store.get_publication("p").refs == ["Ghost2020"]


# =============================================================================
# API (style of test_atlas_api.py)
# =============================================================================

def test_publications_empty_initially(atlas_client):
    resp = atlas_client.get("/api/plugins/atlas/publications")
    assert resp.status_code == 200
    assert resp.json() == {"publications": []}


def test_create_with_only_title_writes_markdown_file(atlas_client, tmp_path):
    created = atlas_client.post(
        "/api/plugins/atlas/publications", json={"title": "Nur Titel"}
    ).json()
    assert created["status"] == "planned"
    assert created["errors"] == []
    md = tmp_path / "veroeffentlichungen" / f"{created['id']}.md"
    assert md.exists()
    text = md.read_text(encoding="utf-8")
    assert "schema: atlas.publication/1" in text
    assert "title: Nur Titel" in text


def test_create_requires_title(atlas_client):
    assert atlas_client.post("/api/plugins/atlas/publications", json={"title": "  "}).status_code == 400


def test_duplicate_titles_get_unique_ids(atlas_client):
    a = atlas_client.post("/api/plugins/atlas/publications", json={"title": "Same"}).json()
    b = atlas_client.post("/api/plugins/atlas/publications", json={"title": "Same"}).json()
    assert a["id"] != b["id"]


def test_crud_list_get_update_delete(atlas_client, tmp_path):
    created = atlas_client.post("/api/plugins/atlas/publications", json={
        "title": "FGC Paper", "type": "journal-article",
        "venue": "AutCon", "authors": ["T. Bartlog"],
        "refs": ["Smith2020"], "tags": ["fgc"],
    }).json()
    pid = created["id"]

    plist = atlas_client.get("/api/plugins/atlas/publications").json()["publications"]
    assert pid in [p["id"] for p in plist]

    upd = atlas_client.put(f"/api/plugins/atlas/publications/{pid}", json={
        "status": "submitted", "submitted": "2026-06-01",
        "manuscripts": ["fgc-paper"], "projects": ["fgc-projekt"],
        "derived_from": ["irgendeine-idee"], "paper": "bartlog2026fgc",
        "due": "2026-08-01", "published": None,
    }).json()
    assert upd["status"] == "submitted"
    assert upd["submitted"] == "2026-06-01"
    assert upd["manuscripts"] == ["fgc-paper"]
    assert upd["projects"] == ["fgc-projekt"]
    assert upd["paper"] == "bartlog2026fgc"
    # unchanged fields preserved
    assert upd["venue"] == "AutCon"
    assert upd["authors"] == ["T. Bartlog"]

    got = atlas_client.get(f"/api/plugins/atlas/publications/{pid}").json()
    assert got["status"] == "submitted"

    deleted = atlas_client.delete(f"/api/plugins/atlas/publications/{pid}")
    assert deleted.status_code == 200
    assert not (tmp_path / "veroeffentlichungen" / f"{pid}.md").exists()
    assert atlas_client.get(f"/api/plugins/atlas/publications/{pid}").status_code == 404


def test_update_rejects_empty_title(atlas_client):
    created = atlas_client.post("/api/plugins/atlas/publications", json={"title": "Keep"}).json()
    resp = atlas_client.put(f"/api/plugins/atlas/publications/{created['id']}", json={"title": "   "})
    assert resp.status_code == 400


def test_get_unknown_returns_404(atlas_client):
    assert atlas_client.get("/api/plugins/atlas/publications/nope").status_code == 404
    assert atlas_client.put("/api/plugins/atlas/publications/nope", json={"title": "x"}).status_code == 404
    assert atlas_client.delete("/api/plugins/atlas/publications/nope").status_code == 404


def test_links_lookup_includes_publications(atlas_client):
    atlas_client.post("/api/plugins/atlas/publications", json={"title": "Zitiert Doe", "refs": ["doe2024"]})
    atlas_client.post("/api/plugins/atlas/publications", json={"title": "Selbstlink", "paper": "doe2024"})
    atlas_client.post("/api/plugins/atlas/publications", json={"title": "Ohne Bezug"})
    atlas_client.post("/api/plugins/atlas/ideas", json={"title": "Idee zitiert Doe", "refs": ["doe2024"]})

    res = atlas_client.get("/api/plugins/atlas/links/doe2024").json()
    assert [i["title"] for i in res["ideas"]] == ["Idee zitiert Doe"]
    assert sorted(p["title"] for p in res["publications"]) == ["Selbstlink", "Zitiert Doe"]

    none = atlas_client.get("/api/plugins/atlas/links/unbekannt").json()
    assert none["publications"] == []


def test_detail_resolves_hanging_links_as_warnings(atlas_client, tmp_path):
    # one real manuscript, one hanging
    atlas_client.post("/api/plugins/atlas/manuscripts", json={"title": "Vorhanden"})
    created = atlas_client.post("/api/plugins/atlas/publications", json={
        "title": "Mit Warnungen",
        "refs": ["Ghost2020"],
        "manuscripts": ["vorhanden", "fehlt.tex"],
        "derived_from": ["ghost-idea"],
        "projects": ["ghost-projekt"],
        "paper": "GhostSelf2026",
    }).json()

    got = atlas_client.get(f"/api/plugins/atlas/publications/{created['id']}").json()
    by_key = {r["citekey"]: r for r in got["refs_resolved"]}
    assert by_key["Ghost2020"]["found"] is False
    assert got["paper_resolved"]["found"] is False
    by_name = {m["name"]: m for m in got["manuscripts_resolved"]}
    assert by_name["vorhanden"]["found"] is True
    assert by_name["fehlt.tex"]["found"] is False
    assert got["origins"] == [{"id": "ghost-idea", "kind": "unknown", "title": "ghost-idea"}]
    assert got["projects_resolved"] == [{"id": "ghost-projekt", "found": False, "title": "ghost-projekt"}]

    # never auto-repaired: the frontmatter keeps every hanging link
    md = (tmp_path / "veroeffentlichungen" / f"{created['id']}.md").read_text(encoding="utf-8")
    for hanging in ("Ghost2020", "fehlt.tex", "ghost-idea", "ghost-projekt", "GhostSelf2026"):
        assert hanging in md


def test_detail_resolves_derived_from_idea_and_project(atlas_client):
    idea = atlas_client.post("/api/plugins/atlas/ideas", json={"title": "Quelle"}).json()
    project = atlas_client.post("/api/plugins/atlas/projects", json={"title": "Traegerprojekt"}).json()
    created = atlas_client.post("/api/plugins/atlas/publications", json={
        "title": "Abgeleitet",
        "derived_from": [idea["id"]],
        "projects": [project["id"]],
    }).json()
    got = atlas_client.get(f"/api/plugins/atlas/publications/{created['id']}").json()
    assert got["origins"] == [{"id": idea["id"], "kind": "idea", "title": "Quelle"}]
    assert got["projects_resolved"] == [{"id": project["id"], "found": True, "title": "Traegerprojekt"}]


def test_reindex_picks_up_external_publication_file(atlas_client, tmp_path):
    pub_dir = tmp_path / "veroeffentlichungen"
    pub_dir.mkdir(exist_ok=True)
    (pub_dir / "extern.md").write_text(
        "---\nschema: atlas.publication/1\nid: extern\ntitle: Extern angelegt\n"
        "status: drafting\n---\nBody.\n",
        encoding="utf-8",
    )
    stats = atlas_client.post("/api/plugins/atlas/reindex").json()
    assert stats["publications_indexed"] == 1
    got = atlas_client.get("/api/plugins/atlas/publications/extern")
    assert got.status_code == 200
    assert got.json()["title"] == "Extern angelegt"
