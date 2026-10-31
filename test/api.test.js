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
const { Client } = require('./client');

const APP = path.resolve(__dirname, '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skiffcode-api-')));
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

process.env.FAKE_LOG = path.join(tmp, 'claude-calls.jsonl');
process.env.FAKE_SCRIPT_FILE = path.join(tmp, 'plan.txt');
const plan = s => fs.writeFileSync(process.env.FAKE_SCRIPT_FILE, s);
const calls = () => (fs.existsSync(process.env.FAKE_LOG) ? fs.readFileSync(process.env.FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);

// Claude's own config folder for the default account, with the user's own status line
const CLAUDE_HOME = path.join(tmp, 'claude-home');
fs.mkdirSync(CLAUDE_HOME, { recursive: true });
fs.writeFileSync(path.join(CLAUDE_HOME, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'echo user-line', padding: 1 } }));

const repo = path.join(tmp, 'code', 'myapp');
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
sh(`git init -q -b main && git config user.email t@t && git config user.name t && printf 'line1\\nline2\\n' > README.md && printf 'def greet(name):\\n    return name\\n' > src/app.py && printf '.btn-primary { color: red; }\\n' > src/site.css && echo .env > .gitignore && git add . && git commit -qm init && echo SECRET=1 > .env`, repo);

let server;
function startServer() {
  server = spawn('node', [path.join(APP, 'server', 'main.js')], {
    env: { ...process.env, SKIFFCODE_HOME: HOME, SKIFFCODE_PORT: String(PORT), SHELL: '/bin/bash', SKIFFCODE_ALERT_LOG: path.join(tmp, 'alerts.jsonl'), CLAUDE_CONFIG_DIR: CLAUDE_HOME, SKIFFCODE_STALL_MS: '2500' },
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
    c.input(shell.id, 'echo "sum=$((20+22))"; stty size\r');
    await until(() => /sum=42/.test(c.term.get(shell.id) || '') && /25 90/.test(c.term.get(shell.id) || ''), 'shell output');
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
    c.input(s.id, 'stty -echo; wc -c | sed s/^/count=/; stty echo\r');
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

  await step('symlinks: only into folders SkiffCode knows; deleting a link keeps its target; `..name` files; FIFOs', async () => {
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
    const stt = await c.call('worktrees.status', { path: wt, fresh: true });
    assert.equal(stt.ahead, 1);
    assert.equal(stt.dirty, 1);
    assert.ok(stt.insertions >= 2);
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
    await sleep(500);
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

  await step('subagents: listed per session with type + description; finished / stopped tracked; memory readout', async () => {
    plan('SessionStart,UserPromptSubmit,Agent:Explore:Find auth code,AgentBg:general-purpose:Run the tests,AgentAsync:security-reviewer:Review auth,sleep:800,AgentDone:1,Stop,hang');
    const s3 = await c.call('sessions.create', { kind: 'claude', worktreePath: wt, cols: 80, rows: 24 });
    const agentsOf = async () => ((await c.call('hello')).sessions.find(x => x.id === s3.id) || {}).agents || [];
    const all = await until(async () => { const a = await agentsOf(); return a.length === 3 && a.every(x => x.state === 'running') && a; }, 'three running subagents');
    assert.deepEqual(all.map(a => [a.type, a.description, !!a.background]), [['Explore', 'Find auth code', false], ['general-purpose', 'Run the tests', true], ['security-reviewer', 'Review auth', true]]);
    const after = await until(async () => { const a = await agentsOf(); return a[0] && a[0].state === 'done' && a; }, 'first subagent done');
    assert.deepEqual(after.slice(1).map(a => a.state), ['running', 'running'], 'background subagents (asked for, or moved there by Claude) keep running after Claude stops');
    assert.ok(after[0].endedAt >= after[0].startedAt);
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

  await step('accounts: add, sign in, per-account config, usage from the status line, sign out', async () => {
    let st = await c.call('accounts.status', { fresh: true });
    assert.equal(st.length, 1);
    assert.equal(st[0].loggedIn, false);
    const a = await c.call('accounts.add', { name: 'Client X', share: true });
    assert.equal(a.dir, path.join(HOME, 'accounts', 'client-x'));
    assert.equal(fs.readlinkSync(path.join(a.dir, 'settings.json')), path.join(CLAUDE_HOME, 'settings.json'), 'settings shared');
    await c.call('accounts.setActive', { id: a.id });
    assert.equal((await c.call('hello')).activeAccount, a.id);
    // sign in: a shell tab runs `claude auth login` with that account's config folder
    const login = await c.call('accounts.login', { id: a.id, worktreePath: wt });
    assert.equal(login.kind, 'shell');
    assert.match(login.name, /sign in · Client X/);
    await until(() => fs.existsSync(path.join(a.dir, 'fake-login.json')), 'login wrote to the account folder');
    st = await c.call('accounts.status', { fresh: true });
    const mine = st.find(x => x.id === a.id);
    assert.equal(mine.loggedIn, true);
    assert.equal(mine.email, 'me@client-x.test');
    assert.equal(mine.org, 'Org client-x');
    assert.equal(st.find(x => x.id === 'default').loggedIn, false);
    // a new Claude session uses the active account, and reports usage through the status line
    plan('SessionStart,UserPromptSubmit,Status:42.4:17,Stop,hang');
    const before = calls().length;
    const s2 = await c.call('sessions.create', { kind: 'claude', worktreePath: wt, cols: 80, rows: 24 });
    await until(() => calls().length > before, 'claude launched');
    const call2 = calls().at(-1);
    assert.equal(call2.configDir, a.dir);
    assert.equal(call2.userStatusLine, 'echo user-line', "user's own status line still runs");
    const { claudeBin } = require('../server/accounts');
    assert.equal(claudeBin('claude --dangerously-skip-permissions'), 'claude');
    assert.equal(claudeBin('node /x/claude.js --flag'), 'node /x/claude.js');
    const u = await until(() => c.last('usage')?.data[a.id], 'usage event');
    assert.equal(u.fiveHour.used, 42.4);
    assert.equal(u.weekly.used, 17);
    assert.ok(Math.abs(u.fiveHour.resetsAt - (Date.now() + 7200e3)) < 60e3);
    await until(() => /user-line/.test(fs.readFileSync(process.env.FAKE_LOG + '.status', 'utf8')), 'user status line output');
    assert.equal(JSON.parse(fs.readFileSync(path.join(HOME, 'usage.json'), 'utf8'))[a.id].weekly.used, 17);
    const snap = await until(async () => (await c.call('hello')).sessions.find(x => x.id === s2.id && x.model), 'model info');
    assert.equal(snap.model, 'Opus');
    assert.equal(snap.contextPct, 12);
    assert.equal(snap.account, a.id);
    // can't remove an account that running sessions use
    await assert.rejects(c.call('accounts.remove', { id: a.id }), /Close the sessions/);
    await c.call('accounts.rename', { id: a.id, name: 'Client Y' });
    assert.equal((await c.call('hello')).accounts.find(x => x.id === a.id).name, 'Client Y');
    await c.call('accounts.logout', { id: a.id });
    assert.equal((await c.call('accounts.status', { fresh: true })).find(x => x.id === a.id).loggedIn, false);
    // tidy up: back to the default account, sessions closed, account removed
    await c.call('accounts.setActive', { id: 'default' });
    // ended sessions still use it: they are named
    await c.call('sessions.stop', { id: s2.id });
    await c.call('sessions.stop', { id: login.id });
    await assert.rejects(c.call('accounts.remove', { id: a.id }), /Close the sessions.*sign in · Client X/);
    await c.call('sessions.forget', { id: s2.id });
    await c.call('sessions.forget', { id: login.id });
    // removing signs it out (its credentials go); shared settings and its other files stay
    const cred = path.join(a.dir, '.credentials.json');
    fs.writeFileSync(cred, '{}');
    const shared = fs.readFileSync(path.join(CLAUDE_HOME, 'settings.json'), 'utf8');
    await c.call('accounts.remove', { id: a.id });
    assert.ok(!fs.existsSync(cred), 'credentials removed');
    assert.ok(fs.lstatSync(path.join(a.dir, 'settings.json')).isSymbolicLink(), 'the settings link is kept');
    assert.equal(fs.readFileSync(path.join(CLAUDE_HOME, 'settings.json'), 'utf8'), shared, 'shared settings untouched');
    const h2 = await c.call('hello');
    assert.deepEqual(h2.accounts.map(x => x.id), ['default']);
    assert.equal(h2.activeAccount, 'default');
    assert.equal(calls()[0].configDir, CLAUDE_HOME, 'default account keeps your CLAUDE_CONFIG_DIR');
  });

  await step('a Claude command whose path has spaces starts Claude and checks sign-in', async () => {
    const dir = path.join(tmp, 'my tools');
    fs.mkdirSync(dir);
    fs.symlinkSync(path.join(__dirname, 'fake-claude.js'), path.join(dir, 'claude'));
    await c.call('settings.set', { values: { claudeCommand: path.join(dir, 'claude') } });
    try {
      plan('SessionStart,hang');
      const before = calls().length;
      const s = await c.call('sessions.create', { kind: 'claude', worktreePath: wt, cols: 80, rows: 24 });
      await until(() => calls().length > before, 'claude launched');
      const st = await c.call('accounts.status', { fresh: true });
      assert.deepEqual([st[0].loggedIn, st[0].unknown], [false, undefined], '`claude auth status` ran');
      await c.call('sessions.forget', { id: s.id });
    } finally {
      await c.call('settings.set', { values: { claudeCommand: path.join(__dirname, 'fake-claude.js') } });
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
    const cliEnv = { ...process.env, SKIFFCODE_APP: APP, SKIFFCODE_HOME: HOME, SKIFFCODE_PORT: String(PORT) };
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
    const r = spawnSync('node', [path.join(APP, 'server', 'main.js')], { env: { ...process.env, SKIFFCODE_HOME: HOME, SKIFFCODE_PORT: String(PORT + 2) }, encoding: 'utf8', timeout: 8000 });
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
      cli3('url');
      assert.equal(fs.readFileSync(path.join(h3, 'server.log.1'), 'utf8'), 'old run\n', 'the previous log is kept');
      assert.equal(fs.statSync(path.join(h3, 'server.log')).mode & 0o777, 0o600);
      const pid3 = Number(fs.readFileSync(path.join(h3, 'server.pid'), 'utf8'));
      assert.match(cli3('stop'), /stopped/);
      assert.throws(() => process.kill(pid3, 0), 'the server it started is stopped');
      assert.ok(!fs.existsSync(path.join(h3, 'server.pid')), 'server.pid removed on a clean exit');
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
    // only this run's fake Claude processes: its cmdline has no HOME, so match FAKE_LOG in its environ
    const mine = sh(`for p in $(pgrep -f "^node [^ ]*fake-claude[.]js" || true); do tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null | grep -qxF "FAKE_LOG=$FAKE_LOG" && echo $p; done; true`).trim();
    assert.equal(mine, '', 'Claude process stopped');
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
    const cliEnv = { ...process.env, SKIFFCODE_APP: APP, SKIFFCODE_HOME: HOME, SKIFFCODE_PORT: String(PORT) };
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
    sh('git init -q -b main', w);
    await until(async () => (await c.call('hello')).repos.find(r => r.path === w).kind === undefined, 'folder became a repo');
    await sleep(600); // the announcement's own git.changed
    c.events.length = 0;
    sh('git add a.txt', w); // only .git/index changes, which only the git watcher sees
    await until(() => c.events.some(e => e.event === 'git.changed' && e.data.root === w), 'git.changed after git init');
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
    assert.match(r1.branchError, /could not remove reference/);
    fs.rmSync(path.join(base, '.git', 'refs', 'heads', 'stuck.lock'));
    const wip = await c.call('worktrees.create', { repo: base, newBranch: 'wip', base: 'main', startClaude: false });
    sh('git commit -q --allow-empty -m unmerged', wip.path);
    const r2 = await c.call('worktrees.remove', { repo: base, path: wip.path, deleteBranch: true });
    assert.equal(r2.branch, 'unmerged');
    await c.call('repos.remove', { path: base });
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
    const p3 = spawn('node', [path.join(APP, 'server', 'main.js')], { env: { ...process.env, PATH: bin, SKIFFCODE_HOME: h3, SKIFFCODE_PORT: String(PORT + 3), SHELL: '/bin/bash' }, stdio: 'ignore' });
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
    const env = { ...process.env, SKIFFCODE_HOME: h, SKIFFCODE_PORT: String(PORT + 1) };
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
