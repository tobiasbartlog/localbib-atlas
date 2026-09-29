"""Atlas Verweise — the one edge table behind every Rueckverweis (ADR-0020).

Every ``[[id]]`` in a body (Idee, Kapitel, Projekt, Veroeffentlichung, Zettel)
and in every Task line is an edge ``(from_kind, from_id) -> to_id``. The
**Rueckverweis** of a detail page is that table read backwards.

``to_id`` is never resolved: a hanging Verweis is allowed, shows up in
``store.check()`` as a warning and is never repaired. The table is derived like
everything else in ``atlas.db`` — a reindex rebuilds it from the files (P1).

Pure SQL helpers over a caller-supplied connection; stdlib only (P3).
"""

from __future__ import annotations

import sqlite3
from typing import Iterable, Optional

LINKS_DDL = """
CREATE TABLE IF NOT EXISTS links (
    from_kind TEXT NOT NULL,
    from_id   TEXT NOT NULL,
    to_id     TEXT NOT NULL,
    ord       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (from_kind, from_id, to_id)
);
CREATE INDEX IF NOT EXISTS links_to_id ON links (to_id);
"""

# from_kind values. The entity kinds double as the ``kind`` of the SSE event
# and of the /entities autocomplete list, so they are spelled once, here.
KIND_IDEA = "idea"
KIND_DISS_NODE = "diss_node"
KIND_PROJECT = "project"
KIND_PUBLICATION = "publication"
KIND_ZETTEL = "zettel"
KIND_TASK = "task"

ENTITY_KINDS = (KIND_IDEA, KIND_DISS_NODE, KIND_PROJECT, KIND_PUBLICATION, KIND_ZETTEL)


def task_source_id(week: str, body_index: int) -> str:
    """The ``from_id`` of a Task edge: ``<week>#<body_index>`` (ADR-0020)."""
    return f"{week}#{body_index}"


def parse_task_source_id(from_id: str) -> Optional[tuple[str, int]]:
    """``'2026-W39#3'`` -> ``('2026-W39', 3)``; None when it is not a Task id."""
    week, _, index = str(from_id or "").rpartition("#")
    if not week or not index.isdigit():
        return None
    return week, int(index)


def replace_edges(
    conn: sqlite3.Connection, from_kind: str, from_id: str, to_ids: Iterable[str]
) -> None:
    """Make ``to_ids`` the complete set of edges leaving ``(from_kind, from_id)``."""
    conn.execute(
        "DELETE FROM links WHERE from_kind = ? AND from_id = ?", (from_kind, from_id)
    )
    rows = []
    for i, to_id in enumerate(to_ids):
        target = str(to_id).strip()
        if target:
            rows.append((from_kind, from_id, target, i))
    conn.executemany(
        "INSERT OR REPLACE INTO links (from_kind, from_id, to_id, ord) VALUES (?,?,?,?)",
        rows,
    )


def delete_edges(conn: sqlite3.Connection, from_kind: str, from_id: str) -> None:
    """Drop every edge of one source — what removing a file means for links."""
    conn.execute(
        "DELETE FROM links WHERE from_kind = ? AND from_id = ?", (from_kind, from_id)
    )


def delete_week_edges(conn: sqlite3.Connection, week: str) -> None:
    """Drop the Task edges of one Journal week (all its ``<week>#n`` sources)."""
    conn.execute(
        "DELETE FROM links WHERE from_kind = ? AND from_id LIKE ?",
        (KIND_TASK, f"{week}#%"),
    )


def wipe(conn: sqlite3.Connection) -> None:
    """Empty the edge table — the first step of a full reindex."""
    conn.execute("DELETE FROM links")


def edges_to(conn: sqlite3.Connection, to_id: str) -> list[sqlite3.Row]:
    """Every edge pointing at ``to_id`` (the raw Rueckverweise)."""
    if not to_id:
        return []
    return conn.execute(
        "SELECT from_kind, from_id, ord FROM links WHERE to_id = ?"
        " ORDER BY from_kind, from_id",
        (to_id,),
    ).fetchall()


def all_edges(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT from_kind, from_id, to_id FROM links ORDER BY from_kind, from_id, ord"
    ).fetchall()
