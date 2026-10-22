"""Atlas store — the derived ``atlas.db`` index over the Markdown archive.

There is exactly **one** writer into the DB: the indexer here. The UI writes a
Markdown file; the watcher (later slice) calls ``index_file``; the index
updates; the UI reads back from the DB (Abschn. 6). External edits and UI edits
are therefore the same code path. The DB holds only derived data and can be
rebuilt from the files at any time (P1, ``reindex``).

Imports only stdlib + Atlas submodules — never the LocalBib core (P3).
"""

from __future__ import annotations

import functools
import json
import sqlite3
import threading
from contextlib import closing
from pathlib import Path
from typing import Optional

from atlas import collection_entries, config, documents, entity_store, index_links, journal_store
from atlas.domain import (
    DissNode,
    Idea,
    Project,
    Publication,
    diss_progress,
    normalize_milestone,
)
from atlas.journal import Journal
from atlas.links import cites, extract_wikilinks
from atlas.zettel import Zettel

_SCHEMA = """
CREATE TABLE IF NOT EXISTS ideas (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL DEFAULT '',
    type         TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT '',
    tags         TEXT NOT NULL DEFAULT '[]',
    refs         TEXT NOT NULL DEFAULT '[]',
    diss         TEXT NOT NULL DEFAULT '[]',
    venue        TEXT,
    created      TEXT,
    updated      TEXT,
    body         TEXT NOT NULL DEFAULT '',
    path         TEXT,
    content_hash TEXT NOT NULL DEFAULT '',
    valid        INTEGER NOT NULL DEFAULT 1,
    errors       TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS idea_anchors (
    idea_id TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
    anchor  TEXT NOT NULL,
    ord     INTEGER NOT NULL,
    PRIMARY KEY (idea_id, anchor)
);

CREATE TABLE IF NOT EXISTS diss_nodes (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL DEFAULT '',
    "order"      INTEGER NOT NULL DEFAULT 0,
    status       TEXT NOT NULL DEFAULT '',
    publications TEXT NOT NULL DEFAULT '[]',
    body         TEXT NOT NULL DEFAULT '',
    path         TEXT,
    content_hash TEXT NOT NULL DEFAULT '',
    valid        INTEGER NOT NULL DEFAULT 1,
    errors       TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS idea_embeddings (
    idea_id      TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    vector       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT '',
    start        TEXT,
    "end"        TEXT,
    funder       TEXT,
    grant_id     TEXT,
    role         TEXT,
    tags         TEXT NOT NULL DEFAULT '[]',
    refs         TEXT NOT NULL DEFAULT '[]',
    milestones   TEXT NOT NULL DEFAULT '[]',
    history      TEXT NOT NULL DEFAULT '[]',
    collection_id INTEGER,
    kind         TEXT,
    body         TEXT NOT NULL DEFAULT '',
    path         TEXT,
    content_hash TEXT NOT NULL DEFAULT '',
    valid        INTEGER NOT NULL DEFAULT 1,
    errors       TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS publications (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT '',
    venue        TEXT,
    type         TEXT,
    authors      TEXT NOT NULL DEFAULT '[]',
    submitted    TEXT,
    published    TEXT,
    due          TEXT,
    tags         TEXT NOT NULL DEFAULT '[]',
    refs         TEXT NOT NULL DEFAULT '[]',
    derived_from TEXT NOT NULL DEFAULT '[]',
    manuscripts  TEXT NOT NULL DEFAULT '[]',
    projects     TEXT NOT NULL DEFAULT '[]',
    paper        TEXT,
    history      TEXT NOT NULL DEFAULT '[]',
    collection_id INTEGER,
    kind         TEXT,
    body         TEXT NOT NULL DEFAULT '',
    path         TEXT,
    content_hash TEXT NOT NULL DEFAULT '',
    valid        INTEGER NOT NULL DEFAULT 1,
    errors       TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS zettel (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL DEFAULT '',
    type         TEXT NOT NULL DEFAULT '',
    date         TEXT,
    refs         TEXT NOT NULL DEFAULT '[]',
    tags         TEXT NOT NULL DEFAULT '[]',
    promoted_to  TEXT,
    body         TEXT NOT NULL DEFAULT '',
    path         TEXT,
    content_hash TEXT NOT NULL DEFAULT '',
    valid        INTEGER NOT NULL DEFAULT 1,
    errors       TEXT NOT NULL DEFAULT '[]'
);
""" + index_links.LINKS_DDL + journal_store.JOURNAL_DDL


def _serialized(method):
    """Run a store method under the store's write lock.

    Two threads write the index: a request (save the file, then index it) and
    the watcher (read the file, then index it). Without a common lock the
    watcher can read the file while it is being rewritten, or read an older
    version and commit it after the request's newer index — a stale index. Every
    file write and every read-and-index of the store takes this lock, so each
    one sees a whole file and the last one to run reads the newest content."""

    @functools.wraps(method)
    def wrapper(self, *args, **kwargs):
        with self._write_lock:
            return method(self, *args, **kwargs)

    return wrapper


class AtlasStore:
    def __init__(self, db_path=None) -> None:
        self._write_lock = threading.RLock()
        # The core's Collections (ADR-0022) — overlaid at read time, never
        # indexed. None: no overlay (no library, or a host before contract 2.1).
        self._collections: Optional[collection_entries.CollectionSource] = None
        self.db_path = Path(db_path) if db_path else config.db_path()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as conn:
            # atlas.project/3 (ADR-0004) reshapes the projects table. The DB is
            # a derived index (P1), so an old layout is simply dropped and the
            # reindex after activation rebuilds it from the Markdown files.
            columns = {
                row["name"]
                for row in conn.execute("PRAGMA table_info(projects)").fetchall()
            }
            # atlas.project/4 + atlas.publication/2 (ADR-0022) add the
            # Collection link columns, project/5 + publication/3 the Verlauf
            # (history) — same rule: drop, reindex rebuilds.
            if columns and not {"milestones", "collection_id", "history"} <= columns:
                conn.execute("DROP TABLE projects")
            pub_columns = {
                row["name"]
                for row in conn.execute("PRAGMA table_info(publications)").fetchall()
            }
            if pub_columns and not {"collection_id", "history"} <= pub_columns:
                conn.execute("DROP TABLE publications")
            # atlas.dissnode/3 (issue #57, ADR-0005) flattens diss_nodes: kind
            # and parent are gone. Derived index — drop the old layout and let
            # the reindex rebuild it from the Markdown files.
            node_columns = {
                row["name"]
                for row in conn.execute("PRAGMA table_info(diss_nodes)").fetchall()
            }
            if node_columns and (
                "kind" in node_columns
                or "parent" in node_columns
                or "publications" not in node_columns
            ):
                conn.execute("DROP TABLE diss_nodes")
            conn.executescript(_SCHEMA)
            conn.commit()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    # --- write path (indexer only) -----------------------------------------
    def index_idea(self, idea: Idea) -> None:
        errors = idea.validate()
        with closing(self._connect()) as conn:
            conn.execute(
                """INSERT INTO ideas
                   (id, title, type, status, tags, refs, diss, venue, created,
                    updated, body, path, content_hash, valid, errors)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(id) DO UPDATE SET
                     title=excluded.title, type=excluded.type, status=excluded.status,
                     tags=excluded.tags, refs=excluded.refs, diss=excluded.diss,
                     venue=excluded.venue, created=excluded.created,
                     updated=excluded.updated, body=excluded.body, path=excluded.path,
                     content_hash=excluded.content_hash, valid=excluded.valid,
                     errors=excluded.errors""",
                (
                    idea.id, idea.title, idea.type, idea.status,
                    json.dumps(idea.tags), json.dumps(idea.refs), json.dumps(idea.diss),
                    idea.venue, idea.created, idea.updated, idea.body, idea.path,
                    idea.content_hash, 0 if errors else 1, json.dumps(errors),
                ),
            )
            conn.execute("DELETE FROM idea_anchors WHERE idea_id = ?", (idea.id,))
            conn.executemany(
                "INSERT INTO idea_anchors (idea_id, anchor, ord) VALUES (?,?,?)",
                [(idea.id, anchor, i) for i, anchor in enumerate(idea.anchors)],
            )
            _index_body_links(conn, index_links.KIND_IDEA, idea.id, idea.body)
            conn.commit()

    @_serialized
    def index_file(self, path) -> Idea:
        return entity_store.index_file(_IDEA_SPEC, self, path)

    def remove_id(self, idea_id: str) -> None:
        self._delete_entity(_IDEA_SPEC, index_links.KIND_IDEA, idea_id)

    def _delete_entity(self, spec, kind: str, entity_id: str) -> None:
        """Delete one entity row **and** its outgoing Verweise (ADR-0020:
        removing a source removes its edges; inbound ones become warnings)."""
        with closing(self._connect()) as conn:
            index_links.delete_edges(conn, kind, entity_id)
            conn.commit()
        entity_store.delete_by_id(self._connect, spec, entity_id)

    @_serialized
    def remove_path(self, path) -> None:
        with closing(self._connect()) as conn:
            for kind, table in _PATH_TABLES:
                rows = conn.execute(
                    f"SELECT id FROM {table} WHERE path = ?", (str(path),)
                ).fetchall()
                for row in rows:
                    index_links.delete_edges(conn, kind, row["id"])
                conn.execute(f"DELETE FROM {table} WHERE path = ?", (str(path),))
            journal_store.remove_path(conn, path)
            conn.commit()

    @_serialized
    def index_path(self, path) -> None:
        """Route a changed file to the right index by its folder (watcher entry).
        Exact-parent matching means files in subfolders — e.g. project documents
        in projekte/<id>/ (issue #49) — are never indexed."""
        p = Path(path)
        parent = p.parent
        if parent == config.ideas_dir():
            self.index_file(p)
        elif parent == config.diss_dir():
            self.index_diss_file(p)
        elif parent == config.projects_dir():
            self.index_project_file(p)
        elif parent == config.publications_dir():
            self.index_publication_file(p)
        elif parent == config.zettel_dir():
            self.index_zettel_file(p)
        elif parent == config.journal_dir():
            self.index_journal_file(p)

    # --- reads --------------------------------------------------------------
    def get_idea(self, idea_id: str) -> Optional[Idea]:
        return entity_store.get_by_id(self._connect, _IDEA_SPEC, idea_id)

    def list_ideas(self) -> list[Idea]:
        return entity_store.list_all(self._connect, _IDEA_SPEC)

    def links_for(self, citekey: str) -> list[Idea]:
        """Ideas that reference ``citekey`` (backward resolution for the library
        reference panel, Abschn. 7). Exact citekey match against each idea's
        refs or a ``[@key]`` in its body (ADR-0026). refs are stored as a
        JSON array, so we filter in Python."""
        if not citekey:
            return []
        return [i for i in self.list_ideas() if citekey in i.refs or cites(i.body, citekey)]

    def nodes_for_citekey(self, citekey: str) -> list[DissNode]:
        """Chapters whose Skizze cites ``citekey`` as ``[@key]`` (ADR-0026)."""
        return [n for n in self.list_nodes() if cites(n.body, citekey)]

    # --- dissertation nodes -------------------------------------------------
    def index_node(self, node: DissNode) -> None:
        errors = node.validate()
        with closing(self._connect()) as conn:
            conn.execute(
                """INSERT INTO diss_nodes
                   (id, title, "order", status, publications, body, path,
                    content_hash, valid, errors)
                   VALUES (?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(id) DO UPDATE SET
                     title=excluded.title,
                     "order"=excluded."order", status=excluded.status,
                     publications=excluded.publications, body=excluded.body,
                     path=excluded.path,
                     content_hash=excluded.content_hash, valid=excluded.valid,
                     errors=excluded.errors""",
                (
                    node.id, node.title, node.order, node.status,
                    json.dumps(node.publications), node.body, node.path,
                    node.content_hash,
                    0 if errors else 1, json.dumps(errors),
                ),
            )
            _index_body_links(conn, index_links.KIND_DISS_NODE, node.id, node.body)
            conn.commit()

    @_serialized
    def index_diss_file(self, path) -> DissNode:
        return entity_store.index_file(_DISS_SPEC, self, path)

    def get_node(self, node_id: str) -> Optional[DissNode]:
        return entity_store.get_by_id(self._connect, _DISS_SPEC, node_id)

    def list_nodes(self) -> list[DissNode]:
        return entity_store.list_all(self._connect, _DISS_SPEC)

    def diss_chapters(self) -> tuple[list[DissNode], dict]:
        """(chapters, progress) — the flat, ordered chapter list (atlas.dissnode/3,
        ADR-0005) plus the progress summary for the page header."""
        chapters = self.list_nodes()
        return chapters, diss_progress(chapters)

    def diss_publication_issues(self) -> list[dict]:
        """Hanging publication links on dissertation nodes (atlas.dissnode/2,
        issue #53), same shape as the tree issues ({id, issue}). Warnings
        only — never auto-repaired (Abschn. 4.4)."""
        publication_ids = {p.id for p in self.list_publications()}
        issues: list[dict] = []
        for node in self.list_nodes():
            for pub_id in node.publications:
                if pub_id not in publication_ids:
                    issues.append({
                        "id": node.id,
                        "issue": (
                            "haengender publications-Verweis"
                            f" (keine Veroeffentlichung): {pub_id}"
                        ),
                    })
        return issues

    def node_links(self, node_id: str) -> list[Idea]:
        """Ideas that feed into this dissertation node (via their ``diss`` field)."""
        if not node_id:
            return []
        return [idea for idea in self.list_ideas() if node_id in idea.diss]

    @_serialized
    def save_node_file(self, node: DissNode) -> Path:
        return entity_store.save_file(_DISS_SPEC, node, self._connect)

    def delete_node(self, node_id: str) -> None:
        self._delete_entity(_DISS_SPEC, index_links.KIND_DISS_NODE, node_id)

    def delete_all_nodes(self) -> None:
        with closing(self._connect()) as conn:
            conn.execute("DELETE FROM diss_nodes")
            conn.execute(
                "DELETE FROM links WHERE from_kind = ?", (index_links.KIND_DISS_NODE,)
            )
            conn.commit()

    # --- research projects (atlas.project/3, ADR-0004) -----------------------
    def index_project(self, project: Project) -> None:
        errors = project.validate()
        with closing(self._connect()) as conn:
            conn.execute(
                """INSERT INTO projects
                   (id, title, status, start, "end", funder, grant_id, role,
                    tags, refs, milestones, history, collection_id, kind, body, path,
                    content_hash, valid, errors)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(id) DO UPDATE SET
                     title=excluded.title, status=excluded.status,
                     start=excluded.start, "end"=excluded."end",
                     funder=excluded.funder, grant_id=excluded.grant_id,
                     role=excluded.role, tags=excluded.tags, refs=excluded.refs,
                     milestones=excluded.milestones, history=excluded.history,
                     collection_id=excluded.collection_id, kind=excluded.kind,
                     body=excluded.body, path=excluded.path,
                     content_hash=excluded.content_hash, valid=excluded.valid,
                     errors=excluded.errors""",
                (
                    project.id, project.title, project.status,
                    project.start, project.end, project.funder,
                    project.grant_id, project.role,
                    json.dumps(project.tags), json.dumps(project.refs),
                    json.dumps([normalize_milestone(m) for m in project.milestones]),
                    json.dumps(project.to_dict()["history"]),
                    project.collection_id, project.kind,
                    project.body, project.path, project.content_hash,
                    0 if errors else 1, json.dumps(errors),
                ),
            )
            _index_body_links(conn, index_links.KIND_PROJECT, project.id, project.body)
            conn.commit()

    @_serialized
    def index_project_file(self, path) -> Project:
        return entity_store.index_file(_PROJECT_SPEC, self, path)

    def get_project(self, project_id: str) -> Optional[Project]:
        project = entity_store.get_by_id(self._connect, _PROJECT_SPEC, project_id)
        if project is not None and self._collections is not None:
            collection_entries.decorate(project, self._collections)
        return project

    def list_projects(self) -> list[Project]:
        projects = entity_store.list_all(self._connect, _PROJECT_SPEC)
        if self._collections is not None:
            for project in projects:
                collection_entries.decorate(project, self._collections)
        return projects

    def projects_for_citekey(self, citekey: str) -> list[Project]:
        """Research projects whose refs contain ``citekey`` — backward
        resolution for the library reference panel (cite-key usage lookup);
        a ``[@key]`` in the description counts too (ADR-0026)."""
        if not citekey:
            return []
        return [p for p in self.list_projects() if citekey in p.refs or cites(p.body, citekey)]

    @_serialized
    def save_project_file(self, project: Project) -> Path:
        return entity_store.save_file(_PROJECT_SPEC, project, self._connect)

    def delete_project(self, project_id: str) -> None:
        self._delete_entity(_PROJECT_SPEC, index_links.KIND_PROJECT, project_id)

    # --- publications (ADR-0004) ---------------------------------------------
    def index_publication(self, publication: Publication) -> None:
        errors = publication.validate()
        with closing(self._connect()) as conn:
            conn.execute(
                """INSERT INTO publications
                   (id, title, status, venue, type, authors, submitted, published,
                    due, tags, refs, derived_from, manuscripts, projects, paper,
                    history, collection_id, kind, body, path, content_hash, valid, errors)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(id) DO UPDATE SET
                     title=excluded.title, status=excluded.status,
                     venue=excluded.venue, type=excluded.type,
                     authors=excluded.authors, submitted=excluded.submitted,
                     published=excluded.published, due=excluded.due,
                     tags=excluded.tags, refs=excluded.refs,
                     derived_from=excluded.derived_from,
                     manuscripts=excluded.manuscripts, projects=excluded.projects,
                     paper=excluded.paper, history=excluded.history,
                     collection_id=excluded.collection_id,
                     kind=excluded.kind, body=excluded.body, path=excluded.path,
                     content_hash=excluded.content_hash, valid=excluded.valid,
                     errors=excluded.errors""",
                (
                    publication.id, publication.title, publication.status,
                    publication.venue, publication.type,
                    json.dumps(publication.authors), publication.submitted,
                    publication.published, publication.due,
                    json.dumps(publication.tags), json.dumps(publication.refs),
                    json.dumps(publication.derived_from),
                    json.dumps(publication.manuscripts),
                    json.dumps(publication.projects), publication.paper,
                    json.dumps(publication.to_dict()["history"]),
                    publication.collection_id, publication.kind,
                    publication.body, publication.path, publication.content_hash,
                    0 if errors else 1, json.dumps(errors),
                ),
            )
            _index_body_links(
                conn, index_links.KIND_PUBLICATION, publication.id, publication.body
            )
            conn.commit()

    @_serialized
    def index_publication_file(self, path) -> Publication:
        return entity_store.index_file(_PUBLICATION_SPEC, self, path)

    def get_publication(self, publication_id: str) -> Optional[Publication]:
        """A Publication file by id; a Collection entry is decorated with its
        live Collection (ADR-0022). There are no virtual entries (ADR-0025)."""
        publication = entity_store.get_by_id(self._connect, _PUBLICATION_SPEC, publication_id)
        if self._collections is None or publication is None:
            return publication
        return collection_entries.decorate(publication, self._collections)

    def list_publications(self) -> list[Publication]:
        """Every Publication file, Collection entries decorated live — a
        Collection without a file is not a Publication (ADR-0025, #225)."""
        rows = entity_store.list_all(self._connect, _PUBLICATION_SPEC)
        if self._collections is None:
            return rows
        return collection_entries.publications_view(rows, self._collections)

    # --- Collection entries (ADR-0022, issue #205) ---------------------------
    def attach_collections(self, source) -> None:
        """Hand the store the core's Collections (``CollectionSource``). Only a
        source that can actually read Collections switches the overlay on."""
        self._collections = source if source is not None and source.available else None

    @property
    def collections(self):
        return self._collections

    def collection_files(self) -> list:
        """The indexed FILES that link a Collection (Publications and
        Projects), undecorated — the tombstone reconcile's input."""
        return [
            entity
            for spec in (_PUBLICATION_SPEC, _PROJECT_SPEC)
            for entity in entity_store.list_all(self._connect, spec)
            if entity.collection_id is not None
        ]

    def delete_publication(self, publication_id: str) -> None:
        self._delete_entity(
            _PUBLICATION_SPEC, index_links.KIND_PUBLICATION, publication_id
        )

    def publications_for_citekey(self, citekey: str) -> list[Publication]:
        """Publications that reference ``citekey`` — via their bibliography
        (refs), the paper self-link or a ``[@key]`` in their notes (ADR-0026).
        Backward resolution for the library reference panel."""
        if not citekey:
            return []
        return [
            p for p in self.list_publications()
            if citekey in p.refs or p.paper == citekey or cites(p.body, citekey)
        ]

    def publications_for_project(self, project_id: str) -> list[Publication]:
        """Publications originating from this research project — reverse lookup
        over the publications' ``projects`` field (issue #50). The link is
        stored downstream on the Publication (ADR-0004); the Project page
        derives its publication list here instead of maintaining a second,
        drift-prone link on the project file."""
        if not project_id:
            return []
        return [p for p in self.list_publications() if project_id in p.projects]

    @_serialized
    def save_publication_file(self, publication: Publication) -> Path:
        return entity_store.save_file(_PUBLICATION_SPEC, publication, self._connect)

    # --- Zettel (atlas.zettel/1, issue #180) ---------------------------------
    def index_zettel(self, zettel: Zettel) -> None:
        errors = zettel.validate()
        with closing(self._connect()) as conn:
            conn.execute(
                """INSERT INTO zettel
                   (id, title, type, date, refs, tags, promoted_to, body, path,
                    content_hash, valid, errors)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(id) DO UPDATE SET
                     title=excluded.title, type=excluded.type, date=excluded.date,
                     refs=excluded.refs, tags=excluded.tags,
                     promoted_to=excluded.promoted_to, body=excluded.body,
                     path=excluded.path, content_hash=excluded.content_hash,
                     valid=excluded.valid, errors=excluded.errors""",
                (
                    zettel.id, zettel.title, zettel.type, zettel.date,
                    json.dumps(zettel.refs), json.dumps(zettel.tags),
                    zettel.promoted_to, zettel.body, zettel.path,
                    zettel.content_hash, 0 if errors else 1, json.dumps(errors),
                ),
            )
            _index_body_links(conn, index_links.KIND_ZETTEL, zettel.id, zettel.body)
            conn.commit()

    @_serialized
    def index_zettel_file(self, path) -> Zettel:
        return entity_store.index_file(_ZETTEL_SPEC, self, path)

    def get_zettel(self, zettel_id: str) -> Optional[Zettel]:
        return entity_store.get_by_id(self._connect, _ZETTEL_SPEC, zettel_id)

    def list_zettel(self, *, type: Optional[str] = None, q: Optional[str] = None) -> list[Zettel]:
        """Zettel, newest first. ``type`` filters the Enum, ``q`` is the simple
        LIKE search over title, body, refs and tags (no FTS5 by decision)."""
        sql = "SELECT * FROM zettel"
        clauses: list[str] = []
        params: list = []
        if type:
            clauses.append("type = ?")
            params.append(type)
        if q and q.strip():
            like = f"%{q.strip().lower()}%"
            clauses.append(
                "(LOWER(title) LIKE ? OR LOWER(body) LIKE ?"
                " OR LOWER(refs) LIKE ? OR LOWER(tags) LIKE ?)"
            )
            params.extend([like] * 4)
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += f" ORDER BY {_ZETTEL_SPEC.order_by}"
        with closing(self._connect()) as conn:
            rows = conn.execute(sql, params).fetchall()
        return [_row_to_zettel(r) for r in rows]

    def zettel_for_citekey(self, citekey: str) -> list[Zettel]:
        """Zettel whose ``refs`` contain ``citekey`` or whose body cites it as
        ``[@key]`` (ADR-0026) — the Paper detail page asks this to show the
        Lektuerezettel of a paper (user story 38)."""
        if not citekey:
            return []
        return [z for z in self.list_zettel() if citekey in z.refs or cites(z.body, citekey)]

    @_serialized
    def save_zettel_file(self, zettel: Zettel) -> Path:
        return entity_store.save_file(_ZETTEL_SPEC, zettel, self._connect)

    def delete_zettel(self, zettel_id: str) -> None:
        self._delete_entity(_ZETTEL_SPEC, index_links.KIND_ZETTEL, zettel_id)

    # --- Journal (atlas.journal/1, ADR-0020) ---------------------------------
    # File-level primitives only: every write is a line operation on the body
    # (journal_store), written to the Markdown file and then re-indexed. There
    # is no generic entity save for a Journal.

    def read_journal(self, week: str) -> Journal:
        """The week's Journal read from its file — a missing file yields an
        empty Journal and creates nothing."""
        return journal_store.read_journal(week)

    @_serialized
    def write_journal(self, journal: Journal) -> Path:
        """Write the week file as it is (no line operation, no index)."""
        return journal_store.write_journal(journal)

    @_serialized
    def index_journal_file(self, path) -> Journal:
        return journal_store.index_journal_file(self._connect, path)

    def list_journal_weeks(self) -> list[dict]:
        return journal_store.list_weeks(self._connect)

    def list_journal_tasks(self, *, weeks=None) -> list[dict]:
        return journal_store.list_tasks(self._connect, weeks=weeks)

    def tasks_for_anchor(self, anchor: str, *, open_only: bool = False) -> list[dict]:
        return journal_store.tasks_for_anchor(self._connect, anchor, open_only=open_only)

    @_serialized
    def add_task(self, week: str, day, text: str) -> dict:
        return journal_store.add_task(self._connect, week, day, text)

    @_serialized
    def update_task(
        self, week: str, body_index: int, text: Optional[str] = None, note: Optional[str] = None
    ) -> dict:
        return journal_store.update_task(self._connect, week, body_index, text, note)

    @_serialized
    def toggle_task(self, week: str, body_index: int) -> dict:
        return journal_store.toggle_task(self._connect, week, body_index)

    @_serialized
    def delete_task(self, week: str, body_index: int) -> None:
        journal_store.delete_task(self._connect, week, body_index)

    @_serialized
    def reorder_task(self, week: str, body_index: int, position: int) -> dict:
        return journal_store.reorder_task(self._connect, week, body_index, position)

    @_serialized
    def move_task(self, week: str, body_index: int, to_day) -> dict:
        return journal_store.move_task(self._connect, week, body_index, to_day)

    @_serialized
    def undo_move(self, week: str, body_index: int, to_week: str, to_index: int) -> dict:
        return journal_store.undo_move(self._connect, week, body_index, to_week, to_index)

    @_serialized
    def set_goals(self, week: str, goals) -> Journal:
        return journal_store.set_goals(self._connect, week, goals)

    @_serialized
    def toggle_goal(self, week: str, index: int) -> Journal:
        return journal_store.toggle_goal(self._connect, week, index)

    # --- Verweise / Rueckverweise (ADR-0020) ---------------------------------
    def entities(self) -> list[dict]:
        """``{id, kind, title}`` of every Atlas entity — the source of the
        ``[[`` autocomplete and of the anchor chip titles."""
        out: list[dict] = []
        for kind, items in (
            (index_links.KIND_DISS_NODE, self.list_nodes()),
            (index_links.KIND_PUBLICATION, self.list_publications()),
            (index_links.KIND_PROJECT, self.list_projects()),
            (index_links.KIND_IDEA, self.list_ideas()),
            (index_links.KIND_ZETTEL, self.list_zettel()),
        ):
            out.extend({"id": e.id, "kind": kind, "title": e.title} for e in items)
        return out

    def backlinks(self, target_id: str) -> dict:
        """Rueckverweise of ``target_id`` grouped by source kind. Entities come
        with their title, Tasks with week, day and done state."""
        groups: dict[str, list] = {key: [] for key in _BACKLINK_GROUPS.values()}
        groups["tasks"] = []
        if not target_id:
            return groups
        with closing(self._connect()) as conn:
            rows = index_links.edges_to(conn, target_id)
        task_ids = [r["from_id"] for r in rows if r["from_kind"] == index_links.KIND_TASK]
        tasks = journal_store.tasks_by_source(self._connect, task_ids)
        getters = {
            index_links.KIND_IDEA: self.get_idea,
            index_links.KIND_DISS_NODE: self.get_node,
            index_links.KIND_PROJECT: self.get_project,
            index_links.KIND_PUBLICATION: self.get_publication,
            index_links.KIND_ZETTEL: self.get_zettel,
        }
        for row in rows:
            kind, from_id = row["from_kind"], row["from_id"]
            if kind == index_links.KIND_TASK:
                task = tasks.get(from_id)
                if task is not None:
                    groups["tasks"].append({"id": from_id, **task})
                continue
            group = _BACKLINK_GROUPS.get(kind)
            entity = getters[kind](from_id) if group else None
            if entity is not None:
                groups[group].append({"id": entity.id, "title": entity.title})
        return groups

    def dangling_links(self) -> list[dict]:
        """Every Verweis whose target id exists in no entity table:
        ``{from_kind, from_id, to_id, path}``. Warnings only — never repaired."""
        known = {e["id"] for e in self.entities()}
        with closing(self._connect()) as conn:
            edges = index_links.all_edges(conn)
        out: list[dict] = []
        for edge in edges:
            if edge["to_id"] in known:
                continue
            out.append({
                "from_kind": edge["from_kind"],
                "from_id": edge["from_id"],
                "to_id": edge["to_id"],
                "path": self._source_path(edge["from_kind"], edge["from_id"]),
            })
        return out

    def _source_path(self, kind: str, from_id: str) -> Optional[str]:
        if kind == index_links.KIND_TASK:
            parsed = index_links.parse_task_source_id(from_id)
            try:
                return str(journal_store.journal_path(parsed[0])) if parsed else None
            except ValueError:
                return None
        spec = _SPEC_BY_KIND.get(kind)
        if spec is None:
            return None
        entity = entity_store.get_by_id(self._connect, spec, from_id)
        return entity.path if entity is not None else None

    # --- full rebuild & integrity ------------------------------------------
    @_serialized
    def reindex(self) -> dict:
        """Rebuild every entity index from its archive folder (P1). Idempotent:
        running it twice yields the same DB state. Last file wins on
        id-collision (also reported). A file that cannot be read (broken YAML
        of a hand edit, a lock that outlasts the retries) counts as invalid,
        is listed in ``unreadable`` (``{path, error, locked}``) and never
        stops the rest; a database failure does. Non-recursive globs are
        deliberate — e.g. per-project document subfolders projekte/<id>/
        (issue #49) are never scanned for Markdown."""
        # The edge table is rebuilt with the entities: wipe it first, then let
        # every indexed body and Task line refill it (ADR-0020).
        with closing(self._connect()) as conn:
            index_links.wipe(conn)
            conn.commit()

        ideas = entity_store.reindex_one(_IDEA_SPEC, self, self._connect)
        nodes = entity_store.reindex_one(_DISS_SPEC, self, self._connect)
        projects = entity_store.reindex_one(_PROJECT_SPEC, self, self._connect)
        publications = entity_store.reindex_one(_PUBLICATION_SPEC, self, self._connect)
        zettel = entity_store.reindex_one(_ZETTEL_SPEC, self, self._connect)
        journals = journal_store.reindex_journals(self._connect)

        self.prune_embeddings()

        return {
            "indexed": ideas["count"],
            "invalid": ideas["invalid"],
            "duplicates": [
                *ideas["duplicates"], *nodes["duplicates"],
                *projects["duplicates"], *publications["duplicates"],
                *zettel["duplicates"],
            ],
            "nodes_indexed": nodes["count"],
            "nodes_invalid": nodes["invalid"],
            "projects_indexed": projects["count"],
            "projects_invalid": projects["invalid"],
            "publications_indexed": publications["count"],
            "publications_invalid": publications["invalid"],
            "zettel_indexed": zettel["count"],
            "zettel_invalid": zettel["invalid"],
            "journals_indexed": journals["count"],
            "journals_invalid": journals["invalid"],
            "unreadable": [
                *ideas["unreadable"], *nodes["unreadable"], *projects["unreadable"],
                *publications["unreadable"], *zettel["unreadable"], *journals["unreadable"],
            ],
        }

    def check(self, resolve_citekey=None) -> list[dict]:
        """Integrity report. Each entry: {id, path, issues:[...]}. Covers
        validation errors and (optionally) hanging refs when ``resolve_citekey``
        is given — a callable citekey -> bool. Hanging refs are warnings, never
        auto-repaired (Abschn. 4.4)."""
        report: list[dict] = []
        nodes = self.list_nodes()
        node_ids = {n.id for n in nodes}
        for idea in self.list_ideas():
            issues = list(idea.validate())
            if resolve_citekey is not None:
                for ref in idea.refs:
                    if not resolve_citekey(ref):
                        issues.append(f"haengender ref (Citekey nicht in Bibliothek): {ref}")
            for node_id in idea.diss:
                if node_id not in node_ids:
                    issues.append(f"haengender diss-Verweis (Knoten nicht vorhanden): {node_id}")
            if issues:
                report.append({"id": idea.id, "path": idea.path, "issues": issues})

        # Dissertation chapter validation + hanging publication links
        # (atlas.dissnode/3, ADR-0005) — warnings only, never auto-repaired.
        # The flat model has no tree integrity (cycles/orphans) to check.
        publication_ids = {p.id for p in self.list_publications()}
        for node in nodes:
            issues = list(node.validate())
            for pub_id in node.publications:
                if pub_id not in publication_ids:
                    issues.append(
                        f"haengender publications-Verweis (keine Veroeffentlichung): {pub_id}"
                    )
            if issues:
                report.append({"id": node.id, "path": node.path, "issues": issues})

        # Research projects (atlas.project/3): validation + hanging refs.
        idea_ids = {i.id for i in self.list_ideas()}
        for project in self.list_projects():
            issues = list(project.validate())
            if resolve_citekey is not None:
                for ref in project.refs:
                    if not resolve_citekey(ref):
                        issues.append(f"haengender ref (Citekey nicht in Bibliothek): {ref}")
            if issues:
                report.append({"id": project.id, "path": project.path, "issues": issues})

        # Publications: validation + hanging links (refs/paper via library,
        # derived_from via ideas, projects via project index, manuscripts via
        # the manuskripte/ folder). Warnings only — never auto-repaired.
        project_ids = {p.id for p in self.list_projects()}
        for publication in self.list_publications():
            issues = list(publication.validate())
            if resolve_citekey is not None:
                for ref in publication.refs:
                    if not resolve_citekey(ref):
                        issues.append(f"haengender ref (Citekey nicht in Bibliothek): {ref}")
                if publication.paper and not resolve_citekey(publication.paper):
                    issues.append(f"haengender paper-Selbstlink (Citekey nicht in Bibliothek): {publication.paper}")
            for origin in publication.derived_from:
                if origin not in idea_ids:
                    issues.append(f"haengender derived_from (keine Idee): {origin}")
            for proj_id in publication.projects:
                if proj_id not in project_ids:
                    issues.append(f"haengender projects-Verweis (kein Projekt): {proj_id}")
            for name in publication.manuscripts:
                if not _manuscript_exists(name):
                    issues.append(f"haengender Manuskript-Verweis (.tex nicht vorhanden): {name}")
            if issues:
                report.append({"id": publication.id, "path": publication.path, "issues": issues})

        # Zettel (atlas.zettel/1): validation + hanging refs.
        for zettel in self.list_zettel():
            issues = list(zettel.validate())
            if resolve_citekey is not None:
                for ref in zettel.refs:
                    if not resolve_citekey(ref):
                        issues.append(f"haengender ref (Citekey nicht in Bibliothek): {ref}")
            if issues:
                report.append({"id": zettel.id, "path": zettel.path, "issues": issues})

        # Journal weeks: structural validation (week id vs. filename, day
        # outside the week, more than five Wochenziele).
        for week in self.list_journal_weeks():
            journal = Journal(week=week["week"], goals=week["goals"])
            if week["path"] and Path(week["path"]).exists():
                try:  # hand-edited since it was indexed: name it, never fail
                    journal = Journal.from_file(week["path"])
                except Exception as exc:  # noqa: BLE001
                    report.append({"id": week["week"], "path": week["path"],
                                   "issues": [f"Datei nicht lesbar: {exc}"]})
                    continue
            issues = journal.validate()
            if issues:
                report.append({"id": week["week"], "path": week["path"], "issues": issues})

        # Hanging Verweise (ADR-0020): a [[id]] whose target exists in no
        # entity table. Warnings with source and target — never repaired.
        dangling: dict[tuple, dict] = {}
        for edge in self.dangling_links():
            key = (edge["from_kind"], edge["from_id"])
            entry = dangling.setdefault(
                key, {"id": edge["from_id"], "path": edge["path"], "issues": []}
            )
            entry["issues"].append(
                f"haengender Verweis (Ziel-ID nicht vorhanden): {edge['to_id']}"
            )
        report.extend(dangling.values())
        return report

    # --- embedding cache (Phase 4, hash-invalidated) -------------------------
    # Derived data like everything else in atlas.db: keyed by the idea's
    # content_hash, so an edited file simply misses the cache and gets
    # re-embedded. Rebuildable at any time (P1); written only here in the store.

    def get_embedding(self, idea_id: str, content_hash: str) -> Optional[list]:
        with closing(self._connect()) as conn:
            row = conn.execute(
                "SELECT vector FROM idea_embeddings WHERE idea_id = ? AND content_hash = ?",
                (idea_id, content_hash),
            ).fetchone()
        return json.loads(row["vector"]) if row else None

    def save_embedding(self, idea_id: str, content_hash: str, vector: list) -> None:
        with closing(self._connect()) as conn:
            conn.execute(
                "INSERT OR REPLACE INTO idea_embeddings (idea_id, content_hash, vector) VALUES (?,?,?)",
                (idea_id, content_hash, json.dumps(vector)),
            )
            conn.commit()

    def prune_embeddings(self) -> None:
        """Drop cache rows whose idea no longer exists (called by reindex)."""
        with closing(self._connect()) as conn:
            conn.execute(
                "DELETE FROM idea_embeddings WHERE idea_id NOT IN (SELECT id FROM ideas)"
            )
            conn.commit()

    # --- file write helper (UI/quick-capture write path) -------------------
    @_serialized
    def save_idea_file(self, idea: Idea) -> Path:
        return entity_store.save_file(_IDEA_SPEC, idea, self._connect)

    @_serialized
    def ensure_current(self, kind: str, entity) -> None:
        """Raise ``entity_store.FileChanged`` unless ``entity``'s file is what
        the index read — before a write that moves the file away (the type
        switch) or that must not start on a stale source (promote). The same
        check every ``save_*_file`` makes (``entity_store.check_current``)."""
        entity_store.check_current(_SPEC_BY_KIND[kind], self._connect, entity)

    def free_id(self, kind: str, base: str) -> str:
        """The id for a NEW entity of ``kind`` (``index_links.KIND_*``) — every
        create/import/promote path asks here: ``base``, else ``base-2``…, never
        one the index has or an ``<id>.md`` on disk holds, indexed or not (a
        skipped hand edit stays the user's). Publications and Projects also
        skip a leftover document folder (``DocumentFolder.free_id``)."""
        spec = _SPEC_BY_KIND[kind]
        exists = lambda i: entity_store.get_by_id(self._connect, spec, i) is not None  # noqa: E731
        folder = _DOCUMENT_FOLDERS.get(kind)
        if folder is not None:
            return folder.free_id(base, exists)
        return entity_store.free_id(base, exists, spec.dir_fn())


def _index_body_links(conn: sqlite3.Connection, kind: str, entity_id: str, body: str) -> None:
    """Every ``[[id]]`` of one entity body as edges (ADR-0020). Called from
    inside each indexer's transaction, so an entity and its Verweise are
    always written together."""
    index_links.replace_edges(conn, kind, entity_id, extract_wikilinks(body or ""))


def _row_to_idea(row: sqlite3.Row) -> Idea:
    return Idea(
        id=row["id"],
        title=row["title"],
        type=row["type"],
        status=row["status"],
        tags=json.loads(row["tags"]),
        refs=json.loads(row["refs"]),
        diss=json.loads(row["diss"]),
        venue=row["venue"],
        created=row["created"],
        updated=row["updated"],
        body=row["body"],
        path=row["path"],
    )


def _row_to_node(row: sqlite3.Row) -> DissNode:
    return DissNode(
        id=row["id"],
        title=row["title"],
        order=row["order"],
        status=row["status"],
        publications=json.loads(row["publications"]),
        body=row["body"],
        path=row["path"],
    )


def _manuscript_exists(name: str) -> bool:
    """A manuscripts entry may be the .tex name or the bare id (filename stem)."""
    stem = name[:-4] if name.lower().endswith(".tex") else name
    if not stem:
        return False
    return (config.manuscripts_dir() / f"{stem}.tex").exists()


def _row_to_publication(row: sqlite3.Row) -> Publication:
    return Publication(
        id=row["id"],
        title=row["title"],
        status=row["status"],
        venue=row["venue"],
        type=row["type"],
        authors=json.loads(row["authors"]),
        submitted=row["submitted"],
        published=row["published"],
        due=row["due"],
        tags=json.loads(row["tags"]),
        refs=json.loads(row["refs"]),
        derived_from=json.loads(row["derived_from"]),
        manuscripts=json.loads(row["manuscripts"]),
        projects=json.loads(row["projects"]),
        paper=row["paper"],
        history=json.loads(row["history"]),
        body=row["body"],
        path=row["path"],
        collection_id=row["collection_id"],
        kind=row["kind"],
    )


def _row_to_zettel(row: sqlite3.Row) -> Zettel:
    return Zettel(
        id=row["id"],
        title=row["title"],
        type=row["type"],
        date=row["date"],
        refs=json.loads(row["refs"]),
        tags=json.loads(row["tags"]),
        promoted_to=row["promoted_to"],
        body=row["body"],
        path=row["path"],
    )


def _row_to_project(row: sqlite3.Row) -> Project:
    return Project(
        id=row["id"],
        title=row["title"],
        status=row["status"],
        start=row["start"],
        end=row["end"],
        funder=row["funder"],
        grant_id=row["grant_id"],
        role=row["role"],
        tags=json.loads(row["tags"]),
        refs=json.loads(row["refs"]),
        milestones=json.loads(row["milestones"]),
        history=json.loads(row["history"]),
        body=row["body"],
        path=row["path"],
        collection_id=row["collection_id"],
        kind=row["kind"],
    )


# --- EntitySpecs: wire the generic CRUD/reindex functions in entity_store to
# each entity's hand-written indexer + row mapper. Defined here (module end)
# so they can reference AtlasStore.index_idea & co. by name.
_IDEA_SPEC = entity_store.EntitySpec(
    label="idea",
    table="ideas",
    order_by="updated DESC, id",
    dir_fn=config.ideas_dir,
    from_file=Idea.from_file,
    index_one=AtlasStore.index_idea,
    row_to_entity=_row_to_idea,
)

_DISS_SPEC = entity_store.EntitySpec(
    label="diss_node",
    table="diss_nodes",
    order_by='"order", id',
    dir_fn=config.diss_dir,
    from_file=DissNode.from_file,
    index_one=AtlasStore.index_node,
    row_to_entity=_row_to_node,
)

_PROJECT_SPEC = entity_store.EntitySpec(
    label="project",
    table="projects",
    order_by='"end" IS NULL, "end", start IS NULL, start, id',
    dir_fn=config.projects_dir,
    from_file=Project.from_file,
    index_one=AtlasStore.index_project,
    row_to_entity=_row_to_project,
)

_PUBLICATION_SPEC = entity_store.EntitySpec(
    label="publication",
    table="publications",
    order_by="due IS NULL, due, id",
    dir_fn=config.publications_dir,
    from_file=Publication.from_file,
    index_one=AtlasStore.index_publication,
    row_to_entity=_row_to_publication,
)

_ZETTEL_SPEC = entity_store.EntitySpec(
    label="zettel",
    table="zettel",
    order_by="date IS NULL, date DESC, id DESC",
    dir_fn=config.zettel_dir,
    from_file=Zettel.from_file,
    index_one=AtlasStore.index_zettel,
    row_to_entity=_row_to_zettel,
)

# Which spec/table carries which link kind — used by remove_path and by the
# hanging-Verweis report.
_SPEC_BY_KIND = {
    index_links.KIND_IDEA: _IDEA_SPEC,
    index_links.KIND_DISS_NODE: _DISS_SPEC,
    index_links.KIND_PROJECT: _PROJECT_SPEC,
    index_links.KIND_PUBLICATION: _PUBLICATION_SPEC,
    index_links.KIND_ZETTEL: _ZETTEL_SPEC,
}

_PATH_TABLES = tuple((kind, spec.table) for kind, spec in _SPEC_BY_KIND.items())

# The entities with a document folder per id (#226) — free_id skips those, too.
_DOCUMENT_FOLDERS = {
    index_links.KIND_PROJECT: documents.PROJECTS,
    index_links.KIND_PUBLICATION: documents.PUBLICATIONS,
}

# Rueckverweis group names of the API payload, per source kind.
_BACKLINK_GROUPS = {
    index_links.KIND_DISS_NODE: "chapters",
    index_links.KIND_PUBLICATION: "publications",
    index_links.KIND_PROJECT: "projects",
    index_links.KIND_IDEA: "ideas",
    index_links.KIND_ZETTEL: "zettel",
}
