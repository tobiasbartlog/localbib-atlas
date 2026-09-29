"""Project document store — plain files in ``<archive>/projekte/<project-id>/``.

Per-project documents (Vorhabensbeschreibung, Zwischenberichte, ...) per
ADR-0004 / issue #49. Like manuscripts, documents carry no frontmatter and
deliberately have no JSON schema: the directory IS the listing (P1 — files are
the source of truth, no DB index, no frontmatter bookkeeping). Files dropped
into the folder externally appear identically to uploaded ones.

The indexer never scans these subfolders (it globs ``projekte/*.md``
non-recursively and routes watcher events by exact parent dir), so project
documents can never be mistaken for project Markdown files.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from atlas import config

_PROJECT_ID_RE = re.compile(r"[\w-]+", re.UNICODE)
# Windows-reserved characters plus path separators; control chars are checked
# separately. Everything else (spaces, umlauts, dots) is a legal filename.
_FORBIDDEN_CHARS = set('<>:"/\\|?*')


def _project_dir(project_id: str) -> Path:
    """Document folder for a project id; rejects anything that could escape
    projekte/. (Project ids come from slugify, so this is belt and braces.)"""
    if not project_id or not _PROJECT_ID_RE.fullmatch(project_id):
        raise ValueError(f"Ungueltige Projekt-ID: {project_id!r}")
    return config.projects_dir() / project_id


def safe_filename(raw: str) -> str:
    """Bare filename from (possibly client-supplied) input.

    Strips any path components, then rejects empty names, dotfiles and names
    with reserved/control characters — a name that survives cannot escape the
    project folder."""
    name = (raw or "").replace("\\", "/").rsplit("/", 1)[-1].strip()
    if not name or name.startswith("."):
        raise ValueError(f"Ungueltiger Dateiname: {raw!r}")
    if any(c in _FORBIDDEN_CHARS or ord(c) < 32 for c in name):
        raise ValueError(f"Ungueltiger Dateiname: {raw!r}")
    return name


def _meta(path: Path) -> dict:
    st = path.stat()
    return {
        "name": path.name,
        "modified": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
        "size": st.st_size,
    }


def path_for(project_id: str, filename: str) -> Path:
    """Validated path of one document (existence not checked)."""
    return _project_dir(project_id) / safe_filename(filename)


def list_all(project_id: str) -> list[dict]:
    """Directory listing — uploaded and externally dropped files alike.
    Hidden files (dotfiles) are skipped; subdirectories are not descended."""
    d = _project_dir(project_id)
    if not d.exists():
        return []
    files = sorted(
        (p for p in d.iterdir() if p.is_file() and not p.name.startswith(".")),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    return [_meta(p) for p in files]


def save(project_id: str, filename: str, data: bytes) -> dict:
    """Store an uploaded document. Never overwrites: name collisions get a
    ``-2``/``-3``... suffix before the extension (uploads must not destroy
    existing user files)."""
    name = safe_filename(filename)
    d = _project_dir(project_id)
    d.mkdir(parents=True, exist_ok=True)
    stem, dot, ext = name.rpartition(".")
    if not dot:  # no extension
        stem, ext = name, ""
    candidate, n = name, 2
    while (d / candidate).exists():
        candidate = f"{stem}-{n}.{ext}" if dot else f"{stem}-{n}"
        n += 1
    path = d / candidate
    path.write_bytes(data)
    return _meta(path)


def delete(project_id: str, filename: str) -> None:
    """Delete one document from the project folder (Atlas writes only its own
    folder, P2). Rejects names that could escape the folder and refuses to
    touch anything that is not a regular file (e.g. subdirectories).

    OneDrive/Defender briefly lock freshly synced files, so a transient
    ``PermissionError`` is retried a few times before it is surfaced."""
    path = path_for(project_id, filename)
    if path.is_dir():
        raise ValueError("Kann kein Verzeichnis loeschen")
    if not path.is_file():
        raise FileNotFoundError(filename)
    last_error: PermissionError | None = None
    for attempt in range(3):
        try:
            path.unlink()
            return
        except PermissionError as exc:  # transient lock (OneDrive sync, AV scan)
            last_error = exc
            time.sleep(0.3)
    raise last_error  # persistent lock (file open in a viewer) -> caller maps to 423


def open_in_viewer(path: Path) -> None:
    """Open a document with the OS default application (story 30 — the app
    runs on the user's own machine, same pattern as the core's PDF open)."""
    if sys.platform == "win32":
        os.startfile(str(path))  # noqa: S606 - explicit user action
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])
