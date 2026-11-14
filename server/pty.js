'use strict';
// Talks to ptyhost.py processes (one per terminal) over Unix sockets.
const { spawn, spawnSync, execFile } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { TERM_SIZE } = require('./util');

const HOST = path.join(__dirname, 'ptyhost.py');

function frame(kind, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const head = Buffer.alloc(5);
  head.write(kind, 0, 'latin1');
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

// macOS has no /proc: there, process checks ask ps (by absolute path: the server's PATH may lack it).
const procfs = fs.existsSync('/proc/self');
const PS = '/bin/ps';
const HOST_MARK = '/ptyhost.py ';

/**
 * Does a ps command line belong to the ptyhost.py serving `sock`? Only the first "/ptyhost.py " counts:
 * later arguments are the user's command and prompt, which may contain anything.
 */
function hostCommandMatches(command, sock) {
  const at = String(command).indexOf(HOST_MARK);
  return at !== -1 && command.startsWith(`${sock} `, at + HOST_MARK.length);
}

/** BSD ps elapsed time, [[dd-]hh:]mm:ss, in seconds (NaN if it isn't one). */
function parseEtime(etime) {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(String(etime).trim());
  return m ? ((Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 60 + Number(m[3])) * 60 + Number(m[4]) : NaN;
}

/** { ppid, command } of a process, asked fresh; null if it is gone or ps failed. */
function psProcess(pid) {
  const r = spawnSync(PS, ['-ww', '-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
  const m = !r.error && r.status === 0 && /^ *(\d+) +(.*)/.exec(r.stdout);
  return m ? { ppid: Number(m[1]), command: m[2] } : null;
}

// Without /proc, liveness checks (every session, every 2 s) read one shared ps snapshot, taken at most once a second.
const SNAP_ARGS = ['-axww', '-o', 'pid=,ppid=,etime=,command='];
let snap = null; // pid -> { ppid, age, command }, or null when the last ps failed
let snapAt = 0;
let snapRun = null;

function parseSnapshot(out) {
  const procs = new Map();
  for (const line of out.split('\n')) {
    const m = /^ *(\d+) +(\d+) +(\S+) ?(.*)$/.exec(line);
    // The first line for a pid wins: a newline inside someone's arguments could forge a later one.
    if (m && !procs.has(Number(m[1]))) procs.set(Number(m[1]), { ppid: Number(m[2]), age: parseEtime(m[3]), command: m[4] });
  }
  return procs;
}

/** Every process (pid -> { ppid, age, command }), at most a second old; null if ps failed. */
function psSnapshot() {
  if (snapRun) return snapRun;
  if (Date.now() - snapAt < 1000) return Promise.resolve(snap);
  snapAt = Date.now();
  snapRun = new Promise(res => execFile(PS, SNAP_ARGS, { maxBuffer: 16 << 20, timeout: 10000 }, (e, out) => {
    snap = e ? null : parseSnapshot(out);
    snapRun = null;
    res(snap);
  }));
  return snapRun;
}

/** A process's snapshot entry; false if it is gone; null if unknown (ps failed, or it started after the snapshot). */
function snapshotted(pid) {
  if (!snapAt) {
    // the first check (server start) waits for a real answer, so interrupted sessions are found
    snapAt = Date.now();
    const r = spawnSync(PS, SNAP_ARGS, { encoding: 'utf8', maxBuffer: 16 << 20, timeout: 10000 });
    snap = !r.error && r.status === 0 ? parseSnapshot(r.stdout) : null;
  } else void psSnapshot();
  try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') return false; }
  return (snap && snap.get(pid)) || null;
}

/** Is `pid` a ptyhost.py serving `sock`? Asked fresh, for signalling. (A pid in a stale .pid file may since belong to anything.) */
function isHost(pid, sock) {
  if (!procfs) {
    const p = psProcess(pid);
    return !!p && hostCommandMatches(p.command, sock);
  }
  try {
    const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    const i = args.findIndex(a => path.basename(a) === 'ptyhost.py');
    return i !== -1 && args[i + 1] === sock;
  } catch {
    return false;
  }
}

function parentOf(pid) {
  if (!procfs) return (psProcess(pid) || { ppid: 0 }).ppid;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  } catch {
    return 0;
  }
}

/**
 * The pids in a socket's .pid file ("hostPid childPid"), each only if it checks out: the host must be
 * a ptyhost.py for this socket, the child a process that host started. 0 for anything else.
 * Without /proc the answer comes from the shared snapshot unless `fresh` (set it before signalling);
 * `unknown` then means the host could not be checked: treat it as alive, but never signal it.
 */
function hostPids(sock, { fresh = false } = {}) {
  let host = 0, child = 0;
  try {
    [host, child] = fs.readFileSync(sock + '.pid', 'utf8').trim().split(/\s+/).map(n => (/^\d+$/.test(n) ? Number(n) : 0));
  } catch { /* no host */ }
  if (!host) return { host: 0, child: 0 };
  if (procfs || fresh) {
    if (!isHost(host, sock)) return { host: 0, child: 0 };
    return { host, child: child && parentOf(child) === host ? child : 0 };
  }
  const h = snapshotted(host);
  if (h === null) return { host: 0, child: 0, unknown: true };
  if (!h || !hostCommandMatches(h.command, sock)) return { host: 0, child: 0 };
  const c = child && snapshotted(child);
  return { host, child: c && c.ppid === host ? child : 0 };
}

/** Is a host serving this socket? An unknown host counts as alive: a relaunch would delete its socket. */
function hostAlive(sock) {
  const p = hostPids(sock);
  return (!!p.host || !!p.unknown) && fs.existsSync(sock);
}

// TIOCSWINSZ takes 16-bit sizes.
const dim = n => Math.min(65535, Math.max(2, n | 0));

/** Start a detached host; resolves once its socket exists. */
async function spawnHost({ sock, cols = TERM_SIZE.cols, rows = TERM_SIZE.rows, cwd, command, env }) {
  for (const f of [sock, sock + '.pid', sock + '.exit']) fs.rmSync(f, { force: true });
  const python = process.env.SKIFFCODE_PYTHON || 'python3';
  const child = spawn(python, [HOST, sock, String(dim(cols)), String(dim(rows)), cwd, '--', ...command], {
    detached: true,
    stdio: 'ignore',
    cwd,
    env,
  });
  child.on('error', () => {});
  child.unref();
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (fs.existsSync(sock) && fs.existsSync(sock + '.pid')) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('terminal host did not start (is python3 installed?)');
}

class PtyClient extends EventEmitter {
  constructor(sock) {
    super();
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const s = net.createConnection(this.sock);
      this.s = s;
      let ready = false;
      s.on('connect', () => {
        ready = true;
        resolve(this);
      });
      s.on('data', d => this.onData(d));
      s.on('error', e => {
        if (!ready) reject(e);
      });
      s.on('close', () => {
        this.closed = true;
        this.emit('close');
      });
    });
  }

  onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= 5) {
      const n = this.buf.readUInt32BE(1);
      if (this.buf.length < 5 + n) break;
      const kind = String.fromCharCode(this.buf[0]);
      const payload = this.buf.subarray(5, 5 + n);
      this.buf = this.buf.subarray(5 + n);
      if (kind === 'h') this.emit('history', payload);
      else if (kind === 'o') this.emit('data', payload);
      else if (kind === 'x') this.emit('exit', Number(payload.toString()) || 0);
    }
  }

  write(data) {
    if (!this.closed) this.s.write(frame('i', data));
  }
  resize(cols, rows) {
    if (!this.closed) this.s.write(frame('r', `${dim(cols)},${dim(rows)}`));
  }
  kill() {
    if (!this.closed) this.s.write(frame('k', ''));
  }
  close() {
    this.closed = true;
    this.s?.destroy();
  }
}

module.exports = { spawnHost, hostAlive, hostPids, isHost, psProcess, psSnapshot, procfs, hostCommandMatches, parseEtime, PtyClient };
