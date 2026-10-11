"""Veroeffentlichungen als Pipeline (#225) — the pure status rule.

The pipeline shows a Publication's ``status`` as one of five columns
(planned → drafting → submitted → in-revision → published); rejected and
withdrawn sit folded away below. Moving a card is a status change, and two of
them carry a date Atlas fills in itself:

- entering ``submitted`` sets ``submitted`` to today when it is empty,
- entering ``published`` sets ``published`` to today when it is empty.

Leaving a status never clears a date — a card dragged back from "Eingereicht"
keeps the day it was submitted. The caller gets the changed fields back so an
undo can clear exactly what this rule set (through the ordinary partial
update), and nothing else.

Pure: no I/O, no clock beyond the ``today`` the caller hands in.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from atlas.domain import PUBLICATION_CLOSED_STATUSES, PUBLICATION_PIPELINE_STATUSES

# Every status in column order — the domain's list, not a copy of it.
STATUSES = PUBLICATION_PIPELINE_STATUSES + PUBLICATION_CLOSED_STATUSES

# Entering this status fills this date field — only when it is still empty.
DATE_ON_ENTER = {"submitted": "submitted", "published": "published"}


def status_changes(publication: Any, target: str, today: date) -> dict:
    """The fields a move to ``target`` writes: always ``status``, plus the
    date of :data:`DATE_ON_ENTER` when the publication has none yet.

    Raises ``ValueError`` for a status outside :data:`STATUSES`."""
    if target not in STATUSES:
        raise ValueError(f"unbekannter Status: {target!r}")
    changes: dict = {"status": target}
    field = DATE_ON_ENTER.get(target)
    if field and not getattr(publication, field, None):
        changes[field] = today.isoformat()
    return changes
