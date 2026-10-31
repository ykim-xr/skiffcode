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
  const root = path.join(configDir, 'projects');
  const exact = path.join(root, encode(folder));
  if (fs.existsSync(exact)) return [exact];
  // Claude's encoding has varied across versions; fall back to a loose name match.
  let names = [];
  try { names = fs.readdirSync(root); } catch { return []; }
  const want = squash(folder);
  return names.filter(n => squash(n) === want).map(n => path.join(root, n));
}

/**
 * Conversations Claude has for `folder`, newest first.
 * accounts: [{ id, dir }] (dir = Claude config dir). tracked: Map claudeId -> SkiffCode session id.
 */
function listConversations(folder, accounts, tracked, limit = 40) {
  const out = [];
  const seen = new Set();
  for (const a of accounts) {
    for (const dir of projectDirs(a.dir, folder)) {
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
          out.push({ id, account: a.id, title: t.title, summary: t.summary, first: t.first, prompts: t.prompts, started: t.started, updated: t.updated, session: tracked.get(id) || null });
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
  if (!UUID.test(id) || id.length !== 36) throw new Error('Not a conversation ID');
  const gone = [];
  const rm = p => { if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); gone.push(p); } };
  for (const cfg of configDirs) {
    const dirs = new Set(projectDirs(cfg, folder));
    // a conversation resumed elsewhere may sit in another project folder
    try { for (const n of fs.readdirSync(path.join(cfg, 'projects'))) if (fs.existsSync(path.join(cfg, 'projects', n, `${id}.jsonl`))) dirs.add(path.join(cfg, 'projects', n)); } catch { /* none */ }
    for (const d of dirs) { rm(path.join(d, `${id}.jsonl`)); rm(path.join(d, id)); }
    rm(path.join(cfg, 'file-history', id));
    rm(path.join(cfg, 'session-env', id));
    rm(path.join(cfg, 'debug', `${id}.txt`));
    try { for (const f of fs.readdirSync(path.join(cfg, 'todos'))) if (f.startsWith(id)) rm(path.join(cfg, 'todos', f)); } catch { /* none */ }
    // prompt history (up-arrow): drop this conversation's lines, keep everything else
    const hist = path.join(cfg, 'history.jsonl');
    try {
      const lines = fs.readFileSync(hist, 'utf8').split('\n');
      const keep = lines.filter(l => !l.includes(id) || (() => { try { return JSON.parse(l).sessionId !== id; } catch { return true; } })());
      if (keep.length !== lines.length) {
        fs.writeFileSync(`${hist}.skiffcode-tmp`, keep.join('\n'));
        fs.chmodSync(`${hist}.skiffcode-tmp`, fs.statSync(hist).mode & 0o7777);
        fs.renameSync(`${hist}.skiffcode-tmp`, hist);
        gone.push(`${hist} (${lines.length - keep.length} lines)`);
      }
    } catch { /* no history */ }
  }
  return gone;
}

/** Pull a conversation ID out of anything pasted: an ID, `claude --resume <id>`, `claude -r "<id>"`, a transcript path. */
function parseConversationId(text) {
  const m = String(text || '').match(UUID);
  return m ? m[0].toLowerCase() : null;
}

module.exports = { listConversations, parseConversationId, encode, readTranscript, deleteConversation, UUID };
