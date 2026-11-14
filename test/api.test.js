'use strict';
// End-to-end test of the SkiffCode server: real git, real terminals (ptyhost.py),
// and a fake `claude` that fires the real hook commands.
const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const crypto = require('crypto');
const { Client } = require('./client');

const APP = path.resolve(__dirname, '..');
// macOS's default tmpdir makes pty socket paths longer than its 104-byte limit
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'skiffcode-api-')));
const HOME = path.join(tmp, 'home');
const PORT = 3600 + Math.floor(Math.random() * 300);
const sh = (cmd, cwd) => execFileSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { if ((last = await fn())) return last; } catch (e) { last = e; }
    await sleep(40);
  }
  throw new Error(`timed out waiting for: ${what}${last instanceof Error ? ` (${last.message})` : ''}`);
}
let passed = 0;
const step = async (name, fn) => { await fn(); passed++; console.log(`  ✓ ${name}`); };
const MAC = process.platform === 'darwin';
const skipped = what => console.log(`  - skipped on macOS (no account switching or sign-in there): ${what}`);
/** A step that needs account switching, sign-in or .credentials.json, which SkiffCode doesn't do on macOS. */
const switchingStep = (name, fn) => (MAC ? skipped(name) : step(name, fn));

process.env.FAKE_LOG = path.join(tmp, 'claude-calls.jsonl');
process.env.FAKE_SCRIPT_FILE = path.join(tmp, 'plan.txt');
const plan = s => fs.writeFileSync(process.env.FAKE_SCRIPT_FILE, s);
const calls = () => (fs.existsSync(process.env.FAKE_LOG) ? fs.readFileSync(process.env.FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);

// Claude's own config folder for the default account, with the user's own status line
const CLAUDE_HOME = path.join(tmp, 'claude-home');
fs.mkdirSync(CLAUDE_HOME, { recursive: true });
fs.writeFileSync(path.join(CLAUDE_HOME, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'echo user-line', padding: 1 } }));

// The shared Claude login, laid out as Claude keeps it: .credentials.json, and oauthAccount in .claude.json
const SHARED_CRED = path.join(CLAUDE_HOME, '.credentials.json');
const SHARED_GLOBAL = path.join(CLAUDE_HOME, '.claude.json');
const login = who => ({ claudeAiOauth: { accessToken: `at-${who}`, refreshToken: `rt-${who}`, expiresAt: Date.now() + 3600e3, refreshTokenExpiresAt: Date.now() + 30 * 86400e3, scopes: ['user:inference'], subscriptionType: 'pro' } });
const oauthOf = who => ({ accountUuid: `acct-${who}`, emailAddress: `${who}@example.test`, organizationUuid: `org-${who}`, organizationName: `Org ${who}` });
const readJ = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const fmode = p => fs.statSync(p).mode & 0o777;
const slot = id => path.join(HOME, 'accounts', id);
/** A saved login's backups (credentials.prev-<ms>.json), oldest first. */
const backupsIn = dir => fs.readdirSync(dir).map(n => /^credentials\.prev-(\d+)\.json$/.exec(n)).filter(Boolean)
  .sort((a, b) => Number(a[1]) - Number(b[1])).map(m => path.join(dir, m[0]));

// A stand-in for Anthropic's usage endpoint (SKIFFCODE_USAGE_URL): no test talks to the real one
const usageReqs = [];
let usageStatus = 200;
const USAGE_PORT = PORT + 50;
http.createServer((req, res) => {
  usageReqs.push({ url: req.url, headers: req.headers });
  res.writeHead(usageStatus, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(usageStatus === 200
    ? { five_hour: { utilization: 69, resets_at: new Date(Date.now() + 3600e3).toISOString(), used_dollars: null }, seven_day: { utilization: 20, resets_at: new Date(Date.now() + 4 * 86400e3).toISOString() }, seven_day_opus: null }
    : { error: { type: 'authentication_error' } }));
}).listen(USAGE_PORT, '127.0.0.1').unref();

const repo = path.join(tmp, 'code', 'myapp');
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
sh(`git init -q -b main && git config user.email t@t && git config user.name t && printf 'line1\\nline2\\n' > README.md && printf 'def greet(name):\\n    return name\\n' > src/app.py && printf '.btn-primary { color: red; }\\n' > src/site.css && echo .env > .gitignore && git add . && git commit -qm init && echo SECRET=1 > .env`, repo);

let server;
function startServer() {
  server = spawn('node', [path.join(APP, 'server', 'main.js')], {
    env: { ...process.env, SKIFFCODE_HOME: HOME, SKIFFCODE_PORT: String(PORT), SHELL: '/bin/bash', SKIFFCODE_ALERT_LOG: path.join(tmp, 'alerts.jsonl'), CLAUDE_CONFIG_DIR: CLAUDE_HOME, SKIFFCODE_STALL_MS: '2500', SKIFFCODE_USAGE_URL: `http://127.0.0.1:${USAGE_PORT}/usage`, CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_MESSAGING_TOKEN: 'leak' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', d => process.stderr.write(`[server] ${d}`));
  server.out = '';
  server.stdout.on('data', d => { server.out += d; });
  return until(() => fs.existsSync(path.join(HOME, 'server.pid')) && fs.readFileSync(path.join(HOME, 'server.pid'), 'utf8') === String(server.pid), 'server up');
}

(async () => {
  console.log(`SkiffCode server e2e (tmp: ${tmp}, port ${PORT})`);
  await startServer();
  const token = fs.readFileSync(path.join(HOME, 'token'), 'utf8').trim();
  let c = await new Client(PORT, token).connect();

  await step('auth: page needs the token; ?tkn sets a cookie; websocket rejects strangers', async () => {
    const r1 = await fetch(`http://127.0.0.1:${PORT}/`);
    assert.equal(r1.status, 401);
    const r2 = await fetch(`http://127.0.0.1:${PORT}/?tkn=${token}`, { redirect: 'manual' });
    assert.equal(r2.status, 302);
    assert.match(r2.headers.get('set-cookie'), /skiffcode_tkn=.*HttpOnly/);
    const bad = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie: 'skiffcode_tkn=nope' } });
    await new Promise(res => { bad.onerror = res; bad.onclose = res; });
    const evil = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie: `skiffcode_tkn=${token}`, origin: 'https://evil.example' } });
    const outcome = await new Promise(res => { evil.onopen = () => res('open'); evil.onerror = () => res('rejected'); });
    assert.equal(outcome, 'rejected', 'cross-site pages cannot connect');
  });

  await step('hello, add repo from a subfolder, groups and ordering', async () => {
    await c.call('hello');
    await c.call('settings.set', { values: { claudeCommand: path.join(__dirname, 'fake-claude.js') } });
    const r = await c.call('repos.add', { path: path.join(repo, 'src') });
    assert.equal(r.path, repo);
    for (const n of ['beta', 'gamma']) {
      const p = path.join(tmp, 'code', n);
      fs.mkdirSync(p);
      sh('git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m x', p);
      await c.call('repos.add', { path: p });
    }
    await c.call('repos.move', { items: [{ kind: 'repo', path: path.join(tmp, 'code', 'gamma') }], target: { kind: 'repo', path: repo } });
    const { id } = await c.call('groups.create', { name: 'Work', repo: path.join(tmp, 'code', 'beta') });
    await c.call('repos.nudge', { path: repo, dir: -1 });
    const st = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8'));
    assert.deepEqual(st.repos.map(r => r.name), ['myapp', 'gamma', 'beta']);
    assert.equal(st.repos.find(r => r.name === 'beta').group, id);
  });

  await step('/api/status counts only clients that answer a ping (a connection that died silently is not open)', async () => {
    const status = async () => (await (await fetch(`http://127.0.0.1:${PORT}/api/status`, { headers: { 'x-skiffcode-token': token } })).json()).clients;
    assert.equal(await status(), 1, 'only the healthy client');
    const raw = net.connect(PORT, '127.0.0.1');
    let got = Buffer.alloc(0);
    raw.on('data', d => { got = Buffer.concat([got, d]); });
    raw.on('error', () => {});
    raw.write(`GET /ws HTTP/1.1\r\nHost: localhost:${PORT}\r\nOrigin: http://localhost:${PORT}\r\nCookie: skiffcode_tkn=${token}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n\r\n`);
    try {
      await until(() => got.includes('101 Switching'), 'raw socket upgraded');
      const t0 = Date.now();
      assert.equal(await status(), 1, 'the silent socket is not counted, the healthy client still is');
      assert.ok(Date.now() - t0 < 1900, 'answers within the launcher\'s 2 s limit');
      assert.ok(got.includes(Buffer.from([0x89, 0x00])), 'the silent socket was connected and pinged');
    } finally {
      raw.destroy();
    }
  });

  let wt, sid;
  await step('new worktree: .env copied, Claude starts in it (with base recorded)', async () => {
    plan('SessionStart,hang');
    const br = await c.call('worktrees.branches', { repo });
    assert.equal(br.defaultBase, 'main');
    assert.equal((await c.call('worktrees.checkName', { repo, branch: 'main' })).error.includes('exists'), true);
    const res = await c.call('worktrees.create', { repo, newBranch: 'feat/login', base: 'main', cols: 100, rows: 30 });
    wt = res.path;
    sid = res.session;
    assert.equal(wt, path.join(tmp, 'code', 'myapp.worktrees', 'feat-login'));
    assert.equal(fs.readFileSync(path.join(wt, '.env'), 'utf8'), 'SECRET=1\n');
    await until(() => calls().length === 1, 'claude launched');
    assert.equal(calls()[0].cwd, wt);
    const wts = (await c.call('worktrees.list', { repo })).worktrees;
    assert.deepEqual(wts.map(w => w.branch), ['main', 'feat/login']);
    assert.equal(wts[1].base, 'main');
    await until(() => c.last('state')?.data.sessions.find(s => s.id === sid)?.state === 'idle', 'ready');
  });

  await step('terminal: history on open, input, resize; survives a server restart', async () => {
    const shell = await c.call('sessions.create', { kind: 'shell', worktreePath: wt, cols: 90, rows: 25 });
    await c.call('term.open', { id: shell.id, cols: 90, rows: 25 });
    await sleep(400);
    c.input(shell.id, 'echo "sum=$((20+22))"; stty size; echo "child=${CLAUDE_CODE_CHILD_SESSION:-none} tok=${CLAUDE_CODE_MESSAGING_TOKEN:-none}"\r');
    await until(() => /sum=42/.test(c.term.get(shell.id) || '') && /25 90/.test(c.term.get(shell.id) || ''), 'shell output');
    // the server was started with a Claude Code session's variables: its terminals don't get them
    await until(() => /child=none tok=none/.test(c.term.get(shell.id) || ''), 'no inherited Claude session variables');
    // output with terminal queries and a mode left on, to check what a restart replays
    c.input(shell.id, "printf 'qtext\\033[c\\033[>0q\\033]7501;?\\007\\033[?1004h-qend\\n'\r");
    await until(() => /-qend\r\n/.test(c.term.get(shell.id) || ''), 'query output');
    c.input(shell.id, 'export KEEP=still-here\r');
    await sleep(500); // let the shell run the export before the server is killed
    // restart the server: the shell (and Claude) keep running
    server.kill('SIGTERM');
    await sleep(300);
    await startServer();
    c = await new Client(PORT, token).connect();
    await c.call('hello');
    await c.call('term.open', { id: shell.id, cols: 90, rows: 25 });
    await until(() => /sum=42/.test(c.term.get(shell.id) || ''), 'scrollback after restart');
    c.input(shell.id, 'echo "v=$KEEP"\r');
    await until(() => /v=still-here/.test(c.term.get(shell.id) || ''), 'same shell after restart');
    const snap = (await c.call('hello')).sessions;
    assert.equal(snap.find(s => s.id === sid).state, 'idle', 'Claude still running after restart');
    await c.call('sessions.stop', { id: shell.id });
    const kept = (await c.call('hello')).sessions.find(s => s.id === shell.id);
    assert.equal(kept.state, 'ended', 'a stopped shell stays in the list');
    const saved = Buffer.from((await c.call('term.history', { id: shell.id })).data, 'base64').toString();
    assert.match(saved, /sum=42/, 'its output was saved to disk');
    await c.call('sessions.resume', { id: shell.id, cols: 90, rows: 25 });
    c.term.delete(shell.id);
    await c.call('term.close', { id: shell.id });
    await c.call('term.open', { id: shell.id, cols: 90, rows: 25 });
    await until(() => /sum=42[\s\S]*restarted/.test(c.term.get(shell.id) || ''), 'old output shown above the restarted shell');
    const replayed = c.term.get(shell.id);
    assert.match(replayed, /qtext-qend\r\n/, 'normal text replayed');
    assert.ok(!/\x1b\[c|\x1b\[>0q|\x1b\]7501;\?\x07|\x1b\[\?1004h/.test(replayed), 'nothing replayed makes the terminal answer');
    assert.match(replayed, /restarted[\s\S]*\x1b\[\?1004l/, 'modes reset after the restarted line');
    c.input(shell.id, 'echo "again=$((1+1))"\r');
    await until(() => /again=2/.test(c.term.get(shell.id) || ''), 'restarted shell works');
    await c.call('sessions.forget', { id: shell.id });
    assert.ok(!(await c.call('hello')).sessions.some(s => s.id === shell.id), 'close removes it');
  });

  await step('reboot: sessions killed without exiting come back as “interrupted” and resume', async () => {
    const sh2 = await c.call('sessions.create', { kind: 'shell', worktreePath: wt, cols: 80, rows: 24 });
    await c.call('term.open', { id: sh2.id });
    await sleep(300);
    c.input(sh2.id, 'echo before-reboot\r');
    await until(() => /before-reboot/.test(c.term.get(sh2.id) || ''), 'output');
    await until(() => /before-reboot/.test(fs.readFileSync(path.join(HOME, 'pty', `${sh2.id}.log`), 'utf8')), 'the host saved its scrollback', 10_000);
    // simulate a power cut: SIGKILL the host and its shell, and the server
    const [hostPid, childPid] = fs.readFileSync(path.join(HOME, 'pty', `${sh2.id}.sock.pid`), 'utf8').trim().split(/\s+/).map(Number);
    process.kill(childPid, 'SIGKILL');
    process.kill(hostPid, 'SIGKILL');
    server.kill('SIGKILL');
    await sleep(300);
    fs.rmSync(path.join(HOME, 'server.pid'), { force: true });
    await startServer();
    c = await new Client(PORT, token).connect();
    const after = (await c.call('hello')).sessions.find(s => s.id === sh2.id);
    assert.equal(after.state, 'ended');
    assert.equal(after.interrupted, true, 'marked as interrupted');
    assert.match(Buffer.from((await c.call('term.history', { id: sh2.id })).data, 'base64').toString(), /before-reboot/);
    await c.call('sessions.resume', { id: sh2.id });
    const back = (await c.call('hello')).sessions.find(s => s.id === sh2.id);
    assert.equal(back.interrupted, undefined);
    await until(async () => (await c.call('hello')).sessions.find(s => s.id === sh2.id).state === 'running', 'running again');
    await c.call('sessions.forget', { id: sh2.id });
  });

  await step('terminal hosts: a stale .pid naming another process is not alive and never signalled', async () => {
    const { hostAlive } = require('../server/pty');
    const s = await c.call('sessions.create', { kind: 'shell', worktreePath: wt, cols: 80, rows: 24 });
    await c.call('sessions.stop', { id: s.id });
    const sock = path.join(HOME, 'pty', `${s.id}.sock`);
    await until(() => !fs.existsSync(sock + '.pid'), 'host gone');
    const victim = spawn('sleep', ['60'], { stdio: 'ignore' });
    try {
      fs.writeFileSync(sock + '.pid', `${victim.pid} ${victim.pid}\n`);
      fs.writeFileSync(sock, '');
      assert.equal(hostAlive(sock), false);
      await c.call('sessions.stop', { id: s.id });
      await c.call('sessions.forget', { id: s.id });
      await sleep(200);
      assert.deepEqual([victim.exitCode, victim.signalCode], [null, null], 'the other process is left alone');
    } finally {
      victim.kill();
      for (const f of [sock, sock + '.pid']) fs.rmSync(f, { force: true });
    }
  });

  await step('terminal input: a 300 KB paste arrives whole; a huge size is clamped', async () => {
    const s = await c.call('sessions.create', { kind: 'shell', worktreePath: wt, cols: 80, rows: 24 });
    await c.call('term.open', { id: s.id, cols: 80, rows: 24 });
    await sleep(400);
    await c.call('term.resize', { id: s.id, cols: 70000, rows: 70000 });
    c.input(s.id, 'stty -echo; wc -c | tr -d " " | sed s/^/count=/; stty echo\r');
    await sleep(400);
    c.input(s.id, ('a'.repeat(99) + '\n').repeat(3000) + '\x04');
    await until(() => /count=300000/.test(c.term.get(s.id) || ''), 'all of the paste reached the program', 15000);
    await c.call('sessions.forget', { id: s.id });
  });

  await step('resume: two at once start Claude once', async () => {
    plan('SessionStart,hang');
    const s = await c.call('sessions.create', { kind: 'claude', worktreePath: wt, cols: 80, rows: 24 });
    await until(async () => (await c.call('hello')).sessions.find(x => x.id === s.id).state === 'idle', 'ready');
    await c.call('sessions.stop', { id: s.id });
    const n = calls().length;
    await Promise.all([c.call('sessions.resume', { id: s.id }), c.call('sessions.resume', { id: s.id })]);
    await sleep(1500);
    assert.equal(calls().length, n + 1, 'one launch');
    await c.call('sessions.forget', { id: s.id });
  });

  await step('sessions.move: reorders within a worktree, ignores another worktree', async () => {
    plan('SessionStart,hang');
    const mk = (name, worktreePath = wt) => c.call('sessions.create', { kind: 'claude', worktreePath, name, cols: 80, rows: 24 });
    const [a, b, d] = [await mk('mv-a'), await mk('mv-b'), await mk('mv-c')];
    const other = await mk('mv-other', repo);
    const order = async () => (await c.call('hello')).sessions.filter(x => /^mv-/.test(x.name) && x.worktreePath === wt).map(x => x.name.slice(3));
    assert.deepEqual(await order(), ['a', 'b', 'c']);
    for (const [id, target, after, want] of [[d, a, false, 'cab'], [a, b, true, 'cba'], [b, d, false, 'bca'], [b, a, true, 'cab']]) {
      await c.call('sessions.move', { id: id.id, target: target.id, after });
      assert.equal((await order()).join(''), want);
    }
    const all = async () => (await c.call('hello')).sessions.map(x => x.id).join();
    const before = await all();
    await c.call('sessions.move', { id: a.id, target: other.id });
    await c.call('sessions.move', { id: a.id, target: a.id, after: true });
    assert.equal(await all(), before, 'another worktree, or itself: nothing changes');
    for (const x of [a, b, d, other]) await c.call('sessions.forget', { id: x.id });
  });

  await step('restart: model and context come back from the status line; no unread marks; a pending rename wins', async () => {
    plan('SessionStart,UserPromptSubmit,PreToolUse:AskUserQuestion,hang');
    const s = await c.call('sessions.create', { kind: 'claude', worktreePath: wt, name: 'before', cols: 80, rows: 24 });
    await until(async () => (await c.call('hello')).sessions.find(x => x.id === s.id).state === 'question', 'asking');
    await c.call('view', { sessionId: s.id, visible: true });
    await c.call('view', { sessionId: null, visible: false });
    await c.call('sessions.rename', { id: s.id, name: 'mine' });
    fs.writeFileSync(path.join(HOME, 'status', `${s.id}.statusline`), JSON.stringify({ session_id: 'x', session_name: 'stale', model: { display_name: 'Sonnet' }, context_window: { used_percentage: 33 } }));
    await sleep(300);
    server.kill('SIGTERM');
    await sleep(300);
    await startServer();
    c = await new Client(PORT, token).connect();
    const after = (await c.call('hello')).sessions.find(x => x.id === s.id);
    assert.deepEqual([after.model, after.contextPct], ['Sonnet', 33], 'status line read at startup');
    assert.equal(after.unread, undefined, 'a restart marks nothing unread');
    assert.equal(after.name, 'mine', 'the SkiffCode rename not yet handed over is kept');
    await c.call('sessions.forget', { id: s.id });
  });

  await step('restart: a subagent that finished before stays finished (the log is read again at startup)', async () => {
    plan('SessionStart,UserPromptSubmit,Agent:Explore:Find auth code,sleep:300,Stop,hang');
    const s = await c.call('sessions.create', { kind: 'claude', worktreePath: wt, cols: 80, rows: 24 });
    const agentState = async () => (((await c.call('hello')).sessions.find(x => x.id === s.id) || {}).agents || [])[0]?.state;
    await until(async () => (await agentState()) === 'done', 'done when Claude stops');
    server.kill('SIGTERM');
    await sleep(300);
    await startServer();
    c = await new Client(PORT, token).connect();
    assert.equal(await agentState(), 'done', 'still done after the restart');
    await c.call('sessions.forget', { id: s.id });
  });

  await step('question / permission / done → alerts and unread; viewing clears unread', async () => {
    plan('SessionStart,sleep:150,UserPromptSubmit,sleep:150,PreToolUse:AskUserQuestion,sleep:250,PostToolUse:AskUserQuestion,sleep:150,Notification:permission_prompt,sleep:250,PostToolUse:Write,sleep:150,Stop,hang');
    await c.call('sessions.stop', { id: sid });
    await c.call('view', { sessionId: null, visible: false });
    c.events.length = 0;
    await c.call('sessions.resume', { id: sid });
    await until(() => c.events.filter(e => e.event === 'alert').length >= 3, 'three alerts', 10_000).catch(e => { console.log(JSON.stringify(c.events.map(e => e.event === 'state' ? 'state:' + (e.data.sessions.find(s => s.id === sid) || {}).state : e.event + ':' + JSON.stringify(e.data)))); console.log(fs.readdirSync(path.join(HOME, 'status'))); throw e; });
    const kinds = c.events.filter(e => e.event === 'alert').map(e => e.data.kind);
    assert.deepEqual(kinds, ['question', 'permission', 'done']);
    assert.ok(c.events.some(e => e.event === 'fs.changed' && e.data.root === wt), 'Write tool → file views refresh');
    const s = (await c.call('hello')).sessions.find(x => x.id === sid);
    assert.equal(s.unread, true);
    assert.equal(s.prompted, true);
    await c.call('view', { sessionId: sid, visible: true });
    assert.equal((await c.call('hello')).sessions.find(x => x.id === sid).unread, undefined);
    // nobody has SkiffCode open → the server alerts by itself
    plan('SessionStart,sleep:300,UserPromptSubmit,sleep:300,Notification:permission_prompt,hang');
    await c.call('sessions.stop', { id: sid });
    await c.call('sessions.resume', { id: sid });
    c.close();
    await until(() => fs.existsSync(path.join(tmp, 'alerts.jsonl')) && /needs permission/.test(fs.readFileSync(path.join(tmp, 'alerts.jsonl'), 'utf8')), 'server-side alert', 10_000);
    const al = JSON.parse(fs.readFileSync(path.join(tmp, 'alerts.jsonl'), 'utf8').trim().split('\n').pop());
    assert.equal(al.kind, 'permission');
    assert.equal(al.sound, 'alert.wav', 'the default sound for permission');
    assert.equal(al.volume, 70);
    c = await new Client(PORT, token).connect();
    await c.call('hello');
    // resume after exit continues the same conversation
    await c.call('sessions.stop', { id: sid });
    plan('SessionStart,hang');
    const n = calls().length;
    await c.call('sessions.resume', { id: sid });
    await until(() => calls().length === n + 1, 'resumed');
    assert.equal(calls()[n].args[0], '--resume');
  });

  await step('files: tree with ignored flag, read, write with conflict detection, create/rename/delete', async () => {
    const top = await c.call('fs.list', { root: wt, dir: '' });
    assert.deepEqual(top.map(e => `${e.type}:${e.name}${e.ignored ? '(ignored)' : ''}`), ['dir:src', 'file:.env(ignored)', 'file:.gitignore', 'file:README.md']);
    const f = await c.call('fs.read', { root: wt, path: 'src/app.py' });
    assert.match(f.text, /def greet/);
    const w = await c.call('fs.write', { root: wt, path: 'src/app.py', text: f.text + '\nprint(greet("x"))\n', mtime: f.mtime });
    await sleep(20);
    fs.appendFileSync(path.join(wt, 'src/app.py'), '# claude edit\n');
    await assert.rejects(c.call('fs.write', { root: wt, path: 'src/app.py', text: 'mine', mtime: w.mtime }), /changed on disk/);
    await c.call('fs.create', { root: wt, path: 'docs/notes.md', type: 'file' });
    await c.call('fs.rename', { root: wt, from: 'docs/notes.md', to: 'docs/readme-notes.md' });
    assert.ok(fs.existsSync(path.join(wt, 'docs/readme-notes.md')));
    await c.call('fs.delete', { root: wt, path: 'docs' });
    assert.ok(!fs.existsSync(path.join(wt, 'docs')));
    await assert.rejects(c.call('fs.read', { root: wt, path: '../../../etc/passwd' }), /outside/);
    await assert.rejects(c.call('fs.read', { root: '/etc', path: 'passwd' }), /doesn’t know|Not a worktree/);
  });

  await step('files: a file that is not UTF-8 is never saved over; a UTF-8 BOM is kept', async () => {
    const d = path.join(tmp, 'code', 'encodings');
    fs.mkdirSync(d);
    await c.call('repos.add', { path: d });
    const cp949 = Buffer.from([0x68, 0x69, 0x20, 0xc7, 0xd1, 0xb1, 0xdb, 0x0a]); // "hi 한글" in CP949
    fs.writeFileSync(path.join(d, 'kr.txt'), cp949);
    const kr = await c.call('fs.read', { root: d, path: 'kr.txt' });
    assert.equal(kr.notUtf8, true);
    assert.ok(kr.text.startsWith('hi '), 'still shown');
    for (const force of [false, true]) {
      await assert.rejects(c.call('fs.write', { root: d, path: 'kr.txt', text: kr.text + 'x', mtime: kr.mtime, force }), /isn’t UTF-8/);
    }
    assert.ok(fs.readFileSync(path.join(d, 'kr.txt')).equals(cp949), 'bytes unchanged');
    fs.writeFileSync(path.join(d, 'bom.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\n')]));
    const b = await c.call('fs.read', { root: d, path: 'bom.txt' });
    assert.deepEqual([b.text, b.bom, b.notUtf8], ['a\n', true, undefined]);
    await c.call('fs.write', { root: d, path: 'bom.txt', text: 'b\n', mtime: b.mtime, bom: b.bom });
    assert.deepEqual([...fs.readFileSync(path.join(d, 'bom.txt'))], [0xef, 0xbb, 0xbf, 0x62, 0x0a]);
    assert.equal((await c.call('fs.read', { root: d, path: 'bom.txt' })).bom, true);
    await c.call('repos.remove', { path: d });
  });

  await step('file watches: a watched file replaced again and again keeps reporting', async () => {
    const d = path.join(tmp, 'code', 'replaced');
    fs.mkdirSync(d);
    await c.call('repos.add', { path: d });
    const f = path.join(d, 'f.txt');
    fs.writeFileSync(f, '0');
    await c.call('fs.watch', { root: d, path: 'f.txt' });
    const changed = () => c.events.some(e => e.event === 'fs.changed' && e.data.root === d && e.data.path === 'f.txt');
    for (const n of [1, 2, 3]) {
      await sleep(200);
      c.events.length = 0;
      fs.writeFileSync(`${f}.tmp`, String(n));
      fs.renameSync(`${f}.tmp`, f); // how editors and git replace a file: a new inode
      await until(changed, `change ${n} reported`, 3000);
    }
    await sleep(200);
    c.events.length = 0;
    fs.rmSync(f);
    await sleep(50);
    fs.writeFileSync(f, 'again'); // deleted and made again, as git checkout does
    await until(changed, 'the remade file reported', 3000);
    await sleep(200);
    c.events.length = 0;
    fs.appendFileSync(f, '!');
    await until(changed, 'an edit of the remade file reported', 3000);
    await c.call('fs.unwatch', { root: d, path: 'f.txt' });
    await c.call('repos.remove', { path: d });
  });

  await step('symlinks:only into folders SkiffCode knows; deleting a link keeps its target; `..name` files; FIFOs', async () => {
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    const beta = path.join(tmp, 'code', 'beta');
    fs.writeFileSync(path.join(beta, 'shared.txt'), 'shared');
    const links = path.join(wt, 'links');
    fs.mkdirSync(links);
    fs.symlinkSync(outside, path.join(links, 'out'));
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(links, 'out-file'));
    fs.symlinkSync(path.join(outside, 'nothing-yet.txt'), path.join(links, 'dangling'));
    fs.symlinkSync(path.join(beta, 'shared.txt'), path.join(links, 'beta-file'));
    fs.symlinkSync('../src/app.py', path.join(links, 'app'));
    const base = await c.call('fs.viewBase', { root: wt });
    const view = async rel => (await fetch(`http://127.0.0.1:${PORT}${base}${rel}`)).status;
    const b64 = Buffer.from('x').toString('base64');
    for (const [what, call] of [
      ['read through a folder link', () => c.call('fs.read', { root: wt, path: 'links/out/secret.txt' })],
      ['read a file link', () => c.call('fs.read', { root: wt, path: 'links/out-file' })],
      ['list a folder link', () => c.call('fs.list', { root: wt, dir: 'links/out' })],
      ['write through a folder link', () => c.call('fs.write', { root: wt, path: 'links/out/new.txt', text: 'x' })],
      ['write through a dangling link', () => c.call('fs.write', { root: wt, path: 'links/dangling', text: 'x' })],
      ['create through a dangling link', () => c.call('fs.create', { root: wt, path: 'links/dangling', type: 'file' })],
      ['upload through a dangling link', () => c.call('fs.upload', { root: wt, path: 'links/dangling', data: b64, replace: true })],
    ]) await assert.rejects(call(), /outside/, what);
    assert.ok(!fs.existsSync(path.join(outside, 'nothing-yet.txt')) && !fs.existsSync(path.join(outside, 'new.txt')), 'nothing created outside');
    for (const rel of ['links/out/secret.txt', 'links/out-file']) assert.equal(await view(rel), 403, rel);
    // into another registered repo, or inside this one: fine
    assert.equal((await c.call('fs.read', { root: wt, path: 'links/beta-file' })).text, 'shared');
    assert.match((await c.call('fs.read', { root: wt, path: 'links/app' })).text, /def greet/);
    assert.deepEqual([await view('links/beta-file'), await view('links/app')], [200, 200]);
    await c.call('fs.write', { root: wt, path: 'links/beta-file', text: 'shared 2' });
    assert.equal(fs.readFileSync(path.join(beta, 'shared.txt'), 'utf8'), 'shared 2');
    // deleting a link removes the link, not what it points to
    await c.call('fs.delete', { root: wt, path: 'links/out' });
    assert.ok(!fs.existsSync(path.join(links, 'out')) && fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8') === 'secret');
    // a name that starts with two dots is still inside
    fs.writeFileSync(path.join(wt, '..env'), 'DOTS=1');
    assert.equal((await c.call('fs.read', { root: wt, path: '..env' })).text, 'DOTS=1');
    // a FIFO (or a device) is refused instead of hanging the read
    sh('mkfifo links/pipe', wt);
    const timeout = new Promise((_r, reject) => setTimeout(() => reject(new Error('fs.read of a FIFO hung')), 3000));
    await assert.rejects(Promise.race([c.call('fs.read', { root: wt, path: 'links/pipe' }), timeout]), /Not a file/);
    fs.rmSync(links, { recursive: true });
    fs.rmSync(path.join(wt, '..env'));
    fs.rmSync(path.join(beta, 'shared.txt'));
  });

  await step('status line: from your own or the account’s Claude settings, never from a repo’s .claude folder', async () => {
    fs.mkdirSync(path.join(wt, '.claude'), { recursive: true });
    for (const f of ['settings.json', 'settings.local.json']) fs.writeFileSync(path.join(wt, '.claude', f), JSON.stringify({ statusLine: { type: 'command', command: 'echo repo-line' } }));
    plan('SessionStart,hang');
    const before = calls().length;
    const s = await c.call('sessions.create', { kind: 'claude', worktreePath: wt, cols: 80, rows: 24 });
    await until(() => calls().length > before, 'claude launched');
    assert.equal(calls().at(-1).userStatusLine, 'echo user-line');
    await c.call('sessions.forget', { id: s.id });
    fs.rmSync(path.join(wt, '.claude'), { recursive: true });
  });

  await step('entry points refuse inherited names, bad escapes, foreign hosts, unknown session ids, roots and git refs', async () => {
    for (const m of ['constructor', 'hasOwnProperty', '__proto__']) await assert.rejects(c.call(m), /Unknown method/, m);
    const cookie = `skiffcode_tkn=${token}`;
    for (const p of ['/%E0%A4%A', '/custom-sounds/%E0%A4%A']) {
      assert.equal((await fetch(`http://127.0.0.1:${PORT}${p}`, { headers: { cookie }, signal: AbortSignal.timeout(3000) })).status, 400, p);
    }
    // app pages can't be framed; previews can
    const page = await fetch(`http://127.0.0.1:${PORT}/`, { headers: { cookie } });
    assert.match(page.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    const base = await c.call('fs.viewBase', { root: wt });
    assert.equal((await fetch(`http://127.0.0.1:${PORT}${base}README.md`)).headers.get('x-frame-options'), null);
    // only loopback host names (a DNS-rebinding page sends its own), for pages, previews and the websocket
    const raw = (p, headers) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: PORT, path: p, headers }, res => { res.resume(); resolve(res.statusCode); });
      req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end();
    });
    const up = { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', cookie };
    assert.equal(await raw('/ws', { ...up, host: `127.0.0.1:${PORT}` }), 101);
    assert.equal(await raw('/ws', { ...up, host: `[::1]:${PORT}`, origin: `http://[::1]:${PORT}` }), 101);
    assert.equal(await raw('/', { host: `localhost:${PORT}`, cookie }), 200);
    for (const host of ['evil.example', `evil.example:${PORT}`, `localhost.evil.example:${PORT}`]) {
      assert.equal(await raw('/', { host, cookie }), 403, host);
      assert.equal(await raw(`${base}README.md`, { host }), 403, host);
      assert.equal(await raw('/ws', { ...up, host }), 403, host);
    }
    // session ids end up in file paths: only real ones
    for (const m of ['term.open', 'term.history', 'term.resize', 'term.close', 'sessions.forget', 'sessions.stop', 'sessions.resume', 'sessions.rename', 'sessions.setUnread']) {
      await assert.rejects(c.call(m, { id: '../../x', name: 'x' }), /No such session/, m);
    }
    // layouts: known worktrees only, and not huge
    await c.call('layout.save', { root: wt, layout: { tabs: [] } });
    await assert.rejects(c.call('layout.save', { root: '/etc', layout: {} }), /Not a worktree/);
    await assert.rejects(c.call('layout.save', { root: wt, layout: { x: 'a'.repeat(300 * 1024) } }), /too large/);
    // a ref or sha that git would take as an option
    for (const [m, params] of [['git.show', { root: wt, ref: `--output=${tmp}/pwned`, path: 'README.md' }], ['git.commitFiles', { root: wt, sha: `--output=${tmp}/pwned` }]]) {
      await assert.rejects(c.call(m, params), /Not a valid ref/, m);
    }
    assert.ok(!fs.readdirSync(tmp).some(f => f.startsWith('pwned')), 'git wrote no file');
  });

  await step('private data: no token in the log, home folder 700 (even an old 755 one), state and attachments 600', async () => {
    assert.ok(!/tkn=/.test(server.out), 'piped output has no token');
    assert.ok(server.out.includes(path.join(HOME, 'token')), 'it says where the token is');
    const mode = p => fs.statSync(p).mode & 0o777;
    await c.call('prefs.mute', { muted: false });
    assert.equal(mode(path.join(HOME, 'state.json')), 0o600);
    for (const d of ['', 'status', 'inbox', 'drops', 'accounts']) assert.equal(mode(path.join(HOME, d)), 0o700, d || 'home');
    const d = await c.call('drops.save', { name: 'private.txt', data: Buffer.from('p').toString('base64') });
    assert.equal(mode(d.path), 0o600);
    assert.equal(mode(path.dirname(d.path)), 0o700);
    fs.chmodSync(HOME, 0o755);
    fs.chmodSync(path.join(HOME, 'status'), 0o755);
    server.kill('SIGTERM');
    await sleep(300);
    await startServer();
    c = await new Client(PORT, token).connect();
    await c.call('hello');
    assert.deepEqual([mode(HOME), mode(path.join(HOME, 'status'))], [0o700, 0o700]);
  });

  await step('git: status lists, stage/unstage/discard, commit, diff vs base, commits on branch', async () => {
    fs.writeFileSync(path.join(wt, 'new.txt'), 'hello\n');
    let s = await c.call('git.status', { root: wt });
    assert.deepEqual(s.changes.map(x => x.path), ['src/app.py']);
    assert.deepEqual(s.untracked.map(x => x.path), ['new.txt']);
    await c.call('git.stage', { root: wt, files: ['src/app.py', 'new.txt'] });
    s = await c.call('git.status', { root: wt });
    assert.deepEqual(s.staged.map(x => x.path).sort(), ['new.txt', 'src/app.py']);
    await c.call('git.unstage', { root: wt, files: ['new.txt'] });
    s = await c.call('git.status', { root: wt });
    assert.deepEqual(s.staged.map(x => x.path), ['src/app.py']);
    await c.call('git.discard', { root: wt, files: ['new.txt'] });
    assert.ok(!fs.existsSync(path.join(wt, 'new.txt')), 'discarding an untracked file deletes it');
    {
      // names that look like pathspec magic or globs name only themselves
      const d = path.join(tmp, 'code', 'pathspecs');
      fs.mkdirSync(d);
      const names = [':!x', 'f[1].txt', 'f1.txt', 'other.txt'];
      for (const n of names) fs.writeFileSync(path.join(d, n), 'old\n');
      sh('git init -q -b main && git config user.email t@t && git config user.name t && git add -A && git commit -qm x', d);
      for (const n of names) fs.writeFileSync(path.join(d, n), 'new\n');
      await c.call('repos.add', { path: d });
      const list = args => sh(`git diff ${args} --name-only`, d).split('\n').filter(Boolean).sort();
      await c.call('git.discard', { root: d, files: [':!x'] });
      assert.deepEqual(list(''), ['f1.txt', 'f[1].txt', 'other.txt'], 'discard: only that file');
      await c.call('git.stage', { root: d, files: ['f[1].txt'] });
      assert.deepEqual(list('--cached'), ['f[1].txt'], 'stage: only that file');
      await c.call('git.stage', { root: d, files: ['f1.txt'] });
      await c.call('git.unstage', { root: d, files: ['f[1].txt'] });
      assert.deepEqual(list('--cached'), ['f1.txt'], 'unstage: only that file');
      await c.call('repos.remove', { path: d });
    }
    await assert.rejects(c.call('git.commit', { root: wt, message: '  ' }), /message/);
    await c.call('git.commit', { root: wt, message: 'greet callers\n\nlonger body' });
    fs.writeFileSync(path.join(wt, 'README.md'), 'line1\nline2 changed\n');
    const ch = await c.call('git.changes', { root: wt });
    assert.equal(ch.status.base, 'main');
    assert.equal(ch.status.ahead, 1);
    assert.deepEqual(ch.files.map(f => `${f.status}:${f.path}`), ['M:README.md', 'M:src/app.py']);
    const base = await c.call('git.show', { root: wt, ref: ch.from, path: 'README.md' });
    assert.equal(base.text, 'line1\nline2\n');
    const cm = await c.call('git.commits', { root: wt });
    assert.deepEqual(cm.commits.map(x => x.subject), ['greet callers']);
    const log = await c.call('git.log', { root: wt });
    assert.deepEqual(log.commits.map(x => x.subject), ['greet callers', 'init'], 'full history of HEAD, newest first, including base commits');
    assert.equal(log.more, false);
    const p1 = await c.call('git.log', { root: wt, max: 1 });
    assert.deepEqual([p1.commits.map(x => x.subject), p1.more], [['greet callers'], true]);
    const p2 = await c.call('git.log', { root: wt, skip: 1, max: 1 });
    assert.deepEqual([p2.commits.map(x => x.subject), p2.more], [['init'], false]);
    const files = await c.call('git.commitFiles', { root: wt, sha: cm.commits[0].sha });
    assert.deepEqual(files.files.map(f => f.path), ['src/app.py']);
    // lines added and deleted per file, as git counts them
    const [added, deleted] = sh(`git show --numstat --format= ${cm.commits[0].sha}`, wt).trim().split('\t').map(Number);
    assert.deepEqual(files.files.map(f => [f.added, f.deleted]), [[added, deleted]]);
    const stt = await c.call('worktrees.status', { path: wt, fresh: true });
    assert.equal(stt.ahead, 1);
    assert.equal(stt.dirty, 1);
    assert.ok(stt.insertions >= 2);
  });

  await step('git: stash modes, files, apply/pop, drop by sha, stale-list guard, conflicts', async () => {
    const made = await c.call('worktrees.create', { repo, newBranch: 'stash-t', base: 'main', startClaude: false });
    const sw = made.path;
    const W = f => path.join(sw, f);
    const list = async () => (await c.call('git.stashList', { root: sw })).stashes;
    const isClean = async () => { const s = await c.call('git.status', { root: sw }); return s.changes.length + s.staged.length + s.untracked.length === 0; };
    const stash = (mode, extra) => c.call('git.stash', { root: sw, mode, ...extra });
    assert.deepEqual(await list(), []);

    // all: a tracked edit plus an untracked file, with a message
    fs.writeFileSync(W('README.md'), 'line1\nline2\nline3\n');
    fs.writeFileSync(W('fresh.txt'), 'brand new\n');
    assert.deepEqual(await stash('all', { message: ' my stash ' }), { stashed: true });
    assert.ok(await isClean(), 'stash all leaves a clean worktree, untracked files included');
    let st = await list();
    assert.equal(st.length, 1);
    assert.deepEqual([st[0].index, st[0].message, st[0].branch], [0, 'my stash', 'stash-t']);
    assert.match(st[0].sha, /^[0-9a-f]{40,64}$/);
    const sha1 = st[0].sha;

    // files: tracked with counts, untracked flagged and readable at ^3
    const sf = await c.call('git.stashFiles', { root: sw, sha: sha1 });
    assert.equal(sf.base, sh('git rev-parse HEAD', sw).trim());
    const byPath = Object.fromEntries(sf.files.map(f => [f.path, f]));
    assert.deepEqual([byPath['README.md'].status, byPath['README.md'].added, byPath['README.md'].deleted], ['M', 1, 0]);
    assert.deepEqual([byPath['fresh.txt'].status, byPath['fresh.txt'].untracked], ['A', true]);
    assert.equal((await c.call('git.show', { root: sw, ref: `${sha1}^3`, path: 'fresh.txt' })).text, 'brand new\n');

    // apply keeps the stash and restores the files; pop removes it
    const applied = await c.call('git.stashApply', { root: sw, sha: sha1 });
    assert.equal(applied.conflicts, false);
    assert.equal(fs.readFileSync(W('fresh.txt'), 'utf8'), 'brand new\n');
    assert.equal((await list()).length, 1, 'apply keeps the stash');
    sh('git reset -q --hard && git clean -fdq', sw);
    assert.equal((await c.call('git.stashApply', { root: sw, sha: sha1, pop: true })).conflicts, false);
    assert.equal(fs.readFileSync(W('README.md'), 'utf8'), 'line1\nline2\nline3\n');
    assert.deepEqual(await list(), [], 'pop removes the stash');
    sh('git reset -q --hard && git clean -fdq', sw);

    // modes stash only what they should
    const cases = [
      { mode: 'tracked', left: ['u.txt'], gone: ['README.md'] },
      { mode: 'staged', left: ['u.txt', 'src/site.css'], gone: ['README.md'] },
      { mode: 'files', files: ['src/site.css', 'u.txt'], left: ['README.md'], gone: ['src/site.css', 'u.txt'] },
    ];
    for (const k of cases) {
      fs.writeFileSync(W('README.md'), `edit for ${k.mode}\n`);
      fs.writeFileSync(W('src/site.css'), `.a { color: ${k.mode}; }\n`);
      fs.writeFileSync(W('u.txt'), 'untracked\n');
      if (k.mode === 'staged') sh('git add README.md', sw); else if (k.mode === 'tracked') sh('git checkout -q -- src/site.css', sw);
      const before = (await list()).length;
      assert.deepEqual(await stash(k.mode, k.files ? { files: k.files } : {}), { stashed: true }, k.mode);
      assert.equal((await list()).length, before + 1, k.mode);
      const s = await c.call('git.status', { root: sw });
      const left = [...s.changes, ...s.staged, ...s.untracked].map(x => x.path);
      for (const f of k.left) assert.ok(left.includes(f), `${k.mode}: ${f} stays`);
      for (const f of k.gone) assert.ok(!left.includes(f), `${k.mode}: ${f} is stashed`);
      if (k.mode === 'files') assert.equal(fs.readFileSync(W('README.md'), 'utf8'), `edit for files\n`);
      sh('git reset -q --hard && git clean -fdq', sw);
    }
    assert.equal((await list()).length, 3);
    // file names are literal paths, not globs
    fs.writeFileSync(W('f[1].txt'), 'bracket\n');
    fs.writeFileSync(W('f1.txt'), 'plain\n');
    await stash('files', { files: ['f[1].txt'] });
    assert.ok(fs.existsSync(W('f1.txt')) && !fs.existsSync(W('f[1].txt')), 'only the named file is stashed');
    const lit = (await list())[0];
    assert.deepEqual((await c.call('git.stashFiles', { root: sw, sha: lit.sha })).files.map(f => f.path), ['f[1].txt']);
    await c.call('git.stashDrop', { root: sw, sha: lit.sha });
    sh('git clean -fdq', sw);
    // nothing to stash; --staged with nothing staged
    assert.deepEqual(await stash('all'), { stashed: false });
    fs.writeFileSync(W('README.md'), 'unstaged only\n');
    assert.deepEqual(await stash('staged'), { stashed: false });
    sh('git reset -q --hard', sw);
    await assert.rejects(stash('bogus'), /mode/i);
    await assert.rejects(stash('files', { files: [] }), /files/i);

    // drop by sha removes exactly that stash, even when it is not stash@{0}
    st = await list();
    const [top, mid, last] = st;
    await c.call('git.stashDrop', { root: sw, sha: mid.sha });
    assert.deepEqual((await list()).map(s => s.sha), [top.sha, last.sha]);
    // a sha no longer in the list is refused and nothing changes
    for (const call of [
      () => c.call('git.stashDrop', { root: sw, sha: mid.sha }),
      () => c.call('git.stashApply', { root: sw, sha: mid.sha, pop: true }),
    ]) {
      await assert.rejects(call(), /stash list changed/);
      assert.deepEqual((await list()).map(s => s.sha), [top.sha, last.sha]);
    }
    // clear refuses a stale list, then clears the current one
    await assert.rejects(c.call('git.stashClear', { root: sw, shas: [top.sha] }), /stash list changed/);
    assert.equal((await list()).length, 2);
    await c.call('git.stashClear', { root: sw, shas: [top.sha, last.sha] });
    assert.deepEqual(await list(), []);

    // pop with a conflict keeps the stash
    fs.writeFileSync(W('README.md'), 'line1\nstashed side\n');
    await stash('all');
    fs.writeFileSync(W('README.md'), 'line1\ncommitted side\n');
    sh('git commit -qam other', sw);
    const [kept] = await list();
    const res = await c.call('git.stashApply', { root: sw, sha: kept.sha, pop: true });
    assert.equal(res.conflicts, true);
    assert.match(res.output, /CONFLICT/);
    assert.deepEqual((await list()).map(s => s.sha), [kept.sha], 'a conflicted pop keeps the stash');
    sh('git reset -q --hard && git clean -fdq', sw);
    await c.call('git.stashDrop', { root: sw, sha: kept.sha });
    assert.deepEqual(await list(), []);

    // a sha that is really an option is refused everywhere
    const bad = '--output=x';
    for (const [m, extra] of [['git.stashFiles', {}], ['git.stashApply', {}], ['git.stashApply', { pop: true }], ['git.stashDrop', {}]]) {
      await assert.rejects(c.call(m, { root: sw, sha: bad, ...extra }), /Not a valid stash/, m);
    }
    await assert.rejects(c.call('git.stashClear', { root: sw, shas: [bad] }), /Not a valid stash/);
    await assert.rejects(c.call('git.stashClear', { root: sw, shas: [] }), /Not a valid stash list/);
    assert.ok(!fs.existsSync(W('x')) && !fs.existsSync(path.join(sw, '--output=x')));

    await c.call('worktrees.remove', { repo, path: sw, deleteBranch: true, forceBranch: true });
  });

  await step('push / pull against a local remote', async () => {
    const remote = path.join(tmp, 'remote.git');
    sh(`git init -q --bare ${remote} && git remote add origin ${remote}`, repo);
    const out = await c.call('git.push', { root: wt });
    assert.ok(out);
    assert.equal(sh('git branch --format="%(refname:short)"', remote).trim(), 'feat/login');
    const s = await c.call('git.status', { root: wt });
    assert.equal(s.upstream, 'origin/feat/login');
    await c.call('git.pull', { root: wt });
    // a branch that only exists on the remote can be checked out as a tracking worktree
    sh(`git push -q origin feat/login:remote-only`, wt);
    sh('git fetch -q origin', repo);
    const br = await c.call('worktrees.branches', { repo });
    assert.ok(br.remoteOnly.includes('origin/remote-only'));
    const r2 = await c.call('worktrees.create', { repo, newBranch: 'remote-only', base: 'origin/remote-only', track: true, startClaude: false });
    assert.equal(sh('git rev-parse --abbrev-ref @{u}', r2.path).trim(), 'origin/remote-only');
    await c.call('worktrees.remove', { repo, path: r2.path, deleteBranch: true });
    // a new branch from a remote base does NOT track it (so push goes to its own branch)
    const r3 = await c.call('worktrees.create', { repo, newBranch: 'from-remote', base: 'origin/feat/login', startClaude: false });
    assert.equal(sh('git rev-parse --abbrev-ref @{u} 2>/dev/null || echo none', r3.path).trim(), 'none');
    await c.call('worktrees.remove', { repo, path: r3.path, deleteBranch: true });
  });

  await step('search: text (rg), quick-open file list, F12 by search (python, css)', async () => {
    const t = await c.call('search.text', { root: wt, query: 'greet' });
    assert.ok(t.results.some(r => r.file === 'src/app.py'));
    const files = await c.call('search.files', { root: wt });
    assert.ok(files.includes('src/site.css') && !files.some(f => f.startsWith('.git/')));
    const d1 = await c.call('search.definition', { root: wt, symbol: 'greet', lang: 'python', fromFile: 'src/app.py' });
    assert.equal(d1[0].file, 'src/app.py');
    assert.equal(d1[0].line, 1);
    const d2 = await c.call('search.definition', { root: wt, symbol: 'btn-primary', lang: 'css' });
    assert.equal(d2[0].file, 'src/site.css');
  });

  await step('past Claude conversations: listed from transcripts (any origin), resumed by pasted command, tracked once', async () => {
    const { encode } = require('../server/history');
    const proj = path.join(CLAUDE_HOME, 'projects', encode(wt));
    fs.mkdirSync(proj, { recursive: true });
    const A = '11111111-2222-4333-8444-555555555555', B = '66666666-7777-4888-9999-aaaaaaaaaaaa', C = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    const ts = '2026-10-01T12:00:00.000Z';
    const write = (id, rows, ageMin) => {
      const f = path.join(proj, `${id}.jsonl`);
      fs.writeFileSync(f, rows.map(r => JSON.stringify({ cwd: wt, sessionId: id, timestamp: ts, ...r })).join('\n') + '\n');
      const t = new Date(Date.now() - ageMin * 60e3);
      fs.utimesSync(f, t, t);
    };
    write(A, [
      { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
      { type: 'user', message: { role: 'user', content: 'Fix the login\nredirect bug' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'On it' }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
      { type: 'user', message: { role: 'user', content: 'also check logout' } },
      { type: 'custom-title', customTitle: 'login redirect' },
    ], 5);
    write(B, [{ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Add rate limiting' }] } }], 60);
    write(C, [{ type: 'user', isMeta: true, message: { role: 'user', content: 'meta only' } }], 1);
    // a conversation from another folder that happens to sit in this project folder is ignored
    write('dddddddd-cccc-4ddd-8eee-ffffffffffff', [{ type: 'user', cwd: '/elsewhere', message: { role: 'user', content: 'other' } }], 2);
    const list = await c.call('claude.history', { worktreePath: wt });
    assert.deepEqual(list.map(x => [x.id, x.title, x.first, x.prompts, x.session]), [[A, 'login redirect', 'Fix the login redirect bug', 2, null], [B, '', 'Add rate limiting', 1, null]]);
    await assert.rejects(c.call('sessions.adopt', { worktreePath: wt, conversation: 'hello' }), /Paste a conversation ID/);
    plan('SessionStart,hang');
    const before = calls().length;
    const s4 = await c.call('sessions.adopt', { worktreePath: wt, conversation: `  Resume this session with:\n  claude --resume ${A}\n` });
    assert.equal(s4.name, 'login redirect');
    await until(() => calls().length > before, 'claude launched');
    const args = calls().at(-1).args;
    assert.equal(args[args.indexOf('--resume') + 1], A, 'resumes that conversation');
    assert.ok(!args.includes('--session-id'));
    assert.equal((await c.call('claude.history', { worktreePath: wt }))[0].session, s4.id);
    const again = await c.call('sessions.adopt', { worktreePath: wt, conversation: A.toUpperCase() });
    assert.equal(again.id, s4.id, 'the same conversation is not opened twice');
    await c.call('sessions.forget', { id: s4.id });
  });

  await step('running commands: a shell running a command, and a Bash command Claude started, are flagged', async () => {
    const flag = async id => ((await c.call('hello')).sessions.find(x => x.id === id) || {}).command;
    plan('SessionStart,UserPromptSubmit,Stop,Bash:5,hang');
    const cl = await c.call('sessions.create', { kind: 'claude', worktreePath: wt, cols: 80, rows: 24 });
    await until(() => flag(cl.id), 'Claude command flagged', 8000);
    await until(async () => !(await flag(cl.id)), 'flag clears when the command ends', 10000);
    const shell = await c.call('sessions.create', { kind: 'shell', worktreePath: wt, cols: 80, rows: 24 });
    await c.call('term.open', { id: shell.id, cols: 80, rows: 24 });
    await sleep(500);
    assert.ok(!(await flag(shell.id)), 'an idle shell is not flagged');
    c.input(shell.id, 'sleep 5\r');
    await until(() => flag(shell.id), 'shell command flagged', 8000);
    c.input(shell.id, '\x03');
    await until(async () => !(await flag(shell.id)), 'shell flag clears', 8000);
    await c.call('sessions.forget', { id: cl.id });
    await c.call('sessions.forget', { id: shell.id });
  });

  await step('alert sounds: per-alert choice, your own uploads, volume; used when no window is open', async () => {
    const list = await c.call('sounds.list');
    assert.ok(['ding', 'chime', 'alert', 'marimba', 'harp'].every(n => list.builtin.includes(n)));
    assert.deepEqual(list.defaults, { question: 'ding', permission: 'alert', done: 'chime' });
    const wav = fs.readFileSync(path.join(APP, 'web', 'sounds', 'pop.wav')).toString('base64');
    await assert.rejects(c.call('sounds.upload', { name: 'evil.exe', data: wav }), /\.wav, \.mp3/);
    const up = await c.call('sounds.upload', { name: 'My Ding!.wav', data: wav });
    assert.match(up.id, /^custom:My-Ding-[0-9a-f]{6}\.wav$/);
    assert.deepEqual((await c.call('sounds.list')).custom.map(x => x.name), ['My-Ding.wav']);
    const r = await fetch(`http://127.0.0.1:${PORT}/custom-sounds/${up.id.slice(7)}`, { headers: { cookie: `skiffcode_tkn=${token}` } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'audio/wav');
    assert.equal((await fetch(`http://127.0.0.1:${PORT}/custom-sounds/..%2Fstate.json`, { headers: { cookie: `skiffcode_tkn=${token}` } })).status, 404);
    await c.call('settings.set', { values: { sounds: { question: up.id, permission: 'none', done: 'marimba' }, volume: 35 } });
    // no window open → the server plays your choice
    plan('SessionStart,sleep:300,UserPromptSubmit,sleep:300,PreToolUse:AskUserQuestion,hang');
    const s6 = await c.call('sessions.create', { kind: 'claude', worktreePath: wt, cols: 80, rows: 24 });
    c.close();
    await until(() => /is asking you a question/.test(fs.readFileSync(path.join(tmp, 'alerts.jsonl'), 'utf8').trim().split('\n').pop()), 'server-side question alert', 10_000);
    const al = JSON.parse(fs.readFileSync(path.join(tmp, 'alerts.jsonl'), 'utf8').trim().split('\n').pop());
    assert.equal(al.sound, up.id.slice(7));
    assert.equal(al.volume, 35);
    c = await new Client(PORT, token).connect();
    await c.call('hello');
    // removing a sound puts its alerts back on the default
    await c.call('sounds.remove', { id: up.id });
    assert.equal((await c.call('hello')).settings.sounds.question, 'ding');
    assert.deepEqual((await c.call('sounds.list')).custom, []);
    await c.call('sessions.forget', { id: s6.id });
    await c.call('settings.set', { values: { sounds: { question: 'ding', permission: 'alert', done: 'chime' }, volume: 70 } });
  });

  await step('Esc interrupt (no Stop hook): Claude stops spinning; busy output keeps it working; no "finished" alert', async () => {
    const stateOf = async id => ((await c.call('hello')).sessions.find(x => x.id === id) || {}).state;
    const alerts = () => (fs.existsSync(path.join(tmp, 'alerts.jsonl')) ? fs.readFileSync(path.join(tmp, 'alerts.jsonl'), 'utf8') : '');
    // "Interrupted" on screen, then quiet → idle quickly
    plan('SessionStart,UserPromptSubmit,Spin:1,Print:⎿  Interrupted · What should Claude do instead?,hang');
    const a = await c.call('sessions.create', { kind: 'claude', worktreePath: wt, cols: 80, rows: 24 });
    await until(async () => (await stateOf(a.id)) === 'working', 'working');
    const before = alerts();
    await until(async () => (await stateOf(a.id)) === 'idle', 'idle after the interrupt', 9000);
    assert.equal(alerts(), before, 'no "finished" alert for an interrupt');
    // the next prompt is noticed again (the status file was reset)
    assert.equal(JSON.parse(fs.readFileSync(path.join(HOME, 'status', `${a.id}.json`), 'utf8')).state, 'idle');
    await c.call('sessions.forget', { id: a.id });
    // a question that also needs permission: one alert, not two
    plan('SessionStart,UserPromptSubmit,sleep:200,PreToolUse:AskUserQuestion,sleep:300,Notification:permission_prompt,hang');
    const q = await c.call('sessions.create', { kind: 'claude', worktreePath: wt, cols: 80, rows: 24 });
    await until(async () => (await stateOf(q.id)) === 'question', 'asking');
    await sleep(900); // the permission notification for the same dialog arrives meanwhile
    assert.equal(await stateOf(q.id), 'question', 'still shown as a question, not permission');
    assert.equal(c.events.filter(e => e.event === 'alert' && e.data.sessionId === q.id).length, 1, 'one alert for one prompt');
    await c.call('sessions.forget', { id: q.id });
    // cancelling a permission prompt (Esc) also runs no hook: answering moves it on, then it settles
    plan('SessionStart,UserPromptSubmit,sleep:200,Notification:permission_prompt,hang');
    const p = await c.call('sessions.create', { kind: 'claude', worktreePath: wt, cols: 80, rows: 24 });
    await until(async () => (await stateOf(p.id)) === 'permission', 'waiting for permission');
    await c.call('term.open', { id: p.id, cols: 80, rows: 24 });
    c.input(p.id, '\x1b[B'); // arrow key: still choosing
    await sleep(600);
    assert.equal(await stateOf(p.id), 'permission');
    const before2 = alerts();
    c.input(p.id, '\x1b'); // Esc
    await until(async () => (await stateOf(p.id)) === 'working', 'answered → working', 3000);
    assert.equal((await c.call('hello')).sessions.find(x => x.id === p.id).unread, undefined, 'no longer waiting for you');
    await until(async () => (await stateOf(p.id)) === 'idle', 'settles to idle', 9000);
    assert.equal(alerts(), before2, 'no extra alert');
    await c.call('sessions.forget', { id: p.id });
    // a spinner that keeps redrawing stays "working"; silence afterwards → idle
    plan('SessionStart,UserPromptSubmit,Spin:6,hang');
    const b = await c.call('sessions.create', { kind: 'claude', worktreePath: wt, cols: 80, rows: 24 });
    await until(async () => (await stateOf(b.id)) === 'working', 'working');
    // sample across more than the stall window (2.5 s): output keeps it working throughout
    for (const end = Date.now() + 4500; Date.now() < end; await sleep(150)) assert.equal(await stateOf(b.id), 'working', 'still working while output flows');
    await until(async () => (await stateOf(b.id)) === 'idle', 'idle after going quiet', 12000);
    await c.call('sessions.forget', { id: b.id });
  });

  await step('a question with two parts stays a question after the first answer', async () => {
    const stateOf = async id => ((await c.call('hello')).sessions.find(x => x.id === id) || {}).state;
    plan('SessionStart,Input,UserPromptSubmit,PreToolUse:AskUserQuestion,WaitKey,WaitKey,PostToolUse:AskUserQuestion,Stop,hang');
    const q = await c.call('sessions.create', { kind: 'claude', worktreePath: wt, cols: 80, rows: 24 });
    await until(async () => (await stateOf(q.id)) === 'question', 'asking');
    await c.call('term.open', { id: q.id, cols: 80, rows: 24 });
    c.input(q.id, '1');
    await sleep(700);
    assert.equal(await stateOf(q.id), 'question', 'the second part is still open');
    c.input(q.id, '\r');
    await until(async () => (await stateOf(q.id)) === 'idle', 'answered in full', 5000);
    await c.call('sessions.forget', { id: q.id });
  });

  await step('only Claude’s own “⎿ Interrupted” line counts as an interrupt', async () => {
    const stateOf = async id => ((await c.call('hello')).sessions.find(x => x.id === id) || {}).state;
    plan('SessionStart,UserPromptSubmit,Bash:8,Spin:1,Print:2 tests Interrupted by signal,hang');
    const s = await c.call('sessions.create', { kind: 'claude', worktreePath: wt, cols: 80, rows: 24 });
    await until(async () => (await stateOf(s.id)) === 'working', 'working');
    await sleep(5500);
    assert.equal(await stateOf(s.id), 'working', 'program output that says “Interrupted” is not an interrupt');
    await c.call('sessions.forget', { id: s.id });
  });

  await step('names sync with Claude: a SkiffCode rename reaches Claude on the next prompt; /rename in Claude comes back', async () => {
    const hookout = () => (fs.existsSync(process.env.FAKE_LOG + '.hookout') ? fs.readFileSync(process.env.FAKE_LOG + '.hookout', 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
    plan('SessionStart,Status:10:20:first,sleep:1500,UserPromptSubmit,Status:10:20:renamed here,sleep:800,Status:10:20:named in Claude,hang');
    const s7 = await c.call('sessions.create', { kind: 'claude', worktreePath: wt, name: 'first', cols: 80, rows: 24 });
    // past SessionStart, which would take a waiting title itself
    await until(async () => (await c.call('hello')).sessions.find(x => x.id === s7.id).state === 'idle', 'Claude started');
    // something was typed since Claude went idle: the name waits for the next prompt
    await c.call('term.open', { id: s7.id, cols: 80, rows: 24 });
    c.input(s7.id, 'x');
    await sleep(100);
    await c.call('sessions.rename', { id: s7.id, name: 'renamed here' });
    assert.equal(JSON.parse(fs.readFileSync(path.join(HOME, 'status', `${s7.id}.title`), 'utf8')), 'renamed here');
    // Claude's next prompt gets the title from the hook (no keystrokes typed for you)
    const got = await until(() => hookout().find(h => h.session === s7.id && h.event === 'UserPromptSubmit'), 'title handed to Claude', 8000);
    assert.deepEqual(JSON.parse(got.out), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', sessionTitle: 'renamed here' } });
    assert.ok(!fs.existsSync(path.join(HOME, 'status', `${s7.id}.title`)), 'handed over once');
    // then you /rename in Claude: the status line reports it and SkiffCode follows
    await until(async () => (await c.call('hello')).sessions.find(x => x.id === s7.id).name === 'named in Claude', 'Claude rename synced', 8000);
    await c.call('sessions.forget', { id: s7.id });
  });

  await step('a rename while Claude is idle and untouched is typed as /rename at once', async () => {
    const typed = id => (fs.existsSync(process.env.FAKE_LOG + '.input') ? fs.readFileSync(process.env.FAKE_LOG + '.input', 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []).filter(x => x.session === id).map(x => x.data).join('');
    plan('SessionStart,Input,hang');
    const s = await c.call('sessions.create', { kind: 'claude', worktreePath: wt, name: 'old name', cols: 80, rows: 24 });
    await until(async () => (await c.call('hello')).sessions.find(x => x.id === s.id).state === 'idle', 'idle');
    await sleep(300);
    await c.call('sessions.rename', { id: s.id, name: 'new\x07 name\n' });
    await until(() => typed(s.id) === '/rename new name\r', 'typed into Claude, without control characters');
    assert.ok(!fs.existsSync(path.join(HOME, 'status', `${s.id}.title`)), 'nothing left for the next prompt');
    await c.call('sessions.forget', { id: s.id });
  });

  await step('subagents: the agent a tool result names is the one that stops; Claude\'s list of running ones ends the rest', async () => {
    const { applyAgentEvent } = require(path.join(APP, 'server', 'sessions.js'));
    const run = events => { const list = []; events.forEach((ev, i) => applyAgentEvent(list, ev, i)); return Object.fromEntries(list.map(x => [x.toolUseId, x.state])); };
    const pre = (id, desc) => ({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: id, tool_input: { subagent_type: 'general-purpose', description: desc } });
    const launched = (id, agentId) => ({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: id, tool_response: { isAsync: true, status: 'async_launched', agentId } });
    const cases = [
      // an older call that never started must not take the new agent's start and stop
      ['paired by the tool result', [pre('old', 'stale'), pre('new', 'critic'), { hook_event_name: 'SubagentStart', agent_id: 'ag1', agent_type: 'general-purpose' }, launched('new', 'ag1'), { hook_event_name: 'SubagentStop', agent_id: 'ag1' }], { old: 'running', new: 'done' }],
      // stopped without its own SubagentStop: another agent's stop lists what still runs
      ['ended by the running list', [pre('a', 'one'), launched('a', 'agA'), pre('b', 'two'), launched('b', 'agB'), { hook_event_name: 'SubagentStop', agent_id: 'agX', background_tasks: [{ id: 'agB', type: 'subagent', status: 'running' }, { id: 'sh1', type: 'shell', status: 'running' }] }], { a: 'done', b: 'running' }],
    ];
    for (const [name, events, want] of cases) assert.deepEqual(run(events), want, name);
  });

  await step('subagents: listed per session with type + description; finished / stopped tracked; memory readout', async () => {
    plan('SessionStart,UserPromptSubmit,Agent:Explore:Find auth code,AgentBg:general-purpose:Run the tests,AgentAsync:security-reviewer:Review auth,sleep:800,AgentDone:1,Stop,hang');
    const s3 = await c.call('sessions.create', { kind: 'claude', worktreePath: wt, cols: 80, rows: 24 });
    const agentsOf = async () => ((await c.call('hello')).sessions.find(x => x.id === s3.id) || {}).agents || [];
    const all = await until(async () => { const a = await agentsOf(); return a.length === 3 && a.every(x => x.state === 'running') && a[2].background && a; }, 'three running subagents, the last moved to the background');
    assert.deepEqual(all.map(a => [a.type, a.description, !!a.background]), [['Explore', 'Find auth code', false], ['general-purpose', 'Run the tests', true], ['security-reviewer', 'Review auth', true]]);
    const after = await until(async () => { const a = await agentsOf(); return a[0] && a[0].state === 'done' && a; }, 'first subagent done');
    assert.deepEqual(after.slice(1).map(a => a.state), ['running', 'running'], 'background subagents (asked for, or moved there by Claude) keep running after Claude stops');
    assert.ok(after[0].endedAt >= after[0].startedAt, `ended ${after[0].endedAt}, started ${after[0].startedAt}`);
    const mem = await c.call('system.memory');
    assert.ok(mem.server > 10e6 && mem.sessions[s3.id] > 1e6, 'memory of the server and the session');
    await c.call('sessions.stop', { id: s3.id });
    await until(async () => (await agentsOf()).slice(1).every(a => a.state === 'stopped'), 'background subagents stopped with the session');
    await c.call('sessions.forget', { id: s3.id });
    assert.ok(!fs.existsSync(path.join(HOME, 'status', `${s3.id}.agents`)));
  });

  await step('subagent hook: parallel events with long lines are written whole', async () => {
    const dir = path.join(tmp, 'hookdir');
    fs.mkdirSync(dir);
    const env = { ...process.env, SKIFFCODE_SESSION_ID: 'par', SKIFFCODE_STATUS_DIR: dir };
    for (let round = 0; round < 5; round++) {
      await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((res, rej) => {
        const p = spawn('sh', [path.join(APP, 'server', 'hook.sh'), 'agent'], { env, stdio: ['pipe', 'ignore', 'inherit'] });
        p.on('exit', res);
        p.on('error', rej);
        p.stdin.end(JSON.stringify({ hook_event_name: 'SubagentStart', agent_id: `r${round}-${i}`, pad: String(i).repeat(30000) }));
      })));
    }
    const lines = fs.readFileSync(path.join(dir, 'par.agents'), 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 40);
    for (const l of lines) assert.match(JSON.parse(l.slice(l.indexOf('\t') + 1)).agent_id, /^r\d-\d$/);
  });

  /** Add account through its sign-in tab (the fake `claude auth login` signs in as `who`); resolves once the login is saved. */
  const addAccount = async (name, who) => {
    fs.writeFileSync(`${process.env.FAKE_SCRIPT_FILE}.login`, who);
    const session = await c.call('accounts.add', { name, worktreePath: wt });
    assert.equal(session.kind, 'shell');
    assert.equal(session.name, `sign in · ${name}`);
    const m = /^CLAUDE_CONFIG_DIR=(\S+) (.+) auth login$/.exec(session.command);
    assert.ok(m, session.command);
    assert.equal(path.dirname(m[1]), path.join(HOME, 'accounts'));
    assert.match(path.basename(m[1]), /^\.login-[0-9a-f-]{36}$/);
    await until(() => !fs.existsSync(m[1]), 'sign-in folder saved and removed', 10000);
    await c.call('sessions.forget', { id: session.id });
    return { session };
  };

  await switchingStep('accounts: Add account signs in from a private folder and saves the login; the same login again updates it', async () => {
    fs.writeFileSync(SHARED_CRED, JSON.stringify(login('x')), { mode: 0o600 });
    fs.writeFileSync(SHARED_GLOBAL, JSON.stringify({ numStartups: 5, oauthAccount: oauthOf('x') }));
    fs.chmodSync(SHARED_GLOBAL, 0o644);
    const sharedBefore = [fs.readFileSync(SHARED_CRED, 'utf8'), fs.readFileSync(SHARED_GLOBAL, 'utf8')];
    let h = await c.call('hello');
    assert.deepEqual(h.accounts, []);
    assert.equal(h.activeAccount, undefined);
    assert.deepEqual(h.currentLogin, { email: 'x@example.test', org: 'Org x', plan: 'pro', saved: false, expired: false });
    await addAccount('Client A', 'alpha');
    h = await c.call('hello');
    assert.equal(h.accounts.length, 1);
    const A = h.accounts[0];
    assert.match(A.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.deepEqual({ ...A, id: undefined }, { id: undefined, name: 'Client A', email: 'alpha@example.test', org: 'Org alpha', plan: 'max', inUse: false });
    assert.equal(c.last('toast')?.data.text, 'Saved Client A');
    assert.equal(fmode(slot(A.id)), 0o700);
    for (const f of ['credentials.json', 'account.json']) assert.equal(fmode(path.join(slot(A.id), f)), 0o600, f);
    assert.deepEqual(readJ(path.join(slot(A.id), 'account.json')), oauthOf('alpha'));
    assert.match(readJ(path.join(slot(A.id), 'credentials.json')).claudeAiOauth.refreshToken, /^rt-alpha-/);
    assert.deepEqual([fs.readFileSync(SHARED_CRED, 'utf8'), fs.readFileSync(SHARED_GLOBAL, 'utf8')], sharedBefore, 'the login in use is untouched');
    const firstToken = readJ(path.join(slot(A.id), 'credentials.json')).claudeAiOauth.accessToken;
    await sleep(5);
    await addAccount('Alpha again', 'alpha');
    h = await c.call('hello');
    assert.deepEqual(h.accounts.map(a => a.name), ['Client A'], 'the same login updates its account');
    assert.notEqual(readJ(path.join(slot(A.id), 'credentials.json')).claudeAiOauth.accessToken, firstToken);
    assert.equal(readJ(backupsIn(slot(A.id)).at(-1)).claudeAiOauth.accessToken, firstToken, 'the previous one is kept');
    await addAccount('Client B', 'beta');
    assert.deepEqual((await c.call('hello')).accounts.map(a => a.name), ['Client A', 'Client B']);
  });

  await switchingStep('accounts: a switch saves the login in use first, then swaps the shared files under Claude’s lock', async () => {
    const sharedX = readJ(SHARED_CRED);
    let h = await c.call('hello');
    const [A, B] = h.accounts.map(a => a.id);
    await c.call('accounts.use', { id: A });
    h = await c.call('hello');
    const X = h.accounts.find(a => a.email === 'x@example.test');
    assert.ok(X, 'the unsaved login in use was saved first');
    assert.equal(X.name, 'Org x');
    assert.deepEqual(readJ(path.join(slot(X.id), 'credentials.json')), sharedX);
    assert.deepEqual(h.accounts.filter(a => a.inUse).map(a => a.id), [A]);
    assert.deepEqual(h.currentLogin, { email: 'alpha@example.test', org: 'Org alpha', plan: 'max', saved: true, expired: false });
    assert.equal(fs.readFileSync(SHARED_CRED, 'utf8'), fs.readFileSync(path.join(slot(A), 'credentials.json'), 'utf8'));
    assert.equal(fmode(SHARED_CRED), 0o600);
    const g = readJ(SHARED_GLOBAL);
    assert.equal(g.numStartups, 5, 'other keys kept');
    assert.deepEqual(g.oauthAccount, oauthOf('alpha'));
    assert.equal(fmode(SHARED_GLOBAL), 0o644, 'its mode kept');
    assert.ok(!fs.existsSync(`${SHARED_GLOBAL}.lock`), 'the lock is released');
    // Claude refreshes A's token; switching away saves the fresh one, the old one is kept aside
    const oldA = readJ(path.join(slot(A), 'credentials.json'));
    const refreshed = login('alpha-2');
    fs.writeFileSync(SHARED_CRED, JSON.stringify(refreshed));
    await c.call('accounts.use', { id: X.id });
    assert.deepEqual(readJ(path.join(slot(A), 'credentials.json')), refreshed);
    assert.deepEqual(readJ(backupsIn(slot(A)).at(-1)), oldA);
    assert.deepEqual(readJ(SHARED_CRED), sharedX);
    assert.deepEqual(readJ(SHARED_GLOBAL).oauthAccount, oauthOf('x'));
    // the tokens SkiffCode wrote last belong to that account, whatever oauthAccount says
    await c.call('accounts.use', { id: A });
    fs.writeFileSync(SHARED_GLOBAL, JSON.stringify({ ...readJ(SHARED_GLOBAL), oauthAccount: oauthOf('beta') }));
    const bBefore = [fs.readFileSync(path.join(slot(B), 'credentials.json'), 'utf8'), fs.readFileSync(path.join(slot(B), 'account.json'), 'utf8')];
    assert.equal((await c.call('hello')).accounts.find(a => a.inUse).id, A);
    await c.call('accounts.use', { id: X.id });
    assert.deepEqual([fs.readFileSync(path.join(slot(B), 'credentials.json'), 'utf8'), fs.readFileSync(path.join(slot(B), 'account.json'), 'utf8')], bBefore, 'B is untouched');
    assert.deepEqual(readJ(path.join(slot(A), 'credentials.json')), refreshed);
    assert.deepEqual(readJ(path.join(slot(A), 'account.json')), oauthOf('alpha'), 'A keeps its identity');
  });

  await switchingStep('accounts: refused switches change nothing; a broken shared file is never saved over a login', async () => {
    const h = await c.call('hello');
    const ids = h.accounts.map(a => a.id);
    const [A, B] = ids;
    const credB = path.join(slot(B), 'credentials.json');
    const files = () => ({
      shared: [SHARED_CRED, SHARED_GLOBAL].map(f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null)),
      saved: ids.map(id => { try { return fs.readFileSync(path.join(slot(id), 'credentials.json'), 'utf8'); } catch { return null; } }),
    });
    const cases = [
      { name: 'unknown id', id: crypto.randomUUID(), err: /Unknown account/ },
      { name: 'not an id', id: '../accounts', err: /Unknown account/ },
      { name: 'no account details', id: B, setup: () => fs.renameSync(path.join(slot(B), 'account.json'), path.join(slot(B), 'account.bak')), undo: () => fs.renameSync(path.join(slot(B), 'account.bak'), path.join(slot(B), 'account.json')), err: /That saved login has no account details\. Add it again\./ },
      { name: 'no saved login', id: B, setup: () => fs.renameSync(credB, `${credB}.bak`), undo: () => fs.renameSync(`${credB}.bak`, credB), err: /Add it again/ },
      { name: 'expired refresh token', id: B, setup: () => { const j = readJ(credB); j.claudeAiOauth.refreshTokenExpiresAt = Date.now() - 1000; fs.writeFileSync(`${credB}.keep`, fs.readFileSync(credB)); fs.writeFileSync(credB, JSON.stringify(j)); }, undo: () => fs.renameSync(`${credB}.keep`, credB), err: /That saved login has expired\. Add it again\./ },
      { name: 'Claude holds its lock', id: B, setup: () => fs.mkdirSync(`${SHARED_GLOBAL}.lock`), undo: () => fs.rmdirSync(`${SHARED_GLOBAL}.lock`), err: /busy/ },
      { name: 'shared credentials missing', id: B, setup: () => fs.rmSync(SHARED_CRED), wrote: B },
      { name: 'shared credentials unreadable', id: A, setup: () => fs.writeFileSync(SHARED_CRED, 'not json{'), wrote: A },
      { name: 'stale lock', id: B, setup: () => { fs.mkdirSync(`${SHARED_GLOBAL}.lock`); const t = new Date(Date.now() - 20e3); fs.utimesSync(`${SHARED_GLOBAL}.lock`, t, t); }, wrote: B },
    ];
    for (const t of cases) {
      if (t.setup) t.setup();
      const before = files();
      try {
        if (t.err) {
          await assert.rejects(c.call('accounts.use', { id: t.id }), t.err, t.name);
          assert.deepEqual(files(), before, `${t.name}: nothing written`);
        } else {
          await c.call('accounts.use', { id: t.id });
          assert.deepEqual(files().saved, before.saved, `${t.name}: no saved login overwritten`);
          assert.equal(fs.readFileSync(SHARED_CRED, 'utf8'), fs.readFileSync(path.join(slot(t.wrote), 'credentials.json'), 'utf8'), t.name);
          assert.deepEqual(fs.readdirSync(CLAUDE_HOME).filter(n => n.includes('.lock')), [], `${t.name}: no lock left, nor a claimed stale one`);
        }
      } finally {
        if (t.undo) t.undo();
      }
    }
    // .claude.json that isn't JSON: left alone; the credentials still switch
    fs.writeFileSync(SHARED_GLOBAL, 'garbage{');
    await c.call('accounts.use', { id: A });
    assert.equal(fs.readFileSync(SHARED_GLOBAL, 'utf8'), 'garbage{');
    assert.equal(fs.readFileSync(SHARED_CRED, 'utf8'), fs.readFileSync(path.join(slot(A), 'credentials.json'), 'utf8'));
    fs.writeFileSync(SHARED_GLOBAL, JSON.stringify({ numStartups: 5, oauthAccount: oauthOf('alpha') }));
  });

  await switchingStep('accounts: a refreshed login is saved into its own account; the shared file keeps its other keys', async () => {
    const h = await c.call('hello');
    const A = h.accounts.find(a => a.name === 'Client A').id;
    const B = h.accounts.find(a => a.name === 'Client B').id;
    const mcp = { 'srv|1': { accessToken: 'mcp-at' } };
    const sharedOauth = () => readJ(SHARED_CRED).claudeAiOauth;
    const refresh = who => fs.writeFileSync(SHARED_CRED, JSON.stringify({ ...readJ(SHARED_CRED), claudeAiOauth: login(who).claudeAiOauth }));
    fs.writeFileSync(SHARED_CRED, JSON.stringify({ ...readJ(SHARED_CRED), mcpOAuth: mcp }));
    await c.call('accounts.use', { id: B });
    assert.deepEqual(readJ(SHARED_CRED).mcpOAuth, mcp, 'other keys kept through a switch');
    assert.deepEqual(sharedOauth(), readJ(path.join(slot(B), 'credentials.json')).claudeAiOauth);
    for (const id of [A, B]) assert.deepEqual(Object.keys(readJ(path.join(slot(id), 'credentials.json'))), ['claudeAiOauth'], 'a saved login holds only claudeAiOauth');
    // Claude refreshes B's tokens; oauthAccount still says B
    refresh('beta-r1');
    await c.call('accounts.use', { id: B });
    assert.equal(sharedOauth().refreshToken, 'rt-beta-r1', 'switching to the login in use keeps its newest token');
    assert.equal(readJ(path.join(slot(B), 'credentials.json')).claudeAiOauth.refreshToken, 'rt-beta-r1');
    refresh('beta-r2');
    await c.call('accounts.use', { id: A });
    assert.equal(readJ(path.join(slot(B), 'credentials.json')).claudeAiOauth.refreshToken, 'rt-beta-r2', 'the refreshed tokens are saved into B');
    assert.deepEqual(readJ(SHARED_CRED).mcpOAuth, mcp);
    assert.deepEqual(readJ(SHARED_GLOBAL).oauthAccount, oauthOf('alpha'));
  });

  await step('accounts: last-switch.json names the new login before .claude.json is written; five backups per login', async () => {
    const { Accounts } = require('../server/accounts');
    const h = path.join(tmp, 'h-acc');
    const cfg = path.join(tmp, 'claude-acc');
    fs.mkdirSync(path.join(h, 'accounts'), { recursive: true });
    fs.mkdirSync(cfg);
    const data = { prefs: {}, sessions: [] };
    const st = { data, get prefs() { return data.prefs; }, get sessions() { return data.sessions; }, update(fn) { fn(data); } };
    const envDir = process.env.CLAUDE_CONFIG_DIR;
    const rename = fs.renameSync;
    process.env.CLAUDE_CONFIG_DIR = cfg;
    try {
      const acc = new Accounts(st, h, { platform: 'linux' });
      for (const [saves, kept] of [[3, 3], [7, 5]]) {
        const base = login(`bk${saves}`).claudeAiOauth;
        const { id } = acc.saveLogin(base, oauthOf(`bk${saves}`));
        for (let i = 1; i <= saves; i++) acc.saveLogin({ ...base, accessToken: `at-${i}` }, undefined, { id });
        acc.saveLogin({ ...base, accessToken: `at-${saves}` }, undefined, { id });
        const files = backupsIn(path.join(h, 'accounts', id));
        // backup i holds the token before save i; the oldest beyond five are dropped
        const want = [base.accessToken, ...Array.from({ length: saves - 1 }, (_, i) => `at-${i + 1}`)].slice(-kept);
        assert.deepEqual(files.map(f => readJ(f).claudeAiOauth.accessToken), want, `${saves} saves`);
        for (const f of files) assert.equal(fmode(f), 0o600);
      }
      acc.saveLogin(login('p').claudeAiOauth, oauthOf('p'));
      const Q = acc.saveLogin(login('q').claudeAiOauth, oauthOf('q')).id;
      fs.writeFileSync(path.join(cfg, '.credentials.json'), JSON.stringify(login('p')));
      fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({ oauthAccount: oauthOf('p') }));
      fs.renameSync = (from, to) => {
        if (to === path.join(cfg, '.claude.json')) throw Object.assign(new Error('EACCES: test'), { code: 'EACCES' });
        return rename(from, to);
      };
      await assert.rejects(acc.use(Q), /EACCES/);
      fs.renameSync = rename;
      assert.deepEqual(readJ(path.join(h, 'accounts', 'last-switch.json')), { id: Q, sha: crypto.createHash('sha256').update('rt-q').digest('hex'), identity: 'acct-q/org-q' });
      assert.equal(readJ(path.join(cfg, '.credentials.json')).claudeAiOauth.refreshToken, 'rt-q');
      assert.deepEqual(readJ(path.join(cfg, '.claude.json')).oauthAccount, oauthOf('p'), 'the failed write changed nothing');
      assert.deepEqual(fs.readdirSync(cfg).sort(), ['.claude.json', '.credentials.json'], 'no temp file or lock left');
    } finally {
      fs.renameSync = rename;
      if (envDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = envDir;
    }
  });

  await step('accounts on macOS: the login shows from .claude.json; use, sign-in and save are refused and write nothing', async () => {
    assert.equal((await c.call('hello')).platform, process.platform);
    const { Accounts } = require('../server/accounts');
    const h = path.join(tmp, 'h-mac');
    const cfg = path.join(tmp, 'claude-mac');
    fs.mkdirSync(path.join(h, 'accounts'), { recursive: true });
    fs.mkdirSync(cfg);
    const data = { prefs: {}, sessions: [] };
    const st = { data, get prefs() { return data.prefs; }, get sessions() { return data.sessions; }, update(fn) { fn(data); } };
    const envDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cfg;
    const refused = { message: 'Switching Claude accounts isn’t available on macOS yet.' };
    const files = dir => fs.readdirSync(dir).sort().map(n => [n, fs.statSync(path.join(dir, n)).isFile() ? fs.readFileSync(path.join(dir, n), 'utf8') : 'dir']);
    try {
      for (const t of [
        { name: 'signed in', global: { numStartups: 1, oauthAccount: oauthOf('mac') }, want: { email: 'mac@example.test', org: 'Org mac', plan: undefined, saved: false, expired: false } },
        { name: 'no oauthAccount', global: { numStartups: 1 }, want: null },
        { name: 'no .claude.json', want: null },
      ]) {
        if (t.global) fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify(t.global));
        else fs.rmSync(path.join(cfg, '.claude.json'), { force: true });
        const acc = new Accounts(st, h, { platform: 'darwin' });
        const saved = acc.saveLogin(login('saved').claudeAiOauth, oauthOf('saved')).id;
        assert.deepEqual(acc.currentLogin(), t.want, t.name);
        assert.equal(acc.list().find(a => a.id === saved).inUse, false, `${t.name}: no saved login is in use`);
        const before = [files(cfg), files(path.join(h, 'accounts'))];
        assert.throws(() => acc.startSignIn('Work'), refused, `${t.name}: sign-in`);
        assert.throws(() => acc.saveCurrent('Work'), refused, `${t.name}: save`);
        await assert.rejects(acc.use(saved), refused, `${t.name}: use`);
        assert.deepEqual([files(cfg), files(path.join(h, 'accounts'))], before, `${t.name}: nothing written`);
        acc.recordUsage({ five_hour: { used_percentage: 12, resets_at: Date.now() / 1000 + 600 } });
        assert.equal(acc.usage.current.fiveHour.used, 12, `${t.name}: usage under "current"`);
      }
    } finally {
      if (envDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = envDir;
    }
  });

  await step('fake claude: auth without CLAUDE_CONFIG_DIR fails and writes nothing', async () => {
    const home = path.join(tmp, 'fake-home');
    fs.mkdirSync(home);
    const env = { ...process.env, HOME: home };
    delete env.CLAUDE_CONFIG_DIR;
    const r = spawnSync('node', [path.join(__dirname, 'fake-claude.js'), 'auth', 'login'], { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /CLAUDE_CONFIG_DIR/);
    assert.deepEqual(fs.readdirSync(home), []);
  });

  await step('accounts: remove deletes only that saved login', async () => {
    await assert.rejects(c.call('accounts.remove', { id: '../accounts' }), /Unknown account/);
    if (MAC) return skipped('removing logins saved by sign-in');
    const h = await c.call('hello');
    const X = h.accounts.find(a => a.email === 'x@example.test');
    const shared = [fs.readFileSync(SHARED_CRED, 'utf8'), fs.readFileSync(SHARED_GLOBAL, 'utf8')];
    await c.call('accounts.remove', { id: X.id });
    assert.ok(!fs.existsSync(slot(X.id)));
    const rest = (await c.call('hello')).accounts;
    assert.deepEqual(rest.map(a => a.name), ['Client A', 'Client B']);
    for (const a of rest) assert.ok(fs.existsSync(path.join(slot(a.id), 'credentials.json')), a.name);
    assert.deepEqual([fs.readFileSync(SHARED_CRED, 'utf8'), fs.readFileSync(SHARED_GLOBAL, 'utf8')], shared, 'the shared folder is untouched');
  });

  await step('accounts: usage refresh reads Anthropic’s usage endpoint with the saved token, never refreshing it', async () => {
    const { usageUrl } = require('../server/accounts');
    const REAL = 'https://api.anthropic.com/api/oauth/usage';
    for (const [v, want] of [
      [undefined, REAL], ['http://127.0.0.1:9/usage', 'http://127.0.0.1:9/usage'], ['http://localhost:9/u', 'http://localhost:9/u'], ['http://[::1]:9/u', 'http://[::1]:9/u'],
      ['https://evil.example/usage', REAL], ['http://10.0.0.1/usage', REAL], ['file:///etc/passwd', REAL], ['http://127.0.0.1@evil.example/', REAL], ['https://127.0.0.1/u', REAL],
    ]) assert.equal(usageUrl({ SKIFFCODE_USAGE_URL: v }), want, String(v));
    if (MAC) return skipped('usage refresh for logins saved by sign-in');
    const h = await c.call('hello');
    const A = h.accounts.find(a => a.inUse).id;
    const B = h.accounts.find(a => !a.inUse).id;
    const credB = path.join(slot(B), 'credentials.json');
    usageReqs.length = 0;
    await c.call('accounts.refreshUsage', { id: B });
    assert.equal(usageReqs.length, 1);
    assert.equal(usageReqs[0].headers.authorization, `Bearer ${readJ(credB).claudeAiOauth.accessToken}`);
    assert.equal(usageReqs[0].headers['anthropic-beta'], 'oauth-2025-04-20');
    const u = await until(() => c.last('usage')?.data[B], 'usage event');
    assert.equal(u.fiveHour.used, 69);
    assert.equal(u.weekly.used, 20);
    assert.ok(Math.abs(u.fiveHour.resetsAt - (Date.now() + 3600e3)) < 60e3);
    assert.equal(readJ(path.join(HOME, 'usage.json'))[B].weekly.used, 20);
    // the account in use: the shared token, the freshest one
    const cur = readJ(SHARED_CRED);
    cur.claudeAiOauth.accessToken = 'at-fresh';
    fs.writeFileSync(SHARED_CRED, JSON.stringify(cur));
    await c.call('accounts.refreshUsage', { id: A });
    assert.equal(usageReqs.at(-1).headers.authorization, 'Bearer at-fresh');
    // an expired token: refused, nothing sent
    const keep = fs.readFileSync(credB);
    const j = readJ(credB);
    j.claudeAiOauth.expiresAt = Date.now() - 1000;
    fs.writeFileSync(credB, JSON.stringify(j));
    const n = usageReqs.length;
    await assert.rejects(c.call('accounts.refreshUsage', { id: B }), /The sign-in token has expired\. Use this account in a session to refresh it\./);
    assert.equal(usageReqs.length, n, 'no request');
    fs.writeFileSync(credB, keep);
    // an error never carries the token
    usageStatus = 401;
    try {
      await assert.rejects(c.call('accounts.refreshUsage', { id: B }), e => e.message === 'Couldn’t read usage (HTTP 401).' && !e.message.includes(j.claudeAiOauth.accessToken));
    } finally {
      usageStatus = 200;
    }
    assert.equal(fs.readFileSync(credB, 'utf8'), keep.toString(), 'the saved token is never written');
  });

  await step('accounts: sessions run on the shared folder and report usage for the account in use', async () => {
    // On macOS no saved login is in use, so usage is the current login's
    const A = MAC ? 'current' : (await c.call('hello')).accounts.find(a => a.inUse).id;
    plan('SessionStart,UserPromptSubmit,Status:42.4:17,Stop,hang');
    const before = calls().length;
    const s2 = await c.call('sessions.create', { kind: 'claude', worktreePath: wt, cols: 80, rows: 24 });
    await until(() => calls().length > before, 'claude launched');
    const call2 = calls().at(-1);
    assert.equal(call2.configDir, CLAUDE_HOME, 'the shared config folder');
    assert.equal(call2.userStatusLine, 'echo user-line', "user's own status line still runs");
    const { claudeBin } = require('../server/accounts');
    assert.equal(claudeBin('claude --dangerously-skip-permissions'), 'claude');
    assert.equal(claudeBin('node /x/claude.js --flag'), 'node /x/claude.js');
    const u = await until(() => c.last('usage')?.data[A]?.fiveHour?.used === 42.4 && c.last('usage').data[A], 'usage event');
    assert.equal(u.weekly.used, 17);
    await until(() => /user-line/.test(fs.readFileSync(process.env.FAKE_LOG + '.status', 'utf8')), 'user status line output');
    const snap = await until(async () => (await c.call('hello')).sessions.find(x => x.id === s2.id && x.model), 'model info');
    assert.equal(snap.model, 'Opus');
    assert.equal(snap.account, undefined);
    await c.call('sessions.forget', { id: s2.id });
    assert.equal(calls()[0].configDir, CLAUDE_HOME, 'your CLAUDE_CONFIG_DIR is kept');
  });

  await switchingStep('Add account runs a Claude command whose path has spaces', async () => {
    const dir = path.join(tmp, 'my tools');
    fs.mkdirSync(dir);
    fs.symlinkSync(path.join(__dirname, 'fake-claude.js'), path.join(dir, 'claude'));
    await c.call('settings.set', { values: { claudeCommand: path.join(dir, 'claude') } });
    try {
      const { session } = await addAccount('Spaced', 'spaced');
      assert.ok(session.command.endsWith(` '${path.join(dir, 'claude')}' auth login`), session.command);
      const a = (await c.call('hello')).accounts.find(x => x.email === 'spaced@example.test');
      assert.ok(a, 'it ran and the login was saved');
      await c.call('accounts.remove', { id: a.id });
    } finally {
      await c.call('settings.set', { values: { claudeCommand: path.join(__dirname, 'fake-claude.js') } });
    }
  });

  await step('accounts: startup imports old folder accounts and finished sign-ins, and tidies the rest', async () => {
    const h = path.join(tmp, 'h5');
    const acc = path.join(h, 'accounts');
    const cfg = path.join(tmp, 'claude-h5');
    fs.mkdirSync(cfg, { recursive: true });
    const mk = (dir, who, global = true) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify(login(who)));
      if (global) fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: oauthOf(who) }));
    };
    const oldId = crypto.randomUUID();
    const emptyId = crypto.randomUUID();
    mk(path.join(acc, 'login-2'), 'old');
    fs.mkdirSync(path.join(acc, 'empty'));
    const done = path.join(acc, `.login-${crypto.randomUUID()}`);
    mk(done, 'fresh');
    const stale = path.join(acc, `.login-${crypto.randomUUID()}`);
    fs.mkdirSync(stale);
    const half = path.join(acc, `.login-${crypto.randomUUID()}`);
    mk(half, 'half', false);
    const t = new Date(Date.now() - 2 * 86400e3);
    for (const d of [stale, half]) fs.utimesSync(d, t, t);
    const young = path.join(acc, `.login-${crypto.randomUUID()}`);
    fs.mkdirSync(young);
    const shellId = crypto.randomUUID();
    fs.writeFileSync(path.join(h, 'state.json'), JSON.stringify({
      version: 3, groups: [], repos: [], worktrees: {}, layouts: {},
      sessions: [{ id: shellId, kind: 'shell', name: 'sign in · Login 2', repoPath: tmp, worktreePath: tmp, createdAt: Date.now(), account: oldId, command: 'claude auth login' }],
      prefs: { activeAccount: oldId, accounts: [{ id: oldId, name: 'Login 2', dir: path.join(acc, 'login-2'), shared: true }, { id: emptyId, name: 'Empty', dir: path.join(acc, 'empty'), shared: true }] },
    }));
    const p = spawn('node', [path.join(APP, 'server', 'main.js')], { env: { ...process.env, SKIFFCODE_HOME: h, SKIFFCODE_PORT: String(PORT + 4), SHELL: '/bin/bash', CLAUDE_CONFIG_DIR: cfg }, stdio: 'ignore' });
    try {
      await until(() => fs.existsSync(path.join(h, 'server.pid')), 'server up');
      const nc = await new Client(PORT + 4, fs.readFileSync(path.join(h, 'token'), 'utf8').trim()).connect();
      const got = (await nc.call('hello')).accounts;
      assert.deepEqual(got.map(a => [a.name, a.email]), [['Login 2', 'old@example.test'], ['Org fresh', 'fresh@example.test']]);
      assert.equal(got[0].id, oldId, 'same id');
      assert.deepEqual(readJ(path.join(acc, oldId, 'credentials.json')), readJ(path.join(acc, 'login-2', '.credentials.json')));
      assert.ok(fs.existsSync(path.join(acc, 'login-2', '.credentials.json')), 'old folders are kept');
      assert.ok(fs.existsSync(path.join(acc, 'empty')));
      assert.ok(!fs.existsSync(done), 'a finished sign-in is imported, then removed');
      assert.ok(!fs.existsSync(stale), 'an old unfinished one is removed');
      assert.ok(fs.existsSync(path.join(half, '.credentials.json')), 'an old one holding a login is kept');
      assert.ok(fs.existsSync(young), 'a recent unfinished one is left');
      const st = readJ(path.join(h, 'state.json'));
      assert.equal(st.sessions[0].command, undefined, 'a sign-in tab resumes as a plain shell');
      assert.equal(st.sessions[0].account, undefined);
      assert.deepEqual(st.prefs.accounts.map(a => Object.keys(a).sort()), [['id', 'name'], ['id', 'name']]);
      assert.equal(st.prefs.activeAccount, undefined);
      assert.deepEqual(fs.readdirSync(cfg), [], 'the shared folder is untouched');
    } finally {
      p.kill('SIGTERM');
    }
  });

  await step('file previews (/view): no cookie needed, read-only, inside the worktree, pages sandboxed; web.check', async () => {
    const base = await c.call('fs.viewBase', { root: wt });
    assert.match(base, /^\/view\/[0-9a-f]{32}\/$/);
    fs.mkdirSync(path.join(wt, 'site'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'site', 'index.html'), '<p>hi</p>');
    fs.writeFileSync(path.join(wt, 'site', 'a b.pdf'), '%PDF-1.4');
    fs.writeFileSync(path.join(wt, 'site', 'pic.png'), 'png');
    const get = (p, opts) => fetch(`http://127.0.0.1:${PORT}${p}`, { redirect: 'manual', ...opts });
    let r = await get(`${base}site/pic.png`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    r = await get(`${base}site/`);
    assert.equal(await r.text(), '<p>hi</p>', 'a folder serves its index.html');
    assert.match(r.headers.get('content-security-policy'), /^sandbox allow-scripts/, 'pages get an origin of their own');
    assert.ok(!/allow-same-origin/.test(r.headers.get('content-security-policy')));
    assert.equal((await get(`${base}site`)).status, 302);
    r = await get(`${base}site/a%20b.pdf`);
    assert.equal(r.headers.get('content-type'), 'application/pdf');
    assert.equal(r.headers.get('content-security-policy'), null, 'PDFs use the browser viewer');
    assert.equal((await get(`${base}site/missing.png`)).status, 404);
    assert.equal((await get(`${base}..%2f..%2fetc%2fpasswd`)).status, 403, 'nothing outside the worktree');
    assert.notEqual((await get(`${base}../../../etc/passwd`)).status, 200);
    assert.equal((await get('/view/0123456789abcdef0123456789abcdef/site/')).status, 404, 'unknown key');
    assert.equal((await get(`${base}site/index.html`, { method: 'POST' })).status, 200);
    await assert.rejects(c.call('fs.viewBase', { root: '/etc' }), /Not a worktree/);
    // can a web page be shown inside SkiffCode?
    const srv = require('http').createServer((req, res) => {
      const hd = { 'Content-Type': 'text/html' };
      if (req.url === '/xfo') hd['X-Frame-Options'] = 'SAMEORIGIN';
      if (req.url === '/csp') hd['Content-Security-Policy'] = "default-src 'self'; frame-ancestors 'self'";
      if (req.url === '/csp-ok') hd['Content-Security-Policy'] = 'frame-ancestors http://localhost:*';
      if (req.url === '/to-self') { res.writeHead(302, { Location: `http://127.0.0.1:${PORT}/` }); return res.end(); }
      res.writeHead(200, hd); res.end('ok');
    });
    await new Promise(res => srv.listen(0, '127.0.0.1', res));
    const at = `http://127.0.0.1:${srv.address().port}`;
    assert.equal((await c.call('web.check', { url: `${at}/` })).frameable, true);
    assert.equal((await c.call('web.check', { url: `${at}/xfo` })).frameable, false);
    assert.equal((await c.call('web.check', { url: `${at}/csp` })).frameable, false);
    assert.equal((await c.call('web.check', { url: `${at}/csp-ok` })).frameable, true);
    assert.equal((await c.call('web.check', { url: `http://localhost:${PORT}/` })).frameable, false, 'not SkiffCode itself');
    for (const host of ['localhost.', '127.0.0.2', '[::1]', '0.0.0.0']) assert.equal((await c.call('web.check', { url: `http://${host}:${PORT}/` })).frameable, false, host);
    assert.equal((await c.call('web.check', { url: `${at}/to-self` })).frameable, false, 'redirected to SkiffCode');
    await assert.rejects(c.call('web.check', { url: 'file:///etc/passwd' }), /Only http/);
    srv.close();
    // paths printed in terminals: which exist (relative to the worktree, ~, Windows, WSL shares)
    const outside = path.join(tmp, 'reports', 'cov');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'index.html'), '<link rel=stylesheet href=s.css>');
    fs.writeFileSync(path.join(outside, 's.css'), 'x{}');
    fs.writeFileSync(path.join(outside, 'run.log'), 'plain text log');
    const res = await c.call('paths.resolve', { cwd: wt, paths: ['site/index.html', 'nope.txt', path.join(outside, 'index.html'), `\\\\wsl.localhost\\Ubuntu${outside.replace(/\//g, '\\')}\\s.css`, `file://${outside}/`, 'site'] });
    assert.deepEqual(res.map(x => x && [x.type, x.rel]), [['file', 'site/index.html'], null, ['file', null], ['file', null], ['dir', null], ['dir', 'site']]);
    assert.equal(res[2].abs, path.join(outside, 'index.html'));
    await assert.rejects(c.call('paths.resolve', { cwd: '/etc', paths: ['passwd'] }), /Not a worktree/);
    // a file outside the worktrees: its folder is served (read-only), so the report's CSS loads
    const ext = await c.call('fs.viewUrl', { path: path.join(outside, 'index.html') });
    assert.match(ext, /^\/view\/[0-9a-f]{32}\/index\.html$/);
    assert.equal((await get(ext.replace('index.html', 's.css'))).status, 200);
    r = await get(ext.replace('index.html', 'run.log'));
    assert.equal(r.headers.get('content-type'), 'text/plain; charset=utf-8', 'text shows as text');
    assert.equal((await get(ext.replace('index.html', '..%2f..%2fx'))).status, 403);
    // any other file shares only itself
    const logUrl = await c.call('fs.viewUrl', { path: path.join(outside, 'run.log') });
    assert.equal((await get(logUrl)).status, 200);
    assert.equal((await get(logUrl.replace('run.log', 's.css'))).status, 404, 'not its neighbours');
    // inside a worktree: the worktree's own key
    assert.equal(await c.call('fs.viewUrl', { path: path.join(wt, 'site', 'index.html') }), `${base}site/index.html`);
    // a file right in a broad folder (/, home, /tmp…): only that file
    const lone = path.join(os.tmpdir(), `skc-${process.pid}.html`);
    fs.writeFileSync(lone, 'lone');
    fs.writeFileSync(`${lone}.css`, 'x');
    const lu = await c.call('fs.viewUrl', { path: lone });
    assert.equal(await (await get(lu)).text(), 'lone');
    assert.equal((await get(`${lu}.css`)).status, 404, 'not its neighbours');
    fs.rmSync(lone); fs.rmSync(`${lone}.css`);
    await assert.rejects(c.call('fs.viewUrl', { path: '/definitely/not/here.html' }), /Not found/);
    fs.rmSync(path.join(wt, 'site'), { recursive: true });
  });

  await step('reveal in file manager: the commands per platform; a missing path or unknown folder is refused before anything starts', async () => {
    const { revealCommands } = require('../server/fsops'); // pure: starts nothing
    const decode = cmd => Buffer.from(cmd.args[cmd.args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
    for (const [name, win, quoted] of [
      ['spaces', String.raw`\\wsl.localhost\Ubuntu\home\me\my docs\a.txt`, String.raw`'\\wsl.localhost\Ubuntu\home\me\my docs\a.txt'`],
      ['quotes cannot end the string', String.raw`\\wsl.localhost\Ubuntu\home\me\it's a\x’; calc; ‘.txt`, String.raw`'\\wsl.localhost\Ubuntu\home\me\it''s a\x’’; calc; ‘‘.txt'`],
    ]) {
      const cmds = revealCommands('/home/me/x', { wsl: true, windowsPath: win });
      assert.equal(cmds.length, 1, name);
      assert.equal(cmds[0].file, 'powershell.exe', name);
      assert.deepEqual(cmds[0].args.slice(0, 4), ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text'], name);
      const script = decode(cmds[0]);
      assert.ok(script.includes(`('/select,"' + ${quoted} + '"')`), `${name}: Explorer gets /select,"<path>" with the path escaped`);
      assert.ok(script.includes('SetForegroundWindow') && script.includes('keybd_event'), `${name}: the window is raised`);
    }
    assert.ok(decode(revealCommands('/x/y', { wsl: true, windowsPath: String.raw`\\wsl.localhost\Ubuntu\home\me\my docs\a.txt` })[0]).includes(`$prefix='my docs - '`), 'the fallback matches the parent folder title');
    const [dbus, open] = revealCommands('/home/me/my docs/a,b.txt', { wsl: false });
    assert.equal(dbus.file, 'dbus-send');
    assert.equal(dbus.args.at(-2), 'array:string:file:///home/me/my%20docs/a%2Cb.txt', 'spaces and commas are escaped');
    assert.equal(dbus.args.at(-1), 'string:');
    assert.deepEqual(open, { file: 'xdg-open', args: ['/home/me/my docs'] });
    assert.deepEqual(revealCommands('/Users/me/my docs/a,b.txt', { wsl: false, mac: true }), [{ file: 'open', args: ['-R', '/Users/me/my docs/a,b.txt'] }], 'macOS: Finder selects the item');
    await assert.rejects(c.call('fs.reveal', { cwd: wt, path: 'no/such/file.txt' }), /Not found: no\/such\/file\.txt/);
    await assert.rejects(c.call('fs.reveal', { cwd: '/etc', path: '/etc/passwd' }), /Not a worktree/);
    await assert.rejects(c.call('fs.reveal', { cwd: wt, path: '' }), /Bad path/);
  });

  await step('desktop toast on Windows: quotes in session, branch or repo names stay inside the string', async () => {
    const { toastScript } = require('../server/notify'); // pure: starts nothing
    const name = "x’);calc;(’ ‘a’ 'b' ‚c‛";
    const script = toastScript(`${name} finished`, `${name} — open SkiffCode`);
    // read the LoadXml argument the way PowerShell does: any of these quotes ends it unless doubled
    const Q = "'‘’‚‛";
    let i = script.indexOf('$x.LoadXml(') + '$x.LoadXml('.length;
    assert.ok(Q.includes(script[i]), 'a quoted string');
    let text = '';
    for (i++; i < script.length; i++) {
      if (!Q.includes(script[i])) text += script[i];
      else if (Q.includes(script[i + 1])) text += script[++i];
      else break;
    }
    assert.equal(script[i + 1], ')', 'the string ends where LoadXml does');
    assert.ok(text.includes(`<text>${name} finished</text><text>${name} — open SkiffCode</text>`), text);
  });

  await step('desktop notification on macOS: names reach osascript as arguments after --, never as script', async () => {
    const { macNotifyArgs } = require('../server/notify'); // pure: starts nothing
    const script = ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', '--'];
    for (const [name, title, body] of [
      ['quotes and backslash', `say "hi" it's \\ done`, `"); do shell script "touch /tmp/x`],
      ['newline and end run', 'a\nend run\non run argv', 'b\n-e\nend run'],
      ['a title that looks like -e', '-e do shell script "x" --', '-e'],
      ['a title that looks like -l', '-lJavaScript', '-l JavaScript'],
    ]) {
      const args = macNotifyArgs(title, body);
      assert.deepEqual(args.slice(0, -2), script, `${name}: the script is fixed`);
      assert.deepEqual(args.slice(-2), [title, body], `${name}: title and body are the last two arguments, right after --`);
      if (process.platform === 'darwin') {
        // The real osascript, with the display line swapped for one that echoes argv: -- must end its options.
        const echo = args.map(a => (a.startsWith('display notification') ? 'return (item 1 of argv) & "|" & (item 2 of argv)' : a));
        assert.equal(execFileSync('/usr/bin/osascript', echo, { encoding: 'utf8' }).replace(/\n$/, ''), `${title}|${body}`, `${name}: osascript reads both as plain text`);
      }
    }
  });

  await step('terminal host check without /proc: only the first ptyhost.py argument names the socket', async () => {
    const { hostCommandMatches } = require('../server/pty'); // pure
    const sock = '/Users/me/Library/Sky Code/pty/abc.sock';
    const host = `/usr/bin/python3 /opt/skiffcode/server/ptyhost.py ${sock} 80 24 /Users/me/my app -- claude`;
    for (const [name, command, want] of [
      ['the host, socket path with spaces', host, true],
      ['the host with a prompt after it', `${host} --session-id x "fix /ptyhost.py ${sock}2 please"`, true],
      ['another socket with this one as prefix', `/usr/bin/python3 /opt/skiffcode/server/ptyhost.py ${sock}2 80 24 /x -- bash`, false],
      ['this socket only in later prompt text', `/usr/bin/python3 /opt/skiffcode/server/ptyhost.py /other.sock 80 24 /x -- claude "/ptyhost.py ${sock} 80"`, false],
      ['not a host', `/bin/sleep 60 ${sock} `, false],
      ['a zombie', '(python3)', false],
      ['empty', '', false],
    ]) assert.equal(hostCommandMatches(command, sock), want, name);
  });

  await step('BSD ps elapsed time ([[dd-]hh:]mm:ss) in seconds', async () => {
    const { parseEtime } = require('../server/pty'); // pure
    for (const [etime, secs] of [['01:05', 65], ['02:01:05', 7265], ['3-02:01:05', 3 * 86400 + 7265]]) assert.equal(parseEtime(etime), secs, etime);
    assert.ok(Number.isNaN(parseEtime('soon')), 'not a time');
  });

  await step('a data folder path too long for terminal sockets: the server says so and exits', async () => {
    const long = path.join(tmp, 'x'.repeat(120));
    const r = spawnSync('node', [path.join(APP, 'server', 'main.js')], { env: { ...process.env, SKIFFCODE_HOME: long, SKIFFCODE_PORT: String(PORT + 7) }, encoding: 'utf8', timeout: 8000 });
    assert.equal(r.status, 1, 'exits');
    assert.match(r.stderr, /data folder path is too long for terminal sockets\. Set SKIFFCODE_HOME to a shorter folder\./);
    assert.equal(fs.existsSync(long), false, 'nothing created');
  });

  await step('delete a session completely: its Claude conversation is gone from /resume; folders can be purged', async () => {
    const { encode } = require('../server/history');
    const proj = path.join(CLAUDE_HOME, 'projects', encode(wt));
    fs.mkdirSync(proj, { recursive: true });
    plan('SessionStart,hang');
    const s8 = await c.call('sessions.create', { kind: 'claude', worktreePath: wt, name: 'to delete', cols: 80, rows: 24 });
    const cid = (await c.call('hello')).sessions.find(x => x.id === s8.id).claudeId;
    // what Claude would have saved for it
    fs.writeFileSync(path.join(proj, `${cid}.jsonl`), JSON.stringify({ type: 'user', cwd: wt, message: { role: 'user', content: 'secret plan' } }) + '\n');
    fs.mkdirSync(path.join(proj, cid, 'subagents'), { recursive: true });
    fs.mkdirSync(path.join(CLAUDE_HOME, 'file-history', cid), { recursive: true });
    fs.mkdirSync(path.join(CLAUDE_HOME, 'todos'), { recursive: true });
    fs.writeFileSync(path.join(CLAUDE_HOME, 'todos', `${cid}-agent-${cid}.json`), '[]');
    fs.writeFileSync(path.join(CLAUDE_HOME, 'history.jsonl'), [JSON.stringify({ display: 'secret plan', sessionId: cid }), JSON.stringify({ display: 'keep me', sessionId: 'other' })].join('\n') + '\n');
    assert.ok((await c.call('claude.history', { worktreePath: wt })).some(x => x.id === cid));
    fs.chmodSync(path.join(CLAUDE_HOME, 'history.jsonl'), 0o600);
    const r = await c.call('sessions.purge', { id: s8.id });
    assert.equal(fs.statSync(path.join(CLAUDE_HOME, 'history.jsonl')).mode & 0o777, 0o600, 'prompt history keeps its mode');
    assert.ok(r.deleted.length >= 4);
    assert.ok(!fs.existsSync(path.join(proj, `${cid}.jsonl`)) && !fs.existsSync(path.join(proj, cid)) && !fs.existsSync(path.join(CLAUDE_HOME, 'file-history', cid)));
    assert.deepEqual(fs.readdirSync(path.join(CLAUDE_HOME, 'todos')), []);
    assert.deepEqual(fs.readFileSync(path.join(CLAUDE_HOME, 'history.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).display), ['keep me'], 'only its prompt history lines removed');
    assert.ok(!(await c.call('hello')).sessions.some(x => x.id === s8.id));
    assert.ok(!(await c.call('claude.history', { worktreePath: wt })).some(x => x.id === cid), 'gone from the Resume list');
    // the Resume list's delete, and purging a whole folder
    const A = 'aaaaaaaa-1111-4222-8333-444444444444', B = 'bbbbbbbb-1111-4222-8333-444444444444';
    for (const id of [A, B]) fs.writeFileSync(path.join(proj, `${id}.jsonl`), JSON.stringify({ type: 'user', cwd: wt, message: { role: 'user', content: `hi ${id}` } }) + '\n');
    const before = await c.call('claude.countConversations', { folders: [wt] });
    await c.call('claude.deleteConversation', { worktreePath: wt, id: A });
    assert.equal(await c.call('claude.countConversations', { folders: [wt] }), before - 1);
    assert.equal(await c.call('claude.countConversations', { folders: ['/etc'] }), 0, 'only folders SkiffCode knows');
    await c.call('claude.deleteConversation', { worktreePath: wt, id: B });
    assert.equal(await c.call('claude.countConversations', { folders: [wt] }), before - 2);
    // purging a whole folder (the "also delete conversations" box when removing it): sessions stop, conversations go
    const box = path.join(tmp, 'purge-me');
    fs.mkdirSync(box, { recursive: true });
    await c.call('repos.add', { path: box });
    const bproj = path.join(CLAUDE_HOME, 'projects', encode(box));
    fs.mkdirSync(bproj, { recursive: true });
    for (const id of [A, B]) fs.writeFileSync(path.join(bproj, `${id}.jsonl`), JSON.stringify({ type: 'user', cwd: box, message: { role: 'user', content: 'x' } }) + '\n');
    plan('SessionStart,hang');
    const s9 = await c.call('sessions.create', { kind: 'claude', worktreePath: box, cols: 80, rows: 24 });
    assert.equal(await c.call('claude.countConversations', { folders: [box] }), 2);
    assert.equal((await c.call('claude.purgeFolders', { folders: [box] })).deleted, 2);
    assert.equal(await c.call('claude.countConversations', { folders: [box] }), 0);
    assert.ok(!(await c.call('hello')).sessions.some(x => x.id === s9.id));
    await c.call('repos.remove', { path: box });
    await assert.rejects(c.call('claude.deleteConversation', { worktreePath: wt, id: '../../x' }), /Not a conversation ID/);
  });

  await step('Claude switches conversation (/tui, /clear): SkiffCode resumes the new one', async () => {
    const { encode } = require('../server/history');
    const proj = path.join(CLAUDE_HOME, 'projects', encode(wt));
    fs.mkdirSync(proj, { recursive: true });
    for (const [label, newId, saved, flag] of [
      ['relaunched, with a transcript', 'cccccccc-1111-4222-8333-444444444444', true, '--resume'],
      ['fresh /clear, no transcript yet', 'dddddddd-1111-4222-8333-444444444444', false, '--session-id'],
    ]) {
      plan('SessionStart,UserPromptSubmit,hang');
      const s9 = await c.call('sessions.create', { kind: 'claude', worktreePath: wt, name: 'switcher', cols: 80, rows: 24 });
      const sess = async () => (await c.call('hello')).sessions.find(x => x.id === s9.id);
      await until(async () => (await sess()).prompted, `${label}: prompted`);
      const transcript = path.join(proj, `${newId}.jsonl`);
      if (saved) fs.writeFileSync(transcript, JSON.stringify({ type: 'user', cwd: wt, message: { role: 'user', content: 'hi' } }) + '\n');
      fs.writeFileSync(path.join(HOME, 'status', `${s9.id}.statusline`), JSON.stringify({ session_id: newId, transcript_path: transcript }));
      await until(async () => (await sess()).claudeId === newId, `${label}: claudeId follows`);
      await c.call('sessions.stop', { id: s9.id });
      plan('SessionStart,hang');
      const n = calls().length;
      await c.call('sessions.resume', { id: s9.id });
      await until(() => calls().length === n + 1, `${label}: relaunched`);
      assert.equal(calls()[n].args[0], flag, label);
      if (saved) assert.equal(calls()[n].args[1], newId, label);
      await c.call('sessions.forget', { id: s9.id });
    }
  });

  await step('CLI: `skiffcode new` makes a worktree + named Claude session with a first prompt; `claude` and `list`', async () => {
    const cliEnv = { ...process.env, SKIFFCODE_APP: APP, SKIFFCODE_HOME: HOME, SKIFFCODE_PORT: String(PORT), CLAUDE_CONFIG_DIR: CLAUDE_HOME };
    const run = (...a) => execFileSync(path.join(APP, 'bin', 'skiffcode'), a, { env: cliEnv, encoding: 'utf8' });
    plan('SessionStart,hang');
    const before = calls().length;
    const r = JSON.parse(run('new', repo, 'feat/cli', '--name', 'cli work', '--prompt', 'Add a --verbose flag', '--json'));
    assert.equal(r.branch, 'feat/cli');
    assert.equal(r.created, true);
    assert.equal(r.worktree, path.join(tmp, 'code', 'myapp.worktrees', 'feat-cli'));
    assert.equal(r.session.name, 'cli work');
    await until(() => calls().length > before, 'claude launched');
    const a = calls().at(-1);
    assert.equal(a.cwd, r.worktree);
    assert.equal(a.args[a.args.indexOf('--name') + 1], 'cli work');
    assert.deepEqual(a.args.slice(-2), ['--', 'Add a --verbose flag'], 'first prompt passed once, after --');
    assert.ok(!JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8')).sessions.find(s => s.id === r.session.id).initialPrompt, 'not sent again on restart');
    assert.equal(c.last('open.worktree')?.data.session, r.session.id, 'shown in the open window');
    // a new branch from a remote base
    sh('git push -q origin main', repo);
    // someone else moves origin/main; `new -b origin/main` fetches it first
    const other = path.join(tmp, 'other-clone');
    sh(`git clone -q $(git -C ${repo} remote get-url origin) ${other}`);
    sh('git checkout -q -B main origin/main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m "upstream change" && git push -q origin main', other);
    const based = JSON.parse(run('new', repo, 'feat/from-origin', '-b', 'origin/main', '--no-claude', '--no-show', '--json'));
    assert.equal(based.created, true);
    assert.equal(sh('git log -1 --format=%s', based.worktree).trim(), 'upstream change', 'branched from the latest origin/main');
    assert.equal((await c.call('worktrees.list', { repo })).worktrees.find(w => w.branch === 'feat/from-origin').base, 'origin/main', 'base remembered for "changes vs base"');
    assert.throws(() => run('new', repo, 'feat/nope', '--base', 'origin/does-not-exist', '--no-claude'), /Base branch not found: origin\/does-not-exist/);
    // same branch again: reuses the worktree
    const again = JSON.parse(run('new', repo, 'feat/cli', '--no-claude', '--json'));
    assert.equal(again.created, false);
    assert.equal(again.session, null);
    // human output
    assert.match(run('claude', r.worktree, '--name', 'second', '--no-show'), /Claude {4}“second” started/);
    const list = JSON.parse(run('list', '--json'));
    const w = list.find(x => x.repo === repo).worktrees.find(x => x.branch === 'feat/cli');
    assert.deepEqual(w.sessions.map(s => s.name).sort(), ['cli work', 'second']);
    assert.throws(() => run('new', repo), /usage: skiffcode new/);
    for (const flag of ['--base', '--name', '--prompt']) assert.throws(() => execFileSync(path.join(APP, 'bin', 'skiffcode'), ['new', repo, 'feat/x', flag], { env: cliEnv, encoding: 'utf8', stdio: 'pipe' }), new RegExp(`${flag} needs a value`), flag);
    assert.throws(() => execFileSync(path.join(APP, 'bin', 'skiffcode'), ['url', path.join(tmp, 'no-such-dir')], { env: cliEnv, encoding: 'utf8', stdio: 'pipe' }), /not a folder/);
    for (const s of w.sessions) await c.call('sessions.forget', { id: s.id });
  });

  await step('CLI: `skiffcode status` reports the running test server, and "not running" for a home with no server', async () => {
    const empty = path.join(tmp, 'h-status');
    fs.mkdirSync(empty);
    const target = { SKIFFCODE_APP: APP, SKIFFCODE_HOME: HOME, SKIFFCODE_PORT: String(PORT) };
    console.log(`    status env: ${JSON.stringify(target)}`);
    // never the user's own server or data folder
    for (const v of Object.values(target)) assert.ok(!v.includes('.local/share/skiffcode'), `test env names the user's data folder: ${v}`);
    assert.notEqual(target.SKIFFCODE_PORT, '3417');
    const status = env => execFileSync(path.join(APP, 'bin', 'skiffcode'), ['status'], { env: { ...process.env, ...env }, encoding: 'utf8' }).trim();
    const out = status(target);
    assert.match(out, /^running — /);
    assert.equal(JSON.parse(out.slice('running — '.length)).pid, server.pid, 'it is this test server');
    assert.equal(status({ ...target, SKIFFCODE_HOME: empty }), 'not running');
  });

  await step('one server per home; `skiffcode stop` stops only SkiffCode; the last log is kept', async () => {
    const r = spawnSync('node', [path.join(APP, 'server', 'main.js')], { env: { ...process.env, SKIFFCODE_HOME: HOME, SKIFFCODE_PORT: String(PORT + 2), CLAUDE_CONFIG_DIR: CLAUDE_HOME }, encoding: 'utf8', timeout: 8000 });
    assert.equal(r.status, 1, 'a second server on the same home exits');
    assert.match(r.stderr, /already running/);
    assert.equal(fs.readFileSync(path.join(HOME, 'server.pid'), 'utf8'), String(server.pid));
    // a home of its own, on a port nothing listens on
    const h3 = path.join(tmp, 'h3');
    fs.mkdirSync(h3);
    const env3 = { ...process.env, SKIFFCODE_APP: APP, SKIFFCODE_HOME: h3, SKIFFCODE_PORT: String(PORT + 2), CLAUDE_CONFIG_DIR: CLAUDE_HOME };
    const cli3 = (...a) => execFileSync(path.join(APP, 'bin', 'skiffcode'), a, { env: env3, encoding: 'utf8', stdio: 'pipe' });
    const victim = spawn('sleep', ['60'], { stdio: 'ignore' });
    try {
      fs.writeFileSync(path.join(h3, 'server.pid'), String(victim.pid));
      assert.match(cli3('stop'), /not running/);
      await sleep(200);
      assert.deepEqual([victim.exitCode, victim.signalCode], [null, null], 'a stale server.pid names another program: left alone');
      fs.writeFileSync(path.join(h3, 'server.log'), 'old run\n');
      fs.writeFileSync(path.join(h3, 'token'), 'old-token\n'); // the real case after a reboot: the probe runs before the start
      const startedAt = Date.now();
      cli3('url');
      assert.ok(Date.now() - startedAt < 8000, 'a closed port that stays silent (WSL mirrored networking) does not stall the start');
      assert.equal(fs.readFileSync(path.join(h3, 'server.log.1'), 'utf8'), 'old run\n', 'the previous log is kept');
      assert.equal(fs.statSync(path.join(h3, 'server.log')).mode & 0o777, 0o600);
      const pid3 = Number(fs.readFileSync(path.join(h3, 'server.pid'), 'utf8'));
      assert.match(cli3('stop'), /stopped/);
      assert.throws(() => process.kill(pid3, 0), 'the server it started is stopped');
      assert.ok(!fs.existsSync(path.join(h3, 'server.pid')), 'server.pid removed on a clean exit');
      const other = net.createServer(() => {});
      await new Promise(resolve => other.listen(PORT + 5, '127.0.0.1', resolve));
      try {
        assert.throws(() => execFileSync(path.join(APP, 'bin', 'skiffcode'), ['url'], { env: { ...env3, SKIFFCODE_PORT: String(PORT + 5) }, encoding: 'utf8', stdio: 'pipe' }), /already used by another program/);
      } finally {
        other.close();
      }
    } finally {
      victim.kill();
      try { cli3('stop'); } catch { /* not running */ }
    }
  });

  await step('remove worktree + branch: sessions stopped, folder gone, unmerged branch reported', async () => {
    const info = await c.call('worktrees.removeInfo', { repo, path: wt });
    assert.equal(info.sessions, 1);
    assert.equal(info.dirty, 1);
    const r = await c.call('worktrees.remove', { repo, path: wt, deleteBranch: true });
    assert.ok(!fs.existsSync(wt));
    // pushed to origin, so git treats it as merged into its upstream and deletes it
    assert.equal(r.branch, 'deleted');
    assert.equal(sh('git branch --list feat/login', repo).trim(), '');
    assert.equal((await c.call('hello')).sessions.length, 0);
    const pidFile = `${process.env.FAKE_LOG}.pids`;
    const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
    const mine = (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').split('\n').filter(Boolean).map(Number) : []).filter(alive);
    assert.deepEqual(mine, [], 'Claude process stopped');
  });

  await step('delete repo from disk: wrong name refused, worktree folders deleted', async () => {
    const doomed = path.join(tmp, 'code', 'doomed');
    fs.mkdirSync(doomed);
    sh('git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m x && git worktree add -q -b side ../doomed.worktrees/side', doomed);
    await c.call('repos.add', { path: doomed });
    const info = await c.call('repos.deleteInfo', { path: doomed });
    assert.equal(info.linked.length, 1);
    await assert.rejects(c.call('repos.delete', { path: doomed, confirm: 'nope' }), /Type the repository name/);
    assert.ok(fs.existsSync(doomed));
    await c.call('repos.delete', { path: doomed, confirm: 'doomed' });
    assert.ok(!fs.existsSync(doomed) && !fs.existsSync(path.join(tmp, 'code', 'doomed.worktrees', 'side')));
    for (const root of [doomed, path.join(tmp, 'code', 'doomed.worktrees', 'side')]) {
      await assert.rejects(c.call('fs.list', { root }), /Not a worktree SkiffCode knows about/, 'a deleted repo and its worktrees are no longer known roots');
    }
  });

  await step('plain folders (no git): added as folders, files/search/Claude work, git panel says so, git init converts', async () => {
    const notes = path.join(tmp, 'code', 'notes');
    fs.mkdirSync(path.join(notes, 'ideas'), { recursive: true });
    fs.writeFileSync(path.join(notes, 'ideas', 'todo.md'), '- ship the folder support\n');
    const r = await c.call('repos.add', { path: path.join(notes, 'ideas') });
    assert.equal(r.path, path.join(notes, 'ideas'), 'a plain folder is added as itself');
    await c.call('repos.remove', { path: r.path });
    const f = await c.call('repos.add', { path: notes });
    assert.equal(f.kind, 'folder');
    const wts = (await c.call('worktrees.list', { repo: notes })).worktrees;
    assert.deepEqual(wts.map(w => [w.path, w.folder]), [[notes, true]]);
    assert.equal((await c.call('worktrees.status', { path: notes })).notGit, true);
    assert.equal((await c.call('git.status', { root: notes })).notGit, true);
    assert.deepEqual((await c.call('git.commits', { root: notes })).commits, []);
    assert.deepEqual(await c.call('git.log', { root: notes }), { commits: [], more: false });
    assert.deepEqual((await c.call('fs.list', { root: notes, dir: '' })).map(e => e.name), ['ideas']);
    assert.deepEqual(await c.call('search.files', { root: notes }), ['ideas/todo.md']);
    assert.equal((await c.call('search.text', { root: notes, query: 'folder support' })).results[0].file, 'ideas/todo.md');
    plan('SessionStart,hang');
    const before = calls().length;
    const s5 = await c.call('sessions.create', { kind: 'claude', worktreePath: notes, cols: 80, rows: 24 });
    await until(() => calls().length > before, 'claude launched');
    assert.equal(calls().at(-1).cwd, notes);
    assert.equal(s5.name, 'notes');
    await c.call('sessions.forget', { id: s5.id });
    await assert.rejects(c.call('repos.add', { path: os.homedir() }), /Pick a project folder/);
    const cliEnv = { ...process.env, SKIFFCODE_APP: APP, SKIFFCODE_HOME: HOME, SKIFFCODE_PORT: String(PORT), CLAUDE_CONFIG_DIR: CLAUDE_HOME };
    assert.throws(() => execFileSync(path.join(APP, 'bin', 'skiffcode'), ['new', notes, 'x', '--no-claude'], { env: cliEnv, encoding: 'utf8', stdio: 'pipe' }), /isn’t a git repository.*skiffcode claude/s);
    await c.call('git.init', { root: notes });
    const after = (await c.call('hello')).repos.find(x => x.path === notes);
    assert.equal(after.kind, undefined, 'now a git repository');
    assert.ok(!(await c.call('git.status', { root: notes })).notGit);
    await c.call('repos.remove', { path: notes });
    // `git init` run by hand (or by Claude) in a shell is picked up too
    const scratch = path.join(tmp, 'code', 'scratch');
    fs.mkdirSync(scratch);
    fs.writeFileSync(path.join(scratch, 'a.txt'), 'a\n');
    assert.equal((await c.call('repos.add', { path: scratch })).kind, 'folder');
    sh('git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m first', scratch);
    await until(async () => (await c.call('hello')).repos.find(x => x.path === scratch).kind === undefined, 'folder became a repo', 8000);
    await until(() => c.last('worktrees.changed')?.data.repo === scratch, 'worktrees refresh');
    const st = await c.call('git.status', { root: scratch });
    assert.deepEqual(st.untracked.map(f => f.path), ['a.txt'], 'git features work');
    assert.equal((await c.call('worktrees.list', { repo: scratch })).worktrees[0].branch, 'main');
    assert.equal((await c.call('git.commits', { root: scratch })).commits[0].subject, 'first');
    await c.call('repos.remove', { path: scratch });
  });

  await step('dropped files: copied into the worktree safely; attachments saved outside the repo', async () => {
    const b64 = t => Buffer.from(t).toString('base64');
    await c.call('fs.upload', { root: repo, path: 'drop/in/a.bin', data: b64('\x00\x01binary') });
    assert.equal(fs.readFileSync(path.join(repo, 'drop/in/a.bin'), 'latin1'), '\x00\x01binary');
    await assert.rejects(c.call('fs.upload', { root: repo, path: 'drop/in/a.bin', data: b64('x') }), /already exists/);
    await c.call('fs.upload', { root: repo, path: 'drop/in/a.bin', data: b64('new'), replace: true });
    assert.equal(fs.readFileSync(path.join(repo, 'drop/in/a.bin'), 'utf8'), 'new');
    await assert.rejects(c.call('fs.upload', { root: repo, path: '../escape.txt', data: b64('x') }), /outside the worktree/);
    assert.deepEqual(await c.call('fs.exists', { root: repo, paths: ['drop/in/a.bin', 'nope', '../../etc/passwd'] }), ['drop/in/a.bin']);
    const d1 = await c.call('drops.save', { name: '../../My Screen shot.png', data: b64('PNG') });
    const d2 = await c.call('drops.save', { name: 'My Screen shot.png', data: b64('PNG2') });
    assert.ok(d1.path.startsWith(path.join(HOME, 'drops') + '/') && d1.path.endsWith('/My-Screen-shot.png'));
    assert.ok(d2.path.endsWith('/My-Screen-shot-2.png'), 'same name the same day → numbered');
    fs.rmSync(path.join(repo, 'drop'), { recursive: true });
  });

  await step('customize: icon + color saved; bad values ignored', async () => {
    await c.call('repos.customize', { path: repo, icon: 'i:rocket', color: '#61AFEF' });
    let r = (await c.call('hello')).repos.find(x => x.path === repo);
    assert.deepEqual([r.icon, r.color], ['i:rocket', '#61afef']);
    await c.call('repos.customize', { path: repo, icon: '<img src=x onerror=1>', color: 'red' });
    r = (await c.call('hello')).repos.find(x => x.path === repo);
    assert.deepEqual([r.icon, r.color], [undefined, undefined], 'only built-in names, short emoji and #rrggbb');
    const { id } = await c.call('groups.create', { name: 'Clients' });
    await c.call('groups.customize', { id, icon: '⭐', color: '#e5c07b' });
    const g = (await c.call('hello')).groups.find(x => x.id === id);
    assert.deepEqual([g.icon, g.color], ['⭐', '#e5c07b']);
    // counted as the eye sees them, like the dialog: a family is one emoji, three emoji are too many
    const family = '👨‍👩‍👧‍👦';
    await c.call('groups.customize', { id, icon: `${family}🇩🇪`, color: undefined });
    assert.equal((await c.call('hello')).groups.find(x => x.id === id).icon, `${family}🇩🇪`);
    await c.call('groups.customize', { id, icon: '⭐⭐⭐', color: undefined });
    assert.equal((await c.call('hello')).groups.find(x => x.id === id).icon, undefined);
  });

  await step('`skiffcode <dir>` inbox adds the repo and asks the page to open it', async () => {
    const r2 = path.join(tmp, 'code', 'inboxed');
    fs.mkdirSync(r2);
    sh('git init -q -b main', r2);
    fs.writeFileSync(path.join(HOME, 'inbox', `${Date.now()}.path`), r2 + '\n');
    await until(() => c.last('open.worktree')?.data.path === r2, 'open event');
  });

  await step('repos: a submodule is a repo of its own; a linked worktree still means its main repo', async () => {
    const sup = path.join(tmp, 'code', 'super');
    const lib = path.join(tmp, 'libsrc');
    fs.mkdirSync(sup);
    fs.mkdirSync(lib);
    sh('git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m lib', lib);
    sh(`git init -q -b main && git -c protocol.file.allow=always submodule --quiet add ${lib} libs/sub && git -c user.email=t@t -c user.name=t commit -qm sub && git worktree add -q -b side ../super.worktrees/side`, sup);
    const sub = path.join(sup, 'libs', 'sub');
    assert.equal((await c.call('repos.add', { path: sub })).path, sub);
    assert.deepEqual((await c.call('worktrees.list', { repo: sub })).worktrees.map(w => w.path), [sub]);
    assert.equal((await c.call('repos.add', { path: path.join(tmp, 'code', 'super.worktrees', 'side') })).path, sup);
    for (const p of [sub, sup]) await c.call('repos.remove', { path: p });
  });

  await step('git watch: a folder watched before `git init` still gets git changes afterwards', async () => {
    const w = path.join(tmp, 'code', 'watchy');
    fs.mkdirSync(w);
    fs.writeFileSync(path.join(w, 'a.txt'), 'a\n');
    assert.equal((await c.call('repos.add', { path: w })).kind, 'folder');
    await c.call('fs.watch', { root: w, path: '' }); // the git watch fails: not a repository yet
    await sleep(400);
    c.events.length = 0;
    sh('git init -q -b main', w);
    await until(async () => (await c.call('hello')).repos.find(r => r.path === w).kind === undefined, 'folder became a repo');
    const changed = () => c.events.some(e => e.event === 'git.changed' && e.data.root === w);
    await until(changed, "the announcement's own git.changed");
    c.events.length = 0;
    // Only .git/HEAD changes, which only the git watcher sees. That watch starts just after the announcement, so repeat.
    let tries = 0;
    await until(() => { if (tries++ % 12 === 0) sh(`git symbolic-ref HEAD refs/heads/b${tries}`, w); return changed(); }, 'git.changed after git init');
    await c.call('fs.unwatch', { root: w, path: '' });
    await c.call('repos.remove', { path: w });
  });

  await step('file watches: counted once per client, so one unwatch or a disconnect ends them', async () => {
    const w = path.join(tmp, 'code', 'watchcount');
    fs.mkdirSync(path.join(w, 'sub'), { recursive: true });
    sh('git init -q -b main', w);
    await c.call('repos.add', { path: w });
    const changes = cl => cl.events.filter(e => e.event === 'fs.changed' && e.data.root === w && e.data.path.startsWith('sub'));
    const touch = n => fs.writeFileSync(path.join(w, 'sub', 'f.txt'), n);
    await c.call('fs.watch', { root: w, path: 'sub' });
    await c.call('fs.watch', { root: w, path: 'sub' });
    c.events.length = 0;
    touch('1');
    await until(() => changes(c).length, 'a watched folder reports changes');
    await c.call('fs.unwatch', { root: w, path: 'sub' });
    await sleep(200);
    c.events.length = 0;
    touch('2');
    await sleep(600);
    assert.equal(changes(c).length, 0, 'one unwatch ends the watch');
    const c2 = await new Client(PORT, token).connect();
    await c2.call('fs.watch', { root: w, path: 'sub' });
    await c2.call('fs.watch', { root: w, path: 'sub' });
    c.events.length = 0;
    touch('3');
    await until(() => changes(c).length, 'the second client’s watch reports changes');
    c2.close();
    await sleep(400);
    c.events.length = 0;
    touch('4');
    await sleep(600);
    assert.equal(changes(c).length, 0, 'a disconnect ends the watch');
    await c.call('repos.remove', { path: w });
  });

  await step('roots: a hello does not hide other pages’ worktrees; removing a repo forgets its worktrees', async () => {
    const base = path.join(tmp, 'code', 'rootcheck');
    fs.mkdirSync(base);
    sh('git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m x', base);
    await c.call('repos.add', { path: base });
    const made = await c.call('worktrees.create', { repo: base, newBranch: 'side', base: 'main', startClaude: false });
    await c.call('layout.save', { root: made.path, layout: { tabs: [] } });
    const [, listed] = await Promise.allSettled([c.call('hello'), c.call('fs.list', { root: base, dir: '' })]);
    assert.equal(listed.status, 'fulfilled', 'fs.list in the middle of a hello');
    await c.call('hello');
    const stored = () => JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8'));
    assert.ok(stored().worktrees[made.path]);
    await until(() => (stored().layouts || {})[made.path], 'layout saved');
    await c.call('repos.remove', { path: base });
    for (const root of [base, made.path]) await assert.rejects(c.call('fs.list', { root, dir: '' }), /Not a worktree/);
    assert.ok(!stored().worktrees[made.path] && !(stored().layouts || {})[made.path], 'its saved worktree data is gone');
  });

  await step('dirty count: a staged file that changed again counts once', async () => {
    const d = path.join(tmp, 'code', 'dirtycount');
    fs.mkdirSync(d);
    sh('git init -q -b main && git config user.email t@t && git config user.name t && echo 1 > f.txt && git add . && git commit -qm x && echo 2 > f.txt && git add f.txt && echo 3 > f.txt', d);
    await c.call('repos.add', { path: d });
    assert.equal((await c.call('worktrees.status', { path: d, fresh: true })).dirty, 1);
    await c.call('repos.remove', { path: d });
  });

  await step('watch events name the deepest worktree (a submodule, not the repo around it)', async () => {
    const sup = path.join(tmp, 'code', 'nest');
    const lib = path.join(tmp, 'nestlib');
    fs.mkdirSync(sup);
    fs.mkdirSync(lib);
    sh('git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m lib', lib);
    sh(`git init -q -b main && git -c protocol.file.allow=always submodule --quiet add ${lib} libs/sub && git -c user.email=t@t -c user.name=t commit -qm sub`, sup);
    const sub = path.join(sup, 'libs', 'sub');
    await c.call('repos.add', { path: sup });
    await c.call('repos.add', { path: sub });
    await c.call('fs.watch', { root: sub, path: '' });
    c.events.length = 0;
    fs.writeFileSync(path.join(sub, 'new.txt'), 'x');
    const ev = await until(() => c.events.find(e => e.event === 'fs.changed' && e.data.path.endsWith('new.txt')), 'change reported');
    assert.deepEqual([ev.data.root, ev.data.path], [sub, 'new.txt']);
    await c.call('fs.unwatch', { root: sub, path: '' });
    for (const p of [sub, sup]) await c.call('repos.remove', { path: p });
  });

  await step('removing a worktree: the real reason a branch stays; “unmerged” only when it is unmerged', async () => {
    const base = path.join(tmp, 'code', 'branchdel');
    fs.mkdirSync(base);
    sh('git init -q -b main && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m x', base);
    await c.call('repos.add', { path: base });
    const stuck = await c.call('worktrees.create', { repo: base, newBranch: 'stuck', base: 'main', startClaude: false });
    fs.writeFileSync(path.join(base, '.git', 'refs', 'heads', 'stuck.lock'), '');
    const r1 = await c.call('worktrees.remove', { repo: base, path: stuck.path, deleteBranch: true });
    assert.equal(r1.branch, 'error');
    assert.match(r1.branchError, /could not (remove|delete) reference/);
    fs.rmSync(path.join(base, '.git', 'refs', 'heads', 'stuck.lock'));
    const wip = await c.call('worktrees.create', { repo: base, newBranch: 'wip', base: 'main', startClaude: false });
    sh('git commit -q --allow-empty -m unmerged', wip.path);
    const r2 = await c.call('worktrees.remove', { repo: base, path: wip.path, deleteBranch: true });
    assert.equal(r2.branch, 'unmerged');
    await c.call('repos.remove', { path: base });
  });

  await step('`skiffcode <dir>` inbox: a request still being written waits for its whole line', async () => {
    const r2 = path.join(tmp, 'code', 'inboxslow');
    fs.mkdirSync(r2);
    const file = path.join(HOME, 'inbox', `${Date.now()}-slow.path`);
    c.events.length = 0;
    fs.writeFileSync(file, '');
    await sleep(300);
    assert.ok(fs.existsSync(file), 'an empty request stays until it is written');
    assert.ok(!c.events.some(e => e.event === 'toast'));
    fs.appendFileSync(file, r2 + '\n');
    await until(() => c.last('open.worktree')?.data.path === r2, 'open event');
    await c.call('repos.remove', { path: r2 });
  });

  await step('`skiffcode <dir>` inbox: a folder that is not there says so', async () => {
    const gone = path.join(tmp, 'no', 'such', 'folder');
    fs.writeFileSync(path.join(HOME, 'inbox', `${Date.now()}-gone.path`), gone + '\n');
    const toast = await until(() => c.events.find(e => e.event === 'toast' && e.data.text.includes(gone)), 'error toast');
    assert.match(toast.data.text, /Folder not found/);
    assert.doesNotMatch(toast.data.text, /not a git repository/);
  });

  await step('commands are looked up again after a miss', async () => {
    const { which } = require(path.join(APP, 'server', 'util'));
    const oldPath = process.env.PATH;
    const bin = path.join(tmp, 'whichbin');
    fs.mkdirSync(bin);
    process.env.PATH = bin;
    try {
      assert.equal(which('skiff-tool'), undefined);
      fs.writeFileSync(path.join(bin, 'skiff-tool'), '#!/bin/sh\n', { mode: 0o755 });
      assert.equal(which('skiff-tool'), path.join(bin, 'skiff-tool'));
    } finally {
      process.env.PATH = oldPath;
    }
  });

  await step('websocket: fragments that add up to a huge message are refused', async () => {
    const sock = net.connect(PORT, '127.0.0.1');
    let got = Buffer.alloc(0);
    sock.on('data', d => { got = Buffer.concat([got, d]); });
    sock.on('error', () => {});
    await new Promise(r => sock.once('connect', r));
    sock.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${Buffer.from('0123456789abcdef').toString('base64')}\r\nSec-WebSocket-Version: 13\r\nCookie: skiffcode_tkn=${token}\r\n\r\n`);
    await until(() => got.includes('\r\n\r\n'), 'handshake');
    const chunk = Buffer.alloc(4 * 1024 * 1024);
    const frame = (first) => {
      const head = Buffer.alloc(10);
      head[0] = first ? 0x01 : 0x00; // text / continuation, never the final fragment
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(chunk.length), 2);
      return Buffer.concat([head, chunk]);
    };
    for (let i = 0; i < 18 && !sock.destroyed; i++) { // 72 MB, over the 64 MB limit
      await new Promise(r => sock.write(frame(i === 0), r));
    }
    const closeFrame = () => { const i = got.indexOf('\r\n\r\n') + 4; return got.length >= i + 4 && got[i] === 0x88 ? got.readUInt16BE(i + 2) : null; };
    assert.equal(await until(closeFrame, 'close frame'), 1009);
    sock.destroy();
  });

  await step('search without ripgrep: regex, include/exclude and match lengths agree with ripgrep', async () => {
    const mk = (dir, git) => {
      fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'vendor'));
      fs.writeFileSync(path.join(dir, 'a.js'), 'const foo = 1; // Foo bar\nfoobar baz\n');
      fs.writeFileSync(path.join(dir, 'b.md'), 'foo and baz\néé FOO\n');
      fs.writeFileSync(path.join(dir, 'docs', 'c.js'), 'baz foo\nfooo\n');
      fs.writeFileSync(path.join(dir, 'vendor', 'd.js'), 'foo\n');
      if (git) sh('git init -q -b main && git add .', dir);
    };
    const gitDir = path.join(tmp, 'code', 'grepgit');
    const plainDir = path.join(tmp, 'code', 'grepplain');
    mk(gitDir, true);
    mk(plainDir, false);
    // a server that cannot find ripgrep
    const bin = path.join(tmp, 'norg-bin');
    fs.mkdirSync(bin);
    for (const t of ['node', 'git', 'grep', 'python3', 'bash', 'sh']) fs.symlinkSync(execFileSync('bash', ['-c', `command -v ${t}`], { encoding: 'utf8' }).trim(), path.join(bin, t));
    const h3 = path.join(tmp, 'h4');
    fs.mkdirSync(h3);
    const p3 = spawn('node', [path.join(APP, 'server', 'main.js')], { env: { ...process.env, PATH: bin, SKIFFCODE_HOME: h3, SKIFFCODE_PORT: String(PORT + 3), SHELL: '/bin/bash', CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-h4') }, stdio: 'ignore' });
    try {
      await until(() => fs.existsSync(path.join(h3, 'token')) && fs.existsSync(path.join(h3, 'server.pid')), 'server without rg up');
      const nc = await new Client(PORT + 3, fs.readFileSync(path.join(h3, 'token'), 'utf8').trim()).connect();
      await nc.call('hello');
      for (const d of [gitDir, plainDir]) {
        await c.call('repos.add', { path: d });
        await nc.call('repos.add', { path: d });
        const norm = r => r.results.map(f => ({ file: f.file, matches: f.matches })).sort((a, b) => a.file.localeCompare(b.file));
        const both = async opts => {
          const [a, b] = [norm(await c.call('search.text', { root: d, ...opts })), norm(await nc.call('search.text', { root: d, ...opts }))];
          assert.deepEqual(b, a, `${d}: ${JSON.stringify(opts)}`);
          return b;
        };
        const alt = await both({ query: 'fo+|baz', regex: true, caseSensitive: true });
        assert.ok(alt.some(f => f.file === 'a.js') && alt.some(f => f.file === 'b.md'), 'a regex with + and |');
        assert.deepEqual((await both({ query: 'foo', include: '*.md' })).map(f => f.file), ['b.md']);
        assert.deepEqual((await both({ query: 'foo', exclude: 'vendor,docs/*,*.md' })).map(f => f.file), ['a.js']);
        assert.deepEqual((await both({ query: 'FOO' })).find(f => f.file === 'a.js').matches.map(m => [m.col, m.len]), [[7, 3], [19, 3], [1, 3]]);
        await both({ query: 'fo+', regex: true });
        await both({ query: 'foo', word: true });
        await both({ query: 'FOO', caseSensitive: true });
      }
    } finally {
      p3.kill('SIGTERM');
      for (const d of [gitDir, plainDir]) await c.call('repos.remove', { path: d });
    }
  });

  await step('search with ripgrep: thousands of unreadable files cannot block it', async () => {
    const d = path.join(tmp, 'code', 'noread');
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'ok.txt'), 'needle\n');
    for (let i = 0; i < 1500; i++) fs.writeFileSync(path.join(d, `f${i}.txt`), 'x', { mode: 0 });
    await c.call('repos.add', { path: d });
    const r = await Promise.race([c.call('search.text', { root: d, query: 'needle' }), sleep(6000).then(() => 'hung')]);
    assert.notEqual(r, 'hung');
    assert.deepEqual(r.results.map(f => f.file), ['ok.txt']);
    await c.call('repos.remove', { path: d });
  });

  await step('state.json: a corrupt file is kept aside; one from a newer SkiffCode stops the server, untouched', async () => {
    const h = path.join(tmp, 'h2');
    fs.mkdirSync(h);
    const file = path.join(h, 'state.json');
    const env = { ...process.env, SKIFFCODE_HOME: h, SKIFFCODE_PORT: String(PORT + 1), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-h2') };
    const newer = JSON.stringify({ version: 99, repos: [{ path: '/x' }] });
    fs.writeFileSync(file, newer);
    const r = spawnSync('node', [path.join(APP, 'server', 'main.js')], { env, encoding: 'utf8', timeout: 8000 });
    assert.equal(r.status, 1, 'exits');
    assert.match(r.stderr, /newer/);
    assert.equal(fs.readFileSync(file, 'utf8'), newer, 'left as it was');
    const corrupt = '{"version": 3, "repos": [';
    fs.writeFileSync(file, corrupt);
    const p = spawn('node', [path.join(APP, 'server', 'main.js')], { env, stdio: 'ignore' });
    try {
      await until(() => fs.existsSync(path.join(h, 'server.pid')), 'second server up');
      const bad = fs.readdirSync(h).filter(f => f.startsWith('state.json.bad-'));
      assert.equal(bad.length, 1);
      assert.equal(fs.readFileSync(path.join(h, bad[0]), 'utf8'), corrupt);
    } finally {
      p.kill('SIGTERM');
    }
  });

  console.log(`\n${passed} checks passed`);
  finish(0);
})().catch(e => {
  console.error('\nFAILED:', e);
  finish(1);
});

function finish(code) {
  try { sh(`pkill -f "${HOME}/pty" || true`); } catch {}
  try { server.kill('SIGTERM'); } catch {}
  setTimeout(() => process.exit(code), 200);
}
