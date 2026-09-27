import test from 'node:test';
import assert from 'node:assert/strict';
import { ADAPTERS, getAdapter } from '../src/crew/adapters.js';
import { isCurrentLead } from '../src/commands/up.js';

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
  assert.deepEqual(ADAPTERS.claude.headless({ prompt: 'fix it' }), ['claude', '-p', 'fix it', '--permission-mode', 'acceptEdits']);
  assert.deepEqual(ADAPTERS.codex.headless({ prompt: 'fix it' }), ['codex', 'exec', '-s', 'workspace-write', 'fix it']);
  assert.deepEqual(ADAPTERS.agy.headless({ prompt: 'fix it' }), ['agy', '-p', 'fix it', '--dangerously-skip-permissions']);
  assert.deepEqual(ADAPTERS.pi.headless({ prompt: 'fix it' }), ['pi', '-p', 'fix it']);
  assert.deepEqual(ADAPTERS.opencode.headless({ prompt: 'fix it' }), ['opencode', 'run', 'fix it']);
  assert.deepEqual(ADAPTERS.gemini.headless({ prompt: 'fix it' }), ['gemini', '-p', 'fix it', '--yolo']);
  assert.deepEqual(
    ADAPTERS.codex.headless({ prompt: 'fix it', member: { model: 'o3', args: ['--search'] } }),
    ['codex', 'exec', '-s', 'workspace-write', '--model', 'o3', '--search', 'fix it'],
  );
});

test('interactive command quotes paths and applies role options', () => {
  const command = ADAPTERS.codex.interactive({ member: { model: 'o 3', args: ['--profile', 'team profile'] } });
  assert.equal(command, "codex -s workspace-write -a never --model 'o 3' --profile 'team profile'");
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
