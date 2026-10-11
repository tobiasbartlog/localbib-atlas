"""Detail page of a Publication (#226) — Literatur-Abgleich, "Zitate prüfen"
and the document folder, through the Atlas HTTP API with the
``plugin_api.testing`` fakes. Behaviour only: request in, answer and files
out."""
from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest
from plugin_api.testing import InMemoryLibrary

API = "/api/plugins/atlas"

REFERENCES = [
    {"citekey": "krause2023", "id": 11, "title": "Dehnungsmessung", "authors": "Krause, M.",
     "year": 2023, "doi": "10.0000/fvp.2023.014", "has_pdf": True},
    {"citekey": "becker2021", "id": 12, "title": "Zyklische Belastung", "authors": "Becker, A.",
     "year": 2021, "doi": "", "has_pdf": False},
    {"citekey": "ito2021", "id": 13, "title": "Strain gauge placement", "authors": "Ito, K.",
     "year": 2021, "doi": "10.0000/sgp.2021.066", "has_pdf": True},
]

MANUSCRIPT = r"""
\section{Einleitung}
Wie in \cite{krause2023, becker2021} gezeigt % \cite{auskommentiert}
und \citep[S.~12]{nguyen2024} sowie \textcite{wolf2024}.
"""

BIB = r"""
@article{nguyen2024,
  title = {Low-cost strain sensing},
  author = {Nguyen, T. and Patel, R.},
  year = {2024},
  doi = {10.0000/sens.2024.118}
}
"""


def _library() -> InMemoryLibrary:
    return InMemoryLibrary(REFERENCES, collections=[
        {"id": 5, "name": "Versuchsreihe B", "refs": ["krause2023", "ito2021"]},
    ])


def _manuscript(client, title: str, content: str) -> str:
    ms = client.post(f"{API}/manuscripts", json={"title": title}).json()["id"]
    assert client.put(f"{API}/manuscripts/{ms}", json={"content": content}).status_code == 200
    return ms


def _rows(data) -> dict:
    return {r["key"]: r for r in data["rows"]}


def test_literature_of_a_collection_entry_joins_manuscript_collection_and_library(atlas_app):
    with atlas_app(library=_library()) as client:
        ms = _manuscript(client, "Konferenz B", MANUSCRIPT)
        pub = client.post(f"{API}/collections/5/plan").json()["entry"]["id"]
        client.post(f"{API}/publications/{pub}/manuscripts", json={"name": ms + ".tex"})
        client.post(f"{API}/publications/{pub}/documents",
                    files={"file": ("literatur.bib", BIB.encode("utf-8"), "text/plain")})
        data = client.get(f"{API}/publications/{pub}/literature").json()

    assert data["source"]["kind"] == "collection"
    assert data["source"]["collection"]["name"] == "Versuchsreihe B"
    assert data["manuscripts"] == [{"name": ms + ".tex", "id": ms, "found": True, "cite_count": 4, "problem": None}]
    # cited keys first (order of appearance), then the rest of the collection
    assert [r["key"] for r in data["rows"]] == ["krause2023", "becker2021", "nguyen2024", "wolf2024", "ito2021"]
    rows = _rows(data)
    assert rows["krause2023"]["cited"] and rows["krause2023"]["in_source"]
    assert rows["krause2023"]["in_library"] and rows["krause2023"]["has_pdf"] is True
    assert rows["krause2023"]["item_id"] == 11
    assert rows["becker2021"]["in_library"] and rows["becker2021"]["has_pdf"] is False
    assert not rows["becker2021"]["in_source"]
    # missing in the library: title and DOI from the .bib of the document folder
    assert rows["nguyen2024"]["in_library"] is False and rows["nguyen2024"]["from_bib"] is True
    assert rows["nguyen2024"]["title"] == "Low-cost strain sensing"
    assert rows["nguyen2024"]["doi"] == "10.0000/sens.2024.118"
    assert rows["wolf2024"]["in_library"] is False and rows["wolf2024"]["title"] is None
    assert rows["ito2021"]["cited"] is False and rows["ito2021"]["in_source"] is True
    assert data["counts"] == {
        "total": 5, "cited": 4, "cited_in_library": 2, "uncited": 1, "cited_missing": 2,
        "missing": 2, "with_pdf": 2, "without_pdf": 1,
    }


def test_the_collection_is_read_live(atlas_app):
    library = _library()
    with atlas_app(library=library) as client:
        pub = client.post(f"{API}/collections/5/plan").json()["entry"]["id"]
        library.set_collection_refs(5, ["becker2021"])
        data = client.get(f"{API}/publications/{pub}/literature").json()
    assert [r["key"] for r in data["rows"]] == ["becker2021"]


def test_an_own_publication_falls_back_to_its_refs(atlas_app):
    with atlas_app(library=_library()) as client:
        pub = client.post(f"{API}/publications", json={"title": "Eigen", "refs": ["ito2021", "fehlt2020"]}).json()["id"]
        data = client.get(f"{API}/publications/{pub}/literature").json()
    assert data["source"]["kind"] == "refs"
    rows = _rows(data)
    assert rows["ito2021"]["in_library"] and not rows["ito2021"]["cited"]
    assert rows["fehlt2020"]["in_library"] is False
    assert data["counts"]["uncited"] == 2 and data["counts"]["missing"] == 1


def test_a_manuscript_link_with_an_invalid_name_is_flagged_and_the_rest_still_counts(atlas_app):
    with atlas_app(library=_library()) as client:
        ms = _manuscript(client, "Gut", MANUSCRIPT)
        pub = client.post(f"{API}/publications", json={
            "title": "Eigen", "manuscripts": ["../kaputt name.tex", ms + ".tex"],
        }).json()["id"]
        resp = client.get(f"{API}/publications/{pub}/literature")
    assert resp.status_code == 200
    linked = {m["name"]: m for m in resp.json()["manuscripts"]}
    assert linked["../kaputt name.tex"]["found"] is False
    assert linked["../kaputt name.tex"]["problem"] == "name_invalid"
    assert linked[ms + ".tex"]["cite_count"] == 4 and linked[ms + ".tex"]["problem"] is None
    assert resp.json()["counts"]["cited"] == 4


def test_a_manuscript_that_is_not_utf8_is_flagged_and_the_rest_still_counts(atlas_app, tmp_path):
    with atlas_app(library=_library()) as client:
        good = _manuscript(client, "Gut", MANUSCRIPT)
        old = _manuscript(client, "Alt", "")
        (tmp_path / "manuskripte" / f"{old}.tex").write_bytes(
            "Größe nach \\cite{ito2021}".encode("latin-1"))
        pub = client.post(f"{API}/publications", json={
            "title": "Eigen", "manuscripts": [old + ".tex", good + ".tex"],
        }).json()["id"]
        resp = client.get(f"{API}/publications/{pub}/literature")
    assert resp.status_code == 200
    linked = {m["id"]: m for m in resp.json()["manuscripts"]}
    assert linked[old]["found"] is True and linked[old]["problem"] == "not_utf8"
    assert linked[old]["cite_count"] == 0
    assert linked[good]["cite_count"] == 4
    assert resp.json()["counts"]["cited"] == 4


def test_literature_of_an_unknown_publication_is_a_code(atlas_client):
    resp = atlas_client.get(f"{API}/publications/gibt-es-nicht/literature")
    assert resp.status_code == 404
    assert resp.json()["detail"] == "error.atlas.publication_not_found"


def test_check_citations_reads_pasted_tex_and_writes_nothing(atlas_app, tmp_path):
    with atlas_app(library=_library()) as client:
        pub = client.post(f"{API}/publications", json={"title": "Eigen"}).json()["id"]
        before = sorted(p.name for p in (tmp_path / "veroeffentlichungen").iterdir())
        resp = client.post(f"{API}/publications/{pub}/check-citations", json={"text": MANUSCRIPT})
        after = sorted(p.name for p in (tmp_path / "veroeffentlichungen").iterdir())
    assert resp.status_code == 200
    data = resp.json()
    assert data["keys"] == ["krause2023", "becker2021", "nguyen2024", "wolf2024"]
    assert data["counts"] == {"total": 4, "in_library": 2, "missing": 2}
    assert before == after


def test_the_document_folder_lists_uploads_and_never_reaches_the_index(atlas_app, tmp_path):
    with atlas_app(library=_library()) as client:
        pub = client.post(f"{API}/publications", json={"title": "Beitrag"}).json()["id"]
        assert client.get(f"{API}/publications/{pub}/documents").json() == {
            "documents": [], "folder": f"veroeffentlichungen/{pub}/",
        }
        up = client.post(f"{API}/publications/{pub}/documents",
                         files={"file": ("gutachten.pdf", b"%PDF-1.4", "application/pdf")})
        assert up.status_code == 200 and up.json()["name"] == "gutachten.pdf"
        # A second upload with the same name never overwrites.
        again = client.post(f"{API}/publications/{pub}/documents",
                            files={"file": ("gutachten.pdf", b"%PDF-1.5", "application/pdf")})
        assert again.json()["name"] == "gutachten-2.pdf"
        # An .md inside the folder is a document, not a publication.
        client.post(f"{API}/publications/{pub}/documents",
                    files={"file": ("notizen.md", b"---\ntitle: X\n---\n", "text/markdown")})
        assert client.post(f"{API}/reindex").status_code == 200
        pubs = client.get(f"{API}/publications").json()["publications"]
        assert [p["id"] for p in pubs] == [pub]
        names = {d["name"] for d in client.get(f"{API}/publications/{pub}/documents").json()["documents"]}
        assert names == {"gutachten.pdf", "gutachten-2.pdf", "notizen.md"}
        assert client.delete(f"{API}/publications/{pub}/documents/gutachten.pdf").status_code == 200
        assert client.delete(f"{API}/publications/{pub}/documents/gutachten.pdf").status_code == 404
        assert client.delete(f"{API}/publications/{pub}/documents/a%3Ab.pdf").status_code == 422
    assert (tmp_path / "veroeffentlichungen" / pub / "gutachten-2.pdf").is_file()
    assert not (tmp_path / "veroeffentlichungen" / pub / "gutachten.pdf").exists()


DAY = date(2026, 10, 10)


@pytest.fixture
def pinned(monkeypatch):
    """The set-aside folder is named after the day; locks give up at once."""
    from atlas import documents

    monkeypatch.setattr(documents, "_today", lambda: DAY)
    monkeypatch.setattr(documents, "LOCK_RETRY_DELAY", 0)
    return DAY.isoformat()


def _lock_file(monkeypatch, path):
    """Make one file undeletable, as an open viewer or OneDrive sync would."""
    real = Path.unlink

    def unlink(self, *args, **kwargs):
        if Path(self) == Path(path):
            raise PermissionError("in Benutzung")
        return real(self, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", unlink)


def test_deleting_a_publication_sets_its_documents_aside(atlas_app, tmp_path, pinned):
    """The folder never resurfaces under a new entry with the same id —
    re-planning a Collection reuses sammlung-<id> — and no user file is lost."""
    today = pinned
    with atlas_app(library=_library()) as client:
        pub = client.post(f"{API}/collections/5/plan").json()["entry"]["id"]
        client.post(f"{API}/publications/{pub}/documents",
                    files={"file": ("literatur.bib", BIB.encode("utf-8"), "text/plain")})
        assert client.delete(f"{API}/publications/{pub}").status_code == 200
        again = client.post(f"{API}/collections/5/plan").json()["entry"]["id"]
        assert again == pub
        assert client.get(f"{API}/publications/{pub}/documents").json()["documents"] == []
        rows = {r["key"]: r for r in client.get(f"{API}/publications/{pub}/literature").json()["rows"]}
        assert all(not r["from_bib"] for r in rows.values())
    aside = tmp_path / "veroeffentlichungen" / f"{pub}.geloescht-{today}"
    assert (aside / "literatur.bib").read_text(encoding="utf-8") == BIB
    assert not (tmp_path / "veroeffentlichungen" / pub).exists()


def test_deleting_a_publication_with_an_empty_folder_leaves_nothing_behind(atlas_app, tmp_path):
    with atlas_app(library=_library()) as client:
        pub = client.post(f"{API}/publications", json={"title": "Beitrag"}).json()["id"]
        client.post(f"{API}/publications/{pub}/documents", files={"file": ("abb.png", b"png", "image/png")})
        client.delete(f"{API}/publications/{pub}/documents/abb.png")
        assert client.delete(f"{API}/publications/{pub}").status_code == 200
    assert sorted(p.name for p in (tmp_path / "veroeffentlichungen").iterdir()) == []


def test_a_locked_document_folder_keeps_the_publication(atlas_app, tmp_path, monkeypatch):
    from atlas import documents

    def locked(entity_id, today=None):
        raise PermissionError("OneDrive")

    with atlas_app(library=_library()) as client:
        pub = client.post(f"{API}/publications", json={"title": "Beitrag"}).json()["id"]
        monkeypatch.setattr(documents.PUBLICATIONS, "set_aside", locked)
        resp = client.delete(f"{API}/publications/{pub}")
        assert resp.status_code == 423
        assert resp.json()["detail"] == "error.atlas.document_locked"
        assert client.get(f"{API}/publications/{pub}").status_code == 200
    assert (tmp_path / "veroeffentlichungen" / f"{pub}.md").is_file()


def test_a_locked_markdown_file_keeps_publication_and_documents(atlas_app, tmp_path, monkeypatch, pinned):
    """All or nothing: the folder set aside is renamed back when the .md
    cannot go."""
    with atlas_app(library=_library()) as client:
        pub = client.post(f"{API}/publications", json={"title": "Beitrag"}).json()["id"]
        client.post(f"{API}/publications/{pub}/documents", files={"file": ("abb.png", b"png", "image/png")})
        _lock_file(monkeypatch, tmp_path / "veroeffentlichungen" / f"{pub}.md")
        resp = client.delete(f"{API}/publications/{pub}")
        assert resp.status_code == 423
        assert resp.json()["detail"] == "error.atlas.document_locked"
        assert client.get(f"{API}/publications/{pub}").status_code == 200
        names = [d["name"] for d in client.get(f"{API}/publications/{pub}/documents").json()["documents"]]
    assert names == ["abb.png"]
    assert not (tmp_path / "veroeffentlichungen" / f"{pub}.geloescht-{pinned}").exists()


def test_a_lock_that_cannot_be_undone_still_answers_423(atlas_app, tmp_path, monkeypatch, pinned):
    """.md locked AND the folder cannot be renamed back: no 500 — the files
    stay where they are (the folder set aside, the .md in place)."""
    from atlas import documents

    def undo_locked(renames):
        raise PermissionError("OneDrive")

    with atlas_app(library=_library()) as client:
        pub = client.post(f"{API}/publications", json={"title": "Beitrag"}).json()["id"]
        client.post(f"{API}/publications/{pub}/documents", files={"file": ("abb.png", b"png", "image/png")})
        _lock_file(monkeypatch, tmp_path / "veroeffentlichungen" / f"{pub}.md")
        monkeypatch.setattr(documents, "undo_renames", undo_locked)
        resp = client.delete(f"{API}/publications/{pub}")
        assert resp.status_code == 423
        assert resp.json()["detail"] == "error.atlas.document_locked"
    assert (tmp_path / "veroeffentlichungen" / f"{pub}.md").is_file()
    assert (tmp_path / "veroeffentlichungen" / f"{pub}.geloescht-{pinned}" / "abb.png").is_file()


def test_a_dotted_id_is_created_as_before(atlas_app, tmp_path):
    """An id no document folder can have (``a.b``) is no error — it simply
    has no folder to look at."""
    with atlas_app(library=_library()) as client:
        resp = client.post(f"{API}/publications", json={"title": "Punkt", "id": "a.b"})
        assert resp.status_code == 200, resp.text
        assert resp.json()["id"] == "a.b"
    assert (tmp_path / "veroeffentlichungen" / "a.b.md").is_file()


def test_a_leftover_folder_is_never_inherited_by_a_new_publication(atlas_app, tmp_path):
    """A folder whose .md was deleted in the Explorer (or by an older Atlas)
    makes its id taken: the new entry gets the next one, the files stay put."""
    for name in ("beitrag", "sammlung-5"):
        leftover = tmp_path / "veroeffentlichungen" / name
        leftover.mkdir(parents=True)
        (leftover / "alt.bib").write_text(BIB, encoding="utf-8")
    with atlas_app(library=_library()) as client:
        own = client.post(f"{API}/publications", json={"title": "Beitrag"}).json()["id"]
        planned = client.post(f"{API}/collections/5/plan").json()["entry"]["id"]
        assert (own, planned) == ("beitrag-2", "sammlung-5-2")
        for pub in (own, planned):
            assert client.get(f"{API}/publications/{pub}/documents").json()["documents"] == []
    assert (tmp_path / "veroeffentlichungen" / "beitrag" / "alt.bib").is_file()


def test_open_uses_the_system_program(atlas_app, monkeypatch):
    from atlas import documents

    opened = []
    monkeypatch.setattr(documents, "open_in_viewer", lambda path: opened.append(path.name))
    with atlas_app(library=_library()) as client:
        pub = client.post(f"{API}/publications", json={"title": "Beitrag"}).json()["id"]
        client.post(f"{API}/publications/{pub}/documents", files={"file": ("abb.png", b"png", "image/png")})
        assert client.post(f"{API}/publications/{pub}/documents/abb.png/open").status_code == 200
        assert client.post(f"{API}/publications/{pub}/documents/fehlt.png/open").status_code == 404
    assert opened == ["abb.png"]
