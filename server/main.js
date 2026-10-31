#!/usr/bin/env node
'use strict';
// SkiffCode server: serves the UI and an API over one WebSocket. Runs inside WSL /
// Linux next to your repos, listens on 127.0.0.1 only, and requires a token.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ws = require('./ws');
const git = require('./git');
const fsops = require('./fsops');
const search = require('./search');
const { State } = require('./state');
const { Sessions } = require('./sessions');
const { PtyClient, hostPids } = require('./pty');
const notify = require('./notify');
const { Accounts, claudeBin } = require('./accounts');
const history = require('./history');
const { Sounds, DEFAULTS: SOUND_DEFAULTS } = require('./sounds');
const { run, skiffcodeHome, privateDir, realpath, isGitDir, TERM_SIZE, within, safeToDelete, pool } = require('./util');

const VERSION = require('../package.json').version;
const VIEW_SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals allow-downloads'; // what a previewed page may do: its own origin, no SkiffCode access
const HOME = skiffcodeHome();
const PORT = Number(process.env.SKIFFCODE_PORT || 3417);
const HOSTNAME = process.env.SKIFFCODE_BIND || '127.0.0.1';
const APP = path.resolve(__dirname, '..');
const WEB = path.join(APP, 'web');
const VENDOR = process.env.SKIFFCODE_VENDOR || path.join(APP, 'vendor');
const PID_FILE = path.join(HOME, 'server.pid');

// One server per home: two would both drive the same sessions and overwrite each other's state.
// Checked before anything below touches the home folder.
(() => {
  let pid;
  try { pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim()); } catch { return; }
  if (!pid || pid === process.pid) return;
  let args;
  try { args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'); } catch { return; }
  if (!args.some(a => a.endsWith(path.join('server', 'main.js')))) return;
  console.error(`skiffcode: a SkiffCode server (pid ${pid}) is already running for ${HOME}. Stop it first: skiffcode stop`);
  process.exit(1);
})();

// Private folders, made one by one: a umask would pass to terminals, shells and Claude and make your own files private too.
for (const d of ['', 'status', 'inbox', 'drops', 'accounts']) privateDir(path.join(HOME, d));
const TOKEN_FILE = path.join(HOME, 'token');
const TOKEN = (() => {
  const t = fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : '';
  if (t) return t;
  const fresh = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(TOKEN_FILE, fresh, { mode: 0o600 });
  fs.chmodSync(TOKEN_FILE, 0o600);
  return fresh;
})();

const DEFAULT_SETTINGS = {
  claudeCommand: 'claude',
  claudeArgs: [],
  nameClaudeSessions: true,
  worktreesDir: '',
  copyToWorktree: ['.env', '.env.local'],
  setupCommand: '',
  startClaudeOnCreate: true,
  autoResume: true, // restart sessions/shells that a reboot interrupted, when you open their worktree
  shellsInPanel: true, // new shells open in the bottom panel
  askSessionName: true, // new Claude sessions from the UI ask for a name
  density: 'comfortable', // sidebar rows: comfortable | compact
  unloadAfterMinutes: 30, // free the UI (editor, terminal views) of worktrees you haven't opened for this long; 0 = never
  alerts: 'all', // all | needsYou | off
  sound: true,
  sounds: { ...SOUND_DEFAULTS }, // per alert: a built-in name, "custom:<file>" or "none"
  volume: 70, // 0–100, for every alert sound
  desktopNotifications: true,
  fontSize: 13,
  shortcutsEnabled: true, // off: only the command palette key stays SkiffCode's
  keybindings: {}, // action id -> key ('ctrl+alt+b'), '' = no key; unset = default (web/js/keybindings.js)
};

const state = new State(HOME);
const settings = () => {
  const s = { ...DEFAULT_SETTINGS, ...(state.prefs.settings || {}) };
  s.sounds = { ...DEFAULT_SETTINGS.sounds, ...s.sounds }; // the pages rely on a complete set
  return s;
};
const accounts = new Accounts(state, HOME);
const accountDirs = () => accounts.list().map(a => ({ id: a.id, dir: a.dir || accounts.defaultConfigDir() }));
const sounds = new Sounds(HOME);
// Attachments dropped onto sessions are kept a week.
try {
  const dropsDir = path.join(HOME, 'drops');
  for (const d of fs.readdirSync(dropsDir)) if (/^\d{4}-\d\d-\d\d$/.test(d) && Date.now() - Date.parse(d) > 7 * 86400e3) fs.rmSync(path.join(dropsDir, d), { recursive: true, force: true });
} catch { /* none yet */ }
const sessions = new Sessions(state, HOME, settings, accounts);
sessions.on('usage', () => broadcast('usage', accounts.usage));

// ------------------------------------------------------------------ clients

const clients = new Set();
function broadcast(event, data) {
  const msg = JSON.stringify({ event, data });
  for (const c of clients) c.conn.send(msg);
}

let stateTimer;
function pushState() {
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = undefined;
    broadcast('state', snapshot());
  }, 40);
}
state.on('change', pushState);
sessions.on('change', pushState);
sessions.on('alert', a => {
  broadcast('alert', a);
  if (clients.size === 0) {
    const s = state.session(a.sessionId);
    if (s) notify.alertWithoutWindow({ session: s, kind: a.kind, repoName: (state.repo(s.repoPath) || {}).name || path.basename(s.repoPath), settings: settings(), muted: !!state.prefs.muted, soundFile: sounds.forKind(settings(), a.kind) });
  }
});
sessions.on('transition', t => {
  if (t.to === 'idle' || t.to === 'ended' || t.to === 'question' || t.to === 'permission') gitChanged(t.session.worktreePath);
});
sessions.on('edited', wt => {
  gitChanged(wt);
  broadcast('fs.changed', { root: wt, path: null });
});

function snapshot() {
  return {
    groups: state.groups,
    repos: state.repos,
    sessions: sessions.list(),
    prefs: { muted: !!state.prefs.muted, collapsed: state.prefs.collapsed || {} },
    accounts: accounts.list().map(a => ({ id: a.id, name: a.name, dir: a.dir || accounts.defaultConfigDir(), shared: a.shared })),
    activeAccount: accounts.activeId(),
    usage: accounts.usage,
    settings: settings(),
  };
}

// ------------------------------------------------------------------ worktrees

const rootsByRepo = new Map(); // repo path -> Set of its worktree paths
const knownRoots = new Set(); // worktree paths of registered repos (where file/git access is allowed)
fsops.setLinkRoots(() => knownRoots);
const statusCache = new Map(); // path -> { at, value, pending }
const baseCache = new Map();

async function worktreesOf(repo) {
  if (repo.kind === 'folder') {
    if (!isGitDir(repo.path)) {
      // A plain folder: one "worktree", itself.
      const one = [{ path: repo.path, branch: null, head: '', isMain: true, folder: true }];
      knownRoots.add(repo.path);
      rootsByRepo.set(repo.path, new Set([repo.path]));
      return one;
    }
    // git init'ed since we last looked (the button, or `git init` in a shell): it's a repo now
    state.update(d => { const r = d.repos.find(x => x.path === repo.path); if (r) delete r.kind; });
    delete repo.kind;
    setImmediate(() => announceGit(repo.path));
  }
  const wts = await git.listWorktrees(repo.path);
  for (const w of wts) knownRoots.add(w.path);
  rootsByRepo.set(repo.path, new Set(wts.map(w => w.path)));
  return wts;
}

function announceGit(p) {
  statusCache.delete(p);
  void watchGit(p);
  broadcast('state', snapshot());
  broadcast('worktrees.changed', { repo: p });
  gitChanged(p);
}

/**
 * A plain folder got a .git (the Initialize button, or `git init` in a shell or by Claude):
 * from now on it's a repository, with worktrees, changes and commits.
 */
async function folderBecameGit(p) {
  const repo = state.repo(p);
  if (!repo || repo.kind !== 'folder' || !isGitDir(p)) return false;
  await worktreesOf(repo).catch(() => []); // drops kind: 'folder' and tells the pages
  return true;
}
setInterval(() => {
  for (const r of state.repos) if (r.kind === 'folder' && isGitDir(r.path)) void folderBecameGit(r.path);
}, 3000).unref();

/** Lists every repo's worktrees again. Roots stay usable meanwhile: only the ones no repo lists any more are dropped. */
async function refreshRoots() {
  await pool(state.repos, 4, r => worktreesOf(r).catch(() => []));
  const live = new Set([...rootsByRepo.values()].flatMap(s => [...s]));
  for (const r of [...knownRoots]) if (!live.has(r)) knownRoots.delete(r);
}

/** A repo is gone: its folders no longer grant file access (knownRoots changes in place: fsops holds it). Returns them. */
function forgetRoots(repoPath, wts) {
  const roots = new Set([repoPath, ...(rootsByRepo.get(repoPath) || []), ...wts.map(w => w.path)]);
  rootsByRepo.delete(repoPath);
  baseCache.delete(repoPath);
  for (const w of roots) { knownRoots.delete(w); statusCache.delete(w); }
  return roots;
}

function rootOf(p) {
  const r = realpath(p);
  if (knownRoots.has(r)) return r;
  throw new Error('Not a worktree SkiffCode knows about');
}

/** A session id from a page ends up in file paths (sockets, logs, status files): only ids of real sessions. */
function sessionId(id) {
  if (typeof id !== 'string' || !state.session(id)) throw new Error('No such session');
  return id;
}

function repoForWorktree(wt) {
  return state.repos.find(r => r.path === wt || knownRootsOf(r).has(wt));
}
function knownRootsOf(r) {
  return rootsByRepo.get(r.path) || new Set();
}

async function worktreeStatus(p, maxAge = 5000) {
  const c = statusCache.get(p) || {};
  if (c.value && Date.now() - c.at < maxAge) return c.value;
  if (c.pending) return c.pending;
  c.pending = (async () => {
    if (!isGitDir(p)) return { notGit: true, files: 0, dirty: 0, insertions: 0, deletions: 0, ahead: 0, behind: 0 };
    const repo = repoForWorktree(p);
    let preferred = state.worktreeMeta(p).base;
    if (!preferred && repo) {
      if (!baseCache.has(repo.path)) baseCache.set(repo.path, git.defaultBase(repo.path));
      preferred = await baseCache.get(repo.path);
    }
    const wts = repo ? await git.listWorktrees(repo.path).catch(() => []) : [];
    const wt = wts.find(w => w.path === p);
    const base = await git.compareBase(p, wt && wt.branch, preferred);
    return git.branchStatus(p, base);
  })();
  statusCache.set(p, c);
  try {
    c.value = await c.pending;
    c.at = Date.now();
    return c.value;
  } finally {
    c.pending = undefined;
  }
}

const gitTimers = new Map();
function gitChanged(root) {
  statusCache.delete(root);
  if (gitTimers.has(root)) return;
  gitTimers.set(root, setTimeout(() => {
    gitTimers.delete(root);
    broadcast('git.changed', { root });
  }, 250));
}

/** Watch each opened worktree's git dir (HEAD, index) so commits/stages refresh the views. */
const gitWatchers = new Map();
async function watchGit(root) {
  if (gitWatchers.has(root)) return;
  gitWatchers.set(root, null);
  try {
    const dir = await git.gitDir(root);
    const w = fs.watch(dir, { persistent: false }, (_e, f) => {
      if (f && /^(index|HEAD|ORIG_HEAD|FETCH_HEAD|MERGE_HEAD)$/.test(String(f))) gitChanged(root);
    });
    w.on('error', () => {});
    gitWatchers.set(root, w);
  } catch {
    gitWatchers.delete(root); // not a repo yet: a later `git init` must be able to start the watch
  }
}

function worktreeTarget(repo, branch) {
  const s = settings();
  const leaf = git.sanitizeForPath(branch);
  const dir = (s.worktreesDir || '').trim().replace(/^~(?=\/|$)/, os.homedir());
  return dir ? path.join(dir, repo.name, leaf) : path.join(path.dirname(repo.path), `${repo.name}.worktrees`, leaf);
}

function copyIntoWorktree(repoPath, target) {
  for (const rel of settings().copyToWorktree || []) {
    const src = path.join(repoPath, rel);
    const dst = path.join(target, rel);
    try {
      if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(src, dst, { recursive: true });
    } catch { /* skip */ }
  }
}

/** Only folders SkiffCode knows (repos, their worktrees): never arbitrary paths. */
function knownFolders(folders) {
  return (folders || []).map(f => realpath(f)).filter(f => f && (knownRoots.has(f) || state.repo(f)));
}

const graphemes = new Intl.Segmenter();
function cleanLook(icon, color) {
  const ic = typeof icon === 'string' ? icon.trim() : '';
  // two emoji at most, counted as the eye sees them (a family or a flag is one), like the customize dialog
  const okIcon = /^i:[a-z][a-zA-Z0-9]{0,20}$/.test(ic) || (ic && [...graphemes.segment(ic)].length <= 2 && !/[<>&"'\\]/.test(ic));
  return { icon: okIcon ? ic : undefined, color: /^#[0-9a-fA-F]{6}$/.test(color || '') ? color.toLowerCase() : undefined };
}

async function addRepo(dir) {
  const real = realpath(dir);
  let st;
  try { st = fs.statSync(real); } catch { throw new Error(`Folder not found: ${dir}`); }
  if (!st.isDirectory()) throw new Error(`Not a folder: ${dir}`);
  const gitRoot = await git.resolveRepoRoot(real).then(realpath, () => null);
  // Inside a git repo: add the repo. Anywhere else: add the folder itself (no git features).
  const root = gitRoot || real;
  if (!gitRoot && (root === '/' || root === os.homedir())) throw new Error(`Pick a project folder, not ${root}`);
  if (!state.repo(root)) state.update(d => void d.repos.push({ path: root, name: path.basename(root).replace(/\.git$/, ''), addedAt: Date.now(), ...(gitRoot ? {} : { kind: 'folder' }) }));
  await worktreesOf(state.repo(root)).catch(() => []);
  return state.repo(root);
}

// ------------------------------------------------------------------ API

const MAX_LAYOUT = 256 * 1024;

function moveItems(d, items, target) {
  for (const it of items) {
    if (it.kind === 'repo') {
      const i = d.repos.findIndex(r => r.path === it.path);
      if (i < 0) continue;
      const [r] = d.repos.splice(i, 1);
      if (target && target.kind === 'repo' && target.path !== r.path) {
        const t = d.repos.find(x => x.path === target.path);
        r.group = t ? t.group : undefined;
        const j = d.repos.findIndex(x => x.path === target.path);
        d.repos.splice(target.after ? j + 1 : j, 0, r);
      } else if (target && target.kind === 'group') {
        r.group = target.id;
        d.repos.push(r);
      } else if (!target) {
        r.group = undefined;
        d.repos.push(r);
      } else d.repos.splice(i, 0, r);
    } else if (it.kind === 'group') {
      const i = d.groups.findIndex(g => g.id === it.id);
      if (i < 0) continue;
      const [g] = d.groups.splice(i, 1);
      if (target && target.kind === 'group' && target.id !== g.id) {
        const j = d.groups.findIndex(x => x.id === target.id);
        d.groups.splice(target.after ? j + 1 : j, 0, g);
      } else d.groups.push(g);
    }
  }
}

/** A URL that reaches this server: any loopback name on our port (other local ports are dev servers, fine to frame). */
function isSelf(u) {
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  const loopback = h === 'localhost' || h === '0.0.0.0' || h === '[::]' || h === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(h) || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(h);
  return loopback && Number(u.port || (u.protocol === 'https:' ? 443 : 80)) === PORT;
}

const api = {
  async hello(_p, client) {
    client.hello = true;
    await refreshRoots();
    return { version: VERSION, home: os.homedir(), dataDir: HOME, user: os.userInfo().username, ...snapshot(), layouts: state.data.layouts || {} };
  },

  // repos & groups
  async 'repos.add'({ path: p }) { return addRepo(p); },
  async 'repos.remove'({ path: p }) {
    const wts = await git.listWorktrees(p).catch(() => []);
    for (const s of state.sessions.filter(s => s.repoPath === p)) await sessions.forget(s.id);
    const roots = forgetRoots(p, wts);
    state.update(d => {
      d.repos = d.repos.filter(r => r.path !== p);
      for (const w of roots) { delete d.worktrees[w]; if (d.layouts) delete d.layouts[w]; }
    });
  },
  async 'repos.deleteInfo'({ path: p }) {
    const repo = state.repo(p);
    if (!repo) throw new Error('Unknown repository');
    const wts = await git.listWorktrees(p).catch(() => []);
    const linked = wts.filter(w => !w.isMain && fs.existsSync(w.path) && !within(p, w.path));
    const unpushed = await git.git(p, ['log', '--branches', '--not', '--remotes', '--oneline']).then(o => o.split('\n').filter(Boolean).length).catch(() => 0);
    return { name: repo.name, path: p, safe: safeToDelete(p), linked: linked.map(w => ({ path: w.path, branch: w.branch })), sessions: state.sessions.filter(s => s.repoPath === p).length, unpushed };
  },
  async 'repos.delete'({ path: p, confirm }) {
    const repo = state.repo(p);
    if (!repo) throw new Error('Unknown repository');
    if (confirm !== repo.name) throw new Error('Type the repository name to confirm');
    if (!safeToDelete(p)) throw new Error(`SkiffCode won’t delete ${p}`);
    const wts = await git.listWorktrees(p).catch(() => []);
    for (const s of state.sessions.filter(s => s.repoPath === p)) await sessions.forget(s.id);
    for (const w of wts) if (!w.isMain && !within(p, w.path) && safeToDelete(w.path)) fs.rmSync(w.path, { recursive: true, force: true });
    fs.rmSync(p, { recursive: true, force: true });
    const roots = forgetRoots(p, wts);
    state.update(d => {
      d.repos = d.repos.filter(r => r.path !== p);
      for (const w of roots) { delete d.worktrees[w]; if (d.layouts) delete d.layouts[w]; }
    });
  },
  'repos.move'({ items, target }) { state.update(d => moveItems(d, items, target)); },
  'repos.nudge'({ path: p, dir }) {
    state.update(d => {
      const r = d.repos.find(x => x.path === p);
      if (!r) return;
      const peers = d.repos.filter(x => (x.group || undefined) === (r.group || undefined));
      const other = peers[peers.indexOf(r) + dir];
      if (!other) return;
      const a = d.repos.indexOf(r), b = d.repos.indexOf(other);
      d.repos[a] = other;
      d.repos[b] = r;
    });
  },
  /** Your own icon (built-in "i:<name>" or an emoji) and text color for a repo / folder or group. */
  'repos.customize'({ path: p, icon, color }) {
    const v = cleanLook(icon, color);
    state.update(d => { const r = d.repos.find(x => x.path === p); if (r) { r.icon = v.icon; r.color = v.color; } });
  },
  'groups.customize'({ id, icon, color }) {
    const v = cleanLook(icon, color);
    state.update(d => { const g = d.groups.find(x => x.id === id); if (g) { g.icon = v.icon; g.color = v.color; } });
  },
  // alert sounds
  'sounds.list'() { return sounds.list(); },
  'sounds.upload'({ name, data }) { const r = sounds.save(name, data); broadcast('sounds.changed', sounds.list()); return r; },
  'sounds.remove'({ id }) {
    sounds.remove(id);
    // anything that used it goes back to its default
    state.update(d => { const st = d.prefs.settings || {}; for (const k of Object.keys(st.sounds || {})) if (st.sounds[k] === id) st.sounds[k] = SOUND_DEFAULTS[k]; });
    broadcast('sounds.changed', sounds.list());
  },
  'repos.setGroup'({ path: p, group }) { state.update(d => { const r = d.repos.find(x => x.path === p); if (r) r.group = group || undefined; }); },
  'groups.create'({ name, repo }) {
    const id = crypto.randomUUID();
    state.update(d => {
      d.groups.push({ id, name });
      if (repo) { const r = d.repos.find(x => x.path === repo); if (r) r.group = id; }
    });
    return { id };
  },
  'groups.rename'({ id, name }) { state.update(d => { const g = d.groups.find(x => x.id === id); if (g) g.name = name; }); },
  'groups.delete'({ id }) {
    state.update(d => {
      d.groups = d.groups.filter(g => g.id !== id);
      for (const r of d.repos) if (r.group === id) r.group = undefined;
    });
  },
  'prefs.collapse'({ key, collapsed }) { state.update(d => { d.prefs.collapsed = { ...(d.prefs.collapsed || {}), [key]: collapsed || undefined }; }); },
  'prefs.mute'({ muted }) { state.update(d => { d.prefs.muted = !!muted; }); },
  'settings.set'({ values }) { state.update(d => { d.prefs.settings = { ...(d.prefs.settings || {}), ...values }; }); return settings(); },

  // worktrees
  async 'worktrees.list'({ repo }) {
    const r = state.repo(repo);
    if (!r) throw new Error('Unknown repository');
    if (!fs.existsSync(r.path)) return { missing: true, worktrees: [] };
    const wts = await worktreesOf(r);
    return { worktrees: wts.map(w => ({ ...w, base: state.worktreeMeta(w.path).base })) };
  },
  async 'worktrees.status'({ path: p, fresh }) { return worktreeStatus(rootOf(p), fresh ? 0 : 5000); },
  async 'worktrees.branches'({ repo }) {
    const [branches, wts, refs, def, remoteNames] = await Promise.all([
      git.localBranches(repo), git.listWorktrees(repo), git.baseRefs(repo).catch(() => []), git.defaultBase(repo), git.remoteNames(repo),
    ]);
    const out = new Set(wts.map(w => w.branch).filter(Boolean));
    const local = new Set(branches);
    // remote branches you don't have locally yet (checked out as a new tracking branch)
    const remoteOnly = refs.filter(r => remoteNames.some(n => r.startsWith(n + '/')) && !local.has(r.slice(r.indexOf('/') + 1)));
    return { free: branches.filter(b => !out.has(b)), checkedOut: [...out], all: branches, remoteOnly, refs: [def, ...refs.filter(r => r !== def)], defaultBase: def };
  },
  async 'worktrees.checkName'({ repo, branch }) {
    const r = state.repo(repo);
    const s = (branch || '').trim();
    if (!s) return { error: 'Enter a branch name' };
    if ((await git.localBranches(repo)).includes(s)) return { error: 'That branch already exists — pick it under “existing branch”' };
    if (!(await git.isValidBranchName(repo, s))) return { error: 'Not a valid branch name' };
    const target = worktreeTarget(r, s);
    if (fs.existsSync(target)) return { error: `Folder already exists: ${target}` };
    return { target };
  },
  async 'worktrees.create'({ repo, newBranch, base, branch, track, startClaude, cols, rows, sessionName, prompt }) {
    const r = state.repo(repo);
    if (!r) throw new Error('Unknown repository');
    const name = (newBranch || branch || '').trim();
    const target = worktreeTarget(r, name);
    if (fs.existsSync(target)) throw new Error(`Folder already exists: ${target}`);
    await git.addWorktree(r.path, target, newBranch ? { newBranch: name, base, track } : { branch: name });
    const real = realpath(target);
    knownRoots.add(real);
    await worktreesOf(r).catch(() => []);
    state.update(d => { d.worktrees[real] = { base: newBranch ? base : undefined }; });
    copyIntoWorktree(r.path, real);
    const s = settings();
    if (s.setupCommand && s.setupCommand.trim()) {
      const sh = await sessions.create({ kind: 'shell', repoPath: r.path, worktreePath: real, branch: name, name: 'setup', cols, rows });
      setTimeout(async () => {
        try {
          const c = await new PtyClient(sessions.sock(sh.id)).connect();
          c.write(s.setupCommand.trim() + '\r');
          setTimeout(() => c.close(), 200);
        } catch { /* ignore */ }
      }, 600);
    }
    let session;
    if (startClaude === undefined ? s.startClaudeOnCreate : startClaude) session = await sessions.create({ kind: 'claude', repoPath: r.path, worktreePath: real, branch: name, cols, rows, name: sessionName, prompt });
    broadcast('worktrees.changed', { repo: r.path });
    return { path: real, branch: name, session: session && session.id };
  },
  async 'worktrees.removeInfo'({ repo, path: p }) {
    const wts = await git.listWorktrees(repo);
    const w = wts.find(x => x.path === p);
    if (!w) throw new Error('Unknown worktree');
    const st = w.prunable ? null : await worktreeStatus(p, 0).catch(() => null);
    return {
      branch: w.branch, isMain: w.isMain, locked: w.locked, prunable: w.prunable,
      dirty: st ? st.dirty : 0,
      unpushed: w.branch ? await git.unpushedCount(repo, w.branch) : 0,
      sessions: state.sessionsIn(p).length,
    };
  },
  async 'worktrees.remove'({ repo, path: p, deleteBranch, forceBranch }) {
    const wts = await git.listWorktrees(repo);
    const w = wts.find(x => x.path === p);
    if (!w) throw new Error('Unknown worktree');
    if (w.isMain) throw new Error('That’s the main checkout — remove or delete the repository instead');
    await sessions.stopAllIn(p);
    if (w.prunable || !fs.existsSync(p)) {
      await git.pruneWorktrees(repo);
    } else {
      try {
        await git.removeWorktree(repo, p, w.locked ? 2 : 1); // you confirmed in the dialog
      } catch {
        await git.removeWorktree(repo, p, 2).catch(() => undefined);
        if (safeToDelete(p)) fs.rmSync(p, { recursive: true, force: true });
        await git.pruneWorktrees(repo);
      }
    }
    if (fs.existsSync(p) && safeToDelete(p)) fs.rmSync(p, { recursive: true, force: true });
    knownRoots.delete(p);
    state.update(d => { delete d.worktrees[p]; if (d.layouts) delete d.layouts[p]; });
    let branchResult = 'kept';
    let branchError;
    if (deleteBranch && w.branch) {
      try {
        await git.deleteBranch(repo, w.branch, !!forceBranch);
        branchResult = 'deleted';
      } catch (e) {
        if (/not fully merged/i.test(e.message)) branchResult = 'unmerged';
        else { branchResult = 'error'; branchError = e.message; }
      }
    }
    broadcast('worktrees.changed', { repo });
    return { branch: branchResult, branchName: w.branch, branchError };
  },
  async 'branches.delete'({ repo, branch, force }) { await git.deleteBranch(repo, branch, !!force); broadcast('worktrees.changed', { repo }); },

  // sessions & terminals
  async 'sessions.create'({ kind, worktreePath, name, cols, rows, resumeClaudeId, account }) {
    const root = rootOf(worktreePath);
    const repo = repoForWorktree(root);
    const wts = repo ? await git.listWorktrees(repo.path).catch(() => []) : [];
    const wt = wts.find(w => w.path === root);
    const s = await sessions.create({ kind, repoPath: repo ? repo.path : root, worktreePath: root, branch: wt && wt.branch, name, cols, rows, resumeClaudeId, account });
    return s;
  },
  /** Folder browser for "Add repository": sub-folders of a folder, git repos marked. */
  async 'folders.browse'({ path: p }) {
    const home = os.homedir();
    let dir = String(p || '').trim().replace(/^~(?=\/|$)/, home) || home;
    dir = path.resolve(dir);
    let st;
    try { st = fs.statSync(dir); } catch { throw new Error(`Folder not found: ${dir}`); }
    if (!st.isDirectory()) dir = path.dirname(dir);
    const added = new Set(state.repos.map(r => r.path));
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { throw new Error(`Can't open ${dir}: ${e.code || e.message}`); }
    const entries = names
      .filter(d => d.isDirectory() || (d.isSymbolicLink() && (() => { try { return fs.statSync(path.join(dir, d.name)).isDirectory(); } catch { return false; } })()))
      .filter(d => d.name !== '.git' && d.name !== 'node_modules')
      .slice(0, 3000)
      .map(d => {
        const full = path.join(dir, d.name);
        return { name: d.name, path: full, hidden: d.name.startsWith('.'), git: isGitDir(full), added: added.has(full) };
      })
      .sort((a, b) => Number(b.git) - Number(a.git) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const root = await git.resolveRepoRoot(dir).catch(() => null);
    return { path: dir, parent: dir === '/' ? null : path.dirname(dir), home, repoRoot: root, added: root ? added.has(root) : false, entries };
  },
  /** Claude conversations for this worktree that exist on disk (started anywhere), newest first. */
  'claude.history'({ worktreePath }) {
    const root = rootOf(worktreePath);
    const tracked = new Map(state.sessions.filter(s => s.kind === 'claude' && s.claudeId).map(s => [s.claudeId, s.id]));
    const accts = accountDirs();
    return history.listConversations(root, accts, tracked);
  },
  /** Delete a session completely: stop it, remove it here, and delete Claude's saved conversation. */
  async 'sessions.purge'({ id }) {
    const s = state.session(id);
    if (!s) throw new Error('No such session');
    const folder = s.worktreePath;
    const cid = s.kind === 'claude' ? s.claudeId : null;
    await sessions.forget(id);
    if (!cid) return { deleted: [] };
    return { deleted: history.deleteConversation(accountDirs().map(a => a.dir), folder, cid) };
  },
  /** Delete a past conversation from the Resume list (and its session here, if it has one). */
  async 'claude.deleteConversation'({ worktreePath, id }) {
    const root = rootOf(worktreePath);
    const open = state.sessions.find(x => x.kind === 'claude' && x.claudeId === id);
    if (open) await sessions.forget(open.id);
    return { deleted: history.deleteConversation(accountDirs().map(a => a.dir), root, id) };
  },
  /** How many saved Claude conversations these folders have (for the "also delete" checkbox). */
  'claude.countConversations'({ folders }) {
    const accts = accountDirs();
    return knownFolders(folders).reduce((n, f) => n + history.listConversations(f, accts, new Map(), Infinity).length, 0);
  },
  /** Delete every saved Claude conversation of these folders (a worktree or repo you're removing). */
  async 'claude.purgeFolders'({ folders }) {
    const accts = accountDirs();
    let n = 0;
    for (const f of knownFolders(folders)) {
      for (const s of state.sessions.filter(x => x.worktreePath === f && x.kind === 'claude')) await sessions.forget(s.id);
      for (const c of history.listConversations(f, accts, new Map(), Infinity)) {
        history.deleteConversation(accts.map(a => a.dir), f, c.id);
        n++;
      }
    }
    return { deleted: n };
  },
  /** Pick up an existing Claude conversation (pasted ID or `claude --resume …` line) as a SkiffCode session. */
  async 'sessions.adopt'({ worktreePath, conversation, name, account, cols, rows }) {
    const id = history.parseConversationId(conversation);
    if (!id) throw new Error('Paste a conversation ID or the `claude --resume …` line Claude printed when it exited');
    const existing = state.sessions.find(s => s.kind === 'claude' && s.claudeId === id);
    if (existing) {
      if (sessions.stateOf(existing.id) === 'ended') await sessions.resume(existing.id, cols, rows);
      return sessions.list().find(s => s.id === existing.id);
    }
    const root = rootOf(worktreePath);
    const found = api['claude.history']({ worktreePath: root }).find(c => c.id === id);
    const label = found && (found.title || found.first);
    const short = label ? (label.length > 40 ? `${label.slice(0, 38).trimEnd()}…` : label) : '';
    return api['sessions.create']({ kind: 'claude', worktreePath: root, name: name || short || undefined, cols, rows, resumeClaudeId: id, account: account || (found && found.account) });
  },
  async 'sessions.resume'({ id, cols, rows }) { return sessions.resume(sessionId(id), cols, rows); },
  async 'sessions.stop'({ id }) { await sessions.stop(sessionId(id)); },
  async 'sessions.forget'({ id }) { await sessions.forget(sessionId(id)); },
  async 'sessions.rename'({ id, name }) { await sessions.rename(sessionId(id), name); },
  'sessions.setUnread'({ id, unread }) { sessions.setUnread(sessionId(id), unread); },
  view(info, client) { sessions.setViewing(client.id, info); },
  /** Memory: the SkiffCode server, and each session's terminal + everything running in it (Claude, tools). */
  async 'system.memory'() {
    const out = await run('ps', ['-eo', 'pid=,ppid=,rss=']).catch(() => '');
    const kids = new Map();
    const rss = new Map();
    for (const line of out.split('\n')) {
      const [pid, ppid, kb] = line.trim().split(/\s+/).map(Number);
      if (!pid) continue;
      rss.set(pid, kb * 1024);
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid).push(pid);
    }
    const tree = pid => {
      let total = 0;
      const stack = [pid];
      const seen = new Set();
      while (stack.length) {
        const p = stack.pop();
        if (seen.has(p)) continue;
        seen.add(p);
        total += rss.get(p) || 0;
        stack.push(...(kids.get(p) || []));
      }
      return total;
    };
    const per = {};
    for (const s of state.sessions) {
      const { host } = hostPids(sessions.sock(s.id));
      if (host && rss.has(host)) per[s.id] = tree(host);
    }
    return { server: process.memoryUsage().rss, sessions: per };
  },

  async 'term.open'({ id, cols, rows }, client) {
    sessionId(id);
    if (client.terms.has(id)) return { ok: true };
    const sock = sessions.sock(id);
    const c = await new PtyClient(sock).connect();
    client.terms.set(id, c);
    const idBuf = Buffer.from(id.padEnd(36).slice(0, 36), 'latin1');
    const send = (type, data) => client.conn.sendBinary(Buffer.concat([Buffer.from([type]), idBuf, data]));
    c.on('history', h => send(1, h));
    c.on('data', d => send(2, d));
    c.on('exit', code => send(3, Buffer.from(String(code))));
    c.on('close', () => client.terms.delete(id));
    if (cols && rows) c.resize(cols, rows);
    return { ok: true };
  },
  // Claude accounts (logins)
  async 'accounts.status'({ fresh }) {
    const list = accounts.list();
    const cmd = (settings().claudeCommand || 'claude');
    const out = await Promise.all(list.map(async a => ({ id: a.id, ...(await accounts.authStatus(a.id, cmd, fresh)) })));
    return out;
  },
  'accounts.setActive'({ id }) { accounts.setActive(id); },
  'accounts.add'({ name, share }) { return accounts.add(name, share !== false); },
  'accounts.rename'({ id, name }) { accounts.rename(id, name); },
  'accounts.remove'({ id }) { accounts.remove(id, state.sessions.filter(s => (s.account || 'default') === id).map(s => s.name)); },
  /** Sign in (or switch org) for an account: a shell tab running `claude auth login` with that account's config. */
  async 'accounts.login'({ id, worktreePath, console: useConsole }) {
    const root = rootOf(worktreePath);
    const repo = repoForWorktree(root);
    accounts.invalidate(id);
    const a = accounts.get(id);
    const cmd = claudeBin(settings().claudeCommand);
    return sessions.create({ kind: 'shell', repoPath: repo ? repo.path : root, worktreePath: root, name: `sign in · ${a.name}`, account: id, command: `${cmd} auth login${useConsole ? ' --console' : ''}` });
  },
  async 'accounts.logout'({ id }) {
    const cmd = claudeBin(settings().claudeCommand);
    const env = accounts.env(id);
    await run('sh', ['-lc', `${cmd} auth logout`], { env, timeout: 30_000 }).catch(() => {});
    accounts.invalidate(id);
  },

  'term.history'({ id }) {
    return { data: sessions.history(sessionId(id)).toString('base64') };
  },
  'term.close'({ id }, client) {
    const c = client.terms.get(sessionId(id));
    if (c) c.close();
    client.terms.delete(id);
  },
  'term.resize'({ id, cols, rows }, client) {
    const c = client.terms.get(sessionId(id));
    if (c) c.resize(cols, rows);
  },

  // files
  async 'fs.list'({ root, dir }) { return fsops.list(rootOf(root), dir || ''); },
  async 'fs.read'({ root, path: p }) { return fsops.read(rootOf(root), p); },
  /**
   * Which of these paths (printed in a terminal) exist? Relative ones are taken from the worktree.
   * Returns, in order, { abs, type, root, rel } or null.
   */
  'paths.resolve'({ cwd, paths }) {
    const base = rootOf(cwd);
    return (paths || []).slice(0, 80).map(p => {
      if (typeof p !== 'string' || !p || p.length > 1024) return null;
      try {
        const abs = toLinuxPath(p, base);
        const st = fs.statSync(abs);
        if (!st.isFile() && !st.isDirectory()) return null;
        const root = knownRootOf(abs);
        return { abs, type: st.isDirectory() ? 'dir' : 'file', root, rel: root ? path.relative(root, abs).split(path.sep).join('/') : null };
      } catch {
        return null;
      }
    });
  },
  /** A /view URL for a file anywhere (you clicked its path): HTML, images, PDFs, text. */
  'fs.viewUrl'({ path: p }) {
    const abs = realpath(toLinuxPath(p));
    let st;
    try { st = fs.statSync(abs); } catch { throw new Error(`Not found: ${p}`); }
    if (!st.isFile()) throw new Error(`Not a file: ${p}`);
    return viewUrlFor(abs);
  },
  /** Where a worktree's files can be previewed (images, PDFs, HTML): /view/<key>/ */
  'fs.viewBase'({ root }) { return `/view/${viewKey(rootOf(root))}/`; },
  /** Can this web page be shown inside SkiffCode? Many sites forbid being framed (X-Frame-Options / CSP). */
  async 'web.check'({ url }) {
    let u;
    try { u = new URL(url); } catch { throw new Error('Not a web address'); }
    if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https addresses can be opened');
    const self = { frameable: false, reason: 'That’s SkiffCode itself.' };
    if (isSelf(u)) return self;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    try {
      const r = await fetch(u, { method: 'GET', redirect: 'follow', signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (SkiffCode link check)' } });
      try { await r.body?.cancel(); } catch { /* fine */ }
      if (isSelf(new URL(r.url))) return self;
      const xfo = (r.headers.get('x-frame-options') || '').trim().toLowerCase();
      const fa = /frame-ancestors([^;]*)/i.exec(r.headers.get('content-security-policy') || '');
      const allowed = fa && fa[1].trim().split(/\s+/).some(v => v === '*' || /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:|$)/.test(v) || v === 'http:');
      if (fa && !allowed) return { frameable: false, reason: 'This site doesn’t allow being shown inside other apps.' };
      if (!fa && xfo && xfo !== 'allowall') return { frameable: false, reason: 'This site doesn’t allow being shown inside other apps.' };
      return { frameable: true, status: r.status };
    } catch {
      // unreachable from here (offline, VPN-only, …): let the browser try, it shows its own error
      return { frameable: true, unknown: true };
    } finally {
      clearTimeout(timer);
    }
  },
  async 'fs.write'({ root, path: p, text, mtime, force }) {
    const r = rootOf(root);
    const res = await fsops.write(r, p, text, mtime, force);
    gitChanged(r);
    return res;
  },
  async 'fs.create'({ root, path: p, type }) { const r = rootOf(root); await fsops.create(r, p, type); gitChanged(r); },
  async 'fs.rename'({ root, from, to }) { const r = rootOf(root); await fsops.rename(r, from, to); gitChanged(r); },
  /** Files dropped from Explorer / Finder onto a folder in the Files panel. */
  async 'fs.upload'({ root, path: p, data, replace }) { const r = rootOf(root); await fsops.upload(r, p, data, !!replace); gitChanged(r); },
  'fs.exists'({ root, paths }) { const r = rootOf(root); return (paths || []).filter(p => { try { return fs.existsSync(fsops.guard(r, p)); } catch { return false; } }); },
  /** A file dropped onto a Claude session or shell: saved outside the repo; returns its path to type in. */
  async 'drops.save'({ name, data }) {
    const buf = Buffer.from(String(data || ''), 'base64');
    if (!buf.length) throw new Error('That file is empty');
    if (buf.length > fsops.MAX_UPLOAD) throw new Error('Files over 50 MB can’t be attached');
    const day = new Date().toISOString().slice(0, 10);
    const dir = path.join(HOME, 'drops', day);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const clean = path.basename(String(name || 'file')).replace(/[^\w.@+-]+/g, '-').replace(/^-+/, '').slice(0, 80) || 'file';
    const ext = path.extname(clean);
    let target = path.join(dir, clean);
    for (let i = 2; fs.existsSync(target); i++) target = path.join(dir, `${clean.slice(0, clean.length - ext.length)}-${i}${ext}`);
    fs.writeFileSync(target, buf, { mode: 0o600 });
    return { path: target };
  },
  async 'fs.delete'({ root, path: p }) { const r = rootOf(root); await fsops.remove(r, p); gitChanged(r); },
  'fs.watch'({ root, path: p }, client) {
    const r = rootOf(root);
    const abs = fsops.guard(r, p || '');
    if (!client.watched.has(abs)) { // one count per client: unwatch and disconnect remove it once
      client.watched.add(abs);
      watcher.add(abs);
    }
    void watchGit(r);
  },
  'fs.unwatch'({ root, path: p }, client) {
    const abs = fsops.guard(rootOf(root), p || '');
    if (client.watched.delete(abs)) watcher.remove(abs);
  },

  // git
  async 'git.status'({ root }) {
    const r = rootOf(root);
    if (!isGitDir(r)) return { notGit: true, staged: [], changes: [], untracked: [], conflicts: [] };
    return git.status(r);
  },
  /** Turn a plain folder into a git repository. */
  async 'git.init'({ root }) {
    const r = rootOf(root);
    if (!isGitDir(r)) await git.git(r, ['init', '-q']);
    await folderBecameGit(r);
  },
  async 'git.changes'({ root }) {
    const r = rootOf(root);
    const st = await worktreeStatus(r, 0);
    const from = st.mergeBase || 'HEAD';
    return { status: st, from, files: await git.changesSince(r, from) };
  },
  async 'git.commits'({ root }) {
    const r = rootOf(root);
    if (!isGitDir(r)) return { commits: [] };
    const st = await worktreeStatus(r);
    return { base: st.base, commits: await git.commitsSince(r, st.mergeBase) };
  },
  async 'git.log'({ root, skip, max }) {
    const r = rootOf(root);
    if (!isGitDir(r)) return { commits: [], more: false };
    const n = Math.min(500, Math.max(1, Math.floor(Number(max)) || 50));
    const from = Math.max(0, Math.floor(Number(skip)) || 0);
    const got = await git.history(r, from, n + 1);
    return { commits: got.slice(0, n), more: got.length > n };
  },
  async 'git.commitFiles'({ root, sha }) {
    const r = rootOf(root);
    return { files: await git.commitFiles(r, sha), parent: await git.parentOf(r, sha) };
  },
  async 'git.show'({ root, ref, path: p }) { return { text: await git.showFile(rootOf(root), ref, p) }; },
  async 'git.stage'({ root, files }) { const r = rootOf(root); await git.stage(r, files); gitChanged(r); },
  async 'git.stageAll'({ root }) { const r = rootOf(root); await git.stageAll(r); gitChanged(r); },
  async 'git.unstage'({ root, files }) { const r = rootOf(root); await git.unstage(r, files); gitChanged(r); },
  async 'git.unstageAll'({ root }) { const r = rootOf(root); await git.unstageAll(r); gitChanged(r); },
  async 'git.discard'({ root, files }) { const r = rootOf(root); await git.discard(r, files); gitChanged(r); broadcast('fs.changed', { root: r, path: null }); },
  async 'git.commit'({ root, message, all, amend }) {
    const r = rootOf(root);
    if ((!message || !message.trim()) && !amend) throw new Error('Enter a commit message');
    const out = await git.commit(r, message && message.trim() ? message : '', { all, amend });
    gitChanged(r);
    return { output: out };
  },
  async 'git.push'({ root }) { const r = rootOf(root); const out = await git.push(r); gitChanged(r); return { output: out }; },
  async 'git.pull'({ root }) { const r = rootOf(root); const out = await git.pull(r); gitChanged(r); broadcast('fs.changed', { root: r, path: null }); return { output: out }; },

  // search
  async 'search.files'({ root }) { return search.files(rootOf(root)); },
  async 'search.text'({ root, ...opts }) { return search.text(rootOf(root), opts); },
  async 'search.definition'({ root, ...opts }) { return search.definition(rootOf(root), opts); },

  // per-worktree UI layout (open tabs), restored after reloads
  'layout.save'({ root, layout }) {
    const r = rootOf(root);
    if (JSON.stringify(layout ?? null).length > MAX_LAYOUT) throw new Error('That layout is too large to save');
    state.data.layouts = state.data.layouts || {};
    state.data.layouts[r] = layout;
    clearTimeout(api._layoutTimer);
    api._layoutTimer = setTimeout(() => state.save(), 500);
  },
};

const watcher = new fsops.Watcher((abs, name) => {
  let isDir = false;
  try { isDir = fs.statSync(abs).isDirectory(); } catch { /* deleted */ }
  const changed = isDir && name ? path.join(abs, name) : abs;
  const r = knownRootOf(abs);
  if (!r) return;
  if (name === '.git' || path.basename(abs) === '.git') void folderBecameGit(r);
  broadcast('fs.changed', { root: r, path: path.relative(r, changed).split(path.sep).join('/'), dir: isDir ? path.relative(r, abs).split(path.sep).join('/') : undefined });
  gitChanged(r);
});

// ------------------------------------------------------------------ HTTP

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.map': 'application/json', '.webmanifest': 'application/manifest+json' };

// Previews (images, PDFs, HTML) of files in a known worktree, at /view/<key>/<path>.
// The key stands for one worktree and is derived from the token, so it can't be guessed. No cookie is
// needed, so a previewed page's own images, CSS and links (relative paths) load too. Pages are served
// sandboxed (an origin of their own), so their scripts can't reach SkiffCode.
const VIEW_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.xml': 'text/xml', '.wasm': 'application/wasm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
};
const viewKey = root => crypto.createHmac('sha256', TOKEN).update(`view:${root}`).digest('hex').slice(0, 32);
// Files outside the worktrees (a report in /tmp, a build folder…), opened from a path you clicked:
// key -> { root: its folder, only: the one file, unless it is a page that needs its neighbours (CSS, images)
// and the folder isn't too broad to share (/, ~, a drive) }
const externalViews = new Map();
const encodeRel = rel => rel.split('/').map(encodeURIComponent).join('/');

/** A path as printed anywhere (Linux, ~, relative, C:\…, \\wsl.localhost\<distro>\…, file://…) → an absolute Linux path. */
function toLinuxPath(p, cwd) {
  let s = String(p || '').trim();
  if (/^file:\/\//i.test(s)) {
    try { s = decodeURIComponent(new URL(s).pathname); } catch { s = s.replace(/^file:\/\//i, ''); }
  }
  let m;
  if ((m = /^\\\\wsl(?:\.localhost|\$)\\[^\\]+(\\.*)?$/i.exec(s))) s = (m[1] || '\\').replace(/\\/g, '/');
  else if ((m = /^\/?([A-Za-z]):[\\/](.*)$/.exec(s))) s = `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
  s = s.replace(/^~(?=\/|$)/, os.homedir());
  return path.resolve(cwd || os.homedir(), s);
}
function knownRootOf(abs) {
  let best = null;
  for (const r of knownRoots) if ((abs === r || within(r, abs)) && (!best || r.length > best.length)) best = r;
  return best;
}
/** A /view URL for any file: inside a worktree via its key, otherwise its own folder (or just the file). */
function viewUrlFor(abs) {
  const root = knownRootOf(abs);
  if (root) return `/view/${viewKey(root)}/${encodeRel(path.relative(root, abs).split(path.sep).join('/'))}`;
  const dir = path.dirname(abs);
  const broad = dir.split('/').filter(Boolean).length < 2 || dir === os.homedir() || /^\/mnt\/[a-z]\/Users\/[^/]+$/i.test(dir);
  const only = broad || !/\.html?$/i.test(abs) ? path.basename(abs) : null;
  const key = viewKey(`external:${dir}:${only || ''}`);
  externalViews.set(key, { root: dir, only });
  return `/view/${key}/${encodeRel(path.basename(abs))}`;
}

function serveView(req, res, url) {
  const m = /^\/view\/([0-9a-f]{32})(\/.*)?$/.exec(url.pathname);
  const ext = m && externalViews.get(m[1]);
  const root = m && (ext ? ext.root : [...knownRoots].find(r => viewKey(r) === m[1]));
  if (!root) { res.writeHead(404); return res.end('not found'); }
  let rel;
  try { rel = decodeURIComponent((m[2] || '/').slice(1)); } catch { res.writeHead(400); return res.end(); }
  if (ext && ext.only && rel !== ext.only) { res.writeHead(404); return res.end('not found'); }
  let file = path.resolve(root, rel);
  if (file !== root && !within(root, file)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) {
      if (!url.pathname.endsWith('/')) { res.writeHead(302, { Location: `${url.pathname}/` }); return res.end(); }
      file = path.join(file, 'index.html');
      try { st = fs.statSync(file); } catch (e) { err = e; }
    }
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
    if (!fsops.realInside(root, file)) { res.writeHead(403); return res.end(); }
    const ext = path.extname(file).toLowerCase();
    let type = VIEW_TYPES[ext];
    if (!type) {
      // code, logs and other text show as text; anything else downloads
      try {
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(Math.min(8000, st.size));
        fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        type = buf.includes(0) ? 'application/octet-stream' : 'text/plain; charset=utf-8';
      } catch {
        type = 'application/octet-stream';
      }
    }
    const headers = {
      'Content-Type': type,
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    };
    // PDFs need the browser's own viewer, which doesn't run in a sandbox (and a PDF can't script the page).
    if (ext !== '.pdf') headers['Content-Security-Policy'] = `sandbox ${VIEW_SANDBOX}`;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

function cookieToken(req) {
  const m = /(?:^|;\s*)skiffcode_tkn=([0-9a-f]+)/.exec(req.headers.cookie || '');
  return m && m[1];
}
function tokenOk(t) {
  if (typeof t !== 'string') return false;
  const a = Buffer.from(t);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function authed(req) {
  return tokenOk(cookieToken(req));
}
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
// Bound to another address on purpose (SKIFFCODE_BIND), SkiffCode can be reached by names we can't know,
// so the Host check is skipped there and only the token protects it.
const CHECK_HOST = /^(127\.\d+\.\d+\.\d+|localhost|::1)$/.test(HOSTNAME);
/**
 * The request names SkiffCode by a loopback host (a DNS-rebinding page would send its own name), and
 * with `origin`, comes from SkiffCode's own page (no cross-site websockets).
 */
function hostOk(req, { origin = false } = {}) {
  const hostname = h => { try { return new URL(`http://${h}`).hostname; } catch { return null; } };
  if (CHECK_HOST && !LOOPBACK_NAMES.has(hostname(req.headers.host))) return false;
  if (!origin || !req.headers.origin) return true;
  try {
    const u = new URL(req.headers.origin);
    return LOOPBACK_NAMES.has(u.hostname) && Number(u.port || 80) === PORT;
  } catch {
    return false;
  }
}

function serveFile(res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404);
      return res.end('not found');
    }
    const headers = {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': file.startsWith(VENDOR) ? 'public, max-age=604800' : 'no-cache',
    };
    if (path.extname(file) === '.html') Object.assign(headers, { 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY' });
    res.writeHead(200, headers);
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

// A stray error (a pipe closed early, a client gone mid-write) shouldn't take the server down.
process.on('uncaughtException', e => console.error('skiffcode: uncaught error (kept running):', e && e.stack || e));
process.on('unhandledRejection', e => console.error('skiffcode: unhandled rejection (kept running):', e && e.stack || e));

const server = http.createServer((req, res) => {
  if (!hostOk(req)) {
    res.writeHead(403);
    return res.end();
  }
  const url = new URL(req.url, 'http://localhost');
  if (url.searchParams.has('tkn')) {
    const t = url.searchParams.get('tkn');
    if (tokenOk(t)) {
      res.writeHead(302, { 'Set-Cookie': `skiffcode_tkn=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`, Location: '/' });
      return res.end();
    }
  }
  if (url.pathname.startsWith('/view/')) return serveView(req, res, url);
  if (url.pathname === '/manifest.webmanifest' || /^\/icons\/[\w.-]+$/.test(url.pathname)) return serveFile(res, path.join(WEB, url.pathname.slice(1)));
  if (url.pathname === '/api/status') {
    // For the `skiffcode` launcher: is a page open? (token in a header, never in logs)
    if (!tokenOk(req.headers['x-skiffcode-token'])) {
      res.writeHead(403);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ version: VERSION, clients: clients.size, pid: process.pid }));
  }
  if (url.pathname === '/api/cli' && req.method === 'POST') {
    if (!tokenOk(req.headers['x-skiffcode-token'])) {
      res.writeHead(403);
      return res.end();
    }
    let body = '';
    req.on('data', d => { body += d; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      res.setHeader('Content-Type', 'application/json');
      try {
        const { cmd, args } = JSON.parse(body || '{}');
        if (!Object.hasOwn(cli, cmd)) throw new Error(`unknown command: ${cmd}`);
        const result = await cli[cmd](args || {});
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, result, clients: clients.size }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  if (!authed(req)) {
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><meta charset=utf-8><title>SkiffCode</title><body style="font:14px system-ui;background:#1e1e1e;color:#ccc;padding:40px">Open SkiffCode with the <code>skiffcode</code> command in your WSL terminal.</body>');
  }
  if (url.pathname === '/') return serveFile(res, path.join(WEB, 'index.html'));
  if (url.pathname.startsWith('/custom-sounds/')) {
    let name;
    try { name = decodeURIComponent(url.pathname.slice(15)); } catch { res.writeHead(400); return res.end(); }
    const f = sounds.file(`custom:${name}`);
    if (!f) { res.writeHead(404); return res.end(); }
    return serveFile(res, f);
  }
  const base = url.pathname.startsWith('/vendor/') ? VENDOR : WEB;
  let rel;
  try { rel = decodeURIComponent(url.pathname.replace(/^\/(vendor\/)?/, '')); } catch { res.writeHead(400); return res.end(); }
  const file = path.resolve(base, rel);
  if (!within(base, file)) {
    res.writeHead(403);
    return res.end();
  }
  serveFile(res, file);
});

server.on('upgrade', (req, socket) => {
  if (req.url !== '/ws' || !authed(req) || !hostOk(req, { origin: true })) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const conn = ws.accept(req, socket);
  if (!conn) return;
  const client = { id: crypto.randomUUID(), conn, terms: new Map(), watched: new Set() };
  clients.add(client);
  conn.on('message', async text => {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    const fn = typeof msg.method === 'string' && Object.hasOwn(api, msg.method) && typeof api[msg.method] === 'function' ? api[msg.method] : null;
    try {
      if (!fn) throw new Error(`Unknown method ${msg.method}`);
      const result = await fn(msg.params || {}, client);
      if (msg.id !== undefined) conn.send(JSON.stringify({ id: msg.id, result: result === undefined ? null : result }));
    } catch (e) {
      if (msg.id !== undefined) conn.send(JSON.stringify({ id: msg.id, error: { message: e.message, code: e.code } }));
    }
  });
  conn.on('binary', buf => {
    // [type=1 input][36-byte session id][data]
    if (buf[0] !== 1 || buf.length < 37) return;
    const id = buf.subarray(1, 37).toString('latin1').trim();
    const c = client.terms.get(id);
    if (c) {
      c.write(buf.subarray(37));
      sessions.userInput(id, buf.subarray(37));
    }
  });
  conn.on('close', () => {
    clients.delete(client);
    sessions.setViewing(client.id, null);
    for (const c of client.terms.values()) c.close();
    for (const abs of client.watched) watcher.remove(abs);
  });
});

// ------------------------------------------------------------------ CLI (`skiffcode new|claude|list`)

/** Commands from the `skiffcode` launcher, for scripts and Claude skills. */
const cli = {
  /** Worktree for <branch> in the repo at <dir> (created if needed) + a Claude session in it. */
  async new({ dir, branch, base, name, prompt, claude = true, show = true }) {
    if (!dir || !branch) throw new Error('usage: skiffcode new <repo-dir> <branch> [-b|--base <ref>] [--name <session name>] [--prompt <text>]');
    const repo = await addRepo(dir);
    broadcast('state', snapshot());
    if (repo.kind === 'folder') throw new Error(`${repo.path} isn’t a git repository, so it has no branches. Use: skiffcode claude ${repo.path}`);
    const b = String(branch).trim();
    const wts = await worktreesOf(repo);
    let wt = wts.find(w => w.branch === b);
    let created = false;
    if (!wt) {
      const local = await git.git(repo.path, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]).then(() => true, () => false);
      const remote = !local && (await git.baseRefs(repo.path).catch(() => [])).find(r => r.replace(/^[^/]+\//, '') === b && r !== b);
      const res = local || remote
        ? await api['worktrees.create']({ repo: repo.path, branch: remote || b, ...(remote ? { newBranch: b, base: remote, track: true } : {}), startClaude: false })
        : await (async () => {
          const from = (base && String(base).trim()) || (await git.defaultBase(repo.path));
          // A remote base (origin/develop) is fetched first, so the branch starts from its latest commit.
          const rm = (await git.remoteNames(repo.path)).find(n => from.startsWith(n + '/'));
          if (rm) await git.git(repo.path, ['fetch', '--quiet', rm, `${from.slice(rm.length + 1)}:refs/remotes/${from}`]).catch(() => {});
          if (!(await git.refExists(repo.path, from))) throw new Error(`Base branch not found: ${from}`);
          return api['worktrees.create']({ repo: repo.path, newBranch: b, base: from, startClaude: false });
        })();
      wt = { path: res.path, branch: res.branch };
      created = true;
    }
    let session = null;
    if (claude) session = await sessions.create({ kind: 'claude', repoPath: repo.path, worktreePath: wt.path, branch: wt.branch, name, prompt, ...TERM_SIZE });
    if (show) broadcast('open.worktree', { path: wt.path, repo: repo.path, session: session && session.id });
    return { repo: repo.path, worktree: wt.path, branch: wt.branch, created, session: session && { id: session.id, name: session.name } };
  },
  /** A new Claude session in an existing worktree (or repo folder). */
  async claude({ dir, name, prompt, show = true }) {
    if (!dir) throw new Error('usage: skiffcode claude <worktree-dir> [--name <session name>] [--prompt <text>]');
    const repo = await addRepo(dir);
    const root = rootOf(realpath(dir));
    const wt = (await worktreesOf(repo)).find(w => w.path === root) || { path: root };
    const session = await sessions.create({ kind: 'claude', repoPath: repo.path, worktreePath: wt.path, branch: wt.branch, name, prompt, ...TERM_SIZE });
    if (show) broadcast('open.worktree', { path: wt.path, repo: repo.path, session: session.id });
    return { repo: repo.path, worktree: wt.path, branch: wt.branch, session: { id: session.id, name: session.name } };
  },
  /** Repos, worktrees and sessions, for scripts. */
  async list() {
    const out = [];
    for (const r of state.repos) {
      const wts = await worktreesOf(r).catch(() => []);
      out.push({ repo: r.path, name: r.name, worktrees: wts.map(w => ({ path: w.path, branch: w.branch, sessions: sessions.list().filter(s => s.worktreePath === w.path).map(s => ({ id: s.id, kind: s.kind, name: s.name, state: s.state })) })) });
    }
    return out;
  },
};

// ------------------------------------------------------------------ inbox (`skiffcode <dir>`)

const INBOX = path.join(HOME, 'inbox');
fs.mkdirSync(INBOX, { recursive: true, mode: 0o700 });
let draining = false;
async function drainInbox() {
  if (draining) return;
  draining = true;
  try {
    for (const f of fs.readdirSync(INBOX).filter(f => f.endsWith('.path')).sort()) {
      const full = path.join(INBOX, f);
      const dir = fs.readFileSync(full, 'utf8').trim();
      fs.rmSync(full, { force: true });
      try {
        const repo = await addRepo(dir);
        broadcast('open.worktree', { path: realpath(dir), repo: repo.path });
      } catch (e) {
        broadcast('toast', { kind: 'error', text: e.message });
      }
    }
  } catch { /* ignore */ } finally {
    draining = false;
  }
}
fs.watch(INBOX, () => void drainInbox());
void drainInbox();

server.listen(PORT, HOSTNAME, () => {
  fs.writeFileSync(PID_FILE, String(process.pid));
  // The token goes only to a terminal: `skiffcode` sends this output to server.log.
  if (process.stdout.isTTY) console.log(`SkiffCode ${VERSION} on http://localhost:${PORT}/?tkn=${TOKEN}`);
  else console.log(`SkiffCode ${VERSION} on http://localhost:${PORT}/ (token in ${TOKEN_FILE})`);
});
server.on('error', e => {
  console.error(`skiffcode: cannot listen on ${HOSTNAME}:${PORT}: ${e.message}`);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  // Sessions keep running in their terminal hosts; just stop serving.
  sessions.dispose();
  server.close();
  try { if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) fs.rmSync(PID_FILE); } catch { /* gone */ }
  process.exit(0);
});
module.exports = { api, state, sessions, server };
