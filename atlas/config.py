"""Atlas paths and configuration.

Atlas owns its data fully (P2): a user-chosen archive folder of Markdown files
plus a derived ``atlas.db`` index. The folder is the Add-on setting
``base_dir`` (``plugin.json``, type ``path``), read through ``SettingsApi`` in
``AtlasPlugin.activate``; left empty it defaults to ``<Basisordner>/atlas``,
the core's library base dir from ``settings.core()``. Atlas never reads the
process environment for it (ADR-0021) — the legacy ``ATLAS_BASE_DIR`` of an
old ``.env`` reaches this module migrated into that setting.

This module imports only stdlib — it never touches the LocalBib core (P3).
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional, Union

# The configured archive root: set by ``configure`` (activate) and cleared on
# deactivate. Tests pin it directly (``monkeypatch.setattr(config, "_base_dir", ...)``).
_base_dir: Optional[Union[str, Path]] = None


def resolve_base_dir(setting: Optional[str], core_base_dir: Optional[str]) -> Optional[Path]:
    """The archive root from the Add-on setting, else ``<core base dir>/atlas``.

    ``~`` and ``%VARS%`` are expanded like the core does for its own base dir.
    ``None`` when neither is known."""
    raw = (setting or "").strip()
    if raw:
        return Path(os.path.expandvars(raw)).expanduser()
    core = (core_base_dir or "").strip()
    if core:
        return Path(os.path.expandvars(core)).expanduser() / "atlas"
    return None


def configure(path: Optional[Union[str, Path]]) -> None:
    """Set (or with ``None`` clear) the archive root for this process."""
    global _base_dir
    _base_dir = path


def base_dir() -> Path:
    """Root of the Atlas archive (Git repo of Markdown files).

    Raises ``RuntimeError`` while Atlas is not configured — reading or writing
    a guessed folder would scatter the user's archive."""
    if _base_dir is None or not str(_base_dir).strip():
        raise RuntimeError("Atlas base dir is not configured (AtlasPlugin.activate sets it)")
    return Path(os.path.expandvars(str(_base_dir))).expanduser()


def ideas_dir() -> Path:
    return base_dir() / "ideen"


def diss_dir() -> Path:
    return base_dir() / "dissertation"


def projects_dir() -> Path:
    return base_dir() / "projekte"


def publications_dir() -> Path:
    """Publications (atlas.publication/2), see ADR-0004/ADR-0022."""
    return base_dir() / "veroeffentlichungen"


def manuscripts_dir() -> Path:
    """LaTeX manuscripts (.tex), compiled by the LaTeX editor's preview."""
    return base_dir() / "manuskripte"


def journal_dir() -> Path:
    """One Markdown file per ISO week (atlas.journal/1), see ADR-0020."""
    return base_dir() / "journal"


def zettel_dir() -> Path:
    """The knowledge entity (atlas.zettel/1) — deliberately not "Notizen"."""
    return base_dir() / "zettel"


def db_path() -> Path:
    """Derived SQLite index. Lives in a hidden ``.atlas/`` so it is never mistaken
    for archive content and can be wiped/rebuilt at will (P1: reconstructable)."""
    return base_dir() / ".atlas" / "atlas.db"


def ensure_dirs() -> None:
    """Create the archive skeleton and the index directory if missing."""
    for d in (
        ideas_dir(), diss_dir(), projects_dir(), publications_dir(),
        manuscripts_dir(), journal_dir(), zettel_dir(), db_path().parent,
    ):
        d.mkdir(parents=True, exist_ok=True)
