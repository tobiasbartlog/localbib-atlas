"""One translation for what the store refuses to write (review 2026-10-18).

An update loads an entity from the index and writes the whole file back. When
that file is not what the index read — a hand edit with broken YAML the
watcher could not read, one it has not read yet, a sync conflict copy indexed
under the same id — the store stops the write with
:class:`atlas.entity_store.FileChanged` before it starts (P1).
:class:`AtlasRoute` turns that into ``409 {code: error.atlas.file_changed,
params: {file}}`` (a code, never a sentence — ADR-0018) for every route of a
router built with ``route_class=AtlasRoute``: ``api.build_router`` and the
sub-routers that rewrite entity files (Notizen, Sammlungs-Einträge, Pipeline).
A file OneDrive or an editor holds (``PermissionError``) is ``423
error.atlas.document_locked``, the code of the document folders and the week
files. One place instead of a ``try`` in each handler — ``atlas/api.py`` is
the one file on the line-budget allowlist and must not grow.
"""

from __future__ import annotations

from fastapi import HTTPException
from fastapi.routing import APIRoute

from atlas.entity_store import FileChanged

ERR_FILE_CHANGED = "error.atlas.file_changed"
ERR_DOCUMENT_LOCKED = "error.atlas.document_locked"


class AtlasRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def route(request):
            try:
                return await handler(request)
            except FileChanged as exc:
                raise HTTPException(
                    status_code=409,
                    detail={"code": ERR_FILE_CHANGED, "params": {"file": exc.file}},
                ) from exc
            except PermissionError as exc:
                raise HTTPException(status_code=423, detail=ERR_DOCUMENT_LOCKED) from exc

        return route
