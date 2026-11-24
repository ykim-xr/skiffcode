// Watches on single files. The server keeps one watch per connection and path, so an
// editor model and a preview tab on the same file share one watch, counted here.
import { call, on } from './rpc.js';

const held = new Map(); // key root\0path -> { root, path, n }

/** Watch a file for `fs.changed`. Returns a function that gives the watch back. */
export function watchFile(root, path) {
  const k = `${root}\0${path}`;
  let w = held.get(k);
  if (w) w.n++;
  else {
    held.set(k, w = { root, path, n: 1 });
    void call('fs.watch', { root, path }).catch(() => {});
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--w.n > 0) return;
    held.delete(k);
    void call('fs.unwatch', { root, path }).catch(() => {});
  };
}

// The server forgets a connection's watches when it drops.
on('reconnect', () => {
  for (const { root, path } of held.values()) void call('fs.watch', { root, path }).catch(() => {});
});
