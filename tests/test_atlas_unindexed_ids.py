"""A new entity never overwrites an unindexed ``<id>.md`` (review 2026-10-18).

The reindex skips a file it cannot read (a hand edit with broken YAML), so
that file is on disk but not in the index. Every path that picks an id for a
NEW entity — create, import, promote, the Rueckblick-Zettel — must count it as
taken: ``<id>.md`` on disk is never overwritten, indexed or not (P1). The
planted files here are exactly that case: malformed, written before Atlas
starts, so neither the reindex nor the watcher ever indexes them.
"""
from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest

from atlas import api_journal, api_zettel
from atlas import config as atlas_config
from atlas import config, entity_store
from atlas.domain import Idea, make_idea_id
from atlas.index_links import KIND_DISS_NODE, KIND_IDEA, KIND_PROJECT, KIND_ZETTEL
from atlas.store import AtlasStore
from atlas.zettel import make_zettel_id

API = "/api/plugins/atlas"
TODAY = date(2026, 9, 23)  # Mittwoch, KW 39
BAD = "---\ntitle: Von Hand: nicht ueberschreiben\n---\n\nMeine Notizen.\n"


@pytest.fixture(autouse=True)
def pinned(monkeypatch):
    monkeypatch.setattr(api_zettel, "_today", lambda: TODAY)
    monkeypatch.setattr(api_journal, "_today", lambda: TODAY)


def _plant(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(BAD, encoding="utf-8")
    return path


# --- the shared rule -----------------------------------------------------------

def test_free_id_counts_the_index_and_the_folder(tmp_path):
    assert entity_store.free_id("idee", lambda i: False, tmp_path) == "idee"
    assert entity_store.free_id("idee", lambda i: i == "idee", tmp_path) == "idee-2"
    _plant(tmp_path / "idee.md")
    assert entity_store.free_id("idee", lambda i: False, tmp_path) == "idee-2"
    assert entity_store.free_id("idee", lambda i: i == "idee-2", tmp_path) == "idee-3"


def test_store_free_id_skips_an_unindexed_file_of_every_kind(tmp_path, monkeypatch):
    monkeypatch.setattr(atlas_config, "_base_dir", str(tmp_path))
    config.ensure_dirs()
    store = AtlasStore()
    store.index_file(store.save_idea_file(Idea(id="gut", title="Gut")))
    assert store.free_id(KIND_IDEA, "gut") == "gut-2"
    for kind, folder in ((KIND_IDEA, config.ideas_dir), (KIND_DISS_NODE, config.diss_dir),
                         (KIND_PROJECT, config.projects_dir), (KIND_ZETTEL, config.zettel_dir)):
        _plant(folder() / "von-hand.md")
        assert store.free_id(kind, "von-hand") == "von-hand-2", kind


# --- every path that creates an entity -------------------------------------------

# (folder, planted id, request) — the request would pick the planted id.
CREATE_PATHS = {
    "idea": ("ideen", make_idea_id("Kalibrierung"), ("/ideas", {"title": "Kalibrierung"})),
    "import": ("ideen", "von-hand", ("/import", {"content": "---\ntitle: Neu\n---\n",
                                                 "filename": "von-hand.md"})),
    "chapter": ("dissertation", "methodik", ("/diss", {"title": "Methodik"})),
    "zettel": ("zettel", make_zettel_id("Gespraech", today=TODAY), ("/zettel", {"title": "Gespraech"})),
    "review-zettel": ("zettel", make_zettel_id("Rückblick KW 39", today=TODAY),
                      ("/journal/2026-W39/review/zettel", None)),
    "publication": ("veroeffentlichungen", "beitrag", ("/publications", {"title": "Beitrag"})),
    "project": ("projekte", "vorhaben", ("/projects", {"title": "Vorhaben"})),
}


@pytest.mark.parametrize("path", sorted(CREATE_PATHS))
def test_creating_never_overwrites_an_unindexed_file(atlas_app, tmp_path, path):
    folder, planted_id, (url, payload) = CREATE_PATHS[path]
    planted = _plant(tmp_path / folder / f"{planted_id}.md")

    with atlas_app(tmp_path) as client:
        resp = client.post(f"{API}{url}", json=payload)

    assert resp.status_code == 200, resp.text
    assert resp.json()["id"] == f"{planted_id}-2"
    assert planted.read_text(encoding="utf-8") == BAD
    assert (tmp_path / folder / f"{planted_id}-2.md").exists()


def test_free_id_keeps_a_new_id_inside_its_folder(tmp_path):
    """An id is a file name in the entity folder, nothing else (P2): one that
    would land elsewhere becomes its slug, or ``eintrag``."""
    folder = tmp_path / "ideen"
    # Backslash and drive only mean something on Windows — wherever it runs,
    # the file lands directly in the folder.
    for base in ("../../escaped", "..\\..\\escaped", "unter/ordner", "/escaped", "D:escaped"):
        target = folder / f"{entity_store.free_id(base, lambda i: False, folder)}.md"
        assert target.parent == folder and target.name.endswith(".md"), base
    assert entity_store.free_id("../../escaped", lambda i: False, folder) == "escaped"
    assert entity_store.free_id("/escaped", lambda i: False, folder) == "escaped"
    assert entity_store.free_id("unter/ordner", lambda i: False, folder) == "unterordner"
    assert entity_store.free_id("../..", lambda i: False, folder) == "eintrag"
    assert entity_store.free_id("", lambda i: False, folder) == "eintrag"
    # A hand-named id that stays in the folder keeps its name (type switch).
    assert entity_store.free_id("Mein Projekt", lambda i: False, folder) == "Mein Projekt"


# (request, the entity's folder) — each would name an id outside the Atlas folder.
ESCAPES = {
    "import": ("/import", {"content": "---\nid: ../../escaped\ntitle: Neu\n---\n"}, "ideen"),
    "chapter": ("/diss", {"title": "Kapitel", "id": "../../escaped"}, "dissertation"),
    "project": ("/projects", {"title": "Vorhaben", "id": "../../escaped"}, "projekte"),
    "publication": ("/publications", {"title": "Beitrag", "id": "../../escaped"}, "veroeffentlichungen"),
}


@pytest.mark.parametrize("path", sorted(ESCAPES))
def test_no_create_path_writes_outside_the_atlas_folder(atlas_app, tmp_path, path):
    url, payload, folder = ESCAPES[path]
    base = tmp_path / "aussen" / "atlas"

    with atlas_app(base) as client:
        resp = client.post(f"{API}{url}", json=payload)

    assert resp.status_code == 200, resp.text
    assert resp.json()["id"] == "escaped"
    assert (base / folder / "escaped.md").exists()
    assert [p for p in (tmp_path / "aussen").rglob("*.md") if not p.is_relative_to(base)] == []


def test_promoting_an_idea_never_overwrites_an_unindexed_publication(atlas_app, tmp_path):
    planted = _plant(tmp_path / "veroeffentlichungen" / "kalibrierung.md")
    with atlas_app(tmp_path) as client:
        idea = client.post(f"{API}/ideas", json={"title": "Kalibrierung"}).json()
        resp = client.post(f"{API}/ideas/{idea['id']}/promote")
    assert resp.status_code == 200, resp.text
    assert resp.json()["publication"]["id"] == "kalibrierung-2"
    assert planted.read_text(encoding="utf-8") == BAD


def test_promoting_a_zettel_never_overwrites_an_unindexed_idea(atlas_app, tmp_path):
    idea_id = make_idea_id("Gespraech", today=TODAY)
    planted = _plant(tmp_path / "ideen" / f"{idea_id}.md")
    with atlas_app(tmp_path) as client:
        zettel = client.post(f"{API}/zettel", json={"title": "Gespraech"}).json()
        resp = client.post(f"{API}/zettel/{zettel['id']}/promote")
    assert resp.status_code == 200, resp.text
    assert resp.json()["idea"]["id"] == f"{idea_id}-2"
    assert resp.json()["zettel"]["promoted_to"] == f"{idea_id}-2"
    assert planted.read_text(encoding="utf-8") == BAD
