"""Generic CRUD + reindex engine shared by Atlas's four Markdown-backed
entities (Idea, DissNode, Project, Publication).

All four are indexed the same way: glob a folder, parse each file, call an
entity-specific indexer, track id-collisions, count invalid files. Before this
module that shape (plus get/list/delete/save_file) was hand-copied four times
in atlas/store.py — most visibly in reindex(), where the comment "same
idempotent full-rebuild pattern" was literally copy-pasted three times
instead of being true.

What stays OUT of here, deliberately: the entity-specific INSERT/UPDATE
statements (column lists, JSON-encoding of list fields, the idea_anchors side
table) and every bespoke relationship query (links_for,
publications_for_project, node_links, ...) — those differ meaningfully per
entity and stay hand-written on AtlasStore.

Three rules every entity shares live here too, because hand edits are
first-class (P1): a file the reindex cannot read is skipped and named, never
fatal — a lock is retried first (:func:`index_or_skip`); a NEW entity never
takes an id whose ``<id>.md`` is on disk, indexed or not (:func:`free_id`);
and an update rewrites the file the index read it from, never over a version
the index has not read (:func:`check_current`, :class:`FileChanged`).
"""

from __future__ import annotations

import logging
import sqlite3
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional

from atlas.domain import slugify

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class EntitySpec:
    """Everything the generic functions below need for one entity.

    ``index_one`` / ``row_to_entity`` point at the entity-specific logic that
    stays hand-written on AtlasStore (see module docstring) — this spec only
    wires it up so the generic CRUD/reindex shape can call it.
    """
    label: str                                    # e.g. "idea" — diagnostics only
    table: str
    order_by: str                                  # SQL, without "ORDER BY "
    dir_fn: Callable[[], Path]
    from_file: Callable[[Any], Any]                # Idea.from_file
    index_one: Callable[[Any, Any], None]           # AtlasStore.index_idea(store, entity)
    row_to_entity: Callable[[sqlite3.Row], Any]     # _row_to_idea


class FileChanged(Exception):
    """An entity file on disk that is not what the index read: a hand edit
    the indexer could not read (broken YAML — the watcher logs it and keeps
    the old row) or has not read yet, or another file with this id (a sync
    conflict copy) is the indexed one. An update writes the whole file from
    the index row, so writing now would put stale data over the user's edit
    (P1): the write stops before it starts (:func:`ensure_current`). The API
    answers 409 ``error.atlas.file_changed`` naming :attr:`file`
    (:mod:`atlas.api_errors`)."""

    def __init__(self, path: Path, reason: str) -> None:
        super().__init__(f"{path}: {reason}")
        self.path = Path(path)
        self.reason = reason

    @property
    def file(self) -> str:
        """The file as the user finds it in the Atlas folder: ``ideen/<id>.md``."""
        return f"{self.path.parent.name}/{self.path.name}"


def get_by_id(connect: Callable[[], sqlite3.Connection], spec: EntitySpec, entity_id: str):
    with closing(connect()) as conn:
        row = conn.execute(f"SELECT * FROM {spec.table} WHERE id = ?", (entity_id,)).fetchone()
    return spec.row_to_entity(row) if row else None


def list_all(connect: Callable[[], sqlite3.Connection], spec: EntitySpec) -> list:
    with closing(connect()) as conn:
        rows = conn.execute(f"SELECT * FROM {spec.table} ORDER BY {spec.order_by}").fetchall()
    return [spec.row_to_entity(r) for r in rows]


def delete_by_id(connect: Callable[[], sqlite3.Connection], spec: EntitySpec, entity_id: str) -> None:
    with closing(connect()) as conn:
        conn.execute(f"DELETE FROM {spec.table} WHERE id = ?", (entity_id,))
        conn.commit()


def index_file(spec: EntitySpec, store: Any, path) -> Any:
    entity = spec.from_file(path)
    spec.index_one(store, entity)
    return entity


def save_file(spec: EntitySpec, entity: Any, connect: Callable[[], sqlite3.Connection]) -> Path:
    """Write ``entity`` to its file (:func:`file_for`, a new one is
    ``<dir>/<id>.md``) and return the path. Does NOT touch the DB — the
    watcher/indexer is the single DB writer (P1). An existing file is
    rewritten only while it is what the index read (:func:`check_current`),
    else :class:`FileChanged` and nothing written."""
    spec.dir_fn().mkdir(parents=True, exist_ok=True)
    path = check_current(spec, connect, entity)
    path.write_text(entity.to_markdown(), encoding="utf-8")
    entity.path = str(path)
    return path


def file_for(spec: EntitySpec, entity: Any) -> Path:
    """The file an update of ``entity`` rewrites: the one the index read it
    from when that lies in ``spec``'s folder — also a hand-named ``Mein
    Entwurf.md``, since the id comes from the frontmatter first —, else
    ``<dir>/<id>.md``: a new entity, or one moving in from the other folder
    (the type switch writes there under its id)."""
    directory = spec.dir_fn()
    if entity.path and Path(entity.path).parent == directory:
        return Path(entity.path)
    return directory / f"{entity.id}.md"


def check_current(spec: EntitySpec, connect: Callable[[], sqlite3.Connection], entity: Any) -> Path:
    """:func:`ensure_current` for the file an update of ``entity`` writes
    (:func:`file_for`) — and for ``<dir>/<id>.md`` when that is another
    file: a conflict copy indexed under the id never gets the original
    written over or beside it. Returns that file. The one check of
    :func:`save_file` and ``AtlasStore.ensure_current`` (the type switch,
    promote), so the two never disagree about which file is the entity's."""
    path = file_for(spec, entity)
    for candidate in dict.fromkeys((path, spec.dir_fn() / f"{entity.id}.md")):
        ensure_current(spec, connect, entity.id, candidate)
    return path


def ensure_current(
    spec: EntitySpec, connect: Callable[[], sqlite3.Connection], entity_id: str, path
) -> None:
    """Raise :class:`FileChanged` unless ``path`` — a file about to be
    rewritten (or moved) from the index row of ``entity_id`` — is exactly
    what the index read: it parses and has the row's ``content_hash``. A
    missing file passes, there is nothing on disk to lose (a NEW id from
    :func:`free_id` never has one). A lock stays an ``OSError``."""
    path = Path(path)
    if not path.exists():
        return
    try:
        on_disk = spec.from_file(path)
    except OSError:
        raise
    except Exception as exc:  # noqa: BLE001 - whatever does not parse is not what the index read
        raise FileChanged(path, f"nicht lesbar: {exc}") from exc
    with closing(connect()) as conn:
        row = conn.execute(
            f"SELECT content_hash FROM {spec.table} WHERE id = ?", (entity_id,)
        ).fetchone()
    if row is None or row["content_hash"] != on_disk.content_hash:
        raise FileChanged(path, "seit dem Einlesen geaendert")


def free_id(base: str, exists: Callable[[str], bool], directory: Path) -> str:
    """``base``, else ``base-2``, ``-3``…: the first id for a NEW entity that
    the index does not have (``exists``) and no ``<id>.md`` in ``directory``
    holds — an unindexed file (a hand edit the reindex skipped, one the
    watcher has not seen yet) is never overwritten. A ``base`` whose file
    would not land directly in ``directory`` (``../../x`` from an imported
    frontmatter or a hand-written request) becomes its slug, else
    ``eintrag``: Atlas writes only into its own folder (P2)."""
    target = Path(directory) / f"{base}.md"
    if not base or target.parent != Path(directory) or target.name != f"{base}.md":
        base = slugify(base) or "eintrag"

    def taken(candidate: str) -> bool:
        return exists(candidate) or (directory / f"{candidate}.md").exists()

    if not taken(base):
        return base
    n = 2
    while taken(f"{base}-{n}"):
        n += 1
    return f"{base}-{n}"


def _index_failed(exc: Exception) -> bool:
    """Whether ``exc`` is ``atlas.db`` itself failing — locked, out of disk,
    corrupt (a bare ``DatabaseError``: "file is not a database") — rather than
    one file: a value the INSERT cannot bind (a YAML list where the index holds
    text: ``ProgrammingError``) or a constraint it breaks is that file's."""
    return (isinstance(exc, (sqlite3.OperationalError, sqlite3.InternalError))
            or type(exc) is sqlite3.DatabaseError)


def index_or_skip(path, index: Callable[[Any], Any], unreadable: list[dict]) -> Optional[Any]:
    """One file of a full reindex. A file that cannot be read as an entity —
    YAML the user broke by hand (``title: a: b``), a value the index cannot
    hold — is logged, named in ``unreadable`` (``{path, error, locked}``) and
    skipped: one bad file never stops the rest, nor Atlas from starting. A
    lock (OneDrive, an editor) is retried like every file operation of Atlas
    (:func:`atlas.documents.retry_locked`) — a valid file is not dropped from
    the index for a whole session over a moment's lock; one that outlasts the
    retries is skipped the same way, named ``locked``. A failing ``atlas.db``
    (:func:`_index_failed`) is no bad file: it goes up. Returns None for a
    skipped file."""
    from atlas import documents  # imports this module: resolved at call time

    try:
        return documents.retry_locked(lambda: index(path))
    except PermissionError as exc:
        logger.warning("Atlas: %s gesperrt, nicht eingelesen: %s", path, exc)
        unreadable.append({"path": str(path), "error": f"gesperrt: {exc}", "locked": True})
    except Exception as exc:  # noqa: BLE001 - never let a bad file stop the reindex
        if _index_failed(exc):
            raise  # the index itself failed — a system failure, never one file's
        logger.warning("Atlas: %s nicht eingelesen, uebersprungen: %s", path, exc)
        unreadable.append({"path": str(path), "error": str(exc), "locked": False})
    return None


def reindex_one(
    spec: EntitySpec,
    store: Any,
    connect: Callable[[], sqlite3.Connection],
) -> dict:
    """One idempotent full-rebuild pass over ``spec``'s folder: wipe the
    table, re-index every file, report duplicates and the invalid count — an
    unreadable file counts as invalid and is named in ``unreadable``.
    Non-recursive glob — per-entity document subfolders are never scanned."""
    files = sorted(spec.dir_fn().glob("*.md")) if spec.dir_fn().exists() else []
    seen: dict[str, str] = {}
    duplicates: list[dict] = []
    unreadable: list[dict] = []
    invalid = 0
    with closing(connect()) as conn:
        conn.execute(f"DELETE FROM {spec.table}")
        conn.commit()
    for path in files:
        entity = index_or_skip(path, lambda p: index_file(spec, store, p), unreadable)
        if entity is None or entity.validate():
            invalid += 1
        if entity is None:
            continue
        if entity.id in seen:
            duplicates.append({"id": entity.id, "paths": [seen[entity.id], str(path)]})
        else:
            seen[entity.id] = str(path)
    return {
        "count": len(files), "invalid": invalid,
        "duplicates": duplicates, "unreadable": unreadable,
    }
