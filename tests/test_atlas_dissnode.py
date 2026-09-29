"""Atlas dissertation-chapter tests — domain, flattening migration /1|2 -> /3,
store, publication assignment (atlas.dissnode/3, ADR-0005, issue #57).

ADR-0005 retires the free tree (kind/parent, nesting): the dissertation is a
flat, ordered list of Kapitel. The startup migration flattens legacy trees
depth-first into ``order`` and drops kind/parent."""
from __future__ import annotations

import pytest

from atlas import config as atlas_config
from atlas import config
from atlas.domain import DissNode, diss_progress, new_idea, parse_frontmatter
from atlas.migration import migrate_legacy_dissnodes, plan_dissnode_migration
from atlas.store import AtlasStore


def _legacy_node_md(
    *, schema="atlas.dissnode/2", nid="p02", title="Paper 2", kind="paper-slot",
    parent="teil-2", order=2, status="planned", paper_ref=None, publications=None,
    body="",
) -> str:
    lines = [
        "---",
        f"schema: {schema}",
        f"id: {nid}",
        f"title: {title}",
        f"kind: {kind}",
        f"parent: {parent if parent is not None else 'null'}",
        f"order: {order}",
        f"status: {status}",
    ]
    if paper_ref is not None:
        lines.append(f"paper_ref: {paper_ref}")
    if publications:
        lines.append("publications:")
        lines.extend(f"- {p}" for p in publications)
    lines.append("---")
    return "\n".join(lines) + f"\n\n{body}"


# --- domain (atlas.dissnode/3) ------------------------------------------------

def test_dissnode_markdown_round_trip():
    node = DissNode(id="k02", title="Kapitel 2", order=2, status="in-progress",
                    publications=["fgc-paper", "review-2026"], body="Skizze")
    reparsed = DissNode.from_markdown(node.to_markdown())
    assert reparsed.to_frontmatter() == node.to_frontmatter()
    assert reparsed.publications == ["fgc-paper", "review-2026"]
    assert reparsed.body == "Skizze"


def test_dissnode_v3_frontmatter_drops_kind_and_parent():
    md = DissNode(id="k1", title="Kap 1", status="planned", order=0).to_markdown()
    assert "schema: atlas.dissnode/3" in md
    assert "kind" not in md
    assert "parent" not in md
    assert "publications" not in md  # optional empty omitted (round-trip stable)


def test_legacy_file_stays_readable_kind_and_parent_ignored():
    """/1|2 files parse tolerantly: title/order/status arrive, kind/parent and a
    /1 paper_ref are ignored (never carried into the /3 model)."""
    node = DissNode.from_markdown(
        _legacy_node_md(schema="atlas.dissnode/1", paper_ref="Smith2020",
                        publications=["da"], body="Skizze"),
        id_hint="p02",
    )
    assert node.id == "p02"
    assert node.title == "Paper 2"
    assert node.order == 2
    assert node.publications == ["da"]
    assert node.body == "Skizze"
    assert node.validate() == []
    fm = node.to_frontmatter()
    assert "kind" not in fm and "parent" not in fm and "paper_ref" not in fm


def test_dissnode_validate():
    assert DissNode(id="a", title="A", status="planned").validate() == []
    bad = DissNode(id="a", title="", status="nope")
    errs = bad.validate()
    assert any("title" in e for e in errs)
    assert any("status" in e for e in errs)


def test_diss_progress_summarises_chapters():
    nodes = [
        DissNode(id="a", title="A", order=0, status="planned", body="Inhalt"),
        DissNode(id="b", title="B", order=1, status="in-progress", publications=["p"]),
        DissNode(id="c", title="C", order=2, status="planned"),
    ]
    progress = diss_progress(nodes)
    assert progress["total"] == 3
    assert progress["with_body"] == 1
    assert progress["with_publications"] == 1
    assert progress["by_status"] == {"planned": 2, "in-progress": 1}


# --- migration planner (pure) -------------------------------------------------

def test_plan_flattens_tree_depth_first_and_drops_kind_parent():
    # Tree:  teil-1 (order 0)
    #          ├ k1 (order 0)  ─ s1 (order 0)
    #          └ k2 (order 1)
    #        teil-2 (order 1)
    files = [
        ("teil-1.md", _legacy_node_md(nid="teil-1", title="Teil 1", kind="part",
                                      parent=None, order=0)),
        ("teil-2.md", _legacy_node_md(nid="teil-2", title="Teil 2", kind="part",
                                      parent=None, order=1)),
        ("k1.md", _legacy_node_md(nid="k1", title="Kap 1", kind="chapter",
                                  parent="teil-1", order=0)),
        ("k2.md", _legacy_node_md(nid="k2", title="Kap 2", kind="chapter",
                                  parent="teil-1", order=1)),
        ("s1.md", _legacy_node_md(nid="s1", title="Abschnitt 1", kind="section",
                                  parent="k1", order=0)),
    ]
    plan = plan_dissnode_migration(files)
    # depth-first pre-order: teil-1, k1, s1, k2, teil-2
    assert [a.name for a in plan.actions] == [
        "teil-1.md", "k1.md", "s1.md", "k2.md", "teil-2.md"
    ]
    assert [a.order for a in plan.actions] == [0, 1, 2, 3, 4]
    for action in plan.actions:
        node = DissNode.from_markdown(action.content)
        assert node.validate() == []
        fm, _ = parse_frontmatter(action.content)
        assert fm["schema"] == "atlas.dissnode/3"
        assert "kind" not in fm and "parent" not in fm
    # the kind/parent that were dropped are reported for visibility
    assert plan.actions[0].dropped_kind == "part"
    assert plan.actions[1].dropped_parent == "teil-1"


def test_plan_carries_publications_and_preserves_paper_ref_note():
    files = [
        ("k1.md", _legacy_node_md(schema="atlas.dissnode/2", nid="k1", kind="chapter",
                                  parent=None, order=0, publications=["fgc-paper"],
                                  body="Body")),
        ("p02.md", _legacy_node_md(schema="atlas.dissnode/1", nid="p02", kind="paper-slot",
                                   parent=None, order=1, paper_ref="Smith2020")),
    ]
    plan = plan_dissnode_migration(files)
    k1 = DissNode.from_markdown(plan.actions[0].content)
    assert k1.publications == ["fgc-paper"]
    p02 = DissNode.from_markdown(plan.actions[1].content)
    assert p02.publications == []  # paper_ref is never auto-converted
    assert "Smith2020" in p02.body and "Migrationshinweis" in p02.body
    assert plan.paper_refs == [{"file": "p02.md", "id": "p02", "paper_ref": "Smith2020"}]


def test_plan_orphan_parent_becomes_root():
    files = [
        ("x.md", _legacy_node_md(nid="x", kind="chapter", parent="ghost", order=0)),
    ]
    plan = plan_dissnode_migration(files)
    assert [a.name for a in plan.actions] == ["x.md"]
    assert plan.actions[0].order == 0


def test_plan_skips_non_legacy_and_unreadable_files():
    v3 = DissNode(id="neu", title="Neu", status="planned", order=0).to_markdown()
    plan = plan_dissnode_migration(
        [("neu.md", v3), ("kaputt.md", "---\n{ kein: [yaml\n---\nx\n")]
    )
    assert plan.empty
    assert sorted(plan.skipped) == ["kaputt.md", "neu.md"]
    assert any("kaputt.md" in w for w in plan.warnings)


# --- migration executor (temp dir) --------------------------------------------

@pytest.fixture
def atlas_dir(tmp_path, monkeypatch):
    base = tmp_path / "atlas"
    monkeypatch.setattr(atlas_config, "_base_dir", str(base))
    config.ensure_dirs()
    return base


def _backups(base):
    return sorted(base.parent.glob(f"{base.name}-backup-*"))


def test_executor_flattens_backs_up_drops_kind_and_is_idempotent(atlas_dir):
    diss = atlas_dir / "dissertation"
    (diss / "teil-1.md").write_text(
        _legacy_node_md(nid="teil-1", title="Teil 1", kind="part", parent=None, order=0),
        encoding="utf-8",
    )
    (diss / "k1.md").write_text(
        _legacy_node_md(nid="k1", title="Kap 1", kind="chapter", parent="teil-1", order=0),
        encoding="utf-8",
    )

    report = migrate_legacy_dissnodes()
    assert report["migrated"] == 2
    assert [m["file"] for m in report["mappings"]] == ["teil-1.md", "k1.md"]
    assert [m["order"] for m in report["mappings"]] == [0, 1]

    # backup taken before the write: it still holds the legacy /2 originals
    backups = _backups(atlas_dir)
    assert len(backups) == 1
    assert report["backup"] == str(backups[0])
    backed_up = (backups[0] / "dissertation" / "teil-1.md").read_text(encoding="utf-8")
    assert "schema: atlas.dissnode/2" in backed_up
    assert "kind: part" in backed_up

    # rewritten in place (id stays), kind/parent gone, flattened order
    migrated = DissNode.from_file(diss / "k1.md")
    assert migrated.validate() == [] and migrated.id == "k1" and migrated.order == 1
    fm, _ = parse_frontmatter((diss / "teil-1.md").read_text(encoding="utf-8"))
    assert fm["schema"] == "atlas.dissnode/3"
    assert "kind" not in fm and "parent" not in fm

    # second run: empty plan, no write, no second backup
    second = migrate_legacy_dissnodes()
    assert second["migrated"] == 0
    assert second["backup"] is None
    assert len(_backups(atlas_dir)) == 1


def test_executor_without_legacy_files_takes_no_backup(atlas_dir):
    report = migrate_legacy_dissnodes()
    assert report["migrated"] == 0
    assert report["backup"] is None
    assert _backups(atlas_dir) == []


# --- store --------------------------------------------------------------------

@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(atlas_config, "_base_dir", str(tmp_path))
    config.ensure_dirs()
    return AtlasStore()


def test_index_and_get_node(store):
    node = DissNode(id="k01", title="Kapitel 1", order=0, status="planned",
                    publications=["fgc-paper"])
    store.index_node(node)
    loaded = store.get_node("k01")
    assert loaded is not None and loaded.title == "Kapitel 1"
    assert loaded.publications == ["fgc-paper"]


def test_reindex_lists_chapters_in_order(store):
    store.save_node_file(DissNode(id="k02", title="Kap 2", order=1, status="planned"))
    store.save_node_file(DissNode(id="k01", title="Kap 1", order=0, status="planned"))
    stats = store.reindex()
    assert stats["nodes_indexed"] == 2
    chapters, progress = store.diss_chapters()
    assert [c.id for c in chapters] == ["k01", "k02"]
    assert progress["total"] == 2


def test_node_links_from_idea_diss(store):
    idea = new_idea("Idee A"); idea.diss = ["k01"]; store.index_idea(idea)
    linked = store.node_links("k01")
    assert [i.id for i in linked] == [idea.id]


def test_index_path_routes_by_folder(store):
    node_path = store.save_node_file(DissNode(id="kx", title="KX", status="planned"))
    idea = new_idea("Idee Y")
    idea_path = store.save_idea_file(idea)
    store.index_path(node_path)
    store.index_path(idea_path)
    assert store.get_node("kx") is not None
    assert store.get_idea(idea.id) is not None


def test_check_reports_hanging_publication_link(store):
    from atlas.domain import Publication

    store.save_publication_file(Publication(id="da", title="Da", status="planned"))
    store.save_node_file(DissNode(id="k1", title="K1", status="planned",
                                  publications=["da", "weg"]))
    store.reindex()
    report = store.check()
    issues = {entry["id"]: entry["issues"] for entry in report}
    # only the missing id is flagged; the resolvable one stays silent
    assert issues.get("k1") == [
        "haengender publications-Verweis (keine Veroeffentlichung): weg"
    ]


def test_diss_publication_issues_warn_only_for_missing(store):
    from atlas.domain import Publication

    store.save_publication_file(Publication(id="da", title="Da", status="planned"))
    store.save_node_file(DissNode(id="k1", title="K1", status="planned",
                                  publications=["da", "weg"]))
    store.reindex()
    issues = store.diss_publication_issues()
    assert len(issues) == 1
    assert issues[0]["id"] == "k1" and "weg" in issues[0]["issue"]


# --- API: assignment endpoint + warnings (TestClient) -------------------------

def test_assign_publication_to_node(atlas_client, tmp_path):
    pub = atlas_client.post("/api/plugins/atlas/publications", json={"title": "FGC Paper"}).json()
    node = atlas_client.post("/api/plugins/atlas/diss", json={"title": "Kapitel 3"}).json()

    res = atlas_client.post(
        f"/api/plugins/atlas/diss/{node['id']}/publications",
        json={"publication_id": pub["id"]},
    )
    assert res.status_code == 200
    assert res.json()["publications"] == [
        {"id": pub["id"], "found": True, "title": "FGC Paper", "status": "planned"}
    ]

    # the link lives in the node's Markdown file (P1)
    md = (tmp_path / "dissertation" / f"{node['id']}.md").read_text(encoding="utf-8")
    assert pub["id"] in md and "publications" in md

    # assigning again is a no-op (deduplicated)
    again = atlas_client.post(
        f"/api/plugins/atlas/diss/{node['id']}/publications",
        json={"publication_id": pub["id"]},
    ).json()
    assert [p["id"] for p in again["publications"]] == [pub["id"]]

    detail = atlas_client.get(f"/api/plugins/atlas/diss/{node['id']}").json()
    assert detail["publications"] == [pub["id"]]
    assert detail["publications_resolved"][0]["found"] is True


def test_assign_rejects_unknown_node_and_publication(atlas_client):
    node = atlas_client.post("/api/plugins/atlas/diss", json={"title": "Kapitel"}).json()
    assert atlas_client.post(
        "/api/plugins/atlas/diss/nope/publications", json={"publication_id": "x"}
    ).status_code == 404
    # hanging links are never created by the assignment action
    assert atlas_client.post(
        f"/api/plugins/atlas/diss/{node['id']}/publications", json={"publication_id": "gibt-es-nicht"}
    ).status_code == 404


def test_unassign_publication_from_node(atlas_client):
    pub = atlas_client.post("/api/plugins/atlas/publications", json={"title": "Weg damit"}).json()
    node = atlas_client.post("/api/plugins/atlas/diss", json={"title": "Kapitel"}).json()
    atlas_client.post(
        f"/api/plugins/atlas/diss/{node['id']}/publications", json={"publication_id": pub["id"]}
    )

    res = atlas_client.delete(f"/api/plugins/atlas/diss/{node['id']}/publications/{pub['id']}")
    assert res.status_code == 200
    assert res.json()["publications"] == []
    assert atlas_client.get(f"/api/plugins/atlas/diss/{node['id']}").json()["publications"] == []

    # not linked (anymore) -> 404
    assert atlas_client.delete(
        f"/api/plugins/atlas/diss/{node['id']}/publications/{pub['id']}"
    ).status_code == 404


def test_hanging_publication_shows_as_warning_never_repaired(atlas_client, tmp_path):
    pub = atlas_client.post("/api/plugins/atlas/publications", json={"title": "Fluechtig"}).json()
    node = atlas_client.post("/api/plugins/atlas/diss", json={"title": "Kapitel"}).json()
    atlas_client.post(
        f"/api/plugins/atlas/diss/{node['id']}/publications", json={"publication_id": pub["id"]}
    )
    atlas_client.delete(f"/api/plugins/atlas/publications/{pub['id']}")

    # the hanging link surfaces as a warning on the outline
    data = atlas_client.get("/api/plugins/atlas/diss").json()
    assert any(
        i["id"] == node["id"] and pub["id"] in i["issue"]
        and "haengender publications-Verweis" in i["issue"]
        for i in data["issues"]
    )
    # node detail keeps the link visible (found=False) — never auto-repaired
    detail = atlas_client.get(f"/api/plugins/atlas/diss/{node['id']}").json()
    assert detail["publications"] == [pub["id"]]
    assert detail["publications_resolved"] == [
        {"id": pub["id"], "found": False, "title": pub["id"], "status": None}
    ]
    md = (tmp_path / "dissertation" / f"{node['id']}.md").read_text(encoding="utf-8")
    assert pub["id"] in md


def test_reorder_chapters_via_put_order(atlas_client):
    """PUT /api/plugins/atlas/diss/{id} with a new order value persists the change and
    GET /api/plugins/atlas/diss returns chapters re-sorted (ADR-0005, issue #62)."""
    a = atlas_client.post("/api/plugins/atlas/diss", json={"title": "Kapitel A"}).json()
    b = atlas_client.post("/api/plugins/atlas/diss", json={"title": "Kapitel B"}).json()

    # Initial order: A (order=0), B (order=1)
    data = atlas_client.get("/api/plugins/atlas/diss").json()
    ids = [c["id"] for c in data["chapters"]]
    assert ids.index(a["id"]) < ids.index(b["id"])

    # Swap: give A order=1, B order=0
    r1 = atlas_client.put(f"/api/plugins/atlas/diss/{a['id']}", json={"order": 1})
    assert r1.status_code == 200
    r2 = atlas_client.put(f"/api/plugins/atlas/diss/{b['id']}", json={"order": 0})
    assert r2.status_code == 200

    # After swap: B comes first
    data2 = atlas_client.get("/api/plugins/atlas/diss").json()
    ids2 = [c["id"] for c in data2["chapters"]]
    assert ids2.index(b["id"]) < ids2.index(a["id"])

    # The new order values are persisted to the Markdown files (P1)
    outline_orders = {c["id"]: c["order"] for c in data2["chapters"]}
    assert outline_orders[b["id"]] == 0
    assert outline_orders[a["id"]] == 1


def test_startup_flattens_legacy_dissnodes_to_v3(atlas_app, tmp_path, monkeypatch):
    base = tmp_path / "atlas"
    monkeypatch.setattr(atlas_config, "_base_dir", str(base))
    diss = base / "dissertation"
    diss.mkdir(parents=True)
    (diss / "teil-1.md").write_text(
        _legacy_node_md(nid="teil-1", title="Teil 1", kind="part", parent=None, order=0),
        encoding="utf-8",
    )
    (diss / "p02.md").write_text(
        _legacy_node_md(schema="atlas.dissnode/1", nid="p02", title="Paper 2",
                        kind="paper-slot", parent="teil-1", order=0, paper_ref="Smith2020"),
        encoding="utf-8",
    )

    with atlas_app(base) as client:
        data = client.get("/api/plugins/atlas/diss").json()
        # flattened depth-first: teil-1 (order 0), p02 (order 1)
        assert [c["id"] for c in data["chapters"]] == ["teil-1", "p02"]
        assert [c["order"] for c in data["chapters"]] == [0, 1]
        detail = client.get("/api/plugins/atlas/diss/p02").json()
        assert detail["publications"] == []          # never auto-converted
        assert "Smith2020" in detail["body"]         # manual-rehang note survives
        assert detail["errors"] == []                # valid /3 after migration

    assert "schema: atlas.dissnode/3" in (diss / "p02.md").read_text(encoding="utf-8")
    assert len(sorted(base.parent.glob(f"{base.name}-backup-*"))) == 1

    # restart: idempotent — no second backup
    with atlas_app(base) as client:
        assert client.get("/api/plugins/atlas/diss/p02").status_code == 200
    assert len(sorted(base.parent.glob(f"{base.name}-backup-*"))) == 1


# --- API: chapter delete endpoints (issue #63) --------------------------------

def test_delete_chapter_success(atlas_client, tmp_path):
    """DELETE /api/plugins/atlas/diss/{id} removes the chapter file and the index row;
    the chapter no longer appears in GET /api/plugins/atlas/diss afterwards."""
    node = atlas_client.post("/api/plugins/atlas/diss", json={"title": "Zu löschendes Kapitel"}).json()
    node_id = node["id"]
    md_path = tmp_path / "dissertation" / f"{node_id}.md"
    assert md_path.exists()

    res = atlas_client.delete(f"/api/plugins/atlas/diss/{node_id}")
    assert res.status_code == 200
    assert res.json()["deleted"] == node_id

    # file is gone
    assert not md_path.exists()
    # not in the chapter list anymore
    data = atlas_client.get("/api/plugins/atlas/diss").json()
    assert not any(c["id"] == node_id for c in data["chapters"])
    # GET detail returns 404
    assert atlas_client.get(f"/api/plugins/atlas/diss/{node_id}").status_code == 404


def test_delete_chapter_not_found(atlas_client):
    """DELETE /api/plugins/atlas/diss/{id} with an unknown id returns 404."""
    res = atlas_client.delete("/api/plugins/atlas/diss/gibt-es-nicht")
    assert res.status_code == 404


def test_delete_all_chapters(atlas_client, tmp_path):
    """DELETE /api/plugins/atlas/diss removes all chapter files and clears the index;
    GET /api/plugins/atlas/diss returns an empty chapter list afterwards."""
    a = atlas_client.post("/api/plugins/atlas/diss", json={"title": "Kapitel A"}).json()
    b = atlas_client.post("/api/plugins/atlas/diss", json={"title": "Kapitel B"}).json()
    assert (tmp_path / "dissertation" / f"{a['id']}.md").exists()
    assert (tmp_path / "dissertation" / f"{b['id']}.md").exists()

    res = atlas_client.delete("/api/plugins/atlas/diss")
    assert res.status_code == 200
    assert res.json()["deleted"] == 2

    # all files gone
    assert not (tmp_path / "dissertation" / f"{a['id']}.md").exists()
    assert not (tmp_path / "dissertation" / f"{b['id']}.md").exists()
    # index is empty
    data = atlas_client.get("/api/plugins/atlas/diss").json()
    assert data["chapters"] == []


def test_delete_all_chapters_empty_outline(atlas_client):
    """DELETE /api/plugins/atlas/diss on an already-empty outline returns 200 with deleted=0."""
    res = atlas_client.delete("/api/plugins/atlas/diss")
    assert res.status_code == 200
    assert res.json()["deleted"] == 0


# --- API: chapter-hub Kennzahlen (issue #180, slice 5, story 51/52) -----------

def test_chapter_metrics_count_zettel_open_tasks_and_merge_refs(atlas_client):
    """The chapter's own literature (its assigned Publications' ``refs``)
    merges with the ``refs`` of every Zettel linking to it into one distinct
    list; ``zettel_count``/``open_task_count`` come from the same edges a
    done Task does not count toward ``open_task_count``."""
    node = atlas_client.post("/api/plugins/atlas/diss", json={"title": "Kapitel Metrik"}).json()
    pub = atlas_client.post(
        "/api/plugins/atlas/publications", json={"title": "Pub", "refs": ["a", "b"]}
    ).json()
    atlas_client.post(
        f"/api/plugins/atlas/diss/{node['id']}/publications",
        json={"publication_id": pub["id"]},
    )
    zettel = atlas_client.post(
        "/api/plugins/atlas/zettel",
        json={"title": "Notiz", "refs": ["b", "c"], "body": f"Bezug [[{node['id']}]]"},
    ).json()
    week = "2026-W39"  # Mo 2026-09-21 .. So 2026-09-27
    day = "2026-09-21"
    atlas_client.post(
        f"/api/plugins/atlas/journal/{week}/tasks",
        json={"day": day, "text": f"Offen [[{node['id']}]]"},
    )
    done = atlas_client.post(
        f"/api/plugins/atlas/journal/{week}/tasks",
        json={"day": day, "text": f"Erledigt [[{node['id']}]]"},
    ).json()
    atlas_client.post(
        f"/api/plugins/atlas/journal/{week}/tasks/{done['body_index']}/toggle"
    )

    detail = atlas_client.get(f"/api/plugins/atlas/diss/{node['id']}").json()
    assert detail["zettel_count"] == 1
    assert detail["open_task_count"] == 1
    assert detail["ref_count"] == 3
    assert detail["refs_all"] == ["a", "b", "c"]
    assert detail["modified_at"] is not None


def test_chapter_metrics_are_zero_for_a_fresh_chapter(atlas_client):
    node = atlas_client.post("/api/plugins/atlas/diss", json={"title": "Frisches Kapitel"}).json()
    detail = atlas_client.get(f"/api/plugins/atlas/diss/{node['id']}").json()
    assert detail["zettel_count"] == 0
    assert detail["open_task_count"] == 0
    assert detail["ref_count"] == 0
    assert detail["refs_all"] == []
    assert detail["modified_at"] is not None
