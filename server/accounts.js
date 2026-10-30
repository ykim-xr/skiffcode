'use strict';
// Claude logins ("accounts"). Each extra account is its own CLAUDE_CONFIG_DIR,
// which is how Claude Code keeps several logins side by side. New sessions use
// the active account; a session always resumes with the account it started on.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { run } = require('./util');

// Shared from ~/.claude into new accounts (symlinks), so your settings, memory,
// agents, commands and skills are the same whichever org you're signed in to.
const SHAREABLE = ['settings.json', 'CLAUDE.md', 'agents', 'commands', 'skills', 'output-styles', 'keybindings.json'];

class Accounts {
  constructor(state, home) {
    this.state = state;
    this.home = home;
    this.dir = path.join(home, 'accounts');
    this.usageFile = path.join(home, 'usage.json');
    this.usage = {};
    try {
      this.usage = JSON.parse(fs.readFileSync(this.usageFile, 'utf8'));
    } catch { /* none yet */ }
    this.status = new Map(); // id -> { at, value }
  }

  list() {
    const extra = this.state.prefs.accounts || [];
    return [{ id: 'default', name: this.state.prefs.defaultAccountName || 'Default', dir: null }, ...extra];
  }

  get(id) {
    return this.list().find(a => a.id === id) || this.list()[0];
  }

  activeId() {
    const id = this.state.prefs.activeAccount;
    return this.list().some(a => a.id === id) ? id : 'default';
  }

  /** CLAUDE_CONFIG_DIR for an account (undefined = Claude's default, ~/.claude). */
  configDir(id) {
    const a = this.get(id);
    return a && a.dir ? a.dir : undefined;
  }

  defaultConfigDir() {
    return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  }

  add(name, share = true) {
    const clean = String(name || '').trim();
    if (!clean) throw new Error('Enter a name');
    if (this.list().some(a => a.name.toLowerCase() === clean.toLowerCase())) throw new Error('An account with that name exists');
    const slug = clean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'account';
    let dir = path.join(this.dir, slug);
    for (let i = 2; fs.existsSync(dir); i++) dir = path.join(this.dir, `${slug}-${i}`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (share) {
      const src = this.defaultConfigDir();
      for (const item of SHAREABLE) {
        const from = path.join(src, item);
        const to = path.join(dir, item);
        if (fs.existsSync(from) && !fs.existsSync(to)) {
          try { fs.symlinkSync(from, to); } catch { /* skip */ }
        }
      }
    }
    const acct = { id: crypto.randomUUID(), name: clean, dir, shared: !!share };
    this.state.update(d => { d.prefs.accounts = [...(d.prefs.accounts || []), acct]; });
    return acct;
  }

  rename(id, name) {
    const clean = String(name || '').trim();
    if (!clean) throw new Error('Enter a name');
    this.state.update(d => {
      if (id === 'default') d.prefs.defaultAccountName = clean;
      else for (const a of d.prefs.accounts || []) if (a.id === id) a.name = clean;
    });
  }

  remove(id, inUse) {
    if (id === 'default') throw new Error('The default account can’t be removed');
    if (inUse) throw new Error('Close the sessions that use this account first');
    this.state.update(d => {
      d.prefs.accounts = (d.prefs.accounts || []).filter(a => a.id !== id);
      if (d.prefs.activeAccount === id) d.prefs.activeAccount = 'default';
    });
    delete this.usage[id];
    this.saveUsage();
  }

  setActive(id) {
    if (!this.list().some(a => a.id === id)) throw new Error('Unknown account');
    this.state.update(d => { d.prefs.activeAccount = id; });
  }

  env(id) {
    const dir = this.configDir(id);
    return dir ? { CLAUDE_CONFIG_DIR: dir } : {};
  }

  /** `claude auth status` for an account (cached a minute). */
  async authStatus(id, claudeCmd = 'claude', fresh = false) {
    const c = this.status.get(id);
    if (c && !fresh && Date.now() - c.at < 60_000) return c.value;
    let value;
    try {
      const env = { ...this.env(id) };
      if (id !== 'default') env.CLAUDE_CONFIG_DIR = this.configDir(id);
      const out = await run('sh', ['-lc', `${claudeBin(claudeCmd)} auth status`], { env, timeout: 20_000 }).catch(e => e.stdout || '');
      const j = JSON.parse(out.slice(out.indexOf('{')));
      value = {
        loggedIn: !!j.loggedIn && j.authMethod !== 'none',
        method: j.authMethod,
        email: j.email || j.emailAddress || (j.account && (j.account.email || j.account.emailAddress)),
        org: j.orgName || j.organizationName || j.organization || (j.account && (j.account.organizationName || j.account.orgName)),
        plan: j.subscriptionType || j.plan,
      };
    } catch {
      value = { loggedIn: false, unknown: true };
    }
    this.status.set(id, { at: Date.now(), value });
    return value;
  }

  invalidate(id) {
    this.status.delete(id);
  }

  /** Record usage from a Claude status-line snapshot. Returns true when it changed. */
  recordUsage(id, rateLimits) {
    if (!rateLimits) return false;
    const pick = w => (w && typeof w.used_percentage === 'number' ? { used: w.used_percentage, resetsAt: Number(w.resets_at) * 1000 || null } : undefined);
    const next = { fiveHour: pick(rateLimits.five_hour), weekly: pick(rateLimits.seven_day), at: Date.now() };
    if (!next.fiveHour && !next.weekly) return false;
    const prev = this.usage[id];
    this.usage[id] = next;
    const changed = !prev || JSON.stringify({ ...prev, at: 0 }) !== JSON.stringify({ ...next, at: 0 });
    if (changed || !prev || Date.now() - prev.at > 60_000) this.saveUsage();
    return changed;
  }

  saveUsage() {
    try {
      fs.writeFileSync(this.usageFile, JSON.stringify(this.usage));
    } catch { /* ignore */ }
  }
}

/** The Claude program from the "Claude command" setting, without its flags ("claude --foo" -> "claude"). */
function claudeBin(cmd) {
  const words = String(cmd || 'claude').trim().split(/\s+/);
  const i = words.findIndex(w => w.startsWith('-'));
  return (i === -1 ? words : words.slice(0, i)).join(' ') || 'claude';
}

/** The statusLine command the user has set (project local > project > account > ~/.claude). */
function userStatusLine(worktree, configDir, defaultDir) {
  const files = [
    path.join(worktree, '.claude', 'settings.local.json'),
    path.join(worktree, '.claude', 'settings.json'),
    configDir ? path.join(configDir, 'settings.json') : null,
    path.join(defaultDir, 'settings.json'),
  ].filter(Boolean);
  for (const f of files) {
    try {
      const sl = JSON.parse(fs.readFileSync(f, 'utf8')).statusLine;
      if (sl && sl.type === 'command' && sl.command && !String(sl.command).includes('skiffcode')) return sl;
    } catch { /* not there */ }
  }
  return undefined;
}

module.exports = { Accounts, userStatusLine, claudeBin };
