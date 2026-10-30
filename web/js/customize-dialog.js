// "Customize…" for a repo, folder or group: an icon (built-in or emoji) and a text color.
import { h, icon, clear } from './util.js';
import { call } from './rpc.js';
import { modal } from './dialogs.js';

export const ICONS = ['repo', 'folder', 'home', 'code', 'star', 'bolt', 'rocket', 'globe', 'server', 'cloud', 'box', 'book', 'flask', 'bug', 'chart', 'leaf', 'heart', 'flag', 'lock', 'phone', 'briefcase', 'terminal', 'git', 'gear'];
export const COLORS = ['#e5e5e5', '#f28b82', '#f6ad55', '#e5c07b', '#81b88b', '#4ec9b0', '#56b6c2', '#61afef', '#9d8cf5', '#c678dd', '#f48fb1', '#9d9d9d'];

/** The icon element for an entry: its own (built-in or emoji) or the default one. */
export function entryIcon(item, fallback, cls = 'row-icon') {
  const style = item && item.color ? { color: item.color } : undefined;
  if (item && item.icon && item.icon.startsWith('i:')) {
    const el = icon(item.icon.slice(2), cls);
    if (style) el.style.color = item.color;
    return el;
  }
  if (item && item.icon) return h(`span.row-emoji.${cls}`, item.icon);
  if (!fallback) return null;
  const el = icon(fallback, cls);
  if (style) el.style.color = item.color;
  return el;
}

/** kind: 'repo' (repos and folders) or 'group'. */
export function customizeDialog(kind, item) {
  let look = { icon: item.icon || '', color: item.color || '' };
  const fallback = kind === 'group' ? null : item.kind === 'folder' ? 'folder' : 'repo';
  const preview = h('div.look-preview');
  const grid = h('div.look-icons');
  const swatches = h('div.look-colors');
  const emoji = h('input.input.look-emoji', { placeholder: 'or type an emoji', maxlength: '4', value: look.icon && !look.icon.startsWith('i:') ? look.icon : '' });
  const custom = h('input.color-pick', { type: 'color', value: look.color || '#e5e5e5', title: 'Any color' });
  const render = () => {
    clear(preview, entryIcon(look, fallback, 'look-preview-icon'), h('span', { style: look.color ? { color: look.color } : {} }, item.name));
    clear(grid,
      h(`button.look-icon${!look.icon ? '.on' : ''}`, { title: 'Default', onclick: () => { look.icon = ''; emoji.value = ''; render(); } }, fallback ? icon(fallback) : h('span.muted', '—')),
      ICONS.filter(n => n !== fallback).map(n => h(`button.look-icon${look.icon === `i:${n}` ? '.on' : ''}`, { title: n, onclick: () => { look.icon = `i:${n}`; emoji.value = ''; render(); } }, icon(n))));
    clear(swatches,
      h(`button.look-color.default${!look.color ? '.on' : ''}`, { title: 'Default color', onclick: () => { look.color = ''; render(); } }, '×'),
      COLORS.map(c => h(`button.look-color${look.color === c ? '.on' : ''}`, { title: c, style: { background: c }, onclick: () => { look.color = c; custom.value = c; render(); } })),
      custom);
  };
  emoji.addEventListener('input', () => { look.icon = emoji.value.trim(); render(); });
  custom.addEventListener('input', () => { look.color = custom.value; render(); });
  const m = modal([
    h('div.modal-title', `Customize ${item.name}`),
    preview,
    h('div.look-label', 'Icon'), grid, emoji,
    h('div.look-label', 'Text color'), swatches,
    h('div.modal-buttons',
      h('button.btn', { onclick: () => { look = { icon: '', color: '' }; render(); } }, 'Reset'),
      h('span.flex'),
      h('button.btn', { onclick: () => m.close() }, 'Cancel'),
      h('button.btn.primary', { onclick: () => m.close('save') }, 'Save')),
  ], {
    onClose: async v => {
      if (v !== 'save') return;
      const values = { icon: look.icon || undefined, color: look.color || undefined };
      Object.assign(item, values); // show it right away; the server confirms
      if (kind === 'group') await call('groups.customize', { id: item.id, ...values });
      else await call('repos.customize', { path: item.path, ...values });
    },
  });
  m.box.classList.add('look-modal');
  render();
}
