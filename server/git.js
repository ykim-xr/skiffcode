'use strict';
const fs = require('fs');
const path = require('path');
const { run } = require('./util');

const git = (cwd, args, opts = {}) => run('git', args, { cwd, ...opts });

/** A ref, sha or branch from a page goes into git's arguments: never one git would read as an option. */
function safeRef(ref) {
  if (typeof ref !== 'string' || !ref || ref.startsWith('-')) throw new Error(`Not a valid ref: ${ref}`);
  return ref;
}

async function resolveRepoRoot(dir) {
  const common = (await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  // A submodule's git dir sits in its parent's .git/modules: the repo is its own working folder.
  const superproject = (await git(dir, ['rev-parse', '--show-superproject-working-tree']).catch(() => '')).trim();
  if (superproject || common.includes(`${path.sep}.git${path.sep}modules${path.sep}`)) return (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
  return path.basename(common) === '.git' ? path.dirname(common) : common;
}

function parseWorktreeList(porcelain) {
  const entries = [];
  let cur;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) entries.push((cur = { path: line.slice(9) }));
    else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line === 'bare') cur.bare = true;
    else if (line.startsWith('locked')) cur.locked = true;
    else if (line.startsWith('prunable')) cur.prunable = true;
  }
  return entries
    .map((e, i) => ({ ...e, isMain: i === 0 && !e.bare }))
    .filter(e => !e.bare && e.path)
    .map(e => ({ path: e.path, head: e.head || '', branch: e.branch, detached: !!e.detached, locked: !!e.locked, prunable: !!e.prunable, isMain: e.isMain }));
}

async function listWorktrees(repo) {
  const wts = parseWorktreeList(await git(repo, ['worktree', 'list', '--porcelain']));
  // git lists a submodule's main checkout at its git dir (.git/modules/…), not at its files.
  const main = wts.find(w => w.isMain);
  if (main && main.path.includes(`${path.sep}.git${path.sep}modules${path.sep}`)) main.path = (await git(repo, ['rev-parse', '--show-toplevel'])).trim();
  return wts.sort((a, b) => (a.isMain === b.isMain ? (a.branch || a.path).localeCompare(b.branch || b.path) : a.isMain ? -1 : 1));
}

async function localBranches(repo) {
  const out = await git(repo, ['for-each-ref', '--format=%(refname:short)', '--sort=-committerdate', 'refs/heads']);
  return out.split('\n').map(s => s.trim()).filter(Boolean);
}

async function remoteNames(repo) {
  return (await git(repo, ['remote']).catch(() => '')).split('\n').map(s => s.trim()).filter(Boolean);
}

async function baseRefs(repo) {
  const [refs, remotes] = await Promise.all([
    git(repo, ['for-each-ref', '--format=%(refname:short)', '--sort=-committerdate', 'refs/heads', 'refs/remotes']),
    remoteNames(repo),
  ]);
  const remoteSet = new Set(remotes);
  return refs.split('\n').map(s => s.trim()).filter(r => r && !r.endsWith('/HEAD') && !remoteSet.has(r));
}

async function defaultBase(repo) {
  try {
    const r = (await git(repo, ['rev-parse', '--abbrev-ref', 'origin/HEAD'])).trim();
    if (r && r !== 'origin/HEAD') return r;
  } catch { /* none */ }
  try {
    const main = (await listWorktrees(repo)).find(w => w.isMain);
    if (main && main.branch) return main.branch;
  } catch { /* none */ }
  return 'HEAD';
}

async function refExists(dir, ref) {
  try {
    await git(dir, ['rev-parse', '--verify', '--quiet', `${safeRef(ref)}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

async function isValidBranchName(repo, name) {
  try {
    await git(repo, ['check-ref-format', '--branch', name]);
    return true;
  } catch {
    return false;
  }
}

async function isSameBranch(dir, ref, branch) {
  if (!branch) return false;
  const full = (await git(dir, ['rev-parse', '--symbolic-full-name', ref]).catch(() => '')).trim();
  if (full === `refs/heads/${branch}`) return true;
  return full.startsWith('refs/remotes/') && full.split('/').slice(3).join('/') === branch;
}

/** What to compare a worktree with: its base branch if different, else its upstream, else nothing. */
async function compareBase(dir, branch, preferred) {
  if (preferred && (await refExists(dir, preferred)) && !(await isSameBranch(dir, preferred, branch))) return preferred;
  if (branch) {
    try {
      const up = (await git(dir, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`])).trim();
      if (up) return up;
    } catch { /* no upstream */ }
  }
  return undefined;
}

/** `git status --porcelain=v2 --branch -z`, split into the lists a Source Control view needs. */
function parseStatusV2(out) {
  const res = { branch: undefined, upstream: undefined, ahead: 0, behind: 0, oid: undefined, staged: [], changes: [], untracked: [], conflicts: [] };
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith('# branch.head ')) res.branch = line.slice(14) === '(detached)' ? undefined : line.slice(14);
    else if (line.startsWith('# branch.oid ')) res.oid = line.slice(13);
    else if (line.startsWith('# branch.upstream ')) res.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) { res.ahead = Number(m[1]); res.behind = Number(m[2]); }
    } else if (line[0] === '1' || line[0] === '2') {
      const f = line.split(' ');
      const xy = f[1];
      const p = line[0] === '1' ? f.slice(8).join(' ') : f.slice(9).join(' ');
      const orig = line[0] === '2' ? parts[++i] : undefined;
      if (xy[0] !== '.') res.staged.push({ path: p, status: xy[0], oldPath: orig });
      if (xy[1] !== '.') res.changes.push({ path: p, status: xy[1] });
    } else if (line[0] === 'u') {
      res.conflicts.push({ path: line.split(' ').slice(10).join(' '), status: 'U' });
    } else if (line[0] === '?') {
      res.untracked.push({ path: line.slice(2), status: '?' });
    }
  }
  return res;
}

async function status(dir) {
  return parseStatusV2(await git(dir, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--ignore-submodules'], { timeout: 30_000 }));
}

/** Numbers for the sidebar: ahead/behind base, +/- lines and files since the merge base, uncommitted count. */
async function branchStatus(dir, base) {
  const st = { base, mergeBase: undefined, ahead: 0, behind: 0, insertions: 0, deletions: 0, files: 0, dirty: 0 };
  const s = await status(dir).catch(() => null);
  if (s) st.dirty = new Set([...s.staged, ...s.changes, ...s.untracked, ...s.conflicts].map(f => f.path)).size; // a staged file edited again is one
  let from = 'HEAD';
  if (base) {
    try {
      st.mergeBase = (await git(dir, ['merge-base', base, 'HEAD'])).trim();
      from = st.mergeBase;
      const [behind, ahead] = (await git(dir, ['rev-list', '--left-right', '--count', `${base}...HEAD`])).trim().split(/\s+/).map(Number);
      st.ahead = ahead || 0;
      st.behind = behind || 0;
    } catch {
      st.mergeBase = undefined;
    }
  }
  const short = await git(dir, ['diff', '--shortstat', from]).catch(() => '');
  st.files = Number((/(\d+) files? changed/.exec(short) || [])[1] || 0) + (s ? s.untracked.length : 0);
  st.insertions = Number((/(\d+) insertions?/.exec(short) || [])[1] || 0);
  st.deletions = Number((/(\d+) deletions?/.exec(short) || [])[1] || 0);
  return st;
}

function parseNameStatus(out) {
  const parts = out.split('\0').filter(p => p !== '');
  const res = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i][0];
    if (status === 'R' || status === 'C') {
      res.push({ status, oldPath: parts[i + 1], path: parts[i + 2] });
      i += 2;
    } else {
      res.push({ status, path: parts[i + 1] });
      i += 1;
    }
  }
  return res;
}

async function changesSince(dir, from) {
  const [tracked, untracked] = await Promise.all([
    git(dir, ['diff', '--name-status', '-z', '-M', from]).catch(() => ''),
    git(dir, ['ls-files', '--others', '--exclude-standard', '-z']).catch(() => ''),
  ]);
  const res = parseNameStatus(tracked);
  for (const p of untracked.split('\0').filter(Boolean)) res.push({ status: '?', path: p });
  return res.sort((a, b) => a.path.localeCompare(b.path));
}

const LOG_FORMAT = '--format=%H%x1f%h%x1f%s%x1f%an%x1f%ct';

function parseLog(out) {
  return out.split('\n').filter(Boolean).map(l => {
    const [sha, short, subject, author, ct] = l.split('\x1f');
    return { sha, short, subject, author, time: Number(ct) * 1000 };
  });
}

async function commitsSince(dir, since, max = 200) {
  const range = since ? [`${since}..HEAD`] : ['HEAD'];
  return parseLog(await git(dir, ['log', LOG_FORMAT, '-n', String(since ? max : 20), ...range]).catch(() => ''));
}

/** Full history of HEAD, newest first, one page at a time. */
async function history(dir, skip = 0, max = 50) {
  return parseLog(await git(dir, ['log', 'HEAD', LOG_FORMAT, `--skip=${skip}`, '-n', String(max)]).catch(() => ''));
}

async function commitFiles(dir, sha) {
  return parseNameStatus(await git(dir, ['show', '--name-status', '-z', '-M', '--format=', safeRef(sha)]).catch(() => ''));
}

async function parentOf(dir, sha) {
  safeRef(sha);
  try {
    return (await git(dir, ['rev-parse', '--verify', '--quiet', `${sha}^`])).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** File content at a ref ('' if missing). ref ":0" = staged version. */
async function showFile(dir, ref, rel) {
  const spec = ref === ':0' ? `:0:${rel}` : `${safeRef(ref)}:${rel}`;
  return git(dir, ['show', spec], { maxBuffer: 32 * 1024 * 1024 }).catch(() => '');
}

// ---- actions

async function stage(dir, files) {
  if (files.length) await git(dir, ['add', '-A', '--', ...files]);
}
async function stageAll(dir) {
  await git(dir, ['add', '-A']);
}
async function unstage(dir, files) {
  if (!files.length) return;
  try {
    await git(dir, ['restore', '--staged', '--', ...files]);
  } catch {
    await git(dir, ['reset', '-q', '--', ...files]); // before the first commit
  }
}
async function unstageAll(dir) {
  try {
    await git(dir, ['restore', '--staged', '.']);
  } catch {
    await git(dir, ['reset', '-q']);
  }
}
/** Throw away working-tree changes; untracked files are deleted. */
async function discard(dir, files) {
  const s = await status(dir);
  const untracked = new Set(s.untracked.map(f => f.path));
  const tracked = files.filter(f => !untracked.has(f));
  if (tracked.length) await git(dir, ['restore', '--worktree', '--', ...tracked]).catch(() => git(dir, ['checkout', '--', ...tracked]));
  for (const f of files.filter(f => untracked.has(f))) {
    const abs = path.join(dir, f);
    if (abs.startsWith(dir + path.sep)) fs.rmSync(abs, { recursive: true, force: true });
  }
}
async function commit(dir, message, { all = false, amend = false } = {}) {
  if (all) await git(dir, ['add', '-A']);
  if (amend && !message) return git(dir, ['commit', '--amend', '--no-edit']);
  const args = ['commit', '-F', '-'];
  if (amend) args.push('--amend');
  return git(dir, args, { input: message });
}
async function push(dir) {
  const s = await status(dir);
  if (!s.branch) throw new Error('Not on a branch (detached HEAD).');
  const args = s.upstream ? ['push'] : ['push', '-u', 'origin', s.branch];
  const r = await run('git', args, { cwd: dir, timeout: 180_000 }).catch(e => { throw new Error(e.stderr || e.message); });
  return r;
}
async function pull(dir) {
  return run('git', ['pull', '--no-edit'], { cwd: dir, timeout: 180_000 }).catch(e => { throw new Error(e.stderr || e.message); });
}

async function addWorktree(repo, target, spec) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (spec.newBranch) await git(repo, ['worktree', 'add', ...(spec.track ? ['--track'] : ['--no-track']), '-b', spec.newBranch, target, safeRef(spec.base)]);
  else await git(repo, ['worktree', 'add', target, safeRef(spec.branch)]);
}
async function removeWorktree(repo, target, force) {
  const args = ['worktree', 'remove'];
  for (let i = 0; i < force; i++) args.push('--force');
  await git(repo, [...args, target]);
}
async function pruneWorktrees(repo) {
  await git(repo, ['worktree', 'prune']).catch(() => undefined);
}
async function deleteBranch(repo, branch, force) {
  await git(repo, ['branch', force ? '-D' : '-d', safeRef(branch)]);
}
async function unpushedCount(repo, branch) {
  safeRef(branch);
  const o = await git(repo, ['rev-list', '--count', branch, '--not', '--remotes']).catch(() => '0');
  return Number(o.trim()) || 0;
}
async function gitDir(dir) {
  return (await git(dir, ['rev-parse', '--path-format=absolute', '--git-dir'])).trim();
}

function sanitizeForPath(branch) {
  return branch.replace(/[\\/]+/g, '-').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
}

module.exports = {
  git, resolveRepoRoot, parseWorktreeList, listWorktrees, localBranches, remoteNames, baseRefs, defaultBase, refExists, isValidBranchName,
  compareBase, parseStatusV2, status, branchStatus, parseNameStatus, changesSince, commitsSince, history, commitFiles, parentOf, showFile,
  stage, stageAll, unstage, unstageAll, discard, commit, push, pull, addWorktree, removeWorktree, pruneWorktrees, deleteBranch,
  unpushedCount, gitDir, sanitizeForPath,
};
