// Test stand-in for Monaco's AMD loader: defines a tiny fake `monaco` API.
(function () {
  const models = new Map();
  class Emitter { constructor() { this.l = []; } on(fn) { this.l.push(fn); return { dispose: () => {} }; } fire(v) { this.l.forEach(f => f(v)); } }
  class Uri {
    constructor(scheme, path, query) { this.scheme = scheme; this.path = path; this.query = query || ''; }
    static from(c) { return new Uri(c.scheme, c.path, c.query); }
    toString() { return `${this.scheme}://${this.path}${this.query ? '?' + this.query : ''}`; }
  }
  let anon = 0;
  class Model {
    constructor(text, lang, uri) { this.text = text; this.lang = lang; this.uri = uri || new Uri('inmemory', '/m' + (++anon)); this.v = 1; this.e = new Emitter(); this.disposed = false; models.set(this.uri.toString(), this); }
    getValue() { return this.text; }
    setValue(t) { this.text = t; this.v++; this.e.fire({}); }
    getAlternativeVersionId() { return this.v; }
    onDidChangeContent(fn) { return this.e.on(fn); }
    pushEditOperations(_s, ops) { this.setValue(ops[0].text); }
    getFullModelRange() { return {}; }
    getLanguageId() { return this.lang; }
    getWordAtPosition() { return null; }
    dispose() { this.disposed = true; models.delete(this.uri.toString()); }
    isDisposed() { return this.disposed; }
  }
  function editorStub(el, opts) {
    const ta = document.createElement('textarea');
    ta.className = 'stub-editor';
    ta.style.cssText = 'width:100%;height:100%;background:#1f1f1f;color:#ccc;border:0;font:12px monospace';
    el.append(ta);
    let model = opts && opts.model;
    const sync = () => { ta.value = model ? model.getValue() : ''; };
    sync();
    ta.addEventListener('input', () => model && model.setValue(ta.value));
    const ed = {
      _ta: ta,
      addCommand() {}, onDidChangeCursorPosition() { return { dispose() {} }; }, getPosition: () => ({ lineNumber: 1, column: 1 }),
      setSelection() {}, revealRangeInCenterIfOutsideViewport() {}, revealLineInCenter() {}, focus() { ta.focus(); }, layout() {}, dispose() { ta.remove(); },
      updateOptions(o) { if ('readOnly' in o) ta.readOnly = !!o.readOnly; }, getModel: () => model,
      setModel(m) { model = m; sync(); if (m) m.onDidChangeContent(() => { if (model === m && document.activeElement !== ta) sync(); }); },
    };
    if (model) model.onDidChangeContent(() => { if (document.activeElement !== ta) sync(); });
    return ed;
  }
  window.require = function (deps, cb) {
    window.monaco = {
      Uri, Range: class { constructor(a, b, c, d) { Object.assign(this, { startLineNumber: a, startColumn: b, endLineNumber: c, endColumn: d }); } },
      KeyMod: { CtrlCmd: 2048 }, KeyCode: { KeyS: 49 },
      editor: {
        create: editorStub,
        createDiffEditor(el) {
          el.classList.add('stub-diff');
          const left = document.createElement('div'); left.className = 'stub-diff-left';
          const right = document.createElement('div'); right.className = 'stub-diff-right';
          left.style.cssText = right.style.cssText = 'display:inline-block;width:50%;height:100%;vertical-align:top';
          el.append(left, right);
          const o = editorStub(left, {}), m = editorStub(right, {});
          o.updateOptions({ readOnly: true });
          let cur = null;
          return { setModel(p) { cur = p; o.setModel(p.original); m.setModel(p.modified); }, getModel: () => cur, getModifiedEditor: () => m, getOriginalEditor: () => o, getLineChanges: () => [], revealLineInCenter() {}, layout() {}, dispose() { o.dispose(); m.dispose(); } };
        },
        createModel: (t, l, u) => new Model(t, l, u),
        getModel: u => models.get(u.toString()) || null,
        defineTheme() {}, setTheme() {}, registerEditorOpener() {},
      },
      languages: {
        typescript: { typescriptDefaults: { setDiagnosticsOptions() {}, setCompilerOptions() {} }, javascriptDefaults: { setDiagnosticsOptions() {}, setCompilerOptions() {} }, JsxEmit: {}, ScriptTarget: {} },
        registerDefinitionProvider(_l, p) { window.__defProvider = p; }, registerReferenceProvider() {},
      },
    };
    setTimeout(cb, 0);
  };
  window.require.config = function () {};
})();
