"""Atlas status HTTP API (#225): ``POST /publications/{id}/status`` and
``POST /projects/{id}/status``.

"Status wechseln" for the pipeline of Veroeffentlichungen and the stand of a
research project: one call moves an entry to another status. The pure rules
(:mod:`atlas.pipeline`) decide which date Atlas fills in itself and what goes
into the Verlauf; this module only reads, applies, persists (file first,
index second) and broadcasts. The answer names the fields that were set
(``set``: the dates Atlas filled in), the status before (``previous_status``)
and the old value of every field the call touched (``previous``), so the
SPA's "Rückgängig" restores exactly that through the ordinary partial update
— nothing here deletes a date on its own.

A publication's call may carry a new target (``venue``, optional ``due``):
"Woanders einreichen" after a rejection, in the same single write.

Its own module for the line-budget reason of ``api_journal.py`` & co.:
``atlas/api.py`` is the one file on the allowlist and must not grow. Errors are
codes (``error.atlas.*``), never sentences. ``_today()`` is module level so
tests pin the day.
"""

from __future__ import annotations

from datetime import date
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from atlas import pipeline
from atlas.api_errors import AtlasRoute
from atlas.domain import annotate_milestones, normalize_history_entry

ERR_PUBLICATION_NOT_FOUND = "error.atlas.publication_not_found"
ERR_PROJECT_NOT_FOUND = "error.atlas.project_not_found"
ERR_STATUS_INVALID = "error.atlas.status_invalid"


class StatusChange(BaseModel):
    status: str
    venue: Optional[str] = None
    due: Optional[str] = None


class HistoryUpdate(BaseModel):
    """Base of the partial updates of Publication and Project in ``api.py``:
    ``history`` replaces the whole Verlauf — the undo of a status change
    sends back the ``previous`` list this module answered with. Here, not in
    ``api.py``, which must not grow."""

    history: Optional[list[dict]] = None


def _today() -> date:
    return date.today()


def _old_value(entity, field: str):
    value = getattr(entity, field, None)
    if field == "history":
        return [normalize_history_entry(h) for h in value or []]
    return value


def build_pipeline_router(store, broadcaster) -> APIRouter:
    """The status part of the Atlas API. Mounted by ``api.build_router``."""
    router = APIRouter(tags=["atlas-pipeline"], route_class=AtlasRoute)

    @router.post("/publications/{publication_id}/status")
    async def change_status(publication_id: str, payload: StatusChange):
        publication = store.get_publication(publication_id)
        if publication is None:
            raise HTTPException(status_code=404, detail=ERR_PUBLICATION_NOT_FOUND)
        extra = {"due": payload.due} if "due" in payload.model_fields_set else {}
        try:
            changes = pipeline.status_changes(
                publication, payload.status, _today(), venue=payload.venue, **extra
            )
        except ValueError:
            raise HTTPException(status_code=422, detail=ERR_STATUS_INVALID)
        previous = {field: _old_value(publication, field) for field in changes}
        for field, value in changes.items():
            setattr(publication, field, value)
        store.index_publication_file(store.save_publication_file(publication))
        broadcaster.publish({"type": "publications-changed"})
        saved = store.get_publication(publication_id)
        data = saved.to_dict()
        data["errors"] = saved.validate()
        return {
            "publication": data,
            "previous_status": previous["status"],
            "set": [f for f in pipeline.DATE_ON_ENTER.values() if f in changes and changes[f]],
            "previous": previous,
        }

    @router.post("/projects/{project_id}/status")
    async def change_project_status(project_id: str, payload: StatusChange):
        project = store.get_project(project_id)
        if project is None:
            raise HTTPException(status_code=404, detail=ERR_PROJECT_NOT_FOUND)
        try:
            changes = pipeline.project_status_changes(project, payload.status, _today())
        except ValueError:
            raise HTTPException(status_code=422, detail=ERR_STATUS_INVALID)
        previous = {field: _old_value(project, field) for field in changes}
        for field, value in changes.items():
            setattr(project, field, value)
        store.index_project_file(store.save_project_file(project))
        broadcaster.publish({"type": "projects-changed"})
        saved = store.get_project(project_id)
        data = saved.to_dict()
        data["errors"] = saved.validate()
        data["timeline"] = annotate_milestones(saved.milestones, today=_today())
        return {"project": data, "previous_status": previous["status"], "previous": previous}

    return router
