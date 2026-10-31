// "Resume a Claude conversation": past conversations of a worktree (from Claude's own
// transcripts, wherever they were started), or a pasted `claude --resume …` line / ID.
import { h, icon, clear, basename, relTime, TERM_SIZE } from './util.js';
import { call } from './rpc.js';
import { store, session } from './store.js';
import { modal, toast, confirmDialog } from './dialogs.js';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function when(ts) {
  const d = new Date(ts);
  const days = (Date.now() - ts) / 86400e3;
  if (days < 1) return `${relTime(ts)} ago`.replace('now ago', 'just now');
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

/** Opens the dialog for a worktree. app: the SkiffCode app (for opening the session). */
export async function resumeDialog(app, worktreePath, { value = '' } = {}) {
  const input = h('input.input', { placeholder: 'Search, or paste  claude --resume <id>  or an ID', spellcheck: 'false', value });
  const err = h('div.modal-error');
  const list = h('div.resume-list', h('div.muted.resume-empty', 'Looking for conversations…'));
  const go = h('button.btn.primary', { onclick: () => submit() }, 'Resume');
  const m = modal([
    h('div.modal-title', `Resume a Claude conversation — ${basename(worktreePath)}`),
    h('div.modal-detail.muted', 'Conversations Claude has saved for this folder, including ones started outside SkiffCode (a terminal, Orca, …). They open as SkiffCode sessions, with alerts and status.'),
    h('div.resume-row', input, go),
    err,
    list,
  ], { wide: true });
  m.box.classList.add('resume-modal');
  setTimeout(() => input.focus(), 0);

  let items = [];
  let sel = 0;
  const label = c => c.title || c.first || c.summary || '(no prompt)';
  const visible = () => {
    const q = input.value.trim().toLowerCase();
    if (!q || UUID.test(q)) return items;
    return items.filter(c => [c.title, c.first, c.summary, c.id].some(t => t && t.toLowerCase().includes(q)));
  };
  const render = () => {
    const v = visible();
    const pasted = UUID.test(input.value);
    go.textContent = pasted ? 'Resume pasted ID' : 'Resume';
    go.disabled = !pasted && !v.length;
    if (!items.length) return;
    sel = Math.max(0, Math.min(sel, v.length - 1));
    clear(list, v.length ? v.map((c, i) => {
      const live = c.session && session(c.session);
      const acct = (store.accounts || []).length > 1 ? ((store.accounts || []).find(a => a.id === c.account) || {}).name : '';
      return h(`div.resume-item${i === sel && !pasted ? '.selected' : ''}`, {
        title: [c.title && c.first ? `First prompt: ${c.first}` : '', c.summary ? `Summary: ${c.summary}` : '', `ID: ${c.id}`].filter(Boolean).join('\n'),
        onmousemove: () => { if (sel !== i) { sel = i; render(); } },
        onclick: () => pick(c),
      },
      icon('claude', 'resume-icon'),
      h('div.resume-main',
        h('div.resume-title', label(c)),
        h('div.resume-meta', [when(c.updated), c.prompts ? `${c.prompts}${c.prompts >= 50 ? '+' : ''} prompt${c.prompts === 1 ? '' : 's'}` : '', acct].filter(Boolean).join(' · '))),
      live ? h('span.resume-tag', live.state === 'ended' ? 'in SkiffCode · stopped' : 'open in SkiffCode') : null,
      h('button.icon-btn.resume-delete', { title: 'Delete this conversation', onclick: ev => { ev.stopPropagation(); void remove(c); } }, icon('trash')));
    }) : h('div.muted.resume-empty', 'No conversations match.'));
  };
  input.addEventListener('input', () => { err.textContent = ''; sel = 0; render(); });
  input.addEventListener('keydown', e => {
    const v = visible();
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, v.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });

  async function remove(c) {
    const v = await confirmDialog({
      title: `Delete “${label(c)}”?`,
      detail: `Deletes Claude’s saved conversation${c.session ? ' and its session in SkiffCode' : ''}. It won’t appear in /resume any more. This can’t be undone.`,
      buttons: [{ label: 'Delete conversation', value: 'yes', danger: true }],
    });
    if (v !== 'yes') return;
    try {
      await call('claude.deleteConversation', { worktreePath, id: c.id });
      items = items.filter(x => x.id !== c.id);
      if (!items.length) clear(list, h('div.muted.resume-empty', 'No saved conversations left for this folder.'));
      render();
    } catch (e) {
      err.textContent = e.message;
    }
  }

  async function pick(c) {
    await adopt(c.id, c.account);
  }
  function submit() {
    if (UUID.test(input.value)) return adopt(input.value);
    const c = visible()[sel];
    if (c) return pick(c);
  }
  let busy = false;
  async function adopt(conversation, account) {
    if (busy) return;
    busy = true;
    try {
      const s = await call('sessions.adopt', { worktreePath, conversation, account, ...TERM_SIZE });
      m.close(s);
      await app.actions.focusSession(s.id);
    } catch (e) {
      err.textContent = e.message;
    } finally {
      busy = false;
    }
  }

  try {
    items = await call('claude.history', { worktreePath });
  } catch (e) {
    items = [];
    err.textContent = e.message;
  }
  if (!items.length) clear(list, h('div.muted.resume-empty', 'Claude has no saved conversations for this folder. You can still paste a conversation ID above.'));
  render();
}

/** After adding a repo: point out conversations that already exist in its worktrees. */
export async function offerPastConversations(app, worktrees) {
  let total = 0;
  let where = null;
  for (const w of worktrees) {
    try {
      const list = (await call('claude.history', { worktreePath: w.path })).filter(c => !c.session);
      if (list.length && !where) where = w.path;
      total += list.length;
    } catch { /* skip */ }
  }
  if (!total) return;
  toast(`Found ${total} earlier Claude conversation${total > 1 ? 's' : ''} in this repo. Resume one here to get alerts and status.`, {
    icon: 'claude',
    timeout: 12000,
    actions: [{ label: 'Show', action: () => resumeDialog(app, where) }],
  });
}
