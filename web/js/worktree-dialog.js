// "New worktree" form, Orca style: pick any branch as the base, name your
// new branch, see where the folder goes — or check out an existing branch.
import { h, icon, clear, debounce } from './util.js';
import { call } from './rpc.js';
import { store } from './store.js';
import { modal, toast } from './dialogs.js';

export async function newWorktreeDialog(repo) {
  let br;
  try {
    br = await call('worktrees.branches', { repo: repo.path });
  } catch (e) {
    toast(e.message, { kind: 'error' });
    return undefined;
  }
  return new Promise(resolve => {
    let mode = 'new';

    const listId = `bases-${Math.random().toString(36).slice(2)}`;
    const base = h('input.input', { list: listId, value: br.defaultBase, spellcheck: 'false', placeholder: 'Branch to start from' });
    const bases = h('datalist', { id: listId }, br.refs.map(r => h('option', { value: r })));
    const name = h('input.input', { placeholder: 'feature/my-change', spellcheck: 'false' });
    const existing = h('select.input', {},
      br.free.length ? h('optgroup', { label: 'Local branches' }, br.free.map(b => h('option', { value: JSON.stringify({ branch: b }) }, b))) : null,
      br.remoteOnly.length ? h('optgroup', { label: 'Remote branches (creates a local tracking branch)' }, br.remoteOnly.map(r => h('option', { value: JSON.stringify({ remote: r }) }, r))) : null);
    const startClaude = h('input', { type: 'checkbox', checked: store.settings.startClaudeOnCreate ? true : undefined });
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
      m.close({ ...spec(), startClaude: startClaude.checked });
    }

    const checkSoon = debounce(check, 150);
    name.addEventListener('input', checkSoon);
    base.addEventListener('input', checkSoon);
    existing.addEventListener('change', check);
    for (const el of [name, base]) el.addEventListener('keydown', e => e.key === 'Enter' && submit());

    const m = modal([
      h('div.modal-title', `New worktree in ${repo.name}`),
      h('div.segmented', tabNew, tabExisting),
      newFields, existingFields,
      where, err,
      h('label.form-check', startClaude, ' Start a Claude session in it'),
      h('div.modal-buttons', h('button.btn', { onclick: () => m.close(undefined) }, 'Cancel'), create),
    ], { onClose: resolve });
    m.box.classList.add('worktree-form');
    void check();
    setTimeout(() => name.focus(), 0);
  });
}
