// One worktree's workspace: two rows of panes (main area on top, a bottom
// panel for shells), each row can split right, plus its own Files / Changes /
// Search panel. Every opened worktree stays alive in the page, so switching
// between them is instant.
import { h, icon, clear, basename } from './util.js';
import { call } from './rpc.js';
import { EditorTab, DiffTab, ReviewTab, TerminalTab, tabFromSpec } from './tabs.js';
import { FileViewTab, WebTab, viewerFor, hasPreview } from './viewers.js';
import { FilesView } from './files.js';
import { ScmView } from './scm.js';
import { SearchView } from './searchview.js';
import { store, sessionsIn, session } from './store.js';
import { isInternal, isExternal, readInternal } from './dnd.js';
import { contextMenu, toast } from './dialogs.js';

const MAX_PANES_PER_ROW = 3;

class Pane {
  constructor(ws, row) {
    this.ws = ws;
    this.row = row;
    this.tabs = [];
    this.active = null;
    this.bar = h('div.tabbar', {
      ondragover: e => { if (ws.dragTab) e.preventDefault(); },
      ondrop: e => { e.preventDefault(); ws.dropTab(this, null, 'center'); },
      // Handled here, not per tab: a click re-renders the tabs, so the two
      // clicks of a double-click land on different elements.
      ondblclick: e => {
        const under = document.elementFromPoint(e.clientX, e.clientY) || e.target;
        const el = under.closest('.tab');
        if (!el || under.closest('.tab-close')) return;
        const t = this.tabs.find(x => x.uid === el.dataset.uid);
        if (!t) return;
        if (t.kind === 'session' && t.session) return ws.app.actions.renameSession(t.session);
        t.pinned = true;
        this.renderBar();
      },
    });
    this.zone = h('div.drop-zone.hidden');
    this.body = h('div.pane-body', {
      ondragover: e => this.dragOver(e),
      ondragleave: e => { if (!this.body.contains(e.relatedTarget)) this.zone.classList.add('hidden'); },
      ondrop: e => {
        e.preventDefault();
        const z = this.zone.dataset.zone || 'center';
        this.zone.classList.add('hidden');
        if (ws.dragTab) return ws.dropTab(this, null, z);
        if (isInternal(e)) return this.dropFile(e, z);
        if (isExternal(e)) toast('Drop files on a folder in the Files panel to copy them in, or on a Claude session to attach them.', { timeout: 5000 });
      },
    }, this.zone);
    this.el = h('div.pane', { onmousedown: () => ws.focusPane(this) }, this.bar, this.body);
  }

  /** Drop zones like Orca: right edge = split right, bottom edge = split down, middle = move here. */
  dragOver(e) {
    if (!this.ws.dragTab && !isInternal(e)) return;
    e.preventDefault();
    const r = this.body.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    let zone = 'center';
    if (y > 0.7 && this.row.kind === 'top') zone = 'down';
    else if (y < 0.3 && this.row.kind === 'bottom') zone = 'up';
    else if (x > 0.7 && this.row.panes.length < MAX_PANES_PER_ROW) zone = 'right';
    this.zone.dataset.zone = zone;
    this.zone.className = `drop-zone zone-${zone}`;
  }

  /** A file dragged from the Files panel: open it here, or in a new split (right / down edge). */
  async dropFile(e, zone) {
    const it = readInternal(e);
    if (!it || it.type !== 'file' || it.root !== this.ws.root) return;
    const t = await this.ws.openFile(it.path, { pane: this });
    if (!t) return;
    if (zone === 'right') this.ws.splitRight(t);
    else if (zone === 'down' || zone === 'up') this.ws.splitDown(t);
  }

  add(tab, { activate = true, index } = {}) {
    tab.pane = this;
    if (index === undefined) {
      const preview = this.tabs.find(t => t.pinned === false);
      if (preview && tab.pinned === false) {
        index = this.tabs.indexOf(preview);
        this.remove(preview);
        preview.dispose();
      }
    }
    if (index === undefined) {
      const at = this.active ? this.tabs.indexOf(this.active) + 1 : this.tabs.length;
      this.tabs.splice(at, 0, tab);
    } else this.tabs.splice(Math.min(index, this.tabs.length), 0, tab);
    this.body.append(tab.el);
    tab.el.classList.add('hidden');
    if (activate || !this.active) this.activate(tab);
    else this.renderBar();
  }

  activate(tab) {
    if (this.active === tab && !tab.el.classList.contains('hidden')) {
      this.ws.changed(); // no re-render: keeps a double-click on the same element
      return;
    }
    if (this.active && this.active !== tab) {
      this.active.el.classList.add('hidden');
      this.active.hide();
    }
    this.active = tab;
    tab.el.classList.remove('hidden');
    tab.show();
    requestAnimationFrame(() => tab.layout());
    this.renderBar();
    this.ws.changed();
  }

  remove(tab) {
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    this.tabs.splice(i, 1);
    tab.el.remove();
    if (this.active === tab) {
      this.active = null;
      const next = this.tabs[i] || this.tabs[i - 1];
      if (next) this.activate(next);
    }
    this.renderBar();
    this.ws.changed();
  }

  renderBar() {
    const ws = this.ws;
    const bottom = this.row.kind === 'bottom';
    clear(this.bar, this.tabs.map(t => {
      const el = h(`div.tab${t === this.active ? '.active' : ''}${t.pinned === false ? '.preview' : ''}${t.dirty() ? '.dirty' : ''}`, {
        title: t.tooltip(),
        draggable: 'true',
        onmousedown: e => {
          if (e.button === 1) { e.preventDefault(); ws.closeTab(t); return; }
          if (e.button === 0) this.activate(t);
        },
        dataset: { uid: t.uid },
        oncontextmenu: e => contextMenu(e, [
          { label: t.kind === 'session' ? 'Close session' : 'Close', action: () => ws.closeTab(t), hint: 'Alt+W' },
          t.kind === 'session' && t.session && t.session.kind === 'claude' && t.session.state !== 'ended' ? { label: 'Hide tab (keeps running)', action: () => ws.hideTab(t) } : null,
          t.kind === 'session' && t.session ? { label: 'Rename…', icon: 'edit', action: () => ws.app.actions.renameSession(t.session) } : null,
          t.kind === 'session' && t.session && t.session.kind === 'claude' ? { label: 'Delete session and conversation…', icon: 'trash', danger: true, action: () => ws.app.actions.purgeSession(t.session) } : null,
          { label: 'Close others', action: () => this.tabs.filter(x => x !== t).forEach(x => ws.closeTab(x)) },
          { separator: true },
          this.row.panes.length < MAX_PANES_PER_ROW ? { label: 'Split right', icon: 'split', action: () => ws.splitRight(t) } : null,
          { label: bottom ? 'Move up to the main area' : 'Split down (bottom panel)', icon: bottom ? 'up' : 'down', action: () => ws.splitDown(t) },
          t.kind === 'file' || t.kind === 'view' || t.kind === 'web' ? { separator: true } : null,
          t.kind === 'file' && hasPreview(t.path) ? { label: 'Open preview to the side', icon: 'eye', action: () => ws.openPreview(t.path) } : null,
          t.kind === 'file' || t.kind === 'view' ? { label: 'Copy path', icon: 'link', action: () => navigator.clipboard.writeText(`${ws.root}/${t.path}`) } : null,
          t.kind === 'web' ? { label: 'Copy address', icon: 'link', action: () => navigator.clipboard.writeText(t.url) } : null,
          t.kind === 'session' && t.session && t.session.state !== 'ended' ? { separator: true } : null,
          t.kind === 'session' && t.session && t.session.state !== 'ended' ? { label: 'Stop', icon: 'stop', action: () => call('sessions.stop', { id: t.sessionId }) } : null,
        ]),
        ondragstart: e => { ws.dragTab = t; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.uid); },
        ondragover: e => { if (ws.dragTab) { e.preventDefault(); e.stopPropagation(); el.classList.add('drop-before'); } },
        ondragleave: () => el.classList.remove('drop-before'),
        ondrop: e => { e.preventDefault(); e.stopPropagation(); el.classList.remove('drop-before'); ws.dropTab(this, t, 'center'); },
      },
      t.iconEl(),
      h('span.tab-title', t.title()),
      t.unread && t.unread() ? h('span.unread-dot') : null,
      h('button.tab-close', {
        title: t.kind === 'session' ? 'Close session' : 'Close',
        onmousedown: e => e.stopPropagation(),
        onclick: e => { e.stopPropagation(); ws.closeTab(t); },
      }, icon('close')));
      return el;
    }),
    h('div.tabbar-fill', {
      ondblclick: () => ws.app.actions.newSession(ws.root, bottom ? 'shell' : 'claude'),
      title: bottom ? 'Double-click for a new shell' : 'Double-click for a new Claude session',
    }),
    h('div.tabbar-actions',
      bottom ? null : h('button.icon-btn', { title: 'New browser tab: a web address or a file path', onclick: () => ws.openWeb('', { pane: this }) }, icon('globe')),
      this.active && this.active.kind === 'file' && hasPreview(this.active.path)
        ? h('button.icon-btn', { title: 'Open preview to the side', onclick: () => ws.openPreview(this.active.path) }, icon('eye'))
        : null,
      bottom ? null : h('button.icon-btn', { title: 'New Claude session (Ctrl+Alt+N)', onclick: () => ws.app.actions.newSession(ws.root, 'claude') }, icon('claude')),
      h('button.icon-btn', { title: 'New shell (Ctrl+`)', onclick: () => ws.app.actions.newSession(ws.root, 'shell', { pane: bottom ? this : undefined }) }, icon('terminal')),
      this.row.panes.length < MAX_PANES_PER_ROW ? h('button.icon-btn', { title: 'Split right', onclick: () => this.active && ws.splitRight(this.active) }, icon('split')) : null,
      !bottom ? h('button.icon-btn', { title: 'Split down', onclick: () => this.active && ws.splitDown(this.active) }, icon('splitDown')) : null,
      bottom && this.row.panes.indexOf(this) === this.row.panes.length - 1
        ? h('button.icon-btn', { title: 'Hide panel (Ctrl+Shift+`)', onclick: () => ws.togglePanel(false) }, icon('chevronDown'))
        : null));
  }
}

class Row {
  constructor(ws, kind) {
    this.ws = ws;
    this.kind = kind;
    this.panes = [];
    this.el = h(`div.ws-row.row-${kind}`);
  }
  addPane(index = this.panes.length) {
    const p = new Pane(this.ws, this);
    this.panes.splice(index, 0, p);
    this.rebuild();
    p.renderBar();
    return p;
  }
  removePane(p) {
    const i = this.panes.indexOf(p);
    if (i < 0) return;
    this.panes.splice(i, 1);
    p.el.remove();
    this.panes.forEach(x => (x.el.style.flex = ''));
    this.rebuild();
  }
  rebuild() {
    this.el.replaceChildren();
    this.panes.forEach((p, i) => {
      if (i > 0) this.el.append(h('div.sash.vertical.pane-sash', { onmousedown: e => this.dragSash(e, i) }));
      this.el.append(p.el);
      p.renderBar();
    });
  }
  dragSash(e, i) {
    e.preventDefault();
    const a = this.panes[i - 1];
    const b = this.panes[i];
    const total = a.el.offsetWidth + b.el.offsetWidth;
    const start = e.clientX;
    const wa = a.el.offsetWidth;
    const move = ev => {
      const x = Math.max(140, Math.min(total - 140, wa + ev.clientX - start));
      a.el.style.flex = `0 0 ${x}px`;
      b.el.style.flex = `0 0 ${total - x}px`;
      this.ws.layoutAll();
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      // keep proportions when the window resizes
      const sum = this.panes.reduce((n, p) => n + p.el.offsetWidth, 0);
      this.panes.forEach(p => (p.el.style.flex = `${(p.el.offsetWidth / sum).toFixed(4)} 1 0`));
      this.ws.saveSoon();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }
  tabs() {
    return this.panes.flatMap(p => p.tabs);
  }
}

/** Whether a worktree path belongs to a git repo (plain folders are added with kind: 'folder'). */
function fs_isGit(root) {
  const r = store.repos.find(x => x.path === root);
  return !(r && r.kind === 'folder');
}

export class Workspace {
  constructor(app, wt) {
    this.app = app;
    this.root = wt.path;
    this.repoPath = wt.repo.path;
    this.focused = null;
    this.top = new Row(this, 'top');
    this.bottom = new Row(this, 'bottom');
    this.panelHidden = false;
    this.panelHeight = 0.34; // fraction of the center height
    this.hsash = h('div.sash.horizontal', { onmousedown: e => this.dragPanelSash(e) });
    this.rowsEl = h('div.ws-rows', this.top.el, this.hsash, this.bottom.el);
    this.empty = h('div.ws-empty');
    this.center = h('div.ws-center', this.rowsEl, this.empty);
    const width = Number(localStorage.getItem('skiffcode.rightWidth') || 320);
    this.right = h('div.ws-right', { style: { width: `${width}px` } });
    this.sash = h('div.sash.vertical', { onmousedown: e => this.dragSash(e) });
    this.el = h('div.workspace.hidden', this.center, this.sash, this.right);
    this.files = new FilesView(this);
    this.scm = new ScmView(this);
    this.search = new SearchView(this);
    this.rightTabs = h('div.right-tabs');
    this.rightBody = h('div.right-body', this.files.el, this.scm.el, this.search.el);
    this.right.append(this.rightTabs, this.rightBody);
    // A plain folder has no git, so it starts on Files.
    const lastView = localStorage.getItem('skiffcode.rightView') || 'files';
    this.showRight(lastView === 'scm' && !fs_isGit(this.root) ? 'files' : lastView);
    this.top.addPane();
    this.focused = this.top.panes[0];
    this.saveSoon = (() => { let t; return () => { clearTimeout(t); t = setTimeout(() => this.saveLayout(), 400); }; })();
    this.applyPanel();
  }

  get panes() { return [...this.top.panes, ...this.bottom.panes]; }
  get activeTab() { return this.focused && this.focused.active; }
  allTabs() { return this.panes.flatMap(p => p.tabs); }

  // ---------------------------------------------------------------- panes & tabs

  focusPane(p) {
    if (this.focused === p) return;
    this.focused = p;
    this.panes.forEach(x => x.el.classList.toggle('focused', x === p));
    this.app.reportView();
  }

  /** The pane a new tab of this kind goes to: shells → bottom panel, everything else → main area. */
  paneFor(kind) {
    if (kind === 'shell' && store.settings.shellsInPanel !== false) {
      if (this.focused && this.focused.row === this.bottom) return this.focused;
      return this.bottom.panes[0] || this.bottom.addPane();
    }
    if (this.focused && this.focused.row === this.top) return this.focused;
    return this.top.panes[0];
  }

  addTab(tab, opts = {}) {
    const pane = opts.pane || this.paneFor(tab.kind === 'session' && tab.session && tab.session.kind === 'shell' ? 'shell' : tab.kind);
    pane.add(tab, opts);
    if (pane.row === this.bottom) {
      if (this.panelHidden && opts.activate !== false) this.panelHidden = false;
      this.applyPanel();
    }
    if (opts.activate !== false) this.focusPane(pane);
    this.changed();
    return tab;
  }

  find(pred) {
    for (const p of this.panes) for (const t of p.tabs) if (pred(t)) return t;
    return null;
  }

  reveal(tab) {
    tab.pane.activate(tab);
    if (tab.pane.row === this.bottom && this.panelHidden) this.togglePanel(true);
    this.focusPane(tab.pane);
    setTimeout(() => tab.focus(), 0);
    return tab;
  }

  async closeTab(t) {
    if (!(await t.canClose())) return;
    const id = t.kind === 'session' ? t.sessionId : null;
    this.hideTab(t);
    // Closing a session's tab closes the session: it disappears from the sidebar too.
    if (id && session(id)) await call('sessions.forget', { id });
  }

  /** Remove the tab only (a Claude session keeps running and stays in the sidebar). */
  hideTab(t) {
    const pane = t.pane;
    pane.remove(t);
    t.dispose();
    this.cleanupPane(pane);
    this.changed();
  }

  cleanupPane(pane) {
    if (pane.tabs.length) return;
    const row = pane.row;
    if (row === this.top && row.panes.length === 1) return; // the main area always has one pane
    row.removePane(pane);
    if (this.focused === pane) this.focusPane(this.top.panes[0]);
    this.applyPanel();
  }

  moveTab(tab, toPane, index) {
    const from = tab.pane;
    from.remove(tab);
    toPane.add(tab, { index });
    tab.el.classList.remove('hidden');
    this.cleanupPane(from);
    this.focusPane(toPane);
    this.applyPanel();
    requestAnimationFrame(() => this.layoutAll());
    this.saveSoon();
  }

  splitRight(tab) {
    const row = tab.pane.row;
    if (row.panes.length >= MAX_PANES_PER_ROW && tab.pane.tabs.length > 1) return;
    const at = row.panes.indexOf(tab.pane) + 1;
    const p = row.panes[at] && tab.pane.tabs.length === 1 ? row.panes[at] : row.addPane(at);
    this.moveTab(tab, p);
  }

  /** Top → bottom panel, bottom → main area. */
  splitDown(tab) {
    const to = tab.pane.row === this.top ? this.bottom : this.top;
    const p = to.panes[0] || to.addPane();
    if (to === this.bottom) this.panelHidden = false;
    this.moveTab(tab, p);
  }

  dropTab(pane, before, zone) {
    const t = this.dragTab;
    this.dragTab = null;
    if (!t) return;
    if (zone === 'right') {
      const row = pane.row;
      const p = row.addPane(row.panes.indexOf(pane) + 1);
      return this.moveTab(t, p);
    }
    if (zone === 'down' || zone === 'up') {
      const row = zone === 'down' ? this.bottom : this.top;
      const p = row.panes[0] || row.addPane();
      if (row === this.bottom) this.panelHidden = false;
      return this.moveTab(t, p);
    }
    if (t === before || (t.pane === pane && !before)) return;
    this.moveTab(t, pane, before ? pane.tabs.indexOf(before) : pane.tabs.length);
  }

  togglePanel(show = this.panelHidden) {
    if (show && !this.bottom.panes.length) {
      this.panelHidden = false;
      this.app.actions.newSession(this.root, 'shell');
      return;
    }
    this.panelHidden = !show;
    this.applyPanel();
    if (show && this.bottom.panes[0]) {
      this.focusPane(this.bottom.panes[0]);
      const t = this.bottom.panes[0].active;
      if (t) setTimeout(() => t.focus(), 0);
    } else if (!show && this.focused && this.focused.row === this.bottom) this.focusPane(this.top.panes[0]);
    this.saveSoon();
  }

  applyPanel() {
    const has = this.bottom.panes.length > 0 && !this.panelHidden;
    this.bottom.el.classList.toggle('hidden', !has);
    this.hsash.classList.toggle('hidden', !has);
    this.bottom.el.style.flex = `0 0 ${Math.round(this.panelHeight * 100)}%`;
    requestAnimationFrame(() => this.layoutAll());
  }

  dragPanelSash(e) {
    e.preventDefault();
    const total = this.rowsEl.offsetHeight;
    const startY = e.clientY;
    const h0 = this.bottom.el.offsetHeight;
    const move = ev => {
      const px = Math.max(90, Math.min(total - 120, h0 - (ev.clientY - startY)));
      this.panelHeight = px / total;
      this.bottom.el.style.flex = `0 0 ${px}px`;
      this.layoutAll();
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      this.applyPanel();
      this.saveSoon();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  layoutAll() {
    for (const p of this.panes) if (p.active) p.active.layout();
  }

  tabChanged(t) {
    if (t.pane) t.pane.renderBar();
    this.app.updateStatusBar();
  }

  changed() {
    const has = this.allTabs().length > 0;
    this.empty.classList.toggle('hidden', has);
    this.rowsEl.classList.toggle('hidden', !has);
    if (!has) this.renderEmpty();
    this.app.reportView();
    this.app.updateStatusBar();
    if (this.saveSoon) this.saveSoon();
  }

  renderEmpty() {
    const live = sessionsIn(this.root);
    clear(this.empty, h('div.empty-inner',
      h('div.empty-title', basename(this.root)),
      h('div.empty-actions',
        h('button.btn.primary', { onclick: () => this.app.actions.newSession(this.root, 'claude') }, icon('claude'), 'New Claude session'),
        h('button.btn', { onclick: () => this.app.actions.newSession(this.root, 'shell') }, icon('terminal'), 'New shell'),
        h('button.btn', { onclick: () => this.app.actions.resumeConversation(this.root) }, icon('play'), 'Resume conversation…'),
        h('button.btn', { onclick: () => this.app.actions.quickOpen() }, icon('file'), 'Open file…')),
      live.length ? h('div.empty-sessions', h('div.muted', 'Sessions in this worktree'), live.map(s => h('button.link', { onclick: () => this.openSession(s.id) }, s.name))) : null,
      h('div.empty-keys',
        h('span', h('kbd', 'Ctrl+P'), ' open file'),
        h('span', h('kbd', 'Ctrl+Alt+J'), ' jump'),
        h('span', h('kbd', 'Ctrl+`'), ' shell'),
        h('span', h('kbd', 'F12'), ' definition'))));
  }

  // ---------------------------------------------------------------- open things

  async openFile(path, { line, col, len, preview = false, pane, asText = false } = {}) {
    const mode = asText ? null : viewerFor(path);
    if (mode) return this.openView(path, mode, { preview, pane });
    let t = this.find(x => x.kind === 'file' && x.path === path);
    if (!t) t = this.addTab(new EditorTab(this, path, { preview }), { pane: pane || this.paneFor('file') });
    else if (!preview) { t.pinned = true; t.pane.renderBar(); }
    this.reveal(t);
    await t.ready;
    if (line) t.reveal(line, col || 1, len || 0);
    return t;
  }

  /** An image or PDF, or a live preview of a page ('html'). */
  async openView(path, mode, { preview = false, pane, side = false } = {}) {
    let t = this.find(x => x.kind === 'view' && x.path === path && x.mode === mode);
    if (!t) {
      let target = pane || this.paneFor('view');
      const next = side && target.row.panes[target.row.panes.indexOf(target) + 1];
      if (next) target = next; // a pane already to the right: open there
      t = this.addTab(new FileViewTab(this, path, mode, { preview }), { pane: target });
      if (side && !next && t.pane.tabs.length > 1 && t.pane.row.panes.length < MAX_PANES_PER_ROW) this.splitRight(t);
    } else if (!preview) { t.pinned = true; t.pane.renderBar(); }
    this.reveal(t);
    await t.ready;
    return t;
  }

  /** Preview of an HTML page (or SVG), next to its source like VS Code's "Open Preview to the Side". */
  openPreview(path, { side = true } = {}) {
    return this.openView(path, 'html', { side });
  }

  /** A web page in a tab. */
  openWeb(url, { pane } = {}) {
    const t = this.addTab(new WebTab(this, url), { pane: pane || this.paneFor('web') });
    return this.reveal(t);
  }

  openDiff(spec) {
    let t = this.find(x => x.kind === 'diff' && x.spec.path === spec.path && x.spec.label === spec.label);
    if (t) {
      const pane = t.pane;
      pane.remove(t);
      t.dispose();
      t = this.addTab(new DiffTab(this, spec), { pane });
    } else t = this.addTab(new DiffTab(this, spec), { pane: this.paneFor('diff') });
    return this.reveal(t);
  }

  openReview() {
    const t = this.find(x => x.kind === 'review') || this.addTab(new ReviewTab(this, { mode: 'base' }), { pane: this.paneFor('review') });
    if (t.load && t.files) void t.load();
    return this.reveal(t);
  }

  openCommit(c) {
    const t = this.find(x => x.kind === 'commit' && x.sha === c.sha) || this.addTab(new ReviewTab(this, { mode: 'commit', sha: c.sha, subject: c.subject, short: c.short }), { pane: this.paneFor('commit') });
    return this.reveal(t);
  }

  openSession(id, { activate = true, pane } = {}) {
    let t = this.find(x => x.kind === 'session' && x.sessionId === id);
    if (!t) {
      const s = session(id);
      t = this.addTab(new TerminalTab(this, id), { activate, pane: pane || this.paneFor(s && s.kind === 'shell' ? 'shell' : 'claude') });
    }
    if (activate) this.reveal(t);
    return t;
  }

  syncSessions() {
    for (const t of this.allTabs()) {
      if (t.kind !== 'session') continue;
      const s = session(t.sessionId);
      if (s) t.seen = true;
      if (!s && t.seen) {
        const pane = t.pane;
        pane.remove(t);
        t.dispose();
        this.cleanupPane(pane);
      } else if (s) {
        t.pane.renderBar();
        if (t.updateBanner) t.updateBanner();
        if (t.ended && s.state !== 'ended' && !t.attached) t.attach();
      }
    }
    if (!this.allTabs().length) this.renderEmpty();
  }

  /** After a reboot: restart this worktree's interrupted sessions and shells (setting: autoResume). */
  async autoResume() {
    if (this.autoResumed || store.settings.autoResume === false) return;
    this.autoResumed = true;
    for (const s of sessionsIn(this.root).filter(x => x.interrupted && x.state === 'ended')) {
      try {
        await call('sessions.resume', { id: s.id, cols: 120, rows: 32 });
        const t = this.find(x => x.kind === 'session' && x.sessionId === s.id) || this.openSession(s.id, { activate: false });
        setTimeout(() => { t.attached = false; t.attach(); }, 250);
      } catch { /* leave it stopped */ }
    }
  }

  // ---------------------------------------------------------------- right panel

  showRight(view) {
    this.rightView = view;
    localStorage.setItem('skiffcode.rightView', view);
    const tabs = [['files', 'files', 'Files', 'Ctrl+Shift+E'], ['scm', 'git', 'Changes', 'Ctrl+Shift+G'], ['search', 'search', 'Search', 'Ctrl+Shift+F']];
    clear(this.rightTabs, tabs.map(([id, ic, label, key]) => h(`button.right-tab${id === view ? '.active' : ''}`, { title: `${label} (${key})`, onclick: () => this.showRight(id) }, icon(ic), h('span', label), id === 'scm' ? this.scm.badge : null)));
    this.files.el.classList.toggle('hidden', view !== 'files');
    this.scm.el.classList.toggle('hidden', view !== 'scm');
    this.search.el.classList.toggle('hidden', view !== 'search');
    if (view === 'scm') this.scm.refresh();
    if (view === 'files') this.files.ensure();
    if (view === 'search') this.search.focus();
  }

  dragSash(e) {
    e.preventDefault();
    const start = e.clientX;
    const w0 = this.right.offsetWidth;
    const move = ev => {
      const w = Math.max(200, Math.min(window.innerWidth * 0.6, w0 - (ev.clientX - start)));
      this.right.style.width = `${w}px`;
      this.layoutAll();
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      localStorage.setItem('skiffcode.rightWidth', String(this.right.offsetWidth));
      for (const ws of this.app.workspaces.values()) ws.right.style.width = this.right.style.width;
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  // ---------------------------------------------------------------- lifecycle

  show() {
    this.lastSeen = Date.now();
    this.el.classList.remove('hidden');
    requestAnimationFrame(() => this.layoutAll());
    this.files.ensure();
    this.scm.refresh();
    this.syncSessions();
    void this.autoResume();
  }
  hide() {
    this.lastSeen = Date.now();
    this.el.classList.add('hidden');
  }

  saveLayout() {
    const rowSpec = row => row.panes.map(p => ({
      tabs: p.tabs.filter(t => t.pinned !== false).map(t => t.serialize()).filter(Boolean),
      active: p.active ? p.tabs.filter(t => t.pinned !== false).indexOf(p.active) : 0,
      flex: p.el.style.flex || '',
    }));
    const layout = {
      v: 2,
      top: rowSpec(this.top),
      bottom: rowSpec(this.bottom),
      panelHeight: this.panelHeight,
      panelHidden: this.panelHidden,
      focused: [this.focused && this.focused.row === this.bottom ? 1 : 0, this.focused ? this.focused.row.panes.indexOf(this.focused) : 0],
      expanded: this.files.expandedList(),
    };
    store.layouts[this.root] = layout;
    void call('layout.save', { root: this.root, layout }).catch(() => {});
  }

  restore() {
    const raw = store.layouts[this.root];
    const layout = raw && raw.v === 2 ? raw : raw && raw.panes ? { top: raw.panes, bottom: [], expanded: raw.expanded } : null;
    const open = new Set();
    if (layout) {
      if (layout.panelHeight) this.panelHeight = layout.panelHeight;
      this.panelHidden = !!layout.panelHidden;
      const fill = (row, specs) => specs.forEach((ps, i) => {
        const pane = row === this.top && i === 0 ? this.top.panes[0] : row.addPane();
        for (const spec of ps.tabs || []) {
          const t = tabFromSpec(this, spec);
          if (!t) continue;
          if (t.kind === 'session') open.add(t.sessionId);
          pane.add(t, { activate: false });
        }
        if (ps.flex) pane.el.style.flex = ps.flex;
        if (pane.tabs[ps.active]) pane.activate(pane.tabs[ps.active]);
        else if (pane.tabs[0]) pane.activate(pane.tabs[0]);
      });
      fill(this.top, layout.top || []);
      fill(this.bottom, layout.bottom || []);
      for (const p of [...this.panes]) this.cleanupPane(p);
      if (layout.expanded) this.files.restoreExpanded(layout.expanded);
      const [r, i] = layout.focused || [0, 0];
      const row = r === 1 && this.bottom.panes.length ? this.bottom : this.top;
      this.focused = null;
      this.focusPane(row.panes[Math.min(i, row.panes.length - 1)] || this.top.panes[0]);
    }
    // Running sessions always get a tab.
    for (const s of sessionsIn(this.root)) if (!open.has(s.id) && s.state !== 'ended') this.openSession(s.id, { activate: false });
    for (const p of this.panes) if (!p.active && p.tabs.length) p.activate(p.tabs[0]);
    this.applyPanel();
    this.changed();
  }

  dispose() {
    for (const t of this.allTabs()) t.dispose();
    this.files.dispose();
    this.el.remove();
  }
}
