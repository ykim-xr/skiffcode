'use strict';
// SkiffCode's sidebar state: groups, repos (in your order), sessions, per-worktree
// metadata and preferences. One JSON file, owned by the server.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { writeFileAtomic } = require('./util');

const EMPTY = () => ({ version: 3, groups: [], repos: [], sessions: [], worktrees: {}, layouts: {}, prefs: {} });

class State extends EventEmitter {
  constructor(home) {
    super();
    this.home = home;
    fs.mkdirSync(home, { recursive: true });
    this.file = path.join(home, 'state.json');
    this.data = this.load();
  }

  load() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return EMPTY(); // a new install
      throw e;
    }
    let d;
    try { d = JSON.parse(text); } catch { /* kept aside below */ }
    if (d && d.version === 3) return { ...EMPTY(), ...d };
    if (d && d.version === 2) {
      // SkiffCode 0.2 (VS Code extension): keep repos and groups.
      return { ...EMPTY(), groups: d.groups || [], repos: (d.repos || []).map(r => ({ path: r.path, name: r.name, group: r.group })), worktrees: d.worktrees || {} };
    }
    if (d && typeof d.version === 'number' && d.version > 3) {
      // Written by a newer SkiffCode: starting empty would overwrite it.
      console.error(`skiffcode: ${this.file} is from a newer SkiffCode (version ${d.version}). Update with: skiffcode update. Nothing was changed.`);
      process.exit(1);
    }
    const bad = `${this.file}.bad-${Date.now()}`;
    fs.copyFileSync(this.file, bad);
    console.error(`skiffcode: ${this.file} could not be read. It was kept as ${bad}; starting with an empty sidebar.`);
    return EMPTY();
  }

  save() {
    writeFileAtomic(this.file, JSON.stringify(this.data, null, 2) + '\n');
  }

  /** Mutate, save, and tell connected clients. */
  update(fn) {
    fn(this.data);
    this.save();
    this.emit('change');
  }

  get repos() { return this.data.repos; }
  get groups() { return this.data.groups; }
  get sessions() { return this.data.sessions; }
  get prefs() { return this.data.prefs; }

  repo(p) { return this.data.repos.find(r => r.path === p); }
  session(id) { return this.data.sessions.find(s => s.id === id); }
  sessionsIn(wt) { return this.data.sessions.filter(s => s.worktreePath === wt); }
  worktreeMeta(p) { return this.data.worktrees[p] || {}; }
}

module.exports = { State };
