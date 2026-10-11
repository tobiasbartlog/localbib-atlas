"""Publikationsliste (#228) through the Atlas HTTP API with the
``plugin_api.testing`` fakes: everything in "Veröffentlicht", grouped by
year, in APA, IEEE or DIN ISO 690, the own name ("Dein Name", an Add-on
setting) in bold, data from the linked library Item, else the frontmatter;
the selection (alle / Journal / Dissertation), "Eingereichte mitnehmen", the
dissertation box and the exports (text, ``.bib``, LaTeX)."""
from __future__ import annotations

import pytest
from plugin_api.testing import InMemoryLibrary

from atlas.citations import parse_bibtex_fields

API = "/api/plugins/atlas"
LIST = f"{API}/publication-list"
ME = {"own_name": "Mustermann, T."}

REFERENCES = [
    {"citekey": "mustermann2025", "id": 21, "title": "Ein Messaufbau für zyklische Belastungsversuche",
     "authors": "Mustermann, Tobias, Krause, Maria, Lindner, Sven", "year": 2025,
     "journal": "Fachjournal Messtechnik", "volume": "38", "issue": "2", "pages": "112–127",
     "doi": "10.0000/fjm.2025.0112", "has_pdf": True},
    {"citekey": "schulz2024", "id": 22, "title": "Messunsicherheit bei Dehnungsmessungen",
     "authors": "Schulz, Anna, Mustermann, Tobias", "year": 2024,
     "journal": "Fachjournal Messtechnik", "volume": "37", "issue": "4", "pages": "301–315",
     "doi": "10.0000/fjm.2024.0301", "has_pdf": True},
    {"citekey": "mustermann2024tagung", "id": 23, "title": "Erste Ergebnisse zur Versuchsreihe A",
     "authors": "Mustermann, Tobias, Krause, Maria", "year": 2024,
     "journal": "Tagungsband Fachkonferenz 2024", "pages": "45–52",
     "doi": "10.0000/tfk.2024.045", "has_pdf": False},
]

PUBLICATIONS = [
    {"id": "messaufbau", "title": "Messaufbau (Arbeitstitel)", "status": "published", "published": "2025-03-01",
     "type": "journal-article", "paper": "mustermann2025"},
    {"id": "tagung-a", "title": "Tagung A", "status": "published", "published": "2024-09-10",
     "type": "conference-paper", "paper": "mustermann2024tagung"},
    {"id": "unsicherheit", "title": "Unsicherheit", "status": "published", "published": "2024-05-01",
     "type": "journal-article", "paper": "schulz2024"},
    {"id": "solo", "title": "Allein gemessen", "status": "published", "published": "2023-11-02",
     "type": "journal-article", "venue": "Zeitschrift X"},
    {"id": "kalibrierung", "title": "Kalibrierung von Messaufbauten unter Last", "status": "submitted",
     "submitted": "2026-08-07", "type": "journal-article", "venue": "Fachjournal Messtechnik",
     "authors": ["Krause, M."]},
    {"id": "datensatz", "title": "Datensatz Versuchsreihe A", "status": "in-revision",
     "submitted": "2026-03-01", "type": "journal-article", "venue": "Data-Journal", "authors": ["S. Lindner"]},
    {"id": "konf-b", "title": "Konferenzbeitrag Versuchsreihe B", "status": "drafting", "type": "conference-paper"},
    {"id": "alt", "title": "Abgelehnt", "status": "rejected", "type": "journal-article", "published": "2022-01-01"},
]

CHAPTERS = [
    ("Einleitung", []),
    ("Stand der Forschung", ["unsicherheit"]),
    ("Methodik", ["messaufbau", "kalibrierung"]),
    ("Ergebnisse", ["konf-b"]),
]


def _library() -> InMemoryLibrary:
    return InMemoryLibrary(REFERENCES)


def _seed(client) -> None:
    for pub in PUBLICATIONS:
        assert client.post(f"{API}/publications", json=pub).status_code == 200
    for title, pubs in CHAPTERS:
        assert client.post(f"{API}/diss", json={"title": title, "publications": pubs}).status_code == 200


@pytest.fixture
def listing(atlas_app):
    """``listing(**query)`` against the seeded archive, own name set."""
    with atlas_app(library=_library(), settings=ME) as client:
        _seed(client)

        def get(path: str = "", **query):
            resp = client.get(LIST + path, params=query)
            assert resp.status_code == 200, resp.text
            return resp.json()

        get.client = client
        yield get


def _entries(data) -> dict:
    return {e["id"]: e for g in data["groups"] for e in g["entries"]}


def _bold(entry) -> list[str]:
    return [s["text"] for s in entry["segments"] if s["bold"]]


# --- the list --------------------------------------------------------------------

def test_published_entries_grouped_by_year_newest_first(listing):
    data = listing()
    assert [g["label"] for g in data["groups"]] == ["2025", "2024", "2023"]
    assert [e["id"] for e in data["groups"][1]["entries"]] == ["tagung-a", "unsicherheit"]
    assert set(_entries(data)) == {"messaufbau", "tagung-a", "unsicherheit", "solo"}
    assert data["own_name"] == "Mustermann, T."


def test_the_answer_carries_only_what_the_page_reads(listing):
    data = listing(submitted="true")
    assert set(data) == {"own_name", "counts", "groups", "text", "dissertation", "dissertation_text"}
    assert {tuple(sorted(g)) for g in data["groups"]} == {("entries", "key", "label")}
    for entry in _entries(data).values():
        assert set(entry) == {"id", "title", "number", "segments", "text", "pending", "has_pdf", "chapters"}
    for chapter in data["dissertation"]:
        assert set(chapter) == {"id", "label", "items"}
        assert all(set(item) == {"id", "state", "short"} for item in chapter["items"])


def test_a_linked_paper_brings_volume_issue_pages_and_doi_from_the_library(listing):
    entry = _entries(listing())["messaufbau"]
    assert entry["text"] == (
        "Mustermann, T., Krause, M., & Lindner, S. (2025). Ein Messaufbau für zyklische "
        "Belastungsversuche. Fachjournal Messtechnik, 38(2), 112–127. https://doi.org/10.0000/fjm.2025.0112"
    )
    assert entry["has_pdf"] is True
    assert entry["chapters"] == [{"number": 3, "title": "Methodik"}]
    assert entry["number"] is None
    assert _entries(listing())["tagung-a"]["has_pdf"] is False


ONE, TWO, THREE = "solo", "unsicherheit", "messaufbau"

EXPECTED = {
    ("apa", ONE): "Mustermann, T. (2023). Allein gemessen. Zeitschrift X.",
    ("apa", TWO): "Schulz, A., & Mustermann, T. (2024). Messunsicherheit bei Dehnungsmessungen. "
                  "Fachjournal Messtechnik, 37(4), 301–315. https://doi.org/10.0000/fjm.2024.0301",
    ("apa", THREE): "Mustermann, T., Krause, M., & Lindner, S. (2025). Ein Messaufbau für zyklische "
                    "Belastungsversuche. Fachjournal Messtechnik, 38(2), 112–127. "
                    "https://doi.org/10.0000/fjm.2025.0112",
    # IEEE journals: the month comes from `published` (same year as the entry)
    ("ieee", ONE): "T. Mustermann, “Allein gemessen,” Zeitschrift X, Nov. 2023.",
    ("ieee", TWO): "A. Schulz and T. Mustermann, “Messunsicherheit bei Dehnungsmessungen,” "
                   "Fachjournal Messtechnik, vol. 37, no. 4, pp. 301–315, May 2024, doi: 10.0000/fjm.2024.0301.",
    ("ieee", THREE): "T. Mustermann, M. Krause, and S. Lindner, “Ein Messaufbau für zyklische "
                     "Belastungsversuche,” Fachjournal Messtechnik, vol. 38, no. 2, pp. 112–127, Mar. 2025, "
                     "doi: 10.0000/fjm.2025.0112.",
    ("din", ONE): "MUSTERMANN, T.: Allein gemessen. In: Zeitschrift X (2023)",
    ("din", TWO): "SCHULZ, Anna; MUSTERMANN, Tobias: Messunsicherheit bei Dehnungsmessungen. In: "
                  "Fachjournal Messtechnik 37 (2024), Nr. 4, S. 301–315. DOI 10.0000/fjm.2024.0301",
    ("din", THREE): "MUSTERMANN, Tobias; KRAUSE, Maria; LINDNER, Sven: Ein Messaufbau für zyklische "
                    "Belastungsversuche. In: Fachjournal Messtechnik 38 (2025), Nr. 2, S. 112–127. "
                    "DOI 10.0000/fjm.2025.0112",
}


@pytest.mark.parametrize("style", ["apa", "ieee", "din"])
@pytest.mark.parametrize("pub", [ONE, TWO, THREE])
def test_each_style_with_one_two_and_three_authors_own_name_bold(listing, style, pub):
    entry = _entries(listing(style=style))[pub]
    assert entry["text"] == EXPECTED[(style, pub)]
    assert len(_bold(entry)) == 1 and "ustermann" in _bold(entry)[0].lower()


def test_ieee_numbers_the_entries_through_all_groups(listing):
    data = listing(style="ieee")
    numbers = [e["number"] for g in data["groups"] for e in g["entries"]]
    assert numbers == [1, 2, 3, 4]


def test_journal_article_versus_conference_paper(listing):
    apa = _entries(listing())["tagung-a"]["text"]
    assert apa == ("Mustermann, T., & Krause, M. (2024). Erste Ergebnisse zur Versuchsreihe A. "
                   "In Tagungsband Fachkonferenz 2024 (S. 45–52). https://doi.org/10.0000/tfk.2024.045")
    ieee = _entries(listing(style="ieee"))["tagung-a"]["text"]
    assert ieee.endswith("“Erste Ergebnisse zur Versuchsreihe A,” in Proc. Tagungsband Fachkonferenz 2024, "
                         "2024, pp. 45–52, doi: 10.0000/tfk.2024.045.")
    din = _entries(listing(style="din"))["tagung-a"]["text"]
    assert din.endswith("In: Tagungsband Fachkonferenz 2024, 2024, S. 45–52. DOI 10.0000/tfk.2024.045")
    journal = listing(selection="journal")
    assert set(_entries(journal)) == {"messaufbau", "unsicherheit", "solo"}
    assert journal["counts"] == {"all": 4, "journal": 3, "diss": 2}


def test_submitted_and_under_review_come_along_on_request(listing):
    assert "kalibrierung" not in _entries(listing())
    data = listing(submitted="true")
    first = data["groups"][0]
    assert first["key"] == "pending" and first["label"] == "Eingereicht und in Begutachtung"
    assert [e["id"] for e in first["entries"]] == ["kalibrierung", "datensatz"]
    kalib, daten = first["entries"]
    # no library Item: the frontmatter, the own name before the co-authors
    assert kalib["text"] == ("Mustermann, T., & Krause, M. (eingereicht). "
                             "Kalibrierung von Messaufbauten unter Last. Fachjournal Messtechnik.")
    assert kalib["pending"] == "submitted" and kalib["has_pdf"] is False
    assert daten["pending"] == "in-revision" and "(in Begutachtung)" in daten["text"]
    assert data["counts"] == {"all": 6, "journal": 5, "diss": 3}
    assert "konf-b" not in _entries(data) and "alt" not in _entries(data)


def test_selection_dissertation_and_the_prior_publications_box(listing):
    data = listing(selection="diss")
    assert set(_entries(data)) == {"messaufbau", "unsicherheit"}
    box = data["dissertation"]
    assert [c["label"] for c in box] == [
        "Kapitel 2 · Stand der Forschung", "Kapitel 3 · Methodik", "Kapitel 4 · Ergebnisse"]
    assert [(i["id"], i["state"], i["short"]) for i in box[1]["items"]] == [
        ("messaufbau", "published", "Mustermann et al. (2025)"),
        ("kalibrierung", "pending", "Mustermann & Krause (eingereicht)"),
    ]
    assert box[2]["items"] == [{"id": "konf-b", "state": "open", "short": "Konferenzbeitrag Versuchsreihe B"}]
    text = data["dissertation_text"]
    assert text.startswith("Kapitel 2 · Stand der Forschung\nSchulz, A., & Mustermann, T. (2024).")
    assert "Kapitel 3 · Methodik\nMustermann, T., Krause, M., & Lindner, S. (2025)." in text
    assert "Kalibrierung" not in text and "Konferenzbeitrag Versuchsreihe B" not in text
    assert "Kalibrierung von Messaufbauten" in listing(selection="diss", submitted="true")["dissertation_text"]


def test_without_an_own_name_nothing_is_bold_and_the_setting_is_read_live(atlas_app):
    with atlas_app(library=_library()) as client:
        _seed(client)
        data = client.get(LIST).json()
        assert data["own_name"] == ""
        assert not any(_bold(e) for e in _entries(data).values())
        # "Dein Name" saved under Einstellungen › Add-ons while Atlas runs
        client.app.state.atlas_api.settings.set("own_name", "Tobias Mustermann")
        entry = _entries(client.get(LIST).json())["unsicherheit"]
    assert _bold(entry) == ["Mustermann, T."]


def test_a_hanging_paper_link_falls_back_to_the_frontmatter_and_keeps_its_cite_key(atlas_app):
    with atlas_app(library=_library(), settings=ME) as client:
        client.post(f"{API}/publications", json={
            "id": "verloren", "title": "Verlorener Link", "status": "published", "published": "2022-06-01",
            "venue": "Journal Y", "type": "journal-article", "paper": "fehlt2020", "authors": ["Maria Krause"]})
        entry = _entries(client.get(LIST).json())["verloren"]
        bib = client.get(f"{LIST}/export", params={"format": "bib"}).json()["content"]
    assert entry["has_pdf"] is False
    assert entry["text"] == "Mustermann, T., & Krause, M. (2022). Verlorener Link. Journal Y."
    # \cite{fehlt2020} in the thesis must keep working: the key is the link,
    # the fields come from the frontmatter.
    found = {e["key"]: e for e in parse_bibtex_fields(bib)}
    assert "verloren" not in found
    assert found["fehlt2020"]["title"] == "Verlorener Link"
    assert found["fehlt2020"]["author"] == "Mustermann, T. and Krause, Maria"
    assert "@article{fehlt2020," in bib and "journal = {Journal Y}" in bib


class _CountingLibrary(InMemoryLibrary):
    """The contract's fake, counting every ``get_reference`` per Cite Key."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.lookups: dict[str, int] = {}

    def get_reference(self, citekey):
        self.lookups[citekey] = self.lookups.get(citekey, 0) + 1
        return super().get_reference(citekey)


@pytest.mark.parametrize("query, wanted", [
    # Nur Journal: the conference paper is neither shown nor in the box
    ({"selection": "journal"}, {"mustermann2025": 1, "schulz2024": 1}),
    ({"selection": "all"}, {"mustermann2025": 1, "schulz2024": 1, "mustermann2024tagung": 1}),
    # Dissertation: the box needs what the list shows, nothing else
    ({"selection": "diss"}, {"mustermann2025": 1, "schulz2024": 1}),
])
def test_only_the_shown_and_the_box_rows_are_looked_up_once_each(atlas_app, query, wanted):
    library = _CountingLibrary(REFERENCES)
    with atlas_app(library=library, settings=ME) as client:
        _seed(client)
        library.lookups.clear()
        assert client.get(LIST, params=query).status_code == 200
    assert library.lookups == wanted


def test_the_export_looks_up_only_the_exported_rows(atlas_app):
    library = _CountingLibrary(REFERENCES)
    with atlas_app(library=library, settings=ME) as client:
        _seed(client)
        library.lookups.clear()
        client.get(f"{LIST}/export", params={"format": "bib", "selection": "journal"})
    assert library.lookups == {"mustermann2025": 1, "schulz2024": 1}


def _live_module(client, name: str):
    """The module the mounted ``/publication-list`` endpoint really calls.
    In the main suite the core's loader tests load the Bundle a second time
    (Dev-Suchpfad), so ``from atlas import …`` inside a test can be another
    copy than the one the router holds — patching that copy counts nothing."""
    for route in client.app.routes:
        if getattr(route, "path", None) == LIST:
            return route.endpoint.__globals__[name]
    raise AssertionError("the publication-list route is not mounted")


def test_each_entry_is_formatted_once_and_the_box_reuses_it(listing, monkeypatch):
    publication_list = _live_module(listing.client, "publication_list")

    formatted = []
    real = publication_list.format_entry

    def counting(work, style, own_name=""):
        formatted.append(work["title"])
        return real(work, style, own_name)

    monkeypatch.setattr(publication_list, "format_entry", counting)
    data = listing(submitted="true")
    shown = [e["id"] for g in data["groups"] for e in g["entries"]]
    assert len(formatted) == len(shown) == 6
    assert sorted(formatted) == sorted(set(formatted))
    assert "Messunsicherheit bei Dehnungsmessungen" in data["dissertation_text"]


@pytest.mark.parametrize("query, code", [
    ({"style": "chicago"}, "error.atlas.style_invalid"),
    ({"selection": "beste"}, "error.atlas.selection_invalid"),
])
def test_unknown_style_or_selection_is_a_code(atlas_client, query, code):
    resp = atlas_client.get(LIST, params=query)
    assert resp.status_code == 422 and resp.json()["detail"] == code


# --- exports ------------------------------------------------------------------------

def test_text_export_is_the_list_as_shown(listing):
    data = listing(style="ieee")
    out = listing("/export", format="text", style="ieee")
    assert out["filename"] == "publikationsliste.txt" and out["count"] == 4
    assert out["content"] == data["text"]
    blocks = out["content"].split("\n\n")
    assert [b.split("\n")[0] for b in blocks] == ["2025", "2024", "2023"]
    assert blocks[0].split("\n")[1] == "[1] " + EXPECTED[("ieee", THREE)]


def test_entry_and_bib_author_field_share_one_parsing_of_the_library_authors(atlas_app):
    """Organizations and multi-word names in the library's "Family, Given, …"
    string: the entry and the ``.bib`` author field read the same people."""
    library = InMemoryLibrary([{
        "citekey": "acme2023", "id": 31, "title": "Gemeinsam gemessen", "year": 2023, "journal": "J",
        "authors": "ACME Consortium, Mustermann, Tobias, Da Silva, Ana Maria",
    }])
    with atlas_app(library=library, settings=ME) as client:
        client.post(f"{API}/publications", json={
            "id": "gemeinsam", "title": "G", "status": "published", "published": "2023-01-01",
            "type": "journal-article", "paper": "acme2023"})
        entry = _entries(client.get(LIST).json())["gemeinsam"]
        bib = client.get(f"{LIST}/export", params={"format": "bib"}).json()["content"]
    assert entry["text"].startswith("ACME Consortium, Mustermann, T., & Da Silva, A. M. (2023). Gemeinsam gemessen.")
    assert _bold(entry) == ["Mustermann, T."]
    assert "author = {{ACME Consortium} and Mustermann, Tobias and Da Silva, Ana Maria}" in bib


def test_bib_export_takes_the_library_entries_and_builds_the_rest_from_the_frontmatter(listing):
    out = listing("/export", format="bib", submitted="true")
    assert out["filename"] == "publikationsliste.bib"
    content = out["content"]
    entries = {e["key"]: e for e in parse_bibtex_fields(content)}
    assert set(entries) == {"mustermann2025", "mustermann2024tagung", "schulz2024", "solo",
                            "kalibrierung", "datensatz"}
    assert entries["mustermann2025"]["doi"] == "10.0000/fjm.2025.0112"
    assert "@article{mustermann2025," in content
    assert "author = {Mustermann, Tobias and Krause, Maria and Lindner, Sven}" in content
    assert "volume = {38}" in content and "number = {2}" in content and "pages = {112--127}" in content
    assert "@inproceedings{mustermann2024tagung," in content
    assert "booktitle = {Tagungsband Fachkonferenz 2024}" in content
    assert "@article{solo," in content and "journal = {Zeitschrift X}" in content
    assert entries["solo"]["author"] == "Mustermann, T." and entries["solo"]["year"] == "2023"
    assert entries["kalibrierung"]["author"] == "Mustermann, T. and Krause, M."
    assert "note = {eingereicht}" in content and "note = {in Begutachtung}" in content


def test_latex_export_is_a_section_with_lists(listing):
    out = listing("/export", format="latex")
    assert out["filename"] == "publikationsliste.tex"
    tex = out["content"]
    assert "\\section*{Publikationen}" in tex
    assert tex.count("\\begin{itemize}") == 3 and tex.count("\\end{itemize}") == 3
    assert "\\subsection*{2025}" in tex
    assert ("\\item \\textbf{Mustermann, T.}, Krause, M., \\& Lindner, S. (2025). Ein Messaufbau "
            "für zyklische Belastungsversuche. \\textit{Fachjournal Messtechnik}, \\textit{38}(2), 112--127.") in tex
    ieee = listing("/export", format="latex", style="ieee")["content"]
    assert "\\item[{[1]}] \\textbf{T. Mustermann}, M. Krause, and S. Lindner, ``Ein Messaufbau" in ieee


def test_latex_export_escapes_special_characters(atlas_app):
    with atlas_app(library=_library(), settings=ME) as client:
        client.post(f"{API}/publications", json={
            "id": "sonder", "title": "50% Last & 100_mm #1", "status": "published",
            "published": "2021-01-01", "venue": "J"})
        tex = client.get(f"{LIST}/export", params={"format": "latex"}).json()["content"]
    assert "50\\% Last \\& 100\\_mm \\#1" in tex


def test_unknown_export_format_is_a_code(atlas_client):
    resp = atlas_client.get(f"{LIST}/export", params={"format": "docx"})
    assert resp.status_code == 422 and resp.json()["detail"] == "error.atlas.format_invalid"


def test_the_list_writes_nothing(listing, tmp_path):
    before = {p: p.stat().st_mtime_ns for p in tmp_path.rglob("*.md")}
    listing()
    listing("/export", format="bib")
    assert {p: p.stat().st_mtime_ns for p in tmp_path.rglob("*.md")} == before
