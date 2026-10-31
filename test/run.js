#!/usr/bin/env node
// Runs both suites, the server one first, and fails if either fails.
// Needs Node 22+: api.test.js uses the global WebSocket. The server itself needs Node 18+.
// ui.test.js needs Playwright (see its header); it uses the stub Monaco/xterm unless SKIFFCODE_VENDOR is set.
const { spawnSync } = require('child_process');
const path = require('path');

const env = { ...process.env, SKIFFCODE_VENDOR: process.env.SKIFFCODE_VENDOR || path.join(__dirname, 'stub-vendor') };
for (const file of ['api.test.js', 'ui.test.js']) {
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit', env });
  if (r.status !== 0) {
    console.error(`\n${file} failed`);
    process.exit(r.status || 1);
  }
}
