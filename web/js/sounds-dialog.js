// Settings → Sounds: a sound for each alert (built-in, your own file, or none) and the volume.
import { h, icon, clear } from './util.js';
import { call, on } from './rpc.js';
import { store } from './store.js';
import { modal, toast } from './dialogs.js';
import { playSoundId } from './alerts.js';
import { toBase64 } from './dnd.js';

const KINDS = [
  ['question', 'Asks you a question'],
  ['permission', 'Needs permission'],
  ['done', 'Finished working'],
];
const MAX_SOUND = 3 * 1024 * 1024; // the server's limit too
const TITLE = s => s.charAt(0).toUpperCase() + s.slice(1);

export async function soundsDialog() {
  let list;
  try {
    list = await call('sounds.list');
  } catch (e) {
    toast(e.message, { kind: 'error' });
    return;
  }
  const before = { sounds: { ...list.defaults, ...store.settings.sounds }, volume: store.settings.volume };
  const draft = { sounds: { ...before.sounds }, volume: before.volume };
  const removed = new Set(); // your sounds to delete on Save
  const custom = () => list.custom.filter(c => !removed.has(c.id));
  const rows = h('div.sound-rows');
  const mine = h('div.sound-mine');
  const vol = h('input.sound-volume', { type: 'range', min: '0', max: '100', step: '5', value: String(draft.volume) });
  const volText = h('span.sound-volume-text', `${draft.volume}%`);
  const file = h('input', { type: 'file', accept: '.wav,.mp3,.ogg,.m4a,audio/*', style: { display: 'none' } });

  const options = selected => [
    h('optgroup', { label: 'Built-in' }, list.builtin.map(n => h('option', { value: n, selected: selected === n ? true : undefined }, TITLE(n)))),
    custom().length ? h('optgroup', { label: 'Your sounds' }, custom().map(c => h('option', { value: c.id, selected: selected === c.id ? true : undefined }, c.name))) : null,
    h('option', { value: 'none', selected: selected === 'none' ? true : undefined }, 'No sound'),
  ];
  const render = () => {
    clear(rows, KINDS.map(([k, label]) => {
      const sel = h('select.input.sound-select', { 'data-kind': k, onchange: () => { draft.sounds[k] = sel.value; playSoundId(sel.value, draft.volume); } }, options(draft.sounds[k]));
      return h('div.sound-row',
        h('span.sound-label', label),
        sel,
        h('button.icon-btn', { title: 'Play', onclick: () => playSoundId(draft.sounds[k], draft.volume) }, icon('play')));
    }));
    clear(mine, custom().length
      ? custom().map(c => h('div.sound-file', icon('file'), h('span.sound-file-name', c.name),
        h('button.icon-btn', { title: 'Play', onclick: () => playSoundId(c.id, draft.volume) }, icon('play')),
        h('button.icon-btn', { title: 'Remove', onclick: () => { removed.add(c.id); for (const [k] of KINDS) if (draft.sounds[k] === c.id) draft.sounds[k] = list.defaults[k]; render(); } }, icon('trash'))))
      : h('div.muted.sound-none', 'Add a .wav, .mp3, .ogg or .m4a file (up to 3 MB).'));
  };
  vol.addEventListener('input', () => { draft.volume = Number(vol.value); volText.textContent = `${draft.volume}%`; });
  vol.addEventListener('change', () => playSoundId(draft.sounds.question, draft.volume));
  file.addEventListener('change', async () => {
    const f = file.files && file.files[0];
    file.value = '';
    if (!f) return;
    if (f.size > MAX_SOUND) return toast('Keep sounds under 3 MB.', { kind: 'error' });
    const data = await toBase64(f);
    try {
      const up = await call('sounds.upload', { name: f.name, data });
      list = await call('sounds.list');
      render();
      playSoundId(up.id, draft.volume);
      toast(`Added “${up.name}”. Pick it for an alert above.`, { icon: 'unmute', timeout: 4000 });
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  });
  const off = on('sounds.changed', l => { list = l; render(); });
  const m = modal([
    h('div.modal-title', 'Sounds'),
    rows,
    h('div.sound-row.sound-volume-row', h('span.sound-label', 'Volume'), vol, volText),
    h('div.look-label', 'Your sounds'),
    mine,
    h('div.modal-buttons',
      h('button.btn', { onclick: () => file.click() }, icon('plus'), 'Add your own…'),
      h('span.flex'),
      h('button.btn', { onclick: () => m.close() }, 'Cancel'),
      h('button.btn.primary', { onclick: () => m.close('save') }, 'Save')),
    file,
  ], {
    onClose: async v => {
      off();
      if (v !== 'save') return;
      store.settings = { ...store.settings, sounds: draft.sounds, volume: draft.volume };
      for (const id of removed) await call('sounds.remove', { id }).catch(e => toast(e.message, { kind: 'error' }));
      await call('settings.set', { values: { sounds: draft.sounds, volume: draft.volume } });
    },
  });
  m.box.classList.add('sounds-modal');
  render();
}
