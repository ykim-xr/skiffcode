// Monaco text models for files on disk (shared by editor and diff tabs, so an
// edit in a diff shows up in the file tab and vice versa) and for git versions.
import { call, on } from './rpc.js';
import { languageOf } from './util.js';
import { confirmDialog, toast } from './dialogs.js';

const files = new Map(); // key root\0path -> entry
const gitModels = new Map(); // key root\0ref\0path -> model
const listeners = new Set(); // (entry) => void   (dirty / saved changes)

const key = (root, p) => `${root}\0${p}`;
export const fileUri = (root, p) => monaco.Uri.from({ scheme: 'file', path: `${root}/${p}` });

export function onModelState(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const fire = e => listeners.forEach(fn => fn(e));

/** Get (and load) the model for a working-tree file. Each user must call release(). */
export async function acquire(root, p) {
  const k = key(root, p);
  let e = files.get(k);
  if (e) {
    e.refs++;
    await e.ready;
    return e;
  }
  e = { root, path: p, refs: 1, model: null, mtime: 0, savedVersion: 0, binary: false, tooLarge: false, missing: false, conflict: false };
  files.set(k, e);
  e.ready = (async () => {
    let r;
    try {
      r = await call('fs.read', { root, path: p });
    } catch (err) {
      e.missing = true;
      r = { text: '' };
    }
    e.binary = !!r.binary;
    e.tooLarge = !!r.tooLarge;
    e.mtime = r.mtime || 0;
    const uri = fileUri(root, p);
    e.model = monaco.editor.getModel(uri) || monaco.editor.createModel(r.text || '', languageOf(p), uri);
    e.savedVersion = e.model.getAlternativeVersionId();
    e.model.onDidChangeContent(() => fire(e));
    void call('fs.watch', { root, path: p }).catch(() => {});
  })();
  await e.ready;
  return e;
}

export function release(e) {
  if (--e.refs > 0) return;
  files.delete(key(e.root, e.path));
  void call('fs.unwatch', { root: e.root, path: e.path }).catch(() => {});
  e.model.dispose();
}

export function isDirty(e) {
  return !!e && !!e.model && e.model.getAlternativeVersionId() !== e.savedVersion;
}

export function anyDirty() {
  return [...files.values()].some(isDirty);
}

export async function save(e, { force = false } = {}) {
  if (!e || e.binary || e.tooLarge) return false;
  try {
    const r = await call('fs.write', { root: e.root, path: e.path, text: e.model.getValue(), mtime: e.mtime, force });
    e.mtime = r.mtime;
    e.savedVersion = e.model.getAlternativeVersionId();
    e.conflict = false;
    e.missing = false;
    fire(e);
    return true;
  } catch (err) {
    if (err.code === 'CONFLICT') {
      const v = await confirmDialog({
        title: `${e.path} changed on disk`,
        detail: 'Someone (probably Claude) changed this file after you opened it.',
        buttons: [
          { label: 'Load their version', value: 'reload' },
          { label: 'Overwrite with mine', value: 'overwrite', danger: true },
        ],
      });
      if (v === 'overwrite') return save(e, { force: true });
      if (v === 'reload') await reload(e, true);
      return false;
    }
    toast(`Couldn’t save ${e.path}: ${err.message}`, { kind: 'error' });
    return false;
  }
}

/** Reload from disk; keeps your edits unless `discard`. */
export async function reload(e, discard = false) {
  if (isDirty(e) && !discard) {
    e.conflict = true;
    fire(e);
    return;
  }
  let r;
  try {
    r = await call('fs.read', { root: e.root, path: e.path });
  } catch {
    e.missing = true;
    fire(e);
    return;
  }
  e.missing = false;
  if (r.text === e.model.getValue()) {
    e.mtime = r.mtime;
    return;
  }
  // pushEditOperations keeps undo history and the cursor where it was.
  e.model.pushEditOperations([], [{ range: e.model.getFullModelRange(), text: r.text }], () => null);
  e.mtime = r.mtime;
  e.savedVersion = e.model.getAlternativeVersionId();
  e.conflict = false;
  fire(e);
}

/** Read-only model of a file at a git ref ('' when it doesn't exist there). */
export async function gitModel(root, ref, p) {
  const k = `${root}\0${ref}\0${p}`;
  const cached = gitModels.get(k);
  if (cached && !cached.isDisposed()) return cached;
  const { text } = await call('git.show', { root, ref, path: p });
  const uri = monaco.Uri.from({ scheme: 'skiffcode-git', path: `${root}/${p}`, query: ref });
  const existing = monaco.editor.getModel(uri);
  const m = existing || monaco.editor.createModel(text, languageOf(p), uri);
  if (existing) existing.setValue(text);
  gitModels.set(k, m);
  return m;
}

/** Refresh cached git versions that move (HEAD, index) after commits / staging. */
export async function refreshGit(root, refs) {
  for (const [k, m] of gitModels) {
    const [r, ref, p] = k.split('\0');
    if (r !== root || (refs && !refs.includes(ref))) continue;
    if (m.isDisposed()) {
      gitModels.delete(k);
      continue;
    }
    try {
      const { text } = await call('git.show', { root, ref, path: p });
      if (!m.isDisposed() && m.getValue() !== text) m.setValue(text);
    } catch { /* keep */ }
  }
}

export function emptyModel(p) {
  return monaco.editor.createModel('', languageOf(p));
}

// Files changed on disk (Claude edits, git checkout, discard…): reload clean ones.
on('fs.changed', ({ root, path: p }) => {
  for (const e of files.values()) {
    if (e.root !== root) continue;
    if (p === null || e.path === p) void reload(e);
  }
});
on('git.changed', ({ root }) => void refreshGit(root, ['HEAD', ':0']));
