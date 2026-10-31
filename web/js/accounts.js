// Claude usage in the status bar (5-hour / weekly, time to reset) and the
// account panel: switch login/org, sign in or out, add accounts.
import { h, icon, clear } from './util.js';
import { call, on } from './rpc.js';
import { store, notify } from './store.js';
import { toast, promptDialog, confirmDialog, modal } from './dialogs.js';

on('usage', u => {
  store.usage = u;
  notify();
});

export function activeAccount() {
  return store.accounts.find(a => a.id === store.activeAccount) || store.accounts[0];
}

export function accountName(id) {
  const a = store.accounts.find(x => x.id === (id || 'default'));
  return a ? a.name : 'Default';
}

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
  const a = activeAccount();
  const u = (store.usage || {})[a ? a.id : 'default'];
  const five = live(u && u.fiveHour);
  const week = live(u && u.weekly);
  const multi = store.accounts.length > 1;
  const tip = [
    `Claude account: ${a ? a.name : 'Default'}`,
    five ? `5-hour: ${Math.round(five.used)}% used, ${resetText(five.resetsAt)}` : '5-hour: not reported yet',
    week ? `Weekly: ${Math.round(week.used)}% used, ${resetText(week.resetsAt)}` : 'Weekly: not reported yet',
    u ? `Updated ${new Date(u.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} (Claude reports usage while a session is working)` : 'Usage appears once a Claude session talks to Claude (Pro/Max logins).',
    'Click to switch account or sign in',
  ].join('\n');
  return h('span.sb-item.click.usage', { title: tip, onclick: () => accountsDialog() },
    icon('claude', 'st-claude'),
    multi ? h('span.usage-acct', a ? a.name : 'Default') : null,
    meter('5h', five),
    five && five.resetsAt ? h('span.usage-reset', `↻ ${untilText(five.resetsAt)}`) : null,
    meter('wk', week),
    week && week.resetsAt ? h('span.usage-reset', `↻ ${untilText(week.resetsAt)}`) : null);
}

/** The account panel. */
export async function accountsDialog() {
  const body = h('div.accounts-list');
  const m = modal([
    h('div.modal-title', 'Claude accounts'),
    h('div.modal-detail.muted', 'New sessions use the selected account. Running sessions keep the account they started with. Each account is its own Claude login (CLAUDE_CONFIG_DIR).'),
    body,
    h('div.modal-buttons',
      h('button.btn', { onclick: addAccount }, icon('plus'), 'Add account…'),
      h('button.btn.primary', { onclick: () => m.close() }, 'Done')),
  ]);
  m.box.classList.add('accounts-modal');

  let status = {};
  const render = () => {
    clear(body, store.accounts.map(a => {
      const st = status[a.id];
      const u = (store.usage || {})[a.id];
      const five = live(u && u.fiveHour);
      const week = live(u && u.weekly);
      const active = a.id === store.activeAccount;
      const who = !st ? 'Checking…' : st.unknown ? 'Couldn’t check sign-in' : st.loggedIn ? [st.email, st.org, st.plan].filter(Boolean).join(' · ') || `Signed in (${st.method})` : 'Not signed in';
      return h(`div.account${active ? '.active' : ''}`, { onclick: e => { if (!e.target.closest('button')) setActive(a); } },
        h('span.account-radio', active ? icon('check') : null),
        h('div.account-main',
          h('div.account-name', a.name, active ? h('span.account-tag', 'active') : null),
          h(`div.account-who${st && st.loggedIn === false && !st.unknown ? '.warn' : ''}`, who),
          h('div.account-usage', meter('5h', five), five ? h('span.muted', ` ${resetText(five.resetsAt)}`) : null),
          h('div.account-usage', meter('wk', week), week ? h('span.muted', ` ${resetText(week.resetsAt)}`) : null),
          h('div.account-dir', a.dir)),
        h('div.account-actions',
          h('button.btn.small', { onclick: () => login(a), title: 'Opens a sign-in tab for this account (also how you switch org)' }, st && st.loggedIn ? 'Switch login…' : 'Sign in…'),
          st && st.loggedIn ? h('button.btn.small', { onclick: () => logout(a) }, 'Sign out') : null,
          h('button.icon-btn', { title: 'Rename', onclick: () => rename(a) }, icon('edit')),
          a.id !== 'default' ? h('button.icon-btn', { title: 'Remove from SkiffCode', onclick: () => remove(a) }, icon('trash')) : null));
    }));
  };
  render();
  const refreshStatus = async fresh => {
    try {
      for (const s of await call('accounts.status', { fresh })) status[s.id] = s;
    } catch { /* keep */ }
    render();
  };
  void refreshStatus(true);

  async function setActive(a) {
    if (a.id === store.activeAccount) return;
    store.activeAccount = a.id;
    render();
    notify();
    await call('accounts.setActive', { id: a.id });
    toast(`New Claude sessions will use “${a.name}”.`, { icon: 'claude', timeout: 3000 });
  }
  async function login(a) {
    if (!store.active) return toast('Open a worktree first — the sign-in runs in a tab there.', { kind: 'warn' });
    const s = await call('accounts.login', { id: a.id, worktreePath: store.active });
    m.close();
    const ws = window.skiffcode.workspaces.get(store.active);
    for (let i = 0; i < 40 && !store.sessions.some(x => x.id === s.id); i++) await new Promise(r => setTimeout(r, 50));
    if (ws) ws.openSession(s.id);
    toast(`Finish signing in to “${a.name}” in the “${s.name}” tab. If the browser shows a code, paste it there.`, { icon: 'link', timeout: 15000 });
  }
  async function logout(a) {
    const v = await confirmDialog({ title: `Sign out of “${a.name}”?`, detail: 'Claude sessions using this account will need to sign in again.', buttons: [{ label: 'Sign out', value: 'yes', danger: true }] });
    if (v !== 'yes') return;
    await call('accounts.logout', { id: a.id });
    await refreshStatus(true);
  }
  async function rename(a) {
    const name = await promptDialog({ title: 'Rename account', value: a.name, okLabel: 'Rename' });
    if (!name) return;
    await call('accounts.rename', { id: a.id, name });
    a.name = name;
    render();
  }
  async function remove(a) {
    const v = await confirmDialog({ title: `Remove “${a.name}” from SkiffCode?`, detail: 'It is signed out on this machine. Its conversations and settings are kept.', buttons: [{ label: 'Remove', value: 'yes', danger: true }] });
    if (v !== 'yes') return;
    try {
      await call('accounts.remove', { id: a.id });
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  }
  async function addAccount() {
    const name = await promptDialog({ title: 'Add a Claude account', placeholder: 'Work, Client X, Personal…', okLabel: 'Add', detail: 'Your settings, CLAUDE.md, agents, commands and skills are shared from your main ~/.claude. Then sign in to it.' });
    if (!name) return;
    try {
      const a = await call('accounts.add', { name, share: true });
      for (let i = 0; i < 20 && !store.accounts.some(x => x.id === a.id); i++) await new Promise(r => setTimeout(r, 50));
      status[a.id] = { loggedIn: false };
      render();
      await login(a);
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  }
  const off = on('state', () => setTimeout(render, 0));
  const obs = new MutationObserver(() => { if (!m.box.isConnected) { off(); obs.disconnect(); } });
  obs.observe(document.getElementById('overlay'), { childList: true });
}
