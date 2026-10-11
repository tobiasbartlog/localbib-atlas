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

// Veroeffentlichungen (atlas.publication/2, ADR-0004). Die EINE Liste der
// Status- und Typ-Bezeichnungen — in der Wortwahl des Redesigns (#220:
// Schreiben, Überarbeiten, Konferenzbeitrag); Pipeline, Detailseite und die
// alten Ansichten lesen alle hieraus (ATLAS_PUBLICATION_*_LABEL unten).
const PUBLICATION_STATUSES = [
    { key: 'planned', label: 'Geplant' },
    { key: 'drafting', label: 'Schreiben' },
    { key: 'submitted', label: 'Eingereicht' },
    { key: 'in-revision', label: 'Überarbeiten' },
    { key: 'published', label: 'Veröffentlicht' },
    // `closed`: eingeklappt unter der Pipeline, keine offene Frist mehr.
    { key: 'rejected', label: 'Abgelehnt', closed: true },
    { key: 'withdrawn', label: 'Zurückgezogen', closed: true },
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
    { key: 'conference-paper', label: 'Konferenzbeitrag' },
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
        // Das Abzeichen am Kalender zählt die offenen Aufgaben von heute (#223).
        atlasWork.openCount = (data.tasks || []).filter((t) => t.open).length;
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
    zettel: 'Notiz',
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
    if (entity.kind === 'publication') return atlasPublicationRoute(entity.id);
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

// Ältere Endpunkte melden nur einen `type`; er sagt dieselbe Art.
const ATLAS_EVENT_TYPE_KIND = {
    'ideas-changed': 'idea',
    'diss-changed': 'diss_node',
    'projects-changed': 'project',
    'publications-changed': 'publication',
    'manuscripts-changed': 'manuscript',
};

// Stilles Nachladen für Seiten (#226-Review). Eine Aktion meldet sich doppelt
// (API und Watcher), ein OneDrive-Sync in Schüben: die Arten werden gesammelt,
// `quiet` ms nach dem letzten Ereignis (spätestens `maxWait` nach dem ersten)
// ruft `reload(kinds)` EINMAL — nie zwei Läufe zugleich; was während eines
// Laufs kommt, folgt danach in genau einem. Die Seite lädt mit
// `atlasTouches(kinds, …)` nur, was die gemeldeten Arten betreffen.
function atlasLiveReload(reload, { quiet = 300, maxWait = 1500 } = {}) {
    let pending = new Set();
    let timer = null;
    let first = 0;
    let running = false;
    let closed = false;
    const schedule = () => {
        if (closed) return;
        const now = Date.now();
        if (!first) first = now;
        clearTimeout(timer);
        timer = setTimeout(fire, Math.max(0, Math.min(quiet, first + maxWait - now)));
    };
    const fire = async () => {
        timer = null;
        if (running || closed) return;  // läuft schon: danach geht es weiter
        const kinds = pending;
        pending = new Set();
        first = 0;
        running = true;
        try { await reload(kinds); } catch (e) { /* still: der nächste Ping holt es nach */ }
        running = false;
        if (pending.size) schedule();
    };
    const es = atlasConnectEvents((kind, type) => {
        pending.add(kind || ATLAS_EVENT_TYPE_KIND[type] || 'archive');
        schedule();
    });
    return {
        close() {
            closed = true;
            clearTimeout(timer);
            timer = null;
            if (es) es.close();
        },
    };
}

// Betrifft eine Menge gemeldeter Arten diese Teile? `null` (erstes Laden) und
// die unbestimmte Art `archive` (Reindex, fremde Datei) betreffen alles.
function atlasTouches(kinds, wanted) {
    return !kinds || kinds.has('archive') || wanted.some((k) => kinds.has(k));
}

// ── Atlas neu (#223): fünf Bereiche, Kopf, „Neu anlegen", Hinweise ──────────
// Die Navigation hat fünf Bereiche (Übersicht, Kalender, Schreiben, Ideen &
// Notizen, Projekte); „Schreiben" und „Ideen & Notizen" tragen eine
// Unternavigation. Die Seiten sagen weiter mit ihrem alten Schlüssel, wo sie
// stehen (`active="zettel"`); welcher Bereich daraus leuchtet, steht hier —
// einmal, statt auf jeder Seite.

// Die Icons der Design-Vorlage (docs/design_handoff_atlas_ui_redesign/), als
// innere SVG-Formen. Gezeichnet wird mit `currentColor`, die Farbe kommt also
// immer aus einem `--lb-*`-Token des umgebenden Elements.
const ATLAS_ICON_PATHS = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="3" width="7" height="7" rx="1.5"></rect><rect x="3" y="14" width="7" height="7" rx="1.5"></rect><rect x="14" y="14" width="7" height="7" rx="1.5"></rect>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M3 10h18M8 3v4M16 3v4"></path>',
    pen: '<path d="M4 20h4L19 9l-4-4L4 16v4z"></path><path d="M13.5 6.5l4 4"></path>',
    bulb: '<path d="M9 18h6M10 21h4"></path><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"></path>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"></path>',
    plus: '<path d="M12 5v14M5 12h14"></path>',
    search: '<circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path>',
    task: '<rect x="4" y="4" width="16" height="16" rx="3"></rect><path d="M8.5 12.5l2.5 2.5 5-6"></path>',
    note: '<path d="M6 3h12v18H6z"></path><path d="M9 7h6M9 11h6M9 15h3"></path>',
    book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5z"></path><path d="M4 19a2 2 0 0 1 2-2h13"></path>',
    doc: '<path d="M6 3h9l4 4v14H6z"></path><path d="M14 3v5h5M9 13h7M9 17h5"></path>',
    close: '<path d="M6 6l12 12M18 6L6 18"></path>',
    alert: '<circle cx="12" cy="12" r="9"></circle><path d="M12 7v6M12 16.5v.5"></path>',
    flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"></path>',
    clock: '<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"></path>',
    back: '<path d="M19 12H5M11 6l-6 6 6 6"></path>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"></path>',
    chevronLeft: '<path d="M15 6l-6 6 6 6"></path>',
    chevronRight: '<path d="M9 6l6 6-6 6"></path>',
    undo: '<path d="M9 14L4 9l5-5"></path><path d="M4 9h10a6 6 0 0 1 0 12h-3"></path>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5"></path><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"></path>',
    external: '<path d="M14 4h6v6M20 4l-9 9"></path><path d="M18 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"></path>',
    copy: '<rect x="8" y="8" width="13" height="13" rx="2"></rect><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"></path>',
    download: '<path d="M12 4v12M7 11l5 5 5-5"></path><path d="M4 20h16"></path>',
    paste: '<rect x="6" y="4" width="12" height="17" rx="2"></rect><path d="M9 4V3h6v1M9 10h6M9 14h6"></path>',
    link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"></path><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"></path>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"></path>',
    stack: '<path d="M12 3l9 5-9 5-9-5 9-5z"></path><path d="M3 13l9 5 9-5"></path>',
    grip: '<circle cx="9" cy="6" r="1.6"></circle><circle cx="15" cy="6" r="1.6"></circle><circle cx="9" cy="12" r="1.6"></circle><circle cx="15" cy="12" r="1.6"></circle><circle cx="9" cy="18" r="1.6"></circle><circle cx="15" cy="18" r="1.6"></circle>',
};

const AtlasIcon = {
    props: {
        name: { type: String, required: true },
        size: { type: [Number, String], default: 18 },
    },
    template: `<svg class="atlas-ico" :class="{ 'is-filled': name === 'grip' }" :width="size" :height="size"
                    viewBox="0 0 24 24" aria-hidden="true" focusable="false" v-html="paths"></svg>`,
    computed: {
        paths() { return ATLAS_ICON_PATHS[this.name] || ''; },
    },
};

// Gemeinsamer Oberflächen-Zustand: der „Neu anlegen"-Dialog und der eine
// Hinweis (Toast) mit optionalem „Rückgängig". Beides hängt an der
// Navigation, die jede Atlas-Seite trägt — eine Seite ruft nur
// `atlasOpenNew()` bzw. `atlasToast()`.
const atlasUi = reactive({
    newOpen: false,
    newType: 'task',
    newDay: '',
    newLinks: [],
    toast: null,
});

let atlasToastTimer = null;

// Ein Hinweis unten am Rand. `opts.action` ist eine (asynchrone) Funktion, die
// der Knopf `opts.actionLabel` ausführt — so läuft jedes „Rückgängig".
// `opts.link` ({label, to}) ist ein Weg dorthin, wo es weitergeht (z. B.
// „DOI eintragen" → Publikationsliste, #228), vor dem Knopf.
function atlasToast(message, opts = {}) {
    if (atlasToastTimer) clearTimeout(atlasToastTimer);
    atlasUi.toast = {
        id: Date.now() + Math.random(),
        message,
        actionLabel: opts.actionLabel || '',
        action: opts.action || null,
        link: opts.link || null,
        tone: opts.tone || '',
    };
    atlasToastTimer = setTimeout(() => {
        atlasUi.toast = null;
        atlasToastTimer = null;
    }, opts.timeout || 10000);
}

// `opts.day` setzt den Tag einer Aufgabe, `opts.links` verknüpft vorab
// ([{id, kind, title}]) — z. B. „Aufgabe zu diesem Beitrag".
function atlasOpenNew(type = 'task', opts = {}) {
    atlasUi.newType = type;
    atlasUi.newDay = opts.day || '';
    atlasUi.newLinks = opts.links || [];
    atlasUi.newOpen = true;
}

// Die Adresse der Veröffentlichungen: die Pipeline (#225).
const ATLAS_PUBLICATIONS_ROUTE = '/atlas/veroeffentlichungen';
// Die Publikationsliste (#228) — eine eigene Adresse neben der Pipeline, nicht
// unter /veroeffentlichungen/:id (eine Veröffentlichung darf „liste" heißen).
const ATLAS_PUBLICATION_LIST_ROUTE = '/atlas/publikationsliste';

// `pubId` wählt die Veröffentlichung in „Eigenes Paper per DOI verknüpfen" vor.
function atlasPublicationListRoute(pubId) {
    return pubId ? { path: ATLAS_PUBLICATION_LIST_ROUTE, query: { verknuepfen: pubId } } : ATLAS_PUBLICATION_LIST_ROUTE;
}

// Der Import des Kerns mit einer DOI-Liste (#227, stabil laut
// plugin_api/AUTHORING.md): ein `dois=` je DOI — Komma und Semikolon kommen
// in echten DOIs vor —, `collection` wählt eine Zielsammlung vor. Angelegt
// wird erst nach Bestätigung im Kern; Atlas ruft keinen schreibenden
// Kern-Endpunkt (P2).
function atlasImportRoute(dois, collectionId) {
    const query = { dois: [...dois] };
    if (collectionId !== null && collectionId !== undefined) query.collection = String(collectionId);
    return { path: '/import', query };
}

const ATLAS_AREAS = [
    { key: 'uebersicht', label: 'Übersicht', icon: 'grid', to: '/atlas' },
    { key: 'kalender', label: 'Kalender', icon: 'calendar', to: '/atlas/woche', badge: true },
    {
        key: 'schreiben', label: 'Schreiben', icon: 'pen', to: '/atlas/sammlung?tab=dissertation',
        sub: [
            { key: 'kapitel', label: 'Dissertation', to: '/atlas/sammlung?tab=dissertation' },
            { key: 'veroeffentlichungen', label: 'Veröffentlichungen', to: ATLAS_PUBLICATIONS_ROUTE },
            { key: 'manuskripte', label: 'Manuskripte', to: '/atlas/sammlung?tab=veroeffentlichungen&focus=manuskripte' },
        ],
    },
    {
        key: 'ideen-notizen', label: 'Ideen & Notizen', icon: 'bulb', to: '/atlas/sammlung?tab=ideen',
        sub: [
            { key: 'ideen', label: 'Ideen', to: '/atlas/sammlung?tab=ideen' },
            { key: 'zettel', label: 'Notizen', to: '/atlas/zettel' },
        ],
    },
    { key: 'projekte', label: 'Projekte', icon: 'folder', to: '/atlas/sammlung?tab=projekte' },
];

// Seitenschlüssel → Bereich. Die Schlüssel sind die bisherigen der
// Werkbank-Navigation, damit keine Seite ihren Namen ändern muss.
const ATLAS_NAV_AREA = {
    heute: 'uebersicht',
    woche: 'kalender',
    rueckblick: 'kalender',
    kapitel: 'schreiben',
    veroeffentlichungen: 'schreiben',
    manuskripte: 'schreiben',
    ideen: 'ideen-notizen',
    zettel: 'ideen-notizen',
    projekte: 'projekte',
};

function atlasAreaOf(key) {
    const areaKey = ATLAS_NAV_AREA[key] || key;
    return ATLAS_AREAS.find((a) => a.key === areaKey) || null;
}

// ISO-Datum (YYYY-MM-DD) eines lokalen Date — nie über toISOString, das in
// UTC rechnet und abends einen Tag daneben liegt.
function atlasIso(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
        + '-' + String(d.getDate()).padStart(2, '0');
}

function atlasAddDays(iso, n) {
    const d = atlasDate(iso);
    if (!d) return '';
    d.setDate(d.getDate() + n);
    return atlasIso(d);
}

// „Nächste Woche" bzw. „Montag" = der Montag der Folgewoche (#220).
function atlasNextMonday(iso) {
    const d = atlasDate(iso);
    if (!d) return '';
    const weekday = (d.getDay() + 6) % 7;   // Mo = 0
    return atlasAddDays(iso, 7 - weekday);
}

// „in 4 Tagen", „heute", „morgen", „seit 3 Tagen" — die Abstände der Übersicht.
function atlasInDays(days) {
    const n = Number(days) || 0;
    if (n === 0) return 'heute';
    if (n === 1) return 'morgen';
    if (n === -1) return 'seit gestern';
    if (n < 0) return 'seit ' + (-n) + ' Tagen';
    return 'in ' + n + ' Tagen';
}

const AtlasToast = {
    template: `
        <div class="atlas-toast-wrap" role="status" aria-live="polite">
            <div v-if="toast" :key="toast.id" class="atlas-toast" :class="toast.tone ? 'is-' + toast.tone : ''">
                <span class="atlas-toast-msg">{{ toast.message }}</span>
                <router-link v-if="toast.link" :to="toast.link.to" class="atlas-toast-link" @click="close">{{ toast.link.label }}</router-link>
                <button v-if="toast.action" type="button" class="atlas-toast-action" @click="run">{{ toast.actionLabel }}</button>
                <button type="button" class="atlas-toast-close" aria-label="Hinweis schließen" @click="close">×</button>
            </div>
        </div>
    `,
    computed: {
        toast() { return atlasUi.toast; },
    },
    methods: {
        async run() {
            const action = this.toast && this.toast.action;
            atlasUi.toast = null;
            if (action) await action();
        },
        close() { atlasUi.toast = null; },
    },
};

// Die sechs Arten von „Neu anlegen" — Satz und Zielbereich aus dem Design.
const ATLAS_NEW_TYPES = [
    { key: 'task', label: 'Aufgabe', icon: 'task', text: 'Etwas, das du an einem bestimmten Tag erledigst.', where: 'Kalender', ph: 'z. B. Abb. 4.2 neu plotten', submit: 'Aufgabe anlegen' },
    { key: 'note', label: 'Notiz', icon: 'note', text: 'Was du gelesen, besprochen oder entschieden hast.', where: 'Ideen & Notizen', ph: 'z. B. Müller et al. 2023 – Kalibrierverfahren', submit: 'Notiz anlegen' },
    { key: 'idea', label: 'Idee', icon: 'bulb', text: 'Ein Gedanke, aus dem später ein Paper werden kann.', where: 'Ideen & Notizen', ph: 'z. B. Surrogatmodell für die Parameterstudie', submit: 'Idee anlegen' },
    { key: 'chapter', label: 'Kapitel', icon: 'book', text: 'Ein Abschnitt deiner Dissertation.', where: 'Schreiben', ph: 'z. B. Kapitel 6 · Ausblick', submit: 'Kapitel anlegen' },
    { key: 'pub', label: 'Veröffentlichung', icon: 'doc', text: 'Ein eigenes Paper – vom Entwurf bis zur Annahme.', where: 'Schreiben', ph: 'z. B. Journal-Paper zur Versuchsreihe B', submit: 'Veröffentlichung anlegen' },
    { key: 'project', label: 'Projekt', icon: 'folder', text: 'Ein Forschungsprojekt mit Laufzeit und Meilensteinen.', where: 'Projekte', ph: 'z. B. DFG-Projekt, zweite Förderphase', submit: 'Projekt anlegen' },
];

// Die sechs Notiz-Arten (`zettel.type`) mit ihrem Erklärsatz. Der Typ
// `fleeting` heißt in der Oberfläche „Gedanke" (#220).
const ATLAS_NOTE_KINDS = [
    { key: 'reading', label: 'Lektüre', help: 'Was du aus einem Paper oder Buch mitnimmst – mit der Quelle verknüpfbar.' },
    { key: 'meeting', label: 'Besprechung', help: 'Ergebnisse aus einem Termin, z. B. mit der Betreuerin oder im Team.' },
    { key: 'method', label: 'Methode', help: 'Wie du etwas machst: Verfahren, Einstellungen, Abläufe.' },
    { key: 'decision', label: 'Entscheidung', help: 'Was du festgelegt hast – und warum.' },
    { key: 'fleeting', label: 'Gedanke', help: 'Ein schneller Einfall, noch unsortiert. Kann später zur Idee werden.' },
    { key: 'review', label: 'Rückblick', help: 'Was in einer Woche gut lief und was nicht.' },
];

// „Neu anlegen": jede Art in einem Satz erklärt, dazu wo sie landet. Angelegt
// wird über die bestehenden Create-Endpunkte; nur der Titel ist Pflicht (P5).
const AtlasNewDialog = {
    components: { 'atlas-icon': AtlasIcon },
    template: `
        <div v-if="open" class="atlas-modal-backdrop" @click.self="close" @keydown.esc="close">
            <div class="atlas-modal atlas-new" role="dialog" aria-modal="true" aria-labelledby="atlas-new-h">
                <div class="atlas-new-head">
                    <div>
                        <h2 id="atlas-new-h" class="atlas-modal-title">Was möchtest du festhalten?</h2>
                        <p class="atlas-modal-sub">Jede Art hat einen festen Platz in Atlas – darunter steht, wo du sie wiederfindest.</p>
                    </div>
                    <button type="button" class="atlas-icon-square" aria-label="Schließen" @click="close"><atlas-icon name="close" /></button>
                </div>

                <fieldset class="atlas-new-types">
                    <legend class="atlas-sr">Art des neuen Eintrags</legend>
                    <label v-for="t in types" :key="t.key" class="atlas-new-type" :class="{ 'is-on': type === t.key }">
                        <input type="radio" name="atlas-new-art" class="atlas-sr" :value="t.key" v-model="type" />
                        <span class="atlas-new-type-head">
                            <span class="atlas-new-type-icon"><atlas-icon :name="t.icon" /></span>
                            <span class="atlas-new-type-label">{{ t.label }}</span>
                        </span>
                        <span class="atlas-new-type-text">{{ t.text }}</span>
                        <span class="atlas-new-type-where">→ {{ t.where }}</span>
                    </label>
                </fieldset>

                <form class="atlas-new-form" @submit.prevent="submit">
                    <fieldset v-if="type === 'note'" class="atlas-new-fieldset">
                        <legend class="atlas-new-legend">Art der Notiz</legend>
                        <div class="atlas-chip-row">
                            <label v-for="k in noteKinds" :key="k.key" class="atlas-choice" :class="{ 'is-on': noteKind === k.key }">
                                <input type="radio" name="atlas-notiz-art" class="atlas-sr" :value="k.key" v-model="noteKind" />{{ k.label }}
                            </label>
                        </div>
                        <p class="atlas-new-help">{{ noteHelp }}</p>
                    </fieldset>

                    <div class="atlas-new-field">
                        <label for="atlas-new-titel" class="atlas-new-legend">Titel</label>
                        <input id="atlas-new-titel" ref="title" v-model="title" type="text" class="atlas-input"
                               :placeholder="current.ph" autocomplete="off" />
                    </div>

                    <fieldset v-if="type === 'task'" class="atlas-new-fieldset">
                        <legend class="atlas-new-legend">Wann?</legend>
                        <div class="atlas-chip-row">
                            <label v-for="w in whenOptions" :key="w.key" class="atlas-choice" :class="{ 'is-on': when === w.key }">
                                <input type="radio" name="atlas-wann" class="atlas-sr" :value="w.key" v-model="when" />
                                <atlas-icon v-if="w.key === 'date'" name="calendar" :size="16" />{{ w.label }}
                            </label>
                            <input v-if="when === 'date'" v-model="date" type="date" class="atlas-input is-date"
                                   aria-label="Datum der Aufgabe" />
                        </div>
                    </fieldset>

                    <div class="atlas-new-field">
                        <label for="atlas-new-link" class="atlas-new-legend">Verknüpfen mit <span class="atlas-muted">(optional)</span></label>
                        <div class="atlas-link-box">
                            <span v-for="e in links" :key="e.id" class="atlas-chip">
                                <span class="atlas-chip-kind">{{ kindLabel(e.kind) }}</span><span class="atlas-chip-label">{{ e.title || e.id }}</span>
                                <button type="button" class="atlas-chip-x" :aria-label="'Verknüpfung mit ' + (e.title || e.id) + ' entfernen'" @click="unlink(e)">×</button>
                            </span>
                            <input id="atlas-new-link" v-model="linkQuery" type="text" class="atlas-link-input"
                                   placeholder="Kapitel, Projekt oder Idee suchen …" autocomplete="off"
                                   @keydown.enter.prevent="pickFirst" />
                        </div>
                        <div v-if="linkQuery.trim()" class="atlas-sug is-inline" role="listbox" aria-label="Vorschläge">
                            <button v-for="e in linkHits" :key="e.id" type="button" role="option" class="atlas-sug-item"
                                    @click="link(e)">
                                <span class="atlas-sug-kind">{{ kindLabel(e.kind) }}</span>
                                <span class="atlas-sug-title">{{ e.title || e.id }}</span>
                            </button>
                            <div v-if="!linkHits.length" class="atlas-sug-empty">Nichts gefunden.</div>
                        </div>
                    </div>
                    <p v-if="error" class="atlas-error" role="alert">{{ error }}</p>
                    <button type="submit" class="atlas-sr" tabindex="-1">{{ current.submit }}</button>
                </form>

                <div class="atlas-new-foot">
                    <span class="atlas-muted">Nur der Titel ist Pflicht – alles andere geht auch später.</span>
                    <div class="atlas-row-gap">
                        <button type="button" class="atlas-btn" @click="close">Abbrechen</button>
                        <button type="button" class="atlas-btn is-primary" :disabled="busy || !title.trim()" @click="submit">
                            {{ busy ? 'Legt an…' : current.submit }}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `,
    data() {
        return {
            type: 'task',
            noteKind: 'reading',
            title: '',
            when: 'today',
            date: '',
            links: [],
            linkQuery: '',
            busy: false,
            error: '',
        };
    },
    computed: {
        open() { return atlasUi.newOpen; },
        types() { return ATLAS_NEW_TYPES; },
        noteKinds() { return ATLAS_NOTE_KINDS; },
        current() { return ATLAS_NEW_TYPES.find((t) => t.key === this.type) || ATLAS_NEW_TYPES[0]; },
        noteHelp() { return (ATLAS_NOTE_KINDS.find((k) => k.key === this.noteKind) || ATLAS_NOTE_KINDS[0]).help; },
        whenOptions() {
            return [
                { key: 'today', label: 'Heute' },
                { key: 'tomorrow', label: 'Morgen' },
                { key: 'monday', label: 'Montag' },
                { key: 'date', label: 'Datum wählen' },
            ];
        },
        linkHits() {
            const q = this.linkQuery.trim().toLowerCase();
            const taken = new Set(this.links.map((e) => e.id));
            return atlasWork.entities
                .filter((e) => !taken.has(e.id))
                .filter((e) => e.id.toLowerCase().includes(q) || (e.title || '').toLowerCase().includes(q))
                .slice(0, 6);
        },
    },
    watch: {
        open(now) {
            if (!now) return;
            this.reset();
            this.type = atlasUi.newType || 'task';
            if (atlasUi.newDay) {
                this.when = 'date';
                this.date = atlasUi.newDay;
            }
            this.links = (atlasUi.newLinks || []).map((e) => ({ ...e }));
            atlasLoadEntities();
            if (!atlasWork.today) atlasRefreshToday();
            this.$nextTick(() => { if (this.$refs.title) this.$refs.title.focus(); });
        },
    },
    methods: {
        kindLabel(kind) { return ATLAS_KIND_LABEL[kind] || kind; },
        reset() {
            this.noteKind = 'reading';
            this.title = '';
            this.when = 'today';
            this.date = '';
            this.links = [];
            this.linkQuery = '';
            this.error = '';
        },
        close() { atlasUi.newOpen = false; },
        link(e) {
            if (!this.links.some((x) => x.id === e.id)) this.links.push(e);
            this.linkQuery = '';
        },
        unlink(e) { this.links = this.links.filter((x) => x.id !== e.id); },
        pickFirst() { if (this.linkHits.length) this.link(this.linkHits[0]); },
        // Verknüpfungen ohne eigenes Feld werden zu Verweisen im Body — jedes
        // `[[id]]` ist ein Verweis (atlas/links.py), der Rückverweis entsteht
        // beim Indexieren von selbst.
        linkBody(skipKinds = []) {
            const rest = this.links.filter((e) => !skipKinds.includes(e.kind));
            return rest.length ? 'Verknüpft mit ' + rest.map((e) => '[[' + e.id + ']]').join(', ') + '\n' : '';
        },
        idsOf(kind) { return this.links.filter((e) => e.kind === kind).map((e) => e.id); },
        // Beim Anlegen bestimmt, nie gemerkt (ein computed hielte den Tag über
        // Mitternacht): der Server-Tag, solange /journal/today noch nicht (oder
        // nie) geantwortet hat der lokale — sonst scheitert das Anlegen.
        taskDay() {
            const today = atlasTodayIso();
            if (this.when === 'tomorrow') return atlasAddDays(today, 1);
            if (this.when === 'monday') return atlasNextMonday(today);
            if (this.when === 'date') return this.date;
            return today;
        },
        async create(title) {
            const post = (url, body) => api(url, { method: 'POST', body: JSON.stringify(body) });
            if (this.type === 'task') {
                const day = this.taskDay();
                if (!atlasDate(day)) throw new Error('error.atlas.date_invalid');
                const anchors = this.links.map((e) => ' [[' + e.id + ']]').join('');
                const week = atlasWeekIdOf(atlasDate(day));
                const created = await post('/api/plugins/atlas/journal/' + encodeURIComponent(week) + '/tasks',
                    { day, text: title + anchors });
                await atlasRefreshToday();
                return { route: null, toast: 'Aufgabe für ' + atlasShortDay(day) + ', ' + atlasDayMonth(day) + ' angelegt.', created };
            }
            if (this.type === 'note') {
                const z = await post('/api/plugins/atlas/zettel', { title, type: this.noteKind, body: this.linkBody() });
                return { route: '/atlas/zettel/' + encodeURIComponent(z.id), toast: 'Notiz angelegt.' };
            }
            if (this.type === 'idea') {
                const i = await post('/api/plugins/atlas/ideas', { title, type: 'paper-idea', tags: [], body: this.linkBody() });
                return { route: { path: '/atlas/sammlung', query: { tab: 'ideen', idea: i.id } }, toast: 'Idee angelegt.' };
            }
            if (this.type === 'chapter') {
                const c = await post('/api/plugins/atlas/diss', {
                    title, publications: this.idsOf('publication'), body: this.linkBody(['publication']),
                });
                return { route: { path: '/atlas/sammlung', query: { tab: 'dissertation', chapter: c.id } }, toast: 'Kapitel angelegt.' };
            }
            if (this.type === 'pub') {
                const p = await post('/api/plugins/atlas/publications', {
                    title, projects: this.idsOf('project'), derived_from: this.idsOf('idea'),
                    body: this.linkBody(['project', 'idea']),
                });
                return { route: atlasPublicationRoute(p.id), toast: 'Veröffentlichung angelegt.' };
            }
            const pr = await post('/api/plugins/atlas/projects', { title, body: this.linkBody() });
            return { route: { path: '/atlas/sammlung', query: { tab: 'projekte', proj: pr.id } }, toast: 'Projekt angelegt.' };
        },
        async submit() {
            const title = this.title.trim();
            if (!title || this.busy) return;
            this.busy = true;
            this.error = '';
            try {
                const result = await this.create(title);
                atlasLoadEntities(true);
                atlasUi.newOpen = false;
                atlasToast(result.toast);
                if (result.route) this.$router.push(result.route);
            } catch (e) {
                this.error = atlasErrorText(e);
            } finally {
                this.busy = false;
            }
        },
    },
};

// Die Detailadresse einer Veröffentlichung: ihre eigene Seite (#225/#226).
// Das alte Formular im Drawer der Sammlung bleibt über `legacy=1` erreichbar.
function atlasPublicationRoute(id) {
    return '/atlas/veroeffentlichungen/' + encodeURIComponent(id);
}

function atlasPublicationLegacyRoute(id) {
    return { path: '/atlas/sammlung', query: { tab: 'veroeffentlichungen', pub: id, legacy: '1' } };
}

// Suche im Kopf der Übersicht: Kapitel, Notizen, Ideen, Veröffentlichungen,
// Projekte aus dem Entitäten-Cache, dazu die Aufgaben der Woche, die die
// Seite schon geladen hat. Strg K setzt den Fokus.
const AtlasSearch = {
    components: { 'atlas-icon': AtlasIcon },
    props: { tasks: { type: Array, default: () => [] } },
    template: `
        <div class="atlas-search">
            <label class="atlas-search-field">
                <atlas-icon name="search" />
                <span class="atlas-sr">In Atlas suchen</span>
                <input ref="input" v-model="q" type="search" class="atlas-search-input"
                       placeholder="Kapitel, Notizen, Aufgaben suchen …" autocomplete="off"
                       @keydown.esc="q = ''" @keydown.enter.prevent="openFirst" />
                <kbd class="atlas-kbd">Strg K</kbd>
            </label>
            <div v-if="q.trim()" class="atlas-sug" role="listbox" aria-label="Suchergebnisse">
                <router-link v-for="hit in hits" :key="hit.key" :to="hit.to" class="atlas-sug-item" role="option"
                             @click="q = ''">
                    <span class="atlas-sug-kind">{{ hit.kind }}</span>
                    <span class="atlas-sug-title">{{ hit.title }}</span>
                </router-link>
                <div v-if="!hits.length" class="atlas-sug-empty">Nichts gefunden.</div>
            </div>
        </div>
    `,
    data() { return { q: '' }; },
    computed: {
        hits() {
            const q = this.q.trim().toLowerCase();
            if (!q) return [];
            const out = [];
            for (const e of atlasWork.entities) {
                if (!(e.title || e.id).toLowerCase().includes(q)) continue;
                const to = atlasEntityRoute(e);
                if (to) out.push({ key: 'e:' + e.id, kind: ATLAS_KIND_LABEL[e.kind] || e.kind, title: e.title || e.id, to });
            }
            for (const t of this.tasks) {
                if (!(t.text || '').toLowerCase().includes(q)) continue;
                out.push({ key: 't:' + t.week + '#' + t.body_index, kind: 'Aufgabe', title: t.text, to: '/atlas/woche/' + t.week });
            }
            return out.slice(0, 10);
        },
    },
    methods: {
        openFirst() {
            if (!this.hits.length) return;
            this.$router.push(this.hits[0].to);
            this.q = '';
        },
        onKey(e) {
            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
                e.preventDefault();
                if (this.$refs.input) this.$refs.input.focus();
            }
        },
    },
    mounted() {
        atlasLoadEntities();
        document.addEventListener('keydown', this.onKey);
    },
    beforeUnmount() {
        document.removeEventListener('keydown', this.onKey);
    },
};

// Der Kopf jeder Atlas-Seite: Kicker, Titel, optional eine Zeile darunter,
// rechts die Aktionen der Seite (Slot) und immer „Neu anlegen".
const AtlasHeader = {
    components: { 'atlas-icon': AtlasIcon, 'atlas-search': AtlasSearch },
    props: {
        kicker: { type: String, default: 'Atlas' },
        title: { type: String, default: '' },
        subtitle: { type: String, default: '' },
        search: { type: Boolean, default: false },
        searchTasks: { type: Array, default: () => [] },
        newLabel: { type: String, default: 'Neu anlegen' },
        newType: { type: String, default: 'task' },
    },
    template: `
        <header class="atlas-header">
            <div class="atlas-header-text">
                <div class="atlas-kicker">{{ kicker }}</div>
                <h1 class="atlas-title"><slot name="title">{{ title }}</slot></h1>
                <p v-if="subtitle || $slots.subtitle" class="atlas-subtitle"><slot name="subtitle">{{ subtitle }}</slot></p>
            </div>
            <div class="atlas-header-actions">
                <atlas-search v-if="search" :tasks="searchTasks" />
                <slot />
                <button type="button" class="atlas-btn is-primary is-tall" @click="openNew">
                    <atlas-icon name="plus" />{{ newLabel }}
                </button>
            </div>
        </header>
    `,
    methods: {
        openNew() { atlasOpenNew(this.newType); },
    },
};

const AtlasNav = {
    components: { 'atlas-icon': AtlasIcon, 'atlas-new-dialog': AtlasNewDialog, 'atlas-toast': AtlasToast },
    props: { active: { type: String, default: '' } },
    template: `
        <div class="atlas-navwrap">
            <nav class="atlas-nav" aria-label="Atlas-Bereiche">
                <router-link v-for="a in areas" :key="a.key" :to="a.to"
                             class="atlas-nav-item" :class="{ 'is-active': area && area.key === a.key }"
                             :aria-current="area && area.key === a.key ? 'page' : null">
                    <atlas-icon :name="a.icon" />{{ a.label }}
                    <span v-if="a.badge && openCount" class="atlas-nav-badge"
                          :title="openCount + (openCount === 1 ? ' offene Aufgabe heute' : ' offene Aufgaben heute')">{{ openCount }}</span>
                </router-link>
            </nav>
            <div v-if="subItems.length || $slots.default" class="atlas-subnav-row">
                <nav v-if="subItems.length" class="atlas-seg" :aria-label="area.label">
                    <router-link v-for="s in subItems" :key="s.key" :to="s.to"
                                 class="atlas-seg-item" :class="{ 'is-active': active === s.key }"
                                 :aria-current="active === s.key ? 'page' : null">{{ s.label }}</router-link>
                </nav>
                <slot />
            </div>
            <atlas-new-dialog />
            <atlas-toast />
        </div>
    `,
    computed: {
        areas() { return ATLAS_AREAS; },
        area() { return atlasAreaOf(this.active); },
        subItems() { return (this.area && this.area.sub) || []; },
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
    { key: 'zettel', label: 'Notizen', kind: 'zettel' },
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
                    Aufgaben-Zeile wird beim Indexieren zum Rückverweis.
                </p>
                <div v-for="g in groups" :key="g.key" class="atlas-back-group">
                    <div class="atlas-back-kicker">{{ g.label }} · {{ g.rows.length }}</div>
                    <div class="atlas-back-rows">
                        <router-link v-for="r in g.rows" :key="r.id" :to="r.to"
                                     class="atlas-back-row" :title="r.id">{{ r.title || r.id }}</router-link>
                    </div>
                </div>
                <div v-if="tasks.length" class="atlas-back-group">
                    <div class="atlas-back-kicker">Aufgaben · {{ tasks.length }}</div>
                    <div v-for="t in tasks" :key="t.id" class="atlas-back-task"
                         :class="{ 'is-done': t.done, 'is-pending': pending === t.id }">
                        <input type="checkbox" class="atlas-check" :checked="t.done"
                               :disabled="!!t.moved_to || pending === t.id"
                               :aria-label="(t.done ? 'Aufgabe wieder öffnen: ' : 'Aufgabe erledigt: ') + t.text"
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
        label: { type: String, default: 'Offene Aufgaben' },
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
                    Keine offene Aufgabe. Eine Zeile mit <code>[[{{ anchor }}]]</code> im Erfassen-Feld hängt einen hier an.
                </p>
                <div v-for="t in tasks" :key="t.id" class="atlas-back-task" :class="{ 'is-pending': pending === t.id }">
                    <input type="checkbox" class="atlas-check" :checked="t.done"
                           :disabled="pending === t.id"
                           :aria-label="'Aufgabe erledigt: ' + t.text" @change="toggle(t)" />
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
    // auf der Notizen-Seite ist „Notiz" der häufigste Fall, überall sonst Aufgabe.
    components: { 'atlas-icon': AtlasIcon },
    props: { initialMode: { type: String, default: 'task' } },
    emits: ['created'],
    template: `
        <form class="atlas-capture" @submit.prevent="submit">
            <label class="atlas-capture-field" :for="inputId">
                <span class="atlas-sr">Schnell erfassen</span>
                <atlas-icon name="plus" />
                <input :id="inputId" ref="input" type="text" class="atlas-capture-input"
                       :value="text" :placeholder="placeholder" autocomplete="off"
                       @input="onInput" @keydown.down="moveSuggestion(1, $event)"
                       @keydown.up="moveSuggestion(-1, $event)"
                       @keydown.enter="onEnter" @keydown.esc="onEscape"
                       @blur="closeSuggestions" />
            </label>
            <div class="atlas-seg atlas-modes" role="group" aria-label="Was wird angelegt?">
                <button v-for="m in modes" :key="m.key" type="button" class="atlas-seg-item atlas-mode"
                        :class="{ 'is-active': mode === m.key }"
                        :aria-pressed="mode === m.key ? 'true' : 'false'"
                        @click="setMode(m.key)">{{ m.label }}</button>
            </div>
            <button type="submit" class="atlas-btn is-tall" :disabled="busy || !text.trim()">
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
                <div v-if="!suggestions.length" class="atlas-sug-empty">Nichts gefunden.</div>
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
                { key: 'task', label: 'Aufgabe' },
                { key: 'zettel', label: 'Notiz' },
                { key: 'idee', label: 'Idee' },
            ],
        };
    },
    computed: {
        placeholder() {
            return ATLAS_CAPTURE_PLACEHOLDER[this.mode] || ATLAS_CAPTURE_PLACEHOLDER.task;
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
                   :aria-label="(task.done ? 'Aufgabe wieder öffnen: ' : 'Aufgabe erledigt: ') + task.text"
                   @change="$emit('toggle')" />
            <input v-if="editing" ref="edit" class="atlas-task-edit" v-model="draft"
                   aria-label="Aufgabentext bearbeiten"
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
                <button v-if="reorderable" type="button" class="atlas-icon-btn" aria-label="Aufgabe nach oben"
                        :disabled="first || editing" @click="$emit('move-up')">↑</button>
                <button v-if="reorderable" type="button" class="atlas-icon-btn" aria-label="Aufgabe nach unten"
                        :disabled="last || editing" @click="$emit('move-down')">↓</button>
                <button type="button" class="atlas-icon-btn is-danger" aria-label="Aufgabe löschen"
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

// Sammlungs-Einträge (ADR-0022, Issue #205): jede Kern-Sammlung erscheint in
// Atlas als Veröffentlichung (oder, verschoben, als Forschungsprojekt). Das
// Badge sagt, dass die Literatur im Kern gepflegt wird; `entry.collection`
// liefert der Server (Name, archiviert, ohne Datei).
const AtlasCollectionBadge = {
    props: { entry: { type: Object, required: true } },
    template: `
        <span v-if="entry.collection" class="atlas-collection-badge"
              :class="{ 'is-archived': entry.collection.archived }"
              :title="entry.collection.archived ? 'Archivierte Sammlung — Literatur im Kern' : 'Sammlung — Literatur wird im Kern gepflegt'"
              data-testid="atlas-collection-badge">Sammlung<template v-if="entry.collection.archived"> · archiviert</template></span>
    `,
};

const AtlasPage = {
    components: {
        'atlas-editor': AtlasEditor,
        'atlas-nav': AtlasNav,
        'atlas-header': AtlasHeader,
        'atlas-capture': AtlasCapture,
        'atlas-backlinks': AtlasBacklinks,
        'atlas-anchor-tasks': AtlasAnchorTasks,
        'atlas-collection-badge': AtlasCollectionBadge,
    },
    template: `
        <div class="atlas-shell relative" lang="de" @dragover="onRootDragOver" @dragleave="onDragLeave" @drop.prevent.stop="onDropMd">
            <!-- .md drag-and-drop overlay -->
            <div v-if="dragOver" class="absolute inset-0 z-30 border-2 border-dashed border-accent rounded-xl flex items-center justify-center pointer-events-none" style="background: var(--lb-accent-soft); opacity:.92;">
                <span class="text-accent-ink font-medium">Markdown-Datei (.md) hier ablegen, um sie als Idee zu importieren</span>
            </div>
            <input ref="mdInput" type="file" accept=".md" multiple class="hidden" @change="onImportFiles" />

            <!-- Kopf + Bereichsnavigation (#223) — auf jeder Atlas-Seite -->
            <atlas-header :kicker="headKicker" :title="headTitle" :new-type="headNewType">
                    <template v-if="tab === 'ideen'">
                        <button @click="onImportClick"
                                class="atlas-pill">
                            .md importieren
                        </button>
                        <button @click="openCapture"
                                class="atlas-pill">
                            <span>+</span> Neue Idee
                        </button>
                    </template>
                    <template v-else-if="tab === 'dissertation'">
                        <button @click="openNodeCreate"
                                class="atlas-pill">
                            <span>+</span> Neues Kapitel
                        </button>
                    </template>
                    <template v-else-if="tab === 'veroeffentlichungen'">
                        <button @click="openPublicationCreate"
                                class="atlas-pill">
                            <span>+</span> Neue Veröffentlichung
                        </button>
                    </template>
                    <template v-else-if="tab === 'editor'">
                        <button @click="goTab('veroeffentlichungen')"
                                class="atlas-pill">
                            ← Zurück zu Veröffentlichungen
                        </button>
                    </template>
                    <button v-else-if="tab === 'projekte'" @click="openProjectCreate"
                            class="atlas-pill">
                        <span>+</span> Neues Projekt
                    </button>
            </atlas-header>
            <!-- Die Bereiche ersetzen die Tabs der Sammlung; welcher Bereich und
                 welche Unternavigation leuchtet, sagt navKey. Der Editor hat
                 weiterhin keinen eigenen Eintrag (ADR-0004). -->
            <atlas-nav :active="navKey" class="mb-5" />

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
                                <div class="atlas-metric-l">Notizen</div>
                            </div>
                            <div class="atlas-metric">
                                <div class="atlas-metric-n" :class="{ 'is-warn': nodeMetrics.open_task_count }">{{ nodeMetrics.open_task_count || 0 }}</div>
                                <div class="atlas-metric-l">offene Aufgaben</div>
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
                                                    label="Offene Aufgaben an diesem Kapitel" @changed="refreshNodeHub" />

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
                                        <h3 class="atlas-sec-title">Verlinkte Notizen<template v-if="nodeZettel.length"> · {{ nodeZettel.length }}</template></h3>
                                        <router-link to="/atlas/zettel" class="atlas-link-btn" style="text-decoration:none">alle</router-link>
                                    </div>
                                    <div class="atlas-card">
                                        <p v-if="!nodeZettel.length" class="atlas-empty">
                                            Keine Notiz verweist auf dieses Kapitel. Ein <code>[[{{ selectedNode.id }}]]</code> im Text einer Notiz genügt.
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
                                        <span class="atlas-sec-note">Kapitel + Notizen</span>
                                    </div>
                                    <div class="atlas-card">
                                        <p v-if="!nodeLiterature.length" class="atlas-empty">
                                            Noch keine Referenzen — sie kommen aus den zugeordneten Veröffentlichungen und den verlinkten Notizen.
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
                                                <atlas-collection-badge :entry="p" />
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
                                            <atlas-collection-badge :entry="p" />
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
                                            <span v-if="p.published" class="text-mute font-mono">{{ p.published.slice(0, 4) }}</span><span v-if="p.published"> · </span><span class="font-medium">{{ p.title }}</span><span v-if="p.venue" class="text-mute"> · {{ p.venue }}</span> <atlas-collection-badge :entry="p" />
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
                                            <atlas-collection-badge :entry="p" />
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
                                    <atlas-collection-badge :entry="selectedPublication" />
                                </div>
                                <h2 class="text-xl font-semibold text-ink font-serif">{{ selectedPublication.title }}</h2>
                            </div>
                            <div class="flex items-center gap-3">
                                <button v-if="!publicationEditing && selectedPublication.collection" @click="switchCollectionKind(selectedPublication, 'project')"
                                        class="text-xs font-medium text-accent-ink hover:underline">Zu Forschungsprojekt verschieben</button>
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
                                        <p class="text-[11px] uppercase tracking-wide text-mute">{{ selectedPublication.collection ? 'Literatur (Sammlung, nur lesbar)' : 'Referenzen (Bibliographie)' }}</p>
                                        <div class="flex items-center gap-3">
                                            <button v-if="selectedPublication.collection" @click="openCollectionInCore(selectedPublication)"
                                                    class="text-[11px] font-medium text-accent-ink hover:underline">In Sammlung bearbeiten</button>
                                            <button @click="openBibtexImport" class="text-[11px] font-medium text-accent-ink hover:underline">+ .bib importieren</button>
                                        </div>
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
                                <input v-model="publicationEdit.title" :disabled="!!selectedPublication.collection" class="w-full border border-hairline rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-accent outline-none disabled:bg-bg-soft disabled:text-mute" />
                                <p v-if="selectedPublication.collection" class="text-[11px] text-mute mt-1">Der Name kommt aus der Sammlung und wird dort geändert.</p>
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
                            <div v-if="!selectedPublication.collection">
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
                                <button v-if="!selectedPublication.collection || selectedPublication.path" @click="deletePublication" class="text-xs text-red-600 hover:underline">{{ selectedPublication.collection ? 'Atlas-Angaben löschen…' : 'Löschen…' }}</button>
                                <span v-else></span>
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
                                    · {{ selectedPublication && selectedPublication.collection ? 'Sammlung' : 'Veröffentlichung' }} „{{ selectedPublication ? selectedPublication.title : '' }}"
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
                                            — alle {{ selectedPublication && selectedPublication.collection ? 'in die Sammlung übernommen' : 'der Veröffentlichung zugeordnet' }}.
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
                                <atlas-collection-badge :entry="p" />
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
                                    <atlas-collection-badge :entry="p" />
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
                                    <atlas-collection-badge :entry="selectedProject" />
                                </div>
                                <h2 class="text-xl font-semibold text-ink font-serif">{{ selectedProject.title }}</h2>
                            </div>
                            <div class="flex items-center gap-3">
                                <button v-if="!projectEditing && selectedProject.collection" @click="switchCollectionKind(selectedProject, 'publication')"
                                        class="text-xs font-medium text-accent-ink hover:underline">Zur Veröffentlichung verschieben</button>
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
                                    <div class="flex items-center justify-between mb-1">
                                        <p class="text-[11px] uppercase tracking-wide text-mute">{{ selectedProject.collection ? 'Literatur (Sammlung, nur lesbar)' : 'Referenzen' }}</p>
                                        <button v-if="selectedProject.collection" @click="openCollectionInCore(selectedProject)"
                                                class="text-[11px] font-medium text-accent-ink hover:underline">In Sammlung bearbeiten</button>
                                    </div>
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
                                <input v-model="projectEdit.title" :disabled="!!selectedProject.collection" class="w-full border border-hairline rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-accent outline-none disabled:bg-bg-soft disabled:text-mute" />
                                <p v-if="selectedProject.collection" class="text-[11px] text-mute mt-1">Der Name kommt aus der Sammlung und wird dort geändert.</p>
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
                            <div v-if="!selectedProject.collection">
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
            projectDocumentsLoaded: false,
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
        // Kopf der Sammlung je Bereich (#223): Kicker = Bereich, Titel = Unterpunkt.
        headKicker() {
            const area = atlasAreaOf(this.navKey);
            return 'Atlas · ' + (area ? area.label : 'Sammlung');
        },
        headTitle() {
            const titles = {
                kapitel: 'Dissertation', veroeffentlichungen: 'Veröffentlichungen',
                manuskripte: 'Manuskripte', ideen: 'Ideen', projekte: 'Projekte',
            };
            return titles[this.navKey] || 'Sammlung';
        },
        headNewType() {
            const types = { kapitel: 'chapter', veroeffentlichungen: 'pub', manuskripte: 'pub', ideen: 'idea', projekte: 'project' };
            return types[this.navKey] || 'task';
        },
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
            // Virtuelle Sammlungs-Einträge gibt es seit ADR-0025 nicht mehr.
            const groups = GROUPS
                .map((g) => ({ ...g, pubs: this.publications.filter((p) => g.statuses.includes(p.status)) }));
            return groups.filter((g) => g.pubs.length > 0);
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
            // Veröffentlichungen haben seit #225 eine Pipeline und eine eigene
            // Seite: alte Tiefenlinks (?tab=veroeffentlichungen[&pub=…]) führen
            // dorthin. Das alte Formular bleibt mit `legacy=1`, die Liste der
            // Manuskripte mit `focus=manuskripte` erreichbar.
            const rq = this.$route.query;
            if (rq.pub && !rq.legacy) {
                this.$router.replace(atlasPublicationRoute(rq.pub));
                return;
            }
            if (rq.tab === 'veroeffentlichungen' && !rq.pub && rq.focus !== 'manuskripte') {
                this.$router.replace(ATLAS_PUBLICATIONS_ROUTE);
                return;
            }
            // ?tab=editor&manuscript=<id> öffnet den LaTeX-Editor (Pipeline,
            // Detailseite der Veröffentlichung).
            if (rq.tab === 'editor' && rq.manuscript) {
                this.editorInitialId = String(rq.manuscript);
                this.tab = 'editor';
                return;
            }
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
                // Die Veröffentlichung hat eine eigene Seite (#225/#226).
                this.$router.push(atlasPublicationRoute(res.publication.id));
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
            this.goTab('ideen');
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
            this.$router.push(atlasPublicationRoute(id));
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
            this.projectDocumentsLoaded = false;
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
            this.projectDocumentsLoaded = false;
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
            this.$router.push(atlasPublicationRoute(id));
        },
        openProjectFromPublication(id) {
            this.closePublicationDrawer();
            this.goTab('projekte');
            this.selectProject(id);
        },
        // --- Projektdokumente (Issue #49) ------------------------------------
        // `projectDocumentsLoaded`: die Liste gilt erst nach einem gelungenen
        // Laden — davor (oder nach einem Fehler) ist die Zahl unbekannt.
        async loadProjectDocuments(id) {
            this.projectDocumentsLoaded = false;
            try {
                const d = await api(`/api/plugins/atlas/projects/${encodeURIComponent(id)}/documents`);
                this.projectDocuments = d.documents || [];
                this.projectDocumentsLoaded = true;
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
            const count = this.projectDocumentsLoaded ? this.projectDocuments.length : null;  // null: unbekannt
            const kept = atlasDocumentsKeptNote(count, 'projekte/' + id);
            if (!confirm(`Projekt „${(proj && proj.title) || id}" wirklich löschen? Die Markdown-Datei wird entfernt.` + kept)) return;
            this.savingProject = true;
            this.projectError = '';
            try {
                await api(`/api/plugins/atlas/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
                this.closeProjectDrawer();
                await this.loadProjects();
            } catch (e) {
                this.projectError = atlasErrorText(e);
                alert('Löschen fehlgeschlagen: ' + atlasErrorText(e));
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
                this.$router.push(atlasPublicationRoute(created.id));
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
                const payload = {
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
                };
                // Sammlungs-Eintrag (ADR-0022): die Literatur ist die Sammlung —
                // nie refs in die Atlas-Datei. Der erste Speichervorgang legt die
                // Datei an.
                const pub = this.selectedPublication;
                if (pub && pub.collection) delete payload.refs;
                await api(`/api/plugins/atlas/publications/${encodeURIComponent(this.selectedPublicationId)}`, {
                    method: 'PUT',
                    body: JSON.stringify(payload),
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
            // Sperre schon vor der Rückfrage: ein Doppelklick löscht nicht zweimal.
            this.savingPublication = true;
            // Das Formular kennt den Dokumentordner nicht — einmal fragen.
            const count = await atlasDocumentCount(`/api/plugins/atlas/publications/${encodeURIComponent(p.id)}/documents`);
            const question = (p.collection
                ? `Atlas-Angaben zu „${p.title}" löschen? Die Markdown-Datei wird entfernt — die Sammlung und ihre Literatur im Kern bleiben.`
                : `Veröffentlichung „${p.title}" wirklich löschen? Die Markdown-Datei wird entfernt.`)
                + atlasDocumentsKeptNote(count, 'veroeffentlichungen/' + p.id);
            if (!confirm(question)) {
                this.savingPublication = false;
                return;
            }
            this.publicationError = '';
            try {
                await api(`/api/plugins/atlas/publications/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
                this.closePublicationDrawer();
                await this.loadPublications();
            } catch (e) {
                this.publicationError = atlasErrorText(e);
            } finally {
                this.savingPublication = false;
            }
        },
        openIdeaFromPublication(id) {
            this.selectedPublicationId = null;
            this.goTab('ideen');
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
        // --- Sammlungs-Einträge (ADR-0022, Issue #205) -----------------------
        // Die Literatur wird im Kern gepflegt: der Link führt auf die
        // Sammlungsseite des Kerns.
        openCollectionInCore(entry) {
            if (!entry || !entry.collection) return;
            this.$router.push(entry.collection.edit_route || ('/collection/' + entry.collection.id));
        },
        // „Zu Forschungsprojekt verschieben" / „Zur Veröffentlichung
        // verschieben": erst die Vorschau (welche Felder in den Abschnitt
        // „Aus … übernommen" wandern), dann bestätigen, dann verschieben.
        async switchCollectionKind(entry, to) {
            if (!entry || !entry.collection) return;
            const cid = entry.collection.id;
            const base = `/api/plugins/atlas/collections/${encodeURIComponent(cid)}/switch`;
            const target = to === 'project' ? 'Forschungsprojekt' : 'Veröffentlichung';
            try {
                const plan = await api(`${base}?to=${encodeURIComponent(to)}`);
                const lines = [`„${entry.title}" zum ${target} verschieben?`, ''];
                if (!plan.has_file) {
                    lines.push('Es gibt noch keine Atlas-Angaben — nur der Typ ändert sich.');
                } else {
                    lines.push(`Übernommen: ${(plan.moved || []).join(', ')}.`);
                    if ((plan.carried || []).length) {
                        lines.push('', `Ohne Gegenstück — wandert als Abschnitt „${plan.section} (Datum)" in die Notizen:`);
                        plan.carried.forEach((c) => lines.push(`• ${c.label}: ${c.value}`));
                    } else {
                        lines.push('Keine Felder ohne Gegenstück.');
                    }
                }
                lines.push('', 'Die Literatur bleibt in der Sammlung.');
                if (!confirm(lines.join('\n'))) return;
                const res = await api(base, { method: 'POST', body: JSON.stringify({ to }) });
                this.closePublicationDrawer();
                this.closeProjectDrawer();
                await Promise.all([this.loadPublications(), this.loadProjects()]);
                if (res.kind === 'project') {
                    this.goTab('projekte');
                    this.selectProject(res.id);
                } else {
                    this.$router.push(atlasPublicationRoute(res.id));
                }
            } catch (e) {
                alert('Verschieben fehlgeschlagen: ' + atlasErrorText(e));
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
                // Sammlungs-Eintrag (ADR-0022): der Kern-Import nimmt die
                // Zielsammlung selbst — Atlas schreibt keine refs.
                const pub = this.selectedPublication;
                const collectionId = pub && pub.collection ? pub.collection.id : null;
                const commit = {
                    entries: payload,
                    source_name: this.bibtexBibFile ? this.bibtexBibFile.name : '',
                };
                if (collectionId) commit.collection_id = collectionId;
                const data = await api('/api/import/bibtex/commit', {
                    method: 'POST', body: JSON.stringify(commit),
                });
                this.bibtexCommitSummary = data;
                const ok = (data.results || []).filter((r) => r.status === 'created' || r.status === 'matched');
                // Cite Keys an die Veröffentlichung haengen (refs, ADR-0003/ADR-0004)
                if (ok.length && !collectionId) {
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
                // (Bei einer Sammlung entfernt der Kern die gelöschten Einträge
                // selbst aus ihr — dort gibt es keine refs zu bereinigen.)
                const citeKeys = new Set(created.map((r) => r.cite_key).filter(Boolean));
                const inCollection = !!(this.selectedPublication && this.selectedPublication.collection);
                if (citeKeys.size && this.selectedPublicationId && !inCollection) {
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
        '$route.query.manuscript'() { this.applyRouteIdea(); },
        '$route.query.legacy'() { this.applyRouteIdea(); },
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
    'error.atlas.task_not_found': 'Die Aufgabe existiert nicht mehr — die Ansicht wird neu geladen.',
    'error.atlas.task_text_required': 'Eine Aufgabe braucht Text.',
    'error.atlas.goal_not_found': 'Das Wochenziel existiert nicht mehr.',
    'error.atlas.goals_too_many': 'Höchstens fünf Wochenziele je Woche.',
    'error.atlas.goal_title_required': 'Ein Wochenziel braucht einen Titel.',
    'error.atlas.title_required': 'Ein Titel ist Pflicht.',
    'error.atlas.zettel_not_found': 'Die Notiz existiert nicht mehr.',
    'error.atlas.checklist_index_invalid': 'Dieser Checklisten-Punkt existiert nicht mehr.',
    'error.atlas.already_promoted': 'Aus dieser Notiz ist bereits eine Idee entstanden.',
    'error.atlas.invalid_request': 'Die Anfrage passt nicht zum Journal.',
    'error.atlas.move_changed': 'Die Aufgabe wurde seither geändert – zieh sie einfach zurück.',
    // Sammlungs-Einträge (ADR-0022, Issue #205)
    'error.atlas.collection_not_found': 'Die Sammlung gibt es nicht (mehr).',
    'error.atlas.kind_invalid': 'Unbekannter Eintragstyp.',
    'error.atlas.kind_unchanged': 'Der Eintrag hat diesen Typ bereits.',
    'error.atlas.collection_refs_readonly': 'Die Literatur einer Sammlung wird im Kern gepflegt.',
    // Pipeline und „Aus Sammlung planen" (#225, ADR-0025)
    'error.atlas.publication_not_found': 'Diese Veröffentlichung gibt es nicht (mehr).',
    'error.atlas.status_invalid': 'Unbekannter Status.',
    'error.atlas.collection_already_planned': 'Diese Sammlung ist schon eine Veröffentlichung.',
    'error.atlas.collection_not_planned': 'Diese Sammlung ist keine Veröffentlichung.',
    'error.atlas.publication_has_collection': 'Diese Veröffentlichung hat schon eine Sammlung.',
    'error.atlas.project_not_found': 'Dieses Forschungsprojekt gibt es nicht (mehr).',
    'error.atlas.project_has_collection': 'Dieses Forschungsprojekt hat schon eine Sammlung.',
    // Detailseite (#226)
    'error.atlas.filename_invalid': 'Dieser Dateiname geht nicht (Sonderzeichen oder Punkt am Anfang).',
    'error.atlas.document_not_found': 'Diese Datei liegt nicht (mehr) im Ordner.',
    'error.atlas.document_locked': 'Die Datei ist gesperrt (z. B. OneDrive-Sync oder in einem Programm geöffnet).',
    // Publikationsliste (#228)
    'error.atlas.style_invalid': 'Unbekannter Zitierstil.',
    'error.atlas.selection_invalid': 'Unbekannte Auswahl.',
    'error.atlas.format_invalid': 'Unbekanntes Exportformat.',
};

function atlasErrorText(err) {
    const msg = (err && err.message) || String(err || '');
    return ATLAS_ERROR_TEXT[msg] || msg;
}

// ── Übersicht (#223) ────────────────────────────────────────────────────────
// Die Startseite von Atlas: Kennzahlen (heute, diese Woche, Dissertation,
// nächster Termin), die Aufgaben von heute samt „Liegen geblieben",
// Wochenziele, „Demnächst" und „Zuletzt notiert". Sie setzt sich nur aus
// bestehenden Lesepfaden zusammen (Journal heute und Woche, Kapitel-Liste,
// „Was liegt an" im Journal von heute) und lädt bei Watcher-Ereignissen still
// nach — ein externer Editor-Edit erscheint von selbst.
const ATLAS_CAPTURE_PLACEHOLDER = {
    task: 'Neue Aufgabe für heute … z. B. Abb. 4.2 überarbeiten [[kapitel-04]] #methodik',
    zettel: 'Titel der Notiz … z. B. Müller 2023 – Kalibrierverfahren',
    idee: 'Titel der Idee … z. B. Surrogatmodell für die Parameterstudie',
};

const ATLAS_DISS_DONE = new Set(['submitted', 'published']);

const AtlasOverviewPage = {
    components: {
        'atlas-nav': AtlasNav,
        'atlas-header': AtlasHeader,
        'atlas-capture': AtlasCapture,
        'atlas-anchor-chip': AtlasAnchorChip,
        'atlas-icon': AtlasIcon,
    },
    template: `
        <div class="atlas-page atlas-shell" lang="de">
            <atlas-header :kicker="kicker" :title="headline" :subtitle="summary" search :search-tasks="weekTasks" />
            <atlas-nav active="heute" />

            <atlas-capture @created="onCaptured" />

            <section class="atlas-tiles" aria-label="Auf einen Blick">
                <div class="atlas-tile">
                    <div class="atlas-kicker">Heute</div>
                    <div class="atlas-tile-num"><span>{{ todayDone.length }}</span><span class="atlas-tile-of">/ {{ todayAll.length }}</span></div>
                    <div class="atlas-tile-text">Aufgaben erledigt</div>
                    <div class="atlas-meter" role="img" :aria-label="todayDone.length + ' von ' + todayAll.length + ' Aufgaben erledigt'">
                        <div class="atlas-meter-fill" :style="{ width: todayPct }"></div>
                    </div>
                </div>

                <div class="atlas-tile">
                    <div class="atlas-tile-head">
                        <div class="atlas-kicker">Diese Woche</div>
                        <div class="atlas-legend">
                            <span><i class="atlas-swatch is-accent"></i>erledigt</span>
                            <span><i class="atlas-swatch is-open"></i>offen</span>
                        </div>
                    </div>
                    <div class="atlas-tile-split">
                        <div>
                            <div class="atlas-tile-num"><span>{{ weekDone }}</span><span class="atlas-tile-of">/ {{ weekTotal }}</span></div>
                            <div class="atlas-tile-text" style="margin-top:8px">Aufgaben erledigt</div>
                        </div>
                        <div class="atlas-weekbars" role="img" aria-label="Aufgaben je Wochentag, erledigt und offen">
                            <div v-for="b in weekBars" :key="b.date" class="atlas-weekbar" :title="b.title">
                                <div class="atlas-weekbar-stack">
                                    <div v-if="b.open" class="atlas-weekbar-open" :style="{ height: b.openH }"></div>
                                    <div v-if="b.done" class="atlas-weekbar-done" :class="{ 'is-top': !b.open }" :style="{ height: b.doneH }"></div>
                                    <div v-if="!b.total" class="atlas-weekbar-empty"></div>
                                </div>
                                <span class="atlas-weekbar-label" :class="{ 'is-today': b.today }">{{ b.label }}</span>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="atlas-tile">
                    <div class="atlas-kicker">Dissertation</div>
                    <template v-if="chapters.length">
                        <div class="atlas-tile-num"><span>{{ diss.done }}</span><span class="atlas-tile-of">/ {{ chapters.length }}</span></div>
                        <div class="atlas-tile-text">Kapitel fertig, {{ diss.draft }} im Entwurf</div>
                        <div class="atlas-segbar" role="img"
                             :aria-label="chapters.length + ' Kapitel: ' + diss.done + ' fertig, ' + diss.draft + ' im Entwurf, ' + diss.open + ' offen'">
                            <div v-for="(c, i) in dissBar" :key="i" class="atlas-segbar-part" :class="'is-' + c"></div>
                        </div>
                        <div class="atlas-legend">
                            <span><i class="atlas-swatch is-done"></i>fertig {{ diss.done }}</span>
                            <span><i class="atlas-swatch is-accent"></i>Entwurf {{ diss.draft }}</span>
                            <span><i class="atlas-swatch is-open"></i>offen {{ diss.open }}</span>
                        </div>
                    </template>
                    <template v-else>
                        <div class="atlas-tile-num"><span>0</span></div>
                        <div class="atlas-tile-text">Noch keine Kapitel.</div>
                        <router-link to="/atlas/sammlung?tab=dissertation" class="atlas-tile-foot">Gliederung anlegen</router-link>
                    </template>
                </div>

                <div class="atlas-tile">
                    <div class="atlas-kicker">Nächster Termin</div>
                    <template v-if="nextTermin">
                        <div class="atlas-tile-big">{{ inDays(nextTermin.days) }}</div>
                        <div class="atlas-tile-strong">{{ nextTermin.title }}</div>
                        <div class="atlas-tile-sub">{{ dayLabel(nextTermin.date) }} · {{ nextTermin.what }}</div>
                    </template>
                    <template v-else>
                        <div class="atlas-tile-big">frei</div>
                        <div class="atlas-tile-sub">Kein Termin in den nächsten 14 Tagen.</div>
                    </template>
                    <router-link v-if="overdue.length" :to="overdue[0].to" class="atlas-tile-foot is-danger">
                        <atlas-icon name="alert" :size="16" />
                        {{ overdue.length }} {{ overdue.length === 1 ? 'Termin' : 'Termine' }} überfällig – neu planen
                    </router-link>
                </div>
            </section>

            <div class="atlas-columns">
                <div class="atlas-col-main">
                    <section class="atlas-panel" aria-labelledby="atlas-h-heute">
                        <div class="atlas-panel-head">
                            <div class="atlas-panel-title-row">
                                <h2 id="atlas-h-heute" class="atlas-panel-title">Heute</h2>
                                <span class="atlas-muted">{{ todayDone.length }} von {{ todayAll.length }} erledigt</span>
                            </div>
                            <router-link to="/atlas/woche" class="atlas-more">Ganze Woche ansehen <atlas-icon name="arrow" :size="16" /></router-link>
                        </div>
                        <div v-if="loading" class="atlas-panel-pad" aria-hidden="true">
                            <div v-for="n in 3" :key="n" class="atlas-skel" style="height:20px;margin-bottom:10px"></div>
                        </div>
                        <template v-else>
                            <ul class="atlas-todo">
                                <li v-for="t in todayOpen" :key="taskKey(t)" class="atlas-todo-row" :class="{ 'is-pending': pending === taskKey(t) }">
                                    <input :id="'atlas-cb-' + taskKey(t)" type="checkbox" class="atlas-check" :checked="t.done" @change="toggle(t)" />
                                    <label :for="'atlas-cb-' + taskKey(t)" class="atlas-todo-text">{{ t.text || '(leere Zeile)' }}</label>
                                    <atlas-anchor-chip v-for="a in t.anchors" :key="a" :id="a" />
                                    <span v-for="tag in t.tags" :key="tag" class="atlas-tag">#{{ tag }}</span>
                                </li>
                                <li v-if="!todayAll.length" class="atlas-todo-empty">
                                    Noch nichts für heute. Schreib die erste Zeile oben ins Erfassen-Feld —
                                    Anker per <code>[[id]]</code>, Schlagwort per <code>#tag</code>.
                                </li>
                                <li v-else-if="!todayOpen.length" class="atlas-todo-empty">Alles erledigt für heute.</li>
                            </ul>

                            <div v-if="carry.length" class="atlas-carry">
                                <div class="atlas-carry-head">
                                    <h3 class="atlas-carry-title"><atlas-icon name="clock" :size="16" /> Liegen geblieben · {{ carry.length }}</h3>
                                    <button type="button" class="atlas-btn is-small" :disabled="busyCarry" @click="carryAll">
                                        {{ busyCarry ? 'Holt…' : 'Alle auf heute holen' }}
                                    </button>
                                </div>
                                <ul class="atlas-carry-list">
                                    <li v-for="t in carry" :key="taskKey(t)" class="atlas-carry-row" :class="{ 'is-pending': pending === taskKey(t) }">
                                        <span class="atlas-carry-text">{{ t.text }}</span>
                                        <span class="atlas-mono-sub">seit {{ shortDay(t.day) }} {{ dayNum(t.day) }}.</span>
                                        <button type="button" class="atlas-text-btn" @click="carryOne(t)">Auf heute</button>
                                    </li>
                                </ul>
                            </div>

                            <template v-if="todayDone.length">
                                <div class="atlas-kicker atlas-panel-sub">Erledigt · {{ todayDone.length }}</div>
                                <ul class="atlas-todo is-done">
                                    <li v-for="t in todayDone" :key="taskKey(t)" class="atlas-todo-row is-done">
                                        <input :id="'atlas-cb-' + taskKey(t)" type="checkbox" class="atlas-check" :checked="t.done" @change="toggle(t)" />
                                        <label :for="'atlas-cb-' + taskKey(t)" class="atlas-todo-text">{{ t.text }}</label>
                                    </li>
                                </ul>
                            </template>
                        </template>
                    </section>

                    <section class="atlas-panel" aria-labelledby="atlas-h-ziele">
                        <div class="atlas-panel-head">
                            <div class="atlas-panel-title-row">
                                <h2 id="atlas-h-ziele" class="atlas-panel-title">Wochenziele</h2>
                                <span v-if="goals.length" class="atlas-muted">{{ goalsReached }} von {{ goals.length }} erreicht</span>
                            </div>
                            <button v-if="goals.length < 5" type="button" class="atlas-btn is-small" @click="startGoal">
                                <atlas-icon name="plus" :size="16" /> Ziel hinzufügen
                            </button>
                        </div>
                        <form v-if="addingGoal" class="atlas-goal-form" @submit.prevent="saveGoal">
                            <label for="atlas-goal-new" class="atlas-sr">Neues Wochenziel</label>
                            <input id="atlas-goal-new" ref="goalInput" v-model="goalDraft" type="text" class="atlas-input"
                                   placeholder="z. B. Kapitel 3 an die Betreuerin schicken [[kapitel-03]]" @keydown.esc="addingGoal = false" />
                            <button type="submit" class="atlas-btn is-primary is-small" :disabled="!goalDraft.trim() || busyGoal">Hinzufügen</button>
                            <button type="button" class="atlas-btn is-small" @click="addingGoal = false">Abbrechen</button>
                        </form>
                        <p v-if="!goals.length && !addingGoal" class="atlas-panel-pad atlas-muted">
                            Noch keine Wochenziele. Bis zu fünf halten fest, worauf es diese Woche ankommt.
                        </p>
                        <ul v-else-if="goals.length" class="atlas-goal-grid">
                            <li v-for="g in goals" :key="g.index" class="atlas-goal-card">
                                <div class="atlas-goal-card-title">{{ g.title }}</div>
                                <div class="atlas-meter is-thin"><div class="atlas-meter-fill" :class="{ 'is-ok': goalReached(g) }" :style="{ width: goalPercent(g) }"></div></div>
                                <div class="atlas-goal-card-foot">
                                    <atlas-anchor-chip v-if="g.anchor" :id="g.anchor" />
                                    <span v-else-if="g.tag" class="atlas-tag">#{{ g.tag }}</span>
                                    <span v-else></span>
                                    <span v-if="goalReached(g)" class="atlas-reached"><atlas-icon name="check" :size="15" /> erreicht</span>
                                    <span v-else-if="g.total" class="atlas-mono-sub is-ink">{{ g.done_count }} / {{ g.total }} Aufgaben</span>
                                    <span v-else class="atlas-mono-sub">offen</span>
                                </div>
                            </li>
                        </ul>
                    </section>
                </div>

                <aside class="atlas-col-side">
                    <section class="atlas-panel is-padded" aria-labelledby="atlas-h-demn">
                        <div class="atlas-panel-head is-flush">
                            <h2 id="atlas-h-demn" class="atlas-panel-title">Demnächst</h2>
                            <router-link to="/atlas/woche" class="atlas-more">Kalender</router-link>
                        </div>
                        <p v-if="!loading && !overdue.length && !soon.length && !still.length" class="atlas-muted" style="margin-top:12px">
                            Nichts überfällig, nichts in den nächsten 14 Tagen.
                        </p>
                        <template v-if="overdue.length">
                            <div class="atlas-group-label is-danger">Überfällig</div>
                            <ul class="atlas-agenda">
                                <li v-for="item in overdue" :key="item.key" class="atlas-agenda-row">
                                    <span class="atlas-agenda-icon is-danger"><atlas-icon name="alert" /></span>
                                    <div class="atlas-agenda-body">
                                        <div class="atlas-agenda-title">{{ item.title }}</div>
                                        <div class="atlas-agenda-sub">{{ item.what }} · überfällig, fällig war {{ dayLabel(item.date) }}</div>
                                    </div>
                                    <router-link :to="item.to" class="atlas-replan">Neu planen</router-link>
                                </li>
                            </ul>
                        </template>
                        <template v-if="soon.length">
                            <div class="atlas-group-label">Nächste 14 Tage</div>
                            <ul class="atlas-agenda">
                                <li v-for="item in soon" :key="item.key" class="atlas-agenda-row">
                                    <span class="atlas-agenda-icon is-accent"><atlas-icon name="flag" /></span>
                                    <div class="atlas-agenda-body">
                                        <router-link v-if="item.open" :to="item.open" class="atlas-agenda-title">{{ item.title }}</router-link>
                                        <div v-else class="atlas-agenda-title">{{ item.title }}</div>
                                        <div class="atlas-agenda-sub">{{ item.what }}</div>
                                    </div>
                                    <div class="atlas-agenda-when">
                                        <div class="atlas-agenda-date">{{ dayLabel(item.date) }}</div>
                                        <div class="atlas-agenda-sub">{{ inDays(item.days) }}</div>
                                    </div>
                                </li>
                            </ul>
                        </template>
                        <template v-if="still.length">
                            <div class="atlas-group-label">Liegt still</div>
                            <ul class="atlas-agenda">
                                <li v-for="item in still" :key="item.key" class="atlas-agenda-row">
                                    <span class="atlas-agenda-icon"><atlas-icon :name="item.icon" /></span>
                                    <div class="atlas-agenda-body">
                                        <router-link :to="item.to" class="atlas-agenda-title">{{ item.title }}</router-link>
                                        <div class="atlas-agenda-sub">{{ item.note }}</div>
                                    </div>
                                </li>
                            </ul>
                        </template>
                    </section>

                    <section class="atlas-panel is-padded" aria-labelledby="atlas-h-notiz">
                        <div class="atlas-panel-head is-flush">
                            <h2 id="atlas-h-notiz" class="atlas-panel-title">Zuletzt notiert</h2>
                            <router-link to="/atlas/zettel" class="atlas-more">Alle Notizen</router-link>
                        </div>
                        <p class="atlas-panel-note">Notizen halten fest, was du gelesen, besprochen oder entschieden hast.</p>
                        <p v-if="!loading && !zettel.length" class="atlas-muted">
                            Noch keine Notiz. Das Erfassen-Feld legt im Modus „Notiz" eine an.
                        </p>
                        <ul v-else class="atlas-notes">
                            <li v-for="z in zettel" :key="z.id" class="atlas-notes-row">
                                <span class="atlas-notes-kind"><span class="atlas-badge">{{ noteKind(z.type) }}</span></span>
                                <router-link :to="'/atlas/zettel/' + encodeURIComponent(z.id)" class="atlas-notes-title">{{ z.title }}</router-link>
                                <span class="atlas-notes-when">{{ when(z.date) }}</span>
                            </li>
                        </ul>
                    </section>
                    <button type="button" class="atlas-text-btn is-muted" style="align-self:flex-end" :disabled="busyReindex" @click="reindex">
                        {{ busyReindex ? 'Liest ein…' : 'Atlas-Ordner neu einlesen' }}
                    </button>
                </aside>
            </div>
        </div>
    `,
    data() {
        return {
            data: null,
            week: null,
            chapters: [],
            loading: true,
            pending: null,
            busyCarry: false,
            busyReindex: false,
            addingGoal: false,
            goalDraft: '',
            busyGoal: false,
        };
    },
    computed: {
        tasks() { return (this.data && this.data.tasks) || []; },
        // Verschobene Zeilen (→) gehören zu ihrem neuen Tag, nicht zu heute.
        todayAll() { return this.tasks.filter((t) => !t.moved_to); },
        todayOpen() { return this.todayAll.filter((t) => !t.done); },
        todayDone() { return this.todayAll.filter((t) => t.done); },
        todayPct() {
            const n = this.todayAll.length;
            return (n ? Math.round(this.todayDone.length / n * 100) : 0) + '%';
        },
        carry() { return (this.data && this.data.carry_over) || []; },
        goals() { return (this.data && this.data.goals) || []; },
        goalsReached() { return this.goals.filter((g) => this.goalReached(g)).length; },
        zettel() { return (this.data && this.data.zettel) || []; },
        weekTasks() { return (this.week && this.week.tasks) || []; },
        weekDays() {
            return ((this.week && this.week.days) || []).map((d) => {
                const rows = (d.tasks || []).filter((t) => !t.moved_to);
                const done = rows.filter((t) => t.done).length;
                return { date: d.date, weekday: d.weekday, done, open: rows.length - done, total: rows.length };
            });
        },
        weekDone() { return this.weekDays.reduce((n, d) => n + d.done, 0); },
        weekTotal() { return this.weekDays.reduce((n, d) => n + d.total, 0); },
        weekBars() {
            const max = Math.max(1, ...this.weekDays.map((d) => d.total));
            const H = 50;
            const today = this.data && this.data.date;
            return this.weekDays.map((d) => ({
                date: d.date,
                label: atlasShortDay(d.date),
                today: d.date === today,
                total: d.total,
                done: d.done,
                open: d.open,
                title: atlasShortDay(d.date) + ' ' + this.dayNum(d.date) + '.' + (d.date === today ? ' (heute)' : '')
                    + ': ' + d.done + ' von ' + d.total + ' erledigt',
                doneH: Math.max(Math.round(d.done / max * H), 3) + 'px',
                openH: Math.max(Math.round(d.open / max * H) - 2, 3) + 'px',
            }));
        },
        diss() {
            let done = 0;
            let draft = 0;
            for (const c of this.chapters) {
                if (ATLAS_DISS_DONE.has(c.status)) done += 1;
                else if (c.status === 'in-progress') draft += 1;
            }
            return { done, draft, open: this.chapters.length - done - draft };
        },
        dissBar() {
            const d = this.diss;
            return [].concat(Array(d.done).fill('done'), Array(d.draft).fill('draft'), Array(d.open).fill('open'));
        },
        due() { return (this.data && this.data.due) || {}; },
        // Termine = Meilensteine der Projekte und Fristen der Veröffentlichungen.
        termine() {
            const out = [];
            for (const m of this.due.milestones || []) {
                out.push({
                    key: 'ms:' + m.project_id + ':' + m.index,
                    title: m.title,
                    date: m.date,
                    days: m.days,
                    overdue: m.state === 'overdue',
                    what: 'Meilenstein · ' + (m.project_title || m.project_id),
                    open: { path: '/atlas/sammlung', query: { tab: 'projekte', proj: m.project_id } },
                    // Überfälliges steht im Kalender unter „Liegen geblieben",
                    // Kommendes in seiner Woche.
                    to: m.state === 'overdue' ? '/atlas/woche' : '/atlas/woche/' + atlasWeekIdOf(atlasDate(m.date)),
                });
            }
            for (const d of this.due.deadlines || []) {
                out.push({
                    key: 'pub:' + d.id,
                    title: d.title,
                    date: d.date,
                    days: d.days,
                    overdue: d.state === 'overdue',
                    what: 'Frist · Veröffentlichung',
                    open: atlasPublicationRoute(d.id),
                    to: d.state === 'overdue' ? '/atlas/woche' : '/atlas/woche/' + atlasWeekIdOf(atlasDate(d.date)),
                });
            }
            out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
            return out;
        },
        overdue() { return this.termine.filter((t) => t.overdue); },
        soon() { return this.termine.filter((t) => !t.overdue); },
        nextTermin() { return this.soon[0] || null; },
        still() {
            const out = [];
            for (const f of this.due.follow_ups || []) {
                const weeks = Math.floor(Math.abs(f.days) / 7);
                out.push({
                    key: 'fu:' + f.id,
                    icon: 'clock',
                    title: f.title + ' – nachfragen?',
                    note: 'seit ' + weeks + ' Wochen eingereicht' + (f.venue ? ' bei ' + f.venue : '') + ' · beim Journal nachfragen',
                    to: atlasPublicationRoute(f.id),
                });
            }
            for (const c of this.due.stale_chapters || []) {
                out.push({
                    key: 'ch:' + c.id,
                    icon: 'book',
                    title: c.title || c.id,
                    note: this.since(c.days) + ' unverändert',
                    to: { path: '/atlas/sammlung', query: { tab: 'dissertation', chapter: c.id } },
                });
            }
            for (const i of this.due.stale_ideas || []) {
                out.push({
                    key: 'id:' + i.id,
                    icon: 'bulb',
                    title: 'Idee: ' + (i.title || i.id),
                    note: this.since(i.days) + ' nicht weiterentwickelt',
                    to: { path: '/atlas/sammlung', query: { tab: 'ideen', idea: i.id } },
                });
            }
            return out;
        },
        kicker() {
            if (!this.data) return 'Atlas · Übersicht';
            return 'Atlas · KW ' + atlasWeekNumber(this.data.week) + ' · Tag ' + this.dayIndex + ' von 7';
        },
        dayIndex() {
            const d = atlasDate(this.data && this.data.date);
            return d ? ((d.getDay() + 6) % 7) + 1 : 0;
        },
        headline() {
            if (!this.data) return 'Übersicht';
            return this.data.weekday + ', ' + atlasDayMonth(this.data.date);
        },
        summary() {
            if (!this.data) return '';
            const n = this.todayOpen.length;
            const parts = [n + (n === 1 ? ' Aufgabe offen' : ' Aufgaben offen')];
            if (this.nextTermin) parts.push('nächster Termin ' + atlasInDays(this.nextTermin.days));
            if (this.overdue.length) parts.push(this.overdue.length + ' überfällig');
            return parts.join(' · ');
        },
    },
    methods: {
        taskKey(task) { return task.week + '#' + task.body_index; },
        shortDay(iso) { return atlasShortDay(iso); },
        dayNum(iso) { const d = atlasDate(iso); return d ? d.getDate() : ''; },
        inDays(n) { return atlasInDays(n); },
        dayLabel(iso) {
            return atlasShortDay(iso) + ', ' + atlasFormatDate(iso, { day: 'numeric', month: 'short' });
        },
        noteKind(type) { return ATLAS_ZETTEL_TYPES[type] || ATLAS_ZETTEL_TYPES.fleeting; },
        // „heute", „gestern", sonst der Wochentag (diese Woche) oder das Datum.
        when(iso) {
            const today = this.data && this.data.date;
            if (!iso || !today) return '';
            if (iso === today) return 'heute';
            if (iso === atlasAddDays(today, -1)) return 'gestern';
            if (iso > atlasAddDays(today, -7) && iso < today) return atlasShortDay(iso);
            return atlasShortDate(iso);
        },
        since(days) {
            const n = Math.abs(Number(days) || 0);
            if (n >= 60) return 'seit ' + Math.floor(n / 30) + ' Monaten';
            if (n >= 14) return 'seit ' + Math.floor(n / 7) + ' Wochen';
            if (n === 1) return 'seit 1 Tag';
            return 'seit ' + n + ' Tagen';
        },
        goalReached(goal) {
            return !!goal.done || (goal.total > 0 && goal.done_count === goal.total);
        },
        goalPercent(goal) {
            if (this.goalReached(goal)) return '100%';
            return Math.round((goal.progress || 0) * 100) + '%';
        },
        taskUrl(task) {
            return '/api/plugins/atlas/journal/' + encodeURIComponent(task.week)
                + '/tasks/' + encodeURIComponent(task.body_index);
        },
        async load(silent = false) {
            if (!silent) this.loading = true;
            const data = await atlasRefreshToday();
            if (data) this.data = data;
            const week = (data && data.week) || atlasWork.week;
            const [weekData, diss] = await Promise.all([
                week ? api('/api/plugins/atlas/journal/' + encodeURIComponent(week)).catch(() => null) : null,
                api('/api/plugins/atlas/diss').catch(() => null),
            ]);
            if (weekData) this.week = weekData;
            if (diss) this.chapters = diss.chapters || [];
            this.loading = false;
        },
        // Heute fasst fast alles zusammen; nur Dateien in Manuskript- und
        // Dokumentordnern ändern hier nichts.
        reloadFor(kinds) {
            if (atlasTouches(kinds, ['journal', 'zettel', 'idea', 'diss_node', 'project', 'publication', 'collection'])) {
                return this.load(true);
            }
            return null;
        },
        async toggle(task) {
            const before = task.done;
            task.done = !before;
            task.open = !task.done && !task.moved_to;
            try {
                await api(this.taskUrl(task) + '/toggle', { method: 'POST' });
            } catch (e) {
                task.done = before;
                task.open = !before && !task.moved_to;
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            await this.load(true);
        },
        async carryOne(task) {
            this.pending = this.taskKey(task);
            try {
                await api(this.taskUrl(task) + '/move', { method: 'POST', body: JSON.stringify({ to: this.data.date }) });
                atlasToast('„' + task.text + '" liegt jetzt auf heute.');
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            this.pending = null;
            await this.load(true);
        },
        async carryAll() {
            if (this.busyCarry || !this.data) return;
            this.busyCarry = true;
            try {
                const res = await api('/api/plugins/atlas/journal/' + encodeURIComponent(this.data.week) + '/carry-over', {
                    method: 'POST', body: JSON.stringify({ to: this.data.date }),
                });
                const n = (res && res.moved) || 0;
                atlasToast(n === 1 ? '1 Aufgabe auf heute geholt.' : n + ' Aufgaben auf heute geholt.');
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            this.busyCarry = false;
            await this.load(true);
        },
        startGoal() {
            this.addingGoal = true;
            this.goalDraft = '';
            this.$nextTick(() => { if (this.$refs.goalInput) this.$refs.goalInput.focus(); });
        },
        // Ein Ziel: Titel, dazu optional ein `[[anker]]` und ein `#tag` aus
        // derselben Zeile — dieselbe Schreibweise wie beim Erfassen.
        async saveGoal() {
            const raw = this.goalDraft.trim();
            if (!raw || this.busyGoal || !this.data) return;
            const anchor = (/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/.exec(raw) || [])[1] || null;
            const tag = (/(?:^|\s)#([\wäöüÄÖÜß-]+)/.exec(raw) || [])[1] || null;
            const title = raw.replace(/\[\[[^\]]*\]\]/g, '').replace(/(?:^|\s)#[\wäöüÄÖÜß-]+/g, ' ').replace(/\s+/g, ' ').trim() || raw;
            const goals = this.goals.map((g) => ({ title: g.title, anchor: g.anchor || null, tag: g.tag || null, done: !!g.done }));
            goals.push({ title, anchor, tag, done: false });
            this.busyGoal = true;
            try {
                await api('/api/plugins/atlas/journal/' + encodeURIComponent(this.data.week) + '/goals', {
                    method: 'PUT', body: JSON.stringify({ goals }),
                });
                this.addingGoal = false;
                atlasToast('Wochenziel hinzugefügt.');
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            this.busyGoal = false;
            await this.load(true);
        },
        onCaptured() { this.load(true); },
        // Den Index aus den Markdown-Dateien neu aufbauen (P1) — nach Edits
        // außerhalb, falls der Watcher etwas verpasst hat.
        async reindex() {
            if (this.busyReindex) return;
            this.busyReindex = true;
            try {
                await api('/api/plugins/atlas/reindex', { method: 'POST' });
                await atlasLoadEntities(true);
                atlasToast('Atlas-Ordner neu eingelesen.');
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            this.busyReindex = false;
            await this.load(true);
        },
    },
    created() {
        // Alte Tiefenlinks (/atlas?idea=…) zeigten auf die Sammlung — sie sollen
        // weiter dort landen.
        const q = this.$route.query || {};
        if (q.idea || q.pub || q.proj || q.chapter || q.tab) {
            this.$router.replace({ path: '/atlas/sammlung', query: q });
        }
    },
    mounted() {
        this.load();
        atlasLoadEntities();
        this._live = atlasLiveReload((kinds) => this.reloadFor(kinds));
    },
    beforeUnmount() {
        if (this._live) { this._live.close(); this._live = null; }
    },
};

// ── Veröffentlichungen als Pipeline (#225) ──────────────────────────────────
// Fünf Spalten nach Status, je mit „wer ist dran". Karten zieht man per
// Drag & Drop (oder Griff + Alt ← / →) in eine andere Spalte; „Status
// wechseln" trägt Einreich- und Veröffentlichungsdatum selbst ein, die Antwort
// nennt, was gesetzt wurde — „Rückgängig" setzt den alten Status und leert
// genau diese Felder über das partielle Update. Abgelehnte/zurückgezogene
// Veröffentlichungen und LaTeX-Manuskripte ohne Veröffentlichung stehen
// eingeklappt darunter.
// Bezeichnungen aus PUBLICATION_STATUSES / PUBLICATION_TYPES (oben) — keine
// zweite Liste.
const ATLAS_PUBLICATION_STATUS_LABEL = Object.fromEntries(PUBLICATION_STATUSES.map((s) => [s.key, s.label]));
const ATLAS_PUBLICATION_TYPE_LABEL = Object.fromEntries(PUBLICATION_TYPES.map((t) => [t.key, t.label]));
const ATLAS_PIPELINE = [
    { key: 'planned', hint: 'Soll mal ein Paper werden', who: 'Noch offen', whoTone: 'neutral' },
    { key: 'drafting', hint: 'Du arbeitest am Manuskript', who: 'Du bist dran', whoTone: 'accent' },
    { key: 'submitted', hint: 'Liegt beim Journal', who: 'Warten', whoTone: 'neutral' },
    { key: 'in-revision', hint: 'Gutachten liegen vor', who: 'Du bist dran', whoTone: 'accent' },
    { key: 'published', hint: 'Steht in deiner Publikationsliste', who: 'Fertig', whoTone: 'ok' },
].map((col) => ({ ...col, name: ATLAS_PUBLICATION_STATUS_LABEL[col.key] }));
const ATLAS_PIPELINE_CLOSED = new Set(PUBLICATION_STATUSES.filter((s) => s.closed).map((s) => s.key));
const ATLAS_SUBMITTED_NUDGE_DAYS = 56;   // dieselbe Schwelle wie agenda.SUBMITTED_NUDGE_DAYS

function atlasTodayIso() {
    return atlasWork.today || atlasIso(new Date());
}

function atlasDaysBetween(fromIso, toIso) {
    const a = atlasDate(fromIso);
    const b = atlasDate(toIso);
    if (!a || !b) return null;
    return Math.round((b - a) / (24 * 3600 * 1000));
}

// Der Hinweis nach einem Statuswechsel — ohne Versprechen, etwas in der
// Bibliothek abzulegen (Atlas fügt dort nie selbst etwas hinzu).
function atlasStatusToast(pub, target, set) {
    const title = '„' + pub.title + '"';
    if (target === 'planned') return title + ' ist wieder geplant.';
    if (target === 'drafting') return title + ' ist jetzt in Arbeit.';
    if (target === 'submitted') {
        return (set || []).includes('submitted')
            ? 'Eingereicht am ' + atlasFormatDate(atlasTodayIso(), { day: 'numeric', month: 'short' }) + ' eingetragen – Atlas erinnert dich in 8 Wochen ans Nachfragen.'
            : title + ' liegt beim Journal.';
    }
    if (target === 'in-revision') return 'Status: Überarbeiten. Trag die Revisionsfrist ein, dann steht sie im Kalender.';
    if (target === 'published') {
        return pub.paper
            ? 'Glückwunsch! ' + title + ' steht jetzt in deiner Publikationsliste.'
            : 'Glückwunsch! Verknüpfe dein eigenes Paper per DOI, dann ist die Publikationsliste vollständig.';
    }
    return title + ': ' + (ATLAS_PUBLICATION_STATUS_LABEL[target] || target) + '.';
}

// „Status wechseln" mit Rückgängig — geteilt von der Pipeline und den
// Schritten der Detailseite. `after` lädt die Seite neu.
async function atlasChangeStatus(pub, target, after) {
    const res = await api('/api/plugins/atlas/publications/' + encodeURIComponent(pub.id) + '/status', {
        method: 'POST', body: JSON.stringify({ status: target }),
    });
    const undoBody = { status: res.previous_status };
    for (const field of res.set || []) undoBody[field] = null;
    // „Veröffentlicht" führt in die Publikationsliste (#228): ohne eigenes
    // Paper gleich in „Eigenes Paper per DOI verknüpfen", vorgewählt.
    let link = null;
    if (target === 'published') {
        link = pub.paper
            ? { label: 'Publikationsliste', to: atlasPublicationListRoute() }
            : { label: 'DOI eintragen', to: atlasPublicationListRoute(pub.id) };
    }
    atlasToast(atlasStatusToast(pub, target, res.set), {
        link,
        actionLabel: 'Rückgängig',
        action: async () => {
            try {
                await api('/api/plugins/atlas/publications/' + encodeURIComponent(pub.id), {
                    method: 'PUT', body: JSON.stringify(undoBody),
                });
                atlasToast('Rückgängig gemacht.');
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            if (after) await after();
        },
    });
    if (after) await after();
    return res;
}

// „Aus Sammlung planen" (#225, ADR-0025): alle Sammlungen; eine davon wird
// zur Veröffentlichung, deren Literatur live die Sammlung ist. „Lösen"
// friert die Literatur ein. Beides mit „Rückgängig".
const AtlasPlanDialog = {
    components: { 'atlas-icon': AtlasIcon },
    emits: ['close', 'changed'],
    template: `
        <div class="atlas-modal-backdrop" @click.self="$emit('close')" @keydown.esc="$emit('close')">
            <div class="atlas-modal atlas-plan" role="dialog" aria-modal="true" aria-labelledby="atlas-plan-h">
                <div class="atlas-new-head">
                    <div>
                        <h2 id="atlas-plan-h" class="atlas-modal-title">Aus Sammlung planen</h2>
                        <p class="atlas-modal-sub">Sammlungen sind erst einmal nur Ablageorte für Paper. Wähl aus, welche zur Veröffentlichung werden soll – ihre Paper sind dann deren Literaturliste und bleiben aktuell.</p>
                    </div>
                    <button type="button" class="atlas-icon-square" aria-label="Schließen" @click="$emit('close')"><atlas-icon name="close" /></button>
                </div>
                <label class="atlas-search-field is-boxed">
                    <atlas-icon name="search" />
                    <span class="atlas-sr">Sammlungen durchsuchen</span>
                    <input ref="search" v-model="q" type="search" class="atlas-search-input" placeholder="Sammlungen durchsuchen …" />
                </label>
                <div class="atlas-plan-body">
                    <p v-if="loading" class="atlas-muted">Lädt…</p>
                    <p v-else-if="!available" class="atlas-muted">Diese LocalBib-Version kennt noch keine Sammlungen.</p>
                    <template v-else>
                        <section aria-labelledby="atlas-plan-free">
                            <h3 id="atlas-plan-free" class="atlas-group-label is-flat">Sammlungen · {{ free.length }}</h3>
                            <p v-if="!free.length" class="atlas-muted">{{ q ? 'Keine Sammlung passt zur Suche.' : 'Jede Sammlung ist schon eine Veröffentlichung.' }}</p>
                            <ul class="atlas-plan-list">
                                <li v-for="c in free" :key="c.id" class="atlas-plan-row">
                                    <span class="atlas-plan-icon"><atlas-icon name="stack" /></span>
                                    <div class="atlas-plan-text">
                                        <div class="atlas-plan-name">{{ c.name }}</div>
                                        <div class="atlas-plan-meta">{{ c.item_count }} Paper<template v-if="created(c)"> · {{ created(c) }}</template><template v-if="c.archived"> · archiviert</template></div>
                                    </div>
                                    <button type="button" class="atlas-btn is-outline-accent" :disabled="busy === c.id"
                                            :aria-label="'„' + c.name + '“ als Veröffentlichung planen'" @click="plan(c)">Als Veröffentlichung planen</button>
                                </li>
                            </ul>
                        </section>
                        <section aria-labelledby="atlas-plan-pub">
                            <h3 id="atlas-plan-pub" class="atlas-group-label is-flat">Schon Veröffentlichungen · {{ planned.length }}</h3>
                            <ul class="atlas-plan-list">
                                <li v-for="c in planned" :key="c.id" class="atlas-plan-row is-planned">
                                    <span class="atlas-plan-icon is-accent"><atlas-icon name="doc" /></span>
                                    <div class="atlas-plan-text">
                                        <div class="atlas-plan-name">{{ c.name }}</div>
                                        <div class="atlas-plan-meta">{{ c.item_count }} Paper · {{ c.entry.kind === 'project' ? 'als Forschungsprojekt' : 'als „' + c.entry.title + '“' }}</div>
                                    </div>
                                    <span class="atlas-who is-accent">{{ stage(c.entry) }}</span>
                                    <router-link :to="openRoute(c.entry)" class="atlas-btn is-small" @click="$emit('close')">Öffnen</router-link>
                                    <button type="button" class="atlas-text-btn is-muted" :disabled="busy === c.id"
                                            :aria-label="'„' + c.name + '“ nicht mehr als Veröffentlichung führen'" @click="unplan(c)">Lösen</button>
                                </li>
                            </ul>
                        </section>
                    </template>
                </div>
                <div class="atlas-new-foot">
                    <span class="atlas-muted">Neue Sammlungen aus LocalBib landen hier – ohne Rückfrage. Du planst nur, was du willst.</span>
                    <button type="button" class="atlas-btn is-primary is-tall" @click="$emit('close')">Fertig</button>
                </div>
            </div>
        </div>
    `,
    data() {
        return { rows: [], available: true, loading: true, q: '', busy: null };
    },
    computed: {
        matching() {
            const q = this.q.trim().toLowerCase();
            return q ? this.rows.filter((c) => (c.name || '').toLowerCase().includes(q)) : this.rows;
        },
        free() { return this.matching.filter((c) => !c.entry); },
        planned() { return this.matching.filter((c) => c.entry); },
    },
    methods: {
        created(c) {
            if (!c.created_at) return '';
            const days = atlasDaysBetween(String(c.created_at).slice(0, 10), atlasTodayIso());
            if (days === null) return '';
            if (days <= 0) return 'angelegt heute';
            if (days === 1) return 'angelegt gestern';
            if (days < 14) return 'angelegt vor ' + days + ' Tagen';
            if (days < 60) return 'angelegt vor ' + Math.round(days / 7) + ' Wochen';
            return 'angelegt im ' + atlasFormatDate(String(c.created_at).slice(0, 10), { month: 'long', year: 'numeric' });
        },
        stage(entry) {
            if (entry.kind === 'project') return 'Projekt';
            return ATLAS_PUBLICATION_STATUS_LABEL[entry.status] || 'Geplant';
        },
        openRoute(entry) {
            return entry.kind === 'project'
                ? { path: '/atlas/sammlung', query: { tab: 'projekte', proj: entry.id } }
                : atlasPublicationRoute(entry.id);
        },
        async load() {
            try {
                const data = await api('/api/plugins/atlas/collections');
                this.rows = data.collections || [];
                this.available = data.available !== false;
            } catch (e) {
                this.rows = [];
            }
            this.loading = false;
        },
        async refresh() {
            await this.load();
            this.$emit('changed');
        },
        // `released` ({id, kind}) ist die Antwort von „Lösen": Rückgängig
        // verknüpft genau diese Datei wieder — eine Veröffentlichung oder ein
        // Forschungsprojekt.
        async plan(c, released) {
            this.busy = c.id;
            try {
                let body = {};
                if (released) {
                    body = released.kind === 'project' ? { project_id: released.id } : { publication_id: released.id };
                }
                const res = await api('/api/plugins/atlas/collections/' + c.id + '/plan', {
                    method: 'POST', body: JSON.stringify(body),
                });
                const entryId = res.entry.id;
                if (released) {
                    atlasToast(released.kind === 'project'
                        ? '„' + c.name + '“ ist wieder die Literatur des Forschungsprojekts.'
                        : '„' + c.name + '“ ist wieder die Literatur der Veröffentlichung.');
                } else {
                    atlasToast('„' + c.name + '“ steht jetzt unter „Geplant“ – die ' + c.item_count + ' Paper sind die Literaturliste.', {
                        actionLabel: 'Rückgängig',
                        // Ein Fehlklick soll folgenlos bleiben: die eben angelegte
                        // Datei geht wieder (ADR-0025).
                        action: async () => {
                            try {
                                await api('/api/plugins/atlas/publications/' + encodeURIComponent(entryId), { method: 'DELETE' });
                            } catch (e) {
                                atlasToast(atlasErrorText(e), { tone: 'danger' });
                            }
                            await this.refresh();
                        },
                    });
                }
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            this.busy = null;
            await this.refresh();
        },
        async unplan(c) {
            this.busy = c.id;
            const entry = c.entry;
            try {
                const res = await api('/api/plugins/atlas/collections/' + c.id + '/unplan', { method: 'POST' });
                const n = (res.refs || []).length;
                atlasToast('„' + entry.title + '“ bleibt bestehen und behält die ' + n + ' Paper als feste Liste. Die Sammlung ist wieder nur ein Ablageort.', {
                    actionLabel: 'Rückgängig',
                    action: () => this.plan(c, { id: res.id, kind: res.kind }),
                });
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            this.busy = null;
            await this.refresh();
        },
    },
    mounted() {
        this.load();
        this.$nextTick(() => { if (this.$refs.search) this.$refs.search.focus(); });
    },
};

const AtlasPipelinePage = {
    components: {
        'atlas-nav': AtlasNav,
        'atlas-header': AtlasHeader,
        'atlas-icon': AtlasIcon,
        'atlas-plan-dialog': AtlasPlanDialog,
    },
    template: `
        <div class="atlas-page atlas-shell" lang="de">
            <atlas-header kicker="Atlas · Schreiben" title="Veröffentlichungen" :subtitle="summary"
                          new-label="Neues Vorhaben" new-type="pub">
                <router-link :to="listRoute" class="atlas-btn is-tall">
                    <atlas-icon name="list" /> Publikationsliste
                </router-link>
                <button type="button" class="atlas-btn is-tall" @click="planOpen = true">
                    <atlas-icon name="stack" /> Aus Sammlung planen
                </button>
            </atlas-header>
            <atlas-nav active="veroeffentlichungen">
                <span class="atlas-hint-line">
                    <span class="atlas-hint-grip"><atlas-icon name="grip" :size="16" /></span>
                    Karte in die nächste Spalte ziehen – Datum und Erinnerung trägt Atlas selbst ein. Titel anklicken öffnet die Details.
                </span>
            </atlas-nav>

            <div class="atlas-board-scroll">
                <div class="atlas-board">
                    <section v-for="col in columns" :key="col.key" class="atlas-col"
                             :class="{ 'is-over': overCol === col.key && canDropOn(col.key), 'is-published': col.key === 'published' }"
                             :aria-label="col.name + ', ' + col.items.length + ' Einträge'"
                             @dragover="onDragOver($event, col.key)" @dragleave="onDragLeave($event, col.key)"
                             @drop="onDrop($event, col.key)">
                        <header class="atlas-col-head">
                            <div class="atlas-col-title-row">
                                <h2 class="atlas-col-title">{{ col.name }}</h2>
                                <span class="atlas-mono-sub">{{ col.items.length }}</span>
                            </div>
                            <div class="atlas-col-sub">
                                <span class="atlas-who" :class="'is-' + col.whoTone">{{ col.who }}</span>
                                <span class="atlas-col-hint">{{ col.hint }}</span>
                            </div>
                        </header>
                        <ul class="atlas-cards">
                            <li v-for="p in col.items" :key="p.id" class="atlas-card-li" :class="{ 'is-dragging': dragging === p.id }"
                                draggable="true" :data-pub="p.id"
                                @dragstart="onDragStart($event, p)" @dragend="onDragEnd">
                                <article class="atlas-pcard">
                                    <button type="button" class="atlas-grip" :data-grip="p.id"
                                            :aria-label="'Verschieben: ' + p.title" title="Ziehen oder Alt + Pfeiltaste"
                                            @keydown="onGripKey($event, p)"><atlas-icon name="grip" :size="16" /></button>
                                    <div class="atlas-pcard-body">
                                        <span v-if="p.timer" class="atlas-timer" :class="'is-' + p.timer.tone">
                                            <atlas-icon :name="p.timer.icon" :size="14" />{{ p.timer.text }}
                                        </span>
                                        <h3 class="atlas-pcard-title">
                                            <router-link :to="detailRoute(p.id)" draggable="false">{{ p.title }}</router-link>
                                        </h3>
                                        <div class="atlas-pcard-meta">
                                            <span class="atlas-pcard-venue">{{ p.venueLine }}</span>
                                            <span v-if="p.coauthors" class="atlas-pcard-co">{{ p.coauthors }}</span>
                                        </div>
                                        <div v-if="p.progress" class="atlas-pcard-progress">
                                            <div class="atlas-meter is-thin"><div class="atlas-meter-fill" :style="{ width: p.progress.pct }"></div></div>
                                            <span class="atlas-pcard-progress-text">{{ p.progress.text }}</span>
                                        </div>
                                        <div v-if="p.links.length" class="atlas-pcard-links">
                                            <span v-for="l in p.links" :key="l.kind + l.label" class="atlas-chip is-static">
                                                <span class="atlas-chip-kind">{{ l.kind }}</span><span class="atlas-chip-label">{{ l.label }}</span>
                                            </span>
                                        </div>
                                    </div>
                                </article>
                            </li>
                        </ul>
                        <div v-if="overCol === col.key && canDropOn(col.key)" class="atlas-dropzone">Nach „{{ col.name }}“ verschieben</div>
                        <p v-if="!col.items.length && !(overCol === col.key && canDropOn(col.key))" class="atlas-col-empty">Gerade nichts hier.</p>
                        <div v-if="col.key === 'planned'" class="atlas-col-foot">
                            <button type="button" class="atlas-col-foot-btn" @click="newPub"><atlas-icon name="plus" :size="16" /> Neues Vorhaben</button>
                            <button type="button" class="atlas-col-foot-btn" @click="planOpen = true"><atlas-icon name="stack" :size="16" /> Aus Sammlung planen</button>
                        </div>
                        <div v-if="col.key === 'published'" class="atlas-col-foot">
                            <router-link :to="listRoute" class="atlas-col-foot-btn is-link">
                                Ganze Publikationsliste <atlas-icon name="arrow" :size="15" />
                            </router-link>
                        </div>
                    </section>
                </div>
            </div>

            <div class="atlas-folds">
                <button type="button" class="atlas-fold-btn" :aria-expanded="showClosed ? 'true' : 'false'"
                        :disabled="!closed.length" @click="showClosed = !showClosed">
                    <atlas-icon :name="showClosed ? 'chevronLeft' : 'chevronRight'" :size="16" />
                    Abgelehnt oder zurückgezogen · {{ closed.length }}
                </button>
                <button type="button" class="atlas-fold-btn" :aria-expanded="showOrphans ? 'true' : 'false'"
                        :disabled="!orphans.length" @click="showOrphans = !showOrphans">
                    <atlas-icon :name="showOrphans ? 'chevronLeft' : 'chevronRight'" :size="16" />
                    LaTeX-Manuskript ohne Veröffentlichung · {{ orphans.length }}
                </button>
            </div>
            <ul v-if="showClosed && closed.length" class="atlas-fold-list" aria-label="Abgelehnt oder zurückgezogen">
                <li v-for="p in closed" :key="p.id" class="atlas-fold-row">
                    <span class="atlas-badge">{{ statusLabel(p.status) }}</span>
                    <router-link :to="detailRoute(p.id)" class="atlas-notes-title">{{ p.title }}</router-link>
                    <span class="atlas-muted">{{ p.venue || '' }}</span>
                </li>
            </ul>
            <ul v-if="showOrphans && orphans.length" class="atlas-fold-list" aria-label="LaTeX-Manuskripte ohne Veröffentlichung">
                <li v-for="m in orphans" :key="m.id" class="atlas-fold-row">
                    <span class="atlas-badge">LaTeX</span>
                    <router-link :to="editorRoute(m.id)" class="atlas-notes-title">{{ m.id }}.tex</router-link>
                </li>
            </ul>

            <atlas-plan-dialog v-if="planOpen" @close="closePlan" @changed="load(true)" />
        </div>
    `,
    data() {
        return {
            pubs: [],
            chapters: [],
            orphans: [],
            loading: true,
            dragging: null,
            overCol: null,
            showClosed: false,
            showOrphans: false,
            planOpen: false,
            busy: false,
        };
    },
    computed: {
        chapterOf() {
            const map = {};
            for (const c of this.chapters) {
                for (const pid of c.publications || []) if (!map[pid]) map[pid] = c;
            }
            return map;
        },
        columns() {
            return ATLAS_PIPELINE.map((st) => ({
                ...st,
                items: this.pubs.filter((p) => (p.status || 'planned') === st.key).map((p) => this.card(p)),
            }));
        },
        closed() { return this.pubs.filter((p) => ATLAS_PIPELINE_CLOSED.has(p.status)); },
        summary() {
            const mine = this.pubs.filter((p) => p.status === 'drafting' || p.status === 'in-revision').length;
            const waiting = this.pubs.filter((p) => p.status === 'submitted').length;
            const pub = this.pubs.filter((p) => p.status === 'published').length;
            return mine + ' warten auf dich · ' + waiting + ' beim Journal · ' + pub + ' veröffentlicht';
        },
        dragPub() { return this.pubs.find((p) => p.id === this.dragging) || null; },
        listRoute() { return atlasPublicationListRoute(); },
    },
    methods: {
        detailRoute(id) { return atlasPublicationRoute(id); },
        editorRoute(id) { return atlasEditorRoute(id); },
        statusLabel(s) { return ATLAS_PUBLICATION_STATUS_LABEL[s] || s; },
        newPub() { atlasOpenNew('pub'); },
        closePlan() {
            this.planOpen = false;
            if (this.$route.query.planen) this.$router.replace(ATLAS_PUBLICATIONS_ROUTE);
        },
        // Badge je Spalte: Frist oder Wartezeit (Design „Veroeffentlichungen").
        timer(p) {
            const today = atlasTodayIso();
            const dueIn = p.due ? atlasDaysBetween(today, p.due) : null;
            const dueText = (label) => {
                if (dueIn === null) return null;
                if (dueIn < 0) return { text: label + ' überfällig seit ' + (-dueIn) + (dueIn === -1 ? ' Tag' : ' Tagen'), tone: 'danger', icon: 'alert' };
                if (dueIn === 0) return { text: label + ' heute', tone: 'soon', icon: 'flag' };
                return { text: label + ' in ' + dueIn + (dueIn === 1 ? ' Tag' : ' Tagen'), tone: 'soon', icon: 'flag' };
            };
            if (p.status === 'planned' || p.status === 'drafting') return dueText('Frist');
            if (p.status === 'submitted') {
                const ago = p.submitted ? atlasDaysBetween(p.submitted, today) : null;
                if (ago === null) return { text: 'beim Journal', tone: 'wait', icon: 'clock' };
                if (ago <= 0) return { text: 'heute eingereicht', tone: 'wait', icon: 'clock' };
                if (ago > ATLAS_SUBMITTED_NUDGE_DAYS) return { text: 'seit ' + ago + ' Tagen beim Journal – nachfragen?', tone: 'warn', icon: 'alert' };
                return { text: 'seit ' + ago + (ago === 1 ? ' Tag' : ' Tagen') + ' beim Journal', tone: 'wait', icon: 'clock' };
            }
            if (p.status === 'in-revision') {
                return dueText('Revision fällig') || { text: 'Revisionsfrist eintragen', tone: 'warn', icon: 'alert' };
            }
            if (p.status === 'published') {
                if (!p.paper) return { text: 'DOI fehlt noch', tone: 'warn', icon: 'alert' };
                const year = (p.published || '').slice(0, 4);
                return { text: year ? 'Veröffentlicht ' + year : 'Veröffentlicht', tone: 'ok', icon: 'check' };
            }
            return null;
        },
        card(p) {
            const typeLabel = ATLAS_PUBLICATION_TYPE_LABEL[p.type] || '';
            const links = [];
            if (p.collection) {
                links.push({ kind: 'Sammlung', label: (p.collection.name || p.title) + ' · ' + (p.collection.item_count || 0) });
            }
            for (const m of p.manuscripts || []) links.push({ kind: 'LaTeX', label: /\.tex$/i.test(m) ? m : m + '.tex' });
            const ch = this.chapterOf[p.id];
            if (ch) links.push({ kind: 'Kapitel', label: ch.title || ch.id });
            if (p.status === 'planned') {
                for (const iid of p.derived_from || []) {
                    const e = atlasEntity(iid);
                    links.push({ kind: 'Idee', label: (e && e.title) || iid });
                }
            }
            if (p.status === 'published' && p.paper) links.push({ kind: 'Bibliothek', label: p.paper });
            const check = p.checklist || {};
            const progress = p.status === 'in-revision' && check.total
                ? { pct: Math.round(check.done / check.total * 100) + '%', text: check.done + ' von ' + check.total + ' Gutachter-Punkten erledigt' }
                : null;
            return {
                id: p.id,
                title: p.title,
                status: p.status,
                venueLine: [p.venue || 'Ziel noch offen', typeLabel].filter(Boolean).join(' · '),
                coauthors: (p.authors || []).length ? 'mit ' + p.authors.join(', ') : '',
                timer: this.timer(p),
                progress,
                links,
            };
        },
        async load(silent = false) {
            if (!silent) this.loading = true;
            const [pubs, diss, orphans] = await Promise.all([
                api('/api/plugins/atlas/publications').catch(() => null),
                api('/api/plugins/atlas/diss').catch(() => null),
                api('/api/plugins/atlas/manuscripts/unassigned').catch(() => null),
            ]);
            if (pubs) this.pubs = pubs.publications || [];
            if (diss) this.chapters = diss.chapters || [];
            if (orphans) this.orphans = orphans.manuscripts || [];
            this.loading = false;
        },
        // Karten: Veröffentlichungen (samt Sammlung), Kapitel, Manuskripte.
        reloadFor(kinds) {
            if (atlasTouches(kinds, ['publication', 'collection', 'diss_node', 'manuscript'])) return this.load(true);
            return null;
        },
        canDropOn(key) {
            return !!this.dragPub && this.dragPub.status !== key;
        },
        onDragStart(e, p) {
            try {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', p.id);
            } catch (err) { /* Browser ohne DataTransfer */ }
            this.dragging = p.id;
        },
        onDragEnd() {
            this.dragging = null;
            this.overCol = null;
        },
        onDragOver(e, key) {
            if (!this.dragging) return;
            e.preventDefault();
            try { e.dataTransfer.dropEffect = 'move'; } catch (err) { /* ignore */ }
            this.overCol = key;
        },
        onDragLeave(e, key) {
            const to = e.relatedTarget;
            if (to && e.currentTarget && e.currentTarget.contains(to)) return;
            if (this.overCol === key) this.overCol = null;
        },
        async onDrop(e, key) {
            e.preventDefault();
            // Eine Karte ist keine Datei: der Datei-Drop des Kerns (Import)
            // soll davon nichts sehen.
            e.stopPropagation();
            let id = this.dragging;
            if (!id) {
                try { id = e.dataTransfer.getData('text/plain'); } catch (err) { id = null; }
            }
            this.dragging = null;
            this.overCol = null;
            if (id) await this.moveTo(id, key);
        },
        onGripKey(e, p) {
            if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
            e.preventDefault();
            const order = ATLAS_PIPELINE.map((s) => s.key);
            const idx = order.indexOf(p.status) + (e.key === 'ArrowRight' ? 1 : -1);
            if (idx < 0 || idx >= order.length) return;
            this.moveTo(p.id, order[idx], true);
        },
        async moveTo(id, key, keepFocus = false) {
            const pub = this.pubs.find((p) => p.id === id);
            if (!pub || pub.status === key || this.busy) return;
            this.busy = true;
            const before = pub.status;
            pub.status = key;   // optimistisch: die Karte steht sofort in der Zielspalte
            try {
                await atlasChangeStatus(pub, key, () => this.load(true));
            } catch (e) {
                pub.status = before;
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            this.busy = false;
            if (keepFocus) {
                this.$nextTick(() => {
                    const grip = this.$el.querySelector('[data-grip="' + id + '"]');
                    if (grip) grip.focus();
                });
            }
        },
    },
    watch: {
        '$route.query.planen'(v) { if (v) this.planOpen = true; },
    },
    mounted() {
        if (this.$route.query.planen) this.planOpen = true;
        this.load();
        atlasLoadEntities();
        if (!atlasWork.today) atlasRefreshToday();
        this._live = atlasLiveReload((kinds) => this.reloadFor(kinds));
    },
    beforeUnmount() {
        if (this._live) { this._live.close(); this._live = null; }
    },
};

// Der LaTeX-Editor lebt in der Sammlung (Tab „editor"); diese Adresse öffnet
// ihn mit einem Manuskript.
function atlasEditorRoute(id) {
    return { path: '/atlas/sammlung', query: { tab: 'editor', manuscript: id } };
}

// ── Kalender (#224) ─────────────────────────────────────────────────────────
// Die Woche als sieben Tagesspalten plus „Nächste Woche". Aufgaben und
// Termine (Meilensteine der Projekte, Fristen der Veröffentlichungen) zieht
// man per Drag & Drop auf einen anderen Tag — oder per Griff + Alt ← / →.
// Nach jedem Verschieben ein Hinweis mit „Rückgängig": für Aufgaben über
// „Übertrag zurücknehmen" (eine Zeilenoperation, ADR-0020), für Termine wird
// das alte Datum zurückgeschrieben. Der Rückblick ist ein Umschalter; die
// Rückblick-Route öffnet den Kalender in diesem Modus. Die Woche steht im Pfad
// (/atlas/woche/2026-W39), damit Blättern und Lesezeichen dasselbe sind.
const ATLAS_WEEKDAYS_LONG = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
const ATLAS_NEXT = 'next';

function atlasDayLabel(iso) {
    const d = atlasDate(iso);
    return d ? atlasShortDay(iso) + ' ' + d.getDate() + '.' : String(iso || '');
}

function atlasDayLong(iso) {
    const d = atlasDate(iso);
    return d ? ATLAS_WEEKDAYS_LONG[(d.getDay() + 6) % 7] + ', ' + atlasFormatDate(iso, { day: 'numeric', month: 'short' }) : '';
}

const AtlasCalendarPage = {
    components: {
        'atlas-nav': AtlasNav,
        'atlas-header': AtlasHeader,
        'atlas-icon': AtlasIcon,
    },
    template: `
        <div class="atlas-page atlas-shell" lang="de">
            <atlas-header :kicker="'Atlas · Kalender · KW ' + (week ? week.number : '')" :title="rangeTitle">
                <div class="atlas-weekswitch" role="group" aria-label="Woche wechseln">
                    <router-link v-if="week" :to="routeFor(week.previous)" class="atlas-weekswitch-btn"
                                 :aria-label="'Vorige Woche, KW ' + weekNumberOf(week.previous)"><atlas-icon name="chevronLeft" /></router-link>
                    <router-link :to="routeFor('')" class="atlas-weekswitch-btn is-text">Diese Woche</router-link>
                    <router-link v-if="week" :to="routeFor(week.next)" class="atlas-weekswitch-btn"
                                 :aria-label="'Nächste Woche, KW ' + weekNumberOf(week.next)"><atlas-icon name="chevronRight" /></router-link>
                </div>
                <nav class="atlas-seg" aria-label="Ansicht">
                    <router-link :to="weekRoute" class="atlas-seg-item" :class="{ 'is-active': !isReview }" :aria-current="!isReview ? 'page' : null">Woche</router-link>
                    <router-link :to="reviewRoute" class="atlas-seg-item" :class="{ 'is-active': isReview }" :aria-current="isReview ? 'page' : null">Rückblick</router-link>
                </nav>
            </atlas-header>
            <atlas-nav :active="isReview ? 'rueckblick' : 'woche'" />

            <template v-if="!isReview">
                <div class="atlas-cal-hint">
                    <span class="atlas-hint-line">
                        <span class="atlas-hint-grip"><atlas-icon name="grip" :size="16" /></span>
                        Aufgaben und Termine einfach auf einen anderen Tag ziehen.
                    </span>
                    <span class="atlas-muted">Tastatur: Griff mit Tab wählen, dann Alt + ← / →</span>
                    <span class="atlas-cal-legend">
                        <span><i class="atlas-legend-box"></i>Aufgabe</span>
                        <span><atlas-icon name="flag" :size="14" />Termin / Meilenstein</span>
                        <button type="button" class="atlas-text-btn" :disabled="!week" @click="openWeekFile">Wochendatei öffnen</button>
                    </span>
                </div>

                <section aria-label="Wochenziele" class="atlas-cal-goals">
                    <span class="atlas-group-label is-flat is-inline">Wochenziele</span>
                    <span v-if="!goals.length" class="atlas-muted">Noch keine Ziele für diese Woche.</span>
                    <div v-for="g in goals" :key="g.index" class="atlas-cal-goal">
                        <span class="atlas-cal-goal-title">{{ g.title }}</span>
                        <template v-if="goalReached(g)">
                            <span class="atlas-reached"><atlas-icon name="check" :size="14" /> erreicht</span>
                        </template>
                        <template v-else>
                            <span class="atlas-meter is-mini"><span class="atlas-meter-fill" :style="{ width: goalPercent(g) }"></span></span>
                            <span v-if="g.total" class="atlas-mono-sub is-ink">{{ g.done_count }}/{{ g.total }}</span>
                        </template>
                    </div>
                    <button type="button" class="atlas-text-btn" :disabled="!week" @click="openGoals">
                        {{ goals.length ? 'Ziele bearbeiten' : 'Ziele festlegen' }}
                    </button>
                </section>

                <div v-if="goalsOpen" class="atlas-modal-backdrop" @click.self="goalsOpen = false" @keydown.esc="goalsOpen = false">
                    <form class="atlas-modal" role="dialog" aria-modal="true" aria-labelledby="atlas-goals-h" @submit.prevent="saveGoals">
                        <div class="atlas-new-head">
                            <div>
                                <h2 id="atlas-goals-h" class="atlas-modal-title">Wochenziele KW {{ week ? week.number : '' }}</h2>
                                <p class="atlas-modal-sub">Bis zu fünf. Mit Anker oder Schlagwort zählt der Fortschritt die passenden Aufgaben der Woche, sonst das Häkchen.</p>
                            </div>
                            <button type="button" class="atlas-icon-square" aria-label="Schließen" @click="goalsOpen = false"><atlas-icon name="close" /></button>
                        </div>
                        <div class="atlas-new-form">
                            <div v-for="(g, i) in goalDrafts" :key="i" class="atlas-goal-edit">
                                <input type="checkbox" class="atlas-check" v-model="g.done" :aria-label="'Erreicht: ' + (g.title || 'Ziel ' + (i + 1))" />
                                <input v-model="g.title" class="atlas-input" :aria-label="'Titel von Ziel ' + (i + 1)" placeholder="z. B. Kapitel 3 an die Betreuerin schicken" />
                                <input v-model="g.anchor" class="atlas-input is-narrow" list="atlas-goal-entities" :aria-label="'Anker von Ziel ' + (i + 1)" placeholder="Anker, z. B. kapitel-03" />
                                <input v-model="g.tag" class="atlas-input is-narrow" :aria-label="'Schlagwort von Ziel ' + (i + 1)" placeholder="#tag" />
                                <button type="button" class="atlas-icon-btn is-danger" :aria-label="'Ziel ' + (i + 1) + ' entfernen'" @click="goalDrafts.splice(i, 1)">✕</button>
                            </div>
                            <datalist id="atlas-goal-entities">
                                <option v-for="e in entities" :key="e.id" :value="e.id">{{ e.title }}</option>
                            </datalist>
                            <div class="atlas-row-gap">
                                <button type="button" class="atlas-btn is-small" :disabled="goalDrafts.length >= 5" @click="goalDrafts.push({ title: '', anchor: '', tag: '', done: false })">
                                    <atlas-icon name="plus" :size="16" /> Ziel hinzufügen
                                </button>
                                <button v-if="week && week.previous" type="button" class="atlas-btn is-small" :disabled="savingGoals" @click="adoptGoals">
                                    Offene Ziele der Vorwoche übernehmen
                                </button>
                            </div>
                        </div>
                        <div class="atlas-new-foot">
                            <span class="atlas-muted">Gespeichert wird nur die Kopfzeile der Wochendatei – die Aufgaben bleiben, wie sie sind.</span>
                            <div class="atlas-row-gap">
                                <button type="button" class="atlas-btn" @click="goalsOpen = false">Abbrechen</button>
                                <button type="submit" class="atlas-btn is-primary" :disabled="savingGoals">{{ savingGoals ? 'Speichert…' : 'Speichern' }}</button>
                            </div>
                        </div>
                    </form>
                </div>

                <section v-if="tray.length" class="atlas-tray" aria-labelledby="atlas-h-tray"
                         @dragover="onDragOver($event, 'tray')" @drop.prevent="onDropTray">
                    <div class="atlas-tray-head">
                        <h2 id="atlas-h-tray" class="atlas-carry-title"><atlas-icon name="clock" :size="16" /> Liegen geblieben · {{ tray.length }}</h2>
                        <span class="atlas-muted">Offen aus den letzten Tagen – auf einen Tag ziehen, um es neu zu planen.</span>
                    </div>
                    <ul class="atlas-tray-list">
                        <li v-for="c in tray" :key="c.key" class="atlas-tray-li" :class="{ 'is-dragging': dragging === c.key }"
                            draggable="true" :data-card="c.key" @dragstart="onDragStart($event, c)" @dragend="onDragEnd">
                            <div class="atlas-ccard" :class="c.kind === 'task' ? '' : 'is-term' + (c.overdue ? ' is-overdue' : '')">
                                <button type="button" class="atlas-grip" :data-grip="c.key" :aria-label="gripLabel(c)"
                                        title="Ziehen oder Alt + Pfeiltaste" @keydown="onGripKey($event, c)"><atlas-icon name="grip" :size="16" /></button>
                                <template v-if="c.kind === 'task'">
                                    <input type="checkbox" class="atlas-check is-small" :id="'atlas-tr-' + c.key" :checked="c.task.done" @change="toggle(c.task)" />
                                    <div class="atlas-ccard-body">
                                        <label :for="'atlas-tr-' + c.key" class="atlas-ccard-text">{{ c.title }}</label>
                                        <span class="atlas-ccard-meta">{{ c.meta }}</span>
                                    </div>
                                </template>
                                <template v-else>
                                    <span class="atlas-ccard-flag"><atlas-icon :name="c.overdue ? 'alert' : 'flag'" :size="16" /></span>
                                    <div class="atlas-ccard-body">
                                        <span class="atlas-ccard-kicker">{{ c.kicker }}</span>
                                        <span class="atlas-ccard-text is-strong">{{ c.title }}</span>
                                        <span class="atlas-ccard-meta">{{ c.meta }}</span>
                                    </div>
                                </template>
                            </div>
                        </li>
                    </ul>
                </section>

                <div class="atlas-board-scroll">
                    <div class="atlas-calgrid">
                        <section v-for="col in columns" :key="col.key" class="atlas-calcol"
                                 :class="{ 'is-today': col.isToday, 'is-weekend': col.weekend, 'is-next': col.key === 'next', 'is-over': canDropOn(col.key) && overCol === col.key }"
                                 :aria-label="col.aria" :data-col="col.key"
                                 @dragover="onDragOver($event, col.key)" @dragleave="onDragLeave($event, col.key)" @drop="onDrop($event, col.key)">
                            <header class="atlas-calcol-head">
                                <template v-if="col.key !== 'next'">
                                    <div class="atlas-calcol-day">
                                        <span class="atlas-calcol-short">{{ col.short }}</span>
                                        <span class="atlas-calcol-num">{{ col.num }}</span>
                                        <span v-if="col.isToday" class="atlas-today-pill">Heute</span>
                                    </div>
                                    <span v-if="col.total" class="atlas-mono-sub">{{ col.done }}/{{ col.total }}</span>
                                </template>
                                <template v-else>
                                    <div class="atlas-calcol-nextt">
                                        <span class="atlas-calcol-short">Nächste Woche</span>
                                        <span class="atlas-calcol-nextrange">{{ col.range }}</span>
                                    </div>
                                    <atlas-icon name="arrow" :size="16" />
                                </template>
                            </header>
                            <ul class="atlas-calcards">
                                <li v-for="c in col.cards" :key="c.key" class="atlas-cal-li"
                                    :class="{ 'is-dragging': dragging === c.key }" :data-card="c.key"
                                    :draggable="c.draggable ? 'true' : 'false'"
                                    @dragstart="onDragStart($event, c)" @dragend="onDragEnd"
                                    @dragover="onCardDragOver($event, c)" @drop="onCardDrop($event, c)">
                                    <div class="atlas-ccard" :class="cardClass(c)">
                                        <button v-if="c.draggable" type="button" class="atlas-grip" :data-grip="c.key"
                                                :aria-label="gripLabel(c)" title="Ziehen oder Alt + Pfeiltaste"
                                                @keydown="onGripKey($event, c)"><atlas-icon name="grip" :size="16" /></button>
                                        <span v-else class="atlas-grip-space"></span>
                                        <template v-if="c.kind === 'task'">
                                            <input type="checkbox" class="atlas-check is-small" :id="'atlas-cc-' + c.key" :checked="c.task.done"
                                                   :disabled="!!c.task.moved_to" @change="toggle(c.task)" />
                                            <div class="atlas-ccard-body">
                                                <input v-if="editing === c.key" :ref="'edit-' + c.key" v-model="editText" class="atlas-ccard-edit"
                                                       aria-label="Aufgabentext bearbeiten" @keydown.enter.prevent="saveEdit(c)"
                                                       @keydown.esc.prevent="editing = ''" @blur="saveEdit(c)" />
                                                <label v-else :for="'atlas-cc-' + c.key" class="atlas-ccard-text">{{ c.title }}</label>
                                                <span v-if="c.meta" class="atlas-ccard-meta">{{ c.meta }}</span>
                                            </div>
                                            <span v-if="!c.task.moved_to && editing !== c.key" class="atlas-ccard-tools">
                                                <button type="button" class="atlas-icon-btn" :aria-label="'Aufgabe bearbeiten: ' + c.title" @click="startEdit(c)">✎</button>
                                                <button type="button" class="atlas-icon-btn is-danger" :aria-label="'Aufgabe löschen: ' + c.title" @click="remove(c.task)">✕</button>
                                            </span>
                                        </template>
                                        <template v-else>
                                            <span class="atlas-ccard-flag"><atlas-icon :name="c.overdue ? 'alert' : 'flag'" :size="16" /></span>
                                            <div class="atlas-ccard-body">
                                                <span class="atlas-ccard-kicker">{{ c.kicker }}</span>
                                                <router-link v-if="c.open" :to="c.open" class="atlas-ccard-text is-strong is-link" draggable="false">{{ c.title }}</router-link>
                                                <span v-else class="atlas-ccard-text is-strong">{{ c.title }}</span>
                                                <span class="atlas-ccard-meta">{{ c.meta }}</span>
                                            </div>
                                        </template>
                                    </div>
                                </li>
                            </ul>
                            <div v-if="canDropOn(col.key) && overCol === col.key" class="atlas-dropzone is-small">{{ col.dropText }}</div>
                            <p v-else-if="!col.cards.length && col.key !== 'next'" class="atlas-col-empty">Nichts geplant</p>
                            <template v-if="col.key !== 'next'">
                                <input v-if="adding === col.key" :id="'atlas-add-' + col.key" v-model="addText" class="atlas-input is-date"
                                       :aria-label="'Neue Aufgabe am ' + col.long" placeholder="Aufgabe …"
                                       @keydown.enter.prevent="createTask(col.key)" @keydown.esc.prevent="stopAdd" @blur="stopAdd" />
                                <button v-else type="button" class="atlas-col-foot-btn is-bottom" @click="startAdd(col.key)">
                                    <atlas-icon name="plus" :size="16" /> Aufgabe
                                </button>
                            </template>
                            <p v-else class="atlas-next-drop">Hierher ziehen, um es auf nächste Woche zu schieben</p>
                        </section>
                    </div>
                </div>
            </template>

            <section v-else class="atlas-panel is-padded atlas-review-panel" aria-labelledby="atlas-h-rueck">
                <div>
                    <h2 id="atlas-h-rueck" class="atlas-panel-title">Rückblick auf KW {{ week ? week.number : '' }}</h2>
                    <p class="atlas-muted" style="margin:6px 0 0">Wird aus der Woche berechnet – nichts muss von Hand eingetragen werden.</p>
                </div>
                <div class="atlas-review-grid">
                    <div class="atlas-review-card"><div class="atlas-review-big">{{ review.tasks.done }}<span class="atlas-tile-of"> / {{ review.tasks.total }}</span></div><div>Aufgaben erledigt</div></div>
                    <div class="atlas-review-card"><div class="atlas-review-big">{{ review.tasks.moved }}</div><div>verschoben</div></div>
                    <div class="atlas-review-card"><div class="atlas-review-big">{{ review.goals.reached }}<span class="atlas-tile-of"> / {{ review.goals.total }}</span></div><div>Wochenziele erreicht</div></div>
                    <div class="atlas-review-card"><div class="atlas-review-big">{{ review.zettel.length }}</div><div>Notizen geschrieben</div></div>
                    <div class="atlas-review-card"><div class="atlas-review-big">{{ review.chapters.length }}</div><div>Kapitel bearbeitet</div></div>
                </div>
                <div v-if="review.carried.length || review.zettel.length || review.chapters.length" class="atlas-review-lists">
                    <div v-if="review.carried.length">
                        <div class="atlas-group-label is-flat">Mehrfach übertragen</div>
                        <ul class="atlas-notes"><li v-for="c in review.carried" :key="c.text" class="atlas-notes-row">
                            <span class="atlas-notes-title">{{ c.text }}</span><span class="atlas-notes-when">{{ c.moves }}× verschoben</span>
                        </li></ul>
                    </div>
                    <div v-if="review.zettel.length">
                        <div class="atlas-group-label is-flat">Notizen dieser Woche</div>
                        <ul class="atlas-notes"><li v-for="z in review.zettel" :key="z.id" class="atlas-notes-row">
                            <router-link :to="'/atlas/zettel/' + encodeURIComponent(z.id)" class="atlas-notes-title">{{ z.title }}</router-link>
                            <span class="atlas-notes-when">{{ dayLabel(z.date) }}</span>
                        </li></ul>
                    </div>
                    <div v-if="review.chapters.length">
                        <div class="atlas-group-label is-flat">Kapitel bearbeitet</div>
                        <ul class="atlas-notes"><li v-for="c in review.chapters" :key="c.id" class="atlas-notes-row">
                            <router-link :to="{ path: '/atlas/sammlung', query: { tab: 'dissertation', chapter: c.id } }" class="atlas-notes-title">{{ c.title || c.id }}</router-link>
                            <span class="atlas-notes-when">{{ dayLabel(c.modified_at) }}</span>
                        </li></ul>
                    </div>
                </div>
                <div class="atlas-row-gap">
                    <button type="button" class="atlas-btn is-primary is-tall" :disabled="reviewBusy || !week" @click="reviewZettel">
                        {{ reviewBusy ? 'Legt an…' : 'Rückblick als Notiz speichern' }}
                    </button>
                    <router-link :to="weekRoute" class="atlas-btn is-tall">Zurück zur Woche</router-link>
                </div>
            </section>
        </div>
    `,
    data() {
        return {
            week: null,
            nextWeek: null,
            today: null,
            projects: [],
            publications: [],
            loading: true,
            dragging: null,
            overCol: null,
            busy: false,
            adding: '',
            addText: '',
            editing: '',
            editText: '',
            reviewBusy: false,
            goalsOpen: false,
            goalDrafts: [],
            savingGoals: false,
        };
    },
    computed: {
        isReview() { return this.$route.path.startsWith('/atlas/rueckblick'); },
        weekId() { return this.week ? this.week.week : ''; },
        weekRoute() { return '/atlas/woche' + (this.weekId ? '/' + this.weekId : ''); },
        reviewRoute() { return '/atlas/rueckblick' + (this.weekId ? '/' + this.weekId : ''); },
        todayIso() { return (this.today && this.today.date) || atlasWork.today || atlasIso(new Date()); },
        days() { return (this.week && this.week.days) || []; },
        goals() { return (this.week && this.week.goals) || []; },
        rangeTitle() {
            if (this.days.length < 7) return 'Kalender';
            const a = atlasDate(this.days[0].date);
            const b = atlasDate(this.days[6].date);
            const month = (d) => d.toLocaleDateString('de-DE', { month: 'long' });
            if (a.getMonth() === b.getMonth()) return a.getDate() + '.–' + b.getDate() + '. ' + month(b);
            return a.getDate() + '. ' + month(a) + ' – ' + b.getDate() + '. ' + month(b);
        },
        nextMonday() {
            return this.days.length === 7 ? atlasAddDays(this.days[6].date, 1) : atlasNextMonday(this.todayIso);
        },
        isCurrentWeek() { return this.days.some((d) => d.date === this.todayIso); },
        // Termine: Meilensteine der Projekte und Fristen offener
        // Veröffentlichungen, mit Datum; überfällig = vor heute, nicht erledigt.
        terms() {
            const out = [];
            for (const p of this.projects) {
                (p.milestones || []).forEach((m, i) => {
                    const date = String(m.date || '').slice(0, 10);
                    if (!atlasDate(date)) return;
                    out.push({
                        key: 'ms:' + p.id + ':' + i, kind: 'milestone', date, done: !!m.done,
                        title: m.title || 'Meilenstein', meta: p.title || p.id, project: p, index: i,
                        open: { path: '/atlas/sammlung', query: { tab: 'projekte', proj: p.id } },
                    });
                });
            }
            for (const p of this.publications) {
                const date = String(p.due || '').slice(0, 10);
                if (!atlasDate(date) || ATLAS_PIPELINE_CLOSED.has(p.status) || p.status === 'published') continue;
                out.push({
                    key: 'due:' + p.id, kind: 'deadline', date, done: false,
                    title: p.title, meta: 'Veröffentlichung', publication: p,
                    open: atlasPublicationRoute(p.id),
                });
            }
            for (const t of out) {
                t.overdue = !t.done && t.date < this.todayIso;
                const label = t.kind === 'milestone' ? 'Meilenstein' : 'Frist';
                t.kicker = label + (t.overdue ? ' · überfällig' : '');
                t.draggable = !t.done;
            }
            return out;
        },
        tray() {
            if (!this.isCurrentWeek) return [];
            // Offenes aus früheren Tagen DIESER Woche steht schon in seiner
            // Spalte — die Leiste trägt nur, was davor liegen blieb.
            const first = this.days[0].date;
            const tasks = ((this.today && this.today.carry_over) || [])
                .filter((t) => !t.day || t.day < first)
                .map((t) => this.taskCard(t, true));
            const overdue = this.terms.filter((t) => t.overdue && t.date < this.days[0].date)
                .map((t) => ({ ...t, meta: t.meta + ' · fällig war ' + atlasDayLabel(t.date) }));
            return [...overdue, ...tasks];
        },
        columns() {
            const cols = this.days.map((d) => {
                const tasks = (d.tasks || []).map((t) => this.taskCard(t, false));
                const terms = this.terms.filter((t) => t.date === d.date);
                const open = (d.tasks || []).filter((t) => !t.moved_to);
                return {
                    key: d.date,
                    short: atlasShortDay(d.date),
                    num: atlasDate(d.date).getDate(),
                    long: atlasDayLong(d.date),
                    isToday: d.date === this.todayIso,
                    weekend: (atlasDate(d.date).getDay() % 6) === 0,
                    cards: [...terms, ...tasks],
                    total: open.length,
                    done: open.filter((t) => t.done).length,
                    dropText: 'Auf ' + atlasDayLabel(d.date) + ' legen',
                    aria: atlasDayLong(d.date) + ', ' + open.length + ' Aufgaben',
                };
            });
            if (cols.length) {
                const nextDays = new Set();
                for (let i = 0; i < 7; i += 1) nextDays.add(atlasAddDays(this.nextMonday, i));
                const nextTasks = ((this.nextWeek && this.nextWeek.tasks) || [])
                    .filter((t) => !t.moved_to).map((t) => this.taskCard(t, false));
                const nextTerms = this.terms.filter((t) => nextDays.has(t.date))
                    .map((t) => ({ ...t, kicker: t.kicker + ' · ' + atlasDayLabel(t.date) }));
                const end = atlasAddDays(this.nextMonday, 6);
                cols.push({
                    key: ATLAS_NEXT,
                    range: 'KW ' + this.weekNumberOf(this.week && this.week.next) + ' · '
                        + atlasDate(this.nextMonday).getDate() + '.–' + atlasDate(end).getDate() + '.',
                    cards: [...nextTerms, ...nextTasks],
                    dropText: 'In KW ' + this.weekNumberOf(this.week && this.week.next) + ' schieben',
                    aria: 'Nächste Woche',
                });
            }
            return cols;
        },
        allCards() {
            const out = {};
            for (const c of this.tray) out[c.key] = c;
            for (const col of this.columns) for (const c of col.cards) out[c.key] = c;
            return out;
        },
        dragCard() { return this.dragging ? this.allCards[this.dragging] || null : null; },
        entities() { return atlasWork.entities; },
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
    },
    methods: {
        weekNumberOf(week) { return atlasWeekNumber(week); },  // fürs Template
        // --- Wochenziele (Kopfzeile der Wochendatei, ADR-0020) -------------
        openGoals() {
            this.goalDrafts = this.goals.map((g) => ({
                title: g.title || '', anchor: g.anchor || '', tag: g.tag ? '#' + g.tag : '', done: !!g.done,
            }));
            if (!this.goalDrafts.length) this.goalDrafts.push({ title: '', anchor: '', tag: '', done: false });
            this.goalsOpen = true;
        },
        async saveGoals() {
            if (!this.week || this.savingGoals) return;
            const goals = this.goalDrafts
                .filter((g) => g.title.trim())
                .map((g) => ({
                    title: g.title.trim(),
                    anchor: g.anchor.trim() || null,
                    tag: g.tag.trim().replace(/^#/, '') || null,
                    done: !!g.done,
                }));
            this.savingGoals = true;
            try {
                await api('/api/plugins/atlas/journal/' + encodeURIComponent(this.week.week) + '/goals', {
                    method: 'PUT', body: JSON.stringify({ goals }),
                });
                this.goalsOpen = false;
                atlasToast('Wochenziele gespeichert.');
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            this.savingGoals = false;
            await this.load(true);
        },
        async adoptGoals() {
            if (!this.week || this.savingGoals) return;
            this.savingGoals = true;
            try {
                await api('/api/plugins/atlas/journal/' + encodeURIComponent(this.week.week) + '/goals/adopt', { method: 'POST' });
                await this.load(true);
                this.openGoals();
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            this.savingGoals = false;
        },
        routeFor(week) { return (this.isReview ? '/atlas/rueckblick' : '/atlas/woche') + (week ? '/' + week : ''); },
        dayLabel(iso) { return atlasDayLabel(String(iso || '').slice(0, 10)); },
        goalReached(g) { return !!g.done || (g.total > 0 && g.done_count === g.total); },
        goalPercent(g) { return Math.round((g.progress || 0) * 100) + '%'; },
        cardClass(c) {
            if (c.kind === 'task') return { 'is-done': c.task.done, 'is-moved': !!c.task.moved_to };
            return { 'is-term': true, 'is-overdue': c.overdue, 'is-done': c.done };
        },
        gripLabel(c) {
            const what = c.kind === 'task' ? 'Aufgabe' : (c.kind === 'milestone' ? 'Meilenstein' : 'Frist');
            return what + ' verschieben: ' + c.title;
        },
        // Eine Aufgabe als Karte. `fromTray`: aus „Liegen geblieben" (offen seit …).
        taskCard(t, fromTray) {
            const meta = [];
            for (const a of t.anchors || []) {
                const e = atlasEntity(a);
                meta.push((e && e.title) || a);
            }
            for (const tag of t.tags || []) meta.push('#' + tag);
            if (fromTray && t.day) meta.push('offen seit ' + atlasDayLabel(t.day));
            if (t.moved_from) meta.push('von ' + atlasDayLabel(t.moved_from));
            if (t.moved_to) meta.push('→ ' + atlasDayLabel(t.moved_to));
            return {
                key: 't:' + t.week + '#' + t.body_index,
                kind: 'task',
                task: t,
                title: t.text || '(leere Zeile)',
                meta: meta.join(' · '),
                date: t.day,
                draggable: !t.done && !t.moved_to,
            };
        },
        canDropOn(key) {
            const c = this.dragCard;
            if (!c || key === 'tray') return false;
            if (key === ATLAS_NEXT) return true;
            return c.date !== key;
        },
        targetDate(key) { return key === ATLAS_NEXT ? this.nextMonday : key; },
        // --- Laden ----------------------------------------------------------
        // `kinds` (stilles Nachladen) beschränkt auf das Betroffene: Heute und
        // die Wochen (Aufgaben; der Rückblick zählt auch Notizen, Ideen und
        // Kapitel), Termine der Projekte, Fristen der Veröffentlichungen.
        // Ohne `kinds` alles.
        async load(silent = false, kinds = null) {
            if (!silent) this.loading = true;
            const journal = atlasTouches(kinds, ['journal', 'zettel', 'idea', 'diss_node']);
            const withProjects = atlasTouches(kinds, ['project', 'collection']);
            const withPubs = atlasTouches(kinds, ['publication', 'collection']);
            if (journal) {
                let id = this.$route.params.week;
                const today = await atlasRefreshToday();
                if (today) this.today = today;
                if (!id) id = atlasWork.week;
                if (!id) { this.loading = false; return; }
                try {
                    this.week = await api('/api/plugins/atlas/journal/' + encodeURIComponent(id));
                } catch (e) {
                    if (!silent) atlasToast(atlasErrorText(e), { tone: 'danger' });
                }
            }
            const [next, projects, pubs] = await Promise.all([
                journal && this.week ? api('/api/plugins/atlas/journal/' + encodeURIComponent(this.week.next)).catch(() => null) : null,
                withProjects ? api('/api/plugins/atlas/projects').catch(() => null) : null,
                withPubs ? api('/api/plugins/atlas/publications').catch(() => null) : null,
            ]);
            if (journal) this.nextWeek = next;
            if (projects) this.projects = projects.projects || [];
            if (pubs) this.publications = pubs.publications || [];
            this.loading = false;
        },
        reloadFor(kinds) { return this.load(true, kinds); },
        // --- Drag & Drop ----------------------------------------------------
        onDragStart(e, c) {
            if (!c.draggable) { e.preventDefault(); return; }
            try {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', c.key);
            } catch (err) { /* ignore */ }
            this.dragging = c.key;
        },
        onDragEnd() { this.dragging = null; this.overCol = null; },
        onDragOver(e, key) {
            if (!this.dragging) return;
            e.preventDefault();
            try { e.dataTransfer.dropEffect = 'move'; } catch (err) { /* ignore */ }
            this.overCol = key;
        },
        onDragLeave(e, key) {
            const to = e.relatedTarget;
            if (to && e.currentTarget && e.currentTarget.contains(to)) return;
            if (this.overCol === key) this.overCol = null;
        },
        draggedKey(e) {
            if (this.dragging) return this.dragging;
            try { return e.dataTransfer.getData('text/plain') || null; } catch (err) { return null; }
        },
        async onDrop(e, key) {
            e.preventDefault();
            e.stopPropagation();
            const card = this.allCards[this.draggedKey(e)];
            this.onDragEnd();
            if (card) await this.moveCard(card, key);
        },
        onDropTray(e) { e.stopPropagation(); this.onDragEnd(); },
        // Innerhalb eines Tages: auf eine andere Aufgabe fallen lassen ändert
        // die Reihenfolge (bestehender Reorder-Endpunkt).
        onCardDragOver(e, target) {
            const card = this.dragCard;
            if (!card || card.kind !== 'task' || target.kind !== 'task') return;
            if (card.task.week !== target.task.week || card.task.day !== target.task.day) return;
            e.preventDefault();
            e.stopPropagation();
            this.overCol = null;
        },
        async onCardDrop(e, target) {
            const card = this.allCards[this.draggedKey(e)];
            if (!card || card.kind !== 'task' || target.kind !== 'task') return;
            if (card.task.week !== target.task.week || card.task.day !== target.task.day) return;
            e.preventDefault();
            e.stopPropagation();
            this.onDragEnd();
            if (card.key === target.key) return;
            await this.reorder(card.task, target.task);
        },
        onGripKey(e, c) {
            if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
            e.preventDefault();
            const order = this.days.map((d) => d.date).concat([ATLAS_NEXT]);
            let idx;
            const inWeek = order.indexOf(c.date);
            if (inWeek < 0) {
                // Aus „Liegen geblieben" oder der Folgewoche: → legt auf heute
                // bzw. den Sonntag, ← schiebt einen Tag früher.
                const step = e.key === 'ArrowRight' ? 1 : -1;
                const target = c.date && c.date >= this.nextMonday
                    ? atlasAddDays(c.date, step)
                    : (step > 0 ? (this.isCurrentWeek ? this.todayIso : this.days[0].date) : null);
                if (target) this.moveCard(c, target, true);
                return;
            }
            idx = inWeek + (e.key === 'ArrowRight' ? 1 : -1);
            if (idx < 0) return;
            this.moveCard(c, order[idx], true);
        },
        // --- Verschieben mit Rückgängig ------------------------------------
        async moveCard(card, key, keepFocus = false) {
            const to = this.targetDate(key);
            if (!to || to === card.date || this.busy) return;
            this.busy = true;
            const where = key === ATLAS_NEXT
                ? 'liegt jetzt in KW ' + this.weekNumberOf(this.week && this.week.next) + '.'
                : 'liegt jetzt auf ' + atlasDayLong(to) + '.';
            try {
                if (card.kind === 'task') await this.moveTask(card, to, where);
                else await this.moveTerm(card, to, where);
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            this.busy = false;
            await this.load(true);
            if (keepFocus) this.focusAfterMove(card, to);
        },
        async moveTask(card, to, where) {
            const t = card.task;
            const res = await api('/api/plugins/atlas/journal/' + encodeURIComponent(t.week) + '/tasks/'
                + encodeURIComponent(t.body_index) + '/move', { method: 'POST', body: JSON.stringify({ to }) });
            atlasToast('„' + card.title + '“ ' + where, {
                actionLabel: 'Rückgängig',
                action: async () => {
                    try {
                        await api('/api/plugins/atlas/journal/' + encodeURIComponent(res.source_week) + '/tasks/'
                            + encodeURIComponent(res.source_index) + '/undo-move', {
                            method: 'POST', body: JSON.stringify({ to_week: res.week, to_index: res.body_index }),
                        });
                        atlasToast('Verschieben rückgängig gemacht.');
                    } catch (e) {
                        atlasToast(e && e.message === 'error.atlas.move_changed'
                            ? 'Die Aufgabe wurde seither geändert – zieh sie einfach zurück auf ' + atlasDayLabel(card.date) + '.'
                            : atlasErrorText(e), { tone: 'danger' });
                    }
                    await this.load(true);
                },
            });
        },
        async writeTermDate(card, date) {
            if (card.kind === 'milestone') {
                const milestones = (card.project.milestones || []).map((m, i) => ({
                    title: m.title, date: i === card.index ? date : (m.date || null), done: !!m.done,
                }));
                await api('/api/plugins/atlas/projects/' + encodeURIComponent(card.project.id), {
                    method: 'PUT', body: JSON.stringify({ milestones }),
                });
            } else {
                await api('/api/plugins/atlas/publications/' + encodeURIComponent(card.publication.id), {
                    method: 'PUT', body: JSON.stringify({ due: date }),
                });
            }
        },
        async moveTerm(card, to, where) {
            const before = card.date;
            await this.writeTermDate(card, to);
            atlasToast('„' + card.title + '“ ' + where, {
                actionLabel: 'Rückgängig',
                action: async () => {
                    try {
                        // Die Liste neu lesen: ein anderes Datum der Meilensteine
                        // darf das Zurückschreiben nicht überschreiben.
                        await this.load(true);
                        const fresh = this.terms.find((t) => t.key === card.key) || card;
                        await this.writeTermDate(fresh, before);
                        atlasToast('Verschieben rückgängig gemacht.');
                    } catch (e) {
                        atlasToast(atlasErrorText(e), { tone: 'danger' });
                    }
                    await this.load(true);
                },
            });
        },
        focusAfterMove(card, to) {
            this.$nextTick(() => {
                const col = this.columns.find((c) => c.key === to || (c.key === ATLAS_NEXT && to >= this.nextMonday));
                if (!col) return;
                const same = col.cards.find((c) => c.title === card.title && c.draggable);
                const grip = same && this.$el.querySelector('[data-grip="' + same.key + '"]');
                if (grip) grip.focus();
            });
        },
        async reorder(task, target) {
            const sameDay = this.days.find((d) => d.date === task.day);
            const list = ((sameDay && sameDay.tasks) || []);
            const position = list.findIndex((t) => t.body_index === target.body_index);
            if (position < 0) return;
            try {
                await api('/api/plugins/atlas/journal/' + encodeURIComponent(task.week) + '/tasks/'
                    + encodeURIComponent(task.body_index) + '/reorder', { method: 'POST', body: JSON.stringify({ position }) });
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            await this.load(true);
        },
        // --- Aufgaben -------------------------------------------------------
        taskUrl(t) {
            return '/api/plugins/atlas/journal/' + encodeURIComponent(t.week) + '/tasks/' + encodeURIComponent(t.body_index);
        },
        async toggle(t) {
            try {
                await api(this.taskUrl(t) + '/toggle', { method: 'POST' });
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            await this.load(true);
        },
        async remove(t) {
            try {
                await api(this.taskUrl(t), { method: 'DELETE' });
                atlasToast('Aufgabe gelöscht.');
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            await this.load(true);
        },
        startEdit(c) {
            this.editing = c.key;
            this.editText = c.task.raw || c.task.text || '';
            this.$nextTick(() => {
                const el = this.$refs['edit-' + c.key];
                const input = Array.isArray(el) ? el[0] : el;
                if (input) input.focus();
            });
        },
        async saveEdit(c) {
            if (this.editing !== c.key) return;
            const text = this.editText.trim();
            this.editing = '';
            if (!text || text === (c.task.raw || '')) return;
            try {
                await api(this.taskUrl(c.task), { method: 'PUT', body: JSON.stringify({ text }) });
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            await this.load(true);
        },
        startAdd(day) {
            this.adding = day;
            this.addText = '';
            this.$nextTick(() => {
                const el = document.getElementById('atlas-add-' + day);
                if (el) el.focus();
            });
        },
        stopAdd() { this.adding = ''; this.addText = ''; },
        async createTask(day) {
            const text = this.addText.trim();
            if (!text || !this.week) { this.stopAdd(); return; }
            this.addText = '';
            try {
                await api('/api/plugins/atlas/journal/' + encodeURIComponent(this.week.week) + '/tasks', {
                    method: 'POST', body: JSON.stringify({ day, text }),
                });
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            await this.load(true);
            this.$nextTick(() => {
                const el = document.getElementById('atlas-add-' + day);
                if (el) el.focus();
            });
        },
        // Die Markdown-Datei der Woche im Systemeditor (bestehender Endpunkt).
        async openWeekFile() {
            if (!this.week) return;
            try {
                await api('/api/plugins/atlas/journal/' + encodeURIComponent(this.week.week) + '/open', { method: 'POST' });
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
        },
        async reviewZettel() {
            if (this.reviewBusy || !this.week) return;
            this.reviewBusy = true;
            try {
                const created = await api('/api/plugins/atlas/journal/' + encodeURIComponent(this.week.week) + '/review/zettel', { method: 'POST' });
                await atlasLoadEntities(true);
                if (created && created.id) {
                    atlasToast('Rückblick als Notiz gespeichert.');
                    this.$router.push('/atlas/zettel/' + encodeURIComponent(created.id));
                }
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            this.reviewBusy = false;
        },
    },
    watch: {
        '$route.params.week'() { this.load(); },
    },
    mounted() {
        atlasLoadEntities();
        this.load();
        this._live = atlasLiveReload((kinds) => this.reloadFor(kinds));
    },
    beforeUnmount() {
        if (this._live) { this._live.close(); this._live = null; }
    },
};

const ATLAS_ZETTEL_TYPES = {
    reading: 'Lektüre',
    meeting: 'Besprechung',
    method: 'Methode',
    decision: 'Entscheidung',
    fleeting: 'Gedanke',
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
        'atlas-header': AtlasHeader,
        'atlas-capture': AtlasCapture,
        'atlas-anchor-chip': AtlasAnchorChip,
        'atlas-backlinks': AtlasBacklinks,
        'atlas-chips': AtlasChips,
    },
    template: `
        <div class="atlas-page atlas-shell" lang="de">
            <atlas-header kicker="Atlas · Ideen & Notizen" title="Notizen" new-type="note"
                          subtitle="Notizen halten fest, was du gelesen, besprochen oder entschieden hast: Lektüre, Besprechung, Methode, Entscheidung, Gedanke, Rückblick." />
            <atlas-nav active="zettel" />

            <atlas-capture initial-mode="zettel" @created="onCaptured" />

            <div class="atlas-split">
                <!-- ── Liste ───────────────────────────────────────────── -->
                <aside class="atlas-list-rail" aria-label="Liste der Notizen">
                    <label class="sr-only" :for="searchId">Notizen durchsuchen</label>
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
                            <template v-if="query || type">Keine Notiz passt zu dieser Suche.</template>
                            <template v-else>Noch keine Notiz. Das Erfassen-Feld oben legt im Modus „Notiz" eine an.</template>
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
                        Jede Notiz ist eine Datei in <code>zettel/</code> — extern geschrieben oder hier,
                        derselbe Weg.
                    </p>
                </aside>

                <!-- ── Detail ──────────────────────────────────────────── -->
                <main class="atlas-detail" aria-label="Notiz">
                    <div v-if="!id" class="atlas-card atlas-empty" style="min-height:220px; display:flex; align-items:center; justify-content:center; text-align:center;">
                        Wähle links eine Notiz — oder schreib oben eine Zeile und leg eine neue an.
                    </div>

                    <div v-else-if="detailLoading" class="flex flex-col gap-3">
                        <div class="atlas-skel" style="height:40px"></div>
                        <div class="atlas-skel" style="height:52px"></div>
                        <div class="atlas-skel" style="height:220px"></div>
                    </div>

                    <div v-else-if="!zettel" class="atlas-card atlas-empty">
                        Diese Notiz gibt es nicht (mehr).
                        <router-link to="/atlas/zettel" class="atlas-link-btn" style="text-decoration:none">Zur Liste</router-link>
                    </div>

                    <template v-else>
                        <div class="atlas-detail-head">
                            <div class="min-w-0 flex flex-col gap-2">
                                <div class="atlas-detail-meta">
                                    <select class="atlas-select" v-model="draft.type" aria-label="Art der Notiz">
                                        <option v-for="t in typeList" :key="t.key" :value="t.key">{{ t.label }}</option>
                                    </select>
                                    <input type="date" class="atlas-select" v-model="draft.date" aria-label="Datum" />
                                    <code class="atlas-path" :title="zettel.path || zettel.id">{{ fileName }}</code>
                                </div>
                                <label class="sr-only" :for="titleId">Titel</label>
                                <input :id="titleId" class="atlas-detail-title" v-model="draft.title"
                                       placeholder="Titel der Notiz" @keydown.enter.prevent="saveNow" />
                            </div>
                            <div class="atlas-actions">
                                <span class="atlas-save" :class="saveClass">{{ saveLabel }}</span>
                                <button type="button" class="atlas-pill" :disabled="saveState === 'saving' || !dirty" @click="saveNow">Speichern</button>
                                <button type="button" class="atlas-pill" :disabled="promoting || !!zettel.promoted_to"
                                        :title="zettel.promoted_to ? 'Ist schon eine Idee' : 'Aus dieser Notiz eine Idee machen'"
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
                            — die Notiz bleibt, wie sie ist.
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
                                      aria-label="Text der Notiz" spellcheck="true"
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
                                <h2 class="atlas-sec-title">Vereinbart → Aufgaben</h2>
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
                                        {{ deriving ? 'Legt an…' : 'Als Aufgaben für heute anlegen' }}
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
        typeLabel(type) { return ATLAS_ZETTEL_TYPES[type || 'fleeting'] || type; },
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
                    ? made + (made === 1 ? ' Aufgabe' : ' Aufgaben') + ' für heute angelegt'
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
            if (!confirm('Diese Notiz wirklich löschen? Rückverweise darauf bleiben als Warnung stehen.')) return;
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
            this.$router.push(atlasPublicationRoute(id));
        },
        openProject(id) {
            this.$router.push({ path: '/atlas/sammlung', query: { tab: 'projekte', proj: id } });
        },
        openZettel(id) {
            this.$router.push('/atlas/zettel/' + encodeURIComponent(id));
        },
        zettelTypeLabel(v) { return ATLAS_ZETTEL_TYPES[v || 'fleeting'] || v; },
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
                <h5 class="lb-aside-h mt-3">Atlas-Notizen zu diesem Paper</h5>
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
// plugin.json) mit eigenem Hinweis, darunter jedes weitere Feld des
// Manifests generisch (Text bzw. Schalter, Beschriftung aus dem Katalog) —
// so steht „Dein Name" (#228) hier, ohne dass das Formular ihn kennt.
// Ein/Aus schaltet der Kern in derselben Karte.
const ATLAS_SETTING_HINTS = {
    own_name: { placeholder: 'z. B. Mustermann, T.', help: 'So, wie dein Name in deinen Papern steht – die Publikationsliste setzt ihn fett.' },
};

function atlasSettingDrafts(fields, values) {
    const drafts = {};
    for (const f of fields || []) {
        if (f.key === 'base_dir' || f.type === 'secret') continue;
        const v = (values || {})[f.key];
        drafts[f.key] = f.type === 'bool' ? (v === true || v === 'true') : (v == null ? '' : String(v));
    }
    return drafts;
}

const AtlasSettings = {
    props: ['addonId', 'fields', 'values', 'save'],
    data() {
        return {
            baseDir: (this.values && this.values.base_dir) || '',
            drafts: atlasSettingDrafts(this.fields, this.values),
            saving: false, saved: false, error: '',
        };
    },
    computed: {
        extraFields() { return (this.fields || []).filter((f) => f.key in this.drafts); },
    },
    methods: {
        label(f) {
            const text = f.label ? LB.t(f.label) : '';
            return text && !text.startsWith('⟦') ? text : f.key;
        },
        hint(f, what) { return (ATLAS_SETTING_HINTS[f.key] || {})[what] || ''; },
        async submit() {
            this.saving = true;
            this.saved = false;
            this.error = '';
            try {
                const next = await this.save({ base_dir: this.baseDir, ...this.drafts });
                this.baseDir = (next && next.base_dir) || '';
                this.drafts = atlasSettingDrafts(this.fields, next);
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
            <div v-for="f in extraFields" :key="f.key" class="space-y-1 pt-2">
                <label v-if="f.type === 'bool'" class="inline-flex items-center gap-2 text-sm text-gray-700">
                    <input type="checkbox" v-model="drafts[f.key]" :data-field="f.key" />{{ label(f) }}
                </label>
                <template v-else>
                    <label class="block text-sm font-medium text-gray-700" :for="'atlas-settings-' + f.key">{{ label(f) }}</label>
                    <input :id="'atlas-settings-' + f.key" :data-field="f.key" v-model="drafts[f.key]" type="text" autocomplete="off"
                           :placeholder="hint(f, 'placeholder')"
                           class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
                    <p v-if="hint(f, 'help')" class="text-xs text-gray-500">{{ hint(f, 'help') }}</p>
                </template>
            </div>
            <div class="flex items-center gap-3">
                <button type="submit" :disabled="saving" data-testid="atlas-settings-save"
                        class="px-3 py-1.5 text-sm rounded-lg border border-gray-300 hover:bg-gray-50">Speichern</button>
                <span v-if="saved" class="text-xs text-gray-500">Gespeichert — Atlas nutzt den Ordner ab sofort.</span>
                <span v-if="error" class="text-xs text-red-600">{{ error }}</span>
            </div>
        </form>
    `,
};

// ── Detailseite einer Veröffentlichung (#225 Kopf und Stand, #226) ─────────
// Eigene Adresse /atlas/veroeffentlichungen/:id statt des Drawers: Dateien
// ablegen (Explorer-Drag & Drop auf die Seite oder Auswahl), LaTeX-Text
// einfügen mit sofortiger Zitat-Prüfung, Literatur-Abgleich Manuskript ×
// Sammlung × Bibliothek, jedes Paper per DOI im Netz oder in LocalBib öffnen.
// Atlas fügt dabei nie selbst etwas zu Bibliothek oder Sammlung hinzu: was
// fehlt, steht als Liste da. Ein alter Tiefenlink auf eine virtuelle
// Sammlungs-ID ohne Datei zeigt, dass diese Sammlung (noch) keine
// Veröffentlichung ist (ADR-0025).

// Wie viele Dateien liegen im Dokumentordner? null, wenn unbekannt.
async function atlasDocumentCount(url) {
    try {
        return ((await api(url)).documents || []).length;
    } catch (e) {
        return null;
    }
}

// Der Satz der Lösch-Rückfrage über den Dokumentordner: nur, wenn Dateien
// darin liegen (ein leerer Ordner geht ohne Spur), unbestimmt, wenn die
// Zahl nicht bekannt ist.
function atlasDocumentsKeptNote(count, folder) {
    if (count === 0) return '';
    const where = ' – unter „' + folder + '.geloescht-<Datum>“.';
    if (count === 1) return ' Die Datei im Dokumentordner bleibt erhalten' + where;
    if (count > 1) return ' Die ' + count + ' Dateien im Dokumentordner bleiben erhalten' + where;
    return ' Dateien im Dokumentordner bleiben erhalten' + where;
}

// Ein verknüpftes Manuskript, das der Literatur-Abgleich nicht lesen konnte
// (`problem` aus GET /publications/{id}/literature) — die übrigen zählen.
const ATLAS_MANUSCRIPT_PROBLEM = {
    name_invalid: 'Ungültiger Manuskriptname – Verknüpfung prüfen',
    not_utf8: 'Manuskript ist nicht UTF-8 – Zitate nicht gelesen',
    unreadable: 'Manuskript nicht lesbar (gesperrt?)',
};

const ATLAS_FILE_KIND = {
    tex: 'LaTeX', bib: 'BibTeX', pdf: 'PDF', png: 'Abbildung', jpg: 'Abbildung', jpeg: 'Abbildung',
    svg: 'Abbildung', eps: 'Abbildung', gif: 'Abbildung', cls: 'Vorlage', sty: 'Vorlage', bst: 'Vorlage',
    docx: 'Word', doc: 'Word',
};

function atlasFileKind(name) {
    const ext = (String(name).split('.').pop() || '').toLowerCase();
    return ATLAS_FILE_KIND[ext] || 'Datei';
}

// "https://doi.org/10.…", "doi:10.…", " 10.… " → "10.…"
function atlasBareDoi(doi) {
    return String(doi || '').trim().replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:\s*)/i, '').trim();
}

function atlasDoiUrl(doi) {
    return 'https://doi.org/' + atlasBareDoi(doi);
}

// „Im Netz": die DOI, ohne DOI eine Websuche nach dem Titel.
function atlasWebUrl(row) {
    if (row.doi) return atlasDoiUrl(row.doi);
    return 'https://scholar.google.com/scholar?q=' + encodeURIComponent(row.title || row.key);
}

// Öffnet jede Adresse in einem eigenen Tab. Gibt der Browser für einen Tab
// nichts zurück (Pop-up-Blocker), sagt Atlas, wie man Pop-ups erlaubt.
// Bewusst OHNE das Feature `noopener`: damit liefert window.open laut
// HTML-Spezifikation immer null, ein geöffneter Tab sähe aus wie ein
// blockierter. Die Verbindung zum Opener trennt Atlas selbst.
function atlasOpenTabs(urls) {
    let blocked = 0;
    for (const url of urls) {
        let win = null;
        try { win = window.open(url, '_blank'); } catch (e) { win = null; }
        if (win) { try { win.opener = null; } catch (e) { /* ignore */ } }
        else blocked += 1;
    }
    if (blocked) {
        atlasToast('Dein Browser hat ' + blocked + (blocked === 1 ? ' Tab' : ' Tabs')
            + ' zurückgehalten. Klick oben rechts in der Adressleiste auf das Symbol und erlaube Pop-ups für LocalBib.',
            { timeout: 16000 });
    }
    return blocked;
}

function atlasBibEscape(value) {
    return String(value || '').replace(/[{}]/g, '');
}

// Die fehlenden Paper als .bib — aus dem, was die Literatur-Zeilen wissen
// (Titel/Autor:innen/Jahr/DOI aus einer .bib des Dokumentordners).
function atlasBibFor(rows) {
    return rows.map((r) => {
        const fields = [];
        if (r.title) fields.push('  title = {' + atlasBibEscape(r.title) + '}');
        if (r.authors) fields.push('  author = {' + atlasBibEscape(r.authors) + '}');
        if (r.year) fields.push('  year = {' + atlasBibEscape(r.year) + '}');
        if (r.doi) fields.push('  doi = {' + atlasBibEscape(r.doi) + '}');
        return '@misc{' + r.key + (fields.length ? ',\n' + fields.join(',\n') + '\n' : ',\n') + '}';
    }).join('\n\n') + '\n';
}

function atlasDownload(filename, text, type = 'text/plain') {
    try {
        const blob = new Blob([text], { type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return true;
    } catch (e) {
        return false;
    }
}

async function atlasCopy(text) {
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (e) { /* fällt auf den Hinweis zurück */ }
    return false;
}

// „Angaben bearbeiten": ein schlankes Formular statt Komma-Listen —
// Manuskripte, Projekte, Ideen und das eigene Paper per Auswahl/Suche. Der
// Schreibpfad bleibt das partielle Update der Veröffentlichung.
const AtlasPublicationEdit = {
    components: { 'atlas-icon': AtlasIcon, 'atlas-chips': AtlasChips },
    props: { pub: { type: Object, required: true } },
    emits: ['close', 'saved'],
    template: `
        <div class="atlas-modal-backdrop" @click.self="$emit('close')" @keydown.esc="$emit('close')">
            <form class="atlas-modal" role="dialog" aria-modal="true" aria-labelledby="atlas-pubedit-h" @submit.prevent="save">
                <div class="atlas-new-head">
                    <div>
                        <h2 id="atlas-pubedit-h" class="atlas-modal-title">Angaben bearbeiten</h2>
                        <p class="atlas-modal-sub">Verknüpfungen wählst du aus – Komma-Listen braucht es nicht.</p>
                    </div>
                    <button type="button" class="atlas-icon-square" aria-label="Schließen" @click="$emit('close')"><atlas-icon name="close" /></button>
                </div>
                <div class="atlas-new-form">
                    <div class="atlas-new-field">
                        <label for="atlas-pe-title" class="atlas-new-legend">Titel</label>
                        <input id="atlas-pe-title" v-model="draft.title" class="atlas-input" :disabled="!!pub.collection" />
                        <span v-if="pub.collection" class="atlas-new-help">Der Titel ist der Name der Sammlung – in LocalBib umbenennen.</span>
                    </div>
                    <div class="atlas-form-grid">
                        <div class="atlas-new-field">
                            <label for="atlas-pe-type" class="atlas-new-legend">Art</label>
                            <select id="atlas-pe-type" v-model="draft.type" class="atlas-input">
                                <option value="">—</option>
                                <option v-for="(label, key) in types" :key="key" :value="key">{{ label }}</option>
                            </select>
                        </div>
                        <div class="atlas-new-field">
                            <label for="atlas-pe-venue" class="atlas-new-legend">Venue</label>
                            <input id="atlas-pe-venue" v-model="draft.venue" class="atlas-input" placeholder="Journal, Konferenz, Verlag" />
                        </div>
                        <div class="atlas-new-field">
                            <label for="atlas-pe-due" class="atlas-new-legend">Frist</label>
                            <input id="atlas-pe-due" v-model="draft.due" type="date" class="atlas-input" />
                        </div>
                    </div>
                    <div class="atlas-new-field">
                        <span class="atlas-new-legend">Co-Autor:innen</span>
                        <atlas-chips v-model="draft.authors" label="Co-Autor:innen" placeholder="Name, Enter" />
                    </div>
                    <div v-for="group in pickers" :key="group.field" class="atlas-new-field">
                        <span class="atlas-new-legend">{{ group.label }}</span>
                        <div class="atlas-link-box">
                            <span v-for="id in draft[group.field]" :key="id" class="atlas-chip">
                                <span class="atlas-chip-label">{{ group.title(id) }}</span>
                                <button type="button" class="atlas-chip-x" :aria-label="group.label + ': ' + group.title(id) + ' entfernen'" @click="remove(group.field, id)">×</button>
                            </span>
                            <select class="atlas-link-input" :aria-label="group.label + ' hinzufügen'" @change="add(group.field, $event)">
                                <option value="">+ hinzufügen …</option>
                                <option v-for="o in group.options()" :key="o.id" :value="o.id">{{ o.title }}</option>
                            </select>
                        </div>
                    </div>
                    <div class="atlas-new-field">
                        <label for="atlas-pe-paper" class="atlas-new-legend">Eigenes Paper <span class="atlas-muted">(aus deiner Bibliothek)</span></label>
                        <div class="atlas-link-box">
                            <span v-if="draft.paper" class="atlas-chip">
                                <span class="atlas-chip-kind">Bibliothek</span><span class="atlas-chip-label">{{ paperTitle }}</span>
                                <button type="button" class="atlas-chip-x" aria-label="Eigenes Paper entfernen" @click="draft.paper = ''">×</button>
                            </span>
                            <input v-else id="atlas-pe-paper" v-model="paperQuery" class="atlas-link-input" placeholder="Titel, Autor:in oder DOI suchen …" autocomplete="off" @focus="loadPapers" />
                        </div>
                        <div v-if="!draft.paper && paperQuery.trim()" class="atlas-sug is-inline" role="listbox" aria-label="Paper der Bibliothek">
                            <button v-for="p in paperHits" :key="p.id" type="button" role="option" class="atlas-sug-item" @click="pickPaper(p)">
                                <span class="atlas-sug-title">{{ p.title }}</span><span class="atlas-sug-id">{{ p.year || '' }}</span>
                            </button>
                            <div v-if="papersLoading && !paperHits.length" class="atlas-sug-empty">Lädt die Bibliothek …</div>
                            <div v-else-if="papersFailed" class="atlas-sug-empty">Die Bibliothek ließ sich nicht laden. Klick noch einmal ins Feld, um es erneut zu versuchen.</div>
                            <div v-else-if="!paperHits.length" class="atlas-sug-empty">Nicht in der Bibliothek. Importiere es zuerst in LocalBib.</div>
                        </div>
                    </div>
                    <p v-if="error" class="atlas-error" role="alert">{{ error }}</p>
                </div>
                <div class="atlas-new-foot">
                    <router-link :to="legacyRoute" class="atlas-more" @click="$emit('close')">Alle Felder (bisheriges Formular)</router-link>
                    <div class="atlas-row-gap">
                        <button type="button" class="atlas-btn" @click="$emit('close')">Abbrechen</button>
                        <button type="submit" class="atlas-btn is-primary" :disabled="busy">{{ busy ? 'Speichert…' : 'Speichern' }}</button>
                    </div>
                </div>
            </form>
        </div>
    `,
    data() {
        const p = this.pub;
        return {
            draft: {
                title: p.title || '',
                type: p.type || '',
                venue: p.venue || '',
                due: p.due || '',
                authors: [...(p.authors || [])],
                manuscripts: [...(p.manuscripts || [])],
                projects: [...(p.projects || [])],
                derived_from: [...(p.derived_from || [])],
                paper: p.paper || '',
            },
            manuscripts: [],
            // Die Bibliothek für „Eigenes Paper": erst beim ersten Fokus des
            // Suchfelds geladen (nicht beim Öffnen), dann für die Lebenszeit
            // des Dialogs behalten. Der Vertrag (plugin_api) kennt keine
            // schlanke Liste, und die Kernsuche `?search=` findet weder DOIs
            // noch Umlaute ohne Rücksicht auf Groß/klein — also hier filtern.
            papers: [],
            papersLoad: null,
            papersLoading: false,
            papersFailed: false,
            paperQuery: '',
            paperPicked: null,
            busy: false,
            error: '',
        };
    },
    watch: {
        // Erstes Laden auch ohne Fokus (Einfügen) — ein gescheitertes Laden
        // versucht aber nur der nächste Fokus erneut, nie jeder Tastendruck.
        paperQuery(q) { if (q.trim() && !this.papersFailed) this.loadPapers(); },
    },
    computed: {
        types() { return ATLAS_PUBLICATION_TYPE_LABEL; },
        legacyRoute() { return atlasPublicationLegacyRoute(this.pub.id); },
        pickers() {
            const entityTitle = (id) => { const e = atlasEntity(id); return (e && e.title) || id; };
            const entities = (kind, field) => () => atlasWork.entities
                .filter((e) => e.kind === kind && !this.draft[field].includes(e.id))
                .map((e) => ({ id: e.id, title: e.title || e.id }));
            return [
                {
                    field: 'manuscripts', label: 'Manuskripte',
                    title: (id) => id,
                    options: () => this.manuscripts
                        .map((m) => m.id + '.tex')
                        .filter((name) => !this.draft.manuscripts.includes(name))
                        .map((name) => ({ id: name, title: name })),
                },
                { field: 'projects', label: 'Projekte', title: entityTitle, options: entities('project', 'projects') },
                { field: 'derived_from', label: 'Ideen', title: entityTitle, options: entities('idea', 'derived_from') },
            ];
        },
        // Titel, Autor:innen oder DOI, ohne Rücksicht auf Groß/klein (auch
        // Umlaute); nur Items mit Cite Key — verknüpft wird per Cite Key.
        paperHits() {
            const q = this.paperQuery.trim().toLowerCase();
            if (!q) return [];
            const has = (value) => String(value || '').toLowerCase().includes(q);
            return this.papers
                .filter((p) => p.cite_key && (has(p.title) || has(p.authors) || has(p.doi)))
                .slice(0, 8);
        },
        paperTitle() {
            const picked = this.paperPicked;
            if (picked && picked.cite_key === this.draft.paper) return picked.title || this.draft.paper;
            const hit = this.papers.find((p) => p.cite_key && p.cite_key === this.draft.paper);
            if (hit) return hit.title || this.draft.paper;
            const resolved = this.pub.paper_resolved;
            if (resolved && resolved.found && resolved.citekey === this.draft.paper) return resolved.title || this.draft.paper;
            return this.draft.paper;
        },
    },
    methods: {
        add(field, event) {
            const id = event.target.value;
            event.target.value = '';
            if (id && !this.draft[field].includes(id)) this.draft[field].push(id);
        },
        remove(field, id) { this.draft[field] = this.draft[field].filter((x) => x !== id); },
        pickPaper(p) {
            this.draft.paper = p.cite_key || '';
            this.paperPicked = { cite_key: p.cite_key || '', title: p.title || '' };
            this.paperQuery = '';
        },
        // Einmal je Dialog; schlägt es fehl, versucht es der nächste Fokus.
        loadPapers() {
            if (this.papersLoad) return this.papersLoad;
            this.papersLoading = true;
            this.papersFailed = false;
            this.papersLoad = api('/api/papers')
                .then((data) => { this.papers = Array.isArray(data) ? data : (data.papers || data.items || []); })
                .catch(() => { this.papers = []; this.papersLoad = null; this.papersFailed = true; })
                .finally(() => { this.papersLoading = false; });
            return this.papersLoad;
        },
        async save() {
            if (this.busy) return;
            const d = this.draft;
            const p = this.pub;
            const body = {};
            const same = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);
            if (!p.collection && d.title.trim() && d.title.trim() !== p.title) body.title = d.title.trim();
            if ((d.type || null) !== (p.type || null)) body.type = d.type || null;
            if ((d.venue.trim() || null) !== (p.venue || null)) body.venue = d.venue.trim() || null;
            if ((d.due || null) !== (p.due || null)) body.due = d.due || null;
            if ((d.paper || null) !== (p.paper || null)) body.paper = d.paper || null;
            for (const field of ['authors', 'manuscripts', 'projects', 'derived_from']) {
                if (!same(d[field], p[field])) body[field] = d[field];
            }
            if (!Object.keys(body).length) { this.$emit('close'); return; }
            this.busy = true;
            this.error = '';
            try {
                await api('/api/plugins/atlas/publications/' + encodeURIComponent(p.id), {
                    method: 'PUT', body: JSON.stringify(body),
                });
                atlasToast('Angaben gespeichert.');
                this.$emit('saved');
            } catch (e) {
                this.error = atlasErrorText(e);
            }
            this.busy = false;
        },
    },
    async mounted() {
        atlasLoadEntities();
        try { this.manuscripts = (await api('/api/plugins/atlas/manuscripts')).manuscripts || []; } catch (e) { this.manuscripts = []; }
    },
};

const ATLAS_LIT_FILTERS = [
    { key: 'all', label: 'Alle' },
    { key: 'missing', label: 'Fehlen in der Bibliothek' },
    { key: 'uncited', label: 'Noch nicht zitiert' },
];

const AtlasPublicationPage = {
    components: {
        'atlas-nav': AtlasNav,
        'atlas-icon': AtlasIcon,
        'atlas-anchor-chip': AtlasAnchorChip,
        'atlas-publication-edit': AtlasPublicationEdit,
    },
    template: `
        <div class="atlas-page atlas-shell" lang="de" @dragover.stop.prevent="onDragOver" @dragleave="onDragLeave" @drop.stop.prevent="onDrop">
            <atlas-nav active="veroeffentlichungen" />

            <div v-if="loading" class="atlas-skel" style="height:120px" aria-hidden="true"></div>

            <section v-else-if="missing" class="atlas-panel is-padded atlas-missing" role="status">
                <router-link :to="backRoute" class="atlas-back"><atlas-icon name="back" :size="16" /> Veröffentlichungen</router-link>
                <template v-if="virtualId">
                    <h1 class="atlas-title is-small">Diese Sammlung ist keine Veröffentlichung</h1>
                    <p class="atlas-muted">Sammlungen sind Ablageorte für Paper. Soll daraus eine Veröffentlichung werden, plan sie über „Aus Sammlung planen“ – ihre Paper sind dann deren Literaturliste.</p>
                    <router-link :to="planRoute" class="atlas-btn is-primary is-tall" style="align-self:flex-start">
                        <atlas-icon name="stack" /> Aus Sammlung planen
                    </router-link>
                </template>
                <template v-else>
                    <h1 class="atlas-title is-small">Diese Veröffentlichung gibt es nicht (mehr)</h1>
                    <p class="atlas-muted">Vielleicht wurde die Datei umbenannt oder gelöscht.</p>
                </template>
            </section>

            <template v-else-if="pub">
                <header class="atlas-detail-header">
                    <router-link :to="backRoute" class="atlas-back"><atlas-icon name="back" :size="16" /> Veröffentlichungen</router-link>
                    <div class="atlas-detail-titlerow">
                        <div class="atlas-detail-titles">
                            <h1 class="atlas-title is-detail">{{ pub.title }}</h1>
                            <div class="atlas-detail-meta">
                                <template v-for="(m, i) in metaParts" :key="i">
                                    <span v-if="i" aria-hidden="true" class="atlas-dot">·</span><span>{{ m }}</span>
                                </template>
                            </div>
                        </div>
                        <div class="atlas-header-actions">
                            <button type="button" class="atlas-btn is-tall" @click="editOpen = true">Angaben bearbeiten</button>
                            <router-link v-if="firstManuscript" :to="editorRoute(firstManuscript)" class="atlas-btn is-primary is-tall">
                                <atlas-icon name="pen" /> LaTeX-Editor öffnen
                            </router-link>
                        </div>
                    </div>
                    <ol class="atlas-steps" aria-label="Stand der Veröffentlichung">
                        <li v-for="(st, i) in steps" :key="st.key" class="atlas-step-li">
                            <atlas-icon v-if="i" name="chevronRight" :size="14" class="atlas-step-sep" />
                            <button type="button" class="atlas-step" :class="{ 'is-current': st.current, 'is-past': st.past }"
                                    :aria-pressed="st.current ? 'true' : 'false'" :disabled="busy" @click="setStatus(st.key)">
                                <atlas-icon v-if="st.past" name="check" :size="14" />{{ st.name }}
                            </button>
                        </li>
                    </ol>
                    <p v-if="closedLabel" class="atlas-muted">Status: {{ closedLabel }}</p>
                </header>

                <div class="atlas-columns">
                    <div class="atlas-col-main">
                        <!-- Dateien -->
                        <section class="atlas-panel is-padded atlas-stack" aria-labelledby="atlas-h-files">
                            <div class="atlas-panel-head is-flush">
                                <h2 id="atlas-h-files" class="atlas-panel-title">Dateien</h2>
                                <span class="atlas-panel-note is-inline">liegen im Atlas-Ordner unter <span class="atlas-mono">{{ folder }}</span></span>
                            </div>
                            <div class="atlas-dropzone-files" :class="{ 'is-over': dropOver }">
                                <span class="atlas-dz-icon"><atlas-icon name="upload" :size="22" /></span>
                                <div class="atlas-dz-text">
                                    <div class="atlas-dz-title">{{ dropOver ? 'Loslassen zum Hinzufügen' : 'Dateien hierher ziehen' }}</div>
                                    <div class="atlas-dz-sub">.tex, .bib, PDF, Abbildungen, Vorlagen – oder LaTeX-Text direkt einfügen. Zitate werden sofort mit der Bibliothek abgeglichen.</div>
                                </div>
                                <label class="atlas-btn">
                                    <input ref="fileInput" type="file" multiple class="atlas-sr" @change="onPick" />
                                    Dateien auswählen
                                </label>
                                <button type="button" class="atlas-btn" :aria-expanded="pasteOpen ? 'true' : 'false'" @click="pasteOpen = !pasteOpen">
                                    <atlas-icon name="paste" :size="16" /> Text einfügen
                                </button>
                            </div>
                            <p v-if="uploading" class="atlas-muted" role="status">Legt ab…</p>

                            <div v-if="pasteOpen" class="atlas-paste">
                                <label for="atlas-paste-tex" class="atlas-new-legend">LaTeX-Text</label>
                                <textarea id="atlas-paste-tex" v-model="paste" rows="6" class="atlas-textarea"
                                          placeholder="Abschnitt aus dem Manuskript hier einfügen (Strg V) – Atlas erkennt \\cite{…} und gleicht mit der Bibliothek ab."
                                          @input="schedulePasteCheck"></textarea>
                                <div class="atlas-paste-foot">
                                    <span class="atlas-paste-summary" :class="pasteTone" role="status">{{ pasteSummary }}</span>
                                    <button type="button" class="atlas-btn" :disabled="!paste.trim() || savingPaste" @click="savePaste">
                                        {{ savingPaste ? 'Speichert…' : 'Als .tex speichern' }}
                                    </button>
                                </div>
                            </div>

                            <ul class="atlas-files">
                                <li v-for="f in files" :key="f.key" class="atlas-file-row">
                                    <span class="atlas-plan-icon"><atlas-icon :name="f.icon" /></span>
                                    <div class="atlas-file-text">
                                        <div class="atlas-file-name-row">
                                            <span class="atlas-mono atlas-file-name">{{ f.name }}</span>
                                            <span class="atlas-badge is-small">{{ f.kind }}</span>
                                            <span v-if="f.fresh" class="atlas-badge is-small is-accent">neu</span>
                                        </div>
                                        <div class="atlas-file-note">{{ f.note }}</div>
                                    </div>
                                    <router-link v-if="f.route" :to="f.route" class="atlas-text-btn is-link">{{ f.action }}</router-link>
                                    <button v-else-if="f.open" type="button" class="atlas-text-btn" @click="openDocument(f.name)">{{ f.action }}</button>
                                    <button v-if="f.removable" type="button" class="atlas-text-btn is-muted"
                                            :aria-label="f.name + ' entfernen'" @click="removeDocument(f.name)">Entfernen</button>
                                </li>
                                <li v-if="!files.length" class="atlas-file-row is-empty">Noch keine Dateien bei diesem Beitrag.</li>
                            </ul>
                        </section>

                        <!-- Literatur -->
                        <section class="atlas-panel is-padded atlas-stack" aria-labelledby="atlas-h-lit">
                            <div class="atlas-panel-head is-flush">
                                <h2 id="atlas-h-lit" class="atlas-panel-title">Literatur</h2>
                                <span class="atlas-panel-note is-inline">{{ counts.total }} Paper aus Manuskript und {{ sourceLabel }}</span>
                            </div>
                            <template v-if="counts.total">
                                <div class="atlas-litbar" role="img" :aria-label="barAria">
                                    <div class="atlas-litbar-part is-ok" :style="{ width: pct(counts.cited_in_library) }"></div>
                                    <div class="atlas-litbar-part is-uncited" :style="{ width: pct(counts.uncited) }"></div>
                                    <div class="atlas-litbar-part is-missing" :style="{ width: pct(counts.cited_missing) }"></div>
                                </div>
                                <div class="atlas-legend is-roomy">
                                    <span><i class="atlas-swatch is-done"></i>zitiert und in der Bibliothek · {{ counts.cited_in_library }}</span>
                                    <span><i class="atlas-swatch is-open"></i>{{ sourceUncitedLabel }} · {{ counts.uncited }}</span>
                                    <span><i class="atlas-swatch is-danger"></i>zitiert, fehlt in der Bibliothek · {{ counts.cited_missing }}</span>
                                </div>
                            </template>
                            <p v-else class="atlas-muted">
                                Noch keine Literatur: verknüpf ein Manuskript mit <code>\\cite{…}</code> oder plan eine Sammlung als Literaturliste.
                            </p>

                            <div v-if="missingRows.length" class="atlas-missing-box" role="region" aria-label="Fehlende Paper">
                                <div class="atlas-missing-title"><atlas-icon name="alert" :size="18" />
                                    {{ missingRows.length }} {{ missingRows.length === 1 ? 'Paper fehlt' : 'Paper fehlen' }} in der Bibliothek</div>
                                <ul class="atlas-missing-list">
                                    <li v-for="m in missingRows" :key="m.key">
                                        <span class="atlas-missing-name">{{ m.title || m.key }}</span>
                                        <span v-if="who(m)" class="atlas-muted">{{ who(m) }}</span>
                                        <span class="atlas-mono is-small">{{ m.doi ? 'doi:' + m.doi : 'kein DOI' }}</span>
                                    </li>
                                </ul>
                                <p class="atlas-missing-note">Atlas legt nichts selbst an. Du nimmst die Liste mit in den Import von LocalBib und siehst dort vorher, was dazukommt.</p>
                                <div class="atlas-row-gap">
                                    <button type="button" class="atlas-btn is-primary" @click="importMissing"><atlas-icon name="download" :size="16" /> In LocalBib importieren</button>
                                    <button type="button" class="atlas-btn" @click="copyDois">DOIs kopieren</button>
                                    <button type="button" class="atlas-btn" @click="downloadBib">Als .bib</button>
                                    <button type="button" class="atlas-btn" @click="openMissing"><atlas-icon name="external" :size="16" /> Im Netz öffnen</button>
                                </div>
                            </div>

                            <div v-if="counts.total" class="atlas-lit-toolbar">
                                <fieldset class="atlas-chip-row atlas-plain-fieldset">
                                    <legend class="atlas-sr">Paper filtern</legend>
                                    <label v-for="f in filters" :key="f.key" class="atlas-choice" :class="{ 'is-on': filter === f.key }">
                                        <input type="radio" name="atlas-lit-filter" class="atlas-sr" :value="f.key" v-model="filter" />
                                        {{ f.label }}<span class="atlas-mono-sub">{{ f.count }}</span>
                                    </label>
                                </fieldset>
                                <button type="button" class="atlas-btn is-small" :disabled="!shownRows.length" @click="openAll">
                                    <atlas-icon name="external" :size="16" /> Alle {{ shownRows.length }} im Netz öffnen
                                </button>
                            </div>

                            <div v-if="counts.total" class="atlas-lit-scroll">
                                <div class="atlas-lit-table">
                                    <div class="atlas-lit-head" aria-hidden="true">
                                        <span>Paper</span><span>Manuskript</span><span>Bibliothek</span><span>Öffnen</span>
                                    </div>
                                    <ul class="atlas-lit-rows">
                                        <li v-for="r in shownRows" :key="r.key" class="atlas-lit-row">
                                            <div class="atlas-lit-paper">
                                                <button type="button" class="atlas-lit-main" :title="r.in_library ? 'In LocalBib öffnen' : 'Im Netz öffnen'"
                                                        @click="openMain(r)">{{ r.title || r.key }}</button>
                                                <div class="atlas-lit-sub"><template v-if="who(r)">{{ who(r) }} · </template><span class="atlas-mono is-small">{{ r.doi ? 'doi:' + r.doi : 'kein DOI' }}</span></div>
                                            </div>
                                            <div>
                                                <span class="atlas-sr">Im Manuskript: </span>
                                                <span v-if="r.cited" class="atlas-cited"><atlas-icon name="check" :size="15" />zitiert</span>
                                                <span v-else class="atlas-muted">noch nicht</span>
                                            </div>
                                            <div>
                                                <span class="atlas-sr">Bibliothek: </span>
                                                <span v-if="r.in_library && r.has_pdf" class="atlas-lib is-pdf"><atlas-icon name="check" :size="14" />mit PDF</span>
                                                <span v-else-if="r.in_library" class="atlas-lib is-nopdf"><atlas-icon name="doc" :size="14" />ohne PDF</span>
                                                <span v-else class="atlas-lib is-missing"><atlas-icon name="alert" :size="14" />fehlt</span>
                                            </div>
                                            <div class="atlas-lit-open">
                                                <button v-if="r.in_library" type="button" class="atlas-btn is-mini" :aria-label="'„' + (r.title || r.key) + '“ in LocalBib öffnen'"
                                                        @click="openLocal(r)"><atlas-icon name="book" :size="14" />LocalBib</button>
                                                <button type="button" class="atlas-btn is-mini"
                                                        :aria-label="r.doi ? '„' + (r.title || r.key) + '“ über die DOI im Netz öffnen' : 'Im Netz nach „' + (r.title || r.key) + '“ suchen'"
                                                        @click="openWeb(r)"><atlas-icon name="external" :size="14" />{{ r.doi ? 'DOI' : 'Suchen' }}</button>
                                            </div>
                                        </li>
                                    </ul>
                                    <p v-if="!shownRows.length" class="atlas-lit-empty">Hier ist nichts offen.</p>
                                </div>
                            </div>
                        </section>
                    </div>

                    <aside class="atlas-col-side">
                        <section v-if="collection" class="atlas-panel is-padded atlas-stack" aria-labelledby="atlas-h-coll">
                            <h2 id="atlas-h-coll" class="atlas-kicker">Literatur aus der Sammlung</h2>
                            <div class="atlas-coll-head">
                                <span class="atlas-plan-icon is-accent is-big"><atlas-icon name="stack" /></span>
                                <div>
                                    <div class="atlas-plan-name">{{ collection.name }}</div>
                                    <div class="atlas-plan-meta">{{ collection.item_count }} Paper · Sammlung in LocalBib<template v-if="collection.archived"> · archiviert</template></div>
                                </div>
                            </div>
                            <ul class="atlas-bullets">
                                <li><atlas-icon name="check" :size="16" />Was du in LocalBib in die Sammlung legst, steht hier sofort mit.</li>
                                <li><atlas-icon name="check" :size="16" /><span>Die Bibliographie für LaTeX wird beim Kompilieren daraus erzeugt.</span></li>
                            </ul>
                            <div class="atlas-row-gap">
                                <router-link :to="'/collection/' + collection.id" class="atlas-btn">In LocalBib öffnen</router-link>
                                <router-link :to="planRoute" class="atlas-btn">Alle Sammlungen</router-link>
                            </div>
                        </section>
                        <section v-else class="atlas-panel is-padded atlas-stack" aria-labelledby="atlas-h-coll">
                            <h2 id="atlas-h-coll" class="atlas-kicker">Literaturliste</h2>
                            <p class="atlas-muted" style="margin:0">
                                <template v-if="(pub.refs || []).length">{{ pub.refs.length }} Cite Keys stehen als feste Liste in der Datei.</template>
                                <template v-else>Keine Sammlung verknüpft.</template>
                                Aus einer Sammlung planen macht deren Paper zur Literaturliste, die mitwächst.
                            </p>
                            <router-link :to="planRoute" class="atlas-btn" style="align-self:flex-start">Alle Sammlungen</router-link>
                        </section>

                        <section class="atlas-panel is-padded" aria-labelledby="atlas-h-fristen">
                            <h2 id="atlas-h-fristen" class="atlas-panel-title is-side">Fristen &amp; Aufgaben</h2>
                            <ul class="atlas-agenda">
                                <li v-for="d in dates" :key="d.key" class="atlas-agenda-row">
                                    <span class="atlas-agenda-icon" :class="d.tone ? 'is-' + d.tone : ''"><atlas-icon :name="d.icon" /></span>
                                    <div class="atlas-agenda-body">
                                        <div class="atlas-agenda-title">{{ d.title }}</div>
                                        <div class="atlas-agenda-sub">{{ d.sub }}</div>
                                    </div>
                                </li>
                                <li v-if="!dates.length" class="atlas-agenda-row atlas-muted">Keine Frist eingetragen.</li>
                            </ul>
                            <div class="atlas-group-label">Aufgaben zu diesem Beitrag</div>
                            <ul class="atlas-mini-tasks">
                                <li v-for="t in tasks" :key="t.week + '#' + t.body_index" class="atlas-mini-task">
                                    <input :id="'atlas-pt-' + t.week + t.body_index" type="checkbox" class="atlas-check" :checked="t.done"
                                           :disabled="!!t.moved_to" @change="toggleTask(t)" />
                                    <label :for="'atlas-pt-' + t.week + t.body_index" :class="{ 'is-done': t.done }">{{ t.text }}</label>
                                    <span class="atlas-mini-day" :class="{ 'is-today': t.day === today }">{{ t.day === today ? 'heute' : shortDay(t.day) }}</span>
                                </li>
                                <li v-if="!tasks.length" class="atlas-muted atlas-mini-task">Noch keine Aufgabe mit Anker auf diesen Beitrag.</li>
                            </ul>
                            <button type="button" class="atlas-col-foot-btn" @click="newTask"><atlas-icon name="plus" :size="16" /> Aufgabe zu diesem Beitrag</button>
                        </section>

                        <section class="atlas-panel is-padded" aria-labelledby="atlas-h-verk">
                            <h2 id="atlas-h-verk" class="atlas-panel-title is-side">Gehört zu</h2>
                            <ul class="atlas-belongs">
                                <li v-for="b in belongs" :key="b.key">
                                    <span class="atlas-muted">{{ b.label }}</span>
                                    <router-link v-if="b.to" :to="b.to" class="atlas-belongs-link">{{ b.title }}</router-link>
                                    <span v-else class="atlas-belongs-link">{{ b.title }}</span>
                                </li>
                                <li v-if="!belongs.length"><span class="atlas-muted">Noch keinem Kapitel, Projekt und keiner Notiz zugeordnet.</span></li>
                            </ul>
                        </section>
                    </aside>
                </div>

                <atlas-publication-edit v-if="editOpen" :pub="pub" @close="editOpen = false" @saved="onSaved" />
            </template>
        </div>
    `,
    data() {
        return {
            pub: null,
            loading: true,
            missing: false,
            busy: false,
            literature: null,
            documents: [],
            folder: '',
            tasks: [],
            chapters: [],
            backlinks: null,
            filter: 'all',
            dropOver: false,
            uploading: false,
            fresh: [],
            pasteOpen: false,
            paste: '',
            pasteResult: null,
            savingPaste: false,
            editOpen: false,
            _pasteTimer: null,
        };
    },
    computed: {
        id() { return String(this.$route.params.id || ''); },
        // Alter Tiefenlink auf einen früheren virtuellen Eintrag (`sammlung-<id>`,
        // ohne Datei): erklärt, statt „gibt es nicht" zu sagen (ADR-0025).
        virtualId() { return /^sammlung-\d+(-\d+)?$/.test(this.id); },
        today() { return atlasTodayIso(); },
        backRoute() { return ATLAS_PUBLICATIONS_ROUTE; },
        planRoute() { return { path: ATLAS_PUBLICATIONS_ROUTE, query: { planen: '1' } }; },
        collection() {
            const c = this.pub && this.pub.collection;
            return c && !c.missing ? c : null;
        },
        metaParts() {
            const p = this.pub;
            const out = [];
            if (ATLAS_PUBLICATION_TYPE_LABEL[p.type]) out.push(ATLAS_PUBLICATION_TYPE_LABEL[p.type]);
            out.push(p.venue || 'Ziel noch offen');
            if ((p.authors || []).length) out.push('mit ' + p.authors.join(', '));
            return out;
        },
        firstManuscript() {
            const m = ((this.pub && this.pub.manuscripts) || [])[0];
            return m ? m.replace(/\.tex$/i, '') : null;
        },
        steps() {
            const order = ATLAS_PIPELINE.map((s) => s.key);
            const idx = order.indexOf(this.pub.status);
            return ATLAS_PIPELINE.map((s, i) => ({
                key: s.key, name: s.name, current: i === idx, past: idx >= 0 && i < idx,
            }));
        },
        closedLabel() {
            return ATLAS_PIPELINE_CLOSED.has(this.pub && this.pub.status)
                ? ATLAS_PUBLICATION_STATUS_LABEL[this.pub.status] : '';
        },
        // Dateiliste: verknüpfte Manuskripte, die Bibliographie (aus der
        // Sammlung erzeugt, keine Datei) und der Dokumentordner.
        files() {
            const out = [];
            const lit = this.literature;
            const cites = {};
            for (const m of (lit && lit.manuscripts) || []) cites[m.id] = m;
            for (const name of (this.pub && this.pub.manuscripts) || []) {
                const id = name.replace(/\.tex$/i, '');
                const info = cites[id];
                const file = /\.tex$/i.test(name) ? name : name + '.tex';
                out.push({
                    key: 'ms:' + id, name: file, kind: 'LaTeX', icon: 'doc',
                    note: info && info.problem ? (ATLAS_MANUSCRIPT_PROBLEM[info.problem] || 'Manuskript nicht lesbar')
                        : info && !info.found ? 'Manuskript fehlt in manuskripte/'
                        : 'Manuskript' + (info ? ' · ' + info.cite_count + (info.cite_count === 1 ? ' Zitat' : ' Zitate') : ''),
                    action: 'Im Editor öffnen', route: atlasEditorRoute(id),
                    fresh: this.fresh.includes(file),
                });
            }
            if (this.collection) {
                out.push({
                    key: 'bib', name: 'Bibliographie (.bib)', kind: 'BibTeX', icon: 'stack',
                    note: 'aus der Sammlung erzeugt – beim Kompilieren, keine eigene Datei',
                    action: 'Sammlung öffnen', route: '/collection/' + this.collection.id,
                });
            }
            for (const d of this.documents) {
                const kind = atlasFileKind(d.name);
                out.push({
                    key: 'doc:' + d.name, name: d.name, kind, icon: kind === 'Abbildung' ? 'grid' : 'doc',
                    note: this.docNote(d, kind), action: 'Öffnen', open: true, removable: true,
                    fresh: this.fresh.includes(d.name),
                });
            }
            return out;
        },
        rows() { return (this.literature && this.literature.rows) || []; },
        counts() {
            return (this.literature && this.literature.counts)
                || { total: 0, cited_in_library: 0, uncited: 0, cited_missing: 0, missing: 0 };
        },
        sourceLabel() {
            const kind = this.literature && this.literature.source && this.literature.source.kind;
            return kind === 'collection' ? 'Sammlung' : 'Literaturliste';
        },
        sourceUncitedLabel() {
            return this.sourceLabel === 'Sammlung' ? 'in der Sammlung, noch nicht zitiert' : 'in der Literaturliste, noch nicht zitiert';
        },
        barAria() {
            const c = this.counts;
            return c.total + ' Paper: ' + c.cited_in_library + ' zitiert und in der Bibliothek, '
                + c.uncited + ' noch nicht zitiert, ' + c.cited_missing + ' zitiert und fehlen in der Bibliothek';
        },
        missingRows() { return this.rows.filter((r) => !r.in_library); },
        filters() {
            const c = this.counts;
            const n = { all: c.total, missing: c.missing, uncited: c.uncited };
            return ATLAS_LIT_FILTERS.map((f) => ({ ...f, count: n[f.key] }));
        },
        shownRows() {
            if (this.filter === 'missing') return this.rows.filter((r) => !r.in_library);
            if (this.filter === 'uncited') return this.rows.filter((r) => !r.cited);
            return this.rows;
        },
        pasteSummary() {
            const r = this.pasteResult;
            if (!this.paste.trim() || !r || !r.keys.length) return 'Noch kein \\cite erkannt.';
            const n = r.keys.length;
            return n + (n === 1 ? ' Zitat erkannt · ' : ' Zitate erkannt · ') + r.counts.in_library + ' in der Bibliothek'
                + (r.counts.missing ? ' · ' + r.counts.missing + ' fehlen' : '');
        },
        pasteTone() {
            const r = this.pasteResult;
            if (!r || !r.keys.length || !this.paste.trim()) return '';
            return r.counts.missing ? 'is-danger' : 'is-ok';
        },
        dates() {
            const p = this.pub;
            const out = [];
            if (p.due) {
                const days = atlasDaysBetween(this.today, p.due);
                const overdue = days !== null && days < 0;
                out.push({
                    key: 'due', icon: overdue ? 'alert' : 'flag', tone: overdue ? 'danger' : 'accent',
                    title: p.status === 'in-revision' ? 'Revisionsfrist' : 'Frist',
                    sub: atlasShortDay(p.due) + ', ' + atlasFormatDate(p.due, { day: 'numeric', month: 'short', year: 'numeric' })
                        + ' · ' + (overdue ? 'überfällig' : atlasInDays(days)) + ' · steht im Kalender',
                });
            }
            if (p.submitted) {
                out.push({ key: 'sub', icon: 'clock', tone: '', title: 'Eingereicht',
                    sub: atlasFormatDate(p.submitted, { day: 'numeric', month: 'short', year: 'numeric' }) });
            }
            if (p.published) {
                out.push({ key: 'pub', icon: 'check', tone: '', title: 'Veröffentlicht',
                    sub: atlasFormatDate(p.published, { day: 'numeric', month: 'short', year: 'numeric' }) });
            }
            return out;
        },
        belongs() {
            const out = [];
            for (const c of this.chapters) {
                if ((c.publications || []).includes(this.id)) {
                    out.push({ key: 'ch:' + c.id, label: 'Dissertation', title: c.title || c.id,
                        to: { path: '/atlas/sammlung', query: { tab: 'dissertation', chapter: c.id } } });
                }
            }
            for (const pr of (this.pub && this.pub.projects_resolved) || []) {
                out.push({ key: 'pr:' + pr.id, label: 'Projekt', title: pr.title || pr.id,
                    to: pr.found ? { path: '/atlas/sammlung', query: { tab: 'projekte', proj: pr.id } } : null });
            }
            for (const o of (this.pub && this.pub.origins) || []) {
                out.push({ key: 'id:' + o.id, label: 'Idee', title: o.title || o.id,
                    to: o.kind === 'idea' ? { path: '/atlas/sammlung', query: { tab: 'ideen', idea: o.id } } : null });
            }
            const notes = (this.backlinks && this.backlinks.zettel) || [];
            if (notes.length === 1) {
                out.push({ key: 'notes', label: 'Notizen', title: '1 Notiz verweist hierher',
                    to: '/atlas/zettel/' + encodeURIComponent(notes[0].id) });
            } else if (notes.length > 1) {
                out.push({ key: 'notes', label: 'Notizen', title: notes.length + ' Notizen verweisen hierher',
                    to: '/atlas/zettel/' + encodeURIComponent(notes[0].id) });
            }
            return out;
        },
    },
    watch: {
        id() { this.load(); },
    },
    methods: {
        editorRoute(id) { return atlasEditorRoute(id); },
        shortDay(iso) { return atlasShortDay(iso) + ' ' + (atlasDate(iso) ? atlasDate(iso).getDate() + '.' : ''); },
        pct(n) { return (this.counts.total ? (n / this.counts.total * 100).toFixed(1) : 0) + '%'; },
        who(r) {
            const first = String(r.authors || '').split(/;| and /)[0].trim();
            const name = first ? first.split(',')[0].trim() : '';
            const more = String(r.authors || '').split(/;| and /).length > 1 ? ' et al.' : '';
            const out = [name ? name + more : '', r.year || ''].filter(Boolean).join(' ');
            // Ohne Angaben steht der Cite Key — außer er ist schon der Titel.
            return out || (r.title ? r.key : '');
        },
        docNote(d, kind) {
            const fresh = this.fresh.includes(d.name);
            const size = d.size >= 1024 * 1024 ? (d.size / 1024 / 1024).toFixed(1) + ' MB'
                : Math.max(1, Math.round((d.size || 0) / 1024)) + ' KB';
            const hint = kind === 'BibTeX' ? ' · Titel und DOI fehlender Paper kommen von hier'
                : kind === 'PDF' ? ' · z. B. Gutachten oder eingereichte Fassung' : '';
            return (fresh ? 'gerade hinzugefügt · ' : '') + size + hint;
        },
        url(suffix = '') {
            return '/api/plugins/atlas/publications/' + encodeURIComponent(this.id) + suffix;
        },
        async load(silent = false) {
            if (!this.id) return;
            if (!silent) this.loading = true;
            try {
                this.pub = await api(this.url());
                this.missing = false;
            } catch (e) {
                this.pub = null;
                this.missing = true;
                this.loading = false;
                return;
            }
            this.loading = false;
            await Promise.all([this.loadLiterature(), this.loadDocuments(), this.loadSide()]);
        },
        async loadLiterature() {
            try { this.literature = await api(this.url('/literature')); } catch (e) { this.literature = null; }
        },
        async loadDocuments() {
            try {
                const data = await api(this.url('/documents'));
                this.documents = data.documents || [];
                this.folder = data.folder || ('veroeffentlichungen/' + this.id + '/');
            } catch (e) {
                this.documents = [];
                this.folder = 'veroeffentlichungen/' + this.id + '/';
            }
        },
        async loadSide() {
            const [tasks, diss, back] = await Promise.all([
                api('/api/plugins/atlas/journal/tasks?anchor=' + encodeURIComponent(this.id)).catch(() => null),
                api('/api/plugins/atlas/diss').catch(() => null),
                api('/api/plugins/atlas/backlinks/' + encodeURIComponent(this.id)).catch(() => null),
            ]);
            this.tasks = (tasks && tasks.tasks) || [];
            this.chapters = (diss && diss.chapters) || [];
            this.backlinks = back;
        },
        // Nur, was die gemeldeten Arten betreffen — vor allem der
        // Literatur-Abgleich (eine Bibliotheksabfrage je Cite Key) läuft nicht
        // bei jeder abgehakten Aufgabe neu.
        // Projekte und Ideen stehen in der Veröffentlichung selbst
        // (`projects_resolved`, `origins` für „Gehört zu"): sie holen nur sie
        // neu, nicht den Literatur-Abgleich.
        reloadFor(kinds) {
            if (atlasTouches(kinds, ['publication', 'collection'])) return this.load(true);
            if (!this.pub) return null;
            const parts = [];
            if (atlasTouches(kinds, ['project', 'idea'])) parts.push(this.loadPub());
            if (atlasTouches(kinds, ['manuscript', 'publication_document'])) parts.push(this.loadLiterature());
            if (atlasTouches(kinds, ['publication_document'])) parts.push(this.loadDocuments());
            if (atlasTouches(kinds, ['journal', 'diss_node', 'zettel', 'idea'])) parts.push(this.loadSide());
            return Promise.all(parts);
        },
        async loadPub() {
            try { this.pub = await api(this.url()); } catch (e) { /* bleibt; das nächste volle Laden entscheidet */ }
        },
        async setStatus(key) {
            if (!this.pub || this.pub.status === key || this.busy) return;
            this.busy = true;
            try {
                await atlasChangeStatus(this.pub, key, () => this.load(true));
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            this.busy = false;
        },
        onSaved() {
            this.editOpen = false;
            this.load(true);
        },
        // --- Dateien ------------------------------------------------------
        onDragOver(e) {
            const types = (e.dataTransfer && e.dataTransfer.types) || [];
            if (!Array.from(types).includes('Files')) return;
            try { e.dataTransfer.dropEffect = 'copy'; } catch (err) { /* ignore */ }
            this.dropOver = true;
        },
        onDragLeave(e) {
            const to = e.relatedTarget;
            if (to && e.currentTarget && e.currentTarget.contains(to)) return;
            this.dropOver = false;
        },
        onDrop(e) {
            this.dropOver = false;
            const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
            if (files.length && this.pub) this.addFiles(files);
        },
        onPick(e) {
            const files = Array.from(e.target.files || []);
            e.target.value = '';
            if (files.length) this.addFiles(files);
        },
        // Eine .tex wird Manuskript (bestehender Upload + Verknüpfung), alles
        // andere landet im Dokumentordner der Veröffentlichung.
        async addFiles(files) {
            this.uploading = true;
            const added = [];
            for (const file of files) {
                try {
                    const fd = new FormData();
                    fd.append('file', file);
                    if (/\.tex$/i.test(file.name)) {
                        const created = await this.postForm('/api/plugins/atlas/manuscripts/upload', fd);
                        await api(this.url('/manuscripts'), { method: 'POST', body: JSON.stringify({ name: created.id + '.tex' }) });
                        added.push(created.id + '.tex');
                    } else {
                        const meta = await this.postForm(this.url('/documents'), fd);
                        added.push(meta.name);
                    }
                } catch (e) {
                    atlasToast(file.name + ': ' + atlasErrorText(e), { tone: 'danger' });
                }
            }
            this.uploading = false;
            this.fresh = [...added, ...this.fresh];
            if (added.length) {
                atlasToast(added.length === 1 ? '„' + added[0] + '“ liegt jetzt bei diesem Beitrag.'
                    : added.length + ' Dateien liegen jetzt bei diesem Beitrag.');
            }
            await this.load(true);
        },
        async postForm(url, fd) {
            const resp = await fetch(url, { method: 'POST', body: fd });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({ detail: 'Upload fehlgeschlagen' }));
                throw new Error(err.detail || 'Upload fehlgeschlagen');
            }
            return resp.json();
        },
        async openDocument(name) {
            try {
                await api(this.url('/documents/' + encodeURIComponent(name) + '/open'), { method: 'POST' });
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
        },
        async removeDocument(name) {
            if (!confirm('„' + name + '“ aus dem Ordner dieses Beitrags löschen?')) return;
            try {
                await api(this.url('/documents/' + encodeURIComponent(name)), { method: 'DELETE' });
                atlasToast('„' + name + '“ gelöscht.');
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            await this.loadDocuments();
            await this.loadLiterature();
        },
        // --- Text einfügen --------------------------------------------------
        schedulePasteCheck() {
            if (this._pasteTimer) clearTimeout(this._pasteTimer);
            this._pasteTimer = setTimeout(() => { this._pasteTimer = null; this.checkPaste(); }, 250);
        },
        async checkPaste() {
            if (!this.paste.trim()) { this.pasteResult = null; return; }
            try {
                this.pasteResult = await api(this.url('/check-citations'), {
                    method: 'POST', body: JSON.stringify({ text: this.paste }),
                });
            } catch (e) {
                this.pasteResult = null;
            }
        },
        async savePaste() {
            const text = this.paste;
            if (!text.trim() || this.savingPaste) return;
            this.savingPaste = true;
            try {
                const name = 'eingefuegt-' + atlasTodayIso() + '.tex';
                await this.addFiles([new File([text], name, { type: 'text/x-tex' })]);
                this.paste = '';
                this.pasteResult = null;
                this.pasteOpen = false;
            } finally {
                this.savingPaste = false;
            }
        },
        // --- Öffnen ---------------------------------------------------------
        openLocal(r) {
            if (r.item_id !== null && r.item_id !== undefined) this.$router.push('/paper/' + r.item_id);
        },
        openWeb(r) { atlasOpenTabs([atlasWebUrl(r)]); },
        openMain(r) { if (r.in_library) this.openLocal(r); else this.openWeb(r); },
        openAll() { atlasOpenTabs(this.shownRows.map(atlasWebUrl)); },
        openMissing() { atlasOpenTabs(this.missingRows.map(atlasWebUrl)); },
        // Atlas legt nichts selbst an (P2): der Import des Kerns zeigt die
        // DOIs, prüft, was schon in der Bibliothek liegt, und legt erst nach
        // Bestätigung an (#227). Die Sammlung der Veröffentlichung ist dort
        // als Ziel vorgewählt — abwählbar.
        importMissing() {
            const dois = [...new Set(this.missingRows.filter((r) => r.doi).map((r) => r.doi))];
            if (!dois.length) { atlasToast('Keines der fehlenden Paper hat eine DOI.'); return; }
            this.$router.push(atlasImportRoute(dois, this.collection ? this.collection.id : null));
        },
        async copyDois() {
            const dois = this.missingRows.filter((r) => r.doi).map((r) => r.doi);
            if (!dois.length) { atlasToast('Keines der fehlenden Paper hat eine DOI.'); return; }
            const ok = await atlasCopy(dois.join('\n'));
            atlasToast(ok ? (dois.length === 1 ? '1 DOI kopiert.' : dois.length + ' DOIs kopiert.')
                : 'Kopieren ging nicht – dein Browser erlaubt keinen Zugriff auf die Zwischenablage.');
        },
        downloadBib() {
            const ok = atlasDownload('fehlende-literatur-' + this.id + '.bib', atlasBibFor(this.missingRows), 'application/x-bibtex');
            if (!ok) atlasToast('Download ging nicht.', { tone: 'danger' });
        },
        // --- Aufgaben -------------------------------------------------------
        async toggleTask(t) {
            try {
                await api('/api/plugins/atlas/journal/' + encodeURIComponent(t.week) + '/tasks/' + t.body_index + '/toggle', { method: 'POST' });
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            await this.loadSide();
        },
        newTask() {
            atlasOpenNew('task', { links: [{ id: this.id, kind: 'publication', title: this.pub.title }] });
        },
    },
    mounted() {
        this.load();
        atlasLoadEntities();
        if (!atlasWork.today) atlasRefreshToday();
        this._live = atlasLiveReload((kinds) => this.reloadFor(kinds));
    },
    beforeUnmount() {
        if (this._live) { this._live.close(); this._live = null; }
        if (this._pasteTimer) { clearTimeout(this._pasteTimer); this._pasteTimer = null; }
    },
};

// ── Publikationsliste (#228) ────────────────────────────────────────────────
// Entsteht aus allem in „Veröffentlicht": der Server setzt die Einträge
// (atlas/publication_list.py — APA, IEEE, DIN ISO 690, der eigene Name fett,
// Band/Heft/Seiten/DOI aus dem verknüpften Bibliothekseintrag), die Seite
// zeigt sie, kopiert und lädt .bib/LaTeX herunter. „Eigenes Paper per DOI
// verknüpfen" fragt den DOI-Existenz-Check des Kerns (stabil laut
// plugin_api/AUTHORING.md): gefunden → Atlas setzt `paper` in seiner Datei
// (den Cite Key nennt der BibTeX-Endpunkt des Items), nicht gefunden → der
// Import des Kerns mit dieser DOI. Kein CrossRef-Abruf in Atlas, kein
// Schreiben in die Bibliothek (P2).
const ATLAS_CITATION_STYLES = [
    { key: 'apa', label: 'APA' },
    { key: 'ieee', label: 'IEEE' },
    { key: 'din', label: 'DIN ISO 690' },
];
const ATLAS_PUBLIST_FILTERS = [
    { key: 'all', label: 'Alle' },
    { key: 'journal', label: 'Nur Journal' },
    { key: 'diss', label: 'Für die Dissertation' },
];
const ATLAS_PENDING_CHIP = { submitted: 'eingereicht', 'in-revision': 'in Begutachtung' };
// Reihenfolge in „Verknüpfen": Veröffentlichtes ohne Paper zuerst.
const ATLAS_LINK_ORDER = ['published', 'submitted', 'in-revision', 'drafting', 'planned'];

const AtlasPublicationListPage = {
    components: { 'atlas-nav': AtlasNav, 'atlas-icon': AtlasIcon },
    template: `
        <div class="atlas-page atlas-shell" lang="de">
            <atlas-nav active="veroeffentlichungen" />

            <header class="atlas-detail-header">
                <router-link :to="backRoute" class="atlas-back"><atlas-icon name="back" :size="16" /> Veröffentlichungen</router-link>
                <div class="atlas-detail-titlerow">
                    <div class="atlas-detail-titles">
                        <h1 class="atlas-title">Publikationsliste</h1>
                        <p class="atlas-subtitle">Entsteht automatisch aus allem, was in der Spalte „Veröffentlicht“ liegt. Du trägst nichts doppelt ein – Lebenslauf, Antrag und Dissertation greifen auf dieselbe Liste zu.</p>
                    </div>
                    <div class="atlas-header-actions">
                        <button type="button" class="atlas-btn is-primary is-tall" :disabled="!total" @click="copyAll">
                            <atlas-icon name="copy" /> {{ copied ? 'Kopiert' : 'Liste kopieren' }}
                        </button>
                        <button type="button" class="atlas-btn is-tall" :disabled="!total" @click="exportAs('bib')">.bib</button>
                        <button type="button" class="atlas-btn is-tall" :disabled="!total" @click="exportAs('latex')">LaTeX</button>
                    </div>
                </div>
            </header>

            <div class="atlas-columns">
                <section class="atlas-panel atlas-col-main atlas-publist" aria-label="Liste">
                    <div class="atlas-publist-bar">
                        <fieldset class="atlas-seg">
                            <legend class="atlas-sr">Zitierstil</legend>
                            <label v-for="s in styles" :key="s.key" class="atlas-seg-item" :class="{ 'is-active': style === s.key }">
                                <input type="radio" name="atlas-zitierstil" class="atlas-sr" :value="s.key" v-model="style" />{{ s.label }}
                            </label>
                        </fieldset>
                        <fieldset class="atlas-chip-row atlas-plain-fieldset">
                            <legend class="atlas-sr">Auswahl</legend>
                            <label v-for="f in filters" :key="f.key" class="atlas-choice" :class="{ 'is-on': selection === f.key }">
                                <input type="radio" name="atlas-auswahl" class="atlas-sr" :value="f.key" v-model="selection" />{{ f.label }}<span class="atlas-mono-sub">{{ counts[f.key] || 0 }}</span>
                            </label>
                        </fieldset>
                    </div>
                    <p v-if="data && !data.own_name" class="atlas-publist-hint" role="note">
                        Dein Name ist noch nicht hinterlegt. Trag ihn unter Einstellungen › Add-ons › Atlas bei „Dein Name“ ein, dann steht er in jedem Eintrag fett.
                    </p>
                    <div class="atlas-publist-body" aria-live="polite">
                        <p v-if="loading" class="atlas-muted atlas-publist-empty">Lädt…</p>
                        <div v-for="g in groups" :key="g.key" class="atlas-publist-group">
                            <h2 class="atlas-publist-year">{{ g.label }}</h2>
                            <ol class="atlas-publist-list">
                                <li v-for="e in g.entries" :key="e.id" class="atlas-publist-entry" :data-entry="e.id">
                                    <span v-if="e.number" class="atlas-publist-num">[{{ e.number }}]</span>
                                    <div class="atlas-publist-main">
                                        <p class="atlas-publist-ref"><span v-for="(s, i) in e.segments" :key="i" :class="{ 'is-bold': s.bold, 'is-italic': s.italic }">{{ s.text }}</span></p>
                                        <div v-if="chips(e).length" class="atlas-publist-chips">
                                            <span v-for="c in chips(e)" :key="c.label" class="atlas-pchip" :class="'is-' + c.tone" :title="c.title || null">{{ c.label }}</span>
                                        </div>
                                    </div>
                                    <button type="button" class="atlas-icon-square is-small" :aria-label="'Eintrag kopieren: ' + e.title"
                                            title="Eintrag kopieren" @click="copyEntry(e)"><atlas-icon name="copy" :size="16" /></button>
                                </li>
                            </ol>
                        </div>
                        <p v-if="!loading && !groups.length" class="atlas-muted atlas-publist-empty">
                            {{ failed ? 'Die Liste ließ sich nicht laden.' : 'Für diese Auswahl gibt es noch keinen Eintrag.' }}
                        </p>
                        <label class="atlas-publist-submitted">
                            <input type="checkbox" class="atlas-check" data-testid="atlas-publist-submitted" v-model="withSubmitted" />
                            <span class="atlas-publist-submitted-text">
                                <span class="atlas-publist-submitted-title">Eingereichte und begutachtete mit aufführen</span>
                                <span class="atlas-muted">Erscheinen als „eingereicht“ bzw. „in Begutachtung“ – praktisch für Lebenslauf und Anträge.</span>
                            </span>
                        </label>
                    </div>
                </section>

                <aside class="atlas-col-side">
                    <section class="atlas-panel is-padded atlas-stack atlas-publist-link" aria-labelledby="atlas-h-link">
                        <div>
                            <h2 id="atlas-h-link" class="atlas-panel-title is-side">Eigenes Paper per DOI verknüpfen</h2>
                            <p class="atlas-panel-note">Atlas sucht dein Paper in deiner Bibliothek. Band, Heft, Seiten und DOI kommen dann von dort – Atlas legt selbst nichts an.</p>
                        </div>
                        <div class="atlas-new-field">
                            <label for="atlas-link-pub" class="atlas-new-legend">Veröffentlichung</label>
                            <select id="atlas-link-pub" v-model="linkPubId" class="atlas-input" :disabled="!linkable.length">
                                <option v-if="!linkable.length" value="">Noch keine Veröffentlichung</option>
                                <option v-for="p in linkable" :key="p.id" :value="p.id">{{ optionLabel(p) }}</option>
                            </select>
                        </div>
                        <form class="atlas-new-field" @submit.prevent="linkByDoi">
                            <label for="atlas-link-doi" class="atlas-new-legend">DOI oder Link</label>
                            <div class="atlas-publist-doirow">
                                <input id="atlas-link-doi" ref="doiInput" v-model="doi" type="text" class="atlas-input atlas-mono-input"
                                       placeholder="10.… oder https://doi.org/10.…" autocomplete="off" spellcheck="false" />
                                <button type="submit" class="atlas-btn is-tall" :disabled="!canLink">{{ linking ? 'Sucht…' : 'Verknüpfen' }}</button>
                            </div>
                        </form>
                        <div v-if="linkResult && linkResult.state === 'missing'" class="atlas-publist-result atlas-publist-missing" role="status">
                            <span class="atlas-lib is-missing"><atlas-icon name="alert" :size="14" /> Nicht in deiner Bibliothek</span>
                            <p class="atlas-missing-note">Zu <span class="atlas-mono">{{ linkResult.doi }}</span> gibt es noch keinen Eintrag. „In LocalBib importieren“ öffnet dort den Import mit dieser DOI – Atlas legt nichts selbst an. Danach hier noch einmal verknüpfen.</p>
                            <button type="button" class="atlas-btn is-primary" @click="importDoi"><atlas-icon name="download" :size="16" /> In LocalBib importieren</button>
                        </div>
                        <div v-else-if="linkResult && linkResult.state === 'linked'" class="atlas-publist-result" role="status">
                            <span class="atlas-lib is-pdf"><atlas-icon name="check" :size="14" /> Verknüpft</span>
                            <p class="atlas-missing-note">„{{ linkResult.title }}“ nimmt Band, Heft, Seiten und DOI jetzt aus deiner Bibliothek.</p>
                        </div>
                    </section>

                    <section class="atlas-panel is-padded atlas-stack" aria-labelledby="atlas-h-diss">
                        <div>
                            <h2 id="atlas-h-diss" class="atlas-panel-title is-side">Für die Dissertation</h2>
                            <p class="atlas-panel-note">Welche Kapitel auf eigenen Veröffentlichungen aufbauen – für den Abschnitt „Vorveröffentlichungen“.</p>
                        </div>
                        <ul v-if="dissertation.length" class="atlas-publist-diss">
                            <li v-for="c in dissertation" :key="c.id">
                                <span class="atlas-publist-diss-ch">{{ c.label }}</span>
                                <span v-for="i in c.items" :key="i.id" class="atlas-publist-diss-item" :class="{ 'is-open': i.state === 'open' }">{{ i.state === 'open' ? i.short + ' – noch in Arbeit' : i.short }}</span>
                            </li>
                        </ul>
                        <p v-else class="atlas-muted">Noch kein Kapitel ist mit einer Veröffentlichung verknüpft. Das geht im Kapitel unter Schreiben › Dissertation.</p>
                        <button type="button" class="atlas-btn is-tall" :disabled="!dissertationText" @click="copyDissertation">
                            <atlas-icon name="copy" :size="16" /> Liste der Vorveröffentlichungen kopieren
                        </button>
                    </section>
                </aside>
            </div>
        </div>
    `,
    data() {
        return {
            data: null,
            loading: true,
            failed: false,
            style: 'apa',
            selection: 'all',
            withSubmitted: false,
            copied: false,
            pubs: [],
            linkPubId: '',
            doi: '',
            linking: false,
            linkResult: null,
        };
    },
    computed: {
        backRoute() { return ATLAS_PUBLICATIONS_ROUTE; },
        styles() { return ATLAS_CITATION_STYLES; },
        filters() { return ATLAS_PUBLIST_FILTERS; },
        counts() { return (this.data && this.data.counts) || {}; },
        groups() { return (this.data && this.data.groups) || []; },
        total() { return this.groups.reduce((n, g) => n + g.entries.length, 0); },
        dissertation() { return (this.data && this.data.dissertation) || []; },
        dissertationText() { return (this.data && this.data.dissertation_text) || ''; },
        // Jede nicht abgelehnte Veröffentlichung, Veröffentlichtes ohne Paper vorn.
        linkable() {
            const rank = (p) => {
                const i = ATLAS_LINK_ORDER.indexOf(p.status);
                return (i < 0 ? ATLAS_LINK_ORDER.length : i) * 2 + (p.status === 'published' && p.paper ? 1 : 0);
            };
            return this.pubs
                .filter((p) => !ATLAS_PIPELINE_CLOSED.has(p.status))
                .slice()
                .sort((a, b) => rank(a) - rank(b) || (a.title || '').localeCompare(b.title || '', 'de-DE'));
        },
        linkPub() { return this.pubs.find((p) => p.id === this.linkPubId) || null; },
        canLink() { return !!this.linkPub && !!atlasBareDoi(this.doi) && !this.linking; },
    },
    watch: {
        style() { this.changed(); },
        selection() { this.changed(); },
        withSubmitted() { this.changed(); },
        doi() { if (this.linkResult && this.linkResult.state === 'missing') this.linkResult = null; },
        '$route.query.verknuepfen'(v) { if (v) this.preselect(v); },
    },
    methods: {
        query(extra = {}) {
            return new URLSearchParams({
                style: this.style, selection: this.selection, submitted: this.withSubmitted ? 'true' : 'false', ...extra,
            }).toString();
        },
        changed() {
            this.copied = false;
            this.load();
        },
        // Eine spätere Anfrage gewinnt: schneller Stilwechsel zeigt nie eine alte Antwort.
        async load() {
            const ticket = (this._ticket = (this._ticket || 0) + 1);
            try {
                const data = await api('/api/plugins/atlas/publication-list?' + this.query());
                if (ticket !== this._ticket) return;
                this.data = data;
                this.failed = false;
            } catch (e) {
                if (ticket !== this._ticket) return;
                this.failed = true;
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            this.loading = false;
        },
        // Lädt nur und hält die Wahl gültig — ein Nachladen (nach dem
        // Verknüpfen, per SSE) wählt nie neu vor und lässt die Bestätigung stehen.
        async loadPubs() {
            try {
                this.pubs = (await api('/api/plugins/atlas/publications')).publications || [];
            } catch (e) { /* der Kasten bleibt leer */ }
            this.keepLinkTarget();
        },
        refresh() { return Promise.all([this.load(), this.loadPubs()]); },
        reloadFor(kinds) {
            if (atlasTouches(kinds, ['publication', 'collection', 'diss_node'])) return this.refresh();
            return null;
        },
        // `wanted` aus „DOI eintragen" (Pipeline): nur beim ersten Laden und
        // wenn sich `?verknuepfen=` wirklich ändert, nie bei einem Nachladen.
        preselect(wanted) {
            if (wanted && this.linkable.some((p) => p.id === wanted)) {
                this.linkPubId = wanted;
                this.linkResult = null;
                this.$nextTick(() => { if (this.$refs.doiInput) this.$refs.doiInput.focus(); });
                return;
            }
            this.keepLinkTarget();
        },
        // Die Wahl bleibt, solange es sie gibt; sonst das erste
        // Veröffentlichte ohne eigenes Paper.
        keepLinkTarget() {
            const list = this.linkable;
            if (this.linkPubId && list.some((p) => p.id === this.linkPubId)) return;
            const first = list.find((p) => p.status === 'published' && !p.paper) || list[0];
            this.linkPubId = first ? first.id : '';
        },
        optionLabel(p) {
            const parts = [p.title || p.id];
            if (p.status !== 'published') parts.push(ATLAS_PUBLICATION_STATUS_LABEL[p.status] || p.status);
            if (p.paper) parts.push('verknüpft');
            return parts.join(' · ');
        },
        chips(e) {
            const out = [];
            if (e.has_pdf) out.push({ label: 'PDF in der Bibliothek', tone: 'ok' });
            for (const c of e.chapters || []) out.push({ label: 'Grundlage für Kapitel ' + c.number, tone: 'soft', title: c.title });
            if (e.pending) out.push({ label: ATLAS_PENDING_CHIP[e.pending] || e.pending, tone: 'warn' });
            return out;
        },
        async copyText(text, done) {
            const ok = await atlasCopy(text);
            atlasToast(ok ? done : 'Kopieren ging nicht – dein Browser erlaubt keinen Zugriff auf die Zwischenablage.',
                ok ? {} : { tone: 'danger' });
            return ok;
        },
        async copyAll() {
            if (this.data) this.copied = await this.copyText(this.data.text, 'Liste kopiert.');
        },
        copyEntry(e) { return this.copyText(e.text, 'Eintrag kopiert.'); },
        copyDissertation() { return this.copyText(this.dissertationText, 'Vorveröffentlichungen kopiert.'); },
        async exportAs(format) {
            try {
                const out = await api('/api/plugins/atlas/publication-list/export?' + this.query({ format }));
                if (atlasDownload(out.filename, out.content, out.mime)) atlasToast(out.filename + ' heruntergeladen.');
                else atlasToast('Download ging nicht.', { tone: 'danger' });
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
        },
        // Gefunden → `paper` in der eigenen Datei (partielles Update, mit
        // Rückgängig); nicht gefunden → der Weg in den Import des Kerns.
        async linkByDoi() {
            const doi = atlasBareDoi(this.doi);
            const pub = this.linkPub;
            if (!doi || !pub || this.linking) return;
            this.linking = true;
            this.linkResult = null;
            try {
                const res = await api('/api/papers/by-doi/exists', { method: 'POST', body: JSON.stringify({ dois: [doi] }) });
                const itemId = ((res && res.papers) || {})[doi];
                if (itemId === null || itemId === undefined) {
                    this.linkResult = { state: 'missing', doi, title: pub.title };
                    return;
                }
                const bib = await api(`/api/papers/${itemId}/bibtex`);
                const key = bib && bib.key;
                if (!key) throw new Error('Das Paper in der Bibliothek hat keinen Cite Key.');
                const previous = pub.paper || null;
                await this.setPaper(pub.id, key);
                this.doi = '';
                this.linkResult = { state: 'linked', doi, title: pub.title, key };
                atlasToast('„' + pub.title + '“ ist mit deinem Paper verknüpft – Band, Heft, Seiten und DOI kommen jetzt aus der Bibliothek.', {
                    actionLabel: 'Rückgängig',
                    action: async () => {
                        try {
                            await this.setPaper(pub.id, previous);
                            this.linkResult = null;
                            atlasToast('Rückgängig gemacht.');
                        } catch (e) {
                            atlasToast(atlasErrorText(e), { tone: 'danger' });
                        }
                        await this.refresh();
                    },
                });
                await this.refresh();
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            } finally {
                this.linking = false;
            }
        },
        setPaper(pubId, key) {
            return api('/api/plugins/atlas/publications/' + encodeURIComponent(pubId), {
                method: 'PUT', body: JSON.stringify({ paper: key }),
            });
        },
        importDoi() {
            if (this.linkResult && this.linkResult.doi) this.$router.push(atlasImportRoute([this.linkResult.doi]));
        },
    },
    mounted() {
        this.load();
        // Erstes Laden: die Vorwahl aus `?verknuepfen=` gilt genau hier
        // (und im Watcher, wenn sie sich ändert).
        this.loadPubs().then(() => this.preselect(this.$route.query.verknuepfen));
        atlasLoadEntities();
        if (!atlasWork.today) atlasRefreshToday();
        this._live = atlasLiveReload((kinds) => this.reloadFor(kinds));
    },
    beforeUnmount() {
        if (this._live) { this._live.close(); this._live = null; }
    },
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
        'atlas.today': AtlasOverviewPage,
        // Kalender (#224): die Wochenroute; die Rückblick-Route öffnet ihn im
        // Rückblick-Modus.
        'atlas.week': AtlasCalendarPage,
        'atlas.review': AtlasCalendarPage,
        'atlas.collection': AtlasPage,
        'atlas.zettel': AtlasZettelPage,
        'atlas.publications': AtlasPipelinePage,
        'atlas.publication': AtlasPublicationPage,
        // Publikationsliste (#228): eigene Adresse neben der Pipeline.
        'atlas.publication-list': AtlasPublicationListPage,
    },
    subroutes: [
        { path: '/atlas/woche/:week?', view: 'atlas.week' },
        { path: '/atlas/rueckblick/:week?', view: 'atlas.review' },
        { path: '/atlas/sammlung', view: 'atlas.collection' },
        { path: '/atlas/zettel/:id?', view: 'atlas.zettel' },
        { path: '/atlas/veroeffentlichungen', view: 'atlas.publications' },
        { path: '/atlas/veroeffentlichungen/:id', view: 'atlas.publication' },
        { path: '/atlas/publikationsliste', view: 'atlas.publication-list' },
    ],
    slots: {
        'item-list-filter': { key: 'atlas.project-filter', component: AtlasItemListFilter },
        'item-detail-aside': { key: 'atlas.links', component: AtlasItemDetailAside },
        'research-chat-context': { key: 'atlas.diss-context', component: AtlasResearchChatContext },
        'settings': { key: 'atlas.settings', component: AtlasSettings },
    },
});
})();
