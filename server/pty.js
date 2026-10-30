'use strict';
// Talks to ptyhost.py processes (one per terminal) over Unix sockets.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const net = require('net');
const path = require('path');

const HOST = path.join(__dirname, 'ptyhost.py');

function frame(kind, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const head = Buffer.alloc(5);
  head.write(kind, 0, 'latin1');
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (e) {
    return e.code === 'EPERM';
  }
  // A killed host whose parent is gone can linger as a zombie: that's dead too.
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return true;
  }
}

/** Is a host serving this socket? */
function hostAlive(sock) {
  try {
    const [hostPid] = fs.readFileSync(sock + '.pid', 'utf8').trim().split(/\s+/).map(Number);
    return !!hostPid && pidAlive(hostPid) && fs.existsSync(sock);
  } catch {
    return false;
  }
}

/** Start a detached host; resolves once its socket exists. */
async function spawnHost({ sock, cols = 120, rows = 30, cwd, command, env }) {
  for (const f of [sock, sock + '.pid', sock + '.exit']) fs.rmSync(f, { force: true });
  const python = process.env.SKIFFCODE_PYTHON || 'python3';
  const child = spawn(python, [HOST, sock, String(cols), String(rows), cwd, '--', ...command], {
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
    if (!this.closed) this.s.write(frame('r', `${Math.max(2, cols | 0)},${Math.max(2, rows | 0)}`));
  }
  kill() {
    if (!this.closed) this.s.write(frame('k', ''));
  }
  close() {
    this.closed = true;
    this.s?.destroy();
  }
}

module.exports = { spawnHost, hostAlive, PtyClient };
