"""Veroeffentlichungen als Pipeline (#225) — "Status wechseln".

The pure rule fills ``submitted``/``published`` with today when they are
empty and never clears a date; the endpoint applies it to the Markdown file
and names what it set, so the SPA's "Rückgängig" can restore exactly that.
The publication list carries the body's checklist progress (reviewer points
in "Überarbeiten"). Today is pinned (``atlas.api_pipeline._today``).
"""

from __future__ import annotations

from datetime import date

import pytest

from atlas import api_pipeline
from atlas.domain import Publication, parse_frontmatter
from atlas.pipeline import STATUSES, status_changes

API = "/api/plugins/atlas"
TODAY = date(2026, 10, 9)


@pytest.fixture
def client(atlas_app, monkeypatch):
    monkeypatch.setattr(api_pipeline, "_today", lambda: TODAY)
    with atlas_app() as c:
        yield c


def _plain(entries: list) -> list:
    """YAML reads an ISO date as a date — compare as the strings Atlas wrote."""
    return [{k: str(v) for k, v in e.items()} for e in entries]


def _frontmatter(tmp_path, pub_id: str) -> dict:
    text = (tmp_path / "veroeffentlichungen" / f"{pub_id}.md").read_text(encoding="utf-8")
    return parse_frontmatter(text)[0]


# =============================================================================
# The pure rule
# =============================================================================

@pytest.mark.parametrize(
    "target, existing, expected",
    [
        ("submitted", {}, {"status": "submitted", "submitted": "2026-10-09"}),
        ("published", {}, {"status": "published", "published": "2026-10-09"}),
        ("submitted", {"submitted": "2026-08-01"}, {"status": "submitted"}),
        ("published", {"published": "2025-03-01"}, {"status": "published"}),
        ("in-revision", {}, {"status": "in-revision"}),
        ("drafting", {"submitted": "2026-08-01"}, {"status": "drafting"}),
        ("planned", {"published": "2025-03-01"}, {"status": "planned"}),
        ("rejected", {}, {"status": "rejected"}),
    ],
)
def test_status_changes_fills_an_empty_date_and_never_clears_one(target, existing, expected):
    pub = Publication(id="p", title="P", **existing)
    changes = status_changes(pub, target, TODAY)
    changes.pop("history", None)  # the Verlauf has its own tests below
    assert changes == expected


def test_a_status_change_lands_in_the_verlauf_with_its_venue():
    pub = Publication(id="p", title="P", status="drafting", venue="Fachkonferenz 2027",
                      history=[{"date": "2026-06-02", "status": "planned"}])
    changes = status_changes(pub, "submitted", TODAY)
    assert changes["history"] == [
        {"date": "2026-06-02", "status": "planned", "venue": None},
        {"date": "2026-10-09", "status": "submitted", "venue": "Fachkonferenz 2027"},
    ]
    assert pub.history == [{"date": "2026-06-02", "status": "planned"}]  # pure: no mutation


def test_the_same_status_writes_no_verlauf_entry():
    pub = Publication(id="p", title="P", status="drafting")
    assert "history" not in status_changes(pub, "drafting", TODAY)


def test_a_new_venue_starts_a_new_submission():
    """„Woanders einreichen": the new target, its deadline, the old
    submission date gone (it stays in the Verlauf)."""
    pub = Publication(id="p", title="P", status="rejected", venue="Konferenz A",
                      submitted="2026-09-01", due="2026-08-15")
    changes = status_changes(pub, "drafting", TODAY, venue=" Journal B ", due="2027-01-31")
    assert changes["venue"] == "Journal B"
    assert changes["submitted"] is None
    assert changes["due"] == "2027-01-31"
    assert changes["history"][-1] == {"date": "2026-10-09", "status": "drafting", "venue": "Journal B"}


def test_the_same_venue_is_no_new_target():
    pub = Publication(id="p", title="P", status="submitted", venue="Journal B", submitted="2026-09-01")
    changes = status_changes(pub, "in-revision", TODAY, venue="Journal B")
    assert "venue" not in changes and "submitted" not in changes


def test_project_status_changes_record_the_verlauf():
    from atlas.domain import Project
    from atlas.pipeline import project_status_changes

    project = Project(id="x", title="X", status="applied")
    changes = project_status_changes(project, "active", TODAY)
    assert changes == {"status": "active", "history": [{"date": "2026-10-09", "status": "active", "venue": None}]}
    assert project_status_changes(project, "applied", TODAY) == {"status": "applied"}
    with pytest.raises(ValueError):
        project_status_changes(project, "submitted", TODAY)


def test_status_changes_refuses_an_unknown_status():
    with pytest.raises(ValueError):
        status_changes(Publication(id="p", title="P"), "archived", TODAY)
    assert STATUSES[:5] == ("planned", "drafting", "submitted", "in-revision", "published")


def test_the_status_lists_are_the_schemas_in_one_place():
    """P6: the schema's enum, in its order, is the domain's list; the
    pipeline and the agenda derive from it instead of keeping copies."""
    import json
    from pathlib import Path

    from atlas import agenda, domain

    schema = json.loads(
        (Path(__file__).resolve().parents[1] / "schemas" / "atlas.publication-3.json").read_text(encoding="utf-8")
    )
    enum = schema["properties"]["status"]["enum"]
    assert tuple(enum) == STATUSES
    assert set(enum) == domain.PUBLICATION_STATUSES
    assert schema["properties"]["history"]["items"]["properties"]["status"]["enum"] == enum
    assert agenda.CLOSED_PUBLICATION_STATUSES == {"published", "rejected", "withdrawn"}
    assert agenda.CLOSED_PUBLICATION_STATUSES <= domain.PUBLICATION_STATUSES


# =============================================================================
# POST /publications/{id}/status
# =============================================================================

def test_moving_to_submitted_sets_the_date_and_says_so(client, tmp_path):
    pub = client.post(f"{API}/publications", json={"title": "Paper A", "status": "drafting"}).json()
    resp = client.post(f"{API}/publications/{pub['id']}/status", json={"status": "submitted"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["previous_status"] == "drafting"
    assert data["set"] == ["submitted"]
    assert data["publication"]["status"] == "submitted"
    assert data["publication"]["submitted"] == "2026-10-09"
    fm = _frontmatter(tmp_path, pub["id"])
    assert fm["status"] == "submitted" and str(fm["submitted"]) == "2026-10-09"


def test_an_existing_date_is_kept_and_not_reported(client, tmp_path):
    pub = client.post(f"{API}/publications", json={
        "title": "Paper B", "status": "in-revision", "submitted": "2026-06-01",
    }).json()
    data = client.post(f"{API}/publications/{pub['id']}/status", json={"status": "submitted"}).json()
    assert data["set"] == []
    assert data["publication"]["submitted"] == "2026-06-01"


def test_leaving_a_status_never_clears_its_date(client, tmp_path):
    pub = client.post(f"{API}/publications", json={"title": "Paper C", "status": "drafting"}).json()
    client.post(f"{API}/publications/{pub['id']}/status", json={"status": "published"})
    data = client.post(f"{API}/publications/{pub['id']}/status", json={"status": "drafting"}).json()
    assert data["publication"]["status"] == "drafting"
    assert data["publication"]["published"] == "2026-10-09"
    assert str(_frontmatter(tmp_path, pub["id"])["published"]) == "2026-10-09"


def test_undo_restores_the_status_and_clears_only_the_set_date(client, tmp_path):
    """What the SPA's "Rückgängig" does with the answer: the old status and
    ``null`` for every field in ``set`` through the ordinary partial update."""
    pub = client.post(f"{API}/publications", json={"title": "Paper D", "status": "drafting", "due": "2026-11-01"}).json()
    data = client.post(f"{API}/publications/{pub['id']}/status", json={"status": "submitted"}).json()
    undo = {"status": data["previous_status"], **{f: None for f in data["set"]}}
    back = client.put(f"{API}/publications/{pub['id']}", json=undo).json()
    assert back["status"] == "drafting" and back["submitted"] is None
    assert back["due"] == "2026-11-01"
    fm = _frontmatter(tmp_path, pub["id"])
    assert "submitted" not in fm and fm["status"] == "drafting"


def test_the_verlauf_is_written_and_undo_puts_the_previous_one_back(client, tmp_path):
    pub = client.post(f"{API}/publications", json={
        "title": "Paper V", "status": "drafting", "venue": "Konferenz A",
    }).json()
    data = client.post(f"{API}/publications/{pub['id']}/status", json={"status": "submitted"}).json()
    assert data["publication"]["history"] == [
        {"date": "2026-10-09", "status": "submitted", "venue": "Konferenz A"},
    ]
    fm = _frontmatter(tmp_path, pub["id"])
    assert _plain(fm["history"]) == [{"date": "2026-10-09", "status": "submitted", "venue": "Konferenz A"}]
    assert fm["schema"] == "atlas.publication/3"
    assert data["previous"] == {"status": "drafting", "submitted": None, "history": []}
    back = client.put(f"{API}/publications/{pub['id']}", json=data["previous"]).json()
    assert back["status"] == "drafting" and back["submitted"] is None and back["history"] == []
    assert "history" not in _frontmatter(tmp_path, pub["id"])


def test_rejected_then_submitted_elsewhere_in_two_calls(client, tmp_path):
    pub = client.post(f"{API}/publications", json={
        "title": "Paper W", "status": "submitted", "venue": "Konferenz A", "submitted": "2026-09-01",
    }).json()
    client.post(f"{API}/publications/{pub['id']}/status", json={"status": "rejected"})
    data = client.post(f"{API}/publications/{pub['id']}/status", json={
        "status": "drafting", "venue": "Journal B", "due": "2027-01-31",
    }).json()
    p = data["publication"]
    assert (p["status"], p["venue"], p["submitted"], p["due"]) == ("drafting", "Journal B", None, "2027-01-31")
    assert [(h["status"], h["venue"]) for h in p["history"]] == [("rejected", "Konferenz A"), ("drafting", "Journal B")]
    assert data["previous"]["venue"] == "Konferenz A" and data["previous"]["submitted"] == "2026-09-01"
    assert data["set"] == []


def test_a_project_status_change_has_its_verlauf_and_codes(client, tmp_path):
    proj = client.post(f"{API}/projects", json={"title": "DFG", "status": "applied"}).json()
    data = client.post(f"{API}/projects/{proj['id']}/status", json={"status": "active"}).json()
    assert data["project"]["status"] == "active"
    assert data["project"]["history"] == [{"date": "2026-10-09", "status": "active", "venue": None}]
    assert "timeline" in data["project"]
    assert data["previous"] == {"status": "applied", "history": []}
    text = (tmp_path / "projekte" / f"{proj['id']}.md").read_text(encoding="utf-8")
    fm = parse_frontmatter(text)[0]
    assert fm["schema"] == "atlas.project/5" and _plain(fm["history"]) == [{"date": "2026-10-09", "status": "active"}]
    back = client.put(f"{API}/projects/{proj['id']}", json=data["previous"]).json()
    assert back["status"] == "applied" and back["history"] == []
    resp = client.post(f"{API}/projects/gibt-es-nicht/status", json={"status": "active"})
    assert resp.status_code == 404 and resp.json()["detail"] == "error.atlas.project_not_found"
    resp = client.post(f"{API}/projects/{proj['id']}/status", json={"status": "published"})
    assert resp.status_code == 422 and resp.json()["detail"] == "error.atlas.status_invalid"


def test_unknown_publication_and_status_are_codes(client):
    resp = client.post(f"{API}/publications/gibt-es-nicht/status", json={"status": "submitted"})
    assert resp.status_code == 404
    assert resp.json()["detail"] == "error.atlas.publication_not_found"
    pub = client.post(f"{API}/publications", json={"title": "Paper E"}).json()
    resp = client.post(f"{API}/publications/{pub['id']}/status", json={"status": "archived"})
    assert resp.status_code == 422
    assert resp.json()["detail"] == "error.atlas.status_invalid"


def test_the_list_carries_the_checklist_progress_of_the_body(client):
    body = "## Gutachten\n\n- [x] R1: Abb. 3 erklären\n- [ ] R2: Statistik\n- [x] R2: Tippfehler\n"
    client.post(f"{API}/publications", json={"title": "Revision", "status": "in-revision", "body": body})
    client.post(f"{API}/publications", json={"title": "Ohne Liste"})
    pubs = {p["title"]: p for p in client.get(f"{API}/publications").json()["publications"]}
    assert pubs["Revision"]["checklist"] == {"done": 2, "total": 3}
    assert pubs["Ohne Liste"]["checklist"] == {"done": 0, "total": 0}
