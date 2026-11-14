'use strict';
// Claude logins ("accounts"). Every session runs on one shared Claude config folder (~/.claude, or the
// server's CLAUDE_CONFIG_DIR). An account is a saved copy of a login; using it swaps that login into the
// shared folder, the way `/login` does. Saved logins: <home>/accounts/<id>/{credentials,account}.json.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { shq, writeFileAtomic, writeFileReplacing, privateDir } = require('./util');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SCRATCH_RE = /^\.login-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const SIGN_IN_WAIT = 30 * 60e3;
const LOCK_STALE = 10e3;
const LOCK_WAIT = 5e3;
const BACKUPS = 5;
// On macOS Claude keeps its login in the Keychain, not in .credentials.json. SkiffCode never reads or writes the Keychain.
const NO_SWITCHING_MAC = 'Switching Claude accounts isn’t available on macOS yet.';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

/** A claude.ai login (.credentials.json) with both tokens, else undefined. */
function oauthOf(creds) {
  const o = creds && creds.claudeAiOauth;
  return o && typeof o.accessToken === 'string' && typeof o.refreshToken === 'string' ? o : undefined;
}

/** Who a login is: the Claude account in one organization. */
function identity(acct) {
  return acct && acct.accountUuid ? `${acct.accountUuid}/${acct.organizationUuid || ''}` : undefined;
}

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');

/** Where Claude keeps its global config (with oauthAccount): in the config folder only when CLAUDE_CONFIG_DIR is set. */
function globalConfigFile(configDir = process.env.CLAUDE_CONFIG_DIR) {
  return configDir ? path.join(configDir, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

let warnedUsageUrl = false;
/** The usage endpoint. Tests may point it at a loopback http server; anything else is ignored, so a token can't leave for another host. */
function usageUrl(env = process.env) {
  const v = env.SKIFFCODE_USAGE_URL;
  if (!v) return USAGE_URL;
  try {
    const u = new URL(v);
    if (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return u.href;
  } catch { /* not a URL */ }
  if (!warnedUsageUrl) console.error('skiffcode: SKIFFCODE_USAGE_URL is ignored: only http on 127.0.0.1, localhost or [::1] is allowed');
  warnedUsageUrl = true;
  return USAGE_URL;
}

/** Claude's lock on its global config: a folder made with mkdir. A lock older than 10 s is left over and taken over. */
async function withClaudeLock(file, fn) {
  const lock = `${file}.lock`;
  const end = Date.now() + LOCK_WAIT;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let age = -1;
    try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { /* just released */ }
    let claimed = false;
    if (age > LOCK_STALE) {
      // Rename first: of several processes taking over the same stale lock, only one rename succeeds,
      // so the others don't delete the fresh lock the winner makes next.
      const stale = `${lock}.stale-${process.pid}-${Date.now()}`;
      try {
        fs.renameSync(lock, stale);
        claimed = true;
      } catch { /* someone else claimed it */ }
      if (claimed) try { fs.rmSync(stale, { recursive: true, force: true }); } catch { /* left over, harmless */ }
    }
    if (Date.now() > end) throw new Error('Claude is busy with its settings file. Try again in a moment.');
    if (!claimed) await sleep(age < 0 ? 10 : 100);
  }
  try {
    return await fn();
  } finally {
    try { fs.rmdirSync(lock); } catch { /* gone */ }
  }
}

class Accounts {
  constructor(state, home, { platform = process.platform } = {}) {
    this.state = state;
    this.mac = platform === 'darwin';
    this.home = home;
    this.dir = path.join(home, 'accounts');
    this.lastSwitchFile = path.join(this.dir, 'last-switch.json');
    this.usageFile = path.join(home, 'usage.json');
    this.usage = {};
    try {
      this.usage = JSON.parse(fs.readFileSync(this.usageFile, 'utf8'));
    } catch { /* none yet */ }
    this.info = new Map(); // id -> { email, org, plan, identity } from its saved login
    this.version = 0; // bumped when saved logins change, so the in-use account is worked out again
    this.current = { key: null, inUse: null, login: null };
    this.pending = new Map(); // scratch sign-in folder -> { name, at }
    this.queue = Promise.resolve(); // switches run one at a time
    this.onSaved = () => {};
  }

  defaultConfigDir() {
    return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  }

  sharedCredentialsFile() {
    return path.join(this.defaultConfigDir(), '.credentials.json');
  }

  records() {
    return this.state.prefs.accounts || [];
  }

  has(id) {
    return typeof id === 'string' && UUID_RE.test(id) && this.records().some(a => a.id === id);
  }

  slot(id) {
    if (!UUID_RE.test(String(id))) throw new Error('Unknown account');
    return path.join(this.dir, id);
  }

  infoOf(id) {
    if (!this.info.has(id)) {
      const acct = readJson(path.join(this.slot(id), 'account.json'));
      const o = oauthOf(readJson(path.join(this.slot(id), 'credentials.json')));
      this.info.set(id, { email: acct && acct.emailAddress, org: acct && acct.organizationName, plan: o && o.subscriptionType, identity: identity(acct) });
    }
    return this.info.get(id);
  }

  /** For the UI: [{ id, name, email, org, plan, inUse }]. */
  list() {
    const inUse = this.inUseId();
    return this.records().map(a => {
      const i = this.infoOf(a.id);
      return { id: a.id, name: a.name, email: i.email, org: i.org, plan: i.plan, inUse: a.id === inUse };
    });
  }

  /** The login in the shared folder: { email, org, plan, saved, expired }, or null when there is none. */
  currentLogin() {
    this.inUseId();
    return this.current.login;
  }

  /**
   * The saved account whose login is in the shared folder (or null). Worked out again only when the
   * shared files change (by mtime) or saved logins do: status-line events call this often.
   */
  inUseId() {
    const mtime = f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
    const global = globalConfigFile();
    if (this.mac) return this.macLogin(global, mtime(global));
    const cred = this.sharedCredentialsFile();
    const key = `${mtime(cred)}:${mtime(global)}:${this.version}`;
    if (key === this.current.key) return this.current.inUse;
    const o = oauthOf(readJson(cred));
    const g = readJson(global);
    const acct = g && g.oauthAccount;
    const inUse = o ? this.ownerOf(o, acct) : null;
    const login = o ? {
      email: acct && acct.emailAddress, org: acct && acct.organizationName, plan: o.subscriptionType,
      saved: !!inUse, expired: !!(o.refreshTokenExpiresAt && o.refreshTokenExpiresAt < Date.now()),
    } : null;
    // A half-written .claude.json is read again next time
    this.current = { key: g || !fs.existsSync(global) ? key : null, inUse, login };
    return inUse;
  }

  /** On macOS: who is signed in, from .claude.json alone. No saved account is ever in use there. */
  macLogin(global, mtime) {
    const key = `mac:${mtime}`;
    if (key === this.current.key) return null;
    const g = readJson(global);
    const acct = g && g.oauthAccount;
    const login = acct ? { email: acct.emailAddress, org: acct.organizationName, plan: undefined, saved: false, expired: false } : null;
    this.current = { key: g || !fs.existsSync(global) ? key : null, inUse: null, login };
    return null;
  }

  /**
   * Which saved account a login in the shared folder belongs to: the one SkiffCode last wrote there (same
   * tokens, or Claude refreshed them and oauthAccount is still what that switch wrote), else by identity.
   */
  ownerOf(o, acct) {
    const last = readJson(this.lastSwitchFile);
    const who = identity(acct);
    if (last && this.has(last.id)) {
      if (last.sha === sha(o.refreshToken)) return last.id;
      if (who && last.identity === who) return last.id;
    }
    if (!who) return null;
    const a = this.records().find(r => this.infoOf(r.id).identity === who);
    return a ? a.id : null;
  }

  uniqueName(base) {
    const taken = new Set(this.records().map(a => a.name.toLowerCase()));
    const root = String(base || '').trim() || 'Claude account';
    let name = root;
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${root} ${i}`;
    return name;
  }

  /**
   * Keep a login (its claudeAiOauth `o`). Into `id` when given; else into the account with the same identity; else a new account.
   * `acct` (oauthAccount) is written only when given, so tokens matched by the last switch can't take another identity.
   */
  saveLogin(o, acct, { id, name } = {}) {
    if (!id) {
      const who = identity(acct);
      const same = who && this.records().find(r => this.infoOf(r.id).identity === who);
      if (same) id = same.id;
    }
    let added;
    if (!id) {
      id = crypto.randomUUID();
      added = { id, name: this.uniqueName(name || (acct && (acct.organizationName || acct.emailAddress))) };
    }
    const dir = this.slot(id);
    privateDir(dir);
    const credFile = path.join(dir, 'credentials.json');
    // Only the claude.ai login: other keys (e.g. MCP sign-ins) stay in the shared file
    const text = JSON.stringify({ claudeAiOauth: o });
    let old;
    try { old = fs.readFileSync(credFile, 'utf8'); } catch { /* new */ }
    if (old !== undefined && old !== text) this.backup(dir, old);
    if (old !== text) writeFileAtomic(credFile, text);
    if (acct) writeFileAtomic(path.join(dir, 'account.json'), JSON.stringify(acct));
    if (added) this.state.update(d => { d.prefs.accounts = [...(d.prefs.accounts || []), added]; });
    this.info.delete(id);
    this.version++;
    return { id, name: added ? added.name : (this.records().find(a => a.id === id) || {}).name };
  }

  /**
   * Keep the replaced credentials as credentials.prev-<ms>.json, the newest BACKUPS of them. A save into
   * the wrong account (tokens refreshed under another login) can then be undone by hand.
   */
  backup(dir, text) {
    const list = () => fs.readdirSync(dir).map(n => /^credentials\.prev-(\d+)\.json$/.exec(n)).filter(Boolean)
      .sort((x, y) => Number(x[1]) - Number(y[1]));
    const newest = list().at(-1);
    // Names sort by age: never older than the newest backup, even within one millisecond
    const ms = Math.max(Date.now(), newest ? Number(newest[1]) + 1 : 0);
    writeFileAtomic(path.join(dir, `credentials.prev-${ms}.json`), text);
    for (const m of list().slice(0, -BACKUPS)) fs.rmSync(path.join(dir, m[0]), { force: true });
  }

  /** Save the login in use now as an account (it keeps its account if it already has one). */
  saveCurrent(name) {
    if (this.mac) throw new Error(NO_SWITCHING_MAC);
    const o = oauthOf(readJson(this.sharedCredentialsFile()));
    if (!o) throw new Error('No Claude login to save');
    const g = readJson(globalConfigFile());
    const acct = g && g.oauthAccount;
    const owner = this.ownerOf(o, acct);
    return this.saveLogin(o, owner ? undefined : acct, { id: owner || undefined, name: String(name || '').trim() || undefined });
  }

  rename(id, name) {
    const clean = String(name || '').trim();
    if (!clean) throw new Error('Enter a name');
    if (!this.has(id)) throw new Error('Unknown account');
    this.state.update(d => { for (const a of d.prefs.accounts || []) if (a.id === id) a.name = clean; });
  }

  /** Forget a saved login. The shared folder is never touched. */
  remove(id) {
    if (!this.has(id)) throw new Error('Unknown account');
    fs.rmSync(this.slot(id), { recursive: true, force: true });
    this.state.update(d => { d.prefs.accounts = (d.prefs.accounts || []).filter(a => a.id !== id); });
    this.info.delete(id);
    this.version++;
    delete this.usage[id];
    this.saveUsage();
  }

  /** Switch the shared login to a saved one. The login it replaces is saved first. */
  use(id) {
    const run = this.queue.then(() => this.switchTo(id));
    this.queue = run.catch(() => {});
    return run;
  }

  /** The saved login to switch to: { t (claudeAiOauth), acct (oauthAccount) }, or a reason it can't be used. */
  switchTarget(id) {
    const t = oauthOf(readJson(path.join(this.slot(id), 'credentials.json')));
    if (!t) throw new Error('That saved login can’t be read. Add it again.');
    if (t.refreshTokenExpiresAt && t.refreshTokenExpiresAt < Date.now()) throw new Error('That saved login has expired. Add it again.');
    // Without it the old oauthAccount would stay, and the next switch would save these tokens under it
    const acct = readJson(path.join(this.slot(id), 'account.json'));
    if (!identity(acct)) throw new Error('That saved login has no account details. Add it again.');
    return { t, acct };
  }

  async switchTo(id) {
    if (this.mac) throw new Error(NO_SWITCHING_MAC);
    if (!this.has(id)) throw new Error('Unknown account');
    this.switchTarget(id);
    const credFile = this.sharedCredentialsFile();
    const globalFile = globalConfigFile();
    let globalReal = globalFile;
    try { globalReal = fs.realpathSync(globalFile); } catch { /* missing */ }
    const hasGlobal = fs.existsSync(globalReal);
    const swap = () => {
      let g;
      if (hasGlobal) {
        try { g = JSON.parse(fs.readFileSync(globalReal, 'utf8')); } catch { /* left alone below */ }
        if (!g || typeof g !== 'object' || Array.isArray(g)) {
          g = undefined;
          console.error(`skiffcode: ${globalFile} isn't valid JSON; switching the credentials only`);
        }
      } else console.error(`skiffcode: no ${globalFile}; switching the credentials only`);
      // Save the login in use. A missing or broken credentials file is never saved over a login.
      const cur = readJson(credFile);
      const o = oauthOf(cur);
      if (o) {
        const acct = g && g.oauthAccount;
        const owner = this.ownerOf(o, acct);
        this.saveLogin(o, owner ? undefined : acct, { id: owner || undefined });
      }
      // Read again: when the login in use was this account, the save above holds its newest tokens
      const { t, acct: targetAcct } = this.switchTarget(id);
      fs.mkdirSync(path.dirname(credFile), { recursive: true, mode: 0o700 });
      const keep = cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {};
      writeFileReplacing(credFile, JSON.stringify({ ...keep, claudeAiOauth: t }), 0o600);
      // Recorded before .claude.json is written, so a failure there still leaves the tokens' owner known.
      // The identity is what oauthAccount holds after this switch (none when the file can't be written).
      writeFileAtomic(this.lastSwitchFile, JSON.stringify({ id, sha: sha(t.refreshToken), identity: g ? identity(targetAcct) : null }));
      this.version++;
      if (g) {
        g.oauthAccount = targetAcct;
        writeFileReplacing(globalReal, JSON.stringify(g, null, 2));
        const back = readJson(globalReal);
        if (!back || JSON.stringify(back.oauthAccount) !== JSON.stringify(targetAcct)) console.error(`skiffcode: ${globalFile} changed while switching accounts`);
      }
    };
    if (hasGlobal) await withClaudeLock(globalReal, swap);
    else swap();
  }

  // ---------------------------------------------------------------- adding a login

  /** A private folder for `claude auth login`; its login is kept once it's done. */
  startSignIn(name) {
    if (this.mac) throw new Error(NO_SWITCHING_MAC);
    const clean = String(name || '').trim();
    if (!clean) throw new Error('Enter a name');
    const scratch = path.join(this.dir, `.login-${crypto.randomUUID()}`);
    privateDir(scratch);
    this.pending.set(scratch, { name: clean, at: Date.now() });
    if (!this.poll) {
      this.poll = setInterval(() => this.checkSignIns(), 1000);
      this.poll.unref();
    }
    return scratch;
  }

  checkSignIns() {
    for (const [scratch, p] of this.pending) {
      try {
        const saved = this.importScratch(scratch, p.name);
        if (saved) this.onSaved(saved);
        if (saved || Date.now() - p.at > SIGN_IN_WAIT) this.pending.delete(scratch); // a late one is picked up at startup
      } catch (e) {
        console.error(`skiffcode: couldn't save a sign-in: ${e.message}`);
        this.pending.delete(scratch);
      }
    }
    if (!this.pending.size) {
      clearInterval(this.poll);
      this.poll = undefined;
    }
  }

  /** A finished sign-in (both files parse) is saved and its folder removed. Returns the account, or undefined. */
  importScratch(scratch, name) {
    const o = oauthOf(readJson(path.join(scratch, '.credentials.json')));
    const g = readJson(path.join(scratch, '.claude.json'));
    const acct = g && g.oauthAccount;
    if (!o || !identity(acct)) return undefined;
    const saved = this.saveLogin(o, acct, { name });
    this.removeScratch(scratch);
    return saved;
  }

  removeScratch(scratch) {
    if (path.dirname(scratch) !== this.dir || !SCRATCH_RE.test(path.basename(scratch))) return;
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------- startup

  /** Once at startup; never fatal. Old folder accounts become saved logins; sign-ins left over are imported or tidied. */
  startup() {
    const oldDirs = new Set();
    try {
      const old = this.records().filter(a => a.dir);
      for (const a of old) oldDirs.add(path.resolve(a.dir));
      if (old.length || this.state.prefs.activeAccount !== undefined || this.state.prefs.defaultAccountName !== undefined) {
        const keep = this.records().filter(a => !a.dir).map(a => ({ id: a.id, name: a.name }));
        this.state.update(d => {
          d.prefs.accounts = keep;
          delete d.prefs.activeAccount;
          delete d.prefs.defaultAccountName;
        });
        for (const a of old) {
          try {
            const o = oauthOf(readJson(path.join(a.dir, '.credentials.json')));
            const g = readJson(path.join(a.dir, '.claude.json'));
            const acct = g && g.oauthAccount;
            if (!o || !identity(acct)) continue;
            const who = identity(acct);
            const same = this.records().find(r => this.infoOf(r.id).identity === who);
            if (same || !UUID_RE.test(String(a.id))) this.saveLogin(o, acct, { id: same && same.id, name: a.name });
            else {
              this.state.update(d => { d.prefs.accounts = [...(d.prefs.accounts || []), { id: a.id, name: this.uniqueName(a.name) }]; });
              this.saveLogin(o, acct, { id: a.id });
            }
          } catch (e) {
            console.error(`skiffcode: couldn't import account ${a.name}: ${e.message}`);
          }
        }
      }
    } catch (e) {
      console.error(`skiffcode: couldn't move old accounts: ${e.message}`);
    }
    try {
      // A sign-in tab resumed now would sign in to the shared folder
      if (this.state.sessions.some(s => s.account !== undefined || (s.kind === 'shell' && s.command && s.command.includes(' auth login')))) {
        this.state.update(d => {
          for (const s of d.sessions) {
            delete s.account;
            if (s.kind === 'shell' && s.command && s.command.includes(' auth login')) delete s.command;
          }
        });
      }
    } catch (e) {
      console.error(`skiffcode: couldn't update old sign-in tabs: ${e.message}`);
    }
    try {
      for (const n of fs.readdirSync(this.dir)) {
        const scratch = path.join(this.dir, n);
        if (!SCRATCH_RE.test(n) || oldDirs.has(scratch)) continue;
        try {
          if (!fs.lstatSync(scratch).isDirectory()) continue;
          const saved = this.importScratch(scratch);
          // Valid credentials without oauthAccount are still a login: never delete one
          const hasLogin = () => !!oauthOf(readJson(path.join(scratch, '.credentials.json')));
          if (!saved && Date.now() - fs.statSync(scratch).mtimeMs > 86400e3 && !hasLogin()) this.removeScratch(scratch);
        } catch (e) {
          console.error(`skiffcode: couldn't check ${scratch}: ${e.message}`);
        }
      }
    } catch { /* no folder */ }
    // Usage under old keys (default, old folder accounts) belongs to no login now
    const known = new Set([...this.records().map(a => a.id), 'current']);
    for (const k of Object.keys(this.usage)) if (!known.has(k)) delete this.usage[k];
  }

  // ---------------------------------------------------------------- usage

  /** Record usage from a Claude status-line snapshot, for the account in use. Returns true when it changed. */
  recordUsage(rateLimits) {
    if (!rateLimits) return false;
    const pick = w => (w && typeof w.used_percentage === 'number' ? { used: w.used_percentage, resetsAt: Number(w.resets_at) * 1000 || null } : undefined);
    const next = { fiveHour: pick(rateLimits.five_hour), weekly: pick(rateLimits.seven_day), at: Date.now() };
    if (!next.fiveHour && !next.weekly) return false;
    const id = this.inUseId() || 'current';
    const prev = this.usage[id];
    this.usage[id] = next;
    const changed = !prev || JSON.stringify({ ...prev, at: 0 }) !== JSON.stringify({ ...next, at: 0 });
    if (changed || !prev || Date.now() - prev.at > 60_000) this.saveUsage();
    return changed;
  }

  /**
   * Read an account's 5-hour and weekly usage from Anthropic with its token. Never refreshes or writes a
   * token, and never puts it in an error.
   */
  async refreshUsage(id) {
    if (!this.has(id)) throw new Error('Unknown account');
    const file = id === this.inUseId() ? this.sharedCredentialsFile() : path.join(this.slot(id), 'credentials.json');
    const o = oauthOf(readJson(file));
    if (!o) throw new Error('That saved login can’t be read. Add it again.');
    if (o.expiresAt && o.expiresAt < Date.now()) throw new Error('The sign-in token has expired. Use this account in a session to refresh it.');
    let res;
    try {
      res = await fetch(usageUrl(), {
        headers: { Authorization: `Bearer ${o.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error('Couldn’t reach Claude to read usage.');
    }
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      throw new Error(`Couldn’t read usage (HTTP ${res.status}).`);
    }
    let j;
    try { j = await res.json(); } catch { throw new Error('Couldn’t read usage (unexpected reply).'); }
    const pick = w => (w && typeof w.utilization === 'number' ? { used: w.utilization, resetsAt: Date.parse(w.resets_at) || null } : undefined);
    this.usage[id] = { fiveHour: pick(j.five_hour), weekly: pick(j.seven_day), at: Date.now() };
    this.saveUsage();
    return this.usage[id];
  }

  saveUsage() {
    try {
      fs.writeFileSync(this.usageFile, JSON.stringify(this.usage));
    } catch { /* ignore */ }
  }
}

/** A command that is one existing path with spaces in it ("/opt/my tools/claude"), quoted for a shell. */
function quotedPath(cmd) {
  const s = String(cmd || '').trim();
  return /\s/.test(s) && fs.existsSync(s) ? shq(s) : undefined;
}

/** The Claude program from the "Claude command" setting, as shell words without its flags ("claude --foo" -> "claude"). */
function claudeBin(cmd) {
  const whole = quotedPath(cmd);
  if (whole) return whole;
  const words = String(cmd || 'claude').trim().split(/\s+/);
  const i = words.findIndex(w => w.startsWith('-'));
  return (i === -1 ? words : words.slice(0, i)).join(' ') || 'claude';
}

/**
 * The statusLine command the user has set (account > ~/.claude). Never a repo's .claude settings:
 * statusline.sh runs it with sh, so a cloned repo could run code.
 */
function userStatusLine(configDir, defaultDir) {
  const files = [
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

module.exports = { Accounts, userStatusLine, claudeBin, quotedPath, usageUrl, globalConfigFile };
