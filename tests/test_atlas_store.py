"""Atlas store tests — indexer, reindex idempotence, check."""
from __future__ import annotations

import pytest

from atlas import config as atlas_config
from atlas import config
from atlas.domain import Idea, new_idea
from atlas.store import AtlasStore


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(atlas_config, "_base_dir", str(tmp_path))
    config.ensure_dirs()
    return AtlasStore()


def test_index_and_get_round_trip(store):
    idea = new_idea("Roundtrip idea")
    idea.body = "## Literatur\n"
    store.index_idea(idea)

    loaded = store.get_idea(idea.id)
    assert loaded is not None
    assert loaded.title == "Roundtrip idea"
    assert loaded.anchors == ["literatur"]


def test_save_file_then_index_file(store):
    idea = new_idea("From file")
    path = store.save_idea_file(idea)
    assert path.exists()
    assert path.name == f"{idea.id}.md"

    indexed = store.index_file(path)
    assert indexed.id == idea.id
    assert store.get_idea(idea.id).title == "From file"


def test_reindex_is_idempotent(store):
    for title in ("First", "Second", "Third"):
        store.save_idea_file(new_idea(title))

    stats1 = store.reindex()
    ids1 = [i.id for i in store.list_ideas()]
    stats2 = store.reindex()
    ids2 = [i.id for i in store.list_ideas()]

    assert stats1["indexed"] == 3
    assert stats1 == stats2
    assert ids1 == ids2
    assert len(ids1) == 3


def test_reindex_detects_duplicate_ids(store):
    # Two files declaring the same id.
    (config.ideas_dir() / "a.md").write_text(
        Idea(id="shared", title="A", type="paper-idea", status="seed").to_markdown(),
        encoding="utf-8",
    )
    (config.ideas_dir() / "b.md").write_text(
        Idea(id="shared", title="B", type="paper-idea", status="seed").to_markdown(),
        encoding="utf-8",
    )
    stats = store.reindex()
    assert stats["duplicates"]
    assert stats["duplicates"][0]["id"] == "shared"


def test_check_reports_invalid_idea(store):
    bad = Idea(id="bad", title="", type="paper-idea", status="seed")
    store.save_idea_file(bad)
    store.reindex()

    report = store.check()
    assert any(entry["id"] == "bad" for entry in report)


def test_check_flags_hanging_refs_with_resolver(store):
    idea = new_idea("Has refs")
    idea.refs = ["inlibrary2025", "missing2025"]
    store.save_idea_file(idea)
    store.reindex()

    report = store.check(resolve_citekey=lambda key: key == "inlibrary2025")
    issues = [i for entry in report for i in entry["issues"]]
    assert any("missing2025" in i for i in issues)
    assert not any("inlibrary2025" in i for i in issues)


def test_links_for_matches_refs(store):
    a = new_idea("Idea A"); a.refs = ["doe2024", "smith2023"]; store.index_idea(a)
    b = new_idea("Idea B"); b.refs = ["doe2024"]; store.index_idea(b)
    c = new_idea("Idea C"); store.index_idea(c)  # no refs

    linked = {i.id for i in store.links_for("doe2024")}
    assert linked == {a.id, b.id}
    assert store.links_for("smith2023") and store.links_for("smith2023")[0].id == a.id
    assert store.links_for("missing") == []
    assert store.links_for("") == []


def test_remove_id(store):
    idea = new_idea("To remove")
    store.index_idea(idea)
    assert store.get_idea(idea.id) is not None
    store.remove_id(idea.id)
    assert store.get_idea(idea.id) is None
