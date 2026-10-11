"""Atlas Werkbank — "Was liegt an" and the Rueckblick (issue #180).

Pure functions over data the caller has **already loaded**: no DB, no
filesystem, no clock beyond the ``today`` the caller hands in (P3, ADR-0006
philosophy). The thresholds are constants by decision — "Was liegt an" is a
reminder, not a configuration surface.

The Rueckblick is derived, never recorded: it counts what the Tasks, Zettel,
Wochenziele and chapter mtimes of one week already say. There is deliberately
no event log (see the spec's *Was NICHT gebaut wird*).
"""

from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Iterable, Optional

from atlas.domain import PUBLICATION_CLOSED_STATUSES, annotate_milestones
from atlas.journal import goal_progress
from atlas.weeks import as_date, today_or, week_contains, week_dates

# Thresholds — constants, not settings.
DUE_SOON_DAYS = 14       # milestones and deadlines due within two weeks (or overdue)
CHAPTER_STALE_DAYS = 21  # a Kapitel untouched this long has stalled
IDEA_SEED_STALE_DAYS = 60  # an Idee sitting in status seed this long
SUBMITTED_NUDGE_DAYS = 56  # eight weeks "Eingereicht" -> ask the journal (#223)

# A Publication in one of these states has no open deadline any more: it is
# published, or folded away below the Pipeline (domain's closed states).
CLOSED_PUBLICATION_STATUSES = frozenset({"published", *PUBLICATION_CLOSED_STATUSES})

_ID_DATE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})")


def _as_day(value) -> Optional[date]:
    """First 10 characters of an ISO date/datetime as a ``date``; None when
    the value is missing or unparsable (a missing mtime is not a finding)."""
    if value is None:
        return None
    if isinstance(value, date):
        return value
    text = str(value).strip()[:10]
    try:
        return date.fromisoformat(text)
    except ValueError:
        return None


def _created_day(entity: dict) -> Optional[date]:
    """Creation day of an Idea: its ``created`` field, else the date prefix of
    its id (``YYYY-MM-DD-<slug>``, how quick capture builds it)."""
    day = _as_day(entity.get("created"))
    if day is not None:
        return day
    m = _ID_DATE_RE.match(str(entity.get("id") or ""))
    return _as_day(m.group(1)) if m else None


def _field(entity, name, default=None):
    if isinstance(entity, dict):
        return entity.get(name, default)
    return getattr(entity, name, default)


def whats_due(
    *,
    projects: Iterable = (),
    chapters: Iterable = (),
    ideas: Iterable = (),
    publications: Iterable = (),
    today: Optional[date] = None,
) -> dict:
    """"Was liegt an" over already-loaded Atlas data.

    - ``milestones``: milestones of the Atlas Projects overdue or due within
      :data:`DUE_SOON_DAYS` (built on the existing milestone annotation).
    - ``stale_chapters``: Kapitel unchanged for :data:`CHAPTER_STALE_DAYS`
      (``modified_at`` — the file mtime, supplied by the caller).
    - ``stale_ideas``: Ideen in status ``seed`` for :data:`IDEA_SEED_STALE_DAYS`.
    - ``deadlines``: Veroeffentlichungen whose ``due`` is overdue or within
      :data:`DUE_SOON_DAYS`, unless published/rejected/withdrawn (#223).
    - ``follow_ups``: Veroeffentlichungen in ``submitted`` for more than
      :data:`SUBMITTED_NUDGE_DAYS` days ("nachfragen?", #223).

    Every entry carries ``days`` — negative = overdue / days in the past.
    """
    now = today_or(today)
    horizon = now + timedelta(days=DUE_SOON_DAYS)

    milestones: list[dict] = []
    for project in projects:
        pid = _field(project, "id")
        ptitle = _field(project, "title")
        for m in annotate_milestones(list(_field(project, "milestones") or []), today=now):
            if m["state"] not in ("overdue", "upcoming"):
                continue
            due = _as_day(m["date"])
            if due is None or due > horizon:
                continue
            milestones.append(
                {
                    "project_id": pid,
                    "project_title": ptitle,
                    "index": m["index"],
                    "title": m["title"],
                    "date": m["date"],
                    "state": m["state"],
                    "days": (due - now).days,
                }
            )
    milestones.sort(key=lambda m: (m["date"], str(m["project_id"])))

    stale_chapters: list[dict] = []
    for chapter in chapters:
        modified = _as_day(_field(chapter, "modified_at"))
        if modified is None:
            continue
        age = (now - modified).days
        if age >= CHAPTER_STALE_DAYS:
            stale_chapters.append(
                {
                    "id": _field(chapter, "id"),
                    "title": _field(chapter, "title"),
                    "modified_at": modified.isoformat(),
                    "days": -age,
                }
            )
    stale_chapters.sort(key=lambda c: c["days"])

    stale_ideas: list[dict] = []
    for idea in ideas:
        data = idea if isinstance(idea, dict) else {
            "id": _field(idea, "id"),
            "title": _field(idea, "title"),
            "status": _field(idea, "status"),
            "created": _field(idea, "created"),
        }
        if (data.get("status") or "") != "seed":
            continue
        created = _created_day(data)
        if created is None:
            continue
        age = (now - created).days
        if age >= IDEA_SEED_STALE_DAYS:
            stale_ideas.append(
                {
                    "id": data.get("id"),
                    "title": data.get("title"),
                    "created": created.isoformat(),
                    "days": -age,
                }
            )
    stale_ideas.sort(key=lambda i: i["days"])

    deadlines: list[dict] = []
    follow_ups: list[dict] = []
    for pub in publications:
        status = str(_field(pub, "status") or "")
        if status in CLOSED_PUBLICATION_STATUSES:
            continue
        due = _as_day(_field(pub, "due"))
        if due is not None and due <= horizon:
            deadlines.append(
                {
                    "id": _field(pub, "id"),
                    "title": _field(pub, "title"),
                    "status": status,
                    "venue": _field(pub, "venue"),
                    "date": due.isoformat(),
                    "state": "overdue" if due < now else "upcoming",
                    "days": (due - now).days,
                }
            )
        submitted = _as_day(_field(pub, "submitted"))
        if status == "submitted" and submitted is not None:
            waiting = (now - submitted).days
            if waiting > SUBMITTED_NUDGE_DAYS:
                follow_ups.append(
                    {
                        "id": _field(pub, "id"),
                        "title": _field(pub, "title"),
                        "venue": _field(pub, "venue"),
                        "submitted": submitted.isoformat(),
                        "days": -waiting,
                    }
                )
    deadlines.sort(key=lambda d: (d["date"], str(d["id"])))
    follow_ups.sort(key=lambda f: f["days"])

    return {
        "milestones": milestones,
        "stale_chapters": stale_chapters,
        "stale_ideas": stale_ideas,
        "deadlines": deadlines,
        "follow_ups": follow_ups,
    }


def open_tasks_before(tasks: Iterable[dict], day) -> list[dict]:
    """Open Tasks of the days *before* ``day`` — the "offen von Vortagen"
    block. Moved (``→``) and done Tasks are not open (pure, order kept)."""
    cutoff = as_date(day).isoformat()
    return [
        t
        for t in tasks
        if t.get("open") and t.get("day") and t["day"] < cutoff
    ]


def carried_tasks(tasks: Iterable[dict]) -> list[dict]:
    """Tasks that were pushed forward more than once, most-pushed first.

    An Uebertrag leaves a chain of lines with the same display text: the
    source carries ``→``, every following copy carries ``←`` (and ``→`` again
    when it was moved on). Counting the ``→`` lines of one text therefore
    counts how often it was pushed."""
    groups: dict[str, dict] = {}
    for t in tasks:
        text = (t.get("text") or "").strip()
        if not text:
            continue
        g = groups.setdefault(text, {"text": text, "moves": 0, "days": [], "done": False})
        if t.get("day"):
            g["days"].append(t["day"])
        if t.get("moved_to"):
            g["moves"] += 1
        if t.get("done"):
            g["done"] = True
    out = [g for g in groups.values() if g["moves"] >= 2]
    for g in out:
        g["days"] = sorted(set(g["days"]))
    out.sort(key=lambda g: (-g["moves"], g["text"]))
    return out


def review(
    week: str,
    *,
    tasks: Iterable[dict] = (),
    zettel: Iterable = (),
    goals: Iterable[dict] = (),
    chapters: Iterable = (),
) -> dict:
    """The derived Rueckblick of one ISO week (pure).

    Counts the week's Tasks (done / open / moved, plus the multiply-pushed
    ones), the Zettel dated into the week, which Wochenziele were reached and
    which Kapitel were touched. Status changes of Ideen/Veroeffentlichungen
    are *not* counted here — there is no event log by decision."""
    task_list = list(tasks)
    done = [t for t in task_list if t.get("done")]
    moved = [t for t in task_list if t.get("moved_to")]
    open_tasks = [t for t in task_list if t.get("open")]

    days = {d.isoformat() for d in week_dates(week)}
    week_zettel = []
    for z in zettel:
        zdate = _as_day(_field(z, "date"))
        if zdate is not None and zdate.isoformat() in days:
            week_zettel.append(
                {
                    "id": _field(z, "id"),
                    "title": _field(z, "title"),
                    "type": _field(z, "type"),
                    "date": zdate.isoformat(),
                }
            )
    week_zettel.sort(key=lambda z: (z["date"], str(z["id"])))

    goal_rows: list[dict] = []
    for i, goal in enumerate(goals):
        row = goal_progress(goal, task_list)
        row["index"] = i
        row["reached"] = bool(row["done"]) or (row["total"] > 0 and row["done_count"] == row["total"])
        goal_rows.append(row)

    touched_chapters = []
    for chapter in chapters:
        modified = _as_day(_field(chapter, "modified_at"))
        if modified is not None and week_contains(week, modified):
            touched_chapters.append(
                {
                    "id": _field(chapter, "id"),
                    "title": _field(chapter, "title"),
                    "modified_at": modified.isoformat(),
                }
            )
    touched_chapters.sort(key=lambda c: (c["modified_at"], str(c["id"])))

    return {
        "week": week,
        "tasks": {
            "total": len(task_list),
            "done": len(done),
            "open": len(open_tasks),
            "moved": len(moved),
        },
        "carried": carried_tasks(task_list),
        "zettel": week_zettel,
        "goals": {
            "total": len(goal_rows),
            "reached": sum(1 for g in goal_rows if g["reached"]),
            "items": goal_rows,
        },
        "chapters": touched_chapters,
    }
