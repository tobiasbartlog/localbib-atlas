"""A malformed hand edit never stops Atlas (architecture review 2026-10-18).

Hand edits are first-class (P1, "open in editor"), so a file whose YAML does
not parse — ``title: Kalibrierung: ein Problem`` without quotes, a week goal
``- title: Kapitel 3: Methodik`` — must not take the rest of the archive down
with it: the reindex skips it, counts it as invalid, names it in its result
(so the user can find it) and indexes every other file. Atlas still starts.
"""
from __future__ import annotations

import dataclasses
import sqlite3
from pathlib import Path

import pytest

from atlas import config as atlas_config
from atlas import config, documents, journal_store
from atlas import store as store_module
from atlas.domain import DissNode, Idea, Project, Publication
from atlas.journal import Journal
from atlas.store import AtlasStore
from atlas.zettel import Zettel

API = "/api/plugins/atlas"
WEEK = "2026-W39"
BAD_WEEK = "2026-W38"

# Unquoted ": " inside a value — YAML refuses it (ScannerError).
BAD_ENTITY = "---\ntitle: Kalibrierung: ein Problem\n---\n\nVon Hand geschrieben.\n"
BAD_JOURNAL = (
    f"---\nweek: {BAD_WEEK}\ngoals:\n- title: Kapitel 3: Methodik\n---\n\n"
    "## Montag 2026-09-14\n- [ ] Von Hand\n"
)


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(atlas_config, "_base_dir", str(tmp_path))
    config.ensure_dirs()
    return AtlasStore()


def _good_journal() -> Journal:
    return Journal(week=WEEK, body="## Mittwoch 2026-09-23\n- [ ] Gut\n")


# (folder, good entity, stats count key, stats invalid key, listing)
KINDS = {
    "idea": (config.ideas_dir, lambda: Idea(id="gut", title="Gut"),
             "indexed", "invalid", lambda s: [i.id for i in s.list_ideas()]),
    "chapter": (config.diss_dir, lambda: DissNode(id="gut", title="Gut"),
                "nodes_indexed", "nodes_invalid", lambda s: [n.id for n in s.list_nodes()]),
    "project": (config.projects_dir, lambda: Project(id="gut", title="Gut"),
                "projects_indexed", "projects_invalid", lambda s: [p.id for p in s.list_projects()]),
    "publication": (config.publications_dir, lambda: Publication(id="gut", title="Gut"),
                    "publications_indexed", "publications_invalid",
                    lambda s: [p.id for p in s.list_publications()]),
    "zettel": (config.zettel_dir, lambda: Zettel(id="gut", title="Gut"),
               "zettel_indexed", "zettel_invalid", lambda s: [z.id for z in s.list_zettel()]),
}


def _write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


@pytest.mark.parametrize("kind", sorted(KINDS))
def test_a_malformed_entity_file_is_skipped_counted_and_named(store, kind):
    folder, good, count_key, invalid_key, listing = KINDS[kind]
    _write(folder() / "gut.md", good().to_markdown())
    bad = _write(folder() / "kaputt.md", BAD_ENTITY)

    stats = store.reindex()

    assert listing(store) == ["gut"]
    assert stats[count_key] == 2
    assert stats[invalid_key] == 1
    assert [u["path"] for u in stats["unreadable"]] == [str(bad)]
    assert stats["unreadable"][0]["error"]


def test_a_malformed_journal_week_is_skipped_counted_and_named(store):
    _write(config.journal_dir() / f"{WEEK}.md", _good_journal().to_markdown())
    bad = _write(config.journal_dir() / f"{BAD_WEEK}.md", BAD_JOURNAL)

    stats = store.reindex()

    assert [w["week"] for w in store.list_journal_weeks()] == [WEEK]
    assert [t["text"] for t in store.list_journal_tasks()] == ["Gut"]
    assert stats["journals_indexed"] == 2
    assert stats["journals_invalid"] == 1
    assert [u["path"] for u in stats["unreadable"]] == [str(bad)]


def test_bad_files_of_every_kind_are_all_named_and_the_rest_indexed(store):
    for folder, good, *_ in KINDS.values():
        _write(folder() / "gut.md", good().to_markdown())
        _write(folder() / "kaputt.md", BAD_ENTITY)
    _write(config.journal_dir() / f"{WEEK}.md", _good_journal().to_markdown())
    _write(config.journal_dir() / f"{BAD_WEEK}.md", BAD_JOURNAL)

    stats = store.reindex()

    assert len(stats["unreadable"]) == len(KINDS) + 1
    for _folder, _good, _count, _invalid, listing in KINDS.values():
        assert listing(store) == ["gut"]
    assert [w["week"] for w in store.list_journal_weeks()] == [WEEK]
    assert store.reindex() == stats  # still idempotent


def test_check_names_a_week_file_broken_after_it_was_indexed(store):
    path = _write(config.journal_dir() / f"{WEEK}.md", _good_journal().to_markdown())
    store.reindex()
    # Broken by hand afterwards; the watcher could not index it, the row stays.
    path.write_text(BAD_JOURNAL.replace(BAD_WEEK, WEEK), encoding="utf-8")

    report = store.check()

    entry = next(e for e in report if e["id"] == WEEK)
    assert entry["path"] == str(path)
    assert entry["issues"][0].startswith("Datei nicht lesbar")


def test_a_clean_archive_reports_no_unreadable_file(store):
    _write(config.ideas_dir() / "gut.md", Idea(id="gut", title="Gut").to_markdown())
    assert store.reindex()["unreadable"] == []


# --- a lock is no bad file, a database failure is no bad file either --------------
# Review 2026-10-18 (A2): OneDrive or an editor holding a file during the full
# reindex (activate() runs one at every start) must not drop a perfectly valid
# entity from the index for the whole session; a broken atlas.db is a system
# failure, not a file to skip.

@pytest.fixture
def read_locks(monkeypatch):
    """``lock(path, times)``: the next ``times`` reads of ``path`` raise the
    ``PermissionError`` of a file OneDrive or an editor holds (``None``: every
    read). Returns the attempts made so far per path."""
    monkeypatch.setattr(documents, "LOCK_RETRY_DELAY", 0)
    left: dict[Path, float] = {}
    attempts: dict[Path, int] = {}
    original = Path.read_text

    def read_text(self, *args, **kwargs):
        key = Path(self)
        if key in left:
            attempts[key] = attempts.get(key, 0) + 1
            if left[key] > 0:
                left[key] -= 1
                raise PermissionError(13, "Permission denied", str(self))
        return original(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", read_text)

    def lock(path: Path, times=None) -> dict:
        left[Path(path)] = float("inf") if times is None else times
        return attempts

    return lock


@pytest.mark.parametrize("kind", sorted(KINDS))
def test_a_transient_lock_is_retried_and_the_entity_indexed(store, read_locks, kind):
    folder, good, count_key, invalid_key, listing = KINDS[kind]
    path = _write(folder() / "gut.md", good().to_markdown())
    attempts = read_locks(path, times=documents.LOCK_RETRIES - 1)

    stats = store.reindex()

    assert listing(store) == ["gut"]
    assert (stats[count_key], stats[invalid_key], stats["unreadable"]) == (1, 0, [])
    assert attempts[path] == documents.LOCK_RETRIES


@pytest.mark.parametrize("kind", sorted(KINDS))
def test_a_lasting_lock_is_skipped_and_named_as_locked(store, read_locks, kind):
    folder, good, count_key, invalid_key, listing = KINDS[kind]
    locked = _write(folder() / "gesperrt.md", good().to_markdown().replace("gut", "gesperrt"))
    _write(folder() / "gut.md", good().to_markdown())
    read_locks(locked)

    stats = store.reindex()

    assert listing(store) == ["gut"]
    assert (stats[count_key], stats[invalid_key]) == (2, 1)
    [entry] = stats["unreadable"]
    assert entry["path"] == str(locked)
    assert entry["locked"] is True
    assert entry["error"].startswith("gesperrt")


def test_a_journal_week_survives_a_transient_lock(store, read_locks):
    path = _write(config.journal_dir() / f"{WEEK}.md", _good_journal().to_markdown())
    read_locks(path, times=1)

    stats = store.reindex()

    assert [w["week"] for w in store.list_journal_weeks()] == [WEEK]
    assert (stats["journals_invalid"], stats["unreadable"]) == (0, [])


def test_a_lasting_lock_on_a_week_file_is_skipped_and_named_as_locked(store, read_locks):
    _write(config.journal_dir() / f"{WEEK}.md", _good_journal().to_markdown())
    locked = _write(config.journal_dir() / f"{BAD_WEEK}.md",
                    Journal(week=BAD_WEEK, body="## Montag 2026-09-14\n- [ ] Gut\n").to_markdown())
    read_locks(locked)

    stats = store.reindex()

    assert [w["week"] for w in store.list_journal_weeks()] == [WEEK]
    assert stats["journals_invalid"] == 1
    assert [(u["path"], u["locked"]) for u in stats["unreadable"]] == [(str(locked), True)]


def test_a_broken_yaml_file_is_not_named_as_locked(store):
    bad = _write(config.ideas_dir() / "kaputt.md", BAD_ENTITY)
    [entry] = store.reindex()["unreadable"]
    assert entry["path"] == str(bad)
    assert entry["locked"] is False


def test_a_database_failure_while_indexing_an_entity_stops_the_reindex(store, monkeypatch):
    _write(config.ideas_dir() / "gut.md", Idea(id="gut", title="Gut").to_markdown())

    def locked_db(_store, _entity):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(store_module, "_IDEA_SPEC",
                        dataclasses.replace(store_module._IDEA_SPEC, index_one=locked_db))

    with pytest.raises(sqlite3.OperationalError):
        store.reindex()


def test_a_database_failure_while_indexing_a_week_stops_the_reindex(store, monkeypatch):
    _write(config.journal_dir() / f"{WEEK}.md", _good_journal().to_markdown())

    def locked_db(_conn, _journal):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(journal_store, "index_journal", locked_db)

    with pytest.raises(sqlite3.OperationalError):
        store.reindex()


# Valid YAML whose value the INSERT cannot bind (a list or mapping where the
# index holds text): SQLite answers with a ProgrammingError — the file's fault,
# not a failing atlas.db.
UNBINDABLE = {
    "idea": (config.ideas_dir, "---\ntitle: Liste\nvenue:\n  - A\n  - B\n---\n",
             lambda s: [i.id for i in s.list_ideas()]),
    "project": (config.projects_dir, "---\ntitle: Liste\nfunder: [DFG, BMBF]\n---\n",
                lambda s: [p.id for p in s.list_projects()]),
    "publication": (config.publications_dir, "---\ntitle: Mapping\nvenue: {name: X}\n---\n",
                    lambda s: [p.id for p in s.list_publications()]),
}


@pytest.mark.parametrize("kind", sorted(UNBINDABLE))
def test_a_value_the_index_cannot_bind_is_skipped_and_named(store, kind):
    dir_fn, text, listing = UNBINDABLE[kind]
    good = KINDS[kind][1]()
    _write(dir_fn() / "gut.md", good.to_markdown())
    bad = _write(dir_fn() / "liste.md", text)

    stats = store.reindex()

    assert listing(store) == ["gut"]
    assert [(u["path"], u["locked"]) for u in stats["unreadable"]] == [(str(bad), False)]


def test_atlas_starts_with_a_value_the_index_cannot_bind(atlas_app, tmp_path):
    _write(tmp_path / "ideen" / "gut.md", Idea(id="gut", title="Gut").to_markdown())
    _write(tmp_path / "ideen" / "liste.md", UNBINDABLE["idea"][1])

    with atlas_app(tmp_path) as client:
        ideas = client.get(f"{API}/ideas").json()["ideas"]
        assert [i["id"] for i in ideas] == ["gut"]


def test_atlas_starts_with_a_malformed_file_and_indexes_the_good_ones(atlas_app, tmp_path):
    _write(tmp_path / "ideen" / "gut.md", Idea(id="gut", title="Gut").to_markdown())
    _write(tmp_path / "ideen" / "kaputt.md", BAD_ENTITY)
    _write(tmp_path / "journal" / f"{WEEK}.md", _good_journal().to_markdown())
    _write(tmp_path / "journal" / f"{BAD_WEEK}.md", BAD_JOURNAL)

    with atlas_app(tmp_path) as client:
        ideas = client.get(f"{API}/ideas").json()["ideas"]
        assert [i["id"] for i in ideas] == ["gut"]
        week = client.get(f"{API}/journal/{WEEK}").json()
        assert [t["text"] for t in week["tasks"]] == ["Gut"]

        stats = client.post(f"{API}/reindex").json()
        assert sorted(Path(u["path"]).name for u in stats["unreadable"]) == [
            f"{BAD_WEEK}.md", "kaputt.md",
        ]
        assert [i["id"] for i in client.get(f"{API}/ideas").json()["ideas"]] == ["gut"]
        # The bad file itself is left exactly as the user wrote it.
        assert (tmp_path / "ideen" / "kaputt.md").read_text(encoding="utf-8") == BAD_ENTITY
