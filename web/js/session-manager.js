// "Claude sessions": every saved Claude conversation on this machine, grouped by repo and worktree,
// with filters, suggested cleanups and bulk delete.
import { h, icon, clear, basename, tildify, debounce, TERM_SIZE } from './util.js';
import { call } from './rpc.js';
import { store, session, subscribe } from './store.js';
import { modal, toast, confirmDialog } from './dialogs.js';
import { when } from './resume-dialog.js';

const DAY = 86400e3;
const WHERE = [['All', 'all'], ['In SkiffCode', 'skiff'], ['Other folders', 'other'], ['Missing folders', 'missing']];
const AGE = [['Any', 0], ['Over a week', 7], ['Over a month', 30], ['Over 3 months', 90]];
const STATE = [['Any', 'any'], ['Running', 'running'], ['Stopped', 'stopped'], ['Not in SkiffCode', 'none']];
const SORT = [['Last active', 'active'], ['Size', 'size'], ['Prompts', 'prompts']];
const VIEW = [['Tree', 'tree'], ['List', 'list']];
const CHUNK = 50;
const BLOCK = { running: 'Running in SkiffCode: stopped first', live: 'Running in another terminal', active: 'Active in the last 2 minutes' };
const REASON = { running: 'running', live: 'running in another terminal', active: 'active in the last 2 minutes' };

export function fmtSize(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${i ? Math.round(n * 10) / 10 : Math.round(n)} ${units[i]}`;
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const sum = (list, f) => list.reduce((t, x) => t + f(x), 0);
const label = c => c.title || c.first || c.summary || '(no prompts)';

/** Opens the dialog. scope: { repo } or { worktree } (paths) limits it to that repo or worktree. */
export async function sessionManager(app, scope = {}) {
  if (document.querySelector('.sm-modal')) return;
  const ui = { q: '', where: 'all', age: 0, state: 'any', sort: 'active', view: 'tree' };
  let sc = { repo: scope.repo || null, worktree: scope.worktree || null };
  let all = [];
  let loaded = false;
  const selected = new Set();
  const collapsed = new Set();

  const summary = h('span.sm-summary');
  const err = h('div.modal-error');
  const notice = h('div.sm-notice');
  const search = h('input.input.sm-search', { placeholder: 'Search title, prompt, folder, branch or ID', spellcheck: 'false' });
  const body = h('div.sm-body', h('div.muted.sm-empty', 'Looking for conversations…'));
  const selText = h('span.sm-selected');
  const clearSel = h('button.link', { onclick: () => { selected.clear(); render(); } }, 'Clear');
  const del = h('button.btn.danger', { onclick: () => void removeIds([...selected]) }, 'Delete…');
  const suggest = h('div.sm-suggest');
  const scopeChip = h('button.btn.small.sm-scope', { title: 'Show every folder', onclick: () => { sc = { repo: null, worktree: null }; render(true); } });

  const groups = [];
  const chips = (title, key, options) => {
    const btns = options.map(([text, val]) => h('button.seg.sm-chip', { onclick: () => { ui[key] = val; render(true); } }, text));
    groups.push(() => btns.forEach((b, i) => b.classList.toggle('on', ui[key] === options[i][1])));
    return h('div.sm-fgroup', title ? h('span.sm-flabel', title) : null, h('div.segmented', ...btns));
  };
  const refresh = h('button.icon-btn', { title: 'Refresh', onclick: () => void load() }, icon('refresh'));

  const m = modal([
    h('div.sm-head', h('div.modal-title', 'Claude sessions'), summary, refresh),
    h('div.sm-toolbar',
      h('div.sm-line', search, scopeChip, chips('', 'view', VIEW)),
      h('div.sm-line', chips('Where', 'where', WHERE), chips('Last active', 'age', AGE)),
      h('div.sm-line', chips('State', 'state', STATE), chips('Sort', 'sort', SORT))),
    suggest, err, notice, body,
    h('div.sm-bar', selText, clearSel, del),
  ], { wide: true, onClose: () => { off(); document.removeEventListener('keydown', slash, true); } });
  m.box.classList.add('sm-modal');
  // Store changes come several times a second while Claude runs: redraw only when something a row shows has changed.
  const signature = () => JSON.stringify([
    store.home,
    all.flatMap(c => c.sessions.map(id => (session(id) || {}).state || '')),
    store.repos.map(r => [r.path, r.name, r.kind, ((store.worktrees.get(r.path) || {}).list || []).map(w => [w.path, w.branch, w.detached])]),
  ]);
  let seen = '';
  const off = subscribe(() => loaded && signature() !== seen && render());
  const slash = e => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || /^(TEXTAREA|SELECT)$/.test(document.activeElement.tagName) || (document.activeElement.tagName === 'INPUT' && document.activeElement.type !== 'checkbox')) return;
    const backs = document.querySelectorAll('#overlay .modal-back');
    if (backs[backs.length - 1] !== m.box.parentElement) return;
    e.preventDefault();
    search.focus();
  };
  document.addEventListener('keydown', slash, true);
  search.addEventListener('input', debounce(() => { ui.q = search.value.trim().toLowerCase(); render(true); }, 100));
  setTimeout(() => search.focus(), 0);

  // ---- what each conversation is, now

  const repoPaths = () => new Set(store.repos.map(r => r.path));
  const branchOf = c => {
    const w = c.worktreePath && ((store.worktrees.get(c.repoPath) || {}).list || []).find(x => x.path === c.worktreePath);
    return (w && w.branch) || '';
  };
  function info(c, repos) {
    const held = c.sessions.map(session).filter(Boolean);
    const heldRunning = held.some(s => s.state !== 'ended');
    const where = c.worktreePath && repos.has(c.repoPath) ? 'skiff' : c.cwd && !c.folderExists ? 'missing' : 'other';
    // the server's reason from the last load, unless a session of ours is running now
    const block = heldRunning ? 'running' : c.block;
    const running = block === 'running' || block === 'live';
    return { held, running, stopped: !running && held.length > 0, where, block, branch: branchOf(c) };
  }
  let infos = new Map();
  // for group checkboxes and suggestions: a blocked row is only ever picked by hand
  const selectable = c => !infos.get(c.id).block;
  const inScope = c => (!sc.worktree || c.worktreePath === sc.worktree) && (!sc.repo || c.repoPath === sc.repo);

  function visible() {
    const q = ui.q;
    return all.filter(c => {
      if (!inScope(c)) return false;
      const i = infos.get(c.id);
      if (ui.where !== 'all' && i.where !== ui.where) return false;
      if (ui.age && Date.now() - c.activeAt < ui.age * DAY) return false;
      if (ui.state === 'running' && !i.running) return false;
      if (ui.state === 'stopped' && !i.stopped) return false;
      if (ui.state === 'none' && i.held.length) return false;
      return !q || [c.title, c.first, c.summary, c.id, c.cwd, i.branch].some(t => t && t.toLowerCase().includes(q));
    });
  }

  const SUGGESTIONS = [
    ['In missing folders', c => c.cwd && !c.folderExists],
    ['Empty', c => c.empty],
    ['Idle over a month, not in SkiffCode', c => Date.now() - c.activeAt > 30 * DAY && !c.sessions.length],
  ];

  // ---- tree

  const sorter = () => {
    const key = { active: c => c.activeAt, size: c => c.size, prompts: c => c.prompts }[ui.sort];
    return (a, b) => key(b) - key(a);
  };
  const group = (kind, key, name, sub, rows, kids = []) => {
    const leaves = [...rows, ...kids.flatMap(k => k.leaves)];
    return { kind, key, name, sub, rows, kids, leaves };
  };
  function foldersOf(kind, items) {
    const by = new Map();
    for (const c of items) by.set(c.cwd, [...(by.get(c.cwd) || []), c]);
    return [...by].map(([cwd, rows]) => group('folder', `${kind}:${cwd}`, basename(cwd), tildify(cwd, store.home), rows))
      .sort((a, b) => {
        const f = { active: g => Math.max(...g.leaves.map(c => c.activeAt)), size: g => sum(g.leaves, c => c.size), prompts: g => sum(g.leaves, c => c.prompts) }[ui.sort];
        return f(b) - f(a);
      });
  }
  function buildTree(items) {
    const out = [];
    for (const r of store.repos) {
      const mine = items.filter(c => c.repoPath === r.path && infos.get(c.id).where === 'skiff');
      if (!mine.length) continue;
      if (r.kind === 'folder') { out.push(group('repo', `repo:${r.path}`, r.name, tildify(r.path, store.home), mine)); continue; }
      const list = (store.worktrees.get(r.path) || {}).list || [];
      const paths = [...list.map(w => w.path), ...new Set(mine.map(c => c.worktreePath))].filter((p, i, a) => a.indexOf(p) === i);
      const kids = paths.map(p => {
        const rows = mine.filter(c => c.worktreePath === p);
        const w = list.find(x => x.path === p);
        return rows.length ? group('worktree', `wt:${p}`, basename(p), w ? w.branch || (w.detached ? 'detached' : '') : '', rows) : null;
      }).filter(Boolean);
      out.push(group('repo', `repo:${r.path}`, r.name, tildify(r.path, store.home), [], kids));
    }
    const rest = items.filter(c => infos.get(c.id).where !== 'skiff');
    const other = rest.filter(c => c.cwd && c.folderExists);
    const missing = rest.filter(c => c.cwd && !c.folderExists);
    const unknown = rest.filter(c => !c.cwd);
    if (other.length) out.push(group('other', 'other', 'Other folders', '', [], foldersOf('o', other)));
    if (missing.length) out.push(group('missing', 'missing', 'Missing folders', '', [], foldersOf('m', missing)));
    if (unknown.length) out.push(group('unknown', 'unknown', 'Unknown folder', '', unknown));
    return out;
  }

  // ---- rendering

  const stats = leaves => `${leaves.length} · ${fmtSize(sum(leaves, c => c.size))} · ${when(Math.max(...leaves.map(c => c.activeAt)))}`;

  function groupRow(g, depth) {
    const open = !collapsed.has(g.key);
    const pick = g.leaves.filter(selectable);
    const n = pick.filter(c => selected.has(c.id)).length;
    const cb = h('input', {
      type: 'checkbox',
      disabled: !pick.length,
      title: pick.length ? 'Select all in this group' : 'Nothing here can be selected now',
      onclick: e => e.stopPropagation(),
      onchange: () => { for (const c of pick) (n === pick.length ? selected.delete(c.id) : selected.add(c.id)); render(); },
    });
    cb.checked = !!pick.length && n === pick.length;
    cb.indeterminate = n > 0 && n < pick.length;
    return h('div.sm-group', {
      dataset: { kind: g.kind, name: g.name },
      style: { paddingLeft: `${8 + depth * 16}px` },
      onclick: () => { open ? collapsed.add(g.key) : collapsed.delete(g.key); render(); },
    },
    icon(open ? 'chevronDown' : 'chevronRight', 'twisty'),
    cb,
    icon(g.kind === 'repo' ? 'repo' : g.kind === 'worktree' ? 'branch' : 'folder', 'row-icon'),
    h('span.sm-name', g.name),
    g.sub ? h('span.sm-sub', { title: g.sub }, g.sub) : null,
    h('span.sm-stats', stats(g.leaves)));
  }

  function convRow(c, depth, showWhere) {
    const i = infos.get(c.id);
    const cb = h('input', {
      type: 'checkbox',
      title: BLOCK[i.block] || 'Select',
      onchange: () => { cb.checked ? selected.add(c.id) : selected.delete(c.id); render(); },
    });
    cb.checked = selected.has(c.id);
    const sub = c.worktreePath && !c.atRoot && c.cwd ? c.cwd.startsWith(`${c.worktreePath}/`) ? c.cwd.slice(c.worktreePath.length + 1) : basename(c.cwd) : '';
    const where = showWhere ? (i.where === 'skiff' ? [(store.repos.find(r => r.path === c.repoPath) || {}).name, i.branch || basename(c.worktreePath)].filter(Boolean).join(' · ') : tildify(c.cwd || 'Unknown folder', store.home)) : '';
    const canResume = c.worktreePath && c.atRoot && c.folderExists && i.block !== 'live'; // a second Claude on one transcript would corrupt it
    const btn = (title, ic, fn) => h('button.icon-btn', { title, onclick: e => { e.stopPropagation(); fn(); } }, icon(ic));
    return h('div.sm-row', {
      dataset: { id: c.id },
      style: { paddingLeft: `${8 + depth * 16}px` },
      title: [c.first && c.first !== c.title ? `First prompt: ${c.first}` : '', c.summary ? `Summary: ${c.summary}` : '', c.cwd ? `Folder: ${c.cwd}` : '', `ID: ${c.id}`].filter(Boolean).join('\n'),
    },
    cb,
    icon('claude', 'resume-icon'),
    h('div.sm-main',
      h('div.sm-label', label(c)),
      h('div.sm-meta', `${when(c.activeAt)} · ${c.prompts}${c.prompts >= 50 ? '+' : ''} prompt${c.prompts === 1 ? '' : 's'} · ${fmtSize(c.size)}`, where ? ` · ${where}` : '')),
    sub ? h('span.sm-tag', `in subfolder ${sub}`) : null,
    i.running ? h('span.sm-tag.run', 'running') : i.stopped ? h('span.sm-tag', 'stopped') : null,
    h('span.sm-actions',
      canResume ? btn('Resume', 'play', () => void resume(c)) : null,
      btn('Copy ID', 'files', () => copy(c.id)),
      c.cwd ? btn('Copy resume command', 'terminal', () => copy(`cd '${c.cwd.replace(/'/g, `'\\''`)}' && claude --resume ${c.id}`)) : null,
      btn('Delete', 'trash', () => void removeIds([c.id]))));
  }

  function treeRows(g, depth, out) {
    out.push(groupRow(g, depth));
    if (collapsed.has(g.key)) return;
    for (const c of g.rows.sort(sorter())) out.push(convRow(c, depth + 1, false));
    for (const k of g.kids) treeRows(k, depth + 1, out);
  }

  /** pruneSelection: the search, a filter or the scope changed, so rows that left the list leave the selection. */
  function render(pruneSelection) {
    seen = signature();
    const repos = repoPaths();
    infos = new Map(all.map(c => [c.id, info(c, repos)]));
    for (const id of [...selected]) if (!infos.has(id)) selected.delete(id);
    for (const sync of groups) sync();
    const scoped = all.filter(inScope);
    const shown = visible();
    if (pruneSelection) {
      const ids = new Set(shown.map(c => c.id));
      for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
    }
    summary.textContent = loaded
      ? `${plural(scoped.length, 'conversation')} · ${fmtSize(sum(scoped, c => c.size))}${shown.length < scoped.length ? ` · ${shown.length} shown` : ''}`
      : '';
    scopeChip.classList.toggle('hidden', !sc.repo && !sc.worktree);
    clear(scopeChip, basename(sc.worktree || sc.repo || ''), icon('close'));

    clear(suggest, h('span.sm-flabel', 'Suggested cleanup'), ...SUGGESTIONS.map(([name, test]) => {
      const set = scoped.filter(c => test(c) && selectable(c));
      if (!set.length) return null;
      return h('button.btn.small', {
        onclick: () => {
          Object.assign(ui, { q: '', where: 'all', age: 0, state: 'any' }); // show what was picked
          search.value = '';
          selected.clear();
          for (const c of set) selected.add(c.id);
          render();
        },
      }, `${name} · ${set.length} · ${fmtSize(sum(set, c => c.size))}`);
    }));
    suggest.classList.toggle('hidden', !suggest.querySelector('button'));

    const top = body.scrollTop;
    if (!loaded) clear(body, h('div.muted.sm-empty', 'Looking for conversations…'));
    else if (!shown.length) clear(body, h('div.muted.sm-empty', all.length ? 'No conversations match.' : 'Claude has no saved conversations.'));
    else if (ui.view === 'list') clear(body, shown.slice().sort(sorter()).map(c => convRow(c, 0, true)));
    else {
      const rows = [];
      for (const g of buildTree(shown)) treeRows(g, 0, rows);
      clear(body, rows);
    }
    body.scrollTop = top;

    const chosen = all.filter(c => selected.has(c.id));
    selText.textContent = chosen.length ? `${chosen.length} selected · ${fmtSize(sum(chosen, c => c.size))}` : 'Nothing selected';
    clearSel.classList.toggle('hidden', !chosen.length);
    del.disabled = !chosen.length;
  }

  // ---- actions

  const copy = text => navigator.clipboard.writeText(text).then(() => toast('Copied', { timeout: 1500 }), () => {});

  async function resume(c) {
    const running = infos.get(c.id).held.find(s => s.state !== 'ended');
    try {
      const s = running || await call('sessions.adopt', { worktreePath: c.worktreePath, conversation: c.id, ...TERM_SIZE });
      m.close();
      await app.actions.focusSession(s.id);
    } catch (e) {
      err.textContent = e.message;
    }
  }

  let busy = false;
  async function removeIds(ids) {
    if (busy || !ids.length) return;
    const picked = all.filter(c => ids.includes(c.id));
    const names = [...new Set(picked.map(c => (c.cwd ? basename(c.cwd) : 'Unknown folder')))];
    const held = picked.some(c => c.sessions.length);
    const blocked = b => picked.filter(c => infos.get(c.id).block === b).map(c => c.id);
    const running = blocked('running');
    const live = blocked('live');
    const active = blocked('active');
    const used = [...live, ...active];
    const v = await confirmDialog({
      title: `Delete ${plural(picked.length, 'conversation')}?`,
      detail: [
        `This frees ${fmtSize(sum(picked, c => c.size))}. Folders: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ` and ${names.length - 5} more` : ''}.`,
        running.length ? `${running.length} running in SkiffCode will be stopped first.` : '',
        live.length ? `${live.length} are running in another terminal; Claude there can write them again.` : '',
        active.length ? `${active.length} were written in the last 2 minutes.` : '',
        held ? 'Their sessions in SkiffCode are removed too.' : '',
        'They won’t appear in /resume any more. This can’t be undone.',
      ].filter(Boolean).join('\n'),
      buttons: [{ label: running.length ? 'Stop and delete' : used.length ? 'Delete anyway' : picked.length === 1 ? 'Delete conversation' : 'Delete conversations', value: 'yes', danger: true }],
    });
    if (v !== 'yes') return;
    busy = true;
    err.textContent = '';
    let done = 0;
    let freed = 0;
    const refused = [];
    try {
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        // per id, only what the dialog said: a row that became busy since is still refused
        const stop = running.filter(id => chunk.includes(id));
        const force = used.filter(id => chunk.includes(id));
        const { results } = await call('claude.deleteConversations', { ids: chunk, ...(stop.length && { stop }), ...(force.length && { force }) });
        for (const r of results) {
          if (r.ok) { done++; freed += r.freed || 0; } else refused.push(r);
          selected.delete(r.id);
        }
      }
    } catch (e) {
      err.textContent = e.message;
    }
    if (done) toast(`Deleted ${plural(done, 'conversation')} · freed ${fmtSize(freed)}`, { kind: 'ok', icon: 'trash', timeout: 4000 });
    const why = r => `${label(all.find(c => c.id === r.id) || { title: r.id })} (${REASON[r.reason] || r.reason})`;
    notice.textContent = refused.length ? `Not deleted: ${refused.slice(0, 5).map(why).join('; ')}${refused.length > 5 ? ` and ${refused.length - 5} more` : ''}.` : '';
    busy = false;
    await load();
  }

  async function load() {
    err.textContent = '';
    try {
      const r = await call('claude.allConversations');
      all = r.conversations;
    } catch (e) {
      all = [];
      err.textContent = e.message;
    }
    loaded = true;
    render();
  }

  render();
  await load();
}
