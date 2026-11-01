#!/usr/bin/env node
// Pretend to be Claude Code: log the arguments, then fire the hooks from --settings
// in the order given by the FAKE_SCRIPT file (one step per line or comma-separated), e.g.
//   SessionStart,sleep:200,UserPromptSubmit,PreToolUse:AskUserQuestion,PostToolUse:Edit,Notification:permission_prompt,Stop
// Steps: <HookEvent>[:matcher] fires that hook; sleep:<ms>; Status:<5h%>:<weekly%>[:name] runs the status line;
// Agent:<type>:<desc> / AgentBg:<type>:<desc> / AgentAsync:<type>:<desc> / AgentDone:<n> start and stop subagents; Print:<text>;
// Spin:<seconds>; Bash:<seconds> (a command through the shell snapshot); Input and WaitKey (raw keys, logged to
// $FAKE_LOG.input); "hang" waits forever (to test killing). The plan file path comes from $FAKE_SCRIPT_FILE
// so each launch can read the current plan even inside tmux.
const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');
const args = process.argv.slice(2);
// `claude auth login|logout|status`: a pretend claude.ai login in the config dir, laid out like Claude's
// (.credentials.json, and oauthAccount in .claude.json); CLAUDE_CONFIG_DIR is required. Who signs in: $FAKE_LOGIN_AS, else the text of
// $FAKE_SCRIPT_FILE.login, else the folder name, so two scratch logins differ.
if (args[0] === 'auth') {
  // Never fall back to ~/.claude: a test must not touch the real login
  if (!process.env.CLAUDE_CONFIG_DIR) {
    console.error('fake claude: auth needs CLAUDE_CONFIG_DIR');
    process.exit(1);
  }
  const dir = process.env.CLAUDE_CONFIG_DIR;
  const cred = path.join(dir, '.credentials.json');
  const global = path.join(dir, '.claude.json');
  const read = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  if (args[1] === 'login') {
    const asFile = `${process.env.FAKE_SCRIPT_FILE || ''}.login`;
    const who = process.env.FAKE_LOGIN_AS || (fs.existsSync(asFile) ? fs.readFileSync(asFile, 'utf8').trim() : '') || path.basename(dir);
    const now = Date.now();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cred, JSON.stringify({ claudeAiOauth: { accessToken: `at-${who}-${now}`, refreshToken: `rt-${who}-${now}`, expiresAt: now + 3600e3, refreshTokenExpiresAt: now + 30 * 86400e3, scopes: ['user:inference'], subscriptionType: 'max' } }), { mode: 0o600 });
    // Claude writes .claude.json a moment later: whoever waits for the login must wait for both
    setTimeout(() => {
      const g = read(global) || {};
      g.oauthAccount = { accountUuid: `acct-${who}`, emailAddress: `${who}@example.test`, organizationUuid: `org-${who}`, organizationName: `Org ${who}` };
      fs.writeFileSync(global, JSON.stringify(g));
      console.log('Login successful.');
    }, 300);
  } else if (args[1] === 'logout') {
    fs.rmSync(cred, { force: true });
  } else {
    const c = read(cred);
    const a = (read(global) || {}).oauthAccount;
    console.log(JSON.stringify(c && a ? { loggedIn: true, authMethod: 'claude.ai', email: a.emailAddress, orgName: a.organizationName, subscriptionType: c.claudeAiOauth.subscriptionType } : { loggedIn: false, authMethod: 'none' }));
    process.exitCode = c ? 0 : 1;
  }
  return;
}
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, cwd: process.cwd(), env: process.env.SKIFFCODE_SESSION_ID, configDir: process.env.CLAUDE_CONFIG_DIR || null, userStatusLine: process.env.SKIFFCODE_USER_STATUSLINE || null }) + '\n');
const settings = JSON.parse(fs.readFileSync(args[args.indexOf('--settings') + 1], 'utf8'));
// the id SkiffCode passed, so hooks carry the session's real Claude id
const sessionId = args[args.findIndex(a => a === '--session-id' || a === '--resume') + 1];
const plan = fs.existsSync(process.env.FAKE_SCRIPT_FILE || '') ? fs.readFileSync(process.env.FAKE_SCRIPT_FILE, 'utf8') : 'SessionStart,hang';

function fire(event, matchValue, extra = {}) {
  for (const group of settings.hooks[event] || []) {
    const m = group.matcher;
    if (m && m !== '*' && !new RegExp(`^(?:${m})$`).test(matchValue ?? '')) continue;
    for (const h of group.hooks) {
      const out = execSync(h.command, { shell: '/bin/sh', input: JSON.stringify({ session_id: sessionId, hook_event_name: event, ...extra }), stdio: ['pipe', 'pipe', 'inherit'] }).toString();
      if (out.trim()) fs.appendFileSync(process.env.FAKE_LOG + '.hookout', JSON.stringify({ session: process.env.SKIFFCODE_SESSION_ID, event, out: out.trim() }) + '\n');
    }
  }
}

const keys = { n: 0, wake: () => {} };
(async () => {
  for (const step of plan.split(/[,\n]/).map(s => s.trim()).filter(Boolean)) {
    if (step.startsWith('sleep:')) await new Promise(r => setTimeout(r, Number(step.slice(6))));
    else if (step.startsWith('Status:')) {
      // Status:<5h%>:<weekly%> — run the statusLine command like Claude does after a response; a 5h of "-" sends no 5-hour window
      const [, five, week] = step.split(':').map(Number);
      const named = step.split(':')[3]; // Status:5h:wk:<session name, as /rename would set it>
      const now = Math.floor(Date.now() / 1000);
      const input = { session_id: sessionId, ...(named ? { session_name: named } : {}), model: { display_name: 'Opus' }, context_window: { used_percentage: 12 }, rate_limits: { ...(Number.isNaN(five) ? {} : { five_hour: { used_percentage: five, resets_at: now + 7200 } }), seven_day: { used_percentage: week, resets_at: now + 3 * 86400 } } };
      const out = execSync(settings.statusLine.command, { shell: '/bin/sh', input: JSON.stringify(input) }).toString();
      if (out.trim()) fs.appendFileSync(process.env.FAKE_LOG + '.status', out);
    } else if (/^Agent(Bg|Async)?:/.test(step)) {
      // Agent:<type>:<description> — spawn subagent n (numbered from 1 in order)
      const [kind, type, desc] = step.split(':');
      const n = (globalThis.agentN = (globalThis.agentN || 0) + 1);
      fire('PreToolUse', 'Agent', { tool_name: 'Agent', tool_use_id: `tu${n}`, tool_input: { subagent_type: type, description: desc, prompt: 'do it\nnow "quoted"', run_in_background: kind === 'AgentBg' } });
      fire('SubagentStart', type, { agent_id: `ag${n}`, agent_type: type });
      if (kind === 'AgentBg') fire('PostToolUse', 'Agent', { tool_name: 'Agent', tool_use_id: `tu${n}`, tool_input: {} });
      // Claude moved it to the background itself: no run_in_background, the result says it was launched
      if (kind === 'AgentAsync') fire('PostToolUse', 'Agent', { tool_name: 'Agent', tool_use_id: `tu${n}`, tool_input: {}, tool_response: { isAsync: true, status: 'async_launched', agentId: `ag${n}` } });
    } else if (step.startsWith('Print:')) {
      process.stdout.write(`\r\n${step.slice(6)}\r\n`);
    } else if (step.startsWith('Spin:')) {
      // Spin:<seconds> — redraw a spinner like Claude does while it works
      const end = Date.now() + Number(step.slice(5)) * 1000;
      while (Date.now() < end) { process.stdout.write(`\r✻ Thinking… ${Math.round((end - Date.now()) / 1000)}s`); await new Promise(r => setTimeout(r, 150)); }
    } else if (step.startsWith('Bash:')) {
      // Bash:<seconds> — a command running the way Claude runs them (through its shell snapshot)
      require('child_process').spawn('bash', ['-c', `source /dev/null shell-snapshots/snapshot-bash-fake.sh; sleep ${step.split(":")[1]}; pwd -P >/dev/null`], { stdio: 'ignore' });
    } else if (step.startsWith('AgentDone:')) {
      const n = Number(step.split(':')[1]);
      fire('SubagentStop', '', { agent_id: `ag${n}`, agent_type: 'x' });
      fire('PostToolUse', 'Agent', { tool_name: 'Agent', tool_use_id: `tu${n}`, tool_input: {} });
    } else if (step === 'Input') {
      // Input — raw keys from now on, each chunk logged to $FAKE_LOG.input
      process.stdin.setRawMode(true);
      process.stdin.on('data', d => {
        fs.appendFileSync(process.env.FAKE_LOG + '.input', JSON.stringify({ session: process.env.SKIFFCODE_SESSION_ID, data: d.toString('utf8') }) + '\n');
        keys.n++;
        keys.wake();
      });
    } else if (step === 'WaitKey') {
      // WaitKey — wait for the next key press (after Input), e.g. one answer of a question
      while (!keys.n) await new Promise(r => { keys.wake = r; });
      keys.n--;
    } else if (step === 'hang') await new Promise(() => setInterval(() => {}, 1 << 30));
    else {
      const [ev, m] = step.split(':');
      fire(ev, m);
    }
  }
})();
