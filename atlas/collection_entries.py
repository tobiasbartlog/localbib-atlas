"""Collection entries — the Atlas side of the core's Collections (ADR-0022, #205,
changed by ADR-0025, #225).

A core Collection is first of all a place to keep Papers. It becomes an Atlas
entry only when the user plans it ("Aus Sammlung planen"): that writes a
Publication file with ``collection_id`` + ``kind`` and no ``refs``. The
entry's literature list *is* the Collection, read live through ``LibraryApi``
(contract 2.1), never copied into the file. There are no virtual entries any
more (ADR-0025): a Collection without a file is not a Publication.

This module is the pure half:

- :class:`CollectionSource` — the guarded live read of the core's Collections
  (an older host without the 2.1 methods reads as "no Collections");
- :func:`publications_view` / :func:`decorate` — the read-time overlay: file
  rows of Collection entries get the core's name, archive state and Items.
  Nothing of this goes into ``atlas.db`` — the index stays exactly what the
  files say (P1, one write path);
- :func:`planned_publication` — "Aus Sammlung planen": the new file of a
  Collection (title = its name, status planned); :func:`virtual_id` names it
  ``sammlung-<id>``, the id older deep links already carry;
- :func:`switch_plan` / :func:`switch_entity` — "Zu Forschungsprojekt
  verschieben" / "Zur Publication verschieben": fields with a counterpart move,
  every other non-empty field is appended to the body as a new section
  ``## Aus … übernommen (<Datum>)`` with a ``Feld: Wert`` list;
- :func:`freeze` — a deleted Collection (tombstone) or "Lösen" turns an
  existing file into a normal Publication/Project once: the last membership
  becomes ``refs``, the Collection link is dropped.

No I/O here besides the calls on the injected library; the store and the
router write.
"""

from __future__ import annotations

import logging
from datetime import date
from typing import Any, Iterable, Optional, Union

from atlas.domain import Project, Publication, normalize_milestone

logger = logging.getLogger(__name__)

KIND_PUBLICATION = "publication"
KIND_PROJECT = "project"
KINDS = (KIND_PUBLICATION, KIND_PROJECT)

VIRTUAL_ID_PREFIX = "sammlung-"
# The core SPA's Collection page — the one place the literature is edited.
EDIT_ROUTE = "/collection/{id}"

Entity = Union[Publication, Project]


# =============================================================================
# Live read of the core's Collections
# =============================================================================

class CollectionSource:
    """The core's Collections through ``LibraryApi`` (contract 2.1).

    Hosts before 2.1 have no ``list_collections``: :attr:`available` is False
    and Atlas behaves as if there were no Collections. A failing call never
    breaks an Atlas page — it reads as "nothing" and is logged."""

    def __init__(self, library: Any) -> None:
        self._library = library

    @property
    def available(self) -> bool:
        return self._library is not None and callable(
            getattr(self._library, "list_collections", None)
        )

    def collections(self) -> list[dict]:
        return self._call("list_collections", default=[]) or []

    def get(self, collection_id: int) -> Optional[dict]:
        return self._call("get_collection", collection_id, default=None)

    def refs(self, collection_id: int) -> list[str]:
        return [str(k) for k in (self._call("get_collection_refs", collection_id, default=[]) or [])]

    def bibtex(self, collection_id: int) -> Optional[str]:
        """The Collection's ``.bib`` — None when the host cannot export it."""
        return self._call("export_collection_bibtex", collection_id, default=None)

    def _call(self, name: str, *args, default):
        method = getattr(self._library, name, None) if self._library is not None else None
        if not callable(method):
            return default
        try:
            return method(*args)
        except Exception:  # noqa: BLE001 - a host error must not break Atlas
            logger.exception("Atlas: LibraryApi.%s fehlgeschlagen", name)
            return default


# =============================================================================
# Read-time overlay
# =============================================================================

def collection_info(collection: Optional[dict], collection_id: int) -> dict:
    """The derived ``collection`` block of an entry's wire form."""
    if collection is None:
        return {
            "id": collection_id, "name": None, "archived": False, "deleted": False,
            "item_count": 0, "missing": True,
            "edit_route": EDIT_ROUTE.format(id=collection_id),
        }
    return {
        "id": collection_id,
        "name": collection.get("name"),
        "archived": bool(collection.get("archived")),
        "deleted": bool(collection.get("deleted")),
        "item_count": int(collection.get("item_count") or 0),
        "missing": False,
        "edit_route": EDIT_ROUTE.format(id=collection_id),
    }


def decorate(entity: Entity, source: CollectionSource, collection: Optional[dict] = None) -> Entity:
    """Overlay the live Collection onto a file-backed entry: the core's name
    wins on display (the file's title is only a snapshot), the Items are the
    literature. An unknown Collection leaves the file as it is and is marked
    ``missing`` — a warning, never a repair."""
    cid = entity.collection_id
    if cid is None:
        return entity
    if collection is None:
        collection = source.get(cid)
    entity.collection = collection_info(collection, cid)
    if collection is not None:
        entity.title = collection.get("name") or entity.title
        entity.refs = source.refs(cid)
    return entity


def virtual_id(collection_id: int, taken: Iterable[str] = ()) -> str:
    """The id of a planned Collection's file: ``sammlung-<id>`` — the id the
    former virtual entries carried, so old deep links find it once planned —
    suffixed only if an unrelated file already uses it."""
    base = f"{VIRTUAL_ID_PREFIX}{collection_id}"
    used = set(taken)
    if base not in used:
        return base
    n = 2
    while f"{base}-{n}" in used:
        n += 1
    return f"{base}-{n}"


def planned_publication(collection: dict, entity_id: str) -> Publication:
    """"Aus Sammlung planen" (#225): the Publication file a Collection gets
    when the user plans it — title = the Collection's name, status planned,
    the link, no ``refs`` (the literature stays the Collection)."""
    cid = int(collection["id"])
    return Publication(
        id=entity_id,
        title=collection.get("name") or entity_id,
        status="planned",
        collection_id=cid,
        kind=KIND_PUBLICATION,
    )


def publications_view(rows: list[Publication], source: CollectionSource) -> list[Publication]:
    """The Publication list as Atlas shows it: every file row, Collection
    entries decorated with the live Collection. A Collection without a file
    is not in it (ADR-0025, #225) — it is only a place to keep Papers until
    the user plans it."""
    collections = {int(c["id"]): c for c in source.collections()}
    for pub in rows:
        if pub.collection_id is not None:
            decorate(pub, source, collections.get(pub.collection_id))
    return rows


# =============================================================================
# Type switch: Publication <-> Forschungsprojekt
# =============================================================================

# Fields WITHOUT a counterpart, in display order, with the label that goes
# into the appended section (``Feld: Wert``). Title, tags and the Markdown
# body (incl. a project's work packages, which live in the body) move as they
# are; the literature is the Collection on both sides.
_PUBLICATION_ONLY = (
    ("status", "Status"),
    ("type", "Art"),
    ("venue", "Venue"),
    ("authors", "Autor:innen"),
    ("due", "Fällig"),
    ("submitted", "Eingereicht"),
    ("published", "Veröffentlicht"),
    ("manuscripts", "Manuskripte"),
    ("derived_from", "Hervorgegangen aus"),
    ("projects", "Forschungsprojekte"),
    ("paper", "Eigenes Paper"),
)
_PROJECT_ONLY = (
    ("status", "Status"),
    ("start", "Laufzeit von"),
    ("end", "Laufzeit bis"),
    ("funder", "Förderer"),
    ("grant_id", "Förderkennzeichen"),
    ("role", "Rolle"),
    ("milestones", "Meilensteine"),
)
MOVED_FIELDS = (("title", "Titel"), ("tags", "Tags"), ("body", "Notizen"))
_SECTION_TITLE = {
    KIND_PUBLICATION: "Aus Publication übernommen",
    KIND_PROJECT: "Aus Forschungsprojekt übernommen",
}
_DEFAULT_STATUS = "planned"


def entity_kind(entity: Entity) -> str:
    return KIND_PROJECT if isinstance(entity, Project) else KIND_PUBLICATION


def _format_value(field: str, value: Any) -> str:
    if field == "milestones":
        parts = []
        for raw in value:
            m = normalize_milestone(raw)
            extra = ", ".join(x for x in (m["date"], "erledigt" if m["done"] else None) if x)
            parts.append(f"{m['title']} ({extra})" if extra else m["title"])
        return "; ".join(parts)
    if isinstance(value, (list, tuple)):
        return ", ".join(str(v) for v in value)
    return str(value)


def carried_fields(entity: Entity) -> list[dict]:
    """The non-empty fields of ``entity`` that have no counterpart in the
    other type — what the confirmation dialog lists and the section holds.
    A default ``status`` (``planned``, the same on both sides) carries no
    information and is left out."""
    spec = _PROJECT_ONLY if isinstance(entity, Project) else _PUBLICATION_ONLY
    out: list[dict] = []
    for field, label in spec:
        value = getattr(entity, field, None)
        if value in (None, "", [], ()):
            continue
        if field == "status" and value == _DEFAULT_STATUS:
            continue
        out.append({"field": field, "label": label, "value": _format_value(field, value)})
    return out


def switch_plan(entity: Entity, target: str) -> dict:
    """What a switch would do — the confirmation dialog's content. Without a
    file nothing can be lost: only the type changes."""
    has_file = bool(entity.path)
    return {
        "from": entity_kind(entity),
        "to": target,
        "has_file": has_file,
        "moved": [label for _, label in MOVED_FIELDS] if has_file else [],
        "carried": carried_fields(entity) if has_file else [],
        "section": _SECTION_TITLE[entity_kind(entity)] if has_file else None,
    }


def carried_section(entity: Entity, today: date) -> str:
    """``## Aus … übernommen (<Datum>)`` + ``- Feld: Wert`` lines; empty when
    nothing has to be carried."""
    fields = carried_fields(entity)
    if not fields:
        return ""
    lines = [f"## {_SECTION_TITLE[entity_kind(entity)]} ({today.isoformat()})", ""]
    lines.extend(f"- {f['label']}: {f['value']}" for f in fields)
    return "\n".join(lines)


def switch_entity(entity: Entity, target: str, entity_id: str, *, today: Optional[date] = None) -> Entity:
    """The entry as the other type. Title, tags and body move; the carried
    section is APPENDED to the body — an earlier section is never touched, so
    switching back and forth only ever adds. The Collection link stays."""
    if target not in KINDS:
        raise ValueError(f"unbekannter Typ: {target!r}")
    if target == entity_kind(entity):
        raise ValueError("Eintrag hat diesen Typ bereits")
    body = entity.body or ""
    if entity.path:
        section = carried_section(entity, today or date.today())
        if section:
            body = f"{body.rstrip()}\n\n{section}" if body.strip() else section
    common = dict(
        id=entity_id,
        title=entity.title,
        tags=list(entity.tags),
        body=body,
        collection_id=entity.collection_id,
        kind=target,
    )
    new: Entity = Project(**common) if target == KIND_PROJECT else Publication(**common)
    return new


# =============================================================================
# Tombstone: a deleted Collection
# =============================================================================

def freeze(entity: Entity, collection: dict, frozen_refs: list[str]) -> Entity:
    """The file of a deleted Collection becomes a normal Publication/Project:
    the last membership is written as Cite-Key ``refs`` once, the title takes
    the Collection's last name, the link is removed. Idempotent by
    construction — afterwards the file has no ``collection_id`` any more."""
    entity.refs = list(dict.fromkeys(frozen_refs))
    entity.title = collection.get("name") or entity.title
    entity.collection_id = None
    entity.kind = None
    entity.collection = None
    return entity
