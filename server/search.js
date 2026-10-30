'use strict';
// File list (quick open), text search and "go to definition" by search.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { run, which } = require('./util');

const MAX_MATCHES = 2000;

async function files(root) {
  if (which('rg')) {
    const out = await run('rg', ['--files', '--hidden', '-g', '!.git'], { cwd: root, timeout: 30_000 }).catch(e => e.stdout || '');
    return out.split('\n').filter(Boolean).sort();
  }
  if (!fs.existsSync(path.join(root, '.git'))) return walkFiles(root);
  const out = await run('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root });
  return out.split('\0').filter(Boolean).sort();
}

/** Text search with ripgrep (falls back to git grep). */
function text(root, { query, regex = false, caseSensitive = false, word = false, include, exclude }) {
  if (!query) return Promise.resolve({ results: [], truncated: false });
  if (!which('rg')) return fs.existsSync(path.join(root, '.git')) ? gitGrep(root, query, { regex, caseSensitive, word }) : plainGrep(root, query, { regex, caseSensitive, word });
  const args = ['--json', '--hidden', '-g', '!.git', '--max-columns', '400', '--max-count', '200'];
  if (!regex) args.push('-F');
  if (!caseSensitive) args.push('-i');
  if (word) args.push('-w');
  for (const g of (include || '').split(',').map(s => s.trim()).filter(Boolean)) args.push('-g', g);
  for (const g of (exclude || '').split(',').map(s => s.trim()).filter(Boolean)) args.push('-g', `!${g}`);
  args.push('-e', query, '.');
  return new Promise(resolve => {
    const child = spawn('rg', args, { cwd: root });
    const byFile = new Map();
    let count = 0;
    let truncated = false;
    let rest = '';
    child.stdout.on('data', chunk => {
      rest += chunk;
      let nl;
      while ((nl = rest.indexOf('\n')) >= 0) {
        const line = rest.slice(0, nl);
        rest = rest.slice(nl + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.type !== 'match') continue;
        const file = (m.data.path.text || '').replace(/^\.\//, '');
        const lineText = m.data.lines.text || '';
        for (const sub of m.data.submatches) {
          if (count >= MAX_MATCHES) {
            truncated = true;
            child.kill();
            break;
          }
          count++;
          if (!byFile.has(file)) byFile.set(file, []);
          const before = Buffer.from(lineText).subarray(0, sub.start).toString().length;
          const len = Buffer.from(lineText).subarray(sub.start, sub.end).toString().length;
          byFile.get(file).push({ line: m.data.line_number, col: before + 1, len, text: lineText.replace(/\r?\n$/, '') });
        }
      }
    });
    child.on('close', () => resolve({ results: [...byFile].map(([file, matches]) => ({ file, matches })), truncated, count }));
    child.on('error', () => resolve({ results: [], truncated: false, count: 0 }));
  });
}

/** Files under a plain (non-git) folder, skipping the usual heavy folders. */
function walkFiles(root, max = 50_000) {
  const skip = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', 'target', '.cache']);
  const out = [];
  const stack = [''];
  while (stack.length && out.length < max) {
    const rel = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!skip.has(e.name)) stack.push(r); } else if (e.isFile()) out.push(r);
    }
  }
  return out.sort();
}

/** Text search in a plain folder without ripgrep: grep -r. */
async function plainGrep(root, query, { regex, caseSensitive, word }) {
  const args = ['-rnI', '--exclude-dir=.git', '--exclude-dir=node_modules', '-m', '200'];
  if (!regex) args.push('-F');
  if (!caseSensitive) args.push('-i');
  if (word) args.push('-w');
  args.push('-e', query, '.');
  const out = await run('grep', args, { cwd: root }).catch(e => e.stdout || '');
  const byFile = new Map();
  let count = 0;
  const needle = caseSensitive ? query : query.toLowerCase();
  for (const l of out.split('\n')) {
    const m = /^(?:\.\/)?(.*?):(\d+):(.*)$/.exec(l);
    if (!m || count >= MAX_MATCHES) continue;
    count++;
    const text = m[3];
    const at = regex ? -1 : (caseSensitive ? text : text.toLowerCase()).indexOf(needle);
    if (!byFile.has(m[1])) byFile.set(m[1], []);
    byFile.get(m[1]).push({ line: Number(m[2]), col: at >= 0 ? at + 1 : 1, len: at >= 0 ? query.length : 0, text });
  }
  return { results: [...byFile].map(([file, matches]) => ({ file, matches })), truncated: count >= MAX_MATCHES, count };
}

async function gitGrep(root, query, { regex, caseSensitive, word }) {
  const args = ['grep', '-n', '--column', '-I', '--untracked'];
  if (!regex) args.push('-F');
  if (!caseSensitive) args.push('-i');
  if (word) args.push('-w');
  args.push('-e', query);
  const out = await run('git', args, { cwd: root }).catch(e => e.stdout || '');
  const byFile = new Map();
  let count = 0;
  for (const l of out.split('\n')) {
    const m = /^(.*?):(\d+):(\d+):(.*)$/.exec(l);
    if (!m || count >= MAX_MATCHES) continue;
    count++;
    if (!byFile.has(m[1])) byFile.set(m[1], []);
    byFile.get(m[1]).push({ line: Number(m[2]), col: Number(m[3]), len: query.length, text: m[4] });
  }
  return { results: [...byFile].map(([file, matches]) => ({ file, matches })), truncated: count >= MAX_MATCHES, count };
}

function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Regexes that usually mark where `sym` is defined, per language family. */
function definitionPatterns(sym, lang) {
  const s = esc(sym);
  const common = [
    `\\b(function|class|interface|type|enum|struct|trait|impl|def|fn|module|namespace|record)\\s+${s}\\b`,
    `\\b(const|let|var|val)\\s+${s}\\b\\s*[:=]`,
  ];
  switch (lang) {
    case 'python':
      return [`^\\s*(async\\s+)?def\\s+${s}\\b`, `^\\s*class\\s+${s}\\b`, `^\\s*${s}\\s*(:[^=]+)?=[^=]`];
    case 'css': case 'scss': case 'less':
      return [`[.#]${s}\\b[^;{]*\\{`, `--${s}\\s*:`, `@mixin\\s+${s}\\b`, `\\$${s}\\s*:`];
    case 'html':
      return [`id=["']${s}["']`, `class=["'][^"']*\\b${s}\\b`];
    case 'rust':
      return [`\\b(fn|struct|enum|trait|type|const|static|mod|macro_rules!)\\s+${s}\\b`, `\\bimpl(<[^>]*>)?\\s+${s}\\b`];
    case 'go':
      return [`\\bfunc\\s+(\\([^)]*\\)\\s*)?${s}\\b`, `\\btype\\s+${s}\\b`, `\\b(var|const)\\s+${s}\\b`];
    case 'javascript': case 'typescript': case 'javascriptreact': case 'typescriptreact':
      return [
        ...common,
        `\\b${s}\\s*[:=]\\s*(async\\s*)?(function\\b|\\([^)]*\\)\\s*(:[^=]+)?=>|[A-Za-z_$][\\w$]*\\s*=>)`,
        `^\\s*(public|private|protected|static|async|get|set|\\s)*${s}\\s*\\([^)]*\\)\\s*(:[^{]+)?\\{`,
        `\\bexport\\s+(default\\s+)?(function|class|const|let)\\s+${s}\\b`,
      ];
    default:
      return common;
  }
}

/** Candidate definitions of `symbol`, best guesses first (same file, then nearby paths). */
async function definition(root, { symbol, lang, fromFile }) {
  if (!symbol || !/^[\w$-]+$/.test(symbol)) return [];
  const pats = definitionPatterns(symbol, lang);
  const results = [];
  for (const p of pats) {
    const r = await text(root, { query: p, regex: true, caseSensitive: true });
    for (const f of r.results) for (const m of f.matches) results.push({ file: f.file, line: m.line, col: Math.max(1, m.text.indexOf(symbol) + 1), text: m.text.trim() });
    if (results.length > 50) break;
  }
  const seen = new Set();
  const uniq = results.filter(r => {
    const k = `${r.file}:${r.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const dirOf = f => f.split('/').slice(0, -1).join('/');
  const score = r => (r.file === fromFile ? 0 : fromFile && dirOf(r.file) === dirOf(fromFile) ? 1 : 2) + (/(^|\/)(test|tests|__tests__|spec)\//.test(r.file) ? 1 : 0);
  return uniq.sort((a, b) => score(a) - score(b) || a.file.localeCompare(b.file) || a.line - b.line).slice(0, 50);
}

module.exports = { files, text, definition, definitionPatterns };
