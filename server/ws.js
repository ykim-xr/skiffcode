'use strict';
// Minimal RFC 6455 WebSocket server (text + binary frames, ping/pong, close),
// so the SkiffCode server needs no npm packages.
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 64 * 1024 * 1024;

class WsConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.fragBytes = 0;
    this.fragOpcode = 0;
    this.open = true;
    socket.setNoDelay(true);
    socket.on('data', d => this.onData(d));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
    this.pinger = setInterval(() => this.sendFrame(0x9, Buffer.alloc(0)), 25_000);
  }

  finish() {
    if (!this.open) return;
    this.open = false;
    clearInterval(this.pinger);
    this.emit('close');
  }

  onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      if (len > MAX_MESSAGE) return this.close(1009);
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < off + maskLen + len) return;
      let payload = this.buf.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = this.buf.subarray(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      this.buf = this.buf.subarray(off + maskLen + len);
      this.onFrame(fin, opcode, payload);
    }
  }

  onFrame(fin, opcode, payload) {
    if (opcode === 0x8) {
      this.sendFrame(0x8, payload.subarray(0, 2));
      this.socket.end();
      return this.finish();
    }
    if (opcode === 0x9) return this.sendFrame(0xa, payload);
    if (opcode === 0xa) return;
    if (opcode === 0x0) {
      this.fragBytes += payload.length;
      if (this.fragBytes > MAX_MESSAGE) return this.close(1009);
      this.fragments.push(payload);
      if (!fin) return;
      const whole = Buffer.concat(this.fragments);
      this.fragments = [];
      this.fragBytes = 0;
      return this.deliver(this.fragOpcode, whole);
    }
    if (!fin) {
      this.fragOpcode = opcode;
      this.fragments = [payload];
      this.fragBytes = payload.length;
      return;
    }
    this.deliver(opcode, payload);
  }

  deliver(opcode, payload) {
    if (opcode === 0x1) this.emit('message', payload.toString('utf8'));
    else if (opcode === 0x2) this.emit('binary', payload);
  }

  sendFrame(opcode, payload) {
    if (!this.open) return;
    const len = payload.length;
    let head;
    if (len < 126) {
      head = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      head = Buffer.alloc(4);
      head[0] = 0x80 | opcode;
      head[1] = 126;
      head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | opcode;
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.socket.write(head);
      this.socket.write(payload);
    } catch {
      this.finish();
    }
  }

  send(text) {
    this.sendFrame(0x1, Buffer.from(text, 'utf8'));
  }

  sendBinary(buf) {
    this.sendFrame(0x2, buf);
  }

  close(code = 1000) {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(code);
    this.sendFrame(0x8, b);
    this.socket.end();
    this.finish();
  }
}

/** Complete the upgrade handshake; returns a connection or null. */
function accept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const acceptKey = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`,
  );
  return new WsConnection(socket);
}

module.exports = { accept };
