"""The pure citation-style formatter of the Publikationsliste (#228).

APA 7, IEEE and DIN ISO 690 — each entry as segments (text, bold, italic) and
as plain text, the user's own name in bold. The fall set is large (style ×
author count × kind × pending × missing data), so the module is tested
directly here; the HTTP seam is ``test_atlas_publication_list.py``.
"""
from __future__ import annotations

import pytest

from atlas.citation_styles import (
    format_entry,
    parse_name,
    same_person,
    short_citation,
    split_authors,
)

ME = "Mustermann, T."

JOURNAL = {
    "title": "Ein Messaufbau für zyklische Belastungsversuche",
    "venue": "Fachjournal Messtechnik", "type": "journal-article", "year": "2025",
    "volume": "38", "issue": "2", "pages": "112–127", "doi": "10.0000/fjm.2025.0112",
}
CONFERENCE = {
    "title": "Erste Ergebnisse zur Versuchsreihe A",
    "venue": "Tagungsband Fachkonferenz 2024", "type": "conference-paper", "year": "2024",
    "pages": "45–52", "doi": "10.0000/tfk.2024.045",
}
SUBMITTED = {
    "title": "Kalibrierung von Messaufbauten unter Last",
    "venue": "Fachjournal Messtechnik", "type": "journal-article", "pending": "submitted",
}

ONE = ["Mustermann, T."]
TWO = ["Schulz, A.", "Mustermann, T."]
THREE = ["Mustermann, T.", "Krause, M.", "Lindner, S."]


def _text(work, authors, style, own=ME):
    return format_entry({**work, "authors": authors}, style, own)["text"]


def _bold(work, authors, style, own=ME):
    entry = format_entry({**work, "authors": authors}, style, own)
    return [s["text"] for s in entry["segments"] if s["bold"]]


def _italic(work, authors, style, own=ME):
    entry = format_entry({**work, "authors": authors}, style, own)
    return [s["text"] for s in entry["segments"] if s["italic"]]


# --- APA 7 -------------------------------------------------------------------

@pytest.mark.parametrize("authors, head", [
    (ONE, "Mustermann, T. (2025)."),
    (TWO, "Schulz, A., & Mustermann, T. (2025)."),
    (THREE, "Mustermann, T., Krause, M., & Lindner, S. (2025)."),
])
def test_apa_journal_article_with_one_two_three_authors(authors, head):
    assert _text(JOURNAL, authors, "apa") == (
        head + " Ein Messaufbau für zyklische Belastungsversuche. "
        "Fachjournal Messtechnik, 38(2), 112–127. https://doi.org/10.0000/fjm.2025.0112"
    )


def test_apa_sets_journal_and_volume_in_italics_and_the_own_name_in_bold():
    assert _italic(JOURNAL, THREE, "apa") == ["Fachjournal Messtechnik", "38"]
    assert _bold(JOURNAL, THREE, "apa") == ["Mustermann, T."]
    assert _bold(JOURNAL, TWO, "apa") == ["Mustermann, T."]


def test_apa_conference_paper_reads_in_proceedings_with_pages():
    assert _text(CONFERENCE, ["Mustermann, T.", "Krause, M."], "apa") == (
        "Mustermann, T., & Krause, M. (2024). Erste Ergebnisse zur Versuchsreihe A. "
        "In Tagungsband Fachkonferenz 2024 (S. 45–52). https://doi.org/10.0000/tfk.2024.045"
    )
    assert _italic(CONFERENCE, ONE, "apa") == ["Tagungsband Fachkonferenz 2024"]


def test_apa_submitted_and_under_review_replace_the_year():
    authors = ["Mustermann, T.", "Krause, M."]
    assert _text(SUBMITTED, authors, "apa") == (
        "Mustermann, T., & Krause, M. (eingereicht). "
        "Kalibrierung von Messaufbauten unter Last. Fachjournal Messtechnik."
    )
    review = {**SUBMITTED, "pending": "in-revision"}
    assert "(in Begutachtung)." in _text(review, authors, "apa")


def test_apa_more_than_twenty_authors_elides_the_middle():
    authors = [f"Autor{i:02d}, A." for i in range(1, 23)]
    text = _text(JOURNAL, authors, "apa", own="")
    assert text.startswith("Autor01, A., Autor02, A.,")
    assert "Autor19, A., . . . Autor22, A. (2025)." in text
    assert "Autor20" not in text and "Autor21" not in text


def test_apa_without_year_volume_pages_or_doi():
    work = {"title": "Messen ohne Daten", "venue": "Fachjournal", "type": "journal-article"}
    assert _text(work, ONE, "apa") == "Mustermann, T. (o. J.). Messen ohne Daten. Fachjournal."


def test_apa_never_doubles_the_title_punctuation():
    work = {"title": "Warum messen wir?", "venue": "Fachjournal", "year": "2024"}
    assert _text(work, ONE, "apa") == "Mustermann, T. (2024). Warum messen wir? Fachjournal."


# --- IEEE --------------------------------------------------------------------

@pytest.mark.parametrize("authors, head", [
    (ONE, "T. Mustermann"),
    (TWO, "A. Schulz and T. Mustermann"),
    (THREE, "T. Mustermann, M. Krause, and S. Lindner"),
])
def test_ieee_journal_article_with_one_two_three_authors(authors, head):
    assert _text(JOURNAL, authors, "ieee") == (
        head + ", “Ein Messaufbau für zyklische Belastungsversuche,” Fachjournal Messtechnik, "
        "vol. 38, no. 2, pp. 112–127, 2025, doi: 10.0000/fjm.2025.0112."
    )


def test_ieee_bolds_the_own_name_and_italicises_the_venue():
    assert _bold(JOURNAL, THREE, "ieee") == ["T. Mustermann"]
    assert _italic(JOURNAL, THREE, "ieee") == ["Fachjournal Messtechnik"]


def test_ieee_journal_article_names_the_month_before_the_year():
    assert _text({**JOURNAL, "month": 3}, ONE, "ieee").endswith(
        "Fachjournal Messtechnik, vol. 38, no. 2, pp. 112–127, Mar. 2025, doi: 10.0000/fjm.2025.0112.")
    assert ", Sep. 2025," in _text({**JOURNAL, "month": "09"}, ONE, "ieee")


def test_ieee_conference_paper_reads_in_proc_with_the_year_before_the_pages():
    assert _text(CONFERENCE, ["Mustermann, T.", "Krause, M."], "ieee") == (
        "T. Mustermann and M. Krause, “Erste Ergebnisse zur Versuchsreihe A,” "
        "in Proc. Tagungsband Fachkonferenz 2024, 2024, pp. 45–52, doi: 10.0000/tfk.2024.045."
    )
    assert _italic(CONFERENCE, ONE, "ieee") == ["Proc. Tagungsband Fachkonferenz 2024"]
    # a venue that already says so gets no second "Proc."
    proceedings = {**CONFERENCE, "venue": "Proceedings of the Measurement Conference", "volume": "2", "month": 6}
    assert _text(proceedings, ONE, "ieee").endswith(
        "in Proceedings of the Measurement Conference, 2024, pp. 45–52, doi: 10.0000/tfk.2024.045.")


def test_ieee_book_chapter_reads_in_without_proc():
    chapter = {"title": "Messen unter Last", "venue": "Handbuch Messtechnik", "type": "book-chapter",
               "year": "2022", "pages": "10–20"}
    assert _text(chapter, ONE, "ieee") == "T. Mustermann, “Messen unter Last,” in Handbuch Messtechnik, 2022, pp. 10–20."


def test_ieee_pending_says_submitted_or_under_review():
    authors = ["Mustermann, T.", "Krause, M."]
    assert _text(SUBMITTED, authors, "ieee") == (
        "T. Mustermann and M. Krause, “Kalibrierung von Messaufbauten unter Last,” "
        "Fachjournal Messtechnik, submitted."
    )
    assert _text({**SUBMITTED, "pending": "in-revision"}, authors, "ieee").endswith(
        "Fachjournal Messtechnik, under review.")


def test_ieee_more_than_six_authors_is_the_first_et_al():
    authors = ["Mustermann, T."] + [f"Autor{i}, A." for i in range(1, 7)]
    assert _text(JOURNAL, authors, "ieee").startswith("T. Mustermann et al., “Ein Messaufbau")


def test_ieee_without_anything_after_the_title_closes_the_quote_with_a_period():
    assert _text({"title": "Nur ein Titel"}, ONE, "ieee") == "T. Mustermann, “Nur ein Titel.”"


# --- DIN ISO 690 ---------------------------------------------------------------

@pytest.mark.parametrize("authors, head", [
    (ONE, "MUSTERMANN, T."),
    (TWO, "SCHULZ, A.; MUSTERMANN, T."),
    (THREE, "MUSTERMANN, T.; KRAUSE, M.; LINDNER, S."),
])
def test_din_journal_article_with_one_two_three_authors(authors, head):
    assert _text(JOURNAL, authors, "din") == (
        head + ": Ein Messaufbau für zyklische Belastungsversuche. In: Fachjournal Messtechnik "
        "38 (2025), Nr. 2, S. 112–127. DOI 10.0000/fjm.2025.0112"
    )


def test_din_conference_paper_and_pending():
    authors = ["Mustermann, T.", "Krause, M."]
    # proceedings: "In: Venue, Year, S. x–y" — the year without parentheses
    assert _text(CONFERENCE, authors, "din") == (
        "MUSTERMANN, T.; KRAUSE, M.: Erste Ergebnisse zur Versuchsreihe A. "
        "In: Tagungsband Fachkonferenz 2024, 2024, S. 45–52. DOI 10.0000/tfk.2024.045"
    )
    assert _text(SUBMITTED, authors, "din") == (
        "MUSTERMANN, T.; KRAUSE, M.: Kalibrierung von Messaufbauten unter Last. "
        "In: Fachjournal Messtechnik (eingereicht)"
    )


def test_din_book_chapter_reads_like_proceedings():
    chapter = {"title": "Messen unter Last", "venue": "Handbuch Messtechnik", "type": "book-chapter",
               "year": "2022", "pages": "10–20"}
    assert _text(chapter, ONE, "din") == "MUSTERMANN, T.: Messen unter Last. In: Handbuch Messtechnik, 2022, S. 10–20"
    assert _text({**chapter, "pages": ""}, ONE, "din").endswith("In: Handbuch Messtechnik, 2022")


def test_din_keeps_the_given_name_as_written_and_bolds_the_own_name():
    authors = ["Mustermann, Tobias", "Krause, Maria"]
    assert _text(JOURNAL, authors, "din", own="Tobias Mustermann").startswith(
        "MUSTERMANN, Tobias; KRAUSE, Maria: ")
    assert _bold(JOURNAL, authors, "din", own="Tobias Mustermann") == ["MUSTERMANN, Tobias"]


# --- the own name -----------------------------------------------------------------

@pytest.mark.parametrize("own", ["Mustermann, T.", "Tobias Mustermann", "T. Mustermann", "mustermann"])
def test_the_own_name_is_found_in_every_spelling(own):
    authors = ["Krause, M.", "Mustermann, Tobias"]
    for style in ("apa", "ieee", "din"):
        assert len(_bold(JOURNAL, authors, style, own=own)) == 1, (style, own)


def test_another_person_with_the_same_surname_is_not_bold():
    assert _bold(JOURNAL, ["Mustermann, A."], "apa", own="Mustermann, T.") == []


def test_without_an_own_name_nothing_is_bold():
    for style in ("apa", "ieee", "din"):
        assert _bold(JOURNAL, THREE, style, own="") == []


def test_text_is_the_segments_joined_and_segments_are_merged():
    entry = format_entry({**JOURNAL, "authors": THREE}, "apa", ME)
    assert entry["text"] == "".join(s["text"] for s in entry["segments"])
    for a, b in zip(entry["segments"], entry["segments"][1:]):
        assert (a["bold"], a["italic"]) != (b["bold"], b["italic"])


def test_an_unknown_style_is_refused():
    with pytest.raises(ValueError):
        format_entry({**JOURNAL, "authors": ONE}, "chicago", ME)


# --- names and author lists ----------------------------------------------------------

@pytest.mark.parametrize("raw, last, given", [
    ("Mustermann, Tobias", "Mustermann", "Tobias"),
    ("Tobias Mustermann", "Mustermann", "Tobias"),
    ("T. Mustermann", "Mustermann", "T."),
    ("van der Berg, Jan", "van der Berg", "Jan"),
    ("Jan van der Berg", "van der Berg", "Jan"),
    ("CERN", "CERN", ""),
    ("  Krause ,  M.  ", "Krause", "M."),
])
def test_parse_name(raw, last, given):
    name = parse_name(raw)
    assert (name.last, name.given) == (last, given)


def test_initials_of_double_names():
    assert _text({"title": "T"}, ["Müller, Hans-Peter"], "apa", own="").startswith("Müller, H.-P. ")
    assert _text({"title": "T"}, ["Hans Peter Müller"], "ieee", own="").startswith("H. P. Müller, ")


def test_same_person_ignores_case_and_diacritics_and_needs_matching_initials():
    assert same_person(parse_name("Müller, J."), parse_name("Jana Muller"))
    assert same_person(parse_name("Mustermann"), parse_name("Mustermann, T."))
    assert not same_person(parse_name("Mustermann, A."), parse_name("Mustermann, T."))
    assert not same_person(parse_name(""), parse_name("Mustermann, T."))


@pytest.mark.parametrize("value, names", [
    ("Mustermann, T.; Krause, M.", ["Mustermann, T.", "Krause, M."]),
    ("Mustermann, T. and Krause, M.", ["Mustermann, T.", "Krause, M."]),
    ("Mustermann, Tobias", ["Mustermann, Tobias"]),
    # the library's own form (CrossRef): "Family, Given" per person, joined by ", "
    ("Mustermann, Tobias, Krause, Maria", ["Mustermann, Tobias", "Krause, Maria"]),
    ("Mustermann, T. M., Krause, M.", ["Mustermann, T. M.", "Krause, M."]),
    # A comma-only string is CrossRef's "Family, Given" first: two parts are
    # one person, even when both have two words …
    ("García Márquez, Gabriel José", ["García Márquez, Gabriel José"]),
    ("Schmidt, Anna Maria Luise", ["Schmidt, Anna Maria Luise"]),
    ("Schmidt, Anna Maria Luise Sophie, Krause, M.", ["Schmidt, Anna Maria Luise Sophie", "Krause, M."]),
    # … a family name that is also an organization word is still a person …
    ("Group, Hans", ["Group, Hans"]),
    ("Group, Hans, Center, Anna", ["Group, Hans", "Center, Anna"]),
    # … and only an odd number of "Given Family" names reads as such a list.
    ("Tobias Mustermann, Maria Krause, Sven Lindner", ["Tobias Mustermann", "Maria Krause", "Sven Lindner"]),
    ("Wei Li, Na Wang, Jun Chen", ["Wei Li", "Na Wang", "Jun Chen"]),
    (["Mustermann, T.", " ", "Krause, M."], ["Mustermann, T.", "Krause, M."]),
    ("", []),
    (None, []),
    # family names of several words, given names of several words or initials
    ("van der Berg, J. P., Krause, M.", ["van der Berg, J. P.", "Krause, M."]),
    ("Da Silva, Ana Maria, Mustermann, Tobias", ["Da Silva, Ana Maria", "Mustermann, Tobias"]),
    ("Le Roux, Jean Paul", ["Le Roux, Jean Paul"]),
    ("Mustermann, J.-P., Krause, Maria", ["Mustermann, J.-P.", "Krause, Maria"]),
    # organizations stand alone (CrossRef writes them without a given name)
    ("ACME Consortium, Mustermann, Tobias", ["ACME Consortium", "Mustermann, Tobias"]),
    ("Mustermann, Tobias, ACME Consortium", ["Mustermann, Tobias", "ACME Consortium"]),
    ("ACME Consortium, World Health Organization", ["ACME Consortium", "World Health Organization"]),
    ("Krause, Maria, Max Planck Institut für Eisenforschung, Lindner, S.",
     ["Krause, Maria", "Max Planck Institut für Eisenforschung", "Lindner, S."]),
    ("Krause, Maria, Arbeitskreis Messtechnik im Maschinenbau Nord",
     ["Krause, Maria", "Arbeitskreis Messtechnik im Maschinenbau Nord"]),
    # with ";" each part is one person, in either order
    ("Da Silva, Ana Maria; Tobias Mustermann; ACME Consortium",
     ["Da Silva, Ana Maria", "Tobias Mustermann", "ACME Consortium"]),
])
def test_split_authors(value, names):
    assert split_authors(value) == names


@pytest.mark.parametrize("raw, last, given", [
    ("Da Silva, Ana Maria", "Da Silva", "Ana Maria"),
    ("Le Roux, Jean Paul", "Le Roux", "Jean Paul"),
    ("Ana Maria da Silva", "da Silva", "Ana Maria"),
    ("ACME Consortium", "ACME Consortium", ""),
    ("World Health Organization", "World Health Organization", ""),
    # "Family, Given" is always a person, whatever its words
    ("Schmidt, Anna Maria Luise", "Schmidt", "Anna Maria Luise"),
    ("García Márquez, Gabriel José", "García Márquez", "Gabriel José"),
    ("Group, Hans", "Group", "Hans"),
    ("Anna Maria Luise Schmidt", "Schmidt", "Anna Maria Luise"),
])
def test_parse_name_with_particles_and_organizations(raw, last, given):
    name = parse_name(raw)
    assert (name.last, name.given) == (last, given)
    assert name.org == (given == "")


PERSONS = {
    "Schmidt, Anna Maria Luise": {
        "apa": "Schmidt, A. M. L.", "ieee": "A. M. L. Schmidt", "din": "SCHMIDT, Anna Maria Luise",
        "bib": "Schmidt, Anna Maria Luise"},
    "García Márquez, Gabriel José": {
        "apa": "García Márquez, G. J.", "ieee": "G. J. García Márquez", "din": "GARCÍA MÁRQUEZ, Gabriel José",
        "bib": "García Márquez, Gabriel José"},
    "Group, Hans": {"apa": "Group, H.", "ieee": "H. Group", "din": "GROUP, Hans", "bib": "Group, Hans"},
}


@pytest.mark.parametrize("raw", list(PERSONS))
@pytest.mark.parametrize("as_list", [False, True], ids=["library string", "frontmatter list"])
def test_a_family_given_name_is_a_person_in_every_style_and_the_bib(raw, as_list):
    from atlas.publication_list import _bib_name

    authors = [raw] if as_list else raw
    for style in ("apa", "ieee", "din"):
        head = _text({"title": "T"}, authors, style, own="")
        assert head.startswith(PERSONS[raw][style] + ("," if style == "ieee" else ":" if style == "din" else " (")), style
    assert [_bib_name(a) for a in split_authors(authors)] == [PERSONS[raw]["bib"]]


def test_a_long_own_name_stays_bold():
    own = "Schmidt, Anna Maria Luise"
    for style, shown in (("apa", "Schmidt, A. M. L."), ("ieee", "A. M. L. Schmidt"), ("din", "SCHMIDT, Anna Maria Luise")):
        assert _bold(JOURNAL, "Schmidt, Anna Maria Luise, Krause, Maria", style, own=own) == [shown]
        assert _bold(JOURNAL, ["Anna Maria Luise Schmidt", "Krause, M."], style, own=own) == [shown]


def test_acme_consortium_without_a_comma_stays_an_organization():
    from atlas.publication_list import _bib_name

    assert parse_name("ACME Consortium").org
    assert split_authors("ACME Consortium") == ["ACME Consortium"]
    assert _bib_name("ACME Consortium") == "{ACME Consortium}"
    assert _text(JOURNAL, ["ACME Consortium"], "din", own="").startswith("ACME Consortium: ")


def test_multi_word_names_in_every_style():
    authors = ["Da Silva, Ana Maria", "van der Berg, J. P."]
    assert _text({"title": "T"}, authors, "apa", own="").startswith("Da Silva, A. M., & van der Berg, J. P. ")
    assert _text({"title": "T"}, authors, "ieee", own="").startswith("A. M. Da Silva and J. P. van der Berg, ")
    assert _text({"title": "T"}, authors, "din", own="").startswith("DA SILVA, Ana Maria; VAN DER BERG, J. P.: ")


@pytest.mark.parametrize("authors", [
    "ACME Consortium, Mustermann, Tobias",
    "Mustermann, Tobias, ACME Consortium",
])
def test_an_organization_author_keeps_its_name_and_the_own_name_stays_bold(authors):
    for style in ("apa", "ieee", "din"):
        entry = format_entry({**JOURNAL, "authors": authors}, style, ME)
        assert "ACME Consortium" in entry["text"], style
        assert [s["text"] for s in entry["segments"] if s["bold"]] == [
            {"apa": "Mustermann, T.", "ieee": "T. Mustermann", "din": "MUSTERMANN, Tobias"}[style]]
    assert _text(JOURNAL, ["ACME Consortium"], "apa").startswith("ACME Consortium (2025). ")


def test_an_organization_only_list():
    text = _text(JOURNAL, "ACME Consortium, World Health Organization", "apa", own="")
    assert text.startswith("ACME Consortium, & World Health Organization (2025). ")
    assert short_citation("ACME Consortium, World Health Organization", "2025") == (
        "ACME Consortium & World Health Organization (2025)")


@pytest.mark.parametrize("authors, when, short", [
    (ONE, "2025", "Mustermann (2025)"),
    (TWO, "2024", "Schulz & Mustermann (2024)"),
    # APA 7: from three authors on, the first "et al." — never all three
    (THREE, "2025", "Mustermann et al. (2025)"),
    (THREE + ["Weber, K."], "2025", "Mustermann et al. (2025)"),
    (ONE, None, "Mustermann (o. J.)"),
])
def test_short_citation(authors, when, short):
    assert short_citation(authors, when) == short


def test_short_citation_of_a_pending_work():
    assert short_citation(TWO, None, pending="submitted") == "Schulz & Mustermann (eingereicht)"
