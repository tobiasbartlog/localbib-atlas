"""Atlas pipeline HTTP API (#225): ``POST /publications/{id}/status``.

"Status wechseln" for the pipeline of Veroeffentlichungen: one call moves a
card to another column. The pure rule (:mod:`atlas.pipeline`) decides which
date Atlas fills in itself; this module only reads, applies, persists (file
first, index second) and broadcasts. The answer names the fields that were
set (``set``) and the status before (``previous_status``), so the SPA's
"Rückgängig" can restore the old status and clear exactly those dates through
the ordinary partial update — nothing here deletes a date.

Its own module for the line-budget reason of ``api_journal.py`` & co.:
``atlas/api.py`` is the one file on the allowlist and must not grow. Errors are
codes (``error.atlas.*``), never sentences. ``_today()`` is module level so
tests pin the day.
"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from atlas import pipeline

ERR_PUBLICATION_NOT_FOUND = "error.atlas.publication_not_found"
ERR_STATUS_INVALID = "error.atlas.status_invalid"


class StatusChange(BaseModel):
    status: str


def _today() -> date:
    return date.today()


def build_pipeline_router(store, broadcaster) -> APIRouter:
    """The pipeline part of the Atlas API. Mounted by ``api.build_router``."""
    router = APIRouter(tags=["atlas-pipeline"])

    @router.post("/publications/{publication_id}/status")
    async def change_status(publication_id: str, payload: StatusChange):
        publication = store.get_publication(publication_id)
        if publication is None:
            raise HTTPException(status_code=404, detail=ERR_PUBLICATION_NOT_FOUND)
        try:
            changes = pipeline.status_changes(publication, payload.status, _today())
        except ValueError:
            raise HTTPException(status_code=422, detail=ERR_STATUS_INVALID)
        previous = publication.status
        for field, value in changes.items():
            setattr(publication, field, value)
        store.index_publication_file(store.save_publication_file(publication))
        broadcaster.publish({"type": "publications-changed"})
        saved = store.get_publication(publication_id)
        data = saved.to_dict()
        data["errors"] = saved.validate()
        return {
            "publication": data,
            "previous_status": previous,
            "set": [field for field in changes if field != "status"],
        }

    return router
