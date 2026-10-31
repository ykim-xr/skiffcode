// Modals, quick picks, context menus and toasts.
import { h, icon, fuzzy, highlight } from './util.js';

const layer = () => document.getElementById('overlay');

/** Dialogs stack (Settings → Sounds): only the top one reacts to Escape. */
function isTopModal(back) {
  const open = layer().querySelectorAll('.modal-back');
  return open[open.length - 1] === back;
}

export function modal(content, { onClose, wide } = {}) {
  const back = h('div.modal-back');
  const box = h(`div.modal${wide ? '.wide' : ''}`, content);
  back.append(box);
  const before = document.activeElement;
  const close = v => {
    back.remove();
    document.removeEventListener('keydown', key, true);
    // Back to where focus was, unless onClose moved it. Later than this key press: Enter would click a button focused now.
    setTimeout(() => {
      if (before && before.isConnected && document.activeElement === document.body) before.focus({ preventScroll: true });
    }, 0);
    onClose && onClose(v);
  };
  const key = e => {
    if (e.key === 'Escape' && isTopModal(back)) {
      e.stopPropagation();
      e.preventDefault();
      close(undefined);
    }
  };
  document.addEventListener('keydown', key, true);
  back.addEventListener('mousedown', e => e.target === back && close(undefined));
  layer().append(back);
  return { box, close };
}

/** confirm({title, detail, buttons:[{label, value, danger, primary}], typed}) → value | undefined */
export function confirmDialog({ title, detail, buttons, typed }) {
  return new Promise(resolve => {
    let input;
    const cancel = h('button.btn', { onclick: () => m.close(undefined) }, 'Cancel');
    const btns = buttons.map(b =>
      h(`button.btn${b.danger ? '.danger' : b.primary ? '.primary' : ''}`, {
        onclick: () => {
          if (typed && b.value && input.value !== typed) {
            input.classList.add('invalid');
            input.focus();
            return;
          }
          m.close(b.value);
        },
      }, b.label),
    );
    const content = [
      h('div.modal-title', title),
      detail ? h('div.modal-detail', detail) : null,
      typed ? h('div.modal-typed', h('label', `Type `, h('b', typed), ' to confirm'), (input = h('input.input', { placeholder: typed, spellcheck: 'false' }))) : null,
      h('div.modal-buttons', cancel, ...btns),
    ];
    const m = modal(content, { onClose: resolve });
    // Enter takes the last button, so a destructive one is not the one to focus
    const focus = input || (buttons[buttons.length - 1].danger ? cancel : btns[btns.length - 1]);
    setTimeout(() => focus.focus({ preventScroll: true }), 0); // a long dialog stays at its top
    if (input) input.addEventListener('keydown', e => e.key === 'Enter' && btns[btns.length - 1].click());
  });
}

/** prompt({title, value, placeholder, validate(v)→error|undefined (may be async)}) → string | undefined */
export function promptDialog({ title, value = '', placeholder = '', validate, okLabel = 'OK', detail }) {
  return new Promise(resolve => {
    const input = h('input.input', { value, placeholder, spellcheck: 'false' });
    const err = h('div.modal-error');
    const ok = h('button.btn.primary', { onclick: submit }, okLabel);
    async function submit() {
      const v = input.value.trim();
      const e = validate ? await validate(v) : !v ? 'Required' : undefined;
      if (e) {
        err.textContent = e;
        input.classList.add('invalid');
        return;
      }
      m.close(v);
    }
    input.addEventListener('keydown', e => e.key === 'Enter' && submit());
    input.addEventListener('input', () => { err.textContent = ''; input.classList.remove('invalid'); });
    const m = modal([h('div.modal-title', title), detail ? h('div.modal-detail', detail) : null, input, err, h('div.modal-buttons', h('button.btn', { onclick: () => m.close(undefined) }, 'Cancel'), ok)], { onClose: resolve });
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

/**
 * quickPick(items | async (query) => items, {placeholder, title})
 * item: {label, description, detail, icon, value, separator, alwaysShow}
 */
export function quickPick(source, { placeholder = '', title, matchDescription = true, value = '' } = {}) {
  return new Promise(resolve => {
    const input = h('input.input.qp-input', { placeholder, spellcheck: 'false', value });
    const list = h('div.qp-list');
    let items = [];
    let shown = [];
    let sel = 0;
    let token = 0;
    const render = () => {
      list.replaceChildren();
      shown.forEach((it, i) => {
        if (it.separator) return list.append(h('div.qp-sep', it.label));
        const row = h(`div.qp-item${i === sel ? '.selected' : ''}`, {
          onmousedown: e => { e.preventDefault(); m.close(it.value); },
          onmousemove: () => { if (sel !== i) { sel = i; render(); } },
        },
        it.icon ? (typeof it.icon === 'string' ? icon(it.icon, it.iconClass || '') : it.icon) : null,
        h('span.qp-label', highlight(it.label, it._hits)),
        it.description ? h('span.qp-desc', highlight(it.description, it._dhits)) : null,
        it.detail ? h('span.qp-detail', it.detail) : null);
        list.append(row);
      });
      const el = list.querySelector('.selected');
      if (el) el.scrollIntoView({ block: 'nearest' });
    };
    const filter = async () => {
      const q = input.value;
      const my = ++token;
      if (typeof source === 'function') {
        const got = await source(q);
        if (my !== token) return;
        items = got;
      }
      if (!q) {
        shown = items.slice(0, 500);
      } else {
        const scored = [];
        for (const it of items) {
          if (it.separator) continue;
          const a = fuzzy(q, it.label);
          const b = matchDescription && it.description ? fuzzy(q, it.description) : null;
          if (!a && !b && !it.alwaysShow) continue;
          scored.push({ ...it, _hits: a && a.hits, _dhits: !a && b ? b.hits : undefined, _s: a ? a.score + 3 : b ? b.score : -999 });
        }
        scored.sort((x, y) => y._s - x._s);
        shown = scored.slice(0, 300);
      }
      sel = Math.max(0, shown.findIndex(i => !i.separator));
      render();
    };
    input.addEventListener('input', filter);
    input.addEventListener('keydown', e => {
      const move = d => {
        let i = sel;
        do i = (i + d + shown.length) % shown.length; while (shown[i] && shown[i].separator && i !== sel);
        sel = i;
        render();
      };
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); const it = shown[sel]; if (it && !it.separator) m.close(it.value); }
    });
    const m = modal([title ? h('div.qp-title', title) : null, input, list], { onClose: resolve, wide: true });
    m.box.classList.add('qp');
    if (Array.isArray(source)) items = source;
    filter();
    setTimeout(() => input.focus(), 0);
  });
}

let menuEl;
let menuOff;
/** Context menu at a mouse event: items {label, icon, action, danger, separator, disabled} */
export function contextMenu(e, items) {
  e.preventDefault();
  e.stopPropagation();
  closeMenu();
  menuEl = h('div.menu', items.filter(Boolean).map(it =>
    it.separator
      ? h('div.menu-sep')
      : h(`div.menu-item${it.danger ? '.danger' : ''}${it.disabled ? '.disabled' : ''}`, {
        onmousedown: ev => {
          ev.preventDefault();
          if (it.disabled) return;
          closeMenu();
          it.action();
        },
      }, it.icon ? icon(it.icon) : h('span.icon'), h('span', it.label), it.hint ? h('span.menu-hint', it.hint) : null),
  ));
  layer().append(menuEl);
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = Math.min(e.clientX, innerWidth - r.width - 4) + 'px';
  menuEl.style.top = Math.min(e.clientY, innerHeight - r.height - 4) + 'px';
  setTimeout(() => document.addEventListener('mousedown', closeMenu, { once: true }), 0);
  const onKey = ev => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeMenu(); } };
  const onScroll = ev => { if (!menuEl.contains(ev.target)) closeMenu(); };
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('blur', closeMenu);
  menuOff = () => {
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('blur', closeMenu);
  };
}
export function closeMenu() {
  if (menuEl) menuEl.remove();
  menuEl = undefined;
  if (menuOff) menuOff();
  menuOff = undefined;
}

/** toast(text, {kind:'info'|'error'|'warn', actions:[{label, action}], timeout}) */
const keyed = new Map(); // key -> toast element (one toast per key, e.g. per session)
/** Remove the toast shown under a key, if any. */
export function dismissToast(key) {
  const el = keyed.get(key);
  if (el) el.remove();
}

export function toast(text, { kind = 'info', actions = [], timeout = 6000, icon: ic, key } = {}) {
  const box = document.getElementById('toasts');
  if (key && keyed.has(key)) keyed.get(key).remove();
  const el = h(`div.toast.${kind}${timeout ? '' : '.sticky'}`,
    ic ? icon(ic) : null,
    h('div.toast-text', text),
    ...actions.map(a => h('button.btn.small', { onclick: () => { el.remove(); a.action(); } }, a.label)),
    h('button.icon-btn', { onclick: () => el.remove(), title: 'Dismiss' }, icon('close')));
  box.append(el);
  if (key) {
    keyed.set(key, el);
    const forget = () => { if (keyed.get(key) === el) keyed.delete(key); };
    new MutationObserver((_m, obs) => { if (!el.isConnected) { forget(); obs.disconnect(); } }).observe(box, { childList: true });
  }
  if (timeout) setTimeout(() => el.remove(), timeout);
  while (box.children.length > 4) {
    const old = [...box.children].find(c => c !== el && !c.classList.contains('sticky')) || box.firstChild; // a sticky one goes only when nothing else can
    old.remove();
  }
  return el;
}

/** Show the output of a command (push/pull) in a modal. */
export function outputDialog(title, text) {
  const m = modal([h('div.modal-title', title), h('pre.modal-output', text || '(no output)'), h('div.modal-buttons', h('button.btn.primary', { onclick: () => m.close() }, 'Close'))], { wide: true });
}
