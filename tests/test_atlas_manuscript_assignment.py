"""Manuscripts reached via Publications (issue #45, ADR-0004).

Unassigned listing (directory minus all linked names) and one-click
assignment/unlinking on the Publication. API tests in the style of
test_atlas_api.py (the ``atlas_client`` host of conftest.py on a temp dir).
"""
from __future__ import annotations

import pytest



def _new_manuscript(client, title: str) -> str:
    return client.post("/api/plugins/atlas/manuscripts", json={"title": title}).json()["id"]


def _new_publication(client, title: str, **fields) -> str:
    return client.post(
        "/api/plugins/atlas/publications", json={"title": title, **fields}
    ).json()["id"]


# =============================================================================
# Unassigned listing
# =============================================================================

def test_unassigned_empty_without_manuscripts(atlas_client):
    resp = atlas_client.get("/api/plugins/atlas/manuscripts/unassigned")
    assert resp.status_code == 200
    assert resp.json() == {"manuscripts": []}


def test_unassigned_lists_only_orphans(atlas_client):
    _new_manuscript(atlas_client, "Verlinkt")
    _new_manuscript(atlas_client, "Verwaist")
    _new_publication(atlas_client, "Mit Manuskript", manuscripts=["verlinkt.tex"])

    ids = [m["id"] for m in
           atlas_client.get("/api/plugins/atlas/manuscripts/unassigned").json()["manuscripts"]]
    assert ids == ["verwaist"]


def test_unassigned_treats_links_with_and_without_tex_suffix_alike(atlas_client):
    _new_manuscript(atlas_client, "Ohne Endung")
    _new_publication(atlas_client, "P", manuscripts=["ohne-endung"])  # kein .tex
    assert atlas_client.get("/api/plugins/atlas/manuscripts/unassigned").json() == {
        "manuscripts": []
    }


def test_unassigned_ignores_hanging_links(atlas_client):
    """A hanging link does not hide an orphan with a different name."""
    _new_manuscript(atlas_client, "Echt")
    _new_publication(atlas_client, "P", manuscripts=["fehlt.tex"])
    ids = [m["id"] for m in
           atlas_client.get("/api/plugins/atlas/manuscripts/unassigned").json()["manuscripts"]]
    assert ids == ["echt"]


def test_unassigned_includes_external_tex_files(atlas_client, tmp_path):
    """External file drops are equal citizens — no DB index for manuscripts."""
    (tmp_path / "manuskripte").mkdir(exist_ok=True)
    (tmp_path / "manuskripte" / "extern.tex").write_text("x", encoding="utf-8")
    ids = [m["id"] for m in
           atlas_client.get("/api/plugins/atlas/manuscripts/unassigned").json()["manuscripts"]]
    assert "extern" in ids


# =============================================================================
# One-click assignment (POST /publications/{id}/manuscripts)
# =============================================================================

def test_assign_links_manuscript_and_persists_to_markdown(atlas_client, tmp_path):
    mid = _new_manuscript(atlas_client, "Entwurf")
    pid = _new_publication(atlas_client, "Ziel")

    resp = atlas_client.post(
        f"/api/plugins/atlas/publications/{pid}/manuscripts", json={"name": f"{mid}.tex"}
    )
    assert resp.status_code == 200
    assert resp.json()["manuscripts"] == [f"{mid}.tex"]

    # P1: the link lives in the Markdown frontmatter, not only in the index.
    md = (tmp_path / "veroeffentlichungen" / f"{pid}.md").read_text(encoding="utf-8")
    assert f"{mid}.tex" in md

    # ... and the manuscript leaves the unassigned list.
    assert atlas_client.get("/api/plugins/atlas/manuscripts/unassigned").json() == {
        "manuscripts": []
    }


def test_assign_is_idempotent(atlas_client):
    mid = _new_manuscript(atlas_client, "Einmal")
    pid = _new_publication(atlas_client, "P")
    atlas_client.post(f"/api/plugins/atlas/publications/{pid}/manuscripts", json={"name": f"{mid}.tex"})
    again = atlas_client.post(
        f"/api/plugins/atlas/publications/{pid}/manuscripts", json={"name": f"{mid}.tex"}
    )
    assert again.status_code == 200
    assert again.json()["manuscripts"] == [f"{mid}.tex"]


def test_assign_dedupes_across_tex_suffix_variants(atlas_client):
    mid = _new_manuscript(atlas_client, "Variante")
    pid = _new_publication(atlas_client, "P", manuscripts=[mid])  # ohne .tex verlinkt
    resp = atlas_client.post(
        f"/api/plugins/atlas/publications/{pid}/manuscripts", json={"name": f"{mid}.tex"}
    )
    assert resp.status_code == 200
    assert resp.json()["manuscripts"] == [mid]  # unveraendert, kein Duplikat


def test_assign_unknown_publication_404(atlas_client):
    _new_manuscript(atlas_client, "Da")
    resp = atlas_client.post(
        "/api/plugins/atlas/publications/nope/manuscripts", json={"name": "da.tex"}
    )
    assert resp.status_code == 404


def test_assign_unknown_manuscript_404_creates_no_hanging_link(atlas_client, tmp_path):
    pid = _new_publication(atlas_client, "P")
    resp = atlas_client.post(
        f"/api/plugins/atlas/publications/{pid}/manuscripts", json={"name": "geist.tex"}
    )
    assert resp.status_code == 404
    md = (tmp_path / "veroeffentlichungen" / f"{pid}.md").read_text(encoding="utf-8")
    assert "geist" not in md


def test_assign_requires_name(atlas_client):
    pid = _new_publication(atlas_client, "P")
    resp = atlas_client.post(
        f"/api/plugins/atlas/publications/{pid}/manuscripts", json={"name": "  "}
    )
    assert resp.status_code == 400


# =============================================================================
# Unlink (DELETE /publications/{id}/manuscripts/{name})
# =============================================================================

def test_unlink_removes_link_but_keeps_tex_file(atlas_client, tmp_path):
    mid = _new_manuscript(atlas_client, "Bleibt")
    pid = _new_publication(atlas_client, "P", manuscripts=[f"{mid}.tex"])

    resp = atlas_client.delete(f"/api/plugins/atlas/publications/{pid}/manuscripts/{mid}.tex")
    assert resp.status_code == 200
    assert resp.json()["manuscripts"] == []

    # The .tex file is never touched (link, not ownership) ...
    assert (tmp_path / "manuskripte" / f"{mid}.tex").exists()
    # ... the frontmatter no longer carries the link ...
    md = (tmp_path / "veroeffentlichungen" / f"{pid}.md").read_text(encoding="utf-8")
    assert f"{mid}.tex" not in md
    # ... and the manuscript is discoverable again.
    ids = [m["id"] for m in
           atlas_client.get("/api/plugins/atlas/manuscripts/unassigned").json()["manuscripts"]]
    assert ids == [mid]


def test_unlink_works_for_hanging_links(atlas_client):
    """Removing a hanging link is an explicit user action, not an auto-repair."""
    pid = _new_publication(atlas_client, "P", manuscripts=["fehlt.tex"])
    resp = atlas_client.delete(f"/api/plugins/atlas/publications/{pid}/manuscripts/fehlt.tex")
    assert resp.status_code == 200
    assert resp.json()["manuscripts"] == []


def test_unlink_unknown_link_404(atlas_client):
    pid = _new_publication(atlas_client, "P")
    assert atlas_client.delete(
        f"/api/plugins/atlas/publications/{pid}/manuscripts/nix.tex"
    ).status_code == 404
    assert atlas_client.delete(
        "/api/plugins/atlas/publications/nope/manuscripts/nix.tex"
    ).status_code == 404
