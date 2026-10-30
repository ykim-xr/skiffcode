// Right panel: file tree of the worktree, colored by git status.
import { h, icon, clear, basename, dirname } from './util.js';
import { call, on } from './rpc.js';
import { contextMenu, promptDialog, confirmDialog, toast } from './dialogs.js';
import { hasPreview, viewerFor } from './viewers.js';
import { startInternal, isInternal, isExternal, readInternal, takeExternal, uploadInto, moveInto } from './dnd.js';

export class FilesView {
  constructor(ws) {
    this.ws = ws;
    this.el = h('div.right-view.files-view');
    this.tree = h('div.file-tree', { tabindex: '0' });
    // Drop files here: from Explorer / Finder (copy in) or from this panel (move).
    this.tree.addEventListener('dragover', e => this.dragOver(e));
    this.tree.addEventListener('dragleave', e => { if (!this.tree.contains(e.relatedTarget)) this.markDrop(null); });
    this.tree.addEventListener('drop', e => this.drop(e));
    this.el.append(
      h('div.view-toolbar',
        h('span.view-title', basename(ws.root)),
        h('button.icon-btn', { title: 'New file', onclick: () => this.newEntry('', 'file') }, icon('file')),
        h('button.icon-btn', { title: 'New folder', onclick: () => this.newEntry('', 'dir') }, icon('folder')),
        h('button.icon-btn', { title: 'Refresh', onclick: () => this.reloadAll() }, icon('refresh')),
        h('button.icon-btn', { title: 'Collapse all', onclick: () => this.collapseAll() }, icon('chevronRight'))),
      this.tree);
    this.children = new Map(); // dir -> entries
    this.expanded = new Set(['']);
    this.gitMarks = new Map(); // path -> status letter
    this.loaded = false;
    this.off = [
      on('fs.changed', e => {
        if (e.root !== this.ws.root) return;
        const d = e.dir !== undefined ? e.dir : e.path === null ? null : dirname(e.path);
        if (d === null) this.reloadAll();
        else if (this.children.has(d)) this.reloadDir(d);
      }),
      on('git.changed', e => { if (e.root === this.ws.root) this.loadGit(); }),
    ];
  }

  ensure() {
    if (this.loaded) return;
    this.loaded = true;
    for (const d of this.expanded) this.reloadDir(d);
    this.loadGit();
  }

  expandedList() { return [...this.expanded]; }
  restoreExpanded(list) { for (const d of list) this.expanded.add(d); }

  async loadGit() {
    try {
      const s = await call('git.status', { root: this.ws.root });
      this.gitMarks.clear();
      const mark = (p, st) => {
        this.gitMarks.set(p, st);
        let d = dirname(p);
        while (d) {
          if (!this.gitMarks.has(d)) this.gitMarks.set(d, 'dir');
          d = dirname(d);
        }
      };
      for (const f of s.untracked) mark(f.path, 'U');
      for (const f of s.changes) mark(f.path, f.status);
      for (const f of s.staged) if (!this.gitMarks.has(f.path) || this.gitMarks.get(f.path) === 'dir') mark(f.path, f.status);
      for (const f of s.conflicts) mark(f.path, '!');
      this.ws.scm.setCount(s.staged.length + s.changes.length + s.untracked.length + s.conflicts.length);
      this.render();
    } catch { /* not ready */ }
  }

  async reloadDir(d) {
    try {
      const entries = await call('fs.list', { root: this.ws.root, dir: d });
      this.children.set(d, entries);
      void call('fs.watch', { root: this.ws.root, path: d }).catch(() => {});
    } catch {
      this.children.delete(d);
      this.expanded.delete(d);
    }
    this.render();
  }

  reloadAll() {
    for (const d of [...this.children.keys()]) if (this.expanded.has(d)) this.reloadDir(d);
    this.loadGit();
  }

  /** Show a file or folder: expand the folders down to it, scroll to it and flash it. */
  async reveal(rel, isDir = false) {
    this.ws.showRight('files');
    this.loaded = true;
    const parts = rel.split('/').filter(Boolean);
    const dirs = [''];
    for (let i = 1; i <= parts.length - (isDir ? 0 : 1); i++) dirs.push(parts.slice(0, i).join('/'));
    for (const d of dirs) {
      this.expanded.add(d);
      if (!this.children.has(d)) await this.reloadDir(d);
    }
    this.render();
    this.ws.saveSoon();
    const row = [...this.tree.querySelectorAll('.file-row')].find(r => r.dataset.path === rel);
    if (row) {
      row.scrollIntoView({ block: 'center' });
      row.classList.add('flash');
      setTimeout(() => row.classList.remove('flash'), 1500);
    }
  }

  collapseAll() {
    for (const d of this.expanded) if (d) void call('fs.unwatch', { root: this.ws.root, path: d }).catch(() => {});
    this.expanded = new Set(['']);
    this.render();
    this.ws.saveSoon();
  }

  toggle(d) {
    if (this.expanded.has(d)) {
      this.expanded.delete(d);
      void call('fs.unwatch', { root: this.ws.root, path: d }).catch(() => {});
      this.render();
    } else {
      this.expanded.add(d);
      if (this.children.has(d)) this.render();
      this.reloadDir(d);
    }
    this.ws.saveSoon();
  }

  render() {
    const rows = [];
    const walk = (d, depth) => {
      for (const e of this.children.get(d) || []) {
        const st = this.gitMarks.get(e.path);
        const open = e.type === 'dir' && this.expanded.has(e.path);
        const active = this.ws.activeTab && (this.ws.activeTab.kind === 'file' || (this.ws.activeTab.kind === 'view' && this.ws.activeTab.mode !== 'html')) && this.ws.activeTab.path === e.path;
        rows.push(h(`div.file-row${e.ignored ? '.ignored' : ''}${active ? '.active' : ''}${st && st !== 'dir' ? `.g-${st === '?' ? 'U' : st}` : st === 'dir' ? '.g-dir' : ''}`, {
          style: { paddingLeft: `${8 + depth * 12}px` },
          title: e.path,
          onclick: () => (e.type === 'dir' ? this.toggle(e.path) : this.ws.openFile(e.path, { preview: true })),
          ondblclick: () => e.type !== 'dir' && this.ws.openFile(e.path),
          oncontextmenu: ev => contextMenu(ev, this.menu(e)),
          draggable: 'true',
          ondragstart: ev => startInternal(ev, this.ws.root, e),
          dataset: { path: e.path, type: e.type },
        },
        e.type === 'dir' ? icon(open ? 'chevronDown' : 'chevronRight', 'twisty') : h('span.twisty-space'),
        icon(e.type === 'dir' ? 'folder' : 'file', 'file-type'),
        h('span.file-name', e.name),
        st && st !== 'dir' ? h('span.git-letter', st === '?' ? 'U' : st) : null));
        if (open) walk(e.path, depth + 1);
      }
    };
    walk('', 0);
    clear(this.tree, rows.length ? rows : h('div.muted.pad', this.loaded ? 'Empty folder' : 'Loading…'));
  }

  /** The folder a drop at this point goes into ('' = the top folder). */
  dropDir(e) {
    const row = e.target.closest && e.target.closest('.file-row');
    if (!row) return '';
    return row.dataset.type === 'dir' ? row.dataset.path : dirname(row.dataset.path);
  }

  markDrop(dir) {
    for (const el of this.tree.querySelectorAll('.drop-into')) el.classList.remove('drop-into');
    this.tree.classList.toggle('drop-root', dir === '');
    if (dir) {
      const row = [...this.tree.querySelectorAll('.file-row')].find(r => r.dataset.path === dir);
      if (row) row.classList.add('drop-into');
    }
  }

  dragOver(e) {
    if (!isInternal(e) && !isExternal(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = isInternal(e) ? 'move' : 'copy';
    const dir = this.dropDir(e);
    this.markDrop(dir);
    // hovering a closed folder opens it, like VS Code
    if (dir && !this.expanded.has(dir)) {
      if (this.hoverDir !== dir) {
        this.hoverDir = dir;
        clearTimeout(this.hoverT);
        this.hoverT = setTimeout(() => { if (this.hoverDir === dir && !this.expanded.has(dir)) this.toggle(dir); }, 700);
      }
    } else this.hoverDir = null;
  }

  async drop(e) {
    if (!isInternal(e) && !isExternal(e)) return;
    e.preventDefault();
    clearTimeout(this.hoverT);
    const dir = this.dropDir(e);
    this.markDrop(null);
    if (isInternal(e)) {
      const it = readInternal(e);
      if (it && it.root === this.ws.root) await moveInto(this.ws, it.path, dir);
      return;
    }
    const items = await takeExternal(e)();
    if (dir) this.expanded.add(dir);
    await uploadInto(this.ws, dir, items);
    await this.reloadDir(dir);
  }

  menu(e) {
    const dir = e.type === 'dir' ? e.path : dirname(e.path);
    return [
      e.type === 'file' ? { label: 'Open', icon: 'file', action: () => this.ws.openFile(e.path) } : null,
      e.type === 'file' ? { label: 'Open to the side', icon: 'split', action: async () => { const t = await this.ws.openFile(e.path); this.ws.splitRight(t); } } : null,
      e.type === 'file' && hasPreview(e.path) ? { label: 'Open preview', icon: 'eye', action: () => this.ws.openPreview(e.path) } : null,
      e.type === 'file' && viewerFor(e.path) ? { label: 'Open as text', icon: 'code', action: () => this.ws.openFile(e.path, { asText: true }) } : null,
      { label: 'New file…', icon: 'file', action: () => this.newEntry(dir, 'file') },
      { label: 'New folder…', icon: 'folder', action: () => this.newEntry(dir, 'dir') },
      { separator: true },
      { label: 'Rename…', icon: 'edit', action: () => this.rename(e) },
      { label: 'Copy path', icon: 'link', action: () => navigator.clipboard.writeText(`${this.ws.root}/${e.path}`) },
      { label: 'Copy relative path', action: () => navigator.clipboard.writeText(e.path) },
      { separator: true },
      { label: 'Delete', icon: 'trash', danger: true, action: () => this.remove(e) },
    ];
  }

  async newEntry(dir, type) {
    const name = await promptDialog({ title: type === 'dir' ? 'New folder' : 'New file', placeholder: dir ? `${dir}/…` : 'name', detail: dir ? `In ${dir}/` : undefined });
    if (!name) return;
    const p = dir ? `${dir}/${name}` : name;
    try {
      await call('fs.create', { root: this.ws.root, path: p, type });
      if (dir) this.expanded.add(dir);
      await this.reloadDir(dirname(p));
      if (type === 'file') this.ws.openFile(p);
    } catch (err) {
      toast(err.message, { kind: 'error' });
    }
  }

  async rename(e) {
    const to = await promptDialog({ title: `Rename ${e.name}`, value: e.path, okLabel: 'Rename' });
    if (!to || to === e.path) return;
    try {
      await call('fs.rename', { root: this.ws.root, from: e.path, to });
      this.reloadDir(dirname(e.path));
      if (dirname(to) !== dirname(e.path)) this.reloadDir(dirname(to));
    } catch (err) {
      toast(err.message, { kind: 'error' });
    }
  }

  async remove(e) {
    const ok = await confirmDialog({ title: `Delete ${e.name}?`, detail: `${e.path}${e.type === 'dir' ? ' and everything in it' : ''} will be deleted from disk.`, buttons: [{ label: 'Delete', value: 'yes', danger: true }] });
    if (ok !== 'yes') return;
    try {
      await call('fs.delete', { root: this.ws.root, path: e.path });
      this.reloadDir(dirname(e.path));
    } catch (err) {
      toast(err.message, { kind: 'error' });
    }
  }

  dispose() {
    this.off.forEach(f => f());
  }
}
