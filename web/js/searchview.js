// Right panel: search across the worktree (ripgrep on the server).
import { h, icon, clear, basename, dirname, debounce } from './util.js';
import { call } from './rpc.js';

export class SearchView {
  constructor(ws) {
    this.ws = ws;
    this.opts = { caseSensitive: false, word: false, regex: false };
    this.input = h('input.input', { placeholder: 'Search', spellcheck: 'false', oninput: debounce(() => this.run(), 250), onkeydown: e => e.key === 'Enter' && this.run() });
    this.include = h('input.input.small', { placeholder: 'files to include (e.g. *.py, src/**)', spellcheck: 'false', oninput: debounce(() => this.run(), 400) });
    this.exclude = h('input.input.small', { placeholder: 'files to exclude', spellcheck: 'false', oninput: debounce(() => this.run(), 400) });
    const toggle = (k, label, title) => {
      const b = h('button.toggle', { title, onclick: () => { this.opts[k] = !this.opts[k]; b.classList.toggle('on', this.opts[k]); this.run(); } }, label);
      return b;
    };
    this.summary = h('div.search-summary');
    this.results = h('div.search-results');
    this.collapsed = new Set();
    this.el = h('div.right-view.search-view',
      h('div.search-box', h('div.search-row', this.input, toggle('caseSensitive', 'Aa', 'Match case'), toggle('word', 'ab', 'Whole word'), toggle('regex', '.*', 'Regular expression')),
        this.include, this.exclude),
      this.summary, this.results);
  }

  focus() {
    setTimeout(() => { this.input.focus(); this.input.select(); }, 0);
  }

  async run() {
    const q = this.input.value;
    const my = (this.seq = (this.seq || 0) + 1);
    if (!q) {
      clear(this.results);
      clear(this.summary);
      return;
    }
    clear(this.summary, 'Searching…');
    try {
      const r = await call('search.text', { root: this.ws.root, query: q, ...this.opts, include: this.include.value, exclude: this.exclude.value });
      if (my !== this.seq) return;
      clear(this.summary, r.count ? `${r.count}${r.truncated ? '+' : ''} result${r.count === 1 ? '' : 's'} in ${r.results.length} file${r.results.length === 1 ? '' : 's'}` : 'No results');
      clear(this.results, r.results.map(f => {
        const open = !this.collapsed.has(f.file);
        return h('div.search-file',
          h('div.search-file-head', { onclick: () => { if (open) this.collapsed.add(f.file); else this.collapsed.delete(f.file); this.run(); } },
            icon(open ? 'chevronDown' : 'chevronRight', 'twisty'), icon('file', 'file-type'), h('span.scm-name', basename(f.file)), h('span.scm-dir', dirname(f.file)), h('span.count-badge', String(f.matches.length))),
          open ? f.matches.map(m => {
            const pre = m.text.slice(Math.max(0, m.col - 1 - 40), m.col - 1);
            const hit = m.text.slice(m.col - 1, m.col - 1 + m.len);
            const post = m.text.slice(m.col - 1 + m.len, m.col - 1 + m.len + 120);
            return h('div.search-hit', { title: `${f.file}:${m.line}`, onclick: () => this.ws.openFile(f.file, { line: m.line, col: m.col, len: m.len, preview: true }) },
              h('span.search-line', String(m.line)), h('span.search-text', (m.col > 41 ? '…' : '') + pre.trimStart(), h('mark', hit), post));
          }) : null);
      }));
    } catch (e) {
      if (my === this.seq) clear(this.summary, h('span.error', e.message));
    }
  }
}
