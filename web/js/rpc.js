// WebSocket connection to the SkiffCode server: request/response calls, pushed
// events, and binary terminal frames. Reconnects automatically.
const listeners = new Map(); // event -> Set<fn>
const termHandlers = new Map(); // session id -> fn(type, bytes)
const pending = new Map();
let ws;
let seq = 0;
let openPromise;
let backoff = 300;
const enc = new TextEncoder();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

function emit(event, data) {
  for (const fn of listeners.get(event) || []) {
    try {
      fn(data);
    } catch (e) {
      console.error(e);
    }
  }
}

export function onTerminal(id, fn) {
  termHandlers.set(id, fn);
  return () => termHandlers.delete(id);
}

export function connect() {
  if (openPromise) return openPromise;
  openPromise = new Promise(resolve => {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      backoff = 300;
      emit('open');
      resolve();
    };
    ws.onmessage = m => {
      if (typeof m.data !== 'string') {
        const b = new Uint8Array(m.data);
        const id = new TextDecoder('latin1').decode(b.subarray(1, 37)).trim();
        const h = termHandlers.get(id);
        if (h) h(b[0], b.subarray(37));
        return;
      }
      const msg = JSON.parse(m.data);
      if (msg.id !== undefined) {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error) {
          const e = new Error(msg.error.message);
          e.code = msg.error.code;
          p.reject(e);
        } else p.resolve(msg.result);
      } else emit(msg.event, msg.data);
    };
    ws.onclose = () => {
      for (const p of pending.values()) p.reject(new Error('Disconnected from SkiffCode'));
      pending.clear();
      openPromise = undefined;
      emit('close');
      setTimeout(() => connect().then(() => emit('reconnect')), backoff);
      backoff = Math.min(backoff * 2, 5000);
    };
  });
  return openPromise;
}

export async function call(method, params = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) await connect();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

/** Keystrokes for a terminal: [1][36-byte id][bytes]. */
export function sendInput(id, text) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const data = typeof text === 'string' ? enc.encode(text) : text;
  const out = new Uint8Array(37 + data.length);
  out[0] = 1;
  out.set(enc.encode(id.padEnd(36).slice(0, 36)), 1);
  out.set(data, 37);
  ws.send(out);
}

export function connected() {
  return !!ws && ws.readyState === WebSocket.OPEN;
}
