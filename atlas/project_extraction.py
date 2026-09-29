"""LLM-assisted extraction of Atlas project metadata from PDF documents.

The module is plugin-local on purpose: PDF text extraction uses PyMuPDF here,
then the API layer passes the text to the host-provided ``api.llm`` service.
It never writes project files; callers receive a proposal only (P4).
"""

from __future__ import annotations

import json
import re
from datetime import date
from pathlib import Path
from typing import Any

import fitz

FIELDS = ("start", "end", "funder", "grant_id", "role")
ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MAX_PDF_TEXT_CHARS = 200000
TRUNCATION_WARNING = (
    "PDF-Text wurde wegen Laenge gekuerzt; der Vorschlag basiert auf dem Anfang des Dokuments."
)


def extract_pdf_text(path: Path) -> str:
    """Return selectable PDF text. Scanned PDFs intentionally stay unsupported."""
    try:
        with fitz.open(path) as doc:
            chunks = [page.get_text("text") for page in doc]
    except Exception as exc:  # noqa: BLE001 - PyMuPDF exposes multiple exception types
        raise ValueError(f"PDF konnte nicht gelesen werden: {exc}") from exc
    text = "\n".join(chunks).strip()
    if not text:
        raise ValueError("PDF enthaelt keinen auslesbaren Text; OCR wird nicht ausgefuehrt.")
    return text


def cap_pdf_text(text: str, limit: int | None = None) -> tuple[str, list[str]]:
    limit = MAX_PDF_TEXT_CHARS if limit is None else limit
    if len(text) <= limit:
        return text, []
    return text[:limit], [TRUNCATION_WARNING]


def build_extraction_messages(
    document_name: str, text: str, affiliation: str | None = None
) -> list[dict[str, str]]:
    system = (
        "Du extrahierst Eckdaten aus einem Foerderprojekt-PDF. "
        "Antworte ausschliesslich als JSON-Objekt. "
        "Extrahiere nur Angaben, die explizit im Dokument stehen. "
        "Wenn eine Angabe nicht explizit im Text steht, setze den Wert auf null."
    )
    affiliation = (affiliation or "").strip()
    if affiliation:
        # Foerderantraege haben mehrere Projektpartner: aus Sicht DER Institution
        # des Nutzers extrahieren (role/milestones/workpackages dieses Partners).
        system += (
            f" Der Nutzer gehoert zu folgender Institution/Organisation: {affiliation}. "
            "In Foerderantraegen gibt es mehrere Projektpartner. Extrahiere role, "
            "milestones und workpackages bevorzugt aus Sicht und Zustaendigkeit "
            "dieser Institution. Wenn Arbeitspakete oder Aufgaben explizit einzelnen "
            "Partnern zugeordnet sind, nimm ausschliesslich die dieser Institution. "
            "Steht zu dieser Institution nichts Explizites, lass die betreffenden "
            "Felder leer bzw. die Listen leer."
        )
    return [
        {
            "role": "system",
            "content": system,
        },
        {
            "role": "user",
            "content": (
                "Gesuchte Felder: start, end, funder, grant_id, role, milestones, workpackages.\n"
                "Datumswerte fuer start/end nach Moeglichkeit als ISO-Datum YYYY-MM-DD; "
                "sonst den expliziten Dokumentwert als String verwenden.\n"
                "Meilensteine als Liste von Objekten {title, date}; date strikt als "
                "ISO-Datum YYYY-MM-DD oder null, wenn kein exaktes Datum im Dokument steht.\n"
                "Arbeitspakete als strukturierte Liste workpackages mit Objekten "
                "{title, tasks}. tasks ist eine Liste kurzer Aufgaben-Strings. "
                "Gib kein Markdown fuer Arbeitspakete aus.\n"
                "JSON-Schema: {\"start\": string|null, \"end\": string|null, "
                "\"funder\": string|null, \"grant_id\": string|null, "
                "\"role\": string|null, \"milestones\": [{\"title\": string, "
                "\"date\": string|null}], \"workpackages\": [{\"title\": string, "
                "\"tasks\": [string]}]}\n\n"
                f"Dokument: {document_name}\n\n"
                f"PDF-Text:\n{text}"
            ),
        },
    ]


def _strip_fences(text: str) -> str:
    text = re.sub(r"^```json\s*", "", text.strip(), flags=re.IGNORECASE)
    text = re.sub(r"^```\s*", "", text.strip())
    text = re.sub(r"\s*```$", "", text.strip())
    return text.strip()


def _is_iso_date(value: str) -> bool:
    if not ISO_DATE_RE.match(value):
        return False
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return True


def _parse_milestones(raw: Any, warnings: list[str]) -> list[dict[str, str | None]]:
    if not isinstance(raw, list):
        return []

    milestones: list[dict[str, str | None]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()
        if not title:
            continue
        raw_date = item.get("date")
        milestone_date: str | None = None
        if raw_date is not None:
            date_text = str(raw_date).strip()
            if date_text:
                if _is_iso_date(date_text):
                    milestone_date = date_text
                else:
                    warnings.append(
                        f"Meilenstein-Datum fuer '{title}' verworfen: '{date_text}' ist kein ISO-Datum YYYY-MM-DD."
                    )
        milestones.append({"title": title, "date": milestone_date})
    return milestones


def _clean_markdown_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _parse_workpackages(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []

    workpackages: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        title = _clean_markdown_text(item.get("title"))
        if not title:
            continue
        raw_tasks = item.get("tasks")
        tasks: list[str] = []
        if isinstance(raw_tasks, list):
            tasks = [_clean_markdown_text(task) for task in raw_tasks]
            tasks = [task for task in tasks if task]
        workpackages.append({"title": title, "tasks": tasks})
    return workpackages


def render_workpackages_markdown(workpackages: list[dict[str, Any]]) -> str:
    """Render structured work packages for atlas.domain.parse_sections()."""
    blocks: list[str] = []
    for item in _parse_workpackages(workpackages):
        lines = [f"## {item['title']}"]
        lines.extend(f"- [ ] {task}" for task in item["tasks"])
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


def parse_extraction_response(content: str, warnings: list[str] | None = None) -> dict[str, Any]:
    try:
        raw = json.loads(_strip_fences(content or ""))
    except json.JSONDecodeError as exc:
        raise ValueError(f"LLM-Antwort ist kein gueltiges JSON: {exc}") from exc
    if not isinstance(raw, dict):
        raise ValueError("LLM-Antwort muss ein JSON-Objekt sein")

    proposal: dict[str, Any] = {}
    for field in FIELDS:
        value = raw.get(field)
        if value is None:
            proposal[field] = None
        elif isinstance(value, str):
            proposal[field] = value.strip() or None
        else:
            proposal[field] = str(value).strip() or None

    llm_warnings = raw.get("warnings")
    clean_warnings = list(warnings or [])
    if isinstance(llm_warnings, list):
        clean_warnings.extend(str(w).strip() for w in llm_warnings if str(w).strip())
    proposal["milestones"] = _parse_milestones(raw.get("milestones"), clean_warnings)
    proposal["workpackages"] = _parse_workpackages(raw.get("workpackages"))
    proposal["workpackage_markdown"] = render_workpackages_markdown(proposal["workpackages"])
    proposal["warnings"] = clean_warnings
    return proposal
