// Drag and drop of files, like VS Code:
//  from the Files panel  → a folder (move), an editor pane (open), a Claude session (@path), a shell (path)
//  from Explorer/Finder  → a folder in the Files panel (copy in), a Claude session or shell (attach: saved, path typed)
import { basename, dirname } from './util.js';
import { call, sendInput } from './rpc.js';
import { confirmDialog, toast } from './dialogs.js';

export const INTERNAL = 'application/x-skiffcode-path';

export const hasType = (e, t) => !!(e.dataTransfer && [...e.dataTransfer.types].includes(t));
export const isInternal = e => hasType(e, INTERNAL);
export const isExternal = e => !isInternal(e) && hasType(e, 'Files');

/** Start dragging a file or folder out of the Files panel. */
export function startInternal(e, root, entry) {
  e.dataTransfer.effectAllowed = 'copyMove';
  e.dataTransfer.setData(INTERNAL, JSON.stringify({ root, path: entry.path, type: entry.type }));
  e.dataTransfer.setData('text/plain', `${root}/${entry.path}`);
}
export function readInternal(e) {
  try { return JSON.parse(e.dataTransfer.getData(INTERNAL)); } catch { return null; }
}

/**
 * Files (and whole folders) dropped from the OS, as [{ rel, file }].
 * The entries must be taken synchronously in the drop event, before any await.
 */
export function takeExternal(e) {
  const items = [...(e.dataTransfer.items || [])].filter(i => i.kind === 'file');
  const entries = items.map(i => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
  const plain = [...(e.dataTransfer.files || [])];
  return async () => {
    const out = [];
    if (entries.some(Boolean)) {
      const walk = async (entry, prefix) => {
        if (!entry) return;
        if (entry.isFile) {
          const file = await new Promise((res, rej) => entry.file(res, rej));
          out.push({ rel: prefix + entry.name, file });
        } else if (entry.isDirectory) {
          const reader = entry.createReader();
          for (;;) {
            const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
            if (!batch.length) break;
            for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
          }
        }
      };
      for (const en of entries) await walk(en, '');
    } else for (const f of plain) out.push({ rel: f.name, file: f });
    return out;
  };
}

export function toBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
}

/** Copy dropped OS files into a folder of the worktree (asks before replacing). */
export async function uploadInto(ws, dir, items) {
  if (!items.length) return;
  const target = rel => (dir ? `${dir}/${rel}` : rel);
  const existing = await call('fs.exists', { root: ws.root, paths: items.map(i => target(i.rel)) });
  let replace = false;
  if (existing.length) {
    const v = await confirmDialog({
      title: existing.length === 1 ? `Replace ${existing[0]}?` : `Replace ${existing.length} existing files?`,
      detail: existing.length === 1 ? 'A file with that name is already there.' : existing.slice(0, 6).join('\n') + (existing.length > 6 ? '\n…' : ''),
      buttons: [{ label: 'Replace', value: 'replace', danger: true }, { label: 'Skip existing', value: 'skip' }],
    });
    if (!v) return;
    replace = v === 'replace';
  }
  let done = 0;
  for (const i of items) {
    const p = target(i.rel);
    if (!replace && existing.includes(p)) continue;
    try {
      await call('fs.upload', { root: ws.root, path: p, data: await toBase64(i.file), replace });
      done++;
    } catch (err) {
      toast(`${i.rel}: ${err.message}`, { kind: 'error' });
    }
  }
  if (done) toast(`Copied ${done} file${done === 1 ? '' : 's'} into ${dir || 'the top folder'}.`, { icon: 'files', timeout: 3000 });
  return done;
}

/** Move a file or folder from the Files panel into another folder. */
export async function moveInto(ws, from, dir) {
  if (dirname(from) === dir || dir === from || dir.startsWith(`${from}/`)) return;
  const to = dir ? `${dir}/${basename(from)}` : basename(from);
  try {
    await call('fs.rename', { root: ws.root, from, to });
  } catch (err) {
    toast(err.message, { kind: 'error' });
  }
}

const shellQuote = p => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);

/** Something dropped on a Claude session or shell: type the path(s) at its prompt. */
export async function dropOnTerminal(tab, e, getExternal) {
  const s = tab.session;
  if (!s) return;
  const claude = s.kind === 'claude';
  const inner = isInternal(e) ? readInternal(e) : null;
  let text = '';
  if (inner) {
    // Claude takes @path for a file in the project; a shell gets the full path
    text = claude && inner.root === tab.ws.root ? `@${inner.path}${inner.type === 'dir' ? '/' : ''} ` : `${shellQuote(`${inner.root}/${inner.path}`)} `;
  } else if (getExternal) {
    const items = await getExternal();
    const paths = [];
    for (const i of items) {
      try {
        const r = await call('drops.save', { name: basename(i.rel), data: await toBase64(i.file) });
        paths.push(shellQuote(r.path));
      } catch (err) {
        toast(`${i.rel}: ${err.message}`, { kind: 'error' });
      }
    }
    if (!paths.length) return;
    text = `${paths.join(' ')} `;
  }
  if (!text) return;
  sendInput(s.id, text);
  tab.focus();
}
