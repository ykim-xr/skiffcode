// Right panel: Source Control for this worktree — stage/unstage/discard,
// commit, push/pull, changes vs base, commits on this branch, and the full
// commit history of HEAD in a resizable pane below.
import { h, icon, clear, basename, dirname, relTime, readStored, dirtyCount, STATUS_LETTER, STATUS_LABEL } from './util.js';
import { call, on } from './rpc.js';
import { store, loadStatus } from './store.js';
import { confirmDialog, toast, outputDialog, contextMenu } from './dialogs.js';

const HISTORY_PAGE = 50;
const HISTORY_HEIGHT_KEY = 'skiffcode.scmHistoryHeight';
const DEFAULT_HISTORY_FRAC = 0.4;
const MIN_PART = 90; // px each side of the divider keeps

function savedHistoryFrac() {
  try {
    const v = parseFloat(localStorage.getItem(HISTORY_HEIGHT_KEY));
    if (v > 0.05 && v < 0.95) return v;
  } catch {}
  return DEFAULT_HISTORY_FRAC;
}

export class ScmView {
  constructor(ws) {
    this.ws = ws;
    this.badge = h('span.count-badge.hidden');
    this.el = h('div.right-view.scm-view');
    this.msg = h('textarea.input.commit-msg', {
      placeholder: 'Message (Ctrl+Enter to commit)',
      rows: '3',
      onkeydown: e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          this.commit(false);
        }
      },
    });
    this.body = h('div.scm-body');
    this.header = h('div.scm-branch');
    this.commitBtn = h('button.btn.primary.commit-btn', { onclick: () => this.commit(false) }, icon('check'), 'Commit');
    this.el.append(
      h('div.view-toolbar',
        h('span.view-title', 'Source control'),
        h('button.icon-btn.scm-sync', { title: 'Pull', onclick: () => this.sync('pull') }, icon('pull')),
        h('button.icon-btn.scm-sync', { title: 'Push', onclick: () => this.sync('push') }, icon('push')),
        h('button.icon-btn', { title: 'Refresh', onclick: () => this.refresh() }, icon('refresh'))),
      h('div.scm-top',
        this.header,
        this.commitBox = h('div.commit-box', this.msg,
          h('div.commit-row', this.commitBtn,
            h('button.btn.commit-more', { title: 'More commit options', onclick: e => contextMenu(e, [
              { label: 'Commit all (stage everything first)', action: () => this.commit(true) },
              { label: 'Amend last commit', action: () => this.commit(false, true) },
            ]) }, icon('chevronDown')))),
        this.body),
      this.sash = h('div.sash.horizontal', { onmousedown: e => this.dragSash(e) }),
      this.historyEl = h('div.scm-history', this.historyHead = h('div'), this.historyList = h('div.scm-history-list')));
    this.historyFrac = savedHistoryFrac();
    this.historyEl.style.height = `${this.historyFrac * 100}%`;
    this.hist = { commits: [], more: false };
    this.collapsed = new Set(readStored('skiffcode.scmCollapsed', [], v => { const a = JSON.parse(v); return Array.isArray(a) ? a : []; }));
    this.sel = { section: null, paths: new Set() }; // multi-select lives in one section
    this.anchor = null; // last row clicked without Shift: { section, path }
    this.sectionPaths = {}; // section id -> file paths in display order
    this.openCommits = new Set(); // commits expanded to show their files
    this.commitFiles = new Map(); // sha -> { files, parent } | 'loading' | { error }
    this.off = on('git.changed', e => { if (e.root === this.ws.root) this.refreshSoon(); });
  }

  setCount(n) {
    this.badge.textContent = n ? String(n) : '';
    this.badge.classList.toggle('hidden', !n);
  }

  /** Git changes are followed only while this view is on screen; showing it again refreshes. */
  refreshSoon() {
    if (this.el.classList.contains('hidden') || this.ws.el.classList.contains('hidden')) return;
    clearTimeout(this.t);
    this.t = setTimeout(() => this.refresh(), 150);
  }

  async refresh() {
    const root = this.ws.root;
    try {
      const [s, commits, st, hist] = await Promise.all([
        call('git.status', { root }),
        call('git.commits', { root }).catch(() => ({ commits: [] })),
        loadStatus(root, true),
        // reload as many as are showing so an expanded list doesn't snap back
        call('git.log', { root, skip: 0, max: Math.max(HISTORY_PAGE, this.hist.commits.length) }).catch(() => ({ commits: [], more: false })),
      ]);
      this.status = s;
      this.hist = hist;
      this.setCount(dirtyCount(s));
      this.render(s, commits, st || store.status.get(root));
    } catch (e) {
      clear(this.body, h('div.error.pad', e.message));
    }
  }

  render(s, commits, st) {
    this.last = [s, commits, st];
    this.commitBox.classList.toggle('hidden', !!s.notGit);
    this.el.querySelector('.view-toolbar').classList.toggle('no-git', !!s.notGit);
    const histCollapsed = this.collapsed.has('history');
    this.historyEl.classList.toggle('hidden', !!s.notGit);
    this.historyEl.classList.toggle('collapsed', histCollapsed);
    this.sash.classList.toggle('hidden', !!s.notGit || histCollapsed);
    if (s.notGit) {
      clear(this.header);
      clear(this.body, h('div.scm-notgit',
        h('div', 'This folder isn’t a git repository.'),
        h('div', 'Files, search, Claude sessions and shells all work here. Initialize git to get changes, commits and worktrees.'),
        h('button.btn', { onclick: () => this.ws.app.actions.gitInit(this.ws.root) }, icon('git'), 'Initialize git')));
      return;
    }
    const up = s.upstream
      ? h('span.scm-up', { title: `Tracking ${s.upstream}` }, `${s.upstream}`, s.ahead ? h('span.stat', ` ${s.ahead}↑`) : null, s.behind ? h('span.stat', ` ${s.behind}↓`) : null)
      : h('span.scm-up.muted', 'not pushed yet');
    clear(this.header, icon('branch'), h('b', s.branch || '(detached)'), up);

    const changes = [...s.changes, ...s.untracked];
    this.sectionPaths = { conflicts: s.conflicts.map(f => f.path), staged: s.staged.map(f => f.path), changes: changes.map(f => f.path) };
    if (this.sel.section) {
      const here = new Set(this.sectionPaths[this.sel.section]);
      this.sel.paths = new Set([...this.sel.paths].filter(p => here.has(p)));
      if (!this.sel.paths.size) this.sel.section = null;
    }
    const sections = [];
    if (s.conflicts.length) sections.push(this.section('conflicts', 'Merge conflicts', s.conflicts, 'conflict'));
    if (s.staged.length) sections.push(this.section('staged', 'Staged changes', s.staged, 'staged', [
      h('button.icon-btn', { title: 'Unstage all', onclick: () => this.run('git.unstageAll') }, icon('close')),
    ]));
    sections.push(this.section('changes', 'Changes', changes, 'working', [
      changes.length ? h('button.icon-btn', { title: 'Discard all', onclick: () => this.discard(changes.map(f => f.path)) }, icon('refresh')) : null,
      changes.length ? h('button.icon-btn', { title: 'Stage all', onclick: () => this.run('git.stageAll') }, icon('plus')) : null,
    ]));

    // Branch overview
    const branch = [];
    if (st && st.files > 0) {
      branch.push(h('div.scm-item.review-link', { onclick: () => this.ws.openReview(), title: 'Every change on this branch in one view (editable)' },
        icon('diff'), h('span.scm-name', st.base ? `Changes vs ${st.base}` : 'Uncommitted changes'),
        h('span.scm-dir', `${st.files} file${st.files === 1 ? '' : 's'}`), h('span.add', ` +${st.insertions}`), h('span.del', ` −${st.deletions}`)));
    }
    const cs = commits.commits || [];
    if (commits.base) {
      const commitList = cs.flatMap(c => this.commitRows(c));
      sections.push(h('div.scm-section',
        this.sectionHead('branch', `On this branch (${cs.length} commit${cs.length === 1 ? '' : 's'} not in ${commits.base})`, []),
        this.collapsed.has('branch') ? null : h('div', branch, commitList.length ? commitList : h('div.muted.pad-s', 'No commits yet on this branch.'))));
    } else if (branch.length) {
      // the commit list is the History pane's job when there is no base
      sections.push(h('div.scm-section',
        this.sectionHead('overview', 'Overview', []),
        this.collapsed.has('overview') ? null : h('div', branch)));
    }
    clear(this.body, sections);
    this.renderHistory(histCollapsed);
    this.commitBtn.disabled = false;
  }

  renderHistory(collapsed) {
    clear(this.historyHead, this.sectionHead('history', 'History', []));
    this.historyList.classList.toggle('hidden', collapsed);
    if (collapsed) return;
    const { commits, more } = this.hist;
    clear(this.historyList,
      commits.length ? commits.flatMap(c => this.commitRows(c)) : h('div.muted.pad-s', 'No commits yet.'),
      more ? h('div.scm-more', h('button.btn', { onclick: e => this.loadMore(e.currentTarget) }, 'Load more')) : null);
  }

  async loadMore(btn) {
    const loaded = this.hist.commits.length;
    btn.disabled = true;
    try {
      const r = await call('git.log', { root: this.ws.root, skip: loaded, max: HISTORY_PAGE });
      if (this.hist.commits.length !== loaded) return; // a refresh replaced the list meanwhile
      this.hist = { commits: [...this.hist.commits, ...r.commits], more: r.more };
      this.rerender();
    } catch (e) {
      btn.disabled = false;
      toast(e.message, { kind: 'error' });
    }
  }

  dragSash(e) {
    e.preventDefault();
    const total = this.el.clientHeight;
    const startY = e.clientY;
    const h0 = this.historyEl.offsetHeight;
    const toolbar = this.el.querySelector('.view-toolbar').offsetHeight;
    const move = ev => {
      const px = Math.max(MIN_PART, Math.min(total - toolbar - MIN_PART, h0 - (ev.clientY - startY)));
      this.historyFrac = px / total;
      this.historyEl.style.height = `${this.historyFrac * 100}%`;
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      try { localStorage.setItem(HISTORY_HEIGHT_KEY, String(this.historyFrac)); } catch {}
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  sectionHead(id, title, actions, count) {
    return h('div.scm-section-head', { onclick: e => { if (e.target.closest('button')) return; this.toggleSection(id); } },
      icon(this.collapsed.has(id) ? 'chevronRight' : 'chevronDown', 'twisty'),
      h('span.scm-section-title', title),
      count !== undefined ? h('span.count-badge', String(count)) : null,
      h('span.scm-section-actions', actions));
  }

  toggleSection(id) {
    if (this.collapsed.has(id)) this.collapsed.delete(id);
    else this.collapsed.add(id);
    localStorage.setItem('skiffcode.scmCollapsed', JSON.stringify([...this.collapsed]));
    this.rerender();
  }

  section(id, title, files, kind, actions = []) {
    return h('div.scm-section',
      this.sectionHead(id, title, actions, files.length),
      this.collapsed.has(id) ? null : h('div', files.length ? files.map(f => this.fileRow(f, kind, id)) : h('div.muted.pad-s', 'No changes')));
  }

  /** A commit: click to show/hide its files; click a file for that file's diff in the center. */
  commitRows(c) {
    const open = this.openCommits.has(c.sha);
    const row = h(`div.scm-item.commit-item${open ? '.open' : ''}`, {
      title: `${c.subject}\n${c.short} · ${c.author} · ${new Date(c.time).toLocaleString()}\nClick to show the files it changed`,
      onclick: () => this.toggleCommit(c),
      oncontextmenu: e => contextMenu(e, [
        { label: open ? 'Hide files' : 'Show files', action: () => this.toggleCommit(c) },
        { label: 'Open all changes in one view', icon: 'diff', action: () => this.ws.openCommit(c) },
        { label: 'Copy commit hash', icon: 'link', action: () => navigator.clipboard.writeText(c.sha) },
      ]),
    },
    icon(open ? 'chevronDown' : 'chevronRight', 'twisty'),
    icon('commit'), h('span.scm-name', c.subject), h('span.scm-dir', `${c.short} · ${relTime(c.time)}`));
    if (!open) return [row];
    const info = this.commitFiles.get(c.sha);
    if (!info || info === 'loading') return [row, h('div.muted.commit-file.pad-s', 'Loading…')];
    if (info.error) return [row, h('div.error.commit-file.pad-s', info.error)];
    if (!info.files.length) return [row, h('div.muted.commit-file.pad-s', 'No file changes.')];
    return [row, ...info.files.map(f => {
      const letter = STATUS_LETTER(f.status);
      return h(`div.scm-item.commit-file.g-${letter}`, {
        title: `${f.path}${f.oldPath ? ` (from ${f.oldPath})` : ''} — ${STATUS_LABEL[f.status] || f.status} in ${c.short}`,
        onclick: () => this.openCommitFile(c, info, f),
        oncontextmenu: e => contextMenu(e, [
          { label: 'Open diff', icon: 'diff', action: () => this.openCommitFile(c, info, f) },
          f.status !== 'D' ? { label: 'Open current file', icon: 'file', action: () => this.ws.openFile(f.path) } : null,
        ]),
      },
      icon('file', 'file-type'),
      h('span.scm-name', basename(f.path)),
      h('span.scm-dir', dirname(f.path)),
      h('span.git-letter', STATUS_LETTER(f.status)));
    })];
  }

  async toggleCommit(c) {
    if (this.openCommits.has(c.sha)) this.openCommits.delete(c.sha);
    else {
      this.openCommits.add(c.sha);
      if (!this.commitFiles.has(c.sha) || this.commitFiles.get(c.sha).error) {
        this.commitFiles.set(c.sha, 'loading');
        this.rerender();
        try {
          this.commitFiles.set(c.sha, await call('git.commitFiles', { root: this.ws.root, sha: c.sha }));
        } catch (e) {
          this.commitFiles.set(c.sha, { error: e.message });
        }
      }
    }
    this.rerender();
  }

  openCommitFile(c, info, f) {
    this.ws.openDiff({
      path: f.path,
      oldPath: f.oldPath,
      left: !info.parent || f.status === 'A' ? null : { ref: info.parent },
      right: f.status === 'D' ? null : { ref: c.sha },
      label: c.short,
    });
  }

  rerender() {
    if (this.last) this.render(...this.last);
  }

  /** Files an action on this row applies to: the whole selection if the row is in it, else just the row. */
  targets(sectionId, f) {
    if (this.sel.section !== sectionId || !this.sel.paths.has(f.path)) return [f.path];
    return this.sectionPaths[sectionId].filter(p => this.sel.paths.has(p));
  }

  clickRow(e, sectionId, f, staged) {
    const paths = this.sectionPaths[sectionId];
    if (e.shiftKey) {
      const a = this.anchor && this.anchor.section === sectionId ? paths.indexOf(this.anchor.path) : -1;
      const b = paths.indexOf(f.path);
      const [from, to] = a < 0 ? [b, b] : [Math.min(a, b), Math.max(a, b)];
      this.sel = { section: sectionId, paths: new Set(paths.slice(from, to + 1)) };
      if (a < 0) this.anchor = { section: sectionId, path: f.path };
    } else if (e.ctrlKey || e.metaKey) {
      if (this.sel.section !== sectionId) this.sel = { section: sectionId, paths: new Set() };
      if (!this.sel.paths.delete(f.path)) this.sel.paths.add(f.path);
      this.anchor = { section: sectionId, path: f.path };
    } else {
      this.sel = { section: sectionId, paths: new Set([f.path]) };
      this.anchor = { section: sectionId, path: f.path };
      this.openDiff(f, staged, sectionId === 'conflicts');
    }
    this.rerender();
  }

  fileRow(f, kind, sectionId) {
    const letter = STATUS_LETTER(f.status);
    const staged = kind === 'staged';
    const conflict = kind === 'conflict'; // git restore refuses unmerged files, so no Discard
    const picked = this.sel.section === sectionId && this.sel.paths.has(f.path);
    return h(`div.scm-item.g-${letter}${picked ? '.selected' : ''}`, {
      title: `${f.path} — ${STATUS_LABEL[f.status] || f.status}${staged ? ' (staged)' : ''}`,
      onmousedown: e => { if (e.shiftKey) e.preventDefault(); }, // no text selection while range-selecting
      onclick: e => this.clickRow(e, sectionId, f, staged),
      oncontextmenu: e => {
        if (!(this.sel.section === sectionId && this.sel.paths.has(f.path))) {
          this.sel = { section: sectionId, paths: new Set([f.path]) };
          this.anchor = { section: sectionId, path: f.path };
          this.rerender();
        }
        const t = this.targets(sectionId, f);
        const many = t.length > 1 ? ` ${t.length} files` : '';
        contextMenu(e, [
          { label: 'Open diff', icon: 'diff', action: () => this.openDiff(f, staged, conflict) },
          f.status !== 'D' ? { label: 'Open file', icon: 'file', action: () => this.ws.openFile(f.path) } : null,
          { separator: true },
          staged ? { label: `Unstage${many}`, action: () => this.run('git.unstage', t) } : { label: `Stage${many}`, action: () => this.stage(t, conflict) },
          !staged && !conflict ? { label: many ? `Discard${many}` : 'Discard changes', icon: 'refresh', danger: true, action: () => this.discard(t) } : null,
        ]);
      },
    },
    icon('file', 'file-type'),
    h('span.scm-name', basename(f.path)),
    h('span.scm-dir', dirname(f.path)),
    h('span.scm-actions',
      f.status !== 'D' ? h('button.icon-btn', { title: 'Open file', onclick: e => { e.stopPropagation(); this.ws.openFile(f.path); } }, icon('file')) : null,
      !staged && !conflict ? h('button.icon-btn', { title: 'Discard changes', onclick: e => { e.stopPropagation(); this.discard(this.targets(sectionId, f)); } }, icon('refresh')) : null,
      staged
        ? h('button.icon-btn', { title: 'Unstage', onclick: e => { e.stopPropagation(); this.run('git.unstage', this.targets(sectionId, f)); } }, icon('close'))
        : h('button.icon-btn', { title: 'Stage', onclick: e => { e.stopPropagation(); this.stage(this.targets(sectionId, f), conflict); } }, icon('plus'))),
    h('span.git-letter', STATUS_LETTER(f.status)));
  }

  /** Working changes: index ↔ your file (editable). Staged: HEAD ↔ index (read-only). Conflicted: HEAD ↔ your file (the index has no stage 0 to compare). */
  openDiff(f, staged, conflict = false) {
    if (conflict) {
      this.ws.openDiff({ path: f.path, left: { ref: 'HEAD' }, right: 'live', label: 'Conflict' });
    } else if (staged) {
      this.ws.openDiff({ path: f.path, oldPath: f.oldPath, left: f.status === 'A' ? null : { ref: 'HEAD' }, right: f.status === 'D' ? null : { ref: ':0' }, label: 'Staged' });
    } else {
      const untracked = f.status === '?';
      this.ws.openDiff({ path: f.path, left: untracked ? null : { ref: ':0' }, right: f.status === 'D' ? null : 'live', label: untracked ? 'Untracked' : 'Working tree' });
    }
  }

  async run(method, files) {
    try {
      await call(method, { root: this.ws.root, files });
      this.refresh();
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  }

  /** Staging a conflicted file marks it resolved, markers or not: ask before doing that to several. */
  async stage(files, conflict) {
    if (conflict && files.length > 1) {
      const v = await confirmDialog({
        title: `Mark ${files.length} files as resolved?`,
        detail: 'Staging a file with conflicts marks it resolved, even if conflict markers remain.',
        buttons: [{ label: 'Mark as resolved', value: 'yes', primary: true }],
      });
      if (v !== 'yes') return;
    }
    await this.run('git.stage', files);
  }

  async discard(files) {
    const untracked = new Set((this.status ? this.status.untracked : []).map(f => f.path));
    const n = files.length;
    const delCount = files.filter(f => untracked.has(f)).length;
    const v = await confirmDialog({
      title: n === 1 ? `Discard changes to ${basename(files[0])}?` : `Discard changes to ${n} files?`,
      detail: `${delCount ? `${delCount} untracked file${delCount === 1 ? '' : 's'} will be deleted. ` : ''}This can’t be undone.`,
      buttons: [{ label: 'Discard', value: 'yes', danger: true }],
    });
    if (v === 'yes') await this.run('git.discard', files);
  }

  async commit(all, amend = false) {
    const message = this.msg.value.trim();
    const s = this.status;
    if (!message && !amend) {
      this.msg.focus();
      this.msg.classList.add('invalid');
      setTimeout(() => this.msg.classList.remove('invalid'), 1200);
      return;
    }
    if (s && !all && !amend && !s.staged.length) {
      const changes = s.changes.length + s.untracked.length;
      if (!changes) return toast('Nothing to commit.');
      const v = await confirmDialog({ title: 'No staged changes', detail: `Stage all ${changes} change${changes === 1 ? '' : 's'} and commit them?`, buttons: [{ label: 'Stage all and commit', value: 'all', primary: true }] });
      if (v !== 'all') return;
      all = true;
    }
    this.commitBtn.disabled = true;
    try {
      await call('git.commit', { root: this.ws.root, message: message || undefined, all, amend });
      this.msg.value = '';
      toast(amend ? 'Amended the last commit.' : 'Committed.', { icon: 'check', timeout: 2500 });
      this.refresh();
    } catch (e) {
      toast(e.message, { kind: 'error', timeout: 12000 });
    } finally {
      this.commitBtn.disabled = false;
    }
  }

  async sync(which) {
    const t = toast(which === 'push' ? 'Pushing…' : 'Pulling…', { timeout: 0, icon: which });
    try {
      const r = await call(`git.${which}`, { root: this.ws.root });
      t.remove();
      toast(which === 'push' ? 'Pushed.' : 'Pulled.', { icon: 'check', timeout: 3000, actions: r.output ? [{ label: 'Details', action: () => outputDialog(`git ${which}`, r.output) }] : [] });
      this.refresh();
    } catch (e) {
      t.remove();
      toast(`git ${which} failed`, { kind: 'error', timeout: 0, actions: [{ label: 'Details', action: () => outputDialog(`git ${which}`, e.message) }] });
    }
  }

  dispose() {
    this.off();
  }
}
