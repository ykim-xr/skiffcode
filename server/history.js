'use strict';
// Past Claude Code conversations for a folder, read from Claude's own transcripts
// (<config dir>/projects/<folder with every non-alphanumeric character as "-">/<id>.jsonl).
// Lets you pick up conversations started elsewhere (plain terminal, Orca, …) as SkiffCode sessions.
const fs = require('fs');
const path = require('path');

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const HEAD = 256 * 1024;
const TAIL = 128 * 1024;

const encode = p => p.replace(/[^a-zA-Z0-9]/g, '-');
const squash = s => s.replace(/[^a-zA-Z0-9]/g, '');

function readRange(file, start, len) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function lines(text) {
  const out = [];
  for (const l of text.split('\n')) {
    if (!l.startsWith('{')) continue;
    try { out.push(JSON.parse(l)); } catch { /* cut-off line at a chunk edge */ }
  }
  return out;
}

/** The text of a user message, or '' for tool results, commands and other non-prompts. */
function promptText(e) {
  if (e.type !== 'user' || e.isMeta || e.isSidechain || !e.message) return '';
  let c = e.message.content;
  if (Array.isArray(c)) c = c.filter(b => b && b.type === 'text').map(b => b.text).join(' ');
  if (typeof c !== 'string') return '';
  c = c.trim();
  if (!c || /^<(command-|local-command|bash-|user-memory|system)/.test(c) || c.startsWith('Caveat:')) return '';
  return c.replace(/\s+/g, ' ').slice(0, 160);
}

/** Summarize one transcript: title, first prompt, folder, times. */
function readTranscript(file) {
  const st = fs.statSync(file);
  const head = lines(readRange(file, 0, Math.min(HEAD, st.size)));
  const tail = st.size > HEAD ? lines(readRange(file, Math.max(HEAD, st.size - TAIL), Math.min(TAIL, st.size - HEAD))) : [];
  const all = head.concat(tail);
  let first = '';
  let cwd = '';
  let started = 0;
  let title = '';
  let summary = '';
  let prompts = 0;
  for (const e of all) {
    if (!cwd && e.cwd) cwd = e.cwd;
    if (!started && e.timestamp) started = Date.parse(e.timestamp) || 0;
    if (e.type === 'custom-title' && e.customTitle) title = e.customTitle;
    if (e.type === 'summary' && e.summary) summary = e.summary;
    const t = promptText(e);
    if (t) {
      prompts++;
      if (!first) first = t;
    }
  }
  return { first, cwd, started: started || st.birthtimeMs || st.mtimeMs, updated: st.mtimeMs, title, summary, prompts, size: st.size };
}

/** Project folders that may hold this folder's transcripts (normally exactly one). */
function projectDirs(configDir, folder) {
  const exact = path.join(configDir, 'projects', encode(folder));
  if (isRealDir(exact)) return [exact];
  // Claude's encoding has varied across versions; fall back to a loose name match.
  const want = squash(folder);
  return projectFolders(configDir).filter(d => squash(path.basename(d)) === want);
}

const isRealDir = p => { try { return fs.lstatSync(p).isDirectory(); } catch { return false; } };

/**
 * Claude's project folders: real directories only. A symlinked one is skipped everywhere (listing, footprint, delete),
 * so a delete never reaches what the listing and the "recently active" check didn't see.
 */
function projectFolders(configDir) {
  const root = path.join(configDir, 'projects');
  try { return fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(root, d.name)); } catch { return []; }
}

/**
 * Conversations Claude has for `folder`, newest first.
 * configDirs: Claude config folders. tracked: Map claudeId -> SkiffCode session id.
 */
function listConversations(folder, configDirs, tracked, limit = 40) {
  const out = [];
  const seen = new Set();
  for (const cfg of configDirs) {
    for (const dir of projectDirs(cfg, folder)) {
      let files = [];
      try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl') && UUID.test(f)); } catch { continue; }
      for (const f of files) {
        const id = f.slice(0, -6);
        if (seen.has(id)) continue;
        try {
          const t = readTranscript(path.join(dir, f));
          if (!t.first && !t.title) continue; // nothing was ever asked
          if (t.cwd && path.resolve(t.cwd) !== path.resolve(folder)) continue;
          seen.add(id);
          out.push({ id, title: t.title, summary: t.summary, first: t.first, prompts: t.prompts, started: t.started, updated: t.updated, session: tracked.get(id) || null });
        } catch { /* unreadable: skip */ }
      }
    }
  }
  out.sort((x, y) => y.updated - x.updated);
  return out.slice(0, limit);
}

/**
 * Delete everything Claude saved for one conversation, so it's gone from /resume too:
 * the transcript, its folder (subagents, tool output), file history, todos, session env, debug log,
 * and its lines in the prompt history. Returns what was deleted.
 */
function deleteConversation(configDirs, folder, id) {
  const [r] = deleteConversations(configDirs, [id], [folder]);
  if (r.error) throw new Error(r.error);
  return r.gone;
}

function checkId(id) {
  if (typeof id !== 'string' || !UUID.test(id) || id.length !== 36) throw new Error('Not a conversation ID');
}

/**
 * deleteConversation for several ids at once: each folder is listed and the prompt history rewritten once per call.
 * All ids are checked before anything is deleted. `folders` (optional) adds those folders' project dirs.
 * Returns [{ id, gone, error? }]: a failure for one id doesn't stop the others.
 */
function deleteConversations(configDirs, ids, folders = []) {
  ids.forEach(checkId);
  const res = new Map(ids.map(id => [id, { id, gone: [] }]));
  const rm = (r, p) => { if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); r.gone.push(p); } };
  for (const cfg of configDirs) {
    const projs = projectFolders(cfg);
    let todos = [];
    try { todos = fs.readdirSync(path.join(cfg, 'todos')); } catch { /* none */ }
    const own = folders.flatMap(f => projectDirs(cfg, f));
    for (const r of res.values()) {
      const id = r.id;
      try {
        const dirs = new Set(own);
        // a conversation resumed elsewhere may sit in another project folder
        for (const d of projs) if (fs.existsSync(path.join(d, `${id}.jsonl`))) dirs.add(d);
        for (const d of dirs) { rm(r, path.join(d, `${id}.jsonl`)); rm(r, path.join(d, id)); }
        rm(r, path.join(cfg, 'file-history', id));
        rm(r, path.join(cfg, 'session-env', id));
        rm(r, path.join(cfg, 'debug', `${id}.txt`));
        for (const f of todos) if (f.startsWith(id)) rm(r, path.join(cfg, 'todos', f));
      } catch (e) {
        r.error = e.message;
      }
    }
    // prompt history (up-arrow): drop these conversations' lines, keep everything else
    const hist = path.join(cfg, 'history.jsonl');
    try {
      const lines = fs.readFileSync(hist, 'utf8').split('\n');
      const dropped = new Map();
      const keep = lines.filter(l => {
        if (!ids.some(id => l.includes(id))) return true;
        let sid;
        try { sid = JSON.parse(l).sessionId; } catch { return true; }
        // an id whose files couldn't all be deleted keeps its prompt history: it is still on disk
        if (!res.has(sid) || res.get(sid).error) return true;
        dropped.set(sid, (dropped.get(sid) || 0) + 1);
        return false;
      });
      if (keep.length !== lines.length) {
        fs.writeFileSync(`${hist}.skiffcode-tmp`, keep.join('\n'));
        fs.chmodSync(`${hist}.skiffcode-tmp`, fs.statSync(hist).mode & 0o7777);
        fs.renameSync(`${hist}.skiffcode-tmp`, hist);
        for (const [sid, n] of dropped) res.get(sid).gone.push(`${hist} (${n} lines)`);
      }
    } catch { /* no history */ }
  }
  return [...res.values()];
}

const TRANSCRIPT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

/** Every transcript in Claude's project folders: { proj, id, file }. Other entries (memory/, plans/, …) are never touched. */
function* transcripts(configDirs) {
  for (const cfg of configDirs) {
    for (const proj of projectFolders(cfg)) {
      let files = [];
      try { files = fs.readdirSync(proj, { withFileTypes: true }); } catch { continue; }
      for (const f of files) if (f.isFile() && TRANSCRIPT.test(f.name)) yield { proj, id: f.name.slice(0, -6), file: path.join(proj, f.name) };
    }
  }
}

/** Bytes and newest mtime of the files under a folder (a conversation's subagents, tool output). Never follows symlinks. */
function folderStats(dir) {
  let bytes = 0;
  let newest = 0;
  const walk = d => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try {
          const st = fs.lstatSync(p);
          bytes += st.size;
          if (st.mtimeMs > newest) newest = st.mtimeMs;
        } catch { /* gone meanwhile */ }
      }
    }
  };
  walk(dir);
  return { bytes, newest };
}

// transcript path -> { mtimeMs, size, t }: a full scan reads only what changed since the last one
const summaries = new Map();

/** Every conversation Claude has on disk, from any folder, newest first. One item per id: copies in several project folders add up. */
async function listAllConversations(configDirs) {
  const byId = new Map();
  const seen = new Set();
  let read = 0;
  let scanned = 0;
  for (const { proj, id, file } of transcripts(configDirs)) {
    // the folder walks below run even for cached transcripts: let terminals and other calls in now and then
    if (++scanned % 50 === 0) await new Promise(setImmediate);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    seen.add(file);
    let c = summaries.get(file);
    if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) {
      // a first scan may read thousands of transcripts: let terminals and other calls in now and then
      if (++read % 20 === 0) await new Promise(setImmediate);
      try { c = { mtimeMs: st.mtimeMs, size: st.size, t: readTranscript(file) }; } catch { continue; }
      summaries.set(file, c);
    }
    const t = c.t;
    const sub = folderStats(path.join(proj, id));
    const item = {
      id, title: t.title, summary: t.summary, first: t.first, prompts: t.prompts, started: t.started, updated: t.updated,
      activeAt: Math.max(t.updated, sub.newest), size: t.size + sub.bytes,
      empty: t.size <= HEAD && !t.prompts && !t.title, // only when the whole file was read
      cwd: t.cwd || null,
    };
    const prev = byId.get(id);
    if (prev) {
      const keep = item.updated > prev.updated ? item : prev;
      keep.size = prev.size + item.size;
      keep.activeAt = Math.max(prev.activeAt, item.activeAt);
      byId.set(id, keep);
    } else byId.set(id, item);
  }
  for (const f of summaries.keys()) if (!seen.has(f)) summaries.delete(f);
  return [...byId.values()].sort((x, y) => y.updated - x.updated);
}

/** What one conversation takes on disk now, over all its copies: { exists, bytes, activeAt }. */
function conversationFootprint(configDirs, id) {
  checkId(id);
  const out = { exists: false, bytes: 0, activeAt: 0 };
  for (const cfg of configDirs) {
    for (const proj of projectFolders(cfg)) {
      let st;
      try { st = fs.lstatSync(path.join(proj, `${id}.jsonl`)); } catch { continue; }
      if (!st.isFile()) continue;
      const sub = folderStats(path.join(proj, id));
      out.exists = true;
      out.bytes += st.size + sub.bytes;
      out.activeAt = Math.max(out.activeAt, st.mtimeMs, sub.newest);
    }
  }
  return out;
}

const REGISTRY_FRESH_MS = 30 * 60e3;
const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

/**
 * Conversations a Claude process is running now, from Claude's registry (<config>/sessions/<pid>.json).
 * Its format isn't documented: anything unexpected is skipped. Fails closed: an entry counts as live when its pid
 * is alive here, or when it was updated recently (a Claude in another pid namespace, e.g. a container sharing the
 * config folder). A reused pid also counts as live, which only refuses a delete.
 */
function liveConversationIds(configDirs) {
  const out = new Set();
  for (const cfg of configDirs) {
    const dir = path.join(cfg, 'sessions');
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      let j;
      try { j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { continue; }
      if (!j || typeof j.sessionId !== 'string') continue;
      // epoch ms; pid 0 or below would signal a whole process group
      const seen = Math.max(...[j.updatedAt, j.statusUpdatedAt].filter(Number.isFinite), 0);
      if ((Number.isInteger(j.pid) && j.pid > 0 && alive(j.pid)) || Date.now() - seen < REGISTRY_FRESH_MS) out.add(j.sessionId.toLowerCase());
    }
  }
  return out;
}

/** Pull a conversation ID out of anything pasted: an ID, `claude --resume <id>`, `claude -r "<id>"`, a transcript path. */
function parseConversationId(text) {
  const m = String(text || '').match(UUID);
  return m ? m[0].toLowerCase() : null;
}

module.exports = { listConversations, parseConversationId, encode, readTranscript, deleteConversation, deleteConversations, listAllConversations, conversationFootprint, liveConversationIds, UUID };
