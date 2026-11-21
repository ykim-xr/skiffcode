#!/usr/bin/env node
// Runs several copies of test/ui.test.js at once, each with a slowed CPU, to catch the timing races that
// macOS CI shows and a fast local run hides. Not part of `npm test` or CI: run it by hand after touching UI tests or UI timing.
//
//   node test/stress.js [--runs N=3] [--cpu R=4] [--ui-only]
//
// Each copy gets its own port (3950, 3960, 3970, ...; PORT + 100 is used too), SKIFFCODE_TEST_CPU=R,
// the stub Monaco/xterm unless SKIFFCODE_VENDOR is set, its own SHOTS folder and its own log under a temp folder.
// Needs Playwright like ui.test.js (PLAYWRIGHT_PATH). The server suite is not run: --ui-only is accepted and is the only mode.
// Exits non-zero if any copy fails.
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i < 0 ? dflt : Number(process.argv[i + 1]); };
const runs = arg('--runs', 3);
const cpu = arg('--cpu', 4);
if (!(runs >= 1) || !(cpu >= 1)) { console.error('usage: node test/stress.js [--runs N=3] [--cpu R=4] [--ui-only]'); process.exit(2); }

const free = port => new Promise(res => {
  const s = net.createServer();
  s.once('error', () => res(false));
  s.listen(port, '127.0.0.1', () => s.close(() => res(true)));
});
/** Both PORT and PORT + 100 must be free. */
const portsFree = async port => (await free(port)) && (await free(port + 100));

(async () => {
  const ports = [];
  for (let p = 3950; ports.length < runs && p < 4950; p += 10) if (await portsFree(p)) ports.push(p);
  if (ports.length < runs) { console.error(`found only ${ports.length} free port pairs for ${runs} runs`); process.exit(2); }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skiffcode-stress-'));
  console.log(`stress: ${runs} parallel ui runs, CPU x${cpu}, logs in ${dir}`);
  const vendor = process.env.SKIFFCODE_VENDOR || path.join(__dirname, 'stub-vendor');

  const results = await Promise.all(ports.map((port, i) => new Promise(resolve => {
    const log = path.join(dir, `run-${i + 1}.log`);
    const out = fs.createWriteStream(log);
    const env = { ...process.env, SKIFFCODE_TEST_PORT: String(port), SKIFFCODE_TEST_CPU: String(cpu), SKIFFCODE_VENDOR: vendor, SHOTS: path.join(dir, `shots-${i + 1}`) };
    const child = spawn(process.execPath, [path.join(__dirname, 'ui.test.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    child.on('close', code => out.end(() => resolve({ i: i + 1, port, log, code })));
  })));

  let failed = 0;
  for (const r of results) {
    const text = fs.readFileSync(r.log, 'utf8');
    if (r.code === 0) { console.log(`run ${r.i} (port ${r.port}): pass`); continue; }
    failed++;
    const lines = text.split('\n');
    const failedStep = lines.find(l => l.startsWith('  ✗ '));
    const failIdx = lines.findIndex(l => l.startsWith('FAILED:'));
    console.log(`run ${r.i} (port ${r.port}): FAIL (exit ${r.code})`);
    console.log(`  failing step: ${failedStep ? failedStep.trim().slice(2) : '(outside any step)'}`);
    console.log(`  first error lines:\n${(failIdx >= 0 ? lines.slice(failIdx, failIdx + 8) : lines.slice(-8)).map(l => `    ${l}`).join('\n')}`);
    console.log(`  log: ${r.log}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
