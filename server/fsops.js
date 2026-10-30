'use strict';
// File tree, read/write and lightweight watching for the open worktree.
const fs = require('fs');
const path = require('path');
const { run, within, safeToDelete } = require('./util');

const MAX_EDIT_SIZE = 8 * 1024 * 1024;
const HIDDEN = new Set(['.git']);

function guard(root, p) {
  const abs = path.resolve(root, p);
  if (!within(root, abs)) throw new Error('Path is outside the worktree');
  return abs;
}

/** Entries of one directory: folders first, with ignored ones flagged (dimmed in the UI). */
async function list(root, rel = '') {
  const dir = guard(root, rel);
  const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  const entries = dirents
    .filter(d => !HIDDEN.has(d.name))
    .map(d => {
      let type = d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'link' : 'file';
      if (type === 'link') {
        try {
          type = fs.statSync(path.join(dir, d.name)).isDirectory() ? 'dir' : 'file';
        } catch {
          type = 'file';
        }
      }
      return { name: d.name, path: path.posix.join(rel.split(path.sep).join('/'), d.name), type };
    });
  if (entries.length && fs.existsSync(path.join(root, '.git'))) {
    try {
      const out = await run('git', ['check-ignore', '--stdin', '-z'], {
        cwd: root,
        input: entries.map(e => (e.type === 'dir' ? e.path + '/' : e.path)).join('\0'),
      }).catch(e => e.stdout || '');
      const ignored = new Set(out.split('\0').filter(Boolean).map(p => p.replace(/\/$/, '')));
      for (const e of entries) if (ignored.has(e.path)) e.ignored = true;
    } catch { /* not a git dir */ }
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.type === 'dir' ? -1 : 1));
  return entries;
}

async function read(root, rel) {
  const abs = guard(root, rel);
  const st = await fs.promises.stat(abs);
  if (st.size > MAX_EDIT_SIZE) return { tooLarge: true, size: st.size, mtime: st.mtimeMs };
  const buf = await fs.promises.readFile(abs);
  const binary = buf.subarray(0, 8000).includes(0);
  return { text: binary ? '' : buf.toString('utf8'), binary, size: st.size, mtime: st.mtimeMs };
}

/** Write a file; refuses when it changed on disk since `expectMtime` (unless force). */
async function write(root, rel, text, expectMtime, force) {
  const abs = guard(root, rel);
  if (!force && expectMtime) {
    try {
      const st = await fs.promises.stat(abs);
      if (Math.abs(st.mtimeMs - expectMtime) > 1) {
        const e = new Error('The file changed on disk since you opened it.');
        e.code = 'CONFLICT';
        throw e;
      }
    } catch (e) {
      if (e.code === 'CONFLICT') throw e;
    }
  }
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, text);
  return { mtime: (await fs.promises.stat(abs)).mtimeMs };
}

async function create(root, rel, type) {
  const abs = guard(root, rel);
  if (fs.existsSync(abs)) throw new Error(`${rel} already exists`);
  if (type === 'dir') await fs.promises.mkdir(abs, { recursive: true });
  else {
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, '');
  }
}

async function rename(root, from, to) {
  const a = guard(root, from);
  const b = guard(root, to);
  if (fs.existsSync(b)) throw new Error(`${to} already exists`);
  await fs.promises.mkdir(path.dirname(b), { recursive: true });
  await fs.promises.rename(a, b);
}

const MAX_UPLOAD = 50 * 1024 * 1024;
/** Write a dropped file (base64) into the worktree. Refuses to overwrite unless replace. */
async function upload(root, rel, base64, replace) {
  const abs = guard(root, rel);
  if (abs === path.resolve(root)) throw new Error('Pick a file name');
  if (fs.existsSync(abs)) {
    if (!replace) { const e = new Error(`${rel} already exists`); e.code = 'EXISTS'; throw e; }
    if (fs.statSync(abs).isDirectory()) throw new Error(`${rel} is a folder`);
  }
  const data = Buffer.from(String(base64 || ''), 'base64');
  if (data.length > MAX_UPLOAD) throw new Error(`${path.basename(rel)} is over 50 MB`);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, data);
}

async function remove(root, rel) {
  const abs = guard(root, rel);
  if (abs === path.resolve(root) || !safeToDelete(abs)) throw new Error('Refusing to delete that');
  await fs.promises.rm(abs, { recursive: true, force: true });
}

/**
 * Watches the folders a client has expanded and the files it has open
 * (one non-recursive watcher each), so even huge trees stay cheap.
 */
class Watcher {
  constructor(onChange) {
    this.onChange = onChange; // (absPath) => void
    this.watchers = new Map(); // abs -> { w, refs }
  }
  add(abs) {
    const e = this.watchers.get(abs);
    if (e) return void e.refs++;
    try {
      const w = fs.watch(abs, { persistent: false }, (_ev, name) => this.onChange(abs, name ? String(name) : undefined));
      w.on('error', () => this.drop(abs));
      this.watchers.set(abs, { w, refs: 1 });
    } catch { /* gone */ }
  }
  remove(abs) {
    const e = this.watchers.get(abs);
    if (!e) return;
    if (--e.refs <= 0) this.drop(abs);
  }
  drop(abs) {
    const e = this.watchers.get(abs);
    if (!e) return;
    try { e.w.close(); } catch { /* ignore */ }
    this.watchers.delete(abs);
  }
  closeAll() {
    for (const k of [...this.watchers.keys()]) this.drop(k);
  }
}

module.exports = { list, read, write, create, rename, remove, upload, guard, Watcher };
