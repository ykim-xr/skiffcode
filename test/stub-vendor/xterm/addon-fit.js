// Test stand-in for @xterm/addon-fit: sizes the terminal from its container (8×17 px cells), like the real one.
window.FitAddon = { FitAddon: class {
  activate(term) { this.term = term; }
  proposeDimensions() {
    const el = this.term && this.term.pre && this.term.pre.parentElement;
    if (!el || !el.clientWidth || !el.clientHeight) return undefined;
    return { cols: Math.max(2, Math.floor(el.clientWidth / 8)), rows: Math.max(1, Math.floor(el.clientHeight / 17)) };
  }
  fit() { const d = this.proposeDimensions(); if (d) { this.term.cols = d.cols; this.term.rows = d.rows; } }
} };
