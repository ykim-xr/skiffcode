// Left sidebar: groups → repos → worktrees → sessions, Orca style.
import { h, icon, clear } from './util.js';
import { store, subscribe, sessionsIn, needsYou } from './store.js';
import { call } from './rpc.js';
import { contextMenu } from './dialogs.js';
import { keyHint, withKey } from './keybindings.js';
import { customizeDialog, entryIcon } from './customize-dialog.js';

/**
 * The icon for a session, everywhere (sidebar, Active panel, tabs, jump list).
 * Claude: waiting for you (? / shield) › working (orange, spinning) › a command it started
 * is still running (zigzag) › otherwise a plain grey Claude mark.
 * Shell: zigzag while a command runs, else a terminal.
 */
export function sessionIcon(s, extra = '') {
  const cls = c => `${c} ${extra}`.trim();
  if (!s) return icon('terminal', cls(''));
  const ended = s.state === 'ended';
  if (s.kind === 'shell') return ended ? icon('terminal', cls('st-ended')) : s.command ? icon('zigzag', cls('st-command')) : icon('terminal', cls('st-running'));
  if (s.state === 'question') return icon('question', cls('st-question'));
  if (s.state === 'permission') return icon('shield', cls('st-permission'));
  if (s.state === 'working' || s.state === 'starting') return icon('claude', cls('st-claude spin'));
  if (s.command && !ended) return icon('zigzag', cls('st-command'));
  return icon('claude', cls(ended ? 'st-ended' : 'st-claude-idle'));
}
const isClaude = s => s.kind === 'claude';

export const STATE_LABEL = { running: 'running', starting: 'starting', working: 'working', question: 'asking you', permission: 'needs permission', idle: 'ready', ended: 'stopped' };
export const stateLabel = s => (s.command && s.state !== 'ended' && !needsYou(s.state) && s.state !== 'working' ? 'running a command' : s.state === 'idle' && s.prompted ? 'done' : STATE_LABEL[s.state] || s.state);

let A; // actions from app.js
let root;
let drag = null;

export function initSidebar(el, actions) {
  A = actions;
  root = el;
  subscribe(render);
  render();
  setInterval(render, 30_000); // keeps times like "5m" current
}

const collapsed = key => !!(store.prefs.collapsed || {})[key];
function toggle(key) {
  const now = !collapsed(key);
  store.prefs.collapsed = { ...(store.prefs.collapsed || {}), [key]: now || undefined };
  render();
  call('prefs.collapse', { key, collapsed: now });
}

function render() {
  const list = h('div.tree', {
    ondragover: e => { if (drag) { e.preventDefault(); markDrop(null); } },
    ondrop: e => { if (drag && e.target === list) { e.preventDefault(); drop(null); } },
  });
  // Each group / repo / folder is one block, so a hairline can separate them.
  for (const g of store.groups) list.append(groupRow(g));
  for (const r of store.repos.filter(r => !r.group || !store.groups.some(g => g.id === r.group))) list.append(h('div.tree-item', ...repoRows(r, 0)));
  if (!store.repos.length) {
    list.append(h('div.sidebar-empty',
      h('p', 'Add a git repository or any folder to get started.'),
      h('button.btn.primary', { onclick: () => A.addRepo() }, icon('plus'), 'Add repository'),
      h('p.muted', 'Or from WSL: ', h('code', 'skiffcode ~/code/my-repo'))));
  }
  // The tree is rebuilt on every change: keep where you'd scrolled to.
  const oldTree = root.querySelector('.tree');
  const oldPanel = root.querySelector('.active-panel .panel-body');
  const treeTop = oldTree ? oldTree.scrollTop : 0;
  const panelTop = oldPanel ? oldPanel.scrollTop : 0;
  clear(root,
    h('div.sidebar-header',
      h('span.sidebar-title', 'SkiffCode'),
      h('div.sidebar-actions',
        h('button.icon-btn', { title: 'Add repository or folder', onclick: () => A.addRepo() }, icon('plus')),
        h('button.icon-btn', { title: 'New group', onclick: () => A.newGroup() }, icon('group')),
        h('button.icon-btn', { title: withKey('Jump to…', 'jump'), onclick: () => A.jump() }, icon('search')))),
    activePanel(),
    list);
  list.scrollTop = treeTop;
  const panel = root.querySelector('.active-panel .panel-body');
  if (panel) panel.scrollTop = panelTop;
}

// ---- "Active" panel: sessions that need you, then the ones working, grouped by repo.

/** Subagents still running; one disappears as soon as it finishes or is stopped. */
export function visibleAgents(s) {
  return (s.agents || []).filter(a => a.state === 'running');
}
const runningAgents = s => visibleAgents(s).length;

function activePanel() {
  const active = store.sessions.filter(s => isClaude(s) && (needsYou(s.state) || s.state === 'working' || s.state === 'starting' || runningAgents(s) || (s.command && s.state !== 'ended')));
  const need = active.filter(s => needsYou(s.state)).length;
  const key = 'panel:active';
  const head = h('div.panel-head', { onclick: () => toggle(key), title: 'Claude sessions that need you or are working' },
    icon(collapsed(key) ? 'chevronRight' : 'chevronDown', 'twisty'),
    h('span.panel-title', 'Active'),
    need ? h('span.badge.need', { title: `${need} waiting for you` }, need) : null,
    h('span.panel-count', active.length ? `${active.length - need ? `${active.length - need} working` : ''}` : ''));
  const panel = h(`div.active-panel${need ? '.attention' : ''}`, head);
  if (collapsed(key)) return panel;
  const body = h('div.panel-body');
  if (!active.length) body.append(h('div.panel-empty', 'Nothing running. Claude sessions that are working or waiting for you show up here.'));
  const rank = s => (needsYou(s.state) ? 0 : 1);
  for (const s of [...active].sort((x, y) => rank(x) - rank(y) || (y.changedAt || 0) - (x.changedAt || 0))) {
    const r = store.repos.find(x => x.path === s.repoPath);
    const wt = ((store.worktrees.get(s.repoPath) || {}).list || []).find(w => w.path === s.worktreePath);
    const agents = runningAgents(s);
    body.append(h(`div.row.active-row${needsYou(s.state) ? '.need' : ''}${A.isSessionFocused(s.id) ? '.focused' : ''}`, {
      title: `${s.name} — ${stateLabel(s)}\n${s.worktreePath}${agents ? `\n${agents} subagent${agents > 1 ? 's' : ''} running` : ''}\nClick to open`,
      onclick: () => A.focusSession(s.id),
    },
    sessionIcon(s, 'row-icon'),
    h('span.row-label', s.name),
    h('span.row-desc', [r ? r.name : '', wt && wt.branch && !wt.isMain ? wt.branch : ''].filter(Boolean).join(' · '))));
  }
  panel.append(body);
  return panel;
}

function badgeCount(sessions, hidden = true) {
  if (!hidden) return [];
  const need = sessions.filter(s => needsYou(s.state)).length;
  const unread = sessions.filter(s => s.unread && !needsYou(s.state)).length;
  return [need ? h('span.badge.need', { title: `${need} waiting for you` }, need) : null, unread ? h('span.badge.unread', { title: `${unread} unread` }, unread) : null];
}

function groupRow(g) {
  const repos = store.repos.filter(r => r.group === g.id);
  const sess = store.sessions.filter(s => isClaude(s) && repos.some(r => r.path === s.repoPath));
  const key = `g:${g.id}`;
  const row = h('div.row.group-row', {
    draggable: 'true',
    onclick: () => toggle(key),
    oncontextmenu: e => contextMenu(e, [
      { label: 'Rename group…', icon: 'edit', action: () => A.renameGroup(g) },
      { label: 'Customize…', icon: 'palette', action: () => customizeDialog('group', g) },
      { label: 'Delete group', icon: 'trash', danger: true, action: () => A.deleteGroup(g) },
    ]),
    ondragstart: e => startDrag(e, { kind: 'group', id: g.id }),
    ondragover: e => overRow(e, row, { kind: 'group', id: g.id }),
    ondrop: e => { e.preventDefault(); e.stopPropagation(); drop({ kind: 'group', id: g.id, after: row.dataset.drop === 'after' }); },
  },
  icon(collapsed(key) ? 'chevronRight' : 'chevronDown', 'twisty'),
  entryIcon(g, null),
  h('span.row-label', { style: g.color ? { color: g.color } : {} }, g.name),
  ...badgeCount(sess, collapsed(key)));
  const wrap = h('div.group.tree-item', row);
  if (!collapsed(key)) for (const r of repos) wrap.append(h('div.tree-item.in-group', ...repoRows(r, 1)));
  return wrap;
}

/** A plain folder (not a git repo): one row that opens it, its Claude sessions below. */
function folderRows(r, depth) {
  const key = `r:${r.path}`;
  const sess = sessionsIn(r.path).filter(isClaude);
  const active = store.active === r.path;
  const row = h(`div.row.repo-row.folder-row${active ? '.active' : ''}`, {
    style: { paddingLeft: `${6 + depth * 12}px` },
    draggable: 'true',
    title: `${r.path}\nFolder (not a git repository)`,
    onclick: () => A.openWorktree(r.path),
    oncontextmenu: e => contextMenu(e, [
      { label: 'New Claude session', icon: 'claude', hint: keyHint('newClaude'), action: () => A.newSession(r.path, 'claude') },
      { label: 'New shell', icon: 'terminal', hint: keyHint('newShell'), action: () => A.newSession(r.path, 'shell') },
      { label: 'Resume Claude conversation…', icon: 'play', action: () => A.resumeConversation(r.path) },
      { separator: true },
      { label: 'Initialize git here', icon: 'git', action: () => A.gitInit(r.path) },
      { label: 'Customize…', icon: 'palette', action: () => customizeDialog('repo', r) },
      { separator: true },
      { label: 'Move up', icon: 'up', action: () => call('repos.nudge', { path: r.path, dir: -1 }) },
      { label: 'Move down', icon: 'down', action: () => call('repos.nudge', { path: r.path, dir: 1 }) },
      { label: 'Move to group…', icon: 'group', action: () => A.moveToGroup(r) },
      { separator: true },
      { label: 'Copy path', icon: 'link', action: () => navigator.clipboard.writeText(r.path) },
      { label: 'Remove from SkiffCode (keep folder)', icon: 'close', action: () => A.removeRepo(r) },
      { label: 'Delete folder from disk…', icon: 'trash', danger: true, action: () => A.deleteRepo(r) },
    ]),
    ondragstart: e => startDrag(e, { kind: 'repo', path: r.path }),
    ondragover: e => overRow(e, row, { kind: 'repo', path: r.path }),
    ondrop: e => { e.preventDefault(); e.stopPropagation(); drop({ kind: 'repo', path: r.path, after: row.dataset.drop === 'after' }); },
  },
  sess.length ? h('span.twisty-hit', { onclick: e => { e.stopPropagation(); toggle(key); } }, icon(collapsed(key) ? 'chevronRight' : 'chevronDown', 'twisty')) : h('span.twisty-space'),
  entryIcon(r, 'folder'),
  h('span.row-label', { style: r.color ? { color: r.color } : {} }, r.name),
  ...badgeCount(sess, collapsed(key)),
  h('span.row-actions',
    h('button.icon-btn', { title: 'New Claude session', onclick: e => { e.stopPropagation(); A.newSession(r.path, 'claude'); } }, icon('claude')),
    h('button.icon-btn', { title: 'New shell', onclick: e => { e.stopPropagation(); A.newSession(r.path, 'shell'); } }, icon('terminal'))));
  const out = [row];
  if (!collapsed(key)) for (const s of sess) out.push(...sessionRows(s, depth + 1));
  return out;
}

function repoRows(r, depth) {
  if (r.kind === 'folder') return folderRows(r, depth);
  const key = `r:${r.path}`;
  const wts = store.worktrees.get(r.path);
  const sess = store.sessions.filter(s => isClaude(s) && s.repoPath === r.path);
  const activeHere = store.active && (store.active === r.path || (wts && wts.list.some(w => w.path === store.active)));
  const row = h(`div.row.repo-row${activeHere ? '.has-active' : ''}`, {
    style: { paddingLeft: `${6 + depth * 12}px` },
    draggable: 'true',
    title: r.path,
    onclick: () => toggle(key),
    oncontextmenu: e => contextMenu(e, [
      { label: 'New worktree…', icon: 'branch', action: () => A.newWorktree(r) },
      { label: 'Refresh', icon: 'refresh', action: () => A.refreshRepo(r) },
      { label: 'Customize…', icon: 'palette', action: () => customizeDialog('repo', r) },
      { separator: true },
      { label: 'Move up', icon: 'up', action: () => call('repos.nudge', { path: r.path, dir: -1 }) },
      { label: 'Move down', icon: 'down', action: () => call('repos.nudge', { path: r.path, dir: 1 }) },
      { label: 'Move to group…', icon: 'group', action: () => A.moveToGroup(r) },
      { separator: true },
      { label: 'Copy path', icon: 'link', action: () => navigator.clipboard.writeText(r.path) },
      { label: 'Remove from SkiffCode (keep folder)', icon: 'close', action: () => A.removeRepo(r) },
      { label: 'Delete repository from disk…', icon: 'trash', danger: true, action: () => A.deleteRepo(r) },
    ]),
    ondragstart: e => startDrag(e, { kind: 'repo', path: r.path }),
    ondragover: e => overRow(e, row, { kind: 'repo', path: r.path }),
    ondrop: e => { e.preventDefault(); e.stopPropagation(); drop({ kind: 'repo', path: r.path, after: row.dataset.drop === 'after' }); },
  },
  icon(collapsed(key) ? 'chevronRight' : 'chevronDown', 'twisty'),
  entryIcon(r, 'repo'),
  h('span.row-label', { style: r.color ? { color: r.color } : {} }, r.name),
  ...badgeCount(sess, collapsed(key)),
  h('span.row-actions', h('button.icon-btn', { title: 'New worktree', onclick: e => { e.stopPropagation(); A.newWorktree(r); } }, icon('plus'))));
  const out = [row];
  if (collapsed(key)) return out;
  if (!wts) out.push(h('div.row.muted', { style: { paddingLeft: `${30 + depth * 12}px` } }, 'Loading…'));
  else if (wts.missing) out.push(h('div.row.error', { style: { paddingLeft: `${30 + depth * 12}px` } }, 'Folder not found'));
  else if (wts.error) out.push(h('div.row.error', { style: { paddingLeft: `${30 + depth * 12}px` }, title: wts.error }, 'git error'));
  else for (const w of wts.list) out.push(...worktreeRows(r, w, depth + 1));
  return out;
}

function worktreeRows(r, w, depth) {
  const key = `w:${w.path}`;
  const sess = sessionsIn(w.path).filter(isClaude); // shells live in the tabs only
  const st = store.status.get(w.path);
  const active = store.active === w.path;
  const row = h(`div.row.wt-row${active ? '.active' : ''}${w.prunable ? '.missing' : ''}`, {
    style: { paddingLeft: `${6 + depth * 12}px` },
    title: `${w.path}${st && st.base ? `\nCompared with ${st.base}` : ''}`,
    onclick: () => A.openWorktree(w.path),
    oncontextmenu: e => contextMenu(e, [
      { label: 'New Claude session', icon: 'claude', hint: keyHint('newClaude'), action: () => A.newSession(w.path, 'claude') },
      { label: 'New shell', icon: 'terminal', hint: keyHint('newShell'), action: () => A.newSession(w.path, 'shell') },
      { label: 'Resume Claude conversation…', icon: 'play', action: () => A.resumeConversation(w.path) },
      { label: 'Review changes vs base', icon: 'diff', action: () => A.reviewChanges(w.path) },
      { separator: true },
      { label: 'New worktree…', icon: 'branch', action: () => A.newWorktree(r) },
      { label: 'Copy path', icon: 'link', action: () => navigator.clipboard.writeText(w.path) },
      w.isMain ? null : { separator: true },
      w.isMain ? null : { label: 'Remove worktree…', icon: 'trash', danger: true, action: () => A.removeWorktree(r, w) },
    ]),
  },
  sess.length ? icon(collapsed(key) ? 'chevronRight' : 'chevronDown', 'twisty', ) : h('span.twisty-space'),
  icon(w.isMain ? 'home' : 'branch', 'row-icon'),
  h('span.row-label', w.branch || (w.detached ? `detached ${w.head.slice(0, 7)}` : w.path.split('/').pop())),
  ...badgeCount(sess, collapsed(key)),
  h('span.row-actions',
    h('button.icon-btn', { title: 'New Claude session', onclick: e => { e.stopPropagation(); A.newSession(w.path, 'claude'); } }, icon('claude')),
    h('button.icon-btn', { title: 'New shell', onclick: e => { e.stopPropagation(); A.newSession(w.path, 'shell'); } }, icon('terminal'))));
  const tw = row.querySelector('.twisty');
  if (tw) tw.addEventListener('click', e => { e.stopPropagation(); toggle(key); });
  const out = [row];
  if (!collapsed(key)) for (const s of sess) out.push(...sessionRows(s, depth + 1));
  return out;
}

function sessionRows(s, depth) {
  const agents = visibleAgents(s);
  const key = `agentsopen:${s.id}`; // subagents start folded into the count on the session row
  const row = sessionRow(s, depth, agents.length ? key : null);
  if (!agents.length || !collapsed(key)) return [row];
  return [row, ...agents.map(a => agentRow(s, a, depth + 1))];
}

function agentRow(s, a, depth) {
  const running = a.state === 'running';
  const took = Math.max(1, Math.round(((a.endedAt || Date.now()) - a.startedAt) / 1000));
  return h(`div.row.agent-row${running ? '' : '.finished'}`, {
    style: { paddingLeft: `${6 + depth * 12}px` },
    title: `${a.type} subagent${a.background ? ' (background)' : ''}${a.description ? `\n${a.description}` : ''}\n${running ? `running for ${took}s` : `${a.state === 'stopped' ? 'stopped' : 'finished'} after ${took}s`}`,
    onclick: () => A.focusSession(s.id),
  },
  h('span.twisty-space'),
  icon('claude', running ? 'row-icon st-claude spin' : 'row-icon st-claude-idle'),
  h('span.row-label', a.description || a.type),
  h('span.row-desc', a.description ? a.type : ''));
}

function sessionRow(s, depth, agentsKey) {
  const ended = s.state === 'ended';
  return h(`div.row.session-row${s.unread ? '.unread' : ''}${A.isSessionFocused(s.id) ? '.focused' : ''}`, {
    style: { paddingLeft: `${6 + depth * 12}px` },
    title: [`${s.name} — ${stateLabel(s)}`, s.model ? `${s.model}${s.contextPct !== undefined ? ` · context ${s.contextPct}%` : ''}` : '', (store.accounts || []).length > 1 ? `Account: ${((store.accounts || []).find(a => a.id === (s.account || 'default')) || {}).name || 'Default'}` : '', 'Double-click to rename'].filter(Boolean).join('\n'),
    onclick: () => A.focusSession(s.id),
    ondblclick: e => { e.preventDefault(); A.renameSession(s); },
    oncontextmenu: e => contextMenu(e, [
      ended ? { label: 'Resume', icon: 'play', action: () => A.resumeSession(s.id) } : null,
      !ended ? { label: 'Stop', icon: 'stop', action: () => A.stopSession(s.id) } : null,
      { label: 'Rename…', icon: 'edit', action: () => A.renameSession(s) },
      s.kind === 'claude' && s.claudeId && s.prompted ? { label: 'Copy conversation ID', icon: 'link', action: () => navigator.clipboard.writeText(s.claudeId) } : null,
      s.unread ? { label: 'Mark as read', icon: 'circle', action: () => call('sessions.setUnread', { id: s.id, unread: false }) } : { label: 'Mark as unread', icon: 'dot', action: () => call('sessions.setUnread', { id: s.id, unread: true }) },
      { separator: true },
      { label: 'Close session', icon: 'close', action: () => A.closeSession(s) },
      { label: 'Delete session and conversation…', icon: 'trash', danger: true, action: () => A.purgeSession(s) },
    ]),
  },
  agentsKey ? h('span.twisty-hit', { title: 'Show/hide subagents', onclick: e => { e.stopPropagation(); toggle(agentsKey); } }, icon(collapsed(agentsKey) ? 'chevronDown' : 'chevronRight', 'twisty')) : h('span.twisty-space'),
  sessionIcon(s, 'row-icon'),
  h('span.row-label', s.name),
  runningAgents(s) ? h('span.agent-count', { title: `${runningAgents(s)} subagent(s) running — click to list them`, onclick: e => { e.stopPropagation(); if (agentsKey) toggle(agentsKey); } }, `${runningAgents(s)} agent${runningAgents(s) > 1 ? 's' : ''}`) : null,
  s.unread ? h('span.unread-dot', { title: 'Unread' }) : null,
  needsYou(s.state) ? h(`span.need-pill.st-${s.state}`, s.state === 'question' ? 'asking' : 'permission') : null,
  h('span.row-actions',
    ended
      ? h('button.icon-btn', { title: 'Resume', onclick: e => { e.stopPropagation(); A.resumeSession(s.id); } }, icon('play'))
      : h('button.icon-btn', { title: 'Stop', onclick: e => { e.stopPropagation(); A.stopSession(s.id); } }, icon('stop')),
    h('button.icon-btn', { title: 'Close session', onclick: e => { e.stopPropagation(); A.closeSession(s); } }, icon('close'))));
}

// ---- drag and drop (repos and groups)

function startDrag(e, item) {
  drag = item;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('application/x-skiffcode-sidebar', JSON.stringify(item)); // not text/plain: a terminal would paste it
  e.stopPropagation();
}

function overRow(e, row, target) {
  if (!drag) return;
  e.stopPropagation();
  if (drag.kind === 'group' && target.kind !== 'group') return; // no drop here
  e.preventDefault();
  const r = row.getBoundingClientRect();
  const y = e.clientY - r.top;
  const mode = target.kind === 'group' && drag.kind === 'repo' ? 'into' : y > r.height / 2 ? 'after' : 'before';
  markDrop(row, mode);
}

function markDrop(row, mode) {
  for (const el of root.querySelectorAll('[data-drop]')) delete el.dataset.drop;
  if (row) row.dataset.drop = mode;
}

function drop(target) {
  const item = drag;
  drag = null;
  markDrop(null);
  if (!item) return;
  if (target && item.kind === target.kind && (item.path || item.id) === (target.path || target.id)) return;
  call('repos.move', { items: [item], target: target && { ...target } });
}

document.addEventListener('dragend', () => {
  drag = null;
  if (root) markDrop(null);
});
