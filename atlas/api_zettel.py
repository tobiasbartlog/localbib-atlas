"""Atlas Zettel API — the Werkbank's knowledge endpoints (issue #180, slice 4).

An own router module for the same reason as ``atlas/api_journal.py``:
``atlas/api.py`` is the one file on the line-budget allowlist and must not
grow further. ``api.py`` mounts this sub-router under the same ``/api/plugins/atlas``
prefix with ``router.include_router(build_zettel_router(store, broadcaster))``,
giving routes ``/api/plugins/atlas/zettel...``.

Orchestration only: store reads, the pure ``parse_checklist`` from
:mod:`atlas.domain` and :func:`atlas.zettel.idea_from_zettel`, store writes,
then one ``{"type": "archive-changed", "kind": "zettel"}`` broadcast — the
same event the watcher publishes for an external edit (ADR-0020), so a UI
write and an external edit reach the SPA on one path.

**Errors are codes, never sentences** (issue #180, ADR-0018), following the
convention ``atlas/api_journal.py`` established for the Werkbank endpoints.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from atlas.api_errors import AtlasRoute
from atlas.domain import parse_checklist
from atlas.index_links import KIND_IDEA, KIND_ZETTEL
from atlas.journal_store import WeekUnreadable
from atlas.weeks import week_id
from atlas.zettel import idea_from_zettel, new_zettel

# Error codes — the SPA resolves them, the backend never translates.
ERR_ZETTEL_NOT_FOUND = "error.atlas.zettel_not_found"
ERR_TITLE_REQUIRED = "error.atlas.title_required"
ERR_CHECKLIST_INDEX_INVALID = "error.atlas.checklist_index_invalid"
ERR_ALREADY_PROMOTED = "error.atlas.already_promoted"
# derive-tasks writes into today's week file — the codes of api_journal.py.
ERR_WEEK_UNREADABLE = "error.atlas.week_unreadable"
ERR_DOCUMENT_LOCKED = "error.atlas.document_locked"


# =============================================================================
# Payloads
# =============================================================================

class ZettelCreate(BaseModel):
    title: str
    type: Optional[str] = None
    date: Optional[str] = None
    refs: list[str] = []
    tags: list[str] = []
    body: Optional[str] = None


class ZettelUpdate(BaseModel):
    # All optional — only provided fields are applied. id stays fixed (=
    # filename, unlike title).
    title: Optional[str] = None
    type: Optional[str] = None
    date: Optional[str] = None
    refs: Optional[list[str]] = None
    tags: Optional[list[str]] = None
    body: Optional[str] = None


class DeriveTasksRequest(BaseModel):
    indices: list[int] = []


# =============================================================================
# Helpers
# =============================================================================

def _today() -> date:
    """Mirrors ``atlas.api_journal._today`` (ADR-0020): the server's local
    date, module level so a test can pin it independently of the Journal
    router's own seam."""
    return date.today()


def _zettel_dict(zettel) -> dict:
    data = zettel.to_dict()
    data["errors"] = zettel.validate()
    return data


def _task_wire(week: str, task: dict) -> dict:
    """The same Task wire shape ``atlas/api_journal.py`` uses — duplicated on
    purpose (a private helper of a sibling module, not shared across files)."""
    return {
        "week": task.get("week") or week,
        "body_index": task.get("body_index"),
        "day": task.get("day"),
        "text": task.get("text") or "",
        "raw": task.get("raw"),
        "done": bool(task.get("done")),
        "open": bool(task.get("open")),
        "anchors": list(task.get("anchors") or []),
        "tags": list(task.get("tags") or []),
        "moved_to": task.get("moved_to"),
        "moved_from": task.get("moved_from"),
    }


def _derived_indices(store, zettel) -> list[int]:
    """Checklist indices that already have a derived Task (story 45): a Task
    anywhere in the Journal carrying ``[[zettel-id]]`` whose display text
    equals the checklist item's text."""
    items = parse_checklist(zettel.body)["items"]
    if not items:
        return []
    existing = {t["text"] for t in store.tasks_for_anchor(zettel.id, open_only=False)}
    return [i for i, item in enumerate(items) if item["text"] in existing]


# =============================================================================
# Router
# =============================================================================

def build_zettel_router(store, broadcaster) -> APIRouter:
    """The ``/zettel`` part of the Atlas API. Mounted by ``api.build_router``."""
    router = APIRouter(prefix="/zettel", tags=["atlas-zettel"], route_class=AtlasRoute)

    def _changed(kind: str = "zettel") -> None:
        broadcaster.publish({"type": "archive-changed", "kind": kind})

    def _zettel_or_404(zettel_id: str):
        zettel = store.get_zettel(zettel_id)
        if zettel is None:
            raise HTTPException(status_code=404, detail=ERR_ZETTEL_NOT_FOUND)
        return zettel

    # --- CRUD ------------------------------------------------------------

    @router.get("")
    async def list_zettel(
        type: Optional[str] = Query(None),
        q: Optional[str] = Query(None),
    ):
        return {"zettel": [_zettel_dict(z) for z in store.list_zettel(type=type, q=q)]}

    @router.get("/{zettel_id}")
    async def get_zettel(zettel_id: str):
        zettel = _zettel_or_404(zettel_id)
        data = _zettel_dict(zettel)
        # Story 45: which checklist items already have a derived Task, so the
        # SPA never offers "derive" twice for the same item.
        data["derived_indices"] = _derived_indices(store, zettel)
        return data

    @router.post("")
    async def create_zettel(payload: ZettelCreate):
        title = payload.title.strip()
        if not title:
            raise HTTPException(status_code=400, detail=ERR_TITLE_REQUIRED)
        fields: dict = {"refs": payload.refs, "tags": payload.tags}
        if payload.type:
            fields["type"] = payload.type
        if payload.date:
            fields["date"] = payload.date
        if payload.body is not None:
            fields["body"] = payload.body
        zettel = new_zettel(title, today=_today(), **fields)
        zettel.id = store.free_id(KIND_ZETTEL, zettel.id)
        # UI write path: file first, then index (single DB writer) — the
        # watcher would also catch the new file, but indexing here makes the
        # request immediately consistent for the caller too.
        path = store.save_zettel_file(zettel)
        store.index_zettel_file(path)
        _changed()
        return _zettel_dict(store.get_zettel(zettel.id))

    @router.put("/{zettel_id}")
    async def update_zettel(zettel_id: str, payload: ZettelUpdate):
        zettel = _zettel_or_404(zettel_id)
        changes = payload.model_dump(exclude_unset=True)
        for field in ("title", "type", "date", "body"):
            if field in changes:
                setattr(zettel, field, changes[field])  # None clears date/type
        for field in ("refs", "tags"):
            if field in changes and changes[field] is not None:
                setattr(zettel, field, changes[field])
        if not (zettel.title or "").strip():
            raise HTTPException(status_code=400, detail=ERR_TITLE_REQUIRED)
        path = store.save_zettel_file(zettel)
        store.index_zettel_file(path)
        _changed()
        return _zettel_dict(store.get_zettel(zettel_id))

    @router.delete("/{zettel_id}")
    async def delete_zettel(zettel_id: str):
        zettel = _zettel_or_404(zettel_id)
        if zettel.path:
            Path(zettel.path).unlink(missing_ok=True)
        store.delete_zettel(zettel_id)
        _changed()
        return {"deleted": zettel_id}

    # --- derive-tasks (story 44/45) ---------------------------------------

    @router.post("/{zettel_id}/derive-tasks")
    async def derive_tasks(zettel_id: str, payload: DeriveTasksRequest):
        """One Task per requested checklist index, for today, anchored back
        to the Zettel. An index whose text already has a Task with this
        anchor is reported in ``already`` instead of duplicated — an empty
        ``indices`` list is a no-op that just reports (nothing to derive);
        use ``GET /zettel/{id}`` (``derived_indices``) to see the whole
        picture without deriving anything. Today's week file not parsing is
        409 naming it, a lock 423 — nothing is written into it."""
        zettel = _zettel_or_404(zettel_id)
        items = parse_checklist(zettel.body)["items"]
        for idx in payload.indices:
            if idx < 0 or idx >= len(items):
                raise HTTPException(status_code=422, detail=ERR_CHECKLIST_INDEX_INVALID)

        existing = {t["text"] for t in store.tasks_for_anchor(zettel.id, open_only=False)}
        day = _today()
        week = week_id(day)
        created: list[dict] = []
        already: list[int] = []
        for idx in payload.indices:
            text = items[idx]["text"]
            if text in existing:
                already.append(idx)
                continue
            try:
                task = store.add_task(week, day.isoformat(), f"{text} [[{zettel.id}]]")
            except (WeekUnreadable, OSError) as exc:  # the ones before stand
                if created:
                    _changed("journal")
                if isinstance(exc, WeekUnreadable):
                    params = {"week": exc.week, "file": exc.file}
                    raise HTTPException(
                        status_code=409, detail={"code": ERR_WEEK_UNREADABLE, "params": params}
                    )
                raise HTTPException(status_code=423, detail=ERR_DOCUMENT_LOCKED)
            created.append(_task_wire(week, task))
            existing.add(text)
        if created:
            _changed("journal")
        return {"zettel_id": zettel.id, "created": created, "already": already}

    # --- promote (story 46) ------------------------------------------------

    @router.post("/{zettel_id}/promote")
    async def promote_zettel(zettel_id: str):
        """Weiterentwickeln (Zettel -> Idee): creates a seed Idea (title,
        tags, refs, body copied) and sets ``promoted_to`` on the Zettel. The
        Zettel file stays in place (P1) — mirrors
        ``POST /ideas/{id}/promote``. A second promote of an already
        promoted Zettel is a conflict, not a silent no-op."""
        zettel = _zettel_or_404(zettel_id)
        if zettel.promoted_to:
            raise HTTPException(status_code=409, detail=ERR_ALREADY_PROMOTED)

        # A hand edit of the Zettel the index has not read stops the whole
        # promote (409 error.atlas.file_changed) before the Idea exists.
        store.ensure_current(KIND_ZETTEL, zettel)
        idea = idea_from_zettel(zettel, today=_today())
        idea.id = store.free_id(KIND_IDEA, idea.id or "zettel")
        idea_path = store.save_idea_file(idea)
        store.index_file(idea_path)

        zettel.promoted_to = idea.id
        zettel_path = store.save_zettel_file(zettel)
        store.index_zettel_file(zettel_path)

        broadcaster.publish({"type": "ideas-changed"})
        _changed()
        return {
            "idea": idea.to_dict() | {"errors": idea.validate()},
            "zettel": _zettel_dict(store.get_zettel(zettel_id)),
        }

    return router
