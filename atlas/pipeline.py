"""Veroeffentlichungen als Pipeline (#225) — the pure status rule.

The pipeline shows a Publication's ``status`` as one of five columns
(planned → drafting → submitted → in-revision → published); rejected and
withdrawn sit folded away below, in the Archiv. Moving a card is a status
change, and two of them carry a date Atlas fills in itself:

- entering ``submitted`` sets ``submitted`` to today when it is empty,
- entering ``published`` sets ``published`` to today when it is empty.

Leaving a status never clears a date — a card dragged back from "Eingereicht"
keeps the day it was submitted. The one exception is a new target
("Woanders einreichen"): a new ``venue`` starts a new submission, so the old
``submitted`` date goes — it stays in the Verlauf, where every change lands
as ``{date, status, venue}`` (:func:`atlas.domain.record_history`).

The caller gets the changed fields back so an undo can restore exactly what
this rule touched (through the ordinary partial update), and nothing else.
Projects have the same Verlauf without dates or targets
(:func:`project_status_changes`).

Pure: no I/O, no clock beyond the ``today`` the caller hands in.
"""

from __future__ import annotations

from datetime import date
from typing import Any, Optional

from atlas.domain import (
    PROJECT_STATUSES,
    PUBLICATION_CLOSED_STATUSES,
    PUBLICATION_PIPELINE_STATUSES,
    record_history,
)

# Every status in column order — the domain's list, not a copy of it.
STATUSES = PUBLICATION_PIPELINE_STATUSES + PUBLICATION_CLOSED_STATUSES

# Entering this status fills this date field — only when it is still empty.
DATE_ON_ENTER = {"submitted": "submitted", "published": "published"}

_UNSET: Any = object()


def status_changes(
    publication: Any,
    target: str,
    today: date,
    *,
    venue: Optional[str] = None,
    due: Any = _UNSET,
) -> dict:
    """The fields a move to ``target`` writes: always ``status``, plus the
    date of :data:`DATE_ON_ENTER` when the publication has none yet, plus a
    Verlauf entry when something changed.

    ``venue`` (non-empty and different from the current one) is a new target:
    it is set and clears ``submitted``. ``due`` (``None`` clears) goes along
    with it — the new deadline of the new target.

    Raises ``ValueError`` for a status outside :data:`STATUSES`."""
    if target not in STATUSES:
        raise ValueError(f"unbekannter Status: {target!r}")
    changes: dict = {"status": target}
    new_venue = (venue or "").strip()
    retarget = bool(new_venue) and new_venue != (publication.venue or "")
    if retarget:
        changes["venue"] = new_venue
        if publication.submitted:
            changes["submitted"] = None
    if due is not _UNSET:
        changes["due"] = due or None
    field = DATE_ON_ENTER.get(target)
    if field and not changes.get(field, getattr(publication, field, None)):
        changes[field] = today.isoformat()
    if target != publication.status or retarget:
        changes["history"] = record_history(
            publication.history, target, today, changes.get("venue", publication.venue)
        )
    return changes


def project_status_changes(project: Any, target: str, today: date) -> dict:
    """A project's status change: ``status`` plus its Verlauf entry (none when
    the status stays). Raises ``ValueError`` for an unknown status."""
    if target not in PROJECT_STATUSES:
        raise ValueError(f"unbekannter Status: {target!r}")
    changes: dict = {"status": target}
    if target != project.status:
        changes["history"] = record_history(project.history, target, today)
    return changes
