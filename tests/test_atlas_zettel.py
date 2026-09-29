"""Atlas Zettel entity tests (issue #180, slice 1) — round-trip, id, validation."""
from __future__ import annotations

from datetime import date

from atlas.zettel import (
    ZETTEL_SCHEMA,
    Zettel,
    make_zettel_id,
    new_zettel,
    unique_zettel_id,
)


def test_zettel_markdown_round_trip():
    zettel = Zettel(
        id="2026-09-23-gespraech-mueller",
        title="Gespraech Mueller",
        type="meeting",
        date="2026-09-23",
        refs=["mueller2024"],
        tags=["betreuung"],
        body="Vereinbart:\n\n- [ ] Kapitel 3 kuerzen\n\nSiehe [[kap-methodik]].",
    )
    text = zettel.to_markdown()
    assert text.startswith(f"---\nschema: {ZETTEL_SCHEMA}\n")
    again = Zettel.from_markdown(text)
    assert again == zettel
    assert again.to_markdown() == text


def test_zettel_derives_links_and_anchors_from_the_body():
    zettel = Zettel(
        id="2026-09-23-notizblock",
        title="Notizblock",
        body="## Kontext\n\n[[kap-einleitung]] und [[pub-abc|die Veroeffentlichung]]\n",
    )
    assert zettel.links == ["kap-einleitung", "pub-abc"]
    assert zettel.anchors == ["kontext"]
    assert zettel.to_dict()["links"] == ["kap-einleitung", "pub-abc"]


def test_new_zettel_needs_only_a_title():
    zettel = new_zettel("Gedanke zur Methodik", today=date(2026, 9, 23))
    assert zettel.id == "2026-09-23-gedanke-zur-methodik"
    assert zettel.title == "Gedanke zur Methodik"
    assert zettel.type == "fleeting"
    assert zettel.date == "2026-09-23"
    assert zettel.validate() == []


def test_make_zettel_id_follows_the_idea_pattern():
    assert make_zettel_id("Grüße & Anker", today=date(2026, 1, 5)) == "2026-01-05-grüße-anker"


def test_unique_zettel_id_suffixes_on_collision():
    base = "2026-09-23-gedanke"
    assert unique_zettel_id(base, []) == base
    assert unique_zettel_id(base, [base]) == f"{base}-2"
    assert unique_zettel_id(base, [base, f"{base}-2"]) == f"{base}-3"


def test_validate_rejects_an_unknown_type():
    zettel = Zettel(id="x", title="X", type="lektuere")
    assert any("type ungueltig" in e for e in zettel.validate())


def test_validate_accepts_every_schema_type():
    for kind in ("reading", "meeting", "method", "decision", "fleeting", "review"):
        assert Zettel(id="x", title="X", type=kind).validate() == []


def test_validate_requires_a_title():
    assert any("title" in e for e in Zettel(id="x", title="").validate())


def test_validate_rejects_an_id_that_is_not_the_filename():
    zettel = Zettel(id="a", title="A", path="/atlas/zettel/b.md")
    assert any("Dateiname" in e for e in zettel.validate())


def test_validate_rejects_a_non_iso_date():
    assert any("ISO-Datum" in e for e in Zettel(id="x", title="X", date="23.09.2026").validate())


def test_unquoted_yaml_date_is_normalised_to_a_string():
    text = f"---\nschema: {ZETTEL_SCHEMA}\nid: x\ntitle: X\ntype: reading\ndate: 2026-09-23\n---\n\nBody\n"
    assert Zettel.from_markdown(text).date == "2026-09-23"


def test_promoted_to_survives_the_round_trip():
    zettel = Zettel(id="x", title="X", promoted_to="2026-09-24-idee")
    assert Zettel.from_markdown(zettel.to_markdown()).promoted_to == "2026-09-24-idee"
