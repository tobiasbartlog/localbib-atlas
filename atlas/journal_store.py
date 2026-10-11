"""Atlas Journal store — the file side of the Werkbank (issue #180, ADR-0020).

The Journal of one ISO week is a Markdown file ``journal/<YYYY-Www>.md``. This
module is the only place that reads and writes those files, and every write is
a **line operation** from :mod:`atlas.journal` — the body of every untouched
line stays byte-identical, also when the Wochenziele are re-serialised.

Journal deliberately does **not** use the generic entity save
(:mod:`atlas.entity_store`): it shares listing and reindex with the four
classic entities, not the "write the whole file from an object" path. The
write order is always the Datenfluss of the Atlas rules: file first, index
second (``UI -> Markdown -> Indexer -> atlas.db``).

Imports only stdlib + Atlas submodules (P3). The public functions take a
``connect`` callable so the store stays the owner of the connection.
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Callable, Iterable, Optional

from atlas import config, index_links, journal as journal_mod
from atlas.journal import MAX_GOALS, Journal, normalize_goal
from atlas.weeks import as_date, is_week_id, week_contains, week_id

Connect = Callable[[], sqlite3.Connection]

JOURNAL_DDL = """
CREATE TABLE IF NOT EXISTS journal_weeks (
    week   TEXT PRIMARY KEY,
    goals  TEXT NOT NULL DEFAULT '[]',
    path   TEXT,
    valid  INTEGER NOT NULL DEFAULT 1,
    errors TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS journal_tasks (
    week       TEXT NOT NULL,
    day        TEXT,
    body_index INTEGER NOT NULL,
    text       TEXT NOT NULL DEFAULT '',
    done       INTEGER NOT NULL DEFAULT 0,
    anchors    TEXT NOT NULL DEFAULT '[]',
    tags       TEXT NOT NULL DEFAULT '[]',
    moved_to   TEXT,
    moved_from TEXT,
    PRIMARY KEY (week, body_index)
);

CREATE INDEX IF NOT EXISTS journal_tasks_day ON journal_tasks (day);
"""


# --- files -------------------------------------------------------------------

def journal_path(week: str) -> Path:
    """``journal/<week>.md`` — the file of one ISO week (may not exist)."""
    return config.journal_dir() / f"{ensure_week(week)}.md"


def ensure_week(week: str) -> str:
    if not is_week_id(week):
        raise ValueError(f"Keine ISO-Wochen-ID (YYYY-Www): {week!r}")
    return week


def read_journal(week: str) -> Journal:
    """The week's Journal. A missing file yields an **empty** Journal with
    ``path = None``; reading never creates a file."""
    path = journal_path(week)
    if not path.exists():
        return Journal(week=week)
    return Journal.from_file(path)


def write_journal(journal: Journal) -> Path:
    """Write the Journal to its week file. Does not touch the index."""
    path = journal_path(journal.week)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(journal.to_markdown(), encoding="utf-8")
    journal.path = str(path)
    return path


# --- indexing ----------------------------------------------------------------

def _task_row(week: str, task: dict) -> tuple:
    return (
        week,
        task.get("day"),
        task["body_index"],
        task.get("text") or "",
        1 if task.get("done") else 0,
        json.dumps(task.get("anchors") or []),
        json.dumps(task.get("tags") or []),
        task.get("moved_to"),
        task.get("moved_from"),
    )


def index_journal(conn: sqlite3.Connection, journal: Journal) -> None:
    """Replace the index rows and the Task edges of one week (single writer)."""
    week = journal.week
    errors = journal.validate()
    conn.execute("DELETE FROM journal_tasks WHERE week = ?", (week,))
    index_links.delete_week_edges(conn, week)
    conn.execute(
        """INSERT INTO journal_weeks (week, goals, path, valid, errors)
           VALUES (?,?,?,?,?)
           ON CONFLICT(week) DO UPDATE SET
             goals=excluded.goals, path=excluded.path,
             valid=excluded.valid, errors=excluded.errors""",
        (
            week,
            json.dumps([normalize_goal(g) for g in journal.goals]),
            journal.path,
            0 if errors else 1,
            json.dumps(errors),
        ),
    )
    tasks = journal.tasks
    conn.executemany(
        """INSERT INTO journal_tasks
           (week, day, body_index, text, done, anchors, tags, moved_to, moved_from)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        [_task_row(week, t) for t in tasks],
    )
    for task in tasks:
        index_links.replace_edges(
            conn,
            index_links.KIND_TASK,
            index_links.task_source_id(week, task["body_index"]),
            task.get("anchors") or [],
        )


def index_journal_file(connect: Connect, path) -> Journal:
    journal = Journal.from_file(path)
    if not journal.week:
        journal.week = Path(path).stem
    with closing(connect()) as conn:
        index_journal(conn, journal)
        conn.commit()
    return journal


def remove_week(connect: Connect, week: str) -> None:
    with closing(connect()) as conn:
        _remove_week(conn, week)
        conn.commit()


def _remove_week(conn: sqlite3.Connection, week: str) -> None:
    conn.execute("DELETE FROM journal_tasks WHERE week = ?", (week,))
    conn.execute("DELETE FROM journal_weeks WHERE week = ?", (week,))
    index_links.delete_week_edges(conn, week)


def remove_path(conn: sqlite3.Connection, path) -> None:
    """Forget the week indexed from ``path`` — including its Task edges."""
    row = conn.execute(
        "SELECT week FROM journal_weeks WHERE path = ?", (str(path),)
    ).fetchone()
    if row is not None:
        _remove_week(conn, row["week"])
    elif Path(path).parent == config.journal_dir():
        _remove_week(conn, Path(path).stem)


def reindex_journals(connect: Connect) -> dict:
    """Full rebuild of ``journal_weeks``/``journal_tasks`` and the Task edges
    from ``journal/*.md`` (P1: atlas.db stays disposable)."""
    directory = config.journal_dir()
    files = sorted(directory.glob("*.md")) if directory.exists() else []
    with closing(connect()) as conn:
        conn.execute("DELETE FROM journal_tasks")
        conn.execute("DELETE FROM journal_weeks")
        conn.execute(
            "DELETE FROM links WHERE from_kind = ?", (index_links.KIND_TASK,)
        )
        conn.commit()
    invalid = 0
    for path in files:
        journal = index_journal_file(connect, path)
        if journal.validate():
            invalid += 1
    return {"count": len(files), "invalid": invalid}


# --- reads -------------------------------------------------------------------

def _row_to_task(row: sqlite3.Row) -> dict:
    done = bool(row["done"])
    moved_to = row["moved_to"]
    return {
        "week": row["week"],
        "day": row["day"],
        "body_index": row["body_index"],
        "text": row["text"],
        "done": done,
        "open": not done and not moved_to,
        "anchors": json.loads(row["anchors"]),
        "tags": json.loads(row["tags"]),
        "moved_to": moved_to,
        "moved_from": row["moved_from"],
    }


def list_weeks(connect: Connect) -> list[dict]:
    """Every indexed week, newest first: ``{week, goals, path}``."""
    with closing(connect()) as conn:
        rows = conn.execute(
            "SELECT week, goals, path FROM journal_weeks ORDER BY week DESC"
        ).fetchall()
    return [
        {"week": r["week"], "goals": json.loads(r["goals"]), "path": r["path"]}
        for r in rows
    ]


def list_tasks(connect: Connect, *, weeks: Optional[Iterable[str]] = None) -> list[dict]:
    """Indexed Tasks across weeks, ordered by day (undated last)."""
    sql = "SELECT * FROM journal_tasks"
    params: list = []
    if weeks is not None:
        week_list = list(weeks)
        if not week_list:
            return []
        sql += f" WHERE week IN ({','.join('?' * len(week_list))})"
        params = week_list
    sql += " ORDER BY day IS NULL, day, week, body_index"
    with closing(connect()) as conn:
        rows = conn.execute(sql, params).fetchall()
    return [_row_to_task(r) for r in rows]


def tasks_for_anchor(connect: Connect, anchor: str, *, open_only: bool = False) -> list[dict]:
    """Tasks carrying ``[[anchor]]``, across all weeks — the Kapitel-Hub and
    every detail page read their Tasks here (resolved via the edge index)."""
    if not anchor:
        return []
    with closing(connect()) as conn:
        rows = conn.execute(
            """SELECT t.* FROM journal_tasks t
               JOIN links l ON l.from_kind = ?
                           AND l.from_id = t.week || '#' || t.body_index
               WHERE l.to_id = ?
               ORDER BY t.day IS NULL, t.day, t.week, t.body_index""",
            (index_links.KIND_TASK, anchor),
        ).fetchall()
    tasks = [_row_to_task(r) for r in rows]
    return [t for t in tasks if t["open"]] if open_only else tasks


def tasks_by_source(connect: Connect, source_ids: Iterable[str]) -> dict[str, dict]:
    """``{from_id: task}`` for Task edge sources (``<week>#<body_index>``)."""
    keys = [k for k in source_ids if index_links.parse_task_source_id(k)]
    if not keys:
        return {}
    out: dict[str, dict] = {}
    with closing(connect()) as conn:
        for key in keys:
            week, body_index = index_links.parse_task_source_id(key)
            row = conn.execute(
                "SELECT * FROM journal_tasks WHERE week = ? AND body_index = ?",
                (week, body_index),
            ).fetchone()
            if row is not None:
                out[key] = _row_to_task(row)
    return out


# --- write primitives (file first, index second) -----------------------------

def _persist(connect: Connect, journal: Journal) -> Journal:
    write_journal(journal)
    with closing(connect()) as conn:
        index_journal(conn, journal)
        conn.commit()
    return journal


def _task_result(journal: Journal, body_index: int) -> dict:
    task = journal_mod.find_task(journal.body, body_index)
    return {"week": journal.week, **(task or {"body_index": body_index})}


def add_task(connect: Connect, week: str, day, text: str) -> dict:
    """Append a Task to ``day``; creates the week file and the day section."""
    iso = as_date(day).isoformat()
    if not week_contains(ensure_week(week), iso):
        raise ValueError(f"Tag {iso} liegt ausserhalb der Woche {week}")
    journal = read_journal(week)
    journal.body, body_index = journal_mod.append_task(journal.body, iso, text)
    _persist(connect, journal)
    return _task_result(journal, body_index)


def update_task(connect: Connect, week: str, body_index: int, text: str) -> dict:
    journal = read_journal(week)
    journal.body = journal_mod.replace_task(journal.body, body_index, text)
    _persist(connect, journal)
    return _task_result(journal, body_index)


def toggle_task(connect: Connect, week: str, body_index: int) -> dict:
    journal = read_journal(week)
    journal.body = journal_mod.toggle_task(journal.body, body_index)
    _persist(connect, journal)
    return _task_result(journal, body_index)


def delete_task(connect: Connect, week: str, body_index: int) -> None:
    journal = read_journal(week)
    journal.body = journal_mod.delete_task(journal.body, body_index)
    _persist(connect, journal)


def reorder_task(connect: Connect, week: str, body_index: int, position: int) -> dict:
    journal = read_journal(week)
    journal.body = journal_mod.reorder_task(journal.body, body_index, position)
    _persist(connect, journal)
    return {"week": journal.week, "tasks": journal.tasks}


def move_task(connect: Connect, week: str, body_index: int, to_day) -> dict:
    """Uebertrag: mark the source line with ``→`` and carry the Task to
    ``to_day`` with ``←``. A target in another week writes (and creates) that
    week's file too — the two-file case of ADR-0020."""
    iso = as_date(to_day).isoformat()
    source = read_journal(ensure_week(week))
    target_week = week_id(iso)
    same_week = target_week == source.week
    target = source if same_week else read_journal(target_week)

    result = journal_mod.move_task(
        source.body, body_index, iso, target_body=None if same_week else target.body
    )
    source.body = result.source_body
    _persist(connect, source)
    if not same_week:
        target.body = result.target_body
        _persist(connect, target)
    return {
        "week": target.week,
        "day": result.target_day,
        "body_index": result.target_index,
        "source_week": source.week,
        "source_index": result.source_index,
    }


def undo_move(connect: Connect, week: str, body_index: int, to_week: str, to_index: int) -> dict:
    """"Übertrag zurücknehmen" (#224): the inverse of :func:`move_task` as a
    line operation on one or both week files (ADR-0020). ``week``/``body_index``
    is the source line, ``to_week``/``to_index`` the carried one."""
    source = read_journal(ensure_week(week))
    same_week = ensure_week(to_week) == source.week
    target = source if same_week else read_journal(to_week)
    result = journal_mod.undo_move(
        source.body, body_index, to_index, target_body=None if same_week else target.body
    )
    source.body = result.source_body
    _persist(connect, source)
    if not same_week:
        target.body = result.target_body
        _persist(connect, target)
    return {"week": source.week, "body_index": result.source_index}


def set_goals(connect: Connect, week: str, goals: Iterable) -> Journal:
    """Replace the Wochenziele. The frontmatter is re-serialised, the body
    stays byte-identical (ADR-0020)."""
    normalized = [normalize_goal(g) for g in goals]
    if len(normalized) > MAX_GOALS:
        raise ValueError(f"hoechstens {MAX_GOALS} Wochenziele (sind {len(normalized)})")
    for i, goal in enumerate(normalized):
        if not goal["title"]:
            raise ValueError(f"Wochenziel {i + 1}: Pflichtfeld fehlt: title")
    journal = read_journal(ensure_week(week))
    journal.goals = normalized
    return _persist(connect, journal)


def toggle_goal(connect: Connect, week: str, index: int) -> Journal:
    journal = read_journal(ensure_week(week))
    if not 0 <= index < len(journal.goals):
        raise KeyError(f"Kein Wochenziel mit Index {index}")
    goals = [normalize_goal(g) for g in journal.goals]
    goals[index]["done"] = not goals[index]["done"]
    journal.goals = goals
    return _persist(connect, journal)
