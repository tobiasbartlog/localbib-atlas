"""Atlas HTTP API of the Publikationsliste (#228).

- ``GET /publication-list?style=apa|ieee|din&selection=all|journal|diss&submitted=``
  — the list as the page shows it (:func:`atlas.publication_list.compose`):
  groups by year, entries as segments and text, counts per selection, the
  "Für die Dissertation" box and the copyable texts.
- ``GET /publication-list/export?format=text|bib|latex&…`` — the same list
  as ``{format, filename, mime, content, count}``; the page downloads or
  copies the content.

The own name ("Dein Name") is the Add-on setting ``own_name``, read through
``SettingsApi`` on every request, so a change under Einstellungen › Add-ons
shows at once. Reads the library only (``get_reference``, contract 2.3);
writes nothing. Handlers are plain ``def`` — the library lookups block, so
FastAPI runs them in its threadpool. Mounted through :mod:`atlas.api_writing`
(``atlas/api.py`` must not grow). Errors are codes (``error.atlas.*``).
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException

from atlas import publication_list
from atlas.citation_styles import STYLES

ERR_STYLE_INVALID = "error.atlas.style_invalid"
ERR_SELECTION_INVALID = "error.atlas.selection_invalid"
ERR_FORMAT_INVALID = "error.atlas.format_invalid"

OWN_NAME_SETTING = "own_name"


def build_publication_list_router(store, library=None, settings=None) -> APIRouter:
    router = APIRouter(tags=["atlas-publication-list"])

    def _own_name() -> str:
        getter = getattr(settings, "get", None) if settings is not None else None
        if getter is None:
            return ""
        try:
            value = getter(OWN_NAME_SETTING)
        except Exception:  # noqa: BLE001 - a settings error reads as "no name"
            return ""
        return str(value).strip() if value else ""

    def _resolve(key: str) -> Optional[dict]:
        getter = getattr(library, "get_reference", None) if library is not None else None
        if getter is None:
            return None
        try:
            return getter(key)
        except Exception:  # noqa: BLE001 - a host error reads as "not in the library"
            return None

    def _arguments(style: str, selection: str) -> None:
        if style not in STYLES:
            raise HTTPException(status_code=422, detail=ERR_STYLE_INVALID)
        if selection not in publication_list.SELECTIONS:
            raise HTTPException(status_code=422, detail=ERR_SELECTION_INVALID)

    def _sources():
        chapters, _progress = store.diss_chapters()
        return store.list_publications(), chapters

    @router.get("/publication-list")
    def publication_list_view(style: str = "apa", selection: str = "all", submitted: bool = False):
        _arguments(style, selection)
        publications, chapters = _sources()
        return publication_list.compose(
            publications, chapters, _resolve, own_name=_own_name(), style=style,
            selection=selection, with_submitted=submitted)

    @router.get("/publication-list/export")
    def publication_list_export(format: str = "text", style: str = "apa", selection: str = "all",
                                submitted: bool = False):
        if format not in publication_list.FORMATS:
            raise HTTPException(status_code=422, detail=ERR_FORMAT_INVALID)
        _arguments(style, selection)
        publications, chapters = _sources()
        return publication_list.export(
            publications, chapters, _resolve, format, own_name=_own_name(), style=style,
            selection=selection, with_submitted=submitted)

    return router
