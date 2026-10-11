"""The pure cite-key extractor and BibTeX field reader (#226)."""
from __future__ import annotations

import pytest

from atlas.citations import extract_cite_keys, parse_bibtex_fields


@pytest.mark.parametrize(
    "tex, keys",
    [
        (r"\cite{a}", ["a"]),
        (r"\cite{a, b ,c}", ["a", "b", "c"]),
        (r"\citep[S.~12]{a} und \citet*{b}", ["a", "b"]),
        (r"\parencite[vgl.][S.~3]{a}", ["a"]),
        (r"\textcite{a} \autocite{b} \footcite{c} \Cite{d} \citeauthor{e}", ["a", "b", "c", "d", "e"]),
        (r"\cites[vgl.]{a}[S.~2]{b}{c}", ["a", "b", "c"]),
        (r"\nocite{*} \nocite{x}", ["x"]),
        (r"\cite{a} \cite{b} \cite{a}", ["a", "b"]),
        ("% \\cite{weg}\n\\cite{da} 50\\% \\cite{auch}", ["da", "auch"]),
        (r"\citestyle{authoryear} \cite{a}", ["a"]),
        (r"\cite {a}", ["a"]),
        ("kein Zitat", []),
        ("", []),
    ],
)
def test_extract_cite_keys(tex, keys):
    assert extract_cite_keys(tex) == keys


def test_a_single_cite_does_not_swallow_the_next_group():
    assert extract_cite_keys(r"\cite{a}{\bf b}") == ["a"]


BIB = r"""
@string{jms = "Journal of Measurement"}
@comment{nichts}
@article{krause2023,
  title = {Dehnungsmessung an {Faserverbund}-Proben},
  author = "Krause, M. and Mustermann, T.",
  year = 2023,
  doi = {https://doi.org/10.0000/FVP.2023.014},
  journal = jms,
}
@book(fischer2019,
  title = {Grundlagen der experimentellen Mechanik},
  year = {2019}
)
@misc{ohne,}
"""


def test_parse_bibtex_fields():
    entries = parse_bibtex_fields(BIB)
    assert [e["key"] for e in entries] == ["krause2023", "fischer2019", "ohne"]
    k = entries[0]
    assert k["title"] == "Dehnungsmessung an Faserverbund-Proben"
    assert k["author"] == "Krause, M. and Mustermann, T."
    assert k["year"] == "2023"
    assert k["doi"] == "10.0000/FVP.2023.014"
    assert entries[1]["title"] == "Grundlagen der experimentellen Mechanik"
    assert entries[1]["doi"] is None
    assert entries[2] == {"key": "ohne", "title": None, "author": None, "year": None, "doi": None}


def test_parse_bibtex_fields_tolerates_garbage():
    assert parse_bibtex_fields("") == []
    assert parse_bibtex_fields("@article{x, title = {offen") == [
        {"key": "x", "title": "offen", "author": None, "year": None, "doi": None}
    ]
