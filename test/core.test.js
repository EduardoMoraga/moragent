import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, flagList } from '../src/core/args.js';
import { upsertBlock, slugify, today, nowISO, writeJSON, readJSON, copyDir } from '../src/core/fsx.js';
import { defaultConfig, PRESETS } from '../src/core/config.js';
import { findRoot, dirs } from '../src/core/paths.js';
import { assignClis, scaffold } from '../src/commands/init.js';
import { syncProject } from '../src/core/sync.js';
import { setExec, resetExec, run, runAsync, spawnDetached } from '../src/core/exec.js';
import { openPrivateLog, writeBoundedPrivateLog } from '../src/core/private-log.js';

test('detached process logs are private even with a permissive process umask', { skip: process.platform === 'win32' }, () => {
  const root = tmp();
  const previousUmask = process.umask(0o022);
  try {
    const logFile = path.join(root, 'background.log');
    const child = spawnDetached(process.execPath, ['-e', ''], { cwd: root, logFile });
    assert.ok(child.pid > 0);
    assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);
  } finally {
    process.umask(previousUmask);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('private logs tighten old permissions and refuse a final-path symlink', { skip: process.platform === 'win32' }, () => {
  const root = tmp();
  try {
    const logFile = path.join(root, 'old.log');
    fs.writeFileSync(logFile, 'old\n', { mode: 0o644 });
    fs.chmodSync(logFile, 0o644);
    const fd = openPrivateLog(logFile);
    fs.closeSync(fd);
    assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);

    const link = path.join(root, 'link.log');
    fs.symlinkSync(logFile, link);
    assert.throws(() => openPrivateLog(link));
    assert.equal(fs.readFileSync(logFile, 'utf8'), 'old\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('bounded private logs keep the recent tail and mark omitted content', () => {
  const root = tmp();
  try {
    const logFile = path.join(root, 'bounded.log');
    const fd = openPrivateLog(logFile);
    try {
      writeBoundedPrivateLog(fd, 'first event\n'.repeat(10), 128);
      writeBoundedPrivateLog(fd, 'RECENT-EVENT\n', 128);
    } finally { fs.closeSync(fd); }
    const text = fs.readFileSync(logFile, 'utf8');
    assert.ok(Buffer.byteLength(text) <= 128);
    assert.match(text, /earlier log data omitted/);
    assert.match(text, /RECENT-EVENT/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mora-core-'));

test('args: positionals, values, booleans, negation, short flags', () => {
  const a = parse(['dispatch', 'backend', 'do it', '--spec', 'auth', '--json', '--no-wait', '-y', '--x=1', '--', '--raw']);
  assert.deepEqual(a._, ['dispatch', 'backend', 'do it', '--raw']);
  assert.equal(a.flags.spec, 'auth');
  assert.equal(a.flags.json, true);
  assert.equal(a.flags.wait, false);
  assert.equal(a.flags.yes, true);
  assert.equal(a.flags.x, '1');
  assert.deepEqual(flagList('a, b,,c'), ['a', 'b', 'c']);
});

test('args: boolean flags never swallow the next positional', () => {
  const a = parse(['--json', 'list']);
  assert.deepEqual(a._, ['list']);
});

test('upsertBlock replaces in place and appends once', () => {
  let s = upsertBlock('# Title\n', 'core', 'one');
  assert.match(s, /# Title\n\n<!-- moragent:core:start -->\none\n<!-- moragent:core:end -->\n$/);
  s = upsertBlock(s + '\nuser text\n', 'core', 'two');
  assert.equal(s.match(/moragent:core:start/g).length, 1);
  assert.match(s, /two/);
  assert.match(s, /user text/);
});

test('slugify strips accents and symbols', () => {
  assert.equal(slugify('Autenticación con JWT: v2!'), 'autenticacion-con-jwt-v2');
  assert.equal(slugify('***'), 'item');
});

test('dates are local and well formed', () => {
  assert.match(today(), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(nowISO(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
});

test('json roundtrip and copyDir only writes changes', () => {
  const d = tmp();
  writeJSON(path.join(d, 'a', 'x.json'), { a: 1 });
  assert.deepEqual(readJSON(path.join(d, 'a', 'x.json')), { a: 1 });
  assert.equal(readJSON(path.join(d, 'missing.json'), 'fb'), 'fb');
  assert.equal(copyDir(path.join(d, 'a'), path.join(d, 'b')).length, 1);
  assert.equal(copyDir(path.join(d, 'a'), path.join(d, 'b')).length, 0);
});

test('config presets and CLI assignment fall back to installed CLIs', () => {
  const adaptive = defaultConfig({ project: 'research' });
  assert.deepEqual(Object.keys(adaptive.crew), PRESETS.adaptive.roles);
  assert.equal(adaptive.crew.executor.cli, 'codex');
  assert.equal(adaptive.crew.researcher.cli, 'pi');
  assert.equal(adaptive.crew.reviewer.cli, 'claude');
  const cfg = defaultConfig({ project: 'p', lang: 'en', preset: 'trio' });
  assert.deepEqual(Object.keys(cfg.crew), PRESETS.trio.roles);
  assert.equal(cfg.crew.backend.cli, 'codex');
  assert.deepEqual(assignClis(['lead', 'backend', 'helper'], ['claude']), { lead: 'claude', backend: 'claude', helper: 'claude' });
  assert.equal(assignClis(['backend'], [], { backend: 'opencode' }).backend, 'opencode');
  assert.throws(() => defaultConfig({ preset: 'huge' }), /Unknown preset/);
});

test('scaffold + sync create the project tree and managed instruction files', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'es', preset: 'squad' });
  scaffold(root, cfg);
  assert.equal(findRoot(path.join(root)), root);
  const sub = path.join(root, 'src', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(findRoot(sub), root);
  for (const k of ['canonical', 'episodic', 'transient', 'specs', 'tasks']) assert.ok(fs.existsSync(dirs(root)[k]));

  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Mine\n\nKeep me.\n');
  const r = await syncProject(root, cfg);
  const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(agents, /Keep me\./);
  assert.match(agents, /moragent:core:start/);
  assert.match(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), /@AGENTS\.md/);
  assert.ok(r.files.length >= 2);
  const again = await syncProject(root, cfg);
  assert.equal(again.files.length, 0, 'second sync is a no-op');
});

test('exec seam replaces run()', () => {
  setExec((cmd, args) => ({ code: 0, stdout: `${cmd} ${args.join(' ')}`, stderr: '' }));
  assert.equal(run('orca', ['terminal', 'list']).stdout, 'orca terminal list');
  resetExec();
});

test('asynchronous CLI probes keep the event loop responsive and time out', async () => {
  const pending = runAsync(process.execPath, ['-e', 'setTimeout(() => console.log("ready"), 100)'], { timeoutMs: 1000 });
  let ticked = false;
  setTimeout(() => { ticked = true; }, 20);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(ticked, true);
  const result = await pending;
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), 'ready');

  const timedOut = await runAsync(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 50 });
  assert.equal(timedOut.code, 124);
  assert.match(timedOut.stderr, /Timed out/);
});

test('hooks merge into existing Claude settings and Codex config without overriding', async () => {
  const { installClaudeHook, installCodexHook } = await import('../src/core/hooks.js');
  const root = tmp();
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));
  assert.ok(installClaudeHook(root));
  assert.equal(installClaudeHook(root), null, 'idempotent');
  const s = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
  assert.equal(s.hooks.Stop[0].hooks[0].command, 'say done');
  assert.match(s.hooks.SessionEnd[0].hooks[0].command, /memory capture --from claude/);

  const cfgFile = path.join(root, 'codex-home', 'config.toml');
  fs.mkdirSync(path.dirname(cfgFile));
  fs.writeFileSync(cfgFile, 'model = "x"\n\n[mcp_servers.a]\ncommand = "a"\n');
  assert.ok(installCodexHook(cfgFile));
  const toml = fs.readFileSync(cfgFile, 'utf8');
  assert.ok(toml.indexOf('notify') < toml.indexOf('[mcp_servers.a]'), 'notify stays top-level');
  assert.equal(installCodexHook(cfgFile), null, 'never overrides an existing notify');
  const { installHooks } = await import('../src/core/hooks.js');
  const fresh = tmp();
  assert.ok(installHooks(fresh, ['codex']).length === 0, 'no global write without global: true');
});

test('windows quoting keeps spaced paths and metacharacters as one literal argument', async () => {
  const { shq, winQuote, which, spawnPlan } = await import('../src/core/exec.js');
  assert.equal(shq('C:\\Program Files\\nodejs\\node.exe', 'win32'), '"C:\\Program Files\\nodejs\\node.exe"');
  assert.equal(shq('Bash(npm test:*)', 'win32'), '"Bash(npm test:*)"');
  assert.equal(winQuote('obsidian://open?vault=V&file=F'), '"obsidian://open?vault=V&file=F"');
  assert.equal(winQuote('say "hi"'), '"say ""hi"""');
  assert.equal(shq("it's", 'linux'), "'it'\\''s'", 'POSIX quoting unchanged');
  assert.equal(which(process.execPath), process.execPath, 'absolute paths resolve to themselves');
  assert.equal(which(''), null);
  assert.deepEqual(spawnPlan('codex', ['exec', 'task & verify'], 'linux'), {
    file: 'codex', argv: ['exec', 'task & verify'], shell: false,
  });
  assert.deepEqual(spawnPlan('C:\\Program Files\\nodejs\\codex.cmd', ['exec', 'task & verify'], 'win32'), {
    file: '"C:\\Program Files\\nodejs\\codex.cmd" exec "task & verify"', argv: [], shell: true,
  });
});

test('findRoot never crosses into a project above the enclosing git repo', () => {
  const top = tmp();
  scaffold(top, defaultConfig({ project: 'workspace', lang: 'es', preset: 'solo' }));
  const repo = path.join(top, 'lab', 'app');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'));
  assert.equal(findRoot(path.join(repo, 'src')), null, 'a repo without .moragent is not part of the workspace project');
  assert.equal(findRoot(path.join(top, 'lab')), top, 'plain folders still resolve upwards');
});
