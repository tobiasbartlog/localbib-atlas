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
"""

from __future__ import annotations

import sqlite3
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


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


def save_file(spec: EntitySpec, entity: Any) -> Path:
    """Write ``entity`` to ``<dir>/<id>.md`` and return the path. Does NOT
    touch the DB — the watcher/indexer is the single DB writer (P1)."""
    d = spec.dir_fn()
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{entity.id}.md"
    path.write_text(entity.to_markdown(), encoding="utf-8")
    entity.path = str(path)
    return path


def reindex_one(
    spec: EntitySpec,
    store: Any,
    connect: Callable[[], sqlite3.Connection],
) -> dict:
    """One idempotent full-rebuild pass over ``spec``'s folder: wipe the
    table, re-index every file, report duplicates and the invalid count.
    Non-recursive glob — per-entity document subfolders are never scanned."""
    files = sorted(spec.dir_fn().glob("*.md")) if spec.dir_fn().exists() else []
    seen: dict[str, str] = {}
    duplicates: list[dict] = []
    invalid = 0
    with closing(connect()) as conn:
        conn.execute(f"DELETE FROM {spec.table}")
        conn.commit()
    for path in files:
        entity = index_file(spec, store, path)
        if entity.validate():
            invalid += 1
        if entity.id in seen:
            duplicates.append({"id": entity.id, "paths": [seen[entity.id], str(path)]})
        else:
            seen[entity.id] = str(path)
    return {"count": len(files), "invalid": invalid, "duplicates": duplicates}
