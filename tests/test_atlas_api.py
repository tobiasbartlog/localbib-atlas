"""Atlas REST tests against the ``atlas_client`` host of ``conftest.py``.

Whether the core mounts the router only while Atlas is active is a core
concern and tested there (``tests/test_atlas_bundle.py``).
"""
from __future__ import annotations

import pytest




def test_ideas_empty_initially(atlas_client):
    resp = atlas_client.get("/api/plugins/atlas/ideas")
    assert resp.status_code == 200
    assert resp.json() == {"ideas": []}


def test_create_then_list_and_get(atlas_client):
    created = atlas_client.post(
        "/api/plugins/atlas/ideas", json={"title": "My idea", "tags": ["fgc"]}
    ).json()
    assert created["title"] == "My idea"
    assert created["tags"] == ["fgc"]

    ideas = atlas_client.get("/api/plugins/atlas/ideas").json()["ideas"]
    assert [i["id"] for i in ideas] == [created["id"]]

    got = atlas_client.get(f"/api/plugins/atlas/ideas/{created['id']}")
    assert got.status_code == 200
    assert got.json()["id"] == created["id"]


def test_create_writes_markdown_file(atlas_client, tmp_path):
    created = atlas_client.post("/api/plugins/atlas/ideas", json={"title": "On disk"}).json()
    md = tmp_path / "ideen" / f"{created['id']}.md"
    assert md.exists()
    assert "title: On disk" in md.read_text(encoding="utf-8")


def test_create_requires_title(atlas_client):
    assert atlas_client.post("/api/plugins/atlas/ideas", json={"title": "   "}).status_code == 400


def test_get_unknown_returns_404(atlas_client):
    assert atlas_client.get("/api/plugins/atlas/ideas/does-not-exist").status_code == 404


def test_duplicate_titles_get_unique_ids(atlas_client):
    a = atlas_client.post("/api/plugins/atlas/ideas", json={"title": "Same"}).json()
    b = atlas_client.post("/api/plugins/atlas/ideas", json={"title": "Same"}).json()
    assert a["id"] != b["id"]


def test_update_changes_status_and_preserves_created(atlas_client):
    created = atlas_client.post("/api/plugins/atlas/ideas", json={"title": "Editable"}).json()
    cid, created_date = created["id"], created["created"]

    upd = atlas_client.put(
        f"/api/plugins/atlas/ideas/{cid}",
        json={"status": "developing", "body": "## Plan\n", "tags": ["x"]},
    ).json()
    assert upd["status"] == "developing"
    assert upd["body"].strip() == "## Plan"
    assert upd["tags"] == ["x"]
    assert upd["created"] == created_date  # preserved

    assert atlas_client.get(f"/api/plugins/atlas/ideas/{cid}").json()["status"] == "developing"


def test_update_unknown_returns_404(atlas_client):
    assert atlas_client.put("/api/plugins/atlas/ideas/nope", json={"title": "x"}).status_code == 404


def test_update_rejects_empty_title(atlas_client):
    created = atlas_client.post("/api/plugins/atlas/ideas", json={"title": "Keep"}).json()
    resp = atlas_client.put(f"/api/plugins/atlas/ideas/{created['id']}", json={"title": "   "})
    assert resp.status_code == 400


def test_import_md_creates_idea(atlas_client):
    md = (
        "---\nschema: atlas.idea/1\nid: imported-one\ntitle: Imported One\n"
        "type: paper-idea\nstatus: seed\n---\nBody.\n"
    )
    res = atlas_client.post(
        "/api/plugins/atlas/import", json={"filename": "imported-one.md", "content": md}
    ).json()
    assert res["id"] == "imported-one"
    assert res["title"] == "Imported One"
    ids = [i["id"] for i in atlas_client.get("/api/plugins/atlas/ideas").json()["ideas"]]
    assert "imported-one" in ids


def test_import_rejects_non_md(atlas_client):
    resp = atlas_client.post("/api/plugins/atlas/import", json={"filename": "x.txt", "content": "hi"})
    assert resp.status_code == 400


def test_import_derives_id_from_title_when_missing(atlas_client):
    md = "---\nschema: atlas.idea/1\ntitle: No Id Here\ntype: paper-idea\nstatus: seed\n---\nx\n"
    res = atlas_client.post("/api/plugins/atlas/import", json={"content": md}).json()
    assert res["id"].endswith("no-id-here")


def test_links_for_citekey(atlas_client):
    atlas_client.post("/api/plugins/atlas/ideas", json={"title": "Cites Doe", "refs": ["doe2024"]})
    atlas_client.post("/api/plugins/atlas/ideas", json={"title": "No refs"})

    linked = atlas_client.get("/api/plugins/atlas/links/doe2024").json()["ideas"]
    assert [i["title"] for i in linked] == ["Cites Doe"]

    assert atlas_client.get("/api/plugins/atlas/links/unknownkey").json()["ideas"] == []


def test_diss_create_appends_to_flat_ordered_list(atlas_client):
    # atlas.dissnode/3 (ADR-0005): a flat, ordered chapter list — new chapters
    # append to the end (ascending order), no kind/parent.
    a = atlas_client.post("/api/plugins/atlas/diss", json={"title": "Kapitel 1"}).json()
    b = atlas_client.post("/api/plugins/atlas/diss", json={"title": "Kapitel 2"}).json()
    assert a["order"] == 0 and b["order"] == 1
    assert "kind" not in a and "parent" not in a
    data = atlas_client.get("/api/plugins/atlas/diss").json()
    assert data["issues"] == []
    assert [c["title"] for c in data["chapters"]] == ["Kapitel 1", "Kapitel 2"]
    assert [c["order"] for c in data["chapters"]] == [0, 1]


def test_diss_progress_counts_body_and_publications(atlas_client):
    pub = atlas_client.post("/api/plugins/atlas/publications", json={"title": "FGC"}).json()
    empty = atlas_client.post("/api/plugins/atlas/diss", json={"title": "Leer"}).json()
    full = atlas_client.post(
        "/api/plugins/atlas/diss", json={"title": "Voll", "body": "Inhalt", "status": "in-progress"}
    ).json()
    atlas_client.post(
        f"/api/plugins/atlas/diss/{full['id']}/publications", json={"publication_id": pub["id"]}
    )
    progress = atlas_client.get("/api/plugins/atlas/diss").json()["progress"]
    assert progress["total"] == 2
    assert progress["with_body"] == 1
    assert progress["with_publications"] == 1
    assert progress["by_status"] == {"planned": 1, "in-progress": 1}


def test_diss_get_404(atlas_client):
    assert atlas_client.get("/api/plugins/atlas/diss/nope").status_code == 404


def test_diss_node_lists_contributing_ideas(atlas_client):
    node = atlas_client.post("/api/plugins/atlas/diss", json={"title": "Kapitel"}).json()
    atlas_client.post("/api/plugins/atlas/ideas", json={"title": "Idee X", "diss": [node["id"]]})
    got = atlas_client.get(f"/api/plugins/atlas/diss/{node['id']}").json()
    assert [i["title"] for i in got["linked_ideas"]] == ["Idee X"]


def test_diss_update_status(atlas_client):
    node = atlas_client.post("/api/plugins/atlas/diss", json={"title": "Knoten"}).json()
    upd = atlas_client.put(f"/api/plugins/atlas/diss/{node['id']}", json={"status": "in-progress"}).json()
    assert upd["status"] == "in-progress"


def test_diss_create_requires_title(atlas_client):
    assert atlas_client.post("/api/plugins/atlas/diss", json={"title": "  "}).status_code == 400


def test_project_create_writes_research_project_file(atlas_client, tmp_path):
    """Research project (atlas.project/3, ADR-0004): Laufzeit, Foerderung,
    Rolle und Meilensteine landen im Frontmatter der Markdown-Datei."""
    proj = atlas_client.post("/api/plugins/atlas/projects", json={
        "title": "FGC Robotik", "status": "active",
        "start": "2026-01-01", "end": "2028-12-31",
        "funder": "DFG", "grant_id": "BA 1234/5-1", "role": "PI",
        "milestones": [
            {"title": "Kickoff", "date": "2026-02-01", "done": True},
            {"title": "Zwischenbericht", "date": "2027-06-30"},
        ],
        "refs": ["Smith2020"],
        "body": "## AP1 Aufbau\n- [x] eins\n- [ ] zwei",
    }).json()
    assert proj["errors"] == []
    assert proj["status"] == "active"
    assert proj["progress"] == 0.5
    assert proj["milestones"] == [
        {"title": "Kickoff", "date": "2026-02-01", "done": True},
        {"title": "Zwischenbericht", "date": "2027-06-30", "done": False},
    ]

    plist = atlas_client.get("/api/plugins/atlas/projects").json()["projects"]
    assert proj["id"] in [p["id"] for p in plist]

    md = (tmp_path / "projekte" / f"{proj['id']}.md").read_text(encoding="utf-8")
    assert "schema: atlas.project/5" in md
    assert "funder: DFG" in md
    assert "grant_id: BA 1234/5-1" in md
    assert "title: Kickoff" in md


def test_project_default_status_is_planned(atlas_client):
    proj = atlas_client.post("/api/plugins/atlas/projects", json={"title": "Nur Titel"}).json()
    assert proj["status"] == "planned"
    assert proj["errors"] == []


def test_project_delete_removes_file_and_index(atlas_client, tmp_path):
    proj = atlas_client.post("/api/plugins/atlas/projects", json={"title": "Wegwerf"}).json()
    md = tmp_path / "projekte" / f"{proj['id']}.md"
    assert md.exists()
    resp = atlas_client.delete(f"/api/plugins/atlas/projects/{proj['id']}")
    assert resp.status_code == 200
    assert resp.json() == {"deleted": proj["id"]}
    assert not md.exists()
    plist = atlas_client.get("/api/plugins/atlas/projects").json()["projects"]
    assert proj["id"] not in [p["id"] for p in plist]
    assert atlas_client.get(f"/api/plugins/atlas/projects/{proj['id']}").status_code == 404


def test_project_delete_missing_returns_404(atlas_client):
    assert atlas_client.delete("/api/plugins/atlas/projects/gibtsnicht").status_code == 404


def test_project_milestones_editable_via_put(atlas_client):
    proj = atlas_client.post("/api/plugins/atlas/projects", json={
        "title": "P", "milestones": [{"title": "Alt", "date": "2026-01-01"}],
    }).json()
    upd = atlas_client.put(f"/api/plugins/atlas/projects/{proj['id']}", json={
        "milestones": [
            {"title": "Alt", "date": "2026-01-01", "done": True},
            {"title": "Neu", "date": "2026-03-01"},
        ],
    }).json()
    assert upd["milestones"] == [
        {"title": "Alt", "date": "2026-01-01", "done": True},
        {"title": "Neu", "date": "2026-03-01", "done": False},
    ]


def test_project_timeline_marks_overdue_and_next(atlas_client):
    proj = atlas_client.post("/api/plugins/atlas/projects", json={
        "title": "P",
        "milestones": [
            {"title": "Verpasst", "date": "2000-01-01"},
            {"title": "Erledigt", "date": "2000-02-01", "done": True},
            {"title": "Fern", "date": "9999-12-31"},
            {"title": "Bald", "date": "9999-01-01"},
        ],
    }).json()
    states = {m["title"]: m for m in proj["timeline"]}
    assert states["Verpasst"]["state"] == "overdue"
    assert states["Erledigt"]["state"] == "done"
    assert states["Bald"]["state"] == "upcoming" and states["Bald"]["next"] is True
    assert states["Fern"]["state"] == "upcoming" and states["Fern"]["next"] is False
    # timeline also present in the list payload (list cards show next/overdue)
    plist = atlas_client.get("/api/plugins/atlas/projects").json()["projects"]
    assert any("timeline" in p for p in plist if p["id"] == proj["id"])


def test_project_detail_resolves_hanging_refs_as_warnings(atlas_client, tmp_path):
    proj = atlas_client.post("/api/plugins/atlas/projects", json={
        "title": "Mit Refs", "refs": ["Ghost2020"],
    }).json()
    got = atlas_client.get(f"/api/plugins/atlas/projects/{proj['id']}").json()
    by_key = {r["citekey"]: r for r in got["refs_resolved"]}
    assert by_key["Ghost2020"]["found"] is False
    # never auto-repaired: the frontmatter keeps the hanging ref
    md = (tmp_path / "projekte" / f"{proj['id']}.md").read_text(encoding="utf-8")
    assert "Ghost2020" in md


def test_links_lookup_includes_projects(atlas_client):
    atlas_client.post("/api/plugins/atlas/projects", json={"title": "Nutzt Doe", "refs": ["doe2024"]})
    atlas_client.post("/api/plugins/atlas/projects", json={"title": "Ohne Bezug"})
    res = atlas_client.get("/api/plugins/atlas/links/doe2024").json()
    assert [p["title"] for p in res["projects"]] == ["Nutzt Doe"]
    assert atlas_client.get("/api/plugins/atlas/links/unbekannt").json()["projects"] == []


def test_project_payload_has_per_work_package_sections(atlas_client):
    """Issue #48: Arbeitspakete (## AP1 …) come with per-section checklist
    stats in both the list and the detail payload."""
    proj = atlas_client.post("/api/plugins/atlas/projects", json={
        "title": "Mit APs",
        "body": (
            "Kontext ohne Aufgabe.\n\n"
            "## AP1 Aufbau\n- [x] eins\n- [ ] zwei\n\n"
            "### Teilaufgaben\n- [ ] drei\n\n"
            "## AP2 Auswertung\n- [x] vier\n"
        ),
    }).json()
    assert [(s["title"], s["done"], s["total"]) for s in proj["sections"]] == [
        ("AP1 Aufbau", 1, 3),  # ### sub-heading stays inside its AP
        ("AP2 Auswertung", 1, 1),
    ]
    assert proj["checklist"]["done"] == 2 and proj["checklist"]["total"] == 4
    assert proj["progress"] == 0.5

    got = atlas_client.get(f"/api/plugins/atlas/projects/{proj['id']}").json()
    assert [s["title"] for s in got["sections"]] == ["AP1 Aufbau", "AP2 Auswertung"]
    plist = atlas_client.get("/api/plugins/atlas/projects").json()["projects"]
    mine = next(p for p in plist if p["id"] == proj["id"])
    assert mine["sections"][0]["done"] == 1


def test_project_toggle_uses_flat_index_across_sections(atlas_client):
    """The toggle index counts checklist items across ALL sections in document
    order — ticking item 2 hits the first task of AP2."""
    proj = atlas_client.post("/api/plugins/atlas/projects", json={
        "title": "Toggle",
        "body": "## AP1\n- [x] a\n- [ ] b\n## AP2\n- [ ] c\n",
    }).json()
    toggled = atlas_client.post(
        f"/api/plugins/atlas/projects/{proj['id']}/toggle", json={"index": 2}
    ).json()
    assert (toggled["sections"][1]["done"], toggled["sections"][1]["total"]) == (1, 1)
    assert toggled["sections"][0]["done"] == 1  # AP1 untouched
    assert toggled["checklist"]["done"] == 2


def test_project_toggle_checklist(atlas_client):
    proj = atlas_client.post("/api/plugins/atlas/projects", json={
        "title": "Spike", "body": "- [ ] a\n- [ ] b"}).json()
    assert proj["progress"] == 0.0
    toggled = atlas_client.post(f"/api/plugins/atlas/projects/{proj['id']}/toggle", json={"index": 0}).json()
    assert toggled["checklist"]["items"][0]["done"] is True
    assert toggled["progress"] == 0.5


def test_project_update_status(atlas_client):
    proj = atlas_client.post("/api/plugins/atlas/projects", json={"title": "P"}).json()
    upd = atlas_client.put(f"/api/plugins/atlas/projects/{proj['id']}", json={"status": "finished"}).json()
    assert upd["status"] == "finished"
    assert upd["errors"] == []


def test_publication_add_refs_appends_and_dedupes(atlas_client):
    """BibTeX import target (ADR-0004): refs assignment goes to a Publication."""
    pub = atlas_client.post("/api/plugins/atlas/publications", json={
        "title": "Paper X", "refs": ["Smith2020"]}).json()
    assert pub["refs"] == ["Smith2020"]

    resp = atlas_client.post(
        f"/api/plugins/atlas/publications/{pub['id']}/refs",
        json={"refs": ["Smith2020", "Doe2021", "", "Doe2021"]},
    ).json()
    assert resp["added"] == ["Doe2021"]
    assert resp["refs"] == ["Smith2020", "Doe2021"]

    got = atlas_client.get(f"/api/plugins/atlas/publications/{pub['id']}").json()
    assert got["refs"] == ["Smith2020", "Doe2021"]
    # unresolvable cite keys are reported, not repaired
    by_key = {r["citekey"]: r for r in got["refs_resolved"]}
    assert by_key["Doe2021"]["found"] is False


def test_publication_add_refs_404(atlas_client):
    assert atlas_client.post("/api/plugins/atlas/publications/nope/refs", json={"refs": ["X"]}).status_code == 404


def test_project_refs_endpoint_removed(atlas_client):
    """Retargeted to Publications (issue #44): the legacy project endpoint is gone."""
    proj = atlas_client.post("/api/plugins/atlas/projects", json={"title": "P"}).json()
    resp = atlas_client.post(f"/api/plugins/atlas/projects/{proj['id']}/refs", json={"refs": ["X"]})
    assert resp.status_code in (404, 405)


def test_project_create_requires_title(atlas_client):
    assert atlas_client.post("/api/plugins/atlas/projects", json={"title": "  "}).status_code == 400


def test_project_get_404(atlas_client):
    assert atlas_client.get("/api/plugins/atlas/projects/nope").status_code == 404


def test_reindex_and_check(atlas_client):
    atlas_client.post("/api/plugins/atlas/ideas", json={"title": "Idea A"})
    stats = atlas_client.post("/api/plugins/atlas/reindex").json()
    assert stats["indexed"] >= 1
    report = atlas_client.get("/api/plugins/atlas/check").json()
    assert "report" in report
