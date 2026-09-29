"""Manuscript CRUD — .tex files in <archive>/manuskripte/, no DB index."""
from __future__ import annotations

import pytest



def test_list_empty_initially(atlas_client):
    resp = atlas_client.get("/api/plugins/atlas/manuscripts")
    assert resp.status_code == 200
    assert resp.json() == {"manuscripts": []}


def test_create_writes_tex_file_with_template(atlas_client, tmp_path):
    created = atlas_client.post(
        "/api/plugins/atlas/manuscripts", json={"title": "Kapitel Eins"}
    ).json()
    assert created["id"] == "kapitel-eins"
    tex = tmp_path / "manuskripte" / "kapitel-eins.tex"
    assert tex.exists()
    content = tex.read_text(encoding="utf-8")
    assert "\\title{Kapitel Eins}" in content
    assert "\\bibliography{literatur}" in content
    assert created["content"] == content


def test_create_requires_title(atlas_client):
    assert atlas_client.post("/api/plugins/atlas/manuscripts", json={"title": " "}).status_code == 400


def test_duplicate_titles_get_unique_ids(atlas_client):
    a = atlas_client.post("/api/plugins/atlas/manuscripts", json={"title": "Same"}).json()
    b = atlas_client.post("/api/plugins/atlas/manuscripts", json={"title": "Same"}).json()
    assert a["id"] == "same"
    assert b["id"] == "same-2"


def test_upload_creates_manuscript_from_tex_file(atlas_client, tmp_path):
    content = "\\documentclass{article}\\begin{document}Hallo\\end{document}"
    created = atlas_client.post(
        "/api/plugins/atlas/manuscripts/upload",
        files={"file": ("Mein Antrag.tex", content.encode("utf-8"), "text/x-tex")},
    ).json()
    assert created["id"] == "mein-antrag"  # aus Dateinamen abgeleitet, slugified
    tex = tmp_path / "manuskripte" / "mein-antrag.tex"
    assert tex.exists()
    assert tex.read_text(encoding="utf-8") == content  # Inhalt verbatim
    assert created["content"] == content


def test_upload_rejects_non_tex(atlas_client):
    resp = atlas_client.post(
        "/api/plugins/atlas/manuscripts/upload",
        files={"file": ("notes.txt", b"plain", "text/plain")},
    )
    assert resp.status_code == 400


def test_upload_dedupes_against_existing(atlas_client):
    atlas_client.post("/api/plugins/atlas/manuscripts", json={"title": "Paper"})
    up = atlas_client.post(
        "/api/plugins/atlas/manuscripts/upload",
        files={"file": ("paper.tex", b"x", "text/x-tex")},
    ).json()
    assert up["id"] == "paper-2"


def test_save_and_read_roundtrip(atlas_client):
    mid = atlas_client.post("/api/plugins/atlas/manuscripts", json={"title": "Draft"}).json()["id"]
    resp = atlas_client.put(
        f"/api/plugins/atlas/manuscripts/{mid}", json={"content": "\\documentclass{article}x"}
    )
    assert resp.status_code == 200
    got = atlas_client.get(f"/api/plugins/atlas/manuscripts/{mid}").json()
    assert got["content"] == "\\documentclass{article}x"


def test_external_file_appears_in_list(atlas_client, tmp_path):
    (tmp_path / "manuskripte").mkdir(exist_ok=True)
    (tmp_path / "manuskripte" / "extern.tex").write_text("x", encoding="utf-8")
    ids = [m["id"] for m in atlas_client.get("/api/plugins/atlas/manuscripts").json()["manuscripts"]]
    assert "extern" in ids


def test_rename_moves_file(atlas_client, tmp_path):
    mid = atlas_client.post("/api/plugins/atlas/manuscripts", json={"title": "Alt"}).json()["id"]
    resp = atlas_client.post(
        f"/api/plugins/atlas/manuscripts/{mid}/rename", json={"title": "Neu Besser"}
    )
    assert resp.status_code == 200
    assert resp.json()["id"] == "neu-besser"
    assert not (tmp_path / "manuskripte" / "alt.tex").exists()
    assert (tmp_path / "manuskripte" / "neu-besser.tex").exists()


def test_delete_removes_file(atlas_client, tmp_path):
    mid = atlas_client.post("/api/plugins/atlas/manuscripts", json={"title": "Weg"}).json()["id"]
    assert atlas_client.delete(f"/api/plugins/atlas/manuscripts/{mid}").status_code == 200
    assert not (tmp_path / "manuskripte" / f"{mid}.tex").exists()
    assert atlas_client.get(f"/api/plugins/atlas/manuscripts/{mid}").status_code == 404


def test_unknown_manuscript_404(atlas_client):
    assert atlas_client.get("/api/plugins/atlas/manuscripts/nope").status_code == 404
    assert atlas_client.put("/api/plugins/atlas/manuscripts/nope", json={"content": "x"}).status_code == 404
    assert atlas_client.delete("/api/plugins/atlas/manuscripts/nope").status_code == 404


def test_path_traversal_rejected(atlas_client):
    resp = atlas_client.get("/api/plugins/atlas/manuscripts/..%2F..%2Fevil")
    assert resp.status_code in (404, 422)
