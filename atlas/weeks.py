"""ISO week arithmetic for the Atlas Journal (issue #180, ADR-0020).

Pure, stdlib only (P3). A Journal is the file of one ISO week; its id — and
its filename — is ``YYYY-Www``. No timezone logic anywhere: "heute" is the
local date the caller hands in. Correct across year boundaries by
construction, because everything goes through :mod:`datetime`'s own ISO
calendar (``date.isocalendar`` / ``date.fromisocalendar``), never through
day arithmetic on the year number.
"""

from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Iterable, Optional, Union

__all__ = [
    "WEEK_ID_RE",
    "WEEKDAY_NAMES",
    "as_date",
    "day_heading",
    "is_week_id",
    "next_week",
    "parse_week_id",
    "previous_week",
    "today_or",
    "week_contains",
    "week_dates",
    "week_id",
    "week_number",
    "weekday_name",
    "weeks_of",
]

WEEK_ID_RE = re.compile(r"^(\d{4})-W(\d{2})$")

# The weekday is decoration in the day heading (the date is authoritative),
# but Atlas writes it, so it is written in the Atlas UI language: German.
WEEKDAY_NAMES = (
    "Montag", "Dienstag", "Mittwoch", "Donnerstag",
    "Freitag", "Samstag", "Sonntag",
)

DateLike = Union[date, str]


def as_date(value: DateLike) -> date:
    """Coerce an ISO ``YYYY-MM-DD`` string or a ``date`` to a ``date``."""
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value).strip())


def week_id(day: DateLike) -> str:
    """ISO week id (``YYYY-Www``) of ``day`` — ISO year, not calendar year."""
    iso = as_date(day).isocalendar()
    return f"{iso[0]:04d}-W{iso[1]:02d}"


def parse_week_id(value: str) -> tuple[int, int]:
    """``'2026-W01'`` → ``(2026, 1)``. Raises ``ValueError`` on a malformed id
    or on a week the ISO calendar does not have (e.g. W53 in a 52-week year)."""
    m = WEEK_ID_RE.match((value or "").strip())
    if not m:
        raise ValueError(f"Keine ISO-Wochen-ID (YYYY-Www): {value!r}")
    year, week = int(m.group(1)), int(m.group(2))
    date.fromisocalendar(year, week, 1)  # raises if that week does not exist
    return year, week


def is_week_id(value: str) -> bool:
    try:
        parse_week_id(value)
    except (ValueError, TypeError):
        return False
    return True


def week_number(value: str) -> int:
    """The ``ww`` part of a week id as an int (for 'Rückblick KW 39')."""
    return parse_week_id(value)[1]


def week_dates(week: str) -> list[date]:
    """The seven dates of ``week``, Monday first."""
    year, number = parse_week_id(week)
    monday = date.fromisocalendar(year, number, 1)
    return [monday + timedelta(days=i) for i in range(7)]


def week_contains(week: str, day: DateLike) -> bool:
    """True when ``day`` falls into ``week`` (ISO, year boundaries included)."""
    try:
        year, number = parse_week_id(week)
        iso = as_date(day).isocalendar()
    except (ValueError, TypeError):
        return False
    return iso[0] == year and iso[1] == number


def previous_week(week: str) -> str:
    """Week id of the week before ``week`` (crosses the year correctly)."""
    return week_id(week_dates(week)[0] - timedelta(days=7))


def next_week(week: str) -> str:
    """Week id of the week after ``week`` (crosses the year correctly)."""
    return week_id(week_dates(week)[0] + timedelta(days=7))


def weekday_name(day: DateLike) -> str:
    return WEEKDAY_NAMES[as_date(day).weekday()]


def day_heading(day: DateLike) -> str:
    """The day heading Atlas writes: ``## <Wochentag> YYYY-MM-DD``."""
    d = as_date(day)
    return f"## {weekday_name(d)} {d.isoformat()}"


def weeks_of(days: Iterable[DateLike]) -> list[str]:
    """De-duplicated week ids of ``days``, in order of first appearance."""
    out: list[str] = []
    for day in days:
        wid = week_id(day)
        if wid not in out:
            out.append(wid)
    return out


def today_or(day: Optional[DateLike]) -> date:
    """``day`` as a date, or the server's local today when it is None."""
    return as_date(day) if day is not None else date.today()
