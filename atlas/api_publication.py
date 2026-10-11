"""Atlas HTTP API of a Publication's detail page (#226).

- ``GET /publications/{id}/literature`` — the Literatur-Abgleich
  (:mod:`atlas.literature`): cite keys of every linked manuscript × the
  literature source (Collection live, else ``refs``) × the library, with the
  ``.bib`` files of the publication's document folder as the fallback for
  title and DOI of a missing key.
- ``POST /publications/{id}/check-citations`` — "Text einfügen": the cite keys
  of a pasted TeX text against the library. Writes nothing.
- ``/publications/{id}/documents…`` — the publication's document folder
  ``veroeffentlichungen/<id>/`` (list, upload, open in the system program,
  delete), the same folder logic as the project documents
  (:class:`atlas.documents.DocumentFolder`). The indexer never scans it.

Mounted through :mod:`atlas.api_writing` (``atlas/api.py`` must not grow).
Reads the library only (``library.read``); Atlas never adds anything to the
library or a Collection (P2). Errors are codes (``error.atlas.*``).
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

from atlas import documents, manuscripts
from atlas.citations import extract_cite_keys, parse_bibtex_fields
from atlas.literature import citation_check, literature_rows

ERR_PUBLICATION_NOT_FOUND = "error.atlas.publication_not_found"
ERR_FILENAME_INVALID = "error.atlas.filename_invalid"
ERR_DOCUMENT_NOT_FOUND = "error.atlas.document_not_found"
ERR_DOCUMENT_LOCKED = "error.atlas.document_locked"

FOLDER = documents.PUBLICATIONS

logger = logging.getLogger(__name__)


class CitationText(BaseModel):
    text: str = ""


def _stem(name: str) -> str:
    return name[:-4] if name.lower().endswith(".tex") else name


def remove_entity_files(folder: documents.DocumentFolder, entity_id: str, md_path) -> None:
    """Deleting a Publication or a Forschungsprojekt (``atlas/api.py``), all
    or nothing: the document folder is set aside
    (:meth:`DocumentFolder.set_aside` — kept, never inherited by a new entity
    with the same id), then the Markdown file goes. A lasting lock on either
    answers 423 with nothing changed — a folder already set aside is renamed
    back (if that is locked too, it is logged and stays aside, still 423).
    The caller drops the index row afterwards."""
    try:
        aside = folder.set_aside(entity_id)
    except OSError:
        raise HTTPException(status_code=423, detail=ERR_DOCUMENT_LOCKED)
    except ValueError:
        aside = None  # an id no folder can have (hand-named file) has no documents
    if not md_path:
        return
    try:
        documents.retry_locked(lambda: Path(md_path).unlink(missing_ok=True))
    except OSError:
        if aside is not None:
            try:
                documents.undo_renames([(folder.dir_for(entity_id), aside)])
            except OSError:
                logger.warning("Atlas: Dokumentordner bleibt beiseitegelegt (%s), %s gesperrt", aside, md_path)
        raise HTTPException(status_code=423, detail=ERR_DOCUMENT_LOCKED)


def _linked_manuscript(name: str) -> tuple[dict, list[str]]:
    """One linked manuscript for the Literatur-Abgleich: its row and its cite
    keys. A link that is no valid manuscript id (``name_invalid``), a file
    that is not UTF-8 (``not_utf8``) or cannot be read (``unreadable``) is
    flagged with no keys — it never fails the check of the others."""
    stem = _stem(name)
    row = {"name": name, "id": stem, "found": False, "cite_count": 0, "problem": None}
    try:
        data = manuscripts.read(stem)
    except UnicodeDecodeError:  # before ValueError — it is one
        row["found"], row["problem"] = True, "not_utf8"
        return row, []
    except ValueError:
        row["problem"] = "name_invalid"
        return row, []
    except OSError:
        row["found"], row["problem"] = True, "unreadable"
        return row, []
    if data is None:
        return row, []
    keys = extract_cite_keys(data["content"])
    row["found"], row["cite_count"] = True, len(keys)
    return row, keys


def build_publication_router(store, broadcaster, library=None) -> APIRouter:
    router = APIRouter(tags=["atlas-publication"])

    def _publication_or_404(publication_id: str):
        publication = store.get_publication(publication_id)
        if publication is None:
            raise HTTPException(status_code=404, detail=ERR_PUBLICATION_NOT_FOUND)
        return publication

    def _resolve(key: str) -> Optional[dict]:
        getter = getattr(library, "get_reference", None) if library is not None else None
        if getter is None:
            return None
        try:
            return getter(key)
        except Exception:  # noqa: BLE001 - a host error reads as "not in the library"
            return None

    def _bib_entries(publication_id: str) -> list[dict]:
        entries: list[dict] = []
        try:
            listing = FOLDER.list_all(publication_id)
        except ValueError:
            return entries
        for doc in listing:
            if doc["name"].lower().endswith(".bib"):
                entries.extend(parse_bibtex_fields(FOLDER.read_text(publication_id, doc["name"]) or ""))
        return entries

    @router.get("/publications/{publication_id}/literature")
    async def publication_literature(publication_id: str):
        publication = _publication_or_404(publication_id)
        cited: list[str] = []
        linked = []
        for name in publication.manuscripts:
            row, keys = _linked_manuscript(name)
            linked.append(row)
            cited.extend(keys)
        collection = publication.collection or None
        if publication.collection_id is not None and collection and not collection.get("missing"):
            source = {"kind": "collection", "collection": collection}
        elif publication.refs:
            source = {"kind": "refs", "collection": None}
        else:
            source = {"kind": None, "collection": None}
        result = literature_rows(cited, publication.refs, _resolve, _bib_entries(publication_id))
        return {
            "publication_id": publication_id,
            "manuscripts": linked,
            "source": source,
            "library_available": library is not None,
            **result,
        }

    @router.post("/publications/{publication_id}/check-citations")
    async def check_citations(publication_id: str, payload: CitationText):
        _publication_or_404(publication_id)
        keys = extract_cite_keys(payload.text)
        return {"keys": keys, **citation_check(keys, _resolve, _bib_entries(publication_id))}

    # --- Dokumentordner veroeffentlichungen/<id>/ ---------------------------

    @router.get("/publications/{publication_id}/documents")
    async def list_publication_documents(publication_id: str):
        _publication_or_404(publication_id)
        try:
            docs = FOLDER.list_all(publication_id)
        except ValueError:
            raise HTTPException(status_code=422, detail=ERR_FILENAME_INVALID)
        return {"documents": docs, "folder": f"veroeffentlichungen/{publication_id}/"}

    @router.post("/publications/{publication_id}/documents")
    async def upload_publication_document(publication_id: str, file: UploadFile = File(...)):
        """Into the publication's own subfolder (P2); never overwrites."""
        _publication_or_404(publication_id)
        data = await file.read()
        try:
            meta = FOLDER.save(publication_id, file.filename or "", data)
        except ValueError:
            raise HTTPException(status_code=400, detail=ERR_FILENAME_INVALID)
        broadcaster.publish({"type": "archive-changed", "kind": "publication_document"})
        return meta

    @router.post("/publications/{publication_id}/documents/{name}/open")
    async def open_publication_document(publication_id: str, name: str):
        _publication_or_404(publication_id)
        try:
            path = FOLDER.path_for(publication_id, name)
        except ValueError:
            raise HTTPException(status_code=422, detail=ERR_FILENAME_INVALID)
        if not path.is_file():
            raise HTTPException(status_code=404, detail=ERR_DOCUMENT_NOT_FOUND)
        documents.open_in_viewer(path)
        return {"status": "ok"}

    @router.delete("/publications/{publication_id}/documents/{name}")
    async def delete_publication_document(publication_id: str, name: str):
        _publication_or_404(publication_id)
        try:
            await run_in_threadpool(FOLDER.delete, publication_id, name)
        except ValueError:
            raise HTTPException(status_code=422, detail=ERR_FILENAME_INVALID)
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail=ERR_DOCUMENT_NOT_FOUND)
        except OSError:
            raise HTTPException(status_code=423, detail=ERR_DOCUMENT_LOCKED)
        broadcaster.publish({"type": "archive-changed", "kind": "publication_document"})
        return {"status": "ok"}

    return router
