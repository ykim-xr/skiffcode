'use strict';
// Drives the real SkiffCode UI in Chromium against a real server.
// SKIFFCODE_VENDOR=test/stub-vendor uses stand-ins for Monaco/xterm; omit it to test the real libraries.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
// Playwright: `npm i -g playwright && npx playwright install chromium`, or point PLAYWRIGHT_PATH at it.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');

const APP = path.resolve(__dirname, '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skiffcode-ui-')));
const HOME = path.join(tmp, 'home');
const PORT = 3950 + Math.floor(Math.random() * 40);
const SHOTS = process.env.SHOTS || path.join(tmp, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const sh = (cmd, cwd) => execFileSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0;
const step = async (name, fn) => { await fn(); passed++; console.log(`  ✓ ${name}`); };

process.env.FAKE_LOG = path.join(tmp, 'claude-calls.jsonl');
process.env.FAKE_SCRIPT_FILE = path.join(tmp, 'plan.txt');
const plan = s => fs.writeFileSync(process.env.FAKE_SCRIPT_FILE, s);

const repo = path.join(tmp, 'code', 'myapp');
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
sh(`git init -q -b main && git config user.email t@t && git config user.name t && printf 'line1\\nline2\\n' > README.md && printf 'def greet(name):\\n    return name\\n' > src/app.py && printf 'body { color: red; }\\n' > src/site.css && git add . && git commit -qm init`, repo);
const other = path.join(tmp, 'code', 'other');
fs.mkdirSync(other);
sh('git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m x', other);

const server = spawn('node', [path.join(APP, 'server', 'main.js')], {
  env: { ...process.env, SKIFFCODE_HOME: HOME, SKIFFCODE_PORT: String(PORT), SHELL: '/bin/bash', CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-home'), SKIFFCODE_VENDOR: process.env.SKIFFCODE_VENDOR || path.join(APP, 'vendor') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', d => process.stderr.write(`[server] ${d}`));

// A tiny local web app for the web-page viewer: /ok can be framed, /deny refuses (X-Frame-Options)
const webPort = PORT + 100;
const web = `http://127.0.0.1:${webPort}`;
require('http').createServer((req, res) => {
  if (req.url === '/deny') res.writeHead(200, { 'Content-Type': 'text/html', 'X-Frame-Options': 'DENY' });
  else res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<h1>local app</h1>');
}).listen(webPort, '127.0.0.1').unref();

/** A w×h PNG, for the image viewer. */
function png(w, hgt) {
  const zlib = require('zlib');
  const crc = buf => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(hgt, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * hgt);
  for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 217; raw[o + 1] = 119; raw[o + 2] = 87; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const G = {};
(async () => {
  console.log(`SkiffCode UI e2e (tmp: ${tmp}, vendor: ${process.env.SKIFFCODE_VENDOR ? 'stubs' : 'real'})`);
  for (let i = 0; i < 100 && !fs.existsSync(path.join(HOME, 'server.pid')); i++) await sleep(50);
  const token = fs.readFileSync(path.join(HOME, 'token'), 'utf8').trim();

  const browser = (G.browser = await chromium.launch());
  const context = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://localhost:${PORT}` });
  const page = (G.page = await context.newPage());
  const errors = (G.errors = []);
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const shot = name => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

  await page.goto(`http://localhost:${PORT}/?tkn=${token}`);
  await page.waitForSelector('#sidebar .sidebar-title', { timeout: 15000 });

  await step('first run: welcome, add repo through the UI', async () => {
    await page.waitForSelector('.sidebar-empty');
    await page.evaluate(c => import('/js/rpc.js').then(r => r.call('settings.set', { values: { claudeCommand: c } })), `node ${path.join(__dirname, 'fake-claude.js')}`);
    await page.click('.sidebar-empty .btn');
    await page.waitForSelector('.browse-modal .browse-list > *');
    await page.fill('.browse-modal .input', path.join(tmp, 'code'));
    await page.keyboard.press('Enter');
    await page.waitForSelector('.browse-item.repo >> text=myapp');
    assert.equal(await page.locator('.browse-item.repo').count(), 2, 'git repos are marked');
    await shot('00-add-repo');
    await page.click('.browse-item.repo:has-text("myapp")');
    await page.waitForSelector('.browse-modal .btn.primary >> text=Add myapp');
    await page.click('.browse-modal .btn.primary');
    await page.waitForSelector('.repo-row >> text=myapp');
    await page.waitForSelector('.wt-row.active >> text=main');
    await page.waitForSelector('.workspace:not(.hidden) .file-row >> text=README.md');
  });

  await step('files panel opens a file in the editor; edit + Ctrl+S saves to disk', async () => {
    await page.click('.workspace:not(.hidden) .file-row >> text=src');
    await page.click('.workspace:not(.hidden) .file-row >> text=app.py');
    await page.waitForSelector('.workspace:not(.hidden) .tab.active >> text=app.py');
    await page.waitForFunction(() => window.skiffcode.active.activeTab && window.skiffcode.active.activeTab.entry && window.skiffcode.active.activeTab.editor);
    assert.match(await page.evaluate(() => window.skiffcode.active.activeTab.entry.model.getValue()), /def greet/);
    await page.evaluate(() => window.skiffcode.active.activeTab.entry.model.setValue('def greet(name):\n    return f"hi {name}"\n'));
    await page.waitForSelector('.workspace:not(.hidden) .tab.dirty');
    await page.evaluate(() => window.skiffcode.active.activeTab.save());
    await page.waitForFunction(() => !document.querySelector('.workspace:not(.hidden) .tab.dirty'));
    assert.match(fs.readFileSync(path.join(repo, 'src/app.py'), 'utf8'), /hi \{name\}/);
    assert.ok(!(await page.locator('.workspace:not(.hidden) .tab.preview').count()), 'editing pins a preview tab');
  });

  await step('source control: change shows up, stage, commit through the UI', async () => {
    await page.click('.workspace:not(.hidden) .right-tab >> text=Changes');
    await page.waitForSelector('.workspace:not(.hidden) .scm-item >> text=app.py');
    await page.hover('.workspace:not(.hidden) .scm-item:has-text("app.py")');
    await page.click('.workspace:not(.hidden) .scm-item:has-text("app.py") button[title=Stage]');
    await page.waitForSelector('.workspace:not(.hidden) .scm-section-title >> text=Staged changes');
    await page.fill('.workspace:not(.hidden) .commit-msg', 'Friendlier greeting');
    await page.click('.workspace:not(.hidden) .commit-btn');
    await page.waitForSelector('.toast >> text=Committed.');
    assert.equal(sh('git log -1 --format=%s', repo).trim(), 'Friendlier greeting');
    await shot('01-scm');
  });

  await step('commits expand to their files; a file opens its diff for that commit', async () => {
    const W = '.workspace:not(.hidden)';
    const tabs = await page.locator(`${W} .tab`).count();
    await page.click(`${W} .commit-item:has-text("Friendlier greeting")`);
    await page.waitForSelector(`${W} .commit-file >> text=app.py`);
    assert.equal(await page.locator(`${W} .tab`).count(), tabs, 'clicking a commit opens nothing in the center');
    await shot('01b-commit-files');
    await page.click(`${W} .commit-file:has-text("app.py")`);
    const short = sh('git log -1 --format=%h', repo).trim();
    await page.waitForSelector(`${W} .tab.active >> text=app.py (${short})`);
    await page.waitForFunction(() => { const t = window.skiffcode.active.activeTab; const m = t.view && t.view.editor.getModel(); return m && m.modified && /hi \{name\}/.test(m.modified.getValue()) && /return name/.test(m.original.getValue()); });
    await page.click(`${W} .commit-item:has-text("Friendlier greeting")`);
    await page.waitForSelector(`${W} .commit-file`, { state: 'detached' });
  });

  await step('history pane lists every commit of the branch; one expands to its files', async () => {
    const W = '.workspace:not(.hidden)';
    await page.waitForSelector(`${W} .scm-history .commit-item:has-text("Friendlier greeting")`);
    await page.click(`${W} .scm-history .commit-item:has-text("init")`);
    await page.waitForSelector(`${W} .scm-history .commit-file >> text=README.md`);
    await page.click(`${W} .scm-history .commit-item:has-text("init")`);
    await page.waitForSelector(`${W} .scm-history .commit-file`, { state: 'detached' });
  });

  await step('panel colors: presets, live preview, saved; terminals follow', async () => {
    const bg = v => page.evaluate(n => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), v);
    await page.click('.sb-item[title="Panel colors"]');
    await page.waitForSelector('.colors-modal');
    await page.click('.colors-modal .btn >> text=Black center');
    assert.equal(await bg('--center-bg'), '#000000', 'live preview');
    await page.click('.colors-modal .btn >> text=Cancel');
    assert.equal(await bg('--center-bg'), '#1f1f1f', 'cancel restores');
    await page.click('.sb-item[title="Panel colors"]');
    await page.click('.colors-modal .btn >> text=Black center');
    await page.fill('.colors-modal .color-hex[data-panel="sidebar"]', '#101010');
    await page.click('.colors-modal .btn >> text=Save');
    await page.waitForSelector('.colors-modal', { state: 'detached' });
    assert.equal(await bg('--panel-sidebar'), '#101010');
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('sidebar')).backgroundColor), 'rgb(16, 16, 16)');
    for (let i = 0; i < 40 && !JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8')).prefs.settings?.colors; i++) await sleep(50);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8')).prefs.settings.colors, { center: '#000000', bottom: '#000000', sidebar: '#101010' });
  });

  await step('new worktree from the sidebar: Claude starts there in its own workspace', async () => {
    plan('SessionStart,hang');
    await page.hover('.repo-row:has-text("myapp")');
    await page.click('.repo-row:has-text("myapp") .row-actions button');
    await page.waitForSelector('.worktree-form');
    assert.equal(await page.inputValue('.worktree-form .form-row:has-text("Base branch") input'), 'main', 'default base preselected');
    await page.fill('.worktree-form .form-row:has-text("New branch name") input', 'main');
    await page.waitForSelector('.worktree-form .modal-error:has-text("already exists")');
    await page.fill('.worktree-form .form-row:has-text("New branch name") input', 'feat/login');
    await page.waitForSelector('.worktree-form .form-hint:has-text("myapp.worktrees/feat-login")');
    await shot('02a-worktree-form');
    await page.click('.worktree-form .btn.primary');
    await page.waitForSelector('.wt-row.active >> text=feat/login', { timeout: 15000 });
    await page.waitForSelector('.workspace:not(.hidden) .tab.active >> text=feat/login', { timeout: 10000 });
    await page.waitForSelector('.session-row >> text=feat/login');
    await page.waitForFunction(() => document.querySelectorAll('.workspace').length === 2);
    await shot('02-worktree');
  });

  await step('terminals use the panel color', async () => {
    await page.waitForFunction(() => { const t = window.skiffcode.active.activeTab; return t && t.term && t.term.options.theme && t.term.options.theme.background === '#000000'; });
  });

  await step('drag and drop files: from Explorer into a folder, within the Files panel, onto an editor pane and onto sessions', async () => {
    const W = '.workspace:not(.hidden)';
    const wt = await page.evaluate(() => window.skiffcode.active.root);
    const drop = (sel, { files, internal, at } = {}) => page.evaluate(({ sel, files, internal, at }) => {
      const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
      const dt = new DataTransfer();
      for (const f of files || []) dt.items.add(new File([f.text], f.name, { type: f.type || 'text/plain' }));
      if (internal) { dt.setData('application/x-skiffcode-path', JSON.stringify(internal)); dt.setData('text/plain', internal.path); }
      const r = el.getBoundingClientRect();
      const p = { clientX: r.left + r.width * (at ? at[0] : 0.5), clientY: r.top + r.height * (at ? at[1] : 0.5) };
      for (const type of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, ...p }));
    }, { sel, files, internal, at });
    await page.click(`${W} .right-tab >> text=Files`);
    await page.waitForSelector(`${W} .file-row >> text=src`);
    // from Explorer onto the "src" folder → copied in
    await drop(`${W} .file-row[data-path="src"]`, { files: [{ name: 'notes.txt', text: 'hello' }] });
    await page.waitForSelector('.toast >> text=Copied 1 file into src');
    assert.equal(fs.readFileSync(path.join(wt, 'src', 'notes.txt'), 'utf8'), 'hello');
    // again → asks before replacing
    await drop(`${W} .file-row[data-path="src"]`, { files: [{ name: 'notes.txt', text: 'hello v2' }] });
    await page.waitForSelector('.modal-title >> text=Replace src/notes.txt?');
    await page.click('.modal .btn >> text=Replace');
    for (let i = 0; i < 40 && fs.readFileSync(path.join(wt, 'src', 'notes.txt'), 'utf8') !== 'hello v2'; i++) await sleep(50);
    assert.equal(fs.readFileSync(path.join(wt, 'src', 'notes.txt'), 'utf8'), 'hello v2');
    // within the Files panel: drag src/notes.txt onto the empty area → moved to the top folder
    await page.waitForSelector(`${W} .file-row[data-path="src/notes.txt"]`);
    await drop(`${W} .file-tree`, { internal: { root: wt, path: 'src/notes.txt', type: 'file' }, at: [0.5, 0.97] });
    for (let i = 0; i < 40 && !fs.existsSync(path.join(wt, 'notes.txt')); i++) await sleep(50);
    assert.ok(fs.existsSync(path.join(wt, 'notes.txt')) && !fs.existsSync(path.join(wt, 'src', 'notes.txt')), 'moved');
    // onto the editor area (a pane showing Claude) → the file opens in that pane
    // a shell to see what gets typed
    // the Claude session in the top pane gets @path
    await drop(`${W} .row-top .term-body:not(.hidden)`, { internal: { root: wt, path: 'notes.txt', type: 'file' } });
    await page.waitForFunction(() => [...document.querySelectorAll('.workspace:not(.hidden) .row-top .stub-term')].some(p => p.textContent.includes('@notes.txt')));
    // a shell (bottom panel) gets the full path
    await page.click(`${W} .row-top .tabbar-actions button[title^="New shell"]`);
    await page.waitForFunction(() => { const t = window.skiffcode.active.activeTab; return t && t.session && t.session.kind === 'shell' && t.attached; });
    await sleep(500);
    const shellSel = `${W} .row-bottom .term-body:not(.hidden)`;
    await drop(shellSel, { internal: { root: wt, path: 'notes.txt', type: 'file' } });
    await page.waitForFunction(p => (window.skiffcode.active.activeTab.term.text || '').includes(p), `${wt}/notes.txt`);
    // a Claude session gets @path (checked through the shell, which echoes what's typed)
    await page.evaluate(async () => {
      const { dropOnTerminal } = await import('/js/dnd.js');
      const t = window.skiffcode.active.activeTab;
      const dt = new DataTransfer();
      dt.setData('application/x-skiffcode-path', JSON.stringify({ root: t.ws.root, path: 'src/app.py', type: 'file' }));
      const fake = { session: { id: t.sessionId, kind: 'claude' }, ws: t.ws, focus() {} };
      await dropOnTerminal(fake, new DragEvent('drop', { dataTransfer: dt }), null);
    });
    await page.waitForFunction(() => (window.skiffcode.active.activeTab.term.text || '').includes('@src/app.py'));
    // from Explorer onto a session → saved under SkiffCode's drops folder, path typed
    await drop(shellSel, { files: [{ name: 'screen shot.png', text: 'PNG', type: 'image/png' }] });
    await page.waitForFunction(() => /\/drops\/\d{4}-\d\d-\d\d\/screen-shot\.png/.test(window.skiffcode.active.activeTab.term.text || ''));
    const day = fs.readdirSync(path.join(HOME, 'drops'))[0];
    assert.equal(fs.readFileSync(path.join(HOME, 'drops', day, 'screen-shot.png'), 'utf8'), 'PNG');
    // right-click: copies the selection, or pastes when nothing is selected; Ctrl+C copies a selection
    const host = `${shellSel} .term-host`;
    await page.evaluate(() => window.skiffcode.active.activeTab.term.select('copied-by-right-click'));
    await page.click(host, { button: 'right' });
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'copied-by-right-click');
    assert.equal(await page.evaluate(() => window.skiffcode.active.activeTab.term.hasSelection()), false, 'selection cleared');
    await page.evaluate(() => navigator.clipboard.writeText('echo pasted-$((6*7))'));
    await page.click(host, { button: 'right' });
    await page.waitForFunction(() => (window.skiffcode.active.activeTab.term.text || '').includes('echo pasted-$((6*7))'));
    await page.evaluate(() => { const t = window.skiffcode.active.activeTab; t.term.select('via-ctrl-c'); t.term.focus(); });
    await page.keyboard.press('Control+c');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'via-ctrl-c');
    // text dragged in (e.g. from the editor) is typed
    await page.evaluate(sel => {
      const el = document.querySelector(sel);
      const dt = new DataTransfer();
      dt.setData('text/plain', 'dragged-text');
      for (const type of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, shellSel);
    await page.waitForFunction(() => (window.skiffcode.active.activeTab.term.text || '').includes('dragged-text'));
    const shellId = await page.evaluate(() => window.skiffcode.active.activeTab.sessionId);
    await page.evaluate(i => import('/js/rpc.js').then(r => r.call('sessions.forget', { id: i })), shellId);
    await page.waitForFunction(() => { const t = window.skiffcode.active.activeTab; return t && t.kind === 'session' && t.session && t.session.kind === 'claude'; });
    // a file from the Files panel onto a pane showing a file → opens there
    await page.click(`${W} .file-row >> text=README.md`);
    await page.waitForSelector(`${W} .row-top .tab.active >> text=README.md`);
    await drop(`${W} .row-top .pane-body`, { internal: { root: wt, path: 'notes.txt', type: 'file' }, at: [0.4, 0.4] });
    await page.waitForSelector(`${W} .row-top .tab.active >> text=notes.txt`);
    for (const name of ['notes.txt', 'README.md']) await page.click(`${W} .row-top .tab:has-text("${name}") .tab-close`);
    fs.rmSync(path.join(wt, 'notes.txt'));
  });

  await step('switching worktrees is instant and keeps each one’s tabs', async () => {
    const t0 = Date.now();
    await page.click('.wt-row >> text=main');
    await page.waitForSelector('.wt-row.active >> text=main');
    await page.waitForSelector('.workspace:not(.hidden) .tab >> text=app.py');
    const switchMs = Date.now() - t0;
    assert.equal(await page.locator('.workspace').count(), 2, 'both workspaces stay loaded');
    await page.click('.wt-row >> text=feat/login');
    await page.waitForSelector('.workspace:not(.hidden) .tab.active >> text=feat/login');
    assert.ok(!(await page.locator('.workspace:not(.hidden) .tab >> text=app.py').count()), 'tabs are per worktree');
    console.log(`      switch took ${switchMs} ms (incl. clicks)`);
  });

  await step('a new terminal gets the full width of its pane right away (not a default size)', async () => {
    await page.click('.workspace:not(.hidden) .row-top .tabbar-actions button[title^="New shell"]');
    await page.waitForFunction(() => { const t = window.skiffcode.active.activeTab; return t && t.kind === 'session' && t.attached && t.session && t.session.kind === 'shell'; });
    await sleep(700);
    const { id, cols } = await page.evaluate(() => { const t = window.skiffcode.active.activeTab; return { id: t.sessionId, cols: t.term.cols }; });
    // the terminal fills its pane (a style once shrank tabs to their content)
    const fill = await page.evaluate(() => { const t = window.skiffcode.active.activeTab; const pane = t.el.closest('.pane-body').getBoundingClientRect(); const r = t.el.getBoundingClientRect(); return { w: r.width / pane.width, h: r.height / pane.height }; });
    assert.ok(fill.w > 0.98 && fill.h > 0.98, `terminal fills its pane (${Math.round(fill.w * 100)}% × ${Math.round(fill.h * 100)}%)`);
    const expect = await page.evaluate(() => Math.floor(window.skiffcode.active.activeTab.host.clientWidth / 8));
    assert.equal(cols, expect, 'the tab fills its pane');
    assert.notEqual(cols, 120, 'not the default size');
    await page.evaluate(i => import('/js/rpc.js').then(r => r.sendInput(i, 'stty size\r')), id);
    await page.waitForFunction(c => new RegExp(`\\b\\d+ ${c}\\b`).test(window.skiffcode.active.activeTab.term.text || ''), cols, { timeout: 8000 });
    await page.evaluate(i => import('/js/rpc.js').then(r => r.call('sessions.forget', { id: i })), id);
  });

  await step('a shell in the worktree: type a command, see output', async () => {
    await page.click('.workspace:not(.hidden) .tabbar-actions button[title^="New shell"]');
    await page.waitForSelector('.workspace:not(.hidden) .row-bottom .tab.active >> text=shell');
    await sleep(500);
    const id = await page.evaluate(() => window.skiffcode.active.activeTab.sessionId);
    await page.evaluate(i => import('/js/rpc.js').then(r => r.sendInput(i, 'echo "answer=$((40+2))"\r')), id);
    await page.waitForFunction(() => /answer=42/.test(window.skiffcode.active.activeTab.term.text || window.skiffcode.active.activeTab.term.buffer?.active?.getLine?.(0)?.translateToString?.() || ''), null, { timeout: 8000 }).catch(async () => {
      const txt = await page.evaluate(() => { const t = window.skiffcode.active.activeTab.term; const b = t.buffer && t.buffer.active; let s = ''; if (b) for (let i = 0; i < b.length; i++) s += b.getLine(i).translateToString(true) + '\n'; return s || t.text; });
      assert.match(txt, /answer=42/);
    });
  });

  await step('bottom panel: split down, hide/show, and the layout survives a reload', async () => {
    await page.keyboard.press('Control+p');
    await page.waitForSelector('.qp-input');
    await page.keyboard.type('README');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.workspace:not(.hidden) .row-top .tab.active >> text=README.md');
    await page.click('.workspace:not(.hidden) .row-top .tab:has-text("README.md")', { button: 'right' });
    await page.click('.menu-item >> text=Split down (bottom panel)');
    await page.waitForSelector('.workspace:not(.hidden) .row-bottom .tab >> text=README.md');
    await page.click('.workspace:not(.hidden) .row-bottom .tab:has-text("README.md")', { button: 'right' });
    await page.click('.menu-item >> text=Split right');
    await page.waitForFunction(() => document.querySelectorAll('.workspace:not(.hidden) .row-bottom .pane').length === 2);
    await shot('02b-panels');
    await page.keyboard.press('Control+Shift+Backquote');
    await page.waitForSelector('.workspace:not(.hidden) .row-bottom.hidden', { state: 'attached' });
    await page.keyboard.press('Control+Shift+Backquote');
    await page.waitForSelector('.workspace:not(.hidden) .row-bottom:not(.hidden)');
    await sleep(700); // layout is saved shortly after changes
    await page.reload();
    await page.waitForSelector('.wt-row.active >> text=feat/login', { timeout: 15000 });
    await page.waitForSelector('.workspace:not(.hidden) .row-bottom .tab >> text=README.md');
    await page.waitForSelector('.workspace:not(.hidden) .row-bottom .tab >> text=shell');
    await page.waitForSelector('.workspace:not(.hidden) .row-top .tab >> text=feat/login');
    assert.equal(await page.locator('.workspace:not(.hidden) .row-bottom .pane').count(), 2, 'bottom split restored');
    // put README back on top for the next steps
    await page.click('.workspace:not(.hidden) .row-bottom .tab:has-text("README.md")', { button: 'right' });
    await page.click('.menu-item >> text=Move up to the main area');
    await page.waitForSelector('.workspace:not(.hidden) .row-top .tab >> text=README.md');
  });

  await step('Claude asks a question while you look elsewhere → icon, toast, unread badge', async () => {
    await page.click('.wt-row >> text=main');
    plan('SessionStart,sleep:300,UserPromptSubmit,sleep:300,PreToolUse:AskUserQuestion,hang');
    const s = await page.evaluate(() => import('/js/store.js').then(m => m.store.sessions.find(x => x.kind === 'claude')));
    await page.evaluate(id => import('/js/rpc.js').then(r => r.call('sessions.stop', { id }).then(() => r.call('sessions.resume', { id }))), s.id);
    await page.waitForSelector('.session-row .st-question', { timeout: 10000 });
    await page.waitForSelector('.toast >> text=is asking you a question');
    // a second alert for the same session replaces its toast (one per session)
    await page.evaluate(id => import('/js/alerts.js').then(m => m.handleAlert({ sessionId: id, kind: 'permission' }, { show: i => window.skiffcode.actions.focusSession(i), isViewing: () => false })), s.id);
    await page.waitForSelector('.toast >> text=needs permission');
    assert.equal(await page.locator('.toast:has-text("feat/login")').count(), 1, 'one toast per session');
    await page.waitForSelector('.session-row .need-pill.st-question'); // the session itself shows it (no repeated badges while expanded)
    assert.match(await page.title(), /^\(1\)/);
    await shot('03-question');
    await page.click('.toast button >> text=Show');
    await page.waitForSelector('.wt-row.active >> text=feat/login');
    await page.waitForFunction(() => !document.querySelector('.session-row.unread'));
    // answering (here Esc) clears "waiting for you": the toast goes away by itself
    await page.evaluate(id => import('/js/alerts.js').then(m => m.handleAlert({ sessionId: id, kind: 'question' }, { show() {}, isViewing: () => false })), s.id);
    await page.waitForSelector('.toast.warn >> text=is asking you a question');
    await page.evaluate(id => import('/js/rpc.js').then(async r => { await r.call('term.open', { id, cols: 100, rows: 30 }); r.sendInput(id, '\x1b'); }), s.id);
    await page.waitForSelector('.toast.warn', { state: 'detached', timeout: 5000 });
  });

  await step('sidebar lists Claude sessions only, with the Claude icon; rename and close stay in sync', async () => {
    const W = '.workspace:not(.hidden)';
    // the shell in the bottom panel is not in the sidebar
    assert.ok(await page.evaluate(() => import('/js/store.js').then(m => m.store.sessions.some(s => s.kind === 'shell'))));
    assert.equal(await page.locator('.session-row:has-text("shell")').count(), 0, 'no shells in the sidebar');
    assert.equal(await page.locator('.session-row').count(), 1);
    await page.waitForSelector('.session-row .row-icon'); // (answered above, so no longer asking)
    // rename from the tab → sidebar follows
    await page.dblclick(`${W} .row-top .tab:has-text("feat/login")`);
    await page.fill('.modal .input', 'login work');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.session-row >> text=login work');
    await page.waitForSelector(`${W} .row-top .tab >> text=login work`);
    // rename from the sidebar → tab follows
    await page.dblclick('.session-row:has-text("login work")');
    await page.fill('.modal .input', 'login flow');
    await page.keyboard.press('Enter');
    await page.waitForSelector(`${W} .row-top .tab >> text=login flow`);
    await page.waitForSelector('.session-row >> text=login flow');
    // closing the shell tab removes the shell
    await page.hover(`${W} .row-bottom .tab:has-text("shell")`);
    await page.click(`${W} .row-bottom .tab:has-text("shell") .tab-close`);
    await page.waitForFunction(() => import('/js/store.js').then(m => !m.store.sessions.some(s => s.kind === 'shell')));
    // a second Claude session shows up in the sidebar; closing its tab removes it there too
    plan('SessionStart,hang');
    await page.click(`${W} .row-top .tabbar-actions button[title^="New Claude session"]`);
    // it asks for a name, suggesting one; that name is passed to Claude too
    await page.waitForSelector('.modal-title >> text=New Claude session');
    assert.equal(await page.inputValue('.modal .input'), 'feat/login 2');
    await page.fill('.modal .input', 'api tests');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.session-row').length === 2, null, { timeout: 10000 });
    await page.waitForSelector('.session-row >> text=api tests');
    await page.waitForSelector(`${W} .row-top .tab.active >> text=api tests`);
    const launched = fs.readFileSync(process.env.FAKE_LOG, 'utf8').trim().split('\n').map(JSON.parse).at(-1).args;
    assert.equal(launched[launched.indexOf('--name') + 1], 'api tests');
    const second = await page.evaluate(() => window.skiffcode.active.activeTab.sessionId);
    await page.waitForFunction(id => import('/js/store.js').then(m => m.store.sessions.find(s => s.id === id)?.state === 'idle'), second);
    await page.click(`${W} .row-top .tab.active .tab-close`);
    await page.click('.modal .btn >> text=Close session');
    await page.waitForFunction(() => document.querySelectorAll('.session-row').length === 1);
    await page.waitForFunction(id => import('/js/store.js').then(m => !m.store.sessions.some(s => s.id === id)), second, { timeout: 8000 });
    await shot('03b-sidebar-sync');
  });

  await step('usage in the status bar; account panel: add + sign in, switch', async () => {
    plan('SessionStart,UserPromptSubmit,Status:63:91,Stop,hang');
    const s = await page.evaluate(() => import('/js/store.js').then(m => m.store.sessions.find(x => x.kind === 'claude')));
    await page.evaluate(id => import('/js/rpc.js').then(r => r.call('sessions.stop', { id }).then(() => r.call('sessions.resume', { id }))), s.id);
    await page.waitForSelector('.sb-item.usage .usage-meter.ok:has-text("63%")', { timeout: 10000 });
    await page.waitForSelector('.sb-item.usage .usage-meter.hot:has-text("91%")');
    assert.match(await page.textContent('.sb-item.usage .usage-reset'), /^↻ (1h 5\dm|2h 0m)$/);
    assert.match(await page.getAttribute('.sb-item.usage', 'title'), /5-hour: 63% used, resets in/);
    await shot('07-usage');
    await page.click('.sb-item.usage');
    await page.waitForSelector('.accounts-modal .account.active >> text=Default');
    await page.waitForSelector('.accounts-modal .account-who >> text=Not signed in');
    await page.click('.accounts-modal .btn >> text=Add account…');
    await page.fill('.modal:not(.accounts-modal) .input', 'Work');
    await page.keyboard.press('Enter');
    // sign-in runs in a shell tab in the bottom panel
    await page.waitForSelector('.workspace:not(.hidden) .row-bottom .tab >> text=sign in · Work', { timeout: 10000 });
    await page.waitForSelector('.toast >> text=Finish signing in');
    const dir = path.join(HOME, 'accounts', 'work');
    for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, 'fake-login.json')); i++) await sleep(50);
    assert.ok(fs.existsSync(path.join(dir, 'fake-login.json')), 'signed in with the Work config folder');
    await page.click('.sb-item.usage');
    await page.waitForSelector('.accounts-modal .account:has-text("Work") .account-who >> text=me@work.test', { timeout: 10000 });
    await page.click('.accounts-modal .account:has-text("Work") .account-name');
    await page.waitForSelector('.accounts-modal .account.active:has-text("Work")');
    await shot('08-accounts');
    await page.click('.accounts-modal .btn >> text=Done');
    await page.waitForSelector('.sb-item.usage .usage-acct >> text=Work');
    assert.equal(await page.locator('.sb-item.usage .usage-meter.unknown').count(), 2, 'no usage reported for Work yet');
    const st = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8'));
    assert.equal(st.prefs.activeAccount, st.prefs.accounts[0].id);
    // back to Default for the rest
    await page.evaluate(() => import('/js/rpc.js').then(r => r.call('accounts.setActive', { id: 'default' })));
    await page.waitForSelector('.sb-item.usage .usage-acct >> text=Default');
  });

  await step('Active panel (needs you + working, by repo) and subagents in the sidebar; collapsible; click opens', async () => {
    await page.click('.wt-row >> text=main');
    await page.waitForSelector('.wt-row.active >> text=main');
    plan('SessionStart,UserPromptSubmit,Agent:Explore:Find auth code,sleep:500,PreToolUse:AskUserQuestion,sleep:6000,AgentDone:1,hang');
    const s = await page.evaluate(() => import('/js/store.js').then(m => m.store.sessions.find(x => x.kind === 'claude')));
    await page.evaluate(id => import('/js/rpc.js').then(r => r.call('sessions.stop', { id }).then(() => r.call('sessions.resume', { id }))), s.id);
    await page.waitForSelector('.active-panel .active-row >> text=login flow', { timeout: 10000 });
    await page.waitForSelector('.session-row:has-text("login flow") .agent-count >> text=1 agent');
    assert.equal(await page.locator('.agent-row').count(), 0, 'subagents start folded into the count');
    await page.waitForSelector('.active-panel .active-row.need >> text=login flow', { timeout: 10000 });
    assert.equal(await page.locator('.active-panel .panel-repo').count(), 0, 'flat list, no repo headings');
    assert.match(await page.textContent('.active-panel .active-row'), /login flow\s*myapp · feat\/login/);
    await page.waitForSelector('.session-row:has-text("login flow") .need-pill >> text=asking');
    // badges only where the session is hidden: none while everything is expanded
    assert.equal(await page.locator('.repo-row .badge.need, .wt-row .badge.need').count(), 0);
    await page.click('.wt-row:has-text("feat/login") .twisty');
    await page.waitForSelector('.wt-row:has-text("feat/login") .badge.need');
    await page.click('.wt-row:has-text("feat/login") .twisty');
    // the count opens the subagent list (with its type), and the arrow folds it again
    await page.click('.session-row:has-text("login flow") .agent-count');
    await page.waitForSelector('.agent-row:has-text("Find auth code") >> text=Explore');
    await shot('09-active-panel');
    await page.click('.session-row:has-text("login flow") .twisty-hit');
    await page.waitForSelector('.agent-row', { state: 'detached' });
    await page.click('.session-row:has-text("login flow") .twisty-hit');
    await page.waitForSelector('.agent-row >> text=Find auth code');
    await page.click('.active-panel .panel-head');
    await page.waitForSelector('.active-panel .panel-body', { state: 'detached' });
    await page.click('.active-panel .panel-head');
    // click → that session, right away
    await page.click('.active-panel .active-row >> text=login flow');
    await page.waitForSelector('.wt-row.active >> text=feat/login');
    assert.equal(await page.evaluate(id => window.skiffcode.active.activeTab.sessionId === id, s.id), true);
    // a finished subagent disappears
    await page.waitForSelector('.agent-row', { state: 'detached', timeout: 12000 });
    assert.equal(await page.locator('.session-row:has-text("login flow") .agent-count').count(), 0);
  });

  await step('idle worktrees unload (sessions keep running) and come back from their layout; memory readout', async () => {
    await page.waitForSelector('.sb-item:has(.icon-chip)', { timeout: 35000 });
    assert.match(await page.getAttribute('.sb-item:has(.icon-chip)', 'title'), /Claude sessions \(1\)/);
    assert.equal(await page.locator('.workspace').count(), 2);
    await page.click('.sb-item:has(.icon-chip)');
    await page.waitForSelector('.toast >> text=Unloaded 1 worktree');
    assert.equal(await page.locator('.workspace').count(), 1, 'the other worktree was unloaded');
    await page.waitForSelector('.sb-item:has(.icon-chip) >> text=1/2');
    await page.click('.wt-row >> text=main');
    await page.waitForSelector('.workspace:not(.hidden) .tab >> text=app.py');
    assert.equal(await page.locator('.workspace').count(), 2);
    await page.click('.wt-row >> text=feat/login');
    await page.waitForSelector('.wt-row.active >> text=feat/login');
    assert.ok(await page.evaluate(() => import('/js/store.js').then(m => m.store.sessions.some(x => x.kind === 'claude' && x.state !== 'ended'))), 'Claude kept running');
  });

  await step('adding a repo with earlier Claude conversations offers them; resume one as a SkiffCode session', async () => {
    const third = path.join(tmp, 'code', 'third');
    fs.mkdirSync(third);
    sh('git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m x', third);
    const id = '12345678-aaaa-4bbb-8ccc-1234567890ab';
    const proj = path.join(tmp, 'claude-home', 'projects', third.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, `${id}.jsonl`), [
      { type: 'user', cwd: third, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Refactor the payment webhooks' } },
      { type: 'user', cwd: third, message: { role: 'user', content: 'and add retries' } },
    ].map(x => JSON.stringify(x)).join('\n') + '\n');
    plan('SessionStart,hang');
    await page.evaluate(p => import('/js/rpc.js').then(r => r.call('repos.add', { path: p })), third);
    await page.waitForSelector('.repo-row >> text=third');
    await page.evaluate(p => window.skiffcode.openWorktree(p), third);
    await page.waitForSelector('.toast >> text=Found 1 earlier Claude conversation', { timeout: 10000 });
    await page.click('.toast:has-text("earlier Claude conversation") button >> text=Show');
    await page.waitForSelector('.resume-item >> text=Refactor the payment webhooks');
    assert.match(await page.textContent('.resume-item .resume-meta'), /2 prompts/);
    await page.fill('.resume-modal .input', 'nothing like this');
    await page.waitForSelector('.resume-empty >> text=No conversations match');
    await page.fill('.resume-modal .input', 'payment');
    await shot('10-resume');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.resume-modal', { state: 'detached' });
    await page.waitForSelector('.workspace:not(.hidden) .tab.active >> text=Refactor the payment webhooks');
    await page.waitForSelector('.session-row >> text=Refactor the payment webhooks');
    const resumed = () => fs.readFileSync(process.env.FAKE_LOG, 'utf8').trim().split('\n').map(JSON.parse).some(l => l.args[l.args.indexOf('--resume') + 1] === id && l.cwd === third);
    for (let i = 0; i < 40 && !resumed(); i++) await sleep(50); // the stand-in Claude logs as it starts
    assert.ok(resumed(), 'Claude resumed that conversation in that folder');
    // the paste box takes the line Claude prints on exit; an open conversation isn't duplicated
    await page.click('.wt-row:has-text("main") >> nth=-1', { button: 'right' });
    await page.click('.menu-item >> text=Resume Claude conversation…');
    await page.waitForSelector('.resume-item >> text=open in SkiffCode');
    await page.fill('.resume-modal .input', `claude --resume ${id}`);
    await page.waitForSelector('.resume-modal .btn.primary >> text=Resume pasted ID');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.resume-modal', { state: 'detached' });
    assert.equal(await page.evaluate(i => import('/js/store.js').then(m => m.store.sessions.filter(s => s.claudeId === i).length), id), 1);
    await page.click('.wt-row >> text=feat/login');
    await page.waitForSelector('.wt-row.active >> text=feat/login');
  });

  await step('review changes vs base: file list + diff with the live file on the right', async () => {
    const wt = await page.evaluate(() => window.skiffcode.active.root);
    fs.writeFileSync(path.join(wt, 'README.md'), 'line1\nline2 changed\n');
    fs.writeFileSync(path.join(wt, 'new.css'), '.x{}\n');
    await page.click('.workspace:not(.hidden) .right-tab >> text=Changes');
    await page.waitForSelector('.workspace:not(.hidden) .review-link');
    await page.click('.workspace:not(.hidden) .review-link');
    await page.waitForSelector('.workspace:not(.hidden) .review-file >> text=README.md');
    await page.waitForSelector('.workspace:not(.hidden) .review-file >> text=new.css');
    await page.click('.workspace:not(.hidden) .review-file >> text=README.md');
    await page.waitForSelector('.workspace:not(.hidden) .review-file.selected >> text=README.md');
    await sleep(300);
    await page.waitForFunction(() => { const t = window.skiffcode.active.activeTab; const m = t.view && t.view.editor.getModel && t.view.editor.getModel(); return m && m.modified && m.modified.getValue() === 'line1\nline2 changed\n'; });
    const sides = await page.evaluate(() => { const t = window.skiffcode.active.activeTab; const m = t.view.editor.getModel(); return { left: m.original.getValue(), right: m.modified.getValue(), live: !!t.view.entry }; });
    assert.equal(sides.left, 'line1\nline2\n', 'left = base version');
    assert.equal(sides.live, true, 'right side is the real (editable) file');
    await shot('04-review');
  });

  await step('search panel and quick open', async () => {
    await page.keyboard.press('Control+Shift+F');
    await page.fill('.workspace:not(.hidden) .search-view .search-row .input', 'greet');
    await page.waitForSelector('.workspace:not(.hidden) .search-hit');
    await page.click('.workspace:not(.hidden) .search-hit');
    await page.waitForSelector('.workspace:not(.hidden) .tab.active >> text=app.py');
    await page.keyboard.press('Control+p');
    await page.waitForSelector('.qp-input');
    await page.keyboard.type('site');
    await page.waitForSelector('.qp-item.selected >> text=site.css');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.workspace:not(.hidden) .tab.active >> text=site.css');
    await shot('05-search');
  });

  await step('viewers: images and PDFs open in a tab; HTML previews live and sandboxed; web pages and links in a tab', async () => {
    const wt = await page.evaluate(() => window.skiffcode.active.root);
    fs.mkdirSync(path.join(wt, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'docs', 'logo.png'), png(40, 20));
    fs.writeFileSync(path.join(wt, 'docs', 'guide.pdf'), '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
    fs.writeFileSync(path.join(wt, 'docs', 'style.css'), '#t { color: rgb(1, 2, 3); }');
    fs.writeFileSync(path.join(wt, 'docs', 'index.html'), '<!doctype html><link rel=stylesheet href="style.css"><p id=t>v1</p><p id=probe></p>' +
      '<script>let r = []; try { parent.document.title; r.push("parent:open"); } catch { r.push("parent:blocked"); } try { localStorage.x = 1; r.push("storage:open"); } catch { r.push("storage:blocked"); } document.getElementById("probe").textContent = r.join(" ");</script>');
    await page.click('.workspace:not(.hidden) .right-tab >> text=Files');
    await page.click('.workspace:not(.hidden) .file-row >> text=docs');
    // image
    await page.click('.workspace:not(.hidden) .file-row >> text=logo.png');
    await page.waitForSelector('.workspace:not(.hidden) .tab.active >> text=logo.png');
    await page.waitForSelector('.workspace:not(.hidden) .viewer-info >> text=40 × 20');
    assert.equal(await page.evaluate(() => window.skiffcode.active.activeTab.kind), 'view');
    await page.click('.workspace:not(.hidden) .viewer-img');
    await page.waitForSelector('.workspace:not(.hidden) .viewer-info >> text=100%');
    await shot('05b-image');
    // PDF: the browser's own viewer in a frame
    await page.click('.workspace:not(.hidden) .file-row >> text=guide.pdf');
    await page.waitForSelector('.workspace:not(.hidden) .tab.active >> text=guide.pdf');
    const pdfSrc = await page.getAttribute('.workspace:not(.hidden) .tab-body:not(.hidden) .viewer-pdf iframe', 'src');
    assert.match(pdfSrc, /^\/view\/[0-9a-f]{32}\/docs\/guide\.pdf\?v=/);
    // HTML: opens as code; preview to the side, with its CSS, sandboxed, live on save
    await page.dblclick('.workspace:not(.hidden) .file-row >> text=index.html');
    await page.waitForSelector('.workspace:not(.hidden) .tab.active >> text=index.html');
    assert.equal(await page.evaluate(() => window.skiffcode.active.activeTab.kind), 'file', 'HTML still opens in the editor');
    await page.click('.workspace:not(.hidden) .pane:has(.tab.active:has-text("index.html")) .tabbar-actions .icon-btn[title="Open preview to the side"]');
    await page.waitForSelector('.workspace:not(.hidden) .tab.active >> text=Preview index.html');
    const frame = page.frameLocator('.workspace:not(.hidden) .tab-body:not(.hidden) .viewer-html iframe');
    await frame.locator('#t', { hasText: 'v1' }).waitFor();
    assert.equal(await frame.locator('#t').evaluate(e => getComputedStyle(e).color), 'rgb(1, 2, 3)', 'relative CSS loads');
    assert.equal(await frame.locator('#probe').textContent(), 'parent:blocked storage:blocked', 'the page can’t reach SkiffCode');
    assert.equal(await page.evaluate(() => window.skiffcode.active.activeTab.pane.row.panes.length > 1), true, 'opened to the side');
    fs.writeFileSync(path.join(wt, 'docs', 'index.html'), '<!doctype html><link rel=stylesheet href="style.css"><p id=t>v2</p>');
    await frame.locator('#t', { hasText: 'v2' }).waitFor({ timeout: 5000 });
    await shot('05c-html-preview');
    // web pages
    // a plain click goes to your browser; Ctrl+click opens a tab here
    const opened = await page.evaluate(u => import('/js/viewers.js').then(m => {
      const calls = [];
      const real = window.open;
      window.open = (...a) => { calls.push(a[0]); return null; };
      try { m.openLink(window.skiffcode, u, { ctrlKey: false }); } finally { window.open = real; }
      return { calls, tabs: window.skiffcode.active.allTabs().filter(t => t.kind === 'web').length };
    }), `${web}/ok`);
    assert.deepEqual(opened, { calls: [`${web}/ok`], tabs: 0 });
    await page.evaluate(u => import('/js/viewers.js').then(m => m.openLink(window.skiffcode, u, { ctrlKey: true })), `${web}/ok`);
    await page.waitForSelector(`.workspace:not(.hidden) .tab.active >> text=127.0.0.1:${webPort}`);
    await page.frameLocator('.workspace:not(.hidden) .tab-body:not(.hidden) .viewer-web iframe').locator('h1', { hasText: 'local app' }).waitFor();
    await page.fill('.workspace:not(.hidden) .tab-body:not(.hidden) .viewer-url', `${web}/deny`);
    await page.press('.workspace:not(.hidden) .tab-body:not(.hidden) .viewer-url', 'Enter');
    await page.waitForSelector('.workspace:not(.hidden) .tab-body:not(.hidden) .viewer-blocked >> text=Open in your browser');
    await shot('05d-web');
    // the layout keeps viewers and pages
    await page.evaluate(() => window.skiffcode.active.saveLayout());
    const kinds = await page.evaluate(() => window.skiffcode.active.allTabs().map(t => t.serialize()).filter(Boolean).map(x => x.kind));
    assert.ok(kinds.includes('view') && kinds.includes('web'));
    // close the extras so later steps see the usual layout
    await page.evaluate(async () => { const ws = window.skiffcode.active; for (const t of ws.allTabs()) if (['view', 'web'].includes(t.kind) || (t.kind === 'file' && t.path.startsWith('docs/'))) await ws.closeTab(t); });
  });

  await step('paths in terminal output are links: click, Ctrl+click, right-click menu; a browser tab takes paths', async () => {
    const wt = await page.evaluate(() => window.skiffcode.active.root);
    // a report outside the worktree, with its own CSS next to it
    const rep = path.join(tmp, 'reports', 'cov');
    fs.mkdirSync(rep, { recursive: true });
    fs.writeFileSync(path.join(rep, 'index.html'), '<!doctype html><link rel=stylesheet href="s.css"><h1 id=r>coverage 93%</h1>');
    fs.writeFileSync(path.join(rep, 's.css'), '#r { color: rgb(4, 5, 6); }');
    await page.click('.workspace:not(.hidden) .tabbar-actions button[title^="New shell"]');
    await page.waitForSelector('.workspace:not(.hidden) .row-bottom .tab.active >> text=shell');
    await sleep(400);
    const id = await page.evaluate(() => window.skiffcode.active.activeTab.sessionId);
    const report = path.join(rep, 'index.html');
    await page.evaluate(([i, r]) => import('/js/rpc.js').then(m => m.sendInput(i, `clear; printf '%s\\n' '⎿  Report: ${r}' 'see src/app.py:2 and README.md, not nothing/here.txt' 'and https://example.com/a/b.html'\r`)), [id, report]);
    await page.waitForFunction(i => /\nsee src/.test(window.skiffcode.active.allTabs().find(t => t.sessionId === i).term.text), id);
    await sleep(300);
    // which rows hold what (the typed command is echoed too: take the printed lines)
    const found = await page.evaluate(async i => {
      const t = window.skiffcode.active.allTabs().find(x => x.sessionId === i).term;
      const b = t.buffer.active;
      const out = [];
      for (let y = 1; y <= b.length; y++) {
        const s = b.getLine(y - 1).translateToString();
        if (/^(⎿|see |and https)/.test(s)) for (const l of await t.links(y)) out.push({ y, text: l.text, sx: l.range.start.x, ex: l.range.end.x });
      }
      return out;
    }, id);
    const texts = found.map(f => f.text);
    assert.ok(texts.includes(report), `the report path is a link: ${JSON.stringify(texts)}`);
    assert.ok(texts.includes('src/app.py:2') && texts.includes('README.md'), JSON.stringify(texts));
    assert.ok(!texts.some(t => /nothing|example\.com/.test(t)), 'only existing files, and not URLs');
    const r = found.find(f => f.text === report);
    assert.equal(r.ex - r.sx + 1, report.length, 'the underline covers the path');
    const act = (text, ev) => page.evaluate(async ([text, ev, i]) => {
      const t = window.skiffcode.active.allTabs().find(x => x.sessionId === i).term;
      for (let y = 1; y <= t.buffer.active.length; y++) for (const l of await t.links(y)) if (l.text === text) return void l.activate(ev, l.text);
    }, [text, ev, id]);
    // plain click on the report: your browser; a right-click opens nothing (the menu comes instead)
    await page.evaluate(() => { window.__opened = []; window.__realOpen = window.open; window.open = (u, n) => { const w = { opener: 1, location: { href: '' }, close() {} }; window.__opened.push(w); return w; }; });
    await act(report, { button: 2 });
    await page.evaluate(([u, i]) => import('/js/viewers.js').then(m => m.openLink(window.skiffcode, u, { button: 2 })), [`${web}/ok`, id]);
    await sleep(300);
    assert.equal(await page.evaluate(() => window.__opened.length), 0, 'right-click doesn’t open links');
    await act(report, { ctrlKey: false });
    await page.waitForFunction(() => window.__opened.length && window.__opened[0].location.href);
    const href = await page.evaluate(() => { window.open = window.__realOpen; return window.__opened[0].location.href; });
    assert.match(href, /\/view\/[0-9a-f]{32}\/index\.html$/);
    const viaBrowser = await fetch(href);
    assert.match(await viaBrowser.text(), /coverage 93%/, 'served without a cookie');
    // Ctrl+click: a preview inside SkiffCode, its CSS loading from next to it
    await act(report, { ctrlKey: true });
    await page.waitForSelector('.workspace:not(.hidden) .row-top .tab.active >> text=Preview index.html');
    const fr = page.frameLocator('.workspace:not(.hidden) .row-top .tab-body:not(.hidden) .viewer-html iframe');
    await fr.locator('#r', { hasText: 'coverage 93%' }).waitFor();
    assert.equal(await fr.locator('#r').evaluate(e => getComputedStyle(e).color), 'rgb(4, 5, 6)');
    // a plain click on code: the editor, at the line
    await act('src/app.py:2', {});
    await page.waitForSelector('.workspace:not(.hidden) .tab.active >> text=app.py');
    // right-click on a path: a menu; elsewhere still copy / paste
    await page.evaluate(async i => {
      const tab = window.skiffcode.active.allTabs().find(t => t.sessionId === i);
      const t = tab.term;
      for (let y = 1; y <= t.buffer.active.length; y++) for (const l of await t.links(y)) if (l.text === 'README.md') l.hover({}, l.text);
      tab.host.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 600 }));
    }, id);
    await page.waitForSelector('.menu-item >> text=Show in Files');
    assert.ok(await page.locator('.menu-item >> text=Open in your browser').count());
    await page.click('.menu-item >> text=Show in Files');
    await page.waitForSelector('.workspace:not(.hidden) .file-row.flash >> text=README.md');
    // globe button: a new browser tab that takes a file path
    await page.click('.workspace:not(.hidden) .row-top .tabbar-actions button[title^="New browser tab"]');
    await page.waitForSelector('.workspace:not(.hidden) .tab.active >> text=New tab');
    await page.fill('.workspace:not(.hidden) .row-top .tab-body:not(.hidden) .viewer-url', `file://${report}`);
    await page.press('.workspace:not(.hidden) .row-top .tab-body:not(.hidden) .viewer-url', 'Enter');
    await page.waitForSelector('.workspace:not(.hidden) .tab.active >> text=index.html');
    await page.frameLocator('.workspace:not(.hidden) .row-top .tab-body:not(.hidden) .viewer-web iframe').locator('#r', { hasText: 'coverage 93%' }).waitFor();
    await shot('05e-path-links');
    await page.evaluate(async i => { const ws = window.skiffcode.active; for (const t of ws.allTabs()) if (['view', 'web'].includes(t.kind) || t.sessionId === i) await ws.closeTab(t); }, id);
  });

  await step('jump palette and groups / drag-to-reorder repos', async () => {
    await page.evaluate(p => import('/js/rpc.js').then(r => r.call('repos.add', { path: p })), other);
    await page.waitForSelector('.repo-row >> text=other');
    await page.dragAndDrop('.repo-row:has-text("other")', '.repo-row:has-text("myapp")', { targetPosition: { x: 20, y: 3 } });
    await page.waitForFunction(() => document.querySelector('.repo-row .row-label').textContent === 'other');
    await page.keyboard.press('Control+Alt+j');
    await page.waitForSelector('.qp-sep >> text=Sessions');
    await page.keyboard.press('Escape');
  });

  await step('delete a session and its conversation from the sidebar', async () => {
    plan('SessionStart,hang');
    const wt = path.join(tmp, 'code', 'myapp.worktrees', 'feat-login');
    const id = await page.evaluate(p => import('/js/rpc.js').then(r => r.call('sessions.create', { kind: 'claude', worktreePath: p, name: 'throwaway', cols: 80, rows: 24 })).then(x => x.id), wt);
    await page.waitForSelector('.session-row >> text=throwaway');
    const cid = await page.evaluate(i => import('/js/store.js').then(m => m.store.sessions.find(s => s.id === i).claudeId), id);
    const proj = path.join(tmp, 'claude-home', 'projects', wt.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, `${cid}.jsonl`), JSON.stringify({ type: 'user', cwd: wt, message: { role: 'user', content: 'x' } }) + '\n');
    await page.click('.session-row:has-text("throwaway")', { button: 'right' });
    await page.click('.menu-item >> text=Delete session and conversation…');
    await page.waitForSelector('.modal-title >> text=and its conversation');
    await page.click('.modal .btn >> text=Delete session and conversation');
    await page.waitForSelector('.session-row:has-text("throwaway")', { state: 'detached' });
    for (let i = 0; i < 40 && fs.existsSync(path.join(proj, `${cid}.jsonl`)); i++) await sleep(50);
    assert.ok(!fs.existsSync(path.join(proj, `${cid}.jsonl`)), 'conversation deleted');
    // removing the worktree offers to delete its saved conversations too
    fs.writeFileSync(path.join(proj, 'cccccccc-1111-4222-8333-444444444444.jsonl'), JSON.stringify({ type: 'user', cwd: wt, message: { role: 'user', content: 'old' } }) + '\n');
  });

  await step('remove a worktree from its menu (sessions stopped, folder gone)', async () => {
    const wt = path.join(tmp, 'code', 'myapp.worktrees', 'feat-login');
    await page.click('.wt-row >> text=feat/login', { button: 'right' });
    await page.click('.menu-item >> text=Remove worktree…');
    await page.waitForSelector('.modal-title >> text=Remove worktree');
    await page.waitForSelector('.modal .purge-check >> text=Also delete Claude’s saved conversations for it (1)');
    await page.check('.modal .purge-check input');
    await page.click('.modal .btn >> text=Remove + delete branch');
    await page.waitForFunction(() => ![...document.querySelectorAll('.wt-row')].some(r => r.textContent.includes('feat/login')), null, { timeout: 15000 });
    assert.ok(!fs.existsSync(wt));
    assert.ok(!fs.existsSync(path.join(tmp, 'claude-home', 'projects', wt.replace(/[^a-zA-Z0-9]/g, '-'), 'cccccccc-1111-4222-8333-444444444444.jsonl')), 'its conversations deleted too');
    // the branch had a commit-less history? it was never pushed: SkiffCode asks before force-deleting
    if (await page.locator('.modal-title >> text=isn’t merged').count()) await page.click('.modal .btn >> text=Delete branch');
    await page.waitForSelector('.wt-row.active >> text=main');
    await shot('06-after-remove');
  });

  await step('a plain folder: added from the browser, opens with files; Changes says it isn’t git', async () => {
    const notes = path.join(tmp, 'code', 'notes');
    fs.mkdirSync(notes, { recursive: true });
    fs.writeFileSync(path.join(notes, 'plan.md'), '# plan\n');
    await page.click('.sidebar-actions button[title="Add repository or folder"]');
    await page.waitForSelector('.browse-modal .browse-list > *');
    await page.fill('.browse-modal .input', notes);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.browse-modal .btn.primary >> text=Add folder notes');
    await page.click('.browse-modal .btn.primary');
    await page.waitForSelector('.folder-row.active >> text=notes');
    await page.click('.workspace:not(.hidden) .right-tab >> text=Files');
    await page.waitForSelector('.workspace:not(.hidden) .file-row >> text=plan.md');
    await page.click('.workspace:not(.hidden) .right-tab >> text=Changes');
    await page.waitForSelector('.workspace:not(.hidden) .scm-notgit >> text=isn’t a git repository');
    await page.waitForSelector('.workspace:not(.hidden) .commit-box', { state: 'hidden' });
    await shot('11-folder');
    // `git init` in that folder (from any shell): it becomes a repo and git features appear
    sh('git init -q -b main', notes);
    await page.waitForSelector('.repo-row:not(.folder-row) >> text=notes', { timeout: 10000 });
    await page.waitForSelector('.wt-row >> text=main');
    await page.waitForSelector('.workspace:not(.hidden) .commit-box', { state: 'visible', timeout: 10000 });
    await page.waitForSelector('.workspace:not(.hidden) .scm-item >> text=plan.md');
  });

  await step('customize a repo: icon + color; dividers between entries', async () => {
    await page.click('.repo-row:has-text("myapp")', { button: 'right' });
    await page.click('.menu-item >> text=Customize…');
    await page.waitForSelector('.look-modal');
    await page.click('.look-modal .look-icon[title=rocket]');
    await page.click('.look-modal .look-color[title="#61afef"]');
    await page.waitForSelector('.look-modal .look-preview .icon-rocket');
    await page.click('.look-modal .btn >> text=Save');
    await page.waitForSelector('.repo-row:has-text("myapp") .icon-rocket');
    assert.equal(await page.evaluate(() => { const r = [...document.querySelectorAll('.repo-row')].find(x => x.textContent.includes('myapp')); return getComputedStyle(r.querySelector('.row-label')).color; }), 'rgb(97, 175, 239)');
    for (let i = 0; i < 40 && !JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8')).repos.find(r => r.name === 'myapp').icon; i++) await sleep(50);
    const saved = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8')).repos.find(r => r.name === 'myapp');
    assert.deepEqual([saved.icon, saved.color], ['i:rocket', '#61afef']);
    // an emoji works too
    await page.click('.repo-row:has-text("myapp")', { button: 'right' });
    await page.click('.menu-item >> text=Customize…');
    await page.fill('.look-modal .look-emoji', '🚀');
    await page.click('.look-modal .btn >> text=Save');
    await page.waitForSelector('.repo-row:has-text("myapp") .row-emoji >> text=🚀');
    assert.ok(await page.locator('.tree > .tree-item').count() >= 2);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelectorAll('.tree > .tree-item')[1]).borderTopStyle), 'solid', 'hairline between entries');
    await shot('12-customize');
  });

  await step('clicking a session low in a scrolled sidebar keeps the scroll position', async () => {
    await page.setViewportSize({ width: 1500, height: 360 });
    await sleep(300);
    const scrollable = await page.evaluate(() => { const t = document.querySelector('.tree'); return t.scrollHeight > t.clientHeight + 40; });
    assert.ok(scrollable, 'the sidebar scrolls at this height');
    await page.evaluate(() => { const t = document.querySelector('.tree'); t.scrollTop = t.scrollHeight; });
    const before = await page.evaluate(() => document.querySelector('.tree').scrollTop);
    assert.ok(before > 0);
    const rows = page.locator('.tree .session-row, .tree .wt-row');
    await rows.nth((await rows.count()) - 1).click();
    await sleep(800);
    const after = await page.evaluate(() => document.querySelector('.tree').scrollTop);
    assert.ok(Math.abs(after - before) < 30, `scroll kept (${before} → ${after})`);
    await page.setViewportSize({ width: 1500, height: 900 });
  });

  await step('sounds: a sound per alert, your own file, volume; alerts play your choice', async () => {
    await page.evaluate(() => {
      window.__played = [];
      HTMLMediaElement.prototype.play = function () { window.__played.push({ src: this.src, volume: this.volume }); return Promise.resolve(); };
    });
    await page.click('.sb-item:has(.icon-unmute), .sb-item:has(.icon-mute)', { button: 'right' });
    await page.waitForSelector('.sounds-modal');
    assert.equal(await page.inputValue('.sounds-modal select[data-kind=question]'), 'ding');
    await page.selectOption('.sounds-modal select[data-kind=done]', 'marimba');
    await page.selectOption('.sounds-modal select[data-kind=permission]', 'none');
    await page.evaluate(() => { const v = document.querySelector('.sounds-modal .sound-volume'); v.value = '40'; v.dispatchEvent(new Event('input')); });
    await page.waitForSelector('.sounds-modal .sound-volume-text >> text=40%');
    await page.setInputFiles('.sounds-modal input[type=file]', { name: 'bloop.wav', mimeType: 'audio/wav', buffer: fs.readFileSync(path.join(APP, 'web', 'sounds', 'pop.wav')) });
    await page.waitForSelector('.sounds-modal .sound-file-name >> text=bloop.wav');
    const custom = await page.evaluate(() => [...document.querySelector('.sounds-modal select[data-kind=question]').options].find(o => o.textContent === 'bloop.wav').value);
    await page.selectOption('.sounds-modal select[data-kind=question]', custom);
    await shot('13-sounds');
    await page.click('.sounds-modal .btn >> text=Save');
    await page.waitForSelector('.sounds-modal', { state: 'detached' });
    for (let i = 0; i < 40 && (JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8')).prefs.settings || {}).volume !== 40; i++) await sleep(50);
    const st = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8')).prefs.settings;
    assert.deepEqual([st.sounds.question, st.sounds.permission, st.sounds.done, st.volume], [custom, 'none', 'marimba', 40]);
    const played = await page.evaluate(async () => {
      const { playSound } = await import('/js/alerts.js');
      window.__played = [];
      playSound('done');
      await new Promise(r => setTimeout(r, 800));
      playSound('permission');
      await new Promise(r => setTimeout(r, 800));
      playSound('question');
      return window.__played;
    });
    assert.equal(played.length, 2, 'permission is set to no sound');
    assert.match(played[0].src, /\/sounds\/marimba\.wav$/);
    assert.ok(Math.abs(played[0].volume - 0.4) < 0.01);
    assert.match(played[1].src, /\/custom-sounds\/bloop-[0-9a-f]{6}\.wav$/);
  });

  await step('no JavaScript errors', async () => {
    const real = errors.filter(e => !/favicon|ResizeObserver loop/.test(e));
    assert.deepEqual(real, []);
  });

  console.log(`\n${passed} checks passed — screenshots in ${SHOTS}`);
  await browser.close();
  finish(0);
})().catch(async e => {
  console.error('\nFAILED:', e);
  console.error('page errors:', G.errors);
  if (G.page) await G.page.screenshot({ path: path.join(SHOTS, 'failure.png') }).catch(() => {});
  finish(1);
});

function finish(code) {
  try { sh(`pkill -f "${HOME}/pty" || true`); } catch {}
  try { server.kill('SIGTERM'); } catch {}
  setTimeout(() => process.exit(code), 200);
}
