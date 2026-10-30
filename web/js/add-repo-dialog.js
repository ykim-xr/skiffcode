// "Add a repository or folder": type a path or browse folders (git repos are marked).
import { h, icon, clear, tildify } from './util.js';
import { call } from './rpc.js';
import { store } from './store.js';
import { modal } from './dialogs.js';

const LAST = 'skiffcode.browseDir';

/** Resolves to the chosen folder (a repo or a folder inside one), or undefined. */
export function addRepoDialog() {
  return new Promise(resolve => {
    const input = h('input.input', { placeholder: `${store.home || '/home/you'}/code/my-repo`, spellcheck: 'false' });
    const err = h('div.modal-error');
    const list = h('div.browse-list');
    const crumbs = h('div.browse-crumbs');
    const hidden = h('input', { type: 'checkbox' });
    const add = h('button.btn.primary', { onclick: () => choose(cur && cur.repoRoot) }, 'Add');
    const m = modal([
      h('div.modal-title', 'Add a repository or folder'),
      h('div.modal-detail.muted', 'Git repositories are marked. Any other folder works too: open it and click “Add folder”.'),
      h('div.browse-row', h('button.icon-btn', { title: 'Up one folder', onclick: () => cur && cur.parent && go(cur.parent) }, icon('up')),
        h('button.icon-btn', { title: 'Home folder', onclick: () => go('~') }, icon('home')), input),
      crumbs,
      list,
      err,
      h('div.modal-buttons.browse-buttons',
        h('label.browse-hidden', hidden, ' Show hidden folders'),
        h('span.flex'),
        h('button.btn', { onclick: () => m.close(undefined) }, 'Cancel'),
        add),
    ], { wide: true, onClose: resolve });
    m.box.classList.add('browse-modal');

    let cur = null;
    let sel = -1;
    const shown = () => (cur ? cur.entries.filter(e => hidden.checked || !e.hidden) : []);

    function choose(p) {
      if (!p) return;
      try { localStorage.setItem(LAST, cur.path); } catch { /* fine */ }
      m.close(p);
    }

    function render() {
      clear(crumbs);
      const parts = cur.path.split('/').filter(Boolean);
      crumbs.append(h('button.link', { onclick: () => go('/') }, '/'));
      parts.forEach((part, i) => {
        if (i) crumbs.append(h('span.muted', ' / '));
        crumbs.append(h('button.link', { onclick: () => go('/' + parts.slice(0, i + 1).join('/')) }, part));
      });
      const v = shown();
      sel = Math.min(sel, v.length - 1);
      clear(list, v.length ? v.map((e, i) => h(`div.browse-item${e.git ? '.repo' : ''}${i === sel ? '.selected' : ''}`, {
        title: e.git ? (e.added ? 'Already in SkiffCode' : 'Git repository — double-click or Add') : 'Open folder',
        onclick: () => (e.git ? select(i) : go(e.path)),
        ondblclick: () => (e.git ? choose(e.path) : null),
      },
      icon(e.git ? 'repo' : 'folder', 'browse-icon'),
      h('span.browse-name', e.name),
      e.git ? h('span.browse-tag', e.added ? 'added' : 'git') : null,
      e.git ? h('button.btn.small', { onclick: ev => { ev.stopPropagation(); choose(e.path); } }, e.added ? 'Show' : 'Add') : icon('chevronRight', 'browse-go'))) : h('div.muted.browse-empty', 'No folders here.'));
      const target = sel >= 0 && v[sel] && v[sel].git ? v[sel] : null;
      if (target) {
        add.disabled = false;
        add.textContent = `${target.added ? 'Show' : 'Add'} ${target.name}`;
        add.onclick = () => choose(target.path);
      } else if (cur.repoRoot) {
        add.disabled = false;
        add.textContent = `${cur.added ? 'Show' : 'Add'} ${cur.repoRoot.split('/').pop()}`;
        add.onclick = () => choose(cur.repoRoot);
      } else if (cur.path !== '/' && cur.path !== cur.home) {
        // not a git repo: add the folder itself (Claude, shells, files and search; no git)
        const name = cur.path.split('/').pop();
        const already = (store.repos || []).some(r => r.path === cur.path);
        add.disabled = false;
        add.textContent = `${already ? 'Show' : 'Add'} folder ${name}`;
        add.onclick = () => choose(cur.path);
      } else {
        add.disabled = true;
        add.textContent = 'Add';
      }
    }

    function select(i) {
      sel = i;
      render();
    }

    async function go(p) {
      err.textContent = '';
      try {
        cur = await call('folders.browse', { path: p });
        sel = -1;
        input.value = tildify(cur.path, store.home);
        render();
      } catch (e) {
        err.textContent = e.message;
      }
    }

    hidden.addEventListener('change', render);
    input.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const v = input.value.trim();
      if (cur && tildify(cur.path, store.home) === v && cur.repoRoot) return choose(cur.repoRoot);
      void go(v);
    });
    list.addEventListener('keydown', () => {});
    let start = '~';
    try { start = localStorage.getItem(LAST) || '~'; } catch { /* fine */ }
    void go(start).then(() => { if (!cur) void go('~'); });
    setTimeout(() => input.focus(), 0);
  });
}
