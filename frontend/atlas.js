// atlas — the frontend of the Atlas Bundle (Add-on Contract 2, #192).
//
// One script per Bundle. It holds every Atlas view (Heute, Woche, Rueckblick,
// Sammlung, Zettel, the LaTeX editor) and the four slot components the core
// renders while Atlas is active: the project filter of the item list, the
// aside of the item detail (links + the two LLM actions), the dissertation
// context of the Research Chat and the Atlas settings. It talks to the core
// only through window.LocalBib (Vue, api, registerPlugin) and the browser
// globals the core page already loads (CodeMirror, EventSource). The stex mode
// and the show-hint addon of CodeMirror are assets of this Bundle
// (frontend/vendor/codemirror/), loaded by the core before this script.
//
// UI texts are German and hardcoded, like before the move: Atlas is exempt
// from the core i18n (CLAUDE.md, "UI language"); its own locale file carries
// only the keys the core resolves (nav label, settings field).
(function () {
'use strict';
const LB = window.LocalBib;
if (!LB || typeof LB.registerPlugin !== 'function') return;
const { ref, reactive, computed, watch } = LB.Vue;
const api = LB.api;

// --- Atlas plugin view: Ideen-Board (Phase 1) -------------------------------

// atlas.idea/2 (ADR-0004, Issue #46): Entwurfs-/Publikationsstatus lebt auf der
// Veröffentlichung — „Ausgearbeitet" (promoted) heißt: daraus ist eine entstanden.
const ATLAS_STATUSES = [
    { key: 'seed', label: 'Seed' },
    { key: 'developing', label: 'In Arbeit' },
    { key: 'promoted', label: 'Ausgearbeitet' },
    { key: 'parked', label: 'Geparkt' },
];

const ATLAS_TYPES = [
    { key: 'paper-idea', label: 'Paper' },
    { key: 'tool-idea', label: 'Tool' },
    { key: 'experiment', label: 'Experiment' },
];

const ATLAS_TYPE_CLASS = {
    'paper-idea': 'bg-accent-soft text-accent-ink',
    'tool-idea': 'bg-blue-100 text-blue-800',
    'experiment': 'bg-emerald-100 text-emerald-800',
};

// LLM matching verdicts (schema atlas.match-result/1) — shared by the idea
// drawer (F1) and the paper detail reverse search (F2).
const ATLAS_VERDICT_LABEL = { relevant: 'Relevant', maybe: 'Vielleicht', irrelevant: 'Irrelevant' };
const ATLAS_VERDICT_CLASS = {
    relevant: 'bg-emerald-100 text-emerald-800',
    maybe: 'bg-amber-100 text-amber-800',
    irrelevant: 'bg-bg-soft text-ink-3',
};
function atlasVerdictLabel(v) { return ATLAS_VERDICT_LABEL[v] || v; }
function atlasVerdictClass(v) { return ATLAS_VERDICT_CLASS[v] || 'bg-bg-soft text-ink-3'; }

const DISS_KINDS = [
    { key: 'part', label: 'Teil' },
    { key: 'chapter', label: 'Kapitel' },
    { key: 'section', label: 'Abschnitt' },
    { key: 'paper-slot', label: 'Paper-Slot' },
];

const DISS_STATUSES = [
    { key: 'planned', label: 'Geplant' },
    { key: 'in-progress', label: 'In Arbeit' },
    { key: 'submitted', label: 'Eingereicht' },
    { key: 'published', label: 'Veröffentlicht' },
];

const DISS_STATUS_CLASS = {
    'planned': 'bg-bg-soft text-ink-3',
    'in-progress': 'bg-blue-100 text-blue-800',
    'submitted': 'bg-amber-100 text-amber-800',
    'published': 'bg-emerald-100 text-emerald-800',
};

// Forschungsprojekte (atlas.project/3, ADR-0004)
const PROJECT_STATUSES = [
    { key: 'planned', label: 'Geplant' },
    { key: 'applied', label: 'Beantragt' },
    { key: 'active', label: 'Aktiv' },
    { key: 'finished', label: 'Abgeschlossen' },
    { key: 'rejected', label: 'Abgelehnt' },
];

const PROJECT_STATUS_CLASS = {
    'planned': 'bg-bg-soft text-ink-3',
    'applied': 'bg-amber-100 text-amber-800',
    'active': 'bg-blue-100 text-blue-800',
    'finished': 'bg-emerald-100 text-emerald-800',
    'rejected': 'bg-red-100 text-red-800',
};

// Active lifecycle statuses (shown as full dashboard tiles).
const PROJECT_ACTIVE_STATUSES = new Set(['planned', 'applied', 'active']);

/**
 * Compute the runtime bar for a research project — pure helper.
 *
 * @param {string} start  ISO date of Laufzeit start (e.g. "2025-01-01")
 * @param {string} end    ISO date of Laufzeit end   (e.g. "2027-12-31")
 * @param {Date}  [today] Reference date (defaults to new Date() — injected for tests)
 * @returns {{ elapsed: number, total: number, fraction: number, label: string }|null}
 *   elapsed/total in calendar months; fraction is the today-marker position [0, 1].
 *   Returns null when start or end is missing / invalid or end ≤ start.
 */
function projRuntimeBar(start, end, today) {
    if (!start || !end) return null;
    const s = new Date(start + 'T00:00:00');
    const e = new Date(end + 'T00:00:00');
    const t = today || new Date();
    if (isNaN(s.getTime()) || isNaN(e.getTime()) || e <= s) return null;
    const fraction = Math.max(0, Math.min(1, (t - s) / (e - s)));
    const sy = s.getFullYear(), sm = s.getMonth();
    const ey = e.getFullYear(), em = e.getMonth();
    const ty = t.getFullYear(), tm = t.getMonth();
    const total   = (ey - sy) * 12 + (em - sm) + 1;
    const elapsed = Math.max(0, Math.min(total, (ty - sy) * 12 + (tm - sm) + 1));
    return { elapsed, total, fraction, label: `Monat ${elapsed}/${total}` };
}
// Expose for vitest (the file is a browser script without ES exports).
if (typeof window !== 'undefined') window._projRuntimeBar = projRuntimeBar;

function mergeProjectBodyExtraction(currentBody, workpackageMarkdown) {
    const block = String(workpackageMarkdown || '').trim();
    const current = String(currentBody || '');
    if (!block) return current;
    return current.trim() ? `${current}\n\n${block}` : block;
}
if (typeof window !== 'undefined') window._mergeProjectBodyExtraction = mergeProjectBodyExtraction;

// Veroeffentlichungen (atlas.publication/1, ADR-0004)
const PUBLICATION_STATUSES = [
    { key: 'planned', label: 'Geplant' },
    { key: 'drafting', label: 'Entwurf' },
    { key: 'submitted', label: 'Eingereicht' },
    { key: 'in-revision', label: 'In Revision' },
    { key: 'published', label: 'Veröffentlicht' },
    { key: 'rejected', label: 'Abgelehnt' },
    { key: 'withdrawn', label: 'Zurückgezogen' },
];

const PUBLICATION_STATUS_CLASS = {
    'planned': 'bg-bg-soft text-ink-3',
    'drafting': 'bg-blue-100 text-blue-800',
    'submitted': 'bg-amber-100 text-amber-800',
    'in-revision': 'bg-purple-100 text-purple-800',
    'published': 'bg-emerald-100 text-emerald-800',
    'rejected': 'bg-red-100 text-red-800',
    'withdrawn': 'bg-bg-soft text-ink-3',
};

const PUBLICATION_TYPES = [
    { key: 'journal-article', label: 'Journal-Artikel' },
    { key: 'conference-paper', label: 'Konferenz-Paper' },
    { key: 'book-chapter', label: 'Buchkapitel' },
    { key: 'other', label: 'Sonstiges' },
];

// Safe Markdown renderer for idea bodies: headings, paragraphs, ordered/
// unordered lists, GFM task lists, blockquotes, code (inline + fenced), links,
// bold/italic, horizontal rules. Escapes HTML first — no raw markup passes through.
function renderAtlasMarkdown(src) {
    if (!src) return '';
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Verweise zuerst: `[[id]]` / `[[id|Anzeige]]` wird ein Chip mit dem Titel
    // der Entität, kein roher Klammerausdruck (Story 39). Vor der Markdown-
    // Linkregel, damit die die doppelte Klammer nie zu fassen bekommt.
    const attr = (s) => esc(s).replace(/"/g, '&quot;');
    const wiki = (s) => s.replace(/\[\[([^\[\]|]+?)(?:\|([^\[\]]*))?\]\]/g, (_m, id, alias) => {
        const key = String(id).trim();
        const entity = atlasEntity(key);
        const href = atlasEntityHref(key);
        const text = esc((alias && alias.trim()) || (entity && entity.title) || key);
        if (!href) return `<span class="atlas-wiki is-dangling" title="Unbekannter Verweis: ${attr(key)}">${text}</span>`;
        return `<a href="${attr(href)}" class="atlas-wiki" title="${attr(key)}">${text}</a>`;
    });
    const inline = (s) => wiki(esc(s))
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="text-accent-ink underline">$1</a>')
        .replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+?)\*/g, '<em>$1</em>')
        .replace(/`([^`]+?)`/g, '<code class="px-1 py-0.5 rounded bg-bg-soft font-mono text-[0.85em]">$1</code>');

    let html = '';
    let listType = null;            // 'ul' | 'ol' | null
    const closeList = () => { if (listType) { html += listType === 'ul' ? '</ul>' : '</ol>'; listType = null; } };
    let inFence = false;
    let fence = [];
    const flushFence = () => {
        html += `<pre class="bg-bg-soft rounded-lg p-3 my-3 overflow-x-auto text-xs font-mono leading-relaxed">${esc(fence.join('\n'))}</pre>`;
        fence = [];
    };

    for (const raw of src.split(/\r?\n/)) {
        const line = raw.replace(/\s+$/, '');
        if (line.trim().startsWith('```')) {
            if (inFence) { flushFence(); inFence = false; }
            else { closeList(); inFence = true; }
            continue;
        }
        if (inFence) { fence.push(raw); continue; }

        let m;
        if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
            closeList();
            const lvl = m[1].length;
            const cls = lvl <= 1 ? 'text-2xl font-semibold font-serif mt-5 mb-2'
                : lvl === 2 ? 'text-xl font-semibold font-serif mt-5 mb-2'
                : 'text-base font-semibold mt-4 mb-1.5';
            html += `<h${lvl} class="${cls} text-ink">${inline(m[2])}</h${lvl}>`;
        } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
            closeList();
            html += '<hr class="my-4 border-hairline">';
        } else if ((m = line.match(/^>\s?(.*)$/))) {
            closeList();
            html += `<blockquote class="border-l-2 border-hairline-2 pl-3 my-2 text-ink-3 italic">${inline(m[1])}</blockquote>`;
        } else if ((m = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/))) {
            if (listType !== 'ul') { closeList(); html += '<ul class="my-2 space-y-1">'; listType = 'ul'; }
            const checked = m[1].toLowerCase() === 'x';
            html += `<li class="flex items-start gap-2 list-none"><span class="mt-px select-none">${checked ? '☑' : '☐'}</span><span>${inline(m[2])}</span></li>`;
        } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
            if (listType !== 'ul') { closeList(); html += '<ul class="list-disc pl-5 my-2 space-y-1">'; listType = 'ul'; }
            html += `<li>${inline(m[1])}</li>`;
        } else if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
            if (listType !== 'ol') { closeList(); html += '<ol class="list-decimal pl-5 my-2 space-y-1">'; listType = 'ol'; }
            html += `<li>${inline(m[1])}</li>`;
        } else if (line.trim() === '') {
            closeList();
        } else {
            closeList();
            html += `<p class="my-2.5 leading-relaxed">${inline(line)}</p>`;
        }
    }
    if (inFence && fence.length) flushFence();
    closeList();
    return html;
}

// =============================================================================
// Atlas: LaTeX-Editor (Manuskripte) — CodeMirror 5 buildless, PRD-latex-editor
// =============================================================================

const AtlasEditor = {
    props: { initialId: { type: String, default: null } },
    template: `
    <div class="flex gap-4" style="height: calc(100vh - 230px); min-height: 420px;">
        <!-- Manuskript-Liste -->
        <aside class="w-60 flex-shrink-0 overflow-y-auto pr-1">
            <button @click="createManuscript"
                    class="w-full mb-3 bg-accent text-white px-3 py-2 rounded-lg text-sm font-medium hover:bg-accent-ink transition-colors">
                + Neues Manuskript
            </button>
            <p v-if="!manuscripts.length" class="text-xs text-mute italic px-1">Noch keine Manuskripte</p>
            <button v-for="m in manuscripts" :key="m.id" @click="open(m.id)"
                    class="w-full text-left px-3 py-2 rounded-lg text-sm mb-1 border transition-colors"
                    :class="m.id === currentId ? 'border-accent text-accent-ink font-medium' : 'border-transparent text-ink-2 hover:border-hairline'"
                    :style="m.id === currentId ? 'background: var(--lb-accent-soft);' : ''">
                <span class="block truncate lb-mono" style="font-size: 12px;">{{ m.id }}.tex</span>
            </button>
        </aside>

        <!-- Editor -->
        <div class="flex-1 min-w-0 flex flex-col border border-hairline rounded-xl overflow-hidden" style="background: var(--lb-bg-elev);">
            <div v-if="currentId" class="flex items-center gap-3 px-3 py-2 border-b border-hairline flex-shrink-0">
                <span class="lb-mono text-xs text-ink-2 truncate">{{ currentId }}.tex</span>
                <span class="text-[11px]" :style="{ color: saveState === 'error' ? 'var(--lb-danger)' : 'var(--lb-mute)' }">{{ saveLabel }}</span>
                <div class="flex-1"></div>
                <button @click="exportBib" class="text-xs text-ink-3 hover:text-ink transition-colors" title="Bibliothek als .bib herunterladen">.bib exportieren</button>
                <button @click="renameManuscript" class="text-xs text-ink-3 hover:text-ink transition-colors">Umbenennen</button>
                <button @click="deleteManuscript" class="text-xs text-ink-3 hover:text-red-600 transition-colors">Löschen</button>
                <button @click="compile" :disabled="compiling"
                        class="bg-accent text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-accent-ink disabled:opacity-50 transition-colors">
                    {{ compiling ? 'Kompiliert…' : 'Vorschau' }}
                </button>
            </div>
            <!-- Formatierungs-Toolbar -->
            <div v-if="currentId" class="flex items-center gap-0.5 px-2 py-1 border-b border-hairline flex-shrink-0 flex-wrap">
                <select @change="onHeadingSelect" class="lb-tbtn" title="Überschrift einfügen">
                    <option value="">Überschrift</option>
                    <option value="section">Abschnitt</option>
                    <option value="subsection">Unterabschnitt</option>
                    <option value="subsubsection">Unter-Unterabschnitt</option>
                    <option value="paragraph">Absatz-Titel</option>
                </select>
                <span class="lb-tdiv"></span>
                <button @click="cmd('bold')" class="lb-tbtn font-bold" title="Fett (Strg+B)">B</button>
                <button @click="cmd('italic')" class="lb-tbtn italic font-serif" title="Kursiv (Strg+I)">I</button>
                <button @click="cmd('mono')" class="lb-tbtn lb-mono" title="Nichtproportional (\\texttt)">tt</button>
                <span class="lb-tdiv"></span>
                <button @click="cmd('itemize')" class="lb-tbtn" title="Aufzählung (itemize)">• Liste</button>
                <button @click="cmd('enumerate')" class="lb-tbtn" title="Nummerierte Liste (enumerate)">1. Liste</button>
                <span class="lb-tdiv"></span>
                <button @click="cmd('math')" class="lb-tbtn italic font-serif" title="Formel im Text ($…$)">x²</button>
                <button @click="cmd('equation')" class="lb-tbtn" title="Abgesetzte Formel (equation)">∑ Formel</button>
                <span class="lb-tdiv"></span>
                <button @click="cmd('figure')" class="lb-tbtn" title="Abbildung (figure) einfügen">Abbildung</button>
                <button @click="cmd('table')" class="lb-tbtn" title="Tabelle (table + booktabs) einfügen">Tabelle</button>
                <span class="lb-tdiv"></span>
                <button @click="cmd('cite')" class="lb-tbtn" title="Zitat einfügen — mit Autovervollständigung aus der Bibliothek">Zitat</button>
                <button @click="cmd('ref')" class="lb-tbtn" title="Querverweis (\\ref)">Verweis</button>
                <button @click="cmd('footnote')" class="lb-tbtn" title="Fußnote">Fußnote</button>
                <span class="lb-tdiv"></span>
                <button @click="cmd('comment')" class="lb-tbtn" title="Zeile(n) auskommentieren (Strg+/)">%</button>
            </div>
            <div v-show="currentId" class="flex-1 min-h-0" ref="cmHost"></div>
            <div v-if="!currentId" class="flex-1 flex items-center justify-center text-sm text-mute">
                Manuskript wählen oder neu anlegen
            </div>
        </div>

        <!-- PDF-Vorschau -->
        <div v-if="previewUrl || compileError" class="flex-1 min-w-0 border border-hairline rounded-xl overflow-hidden flex flex-col" style="background: var(--lb-bg-elev);">
            <div class="flex items-center px-3 py-2 border-b border-hairline flex-shrink-0">
                <span class="text-xs font-medium text-ink-2">Vorschau</span>
                <div class="flex-1"></div>
                <button @click="closePreview" class="text-mute hover:text-ink leading-none">×</button>
            </div>
            <iframe v-if="previewUrl" :src="previewUrl" class="flex-1 w-full" style="border: 0;"></iframe>
            <pre v-else class="flex-1 overflow-auto text-xs p-3 whitespace-pre-wrap" style="color: var(--lb-danger);">{{ compileError }}</pre>
        </div>
    </div>`,
    data() {
        return {
            manuscripts: [],
            currentId: null,
            papers: [],
            saveState: 'saved',   // saved | dirty | saving | error
            compiling: false,
            previewUrl: null,
            compileError: null,
        };
    },
    computed: {
        saveLabel() {
            return { saved: 'gespeichert', dirty: 'ungespeichert…', saving: 'speichert…', error: 'Speichern fehlgeschlagen' }[this.saveState];
        },
    },
    async mounted() {
        this._cm = null;
        this._saveTimer = null;
        this._suppress = false;
        await this.loadList();
        try { this.papers = await api('/api/papers'); } catch (e) { console.error(e); }
        this.initEditor();
        const wanted = this.initialId && this.manuscripts.some((m) => m.id === this.initialId)
            ? this.initialId
            : (this.manuscripts.length ? this.manuscripts[0].id : null);
        if (wanted) await this.open(wanted);
    },
    beforeUnmount() {
        this.flushSave();
        this.closePreview();
    },
    methods: {
        async loadList() {
            try {
                this.manuscripts = (await api('/api/plugins/atlas/manuscripts')).manuscripts;
            } catch (e) { console.error(e); }
        },
        initEditor() {
            if (typeof CodeMirror === 'undefined') {
                console.error('CodeMirror nicht geladen (CDN)');
                return;
            }
            this._cm = CodeMirror(this.$refs.cmHost, {
                value: '',
                mode: 'stex',
                lineNumbers: true,
                lineWrapping: true,
                viewportMargin: 50,
                extraKeys: {
                    'Ctrl-B': () => this.cmd('bold'),
                    'Ctrl-I': () => this.cmd('italic'),
                    'Ctrl-/': () => this.cmd('comment'),
                },
            });
            this._cm.on('change', () => {
                if (this._suppress) return;
                this.saveState = 'dirty';
                clearTimeout(this._saveTimer);
                this._saveTimer = setTimeout(() => this.save(), 1200);
            });
            // \\cite{...}-Autocomplete: Dropdown sobald innerhalb der Klammer getippt wird
            this._cm.on('inputRead', (cm, change) => {
                if (change.text.length !== 1) return;
                const ch = change.text[0];
                if (ch === '{' || /[\w,]/.test(ch)) {
                    const line = cm.getLine(cm.getCursor().line).slice(0, cm.getCursor().ch);
                    if (/\\[a-zA-Z]*cite[a-zA-Z*]*\{[^}]*$/.test(line)) {
                        cm.showHint({ hint: this.citeHint, completeSingle: false });
                    }
                }
            });
        },
        // --- Formatierungs-Toolbar -------------------------------------------
        cmd(name) {
            if (!this._cm || !this.currentId) return;
            switch (name) {
                case 'bold': return this.wrapSelection('\\textbf{', '}');
                case 'italic': return this.wrapSelection('\\textit{', '}');
                case 'mono': return this.wrapSelection('\\texttt{', '}');
                case 'math': return this.wrapSelection('$', '$');
                case 'footnote': return this.wrapSelection('\\footnote{', '}');
                case 'ref': return this.wrapSelection('\\ref{', '}');
                case 'cite': return this.insertCite();
                case 'comment': return this.toggleComment();
                case 'itemize': return this.insertBlock(
                    ['\\begin{itemize}', '    \\item ', '\\end{itemize}'], { line: 1, ch: 999 });
                case 'enumerate': return this.insertBlock(
                    ['\\begin{enumerate}', '    \\item ', '\\end{enumerate}'], { line: 1, ch: 999 });
                case 'equation': return this.insertBlock(
                    ['\\begin{equation}', '    ', '\\end{equation}'], { line: 1, ch: 999 });
                case 'figure': return this.insertBlock([
                    '\\begin{figure}[htbp]',
                    '    \\centering',
                    '    \\includegraphics[width=\\linewidth]{}',
                    '    \\caption{}',
                    '    \\label{fig:}',
                    '\\end{figure}'], { line: 2, ch: -1 });
                case 'table': return this.insertBlock([
                    '\\begin{table}[htbp]',
                    '    \\centering',
                    '    \\caption{}',
                    '    \\label{tab:}',
                    '    \\begin{tabular}{lll}',
                    '        \\toprule',
                    '         &  & \\\\',
                    '        \\midrule',
                    '         &  & \\\\',
                    '        \\bottomrule',
                    '    \\end{tabular}',
                    '\\end{table}'], { line: 2, ch: -1 });
            }
        },
        onHeadingSelect(ev) {
            const level = ev.target.value;
            ev.target.value = '';
            if (level) this.wrapSelection('\\' + level + '{', '}');
        },
        wrapSelection(before, after) {
            const cm = this._cm;
            cm.focus();
            const sel = cm.getSelection();
            if (sel) {
                cm.replaceSelection(before + sel + after);
            } else {
                const cur = cm.getCursor();
                cm.replaceRange(before + after, cur);
                cm.setCursor({ line: cur.line, ch: cur.ch + before.length });
            }
        },
        insertBlock(lines, cursor) {
            // Fuegt den Block hinter der aktuellen Zeile ein; cursor.ch < 0 zaehlt
            // vom Zeilenende (-1 = vor dem letzten Zeichen), zu grosse Werte clippt CM.
            const cm = this._cm;
            cm.focus();
            const cur = cm.getCursor();
            const lineText = cm.getLine(cur.line);
            const onOwnLine = lineText.trim() === '';
            const text = onOwnLine ? lines.join('\n') + '\n' : '\n' + lines.join('\n') + '\n';
            cm.replaceRange(text, { line: cur.line, ch: lineText.length });
            const targetLine = cur.line + cursor.line + (onOwnLine ? 0 : 1);
            const len = cm.getLine(targetLine).length;
            const ch = cursor.ch < 0 ? Math.max(0, len + cursor.ch) : cursor.ch;
            cm.setCursor({ line: targetLine, ch });
        },
        insertCite() {
            this.wrapSelection('\\cite{', '}');
            this._cm.showHint({ hint: this.citeHint, completeSingle: false });
        },
        toggleComment() {
            const cm = this._cm;
            cm.focus();
            const from = cm.getCursor('from');
            const to = cm.getCursor('to');
            // Selektion bis Spalte 0 der Folgezeile: die Folgezeile nicht anfassen
            const end = to.line > from.line && to.ch === 0 ? to.line - 1 : to.line;
            let allCommented = true;
            for (let l = from.line; l <= end; l++) {
                if (!/^\s*%/.test(cm.getLine(l))) { allCommented = false; break; }
            }
            cm.operation(() => {
                for (let l = from.line; l <= end; l++) {
                    if (allCommented) {
                        const m = cm.getLine(l).match(/^(\s*)% ?/);
                        if (m) cm.replaceRange('', { line: l, ch: m[1].length }, { line: l, ch: m[0].length });
                    } else {
                        cm.replaceRange('% ', { line: l, ch: 0 });
                    }
                }
            });
        },
        citeHint(cm) {
            const cursor = cm.getCursor();
            const line = cm.getLine(cursor.line).slice(0, cursor.ch);
            const m = line.match(/\\[a-zA-Z]*cite[a-zA-Z*]*\{([^}]*)$/);
            if (!m) return null;
            // Innerhalb der Klammer zaehlt nur der Teil nach dem letzten Komma
            const inner = m[1];
            const lastComma = inner.lastIndexOf(',');
            const query = inner.slice(lastComma + 1).trim().toLowerCase();
            const from = { line: cursor.line, ch: cursor.ch - (inner.length - lastComma - 1) };
            const tokens = query.split(/\s+/).filter(Boolean);
            const list = this.papers
                .filter(p => {
                    if (!tokens.length) return true;
                    const hay = `${p.cite_key || ''} ${p.title || ''} ${p.authors || ''} ${p.year || ''}`.toLowerCase();
                    return tokens.every(t => hay.includes(t));
                })
                .slice(0, 30)
                .map(p => ({
                    text: p.cite_key || '',
                    displayText: `${p.cite_key} — ${(p.title || '').slice(0, 60)}${(p.title || '').length > 60 ? '…' : ''} (${(p.authors || '').split(';')[0]}, ${p.year || '?'})`,
                }))
                .filter(item => item.text);
            return { list, from, to: cursor };
        },
        async open(id) {
            await this.flushSave();
            try {
                const data = await api(`/api/plugins/atlas/manuscripts/${id}`);
                this.currentId = id;
                this._suppress = true;
                this._cm.setValue(data.content);
                this._cm.clearHistory();
                this._suppress = false;
                this.saveState = 'saved';
                this.closePreview();
                this.$nextTick(() => this._cm.refresh());
            } catch (e) {
                alert('Manuskript konnte nicht geladen werden: ' + e.message);
            }
        },
        async save() {
            if (!this.currentId || this.saveState === 'saved') return;
            this.saveState = 'saving';
            try {
                await api(`/api/plugins/atlas/manuscripts/${this.currentId}`, {
                    method: 'PUT',
                    body: JSON.stringify({ content: this._cm.getValue() }),
                });
                this.saveState = 'saved';
                await this.loadList();
            } catch (e) {
                this.saveState = 'error';
                console.error(e);
            }
        },
        async flushSave() {
            clearTimeout(this._saveTimer);
            if (this.saveState === 'dirty') await this.save();
        },
        async createManuscript() {
            const title = prompt('Titel des Manuskripts:');
            if (!title || !title.trim()) return;
            try {
                const created = await api('/api/plugins/atlas/manuscripts', {
                    method: 'POST',
                    body: JSON.stringify({ title: title.trim() }),
                });
                await this.loadList();
                await this.open(created.id);
            } catch (e) {
                alert('Anlegen fehlgeschlagen: ' + e.message);
            }
        },
        async renameManuscript() {
            const title = prompt('Neuer Titel:', this.currentId);
            if (!title || !title.trim()) return;
            await this.flushSave();
            try {
                const meta = await api(`/api/plugins/atlas/manuscripts/${this.currentId}/rename`, {
                    method: 'POST',
                    body: JSON.stringify({ title: title.trim() }),
                });
                await this.loadList();
                this.currentId = meta.id;
            } catch (e) {
                alert('Umbenennen fehlgeschlagen: ' + e.message);
            }
        },
        async deleteManuscript() {
            if (!confirm(`Manuskript "${this.currentId}" wirklich löschen?`)) return;
            try {
                await api(`/api/plugins/atlas/manuscripts/${this.currentId}`, { method: 'DELETE' });
                this.currentId = null;
                this.closePreview();
                await this.loadList();
            } catch (e) {
                alert('Löschen fehlgeschlagen: ' + e.message);
            }
        },
        exportBib() {
            window.open('/api/export/bibtex', '_blank');
        },
        async compile() {
            await this.flushSave();
            this.compiling = true;
            this.compileError = null;
            try {
                const resp = await fetch(`/api/plugins/atlas/manuscripts/${this.currentId}/compile`, { method: 'POST' });
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    throw new Error(err.detail || `HTTP ${resp.status}`);
                }
                const blob = await resp.blob();
                if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
                this.previewUrl = URL.createObjectURL(blob);
                this.$nextTick(() => this._cm.refresh());
            } catch (e) {
                this.compileError = e.message;
            } finally {
                this.compiling = false;
            }
        },
        closePreview() {
            if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
            this.previewUrl = null;
            this.compileError = null;
        },
    },
};

// =============================================================================
// Atlas-Werkbank (Issue #180, ADR-0020) — gemeinsame Bausteine
// =============================================================================
// Heute, Woche und die Sammlung teilen sich drei Dinge: das Nav-Abzeichen mit
// der Zahl offener Tasks (Story 57), den heutigen Tag samt ISO-Woche für das
// Erfassen-Feld und den Entitäten-Cache, aus dem Anker-Chips ihre Titel und
// die `[[`-Vorschlagsliste ihre Einträge ziehen (Story 4/9). Genau dieser
// gemeinsame Zustand liegt hier — nicht in einer Seite, die zufällig zuerst
// gemountet wurde.

const atlasWork = reactive({
    openCount: null,   // null = noch nicht geladen (Abzeichen bleibt leer)
    today: '',         // ISO-Datum des Servers (via /journal/today)
    week: '',          // ISO-Woche dieses Tages
    entities: [],      // [{id, kind, title}]
    entitiesLoaded: false,
});

// Lädt Tag, Woche und die Zahl offener Tasks nach. Fehler sind still: die
// Werkbank soll ohne Backend nicht kaputt aussehen, nur leer.
async function atlasRefreshToday() {
    try {
        const data = await api('/api/plugins/atlas/journal/today');
        atlasWork.openCount = data.open_count || 0;
        atlasWork.today = data.date || '';
        atlasWork.week = data.week || '';
        return data;
    } catch (e) {
        return null;
    }
}

// Der Entitäten-Cache wird einmal je Sitzung geladen; `force` holt ihn nach
// einem Anlegen neu, damit ein frischer Zettel sofort vorschlagbar ist.
async function atlasLoadEntities(force = false) {
    if (atlasWork.entitiesLoaded && !force) return atlasWork.entities;
    try {
        const data = await api('/api/plugins/atlas/entities');
        atlasWork.entities = data.entities || [];
        atlasWork.entitiesLoaded = true;
    } catch (e) {
        if (!atlasWork.entitiesLoaded) atlasWork.entities = [];
    }
    return atlasWork.entities;
}

const ATLAS_KIND_LABEL = {
    idea: 'Idee',
    diss_node: 'Kapitel',
    project: 'Projekt',
    publication: 'Veröff.',
    zettel: 'Zettel',
};

// Die Sammlung liegt seit #180 unter /atlas/sammlung; welcher Tab und welche
// Detailseite, sagt die Query — dieselben Schlüssel, die die Bibliothek für
// ihre Rücksprünge benutzt (?idea=, ?pub=, ?proj=), plus ?chapter=.
const ATLAS_KIND_QUERY = {
    idea: { tab: 'ideen', key: 'idea' },
    diss_node: { tab: 'dissertation', key: 'chapter' },
    project: { tab: 'projekte', key: 'proj' },
    publication: { tab: 'veroeffentlichungen', key: 'pub' },
};

function atlasEntity(id) {
    return atlasWork.entities.find((e) => e.id === id) || null;
}

// Die Adresse eines Verweises als Zeichenkette — für gerenderten Markdown, wo
// kein `<router-link>` stehen kann. Der Router läuft im Hash-Modus, ein
// gewöhnliches `href="#/…"` ist dort dieselbe Navigation. `null`, wenn das Ziel
// unbekannt ist: hängende Verweise werden angezeigt, nie repariert.
function atlasEntityHref(id) {
    const route = atlasEntityRoute(atlasEntity(id));
    if (!route) return null;
    if (typeof route === 'string') return '#' + route;
    const q = Object.keys(route.query || {})
        .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(route.query[k]))
        .join('&');
    return '#' + route.path + (q ? '?' + q : '');
}

// Zielroute eines Anker-Chips. Unbekannte Anker liefern null — der Chip wird
// dann gestrichelt gezeigt statt ins Leere zu verlinken (hängende Verweise
// sind Warnungen, nie Reparatur).
function atlasEntityRoute(entity) {
    if (!entity) return null;
    if (entity.kind === 'zettel') return '/atlas/zettel/' + encodeURIComponent(entity.id);
    const map = ATLAS_KIND_QUERY[entity.kind];
    if (!map) return null;
    const query = { tab: map.tab };
    query[map.key] = entity.id;
    return { path: '/atlas/sammlung', query };
}

// ISO-Datum -> lokales Date (nie über Date.parse, das ein Datum ohne Zeitzone
// als UTC liest und je nach Zone einen Tag daneben landet).
function atlasDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

const ATLAS_WEEKDAYS_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

function atlasShortDay(iso) {
    const d = atlasDate(iso);
    return d ? ATLAS_WEEKDAYS_SHORT[(d.getDay() + 6) % 7] : String(iso || '');
}

// Atlas ist deutschsprachig (Plugins sind von ADR-0018 ausgenommen), deshalb
// steht die Locale hier ausdrücklich — implizit bleibt sie nirgends.
function atlasFormatDate(iso, opts) {
    const d = atlasDate(iso);
    return d ? d.toLocaleDateString('de-DE', opts) : String(iso || '');
}

function atlasDayMonth(iso) {
    return atlasFormatDate(iso, { day: 'numeric', month: 'long' });
}

function atlasShortDate(iso) {
    return atlasFormatDate(iso, { day: '2-digit', month: '2-digit' });
}

// Ein SSE-Abonnement auf die Atlas-Ereignisse. `onKind` bekommt die Entitätsart
// ('journal', 'zettel', …), damit eine Seite gezielt nachlädt statt bei jedem
// Ping alles neu zu holen.
function atlasConnectEvents(onKind) {
    let es = null;
    try {
        es = new EventSource('/api/plugins/atlas/events');
        es.onmessage = (ev) => {
            try {
                const data = JSON.parse(ev.data);
                if (data && data.type) onKind(data.kind || '', data.type);
            } catch (e) { /* keep-alive oder kaputte Zeile */ }
        };
        es.onerror = () => { /* der Browser verbindet selbst neu */ };
    } catch (e) {
        es = null;
    }
    return es;
}

// Navigation in zwei Gruppen (Story 56). Die aktive Seite sagt selbst, welcher
// Eintrag leuchtet (`active`) — verlässlicher als Pfade zu vergleichen, weil
// die Sammlung ihren Bereich in der Query trägt.
const ATLAS_NAV_GROUPS = [
    {
        label: 'Arbeit',
        items: [
            { key: 'heute', label: 'Heute', to: '/atlas', badge: true },
            { key: 'woche', label: 'Woche', to: '/atlas/woche' },
            { key: 'rueckblick', label: 'Rückblick', to: '/atlas/rueckblick' },
        ],
    },
    {
        label: 'Sammlung',
        items: [
            { key: 'kapitel', label: 'Kapitel', to: '/atlas/sammlung?tab=dissertation' },
            { key: 'zettel', label: 'Zettel', to: '/atlas/zettel' },
            { key: 'ideen', label: 'Ideen', to: '/atlas/sammlung?tab=ideen' },
            { key: 'veroeffentlichungen', label: 'Veröffentlichungen', to: '/atlas/sammlung?tab=veroeffentlichungen' },
            { key: 'projekte', label: 'Projekte', to: '/atlas/sammlung?tab=projekte' },
            { key: 'manuskripte', label: 'Manuskripte', to: '/atlas/sammlung?tab=veroeffentlichungen&focus=manuskripte' },
        ],
    },
];

const AtlasNav = {
    props: { active: { type: String, default: '' } },
    template: `
        <nav class="atlas-nav" aria-label="Atlas">
            <div v-for="group in groups" :key="group.label" class="atlas-nav-group">
                <span class="atlas-nav-kicker">{{ group.label }}</span>
                <router-link v-for="item in group.items" :key="item.key" :to="item.to"
                             class="atlas-nav-item" :class="{ 'is-active': active === item.key }"
                             :aria-current="active === item.key ? 'page' : null">
                    {{ item.label }}
                    <span v-if="item.badge && openCount" class="atlas-nav-badge"
                          :title="openCount + ' offene Tasks'">{{ openCount }}</span>
                </router-link>
            </div>
        </nav>
    `,
    computed: {
        groups() { return ATLAS_NAV_GROUPS; },
        openCount() { return atlasWork.openCount; },
    },
};

// Anker-Chip: zeigt den Titel der Entität, nicht die ID (Story 9), und springt
// per Klick auf deren Detailseite (Story 10).
const AtlasAnchorChip = {
    props: { id: { type: String, required: true } },
    template: `
        <router-link v-if="target" :to="target" class="atlas-chip" :title="id">
            <span class="atlas-chip-kind">{{ kindLabel }}</span><span class="atlas-chip-label">{{ label }}</span>
        </router-link>
        <span v-else class="atlas-chip is-dangling" :title="'Unbekannter Anker: ' + id">{{ id }}</span>
    `,
    computed: {
        entity() { return atlasEntity(this.id); },
        target() { return atlasEntityRoute(this.entity); },
        label() { return (this.entity && this.entity.title) || this.id; },
        kindLabel() { return this.entity ? (ATLAS_KIND_LABEL[this.entity.kind] || '') : ''; },
    },
};

// Relative Zeit für „zuletzt geändert" (Kapitel-Drehscheibe, Story 52). Alles
// jenseits eines Monats ist wieder ein Datum — „vor 43 Tagen" sagt niemandem
// etwas.
function atlasRelative(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    const mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return 'gerade eben';
    if (mins < 60) return 'vor ' + mins + ' Min.';
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return 'vor ' + hrs + ' Std.';
    const days = Math.round(hrs / 24);
    if (days === 1) return 'gestern';
    if (days < 30) return 'vor ' + days + ' Tagen';
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Kalenderwoche aus einer Wochen-ID (`2026-W39`) — rein fürs Anzeigen.
function atlasWeekNumber(week) {
    const m = /W(\d{2})/.exec(String(week || ''));
    return m ? Number(m[1]) : '';
}

// ISO-Wochen-ID eines Datums, nach derselben Regel wie `atlas/weeks.py`:
// die Woche gehört dem Jahr ihres Donnerstags. Der Rückblick braucht das, um
// ohne Server-Rundreise ein paar Wochen zurückblättern zu können.
function atlasWeekIdOf(d) {
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    t.setDate(t.getDate() - ((t.getDay() + 6) % 7) + 3);   // Donnerstag der Woche
    const year = t.getFullYear();
    const jan4 = new Date(year, 0, 4);
    const firstThu = new Date(year, 0, 4 - ((jan4.getDay() + 6) % 7) + 3);
    const n = 1 + Math.round((t - firstThu) / (7 * 24 * 3600 * 1000));
    return year + '-W' + String(n).padStart(2, '0');
}

// Die Checklisten-Punkte eines Bodys, fence-aware und in Dokumentreihenfolge —
// derselbe Index-Kontrakt wie `domain.parse_checklist` auf der Serverseite, den
// `POST /zettel/{id}/derive-tasks` adressiert. Dieselbe Regel zweimal zu
// schreiben ist hier billiger als ein eigener Endpunkt, der nur Zeilen zählt.
function atlasChecklistItems(body) {
    const out = [];
    let inFence = false;
    for (const line of String(body || '').split(/\r?\n/)) {
        if (line.trimStart().startsWith('```')) { inFence = !inFence; continue; }
        if (inFence) continue;
        const m = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
        if (m) out.push({ index: out.length, text: m[2].trim(), done: m[1].toLowerCase() === 'x' });
    }
    return out;
}

// Die Rückverweis-Gruppen in Anzeigereihenfolge. `kind` ist die Entitätsart,
// über die `atlasEntityRoute` das Sprungziel bestimmt.
const ATLAS_BACKLINK_GROUPS = [
    { key: 'chapters', label: 'Kapitel', kind: 'diss_node' },
    { key: 'zettel', label: 'Zettel', kind: 'zettel' },
    { key: 'publications', label: 'Veröffentlichungen', kind: 'publication' },
    { key: 'projects', label: 'Projekte', kind: 'project' },
    { key: 'ideas', label: 'Ideen', kind: 'idea' },
];

// Rückverweise (Story 43/53): derselbe Block auf Zettel, Kapitel,
// Veröffentlichung, Projekt und Idee. Entweder holt er sich die Daten selbst
// (`id`) oder er bekommt sie vorgeladen (`data`) — die Kapitel-Drehscheibe
// liest sie ohnehin schon für „Verlinkte Zettel" und soll nicht zweimal fragen.
const AtlasBacklinks = {
    props: {
        id: { type: String, default: '' },
        // `undefined` = niemand legt Daten vor, der Block holt sie selbst.
        // `null` = der Aufrufer lädt gerade — dann zeigt der Block seinen
        // Platzhalter statt für einen Moment „nichts zeigt hierher".
        data: { type: Object, default: undefined },
        exclude: { type: Array, default: () => [] },
        label: { type: String, default: 'Rückverweise' },
    },
    emits: ['changed'],
    template: `
        <section class="atlas-sec">
            <div class="atlas-sec-head">
                <h3 class="atlas-sec-title">{{ label }}<template v-if="count"> · {{ count }}</template></h3>
            </div>
            <div v-if="isLoading" class="atlas-skel" style="height:56px"></div>
            <div v-else class="atlas-card">
                <p v-if="!count" class="atlas-empty">
                    Nichts zeigt hierher. Ein <code>[[{{ id || 'id' }}]]</code> in einem Body oder in einer
                    Task-Zeile wird beim Indexieren zum Rückverweis.
                </p>
                <div v-for="g in groups" :key="g.key" class="atlas-back-group">
                    <div class="atlas-back-kicker">{{ g.label }} · {{ g.rows.length }}</div>
                    <div class="atlas-back-rows">
                        <router-link v-for="r in g.rows" :key="r.id" :to="r.to"
                                     class="atlas-back-row" :title="r.id">{{ r.title || r.id }}</router-link>
                    </div>
                </div>
                <div v-if="tasks.length" class="atlas-back-group">
                    <div class="atlas-back-kicker">Tasks · {{ tasks.length }}</div>
                    <div v-for="t in tasks" :key="t.id" class="atlas-back-task"
                         :class="{ 'is-done': t.done, 'is-pending': pending === t.id }">
                        <input type="checkbox" class="atlas-check" :checked="t.done"
                               :disabled="!!t.moved_to || pending === t.id"
                               :aria-label="(t.done ? 'Task wieder öffnen: ' : 'Task erledigt: ') + t.text"
                               @change="toggleTask(t)" />
                        <span class="atlas-back-task-text">{{ t.text || '(leere Zeile)' }}</span>
                        <router-link class="atlas-task-note" :to="'/atlas/woche/' + encodeURIComponent(t.week)"
                                     style="text-decoration:none">{{ taskWhen(t) }}</router-link>
                    </div>
                </div>
            </div>
        </section>
    `,
    data() {
        return { fetched: null, loading: false, pending: null };
    },
    computed: {
        payload() { return this.data !== undefined ? this.data : this.fetched; },
        isLoading() { return this.loading || this.data === null; },
        groups() {
            const src = this.payload;
            if (!src) return [];
            return ATLAS_BACKLINK_GROUPS
                .filter((g) => !this.exclude.includes(g.key))
                .map((g) => ({
                    key: g.key,
                    label: g.label,
                    // Ein Rückverweis ohne Sprungziel wäre eine tote Zeile —
                    // die Route kommt aus derselben Tabelle wie der Anker-Chip.
                    rows: (src[g.key] || [])
                        .map((row) => ({ ...row, to: atlasEntityRoute({ kind: g.kind, id: row.id, title: row.title }) }))
                        .filter((row) => !!row.to),
                }))
                .filter((g) => g.rows.length);
        },
        tasks() {
            const src = this.payload;
            if (!src || this.exclude.includes('tasks')) return [];
            return src.tasks || [];
        },
        count() {
            return this.groups.reduce((n, g) => n + g.rows.length, 0) + this.tasks.length;
        },
    },
    methods: {
        taskWhen(task) {
            const parts = [];
            if (task.day) parts.push(atlasShortDay(task.day) + ' ' + atlasShortDate(task.day));
            else if (task.week) parts.push('KW ' + atlasWeekNumber(task.week));
            return parts.join(' · ');
        },
        async load() {
            if (!this.id || this.data !== undefined) return;
            this.loading = true;
            try {
                this.fetched = await api('/api/plugins/atlas/backlinks/' + encodeURIComponent(this.id));
            } catch (e) {
                this.fetched = null;
            }
            this.loading = false;
        },
        async toggleTask(task) {
            const before = task.done;
            task.done = !before;
            this.pending = task.id;
            try {
                await api('/api/plugins/atlas/journal/' + encodeURIComponent(task.week)
                    + '/tasks/' + encodeURIComponent(task.body_index) + '/toggle', { method: 'POST' });
                atlasRefreshToday();
                this.$emit('changed');
            } catch (e) {
                task.done = before;
                alert(atlasErrorText(e));
            }
            this.pending = null;
        },
    },
    watch: {
        id() { this.fetched = null; this.load(); },
    },
    mounted() { this.load(); },
};

// Die offenen Tasks einer Entität (Story 50) — dieselbe Liste, die die
// Kapitel-Drehscheibe zeigt. Abhaken schreibt über den Journal-Endpunkt, der
// Task verschwindet danach aus der Liste der offenen.
const AtlasAnchorTasks = {
    props: {
        anchor: { type: String, required: true },
        label: { type: String, default: 'Offene Tasks' },
    },
    emits: ['changed'],
    template: `
        <section class="atlas-sec">
            <div class="atlas-sec-head">
                <h3 class="atlas-sec-title">{{ label }}<template v-if="tasks.length"> · {{ tasks.length }}</template></h3>
                <router-link to="/atlas" class="atlas-link-btn" style="text-decoration:none">Heute</router-link>
            </div>
            <div v-if="loading" class="atlas-skel" style="height:48px"></div>
            <div v-else class="atlas-card">
                <p v-if="!tasks.length" class="atlas-empty">
                    Kein offener Task. Eine Zeile mit <code>[[{{ anchor }}]]</code> im Erfassen-Feld hängt einen hier an.
                </p>
                <div v-for="t in tasks" :key="t.id" class="atlas-back-task" :class="{ 'is-pending': pending === t.id }">
                    <input type="checkbox" class="atlas-check" :checked="t.done"
                           :disabled="pending === t.id"
                           :aria-label="'Task erledigt: ' + t.text" @change="toggle(t)" />
                    <span class="atlas-back-task-text">{{ t.text || '(leere Zeile)' }}</span>
                    <span class="atlas-task-note" :class="{ 'is-accent': t.day === today }">{{ when(t) }}</span>
                </div>
            </div>
        </section>
    `,
    data() {
        return { rows: [], loading: true, pending: null };
    },
    computed: {
        tasks() { return this.rows; },
        today() { return atlasWork.today; },
    },
    methods: {
        when(task) {
            if (!task.day) return 'KW ' + atlasWeekNumber(task.week);
            if (task.day === atlasWork.today) return 'heute';
            return atlasShortDay(task.day) + ' ' + atlasShortDate(task.day);
        },
        async load(silent = false) {
            if (!this.anchor) { this.rows = []; this.loading = false; return; }
            if (!silent) this.loading = true;
            try {
                const data = await api('/api/plugins/atlas/journal/tasks?anchor='
                    + encodeURIComponent(this.anchor) + '&open=true');
                this.rows = (data.tasks || []).map((t) => ({ id: t.week + '#' + t.body_index, ...t }));
            } catch (e) {
                this.rows = [];
            }
            this.loading = false;
        },
        async toggle(task) {
            // Optimistisch: die Zeile verschwindet sofort aus „offen", ein
            // Fehler holt sie zurück.
            const before = this.rows;
            this.pending = task.id;
            this.rows = this.rows.filter((r) => r.id !== task.id);
            try {
                await api('/api/plugins/atlas/journal/' + encodeURIComponent(task.week)
                    + '/tasks/' + encodeURIComponent(task.body_index) + '/toggle', { method: 'POST' });
                atlasRefreshToday();
                this.$emit('changed');
            } catch (e) {
                this.rows = before;
                alert(atlasErrorText(e));
            }
            this.pending = null;
            await this.load(true);
        },
    },
    watch: { anchor() { this.load(); } },
    mounted() {
        this.load();
        if (!atlasWork.today) atlasRefreshToday();
    },
};

// Erfassen: eine Zeile, drei Modi, Task ist der Vorgabefall (Story 54/55).
// `[[` öffnet die Vorschlagsliste über den Entitäten-Cache (Story 4).
const AtlasCapture = {
    // `initial-mode` ist der Vorgabefall der Seite, auf der das Feld steht —
    // auf der Zettel-Seite ist „Zettel" der häufigste Fall, überall sonst Task.
    props: { initialMode: { type: String, default: 'task' } },
    emits: ['created'],
    template: `
        <form class="atlas-capture" @submit.prevent="submit">
            <label class="atlas-capture-label" :for="inputId">Erfassen</label>
            <input :id="inputId" ref="input" type="text" class="atlas-capture-input"
                   :value="text" :placeholder="placeholder" autocomplete="off"
                   @input="onInput" @keydown.down="moveSuggestion(1, $event)"
                   @keydown.up="moveSuggestion(-1, $event)"
                   @keydown.enter="onEnter" @keydown.esc="onEscape"
                   @blur="closeSuggestions" />
            <div class="atlas-modes" role="group" aria-label="Was wird angelegt">
                <button v-for="m in modes" :key="m.key" type="button" class="atlas-mode"
                        :class="{ 'is-active': mode === m.key }"
                        :aria-pressed="mode === m.key ? 'true' : 'false'"
                        @click="setMode(m.key)">{{ m.label }}</button>
            </div>
            <button type="submit" class="atlas-pill is-strong" :disabled="busy || !text.trim()">
                {{ busy ? 'Legt an…' : 'Anlegen' }}
            </button>
            <div v-if="suggestOpen" ref="sug" class="atlas-sug" role="listbox">
                <button v-for="(e, i) in suggestions" :key="e.id" type="button" role="option"
                        class="atlas-sug-item" :class="{ 'is-active': i === suggestIndex }"
                        :aria-selected="i === suggestIndex ? 'true' : 'false'"
                        @mousedown.prevent="insert(e)">
                    <span class="atlas-sug-kind">{{ kindLabel(e.kind) }}</span>
                    <span class="atlas-sug-title">{{ e.title || e.id }}</span>
                    <span class="atlas-sug-id">{{ e.id }}</span>
                </button>
                <div v-if="!suggestions.length" class="atlas-sug-empty">Keine Entität gefunden.</div>
            </div>
        </form>
    `,
    data() {
        return {
            mode: this.initialMode,
            text: '',
            busy: false,
            suggestOpen: false,
            suggestIndex: 0,
            suggestQuery: '',
            anchorStart: -1,
            inputId: 'atlas-capture-' + Math.random().toString(36).slice(2, 8),
            modes: [
                { key: 'task', label: 'Task' },
                { key: 'zettel', label: 'Zettel' },
                { key: 'idee', label: 'Idee' },
            ],
        };
    },
    computed: {
        placeholder() {
            if (this.mode === 'zettel') return 'Titel des Zettels …';
            if (this.mode === 'idee') return 'Titel der Idee …';
            return 'Eine Zeile … Anker per [[kapitel-03]], Tag per #methodik';
        },
        suggestions() {
            if (!this.suggestOpen) return [];
            const q = this.suggestQuery.trim().toLowerCase();
            const all = atlasWork.entities;
            const hits = q
                ? all.filter((e) => e.id.toLowerCase().includes(q) || (e.title || '').toLowerCase().includes(q))
                : all;
            return hits.slice(0, 8);
        },
    },
    methods: {
        kindLabel(kind) { return ATLAS_KIND_LABEL[kind] || kind; },
        setMode(key) {
            this.mode = key;
            this.$nextTick(() => { if (this.$refs.input) this.$refs.input.focus(); });
        },
        onInput(e) {
            this.text = e.target.value;
            const caret = e.target.selectionStart || this.text.length;
            const before = this.text.slice(0, caret);
            const open = before.lastIndexOf('[[');
            if (open >= 0 && !before.slice(open).includes(']]')) {
                this.anchorStart = open;
                this.suggestQuery = before.slice(open + 2);
                this.suggestIndex = 0;
                this.suggestOpen = true;
            } else {
                this.closeSuggestions();
            }
        },
        // Pfeiltasten gehören der Vorschlagsliste nur, solange sie offen ist —
        // sonst bleiben sie dem Eingabefeld (Anfang/Ende der Zeile).
        moveSuggestion(delta, event) {
            if (!this.suggestOpen || !this.suggestions.length) return;
            if (event) event.preventDefault();
            const n = this.suggestions.length;
            this.suggestIndex = (this.suggestIndex + delta + n) % n;
            // Die Liste ist höher als ihr Fenster: der gewählte Eintrag muss
            // mitwandern, sonst tippt man blind weiter unten.
            this.$nextTick(() => {
                const box = this.$refs.sug;
                const row = box && box.children ? box.children[this.suggestIndex] : null;
                if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
            });
        },
        onEnter(e) {
            if (this.suggestOpen && this.suggestions.length) {
                e.preventDefault();
                this.insert(this.suggestions[this.suggestIndex]);
                return;
            }
            e.preventDefault();
            this.submit();
        },
        onEscape(e) {
            if (this.suggestOpen) {
                e.stopPropagation();
                this.closeSuggestions();
            }
        },
        closeSuggestions() {
            this.suggestOpen = false;
            this.anchorStart = -1;
        },
        insert(entity) {
            if (!entity) return;
            const el = this.$refs.input;
            const caret = el ? (el.selectionStart || this.text.length) : this.text.length;
            const start = this.anchorStart >= 0 ? this.anchorStart : caret;
            const head = this.text.slice(0, start) + '[[' + entity.id + ']] ';
            this.text = head + this.text.slice(caret);
            this.closeSuggestions();
            this.$nextTick(() => {
                if (!this.$refs.input) return;
                this.$refs.input.focus();
                this.$refs.input.setSelectionRange(head.length, head.length);
            });
        },
        async submit() {
            const text = this.text.trim();
            if (!text || this.busy) return;
            this.busy = true;
            try {
                const created = await this.create(text);
                this.text = '';
                this.closeSuggestions();
                this.$emit('created', { mode: this.mode, data: created });
            } catch (e) {
                alert('Anlegen fehlgeschlagen: ' + atlasErrorText(e));
            } finally {
                this.busy = false;
                this.$nextTick(() => { if (this.$refs.input) this.$refs.input.focus(); });
            }
        },
        async create(text) {
            if (this.mode === 'zettel') {
                const created = await api('/api/plugins/atlas/zettel', {
                    method: 'POST',
                    body: JSON.stringify({ title: text }),
                });
                atlasLoadEntities(true);
                return created;
            }
            if (this.mode === 'idee') {
                const created = await api('/api/plugins/atlas/ideas', {
                    method: 'POST',
                    body: JSON.stringify({ title: text, type: 'paper-idea', tags: [] }),
                });
                atlasLoadEntities(true);
                return created;
            }
            // Task-Modus: die Zeile geht verbatim ins Journal von heute — Anker
            // und Tags stehen inline, der Server parst sie (Story 2/3/5).
            if (!atlasWork.week || !atlasWork.today) await atlasRefreshToday();
            if (!atlasWork.week) throw new Error('Journal nicht erreichbar');
            const created = await api(
                '/api/plugins/atlas/journal/' + encodeURIComponent(atlasWork.week) + '/tasks',
                { method: 'POST', body: JSON.stringify({ day: atlasWork.today, text }) },
            );
            await atlasRefreshToday();
            return created;
        },
    },
    mounted() {
        atlasLoadEntities();
        if (!atlasWork.week) atlasRefreshToday();
    },
};

// Eine Task-Zeile der Heute-Liste: echte Checkbox, Text per Klick änderbar,
// Anker- und Tag-Chips, Reihenfolge per Tastatur/Knopf (Story 6–10).
const AtlasTaskRow = {
    components: { 'atlas-anchor-chip': AtlasAnchorChip },
    props: {
        task: { type: Object, required: true },
        pending: { type: Boolean, default: false },
        first: { type: Boolean, default: false },
        last: { type: Boolean, default: false },
        reorderable: { type: Boolean, default: true },
        // Der „offen von gestern"-Block zeigt zusätzlich den Übertrag (Story 12).
        carryable: { type: Boolean, default: false },
    },
    emits: ['toggle', 'save', 'remove', 'move-up', 'move-down', 'carry'],
    template: `
        <div class="atlas-task" :class="{ 'is-done': task.done, 'is-moved': !!task.moved_to, 'is-pending': pending }">
            <input type="checkbox" class="atlas-check" :checked="task.done"
                   :disabled="!!task.moved_to"
                   :aria-label="(task.done ? 'Task wieder öffnen: ' : 'Task erledigt: ') + task.text"
                   @change="$emit('toggle')" />
            <input v-if="editing" ref="edit" class="atlas-task-edit" v-model="draft"
                   aria-label="Task-Text bearbeiten"
                   @keydown.enter.prevent="commit" @keydown.esc.prevent="cancel" @blur="commit" />
            <template v-else>
                <button type="button" class="atlas-task-text" :title="'Zum Bearbeiten klicken — ' + (task.raw || '')"
                        @click="startEdit">{{ task.text || '(leere Zeile)' }}</button>
                <span v-if="task.moved_from" class="atlas-task-note">(von {{ shortDay(task.moved_from) }})</span>
                <span v-if="task.moved_to" class="atlas-task-note is-accent">→ {{ shortDay(task.moved_to) }}</span>
                <atlas-anchor-chip v-for="a in task.anchors" :key="a" :id="a" />
                <span v-for="tag in task.tags" :key="tag" class="atlas-tag">#{{ tag }}</span>
            </template>
            <div class="atlas-task-actions">
                <button v-if="carryable" type="button" class="atlas-link-btn" style="margin-right:6px"
                        @click="$emit('carry')">→ heute</button>
                <button v-if="reorderable" type="button" class="atlas-icon-btn" aria-label="Task nach oben"
                        :disabled="first || editing" @click="$emit('move-up')">↑</button>
                <button v-if="reorderable" type="button" class="atlas-icon-btn" aria-label="Task nach unten"
                        :disabled="last || editing" @click="$emit('move-down')">↓</button>
                <button type="button" class="atlas-icon-btn is-danger" aria-label="Task löschen"
                        :disabled="editing" @click="$emit('remove')">✕</button>
            </div>
        </div>
    `,
    data() {
        return { editing: false, draft: '', closing: false };
    },
    methods: {
        shortDay(iso) { return atlasShortDay(iso); },
        startEdit() {
            // Die Rohzeile wird bearbeitet, nicht der Anzeigetext: Anker, Tags
            // und Marker sollen beim Speichern nicht verloren gehen.
            this.draft = this.task.raw || this.task.text || '';
            this.editing = true;
            this.closing = false;
            this.$nextTick(() => { if (this.$refs.edit) this.$refs.edit.select(); });
        },
        commit() {
            if (!this.editing || this.closing) return;
            this.closing = true;
            this.editing = false;
            const next = this.draft.trim();
            if (next && next !== (this.task.raw || '')) this.$emit('save', next);
        },
        cancel() {
            this.closing = true;
            this.editing = false;
        },
    },
};

const AtlasPage = {
    components: {
        'atlas-editor': AtlasEditor,
        'atlas-nav': AtlasNav,
        'atlas-capture': AtlasCapture,
        'atlas-backlinks': AtlasBacklinks,
        'atlas-anchor-tasks': AtlasAnchorTasks,
    },
    template: `
        <div class="p-6 relative" @dragover="onRootDragOver" @dragleave="onDragLeave" @drop.prevent.stop="onDropMd">
            <!-- .md drag-and-drop overlay -->
            <div v-if="dragOver" class="absolute inset-0 z-30 border-2 border-dashed border-accent rounded-xl flex items-center justify-center pointer-events-none" style="background: var(--lb-accent-soft); opacity:.92;">
                <span class="text-accent-ink font-medium">Markdown-Datei (.md) hier ablegen, um sie als Idee zu importieren</span>
            </div>
            <input ref="mdInput" type="file" accept=".md" multiple class="hidden" @change="onImportFiles" />

            <!-- Werkbank-Navigation + Erfassen-Feld (#180) — auf jeder Atlas-Seite -->
            <atlas-nav :active="navKey" class="mb-4" />
            <atlas-capture class="mb-5" @created="onCaptured" />

            <!-- Header -->
            <div class="flex items-center justify-between mb-5">
                <div>
                    <h1 class="text-2xl font-semibold text-ink">Sammlung</h1>
                    <p class="text-sm text-mute">Kapitel, Veröffentlichungen, Ideen und Projekte — erfassen, ordnen und mit Literatur verknüpfen.</p>
                </div>
                <div class="flex items-center gap-2">
                    <template v-if="tab === 'ideen'">
                        <button @click="onImportClick"
                                class="inline-flex items-center gap-1.5 border border-hairline text-ink-2 px-3 py-2 rounded-lg text-sm font-medium hover:border-accent transition-colors">
                            .md importieren
                        </button>
                        <button @click="openCapture"
                                class="inline-flex items-center gap-1.5 bg-accent text-white px-3.5 py-2 rounded-lg text-sm font-medium hover:bg-accent-ink transition-colors">
                            <span>+</span> Neue Idee
                        </button>
                    </template>
                    <template v-else-if="tab === 'dissertation'">
                        <button @click="openNodeCreate"
                                class="inline-flex items-center gap-1.5 bg-accent text-white px-3.5 py-2 rounded-lg text-sm font-medium hover:bg-accent-ink transition-colors">
                            <span>+</span> Neues Kapitel
                        </button>
                    </template>
                    <template v-else-if="tab === 'veroeffentlichungen'">
                        <button @click="openPublicationCreate"
                                class="inline-flex items-center gap-1.5 bg-accent text-white px-3.5 py-2 rounded-lg text-sm font-medium hover:bg-accent-ink transition-colors">
                            <span>+</span> Neue Veröffentlichung
                        </button>
                    </template>
                    <template v-else-if="tab === 'editor'">
                        <button @click="goTab('veroeffentlichungen')"
                                class="inline-flex items-center gap-1.5 border border-hairline text-ink-2 px-3 py-2 rounded-lg text-sm font-medium hover:border-accent transition-colors">
                            ← Zurück zu Veröffentlichungen
                        </button>
                    </template>
                    <button v-else-if="tab === 'projekte'" @click="openProjectCreate"
                            class="inline-flex items-center gap-1.5 bg-accent text-white px-3.5 py-2 rounded-lg text-sm font-medium hover:bg-accent-ink transition-colors">
                        <span>+</span> Neues Projekt
                    </button>
                </div>
            </div>

            <!-- Tabs -->
            <div class="flex gap-1 mb-5 border-b border-hairline">
                <button @click="goTab('ideen')" class="px-3 py-2 text-sm -mb-px border-b-2 transition-colors"
                        :class="tab === 'ideen' ? 'border-accent text-ink font-medium' : 'border-transparent text-mute hover:text-ink'">Ideen</button>
                <button @click="goTab('veroeffentlichungen')" class="px-3 py-2 text-sm -mb-px border-b-2 transition-colors"
                        :class="tab === 'veroeffentlichungen' ? 'border-accent text-ink font-medium' : 'border-transparent text-mute hover:text-ink'">Veröffentlichungen</button>
                <button @click="goTab('dissertation')" class="px-3 py-2 text-sm -mb-px border-b-2 transition-colors"
                        :class="tab === 'dissertation' ? 'border-accent text-ink font-medium' : 'border-transparent text-mute hover:text-ink'">Kapitel</button>
                <button @click="goTab('projekte')" class="px-3 py-2 text-sm -mb-px border-b-2 transition-colors"
                        :class="tab === 'projekte' ? 'border-accent text-ink font-medium' : 'border-transparent text-mute hover:text-ink'">Projekte</button>
                <!-- Kein eigener Manuskripte/Editor-Tab (ADR-0004): der Editor wird
                     über die Manuskript-Links einer Veröffentlichung geöffnet. -->
                <span v-if="tab === 'editor'" class="px-3 py-2 text-sm -mb-px border-b-2 border-accent text-ink font-medium">Manuskript-Editor</span>
            </div>

            <!-- ===== IDEEN TAB ===== -->
            <template v-if="tab === 'ideen'">
            <!-- Filters -->
            <div class="flex items-center gap-2 mb-5">
                <select v-model="filterType"
                        class="border border-hairline rounded-lg px-3 py-1.5 text-sm bg-white focus:ring-2 focus:ring-accent outline-none">
                    <option value="">Alle Typen</option>
                    <option v-for="t in types" :key="t.key" :value="t.key">{{ t.label }}</option>
                </select>
                <input v-model="filterText" type="text" placeholder="Suche Titel / #tag"
                       class="flex-1 max-w-xs border border-hairline rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-accent outline-none" />
                <span class="text-xs text-mute">{{ filtered.length }} / {{ ideas.length }}</span>
            </div>

            <div v-if="loading" class="text-sm text-mute">Lädt…</div>

            <div v-else-if="ideas.length === 0"
                 class="border border-dashed border-hairline-2 rounded-xl p-10 text-center">
                <p class="text-ink font-medium mb-1">Noch keine Ideen</p>
                <p class="text-sm text-mute mb-4">Halte deine erste Paper-, Tool- oder Experimentidee fest.</p>
                <button @click="openCapture" class="bg-accent text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-accent-ink transition-colors">
                    + Erste Idee
                </button>
            </div>

            <!-- Pinboard (#59): active ideas grid + collapsed promoted/parked sections -->
            <div v-else class="space-y-6">
                <!-- Active ideas grid (seed + developing) -->
                <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    <div v-for="idea in activeIdeas" :key="idea.id"
                         @click="selectedId = idea.id"
                         class="cursor-pointer bg-white border border-hairline rounded-xl p-4 hover:border-accent transition-colors"
                         :class="{ 'border-accent ring-1 ring-accent': idea.id === selectedId }">
                        <div class="flex items-center gap-2 mb-2">
                            <span class="text-[10px] font-medium px-1.5 py-0.5 rounded" :class="typeClass(idea.type)">{{ typeLabel(idea.type) }}</span>
                            <span class="w-2 h-2 rounded-full flex-shrink-0" :class="statusDotClass(idea.status)" :title="statusLabel(idea.status)"></span>
                            <span v-if="idea.errors && idea.errors.length" title="Validierungswarnung" class="text-[10px] text-amber-600">⚠</span>
                        </div>
                        <div class="text-sm font-medium text-ink leading-snug mb-2">{{ idea.title || '(ohne Titel)' }}</div>
                        <div v-if="bodyPreview(idea)" class="text-[12px] text-ink-3 leading-snug line-clamp-3 mb-2">{{ bodyPreview(idea) }}</div>
                        <div v-if="idea.tags && idea.tags.length" class="flex flex-wrap gap-1 mb-2">
                            <span v-for="tag in idea.tags" :key="tag" class="text-[10px] text-ink-3 bg-bg-soft px-1.5 py-0.5 rounded">#{{ tag }}</span>
                        </div>
                        <div class="flex items-center gap-3 text-[11px] text-mute">
                            <span v-if="idea.refs && idea.refs.length">📎 {{ idea.refs.length }}</span>
                            <span v-if="idea.diss && idea.diss.length">🎓 {{ idea.diss.length }}</span>
                        </div>
                    </div>
                    <div v-if="!activeIdeas.length" class="col-span-full text-sm text-mute italic">Keine aktiven Ideen.</div>
                </div>

                <!-- Collapsed section: Ausgearbeitet (promoted) -->
                <div v-if="promotedIdeas.length">
                    <button @click="sectionsOpen.promoted = !sectionsOpen.promoted"
                            class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-mute hover:text-ink transition-colors w-full text-left py-2 border-b border-hairline mb-3">
                        <span>{{ sectionsOpen.promoted ? '▾' : '▸' }}</span>
                        <span>Ausgearbeitet</span>
                        <span class="font-normal normal-case">({{ promotedIdeas.length }})</span>
                    </button>
                    <div v-show="sectionsOpen.promoted" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                        <div v-for="idea in promotedIdeas" :key="idea.id"
                             @click="selectedId = idea.id"
                             class="cursor-pointer bg-white border border-hairline rounded-xl p-4 hover:border-accent transition-colors opacity-70"
                             :class="{ 'border-accent ring-1 ring-accent opacity-100': idea.id === selectedId }">
                            <div class="flex items-center gap-2 mb-2">
                                <span class="text-[10px] font-medium px-1.5 py-0.5 rounded" :class="typeClass(idea.type)">{{ typeLabel(idea.type) }}</span>
                                <span class="w-2 h-2 rounded-full flex-shrink-0 bg-emerald-400" title="Ausgearbeitet"></span>
                            </div>
                            <div class="text-sm font-medium text-ink leading-snug mb-2">{{ idea.title || '(ohne Titel)' }}</div>
                            <div v-if="bodyPreview(idea)" class="text-[12px] text-ink-3 leading-snug line-clamp-3 mb-2">{{ bodyPreview(idea) }}</div>
                            <div v-if="idea.tags && idea.tags.length" class="flex flex-wrap gap-1 mb-2">
                                <span v-for="tag in idea.tags" :key="tag" class="text-[10px] text-ink-3 bg-bg-soft px-1.5 py-0.5 rounded">#{{ tag }}</span>
                            </div>
                            <div class="flex items-center gap-3 text-[11px] text-mute">
                                <span v-if="idea.refs && idea.refs.length">📎 {{ idea.refs.length }}</span>
                                <span v-if="idea.diss && idea.diss.length">🎓 {{ idea.diss.length }}</span>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Collapsed section: Geparkt (parked) -->
                <div v-if="parkedIdeas.length">
                    <button @click="sectionsOpen.parked = !sectionsOpen.parked"
                            class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-mute hover:text-ink transition-colors w-full text-left py-2 border-b border-hairline mb-3">
                        <span>{{ sectionsOpen.parked ? '▾' : '▸' }}</span>
                        <span>Geparkt</span>
                        <span class="font-normal normal-case">({{ parkedIdeas.length }})</span>
                    </button>
                    <div v-show="sectionsOpen.parked" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                        <div v-for="idea in parkedIdeas" :key="idea.id"
                             @click="selectedId = idea.id"
                             class="cursor-pointer bg-white border border-hairline rounded-xl p-4 hover:border-accent transition-colors opacity-60"
                             :class="{ 'border-accent ring-1 ring-accent opacity-100': idea.id === selectedId }">
                            <div class="flex items-center gap-2 mb-2">
                                <span class="text-[10px] font-medium px-1.5 py-0.5 rounded" :class="typeClass(idea.type)">{{ typeLabel(idea.type) }}</span>
                                <span class="w-2 h-2 rounded-full flex-shrink-0 bg-gray-300" title="Geparkt"></span>
                            </div>
                            <div class="text-sm font-medium text-ink leading-snug mb-2">{{ idea.title || '(ohne Titel)' }}</div>
                            <div v-if="bodyPreview(idea)" class="text-[12px] text-ink-3 leading-snug line-clamp-3 mb-2">{{ bodyPreview(idea) }}</div>
                            <div v-if="idea.tags && idea.tags.length" class="flex flex-wrap gap-1 mb-2">
                                <span v-for="tag in idea.tags" :key="tag" class="text-[10px] text-ink-3 bg-bg-soft px-1.5 py-0.5 rounded">#{{ tag }}</span>
                            </div>
                            <div class="flex items-center gap-3 text-[11px] text-mute">
                                <span v-if="idea.refs && idea.refs.length">📎 {{ idea.refs.length }}</span>
                                <span v-if="idea.diss && idea.diss.length">🎓 {{ idea.diss.length }}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            </template>

            <!-- ===== DISSERTATION TAB (flat chapter list, ADR-0005, issue #62) ===== -->
            <template v-else-if="tab === 'dissertation'">
                <div v-if="dissLoading" class="text-sm text-mute">Lädt…</div>
                <div v-else>
                    <!-- Page header -->
                    <div class="flex items-center justify-between mb-4">
                        <h2 class="text-base font-semibold text-ink">Dissertation</h2>
                        <div class="flex items-center gap-2">
                            <button v-if="dissChapters.length" @click="deleteAllNodes" class="px-3 py-1.5 rounded-lg text-sm font-medium border border-red-300 text-red-600 hover:bg-red-50 transition-colors">Gliederung komplett löschen</button>
                            <button @click="openNodeCreate" class="bg-accent text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-accent-ink transition-colors">+ Kapitel</button>
                        </div>
                    </div>
                    <!-- Integrity warnings -->
                    <div v-if="dissIssues.length" class="mb-4 bg-amber-50 border border-amber-200 rounded-lg p-3">
                        <p class="text-xs font-medium text-amber-800 mb-1">Integritätswarnungen</p>
                        <ul class="list-disc pl-4 text-xs text-amber-700 space-y-0.5">
                            <li v-for="(it, i) in dissIssues" :key="i"><span class="font-mono">{{ it.id }}</span>: {{ it.issue }}</li>
                        </ul>
                    </div>
                    <!-- Empty state -->
                    <div v-if="!dissChapters.length" class="border border-dashed border-hairline-2 rounded-xl p-10 text-center">
                        <p class="text-ink font-medium mb-1">Noch keine Kapitel</p>
                        <p class="text-sm text-mute">Gliedere deine kumulative Dissertation als flache Kapitelliste.</p>
                    </div>
                    <div v-else>
                        <!-- Progress bar -->
                        <div class="bg-white border border-hairline rounded-xl px-5 py-3 mb-4 flex items-center gap-4">
                            <span class="text-sm text-mute flex-shrink-0">Fortschritt</span>
                            <div class="flex-1 bg-bg-soft rounded-full h-2 overflow-hidden">
                                <div class="h-full bg-accent rounded-full transition-all" :style="{ width: dissProgressFraction + '%' }"></div>
                            </div>
                            <span class="text-sm text-mute flex-shrink-0 whitespace-nowrap">{{ dissProgress.with_body || 0 }} von {{ dissProgress.total || 0 }} Kapiteln verfasst</span>
                        </div>
                        <!-- Flat chapter list -->
                        <div class="bg-white border border-hairline rounded-xl divide-y divide-hairline overflow-hidden">
                            <div v-for="(chapter, idx) in dissChapters" :key="chapter.id" class="px-4 py-3">
                                <div class="flex items-center gap-2">
                                    <span class="text-xs font-mono text-mute w-5 flex-shrink-0 text-right select-none">{{ idx + 1 }}</span>
                                    <button @click="selectNode(chapter.id)" class="flex-1 text-left text-sm font-medium text-ink hover:text-accent-ink transition-colors truncate min-w-0">{{ chapter.title || '(ohne Titel)' }}</button>
                                    <span class="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0" :class="nodeStatusClass(chapter.status)">{{ nodeStatusLabel(chapter.status) }}</span>
                                    <button v-if="idx > 0" @click.stop="moveChapterUp(chapter)" class="text-mute hover:text-ink px-1 text-xs leading-none flex-shrink-0" title="Nach oben verschieben">▲</button>
                                    <span v-else class="w-4 flex-shrink-0"></span>
                                    <button v-if="idx < dissChapters.length - 1" @click.stop="moveChapterDown(chapter)" class="text-mute hover:text-ink px-1 text-xs leading-none flex-shrink-0" title="Nach unten verschieben">▼</button>
                                    <span v-else class="w-4 flex-shrink-0"></span>
                                </div>
                                <!-- Publications + body warning sub-row -->
                                <div v-if="chapterPublicationsResolved(chapter).length || !chapter.body || !chapter.body.trim()" class="mt-1.5 ml-7 flex flex-wrap items-center gap-x-3 gap-y-1">
                                    <span v-for="p in chapterPublicationsResolved(chapter)" :key="p.id" class="inline-flex items-center gap-1 text-xs text-ink-2">
                                        <span v-if="p.found" class="text-[10px] px-1 py-0.5 rounded flex-shrink-0" :class="pubStatusClass(p.status)">{{ pubStatusLabel(p.status) }}</span>
                                        <span v-if="!p.found" class="text-[10px] text-amber-600 flex-shrink-0">⚠</span>
                                        <span class="truncate max-w-[200px]">{{ p.found ? p.title : p.id }}</span>
                                    </span>
                                    <span v-if="!chapter.body || !chapter.body.trim()" class="text-[11px] text-amber-600">⚠ noch kein Inhalt</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Chapter detail drawer (#66: always-editable body, no view/edit
                     toggle; #180: das Kapitel ist die Drehscheibe — Kennzahlen,
                     Tasks, Zettel, Literatur und Rückverweise an einem Ort) -->
                <div v-if="selectedNode" class="fixed inset-0 bg-black/30 flex justify-end z-40" @click.self="closeNodeDrawer">
                    <div class="bg-bg w-full max-w-[95vw] h-full overflow-y-auto shadow-modal">
                        <div class="sticky top-0 bg-bg border-b border-hairline px-6 py-4 flex items-start justify-between gap-4 z-10">
                            <div class="flex-1 min-w-0">
                                <h2 class="text-xl font-semibold text-ink font-serif">{{ selectedNode.title }}</h2>
                                <p class="text-[11px] text-mute mt-0.5">
                                    Kapitel {{ nodePosition }} von {{ dissChapters.length }}
                                    <template v-if="selectedNode.path"> · <span class="font-mono">dissertation/{{ nodeFileName }}</span></template>
                                </p>
                            </div>
                            <div class="flex items-center gap-3 flex-shrink-0">
                                <!-- Status-Dropdown: speichert sofort bei Änderung -->
                                <select v-model="nodeEdit.status" @change="saveNodeEdit"
                                        class="border border-hairline rounded-lg px-2 py-1 text-xs bg-white focus:ring-2 focus:ring-accent outline-none">
                                    <option v-for="s in dissStatuses" :key="s.key" :value="s.key">{{ s.label }}</option>
                                </select>
                                <button @click="closeNodeDrawer" class="text-mute hover:text-ink text-xl leading-none">×</button>
                            </div>
                        </div>

                        <!-- Kennzahlen (Story 52) -->
                        <div class="atlas-metrics px-8 pt-6">
                            <div class="atlas-metric">
                                <div class="atlas-metric-n">{{ nodePublications.length }}</div>
                                <div class="atlas-metric-l">Veröffentlichungen</div>
                            </div>
                            <div class="atlas-metric">
                                <div class="atlas-metric-n">{{ nodeMetrics.zettel_count || 0 }}</div>
                                <div class="atlas-metric-l">Zettel</div>
                            </div>
                            <div class="atlas-metric">
                                <div class="atlas-metric-n" :class="{ 'is-warn': nodeMetrics.open_task_count }">{{ nodeMetrics.open_task_count || 0 }}</div>
                                <div class="atlas-metric-l">offene Tasks</div>
                            </div>
                            <div class="atlas-metric">
                                <div class="atlas-metric-n">{{ nodeMetrics.ref_count || 0 }}</div>
                                <div class="atlas-metric-l">Referenzen</div>
                            </div>
                            <div class="atlas-metric">
                                <div class="atlas-metric-n is-small">{{ relativeTime(nodeMetrics.modified_at) }}</div>
                                <div class="atlas-metric-l">letzte Änderung</div>
                            </div>
                        </div>

                        <!-- Always-editable two-column layout (follows #56 widened drawer pattern) -->
                        <div class="grid grid-cols-3 gap-8 p-8">
                            <div class="col-span-2 space-y-6">
                                <div class="space-y-3">
                                    <label class="block text-[11px] uppercase tracking-wide text-mute">Skizze (Markdown)</label>
                                    <textarea v-model="nodeEdit.body" rows="14"
                                              placeholder="Forschungsfrage, geplante Inhalte und Methoden dieses Kapitels…"
                                              class="w-full border border-hairline rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-accent outline-none resize-y"></textarea>
                                    <p v-if="nodeError" class="text-xs text-red-600">{{ nodeError }}</p>
                                    <div class="flex items-center justify-between gap-3">
                                        <p class="text-[11px] text-mute">Verweise im Body (<code>[[id]]</code>) werden beim Indexieren zu Kanten — daraus entstehen die Rückverweise.</p>
                                        <button @click="saveNodeEdit" :disabled="savingNode"
                                                class="bg-accent text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-accent-ink disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex-shrink-0">
                                            {{ savingNode ? 'Speichert…' : 'Speichern' }}
                                        </button>
                                    </div>
                                </div>

                                <!-- Offene Tasks an diesem Kapitel (Story 50) -->
                                <atlas-anchor-tasks :key="'nt-' + selectedNode.id" :anchor="selectedNode.id"
                                                    label="Offene Tasks an diesem Kapitel" @changed="refreshNodeHub" />

                                <div>
                                    <div class="flex items-center justify-between mb-1">
                                        <p class="text-[11px] uppercase tracking-wide text-mute">Veröffentlichungen</p>
                                        <button @click="toggleNodePubPicker" class="text-[11px] font-medium text-accent-ink hover:underline">+ zuordnen</button>
                                    </div>
                                    <ul v-if="nodePublications.length" class="space-y-1.5">
                                        <li v-for="p in nodePublications" :key="p.id" class="flex items-center gap-2">
                                            <span v-if="!p.found" class="text-[10px] text-amber-600 flex-shrink-0" title="Hängender Verweis: Veröffentlichung nicht vorhanden">⚠</span>
                                            <button v-if="p.found" @click="openPublicationFromNode(p.id)" class="text-xs text-accent-ink hover:underline flex-1 text-left break-all">{{ p.title }}</button>
                                            <span v-else class="text-xs font-mono text-amber-700 flex-1 break-all">{{ p.id }}</span>
                                            <button @click="unassignNodePublication(p.id)" class="text-mute hover:text-ink" title="Verknüpfung lösen">×</button>
                                        </li>
                                    </ul>
                                    <p v-else class="text-xs text-mute-2">—</p>
                                    <div v-if="showNodePubPicker" class="mt-2 border border-hairline rounded-lg p-2 bg-white">
                                        <input v-model="nodePubFilter" placeholder="Veröffentlichung suchen…" class="w-full border border-hairline rounded px-2 py-1 text-xs mb-2 focus:ring-2 focus:ring-accent outline-none" />
                                        <div class="max-h-44 overflow-y-auto space-y-0.5">
                                            <button v-for="p in assignableNodePublications" :key="p.id" @click="assignNodePublication(p.id)"
                                                    class="w-full text-left text-xs px-2 py-1 rounded hover:bg-bg-soft">{{ p.title }} <span class="text-mute">· {{ pubStatusLabel(p.status) }}</span></button>
                                            <p v-if="!assignableNodePublications.length" class="text-xs text-mute-2 px-2 py-1">Keine weiteren Veröffentlichungen</p>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div class="col-span-1 space-y-5">
                                <!-- Verlinkte Zettel (Story 49) -->
                                <section class="atlas-sec">
                                    <div class="atlas-sec-head">
                                        <h3 class="atlas-sec-title">Verlinkte Zettel<template v-if="nodeZettel.length"> · {{ nodeZettel.length }}</template></h3>
                                        <router-link to="/atlas/zettel" class="atlas-link-btn" style="text-decoration:none">alle</router-link>
                                    </div>
                                    <div class="atlas-card">
                                        <p v-if="!nodeZettel.length" class="atlas-empty">
                                            Kein Zettel verweist auf dieses Kapitel. Ein <code>[[{{ selectedNode.id }}]]</code> im Zettel-Text genügt.
                                        </p>
                                        <router-link v-for="z in nodeZettel" :key="z.id" class="atlas-list-row"
                                                     :to="'/atlas/zettel/' + encodeURIComponent(z.id)">
                                            <div class="atlas-list-top">
                                                <span class="atlas-list-title">{{ z.title || z.id }}</span>
                                            </div>
                                        </router-link>
                                    </div>
                                </section>

                                <!-- Literatur aus Kapitel + verlinkten Zetteln (Story 51) -->
                                <section class="atlas-sec">
                                    <div class="atlas-sec-head">
                                        <h3 class="atlas-sec-title">Literatur<template v-if="nodeLiterature.length"> · {{ nodeLiterature.length }}</template></h3>
                                        <span class="atlas-sec-note">Kapitel + Zettel</span>
                                    </div>
                                    <div class="atlas-card">
                                        <p v-if="!nodeLiterature.length" class="atlas-empty">
                                            Noch keine Referenzen — sie kommen aus den zugeordneten Veröffentlichungen und den verlinkten Zetteln.
                                        </p>
                                        <div v-for="r in nodeLiteratureShown" :key="r.citekey" class="atlas-lit">
                                            <span class="atlas-lit-key">{{ r.citekey }}</span>
                                            <button v-if="r.found" class="atlas-lit-title" @click="$router.push('/paper/' + r.paper_id)">{{ r.title }}</button>
                                            <span v-else class="atlas-lit-title is-missing" title="Cite Key nicht in der Bibliothek">nicht in der Bibliothek ⚠</span>
                                        </div>
                                        <button v-if="nodeLiterature.length > nodeLiteratureShown.length" type="button"
                                                class="atlas-link-btn" style="padding:8px 14px" @click="nodeLitAll = true">
                                            … {{ nodeLiterature.length - nodeLiteratureShown.length }} weitere zeigen
                                        </button>
                                    </div>
                                </section>

                                <!-- Rückverweise, ohne die Zettel (die stehen schon oben) -->
                                <!-- data ist vorgeladen (der Drawer liest die Rückverweise
                                     ohnehin für „Verlinkte Zettel"), id nur, damit der
                                     Leerzustand die echte Kapitel-ID nennt. -->
                                <atlas-backlinks :key="'nb-' + selectedNode.id" :data="nodeBacklinks"
                                                 :id="selectedNode.id"
                                                 :exclude="['zettel']" @changed="refreshNodeHub" />

                                <div class="pt-2 border-t border-hairline text-[11px] text-mute space-y-1">
                                    <div>ID: <span class="font-mono">{{ selectedNode.id }}</span></div>
                                    <div>Reihenfolge: {{ selectedNode.order }}</div>
                                </div>
                                <div class="pt-4 border-t border-red-100">
                                    <button @click="deleteNode" class="w-full text-center px-3 py-2 rounded-lg text-sm font-medium border border-red-300 text-red-600 hover:bg-red-50 transition-colors">Kapitel löschen</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- New chapter modal -->
                <div v-if="showNodeCreate" class="fixed inset-0 bg-black/30 flex items-start justify-center z-50 pt-28" @click.self="showNodeCreate = false">
                    <div class="bg-white rounded-xl shadow-modal p-5 w-full max-w-lg">
                        <h3 class="text-base font-semibold text-ink mb-3">Neues Kapitel</h3>
                        <input ref="nodeTitle" v-model="nodeCreate.title" @keydown.enter="submitNodeCreate"
                               placeholder="Titel, z. B. Materialcharakterisierung"
                               class="w-full border border-hairline rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-accent outline-none mb-3" />
                        <p v-if="nodeError" class="text-xs text-red-600 mb-2">{{ nodeError }}</p>
                        <div class="flex justify-end gap-2">
                            <button @click="showNodeCreate = false" class="px-4 py-2 text-sm text-ink-3 hover:text-ink transition-colors">Abbrechen</button>
                            <button @click="submitNodeCreate" :disabled="!nodeCreate.title.trim() || savingNode"
                                    class="bg-accent text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-accent-ink disabled:opacity-40 disabled:cursor-not-allowed transition-colors">Erstellen</button>
                        </div>
                    </div>
                </div>
            </template>

            <!-- ===== VERÖFFENTLICHUNGEN TAB (atlas.publication/1, ADR-0004) ===== -->
            <template v-else-if="tab === 'veroeffentlichungen'">
                <div v-if="publicationsLoading" class="text-sm text-mute">Lädt…</div>
                <div v-else-if="!publications.length" class="border border-dashed border-hairline-2 rounded-xl p-10 text-center">
                    <p class="text-ink font-medium mb-1">Noch keine Veröffentlichungen</p>
                    <p class="text-sm text-mute mb-4">Archiviere geplante, laufende und fertige eigene Publikationen.</p>
                    <button @click="openPublicationCreate" class="bg-accent text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-accent-ink transition-colors">+ Erste Veröffentlichung</button>
                </div>
                <!-- Lifecycle-Gruppen (Issue #60) -->
                <div v-else class="space-y-6 max-w-3xl">
                    <template v-for="group in publicationGroups" :key="group.key">
                        <div>
                            <!-- Abschnittsüberschrift mit Einklapp-Toggle -->
                            <button @click="toggleSection(group.key)"
                                    class="flex items-center gap-2 mb-3 w-full text-left select-none">
                                <span class="text-[11px] uppercase tracking-wide text-mute font-medium flex-1">{{ group.label }} <span class="text-mute-2 normal-case">({{ group.pubs.length }})</span></span>
                                <span class="text-mute text-xs">{{ isSectionCollapsed(group.key) ? '▶' : '▼' }}</span>
                            </button>

                            <div v-if="!isSectionCollapsed(group.key)">

                                <!-- In Arbeit (drafting / in-revision): große Karten -->
                                <template v-if="group.key === 'in-arbeit'">
                                    <div class="space-y-3">
                                        <button v-for="p in group.pubs" :key="p.id" @click="selectPublication(p.id)"
                                                class="w-full text-left bg-white border border-hairline rounded-xl p-4 hover:border-accent transition-colors">
                                            <div class="flex items-center gap-2 mb-2">
                                                <span class="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0" :class="pubStatusClass(p.status)">{{ pubStatusLabel(p.status) }}</span>
                                                <span v-if="p.type" class="text-[10px] px-1.5 py-0.5 rounded bg-bg-soft text-ink-3 flex-shrink-0">{{ pubTypeLabel(p.type) }}</span>
                                                <span v-if="p.errors && p.errors.length" title="Validierungswarnung" class="text-[10px] text-amber-600 flex-shrink-0">⚠</span>
                                                <span v-if="p.due" class="text-[11px] text-amber-700 flex-shrink-0 ml-auto">fällig {{ p.due }}</span>
                                            </div>
                                            <p class="text-base font-semibold text-ink">{{ p.title }}</p>
                                            <p v-if="p.venue" class="text-xs text-mute mt-0.5 truncate">{{ p.venue }}</p>
                                            <div class="flex flex-wrap gap-3 mt-2 text-[11px] text-mute">
                                                <span v-if="p.refs && p.refs.length">📎 {{ p.refs.length }} Ref.</span>
                                                <span v-if="p.manuscripts && p.manuscripts.length">📝 {{ p.manuscripts.length }}</span>
                                                <span v-if="pubLinkedChapters(p.id).length">📖 {{ pubLinkedChapters(p.id).length }} Kap.</span>
                                            </div>
                                            <div v-if="p.tags && p.tags.length" class="flex flex-wrap gap-1 mt-2">
                                                <span v-for="t in p.tags" :key="t" class="text-[10px] text-ink-3 bg-bg-soft px-1.5 py-0.5 rounded">#{{ t }}</span>
                                            </div>
                                        </button>
                                    </div>
                                </template>

                                <!-- Eingereicht: kompakte Zeilen mit Wartezeit -->
                                <template v-else-if="group.key === 'eingereicht'">
                                    <div class="space-y-1.5">
                                        <button v-for="p in group.pubs" :key="p.id" @click="selectPublication(p.id)"
                                                class="w-full text-left bg-white border border-hairline rounded-lg px-4 py-2.5 hover:border-accent transition-colors flex items-center gap-3">
                                            <span class="text-sm font-medium text-ink flex-1 truncate">{{ p.title }}</span>
                                            <span v-if="p.venue" class="text-xs text-mute flex-shrink-0 truncate max-w-[160px]">{{ p.venue }}</span>
                                            <span v-if="p.submitted" class="text-[11px] text-amber-700 flex-shrink-0 whitespace-nowrap">⏳ {{ waitingDays(p.submitted) }} Tage</span>
                                        </button>
                                    </div>
                                </template>

                                <!-- Veröffentlicht: CV-Zeilen (Jahr · Titel · Venue) -->
                                <template v-else-if="group.key === 'veroeffentlicht'">
                                    <div class="space-y-1">
                                        <button v-for="p in group.pubs" :key="p.id" @click="selectPublication(p.id)"
                                                class="w-full text-left text-sm text-ink hover:text-accent-ink transition-colors py-1 px-1">
                                            <span v-if="p.published" class="text-mute font-mono">{{ p.published.slice(0, 4) }}</span><span v-if="p.published"> · </span><span class="font-medium">{{ p.title }}</span><span v-if="p.venue" class="text-mute"> · {{ p.venue }}</span>
                                        </button>
                                    </div>
                                </template>

                                <!-- Geplant / Abgelehnt / Zurückgezogen: einfache Liste -->
                                <template v-else>
                                    <div class="space-y-1.5">
                                        <button v-for="p in group.pubs" :key="p.id" @click="selectPublication(p.id)"
                                                class="w-full text-left bg-white border border-hairline rounded-lg px-4 py-2.5 hover:border-accent transition-colors flex items-center gap-3">
                                            <span class="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0" :class="pubStatusClass(p.status)">{{ pubStatusLabel(p.status) }}</span>
                                            <span class="text-sm text-ink flex-1 truncate">{{ p.title }}</span>
                                            <span v-if="p.venue" class="text-xs text-mute truncate max-w-[160px]">{{ p.venue }}</span>
                                        </button>
                                    </div>
                                </template>

                            </div><!-- /collapse -->
                        </div>
                    </template>
                </div>

                <!-- Nicht zugeordnete Manuskripte (Issue #45): Verzeichnisliste minus
                     alle verlinkten — verwaiste .tex bleiben ohne eigenen Tab auffindbar. -->
                <div v-if="!publicationsLoading && (unassignedManuscripts.length || focusManuscripts)"
                     id="atlas-manuskripte" ref="manuskripte" class="max-w-3xl mt-8">
                    <p class="text-[11px] uppercase tracking-wide text-mute mb-2">Nicht zugeordnete Manuskripte</p>
                    <p v-if="!unassignedManuscripts.length" class="text-xs text-mute">
                        Jedes <code>.tex</code> in <code>manuskripte/</code> ist einer Veröffentlichung zugeordnet —
                        hier steht nur, was noch keiner gehört.
                    </p>
                    <div class="space-y-1.5">
                        <div v-for="m in unassignedManuscripts" :key="m.id" class="flex items-center gap-3 bg-white border border-hairline rounded-lg px-3 py-2">
                            <button @click="openManuscriptFromPublication(m.id)" class="text-xs font-mono text-accent-ink hover:underline flex-1 text-left truncate" title="Im LaTeX-Editor öffnen">{{ m.id }}.tex</button>
                            <span class="text-[11px] text-mute flex-shrink-0">{{ (m.modified || '').slice(0, 10) }}</span>
                            <select v-if="publications.length" class="border border-hairline rounded-lg px-2 py-1 text-xs bg-white focus:ring-2 focus:ring-accent outline-none flex-shrink-0"
                                    @change="assignManuscript(m.id, $event)">
                                <option value="">Zuordnen zu…</option>
                                <option v-for="p in publications" :key="p.id" :value="p.id">{{ p.title }}</option>
                            </select>
                        </div>
                    </div>
                </div>

                <!-- Publication drawer -->
                <div v-if="selectedPublication" class="fixed inset-0 bg-black/30 flex justify-end z-40" @click.self="closePublicationDrawer">
                    <div class="bg-bg w-full max-w-[95vw] h-full overflow-y-auto shadow-modal">
                        <div class="sticky top-0 bg-bg border-b border-hairline px-6 py-4 flex items-start justify-between">
                            <div>
                                <div class="flex items-center gap-2 mb-1">
                                    <span class="text-[10px] px-1.5 py-0.5 rounded" :class="pubStatusClass(selectedPublication.status)">{{ pubStatusLabel(selectedPublication.status) }}</span>
                                    <span v-if="selectedPublication.type" class="text-[10px] px-1.5 py-0.5 rounded bg-bg-soft text-ink-3">{{ pubTypeLabel(selectedPublication.type) }}</span>
                                    <span v-if="selectedPublication.venue" class="text-[11px] text-mute">{{ selectedPublication.venue }}</span>
                                </div>
                                <h2 class="text-xl font-semibold text-ink font-serif">{{ selectedPublication.title }}</h2>
                            </div>
                            <div class="flex items-center gap-3">
                                <button v-if="!publicationEditing" @click="startPublicationEdit" class="text-xs font-medium text-accent-ink hover:underline">Bearbeiten</button>
                                <button @click="closePublicationDrawer" class="text-mute hover:text-ink text-xl leading-none">×</button>
                            </div>
                        </div>

                        <div v-if="!publicationEditing && selectedPublication.errors && selectedPublication.errors.length" class="mx-6 mt-4 bg-amber-50 border border-amber-200 rounded-lg p-3">
                            <p class="text-xs font-medium text-amber-800 mb-1">Validierungswarnungen</p>
                            <ul class="list-disc pl-4 text-xs text-amber-700 space-y-0.5">
                                <li v-for="(e, i) in selectedPublication.errors" :key="i">{{ e }}</li>
                            </ul>
                        </div>

                        <div v-if="!publicationEditing" class="grid grid-cols-3 gap-8 p-8">
                            <div class="col-span-2">
                                <div v-if="selectedPublication.body && selectedPublication.body.trim()" class="font-serif text-[15.5px] text-ink-2 leading-relaxed" v-html="renderBody(selectedPublication.body)"></div>
                                <p v-else class="text-sm text-mute italic">Keine Notizen. Über „Bearbeiten" Abstract-Entwurf, Plan oder Verlauf ergänzen.</p>

                                <div class="mt-6">
                                    <div class="flex items-center justify-between mb-2">
                                        <p class="text-[11px] uppercase tracking-wide text-mute">Referenzen (Bibliographie)</p>
                                        <button @click="openBibtexImport" class="text-[11px] font-medium text-accent-ink hover:underline">+ .bib importieren</button>
                                    </div>
                                    <ul v-if="publicationRefsResolved.length" class="space-y-1">
                                        <li v-for="r in publicationRefsResolved" :key="r.citekey" class="text-xs">
                                            <button v-if="r.found" @click="$router.push('/paper/' + r.paper_id)"
                                                    class="text-left text-accent-ink hover:underline">{{ r.title || r.citekey }}</button>
                                            <span v-else class="text-amber-700" title="Citekey nicht in Bibliothek">{{ r.citekey }} ⚠</span>
                                            <span v-if="r.found" class="text-mute font-mono"> · {{ r.citekey }}</span>
                                        </li>
                                    </ul>
                                    <p v-else class="text-xs text-mute-2">Keine Paper verknüpft.</p>
                                </div>
                            </div>
                            <div class="col-span-1 space-y-4">
                                <div v-if="selectedPublication.authors && selectedPublication.authors.length">
                                    <p class="text-[11px] uppercase tracking-wide text-mute mb-1">Autor:innen</p>
                                    <ul class="space-y-0.5">
                                        <li v-for="a in selectedPublication.authors" :key="a" class="text-xs text-ink-2">{{ a }}</li>
                                    </ul>
                                </div>
                                <div v-if="selectedPublication.submitted || selectedPublication.published || selectedPublication.due">
                                    <p class="text-[11px] uppercase tracking-wide text-mute mb-1">Daten</p>
                                    <div class="text-xs text-ink-2 space-y-0.5">
                                        <div v-if="selectedPublication.due">Fällig: {{ selectedPublication.due }}</div>
                                        <div v-if="selectedPublication.submitted">Eingereicht: {{ selectedPublication.submitted }}</div>
                                        <div v-if="selectedPublication.published">Veröffentlicht: {{ selectedPublication.published }}</div>
                                    </div>
                                </div>
                                <div>
                                    <p class="text-[11px] uppercase tracking-wide text-mute mb-1">Manuskripte</p>
                                    <ul v-if="publicationManuscriptsResolved.length" class="space-y-1">
                                        <li v-for="m in publicationManuscriptsResolved" :key="m.name" class="text-xs flex items-center gap-1.5">
                                            <button v-if="m.found" @click="openManuscriptFromPublication(m.id)" class="text-accent-ink hover:underline font-mono truncate" title="Im LaTeX-Editor öffnen">{{ m.name }}</button>
                                            <span v-else class="text-amber-700 font-mono truncate" title=".tex nicht vorhanden — hängender Verweis">{{ m.name }} ⚠</span>
                                            <button @click="unlinkManuscript(m.name)" class="text-mute hover:text-red-600 leading-none flex-shrink-0" title="Verknüpfung lösen (Datei bleibt erhalten)">×</button>
                                        </li>
                                    </ul>
                                    <p v-else class="text-xs text-mute-2">—</p>
                                    <select v-if="unassignedManuscripts.length" class="mt-2 w-full border border-hairline rounded-lg px-2 py-1 text-xs bg-white focus:ring-2 focus:ring-accent outline-none"
                                            @change="linkManuscript($event)">
                                        <option value="">+ Vorhandenes Manuskript verknüpfen…</option>
                                        <option v-for="m in unassignedManuscripts" :key="m.id" :value="m.id">{{ m.id }}.tex</option>
                                    </select>
                                    <div class="mt-2 flex items-center gap-3">
                                        <label class="text-xs font-medium text-accent-ink hover:underline cursor-pointer">
                                            {{ manuscriptUploading ? 'Lädt hoch…' : '↑ .tex hochladen' }}
                                            <input type="file" accept=".tex" class="hidden" @change="uploadManuscriptToPublication" :disabled="manuscriptUploading" />
                                        </label>
                                        <span class="text-mute-2">·</span>
                                        <button @click="createManuscriptForPublication" class="text-xs font-medium text-accent-ink hover:underline">+ Neu erstellen</button>
                                    </div>
                                    <p v-if="manuscriptUploadError" class="text-xs text-red-600 mt-1">{{ manuscriptUploadError }}</p>
                                </div>
                                <div>
                                    <p class="text-[11px] uppercase tracking-wide text-mute mb-1">Hervorgegangen aus (Ideen)</p>
                                    <ul v-if="publicationOrigins.length" class="space-y-1">
                                        <li v-for="o in publicationOrigins" :key="o.id" class="text-xs">
                                            <button v-if="o.kind === 'idea'" @click="openIdeaFromPublication(o.id)" class="text-accent-ink hover:underline">{{ o.title }}</button>
                                            <span v-else class="text-amber-700" title="Idee nicht vorhanden">{{ o.id }} ⚠</span>
                                        </li>
                                    </ul>
                                    <p v-else class="text-xs text-mute-2">—</p>
                                </div>
                                <div>
                                    <p class="text-[11px] uppercase tracking-wide text-mute mb-1">Forschungsprojekte</p>
                                    <ul v-if="publicationProjectsResolved.length" class="space-y-1">
                                        <li v-for="pr in publicationProjectsResolved" :key="pr.id" class="text-xs">
                                            <button v-if="pr.found" @click="openProjectFromPublication(pr.id)" class="text-accent-ink hover:underline text-left">{{ pr.title }}</button>
                                            <span v-else class="text-amber-700" title="Projekt nicht vorhanden — hängender Verweis">{{ pr.id }} ⚠</span>
                                        </li>
                                    </ul>
                                    <p v-else class="text-xs text-mute-2">—</p>
                                </div>
                                <div>
                                    <p class="text-[11px] uppercase tracking-wide text-mute mb-1">Eigenes Paper (Bibliothek)</p>
                                    <template v-if="publicationPaperResolved">
                                        <button v-if="publicationPaperResolved.found" @click="$router.push('/paper/' + publicationPaperResolved.paper_id)"
                                                class="text-xs text-accent-ink hover:underline font-mono">{{ publicationPaperResolved.citekey }}</button>
                                        <span v-else class="text-xs text-amber-700 font-mono" title="Citekey nicht in Bibliothek">{{ publicationPaperResolved.citekey }} ⚠</span>
                                    </template>
                                    <p v-else class="text-xs text-mute-2">—</p>
                                </div>
                                <div>
                                    <p class="text-[11px] uppercase tracking-wide text-mute mb-1">Tags</p>
                                    <div v-if="selectedPublication.tags.length" class="flex flex-wrap gap-1">
                                        <span v-for="t in selectedPublication.tags" :key="t" class="text-[11px] text-ink-3 bg-bg-soft px-1.5 py-0.5 rounded">#{{ t }}</span>
                                    </div>
                                    <p v-else class="text-xs text-mute-2">—</p>
                                </div>
                                <!-- Rückverweise (#180, Story 53) -->
                                <atlas-backlinks :key="'pb-' + selectedPublication.id" :id="selectedPublication.id" />
                                <div class="pt-2 border-t border-hairline text-[11px] text-mute">
                                    ID: <span class="font-mono">{{ selectedPublication.id }}</span>
                                </div>
                            </div>
                        </div>

                        <!-- Edit form: all frontmatter fields -->
                        <div v-else class="p-6 space-y-4">
                            <div>
                                <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">Titel</label>
                                <input v-model="publicationEdit.title" class="w-full border border-hairline rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-accent outline-none" />
                            </div>
                            <div class="flex gap-3">
                                <div class="flex-1">
                                    <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">Status</label>
                                    <select v-model="publicationEdit.status" class="w-full border border-hairline rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-accent outline-none">
                                        <option v-for="s in publicationStatuses" :key="s.key" :value="s.key">{{ s.label }}</option>
                                    </select>
                                </div>
                                <div class="flex-1">
                                    <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">Art</label>
                                    <select v-model="publicationEdit.type" class="w-full border border-hairline rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-accent outline-none">
                                        <option value="">—</option>
                                        <option v-for="t in publicationTypes" :key="t.key" :value="t.key">{{ t.label }}</option>
                                    </select>
                                </div>
                            </div>
                            <div>
                                <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">Venue (Journal / Konferenz / Verlag)</label>
                                <input v-model="publicationEdit.venue" class="w-full border border-hairline rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-accent outline-none" />
                            </div>
                            <div>
                                <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">Autor:innen (eine pro Zeile)</label>
                                <textarea v-model="publicationEdit.authors" rows="2" class="w-full border border-hairline rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-accent outline-none"></textarea>
                            </div>
                            <div class="flex gap-3">
                                <div class="flex-1">
                                    <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">Fällig</label>
                                    <input v-model="publicationEdit.due" type="date" class="w-full border border-hairline rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-accent outline-none" />
                                </div>
                                <div class="flex-1">
                                    <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">Eingereicht</label>
                                    <input v-model="publicationEdit.submitted" type="date" class="w-full border border-hairline rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-accent outline-none" />
                                </div>
                                <div class="flex-1">
                                    <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">Veröffentlicht</label>
                                    <input v-model="publicationEdit.published" type="date" class="w-full border border-hairline rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-accent outline-none" />
                                </div>
                            </div>
                            <div>
                                <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">Tags (kommagetrennt)</label>
                                <input v-model="publicationEdit.tags" class="w-full border border-hairline rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-accent outline-none" />
                            </div>
                            <div>
                                <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">Referenzen (Cite Keys, einer pro Zeile)</label>
                                <textarea v-model="publicationEdit.refs" rows="3" class="w-full border border-hairline rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-accent outline-none"></textarea>
                            </div>
                            <div>
                                <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">Hervorgegangen aus (Ideen-IDs, eine pro Zeile)</label>
                                <textarea v-model="publicationEdit.derived_from" rows="2" class="w-full border border-hairline rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-accent outline-none"></textarea>
                            </div>
                            <div>
                                <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">Manuskripte (.tex-Namen, einer pro Zeile)</label>
                                <textarea v-model="publicationEdit.manuscripts" rows="2" class="w-full border border-hairline rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-accent outline-none"></textarea>
                            </div>
                            <div>
                                <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">Forschungsprojekte (IDs, eine pro Zeile)</label>
                                <textarea v-model="publicationEdit.projects" rows="2" class="w-full border border-hairline rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-accent outline-none"></textarea>
                            </div>
                            <div>
                                <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">Eigenes Paper (Cite Key, nach Import in die Bibliothek)</label>
                                <input v-model="publicationEdit.paper" placeholder="z. B. bartlog2026fgc" class="w-full border border-hairline rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-accent outline-none" />
                            </div>
                            <div>
                                <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">Notizen (Markdown)</label>
                                <textarea v-model="publicationEdit.body" rows="8" class="w-full border border-hairline rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-accent outline-none"></textarea>
                            </div>
                            <p v-if="publicationError" class="text-xs text-red-600">{{ publicationError }}</p>
                            <div class="flex justify-between items-center">
                                <button @click="deletePublication" class="text-xs text-red-600 hover:underline">Löschen…</button>
                                <div class="flex gap-2">
                                    <button @click="publicationEditing = false" class="px-4 py-2 text-sm text-ink-3 hover:text-ink transition-colors">Abbrechen</button>
                                    <button @click="savePublicationEdit" :disabled="!publicationEdit.title.trim() || savingPublication"
                                            class="bg-accent text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-accent-ink disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                                        {{ savingPublication ? 'Speichert…' : 'Speichern' }}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- New publication modal (P5: nur Titel erforderlich) -->
                <div v-if="showPublicationCreate" class="fixed inset-0 bg-black/30 flex items-start justify-center z-50 pt-28" @click.self="showPublicationCreate = false">
                    <div class="bg-white rounded-xl shadow-modal p-5 w-full max-w-lg">
                        <h3 class="text-base font-semibold text-ink mb-3">Neue Veröffentlichung</h3>
                        <input ref="publicationTitle" v-model="publicationCreate.title" @keydown.enter="submitPublicationCreate"
                               placeholder="Titel, z. B. FGC-Bahnplanung für Industrieroboter"
                               class="w-full border border-hairline rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-accent outline-none mb-3" />
                        <select v-model="publicationCreate.status" class="border border-hairline rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-accent outline-none mb-3">
                            <option v-for="s in publicationStatuses" :key="s.key" :value="s.key">{{ s.label }}</option>
                        </select>
                        <p v-if="publicationError" class="text-xs text-red-600 mb-2">{{ publicationError }}</p>
                        <div class="flex justify-end gap-2">
                            <button @click="showPublicationCreate = false" class="px-4 py-2 text-sm text-ink-3 hover:text-ink transition-colors">Abbrechen</button>
                            <button @click="submitPublicationCreate" :disabled="!publicationCreate.title.trim() || savingPublication"
                                    class="bg-accent text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-accent-ink disabled:opacity-40 disabled:cursor-not-allowed transition-colors">Erstellen</button>
                        </div>
                    </div>
                </div>

                <!-- BibTeX-Import-Wizard (Ziel: Veröffentlichung, ADR-0004) -->
                <div v-if="showBibtexImport" class="fixed inset-0 bg-black/40 flex items-start justify-center z-50 pt-16 pb-8" @click.self="closeBibtexImport">
                    <div class="bg-white rounded-xl shadow-modal w-full max-w-3xl max-h-full flex flex-col">
                        <div class="px-5 py-4 border-b border-hairline flex items-center justify-between flex-shrink-0">
                            <div>
                                <h3 class="text-base font-semibold text-ink">Referenzen importieren</h3>
                                <p class="text-xs text-mute mt-0.5">
                                    {{ bibtexStep === 1 ? 'Schritt 1/3 · .bib-Datei wählen' :
                                       bibtexStep === 2 ? 'Schritt 2/3 · Einträge prüfen' :
                                       'Schritt 3/3 · PDFs herunterladen' }}
                                    · Veröffentlichung „{{ selectedPublication ? selectedPublication.title : '' }}"
                                </p>
                            </div>
                            <button @click="closeBibtexImport" :disabled="bibtexDownloading" class="text-mute hover:text-ink text-xl leading-none disabled:opacity-40">×</button>
                        </div>

                        <div class="p-5 overflow-y-auto">
                            <!-- Schritt 1: Dateien -->
                            <template v-if="bibtexStep === 1">
                                <div class="space-y-4">
                                    <div>
                                        <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">BibTeX-Datei (.bib) *</label>
                                        <input type="file" accept=".bib,text/plain" @change="onBibtexFile($event, 'bib')"
                                               class="w-full text-sm text-ink-2 file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border-0 file:bg-bg-soft file:text-sm file:text-ink-2 hover:file:bg-hairline cursor-pointer" />
                                    </div>
                                    <div>
                                        <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">LaTeX-Quelle (.tex, optional)</label>
                                        <input type="file" accept=".tex,text/plain" @change="onBibtexFile($event, 'tex')"
                                               class="w-full text-sm text-ink-2 file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border-0 file:bg-bg-soft file:text-sm file:text-ink-2 hover:file:bg-hairline cursor-pointer" />
                                        <p class="text-xs text-mute mt-1">Mit .tex werden nur tatsächlich per <span class="font-mono">\\cite</span> zitierte Einträge vorausgewählt.</p>
                                    </div>
                                </div>
                            </template>

                            <!-- Schritt 2: Review -->
                            <template v-else-if="bibtexStep === 2">
                                <div class="flex items-center justify-between mb-3">
                                    <p class="text-xs text-mute">
                                        {{ bibtexEntries.length }} Einträge ·
                                        {{ bibtexEntries.filter(e => e.match).length }} bereits in der Bibliothek ·
                                        {{ bibtexSelectedCount }} ausgewählt
                                    </p>
                                    <div class="flex gap-2">
                                        <button @click="bibtexSelectAll(true)" class="text-[11px] text-accent-ink hover:underline">Alle</button>
                                        <button @click="bibtexSelectAll(false)" class="text-[11px] text-accent-ink hover:underline">Keine</button>
                                    </div>
                                </div>
                                <div class="border border-hairline rounded-lg divide-y divide-hairline">
                                    <label v-for="e in bibtexEntries" :key="e.key" class="flex items-start gap-3 px-3 py-2.5 cursor-pointer hover:bg-bg-soft">
                                        <input type="checkbox" v-model="e._selected" class="mt-1 accent-accent flex-shrink-0" />
                                        <div class="min-w-0 flex-1">
                                            <div class="flex items-center gap-2">
                                                <span class="text-sm text-ink truncate">{{ e.title || e.key }}</span>
                                                <span v-if="e.match" class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 flex-shrink-0">in Bibliothek</span>
                                                <span v-else class="text-[10px] px-1.5 py-0.5 rounded bg-bg-soft text-ink-3 flex-shrink-0">neu</span>
                                                <span v-if="e.cited === true" class="text-[10px] px-1.5 py-0.5 rounded bg-sky-50 text-sky-700 flex-shrink-0">zitiert</span>
                                                <span v-if="e._alreadyAssigned" class="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 flex-shrink-0">schon zugeordnet</span>
                                            </div>
                                            <p class="text-xs text-mute truncate">{{ e.authors }}<span v-if="e.year"> · {{ e.year }}</span><span v-if="e.journal"> · {{ e.journal }}</span></p>
                                            <p class="text-[11px] font-mono text-ink-3 mt-0.5">
                                                {{ e.key }}<template v-if="e.proposed_cite_key !== e.key"> → {{ e.proposed_cite_key }}<span class="font-sans text-mute"> (Cite Key der Bibliothek gilt)</span></template>
                                            </p>
                                        </div>
                                    </label>
                                </div>
                            </template>

                            <!-- Schritt 3: Ergebnis + Download -->
                            <template v-else>
                                <div v-if="bibtexCommitSummary" class="bg-bg-soft rounded-lg px-4 py-3 mb-4 text-sm text-ink-2">
                                    <div class="flex items-start justify-between gap-3">
                                        <div>
                                            {{ bibtexCommitSummary.created }} neu angelegt · {{ bibtexCommitSummary.matched }} mit Bibliothek verknüpft
                                            <span v-if="bibtexCommitSummary.enriched"> · {{ bibtexCommitSummary.enriched }} angereichert</span>
                                            <span v-if="bibtexCommitSummary.errors"> · <span class="text-red-600">{{ bibtexCommitSummary.errors }} Fehler</span></span>
                                            — alle der Veröffentlichung zugeordnet.
                                        </div>
                                        <button v-if="bibtexCommitSummary.created && !bibtexImportRemoved" @click="removeImportedPapers" :disabled="bibtexLoading"
                                                class="flex-shrink-0 text-xs font-medium text-red-600 hover:underline disabled:opacity-40">Importierte entfernen</button>
                                    </div>
                                    <p v-if="bibtexImportRemoved" class="text-xs text-amber-700 mt-1">Die in diesem Import angelegten Einträge wurden wieder entfernt.</p>
                                </div>
                                <template v-if="bibtexDownloads.length">
                                    <div class="flex items-center justify-between mb-2">
                                        <p class="text-xs text-mute">PDF-Download (nur Open Access) — wähle aus, was geladen werden soll:</p>
                                        <p class="text-xs text-mute">{{ bibtexDownloadSelectedCount }} ausgewählt</p>
                                    </div>
                                    <div class="border border-hairline rounded-lg divide-y divide-hairline mb-3">
                                        <div v-for="c in bibtexDownloads" :key="c.paper_id" class="flex items-start gap-3 px-3 py-2.5">
                                            <input type="checkbox" v-model="c._selected" :disabled="!c.oa_pdf_url || c.status === 'ok'" class="mt-1 accent-accent flex-shrink-0 disabled:opacity-30" />
                                            <div class="min-w-0 flex-1">
                                                <div class="flex items-center gap-2">
                                                    <span class="text-sm text-ink truncate">{{ c.title }}</span>
                                                    <span v-if="c.status === 'ok'" class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 flex-shrink-0">✓ PDF</span>
                                                    <span v-else-if="c.status === 'laedt'" class="text-[10px] px-1.5 py-0.5 rounded bg-sky-50 text-sky-700 flex-shrink-0">lädt…</span>
                                                    <span v-else-if="c.status === 'fehler'" class="text-[10px] px-1.5 py-0.5 rounded bg-red-50 text-red-700 flex-shrink-0">fehlgeschlagen</span>
                                                    <span v-else-if="c.oa_pdf_url" class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 flex-shrink-0">Open Access</span>
                                                    <span v-else class="text-[10px] px-1.5 py-0.5 rounded bg-bg-soft text-ink-3 flex-shrink-0">kein OA-PDF</span>
                                                </div>
                                                <p v-if="c.error" class="text-[11px] text-red-600 mt-0.5">{{ c.error }}</p>
                                                <p v-if="!c.oa_pdf_url || c.status === 'fehler'" class="text-[11px] mt-0.5">
                                                    <span class="text-mute">Manuell laden: </span>
                                                    <a v-if="c.doi_url" :href="c.doi_url" target="_blank" class="text-accent-ink hover:underline">DOI</a>
                                                    <span v-if="c.doi_url"> · </span>
                                                    <a :href="c.scholar_url" target="_blank" class="text-accent-ink hover:underline">Google Scholar</a>
                                                    <span class="text-mute"> — danach am Paper „PDF anhängen".</span>
                                                </p>
                                            </div>
                                        </div>
                                    </div>
                                </template>
                                <p v-else class="text-sm text-mute">Alle importierten Paper haben bereits ein PDF.</p>
                            </template>

                            <p v-if="bibtexError" class="text-xs text-red-600 mt-3">{{ bibtexError }}</p>
                        </div>

                        <div class="px-5 py-3 border-t border-hairline flex justify-end gap-2 flex-shrink-0">
                            <template v-if="bibtexStep === 1">
                                <button @click="closeBibtexImport" class="px-4 py-2 text-sm text-ink-3 hover:text-ink transition-colors">Abbrechen</button>
                                <button @click="bibtexPreview" :disabled="!bibtexBibFile || bibtexLoading"
                                        class="bg-accent text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-accent-ink disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                                    {{ bibtexLoading ? 'Analysiert…' : 'Analysieren' }}
                                </button>
                            </template>
                            <template v-else-if="bibtexStep === 2">
                                <button @click="bibtexStep = 1" :disabled="bibtexLoading" class="px-4 py-2 text-sm text-ink-3 hover:text-ink transition-colors">Zurück</button>
                                <button @click="bibtexCommit" :disabled="!bibtexSelectedCount || bibtexLoading"
                                        class="bg-accent text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-accent-ink disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                                    {{ bibtexLoading ? 'Importiert…' : bibtexSelectedCount + ' Einträge importieren' }}
                                </button>
                            </template>
                            <template v-else>
                                <button v-if="bibtexDownloads.some(c => c.oa_pdf_url && c.status !== 'ok')"
                                        @click="bibtexDownloadSelected" :disabled="!bibtexDownloadSelectedCount || bibtexDownloading"
                                        class="bg-accent text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-accent-ink disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                                    {{ bibtexDownloading ? 'Lädt herunter…' : bibtexDownloadSelectedCount + ' PDFs herunterladen' }}
                                </button>
                                <button @click="closeBibtexImport" :disabled="bibtexDownloading"
                                        class="px-4 py-2 text-sm text-ink-3 hover:text-ink disabled:opacity-40 transition-colors">Fertig</button>
                            </template>
                        </div>
                    </div>
                </div>
            </template>

            <!-- ===== PROJEKTE TAB (Forschungsprojekte, atlas.project/3) ===== -->
            <template v-else-if="tab === 'projekte'">
                <div v-if="projectsLoading" class="text-sm text-mute">Lädt…</div>
                <div v-else-if="!projects.length" class="border border-dashed border-hairline-2 rounded-xl p-10 text-center">
                    <p class="text-ink font-medium mb-1">Noch keine Forschungsprojekte</p>
                    <p class="text-sm text-mute mb-4">Halte Laufzeit, Förderung, Meilensteine und projektrelevante Literatur fest.</p>
                    <button @click="openProjectCreate" class="bg-accent text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-accent-ink transition-colors">+ Erstes Projekt</button>
                </div>
                <div v-else class="max-w-3xl">
                    <!-- Active dashboard tiles (planned / applied / active) -->
                    <div class="space-y-3 mb-4">
                        <p v-if="!activeProjects.length" class="text-sm text-mute italic">Keine aktiven Projekte.</p>
                        <button v-for="p in activeProjects" :key="p.id" @click="selectProject(p.id)"
                                class="w-full text-left bg-white border border-hairline rounded-xl p-4 hover:border-accent transition-colors">
                            <!-- Row 1: status + title + funder/grant -->
                            <div class="flex items-center gap-2 mb-2">
                                <span class="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0" :class="projStatusClass(p.status)">{{ projStatusLabel(p.status) }}</span>
                                <span class="text-sm font-medium text-ink flex-1 truncate">{{ p.title }}</span>
                                <span v-if="p.funder || p.grant_id" class="text-[11px] text-mute flex-shrink-0">
                                    {{ [p.funder, p.grant_id].filter(Boolean).join(' · ') }}
                                </span>
                            </div>
                            <!-- Runtime bar with today marker -->
                            <template v-if="projRuntimeBar(p)">
                                <div class="relative h-2 rounded-full bg-bg-soft overflow-visible mb-0.5">
                                    <div class="absolute inset-y-0 left-0 rounded-full" style="background: var(--lb-accent); opacity: 0.35;" :style="{ width: (projRuntimeBar(p).fraction * 100) + '%' }"></div>
                                    <div class="absolute top-1/2 -translate-y-1/2 w-0.5 h-3 rounded-full z-10" style="background: var(--lb-accent);"
                                         :style="{ left: 'calc(' + (projRuntimeBar(p).fraction * 100) + '% - 1px)' }"></div>
                                </div>
                                <p class="text-[11px] text-mute mb-1.5">{{ projRuntimeBar(p).label }}</p>
                            </template>
                            <!-- Milestones: overdue count + next -->
                            <div v-if="projOverdueCount(p) || projNextMilestone(p)" class="flex flex-wrap items-center gap-2 mb-1.5">
                                <span v-if="projOverdueCount(p)" class="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-800 flex-shrink-0">{{ projOverdueCount(p) }} Meilenstein(e) überfällig</span>
                                <span v-if="projNextMilestone(p)" class="text-[11px] text-mute truncate">Nächster: {{ projNextMilestone(p).title }}<template v-if="projNextMilestone(p).date"> · {{ projNextMilestone(p).date }}</template></span>
                            </div>
                            <!-- Per-AP mini progress bars (sections from backend parser, Issue #48) -->
                            <div v-if="p.sections && p.sections.some(s => s.total > 0)" class="flex flex-wrap gap-x-4 gap-y-1 mb-1.5">
                                <div v-for="(s, si) in p.sections.filter(s => s.total > 0)" :key="si"
                                     class="flex items-center gap-1 min-w-0">
                                    <span v-if="s.title" class="text-[10px] text-ink-3 truncate max-w-[72px]">{{ s.title }}</span>
                                    <div class="w-14 h-1 rounded-full bg-bg-soft overflow-hidden flex-shrink-0">
                                        <div class="h-full bg-accent rounded-full" :style="{ width: Math.round((s.done / s.total) * 100) + '%' }"></div>
                                    </div>
                                    <span class="text-[10px] text-mute flex-shrink-0">{{ s.done }}/{{ s.total }}</span>
                                </div>
                            </div>
                            <!-- Publication count (reverse lookup via publications' projects field) + tags -->
                            <div class="flex flex-wrap items-center gap-2">
                                <span v-if="projPublicationCount(p.id)" class="text-[11px] text-mute">
                                    {{ projPublicationCount(p.id) }} Veröffentlichung{{ projPublicationCount(p.id) === 1 ? '' : 'en' }}
                                </span>
                                <span v-for="t in (p.tags || [])" :key="t" class="text-[10px] text-ink-3 bg-bg-soft px-1.5 py-0.5 rounded">#{{ t }}</span>
                            </div>
                        </button>
                    </div>

                    <!-- Archived section: finished + rejected (collapsed by default) -->
                    <div v-if="archivedProjects.length" class="mt-2">
                        <button @click="collapsedProjectArchive = !collapsedProjectArchive"
                                class="flex items-center gap-1.5 text-sm text-ink-3 hover:text-ink mb-2">
                            <span>{{ collapsedProjectArchive ? '▸' : '▾' }}</span>
                            <span>Abgeschlossen / Abgelehnt ({{ archivedProjects.length }})</span>
                        </button>
                        <div v-show="!collapsedProjectArchive" class="space-y-2">
                            <button v-for="p in archivedProjects" :key="p.id" @click="selectProject(p.id)"
                                    class="w-full text-left bg-white border border-hairline rounded-xl p-3 hover:border-accent transition-colors">
                                <div class="flex items-center gap-2">
                                    <span class="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0" :class="projStatusClass(p.status)">{{ projStatusLabel(p.status) }}</span>
                                    <span class="text-sm text-ink-2 flex-1 truncate">{{ p.title }}</span>
                                    <span v-if="p.start || p.end" class="text-[11px] text-mute flex-shrink-0">{{ projPeriod(p) }}</span>
                                </div>
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Project drawer -->
                <div v-if="selectedProject" class="fixed inset-0 bg-black/30 flex justify-end z-40" @click.self="closeProjectDrawer">
                    <div class="bg-bg w-full max-w-[95vw] h-full overflow-y-auto shadow-modal">
                        <div class="sticky top-0 bg-bg border-b border-hairline px-6 py-4 flex items-start justify-between">
                            <div>
                                <div class="flex items-center gap-2 mb-1">
                                    <span class="text-[10px] px-1.5 py-0.5 rounded" :class="projStatusClass(selectedProject.status)">{{ projStatusLabel(selectedProject.status) }}</span>
                                    <span v-if="selectedProject.start || selectedProject.end" class="text-[11px] text-mute">{{ projPeriod(selectedProject) }}</span>
                                </div>
                                <h2 class="text-xl font-semibold text-ink font-serif">{{ selectedProject.title }}</h2>
                            </div>
                            <div class="flex items-center gap-3">
                                <button v-if="!projectEditing" @click="startProjectEdit" class="text-xs font-medium text-accent-ink hover:underline">Bearbeiten</button>
                                <button @click="closeProjectDrawer" class="text-mute hover:text-ink text-xl leading-none">×</button>
                            </div>
                        </div>

                        <div v-if="!projectEditing" class="grid grid-cols-3 gap-8 p-8">
                            <div class="col-span-2">
                                <div v-if="projectContext" class="font-serif text-[15.5px] text-ink-2 leading-relaxed mb-6" v-html="renderBody(projectContext)"></div>

                                <!-- Meilenstein-Timeline (nächster/überfällig) -->
                                <p class="text-[11px] uppercase tracking-wide text-mute mb-2">Meilensteine</p>
                                <div v-if="selectedProject.timeline && selectedProject.timeline.length" class="space-y-2 mb-6">
                                    <div v-for="m in selectedProject.timeline" :key="m.index" class="flex items-start gap-2 text-sm">
                                        <input type="checkbox" :checked="m.done" @change="toggleMilestone(m.index)" class="mt-1 accent-accent cursor-pointer" />
                                        <div class="flex-1 min-w-0">
                                            <span :class="m.state === 'done' ? 'line-through text-mute' : 'text-ink-2'">{{ m.title }}</span>
                                            <span v-if="m.date" class="text-[11px] ml-2" :class="m.state === 'overdue' ? 'text-red-700 font-medium' : 'text-mute'">{{ m.date }}</span>
                                            <span v-if="m.state === 'overdue'" class="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-800 ml-1.5">überfällig</span>
                                            <span v-else-if="m.next" class="text-[10px] px-1.5 py-0.5 rounded bg-sky-100 text-sky-800 ml-1.5">nächster</span>
                                            <span v-else-if="m.state === 'undated'" class="text-[10px] px-1.5 py-0.5 rounded bg-bg-soft text-ink-3 ml-1.5">ohne Datum</span>
                                        </div>
                                    </div>
                                </div>
                                <p v-else class="text-xs text-mute-2 mb-6">Keine Meilensteine. Über „Bearbeiten" anlegen.</p>

                                <!-- Arbeitspakete: pro AP-Abschnitt (## AP1 …) eigener Fortschritt (Issue #48) -->
                                <p class="text-[11px] uppercase tracking-wide text-mute mb-2">{{ projectSections.some(s => s.title) ? 'Arbeitspakete' : 'Aufgaben' }}</p>
                                <div v-if="projectSections.length" class="space-y-4">
                                    <div v-for="(s, si) in projectSections" :key="si">
                                        <div v-if="s.title" class="flex items-center gap-2 mb-1.5">
                                            <span class="text-sm font-medium text-ink truncate">{{ s.title }}</span>
                                            <div class="w-24 h-1.5 rounded-full bg-bg-soft overflow-hidden flex-shrink-0">
                                                <div class="h-full bg-accent rounded-full" :style="{ width: Math.round((s.done / s.total) * 100) + '%' }"></div>
                                            </div>
                                            <span class="text-[11px] text-mute flex-shrink-0">{{ s.done }}/{{ s.total }}</span>
                                        </div>
                                        <div class="space-y-1.5">
                                            <label v-for="it in s.items" :key="it.index" class="flex items-start gap-2 text-sm cursor-pointer">
                                                <input type="checkbox" :checked="it.done" @change="toggleTask(it.index)" class="mt-1 accent-accent" />
                                                <span :class="it.done ? 'line-through text-mute' : 'text-ink-2'">{{ it.text }}</span>
                                            </label>
                                        </div>
                                    </div>
                                </div>
                                <p v-else class="text-xs text-mute-2">Keine Aufgaben. Über „Bearbeiten" als <span class="font-mono">- [ ] …</span> ergänzen, gern gruppiert unter <span class="font-mono">## AP1 …</span></p>
                            </div>
                            <div class="col-span-1 space-y-4">
                                <div>
                                    <p class="text-[11px] uppercase tracking-wide text-mute mb-1">Eckdaten</p>
                                    <dl class="text-xs space-y-1">
                                        <div class="flex gap-2"><dt class="text-mute w-24 flex-shrink-0">Laufzeit</dt><dd class="text-ink-2">{{ projPeriod(selectedProject) || '—' }}</dd></div>
                                        <div class="flex gap-2"><dt class="text-mute w-24 flex-shrink-0">Förderer</dt><dd class="text-ink-2">{{ selectedProject.funder || '—' }}</dd></div>
                                        <div class="flex gap-2"><dt class="text-mute w-24 flex-shrink-0">Förderkennz.</dt><dd class="text-ink-2 font-mono">{{ selectedProject.grant_id || '—' }}</dd></div>
                                        <div class="flex gap-2"><dt class="text-mute w-24 flex-shrink-0">Rolle</dt><dd class="text-ink-2">{{ selectedProject.role || '—' }}</dd></div>
                                    </dl>
                                </div>
                                <div v-if="selectedProject.checklist.total">
                                    <p class="text-[11px] uppercase tracking-wide text-mute mb-1">Fortschritt</p>
                                    <div class="flex items-center gap-2">
                                        <div class="flex-1 h-1.5 rounded-full bg-bg-soft overflow-hidden">
                                            <div class="h-full bg-accent rounded-full" :style="{ width: Math.round((selectedProject.progress || 0) * 100) + '%' }"></div>
                                        </div>
                                        <span class="text-[11px] text-mute">{{ selectedProject.checklist.done }}/{{ selectedProject.checklist.total }}</span>
                                    </div>
                                </div>
                                <div>
                                    <p class="text-[11px] uppercase tracking-wide text-mute mb-1">Referenzen</p>
                                    <ul v-if="projectRefsResolved.length" class="space-y-1">
                                        <li v-for="r in projectRefsResolved" :key="r.citekey" class="text-xs">
                                            <button v-if="r.found" @click="$router.push('/paper/' + r.paper_id)"
                                                    class="text-left text-accent-ink hover:underline">{{ r.title || r.citekey }}</button>
                                            <span v-else class="text-amber-700" :title="'Citekey nicht in Bibliothek'">{{ r.citekey }} ⚠</span>
                                            <span v-if="r.found" class="text-mute font-mono"> · {{ r.citekey }}</span>
                                        </li>
                                    </ul>
                                    <p v-else class="text-xs text-mute-2">Keine Paper verknüpft.</p>
                                </div>
                                <!-- Veröffentlichungen aus diesem Projekt (Issue #50): Reverse-Lookup
                                     über deren projects-Feld — der Link liegt auf der Veröffentlichung
                                     (ADR-0004), Verknüpfen/Lösen schreibt deren Datei. -->
                                <div>
                                    <p class="text-[11px] uppercase tracking-wide text-mute mb-1">Veröffentlichungen</p>
                                    <ul v-if="projectPublications.length" class="space-y-1">
                                        <li v-for="pub in projectPublications" :key="pub.id" class="text-xs flex items-center gap-1.5 min-w-0">
                                            <span class="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0" :class="pubStatusClass(pub.status)">{{ pubStatusLabel(pub.status) }}</span>
                                            <button @click="openPublicationFromProject(pub.id)" class="text-accent-ink hover:underline flex-1 text-left truncate">{{ pub.title }}</button>
                                            <button @click="unlinkPublicationFromProject(pub.id)" class="text-mute hover:text-red-600 leading-none flex-shrink-0" title="Verknüpfung lösen (schreibt die Veröffentlichungs-Datei)">×</button>
                                        </li>
                                    </ul>
                                    <p v-else class="text-xs text-mute-2">Keine Veröffentlichungen aus diesem Projekt.</p>
                                    <select v-if="linkablePublications.length" class="mt-2 w-full border border-hairline rounded-lg px-2 py-1 text-xs bg-white focus:ring-2 focus:ring-accent outline-none"
                                            @change="linkPublicationToProject($event)">
                                        <option value="">+ Veröffentlichung verknüpfen…</option>
                                        <option v-for="p in linkablePublications" :key="p.id" :value="p.id">{{ p.title }}</option>
                                    </select>
                                </div>
                                <!-- Projektdokumente (projekte/<id>/, Issue #49): Verzeichnislisting wie Manuskripte -->
                                <div>
                                    <div class="flex items-center justify-between mb-1">
                                        <p class="text-[11px] uppercase tracking-wide text-mute">Dokumente</p>
                                        <label class="text-xs font-medium text-accent-ink hover:underline cursor-pointer">
                                            {{ projectDocUploading ? 'Lädt hoch…' : '+ Hochladen' }}
                                            <input type="file" class="hidden" @change="uploadProjectDocument" :disabled="projectDocUploading" />
                                        </label>
                                    </div>
                                    <ul v-if="projectDocuments.length" class="space-y-1">
                                        <li v-for="doc in projectDocuments" :key="doc.name" class="text-xs flex items-center gap-1.5 min-w-0">
                                            <button @click="openProjectDocument(doc.name)"
                                                    class="text-left text-accent-ink hover:underline truncate"
                                                    :title="'Im Standardprogramm öffnen: ' + doc.name">{{ doc.name }}</button>
                                            <span class="text-mute flex-shrink-0">{{ docSize(doc.size) }}</span>
                                            <div class="ml-auto flex items-center gap-2 flex-shrink-0">
                                                <button v-if="isPdfDocument(doc)" @click="openExtractDialog(doc.name)"
                                                        :disabled="projectExtractingDocName === doc.name"
                                                        class="inline-flex items-center gap-1 text-[11px] font-medium text-accent-ink hover:underline disabled:opacity-50 disabled:cursor-wait"
                                                        title="Eckdaten als Vorschlag extrahieren">
                                                    <span v-if="projectExtractingDocName === doc.name" class="inline-block w-3 h-3 border border-accent border-t-transparent rounded-full animate-spin"></span>
                                                    {{ projectExtractingDocName === doc.name ? 'Extrahiert...' : 'Eckdaten extrahieren' }}
                                                </button>
                                                <button @click="deleteProjectDocument(doc.name)"
                                                        class="text-mute hover:text-red-600 leading-none text-sm"
                                                        title="Dokument löschen">×</button>
                                            </div>
                                        </li>
                                    </ul>
                                    <p v-else class="text-xs text-mute-2">Keine Dokumente. Dateien im Projektordner erscheinen hier automatisch.</p>
                                    <p v-if="projectDocsError" class="text-xs text-red-600 mt-1">{{ projectDocsError }}</p>
                                    <p v-if="projectExtractWarning" class="text-xs text-amber-700 mt-1">{{ projectExtractWarning }}</p>
                                </div>
                                <div>
                                    <p class="text-[11px] uppercase tracking-wide text-mute mb-1">Tags</p>
                                    <div v-if="selectedProject.tags.length" class="flex flex-wrap gap-1">
                                        <span v-for="t in selectedProject.tags" :key="t" class="text-[11px] text-ink-3 bg-bg-soft px-1.5 py-0.5 rounded">#{{ t }}</span>
                                    </div>
                                    <p v-else class="text-xs text-mute-2">—</p>
                                </div>
                                <!-- Rückverweise (#180, Story 53) -->
                                <atlas-backlinks :key="'jb-' + selectedProject.id" :id="selectedProject.id" />
                                <div class="pt-2 border-t border-hairline text-[11px] text-mute">
                                    ID: <span class="font-mono">{{ selectedProject.id }}</span>
                                </div>
                            </div>
                        </div>

                        <div v-else class="p-6 space-y-4">
                            <div>
                                <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">Titel</label>
                                <input v-model="projectEdit.title" class="w-full border border-hairline rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-accent outline-none" />
                            </div>
                            <div class="flex gap-3">
                                <div class="flex-1">
                                    <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">Status</label>
                                    <select v-model="projectEdit.status" class="w-full border border-hairline rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-accent outline-none">
                                        <option v-for="s in projectStatuses" :key="s.key" :value="s.key">{{ s.label }}</option>
                                    </select>
                                </div>
                                <div class="w-40">
                                    <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">Laufzeit von</label>
                                    <input v-model="projectEdit.start" type="date" class="w-full border border-hairline rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-accent outline-none" />
                                </div>
                                <div class="w-40">
                                    <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">Laufzeit bis</label>
                                    <input v-model="projectEdit.end" type="date" class="w-full border border-hairline rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-accent outline-none" />
                                </div>
                            </div>
                            <div class="flex gap-3">
                                <div class="flex-1">
                                    <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">Förderer</label>
                                    <input v-model="projectEdit.funder" placeholder="z. B. DFG, BMBF" class="w-full border border-hairline rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-accent outline-none" />
                                </div>
                                <div class="flex-1">
                                    <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">Förderkennzeichen</label>
                                    <input v-model="projectEdit.grant_id" class="w-full border border-hairline rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-accent outline-none" />
                                </div>
                                <div class="flex-1">
                                    <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">Rolle</label>
                                    <input v-model="projectEdit.role" placeholder="z. B. PI, Mitarbeiter" class="w-full border border-hairline rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-accent outline-none" />
                                </div>
                            </div>
                            <div>
                                <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">Meilensteine</label>
                                <div v-for="(m, i) in projectEdit.milestones" :key="i" class="flex items-center gap-2 mb-2">
                                    <input v-model="m.title" placeholder="Titel" class="flex-1 border border-hairline rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-accent outline-none" />
                                    <input v-model="m.date" type="date" class="w-40 border border-hairline rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-accent outline-none" />
                                    <label class="flex items-center gap-1 text-xs text-ink-3 flex-shrink-0"><input type="checkbox" v-model="m.done" class="accent-accent" /> erledigt</label>
                                    <button @click="removeMilestone(i)" class="text-mute hover:text-red-600 text-lg leading-none flex-shrink-0" title="Meilenstein entfernen">×</button>
                                </div>
                                <button @click="addMilestone" class="text-xs font-medium text-accent-ink hover:underline">+ Meilenstein</button>
                            </div>
                            <div>
                                <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">Tags (kommagetrennt)</label>
                                <input v-model="projectEdit.tags" class="w-full border border-hairline rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-accent outline-none" />
                            </div>
                            <div>
                                <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">Referenzen (Citekeys, eine pro Zeile)</label>
                                <textarea v-model="projectEdit.refs" rows="3" class="w-full border border-hairline rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-accent outline-none"></textarea>
                            </div>
                            <div>
                                <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">Text & Aufgaben (Markdown; Aufgaben als <span class="font-mono">- [ ] …</span>)</label>
                                <textarea v-model="projectEdit.body" rows="10" class="w-full border border-hairline rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-accent outline-none"></textarea>
                            </div>
                            <p v-if="projectError" class="text-xs text-red-600">{{ projectError }}</p>
                            <div class="flex items-center gap-2">
                                <button @click="deleteProject" :disabled="savingProject"
                                        class="px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-40">Löschen</button>
                                <button @click="projectEditing = false" class="ml-auto px-4 py-2 text-sm text-ink-3 hover:text-ink transition-colors">Abbrechen</button>
                                <button @click="saveProjectEdit" :disabled="!projectEdit.title.trim() || savingProject"
                                        class="bg-accent text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-accent-ink disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                                    {{ savingProject ? 'Speichert…' : 'Speichern' }}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- New project modal -->
                <div v-if="showProjectCreate" class="fixed inset-0 bg-black/30 flex items-start justify-center z-50 pt-28" @click.self="showProjectCreate = false">
                    <div class="bg-white rounded-xl shadow-modal p-5 w-full max-w-lg">
                        <h3 class="text-base font-semibold text-ink mb-3">Neues Forschungsprojekt</h3>
                        <input ref="projectTitle" v-model="projectCreate.title" @keydown.enter="submitProjectCreate"
                               placeholder="Titel, z. B. FGC-Robotik (DFG)"
                               class="w-full border border-hairline rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-accent outline-none mb-3" />
                        <select v-model="projectCreate.status" class="border border-hairline rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-accent outline-none mb-3">
                            <option v-for="s in projectStatuses" :key="s.key" :value="s.key">{{ s.label }}</option>
                        </select>
                        <p v-if="projectError" class="text-xs text-red-600 mb-2">{{ projectError }}</p>
                        <div class="flex justify-end gap-2">
                            <button @click="showProjectCreate = false" class="px-4 py-2 text-sm text-ink-3 hover:text-ink transition-colors">Abbrechen</button>
                            <button @click="submitProjectCreate" :disabled="!projectCreate.title.trim() || savingProject"
                                    class="bg-accent text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-accent-ink disabled:opacity-40 disabled:cursor-not-allowed transition-colors">Erstellen</button>
                        </div>
                    </div>
                </div>

                <!-- Pre-Extraktion: erst nach Zugehörigkeit (+ Modell) fragen -->
                <div v-if="projectExtractDialogDocName" class="fixed inset-0 bg-black/40 flex items-start justify-center z-50 pt-24" @click.self="closeExtractDialog">
                    <div class="bg-white rounded-xl shadow-modal p-5 w-full max-w-lg">
                        <h3 class="text-base font-semibold text-ink mb-1">Eckdaten extrahieren</h3>
                        <p class="text-xs text-mute mb-4 truncate">{{ projectExtractDialogDocName }}</p>
                        <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">Zu welchem Institut / Lehrstuhl / Unternehmen gehörst du?</label>
                        <input v-model="projectExtractAffiliation" @keydown.enter="runProjectExtraction"
                               placeholder="z. B. RWTH Aachen, Lehrstuhl iCOM"
                               class="w-full border border-hairline rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-accent outline-none mb-1" />
                        <p class="text-[11px] text-mute-2 mb-4">Förderanträge nennen viele Partner — so extrahiert das LLM nur deine Rolle, Meilensteine und Arbeitspakete.</p>
                        <div v-if="projectExtractionModelOptions.length" class="mb-4">
                            <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">LLM-Modell</label>
                            <select v-model="projectExtractionModel"
                                    class="w-full border border-hairline rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-accent outline-none">
                                <option v-for="m in projectExtractionModelOptions" :key="m" :value="m">{{ m }}</option>
                            </select>
                        </div>
                        <p v-if="projectDocsError" class="text-xs text-red-600 mb-2">{{ projectDocsError }}</p>
                        <div class="flex justify-end gap-2">
                            <button @click="closeExtractDialog" class="px-4 py-2 text-sm text-ink-3 hover:text-ink transition-colors">Abbrechen</button>
                            <button @click="runProjectExtraction" :disabled="!!projectExtractingDocName"
                                    class="bg-accent text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-accent-ink disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                                {{ projectExtractingDocName ? 'Extrahiert…' : 'Extrahieren' }}
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Extraktions-Vorschau (P4: Vorschlag bestätigen, bevor gemergt wird) -->
                <div v-if="projectExtractProposal" class="fixed inset-0 bg-black/40 flex items-start justify-center z-50 pt-20" @click.self="closeProjectExtractModal">
                    <div class="bg-white rounded-xl shadow-modal w-full max-w-xl max-h-[80vh] flex flex-col">
                        <div class="px-5 py-4 border-b border-hairline flex items-start justify-between gap-3">
                            <div class="min-w-0">
                                <h3 class="text-base font-semibold text-ink">Extrahierte Eckdaten</h3>
                                <p class="text-xs text-mute mt-0.5 truncate">{{ projectExtractDocName }}</p>
                            </div>
                            <button @click="closeProjectExtractModal" class="text-mute hover:text-ink text-xl leading-none flex-shrink-0">×</button>
                        </div>
                        <div class="px-5 py-4 overflow-y-auto space-y-4 text-sm">
                            <p v-if="!projectExtractHasData" class="text-mute-2">Im Dokument wurden keine übernehmbaren Eckdaten gefunden.</p>
                            <template v-else>
                                <div v-if="projectExtractProposal.start || projectExtractProposal.end || projectExtractProposal.funder || projectExtractProposal.grant_id || projectExtractProposal.role">
                                    <p class="text-[11px] uppercase tracking-wide text-mute mb-1">Eckdaten</p>
                                    <dl class="space-y-1 text-xs">
                                        <div v-if="projectExtractProposal.start || projectExtractProposal.end" class="flex gap-2"><dt class="text-mute w-28 flex-shrink-0">Laufzeit</dt><dd class="text-ink-2">{{ projectExtractProposal.start || '?' }} – {{ projectExtractProposal.end || '?' }}</dd></div>
                                        <div v-if="projectExtractProposal.funder" class="flex gap-2"><dt class="text-mute w-28 flex-shrink-0">Förderer</dt><dd class="text-ink-2">{{ projectExtractProposal.funder }}</dd></div>
                                        <div v-if="projectExtractProposal.grant_id" class="flex gap-2"><dt class="text-mute w-28 flex-shrink-0">Förderkennz.</dt><dd class="text-ink-2 font-mono">{{ projectExtractProposal.grant_id }}</dd></div>
                                        <div v-if="projectExtractProposal.role" class="flex gap-2"><dt class="text-mute w-28 flex-shrink-0">Rolle</dt><dd class="text-ink-2">{{ projectExtractProposal.role }}</dd></div>
                                    </dl>
                                </div>
                                <div v-if="projectExtractProposal.milestones && projectExtractProposal.milestones.length">
                                    <p class="text-[11px] uppercase tracking-wide text-mute mb-1">Meilensteine ({{ projectExtractProposal.milestones.length }})</p>
                                    <ul class="space-y-1 text-xs">
                                        <li v-for="(m, i) in projectExtractProposal.milestones" :key="i" class="flex gap-2">
                                            <span class="text-ink-2 flex-1 min-w-0">{{ m.title }}</span>
                                            <span class="text-mute flex-shrink-0">{{ m.date || 'ohne Datum' }}</span>
                                        </li>
                                    </ul>
                                </div>
                                <div v-if="projectExtractProposal.workpackages && projectExtractProposal.workpackages.length">
                                    <p class="text-[11px] uppercase tracking-wide text-mute mb-1">Arbeitspakete ({{ projectExtractProposal.workpackages.length }})</p>
                                    <ul class="space-y-1.5 text-xs">
                                        <li v-for="(w, i) in projectExtractProposal.workpackages" :key="i">
                                            <span class="font-medium text-ink">{{ w.title }}</span>
                                            <span class="text-mute"> · {{ (w.tasks || []).length }} Aufgabe(n)</span>
                                        </li>
                                    </ul>
                                </div>
                            </template>
                            <div v-if="projectExtractProposal.warnings && projectExtractProposal.warnings.length" class="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 space-y-0.5">
                                <p v-for="(w, i) in projectExtractProposal.warnings" :key="i">{{ w }}</p>
                            </div>
                            <p v-if="projectExtractHasData" class="text-[11px] text-mute-2">Übernahme füllt nur leere Felder; Meilensteine und Arbeitspakete werden angehängt. Gespeichert wird erst über „Speichern".</p>
                        </div>
                        <div class="px-5 py-4 border-t border-hairline flex justify-end gap-2">
                            <button @click="closeProjectExtractModal" class="px-4 py-2 text-sm text-ink-3 hover:text-ink transition-colors">Verwerfen</button>
                            <button @click="applyProjectExtraction" :disabled="!projectExtractHasData"
                                    class="bg-accent text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-accent-ink disabled:opacity-40 disabled:cursor-not-allowed transition-colors">Übernehmen</button>
                        </div>
                    </div>
                </div>
            </template>

            <!-- ===== EDITOR TAB ===== -->
            <atlas-editor v-else-if="tab === 'editor'" :initial-id="editorInitialId"></atlas-editor>

            <!-- Detail drawer -->
            <div v-if="selected" class="fixed inset-0 bg-black/30 flex justify-end z-40" @click.self="closeDrawer">
                <div class="bg-bg w-full max-w-[95vw] h-full overflow-y-auto shadow-modal">
                    <div class="sticky top-0 bg-bg border-b border-hairline px-6 py-4 flex items-start justify-between">
                        <div>
                            <div class="flex items-center gap-2 mb-1">
                                <span class="text-[10px] font-medium px-1.5 py-0.5 rounded" :class="typeClass(selected.type)">{{ typeLabel(selected.type) }}</span>
                                <select :value="selected.status" @change="changeStatus($event.target.value)"
                                        class="text-[11px] border border-hairline rounded px-1.5 py-0.5 bg-white text-mute focus:ring-1 focus:ring-accent outline-none cursor-pointer">
                                    <option v-for="s in statuses" :key="s.key" :value="s.key">{{ s.label }}</option>
                                </select>
                            </div>
                            <h2 class="text-xl font-semibold text-ink font-serif">{{ selected.title }}</h2>
                        </div>
                        <div class="flex items-center gap-3">
                            <!-- Promote (Issue #46): Idee bleibt erhalten (P1), Status wird „Ausgearbeitet" -->
                            <button v-if="!editing && selected.status !== 'promoted'" @click="promoteIdea" :disabled="promoting"
                                    class="text-xs font-medium text-accent-ink hover:underline disabled:opacity-40">
                                {{ promoting ? 'Erstellt…' : 'Zu Veröffentlichung ausarbeiten' }}
                            </button>
                            <button v-if="!editing" @click="startEdit" class="text-xs font-medium text-accent-ink hover:underline">Bearbeiten</button>
                            <button @click="closeDrawer" class="text-mute hover:text-ink text-xl leading-none">×</button>
                        </div>
                    </div>

                    <div v-if="!editing && selected.errors && selected.errors.length" class="mx-6 mt-4 bg-amber-50 border border-amber-200 rounded-lg p-3">
                        <p class="text-xs font-medium text-amber-800 mb-1">Validierungswarnungen</p>
                        <ul class="list-disc pl-4 text-xs text-amber-700 space-y-0.5">
                            <li v-for="(e, i) in selected.errors" :key="i">{{ e }}</li>
                        </ul>
                    </div>

                    <!-- Read view -->
                    <div v-if="!editing" class="grid grid-cols-3 gap-8 p-8">
                        <!-- Body -->
                        <div class="col-span-2">
                            <div v-if="selected.body && selected.body.trim()" class="font-serif text-[15.5px] text-ink-2 leading-relaxed" v-html="renderBody(selected.body)"></div>
                            <p v-else class="text-sm text-mute italic">Kein Freitext. Über „Bearbeiten" ergänzen oder die Markdown-Datei pflegen.</p>
                        </div>
                        <!-- Metadata -->
                        <div class="col-span-1 space-y-4">
                            <div>
                                <p class="text-[11px] uppercase tracking-wide text-mute mb-1">Tags</p>
                                <div v-if="selected.tags.length" class="flex flex-wrap gap-1">
                                    <span v-for="tag in selected.tags" :key="tag" class="text-[11px] text-ink-3 bg-bg-soft px-1.5 py-0.5 rounded">#{{ tag }}</span>
                                </div>
                                <p v-else class="text-xs text-mute-2">—</p>
                            </div>
                            <div>
                                <p class="text-[11px] uppercase tracking-wide text-mute mb-1">Referenzen (Citekeys)</p>
                                <ul v-if="selected.refs.length" class="space-y-0.5">
                                    <li v-for="r in selected.refs" :key="r" class="text-xs font-mono text-ink-2">{{ r }}</li>
                                </ul>
                                <p v-else class="text-xs text-mute-2">—</p>
                            </div>
                            <div>
                                <p class="text-[11px] uppercase tracking-wide text-mute mb-1">Dissertation</p>
                                <ul v-if="selected.diss.length" class="space-y-0.5">
                                    <li v-for="d in selected.diss" :key="d" class="text-xs font-mono text-ink-2">{{ d }}</li>
                                </ul>
                                <p v-else class="text-xs text-mute-2">—</p>
                            </div>
                            <!-- F1: Paarbewertung — Vorschlag; geschrieben wird erst bei "Uebernehmen" (P4) -->
                            <div>
                                <div class="flex items-center justify-between mb-1">
                                    <p class="text-[11px] uppercase tracking-wide text-mute">Literatur-Matching</p>
                                    <button @click="toggleMatchPicker" class="text-[11px] font-medium text-accent-ink hover:underline">✨ Paper prüfen</button>
                                </div>
                                <div v-if="showMatchPicker" class="mb-2 border border-hairline rounded-lg p-2 bg-white">
                                    <input v-model="matchFilter" placeholder="Paper suchen…" class="w-full border border-hairline rounded px-2 py-1 text-xs mb-2 focus:ring-2 focus:ring-accent outline-none" />
                                    <div v-if="paperPickerLoading" class="text-xs text-mute px-2 py-1">Lädt…</div>
                                    <div v-else class="max-h-44 overflow-y-auto space-y-0.5">
                                        <button v-for="p in matchPickerPapers" :key="p.id" @click="runMatchPair(p)"
                                                class="w-full text-left text-xs px-2 py-1 rounded hover:bg-bg-soft">{{ p.title }} <span v-if="p.year" class="text-mute">({{ p.year }})</span></button>
                                        <p v-if="!matchPickerPapers.length" class="text-xs text-mute-2 px-2 py-1">Kein Treffer</p>
                                    </div>
                                </div>
                                <p v-if="matching" class="text-xs text-mute">Prüft mit LLM…</p>
                                <p v-if="matchError" class="text-xs text-red-600">{{ matchError }}</p>
                                <div v-if="matchResult" class="border border-hairline rounded-lg p-2.5 bg-white space-y-1.5">
                                    <div class="flex items-center gap-2">
                                        <span class="text-[10px] font-medium px-1.5 py-0.5 rounded flex-shrink-0" :class="verdictClass(matchResult.verdict)">{{ verdictLabel(matchResult.verdict) }}</span>
                                        <span class="text-[11px] font-mono text-ink-2 truncate">{{ matchResult.citekey }}</span>
                                    </div>
                                    <p class="text-xs text-ink-2 leading-snug">{{ matchResult.reasoning }}</p>
                                    <ul v-if="matchResult.usages && matchResult.usages.length" class="space-y-1">
                                        <li v-for="(u, i) in matchResult.usages" :key="i" class="text-[11px] text-ink-3 leading-snug">
                                            <span v-if="u.anchor" class="font-mono" :class="u.anchor_valid ? 'text-accent-ink' : 'text-amber-700'"
                                                  :title="u.anchor_valid ? '' : 'Anker existiert nicht (mehr) in der Idee'">#{{ u.anchor }}<template v-if="!u.anchor_valid"> ⚠</template></span>
                                            {{ u.suggestion }}
                                        </li>
                                    </ul>
                                    <div class="flex justify-end gap-2 pt-0.5">
                                        <button @click="matchResult = null" class="text-[11px] text-ink-3 hover:text-ink">{{ matchResult.verdict === 'irrelevant' ? 'Schließen' : 'Verwerfen' }}</button>
                                        <button v-if="matchResult.verdict !== 'irrelevant'" @click="acceptMatch" :disabled="acceptingMatch"
                                                class="text-[11px] font-medium text-white bg-accent px-2 py-1 rounded hover:bg-accent-ink disabled:opacity-40">
                                            {{ acceptingMatch ? 'Übernimmt…' : 'Übernehmen' }}
                                        </button>
                                    </div>
                                </div>
                            </div>
                            <!-- Rückverweise (#180, Story 53) -->
                            <atlas-backlinks :key="'ib-' + selected.id" :id="selected.id" />
                            <div class="pt-2 border-t border-hairline text-[11px] text-mute space-y-1">
                                <div>ID: <span class="font-mono">{{ selected.id }}</span></div>
                                <div v-if="selected.created">Erstellt: {{ selected.created }}</div>
                                <div v-if="selected.updated">Aktualisiert: {{ selected.updated }}</div>
                            </div>
                        </div>
                    </div>

                    <!-- Edit form -->
                    <div v-else class="p-6 space-y-4">
                        <div>
                            <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">Titel</label>
                            <input v-model="edit.title" class="w-full border border-hairline rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-accent outline-none" />
                        </div>
                        <div class="flex gap-3">
                            <div class="flex-1">
                                <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">Typ</label>
                                <select v-model="edit.type" class="w-full border border-hairline rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-accent outline-none">
                                    <option v-for="t in types" :key="t.key" :value="t.key">{{ t.label }}</option>
                                </select>
                            </div>
                            <div class="flex-1">
                                <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">Status</label>
                                <select v-model="edit.status" class="w-full border border-hairline rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-accent outline-none">
                                    <option v-for="s in statuses" :key="s.key" :value="s.key">{{ s.label }}</option>
                                </select>
                            </div>
                        </div>
                        <div>
                            <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">Tags (kommagetrennt)</label>
                            <input v-model="edit.tags" placeholder="fgc, slicing" class="w-full border border-hairline rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-accent outline-none" />
                        </div>
                        <div>
                            <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">Referenzen (Citekeys, eine pro Zeile)</label>
                            <textarea v-model="edit.refs" rows="3" class="w-full border border-hairline rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-accent outline-none"></textarea>
                        </div>
                        <div>
                            <label class="block text-[11px] uppercase tracking-wide text-mute mb-1">Freitext (Markdown)</label>
                            <textarea v-model="edit.body" rows="10" class="w-full border border-hairline rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-accent outline-none"></textarea>
                        </div>
                        <p v-if="editError" class="text-xs text-red-600">{{ editError }}</p>
                        <div class="flex justify-end gap-2">
                            <button @click="cancelEdit" class="px-4 py-2 text-sm text-ink-3 hover:text-ink transition-colors">Abbrechen</button>
                            <button @click="saveEdit" :disabled="!edit.title.trim() || savingEdit"
                                    class="bg-accent text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-accent-ink disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                                {{ savingEdit ? 'Speichert…' : 'Speichern' }}
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Quick-Capture modal -->
            <div v-if="showCapture" class="fixed inset-0 bg-black/30 flex items-start justify-center z-50 pt-32" @click.self="showCapture = false">
                <div class="bg-white rounded-xl shadow-modal p-5 w-full max-w-lg">
                    <h3 class="text-base font-semibold text-ink mb-3">Neue Idee</h3>
                    <input ref="captureTitle" v-model="capture.title" @keydown.enter="submitCapture"
                           placeholder="Titel der Idee… (Enter zum Speichern)"
                           class="w-full border border-hairline rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-accent outline-none mb-3" />
                    <div class="flex items-center gap-2 mb-3">
                        <select v-model="capture.type"
                                class="border border-hairline rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-accent outline-none">
                            <option v-for="t in types" :key="t.key" :value="t.key">{{ t.label }}</option>
                        </select>
                        <input v-model="capture.tags" placeholder="#tags, kommagetrennt"
                               class="flex-1 border border-hairline rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-accent outline-none" />
                    </div>
                    <p v-if="error" class="text-xs text-red-600 mb-2">{{ error }}</p>
                    <div class="flex justify-end gap-2">
                        <button @click="showCapture = false" class="px-4 py-2 text-sm text-ink-3 hover:text-ink transition-colors">Abbrechen</button>
                        <button @click="submitCapture" :disabled="!capture.title.trim() || saving"
                                class="bg-accent text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-accent-ink disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                            {{ saving ? 'Speichert…' : 'Erstellen' }}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `,
    data() {
        return {
            ideas: [],
            loading: true,
            selectedId: null,
            showCapture: false,
            filterType: '',
            filterText: '',
            capture: { title: '', type: 'paper-idea', tags: '' },
            saving: false,
            error: '',
            statuses: ATLAS_STATUSES,
            types: ATLAS_TYPES,
            _es: null,
            // Edit state for the detail drawer
            editing: false,
            edit: { title: '', type: 'paper-idea', status: 'seed', tags: '', refs: '', body: '' },
            savingEdit: false,
            editError: '',
            // Promote Idee -> Veröffentlichung (Issue #46)
            promoting: false,
            // F1 pair matching in the detail drawer (proposal only, P4)
            showMatchPicker: false,
            matchFilter: '',
            matching: false,
            matchResult: null,
            matchError: '',
            acceptingMatch: false,
            // .md import
            dragOver: false,
            importing: false,
            // Pinboard (#59): collapsed sections state
            sectionsOpen: { promoted: false, parked: false },
            // Dissertation tab (flat chapter list, ADR-0005, issue #62)
            tab: 'ideen',
            dissStatuses: DISS_STATUSES,
            dissChapters: [],
            dissProgress: {},
            dissIssues: [],
            dissLoading: true,
            selectedNodeId: null,
            nodeLinks: [],
            // Kapitel als Drehscheibe (#180): Kennzahlen aus /diss/{id},
            // Rückverweise aus /backlinks/{id} (einmal geladen, der Block
            // bekommt sie vorgelegt statt selbst zu fragen).
            nodeMetrics: {},
            nodeBacklinks: null,
            nodeLitAll: false,
            showNodeCreate: false,
            nodeCreate: { title: '' },
            nodeEditing: false,
            nodeEdit: { title: '', status: 'planned', order: 0, body: '' },
            savingNode: false,
            nodeError: '',
            // node drawer pickers
            showIdeaPicker: false,
            ideaPickerFilter: '',
            // Veröffentlichungen je Knoten (atlas.dissnode/3, Issue #53) —
            // aufgelöste Links inkl. hängender (found=false, nur Warnung)
            nodePublications: [],
            showNodePubPicker: false,
            nodePubFilter: '',
            libraryPapers: [],
            papersLoaded: false,
            paperPickerLoading: false,
            // Projekte tab (Forschungsprojekte, atlas.project/3, ADR-0004)
            projects: [],
            projectsLoading: true,
            projectStatuses: PROJECT_STATUSES,
            selectedProjectId: null,
            collapsedProjectArchive: true,   // finished/rejected section collapsed by default
            showProjectCreate: false,
            projectCreate: { title: '', status: 'planned' },
            projectEditing: false,
            projectEdit: { title: '', status: 'planned', start: '', end: '', funder: '', grant_id: '', role: '', tags: '', refs: '', milestones: [], body: '' },
            savingProject: false,
            projectError: '',
            projectRefsResolved: [],
            // Veröffentlichungen des Projekts (Issue #50) — Reverse-Lookup über
            // deren projects-Feld, der Link liegt downstream (ADR-0004)
            projectPublications: [],
            // Projektdokumente (projekte/<id>/, Issue #49) — Verzeichnislisting, kein Index
            projectDocuments: [],
            projectDocUploading: false,
            projectDocsError: '',
            projectExtractingDocName: '',
            projectExtractWarning: '',
            projectExtractDialogDocName: '',  // Pre-Extraktions-Dialog offen fuer dieses Dok ('' = zu)
            projectExtractAffiliation: '',    // Institut/Lehrstuhl/Unternehmen (Browser-gemerkt)
            projectExtractProposal: null,     // Vorschlag im Vorschau-Popup (P4), null = zu
            projectExtractDocName: '',
            projectExtractionModels: [],
            projectExtractionModel: '',
            // Veroeffentlichungen tab (atlas.publication/1, ADR-0004)
            publications: [],
            publicationsLoading: true,
            unassignedManuscripts: [],   // verwaiste .tex (Issue #45)
            manuscriptUploading: false,  // .tex-Upload auf einer Veröffentlichung läuft
            manuscriptUploadError: '',
            collapsedSections: {},       // lifecycle-group collapse state (Issue #60)
            publicationStatuses: PUBLICATION_STATUSES,
            publicationTypes: PUBLICATION_TYPES,
            selectedPublicationId: null,
            publicationRefsResolved: [],
            publicationManuscriptsResolved: [],
            publicationOrigins: [],
            publicationProjectsResolved: [],
            publicationPaperResolved: null,
            showPublicationCreate: false,
            publicationCreate: { title: '', status: 'planned' },
            publicationEditing: false,
            publicationEdit: { title: '', status: 'planned', type: '', venue: '', authors: '', due: '', submitted: '', published: '', tags: '', refs: '', derived_from: '', manuscripts: '', projects: '', paper: '', body: '' },
            savingPublication: false,
            publicationError: '',
            editorInitialId: null,   // deep-link Veroeffentlichung -> Manuskript-Editor
            // BibTeX-Import-Wizard (im Veröffentlichungs-Drawer, ADR-0004)
            showBibtexImport: false,
            bibtexStep: 1,           // 1 Dateien, 2 Review, 3 Ergebnis + Download
            bibtexBibFile: null,
            bibtexTexFile: null,
            bibtexLoading: false,
            bibtexError: '',
            bibtexEntries: [],       // Preview-Eintraege, je mit _selected
            bibtexCommitSummary: null,
            bibtexImportRemoved: false,  // "Importierte entfernen" wurde ausgefuehrt
            bibtexDownloads: [],     // Download-Kandidaten nach Commit
            bibtexDownloading: false,
        };
    },
    computed: {
        // Welcher Eintrag der Werkbank-Navigation leuchtet (#180). Manuskripte
        // haben noch keinen eigenen Bereich (ADR-0004) und hängen deshalb an
        // der Veröffentlichungs-Ansicht, erkennbar an ?focus=manuskripte.
        focusManuscripts() { return this.$route.query.focus === 'manuskripte'; },
        navKey() {
            if (this.tab === 'editor') return 'manuskripte';
            if (this.tab === 'veroeffentlichungen') {
                return this.focusManuscripts ? 'manuskripte' : 'veroeffentlichungen';
            }
            if (this.tab === 'dissertation') return 'kapitel';
            if (this.tab === 'projekte') return 'projekte';
            return 'ideen';
        },
        filtered() {
            const q = this.filterText.trim().toLowerCase().replace(/^#/, '');
            return this.ideas.filter((i) => {
                if (this.filterType && i.type !== this.filterType) return false;
                if (!q) return true;
                if ((i.title || '').toLowerCase().includes(q)) return true;
                return (i.tags || []).some((t) => t.toLowerCase().includes(q));
            });
        },
        activeIdeas() {
            return this.filtered.filter((i) => i.status === 'seed' || i.status === 'developing');
        },
        promotedIdeas() {
            return this.filtered.filter((i) => i.status === 'promoted');
        },
        parkedIdeas() {
            return this.filtered.filter((i) => i.status === 'parked');
        },
        selected() {
            return this.ideas.find((i) => i.id === this.selectedId) || null;
        },
        // Dissertation flat list (ADR-0005 / issue #62): the store already
        // returns chapters sorted by order; no tree walk needed.
        selectedNode() {
            return (this.dissChapters || []).find((n) => n.id === this.selectedNodeId) || null;
        },
        // --- Kapitel als Drehscheibe (#180, Story 49–52) --------------------
        nodePosition() {
            const i = (this.dissChapters || []).findIndex((n) => n.id === this.selectedNodeId);
            return i < 0 ? 1 : i + 1;
        },
        nodeFileName() {
            const path = (this.selectedNode && this.selectedNode.path) || '';
            return path ? path.split(/[\\/]/).pop() : '';
        },
        nodeZettel() {
            return (this.nodeBacklinks && this.nodeBacklinks.zettel) || [];
        },
        // Die Literatur des Kapitels: die Cite Keys, die der Server als
        // `refs_all` zusammenführt (eigene Veröffentlichungen + verlinkte
        // Zettel), gegen die Bibliothek aufgelöst. Hängende Keys bleiben
        // sichtbar — Warnung, nie Reparatur.
        nodeLiterature() {
            const keys = (this.nodeMetrics && this.nodeMetrics.refs_all) || [];
            const byKey = new Map((this.libraryPapers || []).map((p) => [p.cite_key, p]));
            return keys.map((citekey) => {
                const paper = byKey.get(citekey);
                return paper
                    ? { citekey, found: true, title: paper.title || citekey, paper_id: paper.id }
                    : { citekey, found: false };
            });
        },
        nodeLiteratureShown() {
            return this.nodeLitAll ? this.nodeLiterature : this.nodeLiterature.slice(0, 8);
        },
        dissProgressFraction() {
            const total = (this.dissProgress && this.dissProgress.total) || 0;
            const done = (this.dissProgress && this.dissProgress.with_body) || 0;
            if (total === 0) return 0;
            return Math.round((done / total) * 100);
        },
        assignableIdeas() {
            const q = this.ideaPickerFilter.trim().toLowerCase();
            return this.ideas
                .filter((i) => !(i.diss || []).includes(this.selectedNodeId))
                .filter((i) => !q || (i.title || '').toLowerCase().includes(q));
        },
        assignableNodePublications() {
            // Kandidaten für „+ zuordnen" im Knoten-Drawer (Issue #53):
            // alle Veröffentlichungen, die der Knoten noch nicht trägt.
            const q = this.nodePubFilter.trim().toLowerCase();
            const linked = new Set((this.selectedNode && this.selectedNode.publications) || []);
            return this.publications
                .filter((p) => !linked.has(p.id))
                .filter((p) => !q || (p.title || '').toLowerCase().includes(q));
        },
        matchPickerPapers() {
            const q = this.matchFilter.trim().toLowerCase();
            return (this.libraryPapers || [])
                .filter((p) => !q || (p.title || '').toLowerCase().includes(q))
                .slice(0, 50);
        },
        activeProjects() {
            return this.projects.filter((p) => PROJECT_ACTIVE_STATUSES.has(p.status));
        },
        archivedProjects() {
            return this.projects.filter((p) => !PROJECT_ACTIVE_STATUSES.has(p.status));
        },
        selectedProject() {
            return this.projects.find((p) => p.id === this.selectedProjectId) || null;
        },
        projectExtractionModelOptions() {
            const models = Array.isArray(this.projectExtractionModels) ? this.projectExtractionModels : [];
            const selected = this.projectExtractionModel ? [this.projectExtractionModel] : [];
            return [...new Set([...selected, ...models].filter(Boolean))];
        },
        projectExtractHasData() {
            const p = this.projectExtractProposal;
            if (!p) return false;
            const fields = ['start', 'end', 'funder', 'grant_id', 'role']
                .some((f) => p[f] != null && String(p[f]).trim());
            const ms = Array.isArray(p.milestones) && p.milestones.length > 0;
            const wp = Array.isArray(p.workpackages) && p.workpackages.length > 0;
            return fields || ms || wp;
        },
        selectedPublication() {
            return this.publications.find((p) => p.id === this.selectedPublicationId) || null;
        },
        linkablePublications() {
            // Kandidaten für „+ Veröffentlichung verknüpfen…" im Projekt-Drawer
            // (Issue #50): alle, die das Projekt noch nicht in projects tragen.
            if (!this.selectedProjectId) return [];
            return this.publications.filter(
                (p) => !(p.projects || []).includes(this.selectedProjectId)
            );
        },
        bibtexSelectedCount() {
            return this.bibtexEntries.filter((e) => e._selected).length;
        },
        bibtexDownloadSelectedCount() {
            return this.bibtexDownloads.filter((c) => c._selected && c.oa_pdf_url).length;
        },
        projectContext() {
            // Body without the task list (and its "## Aufgaben" heading) — those
            // are shown as the interactive checklist instead.
            if (!this.selectedProject) return '';
            return (this.selectedProject.body || '')
                .split(/\r?\n/)
                .filter((l) => !/^\s*[-*]\s+\[[ xX]\]\s+/.test(l) && !/^#{1,6}\s+Aufgaben\s*$/i.test(l))
                .join('\n')
                .trim();
        },
        projectSections() {
            // Arbeitspakete (Issue #48): per-AP sections from the backend parser.
            // The running index is assigned across ALL sections in document
            // order BEFORE filtering — it must match the flat checklist order
            // the toggle endpoint indexes into.
            let idx = 0;
            return ((this.selectedProject && this.selectedProject.sections) || [])
                .map((s) => ({ ...s, items: (s.items || []).map((it) => ({ ...it, index: idx++ })) }))
                .filter((s) => s.total > 0);
        },
        // Lifecycle-Gruppen für die Veröffentlichungen-Liste (Issue #60).
        // Reihenfolge: Dringlichkeit absteigend; nur Gruppen mit ≥1 Einträgen.
        publicationGroups() {
            const GROUPS = [
                { key: 'in-arbeit',      label: 'In Arbeit',              statuses: ['drafting', 'in-revision'] },
                { key: 'eingereicht',    label: 'Eingereicht',            statuses: ['submitted'] },
                { key: 'veroeffentlicht',label: 'Veröffentlicht',         statuses: ['published'] },
                { key: 'geplant',        label: 'Geplant',                statuses: ['planned'] },
                { key: 'abgelehnt',      label: 'Abgelehnt / Zurückgezogen', statuses: ['rejected', 'withdrawn'] },
            ];
            return GROUPS
                .map((g) => ({ ...g, pubs: this.publications.filter((p) => g.statuses.includes(p.status)) }))
                .filter((g) => g.pubs.length > 0);
        },
    },
    methods: {
        async load() {
            this.loading = true;
            try {
                const data = await api('/api/plugins/atlas/ideas');
                this.ideas = data.ideas || [];
            } catch (e) {
                console.error('Atlas load error:', e);
                this.ideas = [];
            }
            this.loading = false;
        },
        openCapture() {
            this.error = '';
            this.showCapture = true;
            this.$nextTick(() => { if (this.$refs.captureTitle) this.$refs.captureTitle.focus(); });
        },
        async submitCapture() {
            const title = this.capture.title.trim();
            if (!title || this.saving) return;
            this.saving = true;
            this.error = '';
            try {
                const tags = this.capture.tags.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean);
                const created = await api('/api/plugins/atlas/ideas', {
                    method: 'POST',
                    body: JSON.stringify({ title, type: this.capture.type, tags }),
                });
                this.showCapture = false;
                this.capture = { title: '', type: 'paper-idea', tags: '' };
                await this.load();
                this.selectedId = created.id;
            } catch (e) {
                this.error = e.message;
            } finally {
                this.saving = false;
            }
        },
        typeLabel(t) { return (ATLAS_TYPES.find((x) => x.key === t) || {}).label || t; },
        statusLabel(s) { return (ATLAS_STATUSES.find((x) => x.key === s) || {}).label || s; },
        typeClass(t) { return ATLAS_TYPE_CLASS[t] || 'bg-bg-soft text-ink-3'; },
        renderBody(text) { return renderAtlasMarkdown(text); },
        connectSSE() {
            try {
                this._es = new EventSource('/api/plugins/atlas/events');
                this._es.onmessage = (ev) => {
                    try {
                        const d = JSON.parse(ev.data);
                        if (d && d.type) {
                            this.load(); this.loadDiss(); this.loadProjects(); this.loadPublications();
                            // Offene Projekt-Detailseite: extern abgelegte Dokumente sofort zeigen (Issue #49)
                            if (this.selectedProjectId) this.loadProjectDocuments(this.selectedProjectId);
                        }
                    } catch (e) { /* ignore keep-alive / malformed */ }
                };
                this._es.onerror = () => { /* browser auto-reconnects */ };
            } catch (e) { /* EventSource unsupported */ }
        },
        onCaptureShortcut(e) {
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'I' || e.key === 'i')) {
                e.preventDefault();
                this.openCapture();
            }
        },
        // Ein Tabwechsel gehört in die Adresse, nicht nur in den Zustand: sonst
        // zeigt die Werkbank-Navigation auf „Kapitel", während `?tab=ideen` in
        // der Zeile steht — und ein Klick auf den Navigationseintrag, der schon
        // in der Adresse steht, tut dann gar nichts. Die Tiefenlink-Schlüssel
        // (?idea=, ?pub=, …) fallen dabei weg: sie gehören zum verlassenen Tab.
        goTab(key) {
            this.tab = key;
            if (this.$route.query.tab === key && Object.keys(this.$route.query).length === 1) return;
            this.$router.replace({ path: '/atlas/sammlung', query: { tab: key } });
        },
        applyRouteIdea() {
            // Deep-open from the library reference panel: ?idea=<id>
            // (#180: the Sammlung moved to /atlas/sammlung, the query keys stay.)
            const tab = this.$route.query.tab;
            if (tab && ['ideen', 'veroeffentlichungen', 'dissertation', 'projekte'].includes(tab)) {
                this.tab = tab;
            }
            const id = this.$route.query.idea;
            if (id) {
                this.tab = 'ideen';
                this.selectedId = id;
            }
            // ?pub=<id> -> Veroeffentlichungen tab + drawer
            const pub = this.$route.query.pub;
            if (pub) {
                this.tab = 'veroeffentlichungen';
                this.selectPublication(pub);
            }
            // ?proj=<id> -> Projekte tab + drawer (Forschungsprojekt)
            const proj = this.$route.query.proj;
            if (proj) {
                this.tab = 'projekte';
                this.selectProject(proj);
            }
            // ?chapter=<id> -> Dissertation tab + Kapitel-Drawer (Anker-Chips)
            const chapter = this.$route.query.chapter;
            if (chapter) {
                this.tab = 'dissertation';
                this.selectNode(chapter);
            }
            // ?focus=manuskripte -> Veroeffentlichungen + der Block darunter
            if (this.focusManuscripts) {
                this.tab = 'veroeffentlichungen';
                this.scrollToManuscripts();
            }
        },
        scrollToManuscripts() {
            // Die Liste kommt erst mit /api/plugins/atlas/publications — einmal jetzt
            // (falls sie schon steht) und einmal, wenn sie nachgeladen ist.
            const go = () => this.$nextTick(() => {
                const el = this.$refs.manuskripte;
                if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            });
            go();
            setTimeout(go, 350);
        },
        // Das Erfassen-Feld hat etwas angelegt: die betroffene Liste nachladen
        // (Story 54) — ein Task berührt die Sammlung nicht.
        onCaptured(ev) {
            if (!ev) return;
            if (ev.mode === 'idee') {
                this.load();
                if (ev.data && ev.data.id) {
                    this.tab = 'ideen';
                    this.selectedId = ev.data.id;
                }
            }
        },
        closeDrawer() {
            this.selectedId = null;
            this.editing = false;
            this.resetMatch();
        },
        // --- F1 Literatur-Matching (drawer) ----------------------------------
        resetMatch() {
            this.showMatchPicker = false;
            this.matchFilter = '';
            this.matching = false;
            this.matchResult = null;
            this.matchError = '';
            this.acceptingMatch = false;
        },
        verdictLabel(v) { return atlasVerdictLabel(v); },
        verdictClass(v) { return atlasVerdictClass(v); },
        async toggleMatchPicker() {
            this.showMatchPicker = !this.showMatchPicker;
            this.matchFilter = '';
            if (this.showMatchPicker) await this.loadLibraryPapers();
        },
        async runMatchPair(paper) {
            if (this.matching) return;
            this.showMatchPicker = false;
            this.matching = true;
            this.matchError = '';
            this.matchResult = null;
            try {
                const bib = await api(`/api/papers/${paper.id}/bibtex`);   // {key}
                this.matchResult = await api('/api/plugins/atlas/match/pair', {
                    method: 'POST',
                    body: JSON.stringify({ citekey: bib.key, idea_id: this.selectedId }),
                });
            } catch (e) {
                this.matchError = e.message;
            }
            this.matching = false;
        },
        async acceptMatch() {
            const r = this.matchResult;
            if (!r || this.acceptingMatch) return;
            this.acceptingMatch = true;
            try {
                await api(`/api/plugins/atlas/ideas/${encodeURIComponent(this.selectedId)}/accept-match`, {
                    method: 'POST',
                    body: JSON.stringify({
                        citekey: r.citekey,
                        reasoning: r.reasoning,
                        usages: (r.usages || []).map((u) => ({ anchor: u.anchor, suggestion: u.suggestion })),
                    }),
                });
                this.matchResult = null;
                await this.load();  // refs + body now contain the accepted block
            } catch (e) {
                this.matchError = e.message;
            } finally {
                this.acceptingMatch = false;
            }
        },
        startEdit() {
            const s = this.selected;
            if (!s) return;
            this.edit = {
                title: s.title || '',
                type: s.type || 'paper-idea',
                status: s.status || 'seed',
                tags: (s.tags || []).join(', '),
                refs: (s.refs || []).join('\n'),
                body: s.body || '',
            };
            this.editError = '';
            this.editing = true;
        },
        cancelEdit() {
            this.editing = false;
            this.editError = '';
        },
        async saveEdit() {
            if (!this.edit.title.trim() || this.savingEdit) return;
            this.savingEdit = true;
            this.editError = '';
            try {
                const tags = this.edit.tags.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean);
                const refs = this.edit.refs.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
                await api(`/api/plugins/atlas/ideas/${encodeURIComponent(this.selectedId)}`, {
                    method: 'PUT',
                    body: JSON.stringify({
                        title: this.edit.title.trim(),
                        type: this.edit.type,
                        status: this.edit.status,
                        tags, refs,
                        body: this.edit.body,
                    }),
                });
                this.editing = false;
                await this.load();  // selectedId stays; card moves to its new status column
            } catch (e) {
                this.editError = e.message;
            } finally {
                this.savingEdit = false;
            }
        },
        async promoteIdea() {
            // Promote (Issue #46): erzeugt eine Veröffentlichung aus der Idee
            // (refs/tags/body als Startpunkt, derived_from = Ideen-ID); die
            // Ideen-Datei bleibt erhalten und wird „Ausgearbeitet" (P1).
            const s = this.selected;
            if (!s || this.promoting) return;
            if (!confirm(`Aus „${s.title}" eine Veröffentlichung ausarbeiten? Die Idee bleibt erhalten (Status „Ausgearbeitet").`)) return;
            this.promoting = true;
            try {
                const res = await api(`/api/plugins/atlas/ideas/${encodeURIComponent(s.id)}/promote`, { method: 'POST' });
                this.closeDrawer();
                await this.load();
                await this.loadPublications();
                this.tab = 'veroeffentlichungen';
                await this.selectPublication(res.publication.id);
            } catch (e) {
                alert('Ausarbeiten fehlgeschlagen: ' + e.message);
            } finally {
                this.promoting = false;
            }
        },
        onImportClick() {
            if (this.$refs.mdInput) this.$refs.mdInput.click();
        },
        onDragLeave(e) {
            // Only clear when truly leaving the container (not when crossing children).
            if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget)) this.dragOver = false;
        },
        async onDropMd(e) {
            this.dragOver = false;
            const files = Array.from((e.dataTransfer && e.dataTransfer.files) || [])
                .filter((f) => f.name.toLowerCase().endsWith('.md'));
            await this._importFiles(files);
        },
        async onImportFiles(e) {
            const files = Array.from(e.target.files || []).filter((f) => f.name.toLowerCase().endsWith('.md'));
            e.target.value = '';
            await this._importFiles(files);
        },
        async _importFiles(files) {
            if (!files.length) return;
            this.importing = true;
            let last = null;
            for (const f of files) {
                try {
                    last = await this._importOne(f);
                } catch (err) {
                    console.error('Atlas import failed:', f.name, err);
                    alert('Import fehlgeschlagen (' + f.name + '): ' + err.message);
                }
            }
            this.importing = false;
            await this.load();
            if (last && last.id) this.selectedId = last.id;
        },
        _importOne(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = async () => {
                    try {
                        const created = await api('/api/plugins/atlas/import', {
                            method: 'POST',
                            body: JSON.stringify({ filename: file.name, content: reader.result }),
                        });
                        resolve(created);
                    } catch (e) { reject(e); }
                };
                reader.onerror = () => reject(new Error('Datei nicht lesbar'));
                reader.readAsText(file);
            });
        },
        onRootDragOver(e) {
            // Only show the .md overlay for actual file drags — not while dragging a card.
            const types = e.dataTransfer ? Array.from(e.dataTransfer.types || []) : [];
            if (types.includes('Files')) { e.preventDefault(); this.dragOver = true; }
        },
        async moveIdeaToStatus(id, status) {
            const idea = this.ideas.find((i) => i.id === id);
            if (!idea || idea.status === status) return;
            try {
                await api(`/api/plugins/atlas/ideas/${encodeURIComponent(id)}`, {
                    method: 'PUT',
                    body: JSON.stringify({ status }),
                });
                await this.load();
            } catch (e) {
                alert('Status ändern fehlgeschlagen: ' + e.message);
            }
        },
        // Pinboard helpers (#59)
        bodyPreview(idea) {
            if (!idea || !idea.body) return '';
            return idea.body
                .replace(/^#{1,6}\s+/gm, '')
                .replace(/\*\*([^*]+)\*\*/g, '$1')
                .replace(/\*([^*]+)\*/g, '$1')
                .replace(/`[^`]+`/g, '')
                .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
                .replace(/\r?\n/g, ' ')
                .trim()
                .substring(0, 200);
        },
        statusDotClass(s) {
            const map = { seed: 'bg-gray-300', developing: 'bg-blue-400', promoted: 'bg-emerald-400', parked: 'bg-gray-200' };
            return map[s] || 'bg-gray-300';
        },
        async changeStatus(status) {
            if (!this.selected || this.selected.status === status) return;
            await this.moveIdeaToStatus(this.selected.id, status);
        },
        // --- Dissertation (flat chapter list, ADR-0005, issue #62) ----------
        async loadDiss() {
            this.dissLoading = true;
            try {
                const data = await api('/api/plugins/atlas/diss');
                this.dissChapters = data.chapters || [];
                this.dissProgress = data.progress || {};
                this.dissIssues = data.issues || [];
            } catch (e) {
                this.dissChapters = [];
                this.dissProgress = {};
                this.dissIssues = [];
            }
            this.dissLoading = false;
        },
        nodeStatusLabel(s) { return (DISS_STATUSES.find((x) => x.key === s) || {}).label || s; },
        nodeStatusClass(s) { return DISS_STATUS_CLASS[s] || 'bg-bg-soft text-ink-3'; },
        relativeTime(iso) { return atlasRelative(iso); },
        // Die Drehscheibe frisch holen, ohne den Drawer zu schließen: nach dem
        // Abhaken eines Tasks oder eines Rückverweis-Tasks stimmen Kennzahlen
        // und Listen sonst nicht mehr.
        async refreshNodeHub() {
            if (!this.selectedNodeId) return;
            const id = this.selectedNodeId;
            try {
                const [detail, backlinks] = await Promise.all([
                    api('/api/plugins/atlas/diss/' + encodeURIComponent(id)),
                    api('/api/plugins/atlas/backlinks/' + encodeURIComponent(id)),
                ]);
                if (this.selectedNodeId !== id) return;   // inzwischen weitergeklickt
                this.nodeMetrics = detail;
                this.nodePublications = detail.publications_resolved || [];
                this.nodeBacklinks = backlinks;
            } catch (e) { /* der Drawer bleibt beim letzten Stand */ }
        },
        async selectNode(id) {
            this.selectedNodeId = id;
            this.nodeEditing = false;
            this.showIdeaPicker = false;
            this.showNodePubPicker = false;
            this.nodeLinks = [];
            this.nodePublications = [];
            this.nodeMetrics = {};
            this.nodeBacklinks = null;
            this.nodeLitAll = false;
            // Die Cite Keys der Literatur-Liste werden gegen die Bibliothek
            // aufgelöst; der Aufruf ist gecacht und blockiert nichts.
            this.loadLibraryPapers();
            api('/api/plugins/atlas/backlinks/' + encodeURIComponent(id))
                .then((d) => { if (this.selectedNodeId === id) this.nodeBacklinks = d; })
                .catch(() => { /* ohne Index keine Rückverweise — kein Fehlerfall */ });
            // Seed edit draft immediately from flat list so textarea / dropdown
            // are populated before the API detail call returns (#66).
            const chapter = (this.dissChapters || []).find((c) => c.id === id);
            if (chapter) {
                this.nodeEdit = {
                    title: chapter.title || '',
                    status: chapter.status || 'planned',
                    order: chapter.order || 0,
                    body: chapter.body || '',
                };
            }
            try {
                const d = await api('/api/plugins/atlas/diss/' + encodeURIComponent(id));
                this.nodeLinks = d.linked_ideas || [];
                this.nodePublications = d.publications_resolved || [];
                this.nodeMetrics = d;
                // Freshen draft fields in case detail response has newer data.
                if (d.body !== undefined) this.nodeEdit.body = d.body || '';
                if (d.status !== undefined) this.nodeEdit.status = d.status || 'planned';
            } catch (e) { /* node may have just vanished */ }
        },
        closeNodeDrawer() {
            this.selectedNodeId = null;
            this.nodeEditing = false;
            this.showIdeaPicker = false;
            this.showNodePubPicker = false;
            this.nodeMetrics = {};
            this.nodeBacklinks = null;
            this.nodeLitAll = false;
        },
        async deleteNode() {
            if (!this.selectedNodeId) return;
            if (!confirm('Dieses Kapitel wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.')) return;
            const id = this.selectedNodeId;
            try {
                await api('/api/plugins/atlas/diss/' + encodeURIComponent(id), { method: 'DELETE' });
            } catch (e) { alert('Löschen fehlgeschlagen: ' + e.message); return; }
            this.closeNodeDrawer();
            await this.loadDiss();
        },
        async deleteAllNodes() {
            if (!this.dissChapters.length) return;
            if (!confirm('Gesamte Gliederung löschen? Alle Kapitel werden unwiderruflich entfernt.')) return;
            try {
                await api('/api/plugins/atlas/diss', { method: 'DELETE' });
            } catch (e) { alert('Löschen fehlgeschlagen: ' + e.message); return; }
            await this.loadDiss();
        },
        openNodeCreate() {
            this.nodeError = '';
            this.nodeCreate = { title: '' };
            this.showNodeCreate = true;
            this.$nextTick(() => { if (this.$refs.nodeTitle) this.$refs.nodeTitle.focus(); });
        },
        async submitNodeCreate() {
            const title = this.nodeCreate.title.trim();
            if (!title || this.savingNode) return;
            this.savingNode = true;
            this.nodeError = '';
            try {
                const created = await api('/api/plugins/atlas/diss', {
                    method: 'POST',
                    body: JSON.stringify({ title }),
                });
                this.showNodeCreate = false;
                await this.loadDiss();
                this.selectNode(created.id);
            } catch (e) {
                this.nodeError = e.message;
            } finally {
                this.savingNode = false;
            }
        },
        startNodeEdit() {
            const n = this.selectedNode;
            if (!n) return;
            this.nodeEdit = {
                title: n.title || '',
                status: n.status || 'planned',
                order: n.order || 0,
                body: n.body || '',
            };
            this.nodeError = '';
            this.nodeEditing = true;
        },
        async saveNodeEdit() {
            // Always-editable drawer (#66): persist status + body; title/order
            // are managed separately (header display / up-down arrows).
            if (this.savingNode || !this.selectedNodeId) return;
            this.savingNode = true;
            this.nodeError = '';
            try {
                await api('/api/plugins/atlas/diss/' + encodeURIComponent(this.selectedNodeId), {
                    method: 'PUT',
                    body: JSON.stringify({
                        status: this.nodeEdit.status,
                        body: this.nodeEdit.body,
                    }),
                });
                await this.loadDiss();
                // Der Body kann neue [[Verweise]] tragen und die Datei hat eine
                // neue mtime — Kennzahlen und Rückverweise ziehen nach.
                this.refreshNodeHub();
            } catch (e) {
                this.nodeError = e.message;
            } finally {
                this.savingNode = false;
            }
        },
        openIdeaFromNode(id) {
            this.selectedNodeId = null;
            this.tab = 'ideen';
            this.selectedId = id;
        },
        toggleIdeaPicker() {
            this.showIdeaPicker = !this.showIdeaPicker;
            this.ideaPickerFilter = '';
        },
        async assignIdea(id) {
            const idea = this.ideas.find((i) => i.id === id);
            if (!idea) return;
            const diss = [...(idea.diss || [])];
            if (!diss.includes(this.selectedNodeId)) diss.push(this.selectedNodeId);
            try {
                await api(`/api/plugins/atlas/ideas/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ diss }) });
            } catch (e) { alert('Zuordnen fehlgeschlagen: ' + e.message); return; }
            this.showIdeaPicker = false;
            await this.load();
            await this.selectNode(this.selectedNodeId);
        },
        async unassignIdea(id) {
            const idea = this.ideas.find((i) => i.id === id);
            if (!idea) return;
            const diss = (idea.diss || []).filter((d) => d !== this.selectedNodeId);
            try {
                await api(`/api/plugins/atlas/ideas/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ diss }) });
            } catch (e) { alert('Lösen fehlgeschlagen: ' + e.message); return; }
            await this.load();
            await this.selectNode(this.selectedNodeId);
        },
        async loadLibraryPapers() {
            if (this.papersLoaded) return;
            this.paperPickerLoading = true;
            try {
                this.libraryPapers = await api('/api/papers');
                this.papersLoaded = true;
            } catch (e) {
                this.libraryPapers = [];
            }
            this.paperPickerLoading = false;
        },
        // --- Veröffentlichungen je Knoten (atlas.dissnode/2, Issue #53) ------
        toggleNodePubPicker() {
            this.showNodePubPicker = !this.showNodePubPicker;
            this.nodePubFilter = '';
        },
        async assignNodePublication(publicationId) {
            try {
                const res = await api(`/api/plugins/atlas/diss/${encodeURIComponent(this.selectedNodeId)}/publications`, {
                    method: 'POST', body: JSON.stringify({ publication_id: publicationId }),
                });
                this.nodePublications = res.publications || [];
            } catch (e) { alert('Zuordnen fehlgeschlagen: ' + e.message); return; }
            this.showNodePubPicker = false;
            await this.loadDiss();
        },
        async unassignNodePublication(publicationId) {
            try {
                const res = await api(`/api/plugins/atlas/diss/${encodeURIComponent(this.selectedNodeId)}/publications/${encodeURIComponent(publicationId)}`, {
                    method: 'DELETE',
                });
                this.nodePublications = res.publications || [];
            } catch (e) { alert('Lösen fehlgeschlagen: ' + e.message); return; }
            await this.loadDiss();
        },
        openPublicationFromNode(id) {
            this.closeNodeDrawer();
            this.tab = 'veroeffentlichungen';
            this.selectPublication(id);
        },
        // --- chapter reordering (up/down arrows, ADR-0005, issue #62) --------
        // Persists new order by swapping the `order` values of adjacent chapters
        // using the existing PUT /api/plugins/atlas/diss/{id} endpoint.
        async moveChapterUp(chapter) {
            const idx = this.dissChapters.findIndex((c) => c.id === chapter.id);
            if (idx <= 0) return;
            const prev = this.dissChapters[idx - 1];
            try {
                await api(`/api/plugins/atlas/diss/${encodeURIComponent(chapter.id)}`, {
                    method: 'PUT', body: JSON.stringify({ order: idx - 1 }),
                });
                await api(`/api/plugins/atlas/diss/${encodeURIComponent(prev.id)}`, {
                    method: 'PUT', body: JSON.stringify({ order: idx }),
                });
            } catch (e) { alert('Verschieben fehlgeschlagen: ' + e.message); return; }
            await this.loadDiss();
        },
        async moveChapterDown(chapter) {
            const idx = this.dissChapters.findIndex((c) => c.id === chapter.id);
            if (idx < 0 || idx >= this.dissChapters.length - 1) return;
            const next = this.dissChapters[idx + 1];
            try {
                await api(`/api/plugins/atlas/diss/${encodeURIComponent(chapter.id)}`, {
                    method: 'PUT', body: JSON.stringify({ order: idx + 1 }),
                });
                await api(`/api/plugins/atlas/diss/${encodeURIComponent(next.id)}`, {
                    method: 'PUT', body: JSON.stringify({ order: idx }),
                });
            } catch (e) { alert('Verschieben fehlgeschlagen: ' + e.message); return; }
            await this.loadDiss();
        },
        // Resolve chapter publication IDs against the loaded publications list.
        // Hanging IDs are kept as { found: false } — never auto-repaired.
        chapterPublicationsResolved(chapter) {
            return (chapter.publications || []).map((id) => {
                const pub = this.publications.find((p) => p.id === id);
                return pub
                    ? { id, found: true, title: pub.title, status: pub.status }
                    : { id, found: false, title: id, status: null };
            });
        },
        // --- Projekte -------------------------------------------------------
        async loadProjects() {
            this.projectsLoading = true;
            try {
                const data = await api('/api/plugins/atlas/projects');
                this.projects = data.projects || [];
            } catch (e) {
                this.projects = [];
            }
            this.projectsLoading = false;
        },
        projStatusLabel(s) { return (PROJECT_STATUSES.find((x) => x.key === s) || {}).label || s; },
        projStatusClass(s) { return PROJECT_STATUS_CLASS[s] || 'bg-bg-soft text-ink-3'; },
        projPeriod(p) {
            if (!p || (!p.start && !p.end)) return '';
            return `${p.start || '…'} – ${p.end || '…'}`;
        },
        projOverdueCount(p) {
            return ((p && p.timeline) || []).filter((m) => m.state === 'overdue').length;
        },
        projNextMilestone(p) {
            return ((p && p.timeline) || []).find((m) => m.next) || null;
        },
        // Delegates to global projRuntimeBar() — accepts a project object.
        projRuntimeBar(p) { return projRuntimeBar(p && p.start, p && p.end); },
        // Publication count for a project via reverse lookup over publications' projects field (ADR-0004).
        projPublicationCount(projectId) {
            return this.publications.filter((pub) => (pub.projects || []).includes(projectId)).length;
        },
        async selectProject(id) {
            this.selectedProjectId = id;
            this.projectEditing = false;
            this.projectRefsResolved = [];
            this.projectPublications = [];
            this.projectDocuments = [];
            this.projectDocsError = '';
            this.projectExtractingDocName = '';
            this.projectExtractWarning = '';
            this.projectExtractDialogDocName = '';
            this.projectExtractProposal = null;
            this.projectExtractDocName = '';
            this.projectExtractionModels = [];
            this.projectExtractionModel = '';
            this.loadProjectDocuments(id);
            this.loadProjectExtractionModels();
            // Publikationsliste für den „verknüpfen…"-Picker (Issue #50)
            this.loadPublications();
            try {
                const d = await api('/api/plugins/atlas/projects/' + encodeURIComponent(id));
                this.projectRefsResolved = d.refs_resolved || [];
                this.projectPublications = d.publications || [];
            } catch (e) { /* gone */ }
        },
        closeProjectDrawer() {
            this.selectedProjectId = null;
            this.projectEditing = false;
            this.projectPublications = [];
            this.projectDocuments = [];
            this.projectDocsError = '';
            this.projectExtractingDocName = '';
            this.projectExtractWarning = '';
            this.projectExtractDialogDocName = '';
            this.projectExtractProposal = null;
            this.projectExtractDocName = '';
            this.projectExtractionModels = [];
            this.projectExtractionModel = '';
        },
        // --- Projekt <-> Veröffentlichung (Issue #50, Link liegt auf der
        // Veröffentlichung — beide Aktionen schreiben deren Markdown-Datei) ---
        async linkPublicationToProject(event) {
            const pubId = event.target.value;
            event.target.value = '';
            if (!pubId || !this.selectedProjectId) return;
            try {
                const d = await api(`/api/plugins/atlas/projects/${encodeURIComponent(this.selectedProjectId)}/publications`, {
                    method: 'POST', body: JSON.stringify({ publication_id: pubId }),
                });
                this.projectPublications = d.publications || [];
                await this.loadPublications();
            } catch (e) {
                alert('Verknüpfen fehlgeschlagen: ' + e.message);
            }
        },
        async unlinkPublicationFromProject(pubId) {
            if (!this.selectedProjectId) return;
            try {
                const d = await api(`/api/plugins/atlas/projects/${encodeURIComponent(this.selectedProjectId)}/publications/${encodeURIComponent(pubId)}`, {
                    method: 'DELETE',
                });
                this.projectPublications = d.publications || [];
                await this.loadPublications();
            } catch (e) {
                alert('Lösen fehlgeschlagen: ' + e.message);
            }
        },
        openPublicationFromProject(id) {
            this.closeProjectDrawer();
            this.tab = 'veroeffentlichungen';
            this.selectPublication(id);
        },
        openProjectFromPublication(id) {
            this.closePublicationDrawer();
            this.tab = 'projekte';
            this.selectProject(id);
        },
        // --- Projektdokumente (Issue #49) ------------------------------------
        async loadProjectDocuments(id) {
            try {
                const d = await api(`/api/plugins/atlas/projects/${encodeURIComponent(id)}/documents`);
                this.projectDocuments = d.documents || [];
            } catch (e) {
                this.projectDocuments = [];
            }
        },
        async loadProjectExtractionModels() {
            this.projectExtractionModels = [];
            this.projectExtractionModel = '';
            try {
                // Die Liste der Verbindung, an der die Reasoning-Rolle haengt.
                const d = await api('/api/llm/models', { method: 'POST', body: JSON.stringify({ tier: 'reasoning' }) });
                this.projectExtractionModels = d.models || [];
                this.projectExtractionModel = d.current || '';
            } catch (e) {
                this.projectExtractionModels = [];
                this.projectExtractionModel = '';
            }
        },
        async uploadProjectDocument(event) {
            const file = event.target.files && event.target.files[0];
            event.target.value = '';
            if (!file || !this.selectedProjectId || this.projectDocUploading) return;
            this.projectDocUploading = true;
            this.projectDocsError = '';
            try {
                const formData = new FormData();
                formData.append('file', file);
                const resp = await fetch(`/api/plugins/atlas/projects/${encodeURIComponent(this.selectedProjectId)}/documents`, {
                    method: 'POST', body: formData,
                });
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({ detail: 'Upload fehlgeschlagen' }));
                    throw new Error(err.detail || 'Upload fehlgeschlagen');
                }
                await this.loadProjectDocuments(this.selectedProjectId);
            } catch (e) {
                this.projectDocsError = e.message;
            } finally {
                this.projectDocUploading = false;
            }
        },
        async openProjectDocument(name) {
            try {
                await api(`/api/plugins/atlas/projects/${encodeURIComponent(this.selectedProjectId)}/documents/${encodeURIComponent(name)}/open`, { method: 'POST' });
            } catch (e) {
                alert('Dokument öffnen fehlgeschlagen: ' + e.message);
            }
        },
        isPdfDocument(doc) {
            return !!doc && /\.pdf$/i.test(doc.name || '');
        },
        openExtractDialog(name) {
            if (!this.selectedProjectId || this.projectExtractingDocName) return;
            this.projectDocsError = '';
            // Zuletzt genutzte Zugehörigkeit aus dem Browser vorbelegen.
            try {
                this.projectExtractAffiliation = localStorage.getItem('atlas.extractAffiliation') || '';
            } catch (e) {
                this.projectExtractAffiliation = '';
            }
            this.projectExtractDialogDocName = name;
        },
        closeExtractDialog() {
            this.projectExtractDialogDocName = '';
        },
        async runProjectExtraction() {
            const name = this.projectExtractDialogDocName;
            if (!name || !this.selectedProjectId || this.projectExtractingDocName) return;
            const affiliation = (this.projectExtractAffiliation || '').trim();
            try { localStorage.setItem('atlas.extractAffiliation', affiliation); } catch (e) { /* ignore */ }
            this.projectExtractingDocName = name;
            this.projectDocsError = '';
            this.projectExtractWarning = '';
            try {
                const proposal = await api(`/api/plugins/atlas/projects/${encodeURIComponent(this.selectedProjectId)}/documents/${encodeURIComponent(name)}/extract`, {
                    method: 'POST',
                    body: JSON.stringify({ model: this.projectExtractionModel || null, affiliation: affiliation || null }),
                });
                // P4: Vorschlag erst im Vorschau-Popup anzeigen, Übernahme bestätigt der Nutzer.
                this.closeExtractDialog();
                this.projectExtractProposal = proposal;
                this.projectExtractDocName = name;
            } catch (e) {
                this.projectDocsError = e.message;  // Dialog bleibt offen, Fehler erscheint darin
            } finally {
                this.projectExtractingDocName = '';
            }
        },
        applyProjectExtraction() {
            const proposal = this.projectExtractProposal;
            if (!proposal) return;
            if (!this.projectEditing) this.startProjectEdit();
            this.mergeProjectExtraction(proposal);
            const warnings = (proposal.warnings || []).filter(Boolean);
            this.projectExtractWarning = warnings.length
                ? warnings.join(' ')
                : 'Vorschlag ins Formular übernommen. Bitte prüfen und speichern.';
            this.closeProjectExtractModal();
        },
        closeProjectExtractModal() {
            this.projectExtractProposal = null;
            this.projectExtractDocName = '';
        },
        async deleteProjectDocument(name) {
            if (!this.selectedProjectId) return;
            if (!confirm(`Dokument „${name}" wirklich löschen? Die Datei wird aus dem Projektordner entfernt.`)) return;
            this.projectDocsError = '';
            try {
                await api(`/api/plugins/atlas/projects/${encodeURIComponent(this.selectedProjectId)}/documents/${encodeURIComponent(name)}`, { method: 'DELETE' });
                await this.loadProjectDocuments(this.selectedProjectId);
            } catch (e) {
                this.projectDocsError = e.message;
            }
        },
        mergeProjectExtraction(proposal) {
            ['start', 'end', 'funder', 'grant_id', 'role'].forEach((field) => {
                const current = String(this.projectEdit[field] || '').trim();
                const next = proposal && proposal[field] != null ? String(proposal[field]).trim() : '';
                if (!current && next) this.projectEdit[field] = next;
            });
            const milestones = Array.isArray(proposal && proposal.milestones) ? proposal.milestones : [];
            milestones.forEach((m) => {
                const title = String((m && m.title) || '').trim();
                if (!title) return;
                this.projectEdit.milestones.push({
                    title,
                    date: m.date ? String(m.date).trim() : '',
                    done: false,
                });
            });
            const workpackageMarkdown = String((proposal && proposal.workpackage_markdown) || '').trim();
            if (workpackageMarkdown) {
                this.projectEdit.body = mergeProjectBodyExtraction(
                    this.projectEdit.body,
                    workpackageMarkdown,
                );
            }
        },
        docSize(bytes) {
            if (bytes == null) return '';
            if (bytes < 1024) return bytes + ' B';
            if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
            return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        },
        openProjectCreate() {
            this.projectError = '';
            this.projectCreate = { title: '', status: 'planned' };
            this.showProjectCreate = true;
            this.$nextTick(() => { if (this.$refs.projectTitle) this.$refs.projectTitle.focus(); });
        },
        async submitProjectCreate() {
            const title = this.projectCreate.title.trim();
            if (!title || this.savingProject) return;
            this.savingProject = true;
            this.projectError = '';
            try {
                const created = await api('/api/plugins/atlas/projects', {
                    method: 'POST',
                    body: JSON.stringify({ title, status: this.projectCreate.status }),
                });
                this.showProjectCreate = false;
                await this.loadProjects();
                this.selectProject(created.id);
            } catch (e) {
                this.projectError = e.message;
            } finally {
                this.savingProject = false;
            }
        },
        startProjectEdit() {
            const p = this.selectedProject;
            if (!p) return;
            this.projectEdit = {
                title: p.title || '',
                status: p.status || 'planned',
                start: p.start || '',
                end: p.end || '',
                funder: p.funder || '',
                grant_id: p.grant_id || '',
                role: p.role || '',
                tags: (p.tags || []).join(', '),
                refs: (p.refs || []).join('\n'),
                milestones: (p.milestones || []).map((m) => ({
                    title: m.title || '', date: m.date || '', done: !!m.done,
                })),
                body: p.body || '',
            };
            this.projectError = '';
            this.projectEditing = true;
        },
        addMilestone() {
            this.projectEdit.milestones.push({ title: '', date: '', done: false });
        },
        removeMilestone(i) {
            this.projectEdit.milestones.splice(i, 1);
        },
        async saveProjectEdit() {
            if (!this.projectEdit.title.trim() || this.savingProject) return;
            this.savingProject = true;
            this.projectError = '';
            try {
                const tags = this.projectEdit.tags.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean);
                const refs = this.projectEdit.refs.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
                const milestones = this.projectEdit.milestones
                    .map((m) => ({ title: m.title.trim(), date: m.date || null, done: !!m.done }))
                    .filter((m) => m.title);
                await api(`/api/plugins/atlas/projects/${encodeURIComponent(this.selectedProjectId)}`, {
                    method: 'PUT',
                    body: JSON.stringify({
                        title: this.projectEdit.title.trim(),
                        status: this.projectEdit.status,
                        start: this.projectEdit.start || null,
                        end: this.projectEdit.end || null,
                        funder: this.projectEdit.funder.trim() || null,
                        grant_id: this.projectEdit.grant_id.trim() || null,
                        role: this.projectEdit.role.trim() || null,
                        tags, refs, milestones,
                        body: this.projectEdit.body,
                    }),
                });
                this.projectEditing = false;
                await this.loadProjects();
                await this.selectProject(this.selectedProjectId);
            } catch (e) {
                this.projectError = e.message;
            } finally {
                this.savingProject = false;
            }
        },
        async deleteProject() {
            const id = this.selectedProjectId;
            if (!id || this.savingProject) return;
            const proj = this.selectedProject;
            if (!confirm(`Projekt „${(proj && proj.title) || id}" wirklich löschen? Die Markdown-Datei wird entfernt (hochgeladene Dokumente im Projektordner bleiben erhalten).`)) return;
            this.savingProject = true;
            this.projectError = '';
            try {
                await api(`/api/plugins/atlas/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
                this.closeProjectDrawer();
                await this.loadProjects();
            } catch (e) {
                this.projectError = e.message;
                alert('Löschen fehlgeschlagen: ' + e.message);
            } finally {
                this.savingProject = false;
            }
        },
        async toggleMilestone(index) {
            // Haken direkt in der Timeline: kompletter milestones-Stand per PUT
            // (UI -> Markdown-Datei -> Indexer, nie direkt in die DB).
            const p = this.selectedProject;
            if (!p) return;
            const milestones = (p.milestones || []).map((m, i) => ({
                title: m.title || '', date: m.date || null,
                done: i === index ? !m.done : !!m.done,
            }));
            try {
                await api(`/api/plugins/atlas/projects/${encodeURIComponent(p.id)}`, {
                    method: 'PUT', body: JSON.stringify({ milestones }),
                });
            } catch (e) { alert('Meilenstein umschalten fehlgeschlagen: ' + e.message); return; }
            await this.loadProjects();
        },
        async toggleTask(index) {
            try {
                await api(`/api/plugins/atlas/projects/${encodeURIComponent(this.selectedProjectId)}/toggle`, {
                    method: 'POST', body: JSON.stringify({ index }),
                });
            } catch (e) { alert('Aufgabe umschalten fehlgeschlagen: ' + e.message); return; }
            await this.loadProjects();
        },
        // --- Veroeffentlichungen (atlas.publication/1, ADR-0004) -------------
        // Lifecycle-Gruppen Hilfsmethoden (Issue #60) -------------------------
        // Wartezeit in Tagen seit dem Einreichungsdatum.
        waitingDays(dateStr) {
            if (!dateStr) return 0;
            return Math.max(0, Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000));
        },
        // Diss-Kapitel, die diese Veröffentlichung referenzieren.
        pubLinkedChapters(pubId) {
            return (this.dissChapters || []).filter((n) => (n.publications || []).includes(pubId));
        },
        // Toggle collapse state für einen Abschnitt.
        toggleSection(key) {
            const current = this.isSectionCollapsed(key);
            this.collapsedSections = { ...this.collapsedSections, [key]: !current };
        },
        // Ob ein Abschnitt eingeklappt ist.
        // "geplant" und "abgelehnt" sind per Default eingeklappt.
        isSectionCollapsed(key) {
            if (Object.prototype.hasOwnProperty.call(this.collapsedSections, key)) {
                return this.collapsedSections[key];
            }
            return key === 'geplant' || key === 'abgelehnt';
        },
        async loadPublications() {
            this.publicationsLoading = true;
            try {
                const data = await api('/api/plugins/atlas/publications');
                this.publications = data.publications || [];
            } catch (e) {
                this.publications = [];
            }
            try {
                const u = await api('/api/plugins/atlas/manuscripts/unassigned');
                this.unassignedManuscripts = u.manuscripts || [];
            } catch (e) {
                this.unassignedManuscripts = [];
            }
            this.publicationsLoading = false;
        },
        async assignManuscript(manuscriptId, event) {
            // One-Click-Zuordnung aus der „Nicht zugeordnet"-Sektion (Issue #45).
            const pubId = event.target.value;
            event.target.value = '';
            if (!pubId) return;
            try {
                await api(`/api/plugins/atlas/publications/${encodeURIComponent(pubId)}/manuscripts`, {
                    method: 'POST', body: JSON.stringify({ name: manuscriptId + '.tex' }),
                });
                await this.loadPublications();
            } catch (e) {
                alert('Zuordnung fehlgeschlagen: ' + e.message);
            }
        },
        async linkManuscript(event) {
            const id = event.target.value;
            event.target.value = '';
            if (!id || !this.selectedPublicationId) return;
            try {
                await api(`/api/plugins/atlas/publications/${encodeURIComponent(this.selectedPublicationId)}/manuscripts`, {
                    method: 'POST', body: JSON.stringify({ name: id + '.tex' }),
                });
                await this.loadPublications();
                await this.selectPublication(this.selectedPublicationId);
            } catch (e) {
                alert('Verknüpfen fehlgeschlagen: ' + e.message);
            }
        },
        async unlinkManuscript(name) {
            if (!this.selectedPublicationId) return;
            try {
                await api(`/api/plugins/atlas/publications/${encodeURIComponent(this.selectedPublicationId)}/manuscripts/${encodeURIComponent(name)}`, {
                    method: 'DELETE',
                });
                await this.loadPublications();
                await this.selectPublication(this.selectedPublicationId);
            } catch (e) {
                alert('Lösen fehlgeschlagen: ' + e.message);
            }
        },
        pubStatusLabel(s) { return (PUBLICATION_STATUSES.find((x) => x.key === s) || {}).label || s; },
        pubStatusClass(s) { return PUBLICATION_STATUS_CLASS[s] || 'bg-bg-soft text-ink-3'; },
        pubTypeLabel(t) { return (PUBLICATION_TYPES.find((x) => x.key === t) || {}).label || t; },
        async selectPublication(id) {
            this.selectedPublicationId = id;
            this.publicationEditing = false;
            this.manuscriptUploadError = '';
            this.publicationRefsResolved = [];
            this.publicationManuscriptsResolved = [];
            this.publicationOrigins = [];
            this.publicationProjectsResolved = [];
            this.publicationPaperResolved = null;
            try {
                const d = await api('/api/plugins/atlas/publications/' + encodeURIComponent(id));
                this.publicationRefsResolved = d.refs_resolved || [];
                this.publicationManuscriptsResolved = d.manuscripts_resolved || [];
                this.publicationOrigins = d.origins || [];
                this.publicationProjectsResolved = d.projects_resolved || [];
                this.publicationPaperResolved = d.paper_resolved || null;
            } catch (e) { /* gone */ }
        },
        closePublicationDrawer() {
            this.selectedPublicationId = null;
            this.publicationEditing = false;
        },
        openPublicationCreate() {
            this.publicationError = '';
            this.publicationCreate = { title: '', status: 'planned' };
            this.showPublicationCreate = true;
            this.$nextTick(() => { if (this.$refs.publicationTitle) this.$refs.publicationTitle.focus(); });
        },
        async submitPublicationCreate() {
            const title = this.publicationCreate.title.trim();
            if (!title || this.savingPublication) return;
            this.savingPublication = true;
            this.publicationError = '';
            try {
                const created = await api('/api/plugins/atlas/publications', {
                    method: 'POST',
                    body: JSON.stringify({ title, status: this.publicationCreate.status }),
                });
                this.showPublicationCreate = false;
                await this.loadPublications();
                this.selectPublication(created.id);
            } catch (e) {
                this.publicationError = e.message;
            } finally {
                this.savingPublication = false;
            }
        },
        startPublicationEdit() {
            const p = this.selectedPublication;
            if (!p) return;
            const lines = (arr) => (arr || []).join('\n');
            this.publicationEdit = {
                title: p.title || '',
                status: p.status || 'planned',
                type: p.type || '',
                venue: p.venue || '',
                authors: lines(p.authors),
                due: p.due || '',
                submitted: p.submitted || '',
                published: p.published || '',
                tags: (p.tags || []).join(', '),
                refs: lines(p.refs),
                derived_from: lines(p.derived_from),
                manuscripts: lines(p.manuscripts),
                projects: lines(p.projects),
                paper: p.paper || '',
                body: p.body || '',
            };
            this.publicationError = '';
            this.publicationEditing = true;
        },
        async savePublicationEdit() {
            if (!this.publicationEdit.title.trim() || this.savingPublication) return;
            this.savingPublication = true;
            this.publicationError = '';
            try {
                const splitLines = (s) => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
                const tags = this.publicationEdit.tags.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean);
                await api(`/api/plugins/atlas/publications/${encodeURIComponent(this.selectedPublicationId)}`, {
                    method: 'PUT',
                    body: JSON.stringify({
                        title: this.publicationEdit.title.trim(),
                        status: this.publicationEdit.status,
                        type: this.publicationEdit.type || null,
                        venue: this.publicationEdit.venue.trim() || null,
                        authors: splitLines(this.publicationEdit.authors),
                        due: this.publicationEdit.due || null,
                        submitted: this.publicationEdit.submitted || null,
                        published: this.publicationEdit.published || null,
                        tags,
                        refs: splitLines(this.publicationEdit.refs),
                        derived_from: splitLines(this.publicationEdit.derived_from),
                        manuscripts: splitLines(this.publicationEdit.manuscripts),
                        projects: splitLines(this.publicationEdit.projects),
                        paper: this.publicationEdit.paper.trim() || null,
                        body: this.publicationEdit.body,
                    }),
                });
                this.publicationEditing = false;
                await this.loadPublications();
                await this.selectPublication(this.selectedPublicationId);
            } catch (e) {
                this.publicationError = e.message;
            } finally {
                this.savingPublication = false;
            }
        },
        async deletePublication() {
            const p = this.selectedPublication;
            if (!p || this.savingPublication) return;
            if (!confirm(`Veröffentlichung „${p.title}" wirklich löschen? Die Markdown-Datei wird entfernt.`)) return;
            this.savingPublication = true;
            this.publicationError = '';
            try {
                await api(`/api/plugins/atlas/publications/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
                this.closePublicationDrawer();
                await this.loadPublications();
            } catch (e) {
                this.publicationError = e.message;
            } finally {
                this.savingPublication = false;
            }
        },
        openIdeaFromPublication(id) {
            this.selectedPublicationId = null;
            this.tab = 'ideen';
            this.selectedId = id;
        },
        openManuscriptFromPublication(id) {
            this.selectedPublicationId = null;
            this.editorInitialId = id;
            this.tab = 'editor';
        },
        async uploadManuscriptToPublication(event) {
            const file = event.target.files && event.target.files[0];
            event.target.value = '';
            if (!file || !this.selectedPublicationId || this.manuscriptUploading) return;
            if (!/\.tex$/i.test(file.name)) {
                this.manuscriptUploadError = 'Bitte eine .tex-Datei wählen.';
                return;
            }
            this.manuscriptUploading = true;
            this.manuscriptUploadError = '';
            try {
                const formData = new FormData();
                formData.append('file', file);
                const resp = await fetch('/api/plugins/atlas/manuscripts/upload', { method: 'POST', body: formData });
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({ detail: 'Upload fehlgeschlagen' }));
                    throw new Error(err.detail || 'Upload fehlgeschlagen');
                }
                const created = await resp.json();
                // Neu hochgeladenes Manuskript direkt mit dieser Veröffentlichung verknüpfen.
                await api(`/api/plugins/atlas/publications/${encodeURIComponent(this.selectedPublicationId)}/manuscripts`, {
                    method: 'POST', body: JSON.stringify({ name: created.id + '.tex' }),
                });
                await this.loadPublications();
                await this.selectPublication(this.selectedPublicationId);
            } catch (e) {
                this.manuscriptUploadError = e.message;
            } finally {
                this.manuscriptUploading = false;
            }
        },
        async createManuscriptForPublication() {
            if (!this.selectedPublicationId) return;
            const pub = this.selectedPublication;
            const title = prompt('Titel des neuen Manuskripts:', (pub && pub.title) || '');
            if (title == null) return;
            this.manuscriptUploadError = '';
            try {
                const created = await api('/api/plugins/atlas/manuscripts', {
                    method: 'POST', body: JSON.stringify({ title: title.trim() || 'Manuskript' }),
                });
                await api(`/api/plugins/atlas/publications/${encodeURIComponent(this.selectedPublicationId)}/manuscripts`, {
                    method: 'POST', body: JSON.stringify({ name: created.id + '.tex' }),
                });
                // Direkt im LaTeX-Editor öffnen (verlässt den Publikations-Drawer).
                this.openManuscriptFromPublication(created.id);
            } catch (e) {
                this.manuscriptUploadError = e.message;
            }
        },
        // --- BibTeX-Import (CONTEXT.md "BibTeX Import") ----------------------
        openBibtexImport() {
            this.bibtexStep = 1;
            this.bibtexBibFile = null;
            this.bibtexTexFile = null;
            this.bibtexError = '';
            this.bibtexEntries = [];
            this.bibtexCommitSummary = null;
            this.bibtexImportRemoved = false;
            this.bibtexDownloads = [];
            this.showBibtexImport = true;
        },
        async closeBibtexImport() {
            if (this.bibtexDownloading) return;
            this.showBibtexImport = false;
            if (this.bibtexCommitSummary) {
                await this.loadPublications();
                await this.selectPublication(this.selectedPublicationId);
            }
        },
        onBibtexFile(event, kind) {
            const file = event.target.files[0] || null;
            if (kind === 'bib') this.bibtexBibFile = file;
            else this.bibtexTexFile = file;
        },
        async bibtexPreview() {
            if (!this.bibtexBibFile || this.bibtexLoading) return;
            this.bibtexLoading = true;
            this.bibtexError = '';
            try {
                const formData = new FormData();
                formData.append('bib_file', this.bibtexBibFile);
                if (this.bibtexTexFile) formData.append('tex_file', this.bibtexTexFile);
                const resp = await fetch('/api/import/bibtex/preview', { method: 'POST', body: formData });
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({ detail: 'Unbekannter Fehler' }));
                    throw new Error(err.detail || 'HTTP ' + resp.status);
                }
                const data = await resp.json();
                const existingRefs = new Set((this.selectedPublication && this.selectedPublication.refs) || []);
                this.bibtexEntries = (data.entries || []).map((e) => ({
                    ...e,
                    // Vorauswahl: mit .tex nur zitierte, sonst alle; bereits an der
                    // Veröffentlichung haengende Keys bleiben abgewaehlt.
                    _selected: (e.cited !== false) && !existingRefs.has(e.proposed_cite_key),
                    _alreadyAssigned: existingRefs.has(e.proposed_cite_key),
                }));
                if (!this.bibtexEntries.length) {
                    this.bibtexError = 'Keine BibTeX-Eintraege gefunden.';
                    return;
                }
                this.bibtexStep = 2;
            } catch (e) {
                this.bibtexError = e.message;
            } finally {
                this.bibtexLoading = false;
            }
        },
        bibtexSelectAll(value) {
            this.bibtexEntries.forEach((e) => { e._selected = value; });
        },
        async bibtexCommit() {
            const selected = this.bibtexEntries.filter((e) => e._selected);
            if (!selected.length || this.bibtexLoading) return;
            this.bibtexLoading = true;
            this.bibtexError = '';
            try {
                const payload = selected.map((e) => ({
                    key: e.key, title: e.title, authors: e.authors, year: e.year,
                    doi: e.doi, isbn: e.isbn, abstract: e.abstract, journal: e.journal,
                    publisher: e.publisher, entry_type: e.entry_type,
                    matched_paper_id: e.match ? e.match.paper_id : null,
                    raw: e.raw || {},
                }));
                const data = await api('/api/import/bibtex/commit', {
                    method: 'POST', body: JSON.stringify({
                        entries: payload,
                        source_name: this.bibtexBibFile ? this.bibtexBibFile.name : '',
                    }),
                });
                this.bibtexCommitSummary = data;
                const ok = (data.results || []).filter((r) => r.status === 'created' || r.status === 'matched');
                // Cite Keys an die Veröffentlichung haengen (refs, ADR-0003/ADR-0004)
                if (ok.length) {
                    await api(`/api/plugins/atlas/publications/${encodeURIComponent(this.selectedPublicationId)}/refs`, {
                        method: 'POST',
                        body: JSON.stringify({ refs: ok.map((r) => r.cite_key) }),
                    });
                }
                this.bibtexStep = 3;
                // Download-Kandidaten: alles ohne PDF; OA-Verfuegbarkeit pruefen
                const byKey = {};
                this.bibtexEntries.forEach((e) => { byKey[e.key] = e; });
                const candidates = ok.filter((r) => !r.has_pdf).map((r) => ({
                    paper_id: r.paper_id,
                    cite_key: r.cite_key,
                    title: (byKey[r.key] || {}).title || r.key,
                    doi: r.doi || '',
                    oa_pdf_url: '', doi_url: '', scholar_url: '',
                    _checked: false, _selected: false, status: '', error: '',
                }));
                this.bibtexDownloads = candidates;
                if (candidates.length) {
                    const check = await api('/api/import/bibtex/oa-check', {
                        method: 'POST',
                        body: JSON.stringify({ items: candidates.map((c) => ({
                            paper_id: c.paper_id, doi: c.doi, title: c.title })) }),
                    });
                    const byId = {};
                    (check.results || []).forEach((r) => { byId[r.paper_id] = r; });
                    this.bibtexDownloads.forEach((c) => {
                        const r = byId[c.paper_id] || {};
                        c.oa_pdf_url = r.oa_pdf_url || '';
                        c.doi_url = r.doi_url || '';
                        c.scholar_url = r.scholar_url || '';
                        c._checked = true;
                        c._selected = !!c.oa_pdf_url;  // Auswahl-Dialog: Nutzer bestimmt, was geladen wird
                    });
                }
            } catch (e) {
                this.bibtexError = e.message;
            } finally {
                this.bibtexLoading = false;
            }
        },
        async removeImportedPapers() {
            // Macht genau diesen Import rückgängig: löscht die neu angelegten
            // Papers und entfernt deren Cite Keys wieder aus den Publikations-Refs.
            const created = (this.bibtexCommitSummary && this.bibtexCommitSummary.results || [])
                .filter((r) => r.status === 'created' && r.paper_id);
            if (!created.length || this.bibtexLoading) return;
            if (!confirm(`${created.length} in diesem Import angelegte Einträge wieder entfernen? Die zugehörigen Bibliotheks-Papers werden gelöscht (bereits vorher vorhandene bleiben).`)) return;
            this.bibtexLoading = true;
            this.bibtexError = '';
            try {
                const ids = created.map((r) => r.paper_id);
                await api('/api/papers/bulk-delete', {
                    method: 'POST', body: JSON.stringify({ paper_ids: ids }),
                });
                // Cite Keys aus den Refs der Veröffentlichung nehmen (keine hängenden Verweise).
                const citeKeys = new Set(created.map((r) => r.cite_key).filter(Boolean));
                if (citeKeys.size && this.selectedPublicationId) {
                    try {
                        const pub = await api(`/api/plugins/atlas/publications/${encodeURIComponent(this.selectedPublicationId)}`);
                        const remaining = (pub.refs || []).filter((c) => !citeKeys.has(c));
                        await api(`/api/plugins/atlas/publications/${encodeURIComponent(this.selectedPublicationId)}`, {
                            method: 'PUT', body: JSON.stringify({ refs: remaining }),
                        });
                    } catch (e) { /* Refs-Bereinigung best-effort */ }
                }
                const removed = new Set(ids);
                this.bibtexDownloads = this.bibtexDownloads.filter((c) => !removed.has(c.paper_id));
                this.bibtexImportRemoved = true;
                window.dispatchEvent(new CustomEvent('refresh-sidebar'));
            } catch (e) {
                this.bibtexError = e.message;
            } finally {
                this.bibtexLoading = false;
            }
        },
        async bibtexDownloadSelected() {
            if (this.bibtexDownloading) return;
            this.bibtexDownloading = true;
            for (const c of this.bibtexDownloads) {
                if (!c._selected || !c.oa_pdf_url || c.status === 'ok') continue;
                c.status = 'laedt';
                c.error = '';
                try {
                    await api(`/api/papers/${c.paper_id}/fetch-oa-pdf`, {
                        method: 'POST', body: JSON.stringify({ url: c.oa_pdf_url }),
                    });
                    c.status = 'ok';
                } catch (e) {
                    c.status = 'fehler';
                    c.error = e.message;
                }
            }
            this.bibtexDownloading = false;
        },
    },
    watch: {
        '$route.query.idea'() { this.applyRouteIdea(); },
        '$route.query.pub'() { this.applyRouteIdea(); },
        '$route.query.proj'() { this.applyRouteIdea(); },
        '$route.query.chapter'() { this.applyRouteIdea(); },
        '$route.query.tab'() { this.applyRouteIdea(); },
        '$route.query.focus'() { this.applyRouteIdea(); },
        selectedId() { this.editing = false; this.resetMatch(); },  // switching ideas exits edit mode + stale proposals
        tab(val) {
            if (val === 'dissertation') this.loadDiss();
            else if (val === 'projekte') this.loadProjects();
            else if (val === 'veroeffentlichungen') this.loadPublications();
            if (val !== 'editor') this.editorInitialId = null;
        },
    },
    mounted() {
        this.load();
        this.loadDiss();
        this.loadProjects();
        this.loadPublications();
        this.connectSSE();
        this.applyRouteIdea();
        window.addEventListener('keydown', this.onCaptureShortcut);
    },
    beforeUnmount() {
        if (this._es) { this._es.close(); this._es = null; }
        window.removeEventListener('keydown', this.onCaptureShortcut);
    },
};

// =============================================================================
// Atlas-Werkbank — Heute, Woche, Zettel (Issue #180, Slice 6)
// =============================================================================
// Der Backend-Kontrakt sind Fehler-CODES, keine Sätze (ADR-0018). Für die
// Kern-Oberfläche löst `t()` sie gegen den Katalog auf; Atlas ist davon
// ausgenommen (die Plugin-Texte sind deutsch und werden nie exportiert), also
// steht die Zuordnung hier — ein `atlas.*`-Schlüssel in `core.de.js` würde den
// Plugin-Bezeichner veröffentlichen.
const ATLAS_ERROR_TEXT = {
    'error.atlas.week_invalid': 'Ungültige Kalenderwoche.',
    'error.atlas.date_invalid': 'Ungültiges Datum.',
    'error.atlas.day_outside_week': 'Der Tag liegt außerhalb dieser Woche.',
    'error.atlas.task_not_found': 'Der Task existiert nicht mehr — die Ansicht wird neu geladen.',
    'error.atlas.task_text_required': 'Ein Task braucht Text.',
    'error.atlas.goal_not_found': 'Das Wochenziel existiert nicht mehr.',
    'error.atlas.goals_too_many': 'Höchstens fünf Wochenziele je Woche.',
    'error.atlas.goal_title_required': 'Ein Wochenziel braucht einen Titel.',
    'error.atlas.title_required': 'Ein Titel ist Pflicht.',
    'error.atlas.zettel_not_found': 'Der Zettel existiert nicht mehr.',
    'error.atlas.checklist_index_invalid': 'Dieser Checklisten-Punkt existiert nicht mehr.',
    'error.atlas.already_promoted': 'Aus diesem Zettel ist bereits eine Idee entstanden.',
    'error.atlas.invalid_request': 'Die Anfrage passt nicht zum Journal.',
};

function atlasErrorText(err) {
    const msg = (err && err.message) || String(err || '');
    return ATLAS_ERROR_TEXT[msg] || msg;
}

// ── Heute (Story 1–19) ──────────────────────────────────────────────────────
// Der Tagesplan ist die Startseite des Plugins (Story 58): links die Tasks des
// Tages und der Block „offen von gestern", rechts Wochenziele, „Was liegt an"
// und die zuletzt geschriebenen Zettel. Nachladen läuft still (kein Spinner,
// keine Sprünge) — die Seite hängt an denselben SSE-Ereignissen wie der
// Watcher, ein externer Editor-Edit erscheint also von selbst (Story 60).
const AtlasTodayPage = {
    components: {
        'atlas-nav': AtlasNav,
        'atlas-capture': AtlasCapture,
        'atlas-task-row': AtlasTaskRow,
    },
    template: `
        <div class="p-6 atlas-page">
            <atlas-nav active="heute" />

            <div class="atlas-head">
                <div>
                    <div class="atlas-kicker">
                        <template v-if="data">KW {{ weekNumber }} · Tag {{ dayIndex }} von 7</template>
                        <template v-else>Atlas · Werkbank</template>
                    </div>
                    <h1 class="atlas-title">{{ headline }}</h1>
                </div>
                <div class="atlas-actions">
                    <button type="button" class="atlas-pill" :disabled="busyJournal || !data" @click="openJournal">
                        {{ busyJournal ? 'Öffnet…' : 'Journal öffnen' }}
                    </button>
                    <button type="button" class="atlas-pill" :disabled="busyReindex" @click="reindex">
                        {{ busyReindex ? 'Reindex läuft…' : 'Reindex' }}
                    </button>
                </div>
            </div>

            <atlas-capture @created="onCaptured" />

            <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
                <div class="lg:col-span-2 flex flex-col gap-5 min-w-0">
                    <section class="atlas-sec">
                        <div class="atlas-sec-head">
                            <h2 class="atlas-sec-title">Heute · {{ doneCount }} von {{ tasks.length }} erledigt</h2>
                            <span class="atlas-sec-note">Reihenfolge = Reihenfolge in der Datei</span>
                        </div>
                        <div class="atlas-card">
                            <div v-if="loading" class="p-4 flex flex-col gap-3" aria-hidden="true">
                                <div v-for="n in 3" :key="n" class="atlas-skel" style="height:20px"></div>
                            </div>
                            <p v-else-if="!tasks.length" class="atlas-empty">
                                Noch nichts für heute. Schreib die erste Zeile oben ins Erfassen-Feld —
                                Anker per <code>[[id]]</code>, Schlagwort per <code>#tag</code>.
                            </p>
                            <template v-else>
                                <atlas-task-row v-for="(task, i) in tasks" :key="taskKey(task)"
                                                :task="task" :first="i === 0" :last="i === tasks.length - 1"
                                                :pending="pending === taskKey(task)"
                                                @toggle="toggle(task)"
                                                @save="(text) => saveText(task, text)"
                                                @remove="remove(task)"
                                                @move-up="reorder(task, i - 1)"
                                                @move-down="reorder(task, i + 1)" />
                            </template>
                        </div>
                    </section>

                    <section v-if="carryOver.length" class="atlas-sec">
                        <div class="atlas-sec-head">
                            <h2 class="atlas-sec-title">Offen von gestern · {{ carryOver.length }}</h2>
                            <button type="button" class="atlas-link-btn" :disabled="busyCarry" @click="carryAll">
                                {{ busyCarry ? 'Überträgt…' : 'Alle übertragen' }}
                            </button>
                        </div>
                        <div class="atlas-card">
                            <atlas-task-row v-for="task in carryOver" :key="taskKey(task)"
                                            :task="task" :reorderable="false" carryable
                                            :pending="pending === taskKey(task)"
                                            @toggle="toggle(task)"
                                            @save="(text) => saveText(task, text)"
                                            @remove="remove(task)"
                                            @carry="carryOne(task)" />
                        </div>
                    </section>
                </div>

                <aside class="flex flex-col gap-5 min-w-0">
                    <section class="atlas-sec">
                        <div class="atlas-sec-head">
                            <h2 class="atlas-sec-title">Wochenziele</h2>
                            <router-link to="/atlas/woche" class="atlas-link-btn" style="text-decoration:none">bearbeiten</router-link>
                        </div>
                        <div v-if="loading" class="atlas-skel" style="height:64px"></div>
                        <div v-else-if="!goals.length" class="atlas-card atlas-empty">
                            Keine Wochenziele. In der Wochenansicht lassen sich bis zu fünf setzen.
                        </div>
                        <div v-else class="flex flex-col gap-2">
                            <div v-for="goal in goals" :key="goal.index" class="atlas-goal">
                                <div class="atlas-goal-head">
                                    <span class="atlas-goal-title">{{ goal.title }}</span>
                                    <span class="atlas-goal-count" :class="{ 'is-done': goalReached(goal) }">{{ goalCount(goal) }}</span>
                                </div>
                                <div class="atlas-bar">
                                    <div class="atlas-bar-fill" :class="{ 'is-done': goalReached(goal) }"
                                         :style="{ width: goalPercent(goal) }"></div>
                                </div>
                            </div>
                        </div>
                    </section>

                    <section class="atlas-sec">
                        <h2 class="atlas-sec-title">Was liegt an</h2>
                        <div v-if="loading" class="atlas-skel" style="height:64px"></div>
                        <div v-else class="atlas-card">
                            <p v-if="!dueItems.length" class="atlas-empty">Nichts überfällig. Keine Frist in den nächsten sieben Tagen.</p>
                            <div v-for="item in dueItems" :key="item.key" class="atlas-due">
                                <span class="atlas-due-dot" :class="{ 'is-overdue': item.overdue }"></span>
                                <div class="min-w-0">
                                    <router-link v-if="item.to" :to="item.to">{{ item.title }}</router-link>
                                    <strong v-else>{{ item.title }}</strong>
                                    <div class="atlas-due-sub">{{ item.note }}</div>
                                </div>
                            </div>
                        </div>
                    </section>

                    <section class="atlas-sec">
                        <div class="atlas-sec-head">
                            <h2 class="atlas-sec-title">Zuletzt notiert</h2>
                            <router-link to="/atlas/zettel" class="atlas-link-btn" style="text-decoration:none">alle</router-link>
                        </div>
                        <div v-if="loading" class="atlas-skel" style="height:48px"></div>
                        <div v-else-if="!zettel.length" class="atlas-card atlas-empty">
                            Noch kein Zettel. Das Erfassen-Feld legt im Modus „Zettel" einen an.
                        </div>
                        <div v-else class="flex flex-col gap-1.5 text-[13px]">
                            <div v-for="z in zettel" :key="z.id" class="flex justify-between gap-3">
                                <router-link :to="'/atlas/zettel/' + encodeURIComponent(z.id)"
                                             class="text-ink hover:text-accent truncate" style="text-decoration:none">{{ z.title }}</router-link>
                                <span class="text-mute whitespace-nowrap">{{ shortDate(z.date) }}</span>
                            </div>
                        </div>
                    </section>
                </aside>
            </div>
        </div>
    `,
    data() {
        return {
            data: null,
            loading: true,
            pending: null,
            busyJournal: false,
            busyReindex: false,
            busyCarry: false,
            _es: null,
            _timer: null,
        };
    },
    computed: {
        tasks() { return (this.data && this.data.tasks) || []; },
        carryOver() { return (this.data && this.data.carry_over) || []; },
        goals() { return (this.data && this.data.goals) || []; },
        zettel() { return (this.data && this.data.zettel) || []; },
        doneCount() { return this.tasks.filter((t) => t.done).length; },
        weekNumber() {
            const m = /W(\d{2})/.exec((this.data && this.data.week) || '');
            return m ? Number(m[1]) : '';
        },
        dayIndex() {
            const d = atlasDate(this.data && this.data.date);
            return d ? ((d.getDay() + 6) % 7) + 1 : 0;
        },
        headline() {
            if (!this.data) return 'Heute';
            return this.data.weekday + ', ' + atlasDayMonth(this.data.date);
        },
        // „Was liegt an" als eine Liste: Meilensteine zuerst (die haben ein
        // Datum), dann stehengebliebene Kapitel und Seed-Ideen (Story 15–17).
        dueItems() {
            const due = (this.data && this.data.due) || {};
            const out = [];
            for (const m of due.milestones || []) {
                const late = Math.abs(m.days);
                out.push({
                    key: 'ms:' + m.project_id + ':' + m.index,
                    title: m.title,
                    overdue: m.state === 'overdue',
                    note: 'Projekt · ' + (m.project_title || m.project_id) + ' · '
                        + (m.days < 0
                            ? late + (late === 1 ? ' Tag überfällig' : ' Tage überfällig')
                            : (m.days === 0 ? 'heute fällig' : 'fällig ' + atlasShortDate(m.date))),
                    to: { path: '/atlas/sammlung', query: { tab: 'projekte', proj: m.project_id } },
                });
            }
            for (const c of due.stale_chapters || []) {
                out.push({
                    key: 'ch:' + c.id,
                    title: c.title || c.id,
                    overdue: false,
                    note: 'Kapitel · ' + this.since(c.days) + ' unverändert',
                    to: { path: '/atlas/sammlung', query: { tab: 'dissertation', chapter: c.id } },
                });
            }
            for (const i of due.stale_ideas || []) {
                out.push({
                    key: 'id:' + i.id,
                    title: i.title || i.id,
                    overdue: false,
                    note: 'Idee · ' + this.since(i.days) + ' im Status seed',
                    to: { path: '/atlas/sammlung', query: { tab: 'ideen', idea: i.id } },
                });
            }
            return out;
        },
    },
    methods: {
        taskKey(task) { return task.week + '#' + task.body_index; },
        shortDate(iso) { return atlasShortDate(iso); },
        // „seit 1 Tag" statt „seit 1 Tagen" — der Server zählt Tage in die
        // Vergangenheit negativ, die Anzeige dreht das um.
        since(days) {
            const n = Math.abs(Number(days) || 0);
            if (n === 0) return 'seit heute';
            if (n === 1) return 'seit 1 Tag';
            if (n >= 60) return 'seit über ' + Math.floor(n / 30) + ' Monaten';
            return 'seit ' + n + ' Tagen';
        },
        goalReached(goal) {
            return !!goal.done || (goal.total > 0 && goal.done_count === goal.total);
        },
        goalCount(goal) {
            if (goal.total) return goal.done_count + '/' + goal.total;
            return goal.done ? 'erledigt' : 'offen';
        },
        goalPercent(goal) { return Math.round((goal.progress || 0) * 100) + '%'; },
        taskUrl(task) {
            return '/api/plugins/atlas/journal/' + encodeURIComponent(task.week)
                + '/tasks/' + encodeURIComponent(task.body_index);
        },
        async load(silent = false) {
            if (!silent) this.loading = true;
            const data = await atlasRefreshToday();
            if (data) this.data = data;
            this.loading = false;
        },
        // Nachladen nach einem Ereignis wird gebündelt: ein Schreibvorgang
        // löst Watcher- UND Router-Ereignis aus, das soll ein Reload bleiben.
        scheduleReload() {
            if (this._timer) clearTimeout(this._timer);
            this._timer = setTimeout(() => { this._timer = null; this.load(true); }, 200);
        },
        async toggle(task) {
            // Optimistisch: das Häkchen sitzt sofort, ein Fehler nimmt es zurück.
            // Bewusst OHNE `pending`: das Häkchen ist die Rückmeldung, ein
            // Abblenden der Zeile für die Dauer des Schreibvorgangs wäre genau
            // das Flackern, das ein Klick auf eine Checkbox nicht haben darf.
            const before = task.done;
            task.done = !before;
            task.open = !task.done && !task.moved_to;
            try {
                await api(this.taskUrl(task) + '/toggle', { method: 'POST' });
                await this.load(true);
            } catch (e) {
                task.done = before;
                task.open = !before && !task.moved_to;
                alert(atlasErrorText(e));
            }
        },
        // Die Zeile ändert sich gleich wirklich (Text, Position, Verschwinden) —
        // hier ist das Abblenden ehrliche Rückmeldung, kein Flackern.
        async write(task, run) {
            this.pending = this.taskKey(task);
            try {
                await run();
            } catch (e) {
                alert(atlasErrorText(e));
            }
            this.pending = null;
            await this.load(true);
        },
        saveText(task, text) {
            return this.write(task, () => api(this.taskUrl(task), {
                method: 'PUT', body: JSON.stringify({ text }),
            }));
        },
        remove(task) {
            return this.write(task, () => api(this.taskUrl(task), { method: 'DELETE' }));
        },
        reorder(task, position) {
            if (position < 0 || position >= this.tasks.length) return Promise.resolve();
            return this.write(task, () => api(this.taskUrl(task) + '/reorder', {
                method: 'POST', body: JSON.stringify({ position }),
            }));
        },
        carryOne(task) {
            return this.write(task, () => api(this.taskUrl(task) + '/move', {
                method: 'POST', body: JSON.stringify({ to: this.data.date }),
            }));
        },
        async carryAll() {
            if (this.busyCarry || !this.data) return;
            this.busyCarry = true;
            try {
                await api('/api/plugins/atlas/journal/' + encodeURIComponent(this.data.week) + '/carry-over', {
                    method: 'POST',
                    body: JSON.stringify({ to: this.data.date }),
                });
            } catch (e) {
                alert(atlasErrorText(e));
            }
            this.busyCarry = false;
            await this.load(true);
        },
        async openJournal() {
            if (this.busyJournal || !this.data) return;
            this.busyJournal = true;
            try {
                await api('/api/plugins/atlas/journal/' + encodeURIComponent(this.data.week) + '/open', { method: 'POST' });
            } catch (e) {
                alert(atlasErrorText(e));
            }
            this.busyJournal = false;
        },
        async reindex() {
            if (this.busyReindex) return;
            this.busyReindex = true;
            try {
                await api('/api/plugins/atlas/reindex', { method: 'POST' });
                await atlasLoadEntities(true);
            } catch (e) {
                alert(atlasErrorText(e));
            }
            this.busyReindex = false;
            await this.load(true);
        },
        onCaptured() { this.load(true); },
    },
    created() {
        // Alte Tiefenlinks (/atlas?idea=…) zeigten auf die Sammlung, die jetzt
        // unter /atlas/sammlung liegt — sie sollen weiter dort landen.
        const q = this.$route.query || {};
        if (q.idea || q.pub || q.proj || q.chapter || q.tab) {
            this.$router.replace({ path: '/atlas/sammlung', query: q });
        }
    },
    mounted() {
        this.load();
        atlasLoadEntities();
        this._es = atlasConnectEvents(() => this.scheduleReload());
    },
    beforeUnmount() {
        if (this._es) { this._es.close(); this._es = null; }
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    },
};

// ── Woche (Story 20–30) ─────────────────────────────────────────────────────
// Sieben Tagesspalten, die Wochenziele darüber, der abgeleitete Rückblick
// darunter. Die Woche steht im Pfad (/atlas/woche/2026-W39), damit Blättern
// und Lesezeichen dasselbe sind; ohne Parameter ist es die laufende Woche.
const AtlasWeekPage = {
    components: {
        'atlas-nav': AtlasNav,
        'atlas-capture': AtlasCapture,
        'atlas-anchor-chip': AtlasAnchorChip,
    },
    template: `
        <div class="p-6 atlas-page">
            <atlas-nav :active="navKey" />

            <div class="atlas-head">
                <div>
                    <div class="atlas-kicker">{{ range || 'Kalenderwoche' }}</div>
                    <h1 class="atlas-title">Kalenderwoche {{ week ? week.number : '' }}</h1>
                </div>
                <div class="atlas-actions">
                    <router-link v-if="week" :to="'/atlas/woche/' + week.previous" class="atlas-pill">← KW {{ weekNumberOf(week.previous) }}</router-link>
                    <router-link v-if="week" :to="'/atlas/woche/' + week.next" class="atlas-pill">KW {{ weekNumberOf(week.next) }} →</router-link>
                    <span class="atlas-sep"></span>
                    <button type="button" class="atlas-pill is-strong" :disabled="!week || goals.length >= 5 || editingGoal !== null"
                            :title="goals.length >= 5 ? 'Höchstens fünf Wochenziele' : ''" @click="addGoal">
                        Ziel hinzufügen
                    </button>
                </div>
            </div>

            <atlas-capture @created="onCaptured" />

            <datalist :id="entityListId">
                <option v-for="e in entities" :key="e.id" :value="e.id">{{ e.title }}</option>
            </datalist>

            <section aria-label="Wochenziele" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                <div v-if="loading" class="atlas-skel" style="height:86px"></div>
                <p v-else-if="!goals.length && editingGoal === null" class="atlas-card atlas-empty md:col-span-2 xl:col-span-3">
                    Diese Woche hat noch kein Ziel.
                    <button type="button" class="atlas-link-btn" @click="addGoal">Ziel hinzufügen</button>
                    <template v-if="week && week.previous">
                        oder <button type="button" class="atlas-link-btn" :disabled="savingGoals" @click="adoptGoals">Ziele der Vorwoche übernehmen</button>.
                    </template>
                </p>
                <template v-else>
                    <div v-for="goal in goals" :key="goal.index" class="atlas-goal">
                        <template v-if="editingGoal === goal.index">
                            <div>
                                <label class="atlas-field-label" :for="entityListId + '-title'">Titel</label>
                                <input :id="entityListId + '-title'" class="atlas-field" v-model="goalDraft.title"
                                       @keydown.enter.prevent="saveGoal" @keydown.esc.prevent="cancelGoal" />
                            </div>
                            <div class="grid grid-cols-2 gap-2">
                                <div>
                                    <label class="atlas-field-label">Anker</label>
                                    <input class="atlas-field" :list="entityListId" v-model="goalDraft.anchor" placeholder="kapitel-03" />
                                </div>
                                <div>
                                    <label class="atlas-field-label">Tag</label>
                                    <input class="atlas-field" v-model="goalDraft.tag" placeholder="methodik" />
                                </div>
                            </div>
                            <div class="flex items-center gap-2">
                                <button type="button" class="atlas-pill is-strong" :disabled="savingGoals || !goalDraft.title.trim()" @click="saveGoal">Speichern</button>
                                <button type="button" class="atlas-pill" @click="cancelGoal">Abbrechen</button>
                                <button type="button" class="atlas-link-btn ml-auto" :disabled="savingGoals" @click="deleteGoal(goal.index)">Löschen</button>
                            </div>
                        </template>
                        <template v-else>
                            <div class="atlas-goal-head">
                                <label class="flex items-start gap-2 cursor-pointer">
                                    <input type="checkbox" class="atlas-check" style="margin-top:2px" :checked="goal.done"
                                           :aria-label="'Wochenziel erreicht: ' + goal.title" @change="toggleGoal(goal.index)" />
                                    <span class="atlas-goal-title">{{ goal.title }}</span>
                                </label>
                                <span class="atlas-goal-count" :class="{ 'is-done': goalReached(goal) }">{{ goalCount(goal) }}</span>
                            </div>
                            <div class="atlas-bar">
                                <div class="atlas-bar-fill" :class="{ 'is-done': goalReached(goal) }" :style="{ width: goalPercent(goal) }"></div>
                            </div>
                            <div class="flex items-baseline justify-between gap-2">
                                <span class="atlas-goal-meta" :class="{ 'is-warn': !!deadline(goal) }">{{ goalMeta(goal) }}</span>
                                <button type="button" class="atlas-link-btn" @click="editGoal(goal)">bearbeiten</button>
                            </div>
                        </template>
                    </div>
                    <div v-if="editingGoal === -1" class="atlas-goal">
                        <div>
                            <label class="atlas-field-label" :for="entityListId + '-new'">Neues Wochenziel</label>
                            <input :id="entityListId + '-new'" ref="newGoal" class="atlas-field" v-model="goalDraft.title"
                                   placeholder="Kapitel 3 an die Betreuerin schicken"
                                   @keydown.enter.prevent="saveGoal" @keydown.esc.prevent="cancelGoal" />
                        </div>
                        <div class="grid grid-cols-2 gap-2">
                            <div>
                                <label class="atlas-field-label">Anker</label>
                                <input class="atlas-field" :list="entityListId" v-model="goalDraft.anchor" placeholder="kapitel-03" />
                            </div>
                            <div>
                                <label class="atlas-field-label">Tag</label>
                                <input class="atlas-field" v-model="goalDraft.tag" placeholder="methodik" />
                            </div>
                        </div>
                        <div class="flex items-center gap-2">
                            <button type="button" class="atlas-pill is-strong" :disabled="savingGoals || !goalDraft.title.trim()" @click="saveGoal">Anlegen</button>
                            <button type="button" class="atlas-pill" @click="cancelGoal">Abbrechen</button>
                        </div>
                    </div>
                </template>
            </section>

            <section aria-label="Tage" class="atlas-week">
                <template v-if="loading">
                    <div v-for="n in 7" :key="n" class="atlas-skel" style="height:150px"></div>
                </template>
                <template v-else>
                <div v-for="day in days" :key="day.date" class="atlas-day"
                     :class="{ 'is-today': day.date === todayIso, 'is-empty': !day.total && day.date !== todayIso }">
                    <div class="atlas-day-head">
                        <span class="atlas-day-name">
                            {{ shortDay(day.date) }} {{ dayNumber(day.date) }}.<template v-if="day.date === todayIso"> · heute</template>
                        </span>
                        <span v-if="day.total" class="atlas-day-count" :class="{ 'is-open': day.open > 0 }">{{ day.done }}/{{ day.total }}</span>
                    </div>
                    <div v-if="day.tasks.length" class="atlas-day-tasks">
                        <div v-for="task in day.tasks" :key="task.body_index" class="atlas-day-task" :class="{ 'is-done': task.done }">
                            <input type="checkbox" class="atlas-check" :id="rowId(task)" :checked="task.done"
                                   :disabled="!!task.moved_to" @change="toggle(task)" />
                            <label :for="rowId(task)" class="atlas-day-label">
                                {{ task.text || '(leere Zeile)' }}
                                <span v-if="task.moved_to" style="color:var(--lb-accent)">→ {{ shortDay(task.moved_to) }}</span>
                                <span v-else-if="task.moved_from" style="color:var(--lb-ink-3)">(von {{ shortDay(task.moved_from) }})</span>
                            </label>
                            <select v-if="!task.moved_to" class="atlas-day-move" value=""
                                    :aria-label="'Task auf einen anderen Tag verschieben: ' + task.text"
                                    @change="move(task, $event)">
                                <option value="">⇢</option>
                                <option v-for="d in days" :key="d.date" :value="d.date" :disabled="d.date === day.date">
                                    {{ shortDay(d.date) }} {{ dayNumber(d.date) }}.
                                </option>
                            </select>
                            <button type="button" class="atlas-icon-btn is-danger atlas-day-del"
                                    :aria-label="'Task löschen: ' + task.text" title="Task löschen"
                                    :disabled="removing === rowId(task)" @click="remove(task)">✕</button>
                        </div>
                    </div>
                    <div class="atlas-day-foot">
                        <input v-if="adding === day.date" :id="addId(day)" class="atlas-field" v-model="addText"
                               :aria-label="'Neuer Task am ' + day.weekday" placeholder="Task …"
                               @keydown.enter.prevent="createTask(day)" @keydown.esc.prevent="stopAdd" @blur="stopAdd" />
                        <button v-else type="button" class="atlas-link-btn" @click="startAdd(day)">+ Task</button>
                    </div>
                </div>
                </template>
            </section>

            <section id="atlas-review" ref="review" aria-label="Rückblick" class="atlas-review" :class="{ 'is-focused': focusReview }">
                <div class="atlas-review-title">Rückblick bisher</div>
                <div class="atlas-review-stats">
                    <div><span class="atlas-review-num">{{ review.tasks.done }}</span> <span class="atlas-review-label">/ {{ review.tasks.total }} Tasks erledigt</span></div>
                    <div><span class="atlas-review-num">{{ review.zettel.length }}</span> <span class="atlas-review-label">Zettel geschrieben</span></div>
                    <div><span class="atlas-review-num">{{ review.goals.reached }}</span> <span class="atlas-review-label">/ {{ review.goals.total }} Wochenziele erreicht</span></div>
                    <div><span class="atlas-review-num">{{ review.chapters.length }}</span> <span class="atlas-review-label">Kapitel bearbeitet</span></div>
                    <div v-if="review.carried.length"><span class="atlas-review-num">{{ review.carried.length }}</span> <span class="atlas-review-label">mehrfach übertragen</span></div>
                </div>
                <div class="flex items-center gap-4 ml-auto">
                    <button v-if="!goals.length && week && week.previous" type="button" class="atlas-link-btn"
                            :disabled="savingGoals" @click="adoptGoals">Ziele der Vorwoche übernehmen</button>
                    <router-link v-if="week" :to="'/atlas/rueckblick/' + week.week" class="atlas-link-btn">ganzer Rückblick →</router-link>
                    <button type="button" class="atlas-link-btn" :disabled="reviewBusy || !week" @click="reviewZettel">
                        {{ reviewBusy ? 'Legt an…' : 'Wochenrückblick als Zettel anlegen' }}
                    </button>
                </div>
            </section>
        </div>
    `,
    data() {
        return {
            week: null,
            loading: true,
            adding: '',
            addText: '',
            removing: null,        // rowId des Tasks, der gerade gelöscht wird
            editingGoal: null,     // null = keiner, -1 = neues Ziel, sonst Index
            goalDraft: { title: '', anchor: '', tag: '', done: false },
            savingGoals: false,
            reviewBusy: false,
            publications: [],
            projects: [],
            entityListId: 'atlas-entities-' + Math.random().toString(36).slice(2, 8),
            _es: null,
            _timer: null,
        };
    },
    computed: {
        // Immer „Woche": der Rückblick hat seit Slice 7 eine eigene Seite, ein
        // `?review=1` springt hier nur an den Fuß und darf die Navigation nicht
        // auf einen Eintrag zeigen lassen, auf dem man gar nicht steht.
        navKey() { return 'woche'; },
        focusReview() { return this.$route.query.review === '1'; },
        days() { return (this.week && this.week.days) || []; },
        goals() { return (this.week && this.week.goals) || []; },
        entities() { return atlasWork.entities; },
        todayIso() { return atlasWork.today; },
        review() {
            const r = (this.week && this.week.review) || {};
            return {
                tasks: r.tasks || { total: 0, done: 0, open: 0, moved: 0 },
                zettel: r.zettel || [],
                goals: r.goals || { total: 0, reached: 0, items: [] },
                chapters: r.chapters || [],
                carried: r.carried || [],
            };
        },
        range() {
            if (this.days.length < 7) return '';
            const a = atlasDate(this.days[0].date);
            const b = atlasDate(this.days[6].date);
            if (!a || !b) return '';
            return a.getDate() + '. – ' + b.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
        },
    },
    methods: {
        shortDay(iso) { return atlasShortDay(iso); },
        dayNumber(iso) { const d = atlasDate(iso); return d ? d.getDate() : ''; },
        weekNumberOf(week) { const m = /W(\d{2})/.exec(week || ''); return m ? Number(m[1]) : ''; },
        rowId(task) { return 'atlas-w-' + task.week + '-' + task.body_index; },
        addId(day) { return 'atlas-add-' + day.date; },
        goalReached(goal) { return !!goal.done || (goal.total > 0 && goal.done_count === goal.total); },
        goalCount(goal) {
            if (goal.total) return goal.done_count + '/' + goal.total;
            return goal.done ? 'erledigt' : 'offen';
        },
        goalPercent(goal) { return Math.round((goal.progress || 0) * 100) + '%'; },
        // Story 28: fällt eine Frist der verankerten Veröffentlichung oder ein
        // Meilenstein des verankerten Projekts in diese Woche, steht sie am Ziel.
        deadline(goal) {
            if (!goal.anchor || this.days.length < 7) return '';
            const inWeek = new Set(this.days.map((d) => d.date));
            const pub = this.publications.find((p) => p.id === goal.anchor);
            if (pub && pub.due && inWeek.has(String(pub.due).slice(0, 10))) {
                return 'Frist ' + atlasShortDate(pub.due);
            }
            const proj = this.projects.find((p) => p.id === goal.anchor);
            if (proj) {
                const ms = (proj.milestones || []).find((m) => m.date && inWeek.has(String(m.date).slice(0, 10)));
                if (ms) return 'Meilenstein „' + ms.title + '" ' + atlasShortDate(ms.date);
            }
            return '';
        },
        goalMeta(goal) {
            const parts = [];
            if (goal.anchor) {
                const e = atlasEntity(goal.anchor);
                parts.push('Anker: ' + ((e && e.title) || goal.anchor));
            }
            if (goal.tag) parts.push('Tag: #' + goal.tag);
            if (goal.total) parts.push(goal.total + (goal.total === 1 ? ' Task' : ' Tasks') + ' diese Woche');
            const due = this.deadline(goal);
            if (due) parts.push(due);
            return parts.length ? parts.join(' · ') : 'Ohne Anker und Tag — Fortschritt ist das Häkchen.';
        },
        taskUrl(task) {
            return '/api/plugins/atlas/journal/' + encodeURIComponent(task.week)
                + '/tasks/' + encodeURIComponent(task.body_index);
        },
        weekUrl(suffix) {
            return '/api/plugins/atlas/journal/' + encodeURIComponent(this.week.week) + suffix;
        },
        async load(silent = false) {
            if (!silent) this.loading = true;
            let id = this.$route.params.week;
            if (!id) {
                if (!atlasWork.week) await atlasRefreshToday();
                id = atlasWork.week;
            }
            if (!id) { this.loading = false; return; }
            try {
                this.week = await api('/api/plugins/atlas/journal/' + encodeURIComponent(id));
            } catch (e) {
                // Ein stilles Nachladen darf niemals einen Dialog aufreißen:
                // es läuft im Hintergrund, während jemand tippt.
                if (!silent) alert(atlasErrorText(e));
            }
            this.loading = false;
        },
        scheduleReload() {
            if (this._timer) clearTimeout(this._timer);
            this._timer = setTimeout(() => { this._timer = null; this.load(true); }, 200);
        },
        // Die Frist-Hinweise (Story 28) brauchen Veröffentlichungen und Projekte;
        // beides ist eine kleine Liste und wird still geladen.
        async loadContext() {
            try {
                const [pubs, projs] = await Promise.all([
                    api('/api/plugins/atlas/publications'),
                    api('/api/plugins/atlas/projects'),
                ]);
                this.publications = pubs.publications || [];
                this.projects = projs.projects || [];
            } catch (e) { /* Hinweise sind Beiwerk, kein Grund für einen Fehler */ }
        },
        async toggle(task) {
            const before = task.done;
            task.done = !before;
            task.open = !task.done && !task.moved_to;
            try {
                await api(this.taskUrl(task) + '/toggle', { method: 'POST' });
                await this.load(true);
                atlasRefreshToday();
            } catch (e) {
                task.done = before;
                task.open = !before && !task.moved_to;
                alert(atlasErrorText(e));
            }
        },
        async move(task, event) {
            const to = event.target.value;
            event.target.value = '';
            if (!to) return;
            try {
                await api(this.taskUrl(task) + '/move', { method: 'POST', body: JSON.stringify({ to }) });
            } catch (e) {
                alert(atlasErrorText(e));
            }
            await this.load(true);
            atlasRefreshToday();
        },
        // Schnell löschen ohne Rückfrage, wie auf Heute: die Zeile ist eine
        // Zeile in der Wochendatei, kein Eintrag mit eigener Geschichte.
        async remove(task) {
            const key = this.rowId(task);
            if (this.removing) return;
            this.removing = key;
            try {
                await api(this.taskUrl(task), { method: 'DELETE' });
            } catch (e) {
                alert(atlasErrorText(e));
            }
            this.removing = null;
            await this.load(true);
            atlasRefreshToday();
        },
        startAdd(day) {
            this.adding = day.date;
            this.addText = '';
            this.$nextTick(() => {
                const el = document.getElementById(this.addId(day));
                if (el) el.focus();
            });
        },
        stopAdd() { this.adding = ''; this.addText = ''; },
        async createTask(day) {
            const text = this.addText.trim();
            if (!text) { this.stopAdd(); return; }
            this.addText = '';
            try {
                await api(this.weekUrl('/tasks'), {
                    method: 'POST',
                    body: JSON.stringify({ day: day.date, text }),
                });
            } catch (e) {
                alert(atlasErrorText(e));
            }
            await this.load(true);
            atlasRefreshToday();
            // Offen lassen: eine Woche plant man in mehreren Zeilen hintereinander.
            this.$nextTick(() => {
                const el = document.getElementById(this.addId(day));
                if (el) el.focus();
            });
        },
        addGoal() {
            if (!this.week || this.goals.length >= 5) return;
            this.editingGoal = -1;
            this.goalDraft = { title: '', anchor: '', tag: '', done: false };
            this.$nextTick(() => { if (this.$refs.newGoal) this.$refs.newGoal.focus(); });
        },
        editGoal(goal) {
            this.editingGoal = goal.index;
            this.goalDraft = {
                title: goal.title || '',
                anchor: goal.anchor || '',
                tag: goal.tag || '',
                done: !!goal.done,
            };
        },
        cancelGoal() { this.editingGoal = null; },
        goalList() {
            return this.goals.map((g) => ({
                title: g.title,
                anchor: g.anchor || null,
                tag: g.tag || null,
                done: !!g.done,
            }));
        },
        async putGoals(list) {
            if (!this.week) return;
            this.savingGoals = true;
            try {
                await api(this.weekUrl('/goals'), { method: 'PUT', body: JSON.stringify({ goals: list }) });
                this.editingGoal = null;
            } catch (e) {
                alert(atlasErrorText(e));
            }
            this.savingGoals = false;
            await this.load(true);
        },
        async saveGoal() {
            const draft = {
                title: this.goalDraft.title.trim(),
                anchor: this.goalDraft.anchor.trim() || null,
                tag: this.goalDraft.tag.trim().replace(/^#/, '') || null,
                done: !!this.goalDraft.done,
            };
            if (!draft.title || this.savingGoals) return;
            const list = this.goalList();
            if (this.editingGoal >= 0) list[this.editingGoal] = draft;
            else list.push(draft);
            await this.putGoals(list);
        },
        async deleteGoal(index) {
            const list = this.goalList().filter((_, i) => i !== index);
            await this.putGoals(list);
        },
        async toggleGoal(index) {
            if (!this.week) return;
            try {
                await api(this.weekUrl('/goals/' + index + '/toggle'), { method: 'POST' });
            } catch (e) {
                alert(atlasErrorText(e));
            }
            await this.load(true);
        },
        async adoptGoals() {
            if (this.savingGoals || !this.week) return;
            this.savingGoals = true;
            try {
                await api(this.weekUrl('/goals/adopt'), { method: 'POST' });
            } catch (e) {
                alert(atlasErrorText(e));
            }
            this.savingGoals = false;
            await this.load(true);
        },
        async reviewZettel() {
            if (this.reviewBusy || !this.week) return;
            this.reviewBusy = true;
            try {
                const created = await api(this.weekUrl('/review/zettel'), { method: 'POST' });
                await atlasLoadEntities(true);
                if (created && created.id) this.$router.push('/atlas/zettel/' + encodeURIComponent(created.id));
            } catch (e) {
                alert(atlasErrorText(e));
            }
            this.reviewBusy = false;
        },
        onCaptured() { this.load(true); },
        scrollToReview() {
            if (!this.focusReview) return;
            this.$nextTick(() => {
                const el = this.$refs.review;
                if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            });
        },
    },
    watch: {
        '$route.params.week'() { this.load(); },
        '$route.query.review'() { this.scrollToReview(); },
    },
    async mounted() {
        atlasLoadEntities();
        if (!atlasWork.today) atlasRefreshToday();
        this.loadContext();
        await this.load();
        this.scrollToReview();
        this._es = atlasConnectEvents((kind) => {
            if (!kind || kind === 'journal' || kind === 'zettel') this.scheduleReload();
        });
    },
    beforeUnmount() {
        if (this._es) { this._es.close(); this._es = null; }
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    },
};

const ATLAS_ZETTEL_TYPES = {
    reading: 'Lektüre',
    meeting: 'Besprechung',
    method: 'Methode',
    decision: 'Entscheidung',
    fleeting: 'Flüchtig',
    review: 'Rückblick',
};

const ATLAS_ZETTEL_TYPE_LIST = Object.keys(ATLAS_ZETTEL_TYPES)
    .map((key) => ({ key, label: ATLAS_ZETTEL_TYPES[key] }));

// Eine Liste kurzer Zeichenketten als Chips — refs (Cite Keys) und Tags eines
// Zettels. Enter oder Komma schließt einen Chip ab, Backspace im leeren Feld
// nimmt den letzten zurück; `blur` übernimmt, was noch im Feld steht, damit
// nichts verloren geht, nur weil niemand Enter gedrückt hat.
const AtlasChips = {
    props: {
        modelValue: { type: Array, default: () => [] },
        placeholder: { type: String, default: '' },
        mono: { type: Boolean, default: false },
        label: { type: String, default: '' },
    },
    emits: ['update:modelValue'],
    template: `
        <div class="atlas-chips" :class="{ 'is-mono': mono }" @click="focus">
            <span v-for="(v, i) in modelValue" :key="v + '#' + i" class="atlas-chip is-input">
                {{ v }}
                <button type="button" class="atlas-chip-x" :aria-label="'Entfernen: ' + v"
                        @click.stop="removeAt(i)">×</button>
            </span>
            <input ref="input" class="atlas-chips-input" :value="draft" :aria-label="label"
                   :placeholder="modelValue.length ? '' : placeholder" autocomplete="off"
                   @input="draft = $event.target.value" @keydown="onKey" @blur="commit" />
        </div>
    `,
    data() { return { draft: '' }; },
    methods: {
        focus() { if (this.$refs.input) this.$refs.input.focus(); },
        onKey(e) {
            if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); this.commit(); return; }
            if (e.key === 'Backspace' && !this.draft && this.modelValue.length) {
                e.preventDefault();
                this.removeAt(this.modelValue.length - 1);
            }
        },
        commit() {
            const value = this.draft.trim().replace(/^#/, '');
            this.draft = '';
            if (!value || this.modelValue.includes(value)) return;
            this.$emit('update:modelValue', [...this.modelValue, value]);
        },
        removeAt(i) {
            this.$emit('update:modelValue', this.modelValue.filter((_, k) => k !== i));
        },
    },
};

// ── Zettel (Story 35–48) ────────────────────────────────────────────────────
// Liste und Detail in einer Ansicht: die Liste bleibt links stehen, das Detail
// wechselt rechts — Blättern durch die Sammlung kostet dann keinen Wechsel der
// Seite und keinen Sprung im Layout. Ohne `:id` hält die rechte Spalte eine
// Einladung statt einer leeren Fläche.
const AtlasZettelPage = {
    components: {
        'atlas-nav': AtlasNav,
        'atlas-capture': AtlasCapture,
        'atlas-anchor-chip': AtlasAnchorChip,
        'atlas-backlinks': AtlasBacklinks,
        'atlas-chips': AtlasChips,
    },
    template: `
        <div class="p-6 atlas-page">
            <atlas-nav active="zettel" />

            <div class="atlas-head">
                <div>
                    <div class="atlas-kicker">Sammlung · Wissen</div>
                    <h1 class="atlas-title">Zettel</h1>
                </div>
                <div class="atlas-actions">
                    <span class="atlas-sec-note">Lektüre, Besprechung, Methode, Entscheidung, Flüchtiges, Rückblick</span>
                </div>
            </div>

            <atlas-capture initial-mode="zettel" @created="onCaptured" />

            <div class="atlas-split">
                <!-- ── Liste ───────────────────────────────────────────── -->
                <aside class="atlas-list-rail" aria-label="Zettel-Liste">
                    <label class="sr-only" :for="searchId">Zettel durchsuchen</label>
                    <input :id="searchId" type="search" class="atlas-field" :value="query"
                           placeholder="Suchen … Titel, Text, refs, Tags"
                           @input="onSearch($event.target.value)" @keydown.esc.prevent="onSearch('')" />

                    <div class="atlas-filters" role="group" aria-label="Nach Art filtern">
                        <button type="button" class="atlas-filter" :class="{ 'is-active': !type }"
                                :aria-pressed="!type ? 'true' : 'false'" @click="setType('')">
                            Alle <span class="atlas-filter-n">{{ searched.length }}</span>
                        </button>
                        <button v-for="t in typeList" :key="t.key" type="button" class="atlas-filter"
                                :class="{ 'is-active': type === t.key }" :disabled="!typeCount(t.key) && type !== t.key"
                                :aria-pressed="type === t.key ? 'true' : 'false'" @click="setType(t.key)">
                            {{ t.label }} <span class="atlas-filter-n">{{ typeCount(t.key) }}</span>
                        </button>
                    </div>

                    <div v-if="listLoading" class="flex flex-col gap-2">
                        <div v-for="n in 5" :key="n" class="atlas-skel" style="height:44px"></div>
                    </div>
                    <div v-else class="atlas-card">
                        <p v-if="!list.length" class="atlas-empty">
                            <template v-if="query || type">Kein Zettel passt zu dieser Suche.</template>
                            <template v-else>Noch kein Zettel. Das Erfassen-Feld oben legt im Modus „Zettel" einen an.</template>
                        </p>
                        <router-link v-for="(z, i) in list" :key="z.id" class="atlas-list-row atlas-enter"
                                     :class="{ 'is-active': z.id === id }" :style="{ '--lb-i': i }"
                                     :to="'/atlas/zettel/' + encodeURIComponent(z.id)">
                            <div class="atlas-list-top">
                                <span class="atlas-list-title">{{ z.title || z.id }}</span>
                                <span class="atlas-list-date">{{ shortDate(z.date) }}</span>
                            </div>
                            <div class="atlas-list-sub">{{ rowMeta(z) }}</div>
                        </router-link>
                    </div>
                    <p class="atlas-sec-note">
                        Jeder Zettel ist eine Datei in <code>zettel/</code> — extern geschrieben oder hier,
                        derselbe Weg.
                    </p>
                </aside>

                <!-- ── Detail ──────────────────────────────────────────── -->
                <main class="atlas-detail" aria-label="Zettel">
                    <div v-if="!id" class="atlas-card atlas-empty" style="min-height:220px; display:flex; align-items:center; justify-content:center; text-align:center;">
                        Wähle links einen Zettel — oder schreib oben eine Zeile und leg einen neuen an.
                    </div>

                    <div v-else-if="detailLoading" class="flex flex-col gap-3">
                        <div class="atlas-skel" style="height:40px"></div>
                        <div class="atlas-skel" style="height:52px"></div>
                        <div class="atlas-skel" style="height:220px"></div>
                    </div>

                    <div v-else-if="!zettel" class="atlas-card atlas-empty">
                        Diesen Zettel gibt es nicht (mehr).
                        <router-link to="/atlas/zettel" class="atlas-link-btn" style="text-decoration:none">Zur Liste</router-link>
                    </div>

                    <template v-else>
                        <div class="atlas-detail-head">
                            <div class="min-w-0 flex flex-col gap-2">
                                <div class="atlas-detail-meta">
                                    <select class="atlas-select" v-model="draft.type" aria-label="Art des Zettels">
                                        <option v-for="t in typeList" :key="t.key" :value="t.key">{{ t.label }}</option>
                                    </select>
                                    <input type="date" class="atlas-select" v-model="draft.date" aria-label="Datum" />
                                    <code class="atlas-path" :title="zettel.path || zettel.id">{{ fileName }}</code>
                                </div>
                                <label class="sr-only" :for="titleId">Titel</label>
                                <input :id="titleId" class="atlas-detail-title" v-model="draft.title"
                                       placeholder="Titel des Zettels" @keydown.enter.prevent="saveNow" />
                            </div>
                            <div class="atlas-actions">
                                <span class="atlas-save" :class="saveClass">{{ saveLabel }}</span>
                                <button type="button" class="atlas-pill" :disabled="saveState === 'saving' || !dirty" @click="saveNow">Speichern</button>
                                <button type="button" class="atlas-pill" :disabled="promoting || !!zettel.promoted_to"
                                        :title="zettel.promoted_to ? 'Ist schon eine Idee' : 'Aus diesem Zettel eine Idee machen'"
                                        @click="promote">
                                    {{ promoting ? 'Legt an…' : 'Zu Idee weiterentwickeln' }}
                                </button>
                                <button type="button" class="atlas-pill is-danger" :disabled="deleting" @click="remove">Löschen</button>
                            </div>
                        </div>

                        <div v-if="zettel.promoted_to" class="atlas-note">
                            Daraus ist eine Idee geworden:
                            <router-link :to="{ path: '/atlas/sammlung', query: { tab: 'ideen', idea: zettel.promoted_to } }">
                                {{ ideaTitle(zettel.promoted_to) }}
                            </router-link>
                            — der Zettel bleibt, wie er ist.
                        </div>
                        <p v-if="saveError" class="atlas-error">{{ saveError }}</p>

                        <div class="atlas-frontmatter">
                            <div>
                                <span class="atlas-field-label">verweist auf</span>
                                <div class="atlas-frontmatter-row">
                                    <atlas-anchor-chip v-for="a in anchors" :key="a" :id="a" />
                                    <span v-if="!anchors.length" class="atlas-sec-note">
                                        Noch kein <code>[[…]]</code> im Text.
                                    </span>
                                </div>
                            </div>
                            <div>
                                <span class="atlas-field-label">refs · Cite Keys</span>
                                <atlas-chips v-model="draft.refs" mono label="Cite Keys" placeholder="creswell2018" />
                            </div>
                            <div>
                                <span class="atlas-field-label">Tags</span>
                                <atlas-chips v-model="draft.tags" label="Tags" placeholder="methodik" />
                            </div>
                        </div>

                        <section class="atlas-sec">
                            <div class="atlas-sec-head">
                                <h2 class="atlas-sec-title">Text</h2>
                                <div class="atlas-modes" role="group" aria-label="Ansicht des Textes">
                                    <button type="button" class="atlas-mode" :class="{ 'is-active': view === 'write' }"
                                            :aria-pressed="view === 'write' ? 'true' : 'false'" @click="setView('write')">Schreiben</button>
                                    <button type="button" class="atlas-mode" :class="{ 'is-active': view === 'read' }"
                                            :aria-pressed="view === 'read' ? 'true' : 'false'" @click="setView('read')">Lesen</button>
                                </div>
                            </div>
                            <textarea v-if="view === 'write'" ref="body" class="atlas-body-edit" v-model="draft.body"
                                      aria-label="Text des Zettels" spellcheck="true"
                                      placeholder="Markdown. Verweise per [[kapitel-03]], Vereinbartes als Checkliste: - [ ] …"
                                      @focus="bodyFocused = true" @blur="bodyFocused = false"></textarea>
                            <div v-else class="atlas-card atlas-body-read">
                                <div v-if="renderedBody" class="font-serif text-[15.5px] text-ink-2 leading-relaxed" v-html="renderedBody"></div>
                                <p v-else class="atlas-empty" style="padding:0">
                                    Noch kein Text. Über „Schreiben" anfangen.
                                </p>
                            </div>
                        </section>

                        <section v-if="checklist.length" class="atlas-sec">
                            <div class="atlas-sec-head">
                                <h2 class="atlas-sec-title">Vereinbart → Tasks</h2>
                                <span class="atlas-sec-note">{{ derivable.length ? derivable.length + ' noch nicht im Journal' : 'alles abgeleitet' }}</span>
                            </div>
                            <div class="atlas-card">
                                <div v-for="item in checklist" :key="item.index" class="atlas-derive"
                                     :class="{ 'is-derived': isDerived(item.index) }">
                                    <input type="checkbox" class="atlas-check" :id="deriveId(item)"
                                           :checked="selected.includes(item.index)" :disabled="isDerived(item.index)"
                                           @change="toggleSelected(item.index)" />
                                    <label :for="deriveId(item)" class="atlas-derive-text">{{ item.text }}</label>
                                    <span class="atlas-task-note" :class="{ 'is-accent': isDerived(item.index) }">
                                        {{ isDerived(item.index) ? '→ im Journal' : 'noch nicht im Journal' }}
                                    </span>
                                </div>
                                <div class="atlas-derive-foot">
                                    <button type="button" class="atlas-pill is-strong"
                                            :disabled="deriving || !selected.length" @click="deriveTasks">
                                        {{ deriving ? 'Legt an…' : 'Als Tasks für heute anlegen' }}
                                    </button>
                                    <button type="button" class="atlas-link-btn" :disabled="!derivable.length" @click="selectAllDerivable">
                                        alle offenen wählen
                                    </button>
                                    <span v-if="deriveMessage" class="atlas-sec-note">{{ deriveMessage }}</span>
                                </div>
                            </div>
                        </section>

                        <atlas-backlinks :id="zettel.id" :key="'bl-' + zettel.id" />
                    </template>
                </main>
            </div>
        </div>
    `,
    data() {
        return {
            all: [],                 // Ergebnis der Volltextsuche (ohne Typfilter)
            listLoading: true,
            detailLoading: false,
            zettel: null,
            // Die ID, zu der der Entwurf gehört — nicht die der Route. Wer
            // weiterklickt, während ein PUT läuft, soll seine Änderung im
            // richtigen Zettel wiederfinden.
            loadedId: '',
            draft: { title: '', type: 'fleeting', date: '', refs: [], tags: [], body: '' },
            baseline: '',
            suppress: true,          // während des Ladens keine Autospeicherung
            saveState: 'saved',      // saved | dirty | saving | error
            saveError: '',
            view: 'read',
            bodyFocused: false,
            query: '',
            type: '',
            selected: [],
            deriving: false,
            deriveMessage: '',
            promoting: false,
            deleting: false,
            searchId: 'atlas-zq-' + Math.random().toString(36).slice(2, 8),
            titleId: 'atlas-zt-' + Math.random().toString(36).slice(2, 8),
            _es: null,
            _search: null,
            _save: null,
        };
    },
    computed: {
        id() { return this.$route.params.id || ''; },
        typeList() { return ATLAS_ZETTEL_TYPE_LIST; },
        // Die Volltextsuche läuft auf dem Server (`q`), der Typfilter im
        // Browser — so bleiben die Zahlen an den Chips zur Suche passend und
        // ein Typwechsel kostet keine Anfrage.
        searched() { return this.all; },
        list() {
            return this.type ? this.all.filter((z) => (z.type || 'fleeting') === this.type) : this.all;
        },
        renderedBody() { return renderAtlasMarkdown(this.draft.body || ''); },
        anchors() { return (this.zettel && this.zettel.links) || []; },
        checklist() { return atlasChecklistItems(this.draft.body); },
        derivedIndices() { return (this.zettel && this.zettel.derived_indices) || []; },
        derivable() { return this.checklist.filter((i) => !this.derivedIndices.includes(i.index)); },
        dirty() { return this.saveState === 'dirty' || this.saveState === 'error'; },
        saveLabel() {
            if (this.saveState === 'saving') return 'Speichert…';
            if (this.saveState === 'dirty') return 'Nicht gespeichert';
            if (this.saveState === 'error') return 'Fehler';
            return 'Gespeichert';
        },
        saveClass() {
            return {
                'is-busy': this.saveState === 'saving',
                'is-dirty': this.saveState === 'dirty',
                'is-error': this.saveState === 'error',
            };
        },
        fileName() {
            const path = (this.zettel && this.zettel.path) || '';
            const name = path ? path.split(/[\\/]/).pop() : (this.zettel ? this.zettel.id + '.md' : '');
            return 'zettel/' + name;
        },
    },
    methods: {
        shortDate(iso) { return atlasShortDate(iso); },
        typeLabel(type) { return ATLAS_ZETTEL_TYPES[type] || type || 'Flüchtig'; },
        typeCount(key) { return this.all.filter((z) => (z.type || 'fleeting') === key).length; },
        rowMeta(z) {
            const parts = [this.typeLabel(z.type)];
            const anchors = (z.links || []).map((a) => {
                const e = atlasEntity(a);
                return (e && e.title) || a;
            });
            if (anchors.length) parts.push(anchors.slice(0, 2).join(', ') + (anchors.length > 2 ? ' +' + (anchors.length - 2) : ''));
            if ((z.refs || []).length) parts.push(z.refs.length === 1 ? '1 Ref.' : z.refs.length + ' Refs.');
            if (z.promoted_to) parts.push('→ Idee');
            return parts.join(' · ');
        },
        ideaTitle(id) {
            const e = atlasEntity(id);
            return (e && e.title) || id;
        },
        deriveId(item) { return 'atlas-d-' + (this.id || 'x') + '-' + item.index; },
        isDerived(index) { return this.derivedIndices.includes(index); },
        toggleSelected(index) {
            this.selected = this.selected.includes(index)
                ? this.selected.filter((i) => i !== index)
                : [...this.selected, index];
        },
        selectAllDerivable() { this.selected = this.derivable.map((i) => i.index); },
        setView(view) {
            this.view = view;
            if (view === 'write') this.$nextTick(() => { if (this.$refs.body) this.$refs.body.focus(); });
        },
        onSearch(value) {
            this.query = value;
            if (this._search) clearTimeout(this._search);
            this._search = setTimeout(() => { this._search = null; this.loadList(true); }, 250);
        },
        setType(key) { this.type = key; },
        // Strg+S gilt auf der ganzen Zettel-Seite, nicht nur im Textfeld: wer
        // gerade den Titel oder ein Tag tippt, erwartet dasselbe — und in jedem
        // Fall soll der Browser nicht seinen „Seite speichern"-Dialog öffnen.
        onSaveShortcut(e) {
            if ((e.ctrlKey || e.metaKey) && !e.altKey && String(e.key).toLowerCase() === 's') {
                e.preventDefault();
                if (this.id) this.saveNow();
            }
        },

        // --- Laden -----------------------------------------------------------
        async loadList(silent = false) {
            if (!silent) this.listLoading = true;
            try {
                const url = '/api/plugins/atlas/zettel' + (this.query.trim() ? '?q=' + encodeURIComponent(this.query.trim()) : '');
                const data = await api(url);
                this.all = data.zettel || [];
            } catch (e) {
                this.all = [];
            }
            this.listLoading = false;
        },
        async loadDetail(silent = false) {
            if (!this.id) { this.zettel = null; this.loadedId = ''; this.detailLoading = false; return; }
            if (!silent) this.detailLoading = true;
            try {
                const data = await api('/api/plugins/atlas/zettel/' + encodeURIComponent(this.id));
                this.applyDetail(data, silent);
            } catch (e) {
                // Kein Zettel mehr — auch der Entwurf gehört dann niemandem
                // mehr, sonst schriebe der nächste Speichervorgang ins Leere.
                this.zettel = null;
                this.loadedId = '';
                this.saveState = 'saved';
            }
            this.detailLoading = false;
        },
        // Setzt den Entwurf aus der Serverantwort. `keepDraft` lässt die
        // Eingabefelder in Ruhe — nach dem Speichern ändern sich nur die
        // abgeleiteten Felder (Verweise, abgeleitete Punkte, Pfad).
        applyDetail(data, keepDraft = false) {
            this.zettel = data;
            if (keepDraft && this.dirty) return;
            this.suppress = true;
            this.loadedId = data.id || this.id;
            this.draft = {
                title: data.title || '',
                type: data.type || 'fleeting',
                date: data.date || '',
                refs: [...(data.refs || [])],
                tags: [...(data.tags || [])],
                body: data.body || '',
            };
            this.baseline = JSON.stringify(this.draft);
            this.saveState = 'saved';
            this.saveError = '';
            // Nur beim Öffnen eines Zettels: Ansicht, Auswahl und Meldung
            // gehören dem Menschen, der gerade arbeitet. Ein stilles Nachladen
            // (eigener Speichervorgang, externer Edit) darf ihn nicht aus
            // „Schreiben" in „Lesen" werfen oder seine Auswahl abräumen.
            if (!keepDraft) {
                this.selected = [];
                this.deriveMessage = '';
                this.view = (data.body || '').trim() ? 'read' : 'write';
            }
            this.$nextTick(() => { this.suppress = false; });
        },

        // --- Speichern -------------------------------------------------------
        scheduleSave() {
            if (this._save) clearTimeout(this._save);
            this._save = setTimeout(() => { this._save = null; this.save(); }, 900);
        },
        saveNow() {
            if (this._save) { clearTimeout(this._save); this._save = null; }
            this.save();
        },
        async save() {
            const id = this.loadedId;
            if (!id) return;
            // Tippen während eines laufenden PUT: neu anstoßen statt verwerfen.
            if (this.saveState === 'saving') { this.scheduleSave(); return; }
            const signature = JSON.stringify(this.draft);
            if (signature === this.baseline) { this.saveState = 'saved'; return; }
            if (!this.draft.title.trim()) {
                this.saveState = 'error';
                this.saveError = atlasErrorText(new Error('error.atlas.title_required'));
                return;
            }
            const payload = {
                title: this.draft.title.trim(),
                type: this.draft.type,
                date: this.draft.date || null,
                refs: [...this.draft.refs],
                tags: [...this.draft.tags],
                body: this.draft.body,
            };
            this.saveState = 'saving';
            this.saveError = '';
            try {
                const saved = await api('/api/plugins/atlas/zettel/' + encodeURIComponent(id), {
                    method: 'PUT', body: JSON.stringify(payload),
                });
                atlasLoadEntities(true);
                this.loadList(true);
                // Inzwischen zeigt die Ansicht einen anderen Zettel — der
                // Schreibvorgang ist trotzdem angekommen, nur der Zustand hier
                // gehört jetzt jemand anderem.
                if (this.loadedId !== id) return;
                this.baseline = signature;
                this.zettel = { ...this.zettel, ...saved };
                this.saveState = JSON.stringify(this.draft) === signature ? 'saved' : 'dirty';
                this.refreshDerived();
            } catch (e) {
                if (this.loadedId !== id) return;
                this.saveState = 'error';
                this.saveError = atlasErrorText(e);
            }
        },
        // Nach dem Schreiben hat sich verschoben, was der Server ableitet:
        // Verweise und bereits abgeleitete Checklisten-Punkte.
        async refreshDerived() {
            const id = this.loadedId;
            if (!id) return;
            try {
                const data = await api('/api/plugins/atlas/zettel/' + encodeURIComponent(id));
                if (this.loadedId !== id) return;
                this.zettel = { ...this.zettel, links: data.links, anchors: data.anchors,
                    derived_indices: data.derived_indices, path: data.path, promoted_to: data.promoted_to };
            } catch (e) { /* die Anzeige bleibt beim letzten Stand */ }
        },

        // --- Aktionen --------------------------------------------------------
        async deriveTasks() {
            if (this.deriving || !this.selected.length) return;
            this.deriving = true;
            this.deriveMessage = '';
            try {
                const res = await api('/api/plugins/atlas/zettel/' + encodeURIComponent(this.id) + '/derive-tasks', {
                    method: 'POST',
                    body: JSON.stringify({ indices: [...this.selected].sort((a, b) => a - b) }),
                });
                const made = (res.created || []).length;
                const dup = (res.already || []).length;
                this.deriveMessage = made
                    ? made + (made === 1 ? ' Task' : ' Tasks') + ' für heute angelegt'
                        + (dup ? ', ' + dup + ' gab es schon.' : '.')
                    : 'Nichts angelegt — alles davon steht schon im Journal.';
                this.selected = [];
                await this.refreshDerived();
                atlasRefreshToday();
            } catch (e) {
                this.deriveMessage = atlasErrorText(e);
            }
            this.deriving = false;
        },
        async promote() {
            if (this.promoting || !this.zettel || this.zettel.promoted_to) return;
            this.promoting = true;
            try {
                const res = await api('/api/plugins/atlas/zettel/' + encodeURIComponent(this.id) + '/promote', { method: 'POST' });
                if (res && res.zettel) this.zettel = { ...this.zettel, ...res.zettel };
                await atlasLoadEntities(true);
                this.loadList(true);
            } catch (e) {
                alert(atlasErrorText(e));
            }
            this.promoting = false;
        },
        async remove() {
            if (this.deleting || !this.zettel) return;
            if (!confirm('Diesen Zettel wirklich löschen? Rückverweise darauf bleiben als Warnung stehen.')) return;
            this.deleting = true;
            try {
                if (this._save) { clearTimeout(this._save); this._save = null; }
                await api('/api/plugins/atlas/zettel/' + encodeURIComponent(this.id), { method: 'DELETE' });
                await atlasLoadEntities(true);
                this.zettel = null;
                this.loadedId = '';
                this.saveState = 'saved';
                this.$router.push('/atlas/zettel');
                this.loadList(true);
            } catch (e) {
                alert(atlasErrorText(e));
            }
            this.deleting = false;
        },
        onCaptured(e) {
            atlasLoadEntities(true);
            this.loadList(true);
            const created = e && e.data;
            if (e && e.mode === 'zettel' && created && created.id) {
                this.$router.push('/atlas/zettel/' + encodeURIComponent(created.id));
            }
        },
    },
    watch: {
        '$route.params.id'() {
            // Offene Änderung erst wegschreiben, dann den nächsten Zettel laden.
            if (this._save) { clearTimeout(this._save); this._save = null; this.save(); }
            this.loadDetail();
        },
        draft: {
            deep: true,
            handler() {
                if (this.suppress || !this.id) return;
                const clean = JSON.stringify(this.draft) === this.baseline;
                this.saveState = clean ? 'saved' : 'dirty';
                if (!clean) this.scheduleSave();
            },
        },
    },
    mounted() {
        atlasLoadEntities();
        this.loadList();
        this.loadDetail();
        window.addEventListener('keydown', this.onSaveShortcut);
        this._es = atlasConnectEvents((kind) => {
            if (kind && kind !== 'zettel' && kind !== 'journal') return;
            this.loadList(true);
            // Ein externer Edit darf nie eine laufende Eingabe überschreiben.
            if (this.saveState === 'saved' && !this.bodyFocused) this.loadDetail(true);
        });
    },
    beforeUnmount() {
        window.removeEventListener('keydown', this.onSaveShortcut);
        if (this._es) { this._es.close(); this._es = null; }
        if (this._search) { clearTimeout(this._search); this._search = null; }
        if (this._save) { clearTimeout(this._save); this._save = null; this.save(); }
    },
};

// ── Rückblick (Story 31–34) ─────────────────────────────────────────────────
// Der Rückblick ist rein abgeleitet: er zählt, was in den Dateien steht, und
// schreibt selbst nichts — bis auf den einen Knopf, der ihn als Zettel vom Typ
// Rückblick festhält. Die Wochenleiste oben vergleicht die letzten Wochen.
const AtlasReviewPage = {
    components: { 'atlas-nav': AtlasNav, 'atlas-capture': AtlasCapture },
    template: `
        <div class="p-6 atlas-page">
            <atlas-nav active="rueckblick" />

            <div class="atlas-head">
                <div>
                    <div class="atlas-kicker">{{ range || 'Rückblick' }}</div>
                    <h1 class="atlas-title">Rückblick KW {{ week ? week.number : '' }}</h1>
                </div>
                <div class="atlas-actions">
                    <router-link v-if="week" :to="'/atlas/rueckblick/' + week.previous" class="atlas-pill">← KW {{ weekNumberOf(week.previous) }}</router-link>
                    <router-link v-if="week" :to="'/atlas/rueckblick/' + week.next" class="atlas-pill">KW {{ weekNumberOf(week.next) }} →</router-link>
                    <span class="atlas-sep"></span>
                    <router-link v-if="week" :to="'/atlas/woche/' + week.week" class="atlas-pill">Zur Woche</router-link>
                    <button type="button" class="atlas-pill is-strong" :disabled="busy || !week" @click="keepAsZettel">
                        {{ busy ? 'Legt an…' : 'Als Zettel festhalten' }}
                    </button>
                </div>
            </div>

            <atlas-capture @created="onCaptured" />

            <!-- Wochenleiste: erledigt/gesamt je Woche, zum Vergleichen -->
            <section class="atlas-weekstrip" aria-label="Wochen vergleichen">
                <template v-if="!strip.length">
                    <div v-for="n in 6" :key="n" class="atlas-skel" style="height:56px; flex:1 1 96px; min-width:96px"></div>
                </template>
                <router-link v-for="w in strip" :key="w.week" class="atlas-weekstrip-item"
                             :class="{ 'is-active': week && w.week === week.week }"
                             :to="'/atlas/rueckblick/' + w.week">
                    <span class="atlas-weekstrip-kw">KW {{ weekNumberOf(w.week) }}</span>
                    <span class="atlas-bar"><span class="atlas-bar-fill" :style="{ width: w.percent }"></span></span>
                    <span class="atlas-weekstrip-n">{{ w.done }}/{{ w.total }}</span>
                </router-link>
            </section>

            <div v-if="loading" class="flex flex-col gap-4">
                <div class="atlas-skel" style="height:92px"></div>
                <div class="atlas-skel" style="height:220px"></div>
            </div>

            <template v-else>
                <section class="atlas-metrics" aria-label="Kennzahlen der Woche">
                    <div class="atlas-metric">
                        <div class="atlas-metric-n">{{ review.tasks.done }}<span class="atlas-metric-of">/{{ review.tasks.total }}</span></div>
                        <div class="atlas-metric-l">Tasks erledigt</div>
                    </div>
                    <div class="atlas-metric">
                        <div class="atlas-metric-n" :class="{ 'is-warn': review.tasks.open }">{{ review.tasks.open }}</div>
                        <div class="atlas-metric-l">offen geblieben</div>
                    </div>
                    <div class="atlas-metric">
                        <div class="atlas-metric-n">{{ review.tasks.moved }}</div>
                        <div class="atlas-metric-l">übertragen</div>
                    </div>
                    <div class="atlas-metric">
                        <div class="atlas-metric-n">{{ review.goals.reached }}<span class="atlas-metric-of">/{{ review.goals.total }}</span></div>
                        <div class="atlas-metric-l">Wochenziele erreicht</div>
                    </div>
                    <div class="atlas-metric">
                        <div class="atlas-metric-n">{{ review.zettel.length }}</div>
                        <div class="atlas-metric-l">Zettel geschrieben</div>
                    </div>
                    <div class="atlas-metric">
                        <div class="atlas-metric-n">{{ review.chapters.length }}</div>
                        <div class="atlas-metric-l">Kapitel bearbeitet</div>
                    </div>
                </section>

                <p v-if="empty" class="atlas-card atlas-empty">
                    In dieser Woche steht nichts im Journal. Der Rückblick zählt nur, was in den Dateien steht —
                    er erfindet nichts.
                </p>

                <div v-else class="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
                    <div class="flex flex-col gap-5 min-w-0">
                        <section class="atlas-sec">
                            <div class="atlas-sec-head">
                                <h2 class="atlas-sec-title">Wochenziele</h2>
                                <router-link v-if="week" :to="'/atlas/woche/' + week.week" class="atlas-link-btn" style="text-decoration:none">bearbeiten</router-link>
                            </div>
                            <div class="atlas-card">
                                <p v-if="!review.goals.items.length" class="atlas-empty">Diese Woche hatte kein Ziel.</p>
                                <div v-for="g in review.goals.items" :key="g.index" class="atlas-goal-row"
                                     :class="{ 'is-reached': g.reached }">
                                    <span class="atlas-goal-mark">{{ g.reached ? '✓' : '○' }}</span>
                                    <span class="atlas-goal-row-title">{{ g.title }}</span>
                                    <span class="atlas-goal-count" :class="{ 'is-done': g.reached }">
                                        {{ g.total ? g.done_count + '/' + g.total : (g.done ? 'erledigt' : 'offen') }}
                                    </span>
                                </div>
                            </div>
                        </section>

                        <section class="atlas-sec">
                            <div class="atlas-sec-head">
                                <h2 class="atlas-sec-title">Mehrfach übertragen</h2>
                                <span class="atlas-sec-note">was liegen bleibt</span>
                            </div>
                            <div class="atlas-card">
                                <p v-if="!review.carried.length" class="atlas-empty">
                                    Nichts wurde mehr als einmal verschoben. Gute Woche.
                                </p>
                                <div v-for="c in review.carried" :key="c.text" class="atlas-carried">
                                    <span class="atlas-carried-n" :title="c.moves + '× übertragen'">{{ c.moves }}×</span>
                                    <span class="atlas-carried-text" :class="{ 'is-done': c.done }">{{ c.text }}</span>
                                    <span class="atlas-task-note">{{ carriedDays(c) }}</span>
                                </div>
                            </div>
                        </section>
                    </div>

                    <div class="flex flex-col gap-5 min-w-0">
                        <section class="atlas-sec">
                            <div class="atlas-sec-head">
                                <h2 class="atlas-sec-title">Zettel dieser Woche</h2>
                                <router-link to="/atlas/zettel" class="atlas-link-btn" style="text-decoration:none">alle</router-link>
                            </div>
                            <div class="atlas-card">
                                <p v-if="!review.zettel.length" class="atlas-empty">Kein Zettel mit einem Datum in dieser Woche.</p>
                                <router-link v-for="z in review.zettel" :key="z.id" class="atlas-list-row"
                                             :to="'/atlas/zettel/' + encodeURIComponent(z.id)">
                                    <div class="atlas-list-top">
                                        <span class="atlas-list-title">{{ z.title || z.id }}</span>
                                        <span class="atlas-list-date">{{ shortDate(z.date) }}</span>
                                    </div>
                                    <div class="atlas-list-sub">{{ typeLabel(z.type) }}</div>
                                </router-link>
                            </div>
                        </section>

                        <section class="atlas-sec">
                            <h2 class="atlas-sec-title">Bearbeitete Kapitel</h2>
                            <div class="atlas-card">
                                <p v-if="!review.chapters.length" class="atlas-empty">In dieser Woche wurde kein Kapitel angefasst.</p>
                                <router-link v-for="c in review.chapters" :key="c.id" class="atlas-list-row"
                                             :to="{ path: '/atlas/sammlung', query: { tab: 'dissertation', chapter: c.id } }">
                                    <div class="atlas-list-top">
                                        <span class="atlas-list-title">{{ c.title || c.id }}</span>
                                        <span class="atlas-list-date">{{ shortDate(c.modified_at) }}</span>
                                    </div>
                                </router-link>
                            </div>
                        </section>
                    </div>
                </div>
            </template>
        </div>
    `,
    data() {
        return { week: null, loading: true, busy: false, strip: [], _stripFor: '', _es: null, _timer: null };
    },
    computed: {
        review() {
            const r = (this.week && this.week.review) || {};
            return {
                tasks: r.tasks || { total: 0, done: 0, open: 0, moved: 0 },
                zettel: r.zettel || [],
                goals: r.goals || { total: 0, reached: 0, items: [] },
                chapters: r.chapters || [],
                carried: r.carried || [],
            };
        },
        empty() {
            return !this.review.tasks.total && !this.review.zettel.length
                && !this.review.goals.total && !this.review.chapters.length;
        },
        range() {
            const days = (this.week && this.week.days) || [];
            if (days.length < 7) return '';
            const a = atlasDate(days[0].date);
            const b = atlasDate(days[6].date);
            if (!a || !b) return '';
            return a.getDate() + '. – ' + b.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
        },
    },
    methods: {
        shortDate(iso) { return atlasShortDate(iso); },
        typeLabel(type) { return ATLAS_ZETTEL_TYPES[type] || type || 'Flüchtig'; },
        weekNumberOf(week) { return atlasWeekNumber(week); },
        carriedDays(c) {
            const days = c.days || [];
            if (!days.length) return '';
            return atlasShortDate(days[0]) + ' → ' + atlasShortDate(days[days.length - 1]);
        },
        async load(silent = false) {
            if (!silent) this.loading = true;
            let id = this.$route.params.week;
            if (!id) {
                if (!atlasWork.week) await atlasRefreshToday();
                id = atlasWork.week;
            }
            if (!id) { this.loading = false; return; }
            try {
                this.week = await api('/api/plugins/atlas/journal/' + encodeURIComponent(id));
            } catch (e) {
                if (!silent) alert(atlasErrorText(e));
            }
            this.loading = false;
            this.loadStrip();
        },
        // Die sechs Wochen bis einschließlich dieser. Die IDs rechnet die SPA
        // selbst aus (dieselbe ISO-Regel wie der Server), die Zahlen holt sie
        // parallel — sechs kleine Anfragen, keine Kette.
        async loadStrip() {
            const days = (this.week && this.week.days) || [];
            if (!days.length) { this.strip = []; return; }
            const anchor = atlasDate(days[0].date);
            if (!anchor) { this.strip = []; return; }
            // Ein Ereignis in derselben Woche ändert nur die eigene Säule —
            // dafür sechs Wochen neu zu holen wäre Verschwendung.
            if (this._stripFor === this.week.week && this.strip.length) {
                this.strip = this.strip.map((w) =>
                    (w.week === this.week.week ? this.stripRow(w.week, this.week) : w));
                return;
            }
            this._stripFor = this.week.week;
            const ids = [];
            for (let k = 5; k >= 0; k--) {
                const d = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - 7 * k);
                ids.push(atlasWeekIdOf(d));
            }
            const rows = await Promise.all(ids.map(async (id) => {
                if (this.week && id === this.week.week) return this.stripRow(id, this.week);
                try {
                    return this.stripRow(id, await api('/api/plugins/atlas/journal/' + encodeURIComponent(id)));
                } catch (e) {
                    return { week: id, done: 0, total: 0, percent: '0%' };
                }
            }));
            this.strip = rows;
        },
        stripRow(id, payload) {
            const t = (payload && payload.review && payload.review.tasks) || { done: 0, total: 0 };
            return {
                week: id,
                done: t.done || 0,
                total: t.total || 0,
                percent: t.total ? Math.round((t.done / t.total) * 100) + '%' : '0%',
            };
        },
        scheduleReload() {
            if (this._timer) clearTimeout(this._timer);
            this._timer = setTimeout(() => { this._timer = null; this.load(true); }, 200);
        },
        async keepAsZettel() {
            if (this.busy || !this.week) return;
            this.busy = true;
            try {
                const created = await api('/api/plugins/atlas/journal/' + encodeURIComponent(this.week.week) + '/review/zettel',
                    { method: 'POST' });
                await atlasLoadEntities(true);
                if (created && created.id) this.$router.push('/atlas/zettel/' + encodeURIComponent(created.id));
            } catch (e) {
                alert(atlasErrorText(e));
            }
            this.busy = false;
        },
        onCaptured() { this.load(true); },
    },
    watch: { '$route.params.week'() { this.load(); } },
    mounted() {
        atlasLoadEntities();
        if (!atlasWork.week) atlasRefreshToday();
        this.load();
        this._es = atlasConnectEvents((kind) => {
            if (!kind || kind === 'journal' || kind === 'zettel') this.scheduleReload();
        });
    },
    beforeUnmount() {
        if (this._es) { this._es.close(); this._es = null; }
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    },
};

// =============================================================================
// Atlas: die Einbauten in den Kern — Slot-Komponenten (#192, Add-on Contract 2)
// -----------------------------------------------------------------------------
// Frueher standen sie als markierte Zeilen in PaperList, PaperDetail,
// ResearchChatPage und SettingsPage. Heute rendert der Kern sie nur, solange
// Atlas aktiv ist — daher kein 404-Tasten mehr, ob es Atlas gibt.
// =============================================================================

// Item-Liste: Projekt-Filter (ADR-0004). Filtert ueber die refs (Cite Keys)
// des gewaehlten Forschungsprojekts; der Kern schickt sie als `cite_keys`.
// Ein Projekt ohne refs liefert bewusst keine Eintraege.
const AtlasItemListFilter = {
    props: ['selection'],
    emits: ['update:selection'],
    data() {
        return { projects: [] };
    },
    computed: {
        current() { return this.selection ? this.selection.value : ''; },
    },
    async mounted() {
        try {
            const data = await api('/api/plugins/atlas/projects');
            this.projects = data.projects || [];
        } catch (e) {
            this.projects = [];
        }
    },
    methods: {
        choose(ev) {
            const id = ev.target.value;
            const proj = this.projects.find((p) => p.id === id);
            this.$emit('update:selection', proj
                ? { value: proj.id, label: proj.title, citeKeys: (proj.refs || []).map(String) }
                : null);
        },
    },
    template: `
        <label class="lb-field atlas-list-filter">
            <span class="lb-field-label">Projekt (Atlas)</span>
            <select class="lb-input" :value="current" @change="choose">
                <option value="">Alle Projekte</option>
                <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.title }}</option>
            </select>
        </label>
    `,
};

// Item-Detail, Metadatenspalte: Verknuepfungen (Ideen, Zettel,
// Veroeffentlichungen, Projekte ueber refs) und die beiden LLM-Aktionen —
// F2 Ideen-Match (Vorschlag; geschrieben wird erst bei "Uebernehmen", P4) und
// F3 Kapitel-Match (nur Vorschlag). Der Kern mountet die Komponente je Item
// neu (Schluessel = Item-id).
const AtlasItemDetailAside = {
    props: ['itemId', 'citeKey'],
    data() {
        return {
            ready: false,
            citekey: '',
            links: [],
            pubLinks: [],
            projLinks: [],
            zettelLinks: [],
            matching: false,
            matches: null,
            matchError: '',
            chapterMatching: false,
            chapterMatchResults: null,
            chapterMatchError: '',
        };
    },
    mounted() { this.loadLinks(); },
    methods: {
        async loadLinks() {
            // Der BibTeX-Schluessel ist der, den Atlas in refs erwartet (auch
            // der erzeugte, wenn das Item keinen gespeicherten Cite Key hat).
            try {
                let key = this.citeKey;
                try {
                    const bib = await api(`/api/papers/${this.itemId}/bibtex`);
                    if (bib && bib.key) key = bib.key;
                } catch (e) { /* gespeicherter Cite Key genuegt */ }
                if (!key) { this.ready = true; return; }
                const res = await api(`/api/plugins/atlas/links/${encodeURIComponent(key)}`);
                this.links = res.ideas || [];
                this.pubLinks = res.publications || [];
                this.projLinks = res.projects || [];
                this.zettelLinks = res.zettel || [];
                this.citekey = key;
            } catch (e) {
                this.links = [];
            }
            this.ready = true;
        },
        // Die Sammlung liegt unter /atlas/sammlung (/atlas ist die Heute-Ansicht).
        openIdea(id) {
            this.$router.push({ path: '/atlas/sammlung', query: { tab: 'ideen', idea: id } });
        },
        openPublication(id) {
            this.$router.push({ path: '/atlas/sammlung', query: { tab: 'veroeffentlichungen', pub: id } });
        },
        openProject(id) {
            this.$router.push({ path: '/atlas/sammlung', query: { tab: 'projekte', proj: id } });
        },
        openZettel(id) {
            this.$router.push('/atlas/zettel/' + encodeURIComponent(id));
        },
        zettelTypeLabel(v) { return ATLAS_ZETTEL_TYPES[v] || v || 'Flüchtig'; },
        ideaTypeLabel(v) { return (ATLAS_TYPES.find((x) => x.key === v) || {}).label || v; },
        pubStatusLabel(s) { return (PUBLICATION_STATUSES.find((x) => x.key === s) || {}).label || s; },
        projStatusLabel(s) { return (PROJECT_STATUSES.find((x) => x.key === s) || {}).label || s; },
        verdictLabel(v) { return atlasVerdictLabel(v); },
        verdictClass(v) { return atlasVerdictClass(v); },
        async findMatches() {
            if (!this.citekey || this.matching) return;
            this.matching = true;
            this.matchError = '';
            this.matches = null;
            try {
                const res = await api('/api/plugins/atlas/match/paper', {
                    method: 'POST',
                    body: JSON.stringify({ citekey: this.citekey }),
                });
                this.matches = res.results || [];
            } catch (e) {
                this.matchError = e.message;
            }
            this.matching = false;
        },
        async acceptMatch(m) {
            try {
                await api(`/api/plugins/atlas/ideas/${encodeURIComponent(m.idea)}/accept-match`, {
                    method: 'POST',
                    body: JSON.stringify({
                        citekey: m.citekey,
                        reasoning: m.reasoning,
                        usages: (m.usages || []).map((u) => ({ anchor: u.anchor, suggestion: u.suggestion })),
                    }),
                });
                m.accepted = true;
                this.loadLinks();  // die Idee referenziert dieses Item jetzt
            } catch (e) {
                alert('Uebernehmen fehlgeschlagen: ' + e.message);
            }
        },
        async findChapterMatch() {
            if (!this.citekey || this.chapterMatching) return;
            this.chapterMatching = true;
            this.chapterMatchError = '';
            this.chapterMatchResults = null;
            try {
                const res = await api('/api/plugins/atlas/diss/match', {
                    method: 'POST',
                    body: JSON.stringify({ citekey: this.citekey }),
                });
                this.chapterMatchResults = res.results || [];
            } catch (e) {
                this.chapterMatchError = e.message;
            }
            this.chapterMatching = false;
        },
    },
    template: `
        <div v-if="ready" class="atlas-aside">
            <h5 class="lb-aside-h">Verknuepfte Ideen</h5>
            <div v-if="links.length" class="space-y-1.5">
                <button v-for="idea in links" :key="idea.id" @click="openIdea(idea.id)"
                        class="atlas-aside-link w-full text-left p-2 rounded-lg">
                    <span class="block text-sm font-medium" style="color: var(--lb-ink);">{{ idea.title }}</span>
                    <span class="block text-xs mt-0.5" style="color: var(--lb-mute);">{{ ideaTypeLabel(idea.type) }} &middot; {{ idea.status }}</span>
                </button>
            </div>
            <p v-else class="text-xs italic" style="color: var(--lb-mute);">
                Keine verknuepften Ideen
                <span v-if="citekey" class="lb-mono" style="font-style: normal;"> ({{ citekey }})</span>
            </p>

            <!-- Zettel mit diesem Cite Key in refs (#180, Story 38) -->
            <template v-if="zettelLinks.length">
                <h5 class="lb-aside-h mt-3">Zettel zu diesem Paper</h5>
                <div class="space-y-1.5">
                    <button v-for="z in zettelLinks" :key="z.id" @click="openZettel(z.id)"
                            class="atlas-aside-link w-full text-left p-2 rounded-lg">
                        <span class="block text-sm font-medium" style="color: var(--lb-ink);">{{ z.title }}</span>
                        <span class="block text-xs mt-0.5" style="color: var(--lb-mute);">{{ zettelTypeLabel(z.type) }}<template v-if="z.date"> &middot; {{ z.date }}</template></span>
                    </button>
                </div>
            </template>

            <!-- Veroeffentlichungen, die diesen Cite Key referenzieren (refs oder paper-Selbstlink) -->
            <template v-if="pubLinks.length">
                <h5 class="lb-aside-h mt-3">Verwendet in Veroeffentlichungen</h5>
                <div class="space-y-1.5">
                    <button v-for="pub in pubLinks" :key="pub.id" @click="openPublication(pub.id)"
                            class="atlas-aside-link w-full text-left p-2 rounded-lg">
                        <span class="block text-sm font-medium" style="color: var(--lb-ink);">{{ pub.title }}</span>
                        <span class="block text-xs mt-0.5" style="color: var(--lb-mute);">{{ pubStatusLabel(pub.status) }}<template v-if="pub.venue"> &middot; {{ pub.venue }}</template></span>
                    </button>
                </div>
            </template>

            <!-- Forschungsprojekte, deren refs diesen Cite Key enthalten (atlas.project/3) -->
            <template v-if="projLinks.length">
                <h5 class="lb-aside-h mt-3">Verwendet in Projekten</h5>
                <div class="space-y-1.5">
                    <button v-for="proj in projLinks" :key="proj.id" @click="openProject(proj.id)"
                            class="atlas-aside-link w-full text-left p-2 rounded-lg">
                        <span class="block text-sm font-medium" style="color: var(--lb-ink);">{{ proj.title }}</span>
                        <span class="block text-xs mt-0.5" style="color: var(--lb-mute);">{{ projStatusLabel(proj.status) }}<template v-if="proj.funder"> &middot; {{ proj.funder }}</template></span>
                    </button>
                </div>
            </template>

            <!-- F2: Rueckwaertssuche — Vorschlaege, geschrieben wird erst bei "Uebernehmen" (P4) -->
            <button v-if="citekey" @click="findMatches" :disabled="matching"
                    class="atlas-aside-action mt-2 w-full text-xs font-medium border rounded-lg px-2 py-1.5 transition-colors">
                {{ matching ? 'Sucht passende Ideen…' : '✨ Passende Ideen finden (LLM)' }}
            </button>
            <p v-if="matchError" class="text-xs mt-1.5" style="color:var(--lb-danger);">{{ matchError }}</p>
            <div v-if="matches" class="mt-2 space-y-1.5">
                <div v-for="m in matches" :key="m.idea" class="p-2 rounded-lg" style="border:1px solid var(--lb-hairline);">
                    <div class="flex items-center gap-1.5 mb-1">
                        <span class="text-[10px] font-medium px-1.5 py-0.5 rounded" :class="verdictClass(m.verdict)">{{ verdictLabel(m.verdict) }}</span>
                        <button @click="openIdea(m.idea)" class="text-xs font-medium flex-1 truncate text-left hover:underline" style="color: var(--lb-ink);">{{ m.title }}</button>
                    </div>
                    <p class="text-[11px] leading-snug" style="color: var(--lb-ink-3);">{{ m.reasoning }}</p>
                    <div v-if="m.verdict !== 'irrelevant'" class="flex justify-end mt-1">
                        <span v-if="m.accepted" class="text-[11px]" style="color: var(--lb-mute);">✓ uebernommen</span>
                        <button v-else @click="acceptMatch(m)" class="text-[11px] font-medium text-accent-ink hover:underline">In Idee uebernehmen</button>
                    </div>
                </div>
                <p v-if="!matches.length" class="text-xs italic" style="color: var(--lb-mute);">Keine Kandidaten gefunden.</p>
            </div>

            <!-- F3: Kapitel-Match — Vorschlag, kein Schreibvorgang (P4) -->
            <button v-if="citekey" @click="findChapterMatch" :disabled="chapterMatching"
                    class="atlas-aside-action mt-2 w-full text-xs font-medium border rounded-lg px-2 py-1.5 transition-colors">
                {{ chapterMatching ? 'Sucht passendes Kapitel…' : '📖 Welches Kapitel passt? (LLM)' }}
            </button>
            <p v-if="chapterMatchError" class="text-xs mt-1.5" style="color:var(--lb-danger);">{{ chapterMatchError }}</p>
            <div v-if="chapterMatchResults" class="mt-2 space-y-1.5">
                <div v-for="r in chapterMatchResults" :key="r.chapter_id" class="p-2 rounded-lg" style="border:1px solid var(--lb-hairline);">
                    <div class="flex items-center gap-1.5 mb-1">
                        <span class="text-[10px] font-medium px-1.5 py-0.5 rounded" style="background:var(--lb-bg-soft); color:var(--lb-ink-2);">#{{ r.rank }}</span>
                        <span class="text-xs font-medium flex-1 truncate" style="color: var(--lb-ink);">{{ r.title }}</span>
                    </div>
                    <p class="text-[11px] leading-snug" style="color: var(--lb-ink-3);">{{ r.reason }}</p>
                </div>
                <p v-if="!chapterMatchResults.length" class="text-xs italic" style="color: var(--lb-mute);">Keine passenden Kapitel gefunden.</p>
            </div>
        </div>
    `,
};

// Research Chat: "Dissertation einbeziehen". Eingeschaltet laedt die
// Komponente die Kapitel mit Text und gibt sie als einen Kontextblock an den
// Kern; ausgeschaltet traegt sie nichts bei.
const AtlasResearchChatContext = {
    props: ['enabled'],
    emits: ['update:enabled', 'update:context'],
    data() {
        return { loading: false };
    },
    mounted() {
        if (this.enabled) this.loadContext();
    },
    methods: {
        flip() {
            const on = !this.enabled;
            this.$emit('update:enabled', on);
            if (on) this.loadContext();
            else this.$emit('update:context', null);
        },
        async loadContext() {
            this.loading = true;
            try {
                const diss = await api('/api/plugins/atlas/diss');
                const chapters = (diss.chapters || []).filter((c) => c.body && c.body.trim());
                const text = chapters.map((c) => `### ${c.title}\n${c.body}`).join('\n\n');
                this.$emit('update:context', text ? `Dissertationskapitel des Nutzers:\n\n${text}` : null);
            } catch (e) {
                console.warn('Diss-Kontext konnte nicht geladen werden:', e);
                this.$emit('update:context', null);
            }
            this.loading = false;
        },
    },
    template: `
        <div class="atlas-chat-context flex items-center gap-2">
            <button @click="flip" :aria-label="enabled ? 'Dissertation ausblenden' : 'Dissertation einbeziehen'"
                    class="relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-1"
                    :class="enabled ? 'bg-accent' : 'bg-gray-300'">
                <span class="lb-knob pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out m-0.5"
                      :class="enabled ? 'translate-x-4' : 'translate-x-0'"></span>
            </button>
            <span class="text-sm text-gray-700 select-none cursor-pointer" @click="flip">Dissertation einbeziehen</span>
            <span v-if="enabled" class="text-xs text-gray-400">{{ loading ? '(Kapitel werden geladen …)' : '(Kapitel werden als Kontext gesendet)' }}</span>
        </div>
    `,
};

// Einstellungen → Add-ons: der Atlas-Ordner (Einstellung `base_dir` aus
// plugin.json). Ein/Aus schaltet der Kern in derselben Karte.
const AtlasSettings = {
    props: ['addonId', 'fields', 'values', 'save'],
    data() {
        return { baseDir: (this.values && this.values.base_dir) || '', saving: false, saved: false, error: '' };
    },
    methods: {
        async submit() {
            this.saving = true;
            this.saved = false;
            this.error = '';
            try {
                const next = await this.save({ base_dir: this.baseDir });
                this.baseDir = (next && next.base_dir) || '';
                this.saved = true;
            } catch (e) {
                this.error = e.message;
            }
            this.saving = false;
        },
    },
    template: `
        <form class="atlas-settings space-y-2" @submit.prevent="submit">
            <p class="text-sm text-gray-500">Ideen skizzieren, Dissertation strukturieren, Projekte ableiten — als Markdown-Dateien in einem eigenen Ordner.</p>
            <label class="block text-sm font-medium text-gray-700" for="atlas-settings-base-dir">Atlas-Ordner</label>
            <input id="atlas-settings-base-dir" data-field="base_dir" v-model="baseDir" type="text" autocomplete="off"
                   placeholder="Standard: <Basisordner>/atlas"
                   class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
            <div class="flex items-center gap-3">
                <button type="submit" :disabled="saving" data-testid="atlas-settings-save"
                        class="px-3 py-1.5 text-sm rounded-lg border border-gray-300 hover:bg-gray-50">Speichern</button>
                <span v-if="saved" class="text-xs text-gray-500">Gespeichert — Atlas nutzt den Ordner ab sofort.</span>
                <span v-if="error" class="text-xs text-red-600">{{ error }}</span>
            </div>
        </form>
    `,
};

// =============================================================================
// Registrierung
// =============================================================================

LB.registerPlugin({
    id: 'atlas',
    views: {
        // /atlas ist die Werkbank-Startseite "Heute" (#180, Story 58); die
        // Sammlung (Ideen, Veroeffentlichungen, Kapitel, Projekte) liegt auf
        // /atlas/sammlung.
        'atlas.today': AtlasTodayPage,
        'atlas.week': AtlasWeekPage,
        'atlas.review': AtlasReviewPage,
        'atlas.collection': AtlasPage,
        'atlas.zettel': AtlasZettelPage,
    },
    subroutes: [
        { path: '/atlas/woche/:week?', view: 'atlas.week' },
        { path: '/atlas/rueckblick/:week?', view: 'atlas.review' },
        { path: '/atlas/sammlung', view: 'atlas.collection' },
        { path: '/atlas/zettel/:id?', view: 'atlas.zettel' },
    ],
    slots: {
        'item-list-filter': { key: 'atlas.project-filter', component: AtlasItemListFilter },
        'item-detail-aside': { key: 'atlas.links', component: AtlasItemDetailAside },
        'research-chat-context': { key: 'atlas.diss-context', component: AtlasResearchChatContext },
        'settings': { key: 'atlas.settings', component: AtlasSettings },
    },
});
})();
