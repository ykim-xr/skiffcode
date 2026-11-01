// One worktree's workspace: a main area split into nested panes like VS Code,
// a bottom panel of panes side by side (for shells), plus its own Files /
// Changes / Search panel. Every opened worktree stays alive in the page, so switching
// between them is instant.
import { h, icon, clear, basename, readStored, debounce, TERM_SIZE } from './util.js';
import { call } from './rpc.js';
import { EditorTab, DiffTab, ReviewTab, TerminalTab, tabFromSpec } from './tabs.js';
import { FileViewTab, WebTab, viewerFor, hasPreview } from './viewers.js';
import { FilesView } from './files.js';
import { ScmView } from './scm.js';
import { SearchView } from './searchview.js';
import { store, sessionsIn, session } from './store.js';
import { isInternal, isExternal, readInternal } from './dnd.js';
import { contextMenu, toast } from './dialogs.js';
import { keyHint, withKey } from './keybindings.js';

const MAX_MAIN_PANES = 8;
const MAX_PANEL_PANES = 5;
const EDGE = 0.25; // a drop this close to a pane's edge splits that way

/** A flex value that grows in proportion to g. */
const flexOf = g => `${+g.toFixed(4)} 1 0`;
/** A node's share of its split (1 while a sash drag holds it at a fixed size). */
const growOf = node => { const v = parseFloat(node.el.style.flex); return v > 0 ? v : 1; };

class Pane {
  constructor(ws, row) {
    this.ws = ws;
    this.row = row;
    this.parent = null; // the Split it is in (main area only)
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

  /**
   * Drop zones like VS Code. Main area: an edge splits that way, the middle moves here.
   * Bottom panel: the right edge splits right, the top edge moves to the main area.
   */
  dragOver(e) {
    const tab = this.ws.dragTab;
    if (!tab && !isInternal(e)) return;
    e.preventDefault();
    const r = this.body.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    let zone = 'center';
    if (this.row.kind === 'bottom') {
      if (y < EDGE) zone = 'up';
      else if (x > 1 - EDGE && this.ws.canSplit(this, tab)) zone = 'right';
    } else if (this.ws.canSplit(this, tab)) {
      const [side, d] = [['left', x], ['right', 1 - x], ['up', y], ['down', 1 - y]].sort((a, b) => a[1] - b[1])[0];
      if (d < EDGE) zone = side;
    }
    this.zone.dataset.zone = zone;
    this.zone.className = `drop-zone zone-${zone}`;
  }

  /** A file dragged from the Files panel: open it here, then handle the zone as a dropped tab would. */
  async dropFile(e, zone) {
    const it = readInternal(e);
    if (!it || it.type !== 'file' || it.root !== this.ws.root) return;
    const t = await this.ws.openFile(it.path, { pane: this });
    if (!t || zone === 'center') return;
    if (zone === 'up' && this.row.kind === 'bottom') this.ws.moveToMain(t);
    else this.ws.split(t, zone, this);
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

  /** `rebuild: false` marks the tab in place, so the element under the pointer survives and a drag can start on it. */
  activate(tab, { rebuild = true } = {}) {
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
    if (rebuild) this.renderBar();
    else this.markActive();
    this.ws.changed();
  }

  markActive() {
    for (const t of this.tabs) if (t.tabEl) t.tabEl.classList.toggle('active', t === this.active);
    const actions = this.renderActions();
    this.actionsEl.replaceWith(actions);
    this.actionsEl = actions;
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
          if (e.button === 0) this.activate(t, { rebuild: false });
        },
        dataset: { uid: t.uid },
        oncontextmenu: e => {
          // a conversation that was never prompted gets a new id when it restarts
          const cid = t.kind === 'session' && t.session && t.session.kind === 'claude' && t.session.prompted && t.session.claudeId;
          contextMenu(e, [
            { label: t.kind === 'session' ? 'Close session' : 'Close', action: () => ws.closeTab(t), hint: keyHint('closeTab') || keyHint('closeTabOutsideTerminals') },
            t.kind === 'session' && t.session && t.session.kind === 'claude' && t.session.state !== 'ended' ? { label: 'Hide tab (keeps running)', action: () => ws.hideTab(t) } : null,
            t.kind === 'session' && t.session ? { label: 'Rename…', icon: 'edit', action: () => ws.app.actions.renameSession(t.session) } : null,
            t.kind === 'session' && t.session && t.session.kind === 'claude' ? { label: 'Delete session and conversation…', icon: 'trash', danger: true, action: () => ws.app.actions.purgeSession(t.session) } : null,
            { label: 'Close others', action: async () => { for (const x of this.tabs.filter(y => y !== t)) await ws.closeTab(x); } }, // one question at a time
            { separator: true },
            this.tabs.length > 1 ? { label: 'Split right', icon: 'split', action: () => ws.split(t, 'right') } : null,
            !bottom && this.tabs.length > 1 ? { label: 'Split down', icon: 'splitDown', action: () => ws.split(t, 'down') } : null,
            bottom ? { label: 'Move to main area', icon: 'up', action: () => ws.moveToMain(t) } : { label: 'Move to panel', icon: 'down', action: () => ws.moveToPanel(t) },
            t.kind === 'file' || t.kind === 'view' || t.kind === 'web' ? { separator: true } : null,
            t.kind === 'file' && hasPreview(t.path) ? { label: 'Open preview to the side', icon: 'eye', action: () => ws.openPreview(t.path) } : null,
            t.kind === 'file' || t.kind === 'view' ? { label: 'Copy path', icon: 'link', action: () => navigator.clipboard.writeText(`${ws.root}/${t.path}`) } : null,
            t.kind === 'web' ? { label: 'Copy address', icon: 'link', action: () => navigator.clipboard.writeText(t.url) } : null,
            cid ? { separator: true } : null,
            cid ? { label: 'Copy conversation ID', icon: 'link', action: () => navigator.clipboard.writeText(cid) } : null,
            t.kind === 'session' && t.session && t.session.state !== 'ended' ? { separator: true } : null,
            t.kind === 'session' && t.session && t.session.state !== 'ended' ? { label: 'Stop', icon: 'stop', action: () => call('sessions.stop', { id: t.sessionId }) } : null,
          ]);
        },
        ondragstart: e => { ws.dragTab = t; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.uid); },
        ondragend: () => { ws.dragTab = null; }, // a drag that ends without a drop
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
      t.tabEl = el;
      return el;
    }),
    h('div.tabbar-fill', {
      ondblclick: () => ws.app.actions.newSession(ws.root, bottom ? 'shell' : 'claude', { pane: this }),
      title: bottom ? 'Double-click for a new shell' : 'Double-click for a new Claude session',
    }),
    (this.actionsEl = this.renderActions()));
  }

  renderActions() {
    const ws = this.ws;
    const bottom = this.row.kind === 'bottom';
    return h('div.tabbar-actions',
      bottom ? null : h('button.icon-btn', { title: 'New browser tab: a web address or a file path', onclick: () => ws.openWeb('', { pane: this }) }, icon('globe')),
      this.active && this.active.kind === 'file' && hasPreview(this.active.path)
        ? h('button.icon-btn', { title: 'Open preview to the side', onclick: () => ws.openPreview(this.active.path) }, icon('eye'))
        : null,
      bottom ? null : h('button.icon-btn', { title: withKey('New Claude session', 'newClaude'), onclick: () => ws.app.actions.newSession(ws.root, 'claude', { pane: this }) }, icon('claude')),
      h('button.icon-btn', { title: withKey('New shell', 'newShell'), onclick: () => ws.app.actions.newSession(ws.root, 'shell', { pane: this }) }, icon('terminal')),
      h('button.icon-btn', { title: 'Split right', onclick: () => this.active && ws.split(this.active, 'right') }, icon('split')),
      bottom ? null : h('button.icon-btn', { title: 'Split down', onclick: () => this.active && ws.split(this.active, 'down') }, icon('splitDown')),
      bottom && this.row.panes.indexOf(this) === this.row.panes.length - 1
        ? h('button.icon-btn', { title: withKey('Hide panel', 'togglePanel'), onclick: () => ws.togglePanel(false) }, icon('chevronDown'))
        : null);
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

/** A split in the main area: panes or splits side by side ('row') or stacked ('column'), with sashes between. */
class Split {
  constructor(area, dir) {
    this.area = area;
    this.dir = dir;
    this.parent = null;
    this.children = [];
    this.sashes = new Map(); // child → the sash before it
    this.el = h(`div.split.split-${dir}`);
  }

  /** Puts the children and their sashes in the DOM. Elements already in place never move, so iframes in untouched panes don't reload. */
  sync() {
    const want = [];
    this.children.forEach((c, i) => {
      c.parent = this;
      if (i) {
        if (!this.sashes.has(c)) this.sashes.set(c, h(`div.sash.pane-sash.${this.dir === 'row' ? 'vertical' : 'horizontal'}`, { onmousedown: e => this.dragSash(e, c) }));
        want.push(this.sashes.get(c));
      }
      want.push(c.el);
    });
    for (const c of this.sashes.keys()) if (this.children.indexOf(c) < 1) this.sashes.delete(c);
    const keep = new Set(want);
    for (const el of [...this.el.children]) if (!keep.has(el)) el.remove();
    want.forEach((el, i) => { if (this.el.children[i] !== el) this.el.insertBefore(el, this.el.children[i] || null); });
  }

  dragSash(e, b) {
    e.preventDefault();
    const ws = this.area.ws;
    const row = this.dir === 'row';
    const size = n => (row ? n.el.offsetWidth : n.el.offsetHeight);
    const pos = ev => (row ? ev.clientX : ev.clientY);
    const min = row ? 140 : 80;
    const a = this.children[this.children.indexOf(b) - 1];
    const total = size(a) + size(b);
    const start = pos(e);
    const sa = size(a);
    const move = ev => {
      const x = Math.max(min, Math.min(total - min, sa + pos(ev) - start));
      a.el.style.flex = `0 0 ${x}px`;
      b.el.style.flex = `0 0 ${total - x}px`;
      ws.layoutAll();
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      // keep proportions when the window resizes
      const sizes = this.children.map(size);
      const sum = sizes.reduce((n, s) => n + s, 0) || 1;
      this.children.forEach((c, i) => (c.el.style.flex = flexOf(sizes[i] / sum || 1)));
      ws.layoutAll();
      ws.saveSoon();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }
}

/** The main area: a tree of splits with panes at the leaves. Has Row's interface (kind, el, panes, tabs()). */
class MainArea {
  constructor(ws) {
    this.ws = ws;
    this.kind = 'top';
    this.el = h('div.ws-row.row-top');
    this.setRoot(new Pane(ws, this));
  }

  /** Panes in reading order. */
  get panes() {
    const out = [];
    const walk = n => (n instanceof Pane ? out.push(n) : n.children.forEach(walk));
    walk(this.root);
    return out;
  }
  tabs() {
    return this.panes.flatMap(p => p.tabs);
  }

  setRoot(node) {
    this.root = node;
    node.parent = null;
    node.el.style.flex = '';
    if (this.el.firstChild !== node.el || this.el.children.length !== 1) this.el.replaceChildren(node.el);
  }

  /** Puts `node` where `old` is, with old's size. */
  replace(old, node) {
    const s = old.parent;
    node.el.style.flex = old.el.style.flex;
    old.parent = null;
    if (!s) return this.setRoot(node);
    s.children[s.children.indexOf(old)] = node;
    s.sync();
  }

  /** A new pane on one side of `target` ('right' | 'left' | 'down' | 'up'), taking half of its size. */
  splitPane(target, side) {
    const dir = side === 'left' || side === 'right' ? 'row' : 'column';
    const after = side === 'right' || side === 'down';
    const p = new Pane(this.ws, this);
    const s = target.parent;
    if (s && s.dir === dir) {
      target.el.style.flex = p.el.style.flex = flexOf(growOf(target) / 2);
      s.children.splice(s.children.indexOf(target) + (after ? 1 : 0), 0, p);
      s.sync();
    } else {
      const split = new Split(this, dir);
      this.replace(target, split);
      target.el.style.flex = p.el.style.flex = '';
      split.children = after ? [target, p] : [p, target];
      split.sync();
    }
    p.renderBar();
    return p;
  }

  /** Takes out an empty pane; a split left with one child gives way to that child. The others keep their shares. */
  removePane(p) {
    const s = p.parent;
    if (!s) return; // the root pane stays
    s.children.splice(s.children.indexOf(p), 1);
    p.parent = null;
    if (s.children.length > 1) return s.sync();
    const lone = s.children[0];
    const up = s.parent;
    if (lone instanceof Split && up && up.dir === lone.dir) {
      // same direction as the split above: its children join that split with their share of the space
      const scale = growOf(s) / lone.children.reduce((n, c) => n + growOf(c), 0);
      for (const c of lone.children) c.el.style.flex = flexOf(growOf(c) * scale);
      up.children.splice(up.children.indexOf(s), 1, ...lone.children);
      up.sync();
    } else this.replace(s, lone);
  }

  /** The tree for saving: a pane is its index in reading order, a split is { split, sizes, children }. */
  spec() {
    const panes = this.panes;
    const walk = n => (n instanceof Pane ? panes.indexOf(n) : { split: n.dir, sizes: n.children.map(growOf), children: n.children.map(walk) });
    return walk(this.root);
  }

  /** Replaces the tree with one built from a checked saved tree (see cleanTree). Returns the new panes by saved index. */
  build(node) {
    const made = new Map();
    const make = n => {
      if (typeof n === 'number') {
        const p = new Pane(this.ws, this);
        made.set(n, p);
        return p;
      }
      const s = new Split(this, n.split);
      s.children = n.children.map(make);
      s.children.forEach((c, i) => (c.el.style.flex = flexOf(n.sizes[i])));
      s.sync();
      return s;
    };
    this.setRoot(make(node));
    for (const p of made.values()) p.renderBar();
    return made;
  }
}

/**
 * A saved main-area tree, checked: nodes of the wrong shape are dropped (never thrown on), a split with one
 * child becomes that child, and each saved pane is placed once, MAX_MAIN_PANES at most.
 * `used` lists the placed pane indexes in reading order.
 */
function cleanTree(node, count) {
  const used = [];
  const walk = (n, depth) => {
    if (Number.isInteger(n)) {
      if (n < 0 || n >= count || used.includes(n) || used.length >= MAX_MAIN_PANES) return null;
      used.push(n);
      return n;
    }
    if (!n || typeof n !== 'object' || depth > MAX_MAIN_PANES || (n.split !== 'row' && n.split !== 'column') || !Array.isArray(n.children)) return null;
    const children = [];
    const sizes = [];
    n.children.forEach((c, i) => {
      const k = walk(c, depth + 1);
      if (k === null) return;
      const size = Array.isArray(n.sizes) ? Number(n.sizes[i]) : NaN;
      children.push(k);
      sizes.push(size > 0 && Number.isFinite(size) ? size : 1);
    });
    if (!children.length) return null;
    return children.length === 1 ? children[0] : { split: n.split, sizes, children };
  };
  return { tree: walk(node, 0), used };
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
    this.top = new MainArea(this);
    this.bottom = new Row(this, 'bottom');
    this.panelHidden = false;
    this.panelHeight = 0.34; // fraction of the center height
    this.hsash = h('div.sash.horizontal', { onmousedown: e => this.dragPanelSash(e) });
    this.rowsEl = h('div.ws-rows', this.top.el, this.hsash, this.bottom.el);
    this.empty = h('div.ws-empty');
    this.center = h('div.ws-center', this.rowsEl, this.empty);
    const saved = Number(readStored('skiffcode.rightWidth') || 320);
    const width = Number.isFinite(saved) ? Math.max(200, Math.min(window.innerWidth * 0.6, saved)) : 320; // same range as the drag
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
    const lastView = readStored('skiffcode.rightView') || 'files';
    this.showRight(lastView === 'scm' && !fs_isGit(this.root) ? 'files' : lastView);
    this.top.panes[0].renderBar();
    this.focused = this.top.panes[0];
    this.saveSoon = debounce(() => this.saveLayout(), 400);
    this.applyPanel();
  }

  get panes() { return [...this.top.panes, ...this.bottom.panes]; }
  get activeTab() { return this.focused && this.focused.active; }
  allTabs() { return this.panes.flatMap(p => p.tabs); }

  // ---------------------------------------------------------------- panes & tabs

  focusPane(p) {
    if (this.focused === p) return;
    this.focused = p;
    if (p && p.row === this.top) this.lastMain = p; // where "Move to main area" goes
    this.panes.forEach(x => x.el.classList.toggle('focused', x === p));
    this.files.markActive();
    this.app.reportView();
  }

  /** The pane a new tab of this kind goes to: shells → bottom panel, everything else → main area. */
  paneFor(kind) {
    if (kind === 'shell' && store.settings.shellsInPanel) {
      if (this.focused && this.focused.row === this.bottom) return this.focused;
      return this.bottom.panes[0] || this.bottom.addPane();
    }
    if (this.focused && this.focused.row === this.top) return this.focused;
    return this.top.panes[0];
  }

  addTab(tab, opts = {}) {
    // a pane picked before an async step (a new session) may have closed meanwhile
    const pane = opts.pane && this.panes.includes(opts.pane) ? opts.pane : this.paneFor(tab.kind === 'session' && tab.session && tab.session.kind === 'shell' ? 'shell' : tab.kind);
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
    return this.split(tab, 'right');
  }

  /** Moves a tab into a new pane on one side of `target` (its own pane by default). The bottom panel splits right only. */
  split(tab, side, target = tab.pane) {
    const bottom = target.row === this.bottom;
    if (bottom && side !== 'right') return;
    if (target === tab.pane && target.tabs.length < 2) return; // its only tab: nothing would be left behind
    if (!this.canSplit(target, tab)) return toast(bottom ? `Up to ${MAX_PANEL_PANES} panes in the panel` : `Up to ${MAX_MAIN_PANES} panes`);
    const p = bottom ? this.bottom.addPane(this.bottom.panes.indexOf(target) + 1) : this.top.splitPane(target, side);
    this.moveTab(tab, p);
  }

  /** Whether `target` can split for `tab` (null for a file): under the cap, or `tab` empties a pane in the same area so the count stays the same. */
  canSplit(target, tab) {
    if (tab && tab.pane === target && target.tabs.length < 2) return false;
    const row = target.row;
    if (row.panes.length < (row === this.bottom ? MAX_PANEL_PANES : MAX_MAIN_PANES)) return true;
    return !!tab && tab.pane.row === row && tab.pane.tabs.length === 1;
  }

  moveToPanel(tab) {
    if (tab.pane.row === this.bottom) return;
    const p = this.bottom.panes[0] || this.bottom.addPane();
    this.panelHidden = false;
    this.moveTab(tab, p);
  }

  /** To the main pane focused last. */
  moveToMain(tab) {
    const panes = this.top.panes;
    const p = panes.includes(this.lastMain) ? this.lastMain : panes[0];
    if (p !== tab.pane) this.moveTab(tab, p);
  }

  /** The pane right of p in the same row, if any. */
  rightOf(p) {
    if (p.row === this.bottom) return this.bottom.panes[this.bottom.panes.indexOf(p) + 1];
    const s = p.parent;
    const next = s && s.dir === 'row' ? s.children[s.children.indexOf(p) + 1] : null;
    return next instanceof Pane ? next : null;
  }

  dropTab(pane, before, zone) {
    const t = this.dragTab;
    this.dragTab = null;
    if (!t) return;
    if (zone === 'up' && pane.row === this.bottom) return this.moveToMain(t);
    if (zone && zone !== 'center') return this.split(t, zone, pane);
    if (t === before || (t.pane === pane && !before)) return;
    let at = before ? pane.tabs.indexOf(before) : pane.tabs.length;
    if (t.pane === pane && pane.tabs.indexOf(t) < at) at--; // moveTab removes the tab first
    this.moveTab(t, pane, at);
  }

  togglePanel(show = this.panelHidden || !this.bottom.panes.length) {
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

  /** A tab's state changed (each keystroke marks it dirty): update its element, don't rebuild the bar. */
  tabChanged(t) {
    const el = t.tabEl;
    if (!el || !el.isConnected) {
      if (t.pane) t.pane.renderBar();
      return;
    }
    el.classList.toggle('dirty', t.dirty());
    el.classList.toggle('preview', t.pinned === false);
    el.title = t.tooltip();
    el.querySelector('.tab-title').textContent = t.title();
  }

  changed() {
    const has = this.allTabs().length > 0;
    this.empty.classList.toggle('hidden', has);
    this.rowsEl.classList.toggle('hidden', !has);
    if (!has) this.renderEmpty();
    this.files.markActive();
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
        [['quickOpen', 'open file'], ['jump', 'jump'], ['newShell', 'shell']].map(([id, what]) => keyHint(id) ? h('span', h('kbd', keyHint(id)), ` ${what}`) : null),
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
      const next = side && this.rightOf(target);
      if (next) target = next; // a pane already to the right: open there
      t = this.addTab(new FileViewTab(this, path, mode, { preview }), { pane: target });
      if (side && !next && this.canSplit(t.pane, t)) this.splitRight(t);
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
    if (t && t.view.losesEdits()) return this.reveal(t); // rebuilding it would drop the unsaved edits
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
    if (this.autoResumed || !store.settings.autoResume) return;
    this.autoResumed = true;
    for (const s of sessionsIn(this.root).filter(x => x.interrupted && x.state === 'ended')) {
      try {
        await call('sessions.resume', { id: s.id, ...TERM_SIZE });
        const t = this.find(x => x.kind === 'session' && x.sessionId === s.id) || this.openSession(s.id, { activate: false });
        setTimeout(() => { t.attached = false; t.attach(); }, 250);
      } catch { /* leave it stopped */ }
    }
  }

  // ---------------------------------------------------------------- right panel

  showRight(view) {
    this.rightView = view;
    localStorage.setItem('skiffcode.rightView', view);
    const tabs = [['files', 'files', 'Files'], ['scm', 'git', 'Changes'], ['search', 'search', 'Search']];
    clear(this.rightTabs, tabs.map(([id, ic, label]) => h(`button.right-tab${id === view ? '.active' : ''}`, { title: withKey(label, id), onclick: () => this.showRight(id) }, icon(ic), h('span', label), id === 'scm' ? this.scm.badge : null)));
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
    if (this.rightView === 'scm') this.scm.refresh();
    this.syncSessions();
    void this.autoResume();
  }
  hide() {
    this.lastSeen = Date.now();
    this.el.classList.add('hidden');
  }

  saveLayout() {
    const paneSpec = p => {
      const saved = p.tabs.filter(t => t.pinned !== false && t.serialize()); // blank web tabs have nothing to save
      return { tabs: saved.map(t => t.serialize()), active: Math.max(0, saved.indexOf(p.active)) };
    };
    // `top` stays the flat list of main-area panes that older builds read; `main` adds the tree and its sizes.
    const layout = {
      v: 2,
      top: this.top.panes.map(paneSpec),
      main: this.top.spec(),
      bottom: this.bottom.panes.map(p => ({ ...paneSpec(p), flex: p.el.style.flex || '' })),
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
      if (Number.isFinite(layout.panelHeight)) this.panelHeight = Math.max(0.1, Math.min(0.8, layout.panelHeight));
      this.panelHidden = !!layout.panelHidden;
      const fill = (pane, ps, { merge = false } = {}) => {
        const made = (ps && Array.isArray(ps.tabs) ? ps.tabs : []).map(spec => {
          const t = tabFromSpec(this, spec); // null for a session that is gone
          if (!t) return null;
          if (t.kind === 'session') open.add(t.sessionId);
          pane.add(t, { activate: false, index: pane.tabs.length }); // in saved order
          return t;
        });
        if (merge) return;
        const want = made[ps && ps.active] || pane.tabs[0];
        if (want) pane.activate(want);
      };
      const specs = Array.isArray(layout.top) ? layout.top : [];
      let { tree, used } = cleanTree(layout.main, specs.length);
      // no usable tree (a layout from before the tree): the panes side by side, as they were
      if (tree === null) ({ tree, used } = cleanTree({ split: 'row', sizes: specs.map(ps => parseFloat(ps && ps.flex)), children: specs.map((_, i) => i) }, specs.length));
      if (tree !== null) {
        const made = this.top.build(tree);
        specs.forEach((ps, i) => { if (made.has(i)) fill(made.get(i), ps); });
        // panes the tree could not place keep their tabs in the last pane placed
        const last = made.get(used[used.length - 1]);
        specs.forEach((ps, i) => { if (!made.has(i)) fill(last, ps, { merge: true }); });
      }
      for (const ps of Array.isArray(layout.bottom) ? layout.bottom : []) {
        const pane = this.bottom.addPane();
        fill(pane, ps);
        if (ps && ps.flex) pane.el.style.flex = ps.flex;
      }
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
    this.scm.dispose();
    this.el.remove();
  }
}
