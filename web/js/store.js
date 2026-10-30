// Client-side view of SkiffCode's state, kept in sync by server events.
import { call, on } from './rpc.js';
import { pool } from './pool.js';

export const store = {
  home: '',
  version: '',
  groups: [],
  repos: [],
  sessions: [],
  prefs: { muted: false, collapsed: {} },
  settings: {},
  layouts: {},
  accounts: [],
  activeAccount: 'default',
  usage: {},
  worktrees: new Map(), // repo path -> { list: [...], missing, error }
  status: new Map(), // worktree path -> BranchStatus
  active: null, // worktree path shown in the main area
};

const subs = new Set();
let scheduled = false;
export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}
export function notify() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    for (const fn of subs) fn();
  });
}

export function applySnapshot(s) {
  Object.assign(store, {
    groups: s.groups,
    repos: s.repos,
    sessions: s.sessions,
    prefs: s.prefs,
    settings: s.settings,
  });
  if (s.accounts) store.accounts = s.accounts;
  if (s.activeAccount) store.activeAccount = s.activeAccount;
  if (s.usage) store.usage = s.usage;
  if (s.layouts) store.layouts = s.layouts;
  if (s.home) store.home = s.home;
  if (s.version) store.version = s.version;
  notify();
}

export async function loadWorktrees(repoPath) {
  try {
    const r = await call('worktrees.list', { repo: repoPath });
    store.worktrees.set(repoPath, { list: r.worktrees, missing: r.missing });
    notify();
    void pool(r.worktrees.filter(w => !w.prunable), 3, w => loadStatus(w.path));
  } catch (e) {
    store.worktrees.set(repoPath, { list: [], error: e.message });
    notify();
  }
}

const statusInflight = new Map();
export function loadStatus(p, fresh = false) {
  if (statusInflight.has(p) && !fresh) return statusInflight.get(p);
  const pr = call('worktrees.status', { path: p, fresh })
    .then(st => {
      store.status.set(p, st);
      notify();
      return st;
    })
    .catch(() => undefined)
    .finally(() => statusInflight.delete(p));
  statusInflight.set(p, pr);
  return pr;
}

export async function loadAll() {
  await pool(store.repos, 4, r => loadWorktrees(r.path));
}

export function allWorktrees() {
  const out = [];
  for (const r of store.repos) for (const w of (store.worktrees.get(r.path) || {}).list || []) out.push({ ...w, repo: r });
  return out;
}

export function worktree(p) {
  return allWorktrees().find(w => w.path === p);
}

export function sessionsIn(p) {
  return store.sessions
    .filter(s => s.worktreePath === p)
    .sort((a, b) => (a.kind === b.kind ? a.createdAt - b.createdAt : a.kind === 'claude' ? -1 : 1));
}

export function session(id) {
  return store.sessions.find(s => s.id === id);
}

export const needsYou = st => st === 'question' || st === 'permission';

on('state', s => applySnapshot(s));
on('git.changed', ({ root }) => loadStatus(root, true));
on('worktrees.changed', ({ repo }) => loadWorktrees(repo));
