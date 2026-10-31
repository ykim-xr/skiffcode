// Small DOM + formatting helpers.

/** h('div.cls#id', {attrs, onclick}, ...children) */
export function h(tag, attrs, ...children) {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(tag) || [];
  const el = document.createElement(m[1] || 'div');
  for (const part of (m[2] || '').match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className += ' ' + v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

// 16px line icons (stroke = currentColor).
const P = {
  repo: 'M4 2.5h7.5v9H5a1.5 1.5 0 0 0-1.5 1.5V3a.5.5 0 0 1 .5-.5zM3.5 13a1.5 1.5 0 0 0 1.5 1.5h6.5V11.5M6 5h3',
  branch: 'M5 2.5v8M5 10.5a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5zM11 2.5a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5zM11 6v.5a3 3 0 0 1-3 3H6.5',
  home: 'M2.5 7.5 8 2.5l5.5 5M4 6.5v7h3v-4h2v4h3v-7',
  folder: 'M1.5 4a1 1 0 0 1 1-1h3.5l1.5 1.5h6a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z',
  file: 'M4 1.5h5L12.5 5v9.5h-8.5zM9 1.5V5h3.5',
  terminal: 'M2 3h12v10H2zM4.5 6l2 2-2 2M8 10.5h3.5',
  claude: 'M8 1.8v2M8 14.2v-2M1.8 8h2M14.2 8h-2M3.6 3.6 5 5M12.4 12.4 11 11M3.6 12.4 5 11M12.4 3.6 11 5M8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z',
  zigzag: 'M1.5 9h2.2l1.6-4.5 2.4 8 2.2-6.5 1.4 3h3.2',
  star: 'M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.2L8 11.5l-3.8 2 .7-4.2-3.1-3 4.3-.6z',
  bolt: 'M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z',
  globe: 'M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM1.5 8h13M8 1.5c2 2 2.6 4.3 2.6 6.5S10 12.5 8 14.5C6 12.5 5.4 10.2 5.4 8S6 3.5 8 1.5z',
  box: 'M2.5 5 8 2l5.5 3v6L8 14l-5.5-3zM2.5 5 8 8l5.5-3M8 8v6',
  flask: 'M6 1.5h4M6.5 1.5v4.5L2.8 12.3a1.3 1.3 0 0 0 1.1 2.2h8.2a1.3 1.3 0 0 0 1.1-2.2L9.5 6V1.5M4.5 10h7',
  book: 'M2.5 3c2-1 4-1 5.5.5 1.5-1.5 3.5-1.5 5.5-.5v10c-2-1-4-1-5.5.5-1.5-1.5-3.5-1.5-5.5-.5zM8 3.5v10',
  heart: 'M8 13.5S2 10 2 5.8A3 3 0 0 1 8 4.5a3 3 0 0 1 6 1.3C14 10 8 13.5 8 13.5z',
  server: 'M2.5 2.5h11v4.5h-11zM2.5 9h11v4.5h-11zM5 4.75h.01M5 11.25h.01',
  cloud: 'M4.5 12.5h7a3 3 0 0 0 .3-6 4 4 0 0 0-7.6-1A3.5 3.5 0 0 0 4.5 12.5z',
  rocket: 'M9.5 2.5c2.5-.5 4 0 4 0s.5 1.5 0 4L8 12l-4-4zM4 8l-2 .5 1.5-3 3-.5M8 12l-.5 2 3-1.5.5-3M10.5 5.5h.01',
  lock: 'M3.5 7h9v7h-9zM5.5 7V5a2.5 2.5 0 0 1 5 0v2',
  bug: 'M5.5 5.5h5v5a2.5 2.5 0 0 1-5 0zM6 5.5V4.5a2 2 0 0 1 4 0v1M2.5 8h3M10.5 8h3M3 4.5l2.5 1.5M13 4.5l-2.5 1.5M3 12.5l2.5-1.5M13 12.5l-2.5-1.5',
  chart: 'M2.5 13.5h11M4.5 11V8M8 11V4.5M11.5 11V6.5',
  leaf: 'M3 13c0-6 4-10 10-10 0 6-4 10-10 10zM3 13l6-6',
  flag: 'M3.5 14.5V2M3.5 2.5h8l-1.5 3 1.5 3h-8',
  code: 'M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5M9 3 7 13',
  phone: 'M5 1.5h6v13H5zM7.5 12.5h1',
  briefcase: 'M2 5h12v8.5H2zM5.5 5V3h5v2M2 8.5h12',
  palette: 'M8 1.5a6.5 6.5 0 1 0 0 13c.9 0 1.3-.6 1.3-1.2 0-.8-.6-1.1-.6-1.8 0-.6.5-1 1.1-1h1.4a2.8 2.8 0 0 0 2.8-2.8C14 4.1 11.3 1.5 8 1.5zM4.8 7.5h.01M6.3 4.8h.01M9.7 4.8h.01M11.2 7.5h.01',
  chip: 'M4.5 4.5h7v7h-7zM6.5 2v2.5M9.5 2v2.5M6.5 11.5V14M9.5 11.5V14M2 6.5h2.5M2 9.5h2.5M11.5 6.5H14M11.5 9.5H14',
  agent: 'M4.5 5.5h7v7h-7zM8 2.5v3M6.5 8.5v1M9.5 8.5v1M2.5 8.5h2M11.5 8.5h2',
  question: 'M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM6.2 6.1a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.5M8 11.3v.2',
  shield: 'M8 1.5 13 3.5v4c0 3-2.2 5.6-5 7-2.8-1.4-5-4-5-7v-4zM6 8l1.5 1.5L10.5 6.5',
  check: 'M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM5 8.2l2 2 4-4.2',
  circle: 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z',
  sync: 'M13.5 8A5.5 5.5 0 0 1 3.3 10.8M2.5 8a5.5 5.5 0 0 1 10.2-2.8M12.7 2.5v2.7H10M3.3 13.5v-2.7H6',
  plus: 'M8 3v10M3 8h10',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9',
  close: 'M4 4l8 8M12 4l-8 8',
  chevronRight: 'M6 3.5 10.5 8 6 12.5',
  chevronDown: 'M3.5 6 8 10.5 12.5 6',
  refresh: 'M13 3v3.5H9.5M13 6.5A5 5 0 1 0 13.3 10',
  search: 'M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM10.6 10.6 14 14',
  diff: 'M5 2v6M2 5h6M2 11.5h6M10 2.5h3.5v11H10',
  commit: 'M8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM1.5 8h4M10.5 8h4',
  files: 'M5 1.5h4.5L12.5 4.5v8h-7.5zM9.5 1.5v3h3M3.5 4v10.5h7',
  git: 'M4.5 3a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM4.5 10a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM11.5 5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM4.5 6v4M11.5 8c0 2-2 2.5-4 2.5H6',
  up: 'M8 13V3M4 7l4-4 4 4',
  down: 'M8 3v10M4 9l4 4 4-4',
  bell: 'M4 11V7.5a4 4 0 1 1 8 0V11l1 1.5H3zM6.5 14h3',
  mute: 'M2.5 6h2.5L8.5 3v10L5 10H2.5zM11 6l3 4M14 6l-3 4',
  unmute: 'M2.5 6h2.5L8.5 3v10L5 10H2.5zM11 5.5a3.5 3.5 0 0 1 0 5M12.5 3.5a6.5 6.5 0 0 1 0 9',
  split: 'M2 3h12v10H2zM8 3v10',
  splitDown: 'M2 3h12v10H2zM2 8h12',
  keyboard: 'M1.5 4h13v8h-13zM4 6.5h1M7.5 6.5h1M11 6.5h1M4.5 9.5h7',
  gear: 'M8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4zM8 1.5l1 1.8 2-.4.5 2 1.8 1-.9 1.8.9 1.8-1.8 1-.5 2-2-.4-1 1.8-1-1.8-2 .4-.5-2-1.8-1 .9-1.8-.9-1.8 1.8-1 .5-2 2 .4z',
  group: 'M1.5 3.5h4l1 1.5h8v8h-13zM1.5 6.5h13',
  stop: 'M4 4h8v8H4z',
  play: 'M5 3l8 5-8 5z',
  edit: 'M10.5 2.5l3 3-8 8h-3v-3z',
  push: 'M8 11V2.5M4.5 6 8 2.5 11.5 6M3 13.5h10',
  pull: 'M8 2.5V11M4.5 7.5 8 11l3.5-3.5M3 13.5h10',
  dot: 'M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  link: 'M6.5 9.5l3-3M5 7.5 3.5 9a2 2 0 0 0 3 3L8 10.5M11 8.5 12.5 7a2 2 0 0 0-3-3L8 5.5',
  image: 'M2 2.5h12v11H2zM2 11l3.5-3.5 3 3 2-2 3.5 3.5M10.5 6.2a1.2 1.2 0 1 0 0-.01',
  eye: 'M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  external: 'M9.5 2.5h4v4M13.5 2.5 8 8M12 9.5v4H2.5V4h4',
  back: 'M10 3 5 8l5 5',
  forward: 'M6 3l5 5-5 5',
};

export function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', `icon icon-${name} ${cls}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', P[name] || P.circle);
  svg.append(path);
  return svg;
}

export function debounce(fn, ms) {
  let t;
  const wrapped = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

export function relTime(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.round(hr / 24)}d`;
}

export function basename(p) {
  return p.split('/').filter(Boolean).pop() || p;
}
export function dirname(p) {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '' : p.slice(0, i);
}
export function tildify(p, home) {
  return home && p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
}

/** Fuzzy score: all query chars in order; bonus for word starts and contiguity. -1 = no match. */
export function fuzzy(query, text) {
  if (!query) return { score: 0, hits: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let ti = 0, score = 0, last = -2;
  const hits = [];
  for (const ch of q) {
    if (ch === ' ') continue;
    const i = t.indexOf(ch, ti);
    if (i < 0) return null;
    hits.push(i);
    score += i === last + 1 ? 5 : 1;
    if (i === 0 || '/._- '.includes(t[i - 1])) score += 4;
    last = i;
    ti = i + 1;
  }
  const base = t.lastIndexOf('/') + 1;
  if (hits[0] >= base) score += 6; // matched within the file name
  return { score: score - text.length * 0.01, hits };
}

export function highlight(text, hits) {
  if (!hits || !hits.length) return [text];
  const set = new Set(hits);
  const out = [];
  let buf = '';
  let inHit = false;
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    if (hit !== inHit) {
      if (buf) out.push(inHit ? h('mark', buf) : buf);
      buf = '';
      inHit = hit;
    }
    buf += text[i];
  }
  if (buf) out.push(inHit ? h('mark', buf) : buf);
  return out;
}

const EXT_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  py: 'python', pyi: 'python', rs: 'rust', go: 'go', css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html', vue: 'html', svelte: 'html',
  json: 'json', jsonc: 'json', md: 'markdown', markdown: 'markdown', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', sh: 'shell', bash: 'shell', zsh: 'shell',
  sql: 'sql', java: 'java', kt: 'kotlin', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', rb: 'ruby', php: 'php', swift: 'swift',
  xml: 'xml', svg: 'xml', dockerfile: 'dockerfile', graphql: 'graphql', gql: 'graphql', lua: 'lua', r: 'r', dart: 'dart', ps1: 'powershell', bat: 'bat',
};
export function languageOf(p) {
  const name = basename(p).toLowerCase();
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile') return 'shell';
  const ext = name.includes('.') ? name.split('.').pop() : '';
  return EXT_LANG[ext] || 'plaintext';
}

export const STATUS_LABEL = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Conflict', '?': 'Untracked' };
export const STATUS_LETTER = s => (s === '?' ? 'U' : s);

/** Files with changes in a git status: a staged file edited again counts once (same as the server's `dirty`). */
export const dirtyCount = s => new Set([...s.staged, ...s.changes, ...s.untracked, ...s.conflicts].map(f => f.path)).size;

/** Size of a new terminal until its view reports the real one (the server uses the same). */
export const TERM_SIZE = { cols: 120, rows: 32 };

/** Reads a saved setting. Blocked storage, a missing key or a value `parse` rejects all give `fallback`. */
export function readStored(key, fallback = null, parse = v => v) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : parse(v);
  } catch {
    return fallback;
  }
}
