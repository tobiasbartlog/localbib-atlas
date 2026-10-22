"""Citations in Markdown bodies (ADR-0026): ``[@key]`` counts as a use of a
library citekey, like an entry in ``refs`` — the "Wo zitiert" of the Item
detail (``GET /links/{citekey}``) lists the Zettel, Idee, Projekt,
Veroeffentlichung and Kapitel whose text cites it. Pure extractor first, then
the wire shape."""
from __future__ import annotations

from atlas.links import cites, extract_citations

FENCE = "```"


# --- extract_citations ---------------------------------------------------------

def test_extracts_keys_in_order_of_first_appearance_deduplicated():
    text = "Siehe [@doe2024] und [@roe2020, S. 12], erneut [@doe2024]."
    assert extract_citations(text) == ["doe2024", "roe2020"]


def test_multi_cites_locators_and_suppressed_authors():
    assert extract_citations("[@a, S. 3; -@b; @c, pp. 4-6]") == ["a", "b", "c"]


def test_keys_with_inner_punctuation_keep_it_but_never_end_on_it():
    assert extract_citations("[@Niu.2026] und [@van-der:x_1].") == ["Niu.2026", "van-der:x_1"]
    assert extract_citations("[@Niu.]") == []


def test_unicode_keys():
    assert extract_citations("[@Müller2021]") == ["Müller2021"]


def test_not_a_citation_without_brackets_or_at():
    assert extract_citations("mail@example.org, @doe2024, [doe2024], [ @doe2024]") == []


def test_skips_fenced_and_inline_code():
    text = (
        "Vorher [@echt]\n"
        f"{FENCE}markdown\n"
        "[@im-fence]\n"
        f"{FENCE}\n"
        "Inline `[@code]` und nachher [@auch-echt]\n"
        "~~~\n[@tilde]\n~~~\n"
    )
    assert extract_citations(text) == ["echt", "auch-echt"]


def test_link_text_is_no_citation():
    """The editor renders ``[@x](url)`` as a link, not as a chip."""
    assert extract_citations("[@doe2024](https://doi.org/10.1/x) und ![@img](a.png)") == []
    assert extract_citations("[@doe2024][ref] aber [@roe2020] (S. 3)") == ["roe2020"]


def test_cites_checks_one_key():
    assert cites("Wie [@doe2024, S. 3] zeigt", "doe2024")
    assert not cites("Wie [@doe2024.x] zeigt", "doe2024")
    assert not cites("[@doe2024](https://x)", "doe2024")
    assert not cites("[@doe2024]", "")
    assert not cites(None, "doe2024")


def test_wikilinks_are_no_citations_and_empty_input_is_empty():
    assert extract_citations("[[doe2024]] [[x|@doe2024]]") == []
    assert extract_citations("") == []
    assert extract_citations(None) == []


# --- GET /links/{citekey} ------------------------------------------------------

def test_links_lists_every_kind_whose_body_cites_the_key(atlas_client):
    base = "/api/plugins/atlas"
    idea = atlas_client.post(f"{base}/ideas", json={"title": "Idee", "body": "Wie [@doe2024] zeigt"}).json()
    pub = atlas_client.post(f"{base}/publications", json={"title": "Paper"}).json()
    atlas_client.put(f"{base}/publications/{pub['id']}", json={"body": "Plan: [@doe2024, S. 4]"})
    proj = atlas_client.post(f"{base}/projects", json={"title": "Projekt", "body": "Basis [@roe2020; @doe2024]"}).json()
    zettel = atlas_client.post(f"{base}/zettel", json={"title": "Notiz", "body": "Gelesen: [@doe2024]."}).json()
    node = atlas_client.post(f"{base}/diss", json={"title": "Kapitel 2", "body": "Methodik nach [@doe2024]"}).json()
    atlas_client.post(f"{base}/zettel", json={"title": "Nur Code", "body": "`[@doe2024]`"})
    atlas_client.post(f"{base}/diss", json={"title": "Ohne", "body": "nichts"})

    res = atlas_client.get(f"{base}/links/doe2024").json()
    assert [i["id"] for i in res["ideas"]] == [idea["id"]]
    assert [p["id"] for p in res["publications"]] == [pub["id"]]
    assert [p["id"] for p in res["projects"]] == [proj["id"]]
    assert [z["id"] for z in res["zettel"]] == [zettel["id"]]
    assert [c["id"] for c in res["chapters"]] == [node["id"]]
    assert res["chapters"][0]["title"] == "Kapitel 2"

    # refs and body citations are one lookup, an unknown key finds nothing
    roe = atlas_client.get(f"{base}/links/roe2020").json()
    assert [p["id"] for p in roe["projects"]] == [proj["id"]]
    assert atlas_client.get(f"{base}/links/unbekannt").json()["chapters"] == []


def test_a_body_citation_never_writes_refs(atlas_client, tmp_path):
    """The file stays what the user wrote (P1): citing in the text does not
    add the key to the frontmatter refs."""
    zettel = atlas_client.post("/api/plugins/atlas/zettel", json={"title": "Z", "body": "[@doe2024]"}).json()
    got = atlas_client.get(f"/api/plugins/atlas/zettel/{zettel['id']}").json()
    assert got["refs"] == []
