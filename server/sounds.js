'use strict';
// Alert sounds: built-in ones (web/sounds/*.wav) and your own uploads (<data dir>/sounds/).
// Setting values: a built-in name ("ding"), "custom:<file>", or "none".
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BUILTIN_DIR = path.join(__dirname, '..', 'web', 'sounds');
const EXT = new Set(['.wav', '.mp3', '.ogg', '.m4a']);
const MAX = 3 * 1024 * 1024;
const DEFAULTS = { question: 'ding', permission: 'alert', done: 'chime' };

class Sounds {
  constructor(home) {
    this.dir = path.join(home, 'sounds');
  }
  builtin() {
    try {
      return fs.readdirSync(BUILTIN_DIR).filter(f => f.endsWith('.wav')).map(f => f.slice(0, -4)).sort();
    } catch {
      return [];
    }
  }
  custom() {
    try {
      return fs.readdirSync(this.dir).filter(f => EXT.has(path.extname(f).toLowerCase())).sort().map(f => ({ id: `custom:${f}`, name: f.replace(/-[0-9a-f]{6}(\.\w+)$/, '$1') }));
    } catch {
      return [];
    }
  }
  list() {
    return { builtin: this.builtin(), custom: this.custom(), defaults: DEFAULTS };
  }
  /** File for a setting value, or null for none / unknown. */
  file(id) {
    if (!id || id === 'none') return null;
    if (id.startsWith('custom:')) {
      const f = id.slice(7);
      if (!/^[\w.-]+$/.test(f)) return null;
      const p = path.join(this.dir, f);
      return fs.existsSync(p) ? p : null;
    }
    if (!/^[a-z]+$/.test(id)) return null;
    const p = path.join(BUILTIN_DIR, `${id}.wav`);
    return fs.existsSync(p) ? p : null;
  }
  /** The sound for an alert kind, from settings (falls back to the default). */
  forKind(settings, kind) {
    const pick = (settings.sounds || {})[kind];
    if (pick === 'none') return null;
    return this.file(pick) || this.file(DEFAULTS[kind]);
  }
  save(name, base64) {
    const ext = path.extname(String(name || '')).toLowerCase();
    if (!EXT.has(ext)) throw new Error('Use a .wav, .mp3, .ogg or .m4a file');
    const data = Buffer.from(String(base64 || ''), 'base64');
    if (!data.length) throw new Error('That file is empty');
    if (data.length > MAX) throw new Error('Keep sounds under 3 MB');
    const stem = path.basename(name, path.extname(name)).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'sound';
    fs.mkdirSync(this.dir, { recursive: true });
    const file = `${stem}-${crypto.randomBytes(3).toString('hex')}${ext}`;
    fs.writeFileSync(path.join(this.dir, file), data);
    return { id: `custom:${file}`, name: `${stem}${ext}` };
  }
  remove(id) {
    const p = id && id.startsWith('custom:') ? this.file(id) : null;
    if (p) fs.rmSync(p, { force: true });
  }
}

module.exports = { Sounds, DEFAULTS };
