"""Atlas startup migration — legacy ``atlas.project/1|2`` files become
Publications; legacy ``atlas.idea/1`` files become ``atlas.idea/2``; core
paper-grouping projects become ``atlas.project/3`` research projects
(issue #51, via the PluginApi library facade, marker-gated).

ADR-0004: the former Atlas Project entity is conceptually a *publication*, so
legacy files are renamed, not rebuilt: frontmatter is rewritten to
``atlas.publication/1`` and the file moves from ``projekte/`` to
``veroeffentlichungen/``. Status mapping (lossy mappings are listed in the
migration report): ``idea → planned``, ``active → drafting``,
``paused → planned``, ``done → published``.

Idea statuses simplify in v2 (issue #46): ``seed → developing → promoted →
parked``. Legacy ``drafting`` maps to ``developing`` and ``published`` to
``promoted`` — drafting/publishing state lives on the Publication now. Idea
files are rewritten **in place** (no move, ids stay).

Structure (issue #43): a **pure planner** — input: file contents, output: a
``MigrationPlan`` — plus a **thin executor** that backs up the whole Atlas
folder before the first write and applies the plan. Idempotent by
construction: once no legacy files are left, the plan is empty and the
executor writes nothing (and takes no backup).

Legacy ``derived_from`` entries may point at dissertation nodes; they are kept
verbatim — hanging links surface as warnings via ``store.check()`` and are
never auto-repaired (Abschn. 4.4).

Imports only stdlib + Atlas submodules — never the LocalBib core (P3). The
executor writes exclusively into the Atlas folder (P2); ``atlas.db`` is not
touched here — the reindex after activation picks the moved files up.
"""

from __future__ import annotations

import json
import shutil
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Iterable, Optional

from atlas import config
from atlas.domain import (
    IDEA_STATUSES,
    DissNode,
    Idea,
    Project,
    Publication,
    _as_int,
    make_project_id,
    parse_frontmatter,
)

LEGACY_PROJECT_SCHEMAS = frozenset({"atlas.project/1", "atlas.project/2"})
LEGACY_IDEA_SCHEMA = "atlas.idea/1"

# Statuses dropped in atlas.idea/2 — their state lives on the Publication now.
IDEA_STATUS_MAP = {
    "drafting": "developing",
    "published": "promoted",
}

# idea and paused both collapse to "planned" — non-invertible, hence lossy.
STATUS_MAP = {
    "idea": "planned",
    "active": "drafting",
    "paused": "planned",
    "done": "published",
}
LOSSY_STATUSES = frozenset({"idea", "paused"})


@dataclass(frozen=True)
class _LegacyProject:
    """Tolerant view of a legacy atlas.project/1|2 file (the old, pre-ADR-0004
    publication-like shape). Lives here because the migration is the only code
    that still reads it."""

    id: str
    title: str
    status: str
    derived_from: list[str]
    refs: list[str]
    due: Optional[str]
    tags: list[str]
    body: str

    @classmethod
    def from_frontmatter(cls, fm: dict, body: str, *, stem: str) -> "_LegacyProject":
        due = fm.get("due")
        return cls(
            id=str(fm.get("id") or stem),
            title=str(fm.get("title") or ""),
            status=str(fm.get("status") or "idea"),
            derived_from=list(fm.get("derived_from") or []),
            refs=[str(r) for r in (fm.get("refs") or [])],
            due=str(due) if due else None,  # YAML date -> ISO string
            tags=list(fm.get("tags") or []),
            body=body.strip("\n"),
        )


@dataclass(frozen=True)
class MigrationAction:
    """One legacy file: write ``content`` to veroeffentlichungen/``target_name``,
    then delete projekte/``source_name``."""

    source_name: str
    target_name: str
    content: str
    old_status: str
    new_status: str
    lossy: bool


@dataclass
class MigrationPlan:
    actions: list[MigrationAction] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)  # non-legacy files, untouched
    warnings: list[str] = field(default_factory=list)

    @property
    def empty(self) -> bool:
        return not self.actions


def plan_migration(
    files: Iterable[tuple[str, str]],
    existing_publication_ids: Iterable[str],
) -> MigrationPlan:
    """Pure planner. ``files``: ``(filename, text)`` pairs from ``projekte/``;
    ``existing_publication_ids``: stems already taken in ``veroeffentlichungen/``.
    No I/O, no clock — fully deterministic for a given input."""
    plan = MigrationPlan()
    taken = set(existing_publication_ids)
    for name, text in sorted(files):
        try:
            fm, body = parse_frontmatter(text)
        except Exception:
            plan.skipped.append(name)
            plan.warnings.append(
                f"{name}: Frontmatter nicht lesbar — Datei bleibt unangetastet"
            )
            continue
        if fm.get("schema") not in LEGACY_PROJECT_SCHEMAS:
            plan.skipped.append(name)
            continue

        # Parse the legacy /1|/2 shape directly — the Project domain class
        # models the NEW research-project entity (atlas.project/3, ADR-0004)
        # and no longer carries the legacy fields (derived_from, due).
        legacy = _LegacyProject.from_frontmatter(fm, body, stem=Path(name).stem)

        new_id = legacy.id or Path(name).stem
        if new_id in taken:
            base, n = new_id, 2
            while f"{base}-{n}" in taken:
                n += 1
            new_id = f"{base}-{n}"
            plan.warnings.append(
                f"{name}: id '{base}' kollidiert mit bestehender Veroeffentlichung"
                f" — umbenannt zu '{new_id}'"
            )
        taken.add(new_id)

        old_status = legacy.status
        new_status = STATUS_MAP.get(old_status)
        if new_status is None:
            new_status = "planned"
            plan.warnings.append(
                f"{name}: unbekannter Legacy-Status {old_status!r} → 'planned'"
            )
        if not legacy.title:
            plan.warnings.append(
                f"{name}: Legacy-Datei ohne Titel — Veroeffentlichung bleibt invalid"
            )

        publication = Publication(
            id=new_id,
            title=legacy.title,
            status=new_status,
            due=legacy.due,
            tags=list(legacy.tags),
            refs=list(legacy.refs),
            derived_from=list(legacy.derived_from),
            body=legacy.body,
        )
        plan.actions.append(
            MigrationAction(
                source_name=name,
                target_name=f"{new_id}.md",
                content=publication.to_markdown(),
                old_status=old_status,
                new_status=new_status,
                lossy=old_status in LOSSY_STATUSES,
            )
        )
    return plan


def migrate_legacy_projects(*, backup_dir: Optional[Path] = None) -> dict:
    """Thin executor: scan ``projekte/``, plan, back up, apply. Returns the
    migration report (mappings incl. lossy ones, warnings, backup path).

    Idempotent: a second run finds no legacy files, yields an empty plan and
    performs **no** write and **no** backup. The backup (a full copy of the
    Atlas folder, default: sibling directory ``<name>-backup-<timestamp>``) is
    taken before the first write. Per action the new file is written before the
    legacy file is deleted, so an interrupted run never loses data — leftovers
    are migrated on the next startup."""
    projects_dir = config.projects_dir()
    files: list[tuple[str, str]] = []
    if projects_dir.exists():
        files = [
            (p.name, p.read_text(encoding="utf-8"))
            for p in sorted(projects_dir.glob("*.md"))
        ]
    publications_dir = config.publications_dir()
    existing = (
        {p.stem for p in publications_dir.glob("*.md")}
        if publications_dir.exists()
        else set()
    )

    plan = plan_migration(files, existing)
    mappings = [
        {
            "file": a.source_name,
            "from": a.old_status,
            "to": a.new_status,
            "lossy": a.lossy,
        }
        for a in plan.actions
    ]
    report = {
        "migrated": 0,
        "backup": None,
        "mappings": mappings,
        "lossy_mappings": [m for m in mappings if m["lossy"]],
        "warnings": list(plan.warnings),
        "skipped": list(plan.skipped),
    }
    if plan.empty:
        return report

    report["backup"] = str(_backup_atlas_folder(backup_dir))
    publications_dir.mkdir(parents=True, exist_ok=True)
    for action in plan.actions:
        (publications_dir / action.target_name).write_text(
            action.content, encoding="utf-8"
        )
        (projects_dir / action.source_name).unlink()
    report["migrated"] = len(plan.actions)
    return report


# =============================================================================
# Idea migration: atlas.idea/1 -> atlas.idea/2 (issue #46)
# =============================================================================

@dataclass(frozen=True)
class IdeaMigrationAction:
    """One legacy idea file: rewrite ideen/``name`` in place with ``content``
    (schema bumped to atlas.idea/2, status mapped). No move, the id stays."""

    name: str
    content: str
    old_status: str
    new_status: str


@dataclass
class IdeaMigrationPlan:
    actions: list[IdeaMigrationAction] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)  # non-legacy files, untouched
    warnings: list[str] = field(default_factory=list)

    @property
    def empty(self) -> bool:
        return not self.actions


def plan_idea_migration(files: Iterable[tuple[str, str]]) -> IdeaMigrationPlan:
    """Pure planner. ``files``: ``(filename, text)`` pairs from ``ideen/``.
    No I/O, no clock — fully deterministic for a given input.

    Status mapping ``drafting → developing``, ``published → promoted``; the
    other v1 statuses are already valid in v2 and stay. Unknown statuses are
    kept verbatim with a warning (already invalid under /1; validation keeps
    flagging them — never silently "repaired")."""
    plan = IdeaMigrationPlan()
    for name, text in sorted(files):
        try:
            fm, _body = parse_frontmatter(text)
        except Exception:
            plan.skipped.append(name)
            plan.warnings.append(
                f"{name}: Frontmatter nicht lesbar — Datei bleibt unangetastet"
            )
            continue
        if fm.get("schema") != LEGACY_IDEA_SCHEMA:
            plan.skipped.append(name)
            continue

        idea = Idea.from_markdown(text, id_hint=Path(name).stem)
        old_status = idea.status
        new_status = IDEA_STATUS_MAP.get(old_status, old_status)
        if new_status not in IDEA_STATUSES:
            plan.warnings.append(
                f"{name}: unbekannter Legacy-Status {old_status!r} bleibt erhalten"
                " (Datei bleibt invalid)"
            )
        idea.status = new_status
        # to_markdown() serialises with the current IDEA_SCHEMA (atlas.idea/2).
        plan.actions.append(
            IdeaMigrationAction(
                name=name,
                content=idea.to_markdown(),
                old_status=old_status,
                new_status=new_status,
            )
        )
    return plan


def migrate_legacy_ideas(*, backup_dir: Optional[Path] = None) -> dict:
    """Thin executor: scan ``ideen/``, plan, back up, rewrite in place. Returns
    the migration report (status mappings, warnings, backup path).

    Idempotent: a second run finds no ``atlas.idea/1`` files, yields an empty
    plan and performs **no** write and **no** backup. The backup (full copy of
    the Atlas folder, like ``migrate_legacy_projects``) is taken before the
    first write."""
    ideas_dir = config.ideas_dir()
    files: list[tuple[str, str]] = []
    if ideas_dir.exists():
        files = [
            (p.name, p.read_text(encoding="utf-8"))
            for p in sorted(ideas_dir.glob("*.md"))
        ]

    plan = plan_idea_migration(files)
    report = {
        "migrated": 0,
        "backup": None,
        "mappings": [
            {"file": a.name, "from": a.old_status, "to": a.new_status}
            for a in plan.actions
        ],
        "warnings": list(plan.warnings),
        "skipped": list(plan.skipped),
    }
    if plan.empty:
        return report

    report["backup"] = str(_backup_atlas_folder(backup_dir))
    for action in plan.actions:
        (ideas_dir / action.name).write_text(action.content, encoding="utf-8")
    report["migrated"] = len(plan.actions)
    return report


# =============================================================================
# Dissertation flattening: atlas.dissnode/1|2 -> atlas.dissnode/3 (issue #57)
# =============================================================================
# ADR-0005: the dissertation tree (kind/parent, arbitrary nesting) is retired;
# a cumulative dissertation is structurally linear. The migration flattens the
# /2 (and legacy /1) tree DEPTH-FIRST into a single ``order`` sequence and
# drops ``kind`` and ``parent``. This is destructive (nesting cannot be
# reconstructed) — hence the backup, like the other migrations.
#
# Legacy /1 ``paper_ref`` values are preserved as a Markdown note in the body
# (P1: the file is the source of truth, never silently dropped), never
# auto-converted into publication links.

LEGACY_DISSNODE_SCHEMAS = frozenset({"atlas.dissnode/1", "atlas.dissnode/2"})

_PAPER_REF_NOTE = (
    "> Migrationshinweis: fruehere Paper-Referenz `{ref}` (paper_ref) — bitte"
    " manuell als Veroeffentlichung neu verknuepfen."
)


@dataclass(frozen=True)
class _LegacyDissNode:
    """Tolerant view of a legacy /1|/2 dissertation node — the only place that
    still reads ``kind``/``parent``/``paper_ref`` (all dropped in /3)."""

    name: str
    id: str
    title: str
    kind: Optional[str]
    parent: Optional[str]
    order: int
    status: str
    publications: list[str]
    paper_ref: Optional[str]
    body: str


@dataclass(frozen=True)
class DissNodeMigrationAction:
    """One legacy node file: rewrite dissertation/``name`` in place with
    ``content`` (schema bumped to atlas.dissnode/3, flattened ``order``,
    kind/parent dropped). No move, the id stays."""

    name: str
    content: str
    order: int
    dropped_kind: Optional[str]
    dropped_parent: Optional[str]


@dataclass
class DissNodeMigrationPlan:
    actions: list[DissNodeMigrationAction] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)  # non-legacy files, untouched
    warnings: list[str] = field(default_factory=list)
    # Manual-rehang list: every dropped /1 paper_ref value ({file, id, paper_ref}).
    paper_refs: list[dict] = field(default_factory=list)

    @property
    def empty(self) -> bool:
        return not self.actions


def _flatten_depth_first(nodes: list[_LegacyDissNode]) -> list[_LegacyDissNode]:
    """Depth-first pre-order over the parent+order tree (pure). Roots and
    siblings are ordered by ``(order, id)``. Orphan parents and nodes caught in
    a parent cycle are treated as roots so every node appears exactly once."""
    by_id = {n.id: n for n in nodes}

    cyclic: set[str] = set()
    for n in nodes:
        seen = {n.id}
        cur = by_id.get(n.parent) if n.parent else None
        while cur is not None:
            if cur.id in seen:
                cyclic.add(n.id)
                break
            seen.add(cur.id)
            cur = by_id.get(cur.parent) if cur.parent else None

    children: dict[str, list[_LegacyDissNode]] = {n.id: [] for n in nodes}
    roots: list[_LegacyDissNode] = []
    for n in nodes:
        attached = (
            n.parent and n.parent in by_id
            and n.id not in cyclic and n.parent not in cyclic
        )
        if attached:
            children[n.parent].append(n)
        else:
            roots.append(n)

    flat: list[_LegacyDissNode] = []

    def visit(n: _LegacyDissNode) -> None:
        flat.append(n)
        for kid in sorted(children[n.id], key=lambda c: (c.order, c.id)):
            visit(kid)

    for root in sorted(roots, key=lambda n: (n.order, n.id)):
        visit(root)
    return flat


def plan_dissnode_migration(files: Iterable[tuple[str, str]]) -> DissNodeMigrationPlan:
    """Pure planner. ``files``: ``(filename, text)`` pairs from ``dissertation/``.
    No I/O, no clock — fully deterministic for a given input.

    Every ``atlas.dissnode/1|2`` file is flattened into a /3 chapter: the tree
    is walked depth-first, ``order`` is reassigned 0, 1, 2, … in that order, and
    ``kind``/``parent`` are dropped. ``publications`` carry over verbatim; a /1
    ``paper_ref`` is preserved as a body note (never auto-converted)."""
    plan = DissNodeMigrationPlan()
    legacy: list[_LegacyDissNode] = []
    for name, text in sorted(files):
        try:
            fm, body = parse_frontmatter(text)
        except Exception:
            plan.skipped.append(name)
            plan.warnings.append(
                f"{name}: Frontmatter nicht lesbar — Datei bleibt unangetastet"
            )
            continue
        if fm.get("schema") not in LEGACY_DISSNODE_SCHEMAS:
            plan.skipped.append(name)
            continue
        paper_ref = fm.get("paper_ref")
        legacy.append(
            _LegacyDissNode(
                name=name,
                id=str(fm.get("id") or Path(name).stem),
                title=str(fm.get("title") or ""),
                kind=str(fm["kind"]) if fm.get("kind") else None,
                parent=str(fm["parent"]) if fm.get("parent") else None,
                order=_as_int(fm.get("order")),
                status=str(fm.get("status") or "planned"),
                publications=[str(p) for p in (fm.get("publications") or [])],
                paper_ref=str(paper_ref) if paper_ref else None,
                body=body.strip("\n"),
            )
        )

    for new_order, node in enumerate(_flatten_depth_first(legacy)):
        body = node.body
        if node.paper_ref:
            plan.paper_refs.append(
                {"file": node.name, "id": node.id, "paper_ref": node.paper_ref}
            )
            note = _PAPER_REF_NOTE.format(ref=node.paper_ref)
            body = f"{body.rstrip()}\n\n{note}" if body.strip() else note
        chapter = DissNode(
            id=node.id,
            title=node.title,
            order=new_order,
            status=node.status,
            publications=list(node.publications),
            body=body,
        )
        # to_markdown() serialises with the current DISSNODE_SCHEMA (/3).
        plan.actions.append(
            DissNodeMigrationAction(
                name=node.name,
                content=chapter.to_markdown(),
                order=new_order,
                dropped_kind=node.kind,
                dropped_parent=node.parent,
            )
        )
    return plan


def migrate_legacy_dissnodes(*, backup_dir: Optional[Path] = None) -> dict:
    """Thin executor: scan ``dissertation/``, plan, back up, rewrite in place.
    Returns the migration report (flattening map, paper_ref warning list,
    warnings, backup).

    Idempotent: a second run finds no ``atlas.dissnode/1|2`` files (all are /3
    now), yields an empty plan and performs **no** write and **no** backup. The
    backup (full copy of the Atlas folder, like the other migrations) is taken
    before the first write."""
    diss_dir = config.diss_dir()
    files: list[tuple[str, str]] = []
    if diss_dir.exists():
        files = [
            (p.name, p.read_text(encoding="utf-8"))
            for p in sorted(diss_dir.glob("*.md"))
        ]

    plan = plan_dissnode_migration(files)
    report = {
        "migrated": 0,
        "backup": None,
        "mappings": [
            {
                "file": a.name,
                "order": a.order,
                "kind": a.dropped_kind,
                "parent": a.dropped_parent,
            }
            for a in plan.actions
        ],
        "paper_refs": list(plan.paper_refs),
        "warnings": list(plan.warnings),
        "skipped": list(plan.skipped),
    }
    if plan.empty:
        return report

    report["backup"] = str(_backup_atlas_folder(backup_dir))
    for action in plan.actions:
        (diss_dir / action.name).write_text(action.content, encoding="utf-8")
    report["migrated"] = len(plan.actions)
    return report


# =============================================================================
# Core project migration: core paper groupings -> atlas.project/3 (issue #51)
# =============================================================================
# ADR-0004: the core SQLite Projects (projects + paper_projects) are migrated
# into Atlas research projects. Data arrives exclusively through the PluginApi
# library facade (``get_core_projects``, P3 — Atlas never reads core SQLite);
# the core rows stay untouched as dead data (no deletion of user data at
# startup). Unlike the file migrations above, the source does not disappear on
# apply, so idempotence needs a marker: a one-shot marker file in the Atlas
# folder (NOT in atlas.db — the index is wipeable and rebuilt, the marker must
# survive a reindex). The marker is written only after an actual migration; a
# run that finds no core projects writes nothing and stays retryable.

CORE_MIGRATION_MARKER_NAME = ".core-projects-migrated.json"


def core_migration_marker() -> Path:
    return config.base_dir() / CORE_MIGRATION_MARKER_NAME


@dataclass(frozen=True)
class CoreProjectAction:
    """One core project: write ``content`` to projekte/``target_name``."""

    core_id: int
    name: str
    target_name: str
    content: str


@dataclass
class CoreProjectMigrationPlan:
    actions: list[CoreProjectAction] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def empty(self) -> bool:
        return not self.actions


def plan_core_project_migration(
    core_projects: Iterable[dict],
    existing_project_ids: Iterable[str],
) -> CoreProjectMigrationPlan:
    """Pure planner. ``core_projects``: wire dicts from the library facade
    (``{id, name, description, refs}``); ``existing_project_ids``: stems already
    taken in ``projekte/``. No I/O, no clock — deterministic for a given input.

    Each core project becomes one ``atlas.project/3`` research project:
    ``title`` = name, ``refs`` = the grouped papers' Cite Keys (de-duplicated,
    order preserved), ``body`` = the core description. Status is ``active`` —
    core groupings carry no lifecycle and were in live use. The core colour has
    no Atlas counterpart and is dropped. Id collisions (with existing Atlas
    projects or within the batch) get a ``-2``/``-3``… suffix plus a warning."""
    plan = CoreProjectMigrationPlan()
    taken = set(existing_project_ids)
    for core in sorted(
        core_projects, key=lambda c: (str(c.get("name") or ""), str(c.get("id")))
    ):
        core_id = core.get("id")
        name = str(core.get("name") or "")
        new_id = make_project_id(name)
        if not new_id:
            new_id = f"projekt-{core_id}"
            plan.warnings.append(
                f"Kern-Projekt {core_id} ({name!r}): Name ergibt keinen Slug"
                f" — id '{new_id}'"
            )
        if not name:
            plan.warnings.append(
                f"Kern-Projekt {core_id}: ohne Namen — Projekt bleibt invalid"
            )
        if new_id in taken:
            base, n = new_id, 2
            while f"{base}-{n}" in taken:
                n += 1
            new_id = f"{base}-{n}"
            plan.warnings.append(
                f"Kern-Projekt {core_id} ({name!r}): id '{base}' kollidiert mit"
                f" bestehendem Atlas-Projekt — umbenannt zu '{new_id}'"
            )
        taken.add(new_id)

        refs: list[str] = []
        for ref in core.get("refs") or []:
            key = str(ref)
            if key and key not in refs:
                refs.append(key)

        project = Project(
            id=new_id,
            title=name,
            status="active",
            refs=refs,
            body=str(core.get("description") or "").strip(),
        )
        plan.actions.append(
            CoreProjectAction(
                core_id=core_id,
                name=name,
                target_name=f"{new_id}.md",
                content=project.to_markdown(),
            )
        )
    return plan


def migrate_core_projects(library, *, backup_dir: Optional[Path] = None) -> dict:
    """Thin executor: read core projects via the PluginApi library facade,
    plan, back up, write ``projekte/*.md``, then drop the marker. Returns the
    migration report (mappings, warnings, backup + marker paths).

    Idempotent via the marker: once it exists every later run is a no-op —
    even if the user deletes a migrated Atlas project file, it is never
    recreated. Core tables are never written (the facade is read-only, P3);
    the marker lives in the Atlas folder (P2). A run without core projects
    writes nothing (no backup, no marker). ``library`` may be ``None`` or
    predate ``get_core_projects`` — then nothing happens beyond a warning."""
    report = {
        "migrated": 0,
        "backup": None,
        "marker": None,
        "already_migrated": False,
        "mappings": [],
        "warnings": [],
    }
    marker = core_migration_marker()
    if marker.exists():
        report["already_migrated"] = True
        report["marker"] = str(marker)
        return report

    getter = getattr(library, "get_core_projects", None)
    if getter is None:
        report["warnings"].append(
            "Kern-Bibliothek bietet keinen Projekt-Lesezugriff"
            " (get_core_projects) — Kern-Projekte nicht migriert"
        )
        return report

    projects_dir = config.projects_dir()
    existing = (
        {p.stem for p in projects_dir.glob("*.md")} if projects_dir.exists() else set()
    )
    plan = plan_core_project_migration(list(getter() or []), existing)
    report["mappings"] = [
        {"core_id": a.core_id, "name": a.name, "file": a.target_name}
        for a in plan.actions
    ]
    report["warnings"].extend(plan.warnings)
    if plan.empty:
        return report

    report["backup"] = str(_backup_atlas_folder(backup_dir))
    projects_dir.mkdir(parents=True, exist_ok=True)
    for action in plan.actions:
        (projects_dir / action.target_name).write_text(
            action.content, encoding="utf-8"
        )
    marker.write_text(
        json.dumps(
            {
                "migrated_at": datetime.now().isoformat(timespec="seconds"),
                "mappings": report["mappings"],
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    report["marker"] = str(marker)
    report["migrated"] = len(plan.actions)
    return report


def _backup_atlas_folder(target: Optional[Path] = None) -> Path:
    """Copy the whole Atlas folder. Default target is a *sibling* directory
    (never inside the archive, so neither watcher nor indexer ever see it)."""
    base = config.base_dir()
    if target is None:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        target = base.parent / f"{base.name}-backup-{stamp}"
        n = 2
        while target.exists():
            target = base.parent / f"{base.name}-backup-{stamp}-{n}"
            n += 1
    shutil.copytree(base, target)
    return target
