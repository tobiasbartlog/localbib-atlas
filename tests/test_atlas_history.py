"""The Verlauf (history) of Publication (atlas.publication/3) and Project
(atlas.project/5), and the entity-file endpoints of the detail pages' "⋯" menu.

The status endpoints that write the Verlauf are covered in
``test_atlas_pipeline.py``; here: the file round trip, validation, the index
keeping it, a type switch carrying it, and ``POST /entities/{kind}/{id}/open``
and ``…/reveal`` handing the Markdown file to the system.
"""

from __future__ import annotations

import sqlite3

from atlas import documents
from atlas.collection_entries import carried_fields
from atlas.domain import Project, Publication

API = "/api/plugins/atlas"

HISTORY = [
    {"date": "2026-09-01", "status": "submitted", "venue": "Konferenz A"},
    {"date": "2026-10-03", "status": "rejected", "venue": "Konferenz A"},
    {"date": "2026-10-22", "status": "drafting", "venue": "Journal B"},
]


def test_a_publication_keeps_its_verlauf_through_the_file():
    pub = Publication(id="p", title="P", status="drafting", venue="Journal B", history=HISTORY)
    again = Publication.from_markdown(pub.to_markdown())
    assert again.history == HISTORY
    assert again.to_markdown() == pub.to_markdown()
    assert again.validate() == []
    assert pub.to_frontmatter()["schema"] == "atlas.publication/3"


def test_an_entry_without_venue_writes_no_venue_key():
    project = Project(id="x", title="X", history=[{"date": "2026-04-01", "status": "active"}])
    assert project.to_frontmatter()["history"] == [{"date": "2026-04-01", "status": "active"}]
    assert Project.from_markdown(project.to_markdown()).to_dict()["history"] == [
        {"date": "2026-04-01", "status": "active", "venue": None},
    ]


def test_a_broken_verlauf_is_a_warning_not_a_crash():
    text = (
        "---\nschema: atlas.publication/3\nid: p\ntitle: P\nstatus: drafting\n"
        "history:\n- {date: gestern, status: drafting}\n- {date: 2026-10-01, status: archived}\n- kaputt\n---\n"
    )
    pub = Publication.from_markdown(text)
    errors = pub.validate()
    assert any("Verlauf 1: date" in e for e in errors)
    assert any("Verlauf 2: status" in e for e in errors)
    assert any("Verlauf 3" in e for e in errors)


def test_a_project_verlauf_only_knows_project_statuses():
    project = Project(id="x", title="X", history=[{"date": "2026-04-01", "status": "submitted"}])
    assert any("Verlauf 1: status" in e for e in project.validate())


def test_a_type_switch_carries_the_verlauf_into_the_section():
    pub = Publication(id="p", title="P", status="rejected", history=HISTORY, path="x.md")
    carried = {f["field"]: f["value"] for f in carried_fields(pub)}
    assert carried["history"] == (
        "2026-09-01 submitted (Konferenz A); 2026-10-03 rejected (Konferenz A); 2026-10-22 drafting (Journal B)"
    )


def test_the_index_keeps_the_verlauf_and_an_old_index_is_rebuilt(atlas_app, tmp_path):
    with atlas_app() as client:
        pub = client.post(f"{API}/publications", json={"title": "Paper H"}).json()
        client.put(f"{API}/publications/{pub['id']}", json={"history": HISTORY})
        assert client.get(f"{API}/publications/{pub['id']}").json()["history"] == HISTORY
        db = client.app.state.atlas_plugin._store.db_path
    # An index from before /3: no history column. The next start drops the
    # table and the reindex rebuilds it from the file.
    with sqlite3.connect(db) as conn:
        conn.execute("DROP TABLE publications")
        conn.execute("CREATE TABLE publications (id TEXT PRIMARY KEY, collection_id INTEGER)")
    with atlas_app() as client:
        assert client.get(f"{API}/publications/{pub['id']}").json()["history"] == HISTORY


def test_open_and_reveal_hand_the_entity_file_to_the_system(atlas_app, monkeypatch):
    seen = []
    monkeypatch.setattr(documents, "open_in_viewer", lambda path: seen.append(("open", path.name)))
    monkeypatch.setattr(documents, "reveal_in_folder", lambda path: seen.append(("reveal", path.name)))
    with atlas_app() as client:
        pub = client.post(f"{API}/publications", json={"title": "Paper O"}).json()
        proj = client.post(f"{API}/projects", json={"title": "Projekt O"}).json()
        assert client.post(f"{API}/entities/publication/{pub['id']}/open").status_code == 200
        assert client.post(f"{API}/entities/project/{proj['id']}/reveal").status_code == 200
        assert seen == [("open", f"{pub['id']}.md"), ("reveal", f"{proj['id']}.md")]
        resp = client.post(f"{API}/entities/project/{pub['id']}/open")  # ids are per kind
        assert resp.status_code == 404 and resp.json()["detail"] == "error.atlas.entity_not_found"
        resp = client.post(f"{API}/entities/task/x/open")
        assert resp.status_code == 422 and resp.json()["detail"] == "error.atlas.kind_invalid"
