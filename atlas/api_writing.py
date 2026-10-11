"""The "Schreiben" endpoints of Atlas neu (#225, #226, #228), mounted as one router.

``atlas/api.py`` is the one file on the line-budget allowlist and must not
grow, so it mounts exactly one router for everything the pipeline of
Veroeffentlichungen, their detail page and the Publikationsliste add: the
Collection entries (:mod:`atlas.api_collections` — list, plan, lösen, type
switch), the status change (:mod:`atlas.api_pipeline`), the detail page's
literature check, citation check and document folder
(:mod:`atlas.api_publication`) and the Publikationsliste with its exports
(:mod:`atlas.api_publication_list`). New "Schreiben" endpoints are added
here, never in ``api.py``. ``manuscript_bibliography`` is re-exported for the
compile route in ``api.py``. ``settings`` is the Add-on's ``SettingsApi``
(the Publikationsliste reads "Dein Name" from it).
"""

from __future__ import annotations

from fastapi import APIRouter

from atlas.api_collections import build_collections_router, manuscript_bibliography
from atlas.api_pipeline import build_pipeline_router
from atlas.api_publication import build_publication_router
from atlas.api_publication_list import build_publication_list_router

__all__ = ["build_writing_router", "manuscript_bibliography"]


def build_writing_router(store, broadcaster, library=None, settings=None) -> APIRouter:
    router = APIRouter()
    router.include_router(build_collections_router(store, broadcaster))
    router.include_router(build_pipeline_router(store, broadcaster))
    router.include_router(build_publication_list_router(store, library, settings))
    router.include_router(build_publication_router(store, broadcaster, library))
    return router
