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
                if (!resp.ok) throw await atlasResponseError(resp, 'Kompilieren fehlgeschlagen');
                const blob = await resp.blob();
                if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
                this.previewUrl = URL.createObjectURL(blob);
                this.$nextTick(() => this._cm.refresh());
            } catch (e) {
                this.compileError = atlasErrorText(e);
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
// Jede Art hat seit „Sammlung neu" ihre eigene Seite (atlasDetailRoute).
function atlasEntityRoute(entity) {
    if (!entity) return null;
    return atlasDetailRoute(entity.kind, entity.id);
}

// Markdown-Fließtext schreibt der Editor des Kerns (Contract 2.4). Atlas gibt
// ihm die Verweise: `[[` sucht im Entitäten-Cache, ein Chip zeigt den Titel und
// springt auf die Seite der Entität (`atlasEntityHref`); ein hängender
// Verweis bleibt gestrichelt stehen. Zitate `[@key]` löst der Kern selbst auf.
const ATLAS_FOLD = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function atlasWikiTarget(id) {
    const e = atlasEntity(id);
    if (!e) return null;
    return { title: e.title || id, href: atlasEntityHref(id), kindLabel: ATLAS_KIND_LABEL[e.kind] || e.kind };
}

const ATLAS_MD_RESOLVERS = Object.freeze({
    wikilink: Object.freeze({
        title: 'Verweis auf Atlas',
        async search(q) {
            const all = await atlasLoadEntities();
            const f = ATLAS_FOLD(q);
            const hits = all.filter((e) => !f || ATLAS_FOLD(e.title + ' ' + e.id).includes(f));
            // Was mit dem Gesuchten anfängt, steht oben.
            hits.sort((a, b) => Number(!ATLAS_FOLD(a.title).startsWith(f)) - Number(!ATLAS_FOLD(b.title).startsWith(f)));
            return hits.slice(0, 7).map((e) => ({ id: e.id, title: e.title || e.id, kindLabel: ATLAS_KIND_LABEL[e.kind] || e.kind }));
        },
        resolve(id) {
            if (atlasWork.entitiesLoaded) return atlasWikiTarget(id);
            return atlasLoadEntities().then(() => atlasWikiTarget(id));
        },
    }),
});

// Ein Kern ohne Editor (älter als Contract 2.4) bekommt ein schlichtes
// Textfeld mit derselben Schnittstelle.
const AtlasPlainEditor = {
    props: { modelValue: { type: String, default: '' }, readonly: Boolean, placeholder: { type: String, default: '' } },
    emits: ['update:modelValue', 'focus', 'blur'],
    template: `<textarea class="atlas-textarea is-prose" rows="8" :value="modelValue" :readonly="readonly"
                         :placeholder="placeholder" @input="$emit('update:modelValue', $event.target.value)"
                         @focus="$emit('focus')" @blur="$emit('blur')"></textarea>`,
    methods: { flush() {}, focus() { this.$el.focus(); } },
};
const AtlasCoreEditor = (LB.components && LB.components.MarkdownEditor) || AtlasPlainEditor;

// Jedes Markdown-Feld in Atlas: der Kern-Editor mit den Atlas-Verweisen.
// Er meldet nur echte Bearbeitungen, eine geöffnete Datei wird also nie
// umgeschrieben, nur weil sie angezeigt wurde.
const AtlasMarkdown = {
    components: { 'lb-markdown-editor': AtlasCoreEditor },
    props: {
        modelValue: { type: String, default: '' }, readonly: Boolean,
        placeholder: { type: String, default: '' }, autofocus: Boolean,
    },
    emits: ['update:modelValue', 'focus', 'blur'],
    computed: { resolvers() { return ATLAS_MD_RESOLVERS; } },
    template: `<lb-markdown-editor ref="md" class="atlas-md" :model-value="modelValue" :readonly="readonly"
                   :placeholder="placeholder" :resolvers="resolvers" :autofocus="autofocus"
                   @update:model-value="$emit('update:modelValue', $event)"
                   @focus="$emit('focus')" @blur="$emit('blur')" />`,
    methods: {
        flush() { if (this.$refs.md && this.$refs.md.flush) this.$refs.md.flush(); },
        focus() { if (this.$refs.md && this.$refs.md.focus) this.$refs.md.focus(); },
    },
};

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
    more: '<circle cx="5" cy="12" r="1.7"></circle><circle cx="12" cy="12" r="1.7"></circle><circle cx="19" cy="12" r="1.7"></circle>',
    archive: '<rect x="3" y="4" width="18" height="5" rx="1"></rect><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4"></path>',
    chevronDown: '<path d="M6 9l6 6 6-6"></path>',
    chevronUp: '<path d="M18 15l-6-6-6 6"></path>',
};

// Icons aus Punkten sind gefüllt, nicht gezeichnet.
const ATLAS_FILLED_ICONS = new Set(['grip', 'more']);

const AtlasIcon = {
    props: {
        name: { type: String, required: true },
        size: { type: [Number, String], default: 18 },
    },
    template: `<svg class="atlas-ico" :class="{ 'is-filled': filled.has(name) }" :width="size" :height="size"
                    viewBox="0 0 24 24" aria-hidden="true" focusable="false" v-html="paths"></svg>`,
    computed: {
        paths() { return ATLAS_ICON_PATHS[this.name] || ''; },
        filled() { return ATLAS_FILLED_ICONS; },
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
            { key: 'publikationsliste', label: 'Publikationsliste', to: ATLAS_PUBLICATION_LIST_ROUTE },
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
    publikationsliste: 'schreiben',
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
                return { route: atlasDetailRoute('idea', i.id), toast: 'Idee angelegt.' };
            }
            if (this.type === 'chapter') {
                const c = await post('/api/plugins/atlas/diss', {
                    title, publications: this.idsOf('publication'), body: this.linkBody(['publication']),
                });
                return { route: atlasDetailRoute('diss_node', c.id), toast: 'Kapitel angelegt.' };
            }
            if (this.type === 'pub') {
                const p = await post('/api/plugins/atlas/publications', {
                    title, projects: this.idsOf('project'), derived_from: this.idsOf('idea'),
                    body: this.linkBody(['project', 'idea']),
                });
                return { route: atlasPublicationRoute(p.id), toast: 'Veröffentlichung angelegt.' };
            }
            const pr = await post('/api/plugins/atlas/projects', { title, body: this.linkBody() });
            return { route: atlasDetailRoute('project', pr.id), toast: 'Projekt angelegt.' };
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
function atlasPublicationRoute(id) {
    return '/atlas/veroeffentlichungen/' + encodeURIComponent(id);
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

// Die Wochen-ID `n` Wochen neben `week` (`2026-W30`, -1 → `2026-W29`): vom
// Montag der Woche aus gerechnet, über `atlasWeekIdOf` — also auch über den
// Jahreswechsel richtig. Für den Kalender, wenn die Woche selbst nicht geladen
// werden konnte (ihre Datei ist nicht lesbar) und der Server keine Nachbarn nennt.
function atlasWeekShift(week, n) {
    const m = /^(\d{4})-W(\d{2})$/.exec(String(week || ''));
    if (!m) return '';
    const year = Number(m[1]);
    const jan4 = new Date(year, 0, 4);
    const monday = 4 - ((jan4.getDay() + 6) % 7) + (Number(m[2]) - 1 + n) * 7;
    return atlasWeekIdOf(new Date(year, 0, monday));
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

// Die Listen der Sammlung (Sammlung neu, 2026-10-22): Ideen (Pinnwand),
// Dissertation (Gliederung) und Projekte, dazu der LaTeX-Editor. Ein Eintrag
// öffnet seine eigene Seite (atlasDetailRoute) — keine Schublade mehr, kein
// Bearbeiten-Formular. Was vorbei ist, steht eingeklappt im „Archiv" der
// Liste. Veröffentlichungen haben die Pipeline; alte Tiefenlinks auf die
// Sammlung (?idea=, ?pub=, ?proj=, ?chapter=, ?tab=veroeffentlichungen)
// leiten auf die neuen Adressen um.
const AtlasPage = {
    components: {
        'atlas-editor': AtlasEditor,
        'atlas-nav': AtlasNav,
        'atlas-header': AtlasHeader,
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
                        <button @click="onImportClick" class="atlas-pill">.md importieren</button>
                        <button @click="openCapture" class="atlas-pill"><span>+</span> Neue Idee</button>
                    </template>
                    <button v-else-if="tab === 'dissertation'" @click="openNodeCreate" class="atlas-pill"><span>+</span> Neues Kapitel</button>
                    <router-link v-else-if="tab === 'editor'" :to="publicationsRoute" class="atlas-pill" style="text-decoration:none">← Zurück zu Veröffentlichungen</router-link>
                    <button v-else-if="tab === 'projekte'" @click="openProjectCreate" class="atlas-pill"><span>+</span> Neues Projekt</button>
            </atlas-header>
            <atlas-nav :active="navKey" class="mb-5" />

            <!-- ===== IDEEN ===== -->
            <template v-if="tab === 'ideen'">
            <div class="flex items-center gap-2 mb-5">
                <label class="atlas-sr" for="atlas-idea-filter-type">Typ</label>
                <select id="atlas-idea-filter-type" v-model="filterType"
                        class="border border-hairline rounded-lg px-3 py-1.5 text-sm bg-white focus:ring-2 focus:ring-accent outline-none">
                    <option value="">Alle Typen</option>
                    <option v-for="t in types" :key="t.key" :value="t.key">{{ t.label }}</option>
                </select>
                <label class="atlas-sr" for="atlas-idea-filter-text">Suche</label>
                <input id="atlas-idea-filter-text" v-model="filterText" type="text" placeholder="Suche Titel / #tag"
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

            <!-- Pinnwand (#59): Seed und In Arbeit; Ausgearbeitetes und Geparktes im Archiv -->
            <div v-else class="space-y-6">
                <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    <router-link v-for="idea in activeIdeas" :key="idea.id" :to="ideaRoute(idea.id)"
                                 class="atlas-idea-card block bg-white border border-hairline rounded-xl p-4 hover:border-accent transition-colors">
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
                            <span v-if="idea.refs && idea.refs.length">{{ idea.refs.length }} {{ idea.refs.length === 1 ? 'Referenz' : 'Referenzen' }}</span>
                            <span v-if="idea.diss && idea.diss.length">{{ idea.diss.length }} {{ idea.diss.length === 1 ? 'Kapitel' : 'Kapitel' }}</span>
                        </div>
                    </router-link>
                    <div v-if="!activeIdeas.length" class="col-span-full text-sm text-mute italic">Keine aktiven Ideen.</div>
                </div>

                <div v-if="archivedIdeas.length">
                    <button type="button" @click="ideaArchiveOpen = !ideaArchiveOpen" :aria-expanded="ideaArchiveOpen ? 'true' : 'false'"
                            class="atlas-archive-fold">
                        <span aria-hidden="true">{{ ideaArchiveOpen ? '▾' : '▸' }}</span>
                        <span class="atlas-archive-fold-title">Archiv</span>
                        <span class="atlas-archive-fold-sub">{{ archivedIdeas.length }} · ausgearbeitet und geparkt</span>
                    </button>
                    <div v-show="ideaArchiveOpen" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                        <router-link v-for="idea in archivedIdeas" :key="idea.id" :to="ideaRoute(idea.id)"
                                     class="atlas-idea-card is-archived block bg-white border border-hairline rounded-xl p-4 hover:border-accent transition-colors">
                            <div class="flex items-center gap-2 mb-2">
                                <span class="text-[10px] font-medium px-1.5 py-0.5 rounded" :class="typeClass(idea.type)">{{ typeLabel(idea.type) }}</span>
                                <span class="atlas-badge is-small">{{ statusLabel(idea.status) }}</span>
                            </div>
                            <div class="text-sm font-medium text-ink leading-snug mb-2">{{ idea.title || '(ohne Titel)' }}</div>
                            <div v-if="bodyPreview(idea)" class="text-[12px] text-ink-3 leading-snug line-clamp-3">{{ bodyPreview(idea) }}</div>
                        </router-link>
                    </div>
                </div>
            </div>
            </template>

            <!-- ===== DISSERTATION (flache Kapitelliste, ADR-0005, Issue #62) ===== -->
            <template v-else-if="tab === 'dissertation'">
                <div v-if="dissLoading" class="text-sm text-mute">Lädt…</div>
                <div v-else>
                    <div class="flex items-center justify-between mb-4">
                        <h2 class="text-base font-semibold text-ink">Dissertation</h2>
                        <div class="flex items-center gap-2">
                            <button v-if="dissChapters.length" @click="deleteAllNodes" class="px-3 py-1.5 rounded-lg text-sm font-medium border border-red-300 text-red-600 hover:bg-red-50 transition-colors">Gliederung komplett löschen</button>
                            <button @click="openNodeCreate" class="bg-accent text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-accent-ink transition-colors">+ Kapitel</button>
                        </div>
                    </div>
                    <div v-if="dissIssues.length" class="mb-4 bg-amber-50 border border-amber-200 rounded-lg p-3">
                        <p class="text-xs font-medium text-amber-800 mb-1">Integritätswarnungen</p>
                        <ul class="list-disc pl-4 text-xs text-amber-700 space-y-0.5">
                            <li v-for="(it, i) in dissIssues" :key="i"><span class="font-mono">{{ it.id }}</span>: {{ it.issue }}</li>
                        </ul>
                    </div>
                    <div v-if="!dissChapters.length" class="border border-dashed border-hairline-2 rounded-xl p-10 text-center">
                        <p class="text-ink font-medium mb-1">Noch keine Kapitel</p>
                        <p class="text-sm text-mute">Gliedere deine kumulative Dissertation als flache Kapitelliste.</p>
                    </div>
                    <div v-else>
                        <div class="bg-white border border-hairline rounded-xl px-5 py-3 mb-4 flex items-center gap-4">
                            <span class="text-sm text-mute flex-shrink-0">Fortschritt</span>
                            <div class="flex-1 bg-bg-soft rounded-full h-2 overflow-hidden">
                                <div class="h-full bg-accent rounded-full transition-all" :style="{ width: dissProgressFraction + '%' }"></div>
                            </div>
                            <span class="text-sm text-mute flex-shrink-0 whitespace-nowrap">{{ dissProgress.with_body || 0 }} von {{ dissProgress.total || 0 }} Kapiteln verfasst</span>
                        </div>
                        <div class="bg-white border border-hairline rounded-xl divide-y divide-hairline overflow-hidden">
                            <div v-for="(chapter, idx) in dissChapters" :key="chapter.id" class="px-4 py-3">
                                <div class="flex items-center gap-2">
                                    <span class="text-xs font-mono text-mute w-5 flex-shrink-0 text-right select-none">{{ idx + 1 }}</span>
                                    <router-link :to="chapterRoute(chapter.id)" class="atlas-chapter-link flex-1 text-left text-sm font-medium text-ink hover:text-accent-ink transition-colors truncate min-w-0">{{ chapter.title || '(ohne Titel)' }}</router-link>
                                    <span class="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0" :class="nodeStatusClass(chapter.status)">{{ nodeStatusLabel(chapter.status) }}</span>
                                    <button v-if="idx > 0" @click.stop="moveChapterUp(chapter)" class="text-mute hover:text-ink px-1 text-xs leading-none flex-shrink-0" :aria-label="'„' + (chapter.title || chapter.id) + '“ nach oben verschieben'" title="Nach oben verschieben">▲</button>
                                    <span v-else class="w-4 flex-shrink-0"></span>
                                    <button v-if="idx < dissChapters.length - 1" @click.stop="moveChapterDown(chapter)" class="text-mute hover:text-ink px-1 text-xs leading-none flex-shrink-0" :aria-label="'„' + (chapter.title || chapter.id) + '“ nach unten verschieben'" title="Nach unten verschieben">▼</button>
                                    <span v-else class="w-4 flex-shrink-0"></span>
                                </div>
                                <div v-if="chapterPublicationsResolved(chapter).length || !chapter.body || !chapter.body.trim()" class="mt-1.5 ml-7 flex flex-wrap items-center gap-x-3 gap-y-1">
                                    <span v-for="p in chapterPublicationsResolved(chapter)" :key="p.id" class="inline-flex items-center gap-1 text-xs text-ink-2">
                                        <span v-if="p.found" class="text-[10px] px-1 py-0.5 rounded flex-shrink-0" :class="pubStatusClass(p.status)">{{ pubStatusLabel(p.status) }}</span>
                                        <span v-if="!p.found" class="text-[10px] text-amber-600 flex-shrink-0">⚠</span>
                                        <router-link v-if="p.found" :to="publicationRoute(p.id)" class="truncate max-w-[200px] hover:text-accent-ink">{{ p.title }}</router-link>
                                        <span v-else class="truncate max-w-[200px]">{{ p.id }}</span>
                                    </span>
                                    <span v-if="!chapter.body || !chapter.body.trim()" class="text-[11px] text-amber-600">⚠ noch kein Inhalt</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div v-if="showNodeCreate" class="fixed inset-0 bg-black/30 flex items-start justify-center z-50 pt-28" @click.self="showNodeCreate = false">
                    <div class="bg-white rounded-xl shadow-modal p-5 w-full max-w-lg" role="dialog" aria-modal="true" aria-label="Neues Kapitel">
                        <h3 class="text-base font-semibold text-ink mb-3">Neues Kapitel</h3>
                        <input ref="nodeTitle" v-model="nodeCreate.title" @keydown.enter="submitNodeCreate" aria-label="Titel des Kapitels"
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

            <!-- ===== PROJEKTE (Forschungsprojekte, atlas.project/5) ===== -->
            <template v-else-if="tab === 'projekte'">
                <div v-if="projectsLoading" class="text-sm text-mute">Lädt…</div>
                <div v-else-if="!projects.length" class="border border-dashed border-hairline-2 rounded-xl p-10 text-center">
                    <p class="text-ink font-medium mb-1">Noch keine Forschungsprojekte</p>
                    <p class="text-sm text-mute mb-4">Halte Laufzeit, Förderung, Meilensteine und projektrelevante Literatur fest.</p>
                    <button @click="openProjectCreate" class="bg-accent text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-accent-ink transition-colors">+ Erstes Projekt</button>
                </div>
                <div v-else class="max-w-3xl">
                    <div class="space-y-3 mb-4">
                        <p v-if="!activeProjects.length" class="text-sm text-mute italic">Keine laufenden Projekte.</p>
                        <router-link v-for="p in activeProjects" :key="p.id" :to="projectRoute(p.id)"
                                     class="atlas-project-tile block w-full text-left bg-white border border-hairline rounded-xl p-4 hover:border-accent transition-colors">
                            <div class="flex items-center gap-2 mb-2">
                                <span class="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0" :class="projStatusClass(p.status)">{{ projStatusLabel(p.status) }}</span>
                                <span class="text-sm font-medium text-ink flex-1 truncate">{{ p.title }}</span>
                                <atlas-collection-badge :entry="p" />
                                <span v-if="p.funder || p.grant_id" class="text-[11px] text-mute flex-shrink-0">
                                    {{ [p.funder, p.grant_id].filter(Boolean).join(' · ') }}
                                </span>
                            </div>
                            <template v-if="projRuntimeBar(p)">
                                <div class="relative h-2 rounded-full bg-bg-soft overflow-visible mb-0.5">
                                    <div class="absolute inset-y-0 left-0 rounded-full" style="background: var(--lb-accent); opacity: 0.35;" :style="{ width: (projRuntimeBar(p).fraction * 100) + '%' }"></div>
                                    <div class="absolute top-1/2 -translate-y-1/2 w-0.5 h-3 rounded-full z-10" style="background: var(--lb-accent);"
                                         :style="{ left: 'calc(' + (projRuntimeBar(p).fraction * 100) + '% - 1px)' }"></div>
                                </div>
                                <p class="text-[11px] text-mute mb-1.5">{{ projRuntimeBar(p).label }}</p>
                            </template>
                            <div v-if="projOverdueCount(p) || projNextMilestone(p)" class="flex flex-wrap items-center gap-2 mb-1.5">
                                <span v-if="projOverdueCount(p)" class="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-800 flex-shrink-0">{{ projOverdueCount(p) }} Meilenstein(e) überfällig</span>
                                <span v-if="projNextMilestone(p)" class="text-[11px] text-mute truncate">Nächster: {{ projNextMilestone(p).title }}<template v-if="projNextMilestone(p).date"> · {{ projNextMilestone(p).date }}</template></span>
                            </div>
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
                            <div class="flex flex-wrap items-center gap-2">
                                <span v-if="projPublicationCount(p.id)" class="text-[11px] text-mute">
                                    {{ projPublicationCount(p.id) }} Veröffentlichung{{ projPublicationCount(p.id) === 1 ? '' : 'en' }}
                                </span>
                                <span v-for="t in (p.tags || [])" :key="t" class="text-[10px] text-ink-3 bg-bg-soft px-1.5 py-0.5 rounded">#{{ t }}</span>
                            </div>
                        </router-link>
                    </div>

                    <div v-if="archivedProjects.length" class="mt-2">
                        <button type="button" @click="projectArchiveOpen = !projectArchiveOpen" :aria-expanded="projectArchiveOpen ? 'true' : 'false'"
                                class="atlas-archive-fold">
                            <span aria-hidden="true">{{ projectArchiveOpen ? '▾' : '▸' }}</span>
                            <span class="atlas-archive-fold-title">Archiv</span>
                            <span class="atlas-archive-fold-sub">{{ archivedProjects.length }} · abgeschlossen und abgelehnt</span>
                        </button>
                        <div v-show="projectArchiveOpen" class="space-y-2">
                            <router-link v-for="p in archivedProjects" :key="p.id" :to="projectRoute(p.id)"
                                         class="atlas-project-tile is-archived block w-full text-left bg-white border border-hairline rounded-xl p-3 hover:border-accent transition-colors">
                                <div class="flex items-center gap-2">
                                    <span class="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0" :class="projStatusClass(p.status)">{{ projStatusLabel(p.status) }}</span>
                                    <span class="text-sm text-ink-2 flex-1 truncate">{{ p.title }}</span>
                                    <atlas-collection-badge :entry="p" />
                                    <span v-if="p.start || p.end" class="text-[11px] text-mute flex-shrink-0">{{ projPeriod(p) }}</span>
                                </div>
                            </router-link>
                        </div>
                    </div>
                </div>

                <div v-if="showProjectCreate" class="fixed inset-0 bg-black/30 flex items-start justify-center z-50 pt-28" @click.self="showProjectCreate = false">
                    <div class="bg-white rounded-xl shadow-modal p-5 w-full max-w-lg" role="dialog" aria-modal="true" aria-label="Neues Forschungsprojekt">
                        <h3 class="text-base font-semibold text-ink mb-3">Neues Forschungsprojekt</h3>
                        <input ref="projectTitle" v-model="projectCreate.title" @keydown.enter="submitProjectCreate" aria-label="Titel des Projekts"
                               placeholder="Titel, z. B. FGC-Robotik (DFG)"
                               class="w-full border border-hairline rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-accent outline-none mb-3" />
                        <select v-model="projectCreate.status" aria-label="Stand" class="border border-hairline rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-accent outline-none mb-3">
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
            </template>

            <!-- ===== LaTeX-Editor ===== -->
            <atlas-editor v-else-if="tab === 'editor'" :initial-id="editorInitialId"></atlas-editor>

            <!-- Quick-Capture modal -->
            <div v-if="showCapture" class="fixed inset-0 bg-black/30 flex items-start justify-center z-50 pt-32" @click.self="showCapture = false">
                <div class="bg-white rounded-xl shadow-modal p-5 w-full max-w-lg" role="dialog" aria-modal="true" aria-label="Neue Idee">
                    <h3 class="text-base font-semibold text-ink mb-3">Neue Idee</h3>
                    <input ref="captureTitle" v-model="capture.title" @keydown.enter="submitCapture" aria-label="Titel der Idee"
                           placeholder="Titel der Idee… (Enter zum Speichern)"
                           class="w-full border border-hairline rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-accent outline-none mb-3" />
                    <div class="flex items-center gap-2 mb-3">
                        <select v-model="capture.type" aria-label="Art der Idee"
                                class="border border-hairline rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-accent outline-none">
                            <option v-for="t in types" :key="t.key" :value="t.key">{{ t.label }}</option>
                        </select>
                        <input v-model="capture.tags" placeholder="#tags, kommagetrennt" aria-label="Schlagworte"
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
            showCapture: false,
            filterType: '',
            filterText: '',
            capture: { title: '', type: 'paper-idea', tags: '' },
            saving: false,
            error: '',
            statuses: ATLAS_STATUSES,
            types: ATLAS_TYPES,
            dragOver: false,
            importing: false,
            ideaArchiveOpen: false,
            tab: 'ideen',
            dissChapters: [],
            dissProgress: {},
            dissIssues: [],
            dissLoading: true,
            showNodeCreate: false,
            nodeCreate: { title: '' },
            savingNode: false,
            nodeError: '',
            projects: [],
            projectsLoading: true,
            projectStatuses: PROJECT_STATUSES,
            projectArchiveOpen: false,
            showProjectCreate: false,
            projectCreate: { title: '', status: 'planned' },
            savingProject: false,
            projectError: '',
            // Für die Kapitelzeilen (Status der Veröffentlichungen) und die
            // Veröffentlichungszahl der Projekt-Kacheln.
            publications: [],
            editorInitialId: null,
        };
    },
    computed: {
        // Welcher Unterpunkt der Navigation leuchtet: der Editor gehört zu den
        // Veröffentlichungen (seine Manuskripte liegen dort in den Dateien).
        navKey() {
            if (this.tab === 'editor') return 'veroeffentlichungen';
            if (this.tab === 'dissertation') return 'kapitel';
            if (this.tab === 'projekte') return 'projekte';
            return 'ideen';
        },
        // Kopf der Sammlung je Bereich (#223): Kicker = Bereich, Titel = Unterpunkt.
        headKicker() {
            const area = atlasAreaOf(this.navKey);
            return 'Atlas · ' + (area ? area.label : 'Sammlung');
        },
        headTitle() {
            const titles = { kapitel: 'Dissertation', veroeffentlichungen: 'LaTeX-Editor', ideen: 'Ideen', projekte: 'Projekte' };
            return titles[this.navKey] || 'Sammlung';
        },
        headNewType() {
            const types = { kapitel: 'chapter', veroeffentlichungen: 'pub', ideen: 'idea', projekte: 'project' };
            return types[this.navKey] || 'task';
        },
        publicationsRoute() { return ATLAS_PUBLICATIONS_ROUTE; },
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
            return this.filtered.filter((i) => !ATLAS_IDEA_CLOSED.has(i.status));
        },
        archivedIdeas() {
            return this.filtered.filter((i) => ATLAS_IDEA_CLOSED.has(i.status));
        },
        dissProgressFraction() {
            const total = (this.dissProgress && this.dissProgress.total) || 0;
            const done = (this.dissProgress && this.dissProgress.with_body) || 0;
            if (total === 0) return 0;
            return Math.round((done / total) * 100);
        },
        activeProjects() {
            return this.projects.filter((p) => !ATLAS_PROJECT_CLOSED.has(p.status));
        },
        archivedProjects() {
            return this.projects.filter((p) => ATLAS_PROJECT_CLOSED.has(p.status));
        },
    },
    methods: {
        ideaRoute(id) { return atlasDetailRoute('idea', id); },
        chapterRoute(id) { return atlasDetailRoute('diss_node', id); },
        projectRoute(id) { return atlasDetailRoute('project', id); },
        publicationRoute(id) { return atlasPublicationRoute(id); },
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
                this.$router.push(this.ideaRoute(created.id));
            } catch (e) {
                this.error = atlasErrorText(e);
            } finally {
                this.saving = false;
            }
        },
        typeLabel(t) { return (ATLAS_TYPES.find((x) => x.key === t) || {}).label || t; },
        statusLabel(s) { return (ATLAS_STATUSES.find((x) => x.key === s) || {}).label || s; },
        typeClass(t) { return ATLAS_TYPE_CLASS[t] || 'bg-bg-soft text-ink-3'; },
        connectSSE() {
            this._live = atlasLiveReload((kinds) => {
                const parts = [];
                if (atlasTouches(kinds, ['idea'])) parts.push(this.load());
                if (atlasTouches(kinds, ['diss_node', 'publication'])) parts.push(this.loadDiss(), this.loadPublications());
                if (atlasTouches(kinds, ['project', 'publication', 'collection'])) parts.push(this.loadProjects());
                return Promise.all(parts);
            });
        },
        onCaptureShortcut(e) {
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'I' || e.key === 'i')) {
                e.preventDefault();
                this.openCapture();
            }
        },
        // Alte Tiefenlinks (die Bibliothek, Lesezeichen, ältere Atlas-Stände)
        // führen auf die eigenen Seiten; der Tab steht in der Adresse.
        applyRoute() {
            const q = this.$route.query;
            if (q.idea) return this.$router.replace(atlasDetailRoute('idea', String(q.idea)));
            if (q.proj) return this.$router.replace(atlasDetailRoute('project', String(q.proj)));
            if (q.chapter) return this.$router.replace(atlasDetailRoute('diss_node', String(q.chapter)));
            if (q.pub) return this.$router.replace(atlasPublicationRoute(String(q.pub)));
            if (q.tab === 'veroeffentlichungen') {
                return this.$router.replace(q.focus === 'manuskripte'
                    ? { path: ATLAS_PUBLICATIONS_ROUTE, query: { manuskripte: '1' } }
                    : ATLAS_PUBLICATIONS_ROUTE);
            }
            if (q.tab === 'editor') {
                this.editorInitialId = q.manuscript ? String(q.manuscript) : null;
                this.tab = 'editor';
                return null;
            }
            this.tab = ['ideen', 'dissertation', 'projekte'].includes(q.tab) ? q.tab : 'ideen';
            return null;
        },
        // --- .md-Import (als Ideen) ------------------------------------------
        onImportClick() {
            if (this.$refs.mdInput) this.$refs.mdInput.click();
        },
        onDragLeave(e) {
            // Nur beim echten Verlassen des Rahmens, nicht beim Überqueren von Kindern.
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
            const done = [];
            for (const f of files) {
                try {
                    done.push(await this._importOne(f));
                } catch (err) {
                    console.error('Atlas import failed:', f.name, err);
                    atlasToast('Import fehlgeschlagen (' + f.name + '): ' + atlasErrorText(err), { tone: 'danger' });
                }
            }
            this.importing = false;
            await this.load();
            if (done.length === 1 && done[0] && done[0].id) this.$router.push(this.ideaRoute(done[0].id));
            else if (done.length > 1) atlasToast(done.length + ' Ideen importiert.');
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
            // Das .md-Overlay nur für echte Datei-Drags auf der Pinnwand.
            const types = e.dataTransfer ? Array.from(e.dataTransfer.types || []) : [];
            if (this.tab === 'ideen' && types.includes('Files')) { e.preventDefault(); this.dragOver = true; }
        },
        // Pinnwand (#59)
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
        // --- Dissertation (flache Kapitelliste, ADR-0005, Issue #62) ---------
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
        async deleteAllNodes() {
            if (!this.dissChapters.length) return;
            if (!confirm('Gesamte Gliederung löschen? Alle Kapitel werden unwiderruflich entfernt.')) return;
            try {
                await api('/api/plugins/atlas/diss', { method: 'DELETE' });
            } catch (e) { atlasToast('Löschen fehlgeschlagen: ' + atlasErrorText(e), { tone: 'danger' }); return; }
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
                this.$router.push(this.chapterRoute(created.id));
            } catch (e) {
                this.nodeError = atlasErrorText(e);
            } finally {
                this.savingNode = false;
            }
        },
        // Reihenfolge per ▲/▼: die order-Werte der Nachbarn tauschen (ADR-0005).
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
            } catch (e) { atlasToast('Verschieben fehlgeschlagen: ' + atlasErrorText(e), { tone: 'danger' }); return; }
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
            } catch (e) { atlasToast('Verschieben fehlgeschlagen: ' + atlasErrorText(e), { tone: 'danger' }); return; }
            await this.loadDiss();
        },
        // Veröffentlichungs-IDs eines Kapitels gegen die Liste aufgelöst;
        // hängende bleiben als { found: false } sichtbar, nie repariert.
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
        // Veröffentlichungen je Projekt per Reverse-Lookup über deren projects-Feld (ADR-0004).
        projPublicationCount(projectId) {
            return this.publications.filter((pub) => (pub.projects || []).includes(projectId)).length;
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
                this.$router.push(this.projectRoute(created.id));
            } catch (e) {
                this.projectError = atlasErrorText(e);
            } finally {
                this.savingProject = false;
            }
        },
        async loadPublications() {
            try {
                this.publications = (await api('/api/plugins/atlas/publications')).publications || [];
            } catch (e) {
                this.publications = [];
            }
        },
        pubStatusLabel(s) { return (PUBLICATION_STATUSES.find((x) => x.key === s) || {}).label || s; },
        pubStatusClass(s) { return PUBLICATION_STATUS_CLASS[s] || 'bg-bg-soft text-ink-3'; },
    },
    watch: {
        '$route.query'() { this.applyRoute(); },
        tab(val) {
            if (val === 'dissertation') this.loadDiss();
            else if (val === 'projekte') this.loadProjects();
            if (val !== 'editor') this.editorInitialId = null;
        },
    },
    mounted() {
        this.applyRoute();
        this.load();
        this.loadDiss();
        this.loadProjects();
        this.loadPublications();
        this.connectSSE();
        window.addEventListener('keydown', this.onCaptureShortcut);
    },
    beforeUnmount() {
        if (this._live) { this._live.close(); this._live = null; }
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
    // Eine Wochendatei, deren Kopf eine Hand-Edit zerbrochen hat (Review 2026-10-18).
    'error.atlas.week_unreadable': 'Die Wochendatei {file} lässt sich nicht lesen – meist ein Doppelpunkt ohne Anführungszeichen, etwa in einem Wochenziel, oder eine Woche im Kopf („week:"), die nicht zum Dateinamen passt. Bitte im Editor korrigieren; bis dahin ändert Atlas sie nicht.',
    // Eine Hand-Edit, die der Index (noch) nicht gelesen hat — ein Update
    // schriebe die alte Fassung darüber (Review 2026-10-18).
    'error.atlas.file_changed': 'Die Datei {file} wurde außerhalb von Atlas geändert und ist noch nicht eingelesen – oft ein Doppelpunkt ohne Anführungszeichen im Kopf. Bitte im Editor prüfen; bis dahin überschreibt Atlas sie nicht.',
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
    // Kern-Codes der Kern-Endpunkte, die Atlas selbst per `fetch` ruft (die
    // übrigen löst `LocalBib.api` gegen den Kernkatalog auf).
    'error.bibtex_unreadable': 'Die BibTeX-Datei ist nicht lesbar: {message}',
};

const ATLAS_CODE_RE = /^error\.[\w.]+$/;

// Was je Code für einen Parameter steht, der unterwegs verloren ging:
// `LocalBib.api` reicht von `{code, params}` eines Atlas-Codes nur den Code weiter.
const ATLAS_ERROR_PARAM_FALLBACK = {
    'error.atlas.week_unreadable': { file: 'im Ordner journal/' },
    'error.atlas.file_changed': { file: 'dieses Eintrags' },
};

// Der Satz zu einem `detail` einer Fehlerantwort. Der Kern schickt Codes als
// String oder als `{code, params}` (ADR-0018), FastAPI bei einer unpassenden
// Anfrage eine Liste, ältere Atlas-Routen deutsche Sätze. Ein Satz bleibt,
// ein Code wird übersetzt, alles andere wird eine allgemeine Meldung — nie
// „[object Object]", nie ein roher Code. `status` 0 = unbekannt.
function atlasDetailText(detail, status, fallback) {
    const failed = (fallback || 'Anfrage fehlgeschlagen') + (status ? ` (HTTP ${status})` : '');
    if (Array.isArray(detail)) return 'Die Anfrage war unvollständig oder ungültig.';
    const coded = !!detail && typeof detail === 'object';
    const code = coded ? detail.code : detail;
    const params = (coded && detail.params) || {};
    if (typeof code !== 'string' || !code.trim()) return failed + '.';
    const text = ATLAS_ERROR_TEXT[code];
    if (typeof text === 'string') {
        const lost = ATLAS_ERROR_PARAM_FALLBACK[code] || {};
        return text.replace(/\{(\w+)\}/g, (m, name) => (params[name] != null ? String(params[name]) : (lost[name] || '')));
    }
    if (!ATLAS_CODE_RE.test(code)) return code;
    return params.message ? `${failed}: ${params.message}` : failed + '.';
}

// Für Aufrufe, die nicht über `LocalBib.api` laufen (FormData-Uploads, die
// PDF-Vorschau): `if (!resp.ok) throw await atlasResponseError(resp);`
async function atlasResponseError(resp, fallback) {
    const body = await resp.json().catch(() => null);
    return new Error(atlasDetailText(body && body.detail, resp.status, fallback));
}

// Der Code hinter einem Fehler aus `LocalBib.api`: `⟦code⟧` (ein Code, den der
// Kernkatalog nicht kennt — dort ist er als `{code, params}` angekommen) oder
// der rohe Code-String, den der Kern unverändert durchreicht; sonst die
// Meldung selbst.
function atlasErrorCode(err) {
    const msg = (err && err.message) || String(err || '');
    const missing = /^⟦(.+)⟧$/.exec(msg);
    return missing ? missing[1] : msg;
}

function atlasErrorText(err) {
    return atlasDetailText(atlasErrorCode(err), 0);
}

// ── Nicht lesbare Wochendateien (Review 2026-10-18) ─────────────────────────
// Eine Hand-Edit kann den Kopf einer Wochendatei zerbrechen (`- title:
// Kapitel 3: Methodik` ohne Anführungszeichen). Der Server schreibt dann nichts
// in sie und nennt sie — `/journal/today` in `unreadable`, die Woche selbst als
// 409 `error.atlas.week_unreadable`. Je Datei der Satz dazu und „Im Editor
// öffnen": `/open` reicht eine vorhandene Datei ungelesen weiter.
const ATLAS_WEEK_UNREADABLE = 'error.atlas.week_unreadable';

function atlasWeekFile(week) {
    return { week, file: 'journal/' + week + '.md' };
}

const AtlasUnreadableWeeks = {
    components: { 'atlas-icon': AtlasIcon },
    props: { weeks: { type: Array, default: () => [] } },
    template: `
        <div v-if="weeks.length" class="atlas-unreadable" role="status">
            <p v-for="w in weeks" :key="w.week" class="atlas-unreadable-row">
                <atlas-icon name="alert" :size="16" />
                <span class="atlas-unreadable-text">{{ text(w) }}</span>
                <button type="button" class="atlas-text-btn" @click="open(w)">Im Editor öffnen</button>
            </p>
        </div>
    `,
    methods: {
        text(w) { return atlasDetailText({ code: ATLAS_WEEK_UNREADABLE, params: w }, 0); },
        async open(w) {
            try {
                await api('/api/plugins/atlas/journal/' + encodeURIComponent(w.week) + '/open', { method: 'POST' });
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
        },
    },
};

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
        'atlas-unreadable-weeks': AtlasUnreadableWeeks,
    },
    template: `
        <div class="atlas-page atlas-shell" lang="de">
            <atlas-header :kicker="kicker" :title="headline" :subtitle="summary" search :search-tasks="weekTasks" />
            <atlas-nav active="heute" />

            <atlas-capture @created="onCaptured" />
            <atlas-unreadable-weeks :weeks="unreadable" />

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
                                <li v-if="!todayAll.length && !weekUnreadable" class="atlas-todo-empty">
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
        // Wochendateien, die der Server übersprungen hat (diese oder die
        // Vorwoche): Hinweis oben, und keine Einladung, in sie zu schreiben.
        unreadable() { return (this.data && this.data.unreadable) || []; },
        weekUnreadable() { return !!this.data && this.unreadable.some((w) => w.week === this.data.week); },
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
                    open: atlasDetailRoute('project', m.project_id),
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
                    to: atlasDetailRoute('diss_node', c.id),
                });
            }
            for (const i of this.due.stale_ideas || []) {
                out.push({
                    key: 'id:' + i.id,
                    icon: 'bulb',
                    title: 'Idee: ' + (i.title || i.id),
                    note: this.since(i.days) + ' nicht weiterentwickelt',
                    to: atlasDetailRoute('idea', i.id),
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
            // Eine nicht lesbare Woche zeigt keine alten Zahlen weiter.
            if (weekData || this.weekUnreadable) this.week = weekData;
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
                const stats = await api('/api/plugins/atlas/reindex', { method: 'POST' });
                await atlasLoadEntities(true);
                // Eine Datei mit kaputtem YAML (Hand-Edit) wird übersprungen —
                // beim Namen nennen (Ordner/Datei), damit man sie findet. Eine
                // gesperrte (OneDrive, Editor) heißt so: erneut einlesen genügt.
                const bad = (stats && stats.unreadable) || [];
                if (bad.length) {
                    const names = bad.map((u) => String(u.path || '').split(/[\\/]/).slice(-2).join('/') + (u.locked ? ' (gesperrt)' : ''));
                    atlasToast(`Atlas-Ordner neu eingelesen – ${bad.length === 1 ? '1 Datei' : bad.length + ' Dateien'} nicht lesbar und übersprungen: ${names.join(', ')}`, { tone: 'danger', timeout: 20000 });
                } else {
                    atlasToast('Atlas-Ordner neu eingelesen.');
                }
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
    if (target === 'rejected') return title + ' liegt jetzt im Archiv der Veröffentlichungen. Nichts ist gelöscht.';
    if (target === 'withdrawn') return title + ' ist zurückgezogen und liegt im Archiv der Veröffentlichungen.';
    return title + ': ' + (ATLAS_PUBLICATION_STATUS_LABEL[target] || target) + '.';
}

// „Status wechseln" mit Rückgängig — geteilt von der Pipeline und den
// Schritten der Detailseite. `after` lädt die Seite neu. `extra.venue` (und
// `extra.due`) ist ein neues Ziel („Woanders einreichen"), `extra.message`
// ersetzt den Hinweis. Rückgängig schreibt `previous` zurück: den alten Wert
// jedes Feldes, das der Wechsel berührt hat, den Verlauf eingeschlossen.
async function atlasChangeStatus(pub, target, after, extra = {}) {
    const body = { status: target };
    if (extra.venue) body.venue = extra.venue;
    if ('due' in extra) body.due = extra.due;
    const res = await api('/api/plugins/atlas/publications/' + encodeURIComponent(pub.id) + '/status', {
        method: 'POST', body: JSON.stringify(body),
    });
    const undoBody = res.previous ? { ...res.previous } : { status: res.previous_status };
    if (!res.previous) for (const field of res.set || []) undoBody[field] = null;
    // „Veröffentlicht" führt in die Publikationsliste (#228): ohne eigenes
    // Paper gleich in „Eigenes Paper per DOI verknüpfen", vorgewählt.
    let link = null;
    if (target === 'published') {
        link = pub.paper
            ? { label: 'Publikationsliste', to: atlasPublicationListRoute() }
            : { label: 'DOI eintragen', to: atlasPublicationListRoute(pub.id) };
    }
    atlasToast(extra.message || atlasStatusToast(pub, target, res.set), {
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
                ? atlasDetailRoute('project', entry.id)
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
                    Archiv · {{ closed.length }}<span class="atlas-fold-sub">abgelehnt oder zurückgezogen</span>
                </button>
                <button type="button" class="atlas-fold-btn" :aria-expanded="showOrphans ? 'true' : 'false'"
                        :disabled="!orphans.length" @click="showOrphans = !showOrphans">
                    <atlas-icon :name="showOrphans ? 'chevronLeft' : 'chevronRight'" :size="16" />
                    LaTeX-Manuskript ohne Veröffentlichung · {{ orphans.length }}
                </button>
            </div>
            <ul v-if="showClosed && closed.length" class="atlas-fold-list" aria-label="Archiv: abgelehnt oder zurückgezogen">
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
                    <label :for="'atlas-orphan-' + m.id" class="atlas-sr">{{ m.id }}.tex zuordnen</label>
                    <select v-if="pubs.length" :id="'atlas-orphan-' + m.id" class="atlas-input is-field is-link is-compact" @change="assignOrphan(m, $event)">
                        <option value="">Zuordnen zu …</option>
                        <option v-for="p in pubs" :key="p.id" :value="p.id">{{ p.title }}</option>
                    </select>
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
        // Ein loses Manuskript seiner Veröffentlichung zuordnen (Issue #45):
        // ein Link, kein Besitz — die .tex bleibt in manuskripte/.
        async assignOrphan(m, event) {
            const pubId = event.target.value;
            event.target.value = '';
            if (!pubId) return;
            const pub = this.pubs.find((p) => p.id === pubId) || { title: pubId };
            try {
                await api('/api/plugins/atlas/publications/' + encodeURIComponent(pubId) + '/manuscripts', {
                    method: 'POST', body: JSON.stringify({ name: m.id + '.tex' }),
                });
                atlasToast('„' + m.id + '.tex“ gehört jetzt zu „' + pub.title + '“.', { link: { label: 'Öffnen', to: this.detailRoute(pubId) } });
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            await this.load(true);
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
        '$route.query.manuskripte'(v) { if (v) this.showOrphans = true; },
    },
    mounted() {
        if (this.$route.query.planen) this.planOpen = true;
        // Alte Tiefenlinks auf „Manuskripte" (?tab=veroeffentlichungen&focus=…)
        // landen hier, mit den losen .tex offen.
        if (this.$route.query.manuskripte) this.showOrphans = true;
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

// Herkunft eines Übertrags (`←YYYY-MM-DD`, ADR-0020) — im Titelfeld des
// Dialogs ausgeblendet und beim Speichern wieder angehängt.
const ATLAS_MOVED_FROM_MARK = /\s*←\s*\d{4}-\d{2}-\d{2}/;

// Eine Kachel des Kalenders: der Titel höchstens zwei Zeilen, nichts erscheint
// erst beim Überfahren (sonst bricht der Text neu um und die Kachel springt).
// Ein Klick öffnet die Details; Häkchen und Griff bleiben eigene Ziele.
const AtlasCalCard = {
    components: { 'atlas-icon': AtlasIcon },
    props: { card: { type: Object, required: true } },
    emits: ['open', 'toggle', 'grip-key'],
    template: `
        <div class="atlas-ccard" :class="cls">
            <button v-if="card.draggable" type="button" class="atlas-grip" :data-grip="card.key" :aria-label="gripLabel"
                    title="Ziehen oder Alt + Pfeiltaste" @keydown="$emit('grip-key', $event)"><atlas-icon name="grip" :size="16" /></button>
            <span v-else class="atlas-grip-space"></span>
            <input v-if="isTask" type="checkbox" class="atlas-check is-small" :checked="card.task.done"
                   :disabled="!!card.task.moved_to" :aria-label="'Erledigt: ' + card.title" @change="$emit('toggle')" />
            <span v-else class="atlas-ccard-flag"><atlas-icon :name="card.overdue ? 'alert' : 'flag'" :size="16" /></span>
            <div class="atlas-ccard-open" role="button" tabindex="0" :data-open="card.key" :title="card.title" :aria-label="openLabel"
                 @click="$emit('open')" @keydown.enter.prevent="$emit('open')" @keydown.space.prevent="$emit('open')">
                <span v-if="!isTask" class="atlas-ccard-kicker">{{ card.kicker }}</span>
                <span class="atlas-ccard-text" :class="{ 'is-strong': !isTask }">{{ card.title }}</span>
                <span v-if="card.meta || card.hasNote" class="atlas-ccard-meta">
                    <atlas-icon v-if="card.hasNote" name="note" :size="12" class="atlas-ccard-noteicon" />{{ card.meta }}
                </span>
            </div>
        </div>
    `,
    computed: {
        isTask() { return this.card.kind === 'task'; },
        cls() {
            const c = this.card;
            if (this.isTask) return { 'is-done': c.task.done, 'is-moved': !!c.task.moved_to };
            return { 'is-term': true, 'is-overdue': c.overdue, 'is-done': c.done };
        },
        what() {
            if (this.isTask) return 'Aufgabe';
            return this.card.kind === 'milestone' ? 'Meilenstein' : 'Frist';
        },
        gripLabel() { return this.what + ' verschieben: ' + this.card.title; },
        openLabel() { return 'Details: ' + this.card.title + (this.card.hasNote ? ' (mit Notiz)' : ''); },
    },
};

// Die Details einer Kachel. Aufgabe: Titel, Häkchen und Notiz — die Notiz
// steht eingerückt unter der Aufgabe in der Wochendatei. Termin: nur lesen und
// in Projekt bzw. Veröffentlichung springen, dort stehen seine Einzelheiten.
const AtlasCalDetail = {
    components: { 'atlas-markdown': AtlasMarkdown, 'atlas-icon': AtlasIcon },
    props: { card: { type: Object, required: true } },
    emits: ['close', 'changed'],
    template: `
        <div class="atlas-modal-backdrop" @click.self="requestClose(true)" @keydown.esc.prevent="requestClose(false)">
            <form class="atlas-modal is-medium" role="dialog" aria-modal="true" aria-labelledby="atlas-detail-kicker"
                  @submit.prevent="save" @keydown.ctrl.enter.prevent="save" @keydown.meta.enter.prevent="save">
                <div class="atlas-new-head">
                    <p id="atlas-detail-kicker" class="atlas-detail-kicker" :class="{ 'is-overdue': card.overdue }">{{ kicker }}</p>
                    <button ref="close" type="button" class="atlas-icon-square is-small" aria-label="Schließen" @click="requestClose(false)"><atlas-icon name="close" /></button>
                </div>

                <template v-if="isTask">
                    <div class="atlas-detail-titlerow">
                        <input type="checkbox" class="atlas-check" v-model="done" :disabled="moved" aria-label="Erledigt" />
                        <textarea v-model="title" class="atlas-detail-title" rows="2" aria-label="Titel der Aufgabe"
                                  :readonly="moved" @keydown.enter.exact.prevent="save"></textarea>
                    </div>
                    <div v-if="anchors.length || tags.length || moveText" class="atlas-detail-meta">
                        <template v-for="a in anchors" :key="a.id">
                            <router-link v-if="a.to" :to="a.to" class="atlas-chip"><span class="atlas-chip-label">{{ a.label }}</span></router-link>
                            <span v-else class="atlas-chip is-dangling" title="Ziel nicht gefunden">{{ a.id }}</span>
                        </template>
                        <span v-for="t in tags" :key="t" class="atlas-tag">#{{ t }}</span>
                        <span v-if="moveText">{{ moveText }}</span>
                    </div>
                    <div class="atlas-new-field">
                        <span class="atlas-new-legend" id="atlas-detail-note-label">Notizen</span>
                        <atlas-markdown id="atlas-detail-note" ref="note" v-model="note" :readonly="moved" :autofocus="!moved"
                                        aria-labelledby="atlas-detail-note-label"
                                        placeholder="Weitere Infos, Links, nächste Schritte …" />
                        <p class="atlas-new-help">{{ moved
                            ? 'Diese Aufgabe wurde übertragen – bearbeite sie am neuen Tag.'
                            : 'Wird eingerückt unter der Aufgabe in der Wochendatei gespeichert.' }}</p>
                    </div>
                    <div class="atlas-new-foot">
                        <button v-if="!moved" type="button" class="atlas-text-btn is-danger" :disabled="busy" @click="remove">Aufgabe löschen</button>
                        <span v-else></span>
                        <div class="atlas-row-gap">
                            <button type="button" class="atlas-btn" @click="requestClose(false)">{{ moved ? 'Schließen' : 'Abbrechen' }}</button>
                            <button v-if="!moved" type="submit" class="atlas-btn is-primary" :disabled="busy">{{ busy ? 'Speichert…' : 'Speichern' }}</button>
                        </div>
                    </div>
                </template>

                <template v-else>
                    <h2 class="atlas-modal-title is-detail">{{ card.title }}</h2>
                    <div class="atlas-detail-meta">
                        <span>{{ termContext }}</span>
                        <span v-if="card.done" class="atlas-reached"><atlas-icon name="check" :size="14" /> erledigt</span>
                    </div>
                    <p class="atlas-new-help">{{ card.kind === 'milestone'
                        ? 'Einzelheiten und Notizen zum Meilenstein stehen im Projekt.'
                        : 'Einzelheiten und Notizen zur Frist stehen in der Veröffentlichung.' }}</p>
                    <div class="atlas-new-foot">
                        <span></span>
                        <div class="atlas-row-gap">
                            <button type="button" class="atlas-btn" @click="requestClose(false)">Schließen</button>
                            <router-link v-if="card.open" :to="card.open" class="atlas-btn is-primary">
                                {{ card.kind === 'milestone' ? 'Projekt öffnen' : 'Veröffentlichung öffnen' }}
                            </router-link>
                        </div>
                    </div>
                </template>
            </form>
        </div>
    `,
    data() {
        const t = this.card.task;
        return {
            title: t ? String(t.raw || t.text || '').replace(ATLAS_MOVED_FROM_MARK, '').trim() : '',
            note: t ? (t.note || '') : '',
            done: t ? !!t.done : false,
            busy: false,
        };
    },
    computed: {
        isTask() { return this.card.kind === 'task'; },
        task() { return this.card.task || null; },
        moved() { return this.isTask && !!this.task.moved_to; },
        kicker() {
            const c = this.card;
            const what = this.isTask ? 'Aufgabe' : (c.kind === 'milestone' ? 'Meilenstein' : 'Frist');
            const parts = [what, atlasDayLong(c.date)];
            if (!this.isTask && c.overdue) parts.push('überfällig');
            return parts.filter(Boolean).join(' · ');
        },
        anchors() {
            return ((this.task && this.task.anchors) || []).map((id) => {
                const e = atlasEntity(id);
                return { id, label: (e && e.title) || id, to: atlasEntityRoute(e) };
            });
        },
        tags() { return (this.task && this.task.tags) || []; },
        moveText() {
            const t = this.task;
            if (!t) return '';
            if (t.moved_to) return 'übertragen auf ' + atlasDayLabel(t.moved_to);
            if (t.moved_from) return 'übertragen von ' + atlasDayLabel(t.moved_from);
            return '';
        },
        termContext() {
            const c = this.card;
            if (c.kind === 'milestone') return 'Projekt: ' + ((c.project && (c.project.title || c.project.id)) || c.meta);
            const venue = c.publication && c.publication.venue;
            return 'Frist der Veröffentlichung' + (venue ? ' · ' + venue : '');
        },
        // Der Titel, wie er in die Zeile geschrieben wird: eine Zeile, die
        // Herkunft eines Übertrags bleibt erhalten.
        lineText() {
            const text = this.title.replace(/\s*\n\s*/g, ' ').trim();
            return this.task && this.task.moved_from && text ? text + ' ←' + this.task.moved_from : text;
        },
        dirty() {
            const t = this.task;
            if (!t || this.moved) return false;
            return this.lineText !== String(t.raw || '').trim()
                || this.note.trim() !== (t.note || '').trim()
                || this.done !== !!t.done;
        },
    },
    methods: {
        url() {
            return '/api/plugins/atlas/journal/' + encodeURIComponent(this.task.week) + '/tasks/' + encodeURIComponent(this.task.body_index);
        },
        // Ein Klick neben den Dialog verwirft nichts, was schon getippt ist.
        requestClose(fromBackdrop) {
            if (this.$refs.note) this.$refs.note.flush();
            if (fromBackdrop && this.dirty) return;
            this.$emit('close');
        },
        async save() {
            if (!this.isTask || this.moved || this.busy) return;
            // Der Editor meldet Getipptes mit kurzer Verzögerung: erst holen.
            if (this.$refs.note) this.$refs.note.flush();
            const t = this.task;
            if (!this.title.trim()) { atlasToast('Die Aufgabe braucht einen Titel.', { tone: 'danger' }); return; }
            const body = {};
            if (this.lineText !== String(t.raw || '').trim()) body.text = this.lineText;
            if (this.note.trim() !== (t.note || '').trim()) body.note = this.note;
            this.busy = true;
            try {
                if (body.text !== undefined || body.note !== undefined) {
                    await api(this.url(), { method: 'PUT', body: JSON.stringify(body) });
                }
                if (this.done !== !!t.done) await api(this.url() + '/toggle', { method: 'POST' });
                this.busy = false;
                this.$emit('changed');
                this.$emit('close');
            } catch (e) {
                this.busy = false;
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
        },
        async remove() {
            if (this.busy) return;
            this.busy = true;
            try {
                await api(this.url(), { method: 'DELETE' });
                atlasToast('Aufgabe gelöscht.');
                this.busy = false;
                this.$emit('changed');
                this.$emit('close');
            } catch (e) {
                this.busy = false;
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
        },
    },
    mounted() {
        this.$nextTick(() => {
            const el = this.isTask && !this.moved ? this.$refs.note : this.$refs.close;
            if (el) el.focus();
        });
    },
};

const AtlasCalendarPage = {
    components: {
        'atlas-nav': AtlasNav,
        'atlas-header': AtlasHeader,
        'atlas-icon': AtlasIcon,
        'atlas-cal-card': AtlasCalCard,
        'atlas-cal-detail': AtlasCalDetail,
        'atlas-unreadable-weeks': AtlasUnreadableWeeks,
    },
    template: `
        <div class="atlas-page atlas-shell" lang="de">
            <atlas-header :kicker="'Atlas · Kalender · KW ' + (week ? week.number : weekNumberOf(weekId))" :title="rangeTitle">
                <div class="atlas-weekswitch" role="group" aria-label="Woche wechseln">
                    <router-link v-if="previousId" :to="routeFor(previousId)" class="atlas-weekswitch-btn"
                                 :aria-label="'Vorige Woche, KW ' + weekNumberOf(previousId)"><atlas-icon name="chevronLeft" /></router-link>
                    <router-link :to="routeFor('')" class="atlas-weekswitch-btn is-text">Diese Woche</router-link>
                    <router-link v-if="nextId" :to="routeFor(nextId)" class="atlas-weekswitch-btn"
                                 :aria-label="'Nächste Woche, KW ' + weekNumberOf(nextId)"><atlas-icon name="chevronRight" /></router-link>
                </div>
                <nav class="atlas-seg" aria-label="Ansicht">
                    <router-link :to="weekRoute" class="atlas-seg-item" :class="{ 'is-active': !isReview }" :aria-current="!isReview ? 'page' : null">Woche</router-link>
                    <router-link :to="reviewRoute" class="atlas-seg-item" :class="{ 'is-active': isReview }" :aria-current="isReview ? 'page' : null">Rückblick</router-link>
                </nav>
            </atlas-header>
            <atlas-nav :active="isReview ? 'rueckblick' : 'woche'" />
            <atlas-unreadable-weeks :weeks="unreadable" />

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
                            :draggable="c.draggable ? 'true' : 'false'" :data-card="c.key" @dragstart="onDragStart($event, c)" @dragend="onDragEnd">
                            <atlas-cal-card :card="c" @open="openCard(c)" @toggle="toggle(c.task)" @grip-key="onGripKey($event, c)" />
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
                                    <atlas-cal-card :card="c" @open="openCard(c)" @toggle="toggle(c.task)" @grip-key="onGripKey($event, c)" />
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

                <atlas-cal-detail v-if="detail" :key="detail.key" :card="detail" @close="closeDetail" @changed="load(true)" />
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
                            <router-link :to="chapterRoute(c.id)" class="atlas-notes-title">{{ c.title || c.id }}</router-link>
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
            // {week, file} der gezeigten bzw. der Folgewoche, wenn ihre Datei
            // nicht lesbar ist (409 `error.atlas.week_unreadable`).
            weekUnreadable: null,
            nextUnreadable: null,
            today: null,
            projects: [],
            publications: [],
            loading: true,
            dragging: null,
            overCol: null,
            busy: false,
            adding: '',
            addText: '',
            detail: null,   // die Kachel, deren Details offen sind (Momentaufnahme)
            reviewBusy: false,
            goalsOpen: false,
            goalDrafts: [],
            savingGoals: false,
        };
    },
    computed: {
        isReview() { return this.$route.path.startsWith('/atlas/rueckblick'); },
        // Die gezeigte Woche — auch wenn ihre Datei nicht lesbar ist und
        // `week` deshalb fehlt: dann aus dem Hinweis bzw. der Adresse, damit
        // Pfeile und Woche | Rückblick bei ihr bleiben statt bei heute.
        weekId() {
            if (this.week) return this.week.week;
            return (this.weekUnreadable && this.weekUnreadable.week) || this.$route.params.week || '';
        },
        previousId() { return this.week ? this.week.previous : atlasWeekShift(this.weekId, -1); },
        nextId() { return this.week ? this.week.next : atlasWeekShift(this.weekId, 1); },
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
        // Jede nicht lesbare Wochendatei, die diese Seite braucht, je Datei
        // einmal: die gezeigte Woche, die Folgewoche und — nur in der
        // laufenden Woche — was Heute übersprungen hat (die Vorwoche fehlt
        // dann in „Liegen geblieben").
        unreadable() {
            const all = [
                this.week ? null : this.weekUnreadable,
                this.week && this.nextUnreadable && this.nextUnreadable.week === this.week.next ? this.nextUnreadable : null,
                ...(this.isCurrentWeek ? (this.today && this.today.unreadable) || [] : []),
            ];
            const seen = new Set();
            return all.filter((w) => w && !seen.has(w.week) && seen.add(w.week));
        },
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
                        open: atlasDetailRoute('project', p.id),
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
        chapterRoute(id) { return atlasDetailRoute('diss_node', id); },
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
        // --- Details einer Kachel -------------------------------------------
        openCard(c) {
            this._detailReturn = document.activeElement;
            this.detail = c;
        },
        closeDetail() {
            this.detail = null;
            const back = this._detailReturn;
            this._detailReturn = null;
            this.$nextTick(() => { if (back && back.isConnected) back.focus(); });
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
                hasNote: !!(t.note && t.note.trim()),
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
                    this.weekUnreadable = null;
                } catch (e) {
                    if (atlasErrorCode(e) === ATLAS_WEEK_UNREADABLE) {
                        // Keine alte oder andere Woche stehen lassen — der
                        // Hinweis nennt die Datei, die zu korrigieren ist.
                        this.week = null;
                        this.weekUnreadable = atlasWeekFile(id);
                    } else if (!silent) atlasToast(atlasErrorText(e), { tone: 'danger' });
                }
            }
            const [next, projects, pubs] = await Promise.all([
                journal && this.week ? this.loadNext(this.week.next) : null,
                withProjects ? api('/api/plugins/atlas/projects').catch(() => null) : null,
                withPubs ? api('/api/plugins/atlas/publications').catch(() => null) : null,
            ]);
            if (journal) this.nextWeek = next;
            if (projects) this.projects = projects.projects || [];
            if (pubs) this.publications = pubs.publications || [];
            this.loading = false;
        },
        // Die Folgewoche für „Nächste Woche"; ist ihre Datei nicht lesbar,
        // bleibt die Spalte ohne Aufgaben und der Hinweis nennt die Datei.
        async loadNext(week) {
            try {
                const data = await api('/api/plugins/atlas/journal/' + encodeURIComponent(week));
                this.nextUnreadable = null;
                return data;
            } catch (e) {
                this.nextUnreadable = atlasErrorCode(e) === ATLAS_WEEK_UNREADABLE ? atlasWeekFile(week) : null;
                return null;
            }
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
    components: { 'atlas-markdown': AtlasMarkdown,
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
                            <router-link :to="ideaRoute(zettel.promoted_to)">
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
                                <h2 class="atlas-sec-title" id="atlas-zettel-text">Text</h2>
                                <span class="atlas-sec-note">„[[“ verweist, „@“ zitiert, „/“ für Blöcke</span>
                            </div>
                            <atlas-markdown ref="body" class="is-zettel" v-model="draft.body" aria-labelledby="atlas-zettel-text"
                                            placeholder="Verweise per [[…]], Zitate per @, Vereinbartes als Checkliste: - [ ] …"
                                            @focus="bodyFocused = true" @blur="bodyFocused = false" />
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
        ideaRoute(id) { return atlasDetailRoute('idea', id); },
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
                if (this.id) { this.flushBody(); this.saveNow(); }
            }
        },
        // Der Editor entprellt: was er noch nicht gemeldet hat, kommt vor
        // jedem Schreiben und jedem Wechsel in den Entwurf.
        flushBody() {
            if (this.$refs.body) this.$refs.body.flush();
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
            // Nur beim Öffnen eines Zettels: Auswahl und Meldung gehören dem
            // Menschen, der gerade arbeitet. Ein stilles Nachladen (eigener
            // Speichervorgang, externer Edit) darf sie nicht abräumen.
            if (!keepDraft) {
                this.selected = [];
                this.deriveMessage = '';
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
            // save() schreibt an `loadedId`, also noch an den alten Zettel.
            this.flushBody();
            if (this._save) { clearTimeout(this._save); this._save = null; }
            this.save();
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
        this.flushBody();
        if (this._save) { clearTimeout(this._save); this._save = null; }
        this.save();
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
            chapterLinks: [],
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
                this.chapterLinks = res.chapters || [];
                this.citekey = key;
            } catch (e) {
                this.links = [];
            }
            this.ready = true;
        },
        // Jede Art hat ihre eigene Seite (Sammlung neu).
        openIdea(id) {
            this.$router.push(atlasDetailRoute('idea', id));
        },
        openPublication(id) {
            this.$router.push(atlasPublicationRoute(id));
        },
        openProject(id) {
            this.$router.push(atlasDetailRoute('project', id));
        },
        openZettel(id) {
            this.$router.push('/atlas/zettel/' + encodeURIComponent(id));
        },
        openChapter(id) {
            this.$router.push(atlasDetailRoute('diss_node', id));
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
                alert('Uebernehmen fehlgeschlagen: ' + atlasErrorText(e));
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

            <!-- Kapitel, deren Skizze den Cite Key als [@key] zitiert (ADR-0026) -->
            <template v-if="chapterLinks.length">
                <h5 class="lb-aside-h mt-3">Zitiert in Kapiteln</h5>
                <div class="space-y-1.5">
                    <button v-for="ch in chapterLinks" :key="ch.id" @click="openChapter(ch.id)"
                            class="atlas-aside-link w-full text-left p-2 rounded-lg">
                        <span class="block text-sm font-medium" style="color: var(--lb-ink);">{{ ch.title }}</span>
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

// =============================================================================
// Detailseiten (Sammlung neu): eine Seite je Eintrag, ein Bauplan
// =============================================================================
// Veröffentlichung, Projekt, Idee und Kapitel haben je eine eigene Adresse und
// denselben Aufbau (Design-Leinwand „Atlas Sammlung neu", 2026-10-22): Kopf
// mit Rückweg, Titel als Feld, Speicherstand, Menü ⋯ und der Hauptaktion,
// darunter der Stand als Schritte; links der Inhalt, rechts Angaben, „Gehört
// zu", Fristen & Aufgaben und — bei Veröffentlichung und Projekt — der
// Verlauf. Es gibt keinen Bearbeiten-Modus und kein zweites Formular: ein Feld
// speichert beim Verlassen, Text nach einer Tipp-Pause (`AtlasAutosave`). Was
// vorbei ist, wird abgeschlossen und liegt im Archiv seiner Liste; Löschen
// steht nur im Menü ⋯ und sagt vorher, was geht und was bleibt.

const ATLAS_DETAIL_BASE = {
    publication: '/atlas/veroeffentlichungen/',
    project: '/atlas/projekte/',
    idea: '/atlas/ideen/',
    diss_node: '/atlas/kapitel/',
    zettel: '/atlas/zettel/',
};

// Die Liste, in die der Rückweg einer Detailseite führt.
const ATLAS_LIST_ROUTE = {
    publication: ATLAS_PUBLICATIONS_ROUTE,
    project: { path: '/atlas/sammlung', query: { tab: 'projekte' } },
    idea: { path: '/atlas/sammlung', query: { tab: 'ideen' } },
    diss_node: { path: '/atlas/sammlung', query: { tab: 'dissertation' } },
};

function atlasDetailRoute(kind, id) {
    const base = ATLAS_DETAIL_BASE[kind];
    return base && id ? base + encodeURIComponent(id) : null;
}

// Der Dateiname eines Eintrags relativ zum Atlas-Ordner, wie ihn der Nutzer im
// Explorer findet (`veroeffentlichungen/konf-b.md`).
function atlasFileLabel(folder, entity) {
    const name = String((entity && entity.path) || '').split(/[\\/]/).pop() || ((entity && entity.id) + '.md');
    return folder + '/' + name;
}

function atlasLongDate(iso) {
    return iso ? atlasFormatDate(iso, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
}

// Speichern ohne Knopf. `queueSave(patch)` sammelt Felder und schreibt sie
// nach einer Tipp-Pause, `saveNow(patch)` sofort (beim Verlassen eines Feldes,
// bei Auswahl und Datum) — beides mit EINEM partiellen Update, eins nach dem
// anderen. Die Seite liefert `persist(patch)` (gibt den neuen Stand zurück)
// und `onPersisted(entity)`. Der Stand steht in `saveState` ('saved' |
// 'saving' | 'error'); was noch nicht geschrieben ist oder gerade getippt
// wird, überschreibt kein Nachladen (`keepsDraft(field)`).
// Ein Schub merkt sich seinen Eintrag (`url()` beim ersten Feld): wechselt
// die Seite auf einen anderen Eintrag derselben Art, schreibt
// `switchEntity()` den alten fertig, bevor der neue lädt — nie landet ein
// Feld im falschen Eintrag, nie eine späte Antwort auf der neuen Seite.
const AtlasAutosave = {
    data() {
        return { saveState: 'saved', saveError: '', pendingPatch: {}, focused: '' };
    },
    methods: {
        targetSave() {
            if (!Object.keys(this.pendingPatch).length) this._saveUrl = this._switchUrl || this.url();
        },
        queueSave(patch, delay = 900) {
            this.targetSave();
            this.pendingPatch = { ...this.pendingPatch, ...patch };
            this.saveState = 'saving';
            if (this._saveTimer) clearTimeout(this._saveTimer);
            this._saveTimer = setTimeout(() => this.flushSave(), delay);
        },
        saveNow(patch) {
            this.targetSave();
            this.pendingPatch = { ...this.pendingPatch, ...patch };
            return this.flushSave();
        },
        async flushSave() {
            if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
            while (this._saveRun) await this._saveRun;
            const patch = this.pendingPatch;
            if (!Object.keys(patch).length) {
                if (this.saveState === 'saving') this.saveState = 'saved';
                return;
            }
            const url = this._saveUrl || this.url();
            this.pendingPatch = {};
            this.saveState = 'saving';
            this._saveRun = (async () => {
                try {
                    const entity = await this.persist(patch, url);
                    this.saveError = '';
                    if (!Object.keys(this.pendingPatch).length) this.saveState = 'saved';
                    // Eine Antwort für einen Eintrag, den die Seite nicht mehr zeigt, bleibt dort.
                    if (entity && url === this.url()) this.onPersisted(entity, patch);
                } catch (e) {
                    // Nichts geht verloren: das Ungeschriebene wartet auf „Erneut versuchen".
                    // Warum, sagt der Hinweis einmal je Versuch (der Stand oben bleibt rot).
                    this.pendingPatch = { ...patch, ...this.pendingPatch };
                    this.saveState = 'error';
                    this.saveError = atlasErrorText(e);
                    atlasToast('Nicht gespeichert – ' + this.saveError, { tone: 'danger' });
                }
            })();
            try { await this._saveRun; } finally { this._saveRun = null; }
        },
        // Die Seite zeigt gleich einen anderen Eintrag: den alten fertig
        // schreiben. Was dabei scheitert, ist verloren — der Hinweis sagt es.
        async switchEntity() {
            if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
            this.flushEditor();
            if (Object.keys(this.pendingPatch).length) await this.flushSave();
            if (Object.keys(this.pendingPatch).length) atlasToast('Eine Änderung am vorigen Eintrag ging nicht mehr durch.', { tone: 'danger' });
            this.pendingPatch = {};
            this.focused = '';
            this.saveState = 'saved';
            this.saveError = '';
            this._shownUrl = this.url();
        },
        // Was der Editor noch nicht gemeldet hat (er entprellt), gehört dem
        // Eintrag, in dem getippt wurde. Beim Wechsel zeigt `url()` aber schon
        // auf den nächsten — der Schub geht deshalb an `_shownUrl`.
        flushEditor() {
            if (!this.$refs.bodyMd) return;
            this._switchUrl = this._shownUrl;
            try { this.$refs.bodyMd.flush(); } finally { this._switchUrl = null; }
        },
        keepsDraft(field) {
            return this.focused === field || Object.prototype.hasOwnProperty.call(this.pendingPatch, field);
        },
        // Server-Stand in die Felder, außer wo der Nutzer gerade schreibt.
        syncDraft(entity, fields) {
            for (const f of fields) {
                if (this.keepsDraft(f)) continue;
                const v = entity[f];
                this.draft[f] = Array.isArray(v) ? [...v] : (v === null || v === undefined ? '' : v);
            }
        },
        focusField(name) { this.focused = name; },
        // Ein Textfeld verlassen: geändert → speichern; ein leerer Pflichttitel
        // springt auf den gespeicherten zurück.
        blurField(name, entity, { required = false } = {}) {
            if (this.focused === name) this.focused = '';
            const value = String(this.draft[name] || '').trim();
            const saved = String((entity && entity[name]) || '');
            if (required && !value) {
                this.draft[name] = saved;
                atlasToast('Ein Titel muss bleiben.');
                return;
            }
            if (value !== saved) this.saveNow({ [name]: value || null });
        },
        blurText(name) {
            if (this.focused === name) this.focused = '';
            this.flushSave();
        },
    },
    created() {
        this._shownUrl = this.url();
    },
    beforeUnmount() {
        if (this._saveTimer) clearTimeout(this._saveTimer);
        // Die Seite verlassen: Ungeschriebenes trotzdem schreiben.
        this.flushEditor();
        if (Object.keys(this.pendingPatch).length) this.flushSave();
    },
};

const AtlasSaveState = {
    components: { 'atlas-icon': AtlasIcon },
    props: {
        state: { type: String, default: 'saved' },
        error: { type: String, default: '' },
        file: { type: String, default: '' },
    },
    emits: ['retry'],
    template: `
        <span class="atlas-savestate" :class="'is-' + state" :title="title">
            <span role="status" aria-live="polite" class="atlas-savestate-text">
                <template v-if="state === 'saving'"><span class="atlas-savestate-dot" aria-hidden="true"></span>Speichert …</template>
                <template v-else-if="state === 'error'"><atlas-icon name="alert" :size="14" />Nicht gespeichert</template>
                <template v-else><atlas-icon name="check" :size="14" />Gespeichert</template>
            </span>
            <button v-if="state === 'error'" type="button" class="atlas-savestate-retry" @click="$emit('retry')">Erneut versuchen</button>
        </span>
    `,
    computed: {
        title() { return this.state === 'error' ? this.error : (this.file ? 'in ' + this.file : ''); },
    },
};

// Das Menü ⋯ jeder Detailseite: die Markdown-Datei im Explorer zeigen oder
// öffnen (POST /entities/{kind}/{id}/reveal|open), seltene Aktionen der Art
// (`extra`) und ganz unten, abgesetzt, Löschen — das nur meldet; die Seite
// fragt im Lösch-Dialog nach.
const AtlasEntityMenu = {
    components: { 'atlas-icon': AtlasIcon },
    props: {
        kind: { type: String, required: true },
        entityId: { type: String, required: true },
        file: { type: String, default: '' },
        extra: { type: Array, default: () => [] },
        deleteLabel: { type: String, default: 'Löschen …' },
        canDelete: { type: Boolean, default: true },
    },
    emits: ['delete'],
    data() { return { open: false }; },
    template: `
        <div class="atlas-menu" @keydown.esc="open = false">
            <button type="button" class="atlas-icon-square" aria-label="Weitere Aktionen"
                    :aria-expanded="open ? 'true' : 'false'" @click="open = !open">
                <atlas-icon name="more" />
            </button>
            <div v-if="open" class="atlas-menu-pop is-right">
                <button type="button" class="atlas-menu-item" @click="call('reveal')">
                    <span class="atlas-menu-label">Im Atlas-Ordner zeigen</span>
                    <span v-if="file" class="atlas-menu-sub atlas-mono">{{ file }}</span>
                </button>
                <button type="button" class="atlas-menu-item" @click="call('open')">
                    <span class="atlas-menu-label">Markdown-Datei öffnen</span>
                    <span class="atlas-menu-sub">im Programm, das Windows dafür kennt</span>
                </button>
                <button v-for="x in extra" :key="x.label" type="button" class="atlas-menu-item" @click="run(x)">
                    <span class="atlas-menu-label">{{ x.label }}</span>
                    <span v-if="x.sub" class="atlas-menu-sub">{{ x.sub }}</span>
                </button>
                <template v-if="canDelete">
                    <div class="atlas-menu-sep" role="separator"></div>
                    <button type="button" class="atlas-menu-item is-danger" @click="askDelete">
                        <span class="atlas-menu-label">{{ deleteLabel }}</span>
                        <span class="atlas-menu-sub">fragt vorher nach</span>
                    </button>
                </template>
            </div>
        </div>
    `,
    methods: {
        async call(action) {
            this.open = false;
            try {
                await api('/api/plugins/atlas/entities/' + this.kind + '/' + encodeURIComponent(this.entityId) + '/' + action, { method: 'POST' });
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
        },
        run(x) { this.open = false; x.action(); },
        askDelete() { this.open = false; this.$emit('delete'); },
        onOutside(e) { if (this.open && this.$el && !this.$el.contains(e.target)) this.open = false; },
    },
    mounted() { document.addEventListener('pointerdown', this.onOutside); },
    beforeUnmount() { document.removeEventListener('pointerdown', this.onOutside); },
};

// Löschen fragt einmal, mit dem, was geht, und dem, was bleibt.
const AtlasDeleteDialog = {
    components: { 'atlas-icon': AtlasIcon },
    props: {
        title: { type: String, required: true },
        gone: { type: Array, default: () => [] },
        kept: { type: Array, default: () => [] },
        hint: { type: String, default: '' },
        busy: { type: Boolean, default: false },
        confirmLabel: { type: String, default: 'Löschen' },
    },
    emits: ['cancel', 'confirm'],
    template: `
        <div class="atlas-modal-backdrop" @click.self="$emit('cancel')" @keydown.esc="$emit('cancel')">
            <div class="atlas-modal is-medium" role="alertdialog" aria-modal="true" aria-labelledby="atlas-del-h" aria-describedby="atlas-del-d">
                <div>
                    <h2 id="atlas-del-h" class="atlas-modal-title is-detail">{{ title }}</h2>
                    <p id="atlas-del-d" class="atlas-modal-sub">Das lässt sich nicht rückgängig machen.</p>
                </div>
                <ul class="atlas-del-list">
                    <li v-for="g in gone" :key="'g' + g" class="is-gone"><atlas-icon name="close" :size="16" /><span><strong>Weg:</strong> {{ g }}</span></li>
                    <li v-for="k in kept" :key="'k' + k" class="is-kept"><atlas-icon name="check" :size="16" /><span><strong>Bleibt:</strong> {{ k }}</span></li>
                </ul>
                <p v-if="hint" class="atlas-muted" style="margin:0">{{ hint }}</p>
                <div class="atlas-row-gap is-end">
                    <button ref="cancel" type="button" class="atlas-btn" @click="$emit('cancel')">Abbrechen</button>
                    <button type="button" class="atlas-btn is-danger" :disabled="busy" @click="$emit('confirm')">{{ busy ? 'Löscht …' : confirmLabel }}</button>
                </div>
            </div>
        </div>
    `,
    mounted() { this.$nextTick(() => { if (this.$refs.cancel) this.$refs.cancel.focus(); }); },
};

// Ein Verlaufseintrag als Satz. Bei einer Veröffentlichung nennt er das Ziel,
// wo es zählt (eingereicht bei, abgelehnt von …), und ein neues Ziel, wenn es
// gegenüber dem Schritt davor gewechselt hat.
function atlasHistoryText(kind, entry, previous) {
    if (kind === 'project') {
        return (PROJECT_STATUSES.find((s) => s.key === entry.status) || {}).label || entry.status;
    }
    const label = ATLAS_PUBLICATION_STATUS_LABEL[entry.status] || entry.status;
    const venue = entry.venue || '';
    const at = { submitted: ' bei ', 'in-revision': ' für ', published: ' in ', rejected: ' von ', withdrawn: ' bei ' }[entry.status];
    if (at && venue) return label + at + venue;
    const changed = venue && previous && previous.venue && previous.venue !== venue;
    return changed ? label + ' · neues Ziel: ' + venue : label;
}

const AtlasVerlauf = {
    props: {
        kind: { type: String, default: 'publication' },
        entries: { type: Array, default: () => [] },
        // Ohne Verlauf (eine Datei von vor /3): was die Angaben schon wissen.
        fallback: { type: Array, default: () => [] },
    },
    template: `
        <section class="atlas-panel is-padded" aria-labelledby="atlas-h-verlauf">
            <div class="atlas-panel-head is-flush">
                <h2 id="atlas-h-verlauf" class="atlas-panel-title is-side">Verlauf</h2>
                <span class="atlas-panel-note is-inline">schreibt Atlas bei jedem Schritt mit</span>
            </div>
            <ol class="atlas-verlauf">
                <li v-for="(r, i) in rows" :key="i" class="atlas-verlauf-row" :class="{ 'is-latest': i === 0 }">
                    <span class="atlas-verlauf-dot" aria-hidden="true"></span>
                    <span class="atlas-verlauf-text">{{ r.text }}</span>
                    <span class="atlas-verlauf-date">{{ r.date }}</span>
                </li>
                <li v-if="!rows.length" class="atlas-verlauf-row is-empty">Noch kein Schritt aufgezeichnet – der nächste Statuswechsel steht hier.</li>
            </ol>
        </section>
    `,
    computed: {
        rows() {
            const list = (this.entries && this.entries.length) ? this.entries : this.fallback;
            const out = list.map((e, i) => ({
                text: e.text || atlasHistoryText(this.kind, e, list[i - 1]),
                date: atlasLongDate(e.date),
            }));
            return out.reverse();
        },
    },
};

// Der Schritt, in den „Zurück in die Pipeline" führt: der letzte offene vor
// dem Abschluss, sonst „Schreiben".
function atlasReopenStatus(history, closed, fallback) {
    const list = history || [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
        if (!closed.has(list[i].status)) return list[i].status;
    }
    return fallback;
}

// ── BibTeX-Import einer Veröffentlichung (CONTEXT.md "BibTeX Import") ──────
// Aus der früheren Schublade herausgelöst: drei Schritte (Dateien → Einträge
// prüfen → PDFs laden). Der Kern-Import legt an (Ziel: die Sammlung einer
// Sammlungs-Veröffentlichung), Atlas hängt nur die Cite Keys an die eigene
// Datei — ein Sammlungs-Eintrag trägt keine refs (ADR-0022).
const AtlasBibtexImport = {
    components: { 'atlas-icon': AtlasIcon },
    props: { publication: { type: Object, required: true } },
    emits: ['close'],
    template: `
        <div class="atlas-modal-backdrop" @click.self="close" @keydown.esc="close">
            <div class="atlas-modal" role="dialog" aria-modal="true" aria-labelledby="atlas-bib-h">
                <div class="atlas-new-head">
                    <div>
                        <h2 id="atlas-bib-h" class="atlas-modal-title is-detail">Referenzen importieren</h2>
                        <p class="atlas-modal-sub">
                            {{ step === 1 ? 'Schritt 1/3 · .bib-Datei wählen' : step === 2 ? 'Schritt 2/3 · Einträge prüfen' : 'Schritt 3/3 · PDFs herunterladen' }}
                            · {{ publication.collection ? 'Sammlung' : 'Veröffentlichung' }} „{{ publication.title }}"
                        </p>
                    </div>
                    <button type="button" class="atlas-icon-square" aria-label="Schließen" :disabled="downloading" @click="close"><atlas-icon name="close" /></button>
                </div>

                <div v-if="step === 1" class="atlas-new-form">
                    <div class="atlas-new-field">
                        <label for="atlas-bib-file" class="atlas-new-legend">BibTeX-Datei (.bib)</label>
                        <input id="atlas-bib-file" type="file" accept=".bib,text/plain" @change="onFile($event, 'bib')" />
                    </div>
                    <div class="atlas-new-field">
                        <label for="atlas-bib-tex" class="atlas-new-legend">LaTeX-Quelle (.tex, optional)</label>
                        <input id="atlas-bib-tex" type="file" accept=".tex,text/plain" @change="onFile($event, 'tex')" />
                        <span class="atlas-new-help">Mit .tex werden nur tatsächlich per <span class="atlas-mono">\\cite</span> zitierte Einträge vorausgewählt.</span>
                    </div>
                </div>

                <div v-else-if="step === 2" class="atlas-stack">
                    <div class="atlas-row-gap is-between">
                        <span class="atlas-muted">{{ entries.length }} Einträge · {{ entries.filter(e => e.match).length }} bereits in der Bibliothek · {{ selectedCount }} ausgewählt</span>
                        <span class="atlas-row-gap">
                            <button type="button" class="atlas-text-btn" @click="selectAll(true)">Alle</button>
                            <button type="button" class="atlas-text-btn" @click="selectAll(false)">Keine</button>
                        </span>
                    </div>
                    <ul class="atlas-bib-list">
                        <li v-for="e in entries" :key="e.key">
                            <label class="atlas-bib-row">
                                <input type="checkbox" v-model="e._selected" class="atlas-check" />
                                <span class="atlas-bib-text">
                                    <span class="atlas-bib-title">{{ e.title || e.key }}
                                        <span v-if="e.match" class="atlas-badge is-small is-ok">in Bibliothek</span>
                                        <span v-else class="atlas-badge is-small">neu</span>
                                        <span v-if="e.cited === true" class="atlas-badge is-small is-accent">zitiert</span>
                                        <span v-if="e._alreadyAssigned" class="atlas-badge is-small">schon zugeordnet</span>
                                    </span>
                                    <span class="atlas-muted">{{ e.authors }}<template v-if="e.year"> · {{ e.year }}</template><template v-if="e.journal"> · {{ e.journal }}</template></span>
                                    <span class="atlas-mono is-small">{{ e.key }}<template v-if="e.proposed_cite_key !== e.key"> → {{ e.proposed_cite_key }} (Cite Key der Bibliothek gilt)</template></span>
                                </span>
                            </label>
                        </li>
                    </ul>
                </div>

                <div v-else class="atlas-stack">
                    <div v-if="summary" class="atlas-bib-summary">
                        <span>{{ summary.created }} neu angelegt · {{ summary.matched }} mit Bibliothek verknüpft<template v-if="summary.enriched"> · {{ summary.enriched }} angereichert</template><template v-if="summary.errors"> · {{ summary.errors }} Fehler</template>
                            — alle {{ publication.collection ? 'in die Sammlung übernommen' : 'der Veröffentlichung zugeordnet' }}.</span>
                        <button v-if="summary.created && !removed" type="button" class="atlas-text-btn is-danger" :disabled="loading" @click="removeImported">Importierte entfernen</button>
                    </div>
                    <p v-if="removed" class="atlas-muted" style="margin:0">Die in diesem Import angelegten Einträge wurden wieder entfernt.</p>
                    <template v-if="downloads.length">
                        <span class="atlas-muted">PDF-Download (nur Open Access) — wähle aus, was geladen werden soll · {{ downloadCount }} ausgewählt</span>
                        <ul class="atlas-bib-list">
                            <li v-for="c in downloads" :key="c.paper_id" class="atlas-bib-row">
                                <input type="checkbox" v-model="c._selected" :disabled="!c.oa_pdf_url || c.status === 'ok'" class="atlas-check" :aria-label="'PDF laden: ' + c.title" />
                                <span class="atlas-bib-text">
                                    <span class="atlas-bib-title">{{ c.title }}
                                        <span v-if="c.status === 'ok'" class="atlas-badge is-small is-ok">PDF da</span>
                                        <span v-else-if="c.status === 'laedt'" class="atlas-badge is-small">lädt …</span>
                                        <span v-else-if="c.status === 'fehler'" class="atlas-badge is-small is-danger">fehlgeschlagen</span>
                                        <span v-else-if="c.oa_pdf_url" class="atlas-badge is-small is-ok">Open Access</span>
                                        <span v-else class="atlas-badge is-small">kein OA-PDF</span>
                                    </span>
                                    <span v-if="c.error" class="atlas-error">{{ c.error }}</span>
                                    <span v-if="!c.oa_pdf_url || c.status === 'fehler'" class="atlas-muted">Manuell laden:
                                        <a v-if="c.doi_url" :href="c.doi_url" target="_blank" rel="noopener">DOI</a><template v-if="c.doi_url"> · </template><a :href="c.scholar_url" target="_blank" rel="noopener">Google Scholar</a> — danach am Paper „PDF anhängen".</span>
                                </span>
                            </li>
                        </ul>
                    </template>
                    <p v-else class="atlas-muted" style="margin:0">Alle importierten Paper haben bereits ein PDF.</p>
                </div>

                <p v-if="error" class="atlas-error" role="alert">{{ error }}</p>
                <div class="atlas-new-foot is-end">
                    <template v-if="step === 1">
                        <button type="button" class="atlas-btn" @click="close">Abbrechen</button>
                        <button type="button" class="atlas-btn is-primary" :disabled="!bibFile || loading" @click="preview">{{ loading ? 'Analysiert …' : 'Analysieren' }}</button>
                    </template>
                    <template v-else-if="step === 2">
                        <button type="button" class="atlas-btn" :disabled="loading" @click="step = 1">Zurück</button>
                        <button type="button" class="atlas-btn is-primary" :disabled="!selectedCount || loading" @click="commit">{{ loading ? 'Importiert …' : selectedCount + ' Einträge importieren' }}</button>
                    </template>
                    <template v-else>
                        <button v-if="downloads.some(c => c.oa_pdf_url && c.status !== 'ok')" type="button" class="atlas-btn is-primary"
                                :disabled="!downloadCount || downloading" @click="downloadSelected">{{ downloading ? 'Lädt herunter …' : downloadCount + ' PDFs herunterladen' }}</button>
                        <button type="button" class="atlas-btn" :disabled="downloading" @click="close">Fertig</button>
                    </template>
                </div>
            </div>
        </div>
    `,
    data() {
        return {
            step: 1, bibFile: null, texFile: null, loading: false, error: '',
            entries: [], summary: null, removed: false, downloads: [], downloading: false,
        };
    },
    computed: {
        selectedCount() { return this.entries.filter((e) => e._selected).length; },
        downloadCount() { return this.downloads.filter((c) => c._selected && c.oa_pdf_url).length; },
        collectionId() { return this.publication.collection ? this.publication.collection.id : null; },
        pubUrl() { return '/api/plugins/atlas/publications/' + encodeURIComponent(this.publication.id); },
    },
    methods: {
        close() {
            if (this.downloading) return;
            this.$emit('close', !!this.summary);
        },
        onFile(event, kind) {
            const file = event.target.files[0] || null;
            if (kind === 'bib') this.bibFile = file;
            else this.texFile = file;
        },
        async preview() {
            if (!this.bibFile || this.loading) return;
            this.loading = true;
            this.error = '';
            try {
                const formData = new FormData();
                formData.append('bib_file', this.bibFile);
                if (this.texFile) formData.append('tex_file', this.texFile);
                const resp = await fetch('/api/import/bibtex/preview', { method: 'POST', body: formData });
                if (!resp.ok) throw await atlasResponseError(resp);
                const data = await resp.json();
                const existing = new Set(this.publication.refs || []);
                this.entries = (data.entries || []).map((e) => ({
                    ...e,
                    // Vorauswahl: mit .tex nur zitierte, sonst alle; Keys, die
                    // schon an der Veröffentlichung hängen, bleiben abgewählt.
                    _selected: (e.cited !== false) && !existing.has(e.proposed_cite_key),
                    _alreadyAssigned: existing.has(e.proposed_cite_key),
                }));
                if (!this.entries.length) {
                    this.error = 'Keine BibTeX-Einträge gefunden.';
                    return;
                }
                this.step = 2;
            } catch (e) {
                this.error = atlasErrorText(e);
            } finally {
                this.loading = false;
            }
        },
        selectAll(value) { this.entries.forEach((e) => { e._selected = value; }); },
        async commit() {
            const selected = this.entries.filter((e) => e._selected);
            if (!selected.length || this.loading) return;
            this.loading = true;
            this.error = '';
            try {
                const commit = {
                    entries: selected.map((e) => ({
                        key: e.key, title: e.title, authors: e.authors, year: e.year,
                        doi: e.doi, isbn: e.isbn, abstract: e.abstract, journal: e.journal,
                        publisher: e.publisher, entry_type: e.entry_type,
                        matched_paper_id: e.match ? e.match.paper_id : null,
                        raw: e.raw || {},
                    })),
                    source_name: this.bibFile ? this.bibFile.name : '',
                };
                if (this.collectionId) commit.collection_id = this.collectionId;
                const data = await api('/api/import/bibtex/commit', { method: 'POST', body: JSON.stringify(commit) });
                this.summary = data;
                const ok = (data.results || []).filter((r) => r.status === 'created' || r.status === 'matched');
                if (ok.length && !this.collectionId) {
                    await api(this.pubUrl + '/refs', { method: 'POST', body: JSON.stringify({ refs: ok.map((r) => r.cite_key) }) });
                }
                this.step = 3;
                const byKey = {};
                this.entries.forEach((e) => { byKey[e.key] = e; });
                this.downloads = ok.filter((r) => !r.has_pdf).map((r) => ({
                    paper_id: r.paper_id, cite_key: r.cite_key, title: (byKey[r.key] || {}).title || r.key,
                    doi: r.doi || '', oa_pdf_url: '', doi_url: '', scholar_url: '', _selected: false, status: '', error: '',
                }));
                if (this.downloads.length) {
                    const check = await api('/api/import/bibtex/oa-check', {
                        method: 'POST',
                        body: JSON.stringify({ items: this.downloads.map((c) => ({ paper_id: c.paper_id, doi: c.doi, title: c.title })) }),
                    });
                    const byId = {};
                    (check.results || []).forEach((r) => { byId[r.paper_id] = r; });
                    this.downloads.forEach((c) => {
                        const r = byId[c.paper_id] || {};
                        c.oa_pdf_url = r.oa_pdf_url || '';
                        c.doi_url = r.doi_url || '';
                        c.scholar_url = r.scholar_url || '';
                        c._selected = !!c.oa_pdf_url;
                    });
                }
            } catch (e) {
                this.error = atlasErrorText(e);
            } finally {
                this.loading = false;
            }
        },
        // Macht genau diesen Import rückgängig: die neu angelegten Paper gehen,
        // ihre Cite Keys verlassen die refs (eine Sammlung räumt der Kern selbst).
        async removeImported() {
            const created = ((this.summary && this.summary.results) || []).filter((r) => r.status === 'created' && r.paper_id);
            if (!created.length || this.loading) return;
            if (!confirm(`${created.length} in diesem Import angelegte Einträge wieder entfernen? Die zugehörigen Bibliotheks-Papers werden gelöscht (bereits vorher vorhandene bleiben).`)) return;
            this.loading = true;
            this.error = '';
            try {
                const ids = created.map((r) => r.paper_id);
                await api('/api/papers/bulk-delete', { method: 'POST', body: JSON.stringify({ paper_ids: ids }) });
                const keys = new Set(created.map((r) => r.cite_key).filter(Boolean));
                if (keys.size && !this.collectionId) {
                    try {
                        const pub = await api(this.pubUrl);
                        await api(this.pubUrl, { method: 'PUT', body: JSON.stringify({ refs: (pub.refs || []).filter((c) => !keys.has(c)) }) });
                    } catch (e) { /* refs-Bereinigung best-effort */ }
                }
                const gone = new Set(ids);
                this.downloads = this.downloads.filter((c) => !gone.has(c.paper_id));
                this.removed = true;
                window.dispatchEvent(new CustomEvent('refresh-sidebar'));
            } catch (e) {
                this.error = atlasErrorText(e);
            } finally {
                this.loading = false;
            }
        },
        async downloadSelected() {
            if (this.downloading) return;
            this.downloading = true;
            for (const c of this.downloads) {
                if (!c._selected || !c.oa_pdf_url || c.status === 'ok') continue;
                c.status = 'laedt';
                c.error = '';
                try {
                    await api(`/api/papers/${c.paper_id}/fetch-oa-pdf`, { method: 'POST', body: JSON.stringify({ url: c.oa_pdf_url }) });
                    c.status = 'ok';
                } catch (e) {
                    c.status = 'fehler';
                    c.error = atlasErrorText(e);
                }
            }
            this.downloading = false;
        },
    },
};

const ATLAS_LIT_FILTERS = [
    { key: 'all', label: 'Alle' },
    { key: 'missing', label: 'Fehlen in der Bibliothek' },
    { key: 'uncited', label: 'Noch nicht zitiert' },
];

const ATLAS_PUBLICATION_FIELDS = ['title', 'type', 'venue', 'due', 'submitted', 'published', 'authors', 'tags', 'refs', 'body'];

const AtlasPublicationPage = {
    mixins: [AtlasAutosave],
    components: { 'atlas-markdown': AtlasMarkdown,
        'atlas-nav': AtlasNav,
        'atlas-icon': AtlasIcon,
        'atlas-chips': AtlasChips,
        'atlas-save-state': AtlasSaveState,
        'atlas-entity-menu': AtlasEntityMenu,
        'atlas-delete-dialog': AtlasDeleteDialog,
        'atlas-verlauf': AtlasVerlauf,
        'atlas-bibtex-import': AtlasBibtexImport,
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
                            <h1 class="atlas-title is-detail atlas-title-field">
                                <label for="atlas-pub-title" class="atlas-sr">Titel</label>
                                <input id="atlas-pub-title" class="atlas-title-input" v-model="draft.title" :readonly="!!pub.collection"
                                       :title="pub.collection ? 'Der Titel ist der Name der Sammlung – in LocalBib umbenennen.' : ''"
                                       autocomplete="off" @focus="focusField('title')" @blur="blurField('title', pub, { required: true })"
                                       @keydown.enter.prevent="$event.target.blur()" />
                            </h1>
                            <div class="atlas-detail-meta">
                                <template v-for="(m, i) in metaParts" :key="i">
                                    <span v-if="i" aria-hidden="true" class="atlas-dot">·</span><span>{{ m }}</span>
                                </template>
                            </div>
                        </div>
                        <div class="atlas-header-actions">
                            <atlas-save-state :state="saveState" :error="saveError" :file="fileLabel" @retry="flushSave" />
                            <atlas-entity-menu kind="publication" :entity-id="pub.id" :file="fileLabel" :extra="menuExtra"
                                               :delete-label="pub.collection ? 'Atlas-Angaben löschen …' : 'Löschen …'" @delete="deleteOpen = true" />
                            <router-link v-if="firstManuscript" :to="editorRoute(firstManuscript)" class="atlas-btn is-primary is-tall">
                                <atlas-icon name="pen" /> LaTeX-Editor öffnen
                            </router-link>
                        </div>
                    </div>
                    <div class="atlas-steprow">
                        <ol class="atlas-steps" :class="{ 'is-muted': closed }" aria-label="Stand der Veröffentlichung">
                            <li v-for="(st, i) in steps" :key="st.key" class="atlas-step-li">
                                <atlas-icon v-if="i" name="chevronRight" :size="14" class="atlas-step-sep" />
                                <button type="button" class="atlas-step" :class="{ 'is-current': st.current, 'is-past': st.past }"
                                        :aria-pressed="st.current ? 'true' : 'false'" :disabled="busy" @click="setStatus(st.key)">
                                    <atlas-icon v-if="st.past" name="check" :size="14" />{{ st.name }}
                                </button>
                            </li>
                        </ol>
                        <span class="atlas-steprow-sep" aria-hidden="true"></span>
                        <div class="atlas-menu">
                            <button type="button" class="atlas-step is-ghost" :aria-expanded="closeOpen ? 'true' : 'false'"
                                    :disabled="busy" @click="closeOpen = !closeOpen">
                                Abgelehnt / zurückgezogen … <atlas-icon name="chevronDown" :size="14" />
                            </button>
                            <div v-if="closeOpen" class="atlas-menu-pop is-left is-wide" @keydown.esc="closeOpen = false">
                                <button type="button" class="atlas-menu-item" @click="openReject('reject')">
                                    <span class="atlas-menu-label">Abgelehnt</span>
                                    <span class="atlas-menu-sub">Das Ziel hat abgesagt. Danach wählst du: woanders einreichen oder ins Archiv.</span>
                                </button>
                                <button type="button" class="atlas-menu-item" @click="withdraw">
                                    <span class="atlas-menu-label">Zurückgezogen</span>
                                    <span class="atlas-menu-sub">Du verfolgst den Beitrag nicht weiter. Er kommt ins Archiv, nichts wird gelöscht.</span>
                                </button>
                            </div>
                        </div>
                    </div>
                </header>

                <section v-if="closed" class="atlas-archive" aria-label="Im Archiv">
                    <span class="atlas-archive-icon"><atlas-icon name="archive" :size="20" /></span>
                    <div class="atlas-archive-text">
                        <div class="atlas-archive-title">{{ archiveTitle }}</div>
                        <div class="atlas-archive-sub">{{ archiveSub }}</div>
                    </div>
                    <div class="atlas-row-gap">
                        <button type="button" class="atlas-btn is-primary" :disabled="busy" @click="openReject('resubmit')">Woanders einreichen</button>
                        <button type="button" class="atlas-btn" :disabled="busy" @click="reopen">Zurück in die Pipeline</button>
                    </div>
                </section>

                <div class="atlas-columns">
                    <div class="atlas-col-main">
                        <!-- Notizen -->
                        <section class="atlas-panel is-padded atlas-stack" aria-labelledby="atlas-h-notes">
                            <div class="atlas-panel-head is-flush">
                                <h2 id="atlas-h-notes" class="atlas-panel-title">Notizen</h2>
                                <span class="atlas-panel-note is-inline">Abstract-Entwurf, Plan, Gutachten · Markdown · speichert nach einer Tipp-Pause</span>
                            </div>
                            <span class="atlas-sr">Notizen</span>
                            <atlas-markdown id="atlas-pub-notes" ref="bodyMd" v-model="draft.body" class="is-notes" placeholder="Abstract-Entwurf, Plan, Gutachten-Punkte als „- [ ] …“"
                                            @focus="focusField('body')" @update:model-value="queueSave({ body: $event })" @blur="blurText('body')" />
                        </section>

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
                                    <button v-if="f.unlink" type="button" class="atlas-text-btn is-muted"
                                            :aria-label="f.name + ': Verknüpfung lösen'" @click="unlinkManuscript(f.name)">Lösen</button>
                                    <button v-if="f.removable" type="button" class="atlas-text-btn is-muted"
                                            :aria-label="f.name + ' entfernen'" @click="removeDocument(f.name)">Entfernen</button>
                                </li>
                                <li v-if="!files.length" class="atlas-file-row is-empty">Noch keine Dateien bei diesem Beitrag.</li>
                            </ul>
                            <label v-if="unassignedManuscripts.length" class="atlas-sr" for="atlas-pub-ms">Vorhandenes Manuskript verknüpfen</label>
                            <select v-if="unassignedManuscripts.length" id="atlas-pub-ms" class="atlas-input is-field is-link" @change="linkManuscript($event)">
                                <option value="">+ Vorhandenes Manuskript verknüpfen …</option>
                                <option v-for="m in unassignedManuscripts" :key="m.id" :value="m.id">{{ m.id }}.tex</option>
                            </select>
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
                                Noch keine Literatur: verknüpf ein Manuskript mit <code>\\cite{…}</code>, plan eine Sammlung als Literaturliste oder importier eine .bib.
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
                        <!-- Angaben: jedes Feld speichert selbst -->
                        <section class="atlas-panel is-padded atlas-stack" aria-labelledby="atlas-h-ang">
                            <div class="atlas-panel-head is-flush">
                                <h2 id="atlas-h-ang" class="atlas-panel-title is-side">Angaben</h2>
                                <span class="atlas-panel-note is-inline">speichert beim Verlassen eines Feldes</span>
                            </div>
                            <div class="atlas-fields">
                                <label for="atlas-pf-type" class="atlas-fields-label">Art</label>
                                <select id="atlas-pf-type" class="atlas-input is-field" v-model="draft.type" @change="saveNow({ type: draft.type || null })">
                                    <option value="">—</option>
                                    <option v-for="(label, key) in types" :key="key" :value="key">{{ label }}</option>
                                </select>
                                <label for="atlas-pf-venue" class="atlas-fields-label">Ziel</label>
                                <input id="atlas-pf-venue" class="atlas-input is-field" v-model="draft.venue" placeholder="Journal, Konferenz, Verlag"
                                       autocomplete="off" @focus="focusField('venue')" @blur="blurField('venue', pub)" @keydown.enter.prevent="$event.target.blur()" />
                                <label for="atlas-pf-due" class="atlas-fields-label">Frist</label>
                                <input id="atlas-pf-due" type="date" class="atlas-input is-field" v-model="draft.due" @change="saveNow({ due: draft.due || null })" />
                                <label for="atlas-pf-sub" class="atlas-fields-label is-top">Eingereicht am</label>
                                <div class="atlas-fields-stack">
                                    <input id="atlas-pf-sub" type="date" class="atlas-input is-field" v-model="draft.submitted" @change="saveNow({ submitted: draft.submitted || null })" />
                                    <span class="atlas-fields-help">trägt Atlas beim Schritt „Eingereicht“ ein</span>
                                </div>
                                <label for="atlas-pf-pub" class="atlas-fields-label">Veröffentlicht am</label>
                                <input id="atlas-pf-pub" type="date" class="atlas-input is-field" v-model="draft.published" @change="saveNow({ published: draft.published || null })" />
                                <span class="atlas-fields-label is-top">Co-Autor:innen</span>
                                <atlas-chips :model-value="draft.authors" label="Co-Autor:in hinzufügen" placeholder="Name, Enter"
                                             @update:model-value="(v) => { draft.authors = v; saveNow({ authors: v }); }" />
                                <span class="atlas-fields-label is-top">Schlagworte</span>
                                <atlas-chips :model-value="draft.tags" label="Schlagwort hinzufügen" placeholder="Wort, Enter"
                                             @update:model-value="(v) => { draft.tags = v; saveNow({ tags: v }); }" />
                                <label for="atlas-pf-paper" class="atlas-fields-label is-top">Eigenes Paper</label>
                                <div class="atlas-fields-stack">
                                    <span v-if="pub.paper" class="atlas-chip">
                                        <span class="atlas-chip-kind">Bibliothek</span><span class="atlas-chip-label">{{ paperTitle }}</span>
                                        <button type="button" class="atlas-chip-x" aria-label="Eigenes Paper lösen" @click="saveNow({ paper: null })">×</button>
                                    </span>
                                    <template v-else>
                                        <input id="atlas-pf-paper" class="atlas-input is-field" v-model="paperQuery" placeholder="Titel, Autor:in oder DOI suchen …"
                                               autocomplete="off" @focus="loadPapers" />
                                        <div v-if="paperQuery.trim()" class="atlas-sug is-inline" role="listbox" aria-label="Paper der Bibliothek">
                                            <button v-for="p in paperHits" :key="p.id" type="button" role="option" class="atlas-sug-item" @click="pickPaper(p)">
                                                <span class="atlas-sug-title">{{ p.title }}</span><span class="atlas-sug-id">{{ p.year || '' }}</span>
                                            </button>
                                            <div v-if="papersLoading && !paperHits.length" class="atlas-sug-empty">Lädt die Bibliothek …</div>
                                            <div v-else-if="papersFailed" class="atlas-sug-empty">Die Bibliothek ließ sich nicht laden. Klick noch einmal ins Feld, um es erneut zu versuchen.</div>
                                            <div v-else-if="!paperHits.length" class="atlas-sug-empty">Nicht in der Bibliothek. Importiere es zuerst in LocalBib.</div>
                                        </div>
                                        <span class="atlas-fields-help">sobald es erschienen ist – dann holt die Publikationsliste Band, Heft und Seiten daraus</span>
                                    </template>
                                </div>
                            </div>
                        </section>

                        <!-- Literatur aus der Sammlung / feste Literaturliste -->
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
                                <button type="button" class="atlas-btn" @click="bibOpen = true">.bib importieren</button>
                            </div>
                        </section>
                        <section v-else class="atlas-panel is-padded atlas-stack" aria-labelledby="atlas-h-coll">
                            <h2 id="atlas-h-coll" class="atlas-kicker">Literaturliste</h2>
                            <p class="atlas-muted" style="margin:0">Cite Keys, fest in der Datei. Aus einer Sammlung planen macht deren Paper zur Literaturliste, die mitwächst.</p>
                            <atlas-chips mono :model-value="draft.refs" label="Cite Key hinzufügen" placeholder="Cite Key, Enter"
                                         @update:model-value="(v) => { draft.refs = v; saveNow({ refs: v }); }" />
                            <div class="atlas-row-gap">
                                <button type="button" class="atlas-btn" @click="bibOpen = true">.bib importieren</button>
                                <router-link :to="planRoute" class="atlas-btn">Alle Sammlungen</router-link>
                            </div>
                        </section>

                        <!-- Gehört zu -->
                        <section class="atlas-panel is-padded" aria-labelledby="atlas-h-verk">
                            <h2 id="atlas-h-verk" class="atlas-panel-title is-side">Gehört zu</h2>
                            <ul class="atlas-belongs">
                                <li v-for="b in belongs" :key="b.key">
                                    <span class="atlas-muted">{{ b.label }}</span>
                                    <span class="atlas-belongs-end">
                                        <router-link v-if="b.to" :to="b.to" class="atlas-belongs-link">{{ b.title }}</router-link>
                                        <span v-else class="atlas-belongs-link">{{ b.title }}</span>
                                        <button v-if="b.unlink" type="button" class="atlas-chip-x is-row" :aria-label="'Verknüpfung mit „' + b.title + '“ lösen'" @click="b.unlink()">×</button>
                                    </span>
                                </li>
                                <li v-if="!belongs.length"><span class="atlas-muted">Noch keinem Kapitel, Projekt und keiner Idee zugeordnet.</span></li>
                            </ul>
                            <label for="atlas-pf-link" class="atlas-sr">Verknüpfen</label>
                            <select id="atlas-pf-link" class="atlas-input is-field is-link" @change="addLink($event)">
                                <option value="">+ Kapitel, Projekt oder Idee verknüpfen …</option>
                                <optgroup v-if="linkOptions.chapters.length" label="Kapitel">
                                    <option v-for="o in linkOptions.chapters" :key="o.id" :value="'diss_node:' + o.id">{{ o.title }}</option>
                                </optgroup>
                                <optgroup v-if="linkOptions.projects.length" label="Projekt">
                                    <option v-for="o in linkOptions.projects" :key="o.id" :value="'project:' + o.id">{{ o.title }}</option>
                                </optgroup>
                                <optgroup v-if="linkOptions.ideas.length" label="Idee">
                                    <option v-for="o in linkOptions.ideas" :key="o.id" :value="'idea:' + o.id">{{ o.title }}</option>
                                </optgroup>
                            </select>
                        </section>

                        <!-- Fristen & Aufgaben -->
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
                                <li v-if="!dates.length" class="atlas-agenda-row atlas-muted">Keine Frist eingetragen – unter „Angaben“, dann steht sie im Kalender.</li>
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

                        <atlas-verlauf kind="publication" :entries="pub.history || []" :fallback="historyFallback" />
                    </aside>
                </div>

                <!-- Abgelehnt → woanders einreichen oder ins Archiv -->
                <div v-if="rejectMode" class="atlas-modal-backdrop" @click.self="rejectMode = ''" @keydown.esc="rejectMode = ''">
                    <form class="atlas-modal is-medium" role="dialog" aria-modal="true" aria-labelledby="atlas-rj-h" @submit.prevent="applyReject">
                        <div class="atlas-new-head">
                            <div>
                                <h2 id="atlas-rj-h" class="atlas-modal-title is-detail">{{ rejectTitle }}</h2>
                                <p class="atlas-modal-sub">{{ rejectSub }}</p>
                            </div>
                            <button type="button" class="atlas-icon-square" aria-label="Schließen" @click="rejectMode = ''"><atlas-icon name="close" /></button>
                        </div>
                        <fieldset v-if="rejectMode === 'reject'" class="atlas-new-fieldset">
                            <legend class="atlas-sr">Wie geht es weiter?</legend>
                            <label class="atlas-option" :class="{ 'is-on': rejectChoice === 'resubmit' }">
                                <input type="radio" name="atlas-rj-choice" value="resubmit" v-model="rejectChoice" />
                                <span class="atlas-option-text"><span class="atlas-option-title">Woanders einreichen</span>
                                    <span class="atlas-option-sub">Zurück auf „Schreiben“, mit neuem Ziel. Dateien, Notizen und Literatur bleiben.</span></span>
                            </label>
                            <label class="atlas-option" :class="{ 'is-on': rejectChoice === 'archive' }">
                                <input type="radio" name="atlas-rj-choice" value="archive" v-model="rejectChoice" />
                                <span class="atlas-option-text"><span class="atlas-option-title">Ins Archiv legen</span>
                                    <span class="atlas-option-sub">Sie verlässt die Pipeline und steht unter „Archiv“. Nichts wird gelöscht.</span></span>
                            </label>
                        </fieldset>
                        <div v-if="rejectResubmit" class="atlas-form-grid">
                            <div class="atlas-new-field">
                                <label for="atlas-rj-venue" class="atlas-new-legend">Neues Ziel</label>
                                <input id="atlas-rj-venue" ref="newVenue" class="atlas-input" v-model="newVenue" placeholder="Journal oder Konferenz" autocomplete="off" />
                            </div>
                            <div class="atlas-new-field">
                                <label for="atlas-rj-due" class="atlas-new-legend">Neue Frist <span class="atlas-muted">(optional)</span></label>
                                <input id="atlas-rj-due" type="date" class="atlas-input" v-model="newDue" />
                            </div>
                        </div>
                        <p v-if="rejectError" class="atlas-error" role="alert">{{ rejectError }}</p>
                        <div class="atlas-new-foot is-end">
                            <button type="button" class="atlas-btn" @click="rejectMode = ''">Abbrechen</button>
                            <button type="submit" class="atlas-btn is-primary" :disabled="busy">{{ rejectResubmit ? 'Woanders einreichen' : 'Ins Archiv legen' }}</button>
                        </div>
                    </form>
                </div>

                <atlas-delete-dialog v-if="deleteOpen" :title="pub.collection ? 'Atlas-Angaben löschen?' : 'Veröffentlichung löschen?'"
                                     :gone="deleteFacts.gone" :kept="deleteFacts.kept" :busy="deleting"
                                     hint="Ist sie nur vorbei? Dann lieber „Abgelehnt / zurückgezogen“ – sie bleibt im Archiv."
                                     @cancel="deleteOpen = false" @confirm="doDelete" />
                <atlas-bibtex-import v-if="bibOpen" :publication="pub" @close="onBibClosed" />
            </template>
        </div>
    `,
    data() {
        return {
            pub: null,
            loading: true,
            missing: false,
            busy: false,
            draft: { title: '', type: '', venue: '', due: '', submitted: '', published: '', authors: [], tags: [], refs: [], body: '' },
            literature: null,
            documents: [],
            folder: '',
            unassignedManuscripts: [],
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
            closeOpen: false,
            rejectMode: '',
            rejectChoice: 'resubmit',
            newVenue: '',
            newDue: '',
            rejectError: '',
            deleteOpen: false,
            deleting: false,
            bibOpen: false,
            // „Eigenes Paper": die Bibliothek erst beim ersten Fokus des
            // Suchfelds laden, dann für die Lebenszeit der Seite behalten. Der
            // Vertrag kennt keine schlanke Liste und die Kernsuche findet weder
            // DOIs noch Umlaute ohne Rücksicht auf Groß/klein — also hier filtern.
            papers: [],
            papersLoading: false,
            papersFailed: false,
            paperQuery: '',
            paperPicked: null,
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
        types() { return ATLAS_PUBLICATION_TYPE_LABEL; },
        fileLabel() { return this.pub ? atlasFileLabel('veroeffentlichungen', this.pub) : ''; },
        collection() {
            const c = this.pub && this.pub.collection;
            return c && !c.missing ? c : null;
        },
        closed() { return !!this.pub && ATLAS_PIPELINE_CLOSED.has(this.pub.status); },
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
        lastClose() {
            const h = (this.pub && this.pub.history) || [];
            for (let i = h.length - 1; i >= 0; i -= 1) if (h[i].status === this.pub.status) return h[i];
            return null;
        },
        archiveTitle() {
            const venue = (this.lastClose && this.lastClose.venue) || this.pub.venue;
            if (this.pub.status === 'rejected') return 'Abgelehnt' + (venue ? ' von ' + venue : '');
            return 'Zurückgezogen';
        },
        archiveSub() {
            const since = this.lastClose ? ', seit ' + atlasLongDate(this.lastClose.date) : '';
            return 'Liegt im Archiv der Veröffentlichungen' + since + '. Dateien, Notizen und Literatur bleiben hier.';
        },
        // Eine Datei von vor dem Verlauf: was die Angaben schon wissen.
        historyFallback() {
            const p = this.pub;
            const out = [];
            if (p.submitted) out.push({ date: p.submitted, status: 'submitted', venue: p.venue });
            if (p.published) out.push({ date: p.published, status: 'published', venue: p.venue });
            return out;
        },
        rejectResubmit() { return this.rejectMode === 'resubmit' || (this.rejectMode === 'reject' && this.rejectChoice === 'resubmit'); },
        rejectTitle() {
            if (this.rejectMode === 'resubmit') return 'Woanders einreichen';
            return 'Abgelehnt von ' + (this.pub.venue || 'dem Ziel');
        },
        rejectSub() {
            return this.rejectMode === 'resubmit'
                ? 'Die Veröffentlichung geht zurück auf „Schreiben“. Das bisherige Ziel bleibt im Verlauf.'
                : 'Wie geht es weiter? Die Absage steht in jedem Fall im Verlauf.';
        },
        // Ein Sammlungs-Eintrag kann die Art wechseln (ADR-0022) — selten,
        // also im Menü ⋯.
        menuExtra() {
            if (!this.collection) return [];
            return [{ label: 'Zum Forschungsprojekt verschieben', sub: 'die Literatur bleibt in der Sammlung', action: () => this.switchKind() }];
        },
        deleteFacts() {
            const p = this.pub;
            const gone = ['Angaben, Notizen und Verlauf in ' + this.fileLabel];
            const kept = [];
            const ms = p.manuscripts || [];
            if (ms.length) kept.push((ms.length === 1 ? 'das Manuskript ' : 'die Manuskripte ') + ms.join(', ') + ' in manuskripte/');
            const n = this.documents.length;
            if (n) kept.push((n === 1 ? 'die Datei' : 'die ' + n + ' Dateien') + ' im Dokumentordner – unter „' + this.folder.replace(/\/$/, '') + '.geloescht-<Datum>“');
            if (p.collection) kept.push('die Sammlung „' + p.collection.name + '“ und ihre Literatur in LocalBib');
            return { gone, kept };
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
                    key: 'ms:' + id, name: file, kind: 'LaTeX', icon: 'doc', link: name,
                    note: info && info.problem ? (ATLAS_MANUSCRIPT_PROBLEM[info.problem] || 'Manuskript nicht lesbar')
                        : info && !info.found ? 'Manuskript fehlt in manuskripte/'
                        : 'Manuskript' + (info ? ' · ' + info.cite_count + (info.cite_count === 1 ? ' Zitat' : ' Zitate') : ''),
                    action: 'Im Editor öffnen', route: atlasEditorRoute(id), unlink: true,
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
                    sub: atlasShortDay(p.due) + ', ' + atlasLongDate(p.due)
                        + ' · ' + (overdue ? 'überfällig' : atlasInDays(days)) + ' · steht im Kalender',
                });
            }
            if (p.submitted) out.push({ key: 'sub', icon: 'clock', tone: '', title: 'Eingereicht', sub: atlasLongDate(p.submitted) });
            if (p.published) out.push({ key: 'pub', icon: 'check', tone: '', title: 'Veröffentlicht', sub: atlasLongDate(p.published) });
            return out;
        },
        linkedChapters() {
            return this.chapters.filter((c) => (c.publications || []).includes(this.id));
        },
        belongs() {
            const out = [];
            for (const c of this.linkedChapters) {
                out.push({ key: 'ch:' + c.id, label: 'Kapitel', title: c.title || c.id,
                    to: atlasDetailRoute('diss_node', c.id), unlink: () => this.unlinkChapter(c) });
            }
            for (const pr of (this.pub && this.pub.projects_resolved) || []) {
                out.push({ key: 'pr:' + pr.id, label: 'Projekt', title: pr.title || pr.id,
                    to: pr.found ? atlasDetailRoute('project', pr.id) : null,
                    unlink: () => this.setLinks('projects', this.pub.projects.filter((x) => x !== pr.id), pr.title || pr.id, true) });
            }
            for (const o of (this.pub && this.pub.origins) || []) {
                out.push({ key: 'id:' + o.id, label: 'Idee', title: o.title || o.id,
                    to: o.kind === 'idea' ? atlasDetailRoute('idea', o.id) : null,
                    unlink: () => this.setLinks('derived_from', this.pub.derived_from.filter((x) => x !== o.id), o.title || o.id, true) });
            }
            const notes = (this.backlinks && this.backlinks.zettel) || [];
            if (notes.length) {
                out.push({ key: 'notes', label: 'Notizen', title: notes.length === 1 ? '1 Notiz verweist hierher' : notes.length + ' Notizen verweisen hierher',
                    to: '/atlas/zettel/' + encodeURIComponent(notes[0].id) });
            }
            return out;
        },
        linkOptions() {
            const p = this.pub || {};
            const linked = new Set(this.linkedChapters.map((c) => c.id));
            const ents = atlasWork.entities || [];
            return {
                chapters: this.chapters.filter((c) => !linked.has(c.id)).map((c) => ({ id: c.id, title: c.title || c.id })),
                projects: ents.filter((e) => e.kind === 'project' && !(p.projects || []).includes(e.id)),
                ideas: ents.filter((e) => e.kind === 'idea' && !(p.derived_from || []).includes(e.id)),
            };
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
            const key = this.pub && this.pub.paper;
            const picked = this.paperPicked;
            if (picked && picked.cite_key === key) return picked.title || key;
            const resolved = this.pub && this.pub.paper_resolved;
            if (resolved && resolved.found && resolved.citekey === key) return resolved.title || key;
            const hit = this.papers.find((p) => p.cite_key && p.cite_key === key);
            return hit ? (hit.title || key) : key;
        },
    },
    watch: {
        async id() { await this.switchEntity(); this.load(); },
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
        // --- Laden ----------------------------------------------------------
        async load(silent = false) {
            if (!this.id) return;
            if (!silent) this.loading = true;
            try {
                this.setPub(await api(this.url()));
                this.missing = false;
            } catch (e) {
                this.pub = null;
                this.missing = true;
                this.loading = false;
                return;
            }
            this.loading = false;
            await Promise.all([this.loadLiterature(), this.loadDocuments(), this.loadSide(), this.loadUnassigned()]);
        },
        setPub(pub) {
            this.pub = pub;
            this.syncDraft(pub, ATLAS_PUBLICATION_FIELDS);
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
        async loadUnassigned() {
            try {
                this.unassignedManuscripts = (await api('/api/plugins/atlas/manuscripts/unassigned')).manuscripts || [];
            } catch (e) {
                this.unassignedManuscripts = [];
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
        // Die Veröffentlichung selbst neu — der Literatur-Abgleich (eine
        // Bibliotheksabfrage je Cite Key) nur, wenn sich seine Quellen
        // geändert haben: Manuskripte, refs, die Sammlung.
        async loadPub() {
            const sources = (p) => JSON.stringify(p ? [p.manuscripts, p.refs, p.collection_id] : null);
            const before = sources(this.pub);
            try { this.setPub(await api(this.url())); } catch (e) { return; }
            if (sources(this.pub) !== before) await this.loadLiterature();
        },
        // Nur, was die gemeldeten Arten betreffen. Das eigene Speichern meldet
        // sich auch — dann holt loadPub nur die Datei, nicht den Abgleich.
        reloadFor(kinds) {
            if (atlasTouches(kinds, ['collection'])) return this.load(true);
            if (!this.pub) return null;
            const parts = [];
            if (atlasTouches(kinds, ['publication', 'project', 'idea'])) parts.push(this.loadPub());
            if (atlasTouches(kinds, ['manuscript', 'publication_document'])) parts.push(this.loadLiterature(), this.loadUnassigned());
            if (atlasTouches(kinds, ['publication_document'])) parts.push(this.loadDocuments());
            if (atlasTouches(kinds, ['journal', 'diss_node', 'zettel', 'idea'])) parts.push(this.loadSide());
            return Promise.all(parts);
        },
        // --- Speichern (AtlasAutosave) --------------------------------------
        persist(patch, url) {
            return api(url, { method: 'PUT', body: JSON.stringify(patch) });
        },
        onPersisted(saved, patch) {
            // Die Antwort des Updates trägt keine aufgelösten Felder (Projekte,
            // Ideen, eigenes Paper) — die bleiben vom letzten Laden.
            const keep = {
                projects_resolved: this.pub.projects_resolved, origins: this.pub.origins,
                paper_resolved: this.pub.paper_resolved, manuscripts_resolved: this.pub.manuscripts_resolved,
            };
            const before = JSON.stringify([this.pub.refs, this.pub.manuscripts]);
            this.setPub({ ...saved, ...keep });
            if ('paper' in patch || 'projects' in patch || 'derived_from' in patch) this.loadPub();
            if (JSON.stringify([saved.refs, saved.manuscripts]) !== before) this.loadLiterature();
        },
        // --- Stand ----------------------------------------------------------
        async setStatus(key, extra = {}) {
            if (!this.pub || this.busy || (this.pub.status === key && !extra.venue)) return null;
            this.busy = true;
            this.closeOpen = false;
            let res = null;
            try {
                await this.flushSave();
                res = await atlasChangeStatus(this.pub, key, () => this.loadPub(), extra);
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            this.busy = false;
            return res;
        },
        withdraw() { this.setStatus('withdrawn'); },
        reopen() {
            this.setStatus(atlasReopenStatus(this.pub.history, ATLAS_PIPELINE_CLOSED, 'drafting'));
        },
        openReject(mode) {
            this.closeOpen = false;
            this.rejectMode = mode;
            this.rejectChoice = 'resubmit';
            this.newVenue = '';
            this.newDue = '';
            this.rejectError = '';
            this.$nextTick(() => { if (this.$refs.newVenue) this.$refs.newVenue.focus(); });
        },
        async applyReject() {
            if (this.busy) return;
            const venue = this.newVenue.trim();
            if (this.rejectResubmit && !venue) {
                this.rejectError = 'Trag das neue Ziel ein – oder leg die Veröffentlichung ins Archiv.';
                return;
            }
            const mode = this.rejectMode;
            this.rejectMode = '';
            if (mode === 'reject' && this.rejectChoice === 'archive') {
                await this.setStatus('rejected');
                return;
            }
            const target = { venue, due: this.newDue || null, message: 'Neues Ziel: ' + venue + '. Die Absage steht im Verlauf.' };
            if (mode === 'resubmit') {
                await this.setStatus('drafting', target);
                return;
            }
            // Abgelehnt und gleich woanders: zwei Schritte im Verlauf (die
            // Absage, das neue Ziel), ein Rückgängig für beide.
            this.busy = true;
            try {
                await this.flushSave();
                const pubUrl = this.url('/status');
                const first = await api(pubUrl, { method: 'POST', body: JSON.stringify({ status: 'rejected' }) });
                const second = await api(pubUrl, { method: 'POST', body: JSON.stringify({ status: 'drafting', venue, due: target.due }) });
                const undoBody = { ...second.previous, ...first.previous };
                atlasToast(target.message, {
                    actionLabel: 'Rückgängig',
                    action: async () => {
                        try {
                            await api(this.url(), { method: 'PUT', body: JSON.stringify(undoBody) });
                            atlasToast('Rückgängig gemacht.');
                        } catch (e) {
                            atlasToast(atlasErrorText(e), { tone: 'danger' });
                        }
                        await this.loadPub();
                    },
                });
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            this.busy = false;
            await this.loadPub();
        },
        // --- Gehört zu ------------------------------------------------------
        // Projekt und Idee liegen in der Veröffentlichung (projects,
        // derived_from), das Kapitel trägt sie in seiner Datei (ADR-0005).
        async setLinks(field, ids, title, removing) {
            const before = [...(this.pub[field] || [])];
            try {
                await this.flushSave();
                await api(this.url(), { method: 'PUT', body: JSON.stringify({ [field]: ids }) });
                atlasToast((removing ? 'Verknüpfung mit „' + title + '“ gelöst.' : 'Verknüpft mit „' + title + '“.'), {
                    actionLabel: 'Rückgängig',
                    action: async () => {
                        try { await api(this.url(), { method: 'PUT', body: JSON.stringify({ [field]: before }) }); } catch (e) { atlasToast(atlasErrorText(e), { tone: 'danger' }); }
                        await this.loadPub();
                    },
                });
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            await this.loadPub();
        },
        async chapterLink(chapterId, on) {
            const base = '/api/plugins/atlas/diss/' + encodeURIComponent(chapterId) + '/publications';
            if (on) await api(base, { method: 'POST', body: JSON.stringify({ publication_id: this.id }) });
            else await api(base + '/' + encodeURIComponent(this.id), { method: 'DELETE' });
        },
        async unlinkChapter(c) {
            try {
                await this.chapterLink(c.id, false);
                atlasToast('Verknüpfung mit „' + (c.title || c.id) + '“ gelöst.', {
                    actionLabel: 'Rückgängig',
                    action: async () => {
                        try { await this.chapterLink(c.id, true); } catch (e) { atlasToast(atlasErrorText(e), { tone: 'danger' }); }
                        await this.loadSide();
                    },
                });
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            await this.loadSide();
        },
        async addLink(event) {
            const value = event.target.value;
            event.target.value = '';
            const cut = value.indexOf(':');
            if (cut < 0) return;
            const kind = value.slice(0, cut);
            const id = value.slice(cut + 1);
            if (kind === 'diss_node') {
                const c = this.chapters.find((x) => x.id === id) || { id, title: id };
                try {
                    await this.chapterLink(id, true);
                    atlasToast('Verknüpft mit „' + (c.title || id) + '“.', {
                        actionLabel: 'Rückgängig',
                        action: async () => {
                            try { await this.chapterLink(id, false); } catch (e) { atlasToast(atlasErrorText(e), { tone: 'danger' }); }
                            await this.loadSide();
                        },
                    });
                } catch (e) {
                    atlasToast(atlasErrorText(e), { tone: 'danger' });
                }
                await this.loadSide();
                return;
            }
            const field = kind === 'project' ? 'projects' : 'derived_from';
            const e = atlasEntity(id);
            await this.setLinks(field, [...(this.pub[field] || []), id], (e && e.title) || id, false);
        },
        // --- Eigenes Paper --------------------------------------------------
        loadPapers() {
            if (this._papersLoad) return this._papersLoad;
            this.papersLoading = true;
            this.papersFailed = false;
            this._papersLoad = api('/api/papers')
                .then((data) => { this.papers = Array.isArray(data) ? data : (data.papers || data.items || []); })
                .catch(() => { this.papers = []; this._papersLoad = null; this.papersFailed = true; })
                .finally(() => { this.papersLoading = false; });
            return this._papersLoad;
        },
        pickPaper(p) {
            this.paperPicked = { cite_key: p.cite_key || '', title: p.title || '' };
            this.paperQuery = '';
            this.saveNow({ paper: p.cite_key || null });
        },
        // --- Löschen --------------------------------------------------------
        async doDelete() {
            if (this.deleting) return;
            this.deleting = true;
            const title = this.pub.title;
            try {
                await api(this.url(), { method: 'DELETE' });
                this.pendingPatch = {};
                this.deleteOpen = false;
                atlasToast('„' + title + '“ gelöscht.');
                this.$router.push(ATLAS_PUBLICATIONS_ROUTE);
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            this.deleting = false;
        },
        onBibClosed(changed) {
            this.bibOpen = false;
            if (changed) this.load(true);
        },
        // „Zum Forschungsprojekt verschieben": erst die Vorschau (welche Felder
        // in den Abschnitt „Aus … übernommen" wandern), dann bestätigen.
        async switchKind() {
            const cid = this.pub.collection.id;
            const base = '/api/plugins/atlas/collections/' + encodeURIComponent(cid) + '/switch';
            try {
                await this.flushSave();
                const plan = await api(base + '?to=project');
                const lines = ['„' + this.pub.title + '“ zum Forschungsprojekt verschieben?', ''];
                if (plan.has_file) {
                    lines.push('Übernommen: ' + (plan.moved || []).join(', ') + '.');
                    if ((plan.carried || []).length) {
                        lines.push('', 'Ohne Gegenstück — wandert als Abschnitt „' + plan.section + ' (Datum)“ in die Notizen:');
                        plan.carried.forEach((c) => lines.push('• ' + c.label + ': ' + c.value));
                    }
                }
                lines.push('', 'Die Literatur bleibt in der Sammlung.');
                if (!confirm(lines.join('\n'))) return;
                const res = await api(base, { method: 'POST', body: JSON.stringify({ to: 'project' }) });
                this.$router.push(atlasDetailRoute('project', res.id));
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
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
            if (!resp.ok) throw await atlasResponseError(resp, 'Upload fehlgeschlagen');
            return resp.json();
        },
        async linkManuscript(event) {
            const id = event.target.value;
            event.target.value = '';
            if (!id) return;
            try {
                await api(this.url('/manuscripts'), { method: 'POST', body: JSON.stringify({ name: id + '.tex' }) });
                atlasToast('„' + id + '.tex“ gehört jetzt zu diesem Beitrag.');
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            await this.load(true);
        },
        // Lösen, nicht löschen: die .tex bleibt in manuskripte/ (Verknüpfung,
        // kein Besitz) und steht dann unten in der Pipeline.
        async unlinkManuscript(name) {
            try {
                await api(this.url('/manuscripts/' + encodeURIComponent(name)), { method: 'DELETE' });
                atlasToast('„' + name + '“ gelöst – die Datei bleibt in manuskripte/.', {
                    actionLabel: 'Rückgängig',
                    action: async () => {
                        try { await api(this.url('/manuscripts'), { method: 'POST', body: JSON.stringify({ name }) }); } catch (e) { atlasToast(atlasErrorText(e), { tone: 'danger' }); }
                        await this.load(true);
                    },
                });
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            await this.load(true);
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
        // Das Ausklappmenü „Abgelehnt / zurückgezogen" schließt ein Klick daneben.
        onOutside(e) {
            if (this.closeOpen && !(e.target.closest && e.target.closest('.atlas-steprow .atlas-menu'))) this.closeOpen = false;
        },
    },
    mounted() {
        this.load();
        atlasLoadEntities();
        if (!atlasWork.today) atlasRefreshToday();
        this._live = atlasLiveReload((kinds) => this.reloadFor(kinds));
        document.addEventListener('pointerdown', this.onOutside);
    },
    beforeUnmount() {
        if (this._live) { this._live.close(); this._live = null; }
        if (this._pasteTimer) { clearTimeout(this._pasteTimer); this._pasteTimer = null; }
        document.removeEventListener('pointerdown', this.onOutside);
    },
};

// ── Projekt-Seite (/atlas/projekte/:id) ─────────────────────────────────────
// Derselbe Bauplan wie die Veröffentlichung. Die Arbeitspakete stehen im
// Markdown der Beschreibung (`## AP1 …` mit `- [ ] …`, Issue #48): abhaken
// geht über den Toggle-Endpunkt, „+ Aufgabe" hängt eine Zeile am Ende ihres
// Abschnitts an — nie wird bestehender Text umgeschrieben. Meilensteine sind
// eine Liste in der Datei; jede Änderung schreibt die ganze Liste.

const ATLAS_PROJECT_PIPELINE = ['planned', 'applied', 'active', 'finished'];
const ATLAS_PROJECT_CLOSED = new Set(['finished', 'rejected']);
const ATLAS_PROJECT_FIELDS = ['title', 'start', 'end', 'funder', 'grant_id', 'role', 'tags', 'refs', 'body'];

// Eine Aufgabe ans Ende eines Arbeitspakets: hinter seine letzte Zeile vor
// der nächsten Überschrift derselben Ebene. Ohne Titel (Text vor der ersten
// Überschrift) vor die erste Überschrift. Rein, fence-bewusst wie der Parser.
function atlasInsertTask(body, sectionTitle, text) {
    const lines = String(body || '').split(/\r?\n/);
    const heading = /^(#{1,6})[ \t]+(.*?)[ \t]*#*$/;
    let fenced = false;
    const heads = [];
    lines.forEach((line, i) => {
        if (line.trim().startsWith('```')) { fenced = !fenced; return; }
        const m = !fenced && heading.exec(line);
        if (m) heads.push({ i, level: m[1].length, title: m[2].trim() });
    });
    const top = heads.length ? Math.min(...heads.map((h) => h.level)) : null;
    const tops = heads.filter((h) => h.level === top);
    let start = -1;
    let end = tops.length ? tops[0].i : lines.length;
    if (sectionTitle) {
        const k = tops.findIndex((h) => h.title === sectionTitle);
        if (k < 0) return (lines.join('\n').replace(/\s+$/, '') + '\n\n## ' + sectionTitle + '\n\n- [ ] ' + text).replace(/^\n+/, '');
        start = tops[k].i;
        end = k + 1 < tops.length ? tops[k + 1].i : lines.length;
    }
    let at = start + 1;
    for (let i = end - 1; i > start; i -= 1) {
        if (lines[i].trim()) { at = i + 1; break; }
    }
    lines.splice(at, 0, '- [ ] ' + text);
    return lines.join('\n');
}
if (typeof window !== 'undefined') window._atlasInsertTask = atlasInsertTask;

function atlasMonthYear(iso) {
    return iso ? atlasFormatDate(iso, { month: 'short', year: 'numeric' }) : '…';
}

const AtlasProjectPage = {
    mixins: [AtlasAutosave],
    components: { 'atlas-markdown': AtlasMarkdown,
        'atlas-nav': AtlasNav,
        'atlas-icon': AtlasIcon,
        'atlas-chips': AtlasChips,
        'atlas-save-state': AtlasSaveState,
        'atlas-entity-menu': AtlasEntityMenu,
        'atlas-delete-dialog': AtlasDeleteDialog,
        'atlas-verlauf': AtlasVerlauf,
        'atlas-backlinks': AtlasBacklinks,
        'atlas-anchor-tasks': AtlasAnchorTasks,
    },
    template: `
        <div class="atlas-page atlas-shell" lang="de">
            <atlas-nav active="projekte" />
            <div v-if="loading" class="atlas-skel" style="height:120px" aria-hidden="true"></div>
            <section v-else-if="missing" class="atlas-panel is-padded atlas-missing" role="status">
                <router-link :to="backRoute" class="atlas-back"><atlas-icon name="back" :size="16" /> Projekte</router-link>
                <h1 class="atlas-title is-small">Dieses Projekt gibt es nicht (mehr)</h1>
                <p class="atlas-muted">Vielleicht wurde die Datei umbenannt oder gelöscht.</p>
            </section>

            <template v-else-if="project">
                <header class="atlas-detail-header">
                    <router-link :to="backRoute" class="atlas-back"><atlas-icon name="back" :size="16" /> Projekte</router-link>
                    <div class="atlas-detail-titlerow">
                        <div class="atlas-detail-titles">
                            <h1 class="atlas-title is-detail atlas-title-field">
                                <label for="atlas-proj-title" class="atlas-sr">Titel</label>
                                <input id="atlas-proj-title" class="atlas-title-input" v-model="draft.title" :readonly="!!project.collection"
                                       :title="project.collection ? 'Der Titel ist der Name der Sammlung – in LocalBib umbenennen.' : ''"
                                       autocomplete="off" @focus="focusField('title')" @blur="blurField('title', project, { required: true })"
                                       @keydown.enter.prevent="$event.target.blur()" />
                            </h1>
                            <div class="atlas-detail-meta">
                                <template v-for="(m, i) in metaParts" :key="i">
                                    <span v-if="i" aria-hidden="true" class="atlas-dot">·</span><span>{{ m }}</span>
                                </template>
                            </div>
                        </div>
                        <div class="atlas-header-actions">
                            <atlas-save-state :state="saveState" :error="saveError" :file="fileLabel" @retry="flushSave" />
                            <atlas-entity-menu kind="project" :entity-id="project.id" :file="fileLabel" :extra="menuExtra"
                                               :delete-label="project.collection ? 'Atlas-Angaben löschen …' : 'Löschen …'" @delete="deleteOpen = true" />
                            <button type="button" class="atlas-btn is-primary is-tall" @click="newTask">
                                <atlas-icon name="plus" /> Aufgabe zum Projekt
                            </button>
                        </div>
                    </div>
                    <div class="atlas-steprow">
                        <ol class="atlas-steps" :class="{ 'is-muted': project.status === 'rejected' }" aria-label="Stand des Projekts">
                            <li v-for="(st, i) in steps" :key="st.key" class="atlas-step-li">
                                <atlas-icon v-if="i" name="chevronRight" :size="14" class="atlas-step-sep" />
                                <button type="button" class="atlas-step" :class="{ 'is-current': st.current, 'is-past': st.past }"
                                        :aria-pressed="st.current ? 'true' : 'false'" :disabled="busy" @click="setStatus(st.key)">
                                    <atlas-icon v-if="st.past" name="check" :size="14" />{{ st.name }}
                                </button>
                            </li>
                        </ol>
                        <span class="atlas-steprow-sep" aria-hidden="true"></span>
                        <button type="button" class="atlas-step is-ghost" :aria-pressed="project.status === 'rejected' ? 'true' : 'false'"
                                :disabled="busy || project.status === 'rejected'" @click="setStatus('rejected')">Abgelehnt</button>
                    </div>
                </header>

                <section v-if="archived" class="atlas-archive" aria-label="Im Archiv">
                    <span class="atlas-archive-icon"><atlas-icon name="archive" :size="20" /></span>
                    <div class="atlas-archive-text">
                        <div class="atlas-archive-title">{{ project.status === 'finished' ? 'Abgeschlossen' : 'Abgelehnt' }}<template v-if="archivedSince"> · seit {{ archivedSince }}</template></div>
                        <div class="atlas-archive-sub">Liegt im Archiv der Projekte. Meilensteine, Dokumente und Veröffentlichungen bleiben hier.</div>
                    </div>
                    <button type="button" class="atlas-btn" :disabled="busy" @click="reopen">Wieder öffnen</button>
                </section>

                <div class="atlas-columns">
                    <div class="atlas-col-main">
                        <section class="atlas-panel is-padded atlas-stack" aria-labelledby="atlas-h-besch">
                            <div class="atlas-panel-head is-flush">
                                <h2 id="atlas-h-besch" class="atlas-panel-title">Beschreibung</h2>
                                <span class="atlas-panel-note is-inline">Ziel, Kontext, Absprachen · Markdown · Arbeitspakete als „## AP1 …“ mit „- [ ] Aufgabe“</span>
                            </div>
                            <span class="atlas-sr">Beschreibung</span>
                            <atlas-markdown id="atlas-proj-body" ref="bodyMd" v-model="draft.body" class="is-notes" placeholder="Ziel des Projekts, Partner, Absprachen …"
                                            @focus="focusField('body')" @update:model-value="queueSave({ body: $event })" @blur="blurText('body')" />
                        </section>

                        <section class="atlas-panel is-padded atlas-stack" aria-labelledby="atlas-h-ms">
                            <div class="atlas-panel-head is-flush">
                                <h2 id="atlas-h-ms" class="atlas-panel-title">Meilensteine</h2>
                                <span class="atlas-panel-note is-inline">{{ msSummary }}</span>
                            </div>
                            <ul class="atlas-ms-list">
                                <li v-for="m in timeline" :key="m.index" class="atlas-ms-row" :class="'is-' + m.state">
                                    <input :id="'atlas-ms-' + m.index" type="checkbox" class="atlas-check" :checked="m.done"
                                           :aria-label="m.title + ' erreicht'" @change="toggleMilestone(m.index)" />
                                    <label :for="'atlas-ms-t' + m.index" class="atlas-sr">Meilenstein</label>
                                    <input :id="'atlas-ms-t' + m.index" class="atlas-ms-title" :value="m.title"
                                           @change="editMilestone(m.index, { title: $event.target.value })" @keydown.enter.prevent="$event.target.blur()" />
                                    <span v-if="m.state === 'overdue'" class="atlas-badge is-small is-danger">überfällig</span>
                                    <span v-else-if="m.next" class="atlas-badge is-small is-accent">als Nächstes</span>
                                    <label :for="'atlas-ms-d' + m.index" class="atlas-sr">Datum von {{ m.title }}</label>
                                    <input :id="'atlas-ms-d' + m.index" type="date" class="atlas-input is-field is-date" :value="m.date || ''"
                                           @change="editMilestone(m.index, { date: $event.target.value || null })" />
                                    <button type="button" class="atlas-chip-x is-row" :aria-label="'Meilenstein „' + m.title + '“ entfernen'"
                                            @click="removeMilestone(m.index)">×</button>
                                </li>
                                <li v-if="!timeline.length" class="atlas-ms-row is-empty">Noch keine Meilensteine.</li>
                            </ul>
                            <div class="atlas-ms-add">
                                <label for="atlas-ms-new" class="atlas-sr">Neuer Meilenstein</label>
                                <input id="atlas-ms-new" class="atlas-input is-field is-add" v-model="msDraft.title" placeholder="+ Meilenstein, Enter"
                                       autocomplete="off" @keydown.enter.prevent="addMilestone" />
                                <label for="atlas-ms-newdate" class="atlas-sr">Datum des neuen Meilensteins</label>
                                <input id="atlas-ms-newdate" type="date" class="atlas-input is-field is-date" v-model="msDraft.date" @keydown.enter.prevent="addMilestone" />
                            </div>
                        </section>

                        <section class="atlas-panel is-padded atlas-stack" aria-labelledby="atlas-h-ap">
                            <div class="atlas-panel-head is-flush">
                                <h2 id="atlas-h-ap" class="atlas-panel-title">{{ sections.some((s) => s.title) ? 'Arbeitspakete' : 'Aufgaben' }}</h2>
                                <span class="atlas-panel-note is-inline">{{ checklistSummary }}</span>
                            </div>
                            <div v-for="s in sections" :key="s.key" class="atlas-ap">
                                <div class="atlas-ap-head">
                                    <h3 class="atlas-ap-title">{{ s.title || 'Ohne Arbeitspaket' }}</h3>
                                    <span class="atlas-ap-bar" aria-hidden="true"><span :style="{ width: s.pct }"></span></span>
                                    <span class="atlas-ap-count">{{ s.done }}/{{ s.total }}</span>
                                </div>
                                <ul class="atlas-mini-tasks">
                                    <li v-for="it in s.items" :key="it.index" class="atlas-mini-task">
                                        <input :id="'atlas-ap-' + it.index" type="checkbox" class="atlas-check" :checked="it.done" @change="toggleTask(it.index)" />
                                        <label :for="'atlas-ap-' + it.index" :class="{ 'is-done': it.done }">{{ it.text }}</label>
                                    </li>
                                </ul>
                                <label :for="'atlas-ap-add-' + s.key" class="atlas-sr">Neue Aufgabe in {{ s.title || 'Aufgaben' }}</label>
                                <input :id="'atlas-ap-add-' + s.key" class="atlas-input is-field is-add" placeholder="+ Aufgabe, Enter"
                                       v-model="apDrafts[s.key]" autocomplete="off" @keydown.enter.prevent="addTask(s)" />
                            </div>
                            <p v-if="!sections.length" class="atlas-muted" style="margin:0">Noch keine Aufgaben. Leg ein Arbeitspaket an – Atlas schreibt es als „## …“ in die Beschreibung.</p>
                            <div class="atlas-ms-add">
                                <label for="atlas-ap-new" class="atlas-sr">Neues Arbeitspaket</label>
                                <input id="atlas-ap-new" class="atlas-input is-field is-add" v-model="apNew" placeholder="+ Arbeitspaket, z. B. AP4 · Transfer, Enter"
                                       autocomplete="off" @keydown.enter.prevent="addWorkpackage" />
                            </div>
                        </section>

                        <atlas-anchor-tasks :key="'pt-' + project.id" :anchor="project.id" label="Offene Aufgaben zum Projekt" />
                    </div>

                    <aside class="atlas-col-side">
                        <section class="atlas-panel is-padded atlas-stack" aria-labelledby="atlas-h-pang">
                            <div class="atlas-panel-head is-flush">
                                <h2 id="atlas-h-pang" class="atlas-panel-title is-side">Angaben</h2>
                                <span class="atlas-panel-note is-inline">speichert beim Verlassen eines Feldes</span>
                            </div>
                            <div v-if="runtime" class="atlas-runtime">
                                <div class="atlas-runtime-head"><span>Laufzeit</span><span class="atlas-mono">{{ runtime.label }}</span></div>
                                <div class="atlas-runtime-bar" role="img" :aria-label="'Laufzeit: ' + runtime.label">
                                    <span class="atlas-runtime-fill" :style="{ width: (runtime.fraction * 100) + '%' }"></span>
                                    <span class="atlas-runtime-now" :style="{ left: (runtime.fraction * 100) + '%' }"></span>
                                </div>
                            </div>
                            <div class="atlas-fields">
                                <label for="atlas-pj-start" class="atlas-fields-label">Beginn</label>
                                <input id="atlas-pj-start" type="date" class="atlas-input is-field" v-model="draft.start" @change="saveNow({ start: draft.start || null })" />
                                <label for="atlas-pj-end" class="atlas-fields-label">Ende</label>
                                <input id="atlas-pj-end" type="date" class="atlas-input is-field" v-model="draft.end" @change="saveNow({ end: draft.end || null })" />
                                <label for="atlas-pj-funder" class="atlas-fields-label">Förderer</label>
                                <input id="atlas-pj-funder" class="atlas-input is-field" v-model="draft.funder" placeholder="z. B. DFG, BMBF" autocomplete="off"
                                       @focus="focusField('funder')" @blur="blurField('funder', project)" @keydown.enter.prevent="$event.target.blur()" />
                                <label for="atlas-pj-grant" class="atlas-fields-label">Förderkennzeichen</label>
                                <input id="atlas-pj-grant" class="atlas-input is-field atlas-mono-input" v-model="draft.grant_id" autocomplete="off"
                                       @focus="focusField('grant_id')" @blur="blurField('grant_id', project)" @keydown.enter.prevent="$event.target.blur()" />
                                <label for="atlas-pj-role" class="atlas-fields-label">Deine Rolle</label>
                                <input id="atlas-pj-role" class="atlas-input is-field" v-model="draft.role" placeholder="z. B. Projektleitung" autocomplete="off"
                                       @focus="focusField('role')" @blur="blurField('role', project)" @keydown.enter.prevent="$event.target.blur()" />
                                <span class="atlas-fields-label is-top">Schlagworte</span>
                                <atlas-chips :model-value="draft.tags" label="Schlagwort hinzufügen" placeholder="Wort, Enter"
                                             @update:model-value="(v) => { draft.tags = v; saveNow({ tags: v }); }" />
                            </div>
                        </section>

                        <section class="atlas-panel is-padded" aria-labelledby="atlas-h-ppubs">
                            <h2 id="atlas-h-ppubs" class="atlas-panel-title is-side">Veröffentlichungen</h2>
                            <ul class="atlas-belongs">
                                <li v-for="p in publications" :key="p.id">
                                    <span class="atlas-badge is-small" :class="p.status === 'published' ? 'is-ok' : (p.status === 'drafting' || p.status === 'in-revision' ? 'is-accent' : '')">{{ pubStatusLabel(p.status) }}</span>
                                    <span class="atlas-belongs-end">
                                        <router-link :to="publicationRoute(p.id)" class="atlas-belongs-link">{{ p.title }}</router-link>
                                        <button type="button" class="atlas-chip-x is-row" :aria-label="'Verknüpfung mit „' + p.title + '“ lösen'" @click="unlinkPublication(p)">×</button>
                                    </span>
                                </li>
                                <li v-if="!publications.length"><span class="atlas-muted">Noch keine Veröffentlichung aus diesem Projekt.</span></li>
                            </ul>
                            <label for="atlas-pj-link" class="atlas-sr">Veröffentlichung verknüpfen</label>
                            <select v-if="linkablePublications.length" id="atlas-pj-link" class="atlas-input is-field is-link" @change="linkPublication($event)">
                                <option value="">+ Veröffentlichung verknüpfen …</option>
                                <option v-for="p in linkablePublications" :key="p.id" :value="p.id">{{ p.title }}</option>
                            </select>
                        </section>

                        <section class="atlas-panel is-padded atlas-stack" aria-labelledby="atlas-h-plit">
                            <h2 id="atlas-h-plit" class="atlas-kicker">{{ collection ? 'Literatur aus der Sammlung' : 'Literatur' }}</h2>
                            <template v-if="collection">
                                <div class="atlas-coll-head">
                                    <span class="atlas-plan-icon is-accent is-big"><atlas-icon name="stack" /></span>
                                    <div>
                                        <div class="atlas-plan-name">{{ collection.name }}</div>
                                        <div class="atlas-plan-meta">{{ collection.item_count }} Paper · Sammlung in LocalBib</div>
                                    </div>
                                </div>
                                <router-link :to="'/collection/' + collection.id" class="atlas-btn" style="align-self:flex-start">In LocalBib öffnen</router-link>
                            </template>
                            <template v-else>
                                <ul v-if="refsResolved.length" class="atlas-lit-short">
                                    <li v-for="r in refsResolved" :key="r.citekey">
                                        <router-link v-if="r.found" :to="'/paper/' + r.paper_id" class="atlas-belongs-link">{{ r.title || r.citekey }}</router-link>
                                        <span v-else class="atlas-muted" title="Cite Key nicht in der Bibliothek">nicht in der Bibliothek</span>
                                        <span class="atlas-mono is-small">{{ r.citekey }}</span>
                                    </li>
                                </ul>
                                <atlas-chips mono :model-value="draft.refs" label="Cite Key hinzufügen" placeholder="Cite Key, Enter"
                                             @update:model-value="(v) => { draft.refs = v; saveNow({ refs: v }); }" />
                            </template>
                        </section>

                        <section class="atlas-panel is-padded atlas-stack" aria-labelledby="atlas-h-pdocs">
                            <div class="atlas-panel-head is-flush">
                                <h2 id="atlas-h-pdocs" class="atlas-panel-title is-side">Dokumente</h2>
                                <span class="atlas-panel-note is-inline">im Ordner <span class="atlas-mono">projekte/{{ project.id }}/</span></span>
                            </div>
                            <ul class="atlas-files">
                                <li v-for="d in documents" :key="d.name" class="atlas-file-row">
                                    <div class="atlas-file-text">
                                        <div class="atlas-file-name-row"><span class="atlas-mono atlas-file-name">{{ d.name }}</span></div>
                                        <div class="atlas-file-note">{{ docSize(d.size) }}</div>
                                    </div>
                                    <button type="button" class="atlas-text-btn" @click="openDocument(d.name)">Öffnen</button>
                                    <button v-if="isPdf(d)" type="button" class="atlas-text-btn" :disabled="!!extracting" @click="openExtract(d.name)">
                                        {{ extracting === d.name ? 'Extrahiert …' : 'Eckdaten extrahieren' }}
                                    </button>
                                    <button type="button" class="atlas-text-btn is-muted" :aria-label="d.name + ' löschen'" @click="deleteDocument(d.name)">Löschen</button>
                                </li>
                                <li v-if="!documents.length" class="atlas-file-row is-empty">Keine Dokumente. Dateien im Projektordner erscheinen hier von selbst.</li>
                            </ul>
                            <label class="atlas-btn is-small" style="align-self:flex-start">
                                <input type="file" multiple class="atlas-sr" :disabled="uploading" @change="uploadDocuments" />
                                <atlas-icon name="upload" :size="16" /> {{ uploading ? 'Lädt hoch …' : 'Dokument ablegen' }}
                            </label>
                            <p v-if="docsError" class="atlas-error" role="alert">{{ docsError }}</p>
                        </section>

                        <atlas-backlinks :key="'pb-' + project.id" :id="project.id" />
                        <atlas-verlauf kind="project" :entries="project.history || []" />
                    </aside>
                </div>

                <!-- Eckdaten extrahieren: erst die Zugehörigkeit, dann der Vorschlag (P4) -->
                <div v-if="extractDoc" class="atlas-modal-backdrop" @click.self="extractDoc = ''" @keydown.esc="extractDoc = ''">
                    <form class="atlas-modal is-medium" role="dialog" aria-modal="true" aria-labelledby="atlas-ex-h" @submit.prevent="runExtract">
                        <div class="atlas-new-head">
                            <div>
                                <h2 id="atlas-ex-h" class="atlas-modal-title is-detail">Eckdaten extrahieren</h2>
                                <p class="atlas-modal-sub atlas-mono">{{ extractDoc }}</p>
                            </div>
                            <button type="button" class="atlas-icon-square" aria-label="Schließen" @click="extractDoc = ''"><atlas-icon name="close" /></button>
                        </div>
                        <div class="atlas-new-field">
                            <label for="atlas-ex-aff" class="atlas-new-legend">Zu welchem Institut, Lehrstuhl oder Unternehmen gehörst du?</label>
                            <input id="atlas-ex-aff" class="atlas-input" v-model="extractAffiliation" placeholder="z. B. RWTH Aachen, Lehrstuhl iCOM" />
                            <span class="atlas-new-help">Förderanträge nennen viele Partner – so liest das LLM nur deine Rolle, Meilensteine und Arbeitspakete.</span>
                        </div>
                        <div v-if="modelOptions.length" class="atlas-new-field">
                            <label for="atlas-ex-model" class="atlas-new-legend">LLM-Modell</label>
                            <select id="atlas-ex-model" class="atlas-input" v-model="extractModel">
                                <option v-for="m in modelOptions" :key="m" :value="m">{{ m }}</option>
                            </select>
                        </div>
                        <p v-if="docsError" class="atlas-error" role="alert">{{ docsError }}</p>
                        <div class="atlas-new-foot is-end">
                            <button type="button" class="atlas-btn" @click="extractDoc = ''">Abbrechen</button>
                            <button type="submit" class="atlas-btn is-primary" :disabled="!!extracting">{{ extracting ? 'Extrahiert …' : 'Extrahieren' }}</button>
                        </div>
                    </form>
                </div>

                <div v-if="proposal" class="atlas-modal-backdrop" @click.self="proposal = null" @keydown.esc="proposal = null">
                    <div class="atlas-modal is-medium" role="dialog" aria-modal="true" aria-labelledby="atlas-pr-h">
                        <div class="atlas-new-head">
                            <div>
                                <h2 id="atlas-pr-h" class="atlas-modal-title is-detail">Extrahierte Eckdaten</h2>
                                <p class="atlas-modal-sub atlas-mono">{{ proposalDoc }}</p>
                            </div>
                            <button type="button" class="atlas-icon-square" aria-label="Schließen" @click="proposal = null"><atlas-icon name="close" /></button>
                        </div>
                        <p v-if="!proposalHasData" class="atlas-muted" style="margin:0">Im Dokument wurden keine übernehmbaren Eckdaten gefunden.</p>
                        <template v-else>
                            <dl v-if="proposalFacts.length" class="atlas-facts">
                                <template v-for="f in proposalFacts" :key="f.label"><dt>{{ f.label }}</dt><dd>{{ f.value }}</dd></template>
                            </dl>
                            <div v-if="(proposal.milestones || []).length">
                                <div class="atlas-group-label">Meilensteine ({{ proposal.milestones.length }})</div>
                                <ul class="atlas-lit-short">
                                    <li v-for="(m, i) in proposal.milestones" :key="i"><span>{{ m.title }}</span><span class="atlas-muted">{{ m.date || 'ohne Datum' }}</span></li>
                                </ul>
                            </div>
                            <div v-if="(proposal.workpackages || []).length">
                                <div class="atlas-group-label">Arbeitspakete ({{ proposal.workpackages.length }})</div>
                                <ul class="atlas-lit-short">
                                    <li v-for="(w, i) in proposal.workpackages" :key="i"><span>{{ w.title }}</span><span class="atlas-muted">{{ (w.tasks || []).length }} Aufgabe(n)</span></li>
                                </ul>
                            </div>
                        </template>
                        <ul v-if="(proposal.warnings || []).length" class="atlas-del-list">
                            <li v-for="(w, i) in proposal.warnings" :key="i" class="is-gone"><atlas-icon name="alert" :size="16" /><span>{{ w }}</span></li>
                        </ul>
                        <p v-if="proposalHasData" class="atlas-muted" style="margin:0">Übernahme füllt nur leere Felder; Meilensteine und Arbeitspakete werden angehängt. Rückgängig geht im Hinweis.</p>
                        <div class="atlas-new-foot is-end">
                            <button type="button" class="atlas-btn" @click="proposal = null">Verwerfen</button>
                            <button type="button" class="atlas-btn is-primary" :disabled="!proposalHasData" @click="applyProposal">Übernehmen</button>
                        </div>
                    </div>
                </div>

                <atlas-delete-dialog v-if="deleteOpen" :title="project.collection ? 'Atlas-Angaben löschen?' : 'Projekt löschen?'"
                                     :gone="deleteFacts.gone" :kept="deleteFacts.kept" :busy="deleting"
                                     hint="Ist es nur vorbei? Dann lieber „Abgeschlossen“ – es bleibt im Archiv."
                                     @cancel="deleteOpen = false" @confirm="doDelete" />
            </template>
        </div>
    `,
    data() {
        return {
            project: null,
            loading: true,
            missing: false,
            busy: false,
            draft: { title: '', start: '', end: '', funder: '', grant_id: '', role: '', tags: [], refs: [], body: '' },
            publications: [],
            refsResolved: [],
            allPublications: [],
            documents: [],
            documentsLoaded: false,
            uploading: false,
            docsError: '',
            msDraft: { title: '', date: '' },
            apDrafts: {},
            apNew: '',
            extractDoc: '',
            extractAffiliation: '',
            extractModels: [],
            extractModel: '',
            extracting: '',
            proposal: null,
            proposalDoc: '',
            deleteOpen: false,
            deleting: false,
        };
    },
    computed: {
        id() { return String(this.$route.params.id || ''); },
        backRoute() { return ATLAS_LIST_ROUTE.project; },
        fileLabel() { return this.project ? atlasFileLabel('projekte', this.project) : ''; },
        collection() {
            const c = this.project && this.project.collection;
            return c && !c.missing ? c : null;
        },
        archived() { return !!this.project && ATLAS_PROJECT_CLOSED.has(this.project.status); },
        archivedSince() {
            const h = (this.project && this.project.history) || [];
            for (let i = h.length - 1; i >= 0; i -= 1) if (h[i].status === this.project.status) return atlasLongDate(h[i].date);
            return '';
        },
        metaParts() {
            const p = this.project;
            const out = [p.funder || 'Förderer offen'];
            if (p.start || p.end) out.push(atlasMonthYear(p.start) + ' – ' + atlasMonthYear(p.end));
            const n = this.publications.length;
            out.push(n === 1 ? '1 Veröffentlichung' : n + ' Veröffentlichungen');
            return out;
        },
        steps() {
            const idx = ATLAS_PROJECT_PIPELINE.indexOf(this.project.status);
            return ATLAS_PROJECT_PIPELINE.map((key, i) => ({
                key, name: (PROJECT_STATUSES.find((s) => s.key === key) || {}).label || key,
                current: i === idx, past: idx >= 0 && i < idx,
            }));
        },
        runtime() { return this.project ? projRuntimeBar(this.project.start, this.project.end) : null; },
        timeline() { return (this.project && this.project.timeline) || []; },
        msSummary() {
            const all = this.timeline.length;
            const done = this.timeline.filter((m) => m.done).length;
            const late = this.timeline.filter((m) => m.state === 'overdue').length;
            if (!all) return 'Termine stehen im Kalender';
            return done + ' von ' + all + ' erreicht' + (late ? ' · ' + late + ' überfällig' : '') + ' · stehen im Kalender';
        },
        // Arbeitspakete aus dem Parser (Issue #48). Die laufende Nummer zählt
        // über ALLE Abschnitte in Dokumentreihenfolge, bevor gefiltert wird —
        // sie muss zur flachen Liste passen, in die der Toggle zeigt.
        sections() {
            let idx = 0;
            return ((this.project && this.project.sections) || [])
                .map((s, n) => ({
                    ...s,
                    key: 'ap' + n,
                    items: (s.items || []).map((it) => ({ ...it, index: idx++ })),
                    pct: (s.total ? Math.round((s.done / s.total) * 100) : 0) + '%',
                }))
                .filter((s) => s.total > 0 || s.title);
        },
        checklistSummary() {
            const c = (this.project && this.project.checklist) || { done: 0, total: 0 };
            return c.total ? c.done + ' von ' + c.total + ' Aufgaben erledigt' : 'abhaken direkt in der Liste';
        },
        linkablePublications() {
            const linked = new Set(this.publications.map((p) => p.id));
            return this.allPublications.filter((p) => !linked.has(p.id));
        },
        modelOptions() {
            const picked = this.extractModel ? [this.extractModel] : [];
            return [...new Set([...picked, ...(this.extractModels || [])].filter(Boolean))];
        },
        proposalFacts() {
            const p = this.proposal || {};
            const out = [];
            if (p.start || p.end) out.push({ label: 'Laufzeit', value: (p.start || '?') + ' – ' + (p.end || '?') });
            if (p.funder) out.push({ label: 'Förderer', value: p.funder });
            if (p.grant_id) out.push({ label: 'Förderkennzeichen', value: p.grant_id });
            if (p.role) out.push({ label: 'Rolle', value: p.role });
            return out;
        },
        proposalHasData() {
            const p = this.proposal;
            if (!p) return false;
            return this.proposalFacts.length > 0 || (p.milestones || []).length > 0 || (p.workpackages || []).length > 0;
        },
        menuExtra() {
            if (!this.collection) return [];
            return [{ label: 'Zur Veröffentlichung verschieben', sub: 'die Literatur bleibt in der Sammlung', action: () => this.switchKind() }];
        },
        deleteFacts() {
            const gone = ['Angaben, Meilensteine, Arbeitspakete und Verlauf in ' + this.fileLabel];
            const kept = [];
            const n = this.documentsLoaded ? this.documents.length : null;
            if (n === null) kept.push('Dateien im Dokumentordner – unter „projekte/' + this.id + '.geloescht-<Datum>“');
            else if (n) kept.push((n === 1 ? 'die Datei' : 'die ' + n + ' Dateien') + ' im Dokumentordner – unter „projekte/' + this.id + '.geloescht-<Datum>“');
            if (this.publications.length) kept.push('die Veröffentlichungen (sie verlieren nur die Verknüpfung)');
            if (this.project.collection) kept.push('die Sammlung „' + this.project.collection.name + '“ und ihre Literatur in LocalBib');
            return { gone, kept };
        },
    },
    watch: {
        async id() { await this.switchEntity(); this.load(); },
    },
    methods: {
        url(suffix = '') { return '/api/plugins/atlas/projects/' + encodeURIComponent(this.id) + suffix; },
        pubStatusLabel(s) { return ATLAS_PUBLICATION_STATUS_LABEL[s] || s; },
        publicationRoute(id) { return atlasPublicationRoute(id); },
        isPdf(d) { return /\.pdf$/i.test((d && d.name) || ''); },
        docSize(bytes) {
            if (bytes == null) return '';
            if (bytes < 1024) return bytes + ' B';
            if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
            return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        },
        async load(silent = false) {
            if (!this.id) return;
            if (!silent) this.loading = true;
            try {
                this.setProject(await api(this.url()));
                this.missing = false;
            } catch (e) {
                this.project = null;
                this.missing = true;
                this.loading = false;
                return;
            }
            this.loading = false;
            await Promise.all([this.loadDocuments(), this.loadAllPublications()]);
        },
        setProject(data) {
            this.project = data;
            if (data.publications) this.publications = data.publications;
            if (data.refs_resolved) this.refsResolved = data.refs_resolved;
            this.syncDraft(data, ATLAS_PROJECT_FIELDS);
        },
        async loadProject() {
            try { this.setProject(await api(this.url())); } catch (e) { /* bleibt; das nächste Laden entscheidet */ }
        },
        async loadAllPublications() {
            try { this.allPublications = (await api('/api/plugins/atlas/publications')).publications || []; } catch (e) { this.allPublications = []; }
        },
        async loadDocuments() {
            this.documentsLoaded = false;
            try {
                this.documents = (await api(this.url('/documents'))).documents || [];
                this.documentsLoaded = true;
            } catch (e) {
                this.documents = [];
            }
        },
        reloadFor(kinds) {
            if (atlasTouches(kinds, ['project', 'publication', 'collection'])) return Promise.all([this.loadProject(), this.loadAllPublications()]);
            if (atlasTouches(kinds, ['project_document'])) return this.loadDocuments();
            return null;
        },
        persist(patch, url) { return api(url, { method: 'PUT', body: JSON.stringify(patch) }); },
        onPersisted(saved, patch) {
            this.setProject(saved);
            if ('refs' in patch) this.loadProject();
        },
        // --- Stand ----------------------------------------------------------
        async setStatus(key) {
            if (!this.project || this.busy || this.project.status === key) return;
            this.busy = true;
            try {
                await this.flushSave();
                const res = await api(this.url('/status'), { method: 'POST', body: JSON.stringify({ status: key }) });
                const label = (PROJECT_STATUSES.find((s) => s.key === key) || {}).label || key;
                const archived = ATLAS_PROJECT_CLOSED.has(key);
                atlasToast(archived ? label + '. Das Projekt liegt jetzt im Archiv der Projekte.' : 'Stand: ' + label + '.', {
                    actionLabel: 'Rückgängig',
                    action: async () => {
                        try {
                            await api(this.url(), { method: 'PUT', body: JSON.stringify(res.previous) });
                            atlasToast('Rückgängig gemacht.');
                        } catch (e) {
                            atlasToast(atlasErrorText(e), { tone: 'danger' });
                        }
                        await this.loadProject();
                    },
                });
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            this.busy = false;
            await this.loadProject();
        },
        reopen() { this.setStatus(atlasReopenStatus(this.project.history, ATLAS_PROJECT_CLOSED, 'active')); },
        // --- Meilensteine: jede Änderung schreibt die ganze Liste -----------
        milestoneList() {
            return (this.project.milestones || []).map((m) => ({ title: m.title || '', date: m.date || null, done: !!m.done }));
        },
        toggleMilestone(index) {
            const list = this.milestoneList();
            if (list[index]) list[index].done = !list[index].done;
            this.saveNow({ milestones: list });
        },
        editMilestone(index, change) {
            const list = this.milestoneList();
            if (!list[index]) return;
            if ('title' in change) {
                const title = String(change.title || '').trim();
                if (!title) { atlasToast('Ein Meilenstein braucht einen Titel – entfernen geht mit ×.'); this.loadProject(); return; }
                change = { title };
            }
            Object.assign(list[index], change);
            this.saveNow({ milestones: list });
        },
        async removeMilestone(index) {
            const before = this.milestoneList();
            const gone = before[index];
            if (!gone) return;
            await this.saveNow({ milestones: before.filter((_, i) => i !== index) });
            atlasToast('Meilenstein „' + gone.title + '“ entfernt.', {
                actionLabel: 'Rückgängig',
                action: () => this.saveNow({ milestones: before }),
            });
        },
        addMilestone() {
            const title = this.msDraft.title.trim();
            if (!title) return;
            const list = this.milestoneList();
            list.push({ title, date: this.msDraft.date || null, done: false });
            this.msDraft = { title: '', date: '' };
            this.saveNow({ milestones: list });
        },
        // --- Arbeitspakete ----------------------------------------------------
        async toggleTask(index) {
            try {
                await this.flushSave();
                this.setProject(await api(this.url('/toggle'), { method: 'POST', body: JSON.stringify({ index }) }));
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
        },
        async addTask(section) {
            const text = String(this.apDrafts[section.key] || '').trim();
            if (!text) return;
            await this.flushSave();
            this.apDrafts = { ...this.apDrafts, [section.key]: '' };
            const body = atlasInsertTask(this.project.body, section.title, text);
            this.draft.body = body;
            this.saveNow({ body });
        },
        async addWorkpackage() {
            const name = this.apNew.trim();
            if (!name) return;
            await this.flushSave();
            this.apNew = '';
            const current = String(this.project.body || '').replace(/\s+$/, '');
            const body = (current ? current + '\n\n' : '') + '## ' + name + '\n';
            this.draft.body = body;
            this.saveNow({ body });
        },
        // --- Veröffentlichungen: der Link liegt auf der Veröffentlichung ---
        async linkPublication(event) {
            const pubId = event.target.value;
            event.target.value = '';
            if (!pubId) return;
            const pub = this.allPublications.find((p) => p.id === pubId) || { id: pubId, title: pubId };
            try {
                await api(this.url('/publications'), { method: 'POST', body: JSON.stringify({ publication_id: pubId }) });
                atlasToast('„' + pub.title + '“ gehört jetzt zu diesem Projekt.', {
                    actionLabel: 'Rückgängig',
                    action: async () => {
                        try { await api(this.url('/publications/' + encodeURIComponent(pubId)), { method: 'DELETE' }); } catch (e) { atlasToast(atlasErrorText(e), { tone: 'danger' }); }
                        await this.loadProject();
                    },
                });
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            await Promise.all([this.loadProject(), this.loadAllPublications()]);
        },
        async unlinkPublication(pub) {
            try {
                await api(this.url('/publications/' + encodeURIComponent(pub.id)), { method: 'DELETE' });
                atlasToast('Verknüpfung mit „' + pub.title + '“ gelöst.', {
                    actionLabel: 'Rückgängig',
                    action: async () => {
                        try { await api(this.url('/publications'), { method: 'POST', body: JSON.stringify({ publication_id: pub.id }) }); } catch (e) { atlasToast(atlasErrorText(e), { tone: 'danger' }); }
                        await this.loadProject();
                    },
                });
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            await this.loadProject();
        },
        // --- Dokumente (projekte/<id>/, Issue #49) --------------------------
        async uploadDocuments(event) {
            const files = Array.from(event.target.files || []);
            event.target.value = '';
            if (!files.length || this.uploading) return;
            this.uploading = true;
            this.docsError = '';
            for (const file of files) {
                try {
                    const fd = new FormData();
                    fd.append('file', file);
                    const resp = await fetch(this.url('/documents'), { method: 'POST', body: fd });
                    if (!resp.ok) throw await atlasResponseError(resp, 'Upload fehlgeschlagen');
                } catch (e) {
                    this.docsError = file.name + ': ' + atlasErrorText(e);
                }
            }
            this.uploading = false;
            await this.loadDocuments();
        },
        async openDocument(name) {
            try {
                await api(this.url('/documents/' + encodeURIComponent(name) + '/open'), { method: 'POST' });
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
        },
        async deleteDocument(name) {
            if (!confirm('Dokument „' + name + '“ wirklich löschen? Die Datei wird aus dem Projektordner entfernt.')) return;
            this.docsError = '';
            try {
                await api(this.url('/documents/' + encodeURIComponent(name)), { method: 'DELETE' });
            } catch (e) {
                this.docsError = atlasErrorText(e);
            }
            await this.loadDocuments();
        },
        async openExtract(name) {
            if (this.extracting) return;
            this.docsError = '';
            try { this.extractAffiliation = localStorage.getItem('atlas.extractAffiliation') || ''; } catch (e) { this.extractAffiliation = ''; }
            this.extractDoc = name;
            try {
                // Die Liste der Verbindung, an der die Reasoning-Rolle hängt.
                const d = await api('/api/llm/models', { method: 'POST', body: JSON.stringify({ tier: 'reasoning' }) });
                this.extractModels = d.models || [];
                this.extractModel = d.current || '';
            } catch (e) {
                this.extractModels = [];
                this.extractModel = '';
            }
        },
        async runExtract() {
            const name = this.extractDoc;
            if (!name || this.extracting) return;
            const affiliation = (this.extractAffiliation || '').trim();
            try { localStorage.setItem('atlas.extractAffiliation', affiliation); } catch (e) { /* ignore */ }
            this.extracting = name;
            this.docsError = '';
            try {
                const proposal = await api(this.url('/documents/' + encodeURIComponent(name) + '/extract'), {
                    method: 'POST', body: JSON.stringify({ model: this.extractModel || null, affiliation: affiliation || null }),
                });
                this.extractDoc = '';
                this.proposal = proposal;
                this.proposalDoc = name;
            } catch (e) {
                this.docsError = atlasErrorText(e);  // der Dialog bleibt offen, der Fehler steht darin
            } finally {
                this.extracting = '';
            }
        },
        // Übernahme füllt nur leere Felder, hängt Meilensteine und Arbeitspakete
        // an — und ist mit einem Rückgängig wieder weg.
        async applyProposal() {
            const p = this.proposal;
            if (!p) return;
            const project = this.project;
            const patch = {};
            const before = {};
            for (const field of ['start', 'end', 'funder', 'grant_id', 'role']) {
                const next = p[field] != null ? String(p[field]).trim() : '';
                if (!String(project[field] || '').trim() && next) { patch[field] = next; before[field] = project[field] || null; }
            }
            const extra = (p.milestones || []).map((m) => ({ title: String((m && m.title) || '').trim(), date: m && m.date ? String(m.date).trim() : null, done: false }))
                .filter((m) => m.title);
            if (extra.length) { before.milestones = this.milestoneList(); patch.milestones = [...before.milestones, ...extra]; }
            const wp = String(p.workpackage_markdown || '').trim();
            if (wp) { before.body = project.body || ''; patch.body = mergeProjectBodyExtraction(project.body, wp); }
            this.proposal = null;
            if (!Object.keys(patch).length) { atlasToast('Nichts zu übernehmen – die Felder sind schon gefüllt.'); return; }
            if ('body' in patch) this.draft.body = patch.body;
            await this.saveNow(patch);
            const warnings = (p.warnings || []).filter(Boolean);
            atlasToast(warnings.length ? 'Übernommen. ' + warnings.join(' ') : 'Eckdaten übernommen.', {
                actionLabel: 'Rückgängig',
                action: async () => {
                    if ('body' in before) this.draft.body = before.body;
                    await this.saveNow(before);
                },
            });
        },
        // --- Sammlung: Typwechsel mit Vorschau ------------------------------
        async switchKind() {
            const cid = this.project.collection.id;
            const base = '/api/plugins/atlas/collections/' + encodeURIComponent(cid) + '/switch';
            try {
                const plan = await api(base + '?to=publication');
                const lines = ['„' + this.project.title + '“ zur Veröffentlichung verschieben?', ''];
                if (plan.has_file) {
                    lines.push('Übernommen: ' + (plan.moved || []).join(', ') + '.');
                    if ((plan.carried || []).length) {
                        lines.push('', 'Ohne Gegenstück — wandert als Abschnitt „' + plan.section + ' (Datum)“ in die Notizen:');
                        plan.carried.forEach((c) => lines.push('• ' + c.label + ': ' + c.value));
                    }
                }
                lines.push('', 'Die Literatur bleibt in der Sammlung.');
                if (!confirm(lines.join('\n'))) return;
                const res = await api(base, { method: 'POST', body: JSON.stringify({ to: 'publication' }) });
                this.$router.push(atlasPublicationRoute(res.id));
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
        },
        async doDelete() {
            if (this.deleting) return;
            this.deleting = true;
            const title = this.project.title;
            try {
                await api(this.url(), { method: 'DELETE' });
                this.pendingPatch = {};
                this.deleteOpen = false;
                atlasToast('„' + title + '“ gelöscht.');
                this.$router.push(ATLAS_LIST_ROUTE.project);
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            this.deleting = false;
        },
        newTask() {
            atlasOpenNew('task', { links: [{ id: this.id, kind: 'project', title: this.project.title }] });
        },
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

// ── Ideen-Seite (/atlas/ideen/:id) ──────────────────────────────────────────
// Eine Idee hat keinen eigenen Löschweg (die Datei bleibt, P1): was nicht
// weitergeht, wird geparkt und liegt im Archiv der Ideen. „Zu Veröffentlichung
// ausarbeiten" (Issue #46) legt die Veröffentlichung an; die Idee bleibt als
// „Ausgearbeitet" stehen.

const ATLAS_IDEA_PIPELINE = ['seed', 'developing', 'promoted'];
const ATLAS_IDEA_CLOSED = new Set(['promoted', 'parked']);
const ATLAS_IDEA_FIELDS = ['title', 'type', 'tags', 'refs', 'body'];

const AtlasIdeaPage = {
    mixins: [AtlasAutosave],
    components: { 'atlas-markdown': AtlasMarkdown,
        'atlas-nav': AtlasNav,
        'atlas-icon': AtlasIcon,
        'atlas-chips': AtlasChips,
        'atlas-save-state': AtlasSaveState,
        'atlas-entity-menu': AtlasEntityMenu,
        'atlas-backlinks': AtlasBacklinks,
        'atlas-anchor-tasks': AtlasAnchorTasks,
    },
    template: `
        <div class="atlas-page atlas-shell" lang="de">
            <atlas-nav active="ideen" />
            <div v-if="loading" class="atlas-skel" style="height:120px" aria-hidden="true"></div>
            <section v-else-if="missing" class="atlas-panel is-padded atlas-missing" role="status">
                <router-link :to="backRoute" class="atlas-back"><atlas-icon name="back" :size="16" /> Ideen</router-link>
                <h1 class="atlas-title is-small">Diese Idee gibt es nicht (mehr)</h1>
                <p class="atlas-muted">Vielleicht wurde die Datei umbenannt oder gelöscht.</p>
            </section>

            <template v-else-if="idea">
                <header class="atlas-detail-header">
                    <router-link :to="backRoute" class="atlas-back"><atlas-icon name="back" :size="16" /> Ideen</router-link>
                    <div class="atlas-detail-titlerow">
                        <div class="atlas-detail-titles">
                            <h1 class="atlas-title is-detail atlas-title-field">
                                <label for="atlas-idea-title" class="atlas-sr">Titel</label>
                                <input id="atlas-idea-title" class="atlas-title-input" v-model="draft.title" autocomplete="off"
                                       @focus="focusField('title')" @blur="blurField('title', idea, { required: true })" @keydown.enter.prevent="$event.target.blur()" />
                            </h1>
                            <div class="atlas-detail-meta">
                                <span>{{ typeLabel }}</span>
                                <template v-if="idea.created"><span aria-hidden="true" class="atlas-dot">·</span><span>notiert {{ longDate(idea.created) }}</span></template>
                                <template v-if="(idea.refs || []).length"><span aria-hidden="true" class="atlas-dot">·</span><span>{{ idea.refs.length }} {{ idea.refs.length === 1 ? 'Referenz' : 'Referenzen' }}</span></template>
                            </div>
                        </div>
                        <div class="atlas-header-actions">
                            <atlas-save-state :state="saveState" :error="saveError" :file="fileLabel" @retry="flushSave" />
                            <atlas-entity-menu kind="idea" :entity-id="idea.id" :file="fileLabel" :can-delete="false" />
                            <router-link v-if="promotedTo" :to="publicationRoute(promotedTo.id)" class="atlas-btn is-tall">
                                <atlas-icon name="pen" /> Zur Veröffentlichung
                            </router-link>
                            <button v-else type="button" class="atlas-btn is-primary is-tall" :disabled="promoting" @click="promote">
                                <atlas-icon name="pen" /> {{ promoting ? 'Legt an …' : 'Zu Veröffentlichung ausarbeiten' }}
                            </button>
                        </div>
                    </div>
                    <div class="atlas-steprow">
                        <ol class="atlas-steps" :class="{ 'is-muted': idea.status === 'parked' }" aria-label="Stand der Idee">
                            <li v-for="(st, i) in steps" :key="st.key" class="atlas-step-li">
                                <atlas-icon v-if="i" name="chevronRight" :size="14" class="atlas-step-sep" />
                                <button type="button" class="atlas-step" :class="{ 'is-current': st.current, 'is-past': st.past }"
                                        :aria-pressed="st.current ? 'true' : 'false'" @click="setStatus(st.key)">
                                    <atlas-icon v-if="st.past" name="check" :size="14" />{{ st.name }}
                                </button>
                            </li>
                        </ol>
                        <span class="atlas-steprow-sep" aria-hidden="true"></span>
                        <button type="button" class="atlas-step is-ghost" :aria-pressed="idea.status === 'parked' ? 'true' : 'false'"
                                :disabled="idea.status === 'parked'" @click="setStatus('parked')">Parken</button>
                    </div>
                </header>

                <section v-if="archived" class="atlas-archive" aria-label="Im Archiv">
                    <span class="atlas-archive-icon"><atlas-icon name="archive" :size="20" /></span>
                    <div class="atlas-archive-text">
                        <div class="atlas-archive-title">{{ idea.status === 'promoted' ? 'Ausgearbeitet' : 'Geparkt' }}<template v-if="promotedTo"> · daraus ist „{{ promotedTo.title }}“ entstanden</template></div>
                        <div class="atlas-archive-sub">Liegt im Archiv der Ideen. Text, Referenzen und Verknüpfungen bleiben hier.</div>
                    </div>
                    <button type="button" class="atlas-btn" @click="setStatus('developing')">Wieder aufnehmen</button>
                </section>

                <div class="atlas-columns">
                    <div class="atlas-col-main">
                        <section class="atlas-panel is-padded atlas-stack" aria-labelledby="atlas-h-itext">
                            <div class="atlas-panel-head is-flush">
                                <h2 id="atlas-h-itext" class="atlas-panel-title">Text</h2>
                                <span class="atlas-panel-note is-inline">Markdown · Überschriften werden Anker für das Literatur-Matching · speichert nach einer Tipp-Pause</span>
                            </div>
                            <span class="atlas-sr">Text</span>
                            <atlas-markdown id="atlas-idea-body" ref="bodyMd" v-model="draft.body" class="is-notes" placeholder="Worum geht es, was wäre der Beitrag, was fehlt noch?"
                                            @focus="focusField('body')" @update:model-value="queueSave({ body: $event })" @blur="blurText('body')" />
                        </section>

                        <!-- F1: Paarbewertung — ein Vorschlag; geschrieben wird erst bei „Übernehmen" (P4) -->
                        <section class="atlas-panel is-padded atlas-stack" aria-labelledby="atlas-h-match">
                            <div class="atlas-panel-head is-flush">
                                <h2 id="atlas-h-match" class="atlas-panel-title">Passt ein Paper?</h2>
                                <span class="atlas-panel-note is-inline">das LLM bewertet ein Paper der Bibliothek gegen diese Idee</span>
                            </div>
                            <div class="atlas-new-field">
                                <label for="atlas-match-q" class="atlas-new-legend">Paper aus der Bibliothek</label>
                                <input id="atlas-match-q" class="atlas-input" v-model="matchFilter" placeholder="Titel suchen …" autocomplete="off" @focus="loadPapers" />
                                <div v-if="matchFilter.trim()" class="atlas-sug is-inline" role="listbox" aria-label="Paper der Bibliothek">
                                    <button v-for="p in matchPapers" :key="p.id" type="button" role="option" class="atlas-sug-item" @click="runMatch(p)">
                                        <span class="atlas-sug-title">{{ p.title }}</span><span class="atlas-sug-id">{{ p.year || '' }}</span>
                                    </button>
                                    <div v-if="papersLoading" class="atlas-sug-empty">Lädt die Bibliothek …</div>
                                    <div v-else-if="!matchPapers.length" class="atlas-sug-empty">Kein Treffer.</div>
                                </div>
                            </div>
                            <p v-if="matching" class="atlas-muted" role="status" style="margin:0">Prüft mit dem LLM …</p>
                            <p v-if="matchError" class="atlas-error" role="alert">{{ matchError }}</p>
                            <div v-if="matchResult" class="atlas-match">
                                <div class="atlas-row-gap">
                                    <span class="atlas-badge is-small" :class="matchResult.verdict === 'relevant' ? 'is-ok' : (matchResult.verdict === 'irrelevant' ? '' : 'is-accent')">{{ verdictLabel(matchResult.verdict) }}</span>
                                    <span class="atlas-mono is-small">{{ matchResult.citekey }}</span>
                                </div>
                                <p style="margin:0">{{ matchResult.reasoning }}</p>
                                <ul v-if="(matchResult.usages || []).length" class="atlas-lit-short">
                                    <li v-for="(u, i) in matchResult.usages" :key="i">
                                        <span v-if="u.anchor" class="atlas-mono is-small" :title="u.anchor_valid ? '' : 'Anker existiert nicht (mehr) in der Idee'">#{{ u.anchor }}<template v-if="!u.anchor_valid"> (fehlt)</template></span>
                                        <span>{{ u.suggestion }}</span>
                                    </li>
                                </ul>
                                <div class="atlas-row-gap is-end">
                                    <button type="button" class="atlas-btn is-small" @click="matchResult = null">{{ matchResult.verdict === 'irrelevant' ? 'Schließen' : 'Verwerfen' }}</button>
                                    <button v-if="matchResult.verdict !== 'irrelevant'" type="button" class="atlas-btn is-small is-primary" :disabled="accepting" @click="acceptMatch">
                                        {{ accepting ? 'Übernimmt …' : 'Übernehmen' }}
                                    </button>
                                </div>
                            </div>
                        </section>
                    </div>

                    <aside class="atlas-col-side">
                        <section class="atlas-panel is-padded atlas-stack" aria-labelledby="atlas-h-iang">
                            <div class="atlas-panel-head is-flush">
                                <h2 id="atlas-h-iang" class="atlas-panel-title is-side">Angaben</h2>
                                <span class="atlas-panel-note is-inline">speichert beim Verlassen eines Feldes</span>
                            </div>
                            <div class="atlas-fields">
                                <label for="atlas-if-type" class="atlas-fields-label">Art</label>
                                <select id="atlas-if-type" class="atlas-input is-field" v-model="draft.type" @change="saveNow({ type: draft.type })">
                                    <option v-for="t in types" :key="t.key" :value="t.key">{{ t.label }}</option>
                                </select>
                                <span class="atlas-fields-label is-top">Schlagworte</span>
                                <atlas-chips :model-value="draft.tags" label="Schlagwort hinzufügen" placeholder="Wort, Enter"
                                             @update:model-value="(v) => { draft.tags = v; saveNow({ tags: v }); }" />
                                <span class="atlas-fields-label is-top">Referenzen</span>
                                <atlas-chips mono :model-value="draft.refs" label="Cite Key hinzufügen" placeholder="Cite Key, Enter"
                                             @update:model-value="(v) => { draft.refs = v; saveNow({ refs: v }); }" />
                            </div>
                        </section>

                        <section class="atlas-panel is-padded" aria-labelledby="atlas-h-iverk">
                            <h2 id="atlas-h-iverk" class="atlas-panel-title is-side">Gehört zu</h2>
                            <ul class="atlas-belongs">
                                <li v-for="c in dissChapters" :key="c.id">
                                    <span class="atlas-muted">Kapitel</span>
                                    <span class="atlas-belongs-end">
                                        <router-link v-if="c.found" :to="chapterRoute(c.id)" class="atlas-belongs-link">{{ c.title }}</router-link>
                                        <span v-else class="atlas-belongs-link" title="Kapitel nicht vorhanden">{{ c.id }}</span>
                                        <button type="button" class="atlas-chip-x is-row" :aria-label="'Verknüpfung mit „' + c.title + '“ lösen'" @click="setDiss(idea.diss.filter((d) => d !== c.id), c.title, true)">×</button>
                                    </span>
                                </li>
                                <li v-for="p in derivedPublications" :key="p.id">
                                    <span class="atlas-muted">Daraus entstanden</span>
                                    <router-link :to="publicationRoute(p.id)" class="atlas-belongs-link">{{ p.title }}</router-link>
                                </li>
                                <li v-if="!dissChapters.length && !derivedPublications.length"><span class="atlas-muted">Noch keinem Kapitel zugeordnet.</span></li>
                            </ul>
                            <label for="atlas-if-link" class="atlas-sr">Kapitel verknüpfen</label>
                            <select v-if="linkableChapters.length" id="atlas-if-link" class="atlas-input is-field is-link" @change="addChapter($event)">
                                <option value="">+ Kapitel verknüpfen …</option>
                                <option v-for="c in linkableChapters" :key="c.id" :value="c.id">{{ c.title }}</option>
                            </select>
                        </section>

                        <atlas-anchor-tasks :key="'it-' + idea.id" :anchor="idea.id" label="Offene Aufgaben zur Idee" />
                        <atlas-backlinks :key="'ib-' + idea.id" :id="idea.id" />
                    </aside>
                </div>
            </template>
        </div>
    `,
    data() {
        return {
            idea: null,
            loading: true,
            missing: false,
            draft: { title: '', type: 'paper-idea', tags: [], refs: [], body: '' },
            chapters: [],
            publications: [],
            promoting: false,
            papers: [],
            papersLoaded: false,
            papersLoading: false,
            matchFilter: '',
            matching: false,
            matchResult: null,
            matchError: '',
            accepting: false,
        };
    },
    computed: {
        id() { return String(this.$route.params.id || ''); },
        backRoute() { return ATLAS_LIST_ROUTE.idea; },
        fileLabel() { return this.idea ? atlasFileLabel('ideen', this.idea) : ''; },
        types() { return ATLAS_TYPES; },
        typeLabel() { return (ATLAS_TYPES.find((t) => t.key === this.idea.type) || {}).label || this.idea.type || 'Idee'; },
        archived() { return !!this.idea && ATLAS_IDEA_CLOSED.has(this.idea.status); },
        steps() {
            const idx = ATLAS_IDEA_PIPELINE.indexOf(this.idea.status);
            return ATLAS_IDEA_PIPELINE.map((key, i) => ({
                key, name: (ATLAS_STATUSES.find((s) => s.key === key) || {}).label || key,
                current: i === idx, past: idx >= 0 && i < idx,
            }));
        },
        derivedPublications() {
            return this.publications.filter((p) => (p.derived_from || []).includes(this.id));
        },
        promotedTo() { return this.derivedPublications[0] || null; },
        dissChapters() {
            return ((this.idea && this.idea.diss) || []).map((id) => {
                const c = this.chapters.find((x) => x.id === id);
                return c ? { id, found: true, title: c.title || id } : { id, found: false, title: id };
            });
        },
        linkableChapters() {
            const linked = new Set((this.idea && this.idea.diss) || []);
            return this.chapters.filter((c) => !linked.has(c.id));
        },
        matchPapers() {
            const q = this.matchFilter.trim().toLowerCase();
            return this.papers.filter((p) => p.cite_key && (!q || (p.title || '').toLowerCase().includes(q))).slice(0, 12);
        },
    },
    watch: {
        async id() { await this.switchEntity(); this.load(); },
    },
    methods: {
        url(suffix = '') { return '/api/plugins/atlas/ideas/' + encodeURIComponent(this.id) + suffix; },
        longDate(iso) { return atlasLongDate(String(iso || '').slice(0, 10)); },
        publicationRoute(id) { return atlasPublicationRoute(id); },
        chapterRoute(id) { return atlasDetailRoute('diss_node', id); },
        verdictLabel(v) { return atlasVerdictLabel(v); },
        async load(silent = false) {
            if (!this.id) return;
            if (!silent) this.loading = true;
            try {
                this.setIdea(await api(this.url()));
                this.missing = false;
            } catch (e) {
                this.idea = null;
                this.missing = true;
                this.loading = false;
                return;
            }
            this.loading = false;
            await this.loadSide();
        },
        setIdea(data) {
            this.idea = data;
            this.syncDraft(data, ATLAS_IDEA_FIELDS);
        },
        async loadIdea() {
            try { this.setIdea(await api(this.url())); } catch (e) { /* bleibt */ }
        },
        async loadSide() {
            const [diss, pubs] = await Promise.all([
                api('/api/plugins/atlas/diss').catch(() => null),
                api('/api/plugins/atlas/publications').catch(() => null),
            ]);
            this.chapters = (diss && diss.chapters) || [];
            this.publications = (pubs && pubs.publications) || [];
        },
        reloadFor(kinds) {
            const parts = [];
            if (atlasTouches(kinds, ['idea'])) parts.push(this.loadIdea());
            if (atlasTouches(kinds, ['diss_node', 'publication'])) parts.push(this.loadSide());
            return Promise.all(parts);
        },
        persist(patch, url) { return api(url, { method: 'PUT', body: JSON.stringify(patch) }); },
        onPersisted(saved) { this.setIdea(saved); },
        async setStatus(key) {
            if (!this.idea || this.idea.status === key) return;
            const before = this.idea.status;
            await this.saveNow({ status: key });
            const label = (ATLAS_STATUSES.find((s) => s.key === key) || {}).label || key;
            atlasToast(ATLAS_IDEA_CLOSED.has(key) ? label + '. Die Idee liegt jetzt im Archiv der Ideen.' : 'Stand: ' + label + '.', {
                actionLabel: 'Rückgängig',
                action: () => this.saveNow({ status: before }),
            });
        },
        async setDiss(ids, title, removing) {
            const before = [...((this.idea && this.idea.diss) || [])];
            await this.saveNow({ diss: ids });
            atlasToast(removing ? 'Verknüpfung mit „' + title + '“ gelöst.' : 'Verknüpft mit „' + title + '“.', {
                actionLabel: 'Rückgängig',
                action: () => this.saveNow({ diss: before }),
            });
        },
        addChapter(event) {
            const id = event.target.value;
            event.target.value = '';
            if (!id) return;
            const c = this.chapters.find((x) => x.id === id) || { title: id };
            this.setDiss([...((this.idea && this.idea.diss) || []), id], c.title || id, false);
        },
        // Promote (Issue #46): legt eine Veröffentlichung an (refs, tags, Text
        // als Startpunkt, derived_from = diese Idee); die Idee bleibt (P1).
        async promote() {
            if (this.promoting) return;
            if (!confirm('Aus „' + this.idea.title + '“ eine Veröffentlichung ausarbeiten? Die Idee bleibt erhalten (Stand „Ausgearbeitet“).')) return;
            this.promoting = true;
            try {
                await this.flushSave();
                const res = await api(this.url('/promote'), { method: 'POST' });
                this.$router.push(atlasPublicationRoute(res.publication.id));
            } catch (e) {
                atlasToast('Ausarbeiten ging nicht: ' + atlasErrorText(e), { tone: 'danger' });
            } finally {
                this.promoting = false;
            }
        },
        async loadPapers() {
            if (this.papersLoaded || this.papersLoading) return;
            this.papersLoading = true;
            try {
                const data = await api('/api/papers');
                this.papers = Array.isArray(data) ? data : (data.papers || data.items || []);
                this.papersLoaded = true;
            } catch (e) {
                this.papers = [];
            }
            this.papersLoading = false;
        },
        async runMatch(paper) {
            if (this.matching) return;
            this.matchFilter = '';
            this.matching = true;
            this.matchError = '';
            this.matchResult = null;
            try {
                this.matchResult = await api('/api/plugins/atlas/match/pair', {
                    method: 'POST', body: JSON.stringify({ citekey: paper.cite_key, idea_id: this.id }),
                });
            } catch (e) {
                this.matchError = atlasErrorText(e);
            }
            this.matching = false;
        },
        async acceptMatch() {
            const r = this.matchResult;
            if (!r || this.accepting) return;
            this.accepting = true;
            try {
                await this.flushSave();
                await api(this.url('/accept-match'), {
                    method: 'POST',
                    body: JSON.stringify({
                        citekey: r.citekey, reasoning: r.reasoning,
                        usages: (r.usages || []).map((u) => ({ anchor: u.anchor, suggestion: u.suggestion })),
                    }),
                });
                this.matchResult = null;
                await this.loadIdea();   // refs und Text tragen jetzt den übernommenen Block
                atlasToast('„' + r.citekey + '“ steht jetzt in den Referenzen und im Text der Idee.');
            } catch (e) {
                this.matchError = atlasErrorText(e);
            } finally {
                this.accepting = false;
            }
        },
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

// ── Kapitel-Seite (/atlas/kapitel/:id) ──────────────────────────────────────
// Das Kapitel als Drehscheibe (#180, Story 49–52): Kennzahlen, Skizze (der
// LLM-Kontext der Dissertation), die Veröffentlichungen darin, Notizen,
// Literatur und offene Aufgaben. Kapitel kennen kein Archiv — sie bleiben in
// der Gliederung; der Platz darin ist die eine „Angabe".

const ATLAS_CHAPTER_FIELDS = ['title', 'body'];

const AtlasChapterPage = {
    mixins: [AtlasAutosave],
    components: { 'atlas-markdown': AtlasMarkdown,
        'atlas-nav': AtlasNav,
        'atlas-icon': AtlasIcon,
        'atlas-save-state': AtlasSaveState,
        'atlas-entity-menu': AtlasEntityMenu,
        'atlas-delete-dialog': AtlasDeleteDialog,
        'atlas-backlinks': AtlasBacklinks,
        'atlas-anchor-tasks': AtlasAnchorTasks,
    },
    template: `
        <div class="atlas-page atlas-shell" lang="de">
            <atlas-nav active="kapitel" />
            <div v-if="loading" class="atlas-skel" style="height:120px" aria-hidden="true"></div>
            <section v-else-if="missing" class="atlas-panel is-padded atlas-missing" role="status">
                <router-link :to="backRoute" class="atlas-back"><atlas-icon name="back" :size="16" /> Dissertation</router-link>
                <h1 class="atlas-title is-small">Dieses Kapitel gibt es nicht (mehr)</h1>
                <p class="atlas-muted">Vielleicht wurde die Datei umbenannt oder gelöscht.</p>
            </section>

            <template v-else-if="node">
                <header class="atlas-detail-header">
                    <router-link :to="backRoute" class="atlas-back"><atlas-icon name="back" :size="16" /> Dissertation</router-link>
                    <div class="atlas-detail-titlerow">
                        <div class="atlas-detail-titles">
                            <h1 class="atlas-title is-detail atlas-title-field">
                                <label for="atlas-ch-title" class="atlas-sr">Titel</label>
                                <input id="atlas-ch-title" class="atlas-title-input" v-model="draft.title" autocomplete="off"
                                       @focus="focusField('title')" @blur="blurField('title', node, { required: true })" @keydown.enter.prevent="$event.target.blur()" />
                            </h1>
                            <div class="atlas-detail-meta">
                                <span>Kapitel {{ position }} von {{ chapters.length || 1 }}</span>
                                <template v-if="node.modified_at"><span aria-hidden="true" class="atlas-dot">·</span><span>zuletzt geändert {{ relative(node.modified_at) }}</span></template>
                            </div>
                        </div>
                        <div class="atlas-header-actions">
                            <atlas-save-state :state="saveState" :error="saveError" :file="fileLabel" @retry="flushSave" />
                            <atlas-entity-menu kind="diss_node" :entity-id="node.id" :file="fileLabel" delete-label="Kapitel löschen …" @delete="deleteOpen = true" />
                            <button type="button" class="atlas-btn is-primary is-tall" @click="newTask">
                                <atlas-icon name="plus" /> Aufgabe zum Kapitel
                            </button>
                        </div>
                    </div>
                    <ol class="atlas-steps" aria-label="Stand des Kapitels">
                        <li v-for="(st, i) in steps" :key="st.key" class="atlas-step-li">
                            <atlas-icon v-if="i" name="chevronRight" :size="14" class="atlas-step-sep" />
                            <button type="button" class="atlas-step" :class="{ 'is-current': st.current, 'is-past': st.past }"
                                    :aria-pressed="st.current ? 'true' : 'false'" @click="setStatus(st.key)">
                                <atlas-icon v-if="st.past" name="check" :size="14" />{{ st.name }}
                            </button>
                        </li>
                    </ol>
                </header>

                <div class="atlas-metrics">
                    <div class="atlas-metric"><div class="atlas-metric-n">{{ publications.length }}</div><div class="atlas-metric-l">Veröffentlichungen</div></div>
                    <div class="atlas-metric"><div class="atlas-metric-n">{{ node.zettel_count || 0 }}</div><div class="atlas-metric-l">Notizen</div></div>
                    <div class="atlas-metric"><div class="atlas-metric-n" :class="{ 'is-warn': node.open_task_count }">{{ node.open_task_count || 0 }}</div><div class="atlas-metric-l">offene Aufgaben</div></div>
                    <div class="atlas-metric"><div class="atlas-metric-n">{{ node.ref_count || 0 }}</div><div class="atlas-metric-l">Referenzen</div></div>
                </div>

                <div class="atlas-columns">
                    <div class="atlas-col-main">
                        <section class="atlas-panel is-padded atlas-stack" aria-labelledby="atlas-h-skizze">
                            <div class="atlas-panel-head is-flush">
                                <h2 id="atlas-h-skizze" class="atlas-panel-title">Skizze</h2>
                                <span class="atlas-panel-note is-inline">Forschungsfrage, Inhalte, Methoden · der Kontext für den Research Chat · <code>[[id]]</code> verweist</span>
                            </div>
                            <span class="atlas-sr">Skizze</span>
                            <atlas-markdown id="atlas-ch-body" ref="bodyMd" v-model="draft.body" class="is-notes" placeholder="Forschungsfrage, geplante Inhalte und Methoden dieses Kapitels …"
                                            @focus="focusField('body')" @update:model-value="queueSave({ body: $event })" @blur="blurText('body')" />
                        </section>

                        <section class="atlas-panel is-padded" aria-labelledby="atlas-h-chpubs">
                            <h2 id="atlas-h-chpubs" class="atlas-panel-title">Veröffentlichungen im Kapitel</h2>
                            <ul class="atlas-belongs">
                                <li v-for="p in publications" :key="p.id">
                                    <span v-if="p.found" class="atlas-badge is-small">{{ pubStatusLabel(p.status) }}</span>
                                    <span v-else class="atlas-badge is-small is-danger">fehlt</span>
                                    <span class="atlas-belongs-end">
                                        <router-link v-if="p.found" :to="publicationRoute(p.id)" class="atlas-belongs-link">{{ p.title }}</router-link>
                                        <span v-else class="atlas-belongs-link atlas-mono" title="Hängender Verweis: Veröffentlichung nicht vorhanden">{{ p.id }}</span>
                                        <button type="button" class="atlas-chip-x is-row" :aria-label="'Verknüpfung mit „' + (p.title || p.id) + '“ lösen'" @click="unassign(p)">×</button>
                                    </span>
                                </li>
                                <li v-if="!publications.length"><span class="atlas-muted">Noch keine Veröffentlichung in diesem Kapitel.</span></li>
                            </ul>
                            <label for="atlas-ch-link" class="atlas-sr">Veröffentlichung zuordnen</label>
                            <select v-if="assignable.length" id="atlas-ch-link" class="atlas-input is-field is-link" @change="assign($event)">
                                <option value="">+ Veröffentlichung zuordnen …</option>
                                <option v-for="p in assignable" :key="p.id" :value="p.id">{{ p.title }} · {{ pubStatusLabel(p.status) }}</option>
                            </select>
                        </section>

                        <atlas-anchor-tasks :key="'ct-' + node.id" :anchor="node.id" label="Offene Aufgaben an diesem Kapitel" @changed="loadNode" />
                    </div>

                    <aside class="atlas-col-side">
                        <section class="atlas-panel is-padded atlas-stack" aria-labelledby="atlas-h-chpos">
                            <h2 id="atlas-h-chpos" class="atlas-panel-title is-side">Platz in der Gliederung</h2>
                            <ol class="atlas-outline">
                                <li v-for="(c, i) in chapters" :key="c.id" :class="{ 'is-current': c.id === node.id }">
                                    <span class="atlas-outline-n">{{ i + 1 }}</span>
                                    <router-link v-if="c.id !== node.id" :to="chapterRoute(c.id)" class="atlas-outline-title">{{ c.title || c.id }}</router-link>
                                    <span v-else class="atlas-outline-title" aria-current="page">{{ c.title || c.id }}</span>
                                </li>
                            </ol>
                            <div class="atlas-row-gap">
                                <button type="button" class="atlas-btn is-small" :disabled="position <= 1 || moving" @click="move(-1)"><atlas-icon name="chevronUp" :size="16" /> Nach oben</button>
                                <button type="button" class="atlas-btn is-small" :disabled="position >= chapters.length || moving" @click="move(1)"><atlas-icon name="chevronDown" :size="16" /> Nach unten</button>
                            </div>
                        </section>

                        <section class="atlas-sec">
                            <div class="atlas-sec-head">
                                <h3 class="atlas-sec-title">Verlinkte Notizen<template v-if="zettel.length"> · {{ zettel.length }}</template></h3>
                                <router-link to="/atlas/zettel" class="atlas-link-btn" style="text-decoration:none">alle</router-link>
                            </div>
                            <div class="atlas-card">
                                <p v-if="!zettel.length" class="atlas-empty">Keine Notiz verweist auf dieses Kapitel. Ein <code>[[{{ node.id }}]]</code> im Text einer Notiz genügt.</p>
                                <router-link v-for="z in zettel" :key="z.id" class="atlas-list-row" :to="'/atlas/zettel/' + encodeURIComponent(z.id)">
                                    <div class="atlas-list-top"><span class="atlas-list-title">{{ z.title || z.id }}</span></div>
                                </router-link>
                            </div>
                        </section>

                        <section class="atlas-sec">
                            <div class="atlas-sec-head">
                                <h3 class="atlas-sec-title">Literatur<template v-if="literature.length"> · {{ literature.length }}</template></h3>
                                <span class="atlas-sec-note">Veröffentlichungen + Notizen</span>
                            </div>
                            <div class="atlas-card">
                                <p v-if="!literature.length" class="atlas-empty">Noch keine Referenzen – sie kommen aus den zugeordneten Veröffentlichungen und den verlinkten Notizen.</p>
                                <div v-for="r in literatureShown" :key="r.citekey" class="atlas-lit">
                                    <span class="atlas-lit-key">{{ r.citekey }}</span>
                                    <button v-if="r.found" type="button" class="atlas-lit-title" @click="$router.push('/paper/' + r.paper_id)">{{ r.title }}</button>
                                    <span v-else class="atlas-lit-title is-missing" title="Cite Key nicht in der Bibliothek">nicht in der Bibliothek</span>
                                </div>
                                <button v-if="literature.length > literatureShown.length" type="button" class="atlas-link-btn" style="padding:8px 14px" @click="litAll = true">
                                    … {{ literature.length - literatureShown.length }} weitere zeigen
                                </button>
                            </div>
                        </section>

                        <atlas-backlinks :key="'cb-' + node.id" :data="backlinks" :id="node.id" :exclude="['zettel']" @changed="loadNode" />
                    </aside>
                </div>

                <atlas-delete-dialog v-if="deleteOpen" title="Kapitel löschen?" :gone="['Skizze und Angaben in ' + fileLabel]"
                                     :kept="deleteKept" :busy="deleting" @cancel="deleteOpen = false" @confirm="doDelete" />
            </template>
        </div>
    `,
    data() {
        return {
            node: null,
            loading: true,
            missing: false,
            draft: { title: '', body: '' },
            chapters: [],
            allPublications: [],
            backlinks: null,
            papers: [],
            litAll: false,
            moving: false,
            deleteOpen: false,
            deleting: false,
        };
    },
    computed: {
        id() { return String(this.$route.params.id || ''); },
        backRoute() { return ATLAS_LIST_ROUTE.diss_node; },
        fileLabel() { return this.node ? atlasFileLabel('dissertation', this.node) : ''; },
        position() {
            const i = this.chapters.findIndex((c) => c.id === this.id);
            return i < 0 ? 1 : i + 1;
        },
        steps() {
            const idx = DISS_STATUSES.findIndex((s) => s.key === this.node.status);
            return DISS_STATUSES.map((s, i) => ({ key: s.key, name: s.label, current: i === idx, past: idx >= 0 && i < idx }));
        },
        publications() { return (this.node && this.node.publications_resolved) || []; },
        assignable() {
            const linked = new Set((this.node && this.node.publications) || []);
            return this.allPublications.filter((p) => !linked.has(p.id));
        },
        zettel() { return (this.backlinks && this.backlinks.zettel) || []; },
        // Die Literatur des Kapitels: `refs_all` (eigene Veröffentlichungen +
        // verlinkte Notizen) gegen die Bibliothek aufgelöst; hängende Keys
        // bleiben sichtbar — Warnung, nie Reparatur.
        literature() {
            const keys = (this.node && this.node.refs_all) || [];
            const byKey = new Map(this.papers.map((p) => [p.cite_key, p]));
            return keys.map((citekey) => {
                const paper = byKey.get(citekey);
                return paper ? { citekey, found: true, title: paper.title || citekey, paper_id: paper.id } : { citekey, found: false };
            });
        },
        literatureShown() { return this.litAll ? this.literature : this.literature.slice(0, 8); },
        deleteKept() {
            const kept = [];
            if (this.publications.length) kept.push('die Veröffentlichungen darin (sie verlieren nur die Zuordnung)');
            if (this.zettel.length) kept.push('die Notizen, die auf das Kapitel verweisen');
            return kept;
        },
    },
    watch: {
        async id() { await this.switchEntity(); this.load(); },
    },
    methods: {
        url(suffix = '') { return '/api/plugins/atlas/diss/' + encodeURIComponent(this.id) + suffix; },
        pubStatusLabel(s) { return ATLAS_PUBLICATION_STATUS_LABEL[s] || s; },
        publicationRoute(id) { return atlasPublicationRoute(id); },
        chapterRoute(id) { return atlasDetailRoute('diss_node', id); },
        relative(iso) { return atlasRelative(iso); },
        async load(silent = false) {
            if (!this.id) return;
            if (!silent) this.loading = true;
            this.litAll = false;
            try {
                this.setNode(await api(this.url()));
                this.missing = false;
            } catch (e) {
                this.node = null;
                this.missing = true;
                this.loading = false;
                return;
            }
            this.loading = false;
            await Promise.all([this.loadList(), this.loadBacklinks(), this.loadPapers()]);
        },
        setNode(data) {
            this.node = data;
            this.syncDraft(data, ATLAS_CHAPTER_FIELDS);
        },
        async loadNode() {
            try { this.setNode(await api(this.url())); } catch (e) { /* bleibt */ }
            await this.loadBacklinks();
        },
        async loadList() {
            const [diss, pubs] = await Promise.all([
                api('/api/plugins/atlas/diss').catch(() => null),
                api('/api/plugins/atlas/publications').catch(() => null),
            ]);
            this.chapters = (diss && diss.chapters) || [];
            this.allPublications = (pubs && pubs.publications) || [];
        },
        async loadBacklinks() {
            try { this.backlinks = await api('/api/plugins/atlas/backlinks/' + encodeURIComponent(this.id)); } catch (e) { this.backlinks = null; }
        },
        // Die Cite Keys werden gegen die Bibliothek aufgelöst; einmal je Seite.
        async loadPapers() {
            if (this.papers.length) return;
            try {
                const data = await api('/api/papers');
                this.papers = Array.isArray(data) ? data : (data.papers || data.items || []);
            } catch (e) {
                this.papers = [];
            }
        },
        reloadFor(kinds) {
            const parts = [];
            if (atlasTouches(kinds, ['diss_node', 'publication', 'zettel', 'journal'])) parts.push(this.loadNode(), this.loadList());
            return Promise.all(parts);
        },
        // PUT /diss/{id} antwortet ohne Kennzahlen und aufgelöste Links — die
        // holt danach ein GET.
        persist(patch, url) { return api(url, { method: 'PUT', body: JSON.stringify(patch) }); },
        onPersisted(saved, patch) {
            this.node = { ...this.node, ...saved };
            this.syncDraft(this.node, ATLAS_CHAPTER_FIELDS);
            if ('body' in patch || 'status' in patch) this.loadNode();
            if ('title' in patch || 'status' in patch) this.loadList();
        },
        async setStatus(key) {
            if (!this.node || this.node.status === key) return;
            const before = this.node.status;
            await this.saveNow({ status: key });
            const label = (DISS_STATUSES.find((s) => s.key === key) || {}).label || key;
            atlasToast('Stand: ' + label + '.', { actionLabel: 'Rückgängig', action: () => this.saveNow({ status: before }) });
        },
        // Reihenfolge: die order-Werte der Nachbarn tauschen (ADR-0005).
        async move(step) {
            const i = this.position - 1;
            const j = i + step;
            if (j < 0 || j >= this.chapters.length || this.moving) return;
            this.moving = true;
            const other = this.chapters[j];
            try {
                await api(this.url(), { method: 'PUT', body: JSON.stringify({ order: j }) });
                await api('/api/plugins/atlas/diss/' + encodeURIComponent(other.id), { method: 'PUT', body: JSON.stringify({ order: i }) });
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            this.moving = false;
            await this.loadList();
        },
        async assign(event) {
            const pubId = event.target.value;
            event.target.value = '';
            if (!pubId) return;
            const pub = this.allPublications.find((p) => p.id === pubId) || { title: pubId };
            try {
                await api(this.url('/publications'), { method: 'POST', body: JSON.stringify({ publication_id: pubId }) });
                atlasToast('„' + pub.title + '“ gehört jetzt zu diesem Kapitel.', {
                    actionLabel: 'Rückgängig',
                    action: async () => {
                        try { await api(this.url('/publications/' + encodeURIComponent(pubId)), { method: 'DELETE' }); } catch (e) { atlasToast(atlasErrorText(e), { tone: 'danger' }); }
                        await this.loadNode();
                    },
                });
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            await this.loadNode();
        },
        async unassign(p) {
            try {
                await api(this.url('/publications/' + encodeURIComponent(p.id)), { method: 'DELETE' });
                atlasToast('Verknüpfung mit „' + (p.title || p.id) + '“ gelöst.', {
                    actionLabel: 'Rückgängig',
                    action: async () => {
                        try { await api(this.url('/publications'), { method: 'POST', body: JSON.stringify({ publication_id: p.id }) }); } catch (e) { atlasToast(atlasErrorText(e), { tone: 'danger' }); }
                        await this.loadNode();
                    },
                });
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            await this.loadNode();
        },
        async doDelete() {
            if (this.deleting) return;
            this.deleting = true;
            const title = this.node.title;
            try {
                await api(this.url(), { method: 'DELETE' });
                this.pendingPatch = {};
                this.deleteOpen = false;
                atlasToast('„' + title + '“ gelöscht.');
                this.$router.push(ATLAS_LIST_ROUTE.diss_node);
            } catch (e) {
                atlasToast(atlasErrorText(e), { tone: 'danger' });
            }
            this.deleting = false;
        },
        newTask() {
            atlasOpenNew('task', { links: [{ id: this.id, kind: 'diss_node', title: this.node.title }] });
        },
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
            <atlas-nav active="publikationsliste" />

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
        // Sammlung neu (2026-10-22): jede Art hat eine eigene Seite.
        'atlas.project': AtlasProjectPage,
        'atlas.idea': AtlasIdeaPage,
        'atlas.chapter': AtlasChapterPage,
    },
    subroutes: [
        { path: '/atlas/woche/:week?', view: 'atlas.week' },
        { path: '/atlas/rueckblick/:week?', view: 'atlas.review' },
        { path: '/atlas/sammlung', view: 'atlas.collection' },
        { path: '/atlas/zettel/:id?', view: 'atlas.zettel' },
        { path: '/atlas/veroeffentlichungen', view: 'atlas.publications' },
        { path: '/atlas/veroeffentlichungen/:id', view: 'atlas.publication' },
        { path: '/atlas/publikationsliste', view: 'atlas.publication-list' },
        { path: '/atlas/projekte/:id', view: 'atlas.project' },
        { path: '/atlas/ideen/:id', view: 'atlas.idea' },
        { path: '/atlas/kapitel/:id', view: 'atlas.chapter' },
    ],
    slots: {
        'item-list-filter': { key: 'atlas.project-filter', component: AtlasItemListFilter },
        'item-detail-aside': { key: 'atlas.links', component: AtlasItemDetailAside },
        'research-chat-context': { key: 'atlas.diss-context', component: AtlasResearchChatContext },
        'settings': { key: 'atlas.settings', component: AtlasSettings },
    },
});
})();
