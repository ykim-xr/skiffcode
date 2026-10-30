// "New worktree" form, Orca style: pick any branch as the base, name your
// new branch, see where the folder goes — or check out an existing branch.
import { h, icon, clear } from './util.js';
import { call } from './rpc.js';
import { store } from './store.js';
import { isTopModal } from './dialogs.js';

export function newWorktreeDialog(repo) {
  return new Promise(async resolve => {
    const br = await call('worktrees.branches', { repo: repo.path });
    let mode = 'new';

    const listId = `bases-${Math.random().toString(36).slice(2)}`;
    const base = h('input.input', { list: listId, value: br.defaultBase, spellcheck: 'false', placeholder: 'Branch to start from' });
    const bases = h('datalist', { id: listId }, br.refs.map(r => h('option', { value: r })));
    const name = h('input.input', { placeholder: 'feature/my-change', spellcheck: 'false' });
    const existing = h('select.input', {},
      br.free.length ? h('optgroup', { label: 'Local branches' }, br.free.map(b => h('option', { value: JSON.stringify({ branch: b }) }, b))) : null,
      br.remoteOnly.length ? h('optgroup', { label: 'Remote branches (creates a local tracking branch)' }, br.remoteOnly.map(r => h('option', { value: JSON.stringify({ remote: r }) }, r))) : null);
    const startClaude = h('input', { type: 'checkbox', checked: store.settings.startClaudeOnCreate !== false ? true : undefined });
    const where = h('div.form-hint');
    const err = h('div.modal-error');
    const create = h('button.btn.primary', { onclick: submit }, icon('branch'), 'Create worktree');

    const tabNew = h('button.seg.on', { onclick: () => setMode('new') }, 'New branch');
    const tabExisting = h('button.seg', { onclick: () => setMode('existing'), disabled: !br.free.length && !br.remoteOnly.length ? true : undefined }, 'Existing branch');
    const newFields = h('div.form-fields',
      h('label.form-row', h('span', 'Base branch'), base, bases),
      h('label.form-row', h('span', 'New branch name'), name));
    const existingFields = h('div.form-fields.hidden', h('label.form-row', h('span', 'Branch'), existing));

    function setMode(m) {
      mode = m;
      tabNew.classList.toggle('on', m === 'new');
      tabExisting.classList.toggle('on', m === 'existing');
      newFields.classList.toggle('hidden', m !== 'new');
      existingFields.classList.toggle('hidden', m !== 'existing');
      void check();
      (m === 'new' ? name : existing).focus();
    }

    function spec() {
      if (mode === 'new') return { newBranch: name.value.trim(), base: base.value.trim() };
      const v = existing.value ? JSON.parse(existing.value) : {};
      if (v.branch) return { branch: v.branch };
      if (v.remote) return { newBranch: v.remote.slice(v.remote.indexOf('/') + 1), base: v.remote, track: true };
      return {};
    }

    let seq = 0;
    async function check() {
      const my = ++seq;
      const s = spec();
      const branch = s.newBranch || s.branch;
      err.textContent = '';
      if (mode === 'new') {
        if (!br.refs.includes(s.base)) {
          clear(where);
          if (s.base) err.textContent = `“${s.base}” isn’t a branch in ${repo.name}`;
          return false;
        }
        if (!branch) {
          clear(where, `New branch off `, h('b', s.base), '.');
          return false;
        }
      }
      if (!branch) return false;
      const r = s.branch ? { target: undefined } : await call('worktrees.checkName', { repo: repo.path, branch });
      if (my !== seq) return false;
      if (r.error) {
        err.textContent = r.error;
        clear(where);
        return false;
      }
      clear(where, icon('folder'), ' ', r.target ? r.target.replace(store.home, '~') : `${repo.name}.worktrees/…`);
      return true;
    }

    async function submit() {
      if (!(await check())) {
        (mode === 'new' ? name : existing).focus();
        return;
      }
      close({ ...spec(), startClaude: startClaude.checked });
    }

    let t;
    name.addEventListener('input', () => { clearTimeout(t); t = setTimeout(check, 150); });
    base.addEventListener('input', () => { clearTimeout(t); t = setTimeout(check, 150); });
    existing.addEventListener('change', check);
    for (const el of [name, base]) el.addEventListener('keydown', e => e.key === 'Enter' && submit());

    const back = h('div.modal-back');
    const box = h('div.modal.worktree-form',
      h('div.modal-title', `New worktree in ${repo.name}`),
      h('div.segmented', tabNew, tabExisting),
      newFields, existingFields,
      where, err,
      h('label.form-check', startClaude, ' Start a Claude session in it'),
      h('div.modal-buttons', h('button.btn', { onclick: () => close(undefined) }, 'Cancel'), create));
    back.append(box);
    const key = e => { if (e.key === 'Escape' && isTopModal(back)) { e.preventDefault(); close(undefined); } };
    document.addEventListener('keydown', key, true);
    back.addEventListener('mousedown', e => e.target === back && close(undefined));
    function close(v) {
      back.remove();
      document.removeEventListener('keydown', key, true);
      resolve(v);
    }
    document.getElementById('overlay').append(back);
    void check();
    setTimeout(() => name.focus(), 0);
  });
}
