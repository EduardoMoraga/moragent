import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { setExec, resetExec } from '../src/core/exec.js';
import { setLang } from '../src/core/i18n.js';
import { plain } from '../src/core/log.js';
import { defaultConfig, PRESETS } from '../src/core/config.js';
import { writeJSON } from '../src/core/fsx.js';
import { scaffold } from '../src/commands/init.js';
import { renderBoard, groupTasks } from '../src/ui/board.js';
import { table } from '../src/ui/table.js';
import { createPrompter, parseYesNo } from '../src/ui/prompt.js';
import { runWizard } from '../src/ui/wizard.js';
import { banner, LOGO } from '../src/ui/banner.js';
import dashboard, { suggestNext, taskSummary } from '../src/commands/dashboard.js';
import doctor, { parseVersion } from '../src/commands/doctor.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mora-ui-'));
const feed = (s) => { const i = new PassThrough(); i.end(s); return i; };
const sink = () => { const o = new PassThrough(); o.text = ''; o.on('data', (d) => { o.text += d; }); return o; };

// Capture everything written to stdout while fn runs.
async function capture(fn) {
  const orig = process.stdout.write.bind(process.stdout);
  let buf = '';
  process.stdout.write = (s) => { buf += s; return true; };
  try { const code = await fn(); return { code, text: buf }; } finally { process.stdout.write = orig; }
}

const TASKS = [
  { id: 'T-0001', title: 'Diseñar el esquema de pedidos y pagos con un proveedor externo', role: 'backend', status: 'done', updatedAt: '2026-09-27T10:00:00-03:00' },
  { id: 'T-0002', title: 'Pantalla de checkout', role: 'frontend', status: 'running' },
  { id: 'T-0003', title: 'CI', role: 'dev', status: 'blocked' },
  { id: 'T-0004', title: 'Tests e2e', role: 'helper', status: 'failed' },
  { id: 'T-0005', title: 'Docs', role: 'frontend', status: 'queued' },
];

beforeEach(() => { setLang('en'); setExec(() => ({ code: 0, stdout: 'tool 1.2.3\n', stderr: '' })); });
afterEach(() => resetExec());

test('banner fits the contract: ≤ 6 lines, ≤ 60 columns', () => {
  const lines = plain(banner({ version: '4.0.0' })).split('\n');
  assert.ok(lines.length <= 6);
  for (const l of [...LOGO, ...lines]) assert.ok([...l].length <= 60, l);
});

test('table aligns on plain width, ignoring ANSI', () => {
  const s = table([['\x1b[32m✓\x1b[39m', 'lead', 'claude'], ['✗', 'backend', 'codex']], ['', 'role', 'cli']);
  const lines = s.split('\n').map(plain);
  assert.equal(lines.length, 4);
  assert.equal(lines[2].indexOf('claude'), lines[3].indexOf('codex'));
  assert.match(lines[1], /^─+ +─+ +─+$/);
  assert.equal(table([], null), '');
});

test('groupTasks puts failed next to blocked and unknown in queued', () => {
  const g = groupTasks([...TASKS, { id: 'T-9', title: 'x', status: 'weird' }]);
  assert.deepEqual(g.blocked.map((x) => x.id), ['T-0003', 'T-0004']);
  assert.deepEqual(g.queued.map((x) => x.id), ['T-0005', 'T-9']);
  assert.equal(g.sent.length, 0);
});

test('renderBoard: kanban on wide terminals never exceeds the width', () => {
  const s = renderBoard(TASKS, { project: 'shop' }, { columns: 100 });
  const lines = s.split('\n').map(plain);
  assert.match(lines[0], /Board · shop · 5 tasks/);
  assert.match(lines[2], /Queued 1\s+Sent 0\s+Running 1\s+Done 1\s+Blocked 2/);
  for (const l of lines) assert.ok([...l].length <= 100, `too wide: ${l}`);
  assert.ok(s.includes('T-0004') && s.includes('✗'));
});

test('renderBoard: list layout under 80 columns, empty state hint', () => {
  const s = plain(renderBoard(TASKS, {}, { columns: 60 }));
  assert.match(s, /Blocked \(2\)\n  • T-0003 @dev CI\n  ✗ T-0004 @helper Tests e2e/);
  for (const l of s.split('\n')) assert.ok([...l].length <= 60, l);
  assert.match(plain(renderBoard([], {}, { columns: 120 })), /No tasks yet/);
});

test('prompter: defaults, numbers, labels, yes/no and EOF fallback', async () => {
  const p = createPrompter({ input: feed('\nhello\n2\nEng\nn\nmaybe\ny\n1, 3\n'), output: sink() });
  assert.equal(await p.ask('Name', 'def'), 'def');
  assert.equal(await p.ask('Name', 'def'), 'hello');
  assert.equal(await p.select('Lang', ['es', 'en'], 'es'), 'en');
  assert.equal(await p.select('Lang', [{ value: 'es', label: 'Español' }, { value: 'en', label: 'English' }], 'es'), 'en');
  assert.equal(await p.confirm('Ok?', true), false);
  assert.equal(await p.confirm('Ok?', false), true);
  assert.deepEqual(await p.multiselect('Pick', ['a', 'b', 'c'], []), ['a', 'c']);
  // input exhausted: everything resolves to its default instead of hanging
  assert.equal(await p.ask('More', 'x'), 'x');
  assert.equal(await p.confirm('More?', true), true);
  assert.equal(await p.select('More', ['a', 'b'], 'b'), 'b');
  p.close();
  assert.equal(parseYesNo('Sí'), true);
  assert.equal(parseYesNo('nope'), null);
});

test('prompter re-asks on invalid choice, then keeps the default', async () => {
  const out = sink();
  const p = createPrompter({ input: feed('9\nzzz\n0\n'), output: out });
  assert.equal(await p.select('Pick', ['a', 'b'], 'b'), 'b');
  p.close();
  assert.match(plain(out.text), /Pick a number from 1 to 2/);
});

test('wizard with simulated input returns init answers', async () => {
  const out = sink();
  const res = await runWizard({
    defaults: { project: 'demo', lang: 'en', preset: 'squad', goal: '', clis: {} },
    installed: ['claude'], presets: PRESETS, catalog: [], input: feed('2\ncoffee shop\nAn online coffee shop\n3\ny\n'), output: out,
  });
  assert.deepEqual(res, { project: 'coffee-shop', lang: 'en', preset: 'trio', goal: 'An online coffee shop', clis: {} });
  const text = plain(out.text);
  assert.match(text, /Your crew/);
  assert.match(text, /frontend/);
});

test('wizard: all defaults with Enter, and cancel returns null', async () => {
  const defaults = { project: 'demo', lang: 'es', preset: 'duo', goal: '', clis: {} };
  const ok = await runWizard({ defaults, installed: [], presets: PRESETS, catalog: [], input: feed('\n\n\n\n\n'), output: sink() });
  assert.deepEqual(ok, { project: 'demo', lang: 'es', preset: 'duo', goal: '', clis: {} });
  const no = await runWizard({ defaults, installed: [], presets: PRESETS, catalog: [], input: feed('\n\n\n\nn\n'), output: sink() });
  assert.equal(no, null);
});

test('suggestNext orders blocked work first and falls back to dispatch', () => {
  const cfg = { brain: { vault: null } };
  const none = suggestNext({ tasks: taskSummary([]), panes: {}, cfg, spec: null }).map((n) => n.cmd);
  assert.deepEqual(none, ['mora plan "…"', 'mora up', 'mora brain link']);
  const busy = suggestNext({ tasks: taskSummary(TASKS), panes: { lead: { alive: true } }, cfg, spec: null }).map((n) => n.cmd);
  assert.equal(busy[0], 'mora board');
  const clear = suggestNext({ tasks: taskSummary([TASKS[0]]), panes: { lead: { alive: true } }, cfg: { brain: { vault: '/v' } }, spec: null });
  assert.match(clear[0].cmd, /mora dispatch/);
});

test('dashboard --json in a temp project', async () => {
  const root = tmp();
  scaffold(root, { ...defaultConfig({ project: 'demo', lang: 'en', preset: 'duo' }), goal: 'Ship the demo' });
  const d = path.join(root, '.moragent');
  writeJSON(path.join(d, 'tasks', 'T-0001.json'), TASKS[0]);
  writeJSON(path.join(d, 'tasks', 'T-0002.json'), TASKS[2]);
  fs.writeFileSync(path.join(d, 'memory', 'episodic', '2026-09-27-x.md'), '---\ntitle: x\n---\nbody\n');
  const { code, text } = await capture(() => dashboard.run({ _: [], flags: {} }, { root, json: true }));
  assert.equal(code, 0);
  const data = JSON.parse(text);
  assert.equal(data.project, 'demo');
  assert.equal(data.goal, 'Ship the demo');
  assert.deepEqual(data.crew.map((m) => m.role), ['lead', 'backend']);
  assert.equal(data.tasks.total, 2);
  assert.equal(data.tasks.byStatus.blocked, 1);
  assert.deepEqual(data.memory, { canonical: 1, episodic: 1, transient: 0, skills: 0 });
  assert.equal(data.next[0].cmd, 'mora board');
  fs.rmSync(root, { recursive: true, force: true });
});

test('dashboard renders text without a TTY', async () => {
  const root = tmp();
  scaffold(root, defaultConfig({ project: 'demo', lang: 'en', preset: 'solo' }));
  const { code, text } = await capture(() => dashboard.run({ _: [], flags: {} }, { root, json: false }));
  assert.equal(code, 0);
  assert.match(plain(text), /Suggested next step\n  › mora plan/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('doctor --json is parseable and exit code follows failures', async () => {
  process.env.MORAGENT_OBSIDIAN_CONFIG = path.join(os.tmpdir(), 'mora-no-obsidian.json');
  const root = tmp();
  scaffold(root, defaultConfig({ project: 'demo', lang: 'en', preset: 'solo' }));
  const { code, text } = await capture(() => doctor.run({ _: [], flags: {} }, { root, json: true }));
  const r = JSON.parse(text);
  assert.equal(code, r.ok ? 0 : 1);
  assert.ok(r.checks.find((x) => x.id === 'node' && x.status === 'ok'));
  assert.ok(r.checks.find((x) => x.id === 'config' && x.status === 'ok'));
  assert.ok(r.checks.some((x) => x.id === 'instructions'), 'project checks run');
  assert.equal(r.summary.ok + r.summary.warn + r.summary.fail + r.summary.skip, r.checks.length);
  fs.writeFileSync(path.join(root, '.moragent', 'moragent.json'), '{ broken');
  const bad = JSON.parse((await capture(() => doctor.run({ _: [], flags: {} }, { root, json: true }))).text);
  assert.equal(bad.ok, false);
  assert.ok(bad.checks.find((x) => x.id === 'config' && x.status === 'fail'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('parseVersion extracts semver from noisy --version output', () => {
  assert.equal(parseVersion('2.1.283 (Claude Code)'), '2.1.283');
  assert.equal(parseVersion('codex-cli 0.154.0'), '0.154.0');
  assert.equal(parseVersion('nothing'), null);
});
