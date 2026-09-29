"""Atlas HTTP API — the router the core mounts when the plugin is active.

Atlas builds its own FastAPI router because the core cannot import the plugin to
define routes for it (P3). Endpoints are read/write over the idea store plus an
SSE stream for live updates. Writes here are explicit user actions (Quick-Capture,
P5) — not silent LLM writes (P4 concerns LLM suggestions, added in Phase 4).
"""

from __future__ import annotations

import json
import re
from datetime import date
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

from atlas import compiler, documents, manuscripts, project_extraction
from atlas.api_journal import build_journal_router
from atlas.api_links import build_links_router, chapter_metrics
from atlas.api_zettel import build_zettel_router
from atlas.domain import (
    DissNode,
    Idea,
    Project,
    Publication,
    annotate_milestones,
    make_idea_id,
    new_idea,
    publication_from_idea,
    slugify,
)


class IdeaCreate(BaseModel):
    title: str
    type: Optional[str] = None
    status: Optional[str] = None
    tags: list[str] = []
    refs: list[str] = []
    diss: list[str] = []
    venue: Optional[str] = None
    body: Optional[str] = None


class IdeaUpdate(BaseModel):
    # All optional — only provided fields are applied. id stays fixed (= filename).
    title: Optional[str] = None
    type: Optional[str] = None
    status: Optional[str] = None
    tags: Optional[list[str]] = None
    refs: Optional[list[str]] = None
    diss: Optional[list[str]] = None
    venue: Optional[str] = None
    body: Optional[str] = None


class IdeaImport(BaseModel):
    content: str
    filename: Optional[str] = None


class ProjectDocumentExtractRequest(BaseModel):
    model: Optional[str] = None
    affiliation: Optional[str] = None


class DissNodeCreate(BaseModel):
    # atlas.dissnode/3 (ADR-0005): a flat chapter — no kind, no parent.
    title: str
    id: Optional[str] = None
    order: Optional[int] = None
    status: Optional[str] = None
    publications: list[str] = []
    body: Optional[str] = None


class DissNodeUpdate(BaseModel):
    title: Optional[str] = None
    order: Optional[int] = None
    status: Optional[str] = None
    publications: Optional[list[str]] = None
    body: Optional[str] = None


class Milestone(BaseModel):
    title: str
    date: Optional[str] = None
    done: bool = False


class ProjectCreate(BaseModel):
    """Research project (atlas.project/3, ADR-0004)."""

    title: str
    id: Optional[str] = None
    status: Optional[str] = None
    start: Optional[str] = None
    end: Optional[str] = None
    funder: Optional[str] = None
    grant_id: Optional[str] = None
    role: Optional[str] = None
    tags: list[str] = []
    refs: list[str] = []
    milestones: list[Milestone] = []
    body: Optional[str] = None


class ProjectUpdate(BaseModel):
    # All optional — only provided fields are applied. id stays fixed (= filename).
    title: Optional[str] = None
    status: Optional[str] = None
    start: Optional[str] = None
    end: Optional[str] = None
    funder: Optional[str] = None
    grant_id: Optional[str] = None
    role: Optional[str] = None
    tags: Optional[list[str]] = None
    refs: Optional[list[str]] = None
    milestones: Optional[list[Milestone]] = None
    body: Optional[str] = None


class AddRefs(BaseModel):
    refs: list[str]


class PublicationLink(BaseModel):
    """Project→Publication linking (issue #50): the chosen publication's file
    receives the project id in its ``projects`` field (link stored downstream,
    ADR-0004)."""

    publication_id: str


class ChecklistToggle(BaseModel):
    index: int


class PublicationCreate(BaseModel):
    title: str
    id: Optional[str] = None
    status: Optional[str] = None
    venue: Optional[str] = None
    type: Optional[str] = None
    authors: list[str] = []
    submitted: Optional[str] = None
    published: Optional[str] = None
    due: Optional[str] = None
    tags: list[str] = []
    refs: list[str] = []
    derived_from: list[str] = []
    manuscripts: list[str] = []
    projects: list[str] = []
    paper: Optional[str] = None
    body: Optional[str] = None


class PublicationUpdate(BaseModel):
    # All optional — only provided fields are applied. id stays fixed (= filename).
    title: Optional[str] = None
    status: Optional[str] = None
    venue: Optional[str] = None
    type: Optional[str] = None
    authors: Optional[list[str]] = None
    submitted: Optional[str] = None
    published: Optional[str] = None
    due: Optional[str] = None
    tags: Optional[list[str]] = None
    refs: Optional[list[str]] = None
    derived_from: Optional[list[str]] = None
    manuscripts: Optional[list[str]] = None
    projects: Optional[list[str]] = None
    paper: Optional[str] = None
    body: Optional[str] = None


class ManuscriptCreate(BaseModel):
    title: str


class ManuscriptLink(BaseModel):
    name: str


class ManuscriptSave(BaseModel):
    content: str


class ManuscriptRename(BaseModel):
    title: str


class MatchPairRequest(BaseModel):
    citekey: str
    idea_id: str
    fulltext: bool = False  # include PDF full text (if the library can provide it)


class MatchPaperRequest(BaseModel):
    citekey: str
    k: int = 8  # top-k candidates for the bundled LLM call (Abschn. 8, F2)


class MatchUsage(BaseModel):
    anchor: Optional[str] = None
    suggestion: str


class MatchAccept(BaseModel):
    citekey: str
    reasoning: Optional[str] = None
    usages: list[MatchUsage] = []


class DissMatchRequest(BaseModel):
    citekey: str


def _serialize(idea) -> dict:
    data = idea.to_dict()
    data["errors"] = idea.validate()  # hanging-ref warnings come via /check
    return data


def _unique_id(store, base: str) -> str:
    if store.get_idea(base) is None:
        return base
    n = 2
    while store.get_idea(f"{base}-{n}") is not None:
        n += 1
    return f"{base}-{n}"


def _node_dict(node) -> dict:
    data = node.to_dict()
    data["errors"] = node.validate()
    return data


def _unique_node_id(store, base: str) -> str:
    base = base or "knoten"
    if store.get_node(base) is None:
        return base
    n = 2
    while store.get_node(f"{base}-{n}") is not None:
        n += 1
    return f"{base}-{n}"


def _project_dict(project) -> dict:
    data = project.to_dict()
    data["errors"] = project.validate()
    # Milestones timeline (next/overdue indication) — derived, never persisted.
    data["timeline"] = annotate_milestones(project.milestones, today=date.today())
    return data


def _publication_dict(publication) -> dict:
    data = publication.to_dict()
    data["errors"] = publication.validate()
    return data


def _publication_summary(publication) -> dict:
    """Compact wire form for reverse-lookup lists (project detail, issue #50)."""
    return {
        "id": publication.id,
        "title": publication.title,
        "status": publication.status,
        "venue": publication.venue,
        "type": publication.type,
    }


def _zettel_dict(zettel) -> dict:
    data = zettel.to_dict()
    data["errors"] = zettel.validate()
    return data


def _unique_publication_id(store, base: str) -> str:
    base = base or "veroeffentlichung"
    if store.get_publication(base) is None:
        return base
    n = 2
    while store.get_publication(f"{base}-{n}") is not None:
        n += 1
    return f"{base}-{n}"


def _unique_project_id(store, base: str) -> str:
    base = base or "projekt"
    if store.get_project(base) is None:
        return base
    n = 2
    while store.get_project(f"{base}-{n}") is not None:
        n += 1
    return f"{base}-{n}"


def _manuscript_stem(name: str) -> str:
    """Manuscript id from a linked name — links may carry the .tex suffix."""
    return name[:-4] if name.lower().endswith(".tex") else name


_CHECKLIST_LINE = re.compile(r"^(\s*[-*]\s+\[)([ xX])(\]\s+.*)$")


def _toggle_checklist_item(body: str, index: int) -> str:
    """Flip the index-th checklist item ([ ] <-> [x]), fence-aware."""
    out: list[str] = []
    in_fence = False
    count = -1
    for line in body.splitlines():
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            out.append(line)
            continue
        m = None if in_fence else _CHECKLIST_LINE.match(line)
        if m:
            count += 1
            if count == index:
                flipped = " " if m.group(2).lower() == "x" else "x"
                line = m.group(1) + flipped + m.group(3)
        out.append(line)
    return "\n".join(out)


def build_router(store, broadcaster, llm=None, library=None) -> APIRouter:
    """``llm``/``library`` are the host services from PluginApi (Phase 4).
    Without them the matching endpoints answer 503 — the rest of Atlas works."""
    router = APIRouter(prefix="/api/plugins/atlas", tags=["atlas"])

    def _resolve_citekey_entry(citekey: str) -> dict:
        """Resolve one cite key against the library for display. Hanging keys
        stay visible as warnings, never repaired."""
        paper = library.get_reference(citekey) if library is not None else None
        if paper is not None:
            return {
                "citekey": citekey, "found": True,
                "title": paper.get("title") or "",
                "authors": paper.get("authors") or "",
                "year": paper.get("year"),
                "paper_id": paper.get("id"),
            }
        return {"citekey": citekey, "found": False}

    @router.get("/ideas")
    async def list_ideas():
        return {"ideas": [_serialize(i) for i in store.list_ideas()]}

    @router.get("/ideas/{idea_id}")
    async def get_idea(idea_id: str):
        idea = store.get_idea(idea_id)
        if idea is None:
            raise HTTPException(status_code=404, detail="Idee nicht gefunden")
        return _serialize(idea)

    @router.post("/ideas")
    async def create_idea(payload: IdeaCreate):
        title = payload.title.strip()
        if not title:
            raise HTTPException(status_code=400, detail="Titel ist erforderlich")
        idea = new_idea(title)
        if payload.type:
            idea.type = payload.type
        if payload.status:
            idea.status = payload.status
        idea.tags = payload.tags
        idea.refs = payload.refs
        idea.diss = payload.diss
        idea.venue = payload.venue
        if payload.body is not None:
            idea.body = payload.body
        idea.id = _unique_id(store, idea.id)
        # UI write path: file first, then index (single DB writer). The watcher
        # will also catch the new file; we index + broadcast here so the request
        # is immediately consistent for the caller too.
        path = store.save_idea_file(idea)
        store.index_file(path)
        broadcaster.publish({"type": "ideas-changed"})
        created = store.get_idea(idea.id)
        return _serialize(created)

    @router.put("/ideas/{idea_id}")
    async def update_idea(idea_id: str, payload: IdeaUpdate):
        idea = store.get_idea(idea_id)
        if idea is None:
            raise HTTPException(status_code=404, detail="Idee nicht gefunden")
        # Apply only the fields the client actually sent; id stays fixed.
        changes = payload.model_dump(exclude_unset=True)
        for field in ("title", "type", "status", "tags", "refs", "diss", "venue", "body"):
            if field in changes and changes[field] is not None:
                setattr(idea, field, changes[field])
        if not (idea.title or "").strip():
            raise HTTPException(status_code=400, detail="Titel ist erforderlich")
        idea.updated = date.today().isoformat()  # created is preserved
        path = store.save_idea_file(idea)
        store.index_file(path)
        broadcaster.publish({"type": "ideas-changed"})
        return _serialize(store.get_idea(idea_id))

    @router.post("/ideas/{idea_id}/promote")
    async def promote_idea(idea_id: str):
        """Promote (ADR-0004, issue #46): "Zu Veroeffentlichung ausarbeiten".
        Creates a Publication seeded from the idea (refs, tags, body copied;
        derived_from = idea id) and flips the idea's status to ``promoted``.
        The idea file stays in place — history is preserved (P1)."""
        idea = store.get_idea(idea_id)
        if idea is None:
            raise HTTPException(status_code=404, detail="Idee nicht gefunden")
        publication = publication_from_idea(idea)
        publication.id = _unique_publication_id(store, publication.id)
        pub_path = store.save_publication_file(publication)
        store.index_publication_file(pub_path)

        idea.status = "promoted"
        idea.updated = date.today().isoformat()
        idea_path = store.save_idea_file(idea)
        store.index_file(idea_path)

        broadcaster.publish({"type": "publications-changed"})
        broadcaster.publish({"type": "ideas-changed"})
        return {
            "publication": _publication_dict(store.get_publication(publication.id)),
            "idea": _serialize(store.get_idea(idea_id)),
        }

    @router.post("/import")
    async def import_idea(payload: IdeaImport):
        if payload.filename and not payload.filename.lower().endswith(".md"):
            raise HTTPException(status_code=400, detail="Nur .md-Dateien")
        stem = None
        if payload.filename:
            name = payload.filename
            stem = name[:-3] if name.lower().endswith(".md") else name
        try:
            idea = Idea.from_markdown(payload.content, id_hint=stem)
        except Exception as exc:  # malformed YAML frontmatter
            raise HTTPException(status_code=400, detail=f"Ungueltiges Markdown: {exc}")
        if not (idea.id or "").strip():
            if not idea.title.strip():
                raise HTTPException(status_code=400, detail="Datei hat weder id noch Titel")
            idea.id = make_idea_id(idea.title)
        idea.id = _unique_id(store, idea.id)
        path = store.save_idea_file(idea)
        store.index_file(path)
        broadcaster.publish({"type": "ideas-changed"})
        return _serialize(store.get_idea(idea.id))

    @router.get("/links/{citekey}")
    async def links_for(citekey: str):
        """Ideas, publications, research projects and Zettel referencing this
        library citekey — the backward-link panel the Paper detail page uses
        (cite-key usage lookup, story 38). ``zettel`` is additive (issue
        #180) — the existing shape stays backwards compatible."""
        return {
            "ideas": [_serialize(i) for i in store.links_for(citekey)],
            "publications": [
                _publication_dict(p) for p in store.publications_for_citekey(citekey)
            ],
            "projects": [
                _project_dict(p) for p in store.projects_for_citekey(citekey)
            ],
            "zettel": [_zettel_dict(z) for z in store.zettel_for_citekey(citekey)],
        }

    def _node_publications_resolved(node) -> list[dict]:
        """Publication links against the index — hanging IDs stay visible as
        warnings (found=False), never auto-repaired."""
        resolved = []
        for pub_id in node.publications:
            publication = store.get_publication(pub_id)
            if publication is not None:
                resolved.append({
                    "id": pub_id, "found": True,
                    "title": publication.title, "status": publication.status,
                })
            else:
                resolved.append({
                    "id": pub_id, "found": False, "title": pub_id, "status": None,
                })
        return resolved

    # --- dissertation chapters (atlas.dissnode/3, ADR-0005) ------------------
    @router.get("/diss")
    async def diss_outline():
        """The flat, ordered chapter list plus progress data for the page
        header (ADR-0005, issue #57). Hanging publication links are surfaced as
        warnings — shown, never auto-repaired."""
        chapters, progress = store.diss_chapters()
        return {
            "chapters": [_node_dict(c) for c in chapters],
            "progress": progress,
            "issues": store.diss_publication_issues(),
        }

    @router.get("/diss/{node_id}")
    async def get_node(node_id: str):
        node = store.get_node(node_id)
        if node is None:
            raise HTTPException(status_code=404, detail="Knoten nicht gefunden")
        data = _node_dict(node)
        data["linked_ideas"] = [
            {"id": i.id, "title": i.title, "type": i.type, "status": i.status}
            for i in store.node_links(node_id)
        ]
        data["publications_resolved"] = _node_publications_resolved(node)
        data.update(chapter_metrics(store, node))
        return data

    @router.post("/diss")
    async def create_node(payload: DissNodeCreate):
        title = payload.title.strip()
        if not title:
            raise HTTPException(status_code=400, detail="Titel ist erforderlich")
        # New chapters append to the end of the flat list unless an explicit
        # order is given (ADR-0005: the dissertation is a linear outline).
        if payload.order is not None:
            order = payload.order
        else:
            existing = store.list_nodes()
            order = max((n.order for n in existing), default=-1) + 1
        node = DissNode(
            id="",
            title=title,
            order=order,
            status=payload.status or "planned",
            publications=payload.publications,
            body=payload.body or "",
        )
        base = (payload.id or "").strip() or slugify(title)
        node.id = _unique_node_id(store, base)
        path = store.save_node_file(node)
        store.index_diss_file(path)
        broadcaster.publish({"type": "diss-changed"})
        return _node_dict(store.get_node(node.id))

    @router.put("/diss/{node_id}")
    async def update_node(node_id: str, payload: DissNodeUpdate):
        node = store.get_node(node_id)
        if node is None:
            raise HTTPException(status_code=404, detail="Knoten nicht gefunden")
        changes = payload.model_dump(exclude_unset=True)
        for field in ("title", "status", "body"):
            if field in changes:
                setattr(node, field, changes[field])
        if "publications" in changes and changes["publications"] is not None:
            node.publications = changes["publications"]
        if "order" in changes:
            node.order = changes["order"] if isinstance(changes["order"], int) else 0
        if not (node.title or "").strip():
            raise HTTPException(status_code=400, detail="Titel ist erforderlich")
        path = store.save_node_file(node)
        store.index_diss_file(path)
        broadcaster.publish({"type": "diss-changed"})
        return _node_dict(store.get_node(node_id))

    # --- diss node <-> publication assignment (atlas.dissnode/2, issue #53) ---
    @router.post("/diss/{node_id}/publications")
    async def assign_node_publication(node_id: str, payload: PublicationLink):
        """Assign a Publication to this dissertation node (any kind, ADR-0004).
        The link lives on the node's Markdown file. Only existing publications
        can be assigned here — hanging links are never created by the
        assignment action (free-text editing stays possible via PUT)."""
        node = store.get_node(node_id)
        if node is None:
            raise HTTPException(status_code=404, detail="Knoten nicht gefunden")
        if store.get_publication(payload.publication_id) is None:
            raise HTTPException(status_code=404, detail="Veroeffentlichung nicht gefunden")
        if payload.publication_id not in node.publications:
            node.publications = node.publications + [payload.publication_id]
            path = store.save_node_file(node)
            store.index_diss_file(path)
            broadcaster.publish({"type": "diss-changed"})
        return {
            "publications": _node_publications_resolved(store.get_node(node_id))
        }

    @router.delete("/diss/{node_id}/publications/{publication_id}")
    async def unassign_node_publication(node_id: str, publication_id: str):
        """Remove a publication link from the node. Works for hanging links
        too — removing a link is an explicit user action, not an auto-repair
        (the publication file itself is never touched)."""
        node = store.get_node(node_id)
        if node is None:
            raise HTTPException(status_code=404, detail="Knoten nicht gefunden")
        if publication_id not in node.publications:
            raise HTTPException(
                status_code=404,
                detail="Veroeffentlichung nicht mit diesem Knoten verknuepft",
            )
        node.publications = [p for p in node.publications if p != publication_id]
        path = store.save_node_file(node)
        store.index_diss_file(path)
        broadcaster.publish({"type": "diss-changed"})
        return {
            "publications": _node_publications_resolved(store.get_node(node_id))
        }

    @router.delete("/diss")
    async def delete_all_nodes():
        """Remove all dissertation chapter files and clear the index.
        This is the whole-outline delete action — explicit, irreversible user
        action; no auto-repair path. Broadcasting keeps the UI in sync."""
        nodes = store.list_nodes()
        for node in nodes:
            if node.path:
                Path(node.path).unlink(missing_ok=True)
        store.delete_all_nodes()
        broadcaster.publish({"type": "diss-changed"})
        return {"deleted": len(nodes)}

    @router.delete("/diss/{node_id}")
    async def delete_node(node_id: str):
        """Remove a single dissertation chapter file and its index row.
        Returns 404 for unknown ids."""
        node = store.get_node(node_id)
        if node is None:
            raise HTTPException(status_code=404, detail="Knoten nicht gefunden")
        if node.path:
            Path(node.path).unlink(missing_ok=True)
        store.delete_node(node_id)
        broadcaster.publish({"type": "diss-changed"})
        return {"deleted": node_id}

    # --- F3: chapter match ("Welches Kapitel passt?", issue #65) --------------
    @router.post("/diss/match")
    async def match_diss_chapters(payload: DissMatchRequest):
        """F3: 'Welches Kapitel passt?' — LLM ranking of dissertation chapters
        for a given paper. Chapters without body text are excluded from the
        prompt (not hallucinated, AC); their ids are returned in ``excluded``
        for UI transparency. Result is a proposal only — writes only on explicit
        user action (P4)."""
        _require_matching()
        from atlas import matching

        paper = _get_paper(payload.citekey)
        chapters, _ = store.diss_chapters()
        if not chapters:
            return {"results": [], "excluded": []}

        chapter_dicts = [c.to_dict() for c in chapters]
        excluded = [
            {"chapter_id": c["id"], "title": c["title"]}
            for c in chapter_dicts if not (c.get("body") or "").strip()
        ]
        eligible = [c for c in chapter_dicts if (c.get("body") or "").strip()]

        if not eligible:
            return {"results": [], "excluded": excluded}

        content = _llm_json(matching.build_chapter_match_messages(paper, eligible))
        try:
            raw = matching.parse_chapter_match_result(content)
        except ValueError as exc:
            raise HTTPException(status_code=502, detail=f"LLM-Antwort unbrauchbar: {exc}")

        id_to_chapter = {c["id"]: c for c in eligible}
        results = []
        for entry in raw:
            c = id_to_chapter.get(entry["chapter_id"])
            if c is None:
                continue  # LLM hallucinated an unknown chapter_id — skip
            results.append({
                "chapter_id": entry["chapter_id"],
                "title": c.get("title", ""),
                "rank": entry["rank"],
                "reason": entry["reason"],
            })
        results.sort(key=lambda x: x["rank"])
        return {"results": results, "excluded": excluded}

    # --- research projects (atlas.project/3, ADR-0004) -----------------------
    @router.get("/projects")
    async def list_projects():
        return {"projects": [_project_dict(p) for p in store.list_projects()]}

    @router.get("/projects/{project_id}")
    async def get_project(project_id: str):
        project = store.get_project(project_id)
        if project is None:
            raise HTTPException(status_code=404, detail="Projekt nicht gefunden")
        data = _project_dict(project)
        # Project-relevant literature against the library (hanging refs stay
        # visible as warnings, never repaired).
        data["refs_resolved"] = [_resolve_citekey_entry(c) for c in project.refs]
        # Publications originating from this project — reverse lookup over the
        # publications' projects field (link stored downstream, ADR-0004).
        data["publications"] = [
            _publication_summary(p) for p in store.publications_for_project(project_id)
        ]
        return data

    @router.post("/projects")
    async def create_project(payload: ProjectCreate):
        title = payload.title.strip()
        if not title:
            raise HTTPException(status_code=400, detail="Titel ist erforderlich")
        project = Project(
            id="", title=title,
            status=payload.status or "planned",
            start=payload.start or None,
            end=payload.end or None,
            funder=payload.funder or None,
            grant_id=payload.grant_id or None,
            role=payload.role or None,
            tags=payload.tags, refs=payload.refs,
            milestones=[m.model_dump() for m in payload.milestones],
            body=payload.body or "",
        )
        base = (payload.id or "").strip() or slugify(title)
        project.id = _unique_project_id(store, base)
        path = store.save_project_file(project)
        store.index_project_file(path)
        broadcaster.publish({"type": "projects-changed"})
        return _project_dict(store.get_project(project.id))

    @router.put("/projects/{project_id}")
    async def update_project(project_id: str, payload: ProjectUpdate):
        project = store.get_project(project_id)
        if project is None:
            raise HTTPException(status_code=404, detail="Projekt nicht gefunden")
        changes = payload.model_dump(exclude_unset=True)
        for field in ("title", "status", "start", "end", "funder", "grant_id", "role", "body"):
            if field in changes:
                setattr(project, field, changes[field])  # None clears the field
        for field in ("tags", "refs", "milestones"):
            if field in changes and changes[field] is not None:
                setattr(project, field, changes[field])
        if not (project.title or "").strip():
            raise HTTPException(status_code=400, detail="Titel ist erforderlich")
        path = store.save_project_file(project)
        store.index_project_file(path)
        broadcaster.publish({"type": "projects-changed"})
        return _project_dict(store.get_project(project_id))

    @router.delete("/projects/{project_id}")
    async def delete_project(project_id: str):
        project = store.get_project(project_id)
        if project is None:
            raise HTTPException(status_code=404, detail="Projekt nicht gefunden")
        # Explicit user action: remove the Markdown file, then the index row.
        # The project's document subfolder (projekte/<id>/) is left untouched —
        # it may hold user files; deleting the project only drops its .md.
        if project.path:
            Path(project.path).unlink(missing_ok=True)
        store.delete_project(project_id)
        broadcaster.publish({"type": "projects-changed"})
        return {"deleted": project_id}

    @router.post("/projects/{project_id}/toggle")
    async def toggle_checklist(project_id: str, payload: ChecklistToggle):
        project = store.get_project(project_id)
        if project is None:
            raise HTTPException(status_code=404, detail="Projekt nicht gefunden")
        project.body = _toggle_checklist_item(project.body, payload.index)
        path = store.save_project_file(project)
        store.index_project_file(path)
        broadcaster.publish({"type": "projects-changed"})
        return _project_dict(store.get_project(project_id))

    # --- project <-> publication linking (issue #50, ADR-0004) ----------------
    @router.post("/projects/{project_id}/publications")
    async def link_publication(project_id: str, payload: PublicationLink):
        """Link a publication to this project from the Project page. The link
        is stored downstream (ADR-0004): this writes the chosen Publication's
        Markdown file, never the project file. Only existing projects and
        publications can be linked here — hanging links are never created by
        the assignment action (free-text editing stays possible via PUT)."""
        if store.get_project(project_id) is None:
            raise HTTPException(status_code=404, detail="Projekt nicht gefunden")
        publication = store.get_publication(payload.publication_id)
        if publication is None:
            raise HTTPException(status_code=404, detail="Veroeffentlichung nicht gefunden")
        if project_id not in publication.projects:
            publication.projects = publication.projects + [project_id]
            path = store.save_publication_file(publication)
            store.index_publication_file(path)
            broadcaster.publish({"type": "publications-changed"})
        return {
            "publications": [
                _publication_summary(p) for p in store.publications_for_project(project_id)
            ]
        }

    @router.delete("/projects/{project_id}/publications/{publication_id}")
    async def unlink_publication(project_id: str, publication_id: str):
        """Remove the project link from the publication's file. An explicit
        user action, not an auto-repair — it works even if the project file no
        longer exists (the publication side is what carries the link)."""
        publication = store.get_publication(publication_id)
        if publication is None:
            raise HTTPException(status_code=404, detail="Veroeffentlichung nicht gefunden")
        if project_id not in publication.projects:
            raise HTTPException(
                status_code=404,
                detail="Veroeffentlichung nicht mit diesem Projekt verknuepft",
            )
        publication.projects = [p for p in publication.projects if p != project_id]
        path = store.save_publication_file(publication)
        store.index_publication_file(path)
        broadcaster.publish({"type": "publications-changed"})
        return {
            "publications": [
                _publication_summary(p) for p in store.publications_for_project(project_id)
            ]
        }

    # --- project documents (projekte/<id>/, issue #49) ------------------------
    def _project_or_404(project_id: str):
        project = store.get_project(project_id)
        if project is None:
            raise HTTPException(status_code=404, detail="Projekt nicht gefunden")
        return project

    @router.get("/projects/{project_id}/documents")
    async def list_project_documents(project_id: str):
        """Directory listing of projekte/<id>/ — externally dropped files
        appear identically to uploaded ones (no frontmatter bookkeeping)."""
        _project_or_404(project_id)
        try:
            return {"documents": documents.list_all(project_id)}
        except ValueError:
            raise HTTPException(status_code=422, detail="Ungueltige Projekt-ID")

    @router.post("/projects/{project_id}/documents")
    async def upload_project_document(project_id: str, file: UploadFile = File(...)):
        """Upload into the project's own subfolder (Atlas writes only its own
        folder, P2). Collisions get a suffix — uploads never overwrite."""
        _project_or_404(project_id)
        data = await file.read()
        try:
            meta = documents.save(project_id, file.filename or "", data)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        broadcaster.publish({"type": "projects-changed"})
        return meta

    @router.post("/projects/{project_id}/documents/{name}/open")
    async def open_project_document(project_id: str, name: str):
        """Open the document with the system viewer on the host machine
        (story 30 — same pattern as the core's POST /api/papers/{id}/open)."""
        _project_or_404(project_id)
        try:
            path = documents.path_for(project_id, name)
        except ValueError:
            raise HTTPException(status_code=422, detail="Ungueltiger Dateiname")
        if not path.is_file():
            raise HTTPException(status_code=404, detail="Dokument nicht gefunden")
        documents.open_in_viewer(path)
        return {"status": "ok"}

    @router.delete("/projects/{project_id}/documents/{name}")
    async def delete_project_document(project_id: str, name: str):
        """Delete one project document (Atlas writes only its own folder, P2)."""
        _project_or_404(project_id)
        try:
            await run_in_threadpool(documents.delete, project_id, name)
        except ValueError:
            raise HTTPException(status_code=422, detail="Ungueltiger Dateiname")
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail="Dokument nicht gefunden")
        except OSError:
            # WinError 32 u. a.: Datei von OneDrive-Sync oder einem Viewer gesperrt.
            raise HTTPException(
                status_code=423,
                detail="Datei ist gesperrt (evtl. OneDrive-Sync oder in einem Programm geöffnet). Bitte schließen und erneut versuchen.",
            )
        broadcaster.publish({"type": "projects-changed"})
        return {"status": "ok"}

    @router.post("/projects/{project_id}/documents/{name}/extract")
    async def extract_project_document_data(
        project_id: str,
        name: str,
        request: Optional[ProjectDocumentExtractRequest] = None,
    ):
        """Proposal-only extraction of project metadata from one PDF document."""
        if llm is None:
            raise HTTPException(status_code=503, detail="LLM-Dienst nicht verfuegbar.")
        _project_or_404(project_id)
        try:
            path = documents.path_for(project_id, name)
        except ValueError:
            raise HTTPException(status_code=422, detail="Ungueltiger Dateiname")
        if path.suffix.lower() != ".pdf":
            raise HTTPException(status_code=400, detail="Nur PDF-Dokumente koennen extrahiert werden")
        if not path.is_file():
            raise HTTPException(status_code=404, detail="Dokument nicht gefunden")
        try:
            text = await run_in_threadpool(project_extraction.extract_pdf_text, path)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        text, warnings = project_extraction.cap_pdf_text(text)
        affiliation = str(request.affiliation or "").strip() if request else ""
        messages = project_extraction.build_extraction_messages(
            path.name, text, affiliation=affiliation
        )
        try:
            llm_request = {"messages": messages, "temperature": 0.0, "timeout": 120}
            model = str(request.model or "").strip() if request else ""
            if model:
                llm_request["model"] = model
            resp = await run_in_threadpool(
                llm.complete,
                llm_request,
            )
        except Exception as exc:  # noqa: BLE001 - LLM failures become gateway errors
            raise HTTPException(status_code=502, detail=f"LLM-Aufruf fehlgeschlagen: {exc}")
        try:
            return project_extraction.parse_extraction_response(
                (resp or {}).get("content", ""),
                warnings=warnings,
            )
        except ValueError as exc:
            raise HTTPException(status_code=502, detail=str(exc))

    # --- Veroeffentlichungen (Publications, ADR-0004) -------------------------
    @router.get("/publications")
    async def list_publications():
        return {"publications": [_publication_dict(p) for p in store.list_publications()]}

    @router.get("/publications/{publication_id}")
    async def get_publication(publication_id: str):
        publication = store.get_publication(publication_id)
        if publication is None:
            raise HTTPException(status_code=404, detail="Veroeffentlichung nicht gefunden")
        data = _publication_dict(publication)
        # Bibliography + paper self-link against the library.
        data["refs_resolved"] = [_resolve_citekey_entry(c) for c in publication.refs]
        data["paper_resolved"] = (
            _resolve_citekey_entry(publication.paper) if publication.paper else None
        )
        # Manuscript links against the manuskripte/ folder (link, not ownership).
        known = {m["id"] for m in manuscripts.list_all()}
        data["manuscripts_resolved"] = [
            {
                "name": name,
                "id": _manuscript_stem(name),
                "found": _manuscript_stem(name) in known,
            }
            for name in publication.manuscripts
        ]
        # derived_from → ideas; projects → research projects (reverse side is
        # derived elsewhere, ADR-0004). Unknown ids are warnings.
        origins = []
        for oid in publication.derived_from:
            idea = store.get_idea(oid)
            if idea is not None:
                origins.append({"id": oid, "kind": "idea", "title": idea.title})
            else:
                origins.append({"id": oid, "kind": "unknown", "title": oid})
        data["origins"] = origins
        projects_resolved = []
        for pid in publication.projects:
            project = store.get_project(pid)
            if project is not None:
                projects_resolved.append({"id": pid, "found": True, "title": project.title})
            else:
                projects_resolved.append({"id": pid, "found": False, "title": pid})
        data["projects_resolved"] = projects_resolved
        return data

    @router.post("/publications")
    async def create_publication(payload: PublicationCreate):
        title = payload.title.strip()
        if not title:
            raise HTTPException(status_code=400, detail="Titel ist erforderlich")
        publication = Publication(
            id="", title=title,
            status=payload.status or "planned",
            venue=payload.venue or None,
            type=payload.type or None,
            authors=payload.authors,
            submitted=payload.submitted or None,
            published=payload.published or None,
            due=payload.due or None,
            tags=payload.tags, refs=payload.refs,
            derived_from=payload.derived_from,
            manuscripts=payload.manuscripts,
            projects=payload.projects,
            paper=payload.paper or None,
            body=payload.body or "",
        )
        base = (payload.id or "").strip() or slugify(title)
        publication.id = _unique_publication_id(store, base)
        path = store.save_publication_file(publication)
        store.index_publication_file(path)
        broadcaster.publish({"type": "publications-changed"})
        return _publication_dict(store.get_publication(publication.id))

    @router.put("/publications/{publication_id}")
    async def update_publication(publication_id: str, payload: PublicationUpdate):
        publication = store.get_publication(publication_id)
        if publication is None:
            raise HTTPException(status_code=404, detail="Veroeffentlichung nicht gefunden")
        changes = payload.model_dump(exclude_unset=True)
        for field in ("title", "status", "venue", "type", "submitted",
                      "published", "due", "paper", "body"):
            if field in changes:
                setattr(publication, field, changes[field])  # None clears the field
        for field in ("authors", "tags", "refs", "derived_from", "manuscripts", "projects"):
            if field in changes and changes[field] is not None:
                setattr(publication, field, changes[field])
        if not (publication.title or "").strip():
            raise HTTPException(status_code=400, detail="Titel ist erforderlich")
        path = store.save_publication_file(publication)
        store.index_publication_file(path)
        broadcaster.publish({"type": "publications-changed"})
        return _publication_dict(store.get_publication(publication_id))

    @router.post("/publications/{publication_id}/refs")
    async def add_publication_refs(publication_id: str, payload: AddRefs):
        """Append cite keys to the publication's refs (deduplicated, order kept).
        Target of the BibTeX import (ADR-0004, moved from the legacy Atlas
        project); an explicit user action, not an LLM write (P4)."""
        publication = store.get_publication(publication_id)
        if publication is None:
            raise HTTPException(status_code=404, detail="Veroeffentlichung nicht gefunden")
        seen = set(publication.refs)
        added = []
        for r in payload.refs:
            if r and r not in seen:
                seen.add(r)
                added.append(r)
        if added:
            publication.refs = publication.refs + added
            path = store.save_publication_file(publication)
            store.index_publication_file(path)
            broadcaster.publish({"type": "publications-changed"})
        return {"added": added, "refs": store.get_publication(publication_id).refs}

    @router.post("/publications/{publication_id}/manuscripts")
    async def link_manuscript(publication_id: str, payload: ManuscriptLink):
        """One-click assignment of a Manuscript to a Publication (issue #45).
        Link, not ownership: the .tex file stays in manuskripte/. Only existing
        manuscripts can be linked here — hanging links are never created by
        the assignment action (free-text editing stays possible via PUT)."""
        publication = store.get_publication(publication_id)
        if publication is None:
            raise HTTPException(status_code=404, detail="Veroeffentlichung nicht gefunden")
        name = payload.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Manuskript-Name ist erforderlich")
        stem = _manuscript_stem(name)
        if stem not in {m["id"] for m in manuscripts.list_all()}:
            raise HTTPException(status_code=404, detail="Manuskript nicht gefunden")
        if stem not in {_manuscript_stem(n) for n in publication.manuscripts}:
            publication.manuscripts = publication.manuscripts + [name]
            path = store.save_publication_file(publication)
            store.index_publication_file(path)
            broadcaster.publish({"type": "publications-changed"})
        return {"manuscripts": store.get_publication(publication_id).manuscripts}

    @router.delete("/publications/{publication_id}/manuscripts/{name}")
    async def unlink_manuscript(publication_id: str, name: str):
        """Remove a manuscript link from the publication. Works for hanging
        links too — removing a link is an explicit user action, not an
        auto-repair (the .tex file itself is never touched)."""
        publication = store.get_publication(publication_id)
        if publication is None:
            raise HTTPException(status_code=404, detail="Veroeffentlichung nicht gefunden")
        stem = _manuscript_stem(name)
        remaining = [n for n in publication.manuscripts if _manuscript_stem(n) != stem]
        if len(remaining) == len(publication.manuscripts):
            raise HTTPException(status_code=404, detail="Manuskript nicht verknuepft")
        publication.manuscripts = remaining
        path = store.save_publication_file(publication)
        store.index_publication_file(path)
        broadcaster.publish({"type": "publications-changed"})
        return {"manuscripts": store.get_publication(publication_id).manuscripts}

    @router.delete("/publications/{publication_id}")
    async def delete_publication(publication_id: str):
        publication = store.get_publication(publication_id)
        if publication is None:
            raise HTTPException(status_code=404, detail="Veroeffentlichung nicht gefunden")
        # Explicit user action: remove the Markdown file, then the index row.
        if publication.path:
            Path(publication.path).unlink(missing_ok=True)
        store.delete_publication(publication_id)
        broadcaster.publish({"type": "publications-changed"})
        return {"deleted": publication_id}

    # --- LLM matching (Phase 4, Abschn. 8) -----------------------------------
    def _require_matching():
        if llm is None or library is None:
            raise HTTPException(
                status_code=503,
                detail="LLM-Matching nicht verfuegbar (kein LLM-/Bibliotheksdienst).",
            )

    def _get_paper(citekey: str) -> dict:
        paper = library.get_reference(citekey)
        if paper is None:
            raise HTTPException(status_code=404, detail=f"Citekey nicht in Bibliothek: {citekey}")
        return paper

    def _llm_json(messages: list[dict], timeout: int = 90) -> str:
        try:
            resp = llm.complete({"messages": messages, "temperature": 0.2, "timeout": timeout})
        except Exception as exc:  # noqa: BLE001 - jede LLM-Stoerung wird zum 502
            raise HTTPException(status_code=502, detail=f"LLM-Aufruf fehlgeschlagen: {exc}")
        return (resp or {}).get("content", "")

    @router.post("/match/pair")
    async def match_pair(payload: MatchPairRequest):
        """F1: 'Ist Paper A fuer Idee B hilfreich, und wo?' — nur Vorschlag,
        geschrieben wird erst bei /ideas/{id}/accept-match (P4)."""
        _require_matching()
        from atlas import matching

        idea = store.get_idea(payload.idea_id)
        if idea is None:
            raise HTTPException(status_code=404, detail="Idee nicht gefunden")
        paper = _get_paper(payload.citekey)
        fulltext = library.get_full_text(payload.citekey) if payload.fulltext else None
        content = _llm_json(matching.build_pair_messages(paper, idea.to_dict(), fulltext))
        try:
            result = matching.parse_match_result(content, idea.anchors)
        except ValueError as exc:
            raise HTTPException(status_code=502, detail=f"LLM-Antwort unbrauchbar: {exc}")
        result["citekey"] = payload.citekey
        result["idea"] = idea.id
        return result

    @router.post("/match/paper")
    async def match_paper(payload: MatchPaperRequest):
        """F2: 'Welche Ideen beruehrt dieses Paper?' — Filter (Embedding, sonst
        lexikalisch) + EIN gebuendelter LLM-Aufruf ueber die Top-k."""
        _require_matching()
        from atlas import matching

        paper = _get_paper(payload.citekey)
        ideas = store.list_ideas()
        if not ideas:
            return {"results": [], "ranking": None}
        idea_dicts = {i.id: i.to_dict() for i in ideas}
        query = matching.paper_text(paper)

        ranking = "embedding"
        try:
            ranked = _embedding_rank_cached(matching, query, ideas)
        except Exception:  # NotImplementedError oder Endpunkt-Fehler -> degradieren
            ranking = "lexikalisch"
            ranked = matching.lexical_rank(query, list(idea_dicts.values()))
        top_ids = [idea_id for idea_id, _score in ranked[: max(1, payload.k)]]
        scores = dict(ranked)

        candidates = [idea_dicts[i] for i in top_ids]
        content = _llm_json(matching.build_batch_messages(paper, candidates), timeout=120)
        anchors_by_id = {i: idea_dicts[i]["anchors"] for i in top_ids}
        try:
            results = matching.parse_batch_result(content, anchors_by_id)
        except ValueError as exc:
            raise HTTPException(status_code=502, detail=f"LLM-Antwort unbrauchbar: {exc}")
        for r in results:
            r["citekey"] = payload.citekey
            r["title"] = idea_dicts[r["idea"]]["title"]
            r["score"] = scores.get(r["idea"])
        return {"results": results, "ranking": ranking}

    def _embedding_rank_cached(matching, query: str, ideas) -> list:
        """Embedding ranking with the hash-invalidated cache in atlas.db.
        Raises when no embedding endpoint is available (caller degrades)."""
        query_vec = llm.embed([query])[0]
        dim = len(query_vec)
        cached: dict[str, list] = {}
        missing = []
        for idea in ideas:
            vec = store.get_embedding(idea.id, idea.content_hash)
            if vec is not None and len(vec) == dim:
                cached[idea.id] = vec
            else:
                missing.append(idea)
        if missing:
            from atlas.matching import idea_text

            vectors = llm.embed([idea_text(i.to_dict()) for i in missing])
            for idea, vec in zip(missing, vectors):
                store.save_embedding(idea.id, idea.content_hash, vec)
                cached[idea.id] = vec
        return matching.embedding_rank(query_vec, cached)

    @router.post("/ideas/{idea_id}/accept-match")
    async def accept_match(idea_id: str, payload: MatchAccept):
        """Expliziter Annahme-Schreibpfad (P4): schreibt den Vorschlag als Block
        unter '## Literatur' der Idee und ergaenzt den Citekey in refs."""
        from atlas import matching

        idea = store.get_idea(idea_id)
        if idea is None:
            raise HTTPException(status_code=404, detail="Idee nicht gefunden")
        citekey = payload.citekey.strip()
        if not citekey:
            raise HTTPException(status_code=400, detail="Citekey ist erforderlich")
        block = matching.format_literature_block(
            citekey,
            (payload.reasoning or "").strip(),
            [u.model_dump() for u in payload.usages],
        )
        idea.body = matching.insert_literature_block(idea.body, block)
        if citekey not in idea.refs:
            idea.refs.append(citekey)
        idea.updated = date.today().isoformat()
        path = store.save_idea_file(idea)
        store.index_file(path)
        broadcaster.publish({"type": "ideas-changed"})
        return _serialize(store.get_idea(idea_id))

    # --- Manuskripte (.tex-Dateien, kein DB-Index — siehe atlas/manuscripts.py) ---

    def _manuscript_or_404(manuscript_id: str) -> dict:
        try:
            data = manuscripts.read(manuscript_id)
        except ValueError:
            raise HTTPException(status_code=422, detail="Ungueltige Manuskript-ID")
        if data is None:
            raise HTTPException(status_code=404, detail="Manuskript nicht gefunden")
        return data

    @router.get("/manuscripts")
    async def list_manuscripts():
        return {"manuscripts": manuscripts.list_all()}

    @router.get("/manuscripts/unassigned")
    async def unassigned_manuscripts():
        """Orphan .tex files: directory listing minus every manuscript linked
        by any publication (issue #45 — no standalone Manuscripts tab, orphans
        stay discoverable via the Publications list)."""
        linked = {
            _manuscript_stem(name)
            for pub in store.list_publications()
            for name in pub.manuscripts
        }
        return {
            "manuscripts": [m for m in manuscripts.list_all() if m["id"] not in linked]
        }

    @router.get("/manuscripts/{manuscript_id}")
    async def get_manuscript(manuscript_id: str):
        return _manuscript_or_404(manuscript_id)

    @router.post("/manuscripts")
    async def create_manuscript(payload: ManuscriptCreate):
        if not payload.title.strip():
            raise HTTPException(status_code=400, detail="Titel ist erforderlich")
        data = manuscripts.create(payload.title)
        broadcaster.publish({"type": "manuscripts-changed"})
        return data

    @router.post("/manuscripts/upload")
    async def upload_manuscript(file: UploadFile = File(...)):
        """Create a manuscript from an uploaded .tex file (e.g. the submitted
        LaTeX of a publication). The id is derived from the filename."""
        name = file.filename or ""
        if not name.lower().endswith(".tex"):
            raise HTTPException(status_code=400, detail="Nur .tex-Dateien koennen hochgeladen werden")
        raw = await file.read()
        try:
            content = raw.decode("utf-8")
        except UnicodeDecodeError:
            content = raw.decode("latin-1")  # LaTeX-Altdateien sind oft latin-1
        data = manuscripts.create_from_upload(name, content)
        broadcaster.publish({"type": "manuscripts-changed"})
        return data

    @router.put("/manuscripts/{manuscript_id}")
    async def save_manuscript(manuscript_id: str, payload: ManuscriptSave):
        _manuscript_or_404(manuscript_id)
        meta = manuscripts.write(manuscript_id, payload.content)
        broadcaster.publish({"type": "manuscripts-changed"})
        return meta

    @router.post("/manuscripts/{manuscript_id}/rename")
    async def rename_manuscript(manuscript_id: str, payload: ManuscriptRename):
        if not payload.title.strip():
            raise HTTPException(status_code=400, detail="Titel ist erforderlich")
        _manuscript_or_404(manuscript_id)
        meta = manuscripts.rename(manuscript_id, payload.title)
        broadcaster.publish({"type": "manuscripts-changed"})
        return meta

    @router.delete("/manuscripts/{manuscript_id}")
    async def delete_manuscript(manuscript_id: str):
        _manuscript_or_404(manuscript_id)
        manuscripts.delete(manuscript_id)
        broadcaster.publish({"type": "manuscripts-changed"})
        return {"deleted": manuscript_id}

    @router.post("/manuscripts/{manuscript_id}/compile")
    async def compile_manuscript(manuscript_id: str):
        """PDF-Vorschau: Manuskript + Bibliotheks-.bib durch Tectonic (Subprozess)."""
        data = _manuscript_or_404(manuscript_id)
        if compiler.find_tectonic() is None:
            raise HTTPException(
                status_code=503,
                detail=(
                    "Tectonic nicht gefunden. Einmalig installieren: Release von "
                    "github.com/tectonic-typesetting/tectonic nach "
                    f"{compiler.app_data_binary()} entpacken (oder TECTONIC_PATH setzen)."
                ),
            )
        # Hosts vor diesem Vertrag haben kein export_bibtex — dann leere Bibliographie.
        exporter = getattr(library, "export_bibtex", None) if library else None
        bibliography = exporter() if exporter else ""
        try:
            pdf = await run_in_threadpool(
                compiler.compile_manuscript, data["content"], bibliography
            )
        except compiler.CompileError as exc:
            raise HTTPException(status_code=422, detail=exc.log)
        return Response(content=pdf, media_type="application/pdf")

    @router.post("/reindex")
    async def reindex():
        stats = store.reindex()
        broadcaster.publish({"type": "archive-changed"})
        return stats

    @router.get("/check")
    async def check():
        return {"report": store.check()}

    @router.get("/events")
    async def events():
        async def gen():
            async for event in broadcaster.subscribe():
                yield f"data: {json.dumps(event)}\n\n"

        return StreamingResponse(
            gen(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # The Werkbank endpoints live in their own modules (issue #180) so this
    # router — the one file on the line-budget allowlist — does not grow.
    router.include_router(build_journal_router(store, broadcaster))
    router.include_router(build_zettel_router(store, broadcaster))
    router.include_router(build_links_router(store))
    return router
