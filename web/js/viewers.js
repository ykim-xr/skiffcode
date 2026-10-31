// Viewers shown in a worktree's panes: images, PDFs, HTML previews and web pages.
// Files are served read-only at /view/<key>/<path> (see server/main.js): pages run sandboxed,
// with their own origin, so a previewed page's scripts can't reach SkiffCode.
import { h, icon, basename, clear, debounce } from './util.js';
import { call, on } from './rpc.js';
import { toast } from './dialogs.js';

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg']);
const HTML = new Set(['html', 'htm']);
// What a previewed page may do: it runs in an origin of its own, with no way into SkiffCode.
const PAGE_SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals allow-downloads';
const ext = p => { const n = basename(p).toLowerCase(); return n.includes('.') ? n.split('.').pop() : ''; };

/** How a file opens when clicked: 'image', 'pdf', or null (the editor). */
export function viewerFor(path) {
  const e = ext(path);
  if (IMAGE.has(e)) return 'image';
  if (e === 'pdf') return 'pdf';
  return null;
}
/** Files that open in the editor but also have a preview (HTML pages, SVG drawings). */
export const hasPreview = path => HTML.has(ext(path)) || ext(path) === 'svg';

const bases = new Map();
async function viewBase(root) {
  if (!bases.has(root)) bases.set(root, call('fs.viewBase', { root }).catch(e => { bases.delete(root); throw e; }));
  return bases.get(root);
}
const encodePath = p => p.split('/').map(encodeURIComponent).join('/');

// Iframes swallow mouse and drag events: while dragging a splitter or a tab, let them pass through.
let guarded = false;
function guardFrames() {
  if (guarded) return;
  guarded = true;
  const busy = v => document.body.classList.toggle('frames-inert', v);
  document.addEventListener('mousedown', () => busy(true), true);
  document.addEventListener('mouseup', () => busy(false), true);
  document.addEventListener('dragstart', () => busy(true), true);
  document.addEventListener('dragend', () => busy(false), true);
  document.addEventListener('drop', () => busy(false), true);
  window.addEventListener('blur', () => busy(false));
}

let seq = 0;
class ViewerBase {
  constructor(ws, kind) {
    guardFrames();
    this.ws = ws;
    this.kind = kind;
    this.uid = `v${++seq}`;
    this.el = h('div.tab-body.viewer');
    this.pinned = true;
  }
  tooltip() { return this.title(); }
  dirty() { return false; }
  show() {}
  hide() {}
  layout() {}
  focus() {}
  async canClose() { return true; }
  dispose() {
    this.disposed = true;
    if (this.off) this.off();
    this.el.remove();
  }
  changed() { this.ws.tabChanged(this); }
}

// ------------------------------------------------------------------ files: image, PDF, HTML preview

export class FileViewTab extends ViewerBase {
  /** mode: 'image' | 'pdf' | 'html' (a live preview of a page or SVG) */
  constructor(ws, path, mode, { preview = false } = {}) {
    super(ws, 'view');
    this.path = path;
    this.abs = path.startsWith('/'); // a file outside this worktree (opened from a path you clicked)
    this.mode = mode;
    this.pinned = !preview;
    this.version = Date.now();
    this.info = h('span.viewer-info.muted');
    this.bar = h('div.viewer-bar', icon(mode === 'image' ? 'image' : mode === 'pdf' ? 'file' : 'eye'), h('span.viewer-path', path), this.info, h('span.flex'));
    this.stage = h(`div.viewer-stage.viewer-${mode}`);
    this.el.append(this.bar, this.stage);
    this.fit = true;
    if (!this.abs && (mode === 'html' || ext(path) === 'svg')) {
      this.bar.append(h('button.icon-btn', { title: 'Open as text', onclick: () => ws.openFile(path, { asText: true }) }, icon('code')));
    }
    if (mode === 'html') this.bar.append(h('button.icon-btn', { title: 'Reload', onclick: () => this.load() }, icon('refresh')));
    this.bar.append(h('button.icon-btn', { title: 'Open in your browser', onclick: () => this.openOutside() }, icon('external')));
    // Follow changes on disk: the file itself, or (for a page) anything it may load
    const reload = debounce(() => { if (!this.disposed) this.load(); }, 300);
    this.off = on('fs.changed', e => {
      if (this.abs || e.root !== ws.root) return;
      if (mode === 'html' || e.path === null || e.path === path || (e.dir !== undefined && path.startsWith(`${e.dir}/`))) reload();
    });
    this.ready = this.load();
  }
  title() { return this.mode === 'html' ? `Preview ${basename(this.path)}` : basename(this.path); }
  tooltip() { return this.mode === 'html' ? `Preview of ${this.path}` : this.path; }
  iconEl() { return icon(this.mode === 'image' ? 'image' : this.mode === 'pdf' ? 'file' : 'eye', 'file-icon'); }
  async url() {
    if (this.abs) return (this.ext ||= call('fs.viewUrl', { path: this.path }).catch(e => { this.ext = null; throw e; }));
    return `${await viewBase(this.ws.root)}${encodePath(this.path)}`;
  }
  async openOutside() { window.open(`${await this.url()}`, '_blank', 'noopener'); }

  async load() {
    let src;
    try {
      src = `${await this.url()}?v=${Date.now()}`;
    } catch (e) {
      clear(this.stage, h('div.tab-message', e.message));
      return;
    }
    if (this.mode === 'image') return this.loadImage(src);
    if (this.frame && this.frame.isConnected) {
      this.frame.src = src;
      return;
    }
    this.frame = this.mode === 'pdf'
      ? h('iframe.viewer-frame', { src, title: this.path })
      // own origin (from the server's sandbox header), and sandboxed here as well
      : h('iframe.viewer-frame.page', { src, title: this.path, sandbox: PAGE_SANDBOX });
    clear(this.stage, this.frame);
  }

  loadImage(src) {
    const img = h('img.viewer-img', { alt: this.path, draggable: 'false' });
    img.onload = () => {
      this.natural = [img.naturalWidth, img.naturalHeight];
      this.updateInfo();
    };
    img.onerror = () => clear(this.stage, h('div.tab-message', 'This image can’t be shown.'));
    img.src = src;
    this.img = img;
    this.stage.classList.toggle('fit', this.fit);
    // click toggles fit-to-window / actual size; Ctrl+wheel zooms
    img.onclick = () => { this.zoom = null; this.fit = !this.fit; this.applyZoom(); };
    this.stage.onwheel = e => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const cur = this.zoom || (this.fit ? img.width / (img.naturalWidth || 1) : 1);
      this.zoom = Math.min(32, Math.max(0.05, cur * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      this.fit = false;
      this.applyZoom();
    };
    clear(this.stage, img);
    this.applyZoom();
  }
  applyZoom() {
    if (!this.img) return;
    this.stage.classList.toggle('fit', this.fit);
    this.img.style.width = !this.fit && this.zoom && this.natural ? `${Math.round(this.natural[0] * this.zoom)}px` : '';
    this.updateInfo();
  }
  updateInfo() {
    if (!this.natural) return;
    const [w, hgt] = this.natural;
    const z = this.fit ? 'fit to window · click for actual size' : this.zoom ? `${Math.round(this.zoom * 100)}% · click to fit` : '100% · click to fit';
    this.info.textContent = `${w} × ${hgt} · ${z}`;
  }
  serialize() { return { kind: 'view', path: this.path, mode: this.mode }; }
}

// ------------------------------------------------------------------ web pages

export class WebTab extends ViewerBase {
  constructor(ws, url) {
    super(ws, 'web');
    this.url = url;
    this.input = h('input.input.viewer-url', {
      value: url,
      spellcheck: 'false',
      onkeydown: e => {
        if (e.key === 'Enter') { e.preventDefault(); this.navigate(this.input.value.trim()); }
        if (e.key === 'Escape') { this.input.value = this.url; this.input.blur(); }
      },
      onfocus: () => this.input.select(),
    });
    this.bar = h('div.viewer-bar',
      h('button.icon-btn', { title: 'Back', onclick: () => this.go(-1) }, icon('back')),
      h('button.icon-btn', { title: 'Forward', onclick: () => this.go(1) }, icon('forward')),
      h('button.icon-btn', { title: 'Reload', onclick: () => this.navigate(this.url, { push: false }) }, icon('refresh')),
      this.input,
      h('button.icon-btn', { title: 'Open in your browser', onclick: () => (this.file ? openInBrowser(this.url) : this.url && window.open(this.url, '_blank', 'noopener')) }, icon('external')));
    this.stage = h('div.viewer-stage.viewer-web');
    this.el.append(this.bar, this.stage);
    this.history = [];
    this.at = -1;
    this.ready = url ? this.navigate(url) : this.blank();
  }
  blank() {
    this.input.placeholder = 'A web address (localhost:3000, https://…) or a file path (/home/…, C:\\…, \\\\wsl.localhost\\…)';
    clear(this.stage, h('div.viewer-blocked', icon('globe'), h('div.muted', 'Type a web address, or paste the path of a file (an HTML report, an image, a PDF…), and press Enter.')));
    setTimeout(() => this.input.focus(), 0);
  }
  focus() { if (!this.url) this.input.focus(); }
  title() {
    if (!this.url) return 'New tab';
    if (this.file) return basename(this.url);
    try { const u = new URL(this.url); return u.host || this.url; } catch { return this.url; }
  }
  tooltip() { return this.url; }
  iconEl() { return icon('globe', 'file-icon'); }
  go(d) {
    const i = this.at + d;
    if (i < 0 || i >= this.history.length) return;
    this.at = i;
    void this.navigate(this.history[i], { push: false });
  }
  async navigate(raw, { push = true } = {}) {
    if (!raw) return;
    if (isPathLike(raw)) return this.openFilePath(raw, { push });
    let url = raw;
    if (!/^[a-z][\w+.-]*:/i.test(url)) url = /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url) ? `http://${url}` : `https://${url}`;
    this.input.value = url;
    clear(this.stage, h('div.tab-message.muted', 'Loading…'));
    const nav = (this.nav = {});
    let check;
    try {
      check = await call('web.check', { url });
    } catch (e) {
      if (this.nav === nav) clear(this.stage, h('div.tab-message', e.message)); // a refused address is not kept in the tab or its history
      return;
    }
    if (this.disposed || this.nav !== nav) return;
    this.file = false;
    this.url = url;
    if (push) {
      this.history = this.history.slice(0, this.at + 1);
      this.history.push(url);
      this.at = this.history.length - 1;
    }
    this.changed();
    if (!check.frameable) {
      clear(this.stage, h('div.viewer-blocked',
        icon('globe'),
        h('div', h('b', this.title()), ' can’t be shown inside SkiffCode.'),
        h('div.muted', check.reason || ''),
        h('button.btn.primary', { onclick: () => window.open(url, '_blank', 'noopener') }, icon('external'), 'Open in your browser')));
      return;
    }
    // A different origin from SkiffCode (the server refuses its own address), so the page can't reach it.
    this.frame = h('iframe.viewer-frame.page', {
      src: url,
      title: url,
      referrerpolicy: 'no-referrer',
      sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads',
    });
    clear(this.stage, this.frame);
  }
  /** A file path typed or pasted in the address bar: shown from SkiffCode's read-only file server. */
  async openFilePath(raw, { push }) {
    this.nav = {}; // an address still being checked is dropped
    this.url = raw;
    this.file = true;
    this.input.value = raw;
    if (push) {
      this.history = this.history.slice(0, this.at + 1);
      this.history.push(raw);
      this.at = this.history.length - 1;
    }
    this.changed();
    let src;
    try {
      const [info] = await call('paths.resolve', { cwd: this.ws.root, paths: [raw] });
      if (!info) throw new Error(`Not found: ${raw}`);
      src = await call('fs.viewUrl', { path: info.type === 'dir' ? `${info.abs}/index.html` : info.abs }).catch(e => {
        throw info.type === 'dir' ? new Error('That’s a folder (with no index.html).') : e;
      });
      this.url = info.abs;
      this.input.value = info.abs;
      this.changed();
    } catch (e) {
      clear(this.stage, h('div.tab-message', e.message));
      return;
    }
    if (this.disposed) return;
    this.frame = /\.pdf$/i.test(this.url)
      ? h('iframe.viewer-frame', { src, title: this.url })
      : h('iframe.viewer-frame.page', { src, title: this.url, sandbox: PAGE_SANDBOX });
    clear(this.stage, this.frame);
  }
  serialize() { return this.url ? { kind: 'web', url: this.url } : null; }
}

export const LINK_HINT = 'Click: open in your browser · Ctrl+click: open in SkiffCode';
/**
 * A link clicked in a terminal or the editor: Ctrl+click (Cmd+click) opens it in a SkiffCode tab,
 * a plain click in your browser. (In the editor, following a link always takes Ctrl+click: a tab here.)
 */
export function openLink(app, uri, e) {
  if (e && e.button > 0) return; // right / middle click on a link: the terminal's menu, not a navigation
  let u;
  try { u = new URL(uri); } catch { return; }
  if (u.protocol === 'file:') return openFileLink(app, uri, e);
  if (!/^https?:$/.test(u.protocol)) return;
  const ws = app.active;
  if (ws && e && (e.ctrlKey || e.metaKey)) ws.openWeb(u.href);
  else window.open(u.href, '_blank', 'noopener');
}

const isPathLike = s => /^(\/|~(\/|$)|\.{1,2}\/|[A-Za-z]:[\\/]|\\\\wsl|file:)/i.test(s);

/** What a file is, for opening it: 'html', 'image', 'pdf' or 'text'. */
export function pathKind(p) {
  const e = ext(p);
  if (HTML.has(e)) return 'html';
  if (IMAGE.has(e)) return 'image';
  if (e === 'pdf') return 'pdf';
  return 'text';
}
export function pathHint(info) {
  if (info.type === 'dir') return 'Click: show in Files · right-click for more';
  if (pathKind(info.abs) === 'text') return 'Click: open in the editor · right-click for more';
  return `${LINK_HINT} · right-click for more`;
}

/** Open any file in your browser, from SkiffCode's read-only file server. */
function openInBrowser(abs) {
  const w = window.open('', '_blank'); // opened now, while the click still counts (popup blockers)
  call('fs.viewUrl', { path: abs }).then(url => {
    if (!w) return window.open(url, '_blank', 'noopener');
    w.opener = null;
    w.location.href = new URL(url, location.href).href;
  }, err => {
    if (w) w.close();
    toast(err.message, { kind: 'error' });
  });
}

/**
 * A path clicked in a terminal (info from paths.resolve).
 * inApp (Ctrl+click): inside SkiffCode; browser: your browser; neither: the natural place
 * (HTML / images / PDFs → your browser, code → the editor, folders → the Files panel).
 */
export function openPath(app, ws, info, { inApp = false, browser = false, line = 0, col = 0 } = {}) {
  const here = info.root === ws.root;
  if (info.type === 'dir') {
    if (here) return ws.files.reveal(info.rel, true);
    return toast(`${info.abs} is outside this worktree.`, { timeout: 3000 });
  }
  const kind = pathKind(info.abs);
  if (browser || (!inApp && kind !== 'text')) return openInBrowser(info.abs);
  if (kind === 'text') return here ? ws.openFile(info.rel, { line: line || undefined, col: col || undefined }) : ws.openWeb(info.abs);
  if (here) return kind === 'html' ? ws.openView(info.rel, 'html') : ws.openFile(info.rel);
  return ws.openView(info.abs, kind);
}

async function openFileLink(app, uri, e) {
  const ws = app.active;
  if (!ws) return;
  const [info] = await call('paths.resolve', { cwd: ws.root, paths: [uri] }).catch(() => [null]);
  if (!info) return toast(`Not found: ${uri}`, { kind: 'error' });
  openPath(app, ws, info, { inApp: !!(e && (e.ctrlKey || e.metaKey)) });
}
