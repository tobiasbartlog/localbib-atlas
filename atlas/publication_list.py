"""Publikationsliste (#228) — pure assembly over already-loaded data.

Everything in "Veröffentlicht" (on request also "Eingereicht" and
"Überarbeiten", shown as "eingereicht" / "in Begutachtung"), grouped by year
— newest first, the pending ones in a group of their own on top — and set in
one of the :mod:`atlas.citation_styles`. Data come from the linked library
Item (``paper`` Cite Key → ``resolve``, contract 2.3: volume, issue, pages,
``has_pdf``), else from the frontmatter (title, venue, the co-authors behind
the own name, the year of ``published``).

- :func:`compose` — the API answer: groups with entries (segments, text,
  chips data), counts per selection, the whole list as text, the
  "Für die Dissertation" box (chapter → publications, the existing chapter
  field) and its copyable text.
- :func:`export` — the list as text, ``.bib`` or LaTeX (a section with
  lists). A ``.bib`` entry is keyed by the ``paper`` Cite Key whenever the
  Publication has one (found in the library or not, so ``\\cite`` stays
  valid), else by the Publication id; its fields are rebuilt from the
  library data (else the frontmatter) rather than copied from the core's
  BibTeX entry, which has no volume/issue/pages, puts the PDF's page count
  into ``pages`` and splits authors at ";" while the library stores
  "Family, Given, …".

No I/O: ``resolve(citekey) -> dict | None`` is handed in, nothing is written.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from atlas.citation_styles import (
    PENDING_LABEL,
    format_entry,
    parse_name,
    same_person,
    short_citation,
    split_authors,
)

SELECTIONS = ("all", "journal", "diss")
FORMATS = ("text", "bib", "latex")
PENDING_STATUSES = ("submitted", "in-revision")
CLOSED_STATUSES = ("rejected", "withdrawn")
PENDING_GROUP = "Eingereicht und in Begutachtung"
NO_YEAR_GROUP = "Ohne Jahr"
STYLE_LABEL = {"apa": "APA 7", "ieee": "IEEE", "din": "DIN ISO 690"}

_EXPORT = {
    "text": ("publikationsliste.txt", "text/plain"),
    "bib": ("publikationsliste.bib", "application/x-bibtex"),
    "latex": ("publikationsliste.tex", "application/x-tex"),
}
_BIB_TYPES = {
    "journal-article": ("article", "journal"),
    "conference-paper": ("inproceedings", "booktitle"),
    "book-chapter": ("incollection", "booktitle"),
}

Resolve = Callable[[str], Optional[dict]]


@dataclass
class _Row:
    """One published or pending Publication. ``ref``/``work`` are filled
    (and ``formatted`` set) only when something shows the row."""
    pub: Any
    pending: Optional[str]
    chapters: list = field(default_factory=list)
    ref: Optional[dict] = None
    work: Optional[dict] = None
    formatted: Optional[dict] = None


class _Request:
    """One request's work: a Cite Key is looked up in the library at most
    once, a row is built only for what is shown (list or dissertation box)
    and formatted at most once."""

    def __init__(self, resolve: "Resolve", own_name: str, style: str) -> None:
        self._resolve = resolve
        self._refs: dict[str, Optional[dict]] = {}
        self.own_name = own_name
        self.style = style

    def fill(self, row: "_Row") -> "_Row":
        if row.work is None:
            key = row.pub.paper
            if key:
                if key not in self._refs:
                    self._refs[key] = self._resolve(key)
                row.ref = self._refs[key]
            row.work = work_of(row.pub, row.ref, self.own_name, row.pending)
        return row

    def formatted(self, row: "_Row") -> dict:
        if row.formatted is None:
            row.formatted = format_entry(self.fill(row).work, self.style, self.own_name)
        return row.formatted


# =============================================================================
# Data of one entry
# =============================================================================

def own_and_coauthors(co_authors, own_name: str) -> list[str]:
    """The frontmatter's author list: ``authors`` are the co-authors, the
    own name goes first unless it is already among them."""
    names = [str(a).strip() for a in co_authors or [] if str(a or "").strip()]
    own = (own_name or "").strip()
    if own and not any(same_person(parse_name(own), parse_name(a)) for a in names):
        names = [own] + names
    return names


def _text(value) -> str:
    return str(value).strip() if value not in (None, "") else ""


def work_of(pub, ref: Optional[dict], own_name: str, pending: Optional[str] = None) -> dict:
    """The formatter's work: the library Item's data first, the frontmatter
    for whatever it does not know."""
    ref = ref or {}
    authors = split_authors(ref.get("authors"))
    published = pub.published or ""
    year = _text(ref.get("year")) or published[:4]
    # The library knows no month; the frontmatter date does (IEEE "Mar. 2025").
    month = published[5:7] if len(published) >= 7 and published[:4] == year else ""
    return {
        "title": _text(ref.get("title")) or pub.title,
        "authors": authors or own_and_coauthors(pub.authors, own_name),
        "year": year,
        "month": month,
        "venue": _text(ref.get("journal")) or _text(pub.venue),
        "type": pub.type,
        "volume": _text(ref.get("volume")),
        "issue": _text(ref.get("issue")),
        "pages": _text(ref.get("pages")),
        "doi": _text(ref.get("doi")),
        "pending": pending,
    }


def chapter_links(chapters) -> dict[str, list[dict]]:
    """Publication id → the chapters (number = position in the ordered
    dissertation) that list it — the existing chapter → publications link."""
    links: dict[str, list[dict]] = {}
    for number, chapter in enumerate(chapters, 1):
        for pid in chapter.publications or []:
            entry = {"id": chapter.id, "number": number, "title": chapter.title}
            if entry not in links.setdefault(pid, []):
                links[pid].append(entry)
    return links


def _rows(publications, chapters) -> list[_Row]:
    """Every published or pending Publication — nothing looked up yet."""
    links = chapter_links(chapters)
    rows = []
    for pub in publications:
        if pub.status == "published":
            pending = None
        elif pub.status in PENDING_STATUSES:
            pending = pub.status
        else:
            continue
        rows.append(_Row(pub, pending, links.get(pub.id, [])))
    return rows


def _selected(row: _Row, selection: str) -> bool:
    if selection == "journal":
        return row.pub.type == "journal-article"
    if selection == "diss":
        return bool(row.chapters)
    return True


def _newest_first(rows: list[_Row], date_of: Callable[[_Row], str]) -> list[_Row]:
    rows = sorted(rows, key=lambda r: r.work["title"].casefold())
    return sorted(rows, key=date_of, reverse=True)


def _groups(rows: list[_Row]) -> list[tuple[str, str, list[_Row]]]:
    groups = []
    pending = [r for r in rows if r.pending]
    if pending:
        groups.append(("pending", PENDING_GROUP, _newest_first(pending, lambda r: r.pub.submitted or "")))
    by_year: dict[str, list[_Row]] = {}
    for r in rows:
        if not r.pending:
            by_year.setdefault(r.work["year"], []).append(r)
    for year in sorted((y for y in by_year if y), reverse=True):
        groups.append((year, year, _newest_first(by_year[year], lambda r: r.pub.published or "")))
    if "" in by_year:
        groups.append(("none", NO_YEAR_GROUP, _newest_first(by_year[""], lambda r: r.pub.published or "")))
    return groups


def _entry(row: _Row, req: _Request, number: Optional[int]) -> dict:
    """What the page reads of one entry — nothing more (the chips: PDF,
    chapters, pending)."""
    formatted = req.formatted(row)
    return {
        "id": row.pub.id,
        "title": row.work["title"],
        "number": number,
        "segments": formatted["segments"],
        "text": formatted["text"],
        "pending": row.pending,
        "has_pdf": bool(row.ref and row.ref.get("has_pdf")),
        "chapters": [{"number": c["number"], "title": c["title"]} for c in row.chapters],
    }


# =============================================================================
# The list
# =============================================================================

def _dissertation(publications, chapters, rows: list[_Row], req: _Request,
                  with_submitted: bool) -> tuple[list[dict], str]:
    """"Für die Dissertation": per chapter its own publications (published,
    pending or still "in Arbeit"), and the copyable list of the entries —
    the same formatted entries the list shows."""
    by_id = {p.id: p for p in publications}
    row_of = {r.pub.id: r for r in rows}
    box, blocks = [], []
    for number, chapter in enumerate(chapters, 1):
        items, lines = [], []
        for pid in dict.fromkeys(chapter.publications or []):
            pub = by_id.get(pid)
            if pub is None or pub.status in CLOSED_STATUSES:
                continue
            row = row_of.get(pid)
            if row is None:
                items.append({"id": pid, "state": "open", "short": pub.title})
                continue
            work = req.fill(row).work
            items.append({
                "id": pid, "state": "pending" if row.pending else "published",
                "short": short_citation(work["authors"], work["year"], row.pending),
            })
            if not row.pending or with_submitted:
                lines.append(req.formatted(row)["text"])
        label = f"Kapitel {number} · {chapter.title}"
        if items:
            box.append({"id": chapter.id, "label": label, "items": items})
        if lines:
            blocks.append(label + "\n" + "\n".join(lines))
    return box, "\n\n".join(blocks)


def _listing(rows: list[_Row], req: _Request, selection: str, with_submitted: bool):
    """Counts need no library; only the selected rows are looked up."""
    scope = [r for r in rows if with_submitted or not r.pending]
    counts = {s: sum(1 for r in scope if _selected(r, s)) for s in SELECTIONS}
    groups = _groups([req.fill(r) for r in scope if _selected(r, selection)])
    return counts, groups


def _groups_payload(groups, req: _Request) -> list[dict]:
    n = 0
    out = []
    for key, label, rows in groups:
        entries = []
        for row in rows:
            n += 1
            entries.append(_entry(row, req, n if req.style == "ieee" else None))
        out.append({"key": key, "label": label, "entries": entries})
    return out


def _as_text(groups: list[dict]) -> str:
    blocks = []
    for g in groups:
        lines = [g["label"]] + [
            (f"[{e['number']}] " if e["number"] else "") + e["text"] for e in g["entries"]
        ]
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


def compose(publications, chapters, resolve: Resolve, *, own_name: str = "", style: str = "apa",
            selection: str = "all", with_submitted: bool = False) -> dict:
    """The Publikationsliste as the page shows it."""
    own_name = (own_name or "").strip()
    publications, chapters = list(publications), list(chapters)
    req = _Request(resolve, own_name, style)
    rows = _rows(publications, chapters)
    counts, groups = _listing(rows, req, selection, with_submitted)
    payload = _groups_payload(groups, req)
    box, box_text = _dissertation(publications, chapters, rows, req, with_submitted)
    return {
        "own_name": own_name,
        "counts": counts,
        "groups": payload,
        "text": _as_text(payload),
        "dissertation": box,
        "dissertation_text": box_text,
    }


# =============================================================================
# Exports
# =============================================================================

_TEX = {
    "\\": r"\textbackslash{}", "{": r"\{", "}": r"\}", "&": r"\&", "%": r"\%", "$": r"\$",
    "#": r"\#", "_": r"\_", "~": r"\textasciitilde{}", "^": r"\textasciicircum{}",
    "–": "--", "—": "---", "“": "``", "”": "''",
}
_TEX_RE = re.compile("|".join(re.escape(k) for k in _TEX))


def tex_escape(text: str) -> str:
    """Plain text for LaTeX/BibTeX: special characters escaped, dashes and
    curly quotes as their TeX ligatures, everything else (umlauts) as is."""
    return _TEX_RE.sub(lambda m: _TEX[m.group(0)], text or "")


def _tex_segments(segments: list[dict]) -> str:
    out = []
    for s in segments:
        text = tex_escape(s["text"])
        if s["italic"]:
            text = f"\\textit{{{text}}}"
        if s["bold"]:
            text = f"\\textbf{{{text}}}"
        out.append(text)
    return "".join(out)


def _as_latex(groups: list[dict], style: str) -> str:
    out = [f"% Publikationsliste ({STYLE_LABEL.get(style, style)}), erzeugt von Atlas",
           "\\section*{Publikationen}"]
    if not groups:
        out.append("% Für diese Auswahl gibt es noch keinen Eintrag.")
    for g in groups:
        out += ["", f"\\subsection*{{{tex_escape(g['label'])}}}", "\\begin{itemize}"]
        for e in g["entries"]:
            label = f"[{{[{e['number']}]}}]" if e["number"] else ""
            out.append(f"  \\item{label} {_tex_segments(e['segments'])}")
        out.append("\\end{itemize}")
    return "\n".join(out) + "\n"


def _bib_name(name: str) -> str:
    """One person as "Family, Given"; an organization in braces, so BibTeX
    reads it as one name instead of a family name "Consortium"."""
    n = parse_name(name)
    if n.org:
        return "{" + tex_escape(n.last) + "}"
    return tex_escape(f"{n.last}, {n.given}" if n.given else n.last)


def _bib_entry(row: _Row) -> tuple[str, str]:
    # A linked paper is always keyed by its `paper` Cite Key, found in the
    # library or not, so \cite{…} in the thesis stays valid (the fields then
    # come from the frontmatter); only a Publication without one gets its id.
    key = row.pub.paper or row.pub.id
    kind, venue_field = _BIB_TYPES.get(row.pub.type or "", ("misc", "howpublished"))
    w = row.work
    fields = []
    if w["authors"]:
        # The same parsed list the entry shows (citation_styles.split_authors).
        fields.append(("author", " and ".join(_bib_name(a) for a in w["authors"])))
    fields.append(("title", tex_escape(w["title"])))
    if w["venue"]:
        fields.append((venue_field, tex_escape(w["venue"])))
    if w["year"] and not row.pending:
        fields.append(("year", tex_escape(w["year"])))
    for name, value in (("volume", w["volume"]), ("number", w["issue"]), ("pages", w["pages"])):
        if value and not row.pending:
            fields.append((name, tex_escape(value)))
    if w["doi"]:
        fields.append(("doi", w["doi"]))
    if row.pending:
        fields.append(("note", PENDING_LABEL[row.pending]))
    body = ",\n".join(f"  {name} = {{{value}}}" for name, value in fields)
    return key, f"@{kind}{{{key},\n{body}\n}}"


def _as_bibtex(groups) -> str:
    seen, entries = set(), []
    for _key, _label, rows in groups:
        for row in rows:
            key, text = _bib_entry(row)
            if key not in seen:
                seen.add(key)
                entries.append(text)
    return "\n\n".join(entries) + ("\n" if entries else "")


def export(publications, chapters, resolve: Resolve, fmt: str, *, own_name: str = "",
           style: str = "apa", selection: str = "all", with_submitted: bool = False) -> dict:
    """``{format, filename, mime, content, count}`` of the list as shown."""
    own_name = (own_name or "").strip()
    req = _Request(resolve, own_name, style)
    _counts, groups = _listing(_rows(list(publications), list(chapters)), req, selection, with_submitted)
    if fmt == "bib":
        content = _as_bibtex(groups)
    else:
        payload = _groups_payload(groups, req)
        content = _as_latex(payload, style) if fmt == "latex" else _as_text(payload)
    filename, mime = _EXPORT[fmt]
    return {
        "format": fmt, "filename": filename, "mime": mime, "content": content,
        "count": sum(len(rows) for _k, _l, rows in groups),
    }
