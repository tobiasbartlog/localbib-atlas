"""Atlas Journal — one Markdown file per ISO week, Tasks as GFM checklists.

Pure, side-effect-free; stdlib + PyYAML only (P3). See **ADR-0020**: the week
file is the truth, every write is a *line operation* on the body, and every
other line stays byte-identical. Nothing here touches the filesystem — the
store (slice 2) reads and writes, this module only maps text → structure and
structure + operation → text.

Body grammar (``schemas/atlas.journal-1.json``)::

    ## Mittwoch 2026-09-23
    - [ ] Abschnitt 3 ueberarbeiten [[kap-methodik]] #schreiben
    - [x] Literatur nachtragen
    - [ ] Mail an Betreuer →2026-09-24

A day is an ATX heading ending on an ISO date; the **date is authoritative**,
the weekday is decoration Atlas writes. A Task is a GFM checklist line. Its
``body_index`` is the same contract the Atlas Project checklist toggle uses:
the n-th non-fenced checklist line of the body, counted in document order —
here continuous across all days.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Optional

import yaml

from atlas.links import extract_wikilinks, strip_wikilinks
from atlas.weeks import as_date, day_heading, is_week_id, week_contains

JOURNAL_SCHEMA = "atlas.journal/1"
MAX_GOALS = 5

MOVED_TO = "→"    # → source line of an Uebertrag
MOVED_FROM = "←"  # ← target line of an Uebertrag

_FRONTMATTER_RE = re.compile(r"^---[ \t]*\r?\n(.*?)\r?\n---[ \t]*\r?\n?(.*)$", re.DOTALL)
_DAY_HEADING_RE = re.compile(
    r"^(#{1,6})[ \t]+(?:(.*?)[ \t]+)?(\d{4}-\d{2}-\d{2})[ \t]*#*[ \t]*$"
)
# Same shape as domain._CHECKLIST_RE / api._CHECKLIST_LINE (index contract).
_TASK_RE = re.compile(r"^(\s*[-*]\s+\[)([ xX])(\]\s+)(.*)$")
_TAG_RE = re.compile(r"(?<!\S)#([^\s#]+)")
_MOVED_TO_RE = re.compile(MOVED_TO + r"\s*(\d{4}-\d{2}-\d{2})")
_MOVED_FROM_RE = re.compile(MOVED_FROM + r"\s*(\d{4}-\d{2}-\d{2})")
_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


# =============================================================================
# Task line grammar
# =============================================================================

def _fenced_flags(lines: list[str]) -> list[bool]:
    """Per line: is it inside (or itself) a code fence? Fence delimiters count
    as fenced — the same rule the existing checklist parsers use."""
    flags: list[bool] = []
    in_fence = False
    for line in lines:
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            flags.append(True)
        else:
            flags.append(in_fence)
    return flags


def parse_task_text(raw: str) -> dict:
    """Split a Task's raw text into display text, anchors, tags and markers.

    ``raw`` is everything after ``- [ ] ``. Anchors and tags may stand
    anywhere; the display text is the rest. Each marker is read at most once
    (the first occurrence wins) and every occurrence is stripped."""
    anchors = extract_wikilinks(raw)
    tags: list[str] = []
    for m in _TAG_RE.finditer(raw):
        tag = m.group(1).strip().rstrip(".,;:!?")
        if tag and tag not in tags:
            tags.append(tag)
    to_m = _MOVED_TO_RE.search(raw)
    from_m = _MOVED_FROM_RE.search(raw)

    text = _MOVED_TO_RE.sub(" ", raw)
    text = _MOVED_FROM_RE.sub(" ", text)
    text = strip_wikilinks(text)
    text = _TAG_RE.sub(" ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return {
        "text": text,
        "anchors": anchors,
        "tags": tags,
        "moved_to": to_m.group(1) if to_m else None,
        "moved_from": from_m.group(1) if from_m else None,
    }


def _make_task(match: re.Match, body_index: int, line: int, day: Optional[str]) -> dict:
    raw = match.group(4)
    parts = parse_task_text(raw)
    done = match.group(2).lower() == "x"
    return {
        "body_index": body_index,
        "line": line,
        "day": day,
        "raw": raw,
        "done": done,
        "open": not done and parts["moved_to"] is None,
        **parts,
    }


def _scan_body(body: str) -> tuple[list[dict], list[dict]]:
    """One pass over ``body``: (day sections, flat task list)."""
    lines = (body or "").split("\n")
    flags = _fenced_flags(lines)
    days: list[dict] = []
    tasks: list[dict] = []
    current: Optional[dict] = None
    body_index = -1
    for i, line in enumerate(lines):
        if flags[i]:
            continue
        dm = _DAY_HEADING_RE.match(line)
        if dm:
            current = {
                "date": dm.group(3),
                "weekday": (dm.group(2) or "").strip() or None,
                "level": len(dm.group(1)),
                "heading_line": i,
                "tasks": [],
            }
            days.append(current)
            continue
        tm = _TASK_RE.match(line)
        if not tm:
            continue
        body_index += 1
        task = _make_task(tm, body_index, i, current["date"] if current else None)
        tasks.append(task)
        if current is not None:
            current["tasks"].append(task)
    for d in days:
        d["total"] = len(d["tasks"])
        d["done"] = sum(1 for t in d["tasks"] if t["done"])
        d["open"] = sum(1 for t in d["tasks"] if t["open"])
    return days, tasks


def parse_days(body: str) -> list[dict]:
    """Day sections of ``body`` in document order:
    ``[{date, weekday, level, heading_line, tasks, total, done, open}]``."""
    return _scan_body(body)[0]


def parse_tasks(body: str) -> list[dict]:
    """All Tasks of ``body``, flat, in document order. ``body_index`` runs
    continuously across all days (checklist lines before the first day heading
    carry ``day: None`` but do consume an index — the toggle contract)."""
    return _scan_body(body)[1]


def find_task(body: str, body_index: int) -> Optional[dict]:
    for task in parse_tasks(body):
        if task["body_index"] == body_index:
            return task
    return None


def task_line(text: str, *, done: bool = False) -> str:
    """The canonical Task line for ``text`` (written verbatim, one line)."""
    one_line = re.sub(r"\s*\r?\n\s*", " ", (text or "").strip())
    return f"- [{'x' if done else ' '}] {one_line}"


# =============================================================================
# Line operations (ADR-0020) — every other line stays byte-identical
# =============================================================================

def _lines_of(body: str) -> tuple[list[str], bool]:
    """``body`` as real lines plus "did it end with a newline?". Indices match
    the ``line`` field of the parsed Tasks."""
    lines = (body or "").split("\n")
    trailing = bool(lines) and lines[-1] == ""
    if trailing:
        lines.pop()
    return lines, trailing


def _body_of(lines: list[str], trailing: bool) -> str:
    return "\n".join(lines) + ("\n" if trailing else "")


def _section_end(days: list[dict], index: int, line_count: int) -> int:
    """Exclusive end line of the day section at ``days[index]``."""
    if index + 1 < len(days):
        return days[index + 1]["heading_line"]
    return line_count


def ensure_day(body: str, day: str) -> tuple[str, int]:
    """Make sure ``body`` has a heading for ``day`` (ascending date order).
    Returns ``(body, heading_line)``; an existing heading is left untouched."""
    iso = as_date(day).isoformat()
    lines, trailing = _lines_of(body)
    days = parse_days(_body_of(lines, trailing))
    for d in days:
        if d["date"] == iso:
            return _body_of(lines, trailing), d["heading_line"]

    heading = day_heading(iso)
    later = [d for d in days if d["date"] > iso]
    if later:
        at = later[0]["heading_line"]
        lines[at:at] = [heading, ""]
        return _body_of(lines, trailing), at

    while lines and lines[-1].strip() == "":
        lines.pop()
    if lines:
        lines.extend(["", heading])
    else:
        lines.append(heading)
        trailing = True
    return _body_of(lines, trailing), len(lines) - 1


def append_task(body: str, day: str, text: str) -> tuple[str, int]:
    """Append a Task to ``day``, creating the day section (and the whole body)
    when needed. Returns ``(body, body_index)`` of the new Task."""
    body, heading_line = ensure_day(body, day)
    lines, trailing = _lines_of(body)
    days = parse_days(_body_of(lines, trailing))
    index = next(i for i, d in enumerate(days) if d["heading_line"] == heading_line)
    at = _section_end(days, index, len(lines))
    while at > heading_line + 1 and lines[at - 1].strip() == "":
        at -= 1
    lines.insert(at, task_line(text))
    new_body = _body_of(lines, trailing)
    inserted = next(t for t in parse_tasks(new_body) if t["line"] == at)
    return new_body, inserted["body_index"]


def _rewrite_line(body: str, body_index: int, rewrite) -> str:
    """Apply ``rewrite(match) -> line`` to the Task line of ``body_index``."""
    task = find_task(body, body_index)
    if task is None:
        raise KeyError(f"Kein Task mit body_index {body_index}")
    lines, trailing = _lines_of(body)
    match = _TASK_RE.match(lines[task["line"]])
    assert match is not None
    lines[task["line"]] = rewrite(match)
    return _body_of(lines, trailing)


def replace_task(body: str, body_index: int, text: str) -> str:
    """Replace the *text* of one Task; checkbox state and indentation stay."""
    one_line = re.sub(r"\s*\r?\n\s*", " ", (text or "").strip())
    return _rewrite_line(
        body, body_index, lambda m: m.group(1) + m.group(2) + m.group(3) + one_line
    )


def toggle_task(body: str, body_index: int) -> str:
    """Flip one Task between ``[ ]`` and ``[x]``."""
    return _rewrite_line(
        body,
        body_index,
        lambda m: m.group(1)
        + (" " if m.group(2).lower() == "x" else "x")
        + m.group(3)
        + m.group(4),
    )


def delete_task(body: str, body_index: int) -> str:
    """Remove one Task line. The day heading stays, even when it falls empty."""
    task = find_task(body, body_index)
    if task is None:
        raise KeyError(f"Kein Task mit body_index {body_index}")
    lines, trailing = _lines_of(body)
    del lines[task["line"]]
    return _body_of(lines, trailing)


def _set_marker(raw: str, arrow: str, day: Optional[str]) -> str:
    """``raw`` with exactly one ``arrow`` marker for ``day`` (None removes it)."""
    pattern = _MOVED_TO_RE if arrow == MOVED_TO else _MOVED_FROM_RE
    text = re.sub(r"\s+", " ", pattern.sub(" ", raw)).strip()
    if day is None:
        return text
    return f"{text} {arrow}{day}".strip()


@dataclass
class MoveResult:
    """Outcome of an Uebertrag: the marked source body, the target body (the
    same object when the target day is in the same week), where the carried
    Task landed and where the marked source line sits AFTER the move — inside
    one week a carry to an earlier day inserts before it, shifting it by one."""

    source_body: str
    target_body: str
    target_day: str
    target_index: int
    same_body: bool
    source_index: int


def move_task(
    body: str,
    body_index: int,
    to_day: str,
    *,
    target_body: Optional[str] = None,
) -> MoveResult:
    """Uebertrag: mark the source line with ``→to_day`` and append the carried
    Task to ``to_day`` with ``←<origin>``. ``target_body`` carries the target
    week when the target day lies outside this body's week; without it the
    Task is carried inside ``body``."""
    task = find_task(body, body_index)
    if task is None:
        raise KeyError(f"Kein Task mit body_index {body_index}")
    iso = as_date(to_day).isoformat()

    source = _rewrite_line(
        body,
        body_index,
        lambda m: m.group(1) + m.group(2) + m.group(3) + _set_marker(m.group(4), MOVED_TO, iso),
    )
    carried = _set_marker(_set_marker(task["raw"], MOVED_TO, None), MOVED_FROM, task["day"])

    same_body = target_body is None
    target = source if same_body else target_body
    target, index = append_task(target, iso, carried)
    return MoveResult(
        source_body=target if same_body else source,
        target_body=target,
        target_day=iso,
        target_index=index,
        same_body=same_body,
        source_index=body_index + (1 if same_body and index <= body_index else 0),
    )


class MoveChanged(ValueError):
    """The two lines of an Uebertrag are no longer what the move wrote — the
    undo would destroy a later edit, so it is refused."""


@dataclass
class UndoMoveResult:
    """Outcome of taking an Uebertrag back: both bodies (the same object when
    one week) and the restored source Task's new ``body_index``."""

    source_body: str
    target_body: str
    source_index: int
    same_body: bool


def undo_move(
    source_body: str,
    source_index: int,
    target_index: int,
    *,
    target_body: Optional[str] = None,
) -> UndoMoveResult:
    """"Übertrag zurücknehmen" (#224): remove the target line (``←``) and the
    ``→`` marker of the source line — the exact inverse of :func:`move_task`,
    also across the week boundary (``target_body`` = the other week's body).

    Allowed only while both lines are what the move left: the source still
    points at the target's day, the target is still open, carries ``←`` the
    source's day and otherwise the source's text. Anything else raises
    :class:`MoveChanged`; a missing line raises ``KeyError``. Every other line
    stays byte-identical (ADR-0020)."""
    source = find_task(source_body, source_index)
    if source is None:
        raise KeyError(f"Kein Task mit body_index {source_index}")
    same_body = target_body is None
    t_body = source_body if same_body else target_body
    target = find_task(t_body, target_index)
    if target is None:
        raise KeyError(f"Kein Task mit body_index {target_index}")
    expected = _set_marker(_set_marker(source["raw"], MOVED_TO, None), MOVED_FROM, source["day"])
    if (
        not source["moved_to"]
        or source["moved_to"] != target["day"]
        or target["done"]
        or target["raw"] != expected
        or (same_body and target["line"] == source["line"])
    ):
        raise MoveChanged("Die Zeilen des Uebertrags wurden seither geaendert")

    restored = _rewrite_line(
        source_body,
        source_index,
        lambda m: m.group(1) + m.group(2) + m.group(3) + _set_marker(m.group(4), MOVED_TO, None),
    )
    if same_body:
        lines, trailing = _lines_of(restored)
        del lines[target["line"]]
        restored = _body_of(lines, trailing)
        new_index = source_index - (1 if target_index < source_index else 0)
        return UndoMoveResult(restored, restored, new_index, True)
    lines, trailing = _lines_of(target_body)
    del lines[target["line"]]
    return UndoMoveResult(restored, _body_of(lines, trailing), source_index, False)


def reorder_task(body: str, body_index: int, position: int) -> str:
    """Move one Task to ``position`` within the Tasks of its own day."""
    days, tasks = _scan_body(body)
    task = next((t for t in tasks if t["body_index"] == body_index), None)
    if task is None:
        raise KeyError(f"Kein Task mit body_index {body_index}")
    day = next((d for d in days if any(t["line"] == task["line"] for t in d["tasks"])), None)
    if day is None:
        raise KeyError(f"Task {body_index} steht unter keinem Tag")

    order = [t["line"] for t in day["tasks"]]
    current = order.index(task["line"])
    position = max(0, min(int(position), len(order) - 1))
    if position == current:
        return body

    lines, trailing = _lines_of(body)
    moved = lines.pop(task["line"])
    rest = [ln if ln < task["line"] else ln - 1 for ln in order if ln != task["line"]]
    at = rest[position] if position < len(rest) else rest[-1] + 1
    lines.insert(at, moved)
    return _body_of(lines, trailing)


# =============================================================================
# Frontmatter, Wochenziele and the Journal entity
# =============================================================================

def parse_journal(text: str) -> tuple[dict, str]:
    """Split a Journal file into (frontmatter, body). The body is kept
    verbatim apart from the single separating blank line, so
    ``render_journal(fm, body)`` returns the file unchanged."""
    match = _FRONTMATTER_RE.match(text or "")
    if not match:
        return {}, text or ""
    data = yaml.safe_load(match.group(1))
    if data is None:
        data = {}
    if not isinstance(data, dict):
        raise ValueError("Frontmatter ist kein YAML-Mapping")
    body = match.group(2)
    if body.startswith("\n"):
        body = body[1:]
    return data, body


def render_journal(frontmatter: dict, body: str) -> str:
    """Frontmatter + body. The body is written byte-identically — re-writing
    the goals never reformats a single line of the week's work."""
    fm = yaml.safe_dump(frontmatter, sort_keys=False, allow_unicode=True).strip()
    return f"---\n{fm}\n---\n\n{body}"


def normalize_goal(raw) -> dict:
    """Coerce one frontmatter goal to ``{title, anchor, tag, done}``."""
    if not isinstance(raw, dict):
        return {"title": ("" if raw is None else str(raw)), "anchor": None, "tag": None, "done": False}
    anchor = raw.get("anchor")
    tag = raw.get("tag")
    return {
        "title": str(raw.get("title") or ""),
        "anchor": str(anchor) if anchor else None,
        "tag": str(tag).lstrip("#") if tag else None,
        "done": bool(raw.get("done")),
    }


def _goal_frontmatter(goal: dict) -> dict:
    fm: dict = {"title": goal["title"]}
    if goal.get("anchor"):
        fm["anchor"] = goal["anchor"]
    if goal.get("tag"):
        fm["tag"] = goal["tag"]
    if goal.get("done"):
        fm["done"] = True
    return fm


def goal_progress(goal: dict, tasks: Iterable[dict]) -> dict:
    """Progress of one Wochenziel over the week's Tasks (pure).

    A goal with an ``anchor`` or a ``tag`` counts the Tasks carrying it
    (``done``/``total``); without both, the manual ``done`` flag *is* the
    progress."""
    g = normalize_goal(goal)
    matched = [
        t
        for t in tasks
        if (g["anchor"] and g["anchor"] in (t.get("anchors") or []))
        or (g["tag"] and g["tag"] in (t.get("tags") or []))
    ]
    total = len(matched)
    done = sum(1 for t in matched if t.get("done"))
    if not g["anchor"] and not g["tag"]:
        progress = 1.0 if g["done"] else 0.0
    else:
        progress = (done / total) if total else (1.0 if g["done"] else 0.0)
    return {**g, "total": total, "done_count": done, "progress": progress}


def goals_progress(goals: Iterable[dict], tasks: Iterable[dict]) -> list[dict]:
    task_list = list(tasks)
    return [
        {**goal_progress(goal, task_list), "index": i}
        for i, goal in enumerate(goals)
    ]


@dataclass
class Journal:
    """One ISO week (``journal/<YYYY-Www>.md``), ``atlas.journal/1``."""

    week: str
    goals: list[dict] = field(default_factory=list)
    body: str = ""
    path: Optional[str] = None

    @property
    def days(self) -> list[dict]:
        return parse_days(self.body)

    @property
    def tasks(self) -> list[dict]:
        return parse_tasks(self.body)

    @property
    def content_hash(self) -> str:
        return hashlib.sha256(self.to_markdown().encode("utf-8")).hexdigest()

    @classmethod
    def from_markdown(cls, text: str, *, id_hint: Optional[str] = None) -> "Journal":
        """Tolerant parse (like the other entities): an invalid file still
        indexes, validation is reported separately."""
        fm, body = parse_journal(text)
        return cls(
            week=str(fm.get("week") or id_hint or ""),
            goals=[normalize_goal(g) for g in (fm.get("goals") or [])],
            body=body,
        )

    @classmethod
    def from_file(cls, path) -> "Journal":
        p = Path(path)
        journal = cls.from_markdown(p.read_text(encoding="utf-8"), id_hint=p.stem)
        journal.path = str(p)
        return journal

    def to_frontmatter(self) -> dict:
        fm: dict = {"schema": JOURNAL_SCHEMA, "week": self.week}
        if self.goals:
            fm["goals"] = [_goal_frontmatter(normalize_goal(g)) for g in self.goals]
        return fm

    def to_markdown(self) -> str:
        return render_journal(self.to_frontmatter(), self.body)

    def to_dict(self) -> dict:
        tasks = self.tasks
        return {
            "week": self.week,
            "goals": goals_progress(self.goals, tasks),
            "days": self.days,
            "tasks": tasks,
            "path": self.path,
        }

    def validate(self) -> list[str]:
        """Structural problems (mirrors ``schemas/atlas.journal-1.json``).
        Hanging anchors need the index — see store.check()."""
        errors: list[str] = []
        if not self.week:
            errors.append("Pflichtfeld fehlt: week")
        elif not is_week_id(self.week):
            errors.append(f"week ist keine ISO-Wochen-ID (YYYY-Www): {self.week!r}")
        stem = Path(self.path).stem if self.path else None
        if stem is not None and self.week and self.week != stem:
            errors.append(f"week '{self.week}' != Dateiname '{stem}'")
        if len(self.goals) > MAX_GOALS:
            errors.append(f"hoechstens {MAX_GOALS} Wochenziele (sind {len(self.goals)})")
        for i, raw in enumerate(self.goals):
            if not normalize_goal(raw)["title"]:
                errors.append(f"Wochenziel {i + 1}: Pflichtfeld fehlt: title")
        for day in self.days:
            if not _ISO_DATE_RE.match(day["date"]):
                errors.append(f"Tag ist kein ISO-Datum (YYYY-MM-DD): {day['date']!r}")
            elif self.week and is_week_id(self.week) and not week_contains(self.week, day["date"]):
                errors.append(f"Tag {day['date']} liegt ausserhalb der Woche {self.week}")
        return errors


def new_journal(week: str, **fields) -> Journal:
    """An empty week file. Day sections come into being with the first Task."""
    if not is_week_id(week):
        raise ValueError(f"Keine ISO-Wochen-ID (YYYY-Www): {week!r}")
    return Journal(week=week, **fields)
