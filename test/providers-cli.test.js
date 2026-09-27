import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetExec, setExec } from '../src/core/exec.js';
import { getLang, setLang } from '../src/core/i18n.js';
import { autonomyArgsFor } from '../src/crew/adapters.js';
import { PROVIDERS, getProvider, listProviders } from '../src/providers/index.js';
import { loginCommand as claudeLogin } from '../src/providers/cli/claude.js';
import { loginCommand as codexLogin } from '../src/providers/cli/codex.js';
import { loginCommand as agyLogin } from '../src/providers/cli/agy.js';
import { loginCommand as piLogin } from '../src/providers/cli/pi.js';
import { loginCommand as geminiLogin } from '../src/providers/cli/gemini.js';
import { loginCommand as openCodeLogin } from '../src/providers/cli/opencode.js';
import { resetSpawn, setSpawn } from '../src/providers/cli/stream.js';

const fixtures = new URL('./fixtures/streams/', import.meta.url);

afterEach(() => {
  resetSpawn();
  resetExec();
});

function fakeProcess(stdout = '', { code = 0, stderr = '', waitForKill = false, calls = [] } = {}) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killedByTest = false;
    child.kill = () => {
      child.killedByTest = true;
      queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
      return true;
    };
    calls.push({ command, args, options, child });
    queueMicrotask(() => {
      if (waitForKill || child.killedByTest) return;
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code);
    });
    return child;
  };
}

for (const id of ['claude', 'codex', 'agy', 'pi']) {
  test(`${id}: normalizes its real stream fixture`, async () => {
    const raw = fs.readFileSync(new URL(`${id}.jsonl`, fixtures), 'utf8');
    setSpawn(fakeProcess(raw));
    const events = [];
    const result = await PROVIDERS[id].run({
      root: process.cwd(), prompt: 'Responde solo: ok', onEvent: (event) => events.push(event),
    });

    assert.equal(result.ok, true);
    assert.equal(result.text.trim(), 'ok');
    assert.ok(result.sessionId);
    assert.equal(events[0].type, 'start');
    assert.equal(events.at(-1).type, 'done');
    assert.equal(events.filter((event) => event.type === 'start').length, 1);
    assert.equal(events.filter((event) => event.type === 'done').length, 1);
    assert.ok(events.some((event) => event.type === 'text' && event.delta.includes('ok')));
    assert.ok(events.some((event) => event.type === 'usage'));
  });
}

test('runner ignores malformed JSON, closes stdin, logs raw output and keeps done last', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-provider-log-'));
  const logFile = path.join(root, 'raw.log');
  const calls = [];
  const fixture = fs.readFileSync(new URL('codex.jsonl', fixtures), 'utf8');
  setSpawn(fakeProcess(`not-json\n${fixture}`, { stderr: 'diagnostic\n', calls }));
  const events = [];
  try {
    const result = await PROVIDERS.codex.run({
      root, prompt: 'ok', logFile, onEvent: (event) => events.push(event),
    });
    assert.equal(result.ok, true);
    assert.equal(events.at(-1).type, 'done');
    assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.ok(calls[0].options.env.MORAGENT_ROLE);
    const log = fs.readFileSync(logFile, 'utf8');
    assert.ok(log.includes('not-json'));
    assert.ok(log.includes('diagnostic'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('abort kills the child and resolves as a failed run with one done event', async () => {
  const calls = [];
  setSpawn(fakeProcess('', { waitForKill: true, calls }));
  const controller = new AbortController();
  const events = [];
  const pending = PROVIDERS.codex.run({
    root: process.cwd(), prompt: 'wait', signal: controller.signal,
    onEvent: (event) => events.push(event),
  });
  controller.abort();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(calls[0].child.killedByTest, true);
  assert.equal(events.filter((event) => event.type === 'done').length, 1);
  assert.equal(events.at(-1).type, 'done');
});

test('spawn failure resolves ready-to-render start/done events instead of throwing', async () => {
  setSpawn(() => { throw Object.assign(new Error('spawn missing ENOENT'), { code: 'ENOENT' }); });
  const events = [];
  const result = await PROVIDERS.gemini.run({
    root: process.cwd(), prompt: 'ok', onEvent: (event) => events.push(event),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /ENOENT/);
  assert.deepEqual(events.map((event) => event.type), ['start', 'done']);
});

test('tool calls and results map to bounded normalized events', async () => {
  const oversized = 'x'.repeat(260);
  const stream = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'm1' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'a.js' } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: oversized }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's1' }),
  ].join('\n');
  setSpawn(fakeProcess(stream));
  const events = [];
  await PROVIDERS.claude.run({ root: process.cwd(), prompt: 'ok', onEvent: (event) => events.push(event) });
  const tool = events.find((event) => event.type === 'tool');
  const toolResult = events.find((event) => event.type === 'tool_result');
  assert.deepEqual(tool, { type: 'tool', id: 'tool-1', name: 'Read', input: { file_path: 'a.js' } });
  assert.equal(toolResult.id, 'tool-1');
  assert.equal(toolResult.ok, true);
  assert.equal(toolResult.summary.length, 200);
});

test('status for an absent CLI is fast, never throws and includes a login/install hint', async () => {
  const originalPath = process.env.PATH;
  const originalLang = getLang();
  process.env.PATH = '';
  try {
    setLang('es');
    const es = await PROVIDERS.gemini.status();
    assert.equal(es.ready, false);
    assert.equal(es.detail, 'gemini no está instalado.');
    assert.equal(es.loginHint, 'npm install -g @google/gemini-cli');
    setLang('en');
    const en = await PROVIDERS.gemini.status();
    assert.equal(en.detail, 'gemini is not installed.');
    assert.equal(en.loginHint, 'npm install -g @google/gemini-cli');
  } finally {
    setLang(originalLang);
    process.env.PATH = originalPath;
  }
});

test('status is bilingual and uses verified login commands with a three-second timeout', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-provider-status-'));
  const originalPath = process.env.PATH;
  const originalLang = getLang();
  const calls = [];
  try {
    for (const id of ['claude', 'codex', 'agy', 'pi', 'gemini', 'opencode']) {
      // which() needs a PATHEXT extension on Windows.
      const bin = path.join(root, process.platform === 'win32' ? `${id}.cmd` : id);
      fs.writeFileSync(bin, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n');
      if (process.platform !== 'win32') fs.chmodSync(bin, 0o755);
    }
    process.env.PATH = root;
    setExec((command, args, options) => {
      calls.push({ command, args, options });
      if (command === 'claude') return { code: 0, stdout: '{"loggedIn":true}', stderr: '' };
      if (command === 'codex') return { code: 0, stdout: 'Logged in using ChatGPT', stderr: '' };
      if (command === 'pi') return { code: 0, stdout: '{"status":"ready"}', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const hints = {
      claude: 'claude auth login',
      codex: 'codex login',
      agy: 'agy',
      pi: 'pi',
      gemini: 'gemini',
      opencode: 'opencode auth login',
    };
    setLang('es');
    for (const id of Object.keys(hints)) {
      const status = await PROVIDERS[id].status();
      assert.equal(status.ready, true);
      assert.match(status.detail, /está instalado/);
      assert.equal(status.loginHint, hints[id]);
    }
    setLang('en');
    for (const id of Object.keys(hints)) {
      const status = await PROVIDERS[id].status();
      assert.equal(status.ready, true);
      assert.match(status.detail, /is installed/);
      assert.equal(status.loginHint, hints[id]);
    }
    assert.deepEqual(calls.find((call) => call.command === 'claude').args, ['auth', 'status']);
    assert.deepEqual(calls.find((call) => call.command === 'codex').args, ['login', 'status']);
    assert.deepEqual(calls.find((call) => call.command === 'pi').args, ['auth', 'check', '--provider', 'openai-codex', '--json', '--no-refresh']);
    assert.ok(calls.every((call) => call.options.timeoutMs === 3000));
  } finally {
    setLang(originalLang);
    process.env.PATH = originalPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('every subscription provider exports an executable login argv', () => {
  const expected = {
    claude: ['claude', 'auth', 'login'],
    codex: ['codex', 'login'],
    agy: ['agy'],
    pi: ['pi'],
    gemini: ['gemini'],
    opencode: ['opencode', 'auth', 'login'],
  };
  const named = {
    claude: claudeLogin,
    codex: codexLogin,
    agy: agyLogin,
    pi: piLogin,
    gemini: geminiLogin,
    opencode: openCodeLogin,
  };
  for (const [id, argv] of Object.entries(expected)) {
    assert.deepEqual(named[id], argv);
    assert.equal(PROVIDERS[id].loginCommand, named[id]);
    assert.ok(argv.every((part) => typeof part === 'string' && part.length));
  }
});

test('readonly autonomy is centralized for every specified subscription CLI', () => {
  assert.deepEqual(autonomyArgsFor('claude', { autonomy: 'readonly' }, true), ['--permission-mode', 'plan']);
  assert.deepEqual(autonomyArgsFor('codex', { autonomy: 'readonly' }, true), ['-s', 'read-only']);
  assert.deepEqual(autonomyArgsFor('agy', { autonomy: 'readonly' }, true), ['--mode', 'plan']);
  assert.deepEqual(autonomyArgsFor('pi', { autonomy: 'readonly' }, true), ['--tools', 'read,grep,find,ls']);
  assert.deepEqual(autonomyArgsFor('gemini', { autonomy: 'readonly' }, true), ['--approval-mode', 'plan']);
});

test('resume flags and readonly flags are passed to each verified CLI', async () => {
  const cases = [
    ['claude', ['--resume', 'session-1'], ['--permission-mode', 'plan']],
    ['codex', ['resume'], ['-s', 'read-only']],
    ['agy', ['--conversation', 'session-1'], ['--mode', 'plan']],
    ['pi', ['--session', 'session-1'], ['--tools', 'read,grep,find,ls']],
  ];
  for (const [id, resume, readonly] of cases) {
    const calls = [];
    setSpawn(fakeProcess('', { calls }));
    await PROVIDERS[id].run({
      root: process.cwd(), prompt: 'ok', sessionId: 'session-1', autonomy: 'readonly',
    });
    for (const part of [...resume, ...readonly]) assert.ok(calls[0].args.includes(part), `${id} missing ${part}`);
  }
});

test('provider registry exposes subscriptions and dynamically integrated APIs', () => {
  for (const id of ['claude', 'codex', 'agy', 'pi', 'gemini', 'opencode']) {
    assert.equal(getProvider(id).kind, 'subscription');
  }
  for (const id of ['anthropic', 'openai', 'openrouter', 'ollama', 'google']) {
    assert.equal(getProvider(id).kind, 'api');
  }
  assert.equal(listProviders().length, Object.keys(PROVIDERS).length);
  assert.throws(() => getProvider('missing'), (error) => error.code === 'UNKNOWN_PROVIDER');
});
