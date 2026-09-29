"""Atlas Verweise — the ``[[id]]`` wikilink extractor (issue #180, ADR-0020).

Pure, side-effect-free; stdlib only (P3). A ``[[id]]`` in a body or in a Task
line is a **Verweis**; the indexer writes every one of them into the edge table
and the reverse direction is the **Rueckverweis** of the target. Targets are
never resolved here — a hanging Verweis is a warning, never a repair.
"""

from __future__ import annotations

import re

__all__ = ["WIKILINK_RE", "extract_wikilinks", "strip_wikilinks"]

# ``[[id]]`` or ``[[id|Anzeige]]``; the id is everything up to ``|``/``]]``.
WIKILINK_RE = re.compile(r"\[\[([^\[\]|\n]+?)(?:\|([^\[\]\n]*))?\]\]")

_FENCE_RE = re.compile(r"^\s*(```|~~~)")
# Inline code spans: a run of backticks closed by an equally long run.
_INLINE_CODE_RE = re.compile(r"(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)", re.DOTALL)


def _without_fences(text: str) -> str:
    """Drop fenced code blocks (``` / ~~~), keeping the line structure."""
    out: list[str] = []
    fence: str | None = None
    for line in text.splitlines():
        m = _FENCE_RE.match(line)
        if fence is None and m:
            fence = m.group(1)
            out.append("")
            continue
        if fence is not None:
            if m and m.group(1) == fence:
                fence = None
            out.append("")
            continue
        out.append(line)
    return "\n".join(out)


def _without_code(text: str) -> str:
    """Blank out fenced blocks and inline code spans."""
    stripped = _without_fences(text)
    return _INLINE_CODE_RE.sub(lambda m: " " * len(m.group(0)), stripped)


def extract_wikilinks(text: str) -> list[str]:
    """All ``[[id]]`` of a Markdown text, in order of first appearance.

    Fence- and inline-code-aware, de-duplicated. ``[[id|Anzeige]]`` yields the
    ``id``. Ids are stripped of surrounding whitespace; empty ones are dropped.
    """
    seen: set[str] = set()
    out: list[str] = []
    for m in WIKILINK_RE.finditer(_without_code(text or "")):
        target = m.group(1).strip()
        if not target or target in seen:
            continue
        seen.add(target)
        out.append(target)
    return out


def strip_wikilinks(text: str) -> str:
    """``text`` with every ``[[id]]``/``[[id|Anzeige]]`` removed (no code
    awareness — used on a single Task line, which is never fenced)."""
    return WIKILINK_RE.sub("", text or "")
