'use strict';
// Talks to ptyhost.py processes (one per terminal) over Unix sockets.
const { spawn } = require('child_process');
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

/** Is `pid` a ptyhost.py serving `sock`? (A pid in a stale .pid file may since belong to anything.) */
function isHost(pid, sock) {
  try {
    const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    const i = args.findIndex(a => path.basename(a) === 'ptyhost.py');
    return i !== -1 && args[i + 1] === sock;
  } catch {
    return false;
  }
}

function parentOf(pid) {
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
 */
function hostPids(sock) {
  let host = 0, child = 0;
  try {
    [host, child] = fs.readFileSync(sock + '.pid', 'utf8').trim().split(/\s+/).map(n => (/^\d+$/.test(n) ? Number(n) : 0));
  } catch { /* no host */ }
  if (!host || !isHost(host, sock)) return { host: 0, child: 0 };
  return { host, child: child && parentOf(child) === host ? child : 0 };
}

/** Is a host serving this socket? */
function hostAlive(sock) {
  return !!hostPids(sock).host && fs.existsSync(sock);
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

module.exports = { spawnHost, hostAlive, hostPids, isHost, PtyClient };
