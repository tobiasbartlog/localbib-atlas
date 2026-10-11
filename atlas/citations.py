"""Cite keys and BibTeX fields for the literature check (#226) — pure.

:func:`extract_cite_keys` reads every ``\\…cite…`` variant of a TeX text
(``\\cite``, ``\\citep``, ``\\citet*``, ``\\parencite``, ``\\textcite``,
``\\autocite``, ``\\nocite``, ``\\Cite`` …) with optional arguments
(``[S.~12]``, ``[vgl.][S.~3]``) and comma-separated keys; the biblatex
multi-cite commands (``\\cites``, ``\\parencites``, ``\\textcites``, …) take
several ``{…}`` groups. Comments (``%`` to the end of the line, ``\\%`` is not
one) are ignored, keys come back in the order of their first appearance.
It is a deliberate twin of the core's rule for the BibTeX import — the
Bundle may only import from ``plugin_api`` (P3), so it carries its own.

:func:`parse_bibtex_fields` reads ``key``, ``title``, ``author``, ``year`` and
``doi`` of every entry of a ``.bib`` text — enough to name and look up a Paper
that is cited but missing in the library. ``@string``, ``@preamble`` and
``@comment`` are skipped; values in braces, quotes or bare (numbers) are read,
nested braces are kept as text without the braces.

No I/O.
"""

from __future__ import annotations

import re

# \cite… commands: anything containing "cite" with letters around it.
_CITE_RE = re.compile(r"\\([A-Za-z]*[cC]ite[A-Za-z]*)\*?")
# Commands that contain "cite" but take no keys.
_NOT_CITES = {"citestyle", "citesetup", "citetrackertrue", "citetrackerfalse"}
_OPT_RE = re.compile(r"\s*(\[[^\]]*\]|\([^)]*\))")
_KEYS_RE = re.compile(r"\s*\{([^{}]*)\}")


def _strip_comments(text: str) -> str:
    out = []
    for line in text.split("\n"):
        cut = len(line)
        i = 0
        while i < len(line):
            if line[i] == "\\":
                i += 2
                continue
            if line[i] == "%":
                cut = i
                break
            i += 1
        out.append(line[:cut])
    return "\n".join(out)


def extract_cite_keys(tex: str) -> list[str]:
    """Every cited key of ``tex`` in the order of first appearance."""
    text = _strip_comments(tex or "")
    keys: list[str] = []
    seen: set[str] = set()
    pos = 0
    while True:
        m = _CITE_RE.search(text, pos)
        if m is None:
            break
        command = m.group(1)
        pos = m.end()
        if command.lower() in _NOT_CITES:
            continue
        multi = command.lower().endswith("cites")
        while True:
            while True:
                opt = _OPT_RE.match(text, pos)
                if opt is None:
                    break
                pos = opt.end()
            group = _KEYS_RE.match(text, pos)
            if group is None:
                break
            pos = group.end()
            for key in group.group(1).split(","):
                key = key.strip()
                if key and key != "*" and key not in seen:
                    seen.add(key)
                    keys.append(key)
            if not multi:
                break
    return keys


# =============================================================================
# BibTeX fields
# =============================================================================

_ENTRY_RE = re.compile(r"@\s*([A-Za-z]+)\s*([{(])")
_SKIP_TYPES = {"string", "preamble", "comment"}
_WANTED = ("title", "author", "year", "doi")
_FIELD_RE = re.compile(r"\s*,?\s*([A-Za-z][\w-]*)\s*=\s*")
_BARE_RE = re.compile(r"[^,\s}]+")


def _read_braced(text: str, start: int) -> tuple[str, int]:
    """Content of the brace group opening at ``text[start] == '{'`` and the
    index after its closing brace (unbalanced: to the end)."""
    depth = 0
    i = start
    while i < len(text):
        ch = text[i]
        if ch == "\\":
            i += 2
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start + 1:i], i + 1
        i += 1
    return text[start + 1:], len(text)


def _clean(value: str) -> str:
    value = value.replace("{", "").replace("}", "")
    return re.sub(r"\s+", " ", value).strip()


def _read_fields(body: str) -> dict:
    fields: dict = {}
    i = 0
    n = len(body)
    while i < n:
        m = _FIELD_RE.match(body, i)
        if m is None:
            break
        name = m.group(1).lower()
        i = m.end()
        if i >= n:
            break
        if body[i] == "{":
            value, i = _read_braced(body, i)
        elif body[i] == '"':
            end = i + 1
            depth = 0
            while end < n and not (body[end] == '"' and depth == 0):
                if body[end] == "{":
                    depth += 1
                elif body[end] == "}":
                    depth -= 1
                end += 1
            value, i = body[i + 1:end], end + 1
        else:
            bare = _BARE_RE.match(body, i)
            value = bare.group(0) if bare else ""
            i = bare.end() if bare else i + 1
        fields[name] = _clean(value)
    return fields


def parse_bibtex_fields(text: str) -> list[dict]:
    """``[{key, title, author, year, doi}]`` of every entry of a ``.bib``
    text, in file order. Missing fields are ``None``."""
    text = text or ""
    entries: list[dict] = []
    pos = 0
    while True:
        m = _ENTRY_RE.search(text, pos)
        if m is None:
            break
        kind = m.group(1).lower()
        if m.group(2) == "{":
            body, pos = _read_braced(text, m.end() - 1)
        else:
            end = text.find(")", m.end())
            end = len(text) if end < 0 else end
            body, pos = text[m.end():end], end + 1
        if kind in _SKIP_TYPES:
            continue
        key, comma, rest = body.partition(",")
        key = key.strip()
        if not key:
            continue
        fields = _read_fields(rest) if comma else {}
        entry = {"key": key}
        for name in _WANTED:
            entry[name] = fields.get(name) or None
        if entry["doi"]:
            entry["doi"] = re.sub(r"^(https?://(dx\.)?doi\.org/|doi:\s*)", "", entry["doi"], flags=re.I)
        entries.append(entry)
    return entries
