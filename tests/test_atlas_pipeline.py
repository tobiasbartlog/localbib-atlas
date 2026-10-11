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
    assert status_changes(pub, target, TODAY) == expected


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
        (Path(__file__).resolve().parents[1] / "schemas" / "atlas.publication-2.json").read_text(encoding="utf-8")
    )
    enum = schema["properties"]["status"]["enum"]
    assert tuple(enum) == STATUSES
    assert set(enum) == domain.PUBLICATION_STATUSES
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
