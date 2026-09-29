"""Atlas Verweise REST tests (issue #180, slice 5) — Naht 1.

``GET /api/plugins/atlas/backlinks/{id}`` and ``GET /api/plugins/atlas/entities`` are thin
wrappers over ``AtlasStore.backlinks``/``AtlasStore.entities`` (ADR-0020); the
edge table itself is exercised by ``test_atlas_werkbank_store.py``. Here
we check the wire shape: grouping, ``exists``, the ``q`` filter and the
plugin-disabled gate. Companion of ``test_atlas_journal_api.py`` /
``test_atlas_zettel_api.py`` (same pattern).
"""
from __future__ import annotations

import pytest


WEEK = "2026-W39"  # Mo 2026-09-21 .. So 2026-09-27
DAY = "2026-09-21"


def _create_task(client, node_id: str, text: str = "Task") -> dict:
    resp = client.post(
        f"/api/plugins/atlas/journal/{WEEK}/tasks",
        json={"day": DAY, "text": f"{text} [[{node_id}]]"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


# --- backlinks -----------------------------------------------------------------

def test_backlinks_groups_zettel_and_task_and_shows_chapter_on_the_other_side(atlas_client):
    """Chapter body -> [[zettel]] (edge chapter->zettel), Zettel body ->
    [[chapter]] (edge zettel->chapter), a Task anchored [[chapter]] (edge
    task->chapter). ``backlinks/{chapter}`` sees the incoming edges (zettel,
    task) grouped, never the chapter itself; the chapter->zettel edge is the
    other side's story, visible only under ``backlinks/{zettel}`` (as
    ``chapters``)."""
    zettel = atlas_client.post("/api/plugins/atlas/zettel", json={"title": "Zettel A"}).json()
    node = atlas_client.post(
        "/api/plugins/atlas/diss",
        json={"title": "Kapitel", "body": f"Siehe [[{zettel['id']}]]"},
    ).json()
    atlas_client.put(
        f"/api/plugins/atlas/zettel/{zettel['id']}",
        json={"body": f"Bezug [[{node['id']}]]"},
    )
    task = _create_task(atlas_client, node["id"])

    backlinks_node = atlas_client.get(f"/api/plugins/atlas/backlinks/{node['id']}").json()
    assert backlinks_node["exists"] is True
    assert [z["id"] for z in backlinks_node["zettel"]] == [zettel["id"]]
    assert backlinks_node["zettel"][0]["title"] == "Zettel A"
    assert [t["body_index"] for t in backlinks_node["tasks"]] == [task["body_index"]]
    assert backlinks_node["chapters"] == []
    assert backlinks_node["publications"] == []
    assert backlinks_node["projects"] == []
    assert backlinks_node["ideas"] == []

    backlinks_zettel = atlas_client.get(f"/api/plugins/atlas/backlinks/{zettel['id']}").json()
    assert backlinks_zettel["exists"] is True
    assert [c["id"] for c in backlinks_zettel["chapters"]] == [node["id"]]
    assert backlinks_zettel["tasks"] == []


def test_backlinks_of_unknown_id_are_empty_and_exists_false(atlas_client):
    res = atlas_client.get("/api/plugins/atlas/backlinks/gibt-es-nicht").json()
    assert res["exists"] is False
    for group in ("chapters", "publications", "projects", "ideas", "zettel", "tasks"):
        assert res[group] == []


def test_backlinks_of_a_deleted_target_still_returned_with_exists_false(atlas_client):
    """Deleting the target only drops ITS OWN outgoing edges; an inbound
    Verweis stays in the table (a warning, never repaired, ADR-0020) — the
    detail page learns it is dangling from ``exists: false``, not a 404."""
    target = atlas_client.post("/api/plugins/atlas/zettel", json={"title": "Ziel"}).json()
    source = atlas_client.post(
        "/api/plugins/atlas/zettel",
        json={"title": "Quelle", "body": f"Bezug [[{target['id']}]]"},
    ).json()

    assert atlas_client.delete(f"/api/plugins/atlas/zettel/{target['id']}").status_code == 200

    res = atlas_client.get(f"/api/plugins/atlas/backlinks/{target['id']}").json()
    assert res["exists"] is False
    assert [z["id"] for z in res["zettel"]] == [source["id"]]


# --- entities --------------------------------------------------------------------

def test_entities_lists_every_kind(atlas_client):
    idea = atlas_client.post("/api/plugins/atlas/ideas", json={"title": "Idee"}).json()
    node = atlas_client.post("/api/plugins/atlas/diss", json={"title": "Kapitel"}).json()
    project = atlas_client.post("/api/plugins/atlas/projects", json={"title": "Projekt"}).json()
    pub = atlas_client.post("/api/plugins/atlas/publications", json={"title": "Pub"}).json()
    zettel = atlas_client.post("/api/plugins/atlas/zettel", json={"title": "Zettel"}).json()

    entities = atlas_client.get("/api/plugins/atlas/entities").json()["entities"]
    by_id = {e["id"]: e for e in entities}
    assert by_id[idea["id"]]["kind"] == "idea"
    assert by_id[node["id"]]["kind"] == "diss_node"
    assert by_id[project["id"]]["kind"] == "project"
    assert by_id[pub["id"]]["kind"] == "publication"
    assert by_id[zettel["id"]]["kind"] == "zettel"
    # sorted by title
    assert [e["title"] for e in entities] == sorted(e["title"] for e in entities)


def test_entities_empty_q_returns_everything_uncapped(atlas_client):
    for i in range(3):
        atlas_client.post("/api/plugins/atlas/ideas", json={"title": f"Idee {i}"})
    entities = atlas_client.get("/api/plugins/atlas/entities").json()["entities"]
    assert len(entities) == 3


def test_entities_q_filters_case_insensitively_on_id_and_title(atlas_client):
    atlas_client.post("/api/plugins/atlas/ideas", json={"title": "Graphenbasierte Analyse"})
    atlas_client.post("/api/plugins/atlas/ideas", json={"title": "Sonstiges"})

    by_title = atlas_client.get("/api/plugins/atlas/entities", params={"q": "graphen"}).json()
    assert [e["title"] for e in by_title["entities"]] == ["Graphenbasierte Analyse"]

    by_id = atlas_client.get(
        "/api/plugins/atlas/entities", params={"q": "graphenbasierte-analyse"}
    ).json()
    assert [e["title"] for e in by_id["entities"]] == ["Graphenbasierte Analyse"]

    none = atlas_client.get("/api/plugins/atlas/entities", params={"q": "nichts-da"}).json()
    assert none["entities"] == []
