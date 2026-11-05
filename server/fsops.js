'use strict';
// File tree, read/write and lightweight watching for the open worktree.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const { run, which, within, safeToDelete, realpath, isGitDir } = require('./util');
const { isWSL, powershell } = require('./notify');

const MAX_EDIT_SIZE = 8 * 1024 * 1024;
const HIDDEN = new Set(['.git']);

let linkRoots = () => [];
/** Where symlinks may lead: every repo and worktree SkiffCode knows (a function returning real paths). */
function setLinkRoots(fn) {
  linkRoots = fn;
}

/**
 * Where a path really leads, even when its tail doesn't exist yet: the existing part is resolved,
 * and dangling links are followed to the target they would create. null for a link loop.
 */
function realTarget(p) {
  const rest = [];
  let cur = p;
  for (let hops = 0; hops < 40;) {
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return path.join(cur, ...rest);
      rest.unshift(path.basename(cur));
      cur = up;
      continue;
    }
    try {
      return path.join(fs.realpathSync(cur), ...rest);
    } catch (e) {
      if (!st.isSymbolicLink()) throw e;
    }
    cur = path.resolve(fs.realpathSync(path.dirname(cur)), fs.readlinkSync(cur));
    hops++;
  }
  return null;
}

/** Does `abs` (inside `root`) really lead inside `root` or another known folder? noFollow: judge a link itself, not its target. */
function realInside(root, abs, noFollow = false) {
  const real = noFollow ? (r => r && path.join(r, path.basename(abs)))(realTarget(path.dirname(abs))) : realTarget(abs);
  return !!real && [realpath(root), ...linkRoots()].some(r => within(r, real));
}

/** The path of `p` in `root`, as given (not resolved), so watch keys and change events match the client's paths. */
function guard(root, p, { noFollow = false } = {}) {
  const abs = path.resolve(root, p);
  if (!within(root, abs)) throw new Error('Path is outside the worktree');
  if (abs !== path.resolve(root) && !realInside(root, abs, noFollow)) throw new Error('That link leads outside the folders SkiffCode knows');
  return abs;
}

/** Entries of one directory: folders first, with ignored ones flagged (dimmed in the UI). */
async function list(root, rel = '') {
  const dir = guard(root, rel);
  const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  const entries = dirents
    .filter(d => !HIDDEN.has(d.name))
    .map(d => {
      let type = d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'link' : 'file';
      if (type === 'link') {
        try {
          type = fs.statSync(path.join(dir, d.name)).isDirectory() ? 'dir' : 'file';
        } catch {
          type = 'file';
        }
      }
      return { name: d.name, path: path.posix.join(rel.split(path.sep).join('/'), d.name), type };
    });
  if (entries.length && isGitDir(root)) {
    const out = await run('git', ['check-ignore', '--stdin', '-z'], {
      cwd: root,
      input: entries.map(e => (e.type === 'dir' ? e.path + '/' : e.path)).join('\0'),
    }).catch(e => e.stdout || '');
    const ignored = new Set(out.split('\0').filter(Boolean).map(p => p.replace(/\/$/, '')));
    for (const e of entries) if (ignored.has(e.path)) e.ignored = true;
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.type === 'dir' ? -1 : 1));
  return entries;
}

async function read(root, rel) {
  const abs = guard(root, rel);
  const st = await fs.promises.stat(abs);
  if (!st.isFile()) throw new Error(`Not a file: ${rel}`);
  if (st.size > MAX_EDIT_SIZE) return { tooLarge: true, size: st.size, mtime: st.mtimeMs };
  const buf = await fs.promises.readFile(abs);
  const binary = buf.subarray(0, 8000).includes(0);
  return { text: binary ? '' : buf.toString('utf8'), binary, size: st.size, mtime: st.mtimeMs };
}

/** Write a file; refuses when it changed on disk since `expectMtime` (unless force). */
async function write(root, rel, text, expectMtime, force) {
  const abs = guard(root, rel);
  if (!force && expectMtime) {
    try {
      const st = await fs.promises.stat(abs);
      if (Math.abs(st.mtimeMs - expectMtime) > 1) {
        const e = new Error('The file changed on disk since you opened it.');
        e.code = 'CONFLICT';
        throw e;
      }
    } catch (e) {
      if (e.code === 'CONFLICT') throw e;
    }
  }
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, text);
  return { mtime: (await fs.promises.stat(abs)).mtimeMs };
}

async function create(root, rel, type) {
  const abs = guard(root, rel);
  if (fs.existsSync(abs)) throw new Error(`${rel} already exists`);
  if (type === 'dir') await fs.promises.mkdir(abs, { recursive: true });
  else {
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, '');
  }
}

async function rename(root, from, to) {
  const a = guard(root, from, { noFollow: true });
  const b = guard(root, to, { noFollow: true });
  if (fs.existsSync(b)) throw new Error(`${to} already exists`);
  await fs.promises.mkdir(path.dirname(b), { recursive: true });
  await fs.promises.rename(a, b);
}

const MAX_UPLOAD = 50 * 1024 * 1024;
/** Write a dropped file (base64) into the worktree. Refuses to overwrite unless replace. */
async function upload(root, rel, base64, replace) {
  const abs = guard(root, rel);
  if (abs === path.resolve(root)) throw new Error('Pick a file name');
  if (fs.existsSync(abs)) {
    if (!replace) { const e = new Error(`${rel} already exists`); e.code = 'EXISTS'; throw e; }
    if (fs.statSync(abs).isDirectory()) throw new Error(`${rel} is a folder`);
  }
  const data = Buffer.from(String(base64 || ''), 'base64');
  if (data.length > MAX_UPLOAD) throw new Error(`${path.basename(rel)} is over 50 MB`);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, data);
}

async function remove(root, rel) {
  const abs = guard(root, rel, { noFollow: true });
  if (abs === path.resolve(root) || !safeToDelete(abs)) throw new Error('Refusing to delete that');
  await fs.promises.rm(abs, { recursive: true, force: true });
}

/**
 * Watches the folders a client has expanded and the files it has open
 * (one non-recursive watcher each), so even huge trees stay cheap.
 */
class Watcher {
  constructor(onChange) {
    this.onChange = onChange; // (absPath) => void
    this.watchers = new Map(); // abs -> { w, refs }
  }
  add(abs) {
    const e = this.watchers.get(abs);
    if (e) return void e.refs++;
    try {
      const w = fs.watch(abs, { persistent: false }, (_ev, name) => this.onChange(abs, name ? String(name) : undefined));
      w.on('error', () => this.drop(abs));
      this.watchers.set(abs, { w, refs: 1 });
    } catch { /* gone */ }
  }
  remove(abs) {
    const e = this.watchers.get(abs);
    if (!e) return;
    if (--e.refs <= 0) this.drop(abs);
  }
  drop(abs) {
    const e = this.watchers.get(abs);
    if (!e) return;
    try { e.w.close(); } catch { /* ignore */ }
    this.watchers.delete(abs);
  }
}

/**
 * A string for a PowerShell script in single quotes. PowerShell also treats the curly single quotes as
 * quotes, and a doubled quote is the only escape: this is what keeps a file name from ending the string.
 */
const psQuote = s => `'${String(s).replace(/['\u2018\u2019\u201A\u201B]/g, q => q + q)}'`;

/**
 * A PowerShell script that shows `windowsPath` in Explorer and brings the window to the front.
 * PowerShell starts Explorer because WSL quotes a whole argument, giving "/select,C:\a b" (which Explorer
 * rejects) instead of /select,"C:\a b". The key press comes first because Windows only lets the process
 * that got the last input take the foreground; F24 (0x87) is used by no app. If no new window shows up
 * the script ends quietly: the window opened, it just can't be raised.
 */
function revealScript(windowsPath) {
  const parts = windowsPath.split('\\').filter(Boolean);
  const folder = parts.length > 1 ? parts[parts.length - 2] : ''; // Explorer titles the window with the parent
  return `$ProgressPreference='SilentlyContinue'
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;
public static class SkiffReveal{
 delegate bool P(IntPtr h,IntPtr l);
 [DllImport("user32.dll")] static extern bool EnumWindows(P p,IntPtr l);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern void keybd_event(byte v,byte s,uint f,UIntPtr e);
 public static List<IntPtr> Windows(){var r=new List<IntPtr>();EnumWindows((h,l)=>{var c=new StringBuilder(64);GetClassName(h,c,64);if(c.ToString()=="CabinetWClass"&&IsWindowVisible(h))r.Add(h);return true;},IntPtr.Zero);return r;}
 public static string Title(IntPtr h){var t=new StringBuilder(256);GetWindowText(h,t,256);return t.ToString();}
}
'@
$old=[SkiffReveal]::Windows()
Start-Process explorer.exe -ArgumentList ('/select,"' + ${psQuote(windowsPath)} + '"')
$h=$null
$sw=[Diagnostics.Stopwatch]::StartNew()
while(-not $h -and $sw.ElapsedMilliseconds -lt 3000){ foreach($x in [SkiffReveal]::Windows()){ if($old -notcontains $x){$h=$x} }; if(-not $h){Start-Sleep -Milliseconds 50} }
if(-not $h){ $prefix=${psQuote(`${folder} - `)}; foreach($x in [SkiffReveal]::Windows()){ if([SkiffReveal]::Title($x).StartsWith($prefix,[StringComparison]::Ordinal)){$h=$x} } }
if(-not $h){exit 0}
[SkiffReveal]::keybd_event(0x87,0,0,[UIntPtr]::Zero);[SkiffReveal]::keybd_event(0x87,0,2,[UIntPtr]::Zero)
[SkiffReveal]::SetForegroundWindow($h) | Out-Null
`;
}

/**
 * The commands that show `abs` in the system file manager, in the order to try them.
 * `windowsPath` (WSL only) is `abs` as Windows names it.
 */
function revealCommands(abs, { wsl, windowsPath }) {
  if (wsl) {
    const enc = Buffer.from(revealScript(windowsPath), 'utf16le').toString('base64');
    return [{ file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', enc] }];
  }
  // dbus-send splits an array:string value on commas, so a comma in a file name must be escaped
  const uri = pathToFileURL(abs).href.replace(/,/g, '%2C');
  return [
    { file: 'dbus-send', args: ['--session', '--dest=org.freedesktop.FileManager1', '--type=method_call', '/org/freedesktop/FileManager1', 'org.freedesktop.FileManager1.ShowItems', `array:string:${uri}`, 'string:'] },
    { file: 'xdg-open', args: [path.dirname(abs)] },
  ];
}

const REVEAL_WAIT_MS = 2000;

/**
 * Starts one command with no shell and no stdin. Resolves true if it started and did not fail, false otherwise.
 * A command still running after REVEAL_WAIT_MS has started: it is left to run (a file manager from xdg-open
 * stays up, and the PowerShell script can take longer on a busy machine), or killed when `killOnWait` is set
 * (dbus-send hanging means no file manager answered).
 */
function startCommand(cmd, { killOnWait }) {
  return new Promise(resolve => {
    let timer;
    const done = ok => { clearTimeout(timer); resolve(ok); };
    // like notify.js: detached, so a Windows program gets no controlling terminal to be suspended on
    const child = spawn(cmd.file, cmd.args, { stdio: 'ignore', detached: true, cwd: fs.existsSync('/mnt/c') && isWSL() ? '/mnt/c' : undefined });
    child.on('error', () => done(false));
    child.on('exit', code => done(code === 0));
    timer = setTimeout(() => {
      if (killOnWait) { try { child.kill(); } catch { /* gone already */ } return done(false); }
      child.unref();
      done(true);
    }, REVEAL_WAIT_MS);
  });
}

/** Shows an existing file or folder in the system file manager (Explorer on WSL). Throws if none could be started. */
async function reveal(abs) {
  const wsl = isWSL();
  let windowsPath;
  if (wsl) windowsPath = (await run('wslpath', ['-w', abs], { timeout: 5000 }).catch(() => '')).trim();
  if (wsl && !windowsPath) throw new Error('Could not open a file manager.');
  for (const cmd of revealCommands(abs, { wsl, windowsPath })) {
    const exe = wsl ? powershell() : which(cmd.file);
    if (!exe) continue;
    if (await startCommand({ ...cmd, file: exe }, { killOnWait: cmd.file === 'dbus-send' })) return;
  }
  throw new Error('Could not open a file manager.');
}

module.exports = { revealScript, revealCommands, reveal, list, read, write, create, rename, remove, upload, guard, realInside, setLinkRoots, Watcher, MAX_UPLOAD };
