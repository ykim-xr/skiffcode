// Panel background colors (Settings → Panel colors). Stored in settings.colors.
import { h, icon, clear } from './util.js';
import { call } from './rpc.js';
import { store } from './store.js';
import { modal } from './dialogs.js';

// key, label, default background
export const PANELS = [
  ['sidebar', 'Left sidebar', '#181818'],
  ['center', 'Editor & terminals', '#1f1f1f'],
  ['bottom', 'Bottom panel', '#181818'],
  ['right', 'Right panel', '#181818'],
];
const PRESETS = [
  ['Default', {}],
  ['Black center', { center: '#000000', bottom: '#000000' }],
  ['All black', { sidebar: '#000000', center: '#000000', bottom: '#000000', right: '#000000' }],
  ['Dim', { sidebar: '#141414', center: '#191919', bottom: '#141414', right: '#141414' }],
];
const HEX = /^#[0-9a-f]{6}$/i;
const TERM_DEFAULT = '#181818';

const current = () => store.settings.colors || {};
export const panelColor = (key, colors = current()) => (HEX.test(colors[key] || '') ? colors[key].toLowerCase() : null);

/** Background for a terminal, by where it sits (main area or bottom panel). */
export function termBackground(el, colors = current()) {
  return el && el.closest('.row-bottom') ? panelColor('bottom', colors) || TERM_DEFAULT : panelColor('center', colors) || TERM_DEFAULT;
}

let applied = '';
let previewing = false; // the Panel colors dialog is open: its live preview wins over saved settings
export function applyColors(colors, force = false) {
  if (colors === undefined) {
    if (previewing) return;
    colors = current();
  }
  const sig = JSON.stringify(colors);
  if (sig === applied && !force) return;
  applied = sig;
  const s = document.documentElement.style;
  s.setProperty('--panel-sidebar', panelColor('sidebar', colors) || '#181818');
  s.setProperty('--panel-right', panelColor('right', colors) || '#181818');
  s.setProperty('--center-bg', panelColor('center', colors) || '#1f1f1f');
  s.setProperty('--center-term-bg', panelColor('center', colors) || TERM_DEFAULT);
  s.setProperty('--bottom-bg', panelColor('bottom', colors) || TERM_DEFAULT);
  if (window.monaco && window.monaco.editor && window.monaco.editor.defineTheme) defineEditorTheme(panelColor('center', colors) || '#1f1f1f');
  window.dispatchEvent(new Event('skiffcode-colors'));
}

export function defineEditorTheme(bg = panelColor('center') || '#1f1f1f') {
  const monaco = window.monaco;
  monaco.editor.defineTheme('skiffcode-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': bg,
      'editor.lineHighlightBackground': '#2a2d2e80',
      'editorGutter.background': bg,
      'diffEditor.insertedTextBackground': '#9ccc2c33',
      'diffEditor.removedTextBackground': '#ff000033',
      'diffEditor.insertedLineBackground': '#9bb95533',
      'diffEditor.removedLineBackground': '#ff000026',
      'editorWidget.background': '#252526',
      'minimap.background': bg,
    },
  });
  monaco.editor.setTheme('skiffcode-dark');
}

/** The quick "Panel colors" dialog: live preview, Save keeps it. */
export function colorsDialog() {
  const before = { ...current() };
  let draft = { ...before };
  const rows = h('div.colors-rows');
  const preview = () => applyColors(draft, true);
  previewing = true;
  const render = () => {
    clear(rows, PANELS.map(([key, label, def]) => {
      const val = panelColor(key, draft);
      const text = h('input.input.color-hex', { value: val || '', placeholder: `${def} (default)`, spellcheck: 'false', 'data-panel': key });
      const pick = h('input.color-pick', { type: 'color', value: val || def, title: `Pick a color for the ${label.toLowerCase()}` });
      pick.addEventListener('input', () => { draft[key] = pick.value; text.value = pick.value; preview(); });
      text.addEventListener('input', () => {
        const v = text.value.trim();
        if (!v) delete draft[key];
        else if (HEX.test(v)) draft[key] = v;
        else return;
        pick.value = draft[key] || def;
        preview();
      });
      return h('div.color-row',
        h('span.color-label', label),
        pick, text,
        h('button.icon-btn', { title: 'Back to default', onclick: () => { delete draft[key]; render(); preview(); } }, icon('refresh')));
    }));
  };
  const m = modal([
    h('div.modal-title', 'Panel colors'),
    h('div.color-presets', PRESETS.map(([name, c]) => h('button.btn.small', { onclick: () => { draft = { ...c }; render(); preview(); } }, name))),
    rows,
    h('div.modal-buttons',
      h('button.btn', { onclick: () => m.close('cancel') }, 'Cancel'),
      h('button.btn.primary', { onclick: () => m.close('save') }, 'Save')),
  ], {
    onClose: async v => {
      previewing = false;
      if (v !== 'save') return applyColors(before, true);
      const colors = Object.fromEntries(Object.entries(draft).filter(([, c]) => HEX.test(c)));
      store.settings = { ...store.settings, colors };
      applyColors(colors, true);
      await call('settings.set', { values: { colors } });
    },
  });
  m.box.classList.add('colors-modal');
  render();
}
