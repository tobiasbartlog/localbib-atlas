"""Pure-logic tests for atlas/matching.py (F1/F2, Abschn. 8) — no I/O, no LLM."""
from __future__ import annotations

import json

import pytest

from atlas import matching


PAPER = {
    "citekey": "Doe2024",
    "title": "Adaptive Slicing for Concrete Printing",
    "authors": "Doe, John",
    "year": 2024,
    "abstract": "We present adaptive slicing strategies for 3D concrete printing.",
}

IDEA = {
    "id": "2026-01-01-bim2print",
    "title": "BIM2Print Slicer",
    "type": "tool-idea",
    "tags": ["3d-druck"],
    "body": "## Motivation\n\nSlicing direkt aus BIM.\n\n## Stand der Technik\n\nOffen.",
    "anchors": ["motivation", "stand-der-technik"],
}


# --- prompts -----------------------------------------------------------------

def test_pair_messages_contain_paper_idea_and_anchors():
    messages = matching.build_pair_messages(PAPER, IDEA)
    assert messages[0]["role"] == "system"
    user = messages[1]["content"]
    assert "Adaptive Slicing" in user
    assert "BIM2Print Slicer" in user
    assert "motivation, stand-der-technik" in user
    assert "atlas.match-result/1" in user


def test_pair_messages_without_anchors_offer_null():
    idea = {**IDEA, "anchors": [], "body": "Nur Text, keine Abschnitte."}
    user = matching.build_pair_messages(PAPER, idea)[1]["content"]
    assert "keine Abschnitte" in user


def test_pair_messages_include_fulltext_when_given():
    user = matching.build_pair_messages(PAPER, IDEA, fulltext="VOLLTEXT XYZ")[1]["content"]
    assert "VOLLTEXT XYZ" in user


def test_batch_messages_list_each_candidate_with_id():
    other = {**IDEA, "id": "idee-zwei", "title": "Zweite Idee", "anchors": []}
    user = matching.build_batch_messages(PAPER, [IDEA, other])[1]["content"]
    assert "[IDEE id=2026-01-01-bim2print]" in user
    assert "[IDEE id=idee-zwei]" in user


# --- parsing F1 ----------------------------------------------------------------

def test_parse_match_result_valid():
    content = json.dumps(
        {
            "verdict": "relevant",
            "reasoning": "Passt zur Motivation.",
            "usages": [{"anchor": "motivation", "suggestion": "Als Beleg nutzen."}],
        }
    )
    result = matching.parse_match_result(content, IDEA["anchors"])
    assert result["verdict"] == "relevant"
    assert result["usages"][0]["anchor_valid"] is True


def test_parse_match_result_flags_orphan_anchor_but_keeps_it():
    content = json.dumps(
        {
            "verdict": "maybe",
            "reasoning": "x",
            "usages": [{"anchor": "geloeschter-abschnitt", "suggestion": "y"}],
        }
    )
    result = matching.parse_match_result(content, IDEA["anchors"])
    assert result["usages"][0]["anchor"] == "geloeschter-abschnitt"
    assert result["usages"][0]["anchor_valid"] is False


def test_parse_match_result_null_anchor_is_valid():
    content = json.dumps(
        {"verdict": "maybe", "reasoning": "x", "usages": [{"anchor": None, "suggestion": "y"}]}
    )
    result = matching.parse_match_result(content, [])
    assert result["usages"][0]["anchor_valid"] is True


def test_parse_match_result_strips_hash_prefix_from_anchor():
    content = json.dumps(
        {"verdict": "relevant", "reasoning": "x", "usages": [{"anchor": "#motivation", "suggestion": "y"}]}
    )
    result = matching.parse_match_result(content, IDEA["anchors"])
    assert result["usages"][0]["anchor"] == "motivation"
    assert result["usages"][0]["anchor_valid"] is True


@pytest.mark.parametrize("bad", ["kein json", "[1,2]", '{"verdict": "super"}'])
def test_parse_match_result_rejects_garbage(bad):
    with pytest.raises(ValueError):
        matching.parse_match_result(bad, [])


def test_parse_match_result_drops_usages_without_suggestion():
    content = json.dumps(
        {"verdict": "relevant", "reasoning": "x", "usages": [{"anchor": "motivation", "suggestion": "  "}]}
    )
    assert matching.parse_match_result(content, IDEA["anchors"])["usages"] == []


# --- parsing F2 ----------------------------------------------------------------

def test_parse_batch_result_validates_per_idea_anchors():
    content = json.dumps(
        [
            {
                "idea": "a",
                "verdict": "relevant",
                "reasoning": "r",
                "usages": [{"anchor": "nur-in-a", "suggestion": "s"}],
            },
            {
                "idea": "b",
                "verdict": "maybe",
                "reasoning": "r",
                "usages": [{"anchor": "nur-in-a", "suggestion": "s"}],
            },
        ]
    )
    results = matching.parse_batch_result(content, {"a": ["nur-in-a"], "b": []})
    assert results[0]["usages"][0]["anchor_valid"] is True
    assert results[1]["usages"][0]["anchor_valid"] is False


def test_parse_batch_result_drops_unknown_ids_and_bad_entries():
    content = json.dumps(
        [
            {"idea": "unbekannt", "verdict": "relevant", "reasoning": "r"},
            {"idea": "a", "verdict": "quatsch", "reasoning": "r"},
            {"idea": "a", "verdict": "irrelevant", "reasoning": "ok"},
        ]
    )
    results = matching.parse_batch_result(content, {"a": []})
    assert len(results) == 1
    assert results[0]["verdict"] == "irrelevant"


def test_parse_batch_result_tolerates_results_wrapper():
    content = json.dumps({"results": [{"idea": "a", "verdict": "maybe", "reasoning": "r"}]})
    assert len(matching.parse_batch_result(content, {"a": []})) == 1


def test_parse_batch_result_rejects_non_list():
    with pytest.raises(ValueError):
        matching.parse_batch_result('{"verdict": "relevant"}', {"a": []})


# --- ranking -------------------------------------------------------------------

def test_lexical_rank_prefers_overlapping_idea():
    ideas = [
        {"id": "match", "title": "Concrete Printing Slicing", "body": "", "tags": []},
        {"id": "other", "title": "Vogelkunde im Winter", "body": "", "tags": []},
    ]
    ranked = matching.lexical_rank(matching.paper_text(PAPER), ideas)
    assert ranked[0][0] == "match"
    assert ranked[0][1] > ranked[1][1]


def test_lexical_rank_returns_all_ideas_even_without_overlap():
    ideas = [{"id": "x", "title": "Aquaristik", "body": "", "tags": []}]
    ranked = matching.lexical_rank("vollkommen anderes thema", ideas)
    assert [r[0] for r in ranked] == ["x"]


def test_embedding_rank_orders_by_cosine():
    ranked = matching.embedding_rank([1.0, 0.0], {"a": [1.0, 0.0], "b": [0.0, 1.0]})
    assert [r[0] for r in ranked] == ["a", "b"]
    assert ranked[0][1] == pytest.approx(1.0)


def test_cosine_handles_dimension_mismatch_and_zero():
    assert matching.cosine([1.0], [1.0, 0.0]) == 0.0
    assert matching.cosine([0.0, 0.0], [1.0, 0.0]) == 0.0


# --- accept write path helpers --------------------------------------------------

def test_format_literature_block_with_usages():
    block = matching.format_literature_block(
        "Doe2024",
        "Stuetzt die Motivation.",
        [{"anchor": "motivation", "suggestion": "Als Beleg."}, {"anchor": None, "suggestion": "Allgemein."}],
    )
    assert block.splitlines()[0] == "- **@Doe2024** — Stuetzt die Motivation."
    assert "  - [#motivation] Als Beleg." in block
    assert "  - Allgemein." in block


def test_insert_literature_block_creates_section():
    body = "## Motivation\n\nText."
    out = matching.insert_literature_block(body, "- **@Doe2024**")
    assert out.index("## Literatur") > out.index("## Motivation")
    assert out.rstrip().endswith("- **@Doe2024**")


def test_insert_literature_block_appends_to_existing_section_before_next_heading():
    body = "## Literatur\n\n- **@Alt2020** — alt\n\n## Notizen\n\nText."
    out = matching.insert_literature_block(body, "- **@Doe2024** — neu")
    lit = out.index("- **@Doe2024**")
    assert out.index("- **@Alt2020**") < lit < out.index("## Notizen")


def test_insert_literature_block_ignores_heading_inside_fence():
    body = "```\n## Literatur\n```\n\nText."
    out = matching.insert_literature_block(body, "- **@Doe2024**")
    # the fenced pseudo-heading is not a section: a real one gets appended
    assert out.count("## Literatur") == 2
    assert out.rstrip().endswith("- **@Doe2024**")


def test_insert_into_empty_body():
    out = matching.insert_literature_block("", "- **@Doe2024**")
    assert out == "## Literatur\n\n- **@Doe2024**\n"


# --- F3: chapter match (pure-function tests) -----------------------------------

CHAPTER_WITH_BODY = {
    "id": "kapitel-1",
    "title": "Einleitung",
    "body": "Dieses Kapitel beschreibt die Motivation und den Kontext der Dissertation.",
}

CHAPTER_NO_BODY = {
    "id": "kapitel-2",
    "title": "Stand der Technik",
    "body": "",
}

CHAPTER_WHITESPACE_BODY = {
    "id": "kapitel-3",
    "title": "Methodik",
    "body": "   \n  ",
}

CHAPTER_WITH_BODY_2 = {
    "id": "kapitel-4",
    "title": "Ergebnisse",
    "body": "Die Ergebnisse zeigen eine Verbesserung der Druckqualitaet.",
}


def test_chapter_match_messages_contain_paper_and_eligible_chapters():
    msgs = matching.build_chapter_match_messages(PAPER, [CHAPTER_WITH_BODY, CHAPTER_WITH_BODY_2])
    assert msgs[0]["role"] == "system"
    user = msgs[1]["content"]
    assert "Adaptive Slicing" in user  # paper title
    assert "kapitel-1" in user
    assert "kapitel-4" in user
    assert "Einleitung" in user
    assert "Ergebnisse" in user


def test_chapter_match_messages_exclude_empty_body_chapters():
    """AC: chapters without body text must NOT appear in the prompt (not hallucinated)."""
    msgs = matching.build_chapter_match_messages(
        PAPER, [CHAPTER_WITH_BODY, CHAPTER_NO_BODY, CHAPTER_WHITESPACE_BODY]
    )
    user = msgs[1]["content"]
    # Only kapitel-1 has a body — kapitel-2 and kapitel-3 must be absent.
    assert "kapitel-1" in user
    assert "kapitel-2" not in user
    assert "kapitel-3" not in user


def test_chapter_match_messages_all_empty_bodies_yields_placeholder():
    """When no chapter has body text the prompt states this explicitly."""
    msgs = matching.build_chapter_match_messages(PAPER, [CHAPTER_NO_BODY, CHAPTER_WHITESPACE_BODY])
    user = msgs[1]["content"]
    assert "keine Kapitel mit Inhalt" in user


def test_chapter_match_messages_empty_chapter_list():
    msgs = matching.build_chapter_match_messages(PAPER, [])
    assert len(msgs) == 2
    assert "keine Kapitel mit Inhalt" in msgs[1]["content"]


def test_parse_chapter_match_result_valid():
    content = json.dumps([
        {"chapter_id": "kapitel-1", "rank": 1, "reason": "Passt gut."},
        {"chapter_id": "kapitel-4", "rank": 2, "reason": "Eher am Rande."},
    ])
    results = matching.parse_chapter_match_result(content)
    assert len(results) == 2
    assert results[0] == {"chapter_id": "kapitel-1", "rank": 1, "reason": "Passt gut."}
    assert results[1]["rank"] == 2


def test_parse_chapter_match_result_tolerates_results_wrapper():
    content = json.dumps({"results": [{"chapter_id": "k1", "rank": 1, "reason": "r"}]})
    results = matching.parse_chapter_match_result(content)
    assert len(results) == 1
    assert results[0]["chapter_id"] == "k1"


def test_parse_chapter_match_result_drops_entries_without_chapter_id():
    content = json.dumps([
        {"chapter_id": "", "rank": 1, "reason": "kein id"},
        {"chapter_id": "kapitel-1", "rank": 2, "reason": "ok"},
    ])
    results = matching.parse_chapter_match_result(content)
    assert len(results) == 1
    assert results[0]["chapter_id"] == "kapitel-1"


@pytest.mark.parametrize("bad", ["kein json", '{"chapter_id": "k1"}', "null"])
def test_parse_chapter_match_result_rejects_garbage(bad):
    with pytest.raises(ValueError):
        matching.parse_chapter_match_result(bad)
