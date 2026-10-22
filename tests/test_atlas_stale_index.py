"""A UI write never puts a stale index row over a hand edit (review 2026-10-18).

Every update of an Idee, Kapitel, Projekt, Veroeffentlichung or Notiz loads
the entity from the index (``atlas.db``) and writes the whole file back. When
the user edited that file by hand and the indexer could not read the edit —
YAML broken by ``title: Kalibrierung: ein Problem``: the watcher logs it and
keeps the old row — or has not read it yet, that write would put the stale
row over the user's text (P1). The same when another file with the same
frontmatter id (a sync conflict copy) is the indexed one. So an existing file
is rewritten only while it is what the index read; otherwise the write stops
before it starts — the API answers 409 ``{code: error.atlas.file_changed,
params: {file}}`` and the bytes stay as the user left them.
"""
from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest
from plugin_api.testing import InMemoryLibrary

from atlas import api_pipeline, api_zettel
from atlas import config as atlas_config
from atlas import config
from atlas.collection_sync import reconcile_tombstones
from atlas.domain import DissNode, Idea, Project, Publication
from atlas.entity_store import FileChanged
from atlas.index_links import KIND_DISS_NODE, KIND_IDEA, KIND_PROJECT, KIND_PUBLICATION, KIND_ZETTEL
from atlas.store import AtlasStore
from atlas.zettel import Zettel

API = "/api/plugins/atlas"
CHANGED = "error.atlas.file_changed"
TODAY = date(2026, 9, 23)


def hand_broken(entity_id: str) -> str:
    """The hand edit of the review: ``: `` inside an unquoted title."""
    return (
        f"---\nid: {entity_id}\ntitle: Kalibrierung: ein Problem\n---\n\n"
        "Alter Text\n\nVon Hand ergaenzt.\n"
    )


def listing(*folders: str) -> dict:
    return {f: sorted(p.name for p in (config.base_dir() / f).glob("*.md")) for f in folders}


# --- the store: one rule for every entity kind -----------------------------------

@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(atlas_config, "_base_dir", str(tmp_path))
    config.ensure_dirs()
    return AtlasStore()


# kind -> (folder, new entity, save, index, get)
KINDS = {
    "idea": ("ideen", lambda: Idea(id="x", title="X", body="Alter Text"),
             "save_idea_file", "index_file", "get_idea"),
    "chapter": ("dissertation", lambda: DissNode(id="x", title="X", status="planned", body="Alter Text"),
                "save_node_file", "index_diss_file", "get_node"),
    "project": ("projekte", lambda: Project(id="x", title="X", body="Alter Text"),
                "save_project_file", "index_project_file", "get_project"),
    "publication": ("veroeffentlichungen", lambda: Publication(id="x", title="X", body="Alter Text"),
                    "save_publication_file", "index_publication_file", "get_publication"),
    "zettel": ("zettel", lambda: Zettel(id="x", title="X", body="Alter Text"),
               "save_zettel_file", "index_zettel_file", "get_zettel"),
}
LINK_KINDS = {
    "idea": KIND_IDEA, "chapter": KIND_DISS_NODE, "project": KIND_PROJECT,
    "publication": KIND_PUBLICATION, "zettel": KIND_ZETTEL,
}


def _indexed(store, kind: str):
    folder, make, save, index, get = KINDS[kind]
    getattr(store, index)(getattr(store, save)(make()))
    return getattr(store, get)("x"), config.base_dir() / folder / "x.md"


@pytest.mark.parametrize("kind", sorted(KINDS))
def test_a_hand_edit_the_index_could_not_read_is_never_overwritten(store, kind):
    entity, path = _indexed(store, kind)
    path.write_text(hand_broken("x"), encoding="utf-8")
    before = path.read_bytes()
    entity.title = "Aus der Oberflaeche"

    with pytest.raises(FileChanged) as caught:
        getattr(store, KINDS[kind][2])(entity)

    assert caught.value.file == f"{KINDS[kind][0]}/x.md"
    assert path.read_bytes() == before


@pytest.mark.parametrize("kind", sorted(KINDS))
def test_a_hand_edit_the_index_has_not_read_yet_is_never_overwritten(store, kind):
    entity, path = _indexed(store, kind)
    path.write_text(
        path.read_text(encoding="utf-8").replace("Alter Text", "Alter Text\n\nVon Hand ergaenzt."),
        encoding="utf-8",
    )
    before = path.read_bytes()
    entity.title = "Aus der Oberflaeche"

    with pytest.raises(FileChanged):
        getattr(store, KINDS[kind][2])(entity)
    assert path.read_bytes() == before

    # Once the indexer has read the edit, the write goes through on top of it.
    _, _, save, index, get = KINDS[kind]
    getattr(store, index)(path)
    entity = getattr(store, get)("x")
    entity.title = "Aus der Oberflaeche"
    getattr(store, save)(entity)
    text = path.read_text(encoding="utf-8")
    assert "Von Hand ergaenzt." in text and "Aus der Oberflaeche" in text


def test_an_unchanged_file_is_rewritten_as_before(store):
    idea, path = _indexed(store, "idea")
    idea.status = "developing"
    store.index_file(store.save_idea_file(idea))
    assert store.get_idea("x").status == "developing"
    idea = store.get_idea("x")
    idea.status = "parked"
    store.save_idea_file(idea)
    assert "status: parked" in path.read_text(encoding="utf-8")


def test_a_conflict_copy_indexed_under_the_id_never_overwrites_the_original(store):
    _, original = _indexed(store, "idea")
    before = original.read_bytes()
    copy = original.with_name("x (Konflikt).md")
    copy.write_text(original.read_text(encoding="utf-8").replace("Alter Text", "Andere Fassung"),
                    encoding="utf-8")
    store.index_file(copy)  # same frontmatter id: the copy is now the indexed one
    idea = store.get_idea("x")
    idea.status = "developing"

    with pytest.raises(FileChanged):
        store.save_idea_file(idea)
    assert original.read_bytes() == before


# --- a hand-named file is the file of its id (review 2026-10-18, A4) --------------
# The id comes from the frontmatter first (``id: x`` in ``Mein Entwurf.md``):
# the index reads that file under ``x``. An update rewrites the file it read —
# never a second ``x.md`` beside it — and refuses it when it is stale.

HAND_NAMED = "Mein Entwurf.md"


def _hand_named(store, kind: str):
    folder, make, _save, index, get = KINDS[kind]
    path = config.base_dir() / folder / HAND_NAMED
    path.write_text(make().to_markdown(), encoding="utf-8")  # frontmatter id: x
    getattr(store, index)(path)
    entity = getattr(store, get)("x")
    assert entity.path == str(path)
    return entity, path


@pytest.mark.parametrize("kind", sorted(KINDS))
def test_an_update_rewrites_the_hand_named_file_it_was_indexed_from(store, kind):
    folder, _make, save, index, get = KINDS[kind]
    entity, path = _hand_named(store, kind)
    entity.title = "Aus der Oberflaeche"

    written = getattr(store, save)(entity)

    assert written == path
    assert listing(folder) == {folder: [HAND_NAMED]}  # no second x.md
    getattr(store, index)(written)
    assert getattr(store, get)("x").title == "Aus der Oberflaeche"
    assert getattr(store, get)("x").path == str(path)


@pytest.mark.parametrize("kind", sorted(KINDS))
def test_a_stale_hand_named_file_is_refused(store, kind):
    folder, _make, save, _index, _get = KINDS[kind]
    entity, path = _hand_named(store, kind)
    path.write_text(hand_broken("x"), encoding="utf-8")
    before = path.read_bytes()
    entity.title = "Aus der Oberflaeche"

    with pytest.raises(FileChanged) as caught:
        getattr(store, save)(entity)
    with pytest.raises(FileChanged):
        store.ensure_current(LINK_KINDS[kind], entity)  # the same answer as the save

    assert caught.value.file == f"{folder}/{HAND_NAMED}"
    assert path.read_bytes() == before
    assert listing(folder) == {folder: [HAND_NAMED]}


@pytest.mark.parametrize("kind", sorted(KINDS))
def test_ensure_current_and_the_save_agree_on_a_current_hand_named_file(store, kind):
    entity, path = _hand_named(store, kind)
    store.ensure_current(LINK_KINDS[kind], entity)  # passes: it is what the index read
    getattr(store, KINDS[kind][2])(entity)
    assert path.exists()


def test_a_deleted_tombstone_skips_a_stale_file_and_converts_the_rest(store):
    for pid, cid in (("a", 1), ("b", 2)):
        store.index_publication_file(store.save_publication_file(
            Publication(id=pid, title=pid.upper(), collection_id=cid, kind="publication")))
    stale = config.publications_dir() / "a.md"
    stale.write_text(hand_broken("a"), encoding="utf-8")
    before = stale.read_bytes()

    class Deleted:
        available = True

        def get(self, cid):
            return {"id": cid, "name": f"S{cid}", "deleted": True}

        def refs(self, cid):
            return ["Smith2020"]

    assert reconcile_tombstones(store, Deleted()) == ["b"]
    assert stale.read_bytes() == before
    assert store.get_publication("b").collection_id is None


# --- HTTP: every update path answers 409 and writes nothing ------------------------

@pytest.fixture
def client(atlas_app, monkeypatch):
    monkeypatch.setattr(api_zettel, "_today", lambda: TODAY)
    monkeypatch.setattr(api_pipeline, "_today", lambda: TODAY)
    with atlas_app() as c:
        yield c


# name -> (folder, create request, update request)
UPDATES = {
    "edit idea": ("ideen", ("/ideas", {"title": "Kalibrierung"}),
                  ("PUT", "/ideas/{id}", {"status": "developing"})),
    "promote idea": ("ideen", ("/ideas", {"title": "Kalibrierung"}),
                     ("POST", "/ideas/{id}/promote", None)),
    "accept match": ("ideen", ("/ideas", {"title": "Kalibrierung"}),
                     ("POST", "/ideas/{id}/accept-match", {"citekey": "Doe2024", "reasoning": "passt"})),
    "edit chapter": ("dissertation", ("/diss", {"title": "Methodik"}),
                     ("PUT", "/diss/{id}", {"status": "in-progress"})),
    "edit project": ("projekte", ("/projects", {"title": "Vorhaben"}),
                     ("PUT", "/projects/{id}", {"status": "active"})),
    "toggle project checklist": ("projekte", ("/projects", {"title": "Vorhaben", "body": "- [ ] eins"}),
                                 ("POST", "/projects/{id}/toggle", {"index": 0})),
    "edit publication": ("veroeffentlichungen", ("/publications", {"title": "Beitrag"}),
                         ("PUT", "/publications/{id}", {"venue": "Journal"})),
    "add publication refs": ("veroeffentlichungen", ("/publications", {"title": "Beitrag"}),
                             ("POST", "/publications/{id}/refs", {"refs": ["Doe2024"]})),
    "change publication status": ("veroeffentlichungen", ("/publications", {"title": "Beitrag"}),
                                  ("POST", "/publications/{id}/status", {"status": "submitted"})),
    "edit zettel": ("zettel", ("/zettel", {"title": "Gespraech"}),
                    ("PUT", "/zettel/{id}", {"title": "Neu"})),
    "promote zettel": ("zettel", ("/zettel", {"title": "Gespraech"}),
                       ("POST", "/zettel/{id}/promote", None)),
}

FOLDERS = ("ideen", "dissertation", "projekte", "veroeffentlichungen", "zettel")


@pytest.mark.parametrize("name", sorted(UPDATES))
def test_no_update_puts_the_index_row_over_an_unreadable_hand_edit(client, name):
    folder, (create_url, create), (method, url, payload) = UPDATES[name]
    created = client.post(f"{API}{create_url}", json=create)
    assert created.status_code == 200, created.text
    entity_id = created.json()["id"]
    path = config.base_dir() / folder / f"{entity_id}.md"
    path.write_text(hand_broken(entity_id), encoding="utf-8")
    before, files = path.read_bytes(), listing(*FOLDERS)

    resp = client.request(method, API + url.format(id=entity_id), json=payload)

    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"] == {"code": CHANGED, "params": {"file": f"{folder}/{entity_id}.md"}}
    assert path.read_bytes() == before
    assert listing(*FOLDERS) == files  # a promote created nothing either


@pytest.fixture
def collections_client(atlas_app):
    library = InMemoryLibrary([], collections=[{"id": 1, "name": "Antrag Robotik", "refs": []}])
    with atlas_app(library=library) as c:
        yield c


@pytest.mark.parametrize("action", ["switch", "unplan"])
def test_a_collection_entry_with_an_unreadable_hand_edit_is_never_moved_or_frozen(
        collections_client, action):
    client = collections_client
    planned = client.post(f"{API}/collections/1/plan")
    assert planned.status_code == 200, planned.text
    entity_id = planned.json()["publication"]["id"]
    path = config.publications_dir() / f"{entity_id}.md"
    path.write_text(hand_broken(entity_id), encoding="utf-8")
    before, files = path.read_bytes(), listing(*FOLDERS)

    if action == "switch":
        resp = client.post(f"{API}/collections/1/switch", json={"to": "project"})
    else:
        resp = client.post(f"{API}/collections/1/unplan")

    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["code"] == CHANGED
    assert path.read_bytes() == before
    assert listing(*FOLDERS) == files
    assert Path(path).exists()


def _hand_named_entry(client) -> Path:
    """The Collection entry of Collection 1, its file named by hand."""
    path = config.publications_dir() / "Mein Antrag.md"
    path.write_text(
        "---\nschema: atlas.publication/2\nid: sammlung-1\ntitle: Antrag\n"
        "collection_id: 1\nkind: publication\n---\n\nVon Hand angelegt.\n", encoding="utf-8")
    assert client.post(f"{API}/reindex").status_code == 200
    return path


def test_the_type_switch_still_moves_a_hand_named_entry_into_the_other_folder(collections_client):
    client = collections_client
    path = _hand_named_entry(client)

    resp = client.post(f"{API}/collections/1/switch", json={"to": "project"})

    assert resp.status_code == 200, resp.text
    assert resp.json()["id"] == "sammlung-1"
    assert listing("veroeffentlichungen", "projekte") == {
        "veroeffentlichungen": [], "projekte": ["sammlung-1.md"],
    }
    assert not path.exists()
    assert "Von Hand angelegt." in (config.projects_dir() / "sammlung-1.md").read_text(encoding="utf-8")


def test_an_update_of_a_hand_named_entry_rewrites_it_in_place(collections_client):
    client = collections_client
    path = _hand_named_entry(client)

    resp = client.put(f"{API}/publications/sammlung-1", json={"venue": "Journal"})

    assert resp.status_code == 200, resp.text
    assert listing("veroeffentlichungen") == {"veroeffentlichungen": ["Mein Antrag.md"]}
    assert "venue: Journal" in path.read_text(encoding="utf-8")
