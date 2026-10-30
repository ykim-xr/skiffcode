'use strict';
// Tiny SkiffCode API client for tests (Node 22 WebSocket).
class Client {
  constructor(port, token) {
    this.port = port;
    this.token = token;
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
    this.listeners = [];
    this.term = new Map(); // id -> string output
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`, { headers: { cookie: `skiffcode_tkn=${this.token}` } });
      this.ws.binaryType = 'arraybuffer';
      this.ws.onopen = () => resolve(this);
      this.ws.onerror = e => reject(new Error('ws error ' + (e.message || '')));
      this.ws.onmessage = m => {
        if (typeof m.data !== 'string') {
          const b = Buffer.from(m.data);
          const id = b.subarray(1, 37).toString('latin1').trim();
          const prev = this.term.get(id) || '';
          if (b[0] === 3) this.term.set(id, prev + `\n[exit ${b.subarray(37).toString()}]`);
          else this.term.set(id, prev + b.subarray(37).toString('utf8'));
          return;
        }
        const msg = JSON.parse(m.data);
        if (msg.id !== undefined) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
        } else {
          this.events.push(msg);
          for (const l of this.listeners) l(msg);
        }
      };
    });
  }
  call(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  input(id, text) {
    const b = Buffer.concat([Buffer.from([1]), Buffer.from(id.padEnd(36), 'latin1'), Buffer.from(text)]);
    this.ws.send(b);
  }
  last(event) {
    return [...this.events].reverse().find(e => e.event === event);
  }
  close() {
    this.ws.close();
  }
}
module.exports = { Client };
