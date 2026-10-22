"""Collection entries (ADR-0022, issue #205; ADR-0025, issue #225) — isolated,
against the ``plugin_api.testing`` fakes only.

A core Collection is only a place for Papers until the user plans it ("Aus
Sammlung planen"): then a Publication file with the link appears, never a
literature copy, and its literature is the Collection, live through
``LibraryApi``. "Lösen" freezes the membership into that file once; the type
switch carries fields without a counterpart into an appended section; a
deleted Collection freezes its last membership into an existing file once;
the manuscript compile of a Collection entry uses the Collection's ``.bib``.
"""

from __future__ import annotations

from datetime import date

import pytest
from plugin_api.testing import InMemoryLibrary

from atlas import collection_entries
from atlas.collection_sync import CollectionSync
from atlas.domain import Project, Publication, parse_frontmatter

API = "/api/plugins/atlas"

REFERENCES = [
    {"citekey": "Smith2020", "title": "Robots", "year": 2020},
    {"citekey": "Doe2021", "title": "Grippers", "year": 2021},
    {"citekey": "Roe2019", "title": "Planning", "year": 2019},
]


def _library(**collections) -> InMemoryLibrary:
    return InMemoryLibrary(REFERENCES, collections=collections.get("collections", ()))


def _seeded() -> InMemoryLibrary:
    return _library(collections=[
        {"id": 1, "name": "Antrag Robotik", "refs": ["Smith2020", "Doe2021"]},
        {"id": 2, "name": "Altes Thema", "refs": ["Roe2019"], "archived": True},
        {"id": 3, "name": "Weg", "refs": ["Roe2019"], "deleted": True},
    ])


def _pubs(client) -> dict:
    return {p["id"]: p for p in client.get(f"{API}/publications").json()["publications"]}


def _projects(client) -> dict:
    return {p["id"]: p for p in client.get(f"{API}/projects").json()["projects"]}


def _frontmatter(path) -> tuple[dict, str]:
    return parse_frontmatter(path.read_text(encoding="utf-8"))


def _sync(client) -> CollectionSync:
    return client.app.state.atlas_plugin._collection_sync


def _plan(client, cid: int = 1) -> dict:
    resp = client.post(f"{API}/collections/{cid}/plan")
    assert resp.status_code == 200, resp.text
    return resp.json()


# =============================================================================
# Domain: the Collection link in the file
# =============================================================================

class TestDomain:
    def test_collection_entry_file_has_link_and_kind_but_no_refs(self):
        pub = Publication(id="sammlung-1", title="T", refs=["Smith2020"],
                          collection_id=1, kind="publication")
        fm = pub.to_frontmatter()
        assert fm["schema"] == "atlas.publication/3"
        assert fm["collection_id"] == 1 and fm["kind"] == "publication"
        assert "refs" not in fm
        assert pub.validate() == []

    def test_project_entry_round_trips(self):
        project = Project(id="p", title="P", collection_id=7, kind="project")
        again = Project.from_markdown(project.to_markdown(), id_hint="p")
        assert (again.collection_id, again.kind) == (7, "project")
        assert again.to_frontmatter()["schema"] == "atlas.project/5"

    def test_wrong_kind_is_a_validation_error(self):
        pub = Publication(id="x", title="X", collection_id=1, kind="project")
        assert any("kind" in e for e in pub.validate())

    def test_legacy_v1_file_still_parses_as_normal_publication(self):
        pub = Publication.from_markdown(
            "---\nschema: atlas.publication/1\nid: alt\ntitle: Alt\nstatus: planned\n"
            "refs:\n- Smith2020\n---\n", id_hint="alt")
        assert pub.collection_id is None and pub.refs == ["Smith2020"]

    def test_broken_collection_id_reads_as_no_link(self):
        pub = Publication.from_markdown("---\nid: a\ntitle: A\ncollection_id: abc\n---\n")
        assert pub.collection_id is None


# =============================================================================
# Virtual entries: live, archived marked, no file
# =============================================================================

class TestNoVirtualEntries:
    """ADR-0025 (#225): a Collection without a file is not a Publication."""

    def test_new_collections_do_not_appear_as_publications(self, atlas_app, tmp_path):
        with atlas_app(library=_seeded()) as client:
            assert _pubs(client) == {}
            assert client.get(f"{API}/publications/sammlung-1").status_code == 404
        assert not list((tmp_path / "veroeffentlichungen").glob("*.md"))

    def test_the_collection_list_names_every_live_collection_and_its_entry(self, atlas_app):
        with atlas_app(library=_seeded()) as client:
            _plan(client, 1)
            data = client.get(f"{API}/collections").json()
        assert data["available"] is True
        rows = {c["id"]: c for c in data["collections"]}
        assert set(rows) == {1, 2}  # the deleted one is gone
        assert rows[1]["entry"]["id"] == "sammlung-1" and rows[1]["entry"]["status"] == "planned"
        assert rows[2]["entry"] is None and rows[2]["archived"] is True
        assert rows[1]["item_count"] == 2
        assert [e["id"] for e in data["entries"]] == ["sammlung-1"]

    def test_own_publications_stay_unchanged(self, atlas_app):
        with atlas_app(library=_seeded()) as client:
            client.post(f"{API}/publications", json={"title": "Eigenes Paper", "refs": ["Roe2019"]})
            own = _pubs(client)["eigenes-paper"]
            assert own["collection_id"] is None and own["collection"] is None
            assert own["refs"] == ["Roe2019"]

    def test_host_without_collections_shows_none_and_does_not_crash(self, atlas_app):
        class OldLibrary:  # a host before contract 2.1
            def get_reference(self, citekey):
                return None

        with atlas_app(library=OldLibrary()) as client:
            assert _pubs(client) == {}
            assert client.get(f"{API}/collections").json() == {
                "entries": [], "collections": [], "available": False,
            }
            assert client.post(f"{API}/collections/1/plan").status_code == 404


# =============================================================================
# "Aus Sammlung planen" and "Lösen" (#225)
# =============================================================================

class TestPlan:
    def test_plan_writes_the_file_with_the_link_and_no_literature_copy(self, atlas_app, tmp_path):
        with atlas_app(library=_seeded()) as client:
            data = _plan(client, 1)
            assert data["entry"]["id"] == "sammlung-1"
            pub = _pubs(client)["sammlung-1"]
            assert pub["title"] == "Antrag Robotik" and pub["status"] == "planned"
            assert pub["collection"]["id"] == 1
            assert "virtual" not in pub["collection"]  # no virtual entries since ADR-0025
            assert pub["refs"] == ["Smith2020", "Doe2021"]  # live from the Collection
        fm, _ = _frontmatter(tmp_path / "veroeffentlichungen" / "sammlung-1.md")
        assert fm["collection_id"] == 1 and fm["kind"] == "publication"
        assert fm["title"] == "Antrag Robotik" and fm["status"] == "planned"
        assert "refs" not in fm

    def test_a_collection_belongs_to_at_most_one_entry(self, atlas_app):
        with atlas_app(library=_seeded()) as client:
            _plan(client, 1)
            resp = client.post(f"{API}/collections/1/plan")
            assert resp.status_code == 409
            assert resp.json()["detail"] == "error.atlas.collection_already_planned"

    def test_unknown_and_deleted_collections_cannot_be_planned(self, atlas_app):
        with atlas_app(library=_seeded()) as client:
            for cid in (3, 99):
                resp = client.post(f"{API}/collections/{cid}/plan")
                assert resp.status_code == 404
                assert resp.json()["detail"] == "error.atlas.collection_not_found"

    def test_the_literature_follows_the_collection_live(self, atlas_app):
        library = _seeded()
        with atlas_app(library=library) as client:
            _plan(client, 1)
            library.rename_collection(1, "Antrag Robotik II")
            library.set_collection_refs(1, ["Roe2019"])
            library.archive_collection(1)
            entry = _pubs(client)["sammlung-1"]
            assert entry["title"] == "Antrag Robotik II"
            assert entry["refs"] == ["Roe2019"]
            assert entry["collection"]["archived"] is True
            detail = client.get(f"{API}/publications/sammlung-1").json()
            assert [r["citekey"] for r in detail["refs_resolved"]] == ["Roe2019"]

    def test_edits_keep_the_link_and_never_write_refs(self, atlas_app, tmp_path):
        with atlas_app(library=_seeded()) as client:
            _plan(client, 1)
            resp = client.put(f"{API}/publications/sammlung-1",
                              json={"status": "drafting", "venue": "ICRA", "refs": ["Roe2019"]})
            assert resp.status_code == 200
            assert resp.json()["refs"] == ["Smith2020", "Doe2021"]
        fm, _ = _frontmatter(tmp_path / "veroeffentlichungen" / "sammlung-1.md")
        assert fm["collection_id"] == 1 and fm["venue"] == "ICRA" and "refs" not in fm

    def test_bibtex_refs_are_refused_for_a_collection_entry(self, atlas_app):
        with atlas_app(library=_seeded()) as client:
            _plan(client, 1)
            resp = client.post(f"{API}/publications/sammlung-1/refs", json={"refs": ["Roe2019"]})
            assert resp.status_code == 409
            assert resp.json()["detail"] == "error.atlas.collection_refs_readonly"

    def test_plan_avoids_an_unrelated_publication_with_the_same_id(self, atlas_app, tmp_path):
        with atlas_app(library=_seeded()) as client:
            client.post(f"{API}/publications", json={"title": "x", "id": "sammlung-1"})
            assert _plan(client, 1)["entry"]["id"] == "sammlung-1-2"
        own, _ = _frontmatter(tmp_path / "veroeffentlichungen" / "sammlung-1.md")
        assert "collection_id" not in own


class TestUnplan:
    def test_loesen_freezes_the_literature_and_keeps_the_file(self, atlas_app, tmp_path):
        with atlas_app(library=_seeded()) as client:
            _plan(client, 1)
            client.put(f"{API}/publications/sammlung-1", json={"status": "drafting"})
            resp = client.post(f"{API}/collections/1/unplan")
            assert resp.status_code == 200
            assert resp.json() == {"id": "sammlung-1", "kind": "publication",
                                   "refs": ["Smith2020", "Doe2021"]}
            pub = _pubs(client)["sammlung-1"]
            assert pub["collection_id"] is None and pub["refs"] == ["Smith2020", "Doe2021"]
            assert pub["status"] == "drafting"
            rows = {c["id"]: c for c in client.get(f"{API}/collections").json()["collections"]}
            assert rows[1]["entry"] is None
        fm, _ = _frontmatter(tmp_path / "veroeffentlichungen" / "sammlung-1.md")
        assert fm["refs"] == ["Smith2020", "Doe2021"]
        assert "collection_id" not in fm and "kind" not in fm

    def test_loesen_without_an_entry_is_404(self, atlas_app):
        with atlas_app(library=_seeded()) as client:
            resp = client.post(f"{API}/collections/1/unplan")
            assert resp.status_code == 404
            assert resp.json()["detail"] == "error.atlas.collection_not_planned"

    def test_undo_of_loesen_relinks_the_same_file(self, atlas_app, tmp_path):
        with atlas_app(library=_seeded()) as client:
            _plan(client, 1)
            client.put(f"{API}/publications/sammlung-1", json={"venue": "ICRA"})
            client.post(f"{API}/collections/1/unplan")
            resp = client.post(f"{API}/collections/1/plan", json={"publication_id": "sammlung-1"})
            assert resp.status_code == 200
            pub = _pubs(client)["sammlung-1"]
            assert pub["collection"]["id"] == 1 and pub["venue"] == "ICRA"
            assert len(_pubs(client)) == 1
        fm, _ = _frontmatter(tmp_path / "veroeffentlichungen" / "sammlung-1.md")
        assert fm["collection_id"] == 1 and "refs" not in fm

    def test_a_publication_with_another_collection_cannot_take_a_second(self, atlas_app):
        with atlas_app(library=_seeded()) as client:
            _plan(client, 1)
            resp = client.post(f"{API}/collections/2/plan", json={"publication_id": "sammlung-1"})
            assert resp.status_code == 409
            assert resp.json()["detail"] == "error.atlas.publication_has_collection"
            resp = client.post(f"{API}/collections/2/plan", json={"publication_id": "gibt-es-nicht"})
            assert resp.status_code == 404

    def test_a_planned_entry_can_still_become_a_research_project(self, atlas_app, tmp_path):
        with atlas_app(library=_seeded()) as client:
            _plan(client, 1)
            resp = client.post(f"{API}/collections/1/switch", json={"to": "project"})
            assert (resp.json()["id"], resp.json()["kind"]) == ("sammlung-1", "project")
            assert _projects(client)["sammlung-1"]["refs"] == ["Smith2020", "Doe2021"]
            # Lösen works for a project entry, too.
            assert client.post(f"{API}/collections/1/unplan").json()["kind"] == "project"
        fm, _ = _frontmatter(tmp_path / "projekte" / "sammlung-1.md")
        assert fm["refs"] == ["Smith2020", "Doe2021"] and "collection_id" not in fm

    def test_undo_of_loesen_relinks_a_research_project(self, atlas_app, tmp_path):
        with atlas_app(library=_seeded()) as client:
            _plan(client, 1)
            client.post(f"{API}/collections/1/switch", json={"to": "project"})
            client.put(f"{API}/projects/sammlung-1", json={"funder": "DFG"})
            released = client.post(f"{API}/collections/1/unplan").json()
            assert (released["id"], released["kind"]) == ("sammlung-1", "project")
            resp = client.post(f"{API}/collections/1/plan", json={"project_id": released["id"]})
            assert resp.status_code == 200, resp.text
            assert (resp.json()["entry"]["id"], resp.json()["entry"]["kind"]) == ("sammlung-1", "project")
            project = _projects(client)["sammlung-1"]
            assert project["collection"]["id"] == 1 and project["funder"] == "DFG"
            assert project["refs"] == ["Smith2020", "Doe2021"]  # live again
            assert _pubs(client) == {}
        fm, _ = _frontmatter(tmp_path / "projekte" / "sammlung-1.md")
        assert fm["collection_id"] == 1 and fm["kind"] == "project" and "refs" not in fm
        assert not (tmp_path / "veroeffentlichungen" / "sammlung-1.md").exists()

    def test_relinking_a_project_is_refused_when_it_cannot_take_the_collection(self, atlas_app):
        with atlas_app(library=_seeded()) as client:
            _plan(client, 1)
            client.post(f"{API}/collections/1/switch", json={"to": "project"})
            resp = client.post(f"{API}/collections/2/plan", json={"project_id": "sammlung-1"})
            assert resp.status_code == 409
            assert resp.json()["detail"] == "error.atlas.project_has_collection"
            resp = client.post(f"{API}/collections/2/plan", json={"project_id": "gibt-es-nicht"})
            assert resp.status_code == 404
            assert resp.json()["detail"] == "error.atlas.project_not_found"
            resp = client.post(f"{API}/collections/2/plan",
                               json={"project_id": "sammlung-1", "publication_id": "x"})
            assert resp.status_code == 422
            assert resp.json()["detail"] == "error.atlas.kind_invalid"


# =============================================================================
# Type switch with the appended Übernahme section
# =============================================================================

class TestTypeSwitch:
    def test_an_unplanned_collection_has_nothing_to_switch(self, atlas_app):
        with atlas_app(library=_seeded()) as client:
            resp = client.post(f"{API}/collections/1/switch", json={"to": "project"})
            assert resp.status_code == 404
            assert resp.json()["detail"] == "error.atlas.collection_not_found"

    def test_a_freshly_planned_entry_carries_nothing(self, atlas_app, tmp_path):
        with atlas_app(library=_seeded()) as client:
            _plan(client, 1)
            plan = client.get(f"{API}/collections/1/switch", params={"to": "project"}).json()
            assert plan["has_file"] is True and plan["carried"] == []
            resp = client.post(f"{API}/collections/1/switch", json={"to": "project"})
            assert (resp.json()["id"], resp.json()["kind"]) == ("sammlung-1", "project")
            assert "sammlung-1" not in _pubs(client)
            project = _projects(client)["sammlung-1"]
            assert project["collection"]["id"] == 1 and project["refs"] == ["Smith2020", "Doe2021"]
        fm, body = _frontmatter(tmp_path / "projekte" / "sammlung-1.md")
        assert fm["kind"] == "project" and fm["collection_id"] == 1 and "refs" not in fm
        assert "übernommen" not in body

    def test_with_file_carries_fields_into_an_appended_section(self, atlas_app, tmp_path):
        today = date.today().isoformat()
        with atlas_app(library=_seeded()) as client:
            _plan(client, 1)
            client.put(f"{API}/publications/sammlung-1", json={
                "status": "drafting", "venue": "ICRA", "authors": ["A. Autor", "B. Autor"],
                "due": "2026-12-01", "tags": ["robotik"], "body": "Meine Notizen.",
            })
            plan = client.get(f"{API}/collections/1/switch", params={"to": "project"}).json()
            assert [c["label"] for c in plan["carried"]] == ["Status", "Venue", "Autor:innen", "Fällig"]
            assert plan["moved"] == ["Titel", "Tags", "Notizen"]
            client.post(f"{API}/collections/1/switch", json={"to": "project"})
        assert not (tmp_path / "veroeffentlichungen" / "sammlung-1.md").exists()
        fm, body = _frontmatter(tmp_path / "projekte" / "sammlung-1.md")
        assert fm["tags"] == ["robotik"] and fm["status"] == "planned"
        assert body.strip().startswith("Meine Notizen.")
        assert f"## Aus Publication übernommen ({today})" in body
        for line in ("- Status: drafting", "- Venue: ICRA",
                     "- Autor:innen: A. Autor, B. Autor", "- Fällig: 2026-12-01"):
            assert line in body

    def test_switching_back_appends_and_never_overwrites(self, atlas_app, tmp_path):
        today = date.today().isoformat()
        with atlas_app(library=_seeded()) as client:
            _plan(client, 1)
            client.put(f"{API}/publications/sammlung-1", json={"venue": "ICRA", "body": "N."})
            client.post(f"{API}/collections/1/switch", json={"to": "project"})
            client.put(f"{API}/projects/sammlung-1", json={
                "funder": "DFG", "grant_id": "GZ 1", "start": "2026-01-01",
                "milestones": [{"title": "Kickoff", "date": "2026-02-01", "done": True}],
            })
            plan = client.get(f"{API}/collections/1/switch", params={"to": "publication"}).json()
            assert {c["field"] for c in plan["carried"]} == {"start", "funder", "grant_id", "milestones"}
            resp = client.post(f"{API}/collections/1/switch", json={"to": "publication"})
            assert resp.json()["id"] == "sammlung-1"
            pub = _pubs(client)["sammlung-1"]
            assert pub["collection"]["id"] == 1 and pub["path"]
            assert "sammlung-1" not in _projects(client)
        _, body = _frontmatter(tmp_path / "veroeffentlichungen" / "sammlung-1.md")
        assert f"## Aus Publication übernommen ({today})\n\n- Venue: ICRA" in body
        assert f"## Aus Forschungsprojekt übernommen ({today})" in body
        assert body.index("Aus Publication") < body.index("Aus Forschungsprojekt")
        assert "- Förderer: DFG" in body and "- Meilensteine: Kickoff (2026-02-01, erledigt)" in body

    def test_the_document_folder_moves_along_with_the_switch(self, atlas_app, tmp_path):
        with atlas_app(library=_seeded()) as client:
            _plan(client, 1)
            client.post(f"{API}/publications/sammlung-1/documents",
                        files={"file": ("gutachten.pdf", b"%PDF-1.4", "application/pdf")})
            client.post(f"{API}/collections/1/switch", json={"to": "project"})
            docs = client.get(f"{API}/projects/sammlung-1/documents").json()["documents"]
            assert [d["name"] for d in docs] == ["gutachten.pdf"]
            assert not (tmp_path / "veroeffentlichungen" / "sammlung-1").exists()
            client.post(f"{API}/collections/1/switch", json={"to": "publication"})
            docs = client.get(f"{API}/publications/sammlung-1/documents").json()["documents"]
            assert [d["name"] for d in docs] == ["gutachten.pdf"]
        assert not (tmp_path / "projekte" / "sammlung-1").exists()

    def test_the_switch_keeps_its_id_and_sets_an_orphan_folder_aside(self, atlas_app, tmp_path, monkeypatch):
        """References ([[sammlung-1]], projects: [sammlung-1]) must not break:
        a leftover folder of a deleted project is set aside, not merged in,
        and does not push the entry onto another id."""
        from atlas import documents

        monkeypatch.setattr(documents, "_today", lambda: date(2026, 10, 10))
        orphan = tmp_path / "projekte" / "sammlung-1"
        orphan.mkdir(parents=True)
        (orphan / "alt.txt").write_text("von einem geloeschten Projekt", encoding="utf-8")
        with atlas_app(library=_seeded()) as client:
            _plan(client, 1)
            client.post(f"{API}/publications/sammlung-1/documents",
                        files={"file": ("neu.pdf", b"%PDF-1.4", "application/pdf")})
            resp = client.post(f"{API}/collections/1/switch", json={"to": "project"})
            assert resp.json()["id"] == "sammlung-1"
            docs = client.get(f"{API}/projects/sammlung-1/documents").json()["documents"]
        assert [d["name"] for d in docs] == ["neu.pdf"]
        assert (tmp_path / "projekte" / "sammlung-1.geloescht-2026-10-10" / "alt.txt").is_file()

    def test_an_unindexed_target_file_is_never_overwritten(self, atlas_app, tmp_path):
        """A project file the index does not know (written by hand, not yet
        indexed) still takes its id: the switch moves on, the file stays."""
        content = "---\nid: sammlung-1\ntitle: Von Hand\n---\nMeins.\n"
        with atlas_app(library=_seeded()) as client:
            _plan(client, 1)
            foreign = tmp_path / "projekte" / "sammlung-1.md"
            foreign.parent.mkdir(parents=True, exist_ok=True)
            foreign.write_text(content, encoding="utf-8")
            resp = client.post(f"{API}/collections/1/switch", json={"to": "project"})
            assert resp.status_code == 200 and resp.json()["id"] == "sammlung-1-2"
        assert foreign.read_text(encoding="utf-8") == content

    def test_a_hand_named_entry_switches_as_before(self, atlas_app, tmp_path):
        """An id outside [\\w-]+ (a hand-named file) can have no document
        folder; its switch works as it did before the folder rules."""
        with atlas_app(library=_seeded()) as client:
            pubs = tmp_path / "veroeffentlichungen"
            pubs.mkdir(parents=True, exist_ok=True)
            (pubs / "Mein.Antrag.md").write_text(
                "---\nschema: atlas.publication/2\nid: Mein.Antrag\ntitle: Antrag\n"
                "collection_id: 1\nkind: publication\n---\n", encoding="utf-8")
            assert client.post(f"{API}/reindex").status_code == 200
            resp = client.post(f"{API}/collections/1/switch", json={"to": "project"})
            assert resp.status_code == 200, resp.text
            assert resp.json()["id"] == "Mein.Antrag"
        assert (tmp_path / "projekte" / "Mein.Antrag.md").is_file()
        assert not (pubs / "Mein.Antrag.md").exists()

    def test_a_lock_that_cannot_be_undone_keeps_the_new_file_for_the_documents(
        self, atlas_app, tmp_path, monkeypatch
    ):
        """Old .md locked AND the folder cannot move back: the documents keep
        an entity — the new file stays (and is indexed), nothing is deleted."""
        from pathlib import Path

        from atlas import documents

        monkeypatch.setattr(documents, "LOCK_RETRY_DELAY", 0)
        old_md = tmp_path / "veroeffentlichungen" / "sammlung-1.md"
        real = Path.unlink

        def unlink(self, *args, **kwargs):
            if Path(self) == old_md:
                raise PermissionError("in Benutzung")
            return real(self, *args, **kwargs)

        def undo_locked(renames):
            raise PermissionError("OneDrive")

        with atlas_app(library=_seeded()) as client:
            _plan(client, 1)
            client.post(f"{API}/publications/sammlung-1/documents",
                        files={"file": ("gutachten.pdf", b"%PDF-1.4", "application/pdf")})
            monkeypatch.setattr(Path, "unlink", unlink)
            monkeypatch.setattr(documents, "undo_renames", undo_locked)
            resp = client.post(f"{API}/collections/1/switch", json={"to": "project"})
            monkeypatch.setattr(Path, "unlink", real)
            assert resp.status_code == 423
            assert resp.json()["detail"] == "error.atlas.document_locked"
            assert "sammlung-1" in _projects(client)
        assert (tmp_path / "projekte" / "sammlung-1.md").is_file()
        assert (tmp_path / "projekte" / "sammlung-1" / "gutachten.pdf").is_file()
        assert old_md.is_file()

    def test_a_locked_document_folder_refuses_the_switch(self, atlas_app, tmp_path, monkeypatch):
        from atlas import documents

        def locked(entity_id, other, new_id, today=None):
            raise PermissionError("OneDrive")

        with atlas_app(library=_seeded()) as client:
            _plan(client, 1)
            monkeypatch.setattr(documents.PUBLICATIONS, "move_to", locked)
            resp = client.post(f"{API}/collections/1/switch", json={"to": "project"})
            assert resp.status_code == 423
            assert resp.json()["detail"] == "error.atlas.document_locked"
            assert "sammlung-1" in _pubs(client) and _projects(client) == {}
        assert not (tmp_path / "projekte" / "sammlung-1.md").exists()

    def test_a_locked_markdown_file_refuses_the_switch_and_moves_the_documents_back(
        self, atlas_app, tmp_path, monkeypatch
    ):
        from pathlib import Path

        from atlas import documents

        monkeypatch.setattr(documents, "LOCK_RETRY_DELAY", 0)
        old_md = tmp_path / "veroeffentlichungen" / "sammlung-1.md"
        real = Path.unlink

        def unlink(self, *args, **kwargs):
            if Path(self) == old_md:
                raise PermissionError("in Benutzung")
            return real(self, *args, **kwargs)

        with atlas_app(library=_seeded()) as client:
            _plan(client, 1)
            client.post(f"{API}/publications/sammlung-1/documents",
                        files={"file": ("gutachten.pdf", b"%PDF-1.4", "application/pdf")})
            monkeypatch.setattr(Path, "unlink", unlink)
            resp = client.post(f"{API}/collections/1/switch", json={"to": "project"})
            monkeypatch.setattr(Path, "unlink", real)
            assert resp.status_code == 423
            assert resp.json()["detail"] == "error.atlas.document_locked"
            assert "sammlung-1" in _pubs(client) and _projects(client) == {}
            docs = client.get(f"{API}/publications/sammlung-1/documents").json()["documents"]
        assert [d["name"] for d in docs] == ["gutachten.pdf"]
        assert old_md.is_file()
        assert not (tmp_path / "projekte" / "sammlung-1.md").exists()
        assert not (tmp_path / "projekte" / "sammlung-1").exists()

    def test_same_kind_and_unknown_kind_are_refused(self, atlas_app):
        with atlas_app(library=_seeded()) as client:
            _plan(client, 1)
            assert client.post(f"{API}/collections/1/switch", json={"to": "publication"}).status_code == 409
            assert client.post(f"{API}/collections/1/switch", json={"to": "idea"}).status_code == 422
            assert client.post(f"{API}/collections/99/switch", json={"to": "project"}).status_code == 404

    def test_switch_keeps_an_unrelated_project_with_the_same_id(self, atlas_app, tmp_path):
        with atlas_app(library=_seeded()) as client:
            client.post(f"{API}/projects", json={"title": "x", "id": "sammlung-1"})
            _plan(client, 1)
            resp = client.post(f"{API}/collections/1/switch", json={"to": "project"})
            assert resp.json()["id"] == "sammlung-1-2"
        own, _ = _frontmatter(tmp_path / "projekte" / "sammlung-1.md")
        assert "collection_id" not in own


# =============================================================================
# Tombstone: freeze once into an existing file, never delete a file
# =============================================================================

class TestTombstone:
    def test_deleted_collection_freezes_refs_into_the_file_once(self, atlas_app, tmp_path):
        library = _seeded()
        with atlas_app(library=library) as client:
            _plan(client, 1)
            client.put(f"{API}/publications/sammlung-1", json={"status": "drafting"})
            library.delete_collection(1)
            assert _sync(client).pending
            _sync(client).flush()
            pub = _pubs(client)["sammlung-1"]
            assert pub["collection_id"] is None and pub["collection"] is None
            assert pub["refs"] == ["Smith2020", "Doe2021"]
            assert pub["status"] == "drafting"
            path = tmp_path / "veroeffentlichungen" / "sammlung-1.md"
            before = path.read_text(encoding="utf-8")
            plugin_store = client.app.state.atlas_plugin._store
            from atlas.collection_sync import reconcile_tombstones
            assert reconcile_tombstones(plugin_store, plugin_store.collections) == []
            assert path.read_text(encoding="utf-8") == before
        fm, _ = _frontmatter(path)
        assert fm["refs"] == ["Smith2020", "Doe2021"]
        assert "collection_id" not in fm and "kind" not in fm

    def test_deleted_collection_without_file_just_disappears(self, atlas_app, tmp_path):
        library = _seeded()
        with atlas_app(library=library) as client:
            library.delete_collection(1)
            _sync(client).flush()
            assert "sammlung-1" not in _pubs(client)
        assert not list((tmp_path / "veroeffentlichungen").glob("*.md"))

    def test_project_entry_becomes_a_normal_project(self, atlas_app, tmp_path):
        library = _seeded()
        with atlas_app(library=library) as client:
            _plan(client, 1)
            client.post(f"{API}/collections/1/switch", json={"to": "project"})
            library.delete_collection(1)
            _sync(client).flush()
            project = _projects(client)["sammlung-1"]
            assert project["refs"] == ["Smith2020", "Doe2021"] and project["collection_id"] is None

    def test_delete_while_atlas_was_off_is_caught_at_startup(self, atlas_app, tmp_path):
        library = _seeded()
        with atlas_app(library=library) as client:
            _plan(client, 1)
        library.delete_collection(1)  # Atlas is not running
        with atlas_app(library=library) as client:
            pub = _pubs(client)["sammlung-1"]
            assert pub["collection_id"] is None and pub["refs"] == ["Smith2020", "Doe2021"]


# =============================================================================
# Events: debounced, cheap, released on deactivate
# =============================================================================

class _FakeTimer:
    created: list = []

    def __init__(self, delay, fn):
        self.fn, self.started, self.cancelled = fn, False, False
        _FakeTimer.created.append(self)

    def start(self):
        self.started = True

    def cancel(self):
        self.cancelled = True


class TestCollectionSync:
    def test_a_burst_is_coalesced_into_one_pass(self):
        _FakeTimer.created = []
        runs, published = [], []
        sync = CollectionSync(lambda: runs.append(1), published.append, timer_factory=_FakeTimer)
        for _ in range(50):
            sync.on_event({"type": "collection", "action": "members_changed", "collection_id": 1})
        sync.on_event({"type": "changed", "citekey": "x"})  # not a Collection event
        assert len(_FakeTimer.created) == 1
        _FakeTimer.created[0].fn()
        assert runs == [1]
        assert published == [{"type": "archive-changed", "kind": "collection"}]

    def test_a_failing_pass_never_raises_and_close_stops_it(self):
        _FakeTimer.created = []

        def boom():
            raise RuntimeError("kaputt")

        sync = CollectionSync(boom, lambda e: None, timer_factory=_FakeTimer)
        sync.on_event({"type": "collection", "action": "deleted", "collection_id": 1})
        sync.flush()  # no exception
        sync.on_event({"type": "collection", "action": "deleted", "collection_id": 1})
        sync.close()
        assert _FakeTimer.created[-1].cancelled
        sync.on_event({"type": "collection", "action": "deleted", "collection_id": 1})
        assert len(_FakeTimer.created) == 2

    def test_deactivate_releases_the_listener(self, atlas_app):
        library = _seeded()
        with atlas_app(library=library):
            assert library.listener_count == 1
        assert library.listener_count == 0


# =============================================================================
# Manuscript compile: the Collection's .bib for a Collection entry
# =============================================================================

class TestCompileScope:
    def _compile(self, client, monkeypatch, manuscript_id) -> str:
        from atlas import compiler

        captured = {}

        def fake_compile(tex, bib):
            captured["bib"] = bib
            return b"%PDF"

        monkeypatch.setattr(compiler, "find_tectonic", lambda: "tectonic")
        monkeypatch.setattr(compiler, "compile_manuscript", fake_compile)
        assert client.post(f"{API}/manuscripts/{manuscript_id}/compile").status_code == 200
        return captured["bib"]

    def test_collection_entry_compiles_against_the_collection_only(self, atlas_app, monkeypatch):
        with atlas_app(library=_seeded()) as client:
            ms = client.post(f"{API}/manuscripts", json={"title": "Antrag"}).json()["id"]
            _plan(client, 1)
            client.post(f"{API}/publications/sammlung-1/manuscripts", json={"name": ms + ".tex"})
            bib = self._compile(client, monkeypatch, ms)
        assert "{Smith2020," in bib and "{Doe2021," in bib
        assert "Roe2019" not in bib

    def test_own_publication_keeps_the_whole_library(self, atlas_app, monkeypatch):
        with atlas_app(library=_seeded()) as client:
            ms = client.post(f"{API}/manuscripts", json={"title": "Eigen"}).json()["id"]
            pub = client.post(f"{API}/publications", json={"title": "Eigen"}).json()["id"]
            client.post(f"{API}/publications/{pub}/manuscripts", json={"name": ms + ".tex"})
            bib = self._compile(client, monkeypatch, ms)
        for key in ("Smith2020", "Doe2021", "Roe2019"):
            assert "{" + key + "," in bib


# =============================================================================
# Pure helpers
# =============================================================================

def test_virtual_id_avoids_an_unrelated_file():
    # The planned file keeps the id old deep links carry (sammlung-<id>).
    assert collection_entries.virtual_id(4) == "sammlung-4"
    assert collection_entries.virtual_id(4, {"sammlung-4"}) == "sammlung-4-2"


@pytest.mark.parametrize("target", ["project", "publication"])
def test_switch_without_file_carries_nothing(target):
    entity = (Publication if target == "project" else Project)(
        id="sammlung-1", title="T", status="active" if target == "publication" else "drafting",
        collection_id=1)
    new = collection_entries.switch_entity(entity, target, "sammlung-1")
    assert new.body == "" and new.kind == target and new.collection_id == 1
