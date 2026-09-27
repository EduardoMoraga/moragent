import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ADAPTERS, autonomyFor, getAdapter } from '../src/crew/adapters.js';
import { flagOn, isCurrentLead } from '../src/commands/up.js';
import dispatchCommand, { assertPaneReady } from '../src/commands/dispatch.js';
import { sizeIdea } from '../src/commands/plan.js';

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

test('plan preset contains and agrees with all three recommended roles', () => {
  const estimate = sizeIdea('Construir una API con interfaz web');
  assert.equal(estimate.preset, 'trio');
  assert.deepEqual(estimate.roles, ['lead', 'backend', 'frontend']);
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
