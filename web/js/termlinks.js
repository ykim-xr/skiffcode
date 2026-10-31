// File paths in terminals (Claude's output, shells) become links, like URLs.
// Only paths that exist are underlined: candidates are checked with the server (cached briefly).
//   click        → HTML / images / PDFs: your browser; code: the editor; folders: the Files panel
//   Ctrl+click   → inside SkiffCode (a preview, viewer or the editor)
//   right-click  → a menu: open here, open in your browser, show in Files, copy
import { call } from './rpc.js';
import { toast } from './dialogs.js';
import { openPath, openLink, pathHint, pathKind } from './viewers.js';

// Linux (/…, ~/…, ./…), Windows (C:\…), WSL shares (\\wsl.localhost\…), relative (src/app.py) and bare
// file names with an extension (index.html); an optional :line or :line:col after any of them.
const PATH_RE = new RegExp([
  String.raw`\\\\wsl(?:\.localhost|\$)\\[^\s"'<>|*?]+`,
  String.raw`[A-Za-z]:\\[^\s"'<>|*?]+`,
  String.raw`(?:~|\.{1,2})?\/[^\s"'<>|*?()\[\]{},;\`]+`,
  String.raw`[\w@+-][\w.@+-]*(?:\/[\w.@+-]+)+`,
  String.raw`[\w@+-][\w@+-]*(?:\.[\w@+-]+)*\.[A-Za-z][A-Za-z0-9]{0,7}`,
].map(s => `(?:${s})`).join('|').replace(/^/, '(?:') + ')' + String.raw`(?::\d+(?::\d+)?)?`, 'g');
const URL_RE = /\b[a-z][\w+.-]*:\/\/\S+/gi;
const LEAD = /[\w/\\.:@-]$/; // a match must not start in the middle of a word or URL
const TRAIL = /[.,;:!?)\]}'"]+$/;

const cache = new Map(); // `${cwd}\n${candidate}` -> { at, info }
const TTL = 15000;

async function resolveAll(cwd, cands) {
  const now = Date.now();
  const need = [...new Set(cands.filter(c => { const e = cache.get(`${cwd}\n${c}`); return !e || now - e.at > TTL; }))];
  if (need.length) {
    let res = [];
    try { res = await call('paths.resolve', { cwd, paths: need }); } catch { res = []; }
    need.forEach((c, i) => cache.set(`${cwd}\n${c}`, { at: now, info: res[i] || null }));
    if (cache.size > 2000) for (const k of [...cache.keys()].slice(0, 1000)) cache.delete(k);
  }
  return cands.map(c => (cache.get(`${cwd}\n${c}`) || {}).info || null);
}

/** The text of the (soft-wrapped) line containing buffer row y (1-based), with each character's cell. */
function logicalLine(term, y) {
  const buf = term.buffer.active;
  let s = y - 1;
  while (s > 0 && buf.getLine(s) && buf.getLine(s).isWrapped) s--;
  let e = y - 1;
  while (buf.getLine(e + 1) && buf.getLine(e + 1).isWrapped) e++;
  let text = '';
  const at = [];
  for (let r = s; r <= e; r++) {
    const line = buf.getLine(r);
    if (!line) break;
    for (let x = 0; x < term.cols; x++) {
      const cell = line.getCell(x);
      if (!cell) break;
      if (cell.getWidth() === 0) continue; // second half of a wide character
      const ch = cell.getChars() || ' ';
      text += ch;
      for (let i = 0; i < ch.length; i++) at.push({ x: x + 1, y: r + 1 }); // one per UTF-16 unit: match offsets count units
    }
  }
  return { text, at };
}

/** Candidate paths in a line: [{ start, end, path, line, col }] (string offsets, end exclusive). */
export function findPaths(text) {
  const urls = [];
  for (const m of text.matchAll(URL_RE)) urls.push([m.index, m.index + m[0].length]);
  const out = [];
  for (const m of text.matchAll(PATH_RE)) {
    const start = m.index;
    if (start > 0 && LEAD.test(text.slice(0, start))) continue;
    if (urls.some(([a, b]) => start < b && start + m[0].length > a)) continue;
    const whole = m[0].replace(TRAIL, ''); // "see /x/report.html." → no final dot
    let raw = whole;
    let line = 0;
    let col = 0;
    const lc = /:(\d+)(?::(\d+))?$/.exec(raw);
    if (lc) { line = Number(lc[1]); col = Number(lc[2] || 0); raw = raw.slice(0, lc.index); }
    if (raw.length < 3 || /^\.+$/.test(raw) || /^\d[\d.]*$/.test(raw)) continue;
    const end = start + whole.length;
    out.push({ start, end, path: raw, line, col });
    if (out.length >= 24) break;
  }
  return out;
}

/** A link provider for one terminal tab. */
export function pathLinks(tab) {
  return {
    provideLinks(y, done) {
      const ws = tab.ws;
      if (!ws || !ws.root) return done(undefined);
      const { text, at } = logicalLine(tab.term, y);
      const found = findPaths(text);
      if (!found.length) return done(undefined);
      resolveAll(ws.root, found.map(f => f.path)).then(infos => {
        const links = [];
        found.forEach((f, i) => {
          const info = infos[i];
          if (!info) return;
          const a = at[f.start];
          const b = at[f.end - 1];
          if (!a || !b || a.y > y || b.y < y) return; // reported on the rows it covers
          links.push({
            range: { start: a, end: b },
            text: text.slice(f.start, f.end),
            decorations: { underline: true, pointerCursor: true },
            // left button only: a right-click opens the menu instead (xterm activates links on any button)
            activate: (e) => { if (!e || !(e.button > 0)) openPath(ws.app, ws, info, { inApp: !!(e && (e.ctrlKey || e.metaKey)), line: f.line, col: f.col }); },
            hover: () => { tab.hoverLink = { kind: 'path', info, line: f.line, col: f.col }; tab.host.title = pathHint(info); },
            leave: () => { if (tab.hoverLink && tab.hoverLink.info === info) tab.hoverLink = null; tab.host.title = ''; },
          });
        });
        done(links.length ? links : undefined);
      }, () => done(undefined));
    },
  };
}

/** Right-click on a link or path in a terminal. */
export function linkMenuItems(tab, link) {
  const ws = tab.ws;
  const app = ws.app;
  if (link.kind === 'url') {
    return [
      { label: 'Open in SkiffCode', icon: 'globe', action: () => openLink(app, link.text, { ctrlKey: true }) },
      { label: 'Open in your browser', icon: 'external', action: () => openLink(app, link.text, {}) },
      { separator: true },
      { label: 'Copy link', icon: 'link', action: () => copy(link.text) },
    ];
  }
  const { info, line, col } = link;
  const inHere = info.root === ws.root;
  if (info.type === 'dir') {
    return [
      inHere ? { label: 'Show in Files', icon: 'files', action: () => openPath(app, ws, info, {}) } : null,
      { label: 'Copy path', icon: 'link', action: () => copy(info.abs) },
    ];
  }
  const kind = pathKind(info.abs);
  return [
    { label: kind === 'html' ? 'Open preview in SkiffCode' : 'Open in SkiffCode', icon: kind === 'html' ? 'eye' : kind === 'image' ? 'image' : 'file', action: () => openPath(app, ws, info, { inApp: true, line, col }) },
    { label: 'Open in your browser', icon: 'external', action: () => openPath(app, ws, info, { browser: true }) },
    kind !== 'text' && inHere ? { label: 'Open as text', icon: 'code', action: () => ws.openFile(info.rel, { asText: true }) } : null,
    inHere ? { label: 'Show in Files', icon: 'files', action: () => ws.files.reveal(info.rel) } : null,
    { separator: true },
    { label: 'Copy path', icon: 'link', action: () => copy(info.abs) },
  ];
}

function copy(text) {
  navigator.clipboard.writeText(text).then(() => toast('Copied.', { timeout: 1500 }), () => {});
}
