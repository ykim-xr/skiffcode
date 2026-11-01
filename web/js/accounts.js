// Claude usage in the status bar (5-hour / weekly, time to reset) and the account panel:
// saved logins, switching the shared login, adding one, refreshing usage.
import { h, icon, clear } from './util.js';
import { call, on } from './rpc.js';
import { store, notify } from './store.js';
import { toast, promptDialog, confirmDialog, modal } from './dialogs.js';

on('usage', u => {
  store.usage = u;
  notify();
});

export function inUseAccount() {
  return store.accounts.find(a => a.inUse);
}

/** Usage of the login in use: under its account, or "current" when it isn't saved. */
function currentUsage() {
  const a = inUseAccount();
  return (store.usage || {})[a ? a.id : 'current'];
}

function whoText(x) {
  return [x.email, x.org, x.plan].filter(Boolean).join(' · ');
}

const timeText = ts => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** "2h 14m", "3d 4h", "12m" */
export function untilText(ts) {
  if (!ts) return '';
  const ms = ts - Date.now();
  if (ms <= 0) return 'now';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const hrs = Math.floor(m / 60);
  if (hrs < 24) return `${hrs}h ${m % 60}m`;
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}

function resetText(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `resets in ${untilText(ts)} (${sameDay ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`})`;
}

/** A window that already reset shows as unknown until Claude reports again. */
function live(w) {
  return w && (!w.resetsAt || w.resetsAt > Date.now()) ? w : undefined;
}

function level(pct) {
  return pct >= 90 ? 'hot' : pct >= 70 ? 'warm' : 'ok';
}

function meter(label, w) {
  if (!w) return h('span.usage-meter.unknown', label, ' —');
  const pct = Math.round(w.used);
  return h(`span.usage-meter.${level(pct)}`, label, ' ', h('span.usage-bar', h('span.usage-fill', { style: { width: `${Math.min(100, pct)}%` } })), ` ${pct}%`);
}

/** The status bar item. */
export function usageItem() {
  const a = inUseAccount();
  const cur = store.currentLogin;
  const u = currentUsage();
  const five = live(u && u.fiveHour);
  const week = live(u && u.weekly);
  const label = a ? a.name : cur ? cur.email : '';
  const tip = [
    `Claude login: ${a ? a.name : cur ? whoText(cur) || 'signed in' : 'not signed in'}`,
    five ? `5-hour: ${Math.round(five.used)}% used, ${resetText(five.resetsAt)}` : '5-hour: not reported yet',
    week ? `Weekly: ${Math.round(week.used)}% used, ${resetText(week.resetsAt)}` : 'Weekly: not reported yet',
    u ? `Updated ${timeText(u.at)} (Claude reports usage while a session is working)` : 'Usage appears once a Claude session talks to Claude (Pro/Max logins).',
    'Click to switch account or refresh usage',
  ].join('\n');
  return h('span.sb-item.click.usage', { title: tip, onclick: () => accountsDialog() },
    icon('claude', 'st-claude'),
    store.accounts.length && label ? h('span.usage-acct', label) : null,
    meter('5h', five),
    five && five.resetsAt ? h('span.usage-reset', `↻ ${untilText(five.resetsAt)}`) : null,
    meter('wk', week),
    week && week.resetsAt ? h('span.usage-reset', `↻ ${untilText(week.resetsAt)}`) : null);
}

/** The account panel. */
export async function accountsDialog() {
  const current = h('div.accounts-current');
  const body = h('div.accounts-list');
  const m = modal([
    h('div.modal-title', 'Claude accounts'),
    h('div.modal-detail.muted', 'Every Claude session uses the login in use. Pick a saved login to switch all of them, like /login does.'),
    current,
    body,
    h('div.modal-buttons',
      h('button.btn', { onclick: addAccount }, icon('plus'), 'Add account…'),
      h('button.btn.primary', { onclick: () => m.close() }, 'Done')),
  ]);
  m.box.classList.add('accounts-modal');

  const loading = new Set();
  const render = () => {
    const cur = store.currentLogin;
    clear(current,
      h('span.accounts-current-text', cur ? `Signed in now: ${whoText(cur) || 'unknown login'}` : 'Not signed in to Claude'),
      cur && cur.expired ? h('span.account-warn', 'expired') : null,
      cur && !cur.saved ? h('button.btn.small', { onclick: saveCurrent }, 'Save as account…') : null);
    clear(body, store.accounts.length ? store.accounts.map(a => {
      const u = (store.usage || {})[a.id];
      const five = live(u && u.fiveHour);
      const week = live(u && u.weekly);
      return h(`div.account${a.inUse ? '.active' : ''}`, { dataset: { id: a.id } },
        h('div.account-main',
          h('div.account-name', a.name, a.inUse ? h('span.account-tag', 'in use') : null),
          h('div.account-who', whoText(a) || 'Saved login'),
          h('div.account-usage', meter('5h', five), five ? h('span.muted', ` ${resetText(five.resetsAt)}`) : null),
          h('div.account-usage', meter('wk', week), week ? h('span.muted', ` ${resetText(week.resetsAt)}`) : null),
          u ? h('div.account-updated', `Updated ${timeText(u.at)}`) : null),
        h('div.account-actions',
          a.inUse ? null : h('button.btn.small', { onclick: () => use(a) }, 'Use'),
          h('button.icon-btn.account-refresh', { title: 'Refresh usage', disabled: loading.has(a.id), onclick: () => refresh(a) }, icon('refresh')),
          h('button.icon-btn', { title: 'Rename', onclick: () => rename(a) }, icon('edit')),
          h('button.icon-btn', { title: 'Forget this saved login', onclick: () => remove(a) }, icon('trash'))));
    }) : h('div.muted.accounts-empty', 'No saved logins yet. Add one to switch between logins and orgs.'));
  };
  render();

  async function use(a) {
    const v = await confirmDialog({
      title: `Switch every Claude session to “${a.name}”?`,
      detail: 'Running sessions use it from their next request; new sessions start with it.',
      buttons: [{ label: 'Switch', value: 'yes', primary: true }],
    });
    if (v !== 'yes') return;
    try {
      await call('accounts.use', { id: a.id });
      toast(`Claude sessions now use “${a.name}”.`, { icon: 'claude', timeout: 4000 });
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  }
  async function refresh(a) {
    loading.add(a.id);
    render();
    try {
      await call('accounts.refreshUsage', { id: a.id });
    } catch (e) {
      toast(e.message, { kind: 'error' });
    } finally {
      loading.delete(a.id);
      render();
    }
  }
  async function saveCurrent() {
    const cur = store.currentLogin || {};
    const name = await promptDialog({ title: 'Save this login as an account', value: cur.org || cur.email || '', okLabel: 'Save' });
    if (!name) return;
    try {
      await call('accounts.saveCurrent', { name });
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  }
  async function rename(a) {
    const name = await promptDialog({ title: 'Rename account', value: a.name, okLabel: 'Rename' });
    if (!name) return;
    await call('accounts.rename', { id: a.id, name });
    a.name = name;
    render();
  }
  async function remove(a) {
    const v = await confirmDialog({ title: 'Forget this saved login?', detail: 'You stay signed in to the login in use now.', buttons: [{ label: 'Forget', value: 'yes', danger: true }] });
    if (v !== 'yes') return;
    try {
      await call('accounts.remove', { id: a.id });
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  }
  async function addAccount() {
    if (!store.active) return toast('Open a worktree first — the sign-in runs in a tab there.', { kind: 'warn' });
    const name = await promptDialog({ title: 'Add a Claude account', placeholder: 'Work, Client X, Personal…', okLabel: 'Sign in', detail: 'A tab runs claude auth login in a private folder. The login in use now doesn’t change until you pick the new account.' });
    if (!name) return;
    try {
      const s = await call('accounts.add', { name, worktreePath: store.active });
      m.close();
      const ws = window.skiffcode.workspaces.get(store.active);
      for (let i = 0; i < 40 && !store.sessions.some(x => x.id === s.id); i++) await new Promise(r => setTimeout(r, 50));
      if (ws) ws.openSession(s.id);
      toast(`Finish signing in in the “${s.name}” tab. SkiffCode saves the login when it’s done.`, { icon: 'link', timeout: 15000 });
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  }
  const offState = on('state', () => setTimeout(render, 0));
  const offUsage = on('usage', () => setTimeout(render, 0));
  const obs = new MutationObserver(() => { if (!m.box.isConnected) { offState(); offUsage(); obs.disconnect(); } });
  obs.observe(document.getElementById('overlay'), { childList: true });
}
