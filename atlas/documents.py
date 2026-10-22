"""Document folders — plain files in ``<archive>/<entity folder>/<id>/``.

Per-project documents (Vorhabensbeschreibung, Zwischenberichte, ...) per
ADR-0004 / issue #49 live in ``projekte/<project-id>/``; since #226 every
Publication has the same kind of folder in ``veroeffentlichungen/<id>/``
(Gutachten, Abbildungen, Vorlagen, ``.bib``). One :class:`DocumentFolder`
holds the folder logic for both — shared, not copied. Like manuscripts,
documents carry no frontmatter and deliberately have no JSON schema: the
directory IS the listing (P1 — files are the source of truth, no DB index, no
frontmatter bookkeeping). Files dropped into the folder externally appear
identically to uploaded ones.

The indexer never scans these subfolders (it globs ``<folder>/*.md``
non-recursively and routes watcher events by exact parent dir), so documents
can never be mistaken for entity Markdown files.

The module-level functions (``list_all``, ``save``, ``path_for``, ``delete``)
are the project folder (:data:`PROJECTS`), unchanged since #49;
:data:`PUBLICATIONS` is the publication folder.

The folder follows its entity (#226 review): a type switch moves it along
(:meth:`DocumentFolder.move_to`), deleting the entity sets it aside as
``<id>.geloescht-<date>`` (:meth:`DocumentFolder.set_aside`), and a new
entity never takes an id whose folder exists (:meth:`DocumentFolder.free_id`)
— so no entity inherits a folder it did not have, however the old ``.md``
went. Atlas never deletes a user file silently; renames and deletes ride out
a transient OneDrive/Defender lock (:func:`retry_locked`), and the callers
take back what they did when a lock lasts (:func:`undo_renames`).
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import time
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Callable, Optional

from atlas import config, entity_store

_PROJECT_ID_RE = re.compile(r"[\w-]+", re.UNICODE)
# Windows-reserved characters plus path separators; control chars are checked
# separately. Everything else (spaces, umlauts, dots) is a legal filename.
_FORBIDDEN_CHARS = set('<>:"/\\|?*')


def _entity_dir(root: Path, entity_id: str) -> Path:
    """Document folder for an entity id; rejects anything that could escape
    the entity folder. (Ids come from slugify, so this is belt and braces.)"""
    if not entity_id or not _PROJECT_ID_RE.fullmatch(entity_id):
        raise ValueError(f"Ungueltige ID: {entity_id!r}")
    return root / entity_id


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


# OneDrive/Defender briefly lock freshly synced files and folders: a transient
# ``PermissionError`` is retried this often, this far apart, before it counts.
LOCK_RETRIES = 3
LOCK_RETRY_DELAY = 0.3


def retry_locked(action: Callable[[], object]):
    """Run a file operation, retrying a transient lock; a lasting one raises
    (the caller maps it to 423 ``error.atlas.document_locked``)."""
    for attempt in range(LOCK_RETRIES):
        try:
            return action()
        except PermissionError:
            if attempt == LOCK_RETRIES - 1:
                raise
            time.sleep(LOCK_RETRY_DELAY)


def _rename(source: Path, target: Path) -> None:
    retry_locked(lambda: source.rename(target))


def undo_renames(renames: list[tuple[Path, Path]]) -> None:
    """Take back the renames of :meth:`DocumentFolder.move_to` /
    :meth:`DocumentFolder.set_aside` (``(from, to)`` pairs), newest first."""
    for source, target in reversed(renames):
        _rename(target, source)


def _today() -> date:
    return date.today()  # module level so tests pin the day


class DocumentFolder:
    """The document folders below one entity folder (``root()``), one
    subfolder per entity id."""

    def __init__(self, root: Callable[[], Path]) -> None:
        self._root = root

    def dir_for(self, entity_id: str) -> Path:
        return _entity_dir(self._root(), entity_id)

    def path_for(self, entity_id: str, filename: str) -> Path:
        """Validated path of one document (existence not checked)."""
        return self.dir_for(entity_id) / safe_filename(filename)

    def list_all(self, entity_id: str) -> list[dict]:
        """Directory listing — uploaded and externally dropped files alike.
        Hidden files (dotfiles) are skipped; subdirectories are not descended."""
        d = self.dir_for(entity_id)
        if not d.exists():
            return []
        files = sorted(
            (p for p in d.iterdir() if p.is_file() and not p.name.startswith(".")),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        return [_meta(p) for p in files]

    def save(self, entity_id: str, filename: str, data: bytes) -> dict:
        """Store an uploaded document. Never overwrites: name collisions get a
        ``-2``/``-3``... suffix before the extension (uploads must not destroy
        existing user files)."""
        name = safe_filename(filename)
        d = self.dir_for(entity_id)
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

    def delete(self, entity_id: str, filename: str) -> None:
        """Delete one document from the folder (Atlas writes only its own
        folder, P2). Rejects names that could escape the folder and refuses to
        touch anything that is not a regular file (e.g. subdirectories).

        OneDrive/Defender briefly lock freshly synced files, so a transient
        ``PermissionError`` is retried a few times before it is surfaced
        (:func:`retry_locked`; a persistent lock -> the caller's 423)."""
        path = self.path_for(entity_id, filename)
        if path.is_dir():
            raise ValueError("Kann kein Verzeichnis loeschen")
        if not path.is_file():
            raise FileNotFoundError(filename)
        retry_locked(path.unlink)

    def read_text(self, entity_id: str, filename: str) -> Optional[str]:
        """A document's text (utf-8, else latin-1), or None when absent."""
        path = self.path_for(entity_id, filename)
        if not path.is_file():
            return None
        raw = path.read_bytes()
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            return raw.decode("latin-1")

    def free_id(self, base: str, exists: Callable[[str], bool], *, count_folders: bool = True) -> str:
        """``base``, else ``base-2``, ``-3``…: the first id that no entity has
        (``exists``, the index) and no entity FILE holds on disk — an
        unindexed ``<id>.md`` is never overwritten. For a NEW entity
        (create, promote, plan) a document folder makes the id taken, too: a
        folder left behind (its ``.md`` deleted in the Explorer, or by an
        Atlas before #226) stays where it is and is never inherited. The type
        switch passes ``count_folders=False``: it keeps its id, so references
        do not break, and :meth:`move_to` sets an orphan folder aside. An id
        no folder can have (outside ``[\\w-]+``, a hand-named file) has none.
        The suffix loop and the ``.md`` rule are :func:`entity_store.free_id`."""

        def taken(candidate: str) -> bool:
            if exists(candidate):
                return True
            if not count_folders:
                return False
            try:
                return self.dir_for(candidate).exists()
            except ValueError:
                return False

        return entity_store.free_id(base, taken, self._root())

    def set_aside(self, entity_id: str, today: Optional[date] = None) -> Optional[Path]:
        """The entity is gone: its folder must not resurface under a NEW entity
        with the same id (re-planning a Collection reuses ``sammlung-<id>``),
        and no user file may vanish. An empty folder is removed; otherwise it
        is renamed to ``<id>.geloescht-<date>`` beside the others — a name no
        entity id can take (ids are ``[\\w-]+``), suffixed on collision. The
        user restores it by renaming it back. Returns the new path, or None
        when there was nothing to keep. A lasting lock raises ``OSError``."""
        folder = self.dir_for(entity_id)
        if not folder.is_dir():
            return None
        if not any(folder.iterdir()):
            retry_locked(folder.rmdir)
            return None
        stamp = (today or _today()).isoformat()
        target = folder.with_name(f"{entity_id}.geloescht-{stamp}")
        n = 2
        while target.exists():
            target = folder.with_name(f"{entity_id}.geloescht-{stamp}-{n}")
            n += 1
        _rename(folder, target)
        return target

    def move_to(
        self, entity_id: str, other: "DocumentFolder", new_id: str, today: Optional[date] = None
    ) -> list[tuple[Path, Path]]:
        """The type switch (Publication <-> Forschungsprojekt): the documents
        go along into ``other``'s folder under ``new_id``. A folder already
        there belongs to no entity (an orphan of a deleted one) and is set
        aside first — also when this entity has no folder, so the switched
        entity never inherits it. Returns the renames done, for
        :func:`undo_renames`. A lasting lock raises ``OSError``; a rename that
        already happened is taken back first."""
        renames: list[tuple[Path, Path]] = []
        target = other.dir_for(new_id)
        source = self.dir_for(entity_id)
        if target.is_dir():
            aside = other.set_aside(new_id, today)
            if aside is not None:
                renames.append((target, aside))
        if not source.is_dir():
            return renames
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            _rename(source, target)
        except OSError:
            undo_renames(renames)
            raise
        renames.append((source, target))
        return renames


PROJECTS = DocumentFolder(config.projects_dir)
PUBLICATIONS = DocumentFolder(config.publications_dir)


def path_for(project_id: str, filename: str) -> Path:
    """Validated path of one project document (existence not checked)."""
    return PROJECTS.path_for(project_id, filename)


def list_all(project_id: str) -> list[dict]:
    return PROJECTS.list_all(project_id)


def save(project_id: str, filename: str, data: bytes) -> dict:
    return PROJECTS.save(project_id, filename, data)


def delete(project_id: str, filename: str) -> None:
    PROJECTS.delete(project_id, filename)


def open_in_viewer(path: Path) -> None:
    """Open a document with the OS default application (story 30 — the app
    runs on the user's own machine, same pattern as the core's PDF open)."""
    if sys.platform == "win32":
        os.startfile(str(path))  # noqa: S606 - explicit user action
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])


def reveal_in_folder(path: Path) -> None:
    """Show ``path`` selected in the system file manager ("Im Atlas-Ordner
    zeigen"); where that is not possible, open its folder."""
    if sys.platform == "win32":
        subprocess.Popen(["explorer", "/select,", str(path)])  # noqa: S603,S607 - explicit user action
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(Path(path).parent)])
