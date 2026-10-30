// Keyboard shortcuts: the actions, their default keys, the user's changes
// (settings.keybindings: { id: spec | '' }) and Settings → Keyboard shortcuts.
import { h, icon, clear } from './util.js';
import { call } from './rpc.js';
import { store, notify } from './store.js';
import { modal } from './dialogs.js';

/** [id, label, default key ('' = none)]. Ids are saved in settings, so keep them stable. */
export const KEY_ACTIONS = [
  ['quickOpen', 'Open file…', 'ctrl+p'],
  ['commands', 'Show all commands', 'ctrl+shift+p'],
  ['jump', 'Jump to session or worktree', 'ctrl+alt+j'],
  ['nextNeedsYou', 'Go to next session that needs you', 'ctrl+alt+k'],
  ['newClaude', 'New Claude session', 'ctrl+alt+n'],
  ['newShell', 'New shell', 'ctrl+`'],
  ['togglePanel', 'Toggle bottom panel', 'ctrl+shift+`'],
  ['review', 'Review changes vs base', 'ctrl+alt+d'],
  ['search', 'Search in worktree', 'ctrl+shift+f'],
  ['files', 'Show files', 'ctrl+shift+e'],
  ['scm', 'Show source control', 'ctrl+shift+g'],
  ['settings', 'Settings', 'ctrl+,'],
  ['toggleSidebar', 'Toggle sidebar', ''],
  ['closeTab', 'Close tab', 'alt+w'],
  ['closeTabOutsideTerminals', 'Close tab (not in terminals)', 'ctrl+w'],
  ['nextWorktree', 'Next worktree', 'alt+arrowdown'],
  ['prevWorktree', 'Previous worktree', 'alt+arrowup'],
  ['nextTab', 'Next tab', 'alt+]'],
  ['prevTab', 'Previous tab', 'alt+['],
  ['nextTabAlt', 'Next tab (second key)', 'ctrl+tab'],
  ['prevTabAlt', 'Previous tab (second key)', 'ctrl+shift+tab'],
];
/** Actions that leave the key to a focused terminal (Ctrl+W deletes a word in shells). */
export const NOT_IN_TERMINALS = new Set(['closeTabOutsideTerminals']);

// Keys the terminal, the editor or SkiffCode itself handle: copy/paste, save, undo, Alt+1–9 worktree jump.
const RESERVED = new Set(['ctrl+c', 'ctrl+v', 'ctrl+x', 'ctrl+shift+c', 'ctrl+shift+v', 'ctrl+s', 'ctrl+z',
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `alt+digit${n}`)]);

const DEFAULTS = Object.fromEntries(KEY_ACTIONS.map(([id, , key]) => [id, key]));
const LABELS = Object.fromEntries(KEY_ACTIONS.map(([id, label]) => [id, label]));

/** The key an action has now: the user's choice, else the default. '' = none. */
export function keyOf(id) {
  const o = store.settings.keybindings || {};
  return typeof o[id] === 'string' ? o[id] : DEFAULTS[id] || '';
}

/** Settings → Keyboard shortcuts → "Use SkiffCode shortcuts". */
export const shortcutsOn = () => store.settings.shortcutsEnabled !== false;

// With shortcuts off, the palette key still works, so commands (and the switch) stay in reach.
const live = id => shortcutsOn() || id === 'commands';

/** [id, spec] for every action whose key works now. */
export function activeKeys() {
  return KEY_ACTIONS.map(([id]) => [id, keyOf(id)]).filter(([id, k]) => k && live(id));
}

/** The key to show next to an action ('Ctrl+P'), or '' when it has none that works now. */
export const keyHint = id => (live(id) ? keyLabel(keyOf(id)) : '');

/** 'Jump to…' → 'Jump to… (Ctrl+Alt+J)', or the title alone when the action has no working key. */
export const withKey = (title, id) => (keyHint(id) ? `${title} (${keyHint(id)})` : title);

export async function setShortcutsOn(on) {
  store.settings = { ...store.settings, shortcutsEnabled: on };
  notify(); // redraw key hints
  await call('settings.set', { values: { shortcutsEnabled: on } });
}

const norm = spec => {
  const parts = spec.toLowerCase().split('+');
  const key = parts.pop();
  return [...['ctrl', 'alt', 'shift'].filter(m => parts.includes(m)), key].join('+');
};

const NAMES = { arrowdown: '↓', arrowup: '↑', arrowleft: '←', arrowright: '→', space: 'Space', escape: 'Esc' };
/** 'ctrl+shift+p' → 'Ctrl+Shift+P' */
export function keyLabel(spec) {
  if (!spec) return '';
  return spec.split('+').map((p, i, all) => {
    if (i < all.length - 1) return p.charAt(0).toUpperCase() + p.slice(1);
    if (NAMES[p]) return NAMES[p];
    const digit = /^digit(\d)$/.exec(p);
    if (digit) return digit[1];
    return p.length === 1 || /^f\d+$/.test(p) ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1);
  }).join('+');
}

/** A key press → { spec } in the form isKey() matches, { error }, or null for a lone modifier. */
function specFromEvent(e) {
  if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'CapsLock'].includes(e.key)) return null;
  if (!(e.ctrlKey || e.metaKey || e.altKey)) return { error: 'Use Ctrl or Alt with the key, so typing still works.' };
  let key;
  // Letters and digits by physical key: with Shift or Alt, e.key can be another character.
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  else if (/^Digit\d$/.test(e.code)) key = e.code.toLowerCase();
  else if (e.code === 'Backquote') key = '`';
  else if (e.key === ' ') key = 'space';
  else if (['+', 'Dead', 'Unidentified'].includes(e.key)) key = e.code.toLowerCase(); // '+' is the spec's separator
  else key = e.key.toLowerCase();
  const spec = [(e.ctrlKey || e.metaKey) && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift', key].filter(Boolean).join('+');
  if (RESERVED.has(spec)) return { error: `${keyLabel(spec)} is reserved for copy, paste, save, undo or worktree jumps.` };
  return { spec };
}

const HINT = 'Click a key to change it.';

export function keybindingsDialog() {
  const keys = Object.fromEntries(KEY_ACTIONS.map(([id]) => [id, keyOf(id)]));
  let recording = null;
  const rows = h('div.keys-rows');
  const enabled = h('input', { type: 'checkbox', checked: shortcutsOn(), onchange: () => rows.classList.toggle('off', !enabled.checked) });
  rows.classList.toggle('off', !enabled.checked);
  const enabledHint = h('span.keys-enabled-hint');
  const note = h('div.keys-note', HINT);
  const say = (text, warn) => { note.textContent = text; note.classList.toggle('warn', !!warn); };
  const assign = (id, spec) => {
    const taken = [];
    if (spec) {
      for (const [other] of KEY_ACTIONS) {
        if (other !== id && keys[other] && norm(keys[other]) === norm(spec)) {
          keys[other] = '';
          taken.push(LABELS[other]);
        }
      }
    }
    keys[id] = spec;
    say(taken.length ? `Removed from ${taken.join(', ')}` : HINT);
    render();
  };
  const render = () => {
    enabledHint.textContent = keys.commands
      ? `Off: keys go to the terminal or editor. ${keyLabel(keys.commands)} (command palette) still works.`
      : 'Off: keys go to the terminal or editor. Turn them back on here, in Settings → Keyboard shortcuts.';
    clear(rows, KEY_ACTIONS.map(([id, label, def]) => h('div.keys-row', { dataset: { id } },
      h('span.keys-label', label),
      h(`button.keys-key${recording === id ? '.recording' : ''}`, {
        title: 'Click, then press the new key',
        onclick: () => { recording = id; say('Press the new key. Esc cancels.'); render(); },
      }, recording === id ? 'Press a key…' : keys[id] ? keyLabel(keys[id]) : h('span.keys-none', 'None')),
      h('button.icon-btn', { title: 'Reset to default', disabled: keys[id] === def, onclick: () => { recording = null; assign(id, def); } }, icon('refresh')),
      h('button.icon-btn', { title: 'Remove key', disabled: !keys[id], onclick: () => { recording = null; assign(id, ''); } }, icon('close')))));
  };
  // Window capture runs before the modal's own Escape handler on document.
  const onKey = e => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      recording = null;
      say(HINT);
      return render();
    }
    const r = specFromEvent(e);
    if (!r) return;
    if (r.error) return say(r.error, true);
    const id = recording;
    recording = null;
    assign(id, r.spec);
  };
  window.addEventListener('keydown', onKey, true);
  const m = modal([
    h('div.modal-title', 'Keyboard shortcuts'),
    h('label.keys-enabled', enabled, 'Use SkiffCode shortcuts', enabledHint),
    rows,
    note,
    h('div.modal-buttons',
      h('button.btn', { onclick: () => m.close() }, 'Cancel'),
      h('button.btn.primary', { onclick: () => m.close('save') }, 'Save')),
  ], {
    onClose: async v => {
      window.removeEventListener('keydown', onKey, true);
      if (v !== 'save') return;
      const keybindings = {};
      for (const [id] of KEY_ACTIONS) if (keys[id] !== DEFAULTS[id]) keybindings[id] = keys[id];
      const values = { keybindings, shortcutsEnabled: enabled.checked };
      store.settings = { ...store.settings, ...values };
      notify(); // redraw key hints
      await call('settings.set', { values });
    },
  });
  m.box.classList.add('keys-modal');
  render();
}
