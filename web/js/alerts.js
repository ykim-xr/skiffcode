// "Needs you" alerts: sound, toast, desktop notification,
// and an unread count in the window title. If several SkiffCode tabs are open,
// only the one you used last makes noise.
import { store, session, needsYou, subscribe } from './store.js';
import { toast, dismissToast } from './dialogs.js';
import { readStored } from './util.js';

const me = Math.random().toString(36).slice(2);
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('skiffcode') : null;
let leader = me;
function claim() {
  leader = me;
  try { localStorage.setItem('skiffcode.leader', me); } catch { /* private mode */ }
  if (channel) channel.postMessage({ leader: me });
}
if (channel) channel.onmessage = e => { if (e.data && e.data.leader) leader = e.data.leader; };
window.addEventListener('focus', claim);
document.addEventListener('visibilitychange', () => { if (!document.hidden) claim(); });
claim();
const isLeader = () => leader === me || readStored('skiffcode.leader') === me;

// Sounds are files (built-in ones in /sounds, yours in /custom-sounds): the same ones the server
// plays when no window is open. Settings → Sounds picks one per alert, plus the volume.
export function soundUrl(id) {
  if (!id || id === 'none') return null;
  if (id.startsWith('custom:')) return `/custom-sounds/${encodeURIComponent(id.slice(7))}`;
  return `/sounds/${encodeURIComponent(id)}.wav`;
}

const cache = new Map();
/** Play one sound now (used by alerts and by the preview buttons). volume: 0–100. */
export function playSoundId(id, volume = store.settings.volume) {
  const url = soundUrl(id);
  if (!url) return;
  let a = cache.get(url);
  if (!a) { a = new Audio(url); a.preload = 'auto'; cache.set(url, a); }
  try {
    a.pause();
    a.currentTime = 0;
    a.volume = Math.max(0, Math.min(1, volume / 100));
    void a.play().catch(() => {});
  } catch { /* no audio device */ }
}

let lastSound = 0;
export function playSound(kind) {
  if (store.prefs.muted || !store.settings.sound) return;
  if (Date.now() - lastSound < 700) return;
  lastSound = Date.now();
  playSoundId((store.settings.sounds || {})[kind]);
}

export function notificationsAllowed() {
  return 'Notification' in window && Notification.permission === 'granted';
}
export async function askNotifications() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.requestPermission();
}

const TEXT = { question: 'is asking you a question', permission: 'needs permission', done: 'finished' };
const ICON = { question: 'question', permission: 'shield', done: 'check' };

// A "waiting for you" toast goes away once that session isn't waiting any more (answered, cancelled, stopped).
const waiting = new Set();
subscribe(() => {
  for (const id of waiting) {
    const s = session(id);
    if (!s || !needsYou(s.state)) { dismissToast(`session:${id}`); waiting.delete(id); }
  }
});

export function handleAlert({ sessionId, kind }, { show, isViewing }) {
  const s = session(sessionId);
  if (!s) return;
  const mode = store.settings.alerts;
  if (mode === 'off' || (mode === 'needsYou' && kind === 'done')) return;
  if (!isLeader() || isViewing(sessionId)) return;
  playSound(kind);
  const repo = (store.repos.find(r => r.path === s.repoPath) || {}).name || '';
  const where = `${repo}${s.branch ? ` / ${s.branch}` : ''}`;
  // one toast per session: a newer alert replaces the older one
  toast(`${s.name} ${TEXT[kind]} — ${where}`, { key: `session:${sessionId}`, icon: ICON[kind], kind: kind === 'done' ? 'ok' : 'warn', timeout: kind === 'done' ? 6000 : 15000, actions: [{ label: 'Show', action: () => show(sessionId) }] });
  if (kind !== 'done') waiting.add(sessionId);
  if ((document.hidden || !document.hasFocus()) && store.settings.desktopNotifications && notificationsAllowed()) {
    const n = new Notification(`${s.name} ${TEXT[kind]}`, { body: where, tag: `skiffcode-${sessionId}`, silent: true, icon: '/icons/icon-192.png' });
    n.onclick = () => {
      window.focus();
      show(sessionId);
      n.close();
    };
  }
}

/** "(2) SkiffCode" in the title, and a dot on the tab icon, while something needs you. */
export function updateTitle(activeName) {
  const need = store.sessions.filter(s => needsYou(s.state)).length;
  const unread = store.sessions.filter(s => s.unread).length;
  const n = Math.max(need, unread);
  document.title = `${n ? `(${n}) ` : ''}${activeName ? `${activeName} — ` : ''}SkiffCode`;
  const link = document.querySelector('link[rel=icon]');
  if (link) link.href = n ? '/icons/icon-alert.svg' : '/icons/icon.svg';
}
