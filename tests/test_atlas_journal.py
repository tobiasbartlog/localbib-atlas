"""Atlas Journal domain tests (issue #180, slice 1) — task grammar, day
sections, the line operations and the Wochenziel frontmatter."""
from __future__ import annotations

import pytest

from atlas.journal import (
    JOURNAL_SCHEMA,
    Journal,
    MoveChanged,
    append_task,
    delete_task,
    find_task,
    goal_progress,
    goals_progress,
    move_task,
    new_journal,
    parse_days,
    parse_journal,
    parse_task_text,
    parse_tasks,
    render_journal,
    reorder_task,
    replace_task,
    set_note,
    toggle_task,
    undo_move,
)

FENCE = "```"

BODY = "\n".join(
    [
        "## Montag 2026-09-21",
        "- [ ] Einleitung schreiben [[kap-einleitung]] #schreiben",
        "- [x] Literatur sichten",
        "",
        FENCE,
        "- [ ] steht im Code-Fence",
        FENCE,
        "",
        "## Dienstag 2026-09-22",
        "- [ ] Methodik ausbauen [[kap-methodik|Methodik]] [[pub-abc]] #lesen #schreiben",
        "- [ ] Mail an Betreuer →2026-09-23",
        "- [ ] Uebernommen ←2026-09-20",
        "",
    ]
)

FRONTMATTER = (
    "---\n"
    f"schema: {JOURNAL_SCHEMA}\n"
    "week: 2026-W39\n"
    "goals:\n"
    "- title: Kapitel 3 fertig\n"
    "  anchor: kap-methodik\n"
    "- title: Taeglich lesen\n"
    "  tag: lesen\n"
    "---\n\n"
)

FILE = FRONTMATTER + BODY


def lines(body: str) -> list[str]:
    return body.split("\n")


def assert_only_line_changed(before: str, after: str, index: int) -> None:
    """Every line but ``index`` is byte-identical (ADR-0020)."""
    a, b = lines(before), lines(after)
    assert len(a) == len(b)
    assert a[:index] == b[:index]
    assert a[index + 1:] == b[index + 1:]
    assert a[index] != b[index]


# =============================================================================
# Parser
# =============================================================================

def test_parse_days_returns_the_day_sections_with_their_tasks():
    days = parse_days(BODY)
    assert [d["date"] for d in days] == ["2026-09-21", "2026-09-22"]
    assert [d["weekday"] for d in days] == ["Montag", "Dienstag"]
    assert [d["total"] for d in days] == [2, 3]
    assert [d["done"] for d in days] == [1, 0]


def test_body_index_is_continuous_across_days_and_skips_fences():
    tasks = parse_tasks(BODY)
    assert [t["body_index"] for t in tasks] == [0, 1, 2, 3, 4]
    assert [t["text"] for t in tasks][:2] == ["Einleitung schreiben", "Literatur sichten"]
    assert all("Code-Fence" not in t["text"] for t in tasks)


def test_tasks_carry_their_day_date():
    tasks = parse_tasks(BODY)
    assert [t["day"] for t in tasks] == [
        "2026-09-21", "2026-09-21", "2026-09-22", "2026-09-22", "2026-09-22",
    ]


def test_several_anchors_including_a_display_label():
    task = parse_tasks(BODY)[2]
    assert task["anchors"] == ["kap-methodik", "pub-abc"]
    assert task["tags"] == ["lesen", "schreiben"]
    assert task["text"] == "Methodik ausbauen"


def test_markers_are_read_and_stripped_from_the_display_text():
    moved_away, carried_in = parse_tasks(BODY)[3], parse_tasks(BODY)[4]
    assert moved_away["moved_to"] == "2026-09-23"
    assert moved_away["moved_from"] is None
    assert moved_away["text"] == "Mail an Betreuer"
    assert carried_in["moved_from"] == "2026-09-20"
    assert carried_in["text"] == "Uebernommen"


def test_a_moved_task_is_no_longer_open_and_a_done_one_is_not_either():
    tasks = parse_tasks(BODY)
    assert [t["open"] for t in tasks] == [True, False, True, False, True]


def test_checklist_lines_before_the_first_day_have_no_day_but_consume_an_index():
    body = "- [ ] Streuner\n\n## Montag 2026-09-21\n- [ ] Echt\n"
    tasks = parse_tasks(body)
    assert [(t["body_index"], t["day"]) for t in tasks] == [
        (0, None), (1, "2026-09-21")
    ]


def test_parse_task_text_handles_both_markers_once():
    parsed = parse_task_text("Text [[a]] #t ←2026-09-20 →2026-09-24")
    assert parsed == {
        "text": "Text",
        "anchors": ["a"],
        "tags": ["t"],
        "moved_to": "2026-09-24",
        "moved_from": "2026-09-20",
    }


# =============================================================================
# Serializer — line operations
# =============================================================================

def test_round_trip_without_an_operation_is_identical():
    fm, body = parse_journal(FILE)
    assert body == BODY
    assert render_journal(fm, body) == FILE
    assert Journal.from_markdown(FILE).to_markdown() == FILE


def test_a_week_file_saved_with_a_bom_keeps_its_goals_and_one_header():
    """"UTF-8 mit BOM" (Windows PowerShell 5.1, some editors) puts U+FEFF in
    front of ``---`` (review 2026-10-18): it is still the frontmatter — the
    goals stay, and the next write does not add a second header."""
    journal = Journal.from_markdown("\ufeff" + FILE)
    assert [g["title"] for g in journal.goals] == ["Kapitel 3 fertig", "Taeglich lesen"]
    assert journal.body == BODY
    journal.body = toggle_task(journal.body, 0)
    assert journal.to_markdown().count("---\n") == 2


def test_append_task_to_an_existing_day_leaves_every_other_line_untouched():
    after, index = append_task(BODY, "2026-09-21", "Neuer Task [[kap-einleitung]]")
    assert index == 2  # inserted before the Dienstag tasks
    before_lines, after_lines = lines(BODY), lines(after)
    # End of the Montag section: after its code fence, before the blank line
    # that separates the day blocks.
    assert after_lines[7] == "- [ ] Neuer Task [[kap-einleitung]]"
    assert before_lines[:7] == after_lines[:7]
    assert before_lines[7:] == after_lines[8:]


def test_append_task_creates_a_missing_day_heading_in_ascending_order():
    body = "## Montag 2026-09-21\n- [ ] A\n\n## Mittwoch 2026-09-23\n- [ ] C\n"
    after, index = append_task(body, "2026-09-22", "B")
    assert after == (
        "## Montag 2026-09-21\n- [ ] A\n\n"
        "## Dienstag 2026-09-22\n- [ ] B\n\n"
        "## Mittwoch 2026-09-23\n- [ ] C\n"
    )
    assert index == 1
    assert [d["date"] for d in parse_days(after)] == [
        "2026-09-21", "2026-09-22", "2026-09-23"
    ]


def test_append_task_appends_a_later_day_at_the_end():
    body = "## Montag 2026-09-21\n- [ ] A\n"
    after, index = append_task(body, "2026-09-23", "C")
    assert after == "## Montag 2026-09-21\n- [ ] A\n\n## Mittwoch 2026-09-23\n- [ ] C\n"
    assert index == 1


def test_append_task_builds_the_body_from_scratch_when_it_is_empty():
    after, index = append_task("", "2026-09-23", "Erster Task #start")
    assert after == "## Mittwoch 2026-09-23\n- [ ] Erster Task #start\n"
    assert index == 0
    assert parse_tasks(after)[0]["tags"] == ["start"]


def test_append_task_writes_the_text_verbatim_on_one_line():
    after, _ = append_task("", "2026-09-23", "  Zeile eins\n  Zeile zwei  ")
    assert after == "## Mittwoch 2026-09-23\n- [ ] Zeile eins Zeile zwei\n"


def test_toggle_changes_exactly_one_line():
    after = toggle_task(BODY, 0)
    assert_only_line_changed(BODY, after, 1)
    assert parse_tasks(after)[0]["done"] is True
    assert toggle_task(after, 0) == BODY


def test_replace_keeps_the_checkbox_state_and_every_other_line():
    after = replace_task(BODY, 1, "Literatur wirklich sichten [[pub-abc]]")
    assert_only_line_changed(BODY, after, 2)
    assert lines(after)[2] == "- [x] Literatur wirklich sichten [[pub-abc]]"
    assert parse_tasks(after)[1]["done"] is True


def test_delete_removes_exactly_one_line():
    after = delete_task(BODY, 2)
    before_lines, after_lines = lines(BODY), lines(after)
    assert len(after_lines) == len(before_lines) - 1
    assert before_lines[:9] == after_lines[:9]
    assert before_lines[10:] == after_lines[9:]
    assert [t["body_index"] for t in parse_tasks(after)] == [0, 1, 2, 3]


def test_unknown_body_index_raises():
    for op in (toggle_task, delete_task):
        with pytest.raises(KeyError):
            op(BODY, 99)


def test_move_inside_the_same_week_marks_the_source_and_appends_the_target():
    result = move_task(BODY, 0, "2026-09-22")
    assert result.same_body is True
    body = result.target_body
    assert lines(body)[1] == (
        "- [ ] Einleitung schreiben [[kap-einleitung]] #schreiben →2026-09-22"
    )
    source, target = parse_tasks(body)[0], find_task(body, result.target_index)
    assert source["moved_to"] == "2026-09-22"
    assert source["open"] is False
    assert target["day"] == "2026-09-22"
    assert target["moved_from"] == "2026-09-21"
    assert target["anchors"] == ["kap-einleitung"]
    assert target["open"] is True


def test_move_names_where_the_source_line_sits_afterwards():
    # A later day: the carried line lands after the source, which keeps its index.
    later = move_task(BODY, 0, "2026-09-22")
    assert later.source_index == 0
    assert find_task(later.source_body, later.source_index)["moved_to"] == "2026-09-22"
    # An earlier day of the same week: the carried line is inserted before the
    # source, so the source moves one index down — the undo must address that.
    earlier = move_task(BODY, 2, "2026-09-21")
    assert earlier.target_index == 2
    assert earlier.source_index == 3
    source = find_task(earlier.source_body, earlier.source_index)
    assert source["text"].startswith("Methodik ausbauen")
    assert source["moved_to"] == "2026-09-21"
    # Another week: the source body gets no new line.
    other = move_task(BODY, 3, "2026-09-28", target_body="## Montag 2026-09-28\n")
    assert other.source_index == 3


def test_move_leaves_all_other_lines_byte_identical():
    result = move_task(BODY, 1, "2026-09-22")
    before, after = lines(BODY), lines(result.target_body)
    assert len(after) == len(before) + 1
    assert before[:2] == after[:2]
    assert before[3:11] == after[3:11]  # everything between source and target


def test_move_into_another_week_uses_the_target_body():
    target_body = "## Montag 2026-09-28\n- [ ] Schon da\n"
    result = move_task(BODY, 3, "2026-09-28", target_body=target_body)
    assert result.same_body is False
    assert parse_tasks(result.source_body)[3]["moved_to"] == "2026-09-28"
    carried = find_task(result.target_body, result.target_index)
    assert carried["day"] == "2026-09-28"
    assert carried["text"] == "Mail an Betreuer"
    assert carried["moved_to"] is None  # the old → marker does not travel
    assert carried["moved_from"] == "2026-09-22"


def test_move_replaces_an_existing_origin_marker_instead_of_adding_a_second():
    result = move_task(BODY, 4, "2026-09-23")
    carried = find_task(result.target_body, result.target_index)
    assert carried["moved_from"] == "2026-09-22"
    raw = lines(result.target_body)[result_line(result.target_body, result.target_index)]
    assert raw.count("←") == 1


def result_line(body: str, body_index: int) -> int:
    return find_task(body, body_index)["line"]


def test_reorder_moves_a_task_inside_its_day():
    after = reorder_task(BODY, 4, 0)
    day = parse_days(after)[1]
    assert [t["text"] for t in day["tasks"]] == [
        "Uebernommen", "Methodik ausbauen", "Mail an Betreuer"
    ]
    # Nothing outside the Dienstag block moved.
    assert lines(BODY)[:9] == lines(after)[:9]
    assert sorted(lines(BODY)) == sorted(lines(after))


def test_reorder_to_the_same_position_is_a_no_op():
    assert reorder_task(BODY, 2, 0) == BODY


# =============================================================================
# Notizen — the indented lines under a Task
# =============================================================================

NOTED = "\n".join(
    [
        "## Montag 2026-09-21",
        "- [ ] Mail an Betreuer",
        "  Fragen:",
        "  - Gliederung 3.2",
        "",
        "  Termin klaeren",
        "- [ ] Ohne Notiz",
        "",
        "## Mittwoch 2026-09-23",
        "- [ ] Schon da",
        "",
    ]
)


def test_indented_lines_under_a_task_are_its_note():
    tasks = parse_tasks(NOTED)
    assert [t["body_index"] for t in tasks] == [0, 1, 2]
    assert tasks[0]["note"] == "Fragen:\n- Gliederung 3.2\n\nTermin klaeren"
    assert tasks[0]["text"] == "Mail an Betreuer"
    assert tasks[1]["note"] == "" and tasks[2]["note"] == ""


def test_a_note_ends_before_trailing_blank_lines_and_unindented_text():
    tasks = parse_tasks("## Montag 2026-09-21\n- [ ] A\n  Notiz\n\nFreitext\n")
    assert tasks[0]["note"] == "Notiz"


def test_an_indented_checklist_line_stays_a_task_of_its_own():
    tasks = parse_tasks("## Montag 2026-09-21\n- [ ] A\n  - [ ] Unteraufgabe\n")
    assert [t["text"] for t in tasks] == ["A", "Unteraufgabe"]
    assert tasks[0]["note"] == ""


def test_set_note_writes_indented_lines_under_the_task_and_nothing_else():
    after = set_note(BODY, 2, "Zeile eins\n\nZeile drei")
    before_lines, after_lines = lines(BODY), lines(after)
    assert after_lines[10:13] == ["  Zeile eins", "", "  Zeile drei"]
    assert before_lines[:10] == after_lines[:10]
    assert before_lines[10:] == after_lines[13:]
    assert find_task(after, 2)["note"] == "Zeile eins\n\nZeile drei"
    assert [t["body_index"] for t in parse_tasks(after)] == [0, 1, 2, 3, 4]


def test_set_note_replaces_an_existing_note_and_an_empty_one_removes_it():
    replaced = set_note(NOTED, 0, "Neu")
    assert lines(replaced)[1:4] == ["- [ ] Mail an Betreuer", "  Neu", "- [ ] Ohne Notiz"]
    assert set_note(set_note(BODY, 0, "Weg damit"), 0, "  \n ") == BODY


def test_toggle_and_replace_leave_the_note_alone():
    body = set_note(BODY, 0, "Bleibt")
    assert find_task(toggle_task(body, 0), 0)["note"] == "Bleibt"
    assert find_task(replace_task(body, 0, "Neuer Titel"), 0)["note"] == "Bleibt"


def test_a_checklist_line_in_a_note_does_not_become_a_task():
    after = set_note(BODY, 0, "- [ ] kein Task\n- [x] auch keiner")
    assert len(parse_tasks(after)) == len(parse_tasks(BODY))
    assert find_task(after, 0)["note"] == "- [ ] kein Task\n- [x] auch keiner"


def test_an_unclosed_fence_in_a_note_is_closed_so_later_tasks_survive():
    after = set_note(BODY, 0, FENCE + "\ncode")
    assert len(parse_tasks(after)) == len(parse_tasks(BODY))
    assert find_task(after, 0)["note"] == FENCE + "\ncode\n" + FENCE


def test_delete_removes_the_task_with_its_note():
    after = delete_task(NOTED, 0)
    assert lines(after)[:2] == ["## Montag 2026-09-21", "- [ ] Ohne Notiz"]
    assert "Fragen" not in after


def test_move_carries_the_note_and_leaves_the_source_line_bare():
    result = move_task(NOTED, 0, "2026-09-23")
    body = result.target_body
    source, carried = find_task(body, result.source_index), find_task(body, result.target_index)
    assert source["moved_to"] == "2026-09-23" and source["note"] == ""
    assert carried["note"] == "Fragen:\n- Gliederung 3.2\n\nTermin klaeren"
    assert lines(body)[-6:-1] == [
        "- [ ] Mail an Betreuer ←2026-09-21", "  Fragen:", "  - Gliederung 3.2", "", "  Termin klaeren",
    ]


def test_move_into_another_week_takes_the_note_out_of_the_source_week():
    result = move_task(NOTED, 0, "2026-09-28", target_body="")
    assert "Fragen" not in result.source_body
    assert find_task(result.target_body, result.target_index)["note"].startswith("Fragen:")


def test_undo_move_brings_the_note_back_byte_for_byte():
    later = move_task(NOTED, 0, "2026-09-23")
    undone = undo_move(later.source_body, later.source_index, later.target_index)
    assert undone.source_body == NOTED

    # To an earlier day of the same week: the carried block sits before the source.
    body = set_note(NOTED, 2, "Notiz am Mittwoch")
    earlier = move_task(body, 2, "2026-09-21")
    undone = undo_move(earlier.source_body, earlier.source_index, earlier.target_index)
    assert undone.source_body == body

    other = move_task(NOTED, 0, "2026-09-28", target_body="")
    undone = undo_move(other.source_body, other.source_index, other.target_index,
                       target_body=other.target_body)
    assert undone.source_body == NOTED
    assert "Fragen" not in undone.target_body


def test_undo_move_is_refused_once_the_source_got_a_note_of_its_own():
    result = move_task(NOTED, 1, "2026-09-23")
    changed = set_note(result.source_body, result.source_index, "Nachgetragen")
    with pytest.raises(MoveChanged):
        undo_move(changed, result.source_index, result.target_index)


def test_reorder_moves_a_task_together_with_its_note():
    after = reorder_task(NOTED, 0, 1)
    assert lines(after)[1:7] == [
        "- [ ] Ohne Notiz", "- [ ] Mail an Betreuer", "  Fragen:", "  - Gliederung 3.2", "", "  Termin klaeren",
    ]
    assert reorder_task(after, 1, 0) == NOTED


# =============================================================================
# Frontmatter, Wochenziele, validation
# =============================================================================

def test_journal_reads_week_and_goals():
    journal = Journal.from_markdown(FILE, id_hint="2026-W39")
    assert journal.week == "2026-W39"
    assert journal.goals == [
        {"title": "Kapitel 3 fertig", "anchor": "kap-methodik", "tag": None, "done": False},
        {"title": "Taeglich lesen", "anchor": None, "tag": "lesen", "done": False},
    ]


def test_rewriting_the_goals_leaves_the_body_byte_identical():
    journal = Journal.from_markdown(FILE, id_hint="2026-W39")
    journal.goals.append({"title": "Neues Ziel", "done": True})
    text = journal.to_markdown()
    assert parse_journal(text)[1] == BODY
    assert "Neues Ziel" in text
    assert Journal.from_markdown(text).goals[-1]["done"] is True


def test_goal_progress_counts_by_anchor_and_by_tag():
    tasks = parse_tasks(BODY)
    by_anchor = goal_progress({"title": "Kapitel 3", "anchor": "kap-methodik"}, tasks)
    assert (by_anchor["total"], by_anchor["done_count"]) == (1, 0)
    by_tag = goal_progress({"title": "Schreiben", "tag": "schreiben"}, tasks)
    assert (by_tag["total"], by_tag["done_count"]) == (2, 0)
    assert by_tag["progress"] == 0.0


def test_goal_without_anchor_and_tag_is_only_its_manual_done_flag():
    tasks = parse_tasks(BODY)
    assert goal_progress({"title": "Frei", "done": True}, tasks)["progress"] == 1.0
    assert goal_progress({"title": "Frei"}, tasks)["progress"] == 0.0


def test_goals_progress_keeps_the_frontmatter_index():
    journal = Journal.from_markdown(FILE, id_hint="2026-W39")
    rows = goals_progress(journal.goals, parse_tasks(BODY))
    assert [r["index"] for r in rows] == [0, 1]
    assert rows[1]["total"] == 1  # only the Methodik task carries #lesen


def test_validate_accepts_a_sound_week():
    journal = Journal(week="2026-W39", body=BODY)
    journal.path = "/atlas/journal/2026-W39.md"
    assert journal.validate() == []


def test_validate_rejects_a_day_outside_the_week():
    journal = Journal(week="2026-W40", body=BODY)
    errors = journal.validate()
    assert any("2026-09-21" in e and "ausserhalb" in e for e in errors)


def test_validate_rejects_more_than_five_goals():
    journal = Journal(week="2026-W39", goals=[{"title": f"Z{i}"} for i in range(6)])
    assert any("hoechstens 5" in e for e in journal.validate())


def test_validate_rejects_a_week_that_is_not_the_filename():
    journal = Journal(week="2026-W39", path="/atlas/journal/2026-W40.md")
    assert any("Dateiname" in e for e in journal.validate())


def test_validate_rejects_a_malformed_week_id():
    assert any("ISO-Wochen-ID" in e for e in Journal(week="2026-39").validate())


def test_new_journal_is_empty_and_rejects_a_bad_week():
    journal = new_journal("2026-W39")
    assert journal.tasks == [] and journal.days == []
    assert journal.to_markdown() == f"---\nschema: {JOURNAL_SCHEMA}\nweek: 2026-W39\n---\n\n"
    with pytest.raises(ValueError):
        new_journal("2025-W53")  # 2025 has only 52 ISO weeks
