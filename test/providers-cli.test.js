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
import { resetSpawn, runStream, setSpawn } from '../src/providers/cli/stream.js';

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
    assert.deepEqual(
      events.filter((event) => event.type === 'tool_result').map((event) => event.ok),
      [true, false],
    );
    if (id === 'codex') {
      assert.equal(events.some((event) => event.type === 'text' && event.delta.includes('Misión del rol')), false);
    }
  });
}

test('codex keeps the final completed message as its task summary', async () => {
  const records = [
    { type: 'thread.started', thread_id: 'thread-1' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'I will inspect the file.' } },
    { type: 'item.completed', item: { type: 'command_execution', command: 'ls', status: 'completed', aggregated_output: 'hello.txt' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Verified hello.txt.' } },
    { type: 'turn.completed', usage: {} },
  ];
  setSpawn(fakeProcess(records.map((record) => JSON.stringify(record)).join('\n') + '\n'));
  const events = [];
  const result = await PROVIDERS.codex.run({ root: process.cwd(), prompt: 'verify', onEvent: (event) => events.push(event) });
  assert.equal(result.text, 'Verified hello.txt.');
  assert.deepEqual(events.filter((event) => event.type === 'text').map((event) => event.delta), ['I will inspect the file.', '\n\nVerified hello.txt.']);
});

test('Codex reasoning alone or a missing turn completion cannot be a successful answer', async () => {
  const records = [
    { type: 'thread.started', thread_id: 'thread-incomplete' },
    { type: 'item.completed', item: { type: 'reasoning', text: 'Drafting a plan...' } },
  ];
  for (const tail of [
    [{ type: 'turn.completed', usage: {} }],
    [{ type: 'item.completed', item: { type: 'agent_message', text: 'Final answer.' } }],
  ]) {
    setSpawn(fakeProcess([...records, ...tail].map((record) => JSON.stringify(record)).join('\n') + '\n'));
    const result = await PROVIDERS.codex.run({ root: process.cwd(), prompt: 'answer' });
    assert.equal(result.ok, false);
    assert.match(result.error, /respuesta final|final answer|confirmar el turno|completion/);
  }
});

test('verified subscription CLIs require their terminal result marker', async () => {
  const cases = [
    ['claude', { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }],
    ['codex', { type: 'item.completed', item: { type: 'agent_message', text: 'partial' } }],
    ['agy', { event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'partial' } }],
    ['pi', { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial' } }],
  ];
  for (const [id, record] of cases) {
    setSpawn(fakeProcess(`${JSON.stringify(record)}\n`));
    const result = await PROVIDERS[id].run({ root: process.cwd(), prompt: 'answer' });
    assert.equal(result.ok, false, id);
    assert.match(result.error, /confirmar el turno|completion/);
  }
});

test('Pi reports assistant stop errors even when the CLI exits zero or emitted earlier text', async () => {
  for (const priorText of ['', 'Draft answer that must not count as success.']) {
    const failure = { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'Model is not supported for this account.' };
    const records = [
      { type: 'session', id: 'pi-failed-session' },
      ...(priorText ? [{ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: priorText } }] : []),
      { type: 'message_end', message: failure },
      { type: 'turn_end', message: failure },
      { type: 'agent_end', messages: [failure], willRetry: false },
    ];
    setSpawn(fakeProcess(records.map((record) => JSON.stringify(record)).join('\n') + '\n', {
      stderr: 'Warning: using a custom model id.',
    }));
    const events = [];
    const result = await PROVIDERS.pi.run({ root: process.cwd(), prompt: 'answer', onEvent: (event) => events.push(event) });
    assert.equal(result.ok, false);
    assert.match(result.error, /Model is not supported for this account/);
    assert.equal(events.at(-1).type, 'done');
    assert.equal(events.at(-1).ok, false);
  }
});

test('Pi rejects a truncated final turn but accepts a later completed retry', async () => {
  const truncated = { role: 'assistant', content: [{ type: 'text', text: 'Partial' }], stopReason: 'length' };
  const completed = { role: 'assistant', content: [{ type: 'text', text: 'Complete' }], stopReason: 'stop' };
  const run = async (messages) => {
    const records = [
      { type: 'session', id: 'pi-retry-session' },
      ...messages.map((message) => ({ type: 'message_end', message })),
      { type: 'agent_end', messages },
    ];
    setSpawn(fakeProcess(records.map((record) => JSON.stringify(record)).join('\n') + '\n'));
    return PROVIDERS.pi.run({ root: process.cwd(), prompt: 'answer' });
  };
  const failed = await run([truncated]);
  assert.equal(failed.ok, false);
  assert.match(failed.error, /length/);
  const recovered = await run([truncated, completed]);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.text, 'Complete');
});

test('OpenCode accepts only a final stop marker, not a truncated or tool-only step', async () => {
  const start = { type: 'step_start', sessionID: 'ses-test', part: { type: 'step-start', sessionID: 'ses-test' } };
  const answer = { type: 'text', sessionID: 'ses-test', part: { type: 'text', text: 'partial answer' } };
  const finish = (reason) => ({ type: 'step_finish', sessionID: 'ses-test', part: { type: 'step-finish', reason, tokens: { input: 10, output: 2 } } });
  for (const tail of [[], [finish('tool-calls')], [finish('length')]]) {
    setSpawn(fakeProcess([start, answer, ...tail].map((record) => JSON.stringify(record)).join('\n') + '\n'));
    const result = await PROVIDERS.opencode.run({ root: process.cwd(), prompt: 'answer' });
    assert.equal(result.ok, false);
  }
  setSpawn(fakeProcess([start, answer, finish('stop')].map((record) => JSON.stringify(record)).join('\n') + '\n'));
  const result = await PROVIDERS.opencode.run({ root: process.cwd(), prompt: 'answer' });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'partial answer');
  assert.equal(result.sessionId, 'ses-test');
  assert.deepEqual(result.usage, { input: 10, output: 2, costUsd: null });
});

test('OpenCode separates text from distinct assistant messages without splitting one message', async () => {
  const records = [
    { type: 'text', part: { type: 'text', messageID: 'first', text: 'I will read the file.' } },
    { type: 'step_finish', part: { type: 'step-finish', reason: 'tool-calls' } },
    { type: 'text', part: { type: 'text', messageID: 'second', text: 'The file says ' } },
    { type: 'text', part: { type: 'text', messageID: 'second', text: 'HELLO.' } },
    { type: 'step_finish', part: { type: 'step-finish', reason: 'stop' } },
  ];
  setSpawn(fakeProcess(records.map((record) => JSON.stringify(record)).join('\n') + '\n'));
  const result = await PROVIDERS.opencode.run({ root: process.cwd(), prompt: 'read' });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'I will read the file.\n\nThe file says HELLO.');
});

test('OpenCode pins its project directory instead of inheriting the parent shell PWD', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-opencode-root-'));
  const calls = [];
  const records = [
    { type: 'step_start', sessionID: 'ses-root', part: { type: 'step-start', sessionID: 'ses-root' } },
    { type: 'text', sessionID: 'ses-root', part: { type: 'text', text: 'ok' } },
    { type: 'step_finish', sessionID: 'ses-root', part: { type: 'step-finish', reason: 'stop' } },
  ];
  try {
    setSpawn(fakeProcess(records.map((record) => JSON.stringify(record)).join('\n') + '\n', { calls }));
    assert.equal((await PROVIDERS.opencode.run({ root, prompt: 'ok' })).ok, true);
    const { args, options } = calls[0];
    assert.equal(options.cwd, root);
    assert.equal(options.env.PWD, root);
    assert.equal(args[args.indexOf('--dir') + 1], root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('OpenCode readonly mode passes an explicit deny policy for writes and shell commands', async () => {
  const calls = [];
  const records = [
    { type: 'step_start', sessionID: 'ses-readonly', part: { type: 'step-start' } },
    { type: 'text', part: { type: 'text', text: 'Read-only.' } },
    { type: 'step_finish', part: { type: 'step-finish', reason: 'stop' } },
  ];
  setSpawn(fakeProcess(records.map((record) => JSON.stringify(record)).join('\n') + '\n', { calls }));
  assert.equal((await PROVIDERS.opencode.run({ root: process.cwd(), prompt: 'inspect', autonomy: 'readonly' })).ok, true);
  const permission = JSON.parse(calls[0].options.env.OPENCODE_PERMISSION);
  assert.equal(permission['*'], 'deny');
  assert.equal(permission.edit, 'deny');
  assert.equal(permission.bash, 'deny');
  assert.equal(permission.external_directory, 'deny');
  assert.equal(permission.read['*.env'], 'deny');
});

test('OpenCode surfaces nested tool input and a failed tool status accurately', async () => {
  const records = [
    { type: 'step_start', sessionID: 'ses-tools', part: { type: 'step-start', sessionID: 'ses-tools' } },
    { type: 'tool', part: { type: 'tool', callID: 'write-1', tool: 'write', state: { status: 'completed', input: { filePath: 'ok.txt' }, output: 'Wrote file successfully.' } } },
    { type: 'tool', part: { type: 'tool', callID: 'write-2', tool: 'write', state: { status: 'error', input: { filePath: 'bad.txt' }, error: 'permission denied' } } },
    { type: 'text', part: { type: 'text', text: 'Done.' } },
    { type: 'step_finish', part: { type: 'step-finish', reason: 'stop' } },
  ];
  setSpawn(fakeProcess(records.map((record) => JSON.stringify(record)).join('\n') + '\n'));
  const events = [];
  await PROVIDERS.opencode.run({ root: process.cwd(), prompt: 'write', onEvent: (event) => events.push(event) });
  assert.deepEqual(events.filter((event) => event.type === 'tool').map((event) => event.input.filePath), ['ok.txt', 'bad.txt']);
  assert.deepEqual(events.filter((event) => event.type === 'tool_result').map((event) => event.ok), [true, false]);
  assert.equal(events.find((event) => event.type === 'tool_result').summary, 'Wrote file successfully.');
});

test('OpenCode reports provider errors without dumping response headers', async () => {
  const records = [
    { type: 'error', properties: { error: { name: 'APIError', data: {
      message: "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode",
      statusCode: 403, responseHeaders: { 'set-cookie': 'private-token' },
    } } } },
    { type: 'error', properties: { error: { name: 'APIError', data: {
      message: "The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account.",
      statusCode: 400, responseHeaders: { authorization: 'private-token' },
    } } } },
  ];
  for (const [index, expected] of ['HTTP 403: Error from provider (Console): OpenCode\'s free tier can only be used from within OpenCode',
    "HTTP 400: The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account."].entries()) {
    setSpawn(fakeProcess(JSON.stringify(records[index]) + '\n'));
    const result = await PROVIDERS.opencode.run({ root: process.cwd(), prompt: 'test' });
    assert.equal(result.ok, false);
    assert.equal(result.error, expected);
    assert.doesNotMatch(result.error, /responseHeaders|private-token/);
  }
});

test('stream preserves UTF-8 characters split between stdout chunks', async () => {
  const raw = Buffer.from([
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-utf8' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Español: acción' } }),
    JSON.stringify({ type: 'turn.completed', usage: {} }),
  ].join('\n') + '\n', 'utf8');
  const split = raw.indexOf(Buffer.from('ñ', 'utf8')) + 1;
  setSpawn(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.emit('data', raw.subarray(0, split));
      child.stdout.emit('data', raw.subarray(split));
      child.emit('close', 0);
    });
    return child;
  });
  const result = await PROVIDERS.codex.run({ root: process.cwd(), prompt: 'Responde en español' });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'Español: acción');
});

test('stream preserves UTF-8 diagnostics split between stderr chunks', async () => {
  const raw = Buffer.from('Error: acción', 'utf8');
  const split = raw.indexOf(Buffer.from('ó', 'utf8')) + 1;
  setSpawn(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stderr.emit('data', raw.subarray(0, split));
      child.stderr.emit('data', raw.subarray(split));
      child.emit('close', 1);
    });
    return child;
  });
  const result = await PROVIDERS.codex.run({ root: process.cwd(), prompt: 'test' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Error: acción');
});

test('stream fails explicitly when a JSONL record exceeds its memory limit', async () => {
  const calls = [];
  setSpawn(fakeProcess('x'.repeat(128), { calls }));
  const events = [];
  const result = await runStream({
    provider: 'test', command: 'fake', args: [], root: process.cwd(),
    parser: () => [], maxLineChars: 64, onEvent: (event) => events.push(event),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /exceeded|excedió/i);
  assert.equal(calls[0].child.killedByTest, true);
  assert.equal(events.filter((event) => event.type === 'done').length, 1);
});

test('runner ignores malformed JSON, closes stdin, logs raw output and keeps done last', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-provider-log-'));
  const previousUmask = process.umask(0o022);
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
    if (process.platform !== 'win32') assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);
  } finally {
    process.umask(previousUmask);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI raw logs retain the most recent bytes within their configured cap', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-provider-bounded-log-'));
  const logFile = path.join(root, 'raw.log');
  const raw = fs.readFileSync(new URL('codex.jsonl', fixtures), 'utf8');
  setSpawn(fakeProcess(raw, { stderr: 'RECENT-DIAGNOSTIC-'.repeat(40) }));
  try {
    const result = await PROVIDERS.codex.run({ root, prompt: 'ok', logFile, maxLogBytes: 256 });
    assert.equal(result.ok, true);
    const log = fs.readFileSync(logFile, 'utf8');
    assert.ok(Buffer.byteLength(log) <= 256);
    assert.match(log, /earlier log data omitted/);
    assert.match(log, /RECENT-DIAGNOSTIC/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('optional CLI log write failure does not crash a successful provider run', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-provider-bad-log-'));
  const raw = fs.readFileSync(new URL('codex.jsonl', fixtures), 'utf8');
  setSpawn(fakeProcess(raw));
  try {
    const result = await PROVIDERS.codex.run({ root, prompt: 'ok', logFile: root });
    assert.equal(result.ok, true);
    assert.equal(result.text.trim(), 'ok');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a CLI that exits zero without assistant text is not a successful run', async () => {
  for (const raw of ['', [
    JSON.stringify({ type: 'thread.started', thread_id: 'silent' }),
    JSON.stringify({ type: 'turn.completed', usage: {} }),
  ].join('\n')]) {
    setSpawn(fakeProcess(raw));
    const events = [];
    const result = await PROVIDERS.codex.run({ root: process.cwd(), prompt: 'answer', onEvent: (event) => events.push(event) });
    assert.equal(result.ok, false);
    assert.match(result.error, /respuesta final|final answer/);
    assert.equal(events.filter((event) => event.type === 'done').length, 1);
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

test('stream cancellation stops a real CLI child process tree', { skip: process.platform === 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-cli-cancel-'));
  const controller = new AbortController();
  const events = [];
  try {
    const started = Date.now();
    const pending = runStream({
      provider: 'test', command: 'bash', args: ['-c', 'sleep 1 && printf orphan > marker.txt & wait'],
      root, signal: controller.signal, onEvent: (event) => events.push(event), parser: () => [],
    });
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.ok(Date.now() - started < 900, 'cancellation must not wait for the descendant');
    assert.equal(events.filter((event) => event.type === 'done').length, 1);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(fs.existsSync(path.join(root, 'marker.txt')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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

test('subscription status awaits an asynchronous auth probe', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-async-status-'));
  const previousPath = process.env.PATH;
  try {
    const bin = path.join(root, process.platform === 'win32' ? 'claude.cmd' : 'claude');
    fs.writeFileSync(bin, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n');
    if (process.platform !== 'win32') fs.chmodSync(bin, 0o755);
    process.env.PATH = root;
    setExec(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { code: 0, stdout: '{"loggedIn":true}', stderr: '' };
    });
    assert.equal((await PROVIDERS.claude.status()).ready, true);
    setExec(() => ({ code: 124, stdout: '{"loggedIn":true}', stderr: 'Timed out' }));
    const timedOut = await PROVIDERS.claude.status();
    assert.equal(timedOut.ready, false);
    assert.match(timedOut.detail, /tiempo|timed out/);
  } finally {
    process.env.PATH = previousPath;
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
  for (const id of ['anthropic', 'openai', 'openrouter', 'ollama', 'google', 'compatible']) {
    assert.equal(getProvider(id).kind, 'api');
  }
  assert.equal(listProviders().length, Object.keys(PROVIDERS).length);
  assert.throws(() => getProvider('missing'), (error) => error.code === 'UNKNOWN_PROVIDER');
});
