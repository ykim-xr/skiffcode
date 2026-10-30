// Settings → Sounds: a sound for each alert (built-in, your own file, or none) and the volume.
import { h, icon, clear } from './util.js';
import { call, on } from './rpc.js';
import { store } from './store.js';
import { modal, toast } from './dialogs.js';
import { playSoundId, SOUND_DEFAULTS } from './alerts.js';

const KINDS = [
  ['question', 'Asks you a question'],
  ['permission', 'Needs permission'],
  ['done', 'Finished working'],
];
const TITLE = s => s.charAt(0).toUpperCase() + s.slice(1);

export async function soundsDialog() {
  let list = await call('sounds.list');
  const before = { sounds: { ...SOUND_DEFAULTS, ...(store.settings.sounds || {}) }, volume: store.settings.volume ?? 70 };
  const draft = { sounds: { ...before.sounds }, volume: before.volume };
  const rows = h('div.sound-rows');
  const mine = h('div.sound-mine');
  const vol = h('input.sound-volume', { type: 'range', min: '0', max: '100', step: '5', value: String(draft.volume) });
  const volText = h('span.sound-volume-text', `${draft.volume}%`);
  const file = h('input', { type: 'file', accept: '.wav,.mp3,.ogg,.m4a,audio/*', style: { display: 'none' } });

  const options = selected => [
    h('optgroup', { label: 'Built-in' }, list.builtin.map(n => h('option', { value: n, selected: selected === n ? true : undefined }, TITLE(n)))),
    list.custom.length ? h('optgroup', { label: 'Your sounds' }, list.custom.map(c => h('option', { value: c.id, selected: selected === c.id ? true : undefined }, c.name))) : null,
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
    clear(mine, list.custom.length
      ? list.custom.map(c => h('div.sound-file', icon('file'), h('span.sound-file-name', c.name),
        h('button.icon-btn', { title: 'Play', onclick: () => playSoundId(c.id, draft.volume) }, icon('play')),
        h('button.icon-btn', { title: 'Remove', onclick: async () => { await call('sounds.remove', { id: c.id }); list = await call('sounds.list'); for (const [k] of KINDS) if (draft.sounds[k] === c.id) draft.sounds[k] = SOUND_DEFAULTS[k]; render(); } }, icon('trash'))))
      : h('div.muted.sound-none', 'Add a .wav, .mp3, .ogg or .m4a file (up to 3 MB).'));
  };
  vol.addEventListener('input', () => { draft.volume = Number(vol.value); volText.textContent = `${draft.volume}%`; });
  vol.addEventListener('change', () => playSoundId(draft.sounds.question, draft.volume));
  file.addEventListener('change', async () => {
    const f = file.files && file.files[0];
    file.value = '';
    if (!f) return;
    if (f.size > 3 * 1024 * 1024) return toast('Keep sounds under 3 MB.', { kind: 'error' });
    const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(f); });
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
      await call('settings.set', { values: { sounds: draft.sounds, volume: draft.volume } });
    },
  });
  m.box.classList.add('sounds-modal');
  render();
}
