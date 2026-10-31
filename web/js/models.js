// Monaco text models for files on disk (shared by editor and diff tabs, so an
// edit in a diff shows up in the file tab and vice versa) and for git versions.
import { call, on } from './rpc.js';
import { languageOf } from './util.js';
import { confirmDialog, toast } from './dialogs.js';

const files = new Map(); // key root\0path -> entry
const gitModels = new Map(); // key root\0ref\0path -> { model, refs }
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
    } catch {
      e.missing = true;
      r = { text: '' };
    }
    e.binary = !!r.binary;
    e.tooLarge = !!r.tooLarge;
    e.mtime = r.mtime || 0;
    const uri = fileUri(root, p);
    e.model = monaco.editor.getModel(uri) || monaco.editor.createModel(r.text || '', languageOf(p), uri);
    e.savedVersion = e.model.getAlternativeVersionId();
    if (e.refs <= 0) return e.model.dispose(); // released while it loaded
    e.model.onDidChangeContent(() => fire(e));
    void call('fs.watch', { root, path: p }).catch(() => {});
  })();
  await e.ready;
  return e;
}

export function release(e) {
  if (--e.refs > 0) return;
  files.delete(key(e.root, e.path));
  if (!e.model) return; // still loading: acquire disposes it when it arrives
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
  // What is written, taken together: typing during the write must leave the file unsaved.
  const text = e.model.getValue();
  const version = e.model.getAlternativeVersionId();
  try {
    const r = await call('fs.write', { root: e.root, path: e.path, text, mtime: e.mtime, force });
    e.mtime = r.mtime;
    e.savedVersion = version;
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
  await e.ready;
  if (!e.model || e.model.isDisposed()) return;
  const p = e.path;
  const dirty = isDirty(e) && !discard;
  let r;
  try {
    r = await call('fs.read', { root: e.root, path: p });
  } catch {
    if (e.path !== p || e.model.isDisposed()) return; // renamed or closed meanwhile
    e.missing = true;
    fire(e);
    return;
  }
  if (e.path !== p || e.model.isDisposed()) return;
  e.missing = false;
  if (dirty) {
    // Same mtime: the content on disk didn't change (a rename, your own save), so no conflict.
    if (r.mtime !== e.mtime) e.conflict = true;
    fire(e);
    return;
  }
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

/** Read-only model of a file at a git ref ('' when it doesn't exist there). Each user must call releaseGit(). */
export async function gitModel(root, ref, p) {
  const k = `${root}\0${ref}\0${p}`;
  let g = gitModels.get(k);
  if (!g) {
    const { text } = await call('git.show', { root, ref, path: p });
    g = gitModels.get(k); // another view may have loaded it meanwhile
    if (!g) {
      const uri = monaco.Uri.from({ scheme: 'skiffcode-git', path: `${root}/${p}`, query: ref });
      const existing = monaco.editor.getModel(uri);
      const m = existing || monaco.editor.createModel(text, languageOf(p), uri);
      if (existing) existing.setValue(text);
      g = { model: m, refs: 0 };
      gitModels.set(k, g);
    }
  }
  g.refs++;
  return g.model;
}

/** Free a git version no view shows any more, so refreshGit doesn't re-read it. */
export function releaseGit(m) {
  for (const [k, g] of gitModels) {
    if (g.model !== m) continue;
    if (--g.refs <= 0) {
      gitModels.delete(k);
      m.dispose();
    }
    return;
  }
}

/** Refresh cached git versions that move (HEAD, index) after commits / staging. */
export async function refreshGit(root, refs) {
  for (const [k, { model: m }] of gitModels) {
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

/**
 * A file or folder was renamed in SkiffCode: move its open models to the new path, keeping
 * unsaved edits. Views find the new model through onModelState (entry.model changed).
 */
export function move(root, from, to) {
  for (const e of [...files.values()]) {
    if (e.root !== root || !e.model) continue;
    const p = e.path === from ? to : e.path.startsWith(`${from}/`) ? to + e.path.slice(from.length) : null;
    if (p === null) continue;
    const old = e.model;
    const dirty = isDirty(e);
    files.delete(key(root, e.path));
    void call('fs.unwatch', { root, path: e.path }).catch(() => {});
    const uri = fileUri(root, p);
    const existing = monaco.editor.getModel(uri);
    e.model = existing || monaco.editor.createModel(old.getValue(), languageOf(p), uri);
    if (existing) existing.setValue(old.getValue());
    e.savedVersion = dirty ? -1 : e.model.getAlternativeVersionId();
    e.path = p;
    e.missing = false;
    files.set(key(root, p), e);
    e.model.onDidChangeContent(() => fire(e));
    void call('fs.watch', { root, path: p }).catch(() => {});
    fire(e); // views switch to the new model before the old one goes
    old.dispose();
  }
}

// Files changed on disk (Claude edits, git checkout, discard…): reload clean ones.
on('fs.changed', ({ root, path: p }) => {
  for (const e of files.values()) {
    if (e.root !== root) continue;
    if (p === null || e.path === p) void reload(e);
  }
});
on('git.changed', ({ root }) => void refreshGit(root, ['HEAD', ':0']));
// The server forgets a connection's watches when it drops.
on('reconnect', () => {
  for (const e of files.values()) if (e.model) void call('fs.watch', { root: e.root, path: e.path }).catch(() => {});
});
