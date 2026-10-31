'use strict';
// Alerts from the server itself, for when no SkiffCode window is open:
// on WSL through Windows (PowerShell sound + toast), on Linux via paplay/notify-send.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { which, run } = require('./util');

let wsl;
function isWSL() {
  if (wsl === undefined) {
    try {
      wsl = !!process.env.WSL_DISTRO_NAME || /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
    } catch {
      wsl = false;
    }
  }
  return wsl;
}

function quiet(cmd, args, cwd) {
  const c = spawn(cmd, args, { stdio: 'ignore', detached: true, cwd });
  c.on('error', () => {});
  c.unref();
}

function powershell() {
  if (which('powershell.exe')) return which('powershell.exe');
  const p = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  return fs.existsSync(p) ? p : undefined;
}

function runPS(script) {
  const ps = powershell();
  if (!ps) return;
  const enc = Buffer.from(script, 'utf16le').toString('base64');
  quiet(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], fs.existsSync('/mnt/c') ? '/mnt/c' : undefined);
}

const psq = s => String(s).replace(/'/g, "''");
const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let winSoundDir; // a promise of the Windows temp folder for sounds, or null
function windowsSoundDir() {
  if (!winSoundDir) {
    const opts = { cwd: fs.existsSync('/mnt/c') ? '/mnt/c' : undefined, timeout: 5000, input: '' }; // input '': cmd.exe must not inherit a pipe that never closes
    winSoundDir = (async () => {
      const temp = (await run('cmd.exe', ['/d', '/c', 'echo %TEMP%'], opts)).trim();
      const dir = path.join((await run('wslpath', ['-u', temp], { timeout: 5000 })).trim(), 'skiffcode-sounds');
      await fs.promises.mkdir(dir, { recursive: true });
      return dir;
    })().catch(() => null);
  }
  return winSoundDir;
}

/** The Windows path of a sound file, copied to the Windows temp folder first (again when its content changed). */
async function windowsSoundPath(file) {
  const dir = await windowsSoundDir();
  if (!dir) return undefined;
  const dst = path.join(dir, path.basename(file));
  try {
    const src = await fs.promises.readFile(file);
    const old = await fs.promises.readFile(dst).catch(() => null);
    if (!old || !old.equals(src)) await fs.promises.writeFile(dst, src);
    return (await run('wslpath', ['-w', dst], { timeout: 5000 })).trim();
  } catch {
    return undefined;
  }
}

/** Play a sound file at a volume (0–1): Windows (from WSL) or PipeWire / PulseAudio / ALSA. */
function playFile(file, volume = 0.7) {
  if (!file) return;
  const v = Math.max(0, Math.min(1, Number(volume)));
  if (v === 0) return;
  if (isWSL()) {
    void windowsSoundPath(file).then(win => {
      if (!win) return;
      // MediaPlayer plays wav/mp3 and has a volume (SoundPlayer has neither)
      runPS([
        'Add-Type -AssemblyName PresentationCore',
        '$p = New-Object System.Windows.Media.MediaPlayer',
        `$p.Open([Uri]'${psq(win)}')`,
        `$p.Volume = ${v.toFixed(2)}`,
        'Start-Sleep -Milliseconds 250',
        '$p.Play()',
        'Start-Sleep -Seconds 5',
        '$p.Close()',
      ].join('; '));
    });
    return;
  }
  if (which('pw-play')) return quiet(which('pw-play'), ['--volume', v.toFixed(2), file]);
  if (which('paplay')) return quiet(which('paplay'), [`--volume=${Math.round(v * 65536)}`, file]);
  if (which('aplay') && file.endsWith('.wav')) return quiet(which('aplay'), ['-q', file]);
}

function desktopNotify(title, body) {
  if (isWSL()) {
    const t = `<toast><visual><binding template="ToastGeneric"><text>${xml(title)}</text><text>${xml(body)}</text></binding></visual><audio silent="true"/></toast>`;
    runPS([
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
      '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
      '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
      `$x.LoadXml('${psq(t)}')`,
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))",
    ].join('; '));
    return;
  }
  const ns = which('notify-send');
  if (ns) quiet(ns, ['-a', 'SkiffCode', title, body]);
}

const TEXT = { question: 'is asking you a question', permission: 'needs permission', done: 'finished' };

/** Called when nobody has SkiffCode open. */
function alertWithoutWindow({ session, kind, repoName, settings, muted, soundFile }) {
  const mode = settings.alerts || 'all';
  if (mode === 'off' || (mode === 'needsYou' && kind === 'done')) return;
  const title = `${session.name} ${TEXT[kind]}`;
  const body = `${repoName}${session.branch ? ` / ${session.branch}` : ''} — open SkiffCode to answer`;
  if (process.env.SKIFFCODE_ALERT_LOG) {
    // tests: record instead of making noise
    fs.appendFileSync(process.env.SKIFFCODE_ALERT_LOG, JSON.stringify({ kind, title, body, sound: settings.sound !== false && !muted && soundFile ? path.basename(soundFile) : false, volume: settings.volume ?? 70 }) + '\n');
    return;
  }
  if (settings.sound !== false && !muted) playFile(soundFile, (settings.volume ?? 70) / 100);
  if (settings.desktopNotifications !== false) desktopNotify(title, body);
}

module.exports = { alertWithoutWindow, playFile, desktopNotify };
