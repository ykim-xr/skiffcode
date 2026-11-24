'use strict';
// Claude sessions and shells. Each runs in its own terminal host (ptyhost.py),
// so it keeps running while you look at another worktree, close the page,
// or restart the SkiffCode server. Claude's state comes from hooks.
const fs = require('fs');
const { execFile } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { spawnHost, hostAlive, hostPids, knownHostPids, isHost, psSnapshot, procfs, parentOf, PtyClient } = require('./pty');
const { shq, userShell, TERM_SIZE } = require('./util');
const { userStatusLine, quotedPath } = require('./accounts');
const { UUID } = require('./history');

const STALL_MS = Number(process.env.SKIFFCODE_STALL_MS) || 8000; // "working" but silent this long (and nothing running) = stopped
// No 'ended': liveness decides that (a /clear also fires SessionEnd).
const LINK_TTL_MS = 12 * 3600e3;
// a start tag counts only at the start of the prompt or right after a closing tag: one quoted in a message does not
const PEER_TAG_RE = /(?:"prompt":"|<\\?\/cross-session-message>(?:\\[nrt]|\s)*)(<cross-session-message\b[^>]*>)/g;
const RESTART_IDLE_MS = 3000; // idle this long before a restart: see restartable()
const HOOK_STATES = new Set(['working', 'question', 'permission', 'idle']);
const UUID_RE = new RegExp(`^${UUID.source}$`, 'i');
const needsYou = s => s === 'question' || s === 'permission';
// Claude's own line, "⎿  Interrupted · What should Claude do instead?" (older: "⎿  Interrupted by user").
// The gap may be drawn with cursor moves, which are stripped first.
const INTERRUPTED_RE = /⎿\s*Interrupted/;
let statusSeq = 0;

class Sessions extends EventEmitter {
  constructor(state, home, config, accounts) {
    super();
    this.starting = true; // until the constructor has read the states left from before
    this.state = state;
    this.accounts = accounts;
    this.info = new Map(); // id -> { contextPct, model, cost } from Claude's status line
    this.agents = new Map(); // id -> { offset, rest, list } subagents, from the agent hook log
    this.busy = new Set(); // sessions with a command running (a shell's command, or a Bash command Claude started)
    this.outWatch = new Map(); // id -> PtyClient listening to a Claude session's output (to notice Esc interrupts)
    this.inflight = new Map(); // id -> the launch or resume under way
    this.config = config; // () => the user's settings
    this.statusDir = path.join(home, 'status');
    this.ptyDir = path.join(home, 'pty');
    fs.mkdirSync(this.statusDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.ptyDir, { recursive: true, mode: 0o700 });
    this.hookFile = path.join(home, 'claude-hooks.json');
    this.writeHooks();
    this.live = new Map(); // id -> { state, changedAt, localAt }
    this.viewing = new Map(); // connection id -> { sessionId, visible }
    for (const s of state.sessions) this.live.set(s.id, { state: 'ended', changedAt: s.createdAt, localAt: 0 });
    // Sessions whose terminal host vanished without exiting (reboot, wsl --shutdown, crash)
    // were interrupted: the UI restarts them when you open their worktree.
    const interrupted = state.sessions.filter(s => !hostAlive(this.sock(s.id)) && !s.stoppedByUser && !fs.existsSync(this.sock(s.id) + '.exit'));
    if (interrupted.length) state.update(d => { for (const s of d.sessions) if (interrupted.some(x => x.id === s.id)) s.interrupted = true; });
    for (const s of state.sessions) {
      this.readAgents(s.id);
      if (!hostAlive(this.sock(s.id))) this.settleAgents(s.id, 'ended');
      this.readStatusLine(s.id, { initial: true });
    }
    // Picking up states from before the restart: nothing new happened, so nothing turns unread.
    this.poll();
    for (const s of state.sessions) this.readStatus(s.id, true);
    this.starting = false;
    // readPeers must run after readStatus: its name fallback skips ended sessions
    this.pruneLinks();
    for (const s of state.sessions) this.readPeers(s.id);
    this.watch();
    // Also settles restarts that were waiting before a server restart, once a scan has shown what is running.
    this.timer = setInterval(() => {
      this.poll();
      void this.scanCommands().then(() => { for (const id of [...(state.data.pendingRestart || [])]) this.settleRestart(id); });
    }, 2000);
  }

  sock(id) {
    return path.join(this.ptyDir, `${id}.sock`);
  }

  logFile(id) {
    return path.join(this.ptyDir, `${id}.log`);
  }

  /** Saved scrollback of a session that isn't running (empty if none). */
  history(id) {
    try {
      return fs.readFileSync(this.logFile(id));
    } catch {
      return Buffer.alloc(0);
    }
  }

  stateOf(id) {
    return (this.live.get(id) || {}).state || 'ended';
  }

  /** Sessions with their live state, for the UI. */
  list() {
    return this.state.sessions.map(s => ({ ...s, ...(this.info.get(s.id) || {}), agents: this.agentList(s.id), launchedAt: (this.live.get(s.id) || {}).launchedAt, command: this.busy.has(s.id) || undefined, state: this.stateOf(s.id), changedAt: (this.live.get(s.id) || {}).changedAt || s.createdAt }));
  }

  // ---------------------------------------------------------------- actions

  async create({ kind = 'claude', repoPath, worktreePath, branch, name, cols, rows, command, resumeClaudeId, prompt }) {
    if (!fs.existsSync(worktreePath)) throw new Error(`Folder not found: ${worktreePath}`);
    const siblings = this.state.sessionsIn(worktreePath).filter(s => s.kind === kind).length;
    const base = kind === 'shell' ? 'shell' : branch || path.basename(worktreePath);
    const rec = {
      id: crypto.randomUUID(),
      kind,
      claudeId: kind === 'claude' ? resumeClaudeId || crypto.randomUUID() : undefined,
      name: (name && name.trim()) || (siblings ? `${base} ${siblings + 1}` : base),
      repoPath,
      worktreePath,
      branch,
      createdAt: Date.now(),
      prompted: !!resumeClaudeId, // an existing conversation: start with --resume
      command: command || undefined, // shells only: run this first (e.g. `claude auth login`)
      initialPrompt: kind === 'claude' && !resumeClaudeId && prompt && String(prompt).trim() ? String(prompt) : undefined, // sent once, on first start
    };
    this.live.set(rec.id, { state: kind === 'shell' ? 'running' : 'starting', changedAt: Date.now(), localAt: Date.now() });
    this.state.update(d => void d.sessions.push(rec));
    await this.oneAtATime(rec.id, () => this.launch(rec, cols, rows));
    return rec;
  }

  resume(id, cols, rows) {
    return this.oneAtATime(id, async () => {
      const s = this.state.session(id);
      if (!s) throw new Error('No such session');
      if (hostAlive(this.sock(id))) return s;
      if (s.kind === 'claude' && !s.prompted && !fs.existsSync(path.join(this.statusDir, `${id}.prompted`))) {
        // Nothing to resume yet: fresh conversation under a new id.
        this.state.update(d => { const x = d.sessions.find(y => y.id === id); if (x) x.claudeId = crypto.randomUUID(); });
      }
      this.setState(id, s.kind === 'shell' ? 'running' : 'starting', true);
      await this.launch(this.state.session(id), cols, rows, { preload: true });
      return this.state.session(id);
    });
  }

  /** Runs launches of one session one after another: a second resume then finds the first one's host. */
  async oneAtATime(id, fn) {
    const run = (this.inflight.get(id) || Promise.resolve()).catch(() => {}).then(fn);
    this.inflight.set(id, run);
    try {
      return await run;
    } finally {
      if (this.inflight.get(id) === run) this.inflight.delete(id);
    }
  }

  /** Waits for a launch or resume under way: before its host exists there is nothing to kill. Never call it from inside oneAtATime. */
  stop(id) {
    return this.oneAtATime(id, async () => {
      const s = this.state.session(id);
      if (!s) return;
      this.state.update(d => { const x = d.sessions.find(y => y.id === id); if (x) { x.stoppedByUser = true; x.interrupted = undefined; } });
      await this.killHost(id);
      this.setState(id, 'ended', true);
    });
  }

  /**
   * Idle with nothing running: no turn, no background subagent, no command Claude started, nothing typed.
   * Restarting anything else would abort work or drop a draft. The idle time covers `busy`, which is up to
   * 2 s old: a turn that ends at once after starting a command must not look free.
   */
  restartable(id) {
    const l = this.live.get(id);
    return !!l && l.state === 'idle' && Date.now() - l.changedAt >= RESTART_IDLE_MS && !l.typedSinceIdle
      && !this.busy.has(id) && !(this.agentList(id) || []).some(a => a.state === 'running');
  }

  /** Stop a live Claude session and resume it with its conversation. Cuts off anything it is doing: check restartable() first. */
  async restart(id, cols, rows) {
    const s = this.state.session(id);
    if (!s) throw new Error('No such session');
    if (s.kind !== 'claude' || this.stateOf(id) === 'ended') throw new Error('Only a running Claude session can restart');
    await this.stop(id);
    return this.resume(id, cols, rows);
  }

  queueRestart(id) {
    this.state.update(d => { d.pendingRestart = [...new Set([...(d.pendingRestart || []), id])]; });
  }

  /** Restarts one session now, or queues it if it is busy. Returns { restarted } or { queued }. */
  async restartWhenFree(id, cols, rows) {
    const s = this.state.session(id);
    if (!s || s.kind !== 'claude' || this.stateOf(id) === 'ended') throw new Error('Only a running Claude session can restart');
    if (!this.restartable(id)) {
      this.queueRestart(id);
      return { queued: true };
    }
    await this.restart(id, cols, rows);
    return { restarted: true };
  }

  /** Restarts the free Claude sessions now. A busy one is never cut off: it restarts when it is free (see settleRestart). */
  async restartAll(cols, rows) {
    let restarted = 0;
    let waiting = 0;
    let failed = 0;
    for (const s of [...this.state.sessions]) {
      if (s.kind !== 'claude' || this.stateOf(s.id) === 'ended') continue;
      try {
        if ((await this.restartWhenFree(s.id, cols, rows)).queued) waiting++;
        else restarted++;
      } catch (e) {
        failed++;
        console.error(`skiffcode: restart of ${s.id} failed: ${e.message}`);
      }
    }
    return { restarted, waiting, failed };
  }

  /** Runs on the timer, after a scan of running commands. Restarts waiting sessions that are free now; drops ones that ended. */
  settleRestart(id) {
    if (!(this.state.data.pendingRestart || []).includes(id)) return;
    if (this.starting) return; // the first states are guesses
    const ended = this.stateOf(id) === 'ended';
    if (!ended && !this.restartable(id)) return;
    this.state.update(d => { d.pendingRestart = d.pendingRestart.filter(x => x !== id); });
    if (!ended) this.restart(id).catch(e => this.emit('restartFailed', { id, message: e.message }));
  }

  async forget(id) {
    await this.killHost(id);
    this.forgetRecord(id);
  }

  async stopAllIn(worktreePath) {
    for (const s of this.state.sessionsIn(worktreePath)) await this.forget(s.id);
  }

  /**
   * Rename in SkiffCode. An idle Claude nobody has typed into since gets `/rename <name>` typed now.
   * Otherwise Claude gets the new name as its session title (prompt bar, /resume) with your next
   * prompt or the next start: hooks may set it then, so nothing you are typing is disturbed.
   */
  async rename(id, name) {
    const s = this.state.session(id);
    this.state.update(d => { const x = d.sessions.find(y => y.id === id); if (x) x.name = name; });
    if (!s || s.kind !== 'claude') return;
    const title = path.join(this.statusDir, `${id}.title`);
    const l = this.live.get(id);
    const typed = String(name).replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim();
    if (typed && l && l.state === 'idle' && !l.typedSinceIdle && hostAlive(this.sock(id))) {
      try {
        const c = await new PtyClient(this.sock(id)).connect();
        c.write(`/rename ${typed}`);
        // Enter on its own: text and Enter in one chunk can read as a paste.
        await new Promise(r => setTimeout(r, 80));
        c.write('\r');
        await new Promise(r => setTimeout(r, 80));
        c.close();
        fs.rmSync(title, { force: true });
        return;
      } catch { /* hand it over with the next prompt instead */ }
    }
    try { fs.writeFileSync(title, JSON.stringify(String(name))); } catch { /* ignore */ }
  }

  setUnread(id, unread) {
    this.state.update(d => { const x = d.sessions.find(y => y.id === id); if (x) x.unread = unread || undefined; });
  }

  /** The UI tells us which session each page is looking at (for unread + alerts). */
  setViewing(connId, info) {
    if (info) this.viewing.set(connId, info);
    else this.viewing.delete(connId);
    if (info && info.sessionId && info.visible) {
      const s = this.state.session(info.sessionId);
      if (s && s.unread) this.setUnread(s.id, false);
    }
  }

  isBeingViewed(id) {
    for (const v of this.viewing.values()) if (v.visible && v.sessionId === id) return true;
    return false;
  }

  // ---------------------------------------------------------------- launching

  claudeCommand(s) {
    const cfg = this.config();
    const raw = (cfg.claudeCommand || 'claude').trim();
    const cmd = quotedPath(raw) || raw;
    const args = s.prompted ? ['--resume', s.claudeId] : ['--session-id', s.claudeId];
    if (!s.prompted && cfg.nameClaudeSessions !== false) args.push('--name', s.name);
    args.push('--settings', this.hookFile, ...(cfg.claudeArgs || []));
    if (!s.prompted && s.initialPrompt) args.push('--', s.initialPrompt);
    return `${cmd} ${args.map(shq).join(' ')}`;
  }

  async launch(s, cols = TERM_SIZE.cols, rows = TERM_SIZE.rows, { preload = false } = {}) {
    this.removeStatus(s.id);
    const l = this.live.get(s.id);
    if (l) l.launchedAt = Date.now(); // lets an open tab see a restart that the state alone does not show
    this.state.update(d => { const x = d.sessions.find(y => y.id === s.id); if (x) { x.stoppedByUser = undefined; x.interrupted = undefined; } });
    const shell = userShell();
    // An interactive login shell gives Claude the same PATH as your terminals (nvm, ~/.local/bin…).
    const command = s.kind === 'claude'
      ? [shell, '-lic', `exec ${this.claudeCommand(s)}`]
      : s.command ? [shell, '-lic', `${s.command}; exec ${shq(shell)} -l`] : [shell, '-l'];
    // Every session runs on the shared Claude config folder: CLAUDE_CONFIG_DIR only as the server has it.
    const env = {
      ...process.env,
      SKIFFCODE_SESSION_ID: s.id, SKIFFCODE_STATUS_DIR: this.statusDir,
      TERM: 'xterm-256color', SKIFFCODE_PTY_LOG: this.logFile(s.id),
    };
    // Keep your own status line: SkiffCode's wrapper records usage, then runs yours.
    const own = s.kind === 'claude' ? userStatusLine(null, this.accounts.defaultConfigDir()) : undefined;
    if (own) env.SKIFFCODE_USER_STATUSLINE = own.command;
    else delete env.SKIFFCODE_USER_STATUSLINE;
    if (preload && fs.existsSync(this.logFile(s.id))) env.SKIFFCODE_PTY_PRELOAD = this.logFile(s.id);
    await spawnHost({ sock: this.sock(s.id), cols, rows, cwd: s.worktreePath, command, env });
    // The first prompt is passed once; a later restart must not send it again.
    if (s.initialPrompt) this.state.update(d => { const x = d.sessions.find(y => y.id === s.id); if (x) delete x.initialPrompt; });
    this.emit('change');
  }

  async killHost(id) {
    const sock = this.sock(id);
    const { host } = hostPids(sock, { fresh: true });
    if (!host) return;
    try {
      const c = await new PtyClient(sock).connect();
      c.kill();
      await new Promise(r => setTimeout(r, 150));
      c.close();
    } catch { /* gone */ }
    // Checked again: the child may have exited meanwhile, and its pid gone to another process.
    const signal = sig => {
      const { child } = hostPids(sock, { fresh: true });
      if (child) {
        try { process.kill(-child, sig === 'SIGKILL' ? sig : 'SIGHUP'); } catch { /* not a group leader */ }
        try { process.kill(child, sig); } catch { /* gone */ }
      }
      if (isHost(host, sock)) try { process.kill(host, sig); } catch { /* gone */ }
    };
    signal('SIGTERM');
    // Wait for the old host to finish cleaning up before anything reuses its socket path.
    const end = Date.now() + 3000;
    // without /proc each check runs ps, so check less often
    while (isHost(host, sock) && Date.now() < end) await new Promise(r => setTimeout(r, procfs ? 30 : 100));
    if (isHost(host, sock)) signal('SIGKILL');
  }

  forgetRecord(id) {
    this.removeStatus(id);
    this.info.delete(id);
    this.agents.delete(id);
    for (const ext of ['.prompted', '.edited', '.statusline', '.agents', '.peers', '.title']) fs.rmSync(path.join(this.statusDir, id + ext), { force: true });
    for (const ext of ['.log', '.log.tmp', '.sock.exit']) fs.rmSync(path.join(this.ptyDir, id + ext), { force: true });
    this.live.delete(id);
    this.state.update(d => {
      d.sessions = d.sessions.filter(s => s.id !== id);
      d.links = (d.links || []).filter(l => l.a !== id && l.b !== id);
      delete (d.peerOffsets || {})[id];
      d.pendingRestart = (d.pendingRestart || []).filter(x => x !== id);
    });
  }

  // ---------------------------------------------------------------- state

  setState(id, state, local, { quiet = false } = {}) {
    const l = this.live.get(id);
    if (!l) return;
    if (local) l.localAt = Date.now();
    if (l.state === state) {
      // The same report again still settles subagents (ones read back from the log at startup, after poll set the state)
      if (!local && this.settleAgents(id, state)) this.emit('change');
      return;
    }
    // Claude also sends a "permission" notification for its question dialog: it's still a question.
    if (l.state === 'question' && state === 'permission' && !local) return;
    const from = l.state;
    l.state = state;
    if (state === 'idle') l.typedSinceIdle = false;
    if (!local || state === 'ended') this.settleAgents(id, state); // a hook said so, or Claude exited
    l.changedAt = Date.now();
    const s = this.state.session(id);
    if (s && s.kind === 'claude' && state === 'working' && !s.prompted) {
      this.state.update(d => { const x = d.sessions.find(y => y.id === id); if (x) x.prompted = true; });
    }
    if (s) {
      const kind = alertKind(from, state);
      if (s.kind === 'claude' && kind && !quiet && !this.starting && !this.isBeingViewed(id)) {
        this.setUnread(id, true);
        this.emit('alert', { sessionId: id, kind });
      }
      this.emit('transition', { session: s, from, to: state });
    }
    this.emit('change');
    if (state === 'ended') this.settleRestart(id); // drops it from the waiting list
  }

  poll() {
    this.checkStalled();
    for (const s of [...this.state.sessions]) {
      if (!this.live.has(s.id)) this.live.set(s.id, { state: 'ended', changedAt: s.createdAt, localAt: 0 });
      const alive = hostAlive(this.sock(s.id));
      const cur = this.stateOf(s.id);
      if (!alive && cur !== 'ended') {
        if (Date.now() - this.live.get(s.id).localAt < 1500) continue;
        this.setState(s.id, 'ended', true);
      } else if (alive && cur === 'ended') {
        this.setState(s.id, s.kind === 'shell' ? 'running' : 'idle', true);
        this.readStatus(s.id, true);
      }
    }
  }

  removeStatus(id) {
    fs.rmSync(path.join(this.statusDir, `${id}.json`), { force: true });
  }

  readStatus(id, ignoreAge) {
    const s = this.state.session(id);
    const l = this.live.get(id);
    if (!s || !l || s.kind !== 'claude' || !hostAlive(this.sock(id))) return;
    if (!s.prompted && fs.existsSync(path.join(this.statusDir, `${id}.prompted`))) {
      this.state.update(d => { const x = d.sessions.find(y => y.id === id); if (x) x.prompted = true; });
    }
    let st, mtime;
    try {
      const f = path.join(this.statusDir, `${id}.json`);
      mtime = fs.statSync(f).mtimeMs;
      st = JSON.parse(fs.readFileSync(f, 'utf8')).state;
    } catch {
      return;
    }
    if (!HOOK_STATES.has(st)) return;
    if (!ignoreAge && mtime + 50 < l.localAt) return;
    this.setState(id, st, false);
  }

  watch() {
    const pending = new Set();
    const edited = new Set();
    const lines = new Set();
    const agentLogs = new Set();
    const peerLogs = new Set();
    let timer;
    const flush = () => {
      timer = undefined;
      for (const id of agentLogs) this.readAgents(id);
      agentLogs.clear();
      for (const id of peerLogs) this.readPeers(id);
      peerLogs.clear();
      for (const id of lines) this.readStatusLine(id);
      lines.clear();
      for (const id of pending) this.readStatus(id);
      for (const id of edited) {
        const s = this.state.session(id);
        if (s) this.emit('edited', s.worktreePath);
      }
      pending.clear();
      edited.clear();
    };
    try {
      this.watcher = fs.watch(this.statusDir, (_e, file) => {
        const name = file ? String(file) : '';
        if (name.endsWith('.json')) pending.add(name.slice(0, -5));
        else if (name.endsWith('.statusline')) lines.add(name.slice(0, -11));
        else if (name.endsWith('.edited')) edited.add(name.slice(0, -7));
        else if (name.endsWith('.agents')) agentLogs.add(name.slice(0, -7));
        else if (name.endsWith('.peers')) peerLogs.add(name.slice(0, -6));
        else return;
        if (!timer) timer = setTimeout(flush, 60);
      });
    } catch (e) {
      console.error('skiffcode: cannot watch status dir', e.message);
    }
  }

  /** Claude's status-line JSON: context %, model, cost, and the account's 5-hour / weekly usage. */
  readStatusLine(id, { initial = false } = {}) {
    const s = this.state.session(id);
    if (!s) return;
    let j;
    try {
      j = JSON.parse(fs.readFileSync(path.join(this.statusDir, `${id}.statusline`), 'utf8'));
    } catch {
      return;
    }
    // Claude moved to another conversation (/clear, /tui, /resume…): resume that one from now on.
    // The id ends up on Claude's command line, so only a plain UUID counts.
    if (s.kind === 'claude' && typeof j.session_id === 'string' && UUID_RE.test(j.session_id) && j.session_id !== s.claudeId) {
      const tp = typeof j.transcript_path === 'string' ? j.transcript_path : '';
      // No transcript yet (a fresh /clear): --resume would fail. The .prompted marker belongs to
      // the old conversation, so drop it; the next prompt's hook writes it again.
      const prompted = path.basename(tp) === `${j.session_id}.jsonl` && fs.existsSync(tp);
      if (!prompted) fs.rmSync(path.join(this.statusDir, `${id}.prompted`), { force: true });
      this.state.update(d => { const x = d.sessions.find(y => y.id === id); if (x) { x.claudeId = j.session_id; x.prompted = prompted; } });
      this.emit('change');
    }
    const info = {
      contextPct: j.context_window && typeof j.context_window.used_percentage === 'number' ? Math.round(j.context_window.used_percentage) : undefined,
      model: j.model && j.model.display_name,
      cost: j.cost && j.cost.total_cost_usd,
    };
    const prev = this.info.get(id);
    this.info.set(id, info);
    // You renamed it in Claude (/rename): use that name here too. Only a change counts, so a
    // rename made here that Claude hasn't picked up yet isn't undone by the old name.
    // At startup the last name Claude reported counts as a change, unless a rename made here is
    // still waiting to be handed over (.title): that one is newer.
    const l = this.live.get(id);
    const cname = typeof j.session_name === 'string' ? j.session_name.trim() : '';
    if (l && cname) {
      const changed = initial ? !fs.existsSync(path.join(this.statusDir, `${id}.title`)) : l.claudeName !== undefined && cname !== l.claudeName;
      if (changed && cname !== s.name) {
        this.state.update(d => { const x = d.sessions.find(y => y.id === id); if (x) x.name = cname.slice(0, 120); });
        fs.rmSync(path.join(this.statusDir, `${id}.title`), { force: true });
        this.emit('change');
      }
      l.claudeName = cname;
    }
    // Usage from an old snapshot would be stamped as fresh: only live reports count.
    if (!initial && this.accounts.recordUsage(j.rate_limits)) this.emit('usage');
    if (JSON.stringify(prev) !== JSON.stringify(info)) this.emit('change');
  }

  /**
   * Claude runs no hook when you interrupt it (Esc), so a session would look busy forever.
   * Listen to each Claude session's output: while Claude works its spinner redraws constantly,
   * so its "⎿  Interrupted" line followed by quiet, or a long silence with nothing running, means it stopped.
   */
  watchOutput(s) {
    if (s.kind !== 'claude' || this.outWatch.has(s.id) || !hostAlive(this.sock(s.id))) return;
    const c = new PtyClient(this.sock(s.id));
    this.outWatch.set(s.id, c);
    c.on('data', buf => {
      const l = this.live.get(s.id);
      if (!l) return;
      l.lastOut = Date.now();
      if (l.state === 'working' && INTERRUPTED_RE.test(buf.toString('utf8').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''))) l.interruptAt = Date.now();
    });
    c.on('close', () => { if (this.outWatch.get(s.id) === c) this.outWatch.delete(s.id); });
    c.connect().then(() => { const l = this.live.get(s.id); if (l) l.lastOut = Date.now(); }, () => this.outWatch.delete(s.id));
  }

  /**
   * You answered a session that was waiting for you (permission prompt or question): Enter, Esc or an
   * option number. Claude runs no hook when you cancel (Esc), and none until an approved command
   * finishes, so treat a permission answer or any Esc as working now; its output (spinner, or
   * "Interrupted" then quiet) settles it. A question may have several parts: Enter or a number
   * answers one, and PostToolUse fires after the last, so the question state holds until then.
   */
  userInput(id, data) {
    const s = this.state.session(id);
    const l = this.live.get(id);
    if (l) l.typedSinceIdle = true;
    if (!s || !l || s.kind !== 'claude' || !needsYou(l.state)) return;
    const text = data.toString('latin1');
    const esc = text === '\x1b';
    const answered = esc || text.includes('\r') || /^[1-9]$/.test(text);
    if (!answered) return; // arrow keys etc.: still choosing
    if (l.state === 'question' && !esc) return;
    this.writeStatus(id, 'working');
    this.setState(id, 'working', true, { quiet: true });
    this.setUnread(id, false);
  }

  writeStatus(id, state) {
    const f = path.join(this.statusDir, `${id}.json`);
    const tmp = `${f}.${process.pid}-${++statusSeq}.srv`;
    try { fs.writeFileSync(tmp, `{"state":"${state}"}\n`); fs.renameSync(tmp, f); } catch { fs.rmSync(tmp, { force: true }); }
  }

  checkStalled() {
    const now = Date.now();
    for (const s of this.state.sessions) {
      if (s.kind !== 'claude') continue;
      const l = this.live.get(s.id);
      if (!l) continue;
      if (l.state !== 'working') { l.interruptAt = 0; continue; }
      this.watchOutput(s);
      if (!l.lastOut || now - l.changedAt < 3000) continue;
      const quietFor = now - l.lastOut;
      const interrupted = l.interruptAt && quietFor > 1500;
      const stalled = quietFor > STALL_MS && !this.busy.has(s.id) && !(this.agentList(s.id) || []).some(a => a.state === 'running');
      if (!interrupted && !stalled) continue;
      l.interruptAt = 0;
      // Record it where the hooks do, so the next prompt's "working" is seen as a change.
      this.writeStatus(s.id, 'idle');
      if (interrupted) this.settleAgents(s.id, 'ended');
      this.setState(s.id, 'idle', true, { quiet: true });
    }
  }

  /**
   * Which sessions have a command running, from the process tree under each terminal host:
   * a shell with a child process (your command), or a Claude with a Bash command still going
   * (Claude runs those through a shell that sources its shell snapshot). Shown as a zigzag.
   */
  async scanCommands() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      let procs; // [pid, ppid, age in seconds, args]
      if (procfs) {
        const out = await new Promise(res => execFile('ps', ['-eo', 'pid=,ppid=,etimes=,args='], { maxBuffer: 16 << 20 }, (e, so) => res(e ? '' : so)));
        if (!out) return;
        procs = out.split('\n').map(line => line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map(m => [Number(m[1]), Number(m[2]), Number(m[3]), m[4]]);
      } else {
        // BSD ps has no etimes: the shared snapshot has etime, already in seconds
        const snap = await psSnapshot();
        if (!snap) return;
        procs = [...snap].map(([pid, p]) => [pid, p.ppid, p.age, p.command]);
      }
      const kids = new Map();
      const info = new Map();
      for (const [pid, ppid, age, args] of procs) {
        info.set(pid, { age, args });
        if (!kids.has(ppid)) kids.set(ppid, []);
        kids.get(ppid).push(pid);
      }
      const below = pid => { const all = []; const st = [...(kids.get(pid) || [])]; while (st.length) { const p = st.pop(); all.push(p); st.push(...(kids.get(p) || [])); } return all; };
      const next = new Set();
      for (const s of this.state.sessions) {
        const { host: hostPid } = hostPids(this.sock(s.id));
        if (!hostPid || !info.has(hostPid)) continue;
        const top = kids.get(hostPid) || []; // the login shell the host started
        let busy = false;
        if (s.kind === 'shell') {
          // anything under the shell that has run for 2s+ (skips prompt helpers like git status)
          busy = top.some(sh => (kids.get(sh) || []).some(c => (info.get(c) || {}).age >= 2));
        } else {
          busy = below(hostPid).some(p => { const i = info.get(p); return i && i.age >= 1 && /shell-snapshots\/snapshot-|claude-[0-9a-f]+-cwd/.test(i.args); });
        }
        if (busy) next.add(s.id);
      }
      const changed = next.size !== this.busy.size || [...next].some(id => !this.busy.has(id));
      this.busy = next;
      if (changed) this.emit('change');
    } finally {
      this.scanning = false;
    }
  }

  /** Subagents Claude spawned (from PreToolUse Agent/Task + SubagentStart/Stop). */
  readAgents(id) {
    if (!this.state.session(id)) return;
    let a = this.agents.get(id);
    if (!a) this.agents.set(id, (a = { offset: 0, rest: Buffer.alloc(0), list: [] }));
    let chunk;
    try {
      const fd = fs.openSync(path.join(this.statusDir, `${id}.agents`), 'r');
      try {
        const size = fs.fstatSync(fd).size;
        if (size < a.offset) Object.assign(a, { offset: 0, rest: Buffer.alloc(0), list: [] });
        chunk = Buffer.alloc(size - a.offset);
        fs.readSync(fd, chunk, 0, chunk.length, a.offset);
        a.offset = size;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return;
    }
    const buf = Buffer.concat([a.rest, chunk]);
    const end = buf.lastIndexOf(10);
    a.rest = end === -1 ? buf : buf.subarray(end + 1);
    if (end === -1) return;
    let changed = false;
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      const tab = line.indexOf('\t');
      if (tab === -1) continue;
      let ev;
      try { ev = JSON.parse(line.slice(tab + 1)); } catch { continue; }
      if (applyAgentEvent(a.list, ev, Number(line.slice(0, tab)) * 1000 || Date.now())) changed = true;
    }
    if (a.list.length > 40) a.list = a.list.filter(x => x.state === 'running').concat(a.list.filter(x => x.state !== 'running').slice(-20));
    if (changed) this.emit('change');
  }

  /**
   * Messages from other Claude sessions (the hook logs each prompt that starts with <cross-session-message>).
   * The read offset lives in state.json: a restart must neither replay old lines (dismissed links would
   * come back, counts double) nor skip lines written while the server was down.
   */
  readPeers(id) {
    if (!this.state.session(id)) return;
    let offset = (this.state.data.peerOffsets || {})[id] || 0;
    let chunk;
    try {
      const fd = fs.openSync(path.join(this.statusDir, `${id}.peers`), 'r');
      try {
        const size = fs.fstatSync(fd).size;
        if (size < offset) offset = 0;
        chunk = Buffer.alloc(size - offset);
        fs.readSync(fd, chunk, 0, chunk.length, offset);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return;
    }
    const end = chunk.lastIndexOf(10); // a partial last line is read again next time
    const lines = end === -1 ? [] : chunk.subarray(0, end).toString('utf8').split('\n');
    const found = [];
    for (const line of lines) {
      const tab = line.indexOf('\t');
      if (tab === -1) continue;
      const at = Number(line.slice(0, tab)) * 1000 || Date.now();
      for (const [, tag] of line.slice(tab + 1).matchAll(PEER_TAG_RE)) {
        const from = this.peerSender(id, tag);
        if (from) found.push({ from, at });
      }
    }
    const next = offset + end + 1;
    if (!found.length && next === ((this.state.data.peerOffsets || {})[id] || 0)) return;
    this.state.update(d => {
      (d.peerOffsets ||= {})[id] = next;
      d.links ||= [];
      for (const f of found) {
        const [a, b] = [f.from, id].sort();
        let l = d.links.find(x => x.a === a && x.b === b);
        if (!l) d.links.push((l = { a, b, n: 0, at: 0, from: f.from, first: f.from, firstAt: f.at }));
        l.n++;
        // lines can arrive out of order (after a restart): `at`/`from` follow the newest, `first` the oldest
        if (f.at >= l.at) { l.at = f.at; l.from = f.from; }
        if (f.at < l.firstAt) { l.first = f.from; l.firstAt = f.at; }
      }
      d.links = d.links.filter(l => Date.now() - l.at < LINK_TTL_MS);
    });
  }

  /** The SkiffCode session that sent the message in this start tag, or undefined (outside SkiffCode, or ambiguous). */
  peerSender(receiver, tag) {
    const attr = k => {
      const m = new RegExp(`[ \\n]${k}=\\\\"((?:[^"\\\\]|\\\\.)*?)\\\\"`).exec(tag);
      if (!m) return '';
      try { return JSON.parse(`"${m[1]}"`); } catch { return ''; }
    };
    const others = this.state.sessions.filter(s => s.id !== receiver);
    const byHost = new Map(others.filter(s => s.kind === 'claude').map(s => [knownHostPids(this.sock(s.id)).host, s]));
    byHost.delete(0);
    const sock = /\/(\d+)\.sock$/.exec(attr('from'));
    // a wrapper command that doesn't exec makes the sender's pid a descendant of the host
    for (let pid = sock ? Number(sock[1]) : 0, i = 0; pid > 1 && i < 8; pid = parentOf(pid), i++) {
      const hit = byHost.get(pid);
      if (hit) return hit.id;
    }
    const name = attr('from-name');
    const named = name ? others.filter(s => s.kind === 'claude' && s.name === name && (this.live.get(s.id) || {}).state !== 'ended') : [];
    return named.length === 1 ? named[0].id : undefined;
  }

  /** At startup: drop links to sessions that are gone, stale links and offsets of unknown sessions. */
  pruneLinks() {
    const known = new Set(this.state.sessions.map(s => s.id));
    this.state.update(d => {
      d.links = (d.links || []).filter(l => known.has(l.a) && known.has(l.b) && Date.now() - l.at < LINK_TTL_MS);
      for (const id of Object.keys(d.peerOffsets || {})) if (!known.has(id)) delete d.peerOffsets[id];
    });
  }

  agentList(id) {
    const a = this.agents.get(id);
    if (!a || !a.list.length) return undefined;
    return a.list.map(x => ({ key: x.key, type: x.type, description: x.description, background: x.background || undefined, state: x.state, startedAt: x.startedAt, endedAt: x.endedAt }));
  }

  /** When Claude stops, its foreground subagents are done; when the session ends, all are. */
  settleAgents(id, state) {
    const a = this.agents.get(id);
    if (!a) return false;
    let changed = false;
    for (const x of a.list) {
      if (x.state !== 'running') continue;
      if (state === 'ended' || (state === 'idle' && !x.background)) {
        x.state = state === 'ended' ? 'stopped' : 'done';
        x.endedAt = Date.now();
        changed = true;
      }
    }
    return changed;
  }

  /** Hooks go in a file passed with `claude --settings`; your ~/.claude/settings.json is never edited. */
  writeHooks() {
    const script = path.join(__dirname, 'hook.sh');
    const hook = (st, ev = '') => [{ type: 'command', command: `sh ${shq(script)} ${st}${ev ? ` ${ev}` : ''}` }];
    const settings = {
      hooks: {
        SessionStart: [{ hooks: hook('idle', 'start') }],
        UserPromptSubmit: [{ hooks: hook('working', 'prompt') }],
        PreToolUse: [
          { matcher: 'AskUserQuestion', hooks: hook('question') },
          { matcher: 'Agent|Task', hooks: hook('agent') },
        ],
        PostToolUse: [
          { matcher: '*', hooks: hook('working') },
          { matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: hook('edited') },
          { matcher: 'Agent|Task', hooks: hook('agent') },
        ],
        SubagentStart: [{ hooks: hook('agent') }],
        SubagentStop: [{ hooks: hook('agent') }],
        Notification: [
          { matcher: 'permission_prompt', hooks: hook('permission') },
          { matcher: 'elicitation_dialog|agent_needs_input', hooks: hook('question') },
        ],
        Stop: [{ hooks: hook('idle') }],
        SessionEnd: [{ hooks: hook('ended') }],
      },
      statusLine: { type: 'command', command: `sh ${shq(path.join(__dirname, 'statusline.sh'))}` },
    };
    const own = userStatusLine(null, this.accounts.defaultConfigDir());
    if (own && own.padding !== undefined) settings.statusLine.padding = own.padding;
    if (own && own.refreshInterval !== undefined) settings.statusLine.refreshInterval = own.refreshInterval;
    fs.writeFileSync(this.hookFile, JSON.stringify(settings, null, 2) + '\n');
  }

  dispose() {
    clearInterval(this.timer);
    if (this.watcher) this.watcher.close();
  }
}

const AGENT_TOOLS = new Set(['Agent', 'Task']);
/** Apply one hook event to a session's subagent list. Returns true when it changed. */
function applyAgentEvent(list, ev, at) {
  const e = ev.hook_event_name;
  const done = (x, how = 'done') => { x.state = how; x.endedAt = at; return true; };
  // Claude lists the subagents still running in the background: any other background one has ended,
  // also one stopped without a SubagentStop.
  let swept = false;
  if (Array.isArray(ev.background_tasks)) {
    const live = new Set(ev.background_tasks.filter(t => t && t.type === 'subagent').map(t => t.id));
    for (const x of list) if (x.state === 'running' && x.background && x.agentId && !live.has(x.agentId)) swept = done(x) || swept;
  }
  return applyOne(list, ev, at, e, done) || swept;
}

function applyOne(list, ev, at, e, done) {
  if (e === 'PreToolUse' && AGENT_TOOLS.has(ev.tool_name)) {
    if (ev.tool_use_id && list.some(x => x.toolUseId === ev.tool_use_id)) return false;
    const ti = ev.tool_input || {};
    list.push({ key: ev.tool_use_id || `a${at}-${list.length}`, toolUseId: ev.tool_use_id, type: ti.subagent_type || 'general-purpose', description: String(ti.description || '').slice(0, 200), background: !!ti.run_in_background, state: 'running', startedAt: at });
    return true;
  }
  if (e === 'SubagentStart') {
    if (list.some(x => x.agentId === ev.agent_id)) return false;
    // The newest unpaired call: it was just made (older unpaired ones may be stale).
    const open = list.filter(x => !x.agentId && x.state === 'running').reverse();
    const m = open.find(x => x.type === ev.agent_type) || open[0];
    if (m) m.agentId = ev.agent_id;
    else list.push({ key: ev.agent_id || `a${at}-${list.length}`, agentId: ev.agent_id, type: ev.agent_type || 'agent', description: '', state: 'running', startedAt: at });
    return true;
  }
  if (e === 'SubagentStop') {
    const m = list.find(x => x.agentId && x.agentId === ev.agent_id);
    return m && m.state === 'running' ? done(m) : false;
  }
  if (e === 'PostToolUse' && AGENT_TOOLS.has(ev.tool_name)) {
    // A background subagent's tool call returns as soon as it starts; it finishes at SubagentStop.
    // Claude also runs subagents in the background without run_in_background: the result says so.
    const m = list.find(x => x.toolUseId && x.toolUseId === ev.tool_use_id);
    if (!m || m.state !== 'running') return false;
    const r = ev.tool_response;
    if (r && (r.isAsync || r.status === 'async_launched')) {
      // The result names the agent: trust it over the SubagentStart pairing, which guesses when several start together.
      const id = typeof r.agentId === 'string' ? r.agentId : undefined;
      const changed = !m.background || (id && m.agentId !== id);
      if (id && m.agentId !== id) {
        for (const x of list) if (x !== m && x.agentId === id) x.agentId = undefined;
        m.agentId = id;
      }
      m.background = true;
      return !!changed;
    }
    return m.background ? false : done(m);
  }
  return false;
}

function alertKind(from, to) {
  if (needsYou(from) && needsYou(to)) return undefined; // question ⇄ permission for the same prompt: you already know
  if (to === 'question' && from !== 'question') return 'question';
  if (to === 'permission' && from !== 'permission') return 'permission';
  if (to === 'idle' && (from === 'working' || needsYou(from))) return 'done';
  return undefined;
}

module.exports = { Sessions, LINK_TTL_MS, alertKind, needsYou, applyAgentEvent };
