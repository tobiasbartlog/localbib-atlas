"""Atlas domain layer — Idea entity, frontmatter (de)serialisation, validation.

Pure, side-effect-free logic over Markdown-with-YAML-frontmatter. Imports only
stdlib + PyYAML (never the LocalBib core, P3). The Markdown file is the source
of truth (P1); everything here derives from it.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Optional

import yaml

IDEA_SCHEMA = "atlas.idea/2"
IDEA_TYPES = {"paper-idea", "tool-idea", "experiment"}
# v2 (ADR-0004, issue #46): drafting/publishing state lives on the Publication.
# Legacy /1 statuses are mapped by the startup migration (atlas/migration.py).
IDEA_STATUSES = {"seed", "developing", "promoted", "parked"}

_FRONTMATTER_RE = re.compile(r"^---[ \t]*\r?\n(.*?)\r?\n---[ \t]*\r?\n?(.*)$", re.DOTALL)
_HEADING_RE = re.compile(r"^(#{1,6})[ \t]+(.*?)[ \t]*#*$")


# =============================================================================
# Frontmatter & slugs
# =============================================================================

def parse_frontmatter(text: str) -> tuple[dict, str]:
    """Split ``text`` into (frontmatter dict, body). No frontmatter → ({}, text).
    A leading BOM ("UTF-8 mit BOM", Windows PowerShell 5.1) is no content."""
    text = text.removeprefix("\ufeff")
    match = _FRONTMATTER_RE.match(text)
    if not match:
        return {}, text
    raw, body = match.group(1), match.group(2)
    data = yaml.safe_load(raw)
    if data is None:
        data = {}
    if not isinstance(data, dict):
        raise ValueError("Frontmatter ist kein YAML-Mapping")
    return data, body


def serialize(frontmatter: dict, body: str) -> str:
    """Render frontmatter + body back to a Markdown string (stable key order)."""
    fm = yaml.safe_dump(frontmatter, sort_keys=False, allow_unicode=True).strip()
    body = body.strip("\n")
    if body:
        return f"---\n{fm}\n---\n\n{body}\n"
    return f"---\n{fm}\n---\n"


def slugify(text: str) -> str:
    """GitHub-ish heading slug. Keeps unicode word chars (German umlauts)."""
    s = text.strip().lower()
    s = re.sub(r"[^\w\s-]", "", s, flags=re.UNICODE)
    s = re.sub(r"[\s_]+", "-", s, flags=re.UNICODE)
    s = re.sub(r"-+", "-", s).strip("-")
    return s


def section_anchors(body: str) -> list[str]:
    """Slugs of all ATX headings in ``body``, de-duplicated GitHub-style
    (``slug``, ``slug-1``, ``slug-2``). These are the anchors LLM usage hints
    reference (Abschn. 8); stored anchors are revalidated against this list."""
    anchors: list[str] = []
    counts: dict[str, int] = {}
    in_fence = False
    for line in body.splitlines():
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = _HEADING_RE.match(line)
        if not m:
            continue
        base = slugify(m.group(2))
        if not base:
            continue
        n = counts.get(base, 0)
        counts[base] = n + 1
        anchors.append(base if n == 0 else f"{base}-{n}")
    return anchors


# =============================================================================
# Idea entity
# =============================================================================

@dataclass
class Idea:
    id: str
    title: str
    type: str = "paper-idea"
    status: str = "seed"
    tags: list[str] = field(default_factory=list)
    refs: list[str] = field(default_factory=list)
    diss: list[str] = field(default_factory=list)
    venue: Optional[str] = None
    created: Optional[str] = None
    updated: Optional[str] = None
    body: str = ""
    path: Optional[str] = None  # derived: source file path, not persisted in frontmatter

    @property
    def anchors(self) -> list[str]:
        return section_anchors(self.body)

    @property
    def content_hash(self) -> str:
        """Hash of the serialised file content — used to invalidate the index."""
        return hashlib.sha256(self.to_markdown().encode("utf-8")).hexdigest()

    @classmethod
    def from_markdown(cls, text: str, *, id_hint: Optional[str] = None) -> "Idea":
        """Tolerant parse: builds an Idea best-effort so the indexer can record
        even an invalid file (validation is reported separately, never rejected)."""
        fm, body = parse_frontmatter(text)
        return cls(
            id=str(fm.get("id") or id_hint or ""),
            title=str(fm.get("title") or ""),
            type=str(fm.get("type") or "paper-idea"),
            status=str(fm.get("status") or "seed"),
            tags=list(fm.get("tags") or []),
            refs=list(fm.get("refs") or []),
            diss=list(fm.get("diss") or []),
            venue=fm.get("venue"),
            created=_as_str(fm.get("created")),
            updated=_as_str(fm.get("updated")),
            # Strip the blank line that serialize() puts between frontmatter and
            # body, so to_markdown()->from_markdown() is stable (content_hash,
            # watcher re-index). Internal blank lines are preserved.
            body=body.strip("\n"),
        )

    @classmethod
    def from_file(cls, path) -> "Idea":
        p = Path(path)
        idea = cls.from_markdown(p.read_text(encoding="utf-8"), id_hint=p.stem)
        idea.path = str(p)
        return idea

    def to_frontmatter(self) -> dict:
        """Frontmatter dict in canonical order; optional empties omitted."""
        fm: dict = {
            "schema": IDEA_SCHEMA,
            "id": self.id,
            "title": self.title,
            "type": self.type,
            "status": self.status,
        }
        if self.tags:
            fm["tags"] = list(self.tags)
        if self.refs:
            fm["refs"] = list(self.refs)
        if self.diss:
            fm["diss"] = list(self.diss)
        if self.venue:
            fm["venue"] = self.venue
        if self.created:
            fm["created"] = self.created
        if self.updated:
            fm["updated"] = self.updated
        return fm

    def to_markdown(self) -> str:
        return serialize(self.to_frontmatter(), self.body)

    def to_dict(self) -> dict:
        """Wire form for the API/SPA. Includes derived anchors and source path."""
        return {
            "id": self.id,
            "title": self.title,
            "type": self.type,
            "status": self.status,
            "tags": list(self.tags),
            "refs": list(self.refs),
            "diss": list(self.diss),
            "venue": self.venue,
            "created": self.created,
            "updated": self.updated,
            "body": self.body,
            "anchors": self.anchors,
            "path": self.path,
        }

    def validate(self) -> list[str]:
        """Structural problems with this idea. Empty list == valid. Hanging refs
        are NOT checked here (they need the library) — see store.check()."""
        return _validate_frontmatter(self.to_frontmatter(), stem=_stem(self.path))


def _validate_frontmatter(fm: dict, *, stem: Optional[str] = None) -> list[str]:
    errors: list[str] = []
    if fm.get("schema") != IDEA_SCHEMA:
        errors.append(f"schema muss '{IDEA_SCHEMA}' sein (ist {fm.get('schema')!r})")
    for required in ("id", "title", "type", "status"):
        if not fm.get(required):
            errors.append(f"Pflichtfeld fehlt: {required}")
    t = fm.get("type")
    if t and t not in IDEA_TYPES:
        errors.append(f"type ungueltig: {t!r} (erlaubt: {sorted(IDEA_TYPES)})")
    s = fm.get("status")
    if s and s not in IDEA_STATUSES:
        errors.append(f"status ungueltig: {s!r} (erlaubt: {sorted(IDEA_STATUSES)})")
    if stem is not None and fm.get("id") and fm["id"] != stem:
        errors.append(f"id '{fm['id']}' != Dateiname '{stem}' (IDs sind dateilokal, unveraenderlich)")
    return errors


def make_idea_id(title: str, *, today: Optional[date] = None) -> str:
    """Quick-capture id: ``YYYY-MM-DD-<title-slug>`` (P5)."""
    today = today or date.today()
    return f"{today.isoformat()}-{slugify(title)}".rstrip("-")


def new_idea(title: str, *, today: Optional[date] = None, **fields) -> Idea:
    """Minimal idea from a title (P5: title is the only required field)."""
    today = today or date.today()
    iso = today.isoformat()
    return Idea(
        id=make_idea_id(title, today=today),
        title=title,
        created=iso,
        updated=iso,
        **fields,
    )


# =============================================================================
# Dissertation chapter entity (Abschn. 4.2; ADR-0005, issue #57)
# =============================================================================
# v3 (ADR-0005): the dissertation is a FLAT, ordered list of Kapitel. The free
# tree of atlas.dissnode/2 (kind/parent, arbitrary nesting) is retired — a
# cumulative dissertation is structurally linear. A chapter keeps ``order``,
# ``status``, ``publications`` and a Markdown ``body`` that doubles as LLM
# context. Legacy /1|/2 files stay readable (tolerant parse: kind/parent are
# ignored); the startup migration (atlas/migration.py) flattens the tree
# depth-first into ``order`` and rewrites the files as /3.

DISSNODE_SCHEMA = "atlas.dissnode/3"
DISSNODE_STATUSES = {"planned", "in-progress", "submitted", "published"}


@dataclass
class DissNode:
    id: str
    title: str
    order: int = 0
    status: str = "planned"
    publications: list[str] = field(default_factory=list)
    body: str = ""
    path: Optional[str] = None

    @property
    def content_hash(self) -> str:
        return hashlib.sha256(self.to_markdown().encode("utf-8")).hexdigest()

    @classmethod
    def from_markdown(cls, text: str, *, id_hint: Optional[str] = None) -> "DissNode":
        # Tolerant parse: legacy /1|/2 files (with kind/parent, and /1 with
        # paper_ref) stay readable — the retired keys are ignored here; the
        # migration flattens and rewrites them.
        fm, body = parse_frontmatter(text)
        return cls(
            id=str(fm.get("id") or id_hint or ""),
            title=str(fm.get("title") or ""),
            order=_as_int(fm.get("order")),
            status=str(fm.get("status") or "planned"),
            publications=[str(p) for p in (fm.get("publications") or [])],
            body=body.strip("\n"),
        )

    @classmethod
    def from_file(cls, path) -> "DissNode":
        p = Path(path)
        node = cls.from_markdown(p.read_text(encoding="utf-8"), id_hint=p.stem)
        node.path = str(p)
        return node

    def to_frontmatter(self) -> dict:
        fm: dict = {
            "schema": DISSNODE_SCHEMA,
            "id": self.id,
            "title": self.title,
            "order": self.order,
            "status": self.status,
        }
        if self.publications:
            fm["publications"] = list(self.publications)
        return fm

    def to_markdown(self) -> str:
        return serialize(self.to_frontmatter(), self.body)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "order": self.order,
            "status": self.status,
            "publications": list(self.publications),
            "body": self.body,
            "path": self.path,
        }

    def validate(self) -> list[str]:
        errors: list[str] = []
        fm = self.to_frontmatter()
        if fm["schema"] != DISSNODE_SCHEMA:
            errors.append(f"schema muss '{DISSNODE_SCHEMA}' sein")
        for required in ("id", "title", "status"):
            if not fm.get(required):
                errors.append(f"Pflichtfeld fehlt: {required}")
        if self.status and self.status not in DISSNODE_STATUSES:
            errors.append(f"status ungueltig: {self.status!r} (erlaubt: {sorted(DISSNODE_STATUSES)})")
        stem = _stem(self.path)
        if stem is not None and self.id and self.id != stem:
            errors.append(f"id '{self.id}' != Dateiname '{stem}'")
        return errors


def diss_progress(nodes: list["DissNode"]) -> dict:
    """Progress summary for the dissertation page header (ADR-0005, issue #57).
    Pure function over the flat chapter list. ``with_body`` counts chapters
    whose Markdown body is non-empty (so they carry LLM context); ``with_
    publications`` counts chapters linking at least one own Publication."""
    total = len(nodes)
    with_body = sum(1 for n in nodes if (n.body or "").strip())
    with_publications = sum(1 for n in nodes if n.publications)
    by_status: dict[str, int] = {}
    for n in nodes:
        by_status[n.status] = by_status.get(n.status, 0) + 1
    return {
        "total": total,
        "with_body": with_body,
        "with_publications": with_publications,
        "by_status": by_status,
    }


# =============================================================================
# Research Project entity (ADR-0004, schemas/atlas.project-5.json)
# =============================================================================
# Beware: atlas.project/3 is a DIFFERENT entity than /1|/2 — those are legacy
# Publications and are converted by the startup migration (atlas/migration.py).

PROJECT_SCHEMA = "atlas.project/5"
# /4 (ADR-0022, issue #205): optional ``collection_id`` + ``kind`` — the Atlas
# side of a core Collection. /5: optional ``history`` (the Verlauf, see
# :func:`record_history`). /3 and /4 files stay readable and are written as /5
# on their next save.
PROJECT_STATUSES = {"planned", "applied", "active", "finished", "rejected"}

_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_CHECKLIST_RE = re.compile(r"^\s*[-*]\s+\[([ xX])\]\s+(.*)$")


# =============================================================================
# Verlauf (history) — Publication and Project
# =============================================================================

def normalize_history_entry(raw) -> dict:
    """Coerce one ``history`` entry to ``{date, status, venue}`` (venue may be
    None). Tolerant like the entity parsers; validation reports problems."""
    if not isinstance(raw, dict):
        return {"date": None, "status": _as_str(raw) or "", "venue": None}
    venue = raw.get("venue")
    return {
        "date": _as_str(raw.get("date")),
        "status": str(raw.get("status") or ""),
        "venue": str(venue) if venue else None,
    }


def record_history(history: list, status: str, today: date, venue: Optional[str] = None) -> list[dict]:
    """The Verlauf after a status change: the old entries plus one for
    ``status`` on ``today`` (with the venue it happened at, if any). Pure —
    returns a new list, the caller persists it."""
    entry = {"date": today.isoformat(), "status": status, "venue": venue or None}
    return [normalize_history_entry(e) for e in history] + [entry]


def _history_frontmatter(history: list) -> list[dict]:
    out = []
    for raw in history:
        e = normalize_history_entry(raw)
        item: dict = {"date": e["date"], "status": e["status"]}
        if e["venue"]:
            item["venue"] = e["venue"]
        out.append(item)
    return out


def _history_errors(history: list, statuses) -> list[str]:
    errors: list[str] = []
    for i, raw in enumerate(history):
        e = normalize_history_entry(raw)
        if not e["date"] or not _ISO_DATE_RE.match(e["date"]):
            errors.append(f"Verlauf {i + 1}: date ist kein ISO-Datum (YYYY-MM-DD): {e['date']!r}")
        if e["status"] not in statuses:
            errors.append(f"Verlauf {i + 1}: status ungueltig: {e['status']!r}")
    return errors


def _scan_lines(body: str):
    """Yield ``(line, fenced)`` pairs; fence delimiters count as fenced."""
    in_fence = False
    for line in body.splitlines():
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            yield line, True
            continue
        yield line, in_fence


def parse_sections(body: str) -> list[dict]:
    """Split a Markdown body into work-package sections and evaluate the GFM
    checklist per section (issue #48). Pure, fence-aware.

    Sections split at the *topmost* heading level present in the body (so both
    ``## AP1 …`` and ``# AP1 …`` conventions work); deeper headings stay inside
    their enclosing section, i.e. an AP keeps the tasks of its sub-headings.
    Text before the first heading becomes a title-less preamble section
    (``title: None``), included only when it contains checklist items.

    Returns ``[{title, level, items: [{text, done}], done, total}]`` in
    document order — the flat concatenation of all ``items`` equals
    :func:`parse_checklist`'s item list (the toggle index contract)."""
    lines = list(_scan_lines(body))
    top: Optional[int] = None
    for line, fenced in lines:
        if fenced:
            continue
        m = _HEADING_RE.match(line)
        if m and (top is None or len(m.group(1)) < top):
            top = len(m.group(1))

    sections: list[dict] = []
    current: dict = {"title": None, "level": None, "items": []}
    for line, fenced in lines:
        if fenced:
            continue
        m = _HEADING_RE.match(line)
        if m and len(m.group(1)) == top:
            sections.append(current)
            current = {"title": m.group(2).strip(), "level": top, "items": []}
            continue
        cm = _CHECKLIST_RE.match(line)
        if cm:
            current["items"].append(
                {"text": cm.group(2).strip(), "done": cm.group(1).lower() == "x"}
            )
    sections.append(current)

    out: list[dict] = []
    for s in sections:
        if s["title"] is None and not s["items"]:
            continue  # empty preamble — only checklist-bearing preambles count
        done = sum(1 for it in s["items"] if it["done"])
        out.append({**s, "done": done, "total": len(s["items"])})
    return out


def parse_checklist(body: str) -> dict:
    """Parse GFM task-list items from a project body (fence-aware).
    Returns ``{items: [{text, done}], done: int, total: int}``.

    Derived from :func:`parse_sections` — item order is document order across
    all sections; the toggle endpoint indexes into this flat list."""
    items = [it for s in parse_sections(body) for it in s["items"]]
    done = sum(1 for it in items if it["done"])
    return {"items": items, "done": done, "total": len(items)}


def normalize_milestone(raw) -> dict:
    """Coerce one frontmatter milestone entry to ``{title, date, done}``.
    Tolerant like the entity parsers: a bare string becomes a title-only
    milestone; validation reports problems separately."""
    if not isinstance(raw, dict):
        return {"title": _as_str(raw) or "", "date": None, "done": False}
    return {
        "title": str(raw.get("title") or ""),
        "date": _as_str(raw.get("date")),
        "done": bool(raw.get("done")),
    }


def annotate_milestones(milestones: list[dict], *, today: Optional[date] = None) -> list[dict]:
    """Timeline view of the milestones (pure). Each entry gets:

    - ``index``: position in the frontmatter list (stable handle for edits),
    - ``state``: ``done`` | ``overdue`` | ``upcoming`` | ``undated``,
    - ``next``: True on the earliest upcoming milestone.

    Returned in timeline order: dated milestones chronologically, undated last."""
    today_iso = (today or date.today()).isoformat()
    annotated: list[dict] = []
    for index, raw in enumerate(milestones):
        m = normalize_milestone(raw)
        valid_date = m["date"] if m["date"] and _ISO_DATE_RE.match(m["date"]) else None
        if m["done"]:
            state = "done"
        elif valid_date is None:
            state = "undated"
        elif valid_date < today_iso:
            state = "overdue"
        else:
            state = "upcoming"
        annotated.append({**m, "index": index, "state": state, "next": False})
    annotated.sort(key=lambda m: (m["date"] is None, m["date"] or "", m["index"]))
    upcoming = [m for m in annotated if m["state"] == "upcoming"]
    if upcoming:
        upcoming[0]["next"] = True
    return annotated


@dataclass
class Project:
    """A research project / Forschungsprojekt (projekte/*.md), ADR-0004.

    NOT the bibliography/publication entity that atlas.project/1|2 used to be
    (that is :class:`Publication` now). Publications originating from the
    project are found by reverse lookup of the Publications' ``projects``
    field — the link is stored downstream (on the Publication)."""

    id: str
    title: str
    status: str = "planned"
    start: Optional[str] = None
    end: Optional[str] = None
    funder: Optional[str] = None
    grant_id: Optional[str] = None
    role: Optional[str] = None
    tags: list[str] = field(default_factory=list)
    refs: list[str] = field(default_factory=list)
    milestones: list[dict] = field(default_factory=list)
    history: list[dict] = field(default_factory=list)
    body: str = ""
    path: Optional[str] = None
    # Collection entry (atlas.project/4, ADR-0022): the core Collection whose
    # Items are this project's literature. ``collection`` is derived at read
    # time (atlas/collection_entries.py) and never persisted.
    collection_id: Optional[int] = None
    kind: Optional[str] = None
    collection: Optional[dict] = None

    @property
    def checklist(self) -> dict:
        return parse_checklist(self.body)

    @property
    def sections(self) -> list[dict]:
        """Work packages: per-heading checklist stats (issue #48), derived."""
        return parse_sections(self.body)

    @property
    def content_hash(self) -> str:
        return hashlib.sha256(self.to_markdown().encode("utf-8")).hexdigest()

    @classmethod
    def from_markdown(cls, text: str, *, id_hint: Optional[str] = None) -> "Project":
        """Tolerant parse (like Idea): invalid files still index, validation is
        reported separately."""
        fm, body = parse_frontmatter(text)
        return cls(
            id=str(fm.get("id") or id_hint or ""),
            title=str(fm.get("title") or ""),
            status=str(fm.get("status") or "planned"),
            start=_as_str(fm.get("start")),
            end=_as_str(fm.get("end")),
            funder=fm.get("funder") if fm.get("funder") else None,
            grant_id=_as_str(fm.get("grant_id")) if fm.get("grant_id") else None,
            role=fm.get("role") if fm.get("role") else None,
            tags=list(fm.get("tags") or []),
            refs=[str(r) for r in (fm.get("refs") or [])],
            milestones=[normalize_milestone(m) for m in (fm.get("milestones") or [])],
            history=[normalize_history_entry(h) for h in (fm.get("history") or [])],
            body=body.strip("\n"),
            collection_id=_as_collection_id(fm.get("collection_id")),
            kind=str(fm["kind"]) if fm.get("kind") else None,
        )

    @classmethod
    def from_file(cls, path) -> "Project":
        p = Path(path)
        project = cls.from_markdown(p.read_text(encoding="utf-8"), id_hint=p.stem)
        project.path = str(p)
        return project

    def to_frontmatter(self) -> dict:
        """Frontmatter dict in canonical order; optional empties omitted."""
        fm: dict = {
            "schema": PROJECT_SCHEMA,
            "id": self.id,
            "title": self.title,
            "status": self.status,
        }
        _collection_frontmatter(fm, self.collection_id, self.kind)
        if self.start:
            fm["start"] = self.start
        if self.end:
            fm["end"] = self.end
        if self.funder:
            fm["funder"] = self.funder
        if self.grant_id:
            fm["grant_id"] = self.grant_id
        if self.role:
            fm["role"] = self.role
        if self.tags:
            fm["tags"] = list(self.tags)
        if self.refs and self.collection_id is None:
            # A Collection entry's literature is the Collection — never a
            # copy in the file (ADR-0022).
            fm["refs"] = list(self.refs)
        if self.milestones:
            fm["milestones"] = [
                _milestone_frontmatter(normalize_milestone(m)) for m in self.milestones
            ]
        if self.history:
            fm["history"] = _history_frontmatter(self.history)
        return fm

    def to_markdown(self) -> str:
        return serialize(self.to_frontmatter(), self.body)

    def to_dict(self) -> dict:
        cl = self.checklist
        return {
            "id": self.id,
            "title": self.title,
            "status": self.status,
            "start": self.start,
            "end": self.end,
            "funder": self.funder,
            "grant_id": self.grant_id,
            "role": self.role,
            "tags": list(self.tags),
            "refs": list(self.refs),
            "milestones": [normalize_milestone(m) for m in self.milestones],
            "history": [normalize_history_entry(h) for h in self.history],
            "body": self.body,
            "path": self.path,
            "checklist": cl,
            "sections": self.sections,
            "progress": (cl["done"] / cl["total"]) if cl["total"] else None,
            "collection_id": self.collection_id,
            "kind": self.kind,
            "collection": self.collection,
        }

    def validate(self) -> list[str]:
        """Structural problems (mirrors schemas/atlas.project-5.json). Empty
        list == valid. Hanging refs need the library — see store.check()."""
        errors: list[str] = []
        fm = self.to_frontmatter()
        if fm["schema"] != PROJECT_SCHEMA:
            errors.append(f"schema muss '{PROJECT_SCHEMA}' sein")
        errors.extend(_collection_errors(self.collection_id, self.kind, "project"))
        for required in ("id", "title", "status"):
            if not fm.get(required):
                errors.append(f"Pflichtfeld fehlt: {required}")
        if self.status and self.status not in PROJECT_STATUSES:
            errors.append(f"status ungueltig: {self.status!r} (erlaubt: {sorted(PROJECT_STATUSES)})")
        for label, value in (("start", self.start), ("end", self.end)):
            if value and not _ISO_DATE_RE.match(value):
                errors.append(f"{label} ist kein ISO-Datum (YYYY-MM-DD): {value!r}")
        for i, raw in enumerate(self.milestones):
            m = normalize_milestone(raw)
            if not m["title"]:
                errors.append(f"Meilenstein {i + 1}: Pflichtfeld fehlt: title")
            if m["date"] and not _ISO_DATE_RE.match(m["date"]):
                errors.append(
                    f"Meilenstein {i + 1}: date ist kein ISO-Datum (YYYY-MM-DD): {m['date']!r}"
                )
        errors.extend(_history_errors(self.history, PROJECT_STATUSES))
        stem = _stem(self.path)
        if stem is not None and self.id and self.id != stem:
            errors.append(f"id '{self.id}' != Dateiname '{stem}'")
        return errors


def _milestone_frontmatter(m: dict) -> dict:
    """Milestone in canonical frontmatter form: optional empties omitted, so
    from_markdown(to_markdown()) is stable (content_hash, watcher re-index)."""
    fm: dict = {"title": m["title"]}
    if m["date"]:
        fm["date"] = m["date"]
    if m["done"]:
        fm["done"] = True
    return fm


def make_project_id(title: str) -> str:
    return slugify(title)


def new_project(title: str, **fields) -> Project:
    """Minimal research project from a title (P5: title is the only required field)."""
    return Project(id=make_project_id(title), title=title, **fields)


# =============================================================================
# Publication entity (ADR-0004, schemas/atlas.publication-3.json)
# =============================================================================

PUBLICATION_SCHEMA = "atlas.publication/3"
# /2 (ADR-0022, issue #205): optional ``collection_id`` + ``kind`` — the Atlas
# side of a core Collection. /3: optional ``history`` (the Verlauf, every
# status change with its date and venue). /1 and /2 files stay readable and
# are written as /3 on their next save.
# The one list of a Publication's states, in the Pipeline's order (#225): its
# five columns, then the two folded away below. pipeline and agenda derive
# from these, never re-declare them.
PUBLICATION_PIPELINE_STATUSES = ("planned", "drafting", "submitted", "in-revision", "published")
PUBLICATION_CLOSED_STATUSES = ("rejected", "withdrawn")
PUBLICATION_STATUSES = frozenset(PUBLICATION_PIPELINE_STATUSES + PUBLICATION_CLOSED_STATUSES)
PUBLICATION_TYPES = {"journal-article", "conference-paper", "book-chapter", "other"}


@dataclass
class Publication:
    """One of the user's own publications (veroeffentlichungen/*.md).

    Successor of the former Atlas Project entity (ADR-0004). Links are stored
    downstream → upstream: ``projects`` (research projects), ``derived_from``
    (ideas), ``manuscripts`` (.tex names), ``paper`` (cite-key self-link).
    Hanging links are warnings, never auto-repaired (store.check())."""

    id: str
    title: str
    status: str = "planned"
    venue: Optional[str] = None
    type: Optional[str] = None
    authors: list[str] = field(default_factory=list)
    submitted: Optional[str] = None
    published: Optional[str] = None
    due: Optional[str] = None
    tags: list[str] = field(default_factory=list)
    refs: list[str] = field(default_factory=list)
    derived_from: list[str] = field(default_factory=list)
    manuscripts: list[str] = field(default_factory=list)
    projects: list[str] = field(default_factory=list)
    paper: Optional[str] = None
    history: list[dict] = field(default_factory=list)
    body: str = ""
    path: Optional[str] = None
    # Collection entry (atlas.publication/2, ADR-0022): the core Collection
    # whose Items are this publication's bibliography. ``collection`` is
    # derived at read time (atlas/collection_entries.py), never persisted.
    collection_id: Optional[int] = None
    kind: Optional[str] = None
    collection: Optional[dict] = None

    @property
    def content_hash(self) -> str:
        return hashlib.sha256(self.to_markdown().encode("utf-8")).hexdigest()

    @classmethod
    def from_markdown(cls, text: str, *, id_hint: Optional[str] = None) -> "Publication":
        """Tolerant parse (like Idea): invalid files still index, validation is
        reported separately."""
        fm, body = parse_frontmatter(text)
        return cls(
            id=str(fm.get("id") or id_hint or ""),
            title=str(fm.get("title") or ""),
            status=str(fm.get("status") or "planned"),
            venue=fm.get("venue") if fm.get("venue") else None,
            type=fm.get("type") if fm.get("type") else None,
            authors=[str(a) for a in (fm.get("authors") or [])],
            submitted=_as_str(fm.get("submitted")),
            published=_as_str(fm.get("published")),
            due=_as_str(fm.get("due")),
            tags=list(fm.get("tags") or []),
            refs=[str(r) for r in (fm.get("refs") or [])],
            derived_from=list(fm.get("derived_from") or []),
            manuscripts=[str(m) for m in (fm.get("manuscripts") or [])],
            projects=list(fm.get("projects") or []),
            paper=fm.get("paper") if fm.get("paper") else None,
            history=[normalize_history_entry(h) for h in (fm.get("history") or [])],
            body=body.strip("\n"),
            collection_id=_as_collection_id(fm.get("collection_id")),
            kind=str(fm["kind"]) if fm.get("kind") else None,
        )

    @classmethod
    def from_file(cls, path) -> "Publication":
        p = Path(path)
        pub = cls.from_markdown(p.read_text(encoding="utf-8"), id_hint=p.stem)
        pub.path = str(p)
        return pub

    def to_frontmatter(self) -> dict:
        """Frontmatter dict in canonical order; optional empties omitted."""
        fm: dict = {
            "schema": PUBLICATION_SCHEMA,
            "id": self.id,
            "title": self.title,
            "status": self.status,
        }
        _collection_frontmatter(fm, self.collection_id, self.kind)
        if self.venue:
            fm["venue"] = self.venue
        if self.type:
            fm["type"] = self.type
        if self.authors:
            fm["authors"] = list(self.authors)
        if self.submitted:
            fm["submitted"] = self.submitted
        if self.published:
            fm["published"] = self.published
        if self.due:
            fm["due"] = self.due
        if self.tags:
            fm["tags"] = list(self.tags)
        if self.refs and self.collection_id is None:
            # A Collection entry's bibliography is the Collection — never a
            # copy in the file (ADR-0022).
            fm["refs"] = list(self.refs)
        if self.derived_from:
            fm["derived_from"] = list(self.derived_from)
        if self.manuscripts:
            fm["manuscripts"] = list(self.manuscripts)
        if self.projects:
            fm["projects"] = list(self.projects)
        if self.paper:
            fm["paper"] = self.paper
        if self.history:
            fm["history"] = _history_frontmatter(self.history)
        return fm

    def to_markdown(self) -> str:
        return serialize(self.to_frontmatter(), self.body)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "status": self.status,
            "venue": self.venue,
            "type": self.type,
            "authors": list(self.authors),
            "submitted": self.submitted,
            "published": self.published,
            "due": self.due,
            "tags": list(self.tags),
            "refs": list(self.refs),
            "derived_from": list(self.derived_from),
            "manuscripts": list(self.manuscripts),
            "projects": list(self.projects),
            "paper": self.paper,
            "history": [normalize_history_entry(h) for h in self.history],
            "body": self.body,
            "path": self.path,
            "collection_id": self.collection_id,
            "kind": self.kind,
            "collection": self.collection,
            # Derived (#225): the body's checklist progress — in the pipeline
            # the reviewer points of a publication in revision.
            "checklist": {k: v for k, v in parse_checklist(self.body).items() if k != "items"},
        }

    def validate(self) -> list[str]:
        """Structural problems (mirrors schemas/atlas.publication-3.json). Empty
        list == valid. Hanging refs/links need the library/archive — store.check()."""
        errors: list[str] = []
        fm = self.to_frontmatter()
        if fm["schema"] != PUBLICATION_SCHEMA:
            errors.append(f"schema muss '{PUBLICATION_SCHEMA}' sein")
        errors.extend(_collection_errors(self.collection_id, self.kind, "publication"))
        for required in ("id", "title", "status"):
            if not fm.get(required):
                errors.append(f"Pflichtfeld fehlt: {required}")
        if self.status and self.status not in PUBLICATION_STATUSES:
            errors.append(f"status ungueltig: {self.status!r} (erlaubt: {sorted(PUBLICATION_STATUSES)})")
        if self.type and self.type not in PUBLICATION_TYPES:
            errors.append(f"type ungueltig: {self.type!r} (erlaubt: {sorted(PUBLICATION_TYPES)})")
        errors.extend(_history_errors(self.history, PUBLICATION_STATUSES))
        stem = _stem(self.path)
        if stem is not None and self.id and self.id != stem:
            errors.append(f"id '{self.id}' != Dateiname '{stem}'")
        return errors


def make_publication_id(title: str) -> str:
    return slugify(title)


def new_publication(title: str, **fields) -> Publication:
    """Minimal publication from a title (P5: title is the only required field)."""
    return Publication(id=make_publication_id(title), title=title, **fields)


def publication_from_idea(idea: Idea) -> Publication:
    """Promote (ADR-0004, issue #46): a Publication seeded from an Idea.

    Pure function — copies refs, tags and body as a starting point and links
    back via ``derived_from``. The caller persists both sides (the idea file
    stays in place with status ``promoted``, P1)."""
    return Publication(
        id=make_publication_id(idea.title),
        title=idea.title,
        status="planned",
        tags=list(idea.tags),
        refs=list(idea.refs),
        derived_from=[idea.id],
        body=idea.body,
    )


# =============================================================================
# helpers
# =============================================================================

def _as_collection_id(value) -> Optional[int]:
    """``collection_id`` from frontmatter: a positive int, else None (tolerant
    parse — a broken value simply makes the file a normal entity)."""
    if isinstance(value, bool):
        return None
    try:
        cid = int(value)
    except (TypeError, ValueError):
        return None
    return cid if cid > 0 else None


def _collection_frontmatter(fm: dict, collection_id: Optional[int], kind: Optional[str]) -> None:
    """Append the Collection link (ADR-0022) right after the core fields."""
    if collection_id is not None:
        fm["collection_id"] = collection_id
        if kind:
            fm["kind"] = kind


def _collection_errors(collection_id: Optional[int], kind: Optional[str], expected: str) -> list[str]:
    if kind and kind != expected:
        return [f"kind ungueltig: {kind!r} (in diesem Ordner nur {expected!r})"]
    return []


def _as_int(value) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _as_str(value) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


def _stem(path: Optional[str]) -> Optional[str]:
    return Path(path).stem if path else None
