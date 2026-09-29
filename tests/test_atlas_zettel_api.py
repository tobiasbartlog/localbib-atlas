"""Atlas Zettel REST tests (issue #180, slice 4) — Naht 1.

Behaviour only: a request goes in, and what comes back plus what stands in the
Markdown file afterwards is what is checked. Companion of
``test_atlas_journal_api.py`` (same pattern) and ``test_atlas_werkbank_store.py``
(the store layer, one below this).

"Heute" is pinned (``atlas.api_zettel._today``) so derive-tasks lands on a
deterministic day, independent of which day the suite happens to run.
"""
from __future__ import annotations

from datetime import date

import pytest

from atlas import api_zettel
from atlas.weeks import week_id

TODAY = date(2026, 9, 23)  # Mittwoch
WEEK = week_id(TODAY)      # 2026-W39

BASE = "/api/plugins/atlas/zettel"


@pytest.fixture
def atlas_client(atlas_app, monkeypatch):
    monkeypatch.setattr(api_zettel, "_today", lambda: TODAY)
    with atlas_app() as c:
        yield c


def journal_text(tmp_path, week: str = WEEK) -> str:
    return (tmp_path / "journal" / f"{week}.md").read_text(encoding="utf-8")


def zettel_file(tmp_path, zettel_id: str):
    return tmp_path / "zettel" / f"{zettel_id}.md"


def create(client, title: str = "Betreuergespraech Mai", **extra) -> dict:
    resp = client.post(BASE, json={"title": title, **extra})
    assert resp.status_code == 200, resp.text
    return resp.json()


# --- create --------------------------------------------------------------

def test_create_with_only_title_writes_file_with_schema_default_type_and_today(
    atlas_client, tmp_path
):
    created = create(atlas_client)
    assert created["id"] == f"{TODAY.isoformat()}-betreuergespraech-mai"
    assert created["type"] == "fleeting"
    assert created["date"] == TODAY.isoformat()
    assert created["errors"] == []

    text = zettel_file(tmp_path, created["id"]).read_text(encoding="utf-8")
    assert "schema: atlas.zettel/1" in text
    assert "type: fleeting" in text
    assert f"date: '{TODAY.isoformat()}'" in text


def test_create_requires_a_title(atlas_client):
    resp = atlas_client.post(BASE, json={"title": "   "})
    assert resp.status_code == 400
    assert resp.json()["detail"] == "error.atlas.title_required"


def test_create_two_with_the_same_title_get_unique_ids(atlas_client):
    a = create(atlas_client, title="Gleicher Titel")
    b = create(atlas_client, title="Gleicher Titel")
    assert a["id"] != b["id"]
    assert b["id"].startswith(a["id"])


# --- list ------------------------------------------------------------------

def test_list_filters_by_type_and_searches(atlas_client):
    reading = create(atlas_client, title="Lektuere Latour", type="reading", refs=["latour2005"])
    meeting = create(atlas_client, title="Besprechung", type="meeting", tags=["methodik"])

    by_type = atlas_client.get(BASE, params={"type": "reading"}).json()["zettel"]
    assert [z["id"] for z in by_type] == [reading["id"]]

    by_q = atlas_client.get(BASE, params={"q": "methodik"}).json()["zettel"]
    assert [z["id"] for z in by_q] == [meeting["id"]]

    assert len(atlas_client.get(BASE).json()["zettel"]) == 2


# --- get ---------------------------------------------------------------------

def test_get_returns_body_anchors_and_links(atlas_client):
    created = create(
        atlas_client,
        title="Methodenfrage",
        body="## Offene Frage\n\nBetrifft [[kap-methodik]] und [[2026-09-01-anderer-zettel]].",
    )
    got = atlas_client.get(f"{BASE}/{created['id']}").json()
    assert got["body"].startswith("## Offene Frage")
    assert got["anchors"] == ["offene-frage"]
    assert got["links"] == ["kap-methodik", "2026-09-01-anderer-zettel"]
    assert got["derived_indices"] == []


def test_get_unknown_zettel_is_404_code(atlas_client):
    resp = atlas_client.get(f"{BASE}/nicht-da")
    assert resp.status_code == 404
    assert resp.json()["detail"] == "error.atlas.zettel_not_found"


# --- update --------------------------------------------------------------

def test_update_rewrites_frontmatter_and_body(atlas_client, tmp_path):
    created = create(atlas_client, title="Erstfassung", tags=["alt"])

    updated = atlas_client.put(
        f"{BASE}/{created['id']}",
        json={"title": "Ueberarbeitet", "type": "method", "tags": ["neu"], "body": "Neuer Text."},
    ).json()
    assert updated["title"] == "Ueberarbeitet"
    assert updated["type"] == "method"
    assert updated["tags"] == ["neu"]
    assert updated["body"] == "Neuer Text."

    text = zettel_file(tmp_path, created["id"]).read_text(encoding="utf-8")
    assert "title: Ueberarbeitet" in text
    assert "type: method" in text
    assert "Neuer Text." in text


def test_update_clearing_the_title_is_rejected(atlas_client):
    created = create(atlas_client)
    resp = atlas_client.put(f"{BASE}/{created['id']}", json={"title": "   "})
    assert resp.status_code == 400
    assert resp.json()["detail"] == "error.atlas.title_required"


# --- delete + dangling link ---------------------------------------------------

def test_delete_removes_file_and_leaves_a_dangling_link_warning_in_check(
    atlas_client, tmp_path
):
    zettel = create(atlas_client, title="Fluechtiger Gedanke")
    node = atlas_client.post(
        "/api/plugins/atlas/diss",
        json={"title": "Kapitel Methodik", "body": f"Siehe [[{zettel['id']}]]."},
    ).json()

    resp = atlas_client.delete(f"{BASE}/{zettel['id']}")
    assert resp.status_code == 200
    assert resp.json() == {"deleted": zettel["id"]}
    assert not zettel_file(tmp_path, zettel["id"]).exists()
    assert atlas_client.get(f"{BASE}/{zettel['id']}").status_code == 404

    report = atlas_client.get("/api/plugins/atlas/check").json()["report"]
    entry = next(e for e in report if e["id"] == node["id"])
    assert any(zettel["id"] in issue for issue in entry["issues"])


# --- derive-tasks (stories 44/45) --------------------------------------------

def test_derive_tasks_creates_tasks_and_reports_duplicates_on_second_call(
    atlas_client, tmp_path
):
    zettel = create(
        atlas_client,
        title="Betreuergespraech",
        type="meeting",
        body="## Vereinbart\n\n- [ ] Kapitel 3 ueberarbeiten\n- [ ] Literatur nachreichen\n",
    )

    first = atlas_client.post(
        f"{BASE}/{zettel['id']}/derive-tasks", json={"indices": [0, 1]}
    )
    assert first.status_code == 200
    data = first.json()
    assert data["zettel_id"] == zettel["id"]
    assert data["already"] == []
    assert [t["text"] for t in data["created"]] == [
        "Kapitel 3 ueberarbeiten", "Literatur nachreichen",
    ]
    assert all(t["anchors"] == [zettel["id"]] for t in data["created"])
    assert all(t["day"] == TODAY.isoformat() for t in data["created"])

    text = journal_text(tmp_path)
    assert f"- [ ] Kapitel 3 ueberarbeiten [[{zettel['id']}]]" in text
    assert f"- [ ] Literatur nachreichen [[{zettel['id']}]]" in text

    # the whole picture is visible on the Zettel itself (story 45)
    detail = atlas_client.get(f"{BASE}/{zettel['id']}").json()
    assert detail["derived_indices"] == [0, 1]

    # deriving again reports both as already there, creates nothing new
    second = atlas_client.post(
        f"{BASE}/{zettel['id']}/derive-tasks", json={"indices": [0, 1]}
    ).json()
    assert second["created"] == []
    assert second["already"] == [0, 1]
    assert journal_text(tmp_path).count("Kapitel 3 ueberarbeiten") == 1


def test_derive_tasks_with_empty_indices_creates_nothing(atlas_client):
    zettel = create(
        atlas_client, title="Notiz", body="- [ ] Einzelpunkt\n",
    )
    resp = atlas_client.post(f"{BASE}/{zettel['id']}/derive-tasks", json={"indices": []})
    assert resp.status_code == 200
    assert resp.json() == {"zettel_id": zettel["id"], "created": [], "already": []}


def test_derive_tasks_out_of_range_index_is_a_validation_error(atlas_client):
    zettel = create(atlas_client, title="Ohne Checkliste")
    resp = atlas_client.post(f"{BASE}/{zettel['id']}/derive-tasks", json={"indices": [0]})
    assert resp.status_code == 422
    assert resp.json()["detail"] == "error.atlas.checklist_index_invalid"


# --- promote (story 46) -------------------------------------------------------

def test_promote_creates_idea_and_sets_promoted_to(atlas_client, tmp_path):
    zettel = create(
        atlas_client, title="Fluechtige Idee", tags=["fgc"], refs=["Smith2020"],
        body="## Gedanke\n\nText.",
    )

    resp = atlas_client.post(f"{BASE}/{zettel['id']}/promote")
    assert resp.status_code == 200
    data = resp.json()

    idea = data["idea"]
    assert idea["title"] == "Fluechtige Idee"
    assert idea["tags"] == ["fgc"]
    assert idea["refs"] == ["Smith2020"]
    assert idea["body"].strip().startswith("## Gedanke")
    assert idea["status"] == "seed"
    assert idea["errors"] == []

    assert data["zettel"]["promoted_to"] == idea["id"]
    zettel_text = zettel_file(tmp_path, zettel["id"]).read_text(encoding="utf-8")
    assert f"promoted_to: {idea['id']}" in zettel_text
    assert (tmp_path / "ideen" / f"{idea['id']}.md").exists()

    # the Zettel file stays in place (P1)
    assert zettel_file(tmp_path, zettel["id"]).exists()
    assert atlas_client.get("/api/plugins/atlas/ideas").json()["ideas"][0]["id"] == idea["id"]


def test_promoting_an_already_promoted_zettel_is_a_conflict(atlas_client):
    zettel = create(atlas_client, title="Einmal genuegt")
    first = atlas_client.post(f"{BASE}/{zettel['id']}/promote")
    assert first.status_code == 200

    second = atlas_client.post(f"{BASE}/{zettel['id']}/promote")
    assert second.status_code == 409
    assert second.json()["detail"] == "error.atlas.already_promoted"


def test_promote_unknown_zettel_is_404(atlas_client):
    assert atlas_client.post(f"{BASE}/nicht-da/promote").status_code == 404


# --- cite-key lookup (story 38) ----------------------------------------------

def test_links_for_citekey_lists_the_zettel(atlas_client):
    hit = create(atlas_client, title="Lektuere", type="reading", refs=["doe2024"])
    create(atlas_client, title="Anderes", type="fleeting")

    res = atlas_client.get("/api/plugins/atlas/links/doe2024").json()
    assert res["ideas"] == []
    assert res["publications"] == []
    assert res["projects"] == []
    assert [z["id"] for z in res["zettel"]] == [hit["id"]]
