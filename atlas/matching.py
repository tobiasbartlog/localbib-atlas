"""Atlas LLM-Matching — F1 pair evaluation & F2 reverse search (Abschn. 8).

Pure logic, side-effect-free: builds prompts, parses/validates LLM answers
against ``schemas/atlas.match-result-1.json`` semantics, ranks candidates.
No I/O and no LLM calls here — the HTTP layer (``api.py``) talks to the LLM
exclusively via ``api.llm`` (P3) and writes files only on explicit user
acceptance (P4). Imports stdlib only.
"""

from __future__ import annotations

import json
import math
import re
from typing import Optional

VERDICTS = ("relevant", "maybe", "irrelevant")

# Generous but bounded excerpts: keep the bundled F2 call within the token
# economy of the validated filter+batch pattern (Abschn. 8).
PAPER_MAX_CHARS = 6000
IDEA_MAX_CHARS = 3000
BATCH_IDEA_MAX_CHARS = 1200

_TOKEN_RE = re.compile(r"\w+", re.UNICODE)

# Tokens this short/common carry no signal for lexical ranking.
_STOPWORDS = frozenset(
    "der die das und oder ein eine einer eines im in am an auf mit von zu für"
    " the a an of and or to for with on in is are this that we our als bei"
    " aus dem den des ist sind wird werden nicht auch ueber über".split()
)


# =============================================================================
# Text assembly
# =============================================================================

def paper_text(paper: dict, fulltext: Optional[str] = None, max_chars: int = PAPER_MAX_CHARS) -> str:
    """Flatten library metadata (+ optional full text) for prompts/ranking."""
    parts = []
    if paper.get("title"):
        parts.append(f"Titel: {paper['title']}")
    if paper.get("authors"):
        parts.append(f"Autoren: {paper['authors']}")
    if paper.get("year"):
        parts.append(f"Jahr: {paper['year']}")
    if paper.get("journal"):
        parts.append(f"Journal: {paper['journal']}")
    if paper.get("abstract"):
        parts.append(f"Abstract: {paper['abstract']}")
    if fulltext:
        parts.append(f"Volltext-Auszug: {fulltext}")
    return "\n".join(parts)[:max_chars]


def idea_text(idea: dict, max_chars: int = IDEA_MAX_CHARS) -> str:
    """Flatten an idea (wire dict) for prompts/ranking."""
    parts = [f"Titel: {idea.get('title', '')}"]
    if idea.get("type"):
        parts.append(f"Typ: {idea['type']}")
    if idea.get("tags"):
        parts.append("Tags: " + ", ".join(idea["tags"]))
    if idea.get("body"):
        parts.append(idea["body"])
    return "\n".join(parts)[:max_chars]


# =============================================================================
# F1 — pair evaluation ("Ist Paper A für Idee B hilfreich, und wo?")
# =============================================================================

_SYSTEM = (
    "Du bist wissenschaftlicher Assistent eines Literaturverwaltungssystems. "
    "Du bewertest, ob ein Paper für eine Forschungsidee nützlich ist. "
    "Antworte ausschließlich mit JSON, ohne Markdown-Zäune, ohne Erklärtext."
)


def build_pair_messages(paper: dict, idea: dict, fulltext: Optional[str] = None) -> list[dict]:
    anchors = idea.get("anchors") or []
    anchor_note = (
        "Erlaubte anchor-Werte (Abschnitts-Slugs der Idee): "
        + (", ".join(anchors) if anchors else "(keine Abschnitte — nutze null)")
    )
    user = f"""PAPER:
{paper_text(paper, fulltext)}

IDEE (Markdown):
{idea_text(idea)}

{anchor_note}

AUFGABE: Ist das Paper für diese Idee hilfreich, und wo?
Antworte mit genau diesem JSON-Objekt (Schema atlas.match-result/1):
{{"verdict": "relevant" | "maybe" | "irrelevant",
 "reasoning": "<kurze Begründung auf Deutsch>",
 "usages": [{{"anchor": "<ein erlaubter Slug oder null>", "suggestion": "<was das Paper an dieser Stelle beiträgt>"}}]}}
Bei verdict "irrelevant" ist usages leer."""
    return [
        {"role": "system", "content": _SYSTEM},
        {"role": "user", "content": user},
    ]


def parse_match_result(content: str, anchors: list[str]) -> dict:
    """Validate one LLM answer into a match result. Raises ValueError.

    Anchors are revalidated (``anchor_valid``); orphaned anchors are flagged,
    never dropped (Abschn. 8 Ankerstabilität)."""
    try:
        data = json.loads(content)
    except json.JSONDecodeError as exc:
        raise ValueError(f"keine gueltige JSON-Antwort: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError("Antwort ist kein JSON-Objekt")
    return _coerce_result(data, anchors)


def _coerce_result(data: dict, anchors: list[str]) -> dict:
    verdict = str(data.get("verdict", "")).strip().lower()
    if verdict not in VERDICTS:
        raise ValueError(f"verdict ungueltig: {data.get('verdict')!r}")
    usages = []
    raw_usages = data.get("usages") or []
    if not isinstance(raw_usages, list):
        raise ValueError("usages ist keine Liste")
    for u in raw_usages:
        if not isinstance(u, dict):
            continue
        anchor = u.get("anchor")
        if anchor is not None:
            anchor = str(anchor).strip().lstrip("#") or None
        suggestion = str(u.get("suggestion", "")).strip()
        if not suggestion:
            continue
        usages.append(
            {
                "anchor": anchor,
                "suggestion": suggestion,
                "anchor_valid": anchor is None or anchor in anchors,
            }
        )
    return {
        "verdict": verdict,
        "reasoning": str(data.get("reasoning", "")).strip(),
        "usages": usages,
    }


# =============================================================================
# F2 — reverse search ("Welche Ideen berührt dieses Paper?")
# =============================================================================

def build_batch_messages(paper: dict, ideas: list[dict], fulltext: Optional[str] = None) -> list[dict]:
    """One bundled call over all top-k candidates (filter+batch pattern)."""
    blocks = []
    for idea in ideas:
        anchors = idea.get("anchors") or []
        blocks.append(
            f"[IDEE id={idea.get('id')}]\n"
            f"{idea_text(idea, BATCH_IDEA_MAX_CHARS)}\n"
            f"Anker: {', '.join(anchors) if anchors else '(keine)'}"
        )
    candidates = "\n\n".join(blocks)
    user = f"""PAPER:
{paper_text(paper, fulltext)}

KANDIDATEN-IDEEN:
{candidates}

AUFGABE: Bewerte für JEDE Kandidaten-Idee, ob das Paper sie berührt.
Antworte mit genau diesem JSON-Array (ein Eintrag pro Idee, Schema atlas.match-result/1):
[{{"idea": "<id>", "verdict": "relevant" | "maybe" | "irrelevant",
  "reasoning": "<kurze Begründung auf Deutsch>",
  "usages": [{{"anchor": "<Anker-Slug der jeweiligen Idee oder null>", "suggestion": "..."}}]}}]"""
    return [
        {"role": "system", "content": _SYSTEM},
        {"role": "user", "content": user},
    ]


def parse_batch_result(content: str, anchors_by_id: dict[str, list[str]]) -> list[dict]:
    """Validate the bundled answer. Unknown idea ids are dropped; per-entry
    parse errors skip the entry (one bad candidate must not void the batch)."""
    try:
        data = json.loads(content)
    except json.JSONDecodeError as exc:
        raise ValueError(f"keine gueltige JSON-Antwort: {exc}") from exc
    if isinstance(data, dict):  # tolerate {"results": [...]}
        data = data.get("results", data.get("ideas"))
    if not isinstance(data, list):
        raise ValueError("Antwort ist kein JSON-Array")
    results = []
    for entry in data:
        if not isinstance(entry, dict):
            continue
        idea_id = str(entry.get("idea", "")).strip()
        if idea_id not in anchors_by_id:
            continue
        try:
            result = _coerce_result(entry, anchors_by_id[idea_id])
        except ValueError:
            continue
        result["idea"] = idea_id
        results.append(result)
    return results


# =============================================================================
# F3 — chapter match ("Welches Kapitel passt?")
# =============================================================================

# Keep dissertation body excerpts bounded; the ranked batch may include many chapters.
CHAPTER_EXCERPT_MAX_CHARS = 1500


def build_chapter_match_messages(paper: dict, chapters: list[dict]) -> list[dict]:
    """F3: Build LLM messages to rank dissertation chapters for a paper.

    Chapters whose body text is empty (or whitespace-only) are **excluded**
    from the prompt — the LLM is not asked to evaluate content it cannot see
    (AC: "not hallucinated"). The caller is responsible for reporting excluded
    chapters to the UI; this function only builds the prompt for chapters that
    actually carry context.

    ``chapters`` should be dicts with keys ``id``, ``title``, ``body``
    (as returned by :meth:`DissNode.to_dict`).
    """
    eligible = [c for c in chapters if (c.get("body") or "").strip()]
    blocks = []
    for c in eligible:
        body_excerpt = (c.get("body") or "").strip()[:CHAPTER_EXCERPT_MAX_CHARS]
        blocks.append(
            f"[KAPITEL id={c.get('id')}]\n"
            f"Titel: {c.get('title', '')}\n\n"
            f"{body_excerpt}"
        )
    candidates = "\n\n".join(blocks)
    user = f"""PAPER:
{paper_text(paper)}

KAPITEL DER DISSERTATION:
{candidates if candidates else "(keine Kapitel mit Inhalt verfuegbar)"}

AUFGABE: Ranke die Kapitel nach ihrer Relevanz fuer dieses Paper. Vergib fuer jedes Kapitel einen Rang (1 = am besten geeignet) und eine kurze Begruendung auf Deutsch.
Antworte mit genau diesem JSON-Array (ein Eintrag pro Kapitel, aufsteigend nach Rang):
[{{"chapter_id": "<id>", "rank": <1-basierter Rang>, "reason": "<kurze Begruendung auf Deutsch>"}}]"""
    return [
        {"role": "system", "content": _SYSTEM},
        {"role": "user", "content": user},
    ]


def parse_chapter_match_result(content: str) -> list[dict]:
    """Parse the LLM chapter ranking answer.

    Returns ``[{chapter_id, rank, reason}, ...]`` in the order the LLM provided.
    Unknown or malformed entries are dropped (one bad entry must not void the
    batch). Raises :exc:`ValueError` on a completely unparseable response.
    """
    try:
        data = json.loads(content)
    except json.JSONDecodeError as exc:
        raise ValueError(f"keine gueltige JSON-Antwort: {exc}") from exc
    if isinstance(data, dict):
        data = data.get("results", data.get("chapters"))
    if not isinstance(data, list):
        raise ValueError("Antwort ist kein JSON-Array")
    results = []
    for entry in data:
        if not isinstance(entry, dict):
            continue
        chapter_id = str(entry.get("chapter_id", "")).strip()
        if not chapter_id:
            continue
        try:
            rank = int(entry.get("rank", 0))
        except (TypeError, ValueError):
            rank = 0
        reason = str(entry.get("reason", "")).strip()
        results.append({"chapter_id": chapter_id, "rank": rank, "reason": reason})
    return results


# =============================================================================
# Candidate ranking (embedding with lexical fallback)
# =============================================================================

def tokenize(text: str) -> set[str]:
    return {
        t
        for t in (m.group(0).lower() for m in _TOKEN_RE.finditer(text or ""))
        if len(t) > 2 and t not in _STOPWORDS
    }


def lexical_rank(query: str, ideas: list[dict]) -> list[tuple[str, float]]:
    """All ideas sorted by token overlap with the query (title weighted 3x).
    Fallback when no embedding endpoint is configured (discovery A4)."""
    query_tokens = tokenize(query)
    scored: list[tuple[str, float]] = []
    for idea in ideas:
        title_tokens = tokenize(idea.get("title", ""))
        body_tokens = tokenize(idea_text(idea))
        if not query_tokens or not (title_tokens | body_tokens):
            scored.append((idea["id"], 0.0))
            continue
        hits = 3 * len(query_tokens & title_tokens) + len(query_tokens & body_tokens)
        scored.append((idea["id"], hits / math.sqrt(len(body_tokens | title_tokens) + 1)))
    scored.sort(key=lambda x: (-x[1], x[0]))
    return scored


def cosine(a: list[float], b: list[float]) -> float:
    if len(a) != len(b) or not a:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def embedding_rank(query_vec: list[float], idea_vecs: dict[str, list[float]]) -> list[tuple[str, float]]:
    scored = [(idea_id, cosine(query_vec, vec)) for idea_id, vec in idea_vecs.items()]
    scored.sort(key=lambda x: (-x[1], x[0]))
    return scored


# =============================================================================
# Accept write path helpers (P4: applied only on explicit user action)
# =============================================================================

_H2_LITERATUR_RE = re.compile(r"^##[ \t]+Literatur[ \t]*#*[ \t]*$", re.IGNORECASE)
_H_LEVEL12_RE = re.compile(r"^#{1,2}[ \t]+")


def format_literature_block(citekey: str, reasoning: str = "", usages: Optional[list[dict]] = None) -> str:
    """The Markdown block an accepted match adds under ``## Literatur``."""
    head = f"- **@{citekey}**"
    if reasoning:
        head += f" — {reasoning}"
    lines = [head]
    for u in usages or []:
        anchor = u.get("anchor")
        suggestion = (u.get("suggestion") or "").strip()
        if not suggestion:
            continue
        prefix = f"[#{anchor}] " if anchor else ""
        lines.append(f"  - {prefix}{suggestion}")
    return "\n".join(lines)


def insert_literature_block(body: str, block: str) -> str:
    """Insert ``block`` at the end of the ``## Literatur`` section, creating the
    section if missing. Fence-aware; everything else stays untouched."""
    lines = body.splitlines()
    section_start = None
    in_fence = False
    for i, line in enumerate(lines):
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if not in_fence and _H2_LITERATUR_RE.match(line):
            section_start = i
            break
    if section_start is None:
        base = body.rstrip("\n")
        prefix = base + "\n\n" if base else ""
        return f"{prefix}## Literatur\n\n{block}\n"
    # Section ends at the next level-1/2 heading (fence-aware) or EOF.
    end = len(lines)
    in_fence = False
    for j in range(section_start + 1, len(lines)):
        if lines[j].lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if not in_fence and _H_LEVEL12_RE.match(lines[j]):
            end = j
            break
    head = "\n".join(lines[:end]).rstrip("\n")
    tail = "\n".join(lines[end:]).strip("\n")
    result = f"{head}\n{block}\n"
    if tail:
        result += f"\n{tail}\n"
    return result
