"""Atlas Zettel — the knowledge entity of the Werkbank (issue #180).

Pure, side-effect-free; stdlib + PyYAML only (P3). A Zettel is a Markdown file
in ``zettel/`` (``atlas.zettel/1``): Lektuere, Besprechung, Methode,
Entscheidung, Fluechtiges, Rueckblick. Deliberately **not** called "Notiz" —
Notizen are the core's per-paper notes. P5: the title is the only required
field; ``refs`` are Paper cite keys, and every ``[[id]]`` in the body is a
Verweis the indexer turns into an edge (ADR-0020).
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Optional

from atlas.domain import Idea, make_idea_id, parse_frontmatter, section_anchors, serialize, slugify
from atlas.links import extract_wikilinks

ZETTEL_SCHEMA = "atlas.zettel/1"
ZETTEL_TYPES = {"reading", "meeting", "method", "decision", "fleeting", "review"}
ZETTEL_DEFAULT_TYPE = "fleeting"


def _iso_or_none(value) -> Optional[str]:
    """YAML gives a ``date`` for an unquoted ISO date — normalise both forms."""
    if value is None or value == "":
        return None
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


@dataclass
class Zettel:
    id: str
    title: str
    type: str = ZETTEL_DEFAULT_TYPE
    date: Optional[str] = None
    refs: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    promoted_to: Optional[str] = None
    body: str = ""
    path: Optional[str] = None

    @property
    def anchors(self) -> list[str]:
        """Heading slugs of the body (same meaning as on an Idea)."""
        return section_anchors(self.body)

    @property
    def links(self) -> list[str]:
        """Verweise: every ``[[id]]`` of the body, de-duplicated, in order."""
        return extract_wikilinks(self.body)

    @property
    def content_hash(self) -> str:
        return hashlib.sha256(self.to_markdown().encode("utf-8")).hexdigest()

    @classmethod
    def from_markdown(cls, text: str, *, id_hint: Optional[str] = None) -> "Zettel":
        """Tolerant parse (like Idea): an invalid file still indexes,
        validation is reported separately."""
        fm, body = parse_frontmatter(text)
        return cls(
            id=str(fm.get("id") or id_hint or ""),
            title=str(fm.get("title") or ""),
            type=str(fm.get("type") or ZETTEL_DEFAULT_TYPE),
            date=_iso_or_none(fm.get("date")),
            refs=[str(r) for r in (fm.get("refs") or [])],
            tags=[str(t) for t in (fm.get("tags") or [])],
            promoted_to=str(fm["promoted_to"]) if fm.get("promoted_to") else None,
            body=body.strip("\n"),
        )

    @classmethod
    def from_file(cls, path) -> "Zettel":
        p = Path(path)
        zettel = cls.from_markdown(p.read_text(encoding="utf-8"), id_hint=p.stem)
        zettel.path = str(p)
        return zettel

    def to_frontmatter(self) -> dict:
        fm: dict = {
            "schema": ZETTEL_SCHEMA,
            "id": self.id,
            "title": self.title,
            "type": self.type,
        }
        if self.date:
            fm["date"] = self.date
        if self.refs:
            fm["refs"] = list(self.refs)
        if self.tags:
            fm["tags"] = list(self.tags)
        if self.promoted_to:
            fm["promoted_to"] = self.promoted_to
        return fm

    def to_markdown(self) -> str:
        return serialize(self.to_frontmatter(), self.body)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "type": self.type,
            "date": self.date,
            "refs": list(self.refs),
            "tags": list(self.tags),
            "promoted_to": self.promoted_to,
            "body": self.body,
            "anchors": self.anchors,
            "links": self.links,
            "path": self.path,
        }

    def validate(self) -> list[str]:
        """Structural problems (mirrors ``schemas/atlas.zettel-1.json``).
        Hanging refs/links need the library/index — see store.check()."""
        errors: list[str] = []
        fm = self.to_frontmatter()
        if fm["schema"] != ZETTEL_SCHEMA:
            errors.append(f"schema muss '{ZETTEL_SCHEMA}' sein")
        for required in ("id", "title"):
            if not fm.get(required):
                errors.append(f"Pflichtfeld fehlt: {required}")
        if self.type and self.type not in ZETTEL_TYPES:
            errors.append(f"type ungueltig: {self.type!r} (erlaubt: {sorted(ZETTEL_TYPES)})")
        if self.date:
            try:
                date.fromisoformat(self.date)
            except ValueError:
                errors.append(f"date ist kein ISO-Datum (YYYY-MM-DD): {self.date!r}")
        stem = Path(self.path).stem if self.path else None
        if stem is not None and self.id and self.id != stem:
            errors.append(f"id '{self.id}' != Dateiname '{stem}'")
        return errors


def make_zettel_id(title: str, *, today: Optional[date] = None) -> str:
    """Quick-capture id: ``YYYY-MM-DD-<title-slug>`` (like an Idea, P5)."""
    today = today or date.today()
    return f"{today.isoformat()}-{slugify(title)}".rstrip("-")


def new_zettel(title: str, *, today: Optional[date] = None, **fields) -> Zettel:
    """Minimal Zettel from a title (P5: the title is the only required field).
    ``date`` defaults to the day it was created."""
    today = today or date.today()
    fields.setdefault("date", today.isoformat())
    return Zettel(id=make_zettel_id(title, today=today), title=title, **fields)


def idea_from_zettel(zettel: Zettel, *, today: Optional[date] = None) -> Idea:
    """Weiterentwickeln (story 46): a seed Idea from a Zettel's title, tags,
    refs and body. Pure — the caller persists both sides and sets
    ``promoted_to`` on the Zettel (the Zettel file stays in place, P1), the
    same shape as :func:`atlas.domain.publication_from_idea`."""
    today = today or date.today()
    iso = today.isoformat()
    return Idea(
        id=make_idea_id(zettel.title, today=today),
        title=zettel.title,
        tags=list(zettel.tags),
        refs=list(zettel.refs),
        body=zettel.body,
        created=iso,
        updated=iso,
    )
