"""Atlas Journal API — the Werkbank endpoints of the Atlas router (issue #180).

An own router module by decision of the spec: `atlas/api.py` is the one file on
the line-budget allowlist, and the Werkbank must not grow it further.
``api.py`` mounts this sub-router under the same ``/api/plugins/atlas`` prefix with
``router.include_router(build_journal_router(store, broadcaster))``.

Everything here is orchestration: read from :class:`atlas.store.AtlasStore`,
hand the numbers to the pure functions in :mod:`atlas.journal`,
:mod:`atlas.agenda` and :mod:`atlas.weeks`, persist through the store (file
first, index second — ADR-0020) and broadcast
``{"type": "archive-changed", "kind": "journal"}`` so the SPA reloads
Heute/Woche. That is the very event the watcher publishes for an external edit,
so both paths look identical to the client.

**Errors are codes, never sentences** (issue #180, ADR-0018): the store raises
German ``ValueError``/``KeyError`` for a human reading a traceback; this module
translates them into ``error.atlas.*`` for the SPA's catalog.

Route order matters: ``/journal/today`` and ``/journal/tasks`` are declared
before ``/journal/{week}``, otherwise the week parameter would swallow them.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from atlas import agenda, documents, journal_store
from atlas.journal import MAX_GOALS, MoveChanged, goals_progress
from atlas.weeks import (
    as_date,
    is_week_id,
    next_week,
    previous_week,
    week_contains,
    week_dates,
    week_id,
    week_number,
    weekday_name,
)
from atlas.zettel import new_zettel, unique_zettel_id

# Error codes — the SPA resolves them, the backend never translates.
ERR_WEEK_INVALID = "error.atlas.week_invalid"
ERR_DATE_INVALID = "error.atlas.date_invalid"
ERR_DAY_OUTSIDE_WEEK = "error.atlas.day_outside_week"
ERR_TASK_NOT_FOUND = "error.atlas.task_not_found"
ERR_TASK_TEXT_REQUIRED = "error.atlas.task_text_required"
ERR_GOAL_NOT_FOUND = "error.atlas.goal_not_found"
ERR_GOALS_TOO_MANY = "error.atlas.goals_too_many"
ERR_GOAL_TITLE_REQUIRED = "error.atlas.goal_title_required"
ERR_INVALID_REQUEST = "error.atlas.invalid_request"
ERR_MOVE_CHANGED = "error.atlas.move_changed"

NEWEST_ZETTEL = 5  # how many Zettel the Heute page shows (story 18)


# =============================================================================
# Payloads
# =============================================================================

class TaskCreate(BaseModel):
    day: str
    text: str


class TaskText(BaseModel):
    text: str


class TaskMove(BaseModel):
    to: str


class TaskUndoMove(BaseModel):
    to_week: str
    to_index: int


class TaskReorder(BaseModel):
    position: int


class CarryOver(BaseModel):
    to: str


class GoalIn(BaseModel):
    title: str
    anchor: Optional[str] = None
    tag: Optional[str] = None
    done: bool = False


class GoalsIn(BaseModel):
    goals: list[GoalIn] = []


# =============================================================================
# Helpers
# =============================================================================

def _today() -> date:
    """The server's local date — "heute" carries no timezone logic (ADR-0020).

    Module level on purpose: a test pins the day here instead of waiting for a
    week boundary to make it flaky."""
    return date.today()


def _week_or_404(week: str) -> str:
    if not is_week_id(week):
        raise HTTPException(status_code=404, detail=ERR_WEEK_INVALID)
    return week


def _day_or_422(value) -> date:
    try:
        return as_date(value)
    except (ValueError, TypeError):
        raise HTTPException(status_code=422, detail=ERR_DATE_INVALID)


def _guard(call):
    """Run a store write and map its German exceptions to error codes."""
    try:
        return call()
    except KeyError:
        raise HTTPException(status_code=404, detail=ERR_TASK_NOT_FOUND)
    except ValueError:
        raise HTTPException(status_code=422, detail=ERR_INVALID_REQUEST)


def _task(week: str, task: dict) -> dict:
    """One Task on the wire — the same shape whether it came from the parsed
    file or from the index (the SPA must not care which)."""
    return {
        "week": task.get("week") or week,
        "body_index": task.get("body_index"),
        "day": task.get("day"),
        "text": task.get("text") or "",
        "raw": task.get("raw"),
        "done": bool(task.get("done")),
        "open": bool(task.get("open")),
        "anchors": list(task.get("anchors") or []),
        "tags": list(task.get("tags") or []),
        "moved_to": task.get("moved_to"),
        "moved_from": task.get("moved_from"),
    }


def _tasks_of(journal) -> list[dict]:
    return [_task(journal.week, t) for t in journal.tasks]


def _zettel_row(zettel) -> dict:
    """Slim Zettel row — the Heute page lists them, it does not read them."""
    return {
        "id": zettel.id,
        "title": zettel.title,
        "type": zettel.type,
        "date": zettel.date,
        "refs": list(zettel.refs),
        "tags": list(zettel.tags),
    }


def _mtime(path) -> Optional[str]:
    if not path:
        return None
    try:
        return date.fromtimestamp(Path(path).stat().st_mtime).isoformat()
    except OSError:
        return None


def _chapters(store) -> list[dict]:
    """Kapitel plus their file mtime. ``agenda`` is pure, so the clock-facing
    data is assembled here, not there."""
    return [
        {"id": node.id, "title": node.title, "modified_at": _mtime(node.path)}
        for node in store.list_nodes()
    ]


def _validated_goals(goals: list[dict]) -> list[dict]:
    """At most five Wochenziele, each with a title (schema atlas.journal/1)."""
    if len(goals) > MAX_GOALS:
        raise HTTPException(status_code=422, detail=ERR_GOALS_TOO_MANY)
    for goal in goals:
        if not str(goal.get("title") or "").strip():
            raise HTTPException(status_code=422, detail=ERR_GOAL_TITLE_REQUIRED)
    return goals


def _goals_payload(journal) -> dict:
    return {
        "week": journal.week,
        "goals": goals_progress(journal.goals, journal.tasks),
    }


def _review_of(store, week: str, journal) -> dict:
    return agenda.review(
        week,
        tasks=journal.tasks,
        zettel=store.list_zettel(),
        goals=journal.goals,
        chapters=_chapters(store),
    )


def _week_payload(store, week: str) -> dict:
    """The whole week: goals with progress, all seven days (empty ones
    included, so the SPA can render columns) and the derived Rueckblick."""
    journal = store.read_journal(week)
    tasks = _tasks_of(journal)
    by_day: dict[str, list[dict]] = {}
    for task in tasks:
        by_day.setdefault(task["day"] or "", []).append(task)

    days = []
    for day in week_dates(week):
        iso = day.isoformat()
        rows = by_day.get(iso, [])
        days.append(
            {
                "date": iso,
                "weekday": weekday_name(day),
                "tasks": rows,
                "total": len(rows),
                "done": sum(1 for t in rows if t["done"]),
                "open": sum(1 for t in rows if t["open"]),
            }
        )

    return {
        "week": week,
        "number": week_number(week),
        "previous": previous_week(week),
        "next": next_week(week),
        "exists": journal.path is not None,
        "goals": goals_progress(journal.goals, journal.tasks),
        "days": days,
        "tasks": tasks,
        "review": _review_of(store, week, journal),
    }


def _review_markdown(week: str, data: dict) -> str:
    """The derived Rueckblick as a Markdown body (story 33). Entities are
    written as ``[[id]]``, so the Zettel links back into the Sammlung."""
    dates = week_dates(week)
    counts = data["tasks"]
    lines = [
        f"# Rückblick KW {week_number(week)} "
        f"({dates[0].isoformat()} – {dates[-1].isoformat()})",
        "",
        "## Tasks",
        f"- Erledigt: {counts['done']} von {counts['total']} "
        f"(offen {counts['open']}, übertragen {counts['moved']})",
        "",
    ]
    if data["carried"]:
        lines.append("## Mehrfach übertragen")
        lines.extend(f"- {c['text']} ({c['moves']}×)" for c in data["carried"])
        lines.append("")
    lines.append("## Wochenziele")
    if data["goals"]["items"]:
        for goal in data["goals"]["items"]:
            mark = "x" if goal["reached"] else " "
            counted = f" ({goal['done_count']}/{goal['total']})" if goal["total"] else ""
            lines.append(f"- [{mark}] {goal['title']}{counted}")
    else:
        lines.append("- keine")
    lines.append("")
    lines.append("## Zettel")
    if data["zettel"]:
        lines.extend(
            f"- [[{z['id']}]] {z['title']} ({z['type']})" for z in data["zettel"]
        )
    else:
        lines.append("- keine")
    lines.append("")
    lines.append("## Kapitel")
    if data["chapters"]:
        lines.extend(
            f"- [[{c['id']}]] {c['title']} ({c['modified_at']})"
            for c in data["chapters"]
        )
    else:
        lines.append("- keine")
    lines.extend(["", "## Eigene Gedanken", ""])
    return "\n".join(lines)


# =============================================================================
# Router
# =============================================================================

def build_journal_router(store, broadcaster) -> APIRouter:
    """The ``/journal`` part of the Atlas API. Mounted by ``api.build_router``."""
    router = APIRouter(prefix="/journal", tags=["atlas-journal"])

    def _changed(kind: str = "journal") -> None:
        """Same event the watcher publishes, so a UI write and an external edit
        reach the SPA on one path."""
        broadcaster.publish({"type": "archive-changed", "kind": kind})

    # --- reads (declared before /{week}) -------------------------------------

    @router.get("/today")
    async def today():
        """The Heute page. Creates no file — a week without Tasks is empty."""
        day = _today()
        iso = day.isoformat()
        week = week_id(day)
        journal = store.read_journal(week)
        tasks = _tasks_of(journal)
        todays = [t for t in tasks if t["day"] == iso]

        # "Offen von Vortagen" (story 11) spans this week and the previous one;
        # a moved (→) or done Task is not open.
        earlier = agenda.open_tasks_before(
            _tasks_of(store.read_journal(previous_week(week))) + tasks, day
        )

        return {
            "date": iso,
            "weekday": weekday_name(day),
            "week": week,
            "tasks": todays,
            "carry_over": earlier,
            "goals": goals_progress(journal.goals, journal.tasks),
            "due": agenda.whats_due(
                projects=store.list_projects(),
                chapters=_chapters(store),
                ideas=store.list_ideas(),
                publications=store.list_publications(),
                today=day,
            ),
            "zettel": [_zettel_row(z) for z in store.list_zettel()[:NEWEST_ZETTEL]],
            # The nav badge (story 57): today plus everything still hanging.
            "open_count": sum(1 for t in todays if t["open"]) + len(earlier),
        }

    @router.get("/tasks")
    async def tasks_for_anchor(
        anchor: str = Query(...),
        open_only: bool = Query(False, alias="open"),
    ):
        """Tasks carrying ``[[anchor]]`` across all weeks (Kapitel-Hub)."""
        rows = store.tasks_for_anchor(anchor, open_only=open_only)
        return {"anchor": anchor, "tasks": [_task(r.get("week", ""), r) for r in rows]}

    @router.get("/{week}")
    async def get_week(week: str):
        """A week that has no file answers 200 with an empty week, not 404."""
        return _week_payload(store, _week_or_404(week))

    # --- Tasks ---------------------------------------------------------------

    @router.post("/{week}/tasks")
    async def create_task(week: str, payload: TaskCreate):
        """Append a Task; ``text`` is written verbatim (anchors and tags inline)."""
        _week_or_404(week)
        day = _day_or_422(payload.day)
        if not week_contains(week, day):
            raise HTTPException(status_code=422, detail=ERR_DAY_OUTSIDE_WEEK)
        text = (payload.text or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail=ERR_TASK_TEXT_REQUIRED)
        created = store.add_task(week, day.isoformat(), text)
        _changed()
        return _task(week, created)

    @router.put("/{week}/tasks/{body_index}")
    async def update_task(week: str, body_index: int, payload: TaskText):
        _week_or_404(week)
        text = (payload.text or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail=ERR_TASK_TEXT_REQUIRED)
        updated = _guard(lambda: store.update_task(week, body_index, text))
        _changed()
        return _task(week, updated)

    @router.delete("/{week}/tasks/{body_index}")
    async def delete_task(week: str, body_index: int):
        _week_or_404(week)
        _guard(lambda: store.delete_task(week, body_index))
        _changed()
        return {"week": week, "deleted": body_index}

    @router.post("/{week}/tasks/{body_index}/toggle")
    async def toggle_task(week: str, body_index: int):
        _week_or_404(week)
        toggled = _guard(lambda: store.toggle_task(week, body_index))
        _changed()
        return _task(week, toggled)

    @router.post("/{week}/tasks/{body_index}/move")
    async def move_task(week: str, body_index: int, payload: TaskMove):
        """Uebertrag: the source line keeps standing with ``→``, the target day
        gets a copy with ``←``. A target in another week creates that file."""
        _week_or_404(week)
        to = _day_or_422(payload.to)
        result = _guard(lambda: store.move_task(week, body_index, to.isoformat()))
        _changed()
        return result

    @router.post("/{week}/tasks/{body_index}/undo-move")
    async def undo_move(week: str, body_index: int, payload: TaskUndoMove):
        """"Übertrag zurücknehmen" (#224): ``week``/``body_index`` is the
        source line of the move, ``to_week``/``to_index`` the carried line (the
        answer of ``/move``). Removes the carried line and the ``→`` marker;
        refused with ``409 error.atlas.move_changed`` once either line was
        edited since — the UI then advises moving the Task back instead."""
        _week_or_404(week)
        _week_or_404(payload.to_week)
        try:
            result = store.undo_move(week, body_index, payload.to_week, payload.to_index)
        except MoveChanged:
            raise HTTPException(status_code=409, detail=ERR_MOVE_CHANGED)
        except KeyError:
            raise HTTPException(status_code=404, detail=ERR_TASK_NOT_FOUND)
        except ValueError:
            raise HTTPException(status_code=422, detail=ERR_INVALID_REQUEST)
        _changed()
        return result

    @router.post("/{week}/tasks/{body_index}/reorder")
    async def reorder_task(week: str, body_index: int, payload: TaskReorder):
        _week_or_404(week)
        result = _guard(lambda: store.reorder_task(week, body_index, payload.position))
        _changed()
        return {"week": week, "tasks": [_task(week, t) for t in result["tasks"]]}

    @router.post("/{week}/carry-over")
    async def carry_over(week: str, payload: CarryOver):
        """Carry every open Task of the earlier days (this week and the one
        before) to ``to`` — story 12, "alle auf einmal"."""
        _week_or_404(week)
        to = _day_or_422(payload.to)
        iso = to.isoformat()

        def _pending(source_week: str) -> list[dict]:
            return [
                t
                for t in store.read_journal(source_week).tasks
                if t["open"] and t["day"] and t["day"] < iso
            ]

        moved: list[dict] = []
        for source_week in (previous_week(week), week):
            # body_index is position-dependent (ADR-0020), so every Uebertrag
            # re-reads the file instead of trusting a remembered list. Bounded
            # by the initial count: a moved line is no longer open.
            for _ in range(len(_pending(source_week))):
                rest = _pending(source_week)
                if not rest:
                    break
                moved.append(store.move_task(source_week, rest[0]["body_index"], iso))
        if moved:
            _changed()
        return {"to": iso, "week": week_id(to), "moved": len(moved), "tasks": moved}

    # --- Wochenziele ---------------------------------------------------------

    @router.put("/{week}/goals")
    async def put_goals(week: str, payload: GoalsIn):
        """Replace the whole list. The frontmatter is re-serialised, the body
        stays byte-identical (ADR-0020)."""
        _week_or_404(week)
        goals = _validated_goals([g.model_dump() for g in payload.goals])
        journal = _guard(lambda: store.set_goals(week, goals))
        _changed()
        return _goals_payload(journal)

    @router.post("/{week}/goals/adopt")
    async def adopt_goals(week: str):
        """Append the previous week's *open* goals (story 29). Titles already
        present stay single, and the maximum of five still holds."""
        _week_or_404(week)
        current = store.read_journal(week)
        prior = store.read_journal(previous_week(week))
        taken = {str(g.get("title") or "").strip().lower() for g in current.goals}
        adopted = []
        for goal in prior.goals:
            title = str(goal.get("title") or "").strip()
            if goal.get("done") or not title or title.lower() in taken:
                continue
            taken.add(title.lower())
            adopted.append({**goal, "done": False})
        goals = _validated_goals(list(current.goals) + adopted)
        journal = _guard(lambda: store.set_goals(week, goals))
        _changed()
        return {**_goals_payload(journal), "adopted": len(adopted)}

    @router.post("/{week}/goals/{index}/toggle")
    async def toggle_goal(week: str, index: int):
        _week_or_404(week)
        try:
            journal = store.toggle_goal(week, index)
        except KeyError:
            raise HTTPException(status_code=404, detail=ERR_GOAL_NOT_FOUND)
        _changed()
        return _goals_payload(journal)

    # --- Rueckblick und Datei ------------------------------------------------

    @router.post("/{week}/review/zettel")
    async def review_zettel(week: str):
        """Hold the derived Rueckblick as a Zettel of type ``review``
        (story 33) — it is a normal Zettel afterwards, editable and linkable."""
        _week_or_404(week)
        journal = store.read_journal(week)
        data = _review_of(store, week, journal)

        # The Zettel belongs to the week it reviews: today when today is in it,
        # otherwise the week's last day (so `review` counts it in that week).
        day = _today()
        if not week_contains(week, day):
            day = week_dates(week)[-1]

        zettel = new_zettel(
            f"Rückblick KW {week_number(week)}",
            today=day,
            type="review",
            body=_review_markdown(week, data),
        )
        zettel.id = unique_zettel_id(zettel.id, [z.id for z in store.list_zettel()])
        path = store.save_zettel_file(zettel)
        store.index_zettel_file(path)
        _changed("zettel")
        created = store.get_zettel(zettel.id)
        return created.to_dict()

    @router.post("/{week}/open")
    async def open_week_file(week: str):
        """Open the week's Journal in the system editor (story 19). A week
        without a file gets one first — you cannot edit what is not there."""
        _week_or_404(week)
        path = journal_store.journal_path(week)
        if not path.exists():
            store.write_journal(store.read_journal(week))
            store.index_journal_file(path)
            _changed()
        documents.open_in_viewer(path)
        return {"status": "ok", "week": week, "path": str(path)}

    return router
