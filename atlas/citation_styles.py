"""Citation styles of the Publikationsliste (#228) — pure, no I/O.

:func:`format_entry` turns one work into an entry in APA 7, IEEE or
DIN ISO 690: a list of **segments** (``{text, bold, italic}``, neighbours of
the same formatting merged) and the same entry as plain ``text``. The user's
own name (the Atlas setting "Dein Name") is set in bold wherever it appears
among the authors.

A work is a plain dict — the caller decides where the data come from (the
linked library Item, else the Publication's frontmatter)::

    {"title", "authors": [names], "year", "month", "venue", "type", "volume",
     "issue", "pages", "doi", "pending": None | "submitted" | "in-revision"}

``type`` is the Publication's (``journal-article``, ``conference-paper``,
``book-chapter``, ``other``); a conference paper or book chapter reads "In …"
(IEEE: "in Proc. …" for a conference, the year before the pages; DIN:
"In: Venue, Year, S. …"). ``month`` (1–12, optional) is only used by IEEE
for journals ("Mar. 2025").
``pending`` replaces the year with "eingereicht" / "in Begutachtung" (IEEE:
"submitted" / "under review") and drops volume, pages and DOI.

Names come as written: "Family, Given", "Given Family", initials or not
(:func:`parse_name`); :func:`split_authors` reads the library's author string,
whose own form is "Family, Given" per person joined by ", " (CrossRef), or a
list. :func:`short_citation` is the in-text form for "Für die Dissertation"
("Schulz & Mustermann (2024)").
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Iterable, Optional, Union

STYLES = ("apa", "ieee", "din")

PENDING_LABEL = {"submitted": "eingereicht", "in-revision": "in Begutachtung"}
_PENDING_LABEL_EN = {"submitted": "submitted", "in-revision": "under review"}
NO_YEAR = "o. J."
# "In …": the venue is a book (proceedings, edited volume), not a journal.
_IN_TYPES = {"conference-paper", "book-chapter"}
_PARTICLES = {"van", "von", "der", "den", "de", "del", "della", "di", "da", "du", "la", "le", "zu", "zum", "zur", "ter", "ten", "dos", "das"}
_APA_MAX = 20     # APA 7: up to 20 authors, then 19 … last
_IEEE_MAX = 6     # IEEE: more than six → first author et al.
# IEEE's month abbreviations (as IEEEtran.bst writes them).
_IEEE_MONTHS = ("Jan.", "Feb.", "Mar.", "Apr.", "May", "Jun.", "Jul.", "Aug.", "Sep.", "Oct.", "Nov.", "Dec.")
# An author that is an organization, not a person: CrossRef (and so the
# library) writes it on its own, without a given name.
_ORG_MARKERS = re.compile(
    r"(?<!\w)(consortium|organi[sz]ation|group|gruppe|arbeitsgruppe|arbeitskreis|institute?|"
    r"universit(?:y|ät|aet|é|at)|universidad|association|society|gesellschaft|committee|komitee|"
    r"collaboration|team|network|netzwerk|council|agency|foundation|stiftung|ministry|ministerium|"
    r"department|centre|center|zentrum|laborator(?:y|ies)|company|corporation|inc|ltd|gmbh|verband|"
    r"verein|commission|kommission|academy|akademie|alliance|federation|initiative|project|bundesamt)(?!\w)",
    re.IGNORECASE)
_MAX_NAME_WORDS = 4   # more words (particles aside) than a person's name has: an organization


# =============================================================================
# Names
# =============================================================================

@dataclass(frozen=True)
class Name:
    last: str
    given: str = ""
    org: bool = False   # an organization: ``last`` is its whole name


def _words(text: str) -> list[str]:
    return [w for w in text.split() if w.casefold() not in _PARTICLES]


def is_organization(raw: str) -> bool:
    """A comma-free name with an organization marker (Consortium, Institut,
    University, …) or more words than a person's name has, particles aside.
    "Family, Given" is always a person ("Group, Hans")."""
    text = re.sub(r"\s+", " ", str(raw or "")).strip()
    if not text or "," in text:
        return False
    return bool(_ORG_MARKERS.search(text)) or len(_words(text)) > _MAX_NAME_WORDS


def parse_name(raw: str) -> Name:
    """"Family, Given" or "Given Family" (particles such as "van der" or
    "Da" belong to the family name); one word is a family name only; an
    organization stays whole."""
    text = re.sub(r"\s+", " ", str(raw or "")).strip()
    if not text:
        return Name("")
    if "," in text:
        last, _, given = text.partition(",")
        return Name(last.strip(), given.strip())
    if is_organization(text):
        return Name(text, org=True)
    tokens = text.split(" ")
    if len(tokens) == 1:
        return Name(tokens[0])
    i = len(tokens) - 1
    while i > 1 and tokens[i - 1].lower() in _PARTICLES:
        i -= 1
    return Name(" ".join(tokens[i:]), " ".join(tokens[:i]))


def _initials(given: str) -> str:
    """"Tobias" → "T.", "Hans-Peter" → "H.-P.", "J.R.R." → "J. R. R."."""
    words = []
    for token in given.split():
        parts = []
        for part in token.split("-"):
            letters = [seg for seg in part.split(".") if seg]
            if letters:
                parts.append(" ".join(seg[0] + "." for seg in letters))
        if parts:
            words.append("-".join(parts))
    return " ".join(words)


def _fold(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text or "")
    plain = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return re.sub(r"\s+", " ", plain).strip().casefold()


def same_person(a: Name, b: Name) -> bool:
    """Same family name (case and diacritics ignored); when both carry a
    given name, the first initials must agree too. Never an organization."""
    if a.org or b.org or not a.last or not b.last or _fold(a.last) != _fold(b.last):
        return False
    ga, gb = _fold(a.given), _fold(b.given)
    return not ga or not gb or ga[0] == gb[0]


def _is_initial(word: str) -> bool:
    """"J.", "J", "J.-P.", "J.P." — initials, not a name ("Li" is a name)."""
    if len(word) == 1:
        return word.isalpha()
    return bool(re.fullmatch(r"[^\W\d_]\.(?:-?[^\W\d_]\.)*", word))


def _looks_like_given(part: str) -> bool:
    """Initials or one to four capitalized words, no organization marker:
    the given names after a family name in "Family, Given"."""
    words = part.split()
    if not words or len(words) > _MAX_NAME_WORDS or _ORG_MARKERS.search(part):
        return False
    return all(w[0].isalpha() and w[0].isupper() for w in words)


def _can_be_family(part: str) -> bool:
    """The part before a given name: one word always — even a marker word
    ("Group, Hans" is a person) —, several words unless they name an
    organization ("ACME Consortium")."""
    return len(part.split()) == 1 or not is_organization(part)


def _looks_like_full_name(part: str) -> bool:
    """"Given Family" on its own: two or more words, not starting with a
    particle ("Da Silva" is a family name) and not ending in initials."""
    words = part.split()
    return (len(words) >= 2 and not is_organization(part)
            and words[0].casefold() not in _PARTICLES and not _is_initial(words[-1]))


def split_authors(value: Union[str, Iterable[str], None]) -> list[str]:
    """The authors of a library Item (a string) or of a frontmatter list as
    one name per entry.

    ``;`` separates people ("Given Family" or "Family, Given"), so does a
    BibTeX " and " (the core's BibTeX, RIS, Zotero and OpenAlex intakes
    write "; "). A comma-only string is CrossRef's form, the library's
    own: "Family, Given" per person, organizations alone, all joined by
    ", " — read from left to right: a part is the given name of the part
    before if it looks like one (initials or one to four capitalized words,
    no organization marker) and that part can be a family name (one word,
    even "Group", or several words that name no organization). So two
    parts are one person ("García Márquez, Gabriel José"). Only an odd
    number of "Given Family" names, three or more, reads as such a list
    ("Tobias Mustermann, Maria Krause, Sven Lindner") — two such names are
    indistinguishable from one CrossRef person and read as that."""
    if value is None:
        return []
    if not isinstance(value, str):
        return [str(v).strip() for v in value if str(v or "").strip()]
    text = value.strip()
    if not text:
        return []
    if ";" in text:
        return [p.strip() for p in text.split(";") if p.strip()]
    if re.search(r"\s+and\s+", text):
        return [p.strip() for p in re.split(r"\s+and\s+", text) if p.strip()]
    parts = [re.sub(r"\s+", " ", p).strip() for p in text.split(",") if p.strip()]
    if len(parts) <= 1:
        return parts
    people = [p for p in parts if not is_organization(p)]
    if len(people) >= 3 and len(people) % 2 and all(_looks_like_full_name(p) for p in people):
        return parts
    out: list[str] = []
    i = 0
    while i < len(parts):
        part = parts[i]
        nxt = parts[i + 1] if i + 1 < len(parts) else None
        if nxt is not None and _can_be_family(part) and _looks_like_given(nxt):
            out.append(f"{part}, {nxt}")
            i += 2
        else:
            out.append(part)
            i += 1
    return out


# =============================================================================
# Segments
# =============================================================================

def _seg(text: str, *, bold: bool = False, italic: bool = False) -> dict:
    return {"text": text, "bold": bold, "italic": italic}


def _merge(segments: list[dict]) -> list[dict]:
    out: list[dict] = []
    for s in segments:
        if not s["text"]:
            continue
        if out and (out[-1]["bold"], out[-1]["italic"]) == (s["bold"], s["italic"]):
            out[-1] = {**out[-1], "text": out[-1]["text"] + s["text"]}
        else:
            out.append(dict(s))
    return out


def _end(text: str, mark: str = ".") -> str:
    """``text`` closed by ``mark`` unless it already ends in punctuation."""
    text = text.rstrip()
    return text if text.endswith((".", "?", "!")) else text + mark


# =============================================================================
# Author lists
# =============================================================================

def _name_apa(n: Name) -> str:
    initials = "" if n.org else _initials(n.given)
    return f"{n.last}, {initials}" if initials else n.last


def _name_ieee(n: Name) -> str:
    initials = "" if n.org else _initials(n.given)
    return f"{initials} {n.last}" if initials else n.last


def _name_din(n: Name) -> str:
    if n.org:  # a corporate author keeps its spelling
        return n.last
    return f"{n.last.upper()}, {n.given}" if n.given else n.last.upper()


def _author_segments(authors: list[str], style: str, own: Name) -> list[dict]:
    names = [parse_name(a) for a in authors]
    names = [n for n in names if n.last]
    fmt = {"apa": _name_apa, "ieee": _name_ieee, "din": _name_din}[style]

    def person(n: Name) -> dict:
        return _seg(fmt(n), bold=bool(own.last) and same_person(own, n))

    if not names:
        return []
    if style == "din":
        out: list[dict] = []
        for i, n in enumerate(names):
            if i:
                out.append(_seg("; "))
            out.append(person(n))
        return out
    if style == "ieee":
        if len(names) > _IEEE_MAX:
            return [person(names[0]), _seg(" et al.")]
        if len(names) == 2:
            return [person(names[0]), _seg(" and "), person(names[1])]
        out = []
        for i, n in enumerate(names):
            if i:
                out.append(_seg(", and " if i == len(names) - 1 else ", "))
            out.append(person(n))
        return out
    # APA 7
    if len(names) > _APA_MAX:
        out = []
        for n in names[:_APA_MAX - 1]:
            out += [person(n), _seg(", ")]
        return out + [_seg(". . . "), person(names[-1])]
    if len(names) == 1:
        return [person(names[0])]
    out = []
    for i, n in enumerate(names):
        if i:
            out.append(_seg(", & " if i == len(names) - 1 else ", "))
        out.append(person(n))
    return out


# =============================================================================
# The three styles
# =============================================================================

def _value(work: dict, key: str) -> str:
    value = work.get(key)
    return str(value).strip() if value not in (None, "") else ""


def _apa(work: dict, authors: list[dict]) -> list[dict]:
    title, venue = _value(work, "title"), _value(work, "venue")
    pending = PENDING_LABEL.get(work.get("pending") or "")
    when = pending or _value(work, "year") or NO_YEAR
    is_in = work.get("type") in _IN_TYPES
    if authors:
        out = authors + [_seg(f" ({when}). "), _seg(_end(title) + " " if title else "")]
    else:
        out = [_seg(_end(title) + f" ({when}). ")]
    if venue:
        if is_in:
            out += [_seg("In "), _seg(venue, italic=True)]
            pages = _value(work, "pages") if not pending else ""
            out.append(_seg(f" (S. {pages})." if pages else "."))
        else:
            out.append(_seg(venue, italic=True))
            if not pending:
                volume, issue, pages = _value(work, "volume"), _value(work, "issue"), _value(work, "pages")
                if volume:
                    out += [_seg(", "), _seg(volume, italic=True)]
                if issue:
                    out.append(_seg(f"({issue})"))
                if pages:
                    out.append(_seg(f", {pages}"))
            out.append(_seg("."))
    doi = _value(work, "doi")
    if doi and not pending:
        out.append(_seg(f" https://doi.org/{doi}"))
    return out


def _ieee_month(value) -> str:
    try:
        month = int(str(value).strip())
    except (TypeError, ValueError):
        return ""
    return _IEEE_MONTHS[month - 1] if 1 <= month <= 12 else ""


def _ieee(work: dict, authors: list[dict]) -> list[dict]:
    """Journal: "Venue, vol. X, no. Y, pp. a–b, Mon. Year, doi: …";
    conference paper: "in Proc. Venue, Year, pp. a–b, doi: …"; book
    chapter: the same without "Proc."."""
    title, venue, year = _value(work, "title"), _value(work, "venue"), _value(work, "year")
    pending = work.get("pending") or ""
    kind = work.get("type")
    tail: list[list[dict]] = []
    if venue:
        if kind == "conference-paper" and not venue.casefold().startswith("proc"):
            venue = "Proc. " + venue
        lead = [_seg("in ")] if kind in _IN_TYPES else []
        tail.append(lead + [_seg(venue, italic=True)])
    pages = [_seg("pp. " + _value(work, "pages"))] if _value(work, "pages") else None
    doi = [_seg("doi: " + _value(work, "doi"))] if _value(work, "doi") else None
    if pending:
        tail.append([_seg(_PENDING_LABEL_EN.get(pending, pending))])
    elif kind in _IN_TYPES:
        tail += [part for part in ([_seg(year)] if year else None, pages, doi) if part]
    else:
        for key, label in (("volume", "vol. "), ("issue", "no. ")):
            if _value(work, key):
                tail.append([_seg(label + _value(work, key))])
        when = " ".join(p for p in (_ieee_month(work.get("month")) if year else "", year) if p)
        tail += [part for part in (pages, [_seg(when)] if when else None, doi) if part]
    out = list(authors)
    if authors:
        out.append(_seg(", "))
    if not tail:
        return out + [_seg(f"“{_end(title)}”")]
    out.append(_seg(f"“{title},” "))
    for i, part in enumerate(tail):
        if i:
            out.append(_seg(", "))
        out += part
    return out + [_seg(".")]


def _din(work: dict, authors: list[dict]) -> list[dict]:
    """Journal: "In: Venue Vol (Year), Nr. N, S. a–b"; proceedings and book
    chapters: "In: Venue, Year, S. a–b" (the year without parentheses)."""
    title, venue, year = _value(work, "title"), _value(work, "venue"), _value(work, "year")
    pending = PENDING_LABEL.get(work.get("pending") or "")
    out = authors + [_seg(": ")] if authors else []
    if venue:
        out += [_seg(_end(title) + " In: "), _seg(venue, italic=True)]
        if pending:
            return out + [_seg(f" ({pending})")]
        if work.get("type") in _IN_TYPES:
            if year:
                out.append(_seg(f", {year}"))
        else:
            if _value(work, "volume"):
                out.append(_seg(" " + _value(work, "volume")))
            if year:
                out.append(_seg(f" ({year})"))
            if _value(work, "issue"):
                out.append(_seg(", Nr. " + _value(work, "issue")))
        if _value(work, "pages"):
            out.append(_seg(", S. " + _value(work, "pages")))
    else:
        out.append(_seg(title))
        if pending:
            return out + [_seg(f" ({pending})")]
        if year:
            out.append(_seg(f", {year}"))
    if _value(work, "doi"):
        out.append(_seg(". DOI " + _value(work, "doi")))
    return out


_FORMATTERS = {"apa": _apa, "ieee": _ieee, "din": _din}


def format_entry(work: dict, style: str, own_name: str = "") -> dict:
    """``{"segments": [...], "text": str}`` of ``work`` in ``style``."""
    if style not in _FORMATTERS:
        raise ValueError(f"unknown citation style: {style!r}")
    authors = _author_segments(split_authors(work.get("authors")), style, parse_name(own_name))
    segments = _merge(_FORMATTERS[style](work, authors))
    if segments:
        segments[-1] = {**segments[-1], "text": segments[-1]["text"].rstrip()}
    return {"segments": segments, "text": "".join(s["text"] for s in segments)}


def short_citation(authors: Union[str, Iterable[str], None], year: Optional[str],
                   pending: Optional[str] = None) -> str:
    """The APA 7 in-text form: "Mustermann (2025)", "Schulz & Mustermann
    (2024)", from three authors on "Mustermann et al. (2025)". The box
    "Für die Dissertation" uses the parenthetical/reference form with "&"
    throughout (never "und" — that belongs to running text). Pending works
    say so instead of a year."""
    names = [parse_name(a).last for a in split_authors(authors)]
    names = [n for n in names if n]
    when = PENDING_LABEL.get(pending or "") or (str(year).strip() if year else "") or NO_YEAR
    if not names:
        who = ""
    elif len(names) == 1:
        who = names[0]
    elif len(names) == 2:
        who = names[0] + " & " + names[1]
    else:
        who = names[0] + " et al."
    return f"{who} ({when})".strip()
