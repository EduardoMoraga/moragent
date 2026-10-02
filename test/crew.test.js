import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ADAPTERS, autonomyFor, getAdapter } from '../src/crew/adapters.js';
import { flagOn, isCurrentLead } from '../src/commands/up.js';
import dispatchCommand, { assertPaneReady } from '../src/commands/dispatch.js';
import { sizeIdea, recommendRoles } from '../src/commands/plan.js';
import crewCommand from '../src/commands/crew.js';
import { defaultConfig, loadConfig } from '../src/core/config.js';
import { scaffold } from '../src/commands/init.js';
import { normalizePlan } from '../src/engine/plan.js';

test('all documented adapters expose a consistent interface', () => {
  assert.deepEqual(Object.keys(ADAPTERS), ['claude', 'codex', 'agy', 'pi', 'opencode', 'gemini']);
  for (const [id, adapter] of Object.entries(ADAPTERS)) {
    assert.equal(adapter.id, id);
    assert.equal(typeof adapter.interactive, 'function');
    assert.equal(typeof adapter.headless, 'function');
    assert.ok(adapter.docs.startsWith('https://'));
    assert.ok(adapter.install);
  }
});

test('headless adapter commands match supported CLI flags', () => {
  assert.deepEqual(ADAPTERS.claude.headless({ prompt: 'fix it' }), [
    'claude', '--permission-mode', 'auto', '--allowedTools',
    'Bash(mora:*)', 'Bash(npm test:*)', 'Bash(node:*)', 'Bash(git status:*)', 'Bash(git diff:*)',
    '-p', 'fix it',
  ]);
  assert.deepEqual(ADAPTERS.codex.headless({ prompt: 'fix it' }), ['codex', 'exec', '-s', 'workspace-write', 'fix it']);
  assert.deepEqual(ADAPTERS.agy.headless({ prompt: 'fix it' }), ['agy', '--sandbox', '--dangerously-skip-permissions', '-p', 'fix it']);
  assert.deepEqual(ADAPTERS.pi.headless({ prompt: 'fix it' }), ['pi', '-p', 'fix it']);
  assert.deepEqual(ADAPTERS.opencode.headless({ prompt: 'fix it' }), ['opencode', 'run', 'fix it']);
  assert.deepEqual(ADAPTERS.gemini.headless({ prompt: 'fix it' }), ['gemini', '--approval-mode', 'auto_edit', '-p', 'fix it']);
  assert.deepEqual(
    ADAPTERS.codex.headless({ prompt: 'fix it', member: { model: 'o3', args: ['--search'] } }),
    ['codex', 'exec', '-s', 'workspace-write', '--model', 'o3', '--search', 'fix it'],
  );
});

test('interactive command applies autonomy, quoting and role options', () => {
  const command = ADAPTERS.codex.interactive({ member: { model: 'o 3', args: ['--profile', 'team profile'] } });
  assert.equal(command, "codex -s workspace-write -a never --model 'o 3' --profile 'team profile'");
  assert.equal(ADAPTERS.codex.interactive({ autonomy: 'full' }), 'codex --dangerously-bypass-approvals-and-sandbox');
  assert.equal(ADAPTERS.codex.interactive({ autonomy: 'ask' }), 'codex');
  assert.equal(ADAPTERS.agy.interactive({ autonomy: 'auto' }), 'agy --sandbox --dangerously-skip-permissions');
  assert.equal(ADAPTERS.gemini.interactive({ autonomy: 'full' }), 'gemini --yolo');
  assert.match(ADAPTERS.claude.interactive(), /--permission-mode auto/);
  assert.match(ADAPTERS.claude.interactive(), /'Bash\(mora:\*\)'/);
});

test('headless ask is promoted to auto and invalid autonomy is rejected', () => {
  assert.equal(autonomyFor({ member: { autonomy: 'ask' } }), 'ask');
  assert.equal(autonomyFor({ member: { autonomy: 'ask' }, headless: true }), 'auto');
  assert.deepEqual(
    ADAPTERS.codex.headless({ prompt: 'work', member: { autonomy: 'ask' } }),
    ['codex', 'exec', '-s', 'workspace-write', 'work'],
  );
  assert.throws(() => autonomyFor({ autonomy: 'invalid' }), (error) => error.code === 'BAD_AUTONOMY');
});

test('unknown CLI is a typed error', () => {
  assert.throws(() => getAdapter('missing'), (error) => error.code === 'UNKNOWN_CLI');
});

test('lead pane is reused only when the current agent matches the configured lead', () => {
  const cfg = { crew: { lead: { cli: 'claude' } } };
  assert.equal(isCurrentLead(cfg, { CLAUDECODE: '1' }), true);
  assert.equal(isCurrentLead(cfg, { CODEX_SESSION_ID: 'abc' }), false);
  assert.equal(isCurrentLead(cfg, { MORAGENT_ROLE: 'backend', CLAUDECODE: '1' }), false);
  assert.equal(isCurrentLead(cfg, { MORAGENT_ROLE: 'lead' }), true);
});

test('dispatch detects trust prompts in Orca before sending', () => {
  const mux = { name: 'orca', read: () => 'Codex startup\nDo you trust the files in this folder?' };
  assert.throws(
    () => assertPaneReady(mux, { handle: 'term-1' }, 'backend'),
    (error) => error.code === 'PANE_NOT_READY' && /backend/.test(error.hint),
  );
  const accepted = [
    'Do you trust the files in this folder?',
    'Accepted',
    'session ready',
    'workspace loaded',
    'model selected',
    'instructions loaded',
    'tools ready',
    'context ready',
    'waiting for input',
    '',
    '›',
  ].join('\n');
  assert.doesNotThrow(() => assertPaneReady({ name: 'orca', read: () => accepted }, { handle: 'term-2' }, 'frontend'));
  assert.doesNotThrow(() => assertPaneReady({ name: 'tmux' }, { handle: '%1' }, 'backend'));
});

test('plan estimates scope without assuming software roles', () => {
  const software = sizeIdea('Construir una API con interfaz web');
  const research = sizeIdea('Investigar fuentes, redactar un informe y revisar citas');
  assert.equal(software.size, 'M');
  assert.equal(research.size, 'M');
  assert.equal('roles' in software, false);
  assert.equal('roles' in research, false);
});

test('plan matches configured research capabilities without software roles', () => {
  const crew = {
    lead: { cli: 'claude' },
    investigador: { cli: 'codex', mission: 'Investiga fuentes', capabilities: ['investigar', 'fuentes'] },
    redactor: { cli: 'pi', mission: 'Redactar informe', capabilities: ['redactar', 'informe'] },
    revisor: { cli: 'claude', mission: 'Revisar citas', capabilities: ['revisar', 'citas'] },
  };
  assert.deepEqual(new Set(recommendRoles('Investigar fuentes y redactar un informe', crew, 'M').map((match) => match.role)), new Set(['investigador', 'redactor']));
  assert.deepEqual(recommendRoles('Diseñar un jardín', crew, 'M'), []);
  assert.equal(recommendRoles('Diseñar un jardín', defaultConfig({ project: 'garden' }).crew, 'M')[0].role, 'executor');
  assert.deepEqual(recommendRoles('Investigar fuentes', { researcher: { cli: 'missing', mission: 'Investigar fuentes' } }, 'S', ['codex']), []);
});

test('dispatch rejects a missing requested spec with a creation hint', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-missing-spec-'));
  await assert.rejects(
    dispatchCommand.run(
      { _: ['backend', 'implement it'], flags: { spec: 'Checkout Flow' } },
      { root, config: { lang: 'en', crew: { backend: { cli: 'codex' } } }, json: false },
    ),
    (error) => error.code === 'SPEC_NOT_FOUND' && error.hint === 'mora spec new checkout-flow',
  );
});

test('boolean CLI values are normalized without becoming roles', () => {
  assert.equal(flagOn(true), true);
  assert.equal(flagOn('true'), true);
  assert.equal(flagOn('false'), false);
  assert.equal(flagOn(false), false);
  assert.equal(flagOn(undefined), false);
});

test('crew add supports non-software roles while keeping existing crew', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-crew-role-'));
  try {
    scaffold(root, defaultConfig({ project: 'research', lang: 'es', preset: 'solo' }));
    const ctx = { root, json: false };
    await crewCommand.run({ _: ['add', 'investigador', 'codex'], flags: {
      mission: 'Investiga fuentes y registra hallazgos.', capabilities: 'investigacion,lectura,investigacion',
    } }, ctx);
    await crewCommand.run({ _: ['add', 'redactor', 'claude'], flags: {
      mission: 'Redacta el informe.', capabilities: 'escritura',
    } }, ctx);
    await crewCommand.run({ _: ['add', 'revisor', 'pi'], flags: {
      mission: 'Revisa evidencia y claridad.', capabilities: 'revision',
    } }, ctx);
    const saved = loadConfig(root);
    assert.equal(saved.crew.lead.cli, 'claude');
    assert.deepEqual(saved.crew.investigador, {
      cli: 'codex', title: 'investigador', mission: 'Investiga fuentes y registra hallazgos.',
      capabilities: ['investigacion', 'lectura'],
    });
    const workerRoles = Object.keys(saved.crew).filter((role) => role !== 'lead');
    const plan = normalizePlan({ tasks: [
      { id: 't1', role: 'investigador', prompt: 'Investigar fuentes' },
      { id: 't2', role: 'redactor', prompt: 'Redactar informe', dependsOn: ['t1'] },
      { id: 't3', role: 'revisor', prompt: 'Revisar informe', dependsOn: ['t2'] },
    ] }, { roles: workerRoles });
    assert.deepEqual(plan.tasks.map((task) => task.role), ['investigador', 'redactor', 'revisor']);
    assert.equal(normalizePlan({ tasks: [{ id: 't1', prompt: 'Investigar un archivo' }] }, { roles: ['investigador'] }).tasks[0].role, 'investigador');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('crew add rejects unsafe names, missing mission and duplicates without changing config', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-crew-invalid-'));
  try {
    scaffold(root, defaultConfig({ project: 'research', lang: 'en', preset: 'solo' }));
    const before = fs.readFileSync(path.join(root, '.moragent', 'moragent.json'), 'utf8');
    const add = (role, flags = { mission: 'Research' }) => crewCommand.run({ _: ['add', role, 'pi'], flags }, { root, json: false });
    for (const role of ['lead', 'constructor', '__proto__', '../escape', 'Upper']) {
      await assert.rejects(add(role), (error) => error.code === 'BAD_ROLE');
    }
    await assert.rejects(add('investigador', {}), (error) => error.code === 'MISSING_MISSION');
    await assert.rejects(add('investigador', { mission: 'Research', capabilities: 'valid,../unsafe' }), (error) => error.code === 'BAD_CAPABILITIES');
    await assert.rejects(crewCommand.run({ _: ['set', 'constructor', 'pi'], flags: {} }, { root, json: false }), (error) => error.code === 'UNKNOWN_ROLE');
    assert.equal(fs.readFileSync(path.join(root, '.moragent', 'moragent.json'), 'utf8'), before);
    await add('investigador');
    await assert.rejects(add('investigador'), (error) => error.code === 'ROLE_EXISTS');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
