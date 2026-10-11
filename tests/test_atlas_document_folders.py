"""Document folders follow their entity (#226 review): ids never inherit a
leftover folder, a switch moves the folder along and can be undone, renames
ride out a transient OneDrive/Defender lock like a document delete does."""
from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest

from atlas import documents
from atlas.documents import DocumentFolder

DAY = date(2026, 10, 10)
ASIDE = "geloescht-2026-10-10"


@pytest.fixture
def folders(tmp_path, monkeypatch):
    monkeypatch.setattr(documents, "_today", lambda: DAY)
    monkeypatch.setattr(documents, "LOCK_RETRY_DELAY", 0)
    return (
        DocumentFolder(lambda: tmp_path / "veroeffentlichungen"),
        DocumentFolder(lambda: tmp_path / "projekte"),
    )


def _file(folder: DocumentFolder, entity_id: str, name: str = "a.txt") -> Path:
    d = folder.dir_for(entity_id)
    d.mkdir(parents=True, exist_ok=True)
    (d / name).write_text("x", encoding="utf-8")
    return d


def test_a_leftover_folder_makes_an_id_taken(folders):
    pubs, _ = folders
    _file(pubs, "beitrag")
    assert pubs.free_id("beitrag", lambda i: False) == "beitrag-2"
    assert pubs.free_id("beitrag", lambda i: i == "beitrag-2") == "beitrag-3"
    assert pubs.free_id("neu", lambda i: False) == "neu"


def test_an_entity_file_on_disk_takes_its_id_and_odd_ids_have_no_folder(folders, tmp_path):
    pubs, _ = folders
    (tmp_path / "veroeffentlichungen").mkdir()
    (tmp_path / "veroeffentlichungen" / "x.md").write_text("---\n---\n", encoding="utf-8")
    assert pubs.free_id("x", lambda i: False) == "x-2"  # unindexed, still never overwritten
    assert pubs.free_id("a.b", lambda i: False) == "a.b"  # no folder possible, no error
    _file(pubs, "y")
    assert pubs.free_id("y", lambda i: False, count_folders=False) == "y"  # the switch keeps its id


def test_set_aside_keeps_the_files_under_a_name_no_id_can_take(folders, tmp_path):
    pubs, _ = folders
    _file(pubs, "x")
    (tmp_path / "veroeffentlichungen" / f"x.{ASIDE}").mkdir()  # an earlier delete that day
    aside = pubs.set_aside("x")
    assert aside == tmp_path / "veroeffentlichungen" / f"x.{ASIDE}-2"
    assert (aside / "a.txt").is_file() and not pubs.dir_for("x").exists()


def test_move_to_sets_an_orphan_aside_even_without_a_source_folder(folders, tmp_path):
    pubs, projs = folders
    _file(projs, "x", "alt.txt")
    pubs.move_to("x", projs, "x")
    assert not projs.dir_for("x").exists()
    assert (tmp_path / "projekte" / f"x.{ASIDE}" / "alt.txt").is_file()


def test_a_move_can_be_undone_with_its_orphan(folders, tmp_path):
    pubs, projs = folders
    _file(pubs, "x", "neu.pdf")
    _file(projs, "x", "alt.txt")
    renames = pubs.move_to("x", projs, "x")
    assert (projs.dir_for("x") / "neu.pdf").is_file()
    documents.undo_renames(renames)
    assert (pubs.dir_for("x") / "neu.pdf").is_file()
    assert (projs.dir_for("x") / "alt.txt").is_file()
    assert not (tmp_path / "projekte" / f"x.{ASIDE}").exists()


def test_renames_ride_out_a_transient_lock(folders, monkeypatch):
    pubs, projs = folders
    real = Path.rename
    fails = {"left": 0}

    def flaky(self, target):
        if fails["left"]:
            fails["left"] -= 1
            raise PermissionError("OneDrive")
        return real(self, target)

    monkeypatch.setattr(Path, "rename", flaky)
    _file(pubs, "x")
    fails["left"] = 1
    assert pubs.set_aside("x") is not None
    _file(pubs, "y")
    fails["left"] = 2
    pubs.move_to("y", projs, "y")
    assert projs.dir_for("y").is_dir()


def test_a_lasting_lock_is_raised_and_nothing_moved(folders, monkeypatch):
    pubs, _ = folders
    _file(pubs, "x")

    def locked(self, target):
        raise PermissionError("in Benutzung")

    monkeypatch.setattr(Path, "rename", locked)
    with pytest.raises(PermissionError):
        pubs.set_aside("x")
    assert (pubs.dir_for("x") / "a.txt").is_file()
