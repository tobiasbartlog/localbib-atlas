"""Atlas Verweise — the ``[[id]]`` wikilink extractor (issue #180, ADR-0020)
and the ``[@key]`` citation extractor of Markdown bodies (ADR-0026).

Pure, side-effect-free; stdlib only (P3). A ``[[id]]`` in a body or in a Task
line is a **Verweis**; the indexer writes every one of them into the edge table
and the reverse direction is the **Rueckverweis** of the target. Targets are
never resolved here — a hanging Verweis is a warning, never a repair.
"""

from __future__ import annotations

import re

__all__ = ["CITATION_RE", "WIKILINK_RE", "cites", "extract_citations", "extract_wikilinks", "strip_wikilinks"]

# ``[[id]]`` or ``[[id|Anzeige]]``; the id is everything up to ``|``/``]]``.
WIKILINK_RE = re.compile(r"\[\[([^\[\]|\n]+?)(?:\|([^\[\]\n]*))?\]\]")

# Pandoc citations, the syntax of the core's Markdown editor
# (static/markdown/syntax.mjs is its source): ``[@key]``, ``[@key, S. 12]``,
# ``[@a; -@b]``. A key starts with a letter, digit or ``_``, may hold inner
# punctuation (``Niu.2026``) and never ends on punctuation, so the period of
# ``[@Niu.2026].`` stays outside the key.
_CITE_KEY = r"\w(?:[\w:.#$%&+?<>~/-]*\w)?"
_CITE_ITEM = rf"-?@{_CITE_KEY}(?:,\s*[^;\[\]\n]+?)?"
CITATION_RE = re.compile(rf"\[({_CITE_ITEM}(?:;\s*{_CITE_ITEM})*)\]")
# In running text: ``[@key](url)`` and ``[@key][ref]`` are link text, which the
# editor renders as a link, not as a citation chip.
_CITATION_IN_TEXT = re.compile(CITATION_RE.pattern + r"(?![(\[])")
_CITE_ITEM_KEY = re.compile(rf"^-?@({_CITE_KEY})")

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


def extract_citations(text: str) -> list[str]:
    """Every cited key of a Markdown text, in order of first appearance.

    ``[@a, S. 12; @b]`` yields ``a`` and ``b``; fenced blocks and inline code
    are skipped like for the wikilinks, so an inline-code ``[@x]`` cites nothing,
    and so is link text (``[@x](url)``). De-duplicated. The keys are never
    resolved here.
    """
    seen: set[str] = set()
    out: list[str] = []
    for m in _CITATION_IN_TEXT.finditer(_without_code(text or "")):
        for part in m.group(1).split(";"):
            key = _CITE_ITEM_KEY.match(part.strip())
            if key and key.group(1) not in seen:
                seen.add(key.group(1))
                out.append(key.group(1))
    return out


def cites(text: str, key: str) -> bool:
    """Whether ``text`` cites ``key`` — the backward lookup asks this of every
    body, so a body that does not even contain ``@key`` is never parsed."""
    return bool(key) and f"@{key}" in (text or "") and key in extract_citations(text)


def strip_wikilinks(text: str) -> str:
    """``text`` with every ``[[id]]``/``[[id|Anzeige]]`` removed (no code
    awareness — used on a single Task line, which is never fenced)."""
    return WIKILINK_RE.sub("", text or "")
