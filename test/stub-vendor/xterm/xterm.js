// Test stand-in for xterm.js: keeps the decoded output in a <pre>.
window.Terminal = class {
  constructor(o) { this.o = o; this.options = { ...o }; this.cols = 100; this.rows = 30; this.text = ''; this.dec = new TextDecoder(); }
  loadAddon(a) { a.activate && a.activate(this); }
  open(el) { this.pre = document.createElement('pre'); this.pre.className = 'stub-term'; this.pre.style.cssText = 'margin:0;color:#ccc;white-space:pre-wrap;height:100%;overflow:auto'; this.pre.tabIndex = 0; el.append(this.pre);
    this.pre.addEventListener('keydown', e => { if (this.kh && this.kh(e) === false) return; if (e.key.length === 1) this._d && this._d(e.key); else if (e.key === 'Enter') this._d && this._d('\r'); e.preventDefault(); }); }
  write(d) { this.text += typeof d === 'string' ? d : this.dec.decode(d, { stream: true }); this.pre.textContent = this.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').slice(-20000); }
  reset() { this.text = ''; }
  onData(fn) { this._d = fn; return { dispose() {} }; }
  attachCustomKeyEventHandler(fn) { this.kh = fn; }
  hasSelection() { return !!this._sel; } getSelection() { return this._sel || ''; } clearSelection() { this._sel = ''; } select(text) { this._sel = text; }
  paste(text) { this._d && this._d(text); }
  focus() { this.pre && this.pre.focus(); } dispose() { this.pre && this.pre.remove(); }
  // the slice of xterm's buffer + link API that SkiffCode's path links use (rows wrap at `cols`)
  registerLinkProvider(p) { (this.providers ||= []).push(p); return { dispose() {} }; }
  get buffer() {
    const cols = this.cols;
    const rows = [];
    for (const l of this.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '').split('\n')) {
      if (!l.length) rows.push({ s: '', w: false });
      for (let i = 0; i < l.length; i += cols) rows.push({ s: l.slice(i, i + cols), w: i > 0 });
    }
    return { active: { length: rows.length, getLine: i => rows[i] && { isWrapped: rows[i].w, length: cols, translateToString: () => rows[i].s, getCell: x => (x < cols ? { getWidth: () => 1, getChars: () => rows[i].s[x] || '' } : undefined) } } };
  }
  /** test helper: the links all providers report for buffer row y (1-based) */
  links(y) { return Promise.all((this.providers || []).map(p => new Promise(r => p.provideLinks(y, l => r(l || []))))).then(a => a.flat()); }
};
