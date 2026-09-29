"""Atlas Verweise — the [[id]] wikilink extractor (issue #180, slice 1)."""
from __future__ import annotations

from atlas.links import extract_wikilinks, strip_wikilinks

FENCE = "```"


def test_extract_returns_ids_in_order_of_first_appearance():
    text = "Siehe [[kap-methodik]] und [[pub-abc]], erneut [[kap-methodik]]."
    assert extract_wikilinks(text) == ["kap-methodik", "pub-abc"]


def test_extract_deduplicates_keeping_the_first_position():
    text = "[[a]] [[b]] [[a]] [[c]] [[b]]"
    assert extract_wikilinks(text) == ["a", "b", "c"]


def test_extract_uses_the_id_not_the_label():
    assert extract_wikilinks("[[kap-methodik|Methodik des Kapitels]]") == ["kap-methodik"]


def test_extract_ignores_fenced_code_blocks():
    text = (
        "Vorher [[echt]]\n"
        f"{FENCE}markdown\n"
        "[[im-fence]]\n"
        f"{FENCE}\n"
        "Nachher [[auch-echt]]\n"
    )
    assert extract_wikilinks(text) == ["echt", "auch-echt"]


def test_extract_ignores_tilde_fences():
    text = "[[a]]\n~~~\n[[versteckt]]\n~~~\n[[b]]\n"
    assert extract_wikilinks(text) == ["a", "b"]


def test_extract_ignores_inline_code():
    text = "Schreibe `[[nicht-gemeint]]` statt [[gemeint]]."
    assert extract_wikilinks(text) == ["gemeint"]


def test_extract_ignores_double_backtick_spans():
    assert extract_wikilinks("``ein `[[x]]` Beispiel`` und [[y]]") == ["y"]


def test_extract_on_empty_and_linkless_text():
    assert extract_wikilinks("") == []
    assert extract_wikilinks("nur Text") == []


def test_strip_wikilinks_removes_both_forms():
    assert strip_wikilinks("A [[x]] B [[y|Y]] C").replace("  ", " ") == "A B C"
