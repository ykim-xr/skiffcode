'use strict';
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Run a command (no shell); resolves stdout, rejects with stderr as the message. */
function run(cmd, args, { cwd, input, timeout = 60_000, env, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { cwd, timeout, maxBuffer, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', ...env } },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (String(stderr || '').trim() || err.message).split('\n').slice(-6).join('\n');
          const e = new Error(msg);
          e.stderr = String(stderr || '');
          e.stdout = String(stdout || '');
          e.code = err.code;
          reject(e);
        } else resolve(String(stdout));
      },
    );
    if (input !== undefined) {
      // The program may exit before reading its input (e.g. git outside a repo): that's not fatal.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

function shq(s) {
  if (/^[A-Za-z0-9_\-./:=@%+,]+$/.test(s)) return s;
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function skiffcodeHome() {
  return process.env.SKIFFCODE_HOME || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'skiffcode');
}

/** Write a private (0600) file in one step: synced to disk before it replaces the old one. */
function writeFileAtomic(file, content) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/** A folder only you can open (made 0700, and an existing one tightened). */
function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

const whichCache = new Map();
function which(cmd) {
  if (whichCache.has(cmd)) return whichCache.get(cmd);
  let found;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) {
        found = p;
        break;
      }
    } catch { /* next */ }
  }
  if (found) whichCache.set(cmd, found); // a miss is not cached: the tool may be installed later
  return found;
}

function userShell() {
  try {
    return process.env.SHELL || os.userInfo().shell || '/bin/bash';
  } catch {
    return '/bin/bash';
  }
}

function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** A folder git knows about (a repo root or a linked worktree has a .git entry). */
const isGitDir = p => fs.existsSync(path.join(p, '.git'));

/** Size of a new terminal until the page reports the real one. */
const TERM_SIZE = Object.freeze({ cols: 120, rows: 32 });

/** Is `child` inside (or equal to) `parent`? */
function within(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

/** Never delete /, a top-level folder like /mnt/c, your home folder or anything above it. */
function safeToDelete(p) {
  const abs = path.resolve(p);
  const home = os.homedir();
  if (abs.split(path.sep).filter(Boolean).length < 3) return false;
  if (abs === home || within(abs, home)) return false;
  return true;
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

module.exports = { run, shq, skiffcodeHome, writeFileAtomic, privateDir, which, userShell, realpath, isGitDir, TERM_SIZE, within, safeToDelete, pool };
