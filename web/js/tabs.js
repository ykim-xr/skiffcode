// Tab types shown in a worktree's panes: file editor, single-file diff,
// review (all changes vs base, or one commit) and terminal (Claude / shell).
import { h, icon, basename, dirname, STATUS_LETTER, STATUS_LABEL, TERM_SIZE, clear } from './util.js';
import { call, on, onTerminal, sendInput } from './rpc.js';
import * as models from './models.js';
import { store, session } from './store.js';
import { stateLabel, sessionIcon } from './sidebar.js';
import { termBackground } from './colors.js';
import { isInternal, isExternal, takeExternal, dropOnTerminal, hasType } from './dnd.js';
import { toast, confirmDialog } from './dialogs.js';
import { FileViewTab, WebTab, openLink, LINK_HINT } from './viewers.js';
import { pathLinks, linkMenuItems } from './termlinks.js';
import { contextMenu } from './dialogs.js';

export const editorOptions = () => ({
  theme: 'skiffcode-dark',
  fontSize: store.settings.fontSize || 13,
  fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, 'DejaVu Sans Mono', monospace",
  automaticLayout: true,
  minimap: { enabled: true, scale: 1, renderCharacters: false },
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  renderWhitespace: 'selection',
  bracketPairColorization: { enabled: true },
  guides: { bracketPairs: 'active', indentation: true },
  stickyScroll: { enabled: true },
  fixedOverflowWidgets: true,
  dropIntoEditor: { enabled: false }, // a file dragged from the Files panel opens, it doesn't insert its path
});

let seq = 0;
let keySeq = 0;

/** Ctrl+S for this editor only: Monaco's keybindings are shared, so without a context the last editor's command wins. */
function bindSave(editor, fn) {
  const ctx = `skiffEd${++keySeq}`;
  editor.createContextKey(ctx, true);
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, fn, ctx);
}

/** Save / Don't save / Cancel for a file with unsaved edits. True when it's fine to go on. */
async function askSave(entry) {
  const v = await confirmDialog({
    title: `Save changes to ${basename(entry.path)}?`,
    detail: 'Your changes will be lost if you don’t save them.',
    buttons: [{ label: 'Don’t save', value: 'discard', danger: true }, { label: 'Save', value: 'save', primary: true }],
  });
  if (v === 'save') return models.save(entry);
  return v === 'discard';
}

class Tab {
  constructor(ws, kind) {
    this.ws = ws;
    this.kind = kind;
    this.uid = `t${++seq}`;
    this.el = h('div.tab-body');
    this.pinned = true;
  }
  title() { return ''; }
  tooltip() { return this.title(); }
  iconEl() { return icon('file'); }
  dirty() { return false; }
  show() {}
  hide() {}
  layout() {}
  focus() {}
  async canClose() { return true; }
  dispose() { this.el.remove(); }
  serialize() { return null; }
  changed() { this.ws.tabChanged(this); }
}

// ------------------------------------------------------------------ editor

export class EditorTab extends Tab {
  constructor(ws, path, { preview = false } = {}) {
    super(ws, 'file');
    this.path = path;
    this.pinned = !preview;
    this.ready = this.init();
  }
  async init() {
    this.entry = await models.acquire(this.ws.root, this.path);
    if (this.disposed) return models.release(this.entry);
    if (this.entry.binary || this.entry.tooLarge) {
      this.el.append(h('div.tab-message', this.entry.binary ? 'This file is binary and can’t be shown.' : 'This file is too large to edit here.'));
      return;
    }
    this.banner = h('div.editor-banner.hidden');
    this.host = h('div.editor-host');
    this.el.append(this.banner, this.host);
    this.editor = monaco.editor.create(this.host, { ...editorOptions(), model: this.entry.model });
    bindSave(this.editor, () => this.save());
    this.unsub = models.onModelState(e => {
      if (e !== this.entry) return;
      if (this.editor.getModel() !== e.model) { // renamed (models.move)
        this.editor.setModel(e.model);
        this.path = e.path;
        this.ws.saveSoon();
      }
      if (this.pinned === false && models.isDirty(e)) this.pinned = true;
      this.updateBanner();
      this.changed();
    });
    this.editor.onDidChangeCursorPosition(() => this.ws.app.updateCursor());
    if (this.pendingReveal) this.reveal(...this.pendingReveal);
    this.updateBanner();
  }
  updateBanner() {
    if (!this.banner) return;
    const e = this.entry;
    if (e.conflict) {
      clear(this.banner, 'This file changed on disk while you were editing.',
        h('button.btn.small', { onclick: () => models.reload(e, true) }, 'Load their version'),
        h('button.btn.small', { onclick: () => models.save(e, { force: true }) }, 'Keep mine and save'));
      this.banner.classList.remove('hidden');
    } else if (e.missing) {
      clear(this.banner, 'This file was deleted on disk.', h('button.btn.small', { onclick: () => models.save(e, { force: true }) }, 'Save it again'));
      this.banner.classList.remove('hidden');
    } else this.banner.classList.add('hidden');
  }
  title() { return basename(this.path); }
  tooltip() { return this.path; }
  iconEl() { return icon('file', 'file-icon'); }
  dirty() { return models.isDirty(this.entry); }
  async save() {
    if (await models.save(this.entry)) this.changed();
  }
  reveal(line, col = 1, len = 0) {
    if (!this.editor) {
      this.pendingReveal = [line, col, len];
      return;
    }
    const range = new monaco.Range(line, col, line, col + len);
    this.editor.setSelection(range);
    this.editor.revealRangeInCenterIfOutsideViewport(range);
    this.editor.focus();
  }
  focus() { this.editor && this.editor.focus(); }
  layout() { this.editor && this.editor.layout(); }
  async canClose() {
    return !this.dirty() || askSave(this.entry);
  }
  dispose() {
    this.disposed = true;
    if (this.unsub) this.unsub();
    if (this.editor) this.editor.dispose();
    if (this.entry) models.release(this.entry); // the last user's release drops unsaved edits with the model
    super.dispose();
  }
  serialize() { return { kind: 'file', path: this.path }; }
}

// ------------------------------------------------------------------ diffs

/**
 * One diff view that can show any file pair. `left`/`right` are
 * { ref } (read-only git version), 'live' (the real, editable file) or null (missing).
 */
class DiffView {
  constructor(ws, host, { sideBySide = true } = {}) {
    this.ws = ws;
    this.host = host;
    this.editor = monaco.editor.createDiffEditor(host, {
      ...editorOptions(),
      renderSideBySide: sideBySide,
      originalEditable: false,
      ignoreTrimWhitespace: false,
      renderOverviewRuler: true,
      hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 5 },
      minimap: { enabled: false },
    });
    bindSave(this.editor.getModifiedEditor(), () => this.save());
    this.entry = null;
    this.gitModels = [];
    this.tmpModels = [];
    this.unsub = models.onModelState(e => {
      if (e !== this.entry) return;
      const cur = this.editor.getModel();
      if (cur && cur.modified !== e.model) this.editor.setModel({ original: cur.original, modified: e.model }); // renamed
      this.path = e.path;
    });
  }
  async show(path, left, right, oldPath) {
    const root = this.ws.root;
    const token = (this.token = Symbol());
    const orig = left ? await models.gitModel(root, left.ref, oldPath || path) : models.emptyModel(path);
    let mod;
    let entry = null;
    if (right === 'live') {
      entry = await models.acquire(root, path);
      mod = entry.model;
    } else if (right) mod = await models.gitModel(root, right.ref, path);
    else mod = models.emptyModel(path);
    const git = [left ? orig : null, right && right !== 'live' ? mod : null].filter(Boolean);
    const tmp = [left ? null : orig, right ? null : mod].filter(Boolean);
    if (token !== this.token || this.disposed) {
      free(entry, git, tmp);
      return;
    }
    this.editor.setModel({ original: orig, modified: mod });
    free(this.entry, this.gitModels, this.tmpModels);
    this.entry = entry;
    this.gitModels = git;
    this.tmpModels = tmp;
    this.editor.getModifiedEditor().updateOptions({ readOnly: right !== 'live' });
    this.path = path;
  }
  /** Leaving this file now would drop unsaved edits (no other tab holds it). */
  losesEdits() {
    return !!this.entry && models.isDirty(this.entry) && this.entry.refs === 1;
  }
  async save() {
    if (this.entry) await models.save(this.entry);
  }
  firstChange() {
    setTimeout(() => {
      if (this.disposed) return;
      const ch = this.editor.getLineChanges();
      if (ch && ch.length) this.editor.revealLineInCenter(ch[0].modifiedStartLineNumber || ch[0].originalStartLineNumber);
    }, 120);
  }
  dirty() { return models.isDirty(this.entry); }
  dispose() {
    this.disposed = true;
    this.unsub();
    this.editor.dispose();
    free(this.entry, this.gitModels, this.tmpModels);
    this.entry = null;
  }
}

function free(entry, git, tmp) {
  if (entry) models.release(entry);
  git.forEach(m => models.releaseGit(m));
  tmp.forEach(m => m.dispose());
}

/** A single file's diff (Source Control click). */
export class DiffTab extends Tab {
  constructor(ws, spec) {
    super(ws, 'diff');
    this.spec = spec; // { path, oldPath, left, right, label }
    this.host = h('div.editor-host');
    this.el.append(this.host);
    this.view = new DiffView(ws, this.host);
    this.ready = this.view.show(spec.path, spec.left, spec.right, spec.oldPath).then(() => this.view.firstChange());
    this.unsub = models.onModelState(e => { if (e === this.view.entry) this.changed(); });
  }
  title() { return `${basename(this.spec.path)} (${this.spec.label || 'diff'})`; }
  tooltip() { return `${this.spec.path} — ${this.spec.label}${this.spec.right === 'live' ? ' · right side is editable' : ''}`; }
  iconEl() { return icon('diff', 'diff-icon'); }
  dirty() { return this.view.dirty(); }
  layout() { this.view.editor.layout(); }
  async canClose() { return !this.view.losesEdits() || askSave(this.view.entry); }
  dispose() { this.unsub(); this.view.dispose(); super.dispose(); }
  serialize() { return { kind: 'diff', spec: this.spec }; }
}

/**
 * Review: every changed file in a list + one diff editor.
 *  mode 'base'   – this worktree vs its base branch (merge base), right side = your real file (editable)
 *  mode 'commit' – one commit vs its parent (read-only), with "Open current file"
 */
export class ReviewTab extends Tab {
  constructor(ws, { mode, sha, subject, short }) {
    super(ws, mode === 'base' ? 'review' : 'commit');
    this.mode = mode;
    this.sha = sha;
    this.subject = subject;
    this.short = short;
    this.list = h('div.review-list');
    this.head = h('div.review-head');
    this.host = h('div.editor-host');
    this.el.classList.add('review');
    this.el.append(h('div.review-side', this.head, this.list), h('div.review-main', this.host));
    this.view = new DiffView(ws, this.host);
    this.files = [];
    this.current = null;
    this.ready = this.load();
    if (mode === 'base') {
      this.off = on('git.changed', ({ root }) => { if (root === ws.root) this.reloadSoon(); });
      this.off2 = on('fs.changed', ({ root }) => { if (root === ws.root) this.reloadSoon(); });
    }
    this.unsub = models.onModelState(e => { if (e === this.view.entry) this.changed(); });
  }
  reloadSoon() {
    clearTimeout(this.t);
    this.t = setTimeout(() => this.load(), 400);
  }
  async load() {
    const root = this.ws.root;
    if (this.mode === 'base') {
      const r = await call('git.changes', { root });
      if (this.disposed) return;
      this.from = r.from;
      this.files = r.files;
      const st = r.status;
      clear(this.head,
        h('div.review-title', st.base ? `Changes vs ${st.base}` : 'Uncommitted changes'),
        h('div.review-sub', `${r.files.length} file${r.files.length === 1 ? '' : 's'} · `, h('span.add', `+${st.insertions}`), ' ', h('span.del', `−${st.deletions}`), st.ahead ? ` · ${st.ahead} commit${st.ahead === 1 ? '' : 's'}` : ''),
        h('div.review-hint', 'Right side is your file — edit it right here.'));
    } else {
      const r = await call('git.commitFiles', { root, sha: this.sha });
      if (this.disposed) return;
      this.parent = r.parent;
      this.files = r.files;
      clear(this.head,
        h('div.review-title', this.subject || this.short),
        h('div.review-sub', `${this.short} · ${r.files.length} file${r.files.length === 1 ? '' : 's'}`),
        h('div.review-hint', 'Read-only. Use ↗ to edit the current version of a file.'));
    }
    this.renderList();
    const still = this.current && this.files.find(f => f.path === this.current);
    // A file with unsaved edits stays shown even when it leaves the list: a background change must not ask or drop them.
    if (still || models.isDirty(this.view.entry)) return;
    if (this.files.length) await this.select(this.files[0]);
    else {
      this.current = null;
      clear(this.list, h('div.muted.pad', this.mode === 'base' ? 'No changes.' : 'No files in this commit.'));
    }
  }
  renderList() {
    clear(this.list, this.files.map(f => h(`div.review-file${f.path === this.current ? '.selected' : ''}`, {
      title: `${f.path}${f.oldPath ? ` (from ${f.oldPath})` : ''} — ${STATUS_LABEL[f.status] || f.status}`,
      onclick: () => this.select(f),
    },
    h(`span.git-letter.g-${STATUS_LETTER(f.status)}`, STATUS_LETTER(f.status)),
    h('span.review-name', basename(f.path)),
    h('span.review-dir', dirname(f.path)),
    this.mode === 'commit' && f.status !== 'D'
      ? h('button.icon-btn', { title: 'Open current file (editable)', onclick: e => { e.stopPropagation(); this.ws.openFile(f.path); } }, icon('link'))
      : null)));
  }
  async select(f) {
    if (f.path !== this.current && this.view.losesEdits() && !(await askSave(this.view.entry))) return;
    if (this.disposed) return;
    this.current = f.path;
    this.renderList();
    if (this.mode === 'base') {
      const left = f.status === 'A' || f.status === '?' ? null : { ref: this.from };
      const right = f.status === 'D' ? null : 'live';
      await this.view.show(f.path, left, right, f.oldPath);
    } else {
      const left = !this.parent || f.status === 'A' ? null : { ref: this.parent };
      const right = f.status === 'D' ? null : { ref: this.sha };
      await this.view.show(f.path, left, right, f.oldPath);
    }
    if (!this.disposed) this.view.firstChange();
  }
  title() { return this.mode === 'base' ? 'Review changes' : `${this.short} ${this.subject || ''}`.trim(); }
  iconEl() { return icon(this.mode === 'base' ? 'diff' : 'commit', 'diff-icon'); }
  dirty() { return this.view.dirty(); }
  layout() { this.view.editor.layout(); }
  async canClose() { return !this.view.losesEdits() || askSave(this.view.entry); }
  dispose() {
    this.disposed = true;
    clearTimeout(this.t);
    if (this.off) this.off();
    if (this.off2) this.off2();
    this.unsub();
    this.view.dispose();
    super.dispose();
  }
  serialize() { return this.mode === 'base' ? { kind: 'review' } : { kind: 'commit', sha: this.sha, subject: this.subject, short: this.short }; }
}

// ------------------------------------------------------------------ terminal

const TERM_THEME = {
  background: '#181818', foreground: '#cccccc', cursor: '#aeafad', cursorAccent: '#181818', selectionBackground: '#264f78',
  black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510', blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
  brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#e5e5e5',
};

/** A Claude session or shell. The process lives on the server; this tab only shows it. */
export class TerminalTab extends Tab {
  constructor(ws, sessionId) {
    super(ws, 'session');
    this.sessionId = sessionId;
    this.seen = !!session(sessionId); // so Workspace.syncSessions closes this tab when the session goes, even if no store update came in between
    this.el.classList.add('term-body');
    this.host = h('div.term-host');
    this.banner = h('div.term-banner.hidden');
    this.el.append(this.banner, this.host);
    this.term = new Terminal({
      fontFamily: "'Cascadia Mono', 'JetBrains Mono', Consolas, 'DejaVu Sans Mono', monospace",
      fontSize: store.settings.fontSize || 13,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 20000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      rightClickSelectsWord: false, // right-click copies / pastes instead (below)
      // OSC 8 hyperlinks: click → your browser, Ctrl+click → a SkiffCode tab
      linkHandler: { activate: (e, uri) => openLink(this.ws.app, uri, e), hover: (e, uri) => this.hoverUrl(uri), leave: () => this.leaveLink(), allowNonHttpProtocols: true },
      theme: TERM_THEME,
    });
    this.fit = new FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    // Claude Code's TUI measures emoji as 2 cells; xterm's default Unicode 6 table says 1, which misplaces redraws.
    if (window.Unicode11Addon) {
      this.term.loadAddon(new Unicode11Addon.Unicode11Addon());
      this.term.unicode.activeVersion = '11';
    }
    // Links: click → your browser, Ctrl+click → a SkiffCode tab (the hint shows on hover)
    if (window.WebLinksAddon) {
      this.term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => openLink(this.ws.app, uri, e), {
        hover: (e, uri) => this.hoverUrl(uri),
        leave: () => this.leaveLink(),
      }));
    }
    // File paths (in Claude's output too): click / Ctrl+click / right-click, see termlinks.js
    if (this.term.registerLinkProvider) this.term.registerLinkProvider(pathLinks(this));
    this.host.addEventListener('mouseleave', () => this.leaveLink());
    this.term.open(this.host);
    try {
      if (window.WebglAddon) this.term.loadAddon(new WebglAddon.WebglAddon());
    } catch { /* canvas fallback */ }
    this.term.onData(d => sendInput(this.sessionId, d));
    this.term.attachCustomKeyEventHandler(e => this.ws.app.terminalKey(e, this));
    // Ctrl+V reaches xterm as a paste event: take it here so several lines can be confirmed first
    this.host.addEventListener('paste', e => {
      const text = e.clipboardData && e.clipboardData.getData('text/plain');
      if (!text) return;
      e.preventDefault();
      e.stopPropagation();
      void this.pasteText(text);
    }, true);
    // Right-click, like Windows Terminal and Orca: copies the selection, or pastes when nothing is selected.
    this.host.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      // On a link or a path: a menu (open here / in your browser / copy…); elsewhere copy or paste
      if (this.hoverLink && !this.term.hasSelection()) return contextMenu(e, linkMenuItems(this, this.hoverLink));
      if (this.term.hasSelection()) this.copySelection();
      else void this.pasteClipboard();
    }, true);
    // Files dropped on a session: from the Files panel (@path / path) or from Explorer (attached);
    // plain text dragged in (e.g. from the editor) is typed in.
    this.el.addEventListener('dragover', e => {
      if (!this.ws.dragTab && !isInternal(e) && !isExternal(e) && hasType(e, 'text/plain')) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        this.el.classList.add('term-drop');
        return;
      }
      if (this.ws.dragTab || (!isInternal(e) && !isExternal(e))) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      this.el.classList.add('term-drop');
    });
    this.el.addEventListener('dragleave', e => { if (!this.el.contains(e.relatedTarget)) this.el.classList.remove('term-drop'); });
    this.el.addEventListener('drop', e => {
      if (!this.ws.dragTab && !isInternal(e) && !isExternal(e) && hasType(e, 'text/plain')) {
        e.preventDefault();
        e.stopPropagation();
        this.el.classList.remove('term-drop');
        void this.pasteText(e.dataTransfer.getData('text/plain'));
        return;
      }
      if (this.ws.dragTab || (!isInternal(e) && !isExternal(e))) return;
      e.preventDefault();
      e.stopPropagation();
      this.el.classList.remove('term-drop');
      void dropOnTerminal(this, e, isExternal(e) ? takeExternal(e) : null);
    });
    this.onColors = () => { this.bg = null; if (this.el.isConnected && this.el.offsetParent !== null) this.applyBackground(); };
    window.addEventListener('skiffcode-colors', this.onColors);
    this.offTerm = onTerminal(sessionId, (type, bytes) => {
      if (type === 1) {
        this.term.reset();
        this.term.write(bytes);
        this.ended = false;
        this.updateBanner();
      } else if (type === 2) this.term.write(bytes);
      else if (type === 3) {
        this.ended = true;
        this.updateBanner();
      }
    });
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(this.host);
    this.attach();
  }
  get session() { return session(this.sessionId); }
  async attach() {
    const s = this.session;
    if (!s || this.disposed) return;
    if (s.state === 'ended') {
      this.ended = true;
      await this.showSavedOutput();
      if (!this.disposed) this.updateBanner();
      return;
    }
    try {
      const { cols, rows } = this.size();
      await call('term.open', { id: this.sessionId, cols, rows });
      if (this.disposed) return;
      this.attached = true;
      // The tab may not have been laid out when it connected (a brand-new tab starts at a default
      // size), and resizes before now weren't sent: measure again and tell the session its real size.
      this.lastCols = cols;
      this.lastRows = rows;
      requestAnimationFrame(() => this.layout());
      setTimeout(() => this.layout(), 250);
    } catch {
      // A dropped connection fails term.open too: the reconnect attaches again.
      if (this.disposed || (this.session || {}).state !== 'ended') return;
      this.ended = true;
      this.updateBanner();
    }
  }
  /** Show the last output of a stopped session (saved on disk, survives reboots). */
  async showSavedOutput() {
    if (this.savedShown) return;
    this.savedShown = true;
    try {
      const { data } = await call('term.history', { id: this.sessionId });
      if (data && !this.disposed) {
        const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
        this.term.reset();
        this.term.write(bytes);
        this.term.write('\r\n');
      }
    } catch { /* nothing saved */ }
  }
  updateBanner() {
    const s = this.session;
    if (this.ended && s) {
      const claude = s.kind === 'claude';
      clear(this.banner, icon('circle'),
        s.interrupted ? (claude ? 'Claude stopped when the computer restarted.' : 'This shell stopped when the computer restarted.') : claude ? 'Claude isn’t running in this session.' : 'This shell has exited.',
        h('button.btn.small.primary', { onclick: () => this.resume() }, claude ? (s.prompted ? 'Resume conversation' : 'Start Claude') : 'Restart shell'),
        !claude ? h('button.btn.small', { onclick: () => this.ws.closeTab(this) }, 'Close') : null);
      this.banner.classList.remove('hidden');
    } else this.banner.classList.add('hidden');
  }
  async resume() {
    const { cols, rows } = this.size();
    await call('sessions.resume', { id: this.sessionId, cols, rows });
    this.attached = false;
    this.savedShown = false;
    await call('term.close', { id: this.sessionId }).catch(() => {});
    setTimeout(() => this.attach(), 150);
  }
  size() {
    try {
      const d = this.fit.proposeDimensions();
      if (d && d.cols && d.rows) return { cols: d.cols, rows: d.rows };
    } catch { /* hidden */ }
    return { ...TERM_SIZE };
  }
  /** Match the panel background (Settings → Panel colors; main area vs bottom panel). */
  applyBackground() {
    const bg = termBackground(this.el);
    if (bg === this.bg) return;
    this.bg = bg;
    this.term.options.theme = { ...TERM_THEME, background: bg, cursorAccent: bg };
  }
  layout() {
    if (!this.el.isConnected || this.el.offsetParent === null) return;
    this.applyBackground();
    try {
      this.fit.fit();
    } catch { return; }
    const { cols, rows } = this.term;
    if (this.attached && (cols !== this.lastCols || rows !== this.lastRows)) {
      this.lastCols = cols;
      this.lastRows = rows;
      clearTimeout(this.rt);
      this.rt = setTimeout(() => call('term.resize', { id: this.sessionId, cols, rows }).catch(() => {}), 60);
    }
  }
  show() { requestAnimationFrame(() => this.layout()); }
  focus() { this.term.focus(); }
  hoverUrl(uri) {
    if (/^file:/i.test(uri)) { this.host.title = 'Click: open · Ctrl+click: open in SkiffCode'; return; }
    this.hoverLink = { kind: 'url', text: uri };
    this.host.title = `${LINK_HINT} · right-click for more`;
  }
  leaveLink() {
    this.hoverLink = null;
    this.host.title = '';
  }
  copySelection() {
    const text = this.term.getSelection();
    if (!text) return false;
    void navigator.clipboard.writeText(text).catch(() => {});
    this.term.clearSelection();
    toast('Copied', { timeout: 900 });
    return true;
  }
  /**
   * Paste through xterm, so programs that ask for bracketed paste (Claude, shells) get it.
   * Without bracketed paste every line runs as it arrives, so several lines are confirmed first.
   */
  async pasteText(text) {
    if (!text) return;
    const modes = this.term.modes;
    const lines = text.replace(/\r?\n$/, '').split(/\r\n|\r|\n/).length;
    if (modes && !modes.bracketedPasteMode && lines > 1) {
      const v = await confirmDialog({
        title: `Paste ${lines} lines?`,
        detail: 'This program doesn’t ask for bracketed paste, so each line may run as soon as it is pasted.',
        buttons: [{ label: 'Paste', value: 'paste', danger: true }],
      });
      if (v !== 'paste' || this.disposed) return;
    }
    if (this.term.paste) this.term.paste(text);
    else sendInput(this.sessionId, text);
    this.term.focus();
  }
  async pasteClipboard() {
    try {
      void this.pasteText(await navigator.clipboard.readText());
    } catch {
      toast('Allow clipboard access to paste with right-click (or press Ctrl+V).', { kind: 'warn', timeout: 4000 });
    }
  }
  title() { const s = this.session; return s ? s.name : 'session'; }
  tooltip() { const s = this.session; return s ? `${s.name} — ${stateLabel(s)}` : ''; }
  iconEl() {
    return sessionIcon(this.session);
  }
  unread() { const s = this.session; return !!(s && s.unread); }
  /** Closing a session's tab closes the session (SkiffCode's list and this tab stay in sync). */
  async canClose() { return this.ws.app.actions.confirmCloseSession(this.session); }
  dispose() {
    this.disposed = true;
    window.removeEventListener('skiffcode-colors', this.onColors);
    this.offTerm();
    this.ro.disconnect();
    void call('term.close', { id: this.sessionId }).catch(() => {});
    this.term.dispose();
    super.dispose();
  }
  serialize() { return { kind: 'session', id: this.sessionId }; }
}

export function tabFromSpec(ws, spec) {
  switch (spec.kind) {
    case 'file': return new EditorTab(ws, spec.path);
    case 'diff': return new DiffTab(ws, spec.spec);
    case 'review': return new ReviewTab(ws, { mode: 'base' });
    case 'commit': return new ReviewTab(ws, { mode: 'commit', sha: spec.sha, subject: spec.subject, short: spec.short });
    case 'session': return session(spec.id) ? new TerminalTab(ws, spec.id) : null;
    case 'view': return spec.path && ['image', 'pdf', 'html'].includes(spec.mode) ? new FileViewTab(ws, spec.path, spec.mode) : null;
    case 'web': return spec.url ? new WebTab(ws, spec.url) : null;
    default: return null;
  }
}
