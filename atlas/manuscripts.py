"""Manuscript file store — plain ``.tex`` files in ``<archive>/manuskripte/``.

A Manuscript is a single ``.tex`` file, compiled by the LaTeX editor's preview. The file is
the source of truth (P1); there is no DB index — listing reads the directory,
so external edits (OneDrive sync, Overleaf round-trips) need no reindexing.
The id is the filename stem, immutable except via rename (same rule as ideas).
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from atlas import config
from atlas.domain import slugify

_ID_RE = re.compile(r"[\w-]+", re.UNICODE)

TEMPLATE = """\\documentclass{{article}}
\\usepackage[utf8]{{inputenc}}
\\usepackage[T1]{{fontenc}}
\\usepackage[ngerman]{{babel}}
\\usepackage{{natbib}}

\\title{{{title}}}
\\author{{}}
\\date{{\\today}}

\\begin{{document}}
\\maketitle



\\bibliographystyle{{plainnat}}
\\bibliography{{literatur}}
\\end{{document}}
"""


def _path(manuscript_id: str) -> Path:
    """Path for an id; rejects anything that could escape manuskripte/."""
    if not manuscript_id or not _ID_RE.fullmatch(manuscript_id):
        raise ValueError(f"Ungueltige Manuskript-ID: {manuscript_id!r}")
    return config.manuscripts_dir() / f"{manuscript_id}.tex"


def _meta(path: Path) -> dict:
    st = path.stat()
    return {
        "id": path.stem,
        "modified": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
        "size": st.st_size,
    }


def list_all() -> list[dict]:
    d = config.manuscripts_dir()
    if not d.exists():
        return []
    files = sorted(d.glob("*.tex"), key=lambda p: p.stat().st_mtime, reverse=True)
    return [_meta(p) for p in files]


def read(manuscript_id: str) -> Optional[dict]:
    path = _path(manuscript_id)
    if not path.exists():
        return None
    data = _meta(path)
    data["content"] = path.read_text(encoding="utf-8")
    return data


def write(manuscript_id: str, content: str) -> dict:
    """Save content; the file must already exist (create() makes new ones)."""
    path = _path(manuscript_id)
    if not path.exists():
        raise FileNotFoundError(manuscript_id)
    path.write_text(content, encoding="utf-8")
    return _meta(path)


def unique_id(title: str) -> str:
    base = slugify(title) or "manuskript"
    candidate, n = base, 2
    while _path(candidate).exists():
        candidate = f"{base}-{n}"
        n += 1
    return candidate


def create(title: str) -> dict:
    manuscript_id = unique_id(title)
    path = _path(manuscript_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(TEMPLATE.format(title=title.strip()), encoding="utf-8")
    data = _meta(path)
    data["content"] = path.read_text(encoding="utf-8")
    return data


def create_from_upload(filename: str, content: str) -> dict:
    """Create a manuscript from an uploaded ``.tex`` file. The id is derived
    from the filename stem (slugified + deduped); content is stored verbatim."""
    stem = (filename or "").replace("\\", "/").rsplit("/", 1)[-1]
    if stem.lower().endswith(".tex"):
        stem = stem[:-4]
    manuscript_id = unique_id(stem)
    path = _path(manuscript_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    data = _meta(path)
    data["content"] = path.read_text(encoding="utf-8")
    return data


def rename(manuscript_id: str, new_title: str) -> dict:
    old = _path(manuscript_id)
    if not old.exists():
        raise FileNotFoundError(manuscript_id)
    new_id = unique_id(new_title)
    old.rename(_path(new_id))
    return _meta(_path(new_id))


def delete(manuscript_id: str) -> bool:
    path = _path(manuscript_id)
    if not path.exists():
        return False
    path.unlink()
    return True
