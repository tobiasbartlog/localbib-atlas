"""Atlas domain layer tests — frontmatter, slugs, anchors, Idea, validation."""
from __future__ import annotations

from datetime import date

import pytest

from atlas.domain import (
    Idea,
    make_idea_id,
    new_idea,
    parse_frontmatter,
    section_anchors,
    serialize,
    slugify,
)


def test_parse_frontmatter_splits_yaml_and_body():
    text = "---\nid: x\ntitle: Hello\n---\n\nBody text\n"
    fm, body = parse_frontmatter(text)
    assert fm == {"id": "x", "title": "Hello"}
    assert body.strip() == "Body text"


def test_parse_frontmatter_without_frontmatter():
    fm, body = parse_frontmatter("just a body")
    assert fm == {}
    assert body == "just a body"


def test_parse_frontmatter_reads_a_file_saved_with_a_bom():
    """"UTF-8 mit BOM" puts U+FEFF in front of ``---`` (review 2026-10-18)."""
    fm, body = parse_frontmatter("\ufeff---\nid: x\ntitle: Hello\n---\n\nBody text\n")
    assert fm == {"id": "x", "title": "Hello"}
    assert body.strip() == "Body text"
    assert Idea.from_markdown("\ufeff---\nid: x\ntitle: Hello\n---\n").title == "Hello"


def test_parse_frontmatter_rejects_non_mapping():
    with pytest.raises(ValueError):
        parse_frontmatter("---\n- a\n- b\n---\n")


def test_slugify_keeps_umlauts():
    assert slugify("Materialcharakterisierung gradierter Lehmproben") == \
        "materialcharakterisierung-gradierter-lehmproben"
    assert slugify("BIM2Print – IFC!") == "bim2print-ifc"
    assert slugify("Grüße & Anker") == "grüße-anker"


def test_section_anchors_dedup_and_skip_code_fences():
    body = (
        "## Literatur\n"
        "text\n"
        "## Literatur\n"
        "```\n## not a heading\n```\n"
        "### Anker hier\n"
    )
    assert section_anchors(body) == ["literatur", "literatur-1", "anker-hier"]


def test_idea_markdown_round_trip():
    idea = Idea(
        id="2026-06-10-bim2print-slicer",
        title="BIM2Print – Slicer",
        type="paper-idea",
        status="seed",
        tags=["fgc", "bim"],
        refs=["visose2025robots"],
        created="2026-06-10",
        updated="2026-06-10",
        body="Freitext.\n\n## Literatur\n",
    )
    reparsed = Idea.from_markdown(idea.to_markdown())
    assert reparsed.to_frontmatter() == idea.to_frontmatter()
    assert reparsed.body.strip() == idea.body.strip()
    assert reparsed.anchors == ["literatur"]


def test_body_round_trip_is_stable():
    # to_markdown -> from_markdown must not drift (no leading newline creeping in).
    idea = Idea(id="x", title="T", type="paper-idea", status="seed", body="# H\n\nAbsatz")
    reparsed = Idea.from_markdown(idea.to_markdown())
    assert reparsed.body == "# H\n\nAbsatz"
    # And it stays stable on a second round-trip (content_hash would otherwise churn).
    assert Idea.from_markdown(reparsed.to_markdown()).body == "# H\n\nAbsatz"


def test_validate_clean_idea_has_no_errors():
    idea = new_idea("A fresh idea")
    assert idea.validate() == []


def test_validate_flags_missing_and_bad_enums():
    idea = Idea(id="x", title="", type="bogus", status="seed")
    errors = idea.validate()
    assert any("title" in e for e in errors)
    assert any("type" in e for e in errors)


def test_validate_flags_id_filename_mismatch():
    idea = Idea(id="some-id", title="T", type="paper-idea", status="seed")
    idea.path = "/archive/ideen/other-name.md"
    assert any("Dateiname" in e for e in idea.validate())


def test_make_idea_id_and_new_idea():
    assert make_idea_id("Hello World", today=date(2026, 6, 11)) == "2026-06-11-hello-world"
    idea = new_idea("Quick capture", today=date(2026, 6, 11))
    assert idea.id == "2026-06-11-quick-capture"
    assert idea.created == "2026-06-11"
    assert idea.title == "Quick capture"
