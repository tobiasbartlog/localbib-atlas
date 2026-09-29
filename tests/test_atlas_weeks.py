"""Atlas week arithmetic — ISO weeks across year boundaries (issue #180)."""
from __future__ import annotations

from datetime import date

import pytest

from atlas.weeks import (
    day_heading,
    is_week_id,
    next_week,
    parse_week_id,
    previous_week,
    week_contains,
    week_dates,
    week_id,
    week_number,
    weekday_name,
)


def test_week_id_of_an_ordinary_day():
    assert week_id(date(2026, 9, 23)) == "2026-W39"
    assert week_id("2026-09-23") == "2026-W39"


def test_week_id_uses_the_iso_year_not_the_calendar_year():
    # 2025-12-29 is a Monday and already belongs to ISO week 2026-W01.
    assert week_id(date(2025, 12, 29)) == "2026-W01"
    assert week_id(date(2026, 1, 1)) == "2026-W01"
    # 2021-01-03 is the Sunday of the 53rd week of ISO year 2020.
    assert week_id(date(2021, 1, 3)) == "2020-W53"


def test_week_dates_are_monday_to_sunday():
    days = week_dates("2026-W39")
    assert len(days) == 7
    assert days[0] == date(2026, 9, 21)
    assert days[-1] == date(2026, 9, 27)
    assert [d.weekday() for d in days] == list(range(7))


def test_week_dates_of_a_week_spanning_the_year_boundary():
    assert week_dates("2026-W01")[0] == date(2025, 12, 29)
    assert week_dates("2026-W01")[-1] == date(2026, 1, 4)
    assert week_dates("2020-W53")[0] == date(2020, 12, 28)
    assert week_dates("2020-W53")[-1] == date(2021, 1, 3)


def test_previous_and_next_week_cross_the_year():
    assert previous_week("2026-W01") == "2025-W52"
    assert next_week("2025-W52") == "2026-W01"
    assert next_week("2020-W53") == "2021-W01"
    assert previous_week("2021-W01") == "2020-W53"


def test_previous_and_next_week_inside_a_year():
    assert previous_week("2026-W39") == "2026-W38"
    assert next_week("2026-W39") == "2026-W40"


def test_parse_week_id_rejects_malformed_and_non_existent_weeks():
    assert parse_week_id("2026-W39") == (2026, 39)
    for bad in ("2026-39", "26-W39", "2026-W", "", "2026-W99"):
        with pytest.raises(ValueError):
            parse_week_id(bad)
    # 2025 has 52 ISO weeks — W53 does not exist.
    with pytest.raises(ValueError):
        parse_week_id("2025-W53")
    assert is_week_id("2020-W53") is True
    assert is_week_id("2025-W53") is False


def test_week_number_and_contains():
    assert week_number("2026-W39") == 39
    assert week_contains("2026-W39", "2026-09-27") is True
    assert week_contains("2026-W39", "2026-09-28") is False
    assert week_contains("2026-W01", date(2025, 12, 29)) is True
    assert week_contains("kaputt", "2026-09-23") is False


def test_day_heading_carries_german_weekday_and_iso_date():
    assert day_heading("2026-09-23") == "## Mittwoch 2026-09-23"
    assert weekday_name(date(2026, 9, 21)) == "Montag"
