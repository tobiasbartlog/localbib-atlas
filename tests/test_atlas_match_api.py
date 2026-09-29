"""Atlas matching REST tests (Phase 4) — the LLM is the contract's ``DummyLlm``
(patched per test), the library an ``InMemoryLibrary`` with one Item.
"""
from __future__ import annotations

import json
import sqlite3
from unittest.mock import patch

import pytest
from plugin_api.testing import InMemoryLibrary

DOE = {"citekey": "Doe2024", "title": "Test Paper Title", "authors": "Doe, John",
       "year": 2024, "doi": "10.1000/test"}


PAIR_ANSWER = json.dumps(
    {
        "verdict": "relevant",
        "reasoning": "Passt zur Motivation.",
        "usages": [{"anchor": "motivation", "suggestion": "Als Beleg nutzen."}],
    }
)


@pytest.fixture
def atlas_client(atlas_app):
    with atlas_app(library=InMemoryLibrary([DOE])) as c:
        yield c


def _create_idea(client, title="BIM2Print Slicer"):
    return client.post(
        "/api/plugins/atlas/ideas",
        json={"title": title, "body": "## Motivation\n\nSlicing aus BIM.\n\n## Offen\n\n..."},
    ).json()


# --- F1: /match/pair ----------------------------------------------------------

def test_match_pair_returns_validated_proposal(atlas_client):
    idea = _create_idea(atlas_client)
    with patch.object(atlas_client.app.state.atlas_api.llm, "complete", return_value={"content": PAIR_ANSWER}) as mock:
        resp = atlas_client.post(
            "/api/plugins/atlas/match/pair", json={"citekey": "Doe2024", "idea_id": idea["id"]}
        )
    assert resp.status_code == 200
    result = resp.json()
    assert result["verdict"] == "relevant"
    assert result["citekey"] == "Doe2024"
    assert result["idea"] == idea["id"]
    assert result["usages"][0]["anchor_valid"] is True
    # prompt was built from library metadata + idea markdown
    sent = mock.call_args[0][0]["messages"][1]["content"]
    assert "Test Paper Title" in sent
    assert "BIM2Print Slicer" in sent


def test_match_pair_unknown_citekey_404(atlas_client):
    idea = _create_idea(atlas_client)
    resp = atlas_client.post(
        "/api/plugins/atlas/match/pair", json={"citekey": "Nope9999", "idea_id": idea["id"]}
    )
    assert resp.status_code == 404


def test_match_pair_unknown_idea_404(atlas_client):
    resp = atlas_client.post(
        "/api/plugins/atlas/match/pair", json={"citekey": "Doe2024", "idea_id": "fehlt"}
    )
    assert resp.status_code == 404


def test_match_pair_unusable_llm_answer_502(atlas_client):
    idea = _create_idea(atlas_client)
    with patch.object(atlas_client.app.state.atlas_api.llm, "complete", return_value={"content": "kein json"}):
        resp = atlas_client.post(
            "/api/plugins/atlas/match/pair", json={"citekey": "Doe2024", "idea_id": idea["id"]}
        )
    assert resp.status_code == 502


def test_match_pair_llm_error_502(atlas_client):
    idea = _create_idea(atlas_client)
    with patch.object(atlas_client.app.state.atlas_api.llm, "complete", side_effect=RuntimeError("down")):
        resp = atlas_client.post(
            "/api/plugins/atlas/match/pair", json={"citekey": "Doe2024", "idea_id": idea["id"]}
        )
    assert resp.status_code == 502


def test_match_unavailable_without_llm_service_503(atlas_app):
    with atlas_app(library=InMemoryLibrary([DOE]), llm=False) as c:
        idea = _create_idea(c)
        resp = c.post(
            "/api/plugins/atlas/match/pair", json={"citekey": "Doe2024", "idea_id": idea["id"]}
        )
    assert resp.status_code == 503


# --- F2: /match/paper ----------------------------------------------------------

def _batch_answer(idea_id):
    return json.dumps(
        [
            {
                "idea": idea_id,
                "verdict": "maybe",
                "reasoning": "Beruehrt das Thema.",
                "usages": [],
            }
        ]
    )


def test_match_paper_falls_back_to_lexical_ranking(atlas_client):
    idea = _create_idea(atlas_client)  # DummyLlm without embeddings -> embed raises
    with patch.object(
        atlas_client.app.state.atlas_api.llm, "complete", return_value={"content": _batch_answer(idea["id"])}
    ):
        resp = atlas_client.post("/api/plugins/atlas/match/paper", json={"citekey": "Doe2024"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["ranking"] == "lexikalisch"
    assert data["results"][0]["idea"] == idea["id"]
    assert data["results"][0]["title"] == "BIM2Print Slicer"
    assert data["results"][0]["citekey"] == "Doe2024"


def test_match_paper_uses_embeddings_and_caches_by_hash(atlas_client, tmp_path):
    idea = _create_idea(atlas_client)
    embed_calls = []

    def fake_embed(texts):
        embed_calls.append(list(texts))
        return [[1.0, 0.5] for _ in texts]

    with patch.object(atlas_client.app.state.atlas_api.llm, "embed", fake_embed), patch.object(
        atlas_client.app.state.atlas_api.llm, "complete", return_value={"content": _batch_answer(idea["id"])}
    ):
        first = atlas_client.post("/api/plugins/atlas/match/paper", json={"citekey": "Doe2024"})
        second = atlas_client.post("/api/plugins/atlas/match/paper", json={"citekey": "Doe2024"})
    assert first.json()["ranking"] == "embedding"
    assert second.status_code == 200
    # 1st call: query + missing idea; 2nd call: query only (idea vector cached)
    assert len(embed_calls) == 3
    with sqlite3.connect(tmp_path / ".atlas" / "atlas.db") as conn:
        rows = conn.execute("SELECT idea_id FROM idea_embeddings").fetchall()
    assert rows == [(idea["id"],)]


def test_match_paper_without_ideas_returns_empty(atlas_client):
    resp = atlas_client.post("/api/plugins/atlas/match/paper", json={"citekey": "Doe2024"})
    assert resp.status_code == 200
    assert resp.json() == {"results": [], "ranking": None}


# --- accept write path (P4) ------------------------------------------------------

def test_accept_match_writes_literatur_block_and_ref(atlas_client, tmp_path):
    idea = _create_idea(atlas_client)
    resp = atlas_client.post(
        f"/api/plugins/atlas/ideas/{idea['id']}/accept-match",
        json={
            "citekey": "Doe2024",
            "reasoning": "Stuetzt die Motivation.",
            "usages": [{"anchor": "motivation", "suggestion": "Als Beleg."}],
        },
    )
    assert resp.status_code == 200
    updated = resp.json()
    assert "Doe2024" in updated["refs"]
    assert "## Literatur" in updated["body"]
    assert "- **@Doe2024** — Stuetzt die Motivation." in updated["body"]
    # P1: the markdown file is the source of truth — block must be on disk
    md = (tmp_path / "ideen" / f"{idea['id']}.md").read_text(encoding="utf-8")
    assert "- **@Doe2024**" in md
    assert "refs:" in md


def test_accept_match_is_idempotent_on_refs(atlas_client):
    idea = _create_idea(atlas_client)
    for _ in range(2):
        resp = atlas_client.post(
            f"/api/plugins/atlas/ideas/{idea['id']}/accept-match",
            json={"citekey": "Doe2024", "reasoning": "x", "usages": []},
        )
    assert resp.json()["refs"].count("Doe2024") == 1


def test_accept_match_requires_citekey(atlas_client):
    idea = _create_idea(atlas_client)
    resp = atlas_client.post(
        f"/api/plugins/atlas/ideas/{idea['id']}/accept-match",
        json={"citekey": "  ", "usages": []},
    )
    assert resp.status_code == 400


def test_accept_match_unknown_idea_404(atlas_client):
    resp = atlas_client.post(
        "/api/plugins/atlas/ideas/fehlt/accept-match", json={"citekey": "Doe2024", "usages": []}
    )
    assert resp.status_code == 404


# --- F3: /diss/match -----------------------------------------------------------

def _create_chapter(client, title="Einleitung", body="Motivation und Kontext.", order=0):
    return client.post(
        "/api/plugins/atlas/diss",
        json={"title": title, "body": body, "order": order},
    ).json()


_CHAPTER_RANK_ANSWER = json.dumps([
    {"chapter_id": "einleitung", "rank": 1, "reason": "Passt gut zur Einleitung."},
])


def test_diss_match_returns_ranked_chapters(atlas_client):
    chapter = _create_chapter(atlas_client, title="Einleitung", body="Motivation und Kontext.")
    with patch.object(
        atlas_client.app.state.atlas_api.llm, "complete", return_value={"content": _CHAPTER_RANK_ANSWER}
    ) as mock:
        resp = atlas_client.post("/api/plugins/atlas/diss/match", json={"citekey": "Doe2024"})
    assert resp.status_code == 200
    data = resp.json()
    assert "results" in data
    assert "excluded" in data
    assert data["results"][0]["chapter_id"] == chapter["id"]
    assert data["results"][0]["rank"] == 1
    assert data["results"][0]["title"] == "Einleitung"
    assert "reason" in data["results"][0]
    # The prompt was built from library paper metadata + chapter body
    sent = mock.call_args[0][0]["messages"][1]["content"]
    assert "Test Paper Title" in sent
    assert "Einleitung" in sent


def test_diss_match_excludes_chapters_without_body(atlas_client):
    """AC: chapters with empty body must be excluded (not hallucinated)."""
    chapter_with = _create_chapter(atlas_client, title="Einleitung", body="Hat Inhalt.", order=0)
    chapter_empty = _create_chapter(atlas_client, title="Anhang", body="", order=1)
    rank_answer = json.dumps([
        {"chapter_id": chapter_with["id"], "rank": 1, "reason": "Passt."},
    ])
    with patch.object(atlas_client.app.state.atlas_api.llm, "complete", return_value={"content": rank_answer}) as mock:
        resp = atlas_client.post("/api/plugins/atlas/diss/match", json={"citekey": "Doe2024"})
    assert resp.status_code == 200
    data = resp.json()
    # Excluded chapters are reported in the response
    excluded_ids = [e["chapter_id"] for e in data["excluded"]]
    assert chapter_empty["id"] in excluded_ids
    # The empty-body chapter must NOT appear in the LLM prompt
    sent = mock.call_args[0][0]["messages"][1]["content"]
    assert chapter_empty["id"] not in sent
    assert chapter_with["id"] in sent


def test_diss_match_no_chapters_returns_empty(atlas_client):
    resp = atlas_client.post("/api/plugins/atlas/diss/match", json={"citekey": "Doe2024"})
    assert resp.status_code == 200
    assert resp.json() == {"results": [], "excluded": []}


def test_diss_match_all_chapters_empty_body_returns_empty(atlas_client):
    _create_chapter(atlas_client, title="Kapitel", body="", order=0)
    resp = atlas_client.post("/api/plugins/atlas/diss/match", json={"citekey": "Doe2024"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["results"] == []
    assert len(data["excluded"]) == 1


def test_diss_match_unknown_citekey_404(atlas_client):
    _create_chapter(atlas_client)
    resp = atlas_client.post("/api/plugins/atlas/diss/match", json={"citekey": "Nope9999"})
    assert resp.status_code == 404


def test_diss_match_unusable_llm_answer_502(atlas_client):
    _create_chapter(atlas_client)
    with patch.object(atlas_client.app.state.atlas_api.llm, "complete", return_value={"content": "kein json"}):
        resp = atlas_client.post("/api/plugins/atlas/diss/match", json={"citekey": "Doe2024"})
    assert resp.status_code == 502


def test_diss_match_unavailable_without_llm_503(atlas_app):
    with atlas_app(library=InMemoryLibrary([DOE]), llm=False) as c:
        _create_chapter(c)
        resp = c.post("/api/plugins/atlas/diss/match", json={"citekey": "Doe2024"})
    assert resp.status_code == 503
