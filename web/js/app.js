// SkiffCode app: wires the sidebar, workspaces, palettes, shortcuts and alerts.
import { h, icon, clear, basename, dirname, tildify, languageOf } from './util.js';
import { call, connect, on, connected } from './rpc.js';
import { store, applySnapshot, loadAll, loadWorktrees, loadStatus, allWorktrees, worktree, sessionsIn, session, needsYou, subscribe } from './store.js';
import { initSidebar, STATE_ICON, stateLabel, claudeIcon, sessionIcon } from './sidebar.js';
import { notify as sidebarRefresh } from './store.js';
import { Workspace } from './workspace.js';
import { quickPick, promptDialog, confirmDialog, toast, contextMenu } from './dialogs.js';
import { handleAlert, updateTitle, askNotifications, notificationsAllowed, playSound } from './alerts.js';
import * as models from './models.js';
import { newWorktreeDialog } from './worktree-dialog.js';
import { usageItem, accountsDialog, accountName } from './accounts.js';
import { resumeDialog, offerPastConversations } from './resume-dialog.js';
import { applyColors, colorsDialog, defineEditorTheme } from './colors.js';
import { addRepoDialog } from './add-repo-dialog.js';
import { soundsDialog } from './sounds-dialog.js';
import { openLink } from './viewers.js';

const app = {
  workspaces: new Map(),
  active: null, // Workspace
};
window.skiffcode = app; // handy for debugging and tests

// ------------------------------------------------------------------ boot

async function loadMonaco() {
  await new Promise((resolve, reject) => {
    window.require.config({ paths: { vs: '/vendor/monaco/vs' } });
    window.MonacoEnvironment = { getWorkerUrl: () => '/vendor/monaco/vs/base/worker/workerMain.js' };
    window.require(['vs/editor/editor.main'], resolve, reject);
  });
  defineEditorTheme(); // background follows Settings → Panel colors
  // Plain colors only: no red squiggles from Monaco's partial view of your project.
  for (const d of [monaco.languages.typescript.typescriptDefaults, monaco.languages.typescript.javascriptDefaults]) {
    d.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
    d.setCompilerOptions({ allowJs: true, jsx: monaco.languages.typescript.JsxEmit.Preserve, allowNonTsExtensions: true, target: monaco.languages.typescript.ScriptTarget.ESNext });
  }
  // F12 / Ctrl+click for every language: search the worktree for where the word is defined.
  monaco.languages.registerDefinitionProvider('*', {
    async provideDefinition(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word || model.uri.scheme !== 'file') return [];
      const ws = workspaceForUri(model.uri);
      if (!ws) return [];
      const fromFile = model.uri.path.slice(ws.root.length + 1);
      const res = await call('search.definition', { root: ws.root, symbol: word.word, lang: model.getLanguageId(), fromFile }).catch(() => []);
      return res.map(r => ({ uri: monaco.Uri.from({ scheme: 'file', path: `${ws.root}/${r.file}` }), range: new monaco.Range(r.line, r.col, r.line, r.col + word.word.length) }));
    },
  });
  // Shift+F12-ish: find all references of the word (plain text search, whole word).
  monaco.languages.registerReferenceProvider('*', {
    async provideReferences(model, position) {
      const word = model.getWordAtPosition(position);
      const ws = word && workspaceForUri(model.uri);
      if (!ws) return [];
      const r = await call('search.text', { root: ws.root, query: word.word, word: true, caseSensitive: true }).catch(() => ({ results: [] }));
      return r.results.flatMap(f => f.matches.map(m => ({ uri: monaco.Uri.from({ scheme: 'file', path: `${ws.root}/${f.file}` }), range: new monaco.Range(m.line, m.col, m.line, m.col + m.len) })));
    },
  });
  // Ctrl+click on a link in the editor: a SkiffCode tab (or the browser, per settings)
  if (monaco.editor.registerLinkOpener) {
    monaco.editor.registerLinkOpener({
      open(resource) {
        const uri = String(resource);
        if (!/^https?:/i.test(uri)) return false;
        openLink(app, uri, { ctrlKey: true }); // the editor follows links on Ctrl+click
        return true;
      },
    });
  }
  // Opening another file from "go to definition" opens a SkiffCode tab.
  monaco.editor.registerEditorOpener({
    openCodeEditor(_src, uri, sel) {
      const ws = workspaceForUri(uri);
      if (!ws) return false;
      const line = sel && (sel.startLineNumber || sel.lineNumber);
      const col = sel && (sel.startColumn || sel.column);
      void ws.openFile(uri.path.slice(ws.root.length + 1), { line, col });
      return true;
    },
  });
}

function workspaceForUri(uri) {
  for (const ws of app.workspaces.values()) if (uri.path.startsWith(ws.root + '/')) return ws;
  return null;
}

async function boot() {
  const status = document.getElementById('boot-status');
  try {
    await Promise.all([loadMonaco(), connect()]);
  } catch (e) {
    status.textContent = `Couldn’t start: ${e.message || e}`;
    return;
  }
  const hello = await call('hello');
  applySnapshot(hello);
  store.home = hello.home;
  document.getElementById('boot').remove();
  initSidebar(document.getElementById('sidebar'), actions);
  await loadAll();
  const last = new URLSearchParams(location.search).get('folder') || localStorage.getItem('skiffcode.active');
  const wt = last && (worktree(last) || allWorktrees().find(w => w.path === last));
  if (wt) await openWorktree(wt.path);
  else if (allWorktrees().length) await openWorktree(allWorktrees()[0].path);
  else renderNothing();
  if (new URLSearchParams(location.search).has('folder')) history.replaceState(null, '', '/');
  updateStatusBar();
  maybeAskNotifications();
}

function renderNothing() {
  clear(document.getElementById('nothing'), h('div.empty-inner',
    h('div.empty-title', 'Welcome to SkiffCode'),
    h('p.muted', 'Add a git repository (or any folder) to see its worktrees, Claude sessions and files here.'),
    h('div.empty-actions', h('button.btn.primary', { onclick: () => actions.addRepo() }, icon('plus'), 'Add repository'))));
  document.getElementById('nothing').classList.remove('hidden');
}

// ------------------------------------------------------------------ worktrees

async function openWorktree(p) {
  let wt = worktree(p);
  if (!wt) {
    // Just added / created: refresh what we know first.
    applySnapshot(await call('hello'));
    for (const r of store.repos) await loadWorktrees(r.path);
    wt = worktree(p);
  }
  if (!wt) return toast(`${p} isn’t a worktree of a repository in SkiffCode.`, { kind: 'error' });
  let ws = app.workspaces.get(p);
  if (!ws) {
    ws = new Workspace(app, wt);
    app.workspaces.set(p, ws);
    document.getElementById('workspaces').append(ws.el);
    ws.restore();
  }
  if (app.active && app.active !== ws) app.active.hide();
  app.active = ws;
  store.active = p;
  localStorage.setItem('skiffcode.active', p);
  document.getElementById('nothing').classList.add('hidden');
  ws.show();
  reportView();
  updateStatusBar();
  maybeOfferPast(wt.repo);
  // forget workspaces of worktrees that no longer exist
  for (const [k, w] of app.workspaces) if (!worktree(k)) { w.dispose(); app.workspaces.delete(k); }
  return ws;
}
app.openWorktree = openWorktree;

/** A repo you just added (from the app or `skiffcode <dir>`) may already have Claude conversations: say so once. */
const offered = new Set();
function maybeOfferPast(repo) {
  if (!repo || !repo.addedAt || Date.now() - repo.addedAt > 5 * 60_000 || offered.has(repo.path)) return;
  offered.add(repo.path);
  try {
    if (localStorage.getItem(`skiffcode.offered:${repo.path}`)) return;
    localStorage.setItem(`skiffcode.offered:${repo.path}`, '1');
  } catch { /* storage unavailable: once per page load is fine */ }
  void offerPastConversations(app, ((store.worktrees.get(repo.path) || {}).list || []).filter(w => !w.prunable));
}

/**
 * Free the browser side (editors, terminal views, file tree) of worktrees you haven't
 * opened for a while. Their sessions keep running on the server; clicking the worktree
 * rebuilds it from its saved layout. Worktrees with unsaved files are kept.
 */
function unloadIdle(force = false) {
  const mins = Number(store.settings.unloadAfterMinutes ?? 30);
  if (!force && !(mins > 0)) return 0;
  let n = 0;
  for (const [p, ws] of app.workspaces) {
    if (ws === app.active) continue;
    if (!force && Date.now() - (ws.lastSeen || 0) < mins * 60_000) continue;
    if (ws.allTabs().some(t => t.dirty())) continue;
    ws.saveLayout();
    ws.dispose();
    app.workspaces.delete(p);
    n++;
  }
  if (n) updateStatusBar();
  return n;
}
app.unloadIdle = unloadIdle;
setInterval(() => unloadIdle(), 60_000);

// Memory readout: the SkiffCode server, this window, and each session (Claude + what it runs).
let memory = null;
async function refreshMemory() {
  try {
    memory = await call('system.memory');
    memory.page = performance.memory ? performance.memory.usedJSHeapSize : 0;
    memory.at = Date.now();
  } catch { /* offline */ }
}
setInterval(() => { if (!document.hidden) void refreshMemory().then(updateStatusBar); }, 30_000);
setTimeout(() => void refreshMemory().then(updateStatusBar), 1500);

const mb = n => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`);
function memoryItem() {
  if (!memory) return null;
  const per = memory.sessions || {};
  const ids = Object.keys(per);
  const claude = ids.filter(id => (session(id) || {}).kind === 'claude');
  const sum = list => list.reduce((a, id) => a + per[id], 0);
  const total = memory.server + memory.page + sum(ids);
  const loaded = app.workspaces.size;
  const all = allWorktrees().length;
  const mins = Number(store.settings.unloadAfterMinutes ?? 30);
  const top = claude.sort((a, b) => per[b] - per[a]).slice(0, 5).map(id => `   ${mb(per[id])}  ${(session(id) || {}).name}`);
  const tip = [
    `SkiffCode + sessions: ${mb(total)}`,
    `  Claude sessions (${claude.length}): ${mb(sum(claude))}`,
    ...top,
    `  Shells (${ids.length - claude.length}): ${mb(sum(ids.filter(id => !claude.includes(id))))}`,
    `  SkiffCode server: ${mb(memory.server)}`,
    memory.page ? `  This window (scripts): ${mb(memory.page)}` : '',
    `Worktrees loaded in this window: ${loaded} of ${all}`,
    mins > 0 ? `Worktrees unused for ${mins} min are unloaded (sessions keep running).` : 'Unloading idle worktrees is off (Settings).',
    'Click to unload all other worktrees now',
  ].filter(Boolean).join('\n');
  return h('span.sb-item.click', {
    title: tip,
    onclick: () => {
      const n = unloadIdle(true);
      toast(n ? `Unloaded ${n} worktree${n > 1 ? 's' : ''}. Their sessions keep running.` : 'Nothing to unload (open or unsaved worktrees are kept).', { timeout: 3000 });
      void refreshMemory().then(updateStatusBar);
    },
  }, icon('chip'), mb(total), h('span.sb-dim', ` · ${loaded}/${all}`));
}

function stepWorktree(dir) {
  const list = orderedWorktrees();
  if (!list.length) return;
  const i = list.findIndex(w => w.path === store.active);
  const next = list[(i + dir + list.length) % list.length];
  void openWorktree(next.path);
}

/** Worktrees in sidebar order. */
function orderedWorktrees() {
  const repos = [...store.groups.flatMap(g => store.repos.filter(r => r.group === g.id)), ...store.repos.filter(r => !r.group || !store.groups.some(g => g.id === r.group))];
  return repos.flatMap(r => ((store.worktrees.get(r.path) || {}).list || []).map(w => ({ ...w, repo: r })));
}

// ------------------------------------------------------------------ actions

const sizeHint = () => ({ cols: 120, rows: 32 });

/** Wait until the server's state push includes a just-created session. */
async function waitForSession(id) {
  for (let i = 0; i < 40 && !session(id); i++) await new Promise(r => setTimeout(r, 50));
  if (!session(id)) applySnapshot(await call('hello'));
}

/** "Also delete Claude's saved conversations (N)" for a remove dialog; null when there are none. */
async function purgeCheckbox(folders) {
  const n = await call('claude.countConversations', { folders }).catch(() => 0);
  if (!n) return null;
  const input = h('input', { type: 'checkbox' });
  return { input, el: h('label.purge-check', input, ` Also delete Claude’s saved conversations for it (${n}), so they’re gone from /resume`) };
}

const actions = {
  openWorktree,
  isSessionFocused: id => !!(app.active && app.active.activeTab && app.active.activeTab.kind === 'session' && app.active.activeTab.sessionId === id),

  async addRepo() {
    const p = await addRepoDialog();
    if (!p) return;
    try {
      const repo = await call('repos.add', { path: p.replace(/^~(?=\/|$)/, store.home) });
      await loadWorktrees(repo.path);
      const wts = (store.worktrees.get(repo.path) || {}).list || [];
      if (wts[0]) await openWorktree(wts[0].path);
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  },

  resumeConversation(worktreePath, value) {
    const p = worktreePath || store.active;
    if (!p) return toast('Open a worktree first.', { kind: 'warn' });
    return resumeDialog(app, p, { value });
  },

  async gitInit(p) {
    try {
      await call('git.init', { root: p });
      const r = store.repos.find(x => x.path === p);
      applySnapshot(await call('hello'));
      if (r) await loadWorktrees(r.path);
      toast('Initialized a git repository here.', { icon: 'git', timeout: 3000 });
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  },

  async removeRepo(r) {
    const folders = [r.path, ...((store.worktrees.get(r.path) || {}).list || []).map(w => w.path)];
    const purge = await purgeCheckbox(folders);
    const v = await confirmDialog({ title: `Remove ${r.name} from SkiffCode?`, detail: h('div', h('p', 'The folder stays on disk. Its sessions are stopped.'), purge && purge.el), buttons: [{ label: 'Remove from list', value: 'yes', primary: true }] });
    if (v !== 'yes') return;
    if (purge && purge.input.checked) await call('claude.purgeFolders', { folders });
    await call('repos.remove', { path: r.path });
  },

  async deleteRepo(r) {
    const info = await call('repos.deleteInfo', { path: r.path });
    if (!info.safe) return toast(`SkiffCode won’t delete ${r.path}.`, { kind: 'error' });
    const folders = [r.path, ...info.linked.map(l => l.path)];
    const purge = await purgeCheckbox(folders);
    const v = await confirmDialog({
      title: `Delete ${r.name} from disk?`,
      detail: h('div', h('p', 'This permanently deletes:'), h('ul', h('li', h('code', tildify(r.path, store.home))), info.linked.map(w => h('li', h('code', tildify(w.path, store.home)), ` (worktree ${w.branch || ''})`))),
        info.sessions ? h('p', `${info.sessions} session(s) will be stopped.`) : null,
        info.unpushed ? h('p.warn', `⚠ ${info.unpushed} commit(s) on local branches aren’t on any remote and will be lost.`) : null,
        h('p', 'This can’t be undone.'),
        purge && purge.el),
      typed: r.name,
      buttons: [{ label: 'Delete forever', value: 'yes', danger: true }],
    });
    if (v !== 'yes') return;
    const t = toast(`Deleting ${r.name}…`, { timeout: 0 });
    try {
      if (purge && purge.input.checked) await call('claude.purgeFolders', { folders });
      await call('repos.delete', { path: r.path, confirm: r.name });
      for (const [k, w] of app.workspaces) if (k === r.path || info.linked.some(l => l.path === k)) { w.dispose(); app.workspaces.delete(k); }
      if (app.active && !app.workspaces.has(app.active.root)) { app.active = null; store.active = null; renderNothing(); }
      toast(`Deleted ${r.name}.`, { icon: 'trash' });
    } catch (e) {
      toast(e.message, { kind: 'error' });
    } finally {
      t.remove();
    }
  },

  refreshRepo: r => loadWorktrees(r.path),

  async newGroup(repo) {
    const name = await promptDialog({ title: 'New group', placeholder: 'Work, Personal, Archive…', okLabel: 'Create' });
    if (name) await call('groups.create', { name, repo: repo && repo.path });
  },
  async renameGroup(g) {
    const name = await promptDialog({ title: 'Rename group', value: g.name, okLabel: 'Rename' });
    if (name) await call('groups.rename', { id: g.id, name });
  },
  async deleteGroup(g) {
    const v = await confirmDialog({ title: `Delete group “${g.name}”?`, detail: 'Its repositories move out of the group. Nothing is deleted from disk.', buttons: [{ label: 'Delete group', value: 'yes', danger: true }] });
    if (v === 'yes') await call('groups.delete', { id: g.id });
  },
  async moveToGroup(r) {
    const v = await quickPick([
      ...store.groups.map(g => ({ label: g.name, icon: 'group', value: g.id, description: g.id === r.group ? 'current' : '' })),
      { label: 'New group…', icon: 'plus', value: '__new', alwaysShow: true },
      { label: 'No group', icon: 'close', value: '__none', alwaysShow: true },
    ], { placeholder: `Move ${r.name} to…` });
    if (v === undefined) return;
    if (v === '__new') return actions.newGroup(r);
    await call('repos.setGroup', { path: r.path, group: v === '__none' ? null : v });
  },

  async newWorktree(r) {
    const params = await newWorktreeDialog(r);
    if (!params) return;
    const t = toast(`Creating worktree ${params.newBranch || params.branch}…`, { timeout: 0, icon: 'branch' });
    try {
      const res = await call('worktrees.create', { repo: r.path, ...params, ...sizeHint() });
      await loadWorktrees(r.path);
      if (res.session) await waitForSession(res.session);
      const ws = await openWorktree(res.path);
      if (res.session && ws) ws.openSession(res.session);
    } catch (e) {
      toast(e.message, { kind: 'error', timeout: 12000 });
    } finally {
      t.remove();
    }
  },

  async removeWorktree(r, w) {
    const info = await call('worktrees.removeInfo', { repo: r.path, path: w.path });
    const purge = await purgeCheckbox([w.path]);
    const detail = h('div',
      h('p', h('code', tildify(w.path, store.home)), ' will be deleted.'),
      info.sessions ? h('p', `${info.sessions} session(s) and shell(s) in it will be stopped.`) : null,
      info.dirty ? h('p.warn', `⚠ ${info.dirty} uncommitted or untracked file(s) will be discarded.`) : null,
      info.unpushed && w.branch ? h('p', `${info.unpushed} commit(s) on ${w.branch} aren’t on a remote — kept unless you also delete the branch.`) : null,
      info.locked ? h('p', 'The worktree is locked; it will be force-removed.') : null,
      purge && purge.el);
    const buttons = [{ label: 'Remove worktree', value: 'keep', danger: !!info.dirty, primary: !info.dirty }];
    if (w.branch) buttons.unshift({ label: 'Remove + delete branch', value: 'branch', danger: true });
    const v = await confirmDialog({ title: `Remove worktree “${w.branch || basename(w.path)}”?`, detail, buttons });
    if (!v) return;
    const t = toast('Removing worktree…', { timeout: 0 });
    try {
      if (purge && purge.input.checked) await call('claude.purgeFolders', { folders: [w.path] });
      const wasActive = store.active === w.path;
      const res = await call('worktrees.remove', { repo: r.path, path: w.path, deleteBranch: v === 'branch' });
      const ws = app.workspaces.get(w.path);
      if (ws) { ws.dispose(); app.workspaces.delete(w.path); }
      await loadWorktrees(r.path);
      if (wasActive) {
        const main = (store.worktrees.get(r.path) || {}).list?.[0];
        if (main) await openWorktree(main.path);
      }
      if (res.branch === 'unmerged') {
        const f = await confirmDialog({ title: `Branch ${res.branchName} isn’t merged`, detail: 'Delete it anyway? Its unmerged commits will be lost.', buttons: [{ label: 'Delete branch', value: 'yes', danger: true }] });
        if (f === 'yes') await call('branches.delete', { repo: r.path, branch: res.branchName, force: true });
      }
    } catch (e) {
      toast(e.message, { kind: 'error' });
    } finally {
      t.remove();
    }
  },

  async newSession(worktreePath, kind = 'claude', { pane, name } = {}) {
    const p = worktreePath || store.active;
    if (!p) return toast('Open a worktree first.');
    if (kind === 'claude' && name === undefined && store.settings.askSessionName !== false) {
      // Name it now (Enter keeps the suggestion); Claude gets the same name
      const wt = worktree(p);
      const base = (wt && wt.branch) || basename(p);
      const n = sessionsIn(p).filter(x => x.kind === 'claude').length;
      name = await promptDialog({ title: 'New Claude session', value: n ? `${base} ${n + 1}` : base, okLabel: 'Start', detail: 'A name for this session. Claude uses it too (its prompt bar and /resume).' });
      if (!name) return;
    }
    try {
      const s = await call('sessions.create', { kind, worktreePath: p, name, ...sizeHint() });
      await waitForSession(s.id);
      const ws = await openWorktree(p);
      if (ws) ws.openSession(s.id, { pane });
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  },

  async focusSession(id) {
    if (!session(id)) await waitForSession(id); // just created: the state push may still be on its way
    const s = session(id);
    if (!s) return;
    const ws = await openWorktree(s.worktreePath);
    if (ws) ws.openSession(id);
  },
  async resumeSession(id) {
    const s = session(id);
    if (!s) return;
    await call('sessions.resume', { id, ...sizeHint() });
    const ws = await openWorktree(s.worktreePath);
    if (ws) {
      const t = ws.openSession(id);
      setTimeout(() => t.attach && t.attach(), 200);
    }
  },
  async stopSession(id) {
    await call('sessions.stop', { id });
  },
  /** Ask before closing a running Claude session; shells and stopped sessions close right away. */
  async confirmCloseSession(s) {
    if (!s || s.kind !== 'claude' || s.state === 'ended') return true;
    const busy = s.state === 'working' || s.state === 'question' || s.state === 'permission';
    const v = await confirmDialog({
      title: `Close “${s.name}”?`,
      detail: `${busy ? 'Claude is still working in it. ' : ''}Claude will stop and the session is removed from SkiffCode. The conversation stays on disk (claude --resume).`,
      buttons: [{ label: 'Close session', value: 'yes', danger: true }],
    });
    return v === 'yes';
  },
  /** Close from the sidebar: stops it, removes it, and closes its tab. */
  async closeSession(s) {
    if (!(await actions.confirmCloseSession(s))) return;
    for (const ws of app.workspaces.values()) {
      const t = ws.find(x => x.kind === 'session' && x.sessionId === s.id);
      if (t) ws.hideTab(t);
    }
    await call('sessions.forget', { id: s.id });
  },
  /** Delete a session completely: also Claude's saved conversation (gone from /resume). */
  async purgeSession(s) {
    if (!s) return;
    const claude = s.kind === 'claude';
    const v = await confirmDialog({
      title: `Delete “${s.name}”${claude ? ' and its conversation' : ''}?`,
      detail: claude
        ? 'Stops the session, removes it from SkiffCode and deletes Claude’s saved conversation, so it no longer appears in /resume or “Resume conversation”. This can’t be undone.'
        : 'Stops the shell and removes it.',
      buttons: [{ label: claude ? 'Delete session and conversation' : 'Delete', value: 'yes', danger: true }],
    });
    if (v !== 'yes') return;
    for (const ws of app.workspaces.values()) {
      const t = ws.find(x => x.kind === 'session' && x.sessionId === s.id);
      if (t) ws.hideTab(t);
    }
    try {
      await call('sessions.purge', { id: s.id });
      toast(claude ? `Deleted “${s.name}” and its conversation.` : `Deleted “${s.name}”.`, { icon: 'trash', timeout: 3000 });
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  },
  forgetSession(s) {
    return actions.closeSession(s);
  },
  async renameSession(s) {
    const name = await promptDialog({ title: 'Rename session', value: s.name, okLabel: 'Rename' });
    if (!name || name === s.name) return;
    // Update the tab and the sidebar right away; the server confirms.
    const local = session(s.id);
    if (local) local.name = name;
    for (const ws of app.workspaces.values()) ws.syncSessions();
    sidebarRefresh();
    await call('sessions.rename', { id: s.id, name });
  },

  reviewChanges: async p => { const ws = await openWorktree(p); if (ws) ws.openReview(); },

  async quickOpen() {
    const ws = app.active;
    if (!ws) return;
    const files = await call('search.files', { root: ws.root });
    const v = await quickPick(files.map(f => ({ label: basename(f), description: dirname(f), value: f, icon: 'file' })), { placeholder: `Open a file in ${basename(ws.root)}` });
    if (v) ws.openFile(v);
  },

  async jump() {
    const items = [];
    const order = { question: 0, permission: 0, working: 2, idle: 3, starting: 4, running: 5, ended: 6 };
    const list = [...store.sessions].sort((a, b) => Number(!!b.unread) - Number(!!a.unread) || order[a.state] - order[b.state] || b.createdAt - a.createdAt);
    if (list.length) items.push({ separator: true, label: 'Sessions' });
    for (const s of list) {
      const [ic, cls] = STATE_ICON[s.state] || STATE_ICON.ended;
      const repo = (store.repos.find(r => r.path === s.repoPath) || {}).name || '';
      const acct = (store.accounts || []).length > 1 && s.kind === 'claude' ? ` · ${accountName(s.account)}` : '';
      items.push({ label: `${s.unread ? '● ' : ''}${s.name}`, description: `${repo}${s.branch ? ` / ${s.branch}` : ''}${acct}`, detail: s.kind === 'shell' ? 'shell' : stateLabel(s), icon: sessionIcon(s), value: { session: s.id } });
    }
    items.push({ separator: true, label: 'Worktrees' });
    for (const w of orderedWorktrees()) items.push({ label: w.branch || basename(w.path), description: w.repo.name, detail: w.path === store.active ? 'open' : '', icon: w.isMain ? 'home' : 'branch', value: { wt: w.path } });
    const v = await quickPick(items, { placeholder: 'Jump to a session or worktree' });
    if (!v) return;
    if (v.session) actions.focusSession(v.session);
    else openWorktree(v.wt);
  },

  nextNeedsYou() {
    const list = store.sessions.filter(s => needsYou(s.state) || s.unread).sort((a, b) => Number(needsYou(b.state)) - Number(needsYou(a.state)) || a.changedAt - b.changedAt);
    if (!list.length) return toast('Nothing needs you right now.', { timeout: 2000 });
    actions.focusSession(list[0].id);
  },

  async openWebPage() {
    const ws = app.active;
    if (!ws) return toast('Open a worktree first.');
    const url = await promptDialog({ title: 'Open web page or file', placeholder: 'localhost:3000, https://…, or a file path (/home/…, C:\\…, \\\\wsl.localhost\\…)', okLabel: 'Open' });
    if (url && url.trim()) ws.openWeb(url.trim());
  },
  async commands() {
    const ws = app.active;
    const cmds = [
      ['Jump to session or worktree', 'Ctrl+Alt+J', () => actions.jump()],
      ['Go to next session that needs you', 'Ctrl+Alt+K', () => actions.nextNeedsYou()],
      ['Open file…', 'Ctrl+P', () => actions.quickOpen()],
      ['New Claude session', 'Ctrl+Alt+N', () => actions.newSession(null, 'claude')],
      ['New shell', 'Ctrl+`', () => actions.newSession(null, 'shell')],
      ['Review changes vs base', 'Ctrl+Alt+D', () => ws && ws.openReview()],
      ['Search in worktree', 'Ctrl+Shift+F', () => ws && ws.showRight('search')],
      ['Show files', 'Ctrl+Shift+E', () => ws && ws.showRight('files')],
      ['Show source control', 'Ctrl+Shift+G', () => ws && ws.showRight('scm')],
      ['Add repository or folder…', '', () => actions.addRepo()],
      ['New group…', '', () => actions.newGroup()],
      ['Next worktree', 'Alt+↓', () => stepWorktree(1)],
      ['Previous worktree', 'Alt+↑', () => stepWorktree(-1)],
      ['Split right', '', () => ws && ws.activeTab && ws.splitRight(ws.activeTab)],
      ['Split down (move to bottom panel)', '', () => ws && ws.activeTab && ws.splitDown(ws.activeTab)],
      ['Toggle bottom panel', 'Ctrl+Shift+`', () => ws && ws.togglePanel()],
      [store.prefs.muted ? 'Unmute sounds' : 'Mute sounds', '', () => toggleMute()],
      ['Test alert sound', '', () => playSound('question')],
      ['Sounds…', '', () => soundsDialog()],
      ['Settings…', 'Ctrl+,', () => openSettings()],
      ['Claude accounts & usage…', '', () => accountsDialog()],
      ['Resume a Claude conversation…', '', () => actions.resumeConversation()],
      ['Open web page or file…', '', () => actions.openWebPage()],
      ['Panel colors…', '', () => colorsDialog()],
      ['Toggle sidebar', 'Ctrl+B', () => document.body.classList.toggle('no-sidebar')],
    ];
    const v = await quickPick(cmds.map(([label, key, fn], i) => ({ label, description: key, value: i })), { placeholder: 'Run a command', matchDescription: false });
    if (v !== undefined) cmds[v][2]();
  },
};
app.actions = actions;

function toggleMute() {
  store.prefs.muted = !store.prefs.muted;
  call('prefs.mute', { muted: store.prefs.muted });
  updateStatusBar();
}

// ------------------------------------------------------------------ settings

async function openSettings() {
  const s = { ...store.settings };
  const field = (label, input, hint) => h('label.setting', h('span.setting-label', label), input, hint ? h('span.setting-hint', hint) : null);
  const text = (k, ph) => h('input.input', { value: Array.isArray(s[k]) ? s[k].join(' ') : s[k] || '', placeholder: ph || '', 'data-key': k });
  const check = k => h('input', { type: 'checkbox', checked: s[k] !== false ? true : undefined, 'data-key': k, 'data-type': 'bool' });
  const select = (k, opts) => h('select.input', { 'data-key': k }, opts.map(([v, l]) => h('option', { value: v, selected: s[k] === v ? true : undefined }, l)));
  const form = h('div.settings',
    h('div.setting', h('span.setting-label', 'Panel colors'), h('button.btn', { type: 'button', onclick: () => colorsDialog() }, icon('palette'), 'Choose…'), h('span.setting-hint', 'Background of the sidebar, editor & terminals, bottom panel and right panel.')),
    field('Sidebar density', select('density', [['comfortable', 'Comfortable'], ['compact', 'Compact']]), 'Compact fits more sessions on screen.'),
    h('h3', 'Claude'),
    field('Command', text('claudeCommand', 'claude'), 'SkiffCode adds --session-id / --resume, --name and --settings.'),
    field('Extra arguments', text('claudeArgs', '--permission-mode acceptEdits'), 'Added to every session.'),
    field('Start Claude in new worktrees', check('startClaudeOnCreate')),
    field('Ask for a name for new Claude sessions', check('askSessionName'), 'Off: new sessions are named after the branch.'),
    field('Restart after a reboot', check('autoResume'), 'Sessions and shells that a reboot stopped restart when you open their worktree.'),
    field('Unload idle worktrees after (minutes)', h('input.input', { type: 'number', min: '0', max: '1440', value: String(s.unloadAfterMinutes ?? 30), 'data-key': 'unloadAfterMinutes', 'data-type': 'num' }), 'Frees the editor and terminal views of worktrees you haven’t opened for this long. Claude keeps running; clicking the worktree brings it back. 0 = never.'),
    field('Shells open in the bottom panel', check('shellsInPanel')),
    h('h3', 'Worktrees'),
    field('Folder', text('worktreesDir', 'next to the repo: <repo>.worktrees/<branch>'), 'Empty = next to each repo.'),
    field('Copy into new worktrees', text('copyToWorktree', '.env .env.local'), 'Untracked files from the main checkout, space separated.'),
    field('Setup command', text('setupCommand', 'npm ci'), 'Runs in a shell in each new worktree.'),
    h('h3', 'Alerts'),
    field('Alert me', select('alerts', [['all', 'When a session asks, needs permission, or finishes'], ['needsYou', 'Only when a session asks or needs permission'], ['off', 'Never']])),
    field('Sound', check('sound')),
    h('div.setting', h('span.setting-label', 'Alert sounds'), h('button.btn', { type: 'button', onclick: () => soundsDialog() }, icon('unmute'), 'Choose sounds & volume…'), h('span.setting-hint', 'A sound for each alert (or your own file), and the volume.')),
    field('Desktop notifications', check('desktopNotifications'), notificationsAllowed() ? 'Allowed in this browser.' : h('button.btn.small', { onclick: async e => { e.preventDefault(); const r = await askNotifications(); toast(r === 'granted' ? 'Notifications allowed.' : 'Notifications are blocked in this browser’s site settings.'); } }, 'Allow in this browser')),
    h('h3', 'Editor'),
    field('Font size', h('input.input', { type: 'number', min: '9', max: '24', value: String(s.fontSize || 13), 'data-key': 'fontSize', 'data-type': 'num' })));
  const v = await confirmDialog({ title: 'Settings', detail: form, buttons: [{ label: 'Save', value: 'save', primary: true }] });
  if (v !== 'save') return;
  const values = {};
  for (const el of form.querySelectorAll('[data-key]')) {
    const k = el.dataset.key;
    if (el.dataset.type === 'bool') values[k] = el.checked;
    else if (el.dataset.type === 'num') values[k] = Number(el.value) || 13;
    else if (k === 'claudeArgs' || k === 'copyToWorktree') values[k] = el.value.split(/\s+/).filter(Boolean);
    else values[k] = el.value.trim();
  }
  store.settings = await call('settings.set', { values });
  toast('Settings saved.', { timeout: 2000 });
}

function maybeAskNotifications() {
  if (!('Notification' in window) || Notification.permission !== 'default' || localStorage.getItem('skiffcode.askedNotify')) return;
  localStorage.setItem('skiffcode.askedNotify', '1');
  toast('Get a desktop notification when Claude needs you?', { timeout: 0, icon: 'bell', actions: [{ label: 'Allow notifications', action: () => askNotifications() }] });
}

// ------------------------------------------------------------------ status bar & view reporting

function updateStatusBar() {
  const bar = document.getElementById('statusbar');
  const ws = app.active;
  const wt = ws && worktree(ws.root);
  const st = ws && store.status.get(ws.root);
  const running = store.sessions.filter(s => s.kind === 'claude' && s.state !== 'ended').length;
  const working = store.sessions.filter(s => s.state === 'working').length;
  const need = store.sessions.filter(s => needsYou(s.state)).length;
  const unread = store.sessions.filter(s => s.unread).length;
  const tab = ws && ws.activeTab;
  let pos = null;
  if (tab && tab.kind === 'file' && tab.editor) {
    const p = tab.editor.getPosition();
    if (p) pos = `Ln ${p.lineNumber}, Col ${p.column}`;
  }
  clear(bar,
    h('div.sb-left',
      usageItem(),
      h('span.sb-item.click', { title: 'Jump to a session (Ctrl+Alt+J)', onclick: () => actions.jump() }, icon('claude', working ? 'spin st-claude' : 'st-claude-idle'), `${running} running`,
        working ? ` · ${working} working` : null,
        need ? [' ', icon('question', 'st-question'), String(need)] : null,
        unread ? [' ', h('span.unread-dot'), String(unread)] : null),
      memoryItem()),
    h('div.sb-right',
      pos ? h('span.sb-item', pos) : null,
      tab && tab.kind === 'file' ? h('span.sb-item', languageOf(tab.path)) : null,
      st && st.dirty ? h('span.sb-item.click', { onclick: () => ws.showRight('scm') }, `${st.dirty} uncommitted`) : null,
      st && st.base ? h('span.sb-item', { title: `Compared with ${st.base}` }, `${st.ahead}↑ ${st.behind}↓ vs ${st.base}`) : null,
      wt ? h('span.sb-item', { title: ws.root }, icon(wt.folder ? 'folder' : wt.isMain ? 'home' : 'branch'), wt.folder ? wt.repo.name : `${wt.repo.name} / ${wt.branch || basename(ws.root)}`) : null,
      h(`span.sb-item${connected() ? '' : '.error'}`, { title: connected() ? 'Connected to the SkiffCode server' : 'Reconnecting…' }, icon(connected() ? 'link' : 'close')),
      h('span.sb-item.click', { title: `${store.prefs.muted ? 'Sounds off — click to turn on' : `Sounds on (${store.settings.volume ?? 70}%) — click to mute`}\nRight-click: choose sounds & volume`, onclick: toggleMute, oncontextmenu: e => { e.preventDefault(); void soundsDialog(); } }, icon(store.prefs.muted ? 'mute' : 'unmute')),
      h('span.sb-item.click', { title: 'Panel colors', onclick: () => colorsDialog() }, icon('palette')),
      h('span.sb-item.click', { title: 'Settings', onclick: openSettings }, icon('gear'))));
  document.body.classList.toggle('attention', need > 0);
  updateTitle(wt ? (wt.folder ? wt.repo.name : `${wt.repo.name} / ${wt.branch || basename(ws.root)}`) : '');
}
app.updateStatusBar = updateStatusBar;
subscribe(() => { applyColors(); document.body.classList.toggle('density-compact', store.settings.density === 'compact'); });
setInterval(updateStatusBar, 30_000); // keeps the usage reset countdown current

let lastView = '';
function reportView() {
  const ws = app.active;
  const t = ws && ws.activeTab;
  const info = { sessionId: t && t.kind === 'session' ? t.sessionId : null, visible: !document.hidden && document.hasFocus() };
  const key = JSON.stringify(info);
  if (key === lastView) return;
  lastView = key;
  if (connected()) void call('view', info).catch(() => {});
}
app.reportView = reportView;
window.addEventListener('focus', () => { lastView = ''; reportView(); });
window.addEventListener('blur', () => { lastView = ''; reportView(); });
document.addEventListener('visibilitychange', () => { lastView = ''; reportView(); });

// ------------------------------------------------------------------ keyboard

function isKey(e, spec) {
  const parts = spec.toLowerCase().split('+');
  const key = parts.pop();
  const want = { ctrl: parts.includes('ctrl'), alt: parts.includes('alt'), shift: parts.includes('shift') };
  if ((e.ctrlKey || e.metaKey) !== want.ctrl || e.altKey !== want.alt || e.shiftKey !== want.shift) return false;
  const k = e.key.toLowerCase();
  return k === key || e.code.toLowerCase() === `key${key}` || (key === '`' && e.code === 'Backquote') || e.code.toLowerCase() === key;
}

const SHORTCUTS = [
  ['ctrl+p', () => actions.quickOpen()],
  ['ctrl+shift+p', () => actions.commands()],
  ['ctrl+alt+j', () => actions.jump()],
  ['ctrl+alt+k', () => actions.nextNeedsYou()],
  ['ctrl+alt+n', () => actions.newSession(null, 'claude')],
  ['ctrl+`', () => actions.newSession(null, 'shell')],
  ['ctrl+shift+`', () => app.active && app.active.togglePanel()],
  ['ctrl+alt+d', () => app.active && app.active.openReview()],
  ['ctrl+shift+f', () => app.active && app.active.showRight('search')],
  ['ctrl+shift+e', () => app.active && app.active.showRight('files')],
  ['ctrl+shift+g', () => app.active && app.active.showRight('scm')],
  ['ctrl+b', () => document.body.classList.toggle('no-sidebar')],
  ['ctrl+,', () => openSettings()],
  ['alt+w', () => closeActiveTab()],
  ['ctrl+w', () => closeActiveTab()],
  ['alt+arrowdown', () => stepWorktree(1)],
  ['alt+arrowup', () => stepWorktree(-1)],
  ['alt+]', () => stepTab(1)],
  ['alt+[', () => stepTab(-1)],
  ['ctrl+tab', () => stepTab(1)],
  ['ctrl+shift+tab', () => stepTab(-1)],
];

function closeActiveTab() {
  const ws = app.active;
  if (ws && ws.activeTab) ws.closeTab(ws.activeTab);
}
function stepTab(d) {
  const ws = app.active;
  const p = ws && ws.focused;
  if (!p || !p.tabs.length) return;
  const i = p.tabs.indexOf(p.active);
  p.activate(p.tabs[(i + d + p.tabs.length) % p.tabs.length]);
  setTimeout(() => p.active.focus(), 0);
}

function globalKey(e) {
  for (const [spec, fn] of SHORTCUTS) {
    if (isKey(e, spec)) {
      e.preventDefault();
      e.stopPropagation();
      fn();
      return true;
    }
  }
  if (e.altKey && !e.ctrlKey && /^Digit[1-9]$/.test(e.code)) {
    const list = orderedWorktrees();
    const w = list[Number(e.code.slice(5)) - 1];
    if (w) {
      e.preventDefault();
      openWorktree(w.path);
      return true;
    }
  }
  return false;
}
document.addEventListener('keydown', e => {
  if (document.querySelector('.modal-back')) return;
  globalKey(e);
}, true);

/** Terminals swallow keys; let SkiffCode's shortcuts through (xterm custom key handler). */
app.terminalKey = (e, tab) => {
  if (e.type !== 'keydown') return true;
  const t = tab || (app.active && app.active.activeTab);
  // Ctrl+C copies when text is selected, otherwise it goes to the program (interrupt). Ctrl+Shift+C always copies.
  if ((isKey(e, 'ctrl+c') || isKey(e, 'ctrl+shift+c')) && t && t.term && t.term.hasSelection()) {
    e.preventDefault();
    t.copySelection();
    return false;
  }
  if (isKey(e, 'ctrl+shift+c')) return false;
  if (isKey(e, 'ctrl+v') || isKey(e, 'ctrl+shift+v')) return false; // the browser's paste event reaches xterm
  for (const [spec] of SHORTCUTS) if (isKey(e, spec) && spec !== 'ctrl+w') return false;
  if (e.altKey && /^Digit[1-9]$/.test(e.code)) return false;
  return true;
};

window.addEventListener('beforeunload', e => {
  if (models.anyDirty()) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ------------------------------------------------------------------ server events

on('alert', a => handleAlert(a, {
  show: id => actions.focusSession(id),
  isViewing: id => actions.isSessionFocused(id) && document.hasFocus() && !document.hidden,
}));
on('open.worktree', async ({ path: p, session: id }) => {
  // from `skiffcode <dir>`, `skiffcode new` or `skiffcode claude`
  const ws = await openWorktree(p);
  if (ws && id) await actions.focusSession(id);
});
on('toast', t => toast(t.text, { kind: t.kind }));
on('close', () => updateStatusBar());
on('reconnect', async () => {
  const hello = await call('hello');
  applySnapshot(hello);
  await loadAll();
  for (const ws of app.workspaces.values()) for (const t of ws.allTabs()) if (t.kind === 'session') { t.attached = false; t.attach(); }
  updateStatusBar();
});
subscribe(() => {
  for (const ws of app.workspaces.values()) ws.syncSessions();
  if (app.active) app.active.allTabs().forEach(t => t.kind === 'session' && t.pane && t.pane.renderBar());
  updateStatusBar();
});

boot();
