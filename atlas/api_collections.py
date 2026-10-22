"""Atlas Collection-entry HTTP API (ADR-0022, issue #205; ADR-0025, #225).

``GET /collections`` (every Collection entry, plus every core Collection with
the entry it has, if any — the list of "Aus Sammlung planen"),
``POST /collections/{id}/plan`` (make a Collection a Publication: writes the
file with ``collection_id`` + ``kind``, title = the Collection's name, status
planned; 409 when it already has an entry), ``POST /collections/{id}/unplan``
("Lösen": the last membership is frozen once into ``refs``, the link goes,
the file stays), ``GET /collections/{id}/switch?to=…`` (what a type switch
would carry — the confirmation dialog) and ``POST /collections/{id}/switch``
("Zu Forschungsprojekt verschieben" / "Zur Publication verschieben"), plus the
compile helper :func:`manuscript_bibliography` the ``/manuscripts/{id}/compile``
route in :mod:`atlas.api` calls.

A Collection is a Publication only when a file with its ``collection_id``
exists (ADR-0025) — nothing here creates one on the side. Mounted through
:mod:`atlas.api_writing` for the line-budget reason of ``api_journal.py`` &
co.: ``atlas/api.py`` is the one file on the allowlist and must not grow.
Errors are codes (``error.atlas.*``), never sentences.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from atlas import collection_entries, documents
from atlas.api_errors import AtlasRoute
from atlas.collection_entries import KIND_PROJECT, KIND_PUBLICATION, KINDS
from atlas.domain import Project

logger = logging.getLogger(__name__)


class SwitchRequest(BaseModel):
    to: str


class PlanRequest(BaseModel):
    # Plan onto an EXISTING file instead of a new one — the undo of "Lösen"
    # re-links the very file that was released: a Publication, or a
    # Forschungsprojekt when the entry had been switched to one. At most one.
    publication_id: Optional[str] = None
    project_id: Optional[str] = None


def _manuscript_stem(name: str) -> str:
    return name[:-4] if name.lower().endswith(".tex") else name


def manuscript_bibliography(store, library, manuscript_id: str) -> str:
    """The ``.bib`` a manuscript compiles against. Linked from a Collection
    entry: that Collection's Items only (story 60; the first such entry by id
    when several link it). Otherwise — own Publications, unchanged — the whole
    library. Hosts without the export methods give an empty bibliography."""
    source = store.collections
    if source is not None:
        linking = sorted(
            (p for p in store.list_publications()
             if p.collection_id is not None
             and manuscript_id in {_manuscript_stem(n) for n in p.manuscripts}),
            key=lambda p: p.id,
        )
        for publication in linking:
            bib = source.bibtex(publication.collection_id)
            if bib is not None:
                return bib
    exporter = getattr(library, "export_bibtex", None) if library is not None else None
    return exporter() if exporter else ""


def find_entry(store, collection_id: int):
    """The entry of one Collection: its file (a Publication before a
    Project, should both exist), decorated with the live Collection. None
    when the Collection has no file — it is not planned (ADR-0025)."""
    for entity in store.collection_files():
        if entity.collection_id == collection_id:
            getter = store.get_project if isinstance(entity, Project) else store.get_publication
            return getter(entity.id)
    return None


def _take_back(renames: list, new_path, index) -> None:
    """Undo a switch that could not finish: the documents go back, the new
    file goes. When the documents cannot go back (a second lock), the new
    file STAYS and is indexed, so the documents keep an entity under their
    id; it is logged. Nothing is ever deleted that holds user data."""
    try:
        documents.undo_renames(renames)
    except OSError:
        logger.warning("Atlas: Dokumentordner nach abgebrochenem Typwechsel nicht zurueck, "
                       "neue Datei bleibt: %s, %s", renames, new_path)
        index(new_path)
        return
    try:
        documents.retry_locked(lambda: Path(new_path).unlink(missing_ok=True))
    except OSError:
        logger.warning("Atlas: neue Datei nach abgebrochenem Typwechsel nicht entfernt: %s", new_path)


def _entry_summary(entity) -> dict:
    return {
        "id": entity.id,
        "kind": collection_entries.entity_kind(entity),
        "has_file": bool(entity.path),
        "title": entity.title,
        "status": entity.status,
        "collection": entity.collection,
    }


def _collection_row(collection: dict, entry) -> dict:
    """One core Collection for "Aus Sammlung planen": name, size, archive
    state and the entry it already has (None = only a place for Papers)."""
    return {
        "id": int(collection["id"]),
        "name": collection.get("name"),
        "archived": bool(collection.get("archived")),
        "item_count": int(collection.get("item_count") or 0),
        "created_at": collection.get("created_at"),
        "entry": _entry_summary(entry) if entry is not None else None,
    }


def build_collections_router(store, broadcaster) -> APIRouter:
    """The Collection-entry part of the Atlas API. Mounted by ``api.build_router``."""
    router = APIRouter(tags=["atlas-collections"], route_class=AtlasRoute)

    def _publication_exists(entity_id: str) -> bool:
        return store.get_publication(entity_id) is not None

    def _project_exists(entity_id: str) -> bool:
        return store.get_project(entity_id) is not None

    def _entry_or_404(collection_id: int):
        entry = find_entry(store, collection_id) if store.collections is not None else None
        if entry is None:
            raise HTTPException(status_code=404, detail="error.atlas.collection_not_found")
        return entry

    def _target_or_422(entry, to: Optional[str]) -> str:
        if to not in KINDS:
            raise HTTPException(status_code=422, detail="error.atlas.kind_invalid")
        if to == collection_entries.entity_kind(entry):
            raise HTTPException(status_code=409, detail="error.atlas.kind_unchanged")
        return to

    def _changed() -> None:
        for kind in (KIND_PUBLICATION, KIND_PROJECT):
            broadcaster.publish({"type": "archive-changed", "kind": kind})
        broadcaster.publish({"type": "publications-changed"})

    @router.get("/collections")
    async def list_collection_entries():
        """Every Collection entry (always a file, ADR-0025) by Collection name,
        and every live core Collection with its entry or ``None``."""
        if store.collections is None:
            return {"entries": [], "collections": [], "available": False}
        entries = [
            e for e in [*store.list_publications(), *store.list_projects()]
            if e.collection_id is not None
        ]
        entries.sort(key=lambda e: ((e.title or "").casefold(), e.collection_id))
        by_collection: dict = {}
        for e in entries:
            by_collection.setdefault(e.collection_id, e)
        collections = [
            _collection_row(c, by_collection.get(int(c["id"])))
            for c in store.collections.collections()
            if not c.get("deleted")
        ]
        collections.sort(key=lambda c: ((c["name"] or "").casefold(), c["id"]))
        return {
            "entries": [_entry_summary(e) for e in entries],
            "collections": collections,
            "available": True,
        }

    @router.post("/collections/{collection_id}/plan")
    async def plan_collection(collection_id: int, payload: Optional[PlanRequest] = None):
        """"Aus Sammlung planen" (#225): the Collection becomes a Publication
        under "Geplant". A Collection belongs to at most one entry — 409 when
        it has one. With ``publication_id`` (or ``project_id``) the link goes
        onto that existing file (the undo of "Lösen"); its frozen ``refs`` give
        way to the live Collection again."""
        collection = store.collections.get(collection_id) if store.collections is not None else None
        if collection is None or collection.get("deleted"):
            raise HTTPException(status_code=404, detail="error.atlas.collection_not_found")
        if find_entry(store, collection_id) is not None:
            raise HTTPException(status_code=409, detail="error.atlas.collection_already_planned")
        target_id = (payload.publication_id or "").strip() if payload else ""
        project_id = (payload.project_id or "").strip() if payload else ""
        if target_id and project_id:
            raise HTTPException(status_code=422, detail="error.atlas.kind_invalid")
        if project_id:
            return _relink_project(collection_id, project_id)
        if target_id:
            publication = store.get_publication(target_id)
            if publication is None:
                raise HTTPException(status_code=404, detail="error.atlas.publication_not_found")
            if publication.collection_id is not None:
                raise HTTPException(status_code=409, detail="error.atlas.publication_has_collection")
            publication.collection_id = collection_id
            publication.kind = KIND_PUBLICATION
            publication.refs = []
        else:
            new_id = documents.PUBLICATIONS.free_id(
                collection_entries.virtual_id(collection_id), _publication_exists)
            publication = collection_entries.planned_publication(collection, new_id)
        store.index_publication_file(store.save_publication_file(publication))
        _changed()
        saved = store.get_publication(publication.id)
        return {"entry": _entry_summary(saved), "publication": saved.to_dict()}

    def _relink_project(collection_id: int, project_id: str) -> dict:
        """The undo of "Lösen" for an entry that is a Forschungsprojekt: the
        same file takes the link back, its frozen ``refs`` give way."""
        project = store.get_project(project_id)
        if project is None:
            raise HTTPException(status_code=404, detail="error.atlas.project_not_found")
        if project.collection_id is not None:
            raise HTTPException(status_code=409, detail="error.atlas.project_has_collection")
        project.collection_id = collection_id
        project.kind = KIND_PROJECT
        project.refs = []
        store.index_project_file(store.save_project_file(project))
        _changed()
        saved = store.get_project(project.id)
        return {"entry": _entry_summary(saved), "project": saved.to_dict()}

    @router.post("/collections/{collection_id}/unplan")
    async def unplan_collection(collection_id: int):
        """"Lösen" (#225): the entry keeps its file and becomes a normal
        Publication/Project — the Collection's current membership is frozen
        into ``refs`` once (the tombstone logic), the link goes. The
        Collection is only a place for Papers again."""
        entry = find_entry(store, collection_id) if store.collections is not None else None
        if entry is None:
            raise HTTPException(status_code=404, detail="error.atlas.collection_not_planned")
        source = store.collections
        collection = source.get(collection_id) or {"name": entry.title}
        frozen = collection_entries.freeze(entry, collection, source.refs(collection_id))
        if isinstance(frozen, Project):
            store.index_project_file(store.save_project_file(frozen))
        else:
            store.index_publication_file(store.save_publication_file(frozen))
        _changed()
        return {
            "id": frozen.id,
            "kind": collection_entries.entity_kind(frozen),
            "refs": list(frozen.refs),
        }

    @router.get("/collections/{collection_id}/switch")
    async def preview_switch(collection_id: int, to: Optional[str] = Query(None)):
        """What the switch would do — the confirmation dialog lists
        ``carried`` (``{field, label, value}``) before anything is written."""
        entry = _entry_or_404(collection_id)
        target = _target_or_422(entry, to)
        return {"entry": _entry_summary(entry), **collection_entries.switch_plan(entry, target)}

    @router.post("/collections/{collection_id}/switch")
    async def switch_kind(collection_id: int, payload: SwitchRequest):
        """Move a Collection entry to the other type. Without a file: the
        file is created with the new ``kind`` (nothing can be lost). With a
        file: title/tags/notes move, every other field is appended as a new
        ``## Aus … übernommen (<Datum>)`` section, the file moves to the other
        folder under the same id when it is free there — and so does its
        document folder (``documents.DocumentFolder.move_to``)."""
        entry = _entry_or_404(collection_id)
        target = _target_or_422(entry, payload.to)
        plan = collection_entries.switch_plan(entry, target)
        if target == KIND_PROJECT:
            exists, save, index = _project_exists, store.save_project_file, store.index_project_file
            folders = (documents.PUBLICATIONS, documents.PROJECTS)
        else:
            exists, save, index = _publication_exists, store.save_publication_file, store.index_publication_file
            folders = (documents.PROJECTS, documents.PUBLICATIONS)
        # The entry keeps its id ([[id]] and projects: [id] stay valid) unless
        # an entity of the other kind has it — indexed or only on disk.
        new_id = folders[1].free_id(entry.id, exists, count_folders=False)
        new = collection_entries.switch_entity(entry, target, new_id)
        # The old file goes below: never one whose hand edit the index has
        # not read (409 error.atlas.file_changed) — that edit would be lost.
        store.ensure_current(collection_entries.entity_kind(entry), entry)
        # All or nothing. The confirmed switch carries every value over into
        # the new file; only then do the documents follow and the old file go
        # (ADR-0022). A lasting lock on the folder or the old file takes back
        # what was done and answers 423 — nothing changed.
        new_path = save(new)
        renames: list = []
        try:
            try:
                renames = folders[0].move_to(entry.id, folders[1], new_id)
            except ValueError:
                pass  # an id no folder can have (hand-named file) has no documents
            if entry.path:
                documents.retry_locked(lambda: Path(entry.path).unlink(missing_ok=True))
        except OSError:
            _take_back(renames, new_path, index)
            raise HTTPException(status_code=423, detail="error.atlas.document_locked")
        index(new_path)
        if entry.path:
            store.remove_path(entry.path)
        for kind in (KIND_PUBLICATION, KIND_PROJECT):
            broadcaster.publish({"type": "archive-changed", "kind": kind})
        return {"id": new.id, "kind": target, "plan": plan}

    return router
