"""Per-project documents (projekte/<id>/, issue #49) — upload, listing, open.

Documents are plain files, no frontmatter, no DB index: the listing reads the
directory, so externally dropped files appear identically to uploads. The
indexer must never scan these subfolders for Markdown.
"""
from __future__ import annotations

import json
from datetime import date
from unittest.mock import patch

import fitz
import pytest

from atlas import config as atlas_config
from atlas import project_extraction
from atlas import config
from atlas.domain import Project, parse_sections
from atlas.store import AtlasStore


@pytest.fixture
def project_id(atlas_client):
    return atlas_client.post(
        "/api/plugins/atlas/projects", json={"title": "FGC Robotik"}
    ).json()["id"]


def _upload(client, project_id, name=b"bericht.pdf", content=b"%PDF-1.4 test"):
    name = name.decode() if isinstance(name, bytes) else name
    return client.post(
        f"/api/plugins/atlas/projects/{project_id}/documents",
        files={"file": (name, content, "application/octet-stream")},
    )


def _write_pdf(path, text: str = ""):
    doc = fitz.open()
    page = doc.new_page()
    if text:
        page.insert_text((72, 72), text)
    doc.save(path)
    doc.close()


# --- deleting the project ----------------------------------------------------------

def test_deleting_the_project_sets_its_documents_aside(atlas_client, project_id, tmp_path, monkeypatch):
    """Same rule as a Publication's folder (#226 review): the files stay, but
    a new project with the same id does not inherit them."""
    from atlas import documents

    monkeypatch.setattr(documents, "_today", lambda: date(2026, 10, 10))
    today = "2026-10-10"
    _upload(atlas_client, project_id)
    assert atlas_client.delete(f"/api/plugins/atlas/projects/{project_id}").status_code == 200
    assert not (tmp_path / "projekte" / project_id).exists()
    assert (tmp_path / "projekte" / f"{project_id}.geloescht-{today}" / "bericht.pdf").is_file()
    again = atlas_client.post("/api/plugins/atlas/projects", json={"title": "FGC Robotik"}).json()["id"]
    assert again == project_id
    assert atlas_client.get(f"/api/plugins/atlas/projects/{project_id}/documents").json() == {"documents": []}


def test_a_leftover_folder_is_never_inherited_by_a_new_project(atlas_client, tmp_path):
    leftover = tmp_path / "projekte" / "dfg-antrag"
    leftover.mkdir(parents=True)
    (leftover / "alt.pdf").write_bytes(b"%PDF-1.4")
    new_id = atlas_client.post("/api/plugins/atlas/projects", json={"title": "DFG Antrag"}).json()["id"]
    assert new_id == "dfg-antrag-2"
    assert atlas_client.get(f"/api/plugins/atlas/projects/{new_id}/documents").json() == {"documents": []}
    assert (leftover / "alt.pdf").is_file()


# --- listing -------------------------------------------------------------------

def test_listing_empty_initially(atlas_client, project_id):
    resp = atlas_client.get(f"/api/plugins/atlas/projects/{project_id}/documents")
    assert resp.status_code == 200
    assert resp.json() == {"documents": []}


def test_listing_unknown_project_404(atlas_client):
    assert atlas_client.get("/api/plugins/atlas/projects/nope/documents").status_code == 404


def test_external_file_appears_in_listing(atlas_client, project_id, tmp_path):
    # Story 29: a file dropped into the folder externally is an equal citizen.
    folder = tmp_path / "projekte" / project_id
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "Vorhabensbeschreibung.docx").write_bytes(b"extern")
    docs = atlas_client.get(f"/api/plugins/atlas/projects/{project_id}/documents").json()["documents"]
    assert [d["name"] for d in docs] == ["Vorhabensbeschreibung.docx"]
    assert docs[0]["size"] == 6


def test_listing_skips_dotfiles_and_subdirs(atlas_client, project_id, tmp_path):
    folder = tmp_path / "projekte" / project_id
    folder.mkdir(parents=True, exist_ok=True)
    (folder / ".versteckt").write_bytes(b"x")
    (folder / "unterordner").mkdir()
    (folder / "sichtbar.txt").write_bytes(b"x")
    docs = atlas_client.get(f"/api/plugins/atlas/projects/{project_id}/documents").json()["documents"]
    assert [d["name"] for d in docs] == ["sichtbar.txt"]


# --- upload --------------------------------------------------------------------

def test_upload_stores_into_project_subfolder(atlas_client, project_id, tmp_path):
    resp = _upload(atlas_client, project_id)
    assert resp.status_code == 200
    meta = resp.json()
    assert meta["name"] == "bericht.pdf"
    stored = tmp_path / "projekte" / project_id / "bericht.pdf"
    assert stored.read_bytes() == b"%PDF-1.4 test"
    # ... and shows up in the listing.
    docs = atlas_client.get(f"/api/plugins/atlas/projects/{project_id}/documents").json()["documents"]
    assert [d["name"] for d in docs] == ["bericht.pdf"]


def test_upload_unknown_project_404(atlas_client):
    assert _upload(atlas_client, "nope").status_code == 404


def test_upload_never_overwrites_collisions_get_suffix(atlas_client, project_id, tmp_path):
    assert _upload(atlas_client, project_id, content=b"erste").status_code == 200
    assert _upload(atlas_client, project_id, content=b"zweite").status_code == 200
    folder = tmp_path / "projekte" / project_id
    assert (folder / "bericht.pdf").read_bytes() == b"erste"
    assert (folder / "bericht-2.pdf").read_bytes() == b"zweite"


def test_upload_strips_client_path_components(atlas_client, project_id, tmp_path):
    resp = _upload(atlas_client, project_id, name="..\\..\\evil.txt", content=b"x")
    assert resp.status_code == 200
    assert resp.json()["name"] == "evil.txt"
    assert (tmp_path / "projekte" / project_id / "evil.txt").exists()
    assert not (tmp_path / "evil.txt").exists()


def test_upload_invalid_filename_rejected(atlas_client, project_id):
    assert _upload(atlas_client, project_id, name=".versteckt").status_code == 400
    assert _upload(atlas_client, project_id, name="a?b.txt").status_code == 400


# --- open in system viewer -----------------------------------------------------

def test_open_invokes_system_viewer(atlas_client, project_id, tmp_path):
    _upload(atlas_client, project_id)
    with patch("atlas.documents.open_in_viewer") as opener:
        resp = atlas_client.post(
            f"/api/plugins/atlas/projects/{project_id}/documents/bericht.pdf/open"
        )
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}
    opener.assert_called_once()
    assert opener.call_args[0][0] == tmp_path / "projekte" / project_id / "bericht.pdf"


def test_open_missing_document_404(atlas_client, project_id):
    with patch("atlas.documents.open_in_viewer") as opener:
        resp = atlas_client.post(
            f"/api/plugins/atlas/projects/{project_id}/documents/fehlt.pdf/open"
        )
    assert resp.status_code == 404
    opener.assert_not_called()


def test_open_path_traversal_rejected(atlas_client, project_id, tmp_path):
    (tmp_path / "geheim.txt").write_bytes(b"x")
    with patch("atlas.documents.open_in_viewer") as opener:
        resp = atlas_client.post(
            f"/api/plugins/atlas/projects/{project_id}/documents/..%2Fgeheim.txt/open"
        )
    assert resp.status_code in (404, 422)
    opener.assert_not_called()


# --- delete --------------------------------------------------------------------

def test_delete_removes_document(atlas_client, project_id, tmp_path):
    _upload(atlas_client, project_id)
    path = tmp_path / "projekte" / project_id / "bericht.pdf"
    assert path.is_file()
    resp = atlas_client.delete(
        f"/api/plugins/atlas/projects/{project_id}/documents/bericht.pdf"
    )
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}
    assert not path.exists()
    listing = atlas_client.get(f"/api/plugins/atlas/projects/{project_id}/documents").json()
    assert listing == {"documents": []}


def test_delete_missing_document_404(atlas_client, project_id):
    resp = atlas_client.delete(
        f"/api/plugins/atlas/projects/{project_id}/documents/fehlt.pdf"
    )
    assert resp.status_code == 404


def test_delete_path_traversal_rejected(atlas_client, project_id, tmp_path):
    secret = tmp_path / "geheim.txt"
    secret.write_bytes(b"x")
    resp = atlas_client.delete(
        f"/api/plugins/atlas/projects/{project_id}/documents/..%2Fgeheim.txt"
    )
    assert resp.status_code in (404, 422)
    assert secret.exists()  # nichts ausserhalb des Projektordners geloescht


def test_delete_locked_file_returns_423(atlas_client, project_id, monkeypatch):
    """OneDrive-Sync/Viewer haelt die Datei -> klarer 423 statt 500."""
    import pathlib

    _upload(atlas_client, project_id)

    def boom(self):
        raise PermissionError(32, "in use by another process")

    monkeypatch.setattr(pathlib.Path, "unlink", boom)
    resp = atlas_client.delete(
        f"/api/plugins/atlas/projects/{project_id}/documents/bericht.pdf"
    )
    assert resp.status_code == 423


# --- extract project metadata proposal ----------------------------------------

def test_extract_passes_affiliation_into_prompt(atlas_client, project_id, tmp_path):
    """Zugehörigkeit landet im System-Prompt, damit das LLM aus Sicht des
    richtigen Projektpartners extrahiert (viele Partner im Foerderantrag)."""
    folder = tmp_path / "projekte" / project_id
    folder.mkdir(parents=True, exist_ok=True)
    _write_pdf(folder / "antrag.pdf", "Verbundprojekt mit mehreren Partnern.")
    with patch.object(
        atlas_client.app.state.atlas_api.llm, "complete", return_value={"content": "{}"}
    ) as llm:
        resp = atlas_client.post(
            f"/api/plugins/atlas/projects/{project_id}/documents/antrag.pdf/extract",
            json={"affiliation": "RWTH Aachen, Lehrstuhl iCOM"},
        )
    assert resp.status_code == 200
    system = llm.call_args[0][0]["messages"][0]["content"]
    assert "RWTH Aachen, Lehrstuhl iCOM" in system
    assert "Projektpartner" in system


def test_extract_without_affiliation_omits_partner_hint(atlas_client, project_id, tmp_path):
    folder = tmp_path / "projekte" / project_id
    folder.mkdir(parents=True, exist_ok=True)
    _write_pdf(folder / "antrag.pdf", "Verbundprojekt mit mehreren Partnern.")
    with patch.object(
        atlas_client.app.state.atlas_api.llm, "complete", return_value={"content": "{}"}
    ) as llm:
        resp = atlas_client.post(
            f"/api/plugins/atlas/projects/{project_id}/documents/antrag.pdf/extract",
            json={},
        )
    assert resp.status_code == 200
    system = llm.call_args[0][0]["messages"][0]["content"]
    assert "Projektpartner" not in system  # unveraendertes Verhalten ohne Angabe


def test_extract_pdf_returns_proposal_without_writing(atlas_client, project_id, tmp_path):
    folder = tmp_path / "projekte" / project_id
    folder.mkdir(parents=True, exist_ok=True)
    pdf = folder / "antrag.pdf"
    _write_pdf(
        pdf,
        "Projektlaufzeit 2026-01-01 bis 2028-12-31. Foerderer: DFG. "
        "Foerderkennzeichen RO-12345. Rolle: Projektleitung.",
    )
    project_md = tmp_path / "projekte" / f"{project_id}.md"
    before = project_md.read_text(encoding="utf-8")
    answer = json.dumps(
        {
            "start": "2026-01-01",
            "end": "2028-12-31",
            "funder": "DFG",
            "grant_id": "RO-12345",
            "role": "Projektleitung",
            "milestones": [
                {"title": "Projektstart", "date": "2026-01-01"},
                {"title": "Zwischenbericht", "date": "Q3 2026"},
            ],
            "workpackages": [
                {
                    "title": "AP1 Aufbau",
                    "tasks": ["Teststand aufbauen", "Pilotstudie durchfuehren"],
                }
            ],
        }
    )
    with patch.object(atlas_client.app.state.atlas_api.llm, "complete", return_value={"content": answer}) as llm:
        resp = atlas_client.post(
            f"/api/plugins/atlas/projects/{project_id}/documents/antrag.pdf/extract",
            json={"model": "atlas-model"},
        )
    assert resp.status_code == 200
    assert resp.json() == {
        "start": "2026-01-01",
        "end": "2028-12-31",
        "funder": "DFG",
        "grant_id": "RO-12345",
        "role": "Projektleitung",
        "milestones": [
            {"title": "Projektstart", "date": "2026-01-01"},
            {"title": "Zwischenbericht", "date": None},
        ],
        "workpackages": [
            {
                "title": "AP1 Aufbau",
                "tasks": ["Teststand aufbauen", "Pilotstudie durchfuehren"],
            }
        ],
        "workpackage_markdown": (
            "## AP1 Aufbau\n"
            "- [ ] Teststand aufbauen\n"
            "- [ ] Pilotstudie durchfuehren"
        ),
        "warnings": [
            "Meilenstein-Datum fuer 'Zwischenbericht' verworfen: 'Q3 2026' ist kein ISO-Datum YYYY-MM-DD."
        ],
    }
    assert project_md.read_text(encoding="utf-8") == before
    req = llm.call_args[0][0]
    assert req["timeout"] == 120
    assert req["model"] == "atlas-model"
    assert req["messages"][1]["content"].count("Foerderkennzeichen") >= 1
    assert "milestones" in req["messages"][1]["content"]
    assert "workpackages" in req["messages"][1]["content"]


def test_extract_pdf_textless_returns_clear_error_without_llm(atlas_client, project_id, tmp_path):
    folder = tmp_path / "projekte" / project_id
    folder.mkdir(parents=True, exist_ok=True)
    _write_pdf(folder / "scan.pdf")
    with patch.object(atlas_client.app.state.atlas_api.llm, "complete") as llm:
        resp = atlas_client.post(
            f"/api/plugins/atlas/projects/{project_id}/documents/scan.pdf/extract"
        )
    assert resp.status_code == 422
    assert "OCR" in resp.json()["detail"]
    llm.assert_not_called()


def test_extract_invalid_json_fails_without_partial_result(atlas_client, project_id, tmp_path):
    folder = tmp_path / "projekte" / project_id
    folder.mkdir(parents=True, exist_ok=True)
    _write_pdf(folder / "antrag.pdf", "Foerderer: DFG")
    with patch.object(atlas_client.app.state.atlas_api.llm, "complete", return_value={"content": "kein json"}):
        resp = atlas_client.post(
            f"/api/plugins/atlas/projects/{project_id}/documents/antrag.pdf/extract"
        )
    assert resp.status_code == 502
    assert "JSON" in resp.json()["detail"]


def test_extract_overlong_text_adds_warning(atlas_client, project_id, tmp_path, monkeypatch):
    folder = tmp_path / "projekte" / project_id
    folder.mkdir(parents=True, exist_ok=True)
    _write_pdf(folder / "lang.pdf", "Foerderer: DFG " * 30)
    monkeypatch.setattr(project_extraction, "MAX_PDF_TEXT_CHARS", 80)
    with patch.object(
        atlas_client.app.state.atlas_api.llm,
        "complete",
        return_value={"content": json.dumps({"funder": "DFG"})},
    ):
        resp = atlas_client.post(
            f"/api/plugins/atlas/projects/{project_id}/documents/lang.pdf/extract"
        )
    assert resp.status_code == 200
    data = resp.json()
    assert data["funder"] == "DFG"
    assert data["start"] is None
    assert data["milestones"] == []
    assert data["workpackages"] == []
    assert data["workpackage_markdown"] == ""
    assert data["warnings"] == [project_extraction.TRUNCATION_WARNING]


def test_render_workpackages_markdown_round_trips_through_parse_sections():
    markdown = project_extraction.render_workpackages_markdown(
        [
            {"title": "AP1 Grundlagen", "tasks": ["Literatur sichten", "Konzept schreiben"]},
            {"title": "AP2 Transfer", "tasks": ["Demonstrator bauen"]},
        ]
    )
    assert markdown == (
        "## AP1 Grundlagen\n"
        "- [ ] Literatur sichten\n"
        "- [ ] Konzept schreiben\n\n"
        "## AP2 Transfer\n"
        "- [ ] Demonstrator bauen"
    )
    sections = parse_sections(markdown)
    assert [(s["title"], s["done"], s["total"]) for s in sections] == [
        ("AP1 Grundlagen", 0, 2),
        ("AP2 Transfer", 0, 1),
    ]


def test_parse_extraction_response_without_workpackages_has_empty_body_block():
    proposal = project_extraction.parse_extraction_response('{"funder": "DFG"}')
    assert proposal["workpackages"] == []
    assert proposal["workpackage_markdown"] == ""


def test_extract_non_pdf_rejected(atlas_client, project_id, tmp_path):
    folder = tmp_path / "projekte" / project_id
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "notiz.txt").write_text("Foerderer: DFG", encoding="utf-8")
    resp = atlas_client.post(
        f"/api/plugins/atlas/projects/{project_id}/documents/notiz.txt/extract"
    )
    assert resp.status_code == 400


# --- indexer ignores project subfolders ----------------------------------------

def _store(tmp_path, monkeypatch) -> AtlasStore:
    monkeypatch.setattr(atlas_config, "_base_dir", str(tmp_path))
    config.ensure_dirs()
    return AtlasStore()


def _write_project(project_id: str, title: str, into) -> None:
    into.mkdir(parents=True, exist_ok=True)
    (into / f"{project_id}.md").write_text(
        Project(id=project_id, title=title).to_markdown(), encoding="utf-8"
    )


def test_reindex_ignores_markdown_in_document_subfolders(tmp_path, monkeypatch):
    store = _store(tmp_path, monkeypatch)
    _write_project("echt", "Echtes Projekt", config.projects_dir())
    # A Markdown *document* inside the project's folder must not be indexed.
    _write_project("dokument", "Zwischenbericht", config.projects_dir() / "echt")

    stats = store.reindex()
    assert stats["projects_indexed"] == 1
    assert [p.id for p in store.list_projects()] == ["echt"]


def test_index_path_ignores_files_in_document_subfolders(tmp_path, monkeypatch):
    store = _store(tmp_path, monkeypatch)
    _write_project("echt", "Echtes Projekt", config.projects_dir())
    store.reindex()
    _write_project("notiz", "Notiz im Ordner", config.projects_dir() / "echt")

    # Watcher entry point: the subfolder file is routed nowhere.
    store.index_path(config.projects_dir() / "echt" / "notiz.md")
    assert [p.id for p in store.list_projects()] == ["echt"]
