import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  getKey,
  setKey,
  setEndpoint,
  removeKey,
  listKeys,
  maskKey,
  getCredentialsPath,
} from '../src/providers/credentials.js';

import {
  executeTool,
  assertPathInside,
  truncateOutput,
  MAX_OUTPUT_BYTES,
  getAnthropicTools,
  getOpenAITools,
  getGeminiTools,
} from '../src/providers/api/tools.js';

import {
  setFetch,
  resetFetch,
  runApiLoop,
} from '../src/providers/api/loop.js';

import { anthropic, anthropicAdapter } from '../src/providers/api/anthropic.js';
import { openai, openaiAdapter } from '../src/providers/api/openai.js';
import { openrouter } from '../src/providers/api/openrouter.js';
import { ollama } from '../src/providers/api/ollama.js';
import { google, googleAdapter } from '../src/providers/api/google.js';
import { resetApiModelCache } from '../src/providers/api/models.js';
import { getLang, setLang } from '../src/core/i18n.js';

test('API adapters omit tool declarations for a tool-free recovery turn', async () => {
  const cases = [
    [openaiAdapter, { choices: [{ message: { role: 'assistant', content: 'ready' } }] }],
    [anthropicAdapter, { content: [{ type: 'text', text: 'ready' }] }],
    [googleAdapter, { candidates: [{ content: { role: 'model', parts: [{ text: 'ready' }] } }] }],
  ];
  try {
    for (const [adapter, response] of cases) {
      let body;
      setFetch(async (_url, options) => {
        body = JSON.parse(options.body);
        return { ok: true, json: async () => response };
      });
      const result = await runApiLoop({ providerId: adapter.id, adapter, root: os.tmpdir(), prompt: 'Reply ready', apiKey: 'test-key', autonomy: 'readonly', toolsEnabled: false });
      assert.equal(result.ok, true, adapter.id);
      assert.equal(Object.hasOwn(body, 'tools'), false, `${adapter.id}: tool declarations must be absent`);
    }
  } finally { resetFetch(); }
});

test('API event logs are private even with a permissive process umask', { skip: process.platform === 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-api-private-log-'));
  const previousUmask = process.umask(0o022);
  try {
    setFetch(async () => ({ ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: 'done' } }] }) }));
    const logFile = path.join(root, 'events.log');
    const result = await runApiLoop({ providerId: 'openai', adapter: openaiAdapter, root, prompt: 'Reply done', apiKey: 'test-key', logFile, toolsEnabled: false });
    assert.equal(result.ok, true);
    assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);
  } finally {
    process.umask(previousUmask);
    resetFetch();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('API event logs stay within the configured byte cap and retain their latest event', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-api-bounded-log-'));
  try {
    setFetch(async () => ({ ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: 'X'.repeat(512) } }] }) }));
    const logFile = path.join(root, 'events.log');
    const result = await runApiLoop({ providerId: 'openai', adapter: openaiAdapter, root, prompt: 'Reply', apiKey: 'test-key', logFile, maxLogBytes: 256, toolsEnabled: false });
    assert.equal(result.ok, true);
    const log = fs.readFileSync(logFile, 'utf8');
    assert.ok(Buffer.byteLength(log) <= 256);
    assert.match(log, /earlier log data omitted/);
    assert.match(log, /"type":"done"/);
    for (const line of log.split('\n').filter((entry) => entry.startsWith('{'))) assert.doesNotThrow(() => JSON.parse(line));
  } finally {
    resetFetch();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a tool call returned during a tool-free API turn is rejected before execution', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-no-tools-'));
  try {
    setFetch(async () => ({ ok: true, json: async () => ({ choices: [{ message: {
      role: 'assistant', content: '', tool_calls: [{ id: 'unexpected', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'unsafe.txt', content: 'unsafe' }) } }],
    } }] }) }));
    const result = await runApiLoop({ providerId: 'openai', adapter: openaiAdapter, root, prompt: 'Do not call tools', apiKey: 'test-key', autonomy: 'readonly', toolsEnabled: false });
    assert.equal(result.ok, false);
    assert.match(result.error, /tools were disabled|herramientas estaban desactivadas/);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    resetFetch();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('API loop does not report success for an empty model response', async () => {
  const providers = [
    [openai, { choices: [] }],
    [anthropic, { content: [] }],
    [google, { candidates: [] }],
    [openai, { error: { message: 'model unavailable' } }],
    [google, { promptFeedback: { blockReason: 'SAFETY' }, candidates: [] }],
  ];
  try {
    for (const [provider, response] of providers) {
      const events = [];
      setFetch(async () => ({ ok: true, status: 200, json: async () => response }));
      const result = await provider.run({
        root: os.tmpdir(), prompt: 'Say hello', apiKey: 'test-key',
        onEvent: (event) => events.push(event),
      });
      assert.equal(result.ok, false, provider.id);
      assert.match(result.error, /texto ni herramientas|neither text nor tools/);
      if (response.error) assert.match(result.error, /model unavailable/);
      if (response.promptFeedback) assert.match(result.error, /SAFETY/);
      assert.equal(events.filter((event) => event.type === 'done').length, 1);
      assert.equal(events.at(-1).ok, false);
    }
  } finally {
    resetFetch();
  }
});

test('API loop rejects text stopped by a token limit or response filter', async () => {
  const cases = [
    [openai, { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'Partial answer' } }], usage: { prompt_tokens: 7, completion_tokens: 9 } }, 'length'],
    [openai, { choices: [{ finish_reason: 'content_filter', message: { role: 'assistant', content: 'Partial answer' } }] }, 'content_filter'],
    [openai, { choices: [{ finish_reason: 'upstream_error', message: { role: 'assistant', content: 'Partial answer' } }] }, 'upstream_error'],
    [anthropic, { stop_reason: 'max_tokens', content: [{ type: 'text', text: 'Partial answer' }] }, 'max_tokens'],
    [anthropic, { stop_reason: 'upstream_error', content: [{ type: 'text', text: 'Partial answer' }] }, 'upstream_error'],
    [anthropic, { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Partial answer' }] }, 'tool_use'],
    [openai, { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: 'Partial answer' } }] }, 'tool_calls'],
    [google, { candidates: [{ finishReason: 'MAX_TOKENS', content: { role: 'model', parts: [{ text: 'Partial answer' }] } }] }, 'MAX_TOKENS'],
    [google, { candidates: [{ finishReason: 'SAFETY', content: { role: 'model', parts: [{ text: 'Partial answer' }] } }] }, 'SAFETY'],
  ];
  try {
    for (const [provider, response, reason] of cases) {
      const events = [];
      setFetch(async () => ({ ok: true, status: 200, json: async () => response }));
      const result = await provider.run({ root: os.tmpdir(), prompt: 'Finish the task', apiKey: 'test-key', onEvent: (event) => events.push(event) });
      assert.equal(result.ok, false, `${provider.id}: ${reason}`);
      assert.match(result.error, new RegExp(reason));
      if (provider.id === 'openai' && reason === 'length') assert.deepEqual(result.usage, { input: 7, output: 9, costUsd: null });
      assert.equal(events.at(-1).type, 'done');
      assert.equal(events.at(-1).ok, false);
    }
  } finally {
    resetFetch();
  }
});

test('API loop never executes a tool from a truncated response', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-truncated-tool-'));
  try {
    setFetch(async () => ({
      ok: true, status: 200,
      json: async () => ({ choices: [{ finish_reason: 'length', message: {
        role: 'assistant', content: 'Starting a file',
        tool_calls: [{ id: 'partial_write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'should-not-exist.txt', content: 'partial' }) } }],
      } }] }),
    }));
    const result = await openai.run({ root, prompt: 'Create a file', apiKey: 'test-key', autonomy: 'auto' });
    assert.equal(result.ok, false);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    resetFetch();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('OpenAI-compatible loop never executes tools under an unknown explicit finish reason', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-unknown-finish-'));
  try {
    setFetch(async () => ({
      ok: true, status: 200,
      json: async () => ({ choices: [{ finish_reason: 'upstream_error', message: {
        role: 'assistant', content: 'Writing',
        tool_calls: [{ id: 'write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'should-not-exist.txt', content: 'partial' }) } }],
      } }] }),
    }));
    const result = await openai.run({ root, prompt: 'Create a file', apiKey: 'test-key', autonomy: 'auto' });
    assert.equal(result.ok, false);
    assert.match(result.error, /upstream_error/);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    resetFetch();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Gemini omits a function-response ID when the server supplied no call ID', () => {
  const state = googleAdapter.initConversation({ prompt: 'Read a file' });
  const parsed = googleAdapter.parseResponse({ candidates: [{ content: { role: 'model', parts: [
    { functionCall: { name: 'read_file', args: { path: 'note.txt' } } },
  ] }, finishReason: 'STOP' }] });
  assert.equal(parsed.toolCalls[0].id, undefined);
  googleAdapter.appendAssistant({ state, parsed, rawMessage: parsed.rawAssistantMessage });
  googleAdapter.appendToolResult({ state, callId: parsed.toolCalls[0].id, toolName: 'read_file', result: { ok: true, output: 'note' } });
  assert.equal(Object.hasOwn(state.contents.at(-1).parts[0].functionResponse, 'id'), false);
});

test('OpenAI-compatible text content parts are joined as plain text', async () => {
  try {
    setFetch(async () => ({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: {
        role: 'assistant', content: [
          { type: 'text', text: 'Primera línea' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
          { type: 'text', text: 'Second line' },
        ],
      } }] }),
    }));
    const result = await openai.run({ root: os.tmpdir(), prompt: 'Reply', apiKey: 'test-key' });
    assert.equal(result.ok, true);
    assert.equal(result.text, 'Primera línea\nSecond line');
  } finally {
    resetFetch();
  }
});

test('API loop final answer supersedes provisional text emitted before tool calls', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-api-final-answer-'));
  fs.writeFileSync(path.join(root, 'note.txt'), 'known');
  const draft = '```moragent-plan\n{"tasks":[{"id":"t1","role":"backend","prompt":"make a file"}]}\n```';
  try {
    for (const [provisional, final] of [[draft, 'No changes needed.'], ['Checking first.', draft]]) {
      let turn = 0;
      const events = [];
      setFetch(async () => ({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: ++turn === 1
          ? { role: 'assistant', content: provisional, tool_calls: [{ id: 'read_1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'note.txt' }) } }] }
          : { role: 'assistant', content: final } }] }),
      }));
      const result = await openai.run({ root, prompt: 'Inspect note.txt', apiKey: 'test-key', autonomy: 'readonly', onEvent: (event) => events.push(event) });
      assert.equal(result.ok, true);
      assert.equal(result.text, final);
      assert.ok(events.some((event) => event.type === 'text' && event.delta === provisional), 'provisional progress remains visible');
      assert.equal(events.at(-1).text, final);
    }
  } finally {
    resetFetch();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('OpenAI-compatible malformed tool arguments fail without running the tool', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-bad-tool-'));
  try {
    for (const args of ['{bad json', 'null', '[]']) {
      let requests = 0;
      setFetch(async () => {
        requests++;
        return {
          ok: true, status: 200,
          json: async () => ({ choices: [{ message: {
            role: 'assistant', content: null,
            tool_calls: [{ id: 'bad_call', type: 'function', function: {
              name: 'write_file', arguments: args,
            } }],
          } }] }),
        };
      });
      const result = await openai.run({ root, prompt: 'Write a file', apiKey: 'test-key' });
      assert.equal(result.ok, false, args);
      assert.match(result.error, /JSON inválidos|invalid JSON|no son un objeto|non-object arguments/);
      assert.equal(requests, 1);
      assert.deepEqual(fs.readdirSync(root), []);
    }
  } finally {
    resetFetch();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('API worker cannot claim success after an unrecovered file-tool failure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-failed-file-tool-'));
  const events = [];
  let turn = 0;
  try {
    setFetch(async () => ({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: ++turn === 1
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'write_1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: '../outside.txt', content: 'wrong' }) } }] }
        : { role: 'assistant', content: 'Created outside.txt.' } }] }),
    }));
    const result = await openai.run({ root, prompt: 'Create outside.txt', apiKey: 'test-key', autonomy: 'auto', onEvent: (event) => events.push(event) });
    assert.equal(result.ok, false);
    assert.match(result.error, /file tool|herramienta de archivo/i);
    assert.equal(events.at(-1).type, 'done');
    assert.equal(events.at(-1).ok, false);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    resetFetch();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('API worker cannot claim success after a write_file call without content', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-missing-content-'));
  const file = path.join(root, 'note.txt');
  fs.writeFileSync(file, 'original');
  let turn = 0;
  try {
    setFetch(async () => ({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: ++turn === 1
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'write_1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'note.txt' }) } }] }
        : { role: 'assistant', content: 'Updated note.txt.' } }] }),
    }));
    const result = await openai.run({ root, prompt: 'Update note.txt', apiKey: 'test-key', autonomy: 'auto' });
    assert.equal(result.ok, false);
    assert.match(result.error, /file tool|herramienta de archivo/i);
    assert.equal(fs.readFileSync(file, 'utf8'), 'original');
  } finally {
    resetFetch();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('API worker may recover a failed edit by successfully editing the same path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-retry-file-tool-'));
  fs.writeFileSync(path.join(root, 'note.txt'), 'before');
  let turn = 0;
  try {
    setFetch(async () => {
      turn++;
      const message = turn === 3
        ? { role: 'assistant', content: 'Updated note.txt.' }
        : { role: 'assistant', content: null, tool_calls: [{ id: `edit_${turn}`, type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'note.txt', old_string: turn === 1 ? 'missing' : 'before', new_string: 'after' }) } }] };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message }] }) };
    });
    const result = await openai.run({ root, prompt: 'Update note.txt', apiKey: 'test-key', autonomy: 'auto' });
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'after');
  } finally {
    resetFetch();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('API worker preserves literal dollar tokens in an edit_file tool call', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-api-literal-edit-'));
  const file = path.join(root, 'source.txt');
  fs.writeFileSync(file, 'prefix-before-suffix');
  let turn = 0;
  try {
    setFetch(async () => ({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: ++turn === 1
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'edit_1', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'source.txt', old_string: 'before', new_string: '$&' }) } }] }
        : { role: 'assistant', content: 'Edited source.txt.' } }] }),
    }));
    const result = await openai.run({ root, prompt: 'Insert literal $&', apiKey: 'test-key', autonomy: 'auto' });
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'prefix-$&-suffix');
  } finally {
    resetFetch();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('credentials: MORAGENT_HOME override, file mode 0600, get, set, remove, list', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-cred-test-'));
  const origHome = process.env.MORAGENT_HOME;
  const origAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const origOpenaiKey = process.env.OPENAI_API_KEY;

  try {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.MORAGENT_HOME = tmpDir;

    const credPath = getCredentialsPath();
    assert.ok(credPath.startsWith(tmpDir), 'credPath should be inside MORAGENT_HOME');

    // Initially no keys
    assert.equal(getKey('anthropic'), null);
    assert.deepEqual(listKeys(), []);

    // Set key
    setKey('anthropic', 'sk-ant-api03-abcdef123456');
    assert.equal(getKey('anthropic'), 'sk-ant-api03-abcdef123456');

    // Verify file mode 0600 (on POSIX)
    if (process.platform !== 'win32') {
      const stat = fs.statSync(credPath);
      const mode = stat.mode & 0o777;
      assert.equal(mode, 0o600, 'credentials.json must have mode 0600');
    }

    // Set second key
    setKey('openai', 'sk-proj-9876543210zyxw');
    assert.deepEqual(fs.readdirSync(tmpDir), ['credentials.json'], 'atomic saves should leave no temporary key files');

    // List keys
    const keys = listKeys();
    assert.equal(keys.length, 2);
    const antEntry = keys.find((k) => k.id === 'anthropic');
    assert.ok(antEntry);
    assert.equal(antEntry.source, 'file');
    assert.equal(antEntry.masked, 'sk-…3456');

    // Env wins over file
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-override-9999';
    assert.equal(getKey('anthropic'), 'sk-ant-env-override-9999');
    const keysAfterEnv = listKeys();
    const antEnvEntry = keysAfterEnv.find((k) => k.id === 'anthropic');
    assert.equal(antEnvEntry.source, 'env');
    assert.equal(antEnvEntry.masked, 'sk-…9999');

    // Clean env override
    delete process.env.ANTHROPIC_API_KEY;
    assert.equal(getKey('anthropic'), 'sk-ant-api03-abcdef123456');

    // Remove key
    removeKey('anthropic');
    assert.equal(getKey('anthropic'), null);
    assert.equal(listKeys().length, 1);
  } finally {
    if (origHome !== undefined) process.env.MORAGENT_HOME = origHome;
    else delete process.env.MORAGENT_HOME;
    if (origAnthropicKey !== undefined) process.env.ANTHROPIC_API_KEY = origAnthropicKey;
    else delete process.env.ANTHROPIC_API_KEY;
    if (origOpenaiKey !== undefined) process.env.OPENAI_API_KEY = origOpenaiKey;
    else delete process.env.OPENAI_API_KEY;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('credentials: a damaged file is preserved instead of overwritten by login changes', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-cred-damaged-'));
  const originalHome = process.env.MORAGENT_HOME;
  const originalKey = process.env.OPENAI_API_KEY;
  try {
    process.env.MORAGENT_HOME = tmpDir;
    delete process.env.OPENAI_API_KEY;
    const file = getCredentialsPath();
    const damaged = '{"openai":"sk-keep-me", invalid';
    fs.writeFileSync(file, damaged, { mode: 0o600 });

    assert.equal(getKey('openai'), null);
    assert.throws(() => setKey('openai', 'sk-new'), /existing credentials\.json is unreadable or invalid/);
    assert.throws(() => setEndpoint('compatible', 'http://127.0.0.1:7777/v1'), /existing credentials\.json is unreadable or invalid/);
    assert.throws(() => removeKey('openai'), /existing credentials\.json is unreadable or invalid/);
    assert.equal(fs.readFileSync(file, 'utf8'), damaged);
    assert.deepEqual(fs.readdirSync(tmpDir), ['credentials.json']);
  } finally {
    if (originalHome === undefined) delete process.env.MORAGENT_HOME; else process.env.MORAGENT_HOME = originalHome;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('credentials: maskKey formatting', () => {
  assert.equal(maskKey(''), '');
  assert.equal(maskKey('sk-1234567890abcd'), 'sk-…abcd');
  assert.equal(maskKey('sk-proj-xyz123'), 'sk-…z123');
  assert.equal(maskKey('AIzaSy1234567890'), 'AIz…7890');
  assert.equal(maskKey('short'), 's…rt');
});

test('tools: path confinement rejects .. and external symlinks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-tools-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-tools-outside-'));

  try {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret data');

    // Internal path ok
    const inside = assertPathInside(root, 'subdir/file.txt');
    const realRoot = fs.realpathSync(root);
    assert.ok(inside.startsWith(realRoot));
    assert.equal(assertPathInside(root, '..cache/file.txt'), path.join(realRoot, '..cache', 'file.txt'));

    // Traversal with .. rejected
    assert.throws(() => {
      assertPathInside(root, '../secret.txt');
    }, /escap/i);

    assert.throws(() => {
      assertPathInside(root, 'subdir/../../secret.txt');
    }, /escap/i);

    // Symlink pointing outside rejected
    if (process.platform !== 'win32') {
      const symlinkPath = path.join(root, 'link_to_outside');
      try {
        fs.symlinkSync(outside, symlinkPath);
        assert.throws(() => {
          assertPathInside(root, 'link_to_outside/secret.txt');
        }, /raíz|root/i);
      } catch (err) {
        // If symlink not permitted in environment, skip symlink test
        if (err.code !== 'EPERM') throw err;
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('tools: write_file cannot follow a dangling symlink outside the project', { skip: process.platform === 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-link-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-link-outside-'));
  const destination = path.join(outside, 'new.txt');
  try {
    fs.symlinkSync(destination, path.join(root, 'link.txt'));
    const result = await executeTool('write_file', { path: 'link.txt', content: 'escape' }, { root });
    assert.equal(result.ok, false);
    assert.equal(fs.existsSync(destination), false);
    fs.symlinkSync(path.join(outside, 'new-dir'), path.join(root, 'link-dir'));
    const nested = await executeTool('write_file', { path: 'link-dir/nested.txt', content: 'escape' }, { root });
    assert.equal(nested.ok, false);
    assert.equal(fs.existsSync(path.join(outside, 'new-dir')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('tools: list_dir does not follow symlinks for external file metadata', { skip: process.platform === 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-list-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-list-outside-'));
  try {
    fs.writeFileSync(path.join(root, 'ordinary.txt'), 'ok');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x'.repeat(12345));
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'external.txt'));
    fs.symlinkSync(path.join(root, 'ordinary.txt'), path.join(root, 'internal.txt'));

    const result = await executeTool('list_dir', { path: '.' }, { root, autonomy: 'readonly' });
    assert.equal(result.ok, true);
    assert.match(result.output, /\[FILE\] ordinary\.txt \(2 B\)/);
    assert.match(result.output, /\[LINK\] external\.txt(?:\n|$)/);
    assert.match(result.output, /\[LINK\] internal\.txt(?:\n|$)/);
    assert.doesNotMatch(result.output, /12345 B|secret\.txt/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('tools: read_file streams selected lines from oversized files while edit_file rejects them', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-large-file-'));
  try {
    const file = path.join(root, 'large.txt');
    fs.writeFileSync(file, 'first\n');
    fs.truncateSync(file, 32 * 1024 * 1024);
    const before = fs.statSync(file).size;
    const descriptor = fs.openSync(file, 'r+');
    try {
      const tail = Buffer.from('\nlast\n');
      fs.writeSync(descriptor, tail, 0, tail.length, before - tail.length);
    } finally {
      fs.closeSync(descriptor);
    }

    const read = await executeTool('read_file', { path: 'large.txt', offset: 1, limit: 1 }, { root, autonomy: 'readonly' });
    assert.equal(read.ok, true);
    assert.equal(read.output, 'first');
    let yielded = false;
    const tick = setTimeout(() => { yielded = true; }, 0);
    const tail = await executeTool('read_file', { path: 'large.txt', offset: 3, limit: 1 }, { root, autonomy: 'readonly' });
    clearTimeout(tick);
    assert.equal(tail.ok, true);
    assert.equal(tail.output, 'last');
    assert.equal(yielded, true, 'large offset scan must yield to the terminal event loop');
    const edit = await executeTool('edit_file', { path: 'large.txt', old_string: 'first', new_string: 'changed' }, { root });
    assert.equal(edit.ok, false);
    assert.match(edit.output, /too large|demasiado grande/i);
    assert.equal(fs.statSync(file).size, before);
    const check = fs.openSync(file, 'r');
    try {
      const first = Buffer.alloc(6);
      fs.readSync(check, first, 0, first.length, 0);
      assert.equal(first.toString('utf8'), 'first\n');
    } finally {
      fs.closeSync(check);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tools: read_file preserves UTF-8 across stream chunks, truncates output, and cancels a long scan', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-stream-read-'));
  try {
    fs.writeFileSync(path.join(root, 'boundary.txt'), `${'a'.repeat(65534)}\néx\n`);
    const selected = await executeTool('read_file', { path: 'boundary.txt', offset: 2, limit: 1 }, { root });
    assert.equal(selected.ok, true);
    assert.equal(selected.output, 'éx');
    const full = await executeTool('read_file', { path: 'boundary.txt' }, { root });
    assert.equal(full.ok, true);
    assert.ok(Buffer.byteLength(full.output, 'utf8') <= MAX_OUTPUT_BYTES);
    assert.match(full.output, /output truncated to 20 KB/);

    const large = path.join(root, 'large.txt');
    fs.writeFileSync(large, 'first\n');
    fs.truncateSync(large, 64 * 1024 * 1024);
    const controller = new AbortController();
    const pending = executeTool('read_file', { path: 'large.txt', offset: 3, limit: 1 }, { root, signal: controller.signal });
    setTimeout(() => controller.abort(), 1);
    const cancelled = await pending;
    assert.equal(cancelled.ok, false);
    assert.match(cancelled.output, /cancelada|cancelled/i);
    // A destroyed FileHandle stream must not emit a late uncaught abort error.
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tools: incomplete or malformed file arguments never overwrite existing content', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-tools-arguments-'));
  const file = path.join(root, 'existing.txt');
  try {
    fs.writeFileSync(file, 'keep this text');
    for (const args of [{ path: 'existing.txt' }, { path: 'existing.txt', content: { text: 'replacement' } }]) {
      const result = await executeTool('write_file', args, { root });
      assert.equal(result.ok, false);
      assert.equal(fs.readFileSync(file, 'utf8'), 'keep this text');
    }
    for (const args of [
      { path: 'existing.txt', old_string: 'keep this text' },
      { path: 'existing.txt', old_string: '', new_string: 'replacement' },
      { path: 'existing.txt', old_string: 'keep this text', new_string: { text: 'replacement' } },
    ]) {
      const result = await executeTool('edit_file', args, { root });
      assert.equal(result.ok, false);
      assert.equal(fs.readFileSync(file, 'utf8'), 'keep this text');
    }
    assert.equal((await executeTool('write_file', { path: 'empty.txt', content: '' }, { root })).ok, true);
    assert.equal(fs.readFileSync(path.join(root, 'empty.txt'), 'utf8'), '');
    assert.equal((await executeTool('edit_file', { path: 'existing.txt', old_string: 'keep this text', new_string: '' }, { root })).ok, true);
    assert.equal(fs.readFileSync(file, 'utf8'), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('write_file can construct exact LF bytes from lines without escape ambiguity', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-lines-write-'));
  try {
    const result = await executeTool('write_file', { path: 'exact.txt', lines: ['LIVE-ENGINE-OK'], final_newline: true }, { root });
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(path.join(root, 'exact.txt'), 'utf8'), 'LIVE-ENGINE-OK\n');
    const noFinal = await executeTool('write_file', { path: 'plain.txt', lines: ['first', 'second'], final_newline: false }, { root });
    assert.equal(noFinal.ok, true);
    assert.equal(fs.readFileSync(path.join(root, 'plain.txt'), 'utf8'), 'first\nsecond');
    for (const args of [
      { path: 'exact.txt', lines: ['wrong'] },
      { path: 'exact.txt', lines: ['wrong\nline'], final_newline: true },
      { path: 'exact.txt', lines: ['wrong'], final_newline: 'true' },
      { path: 'exact.txt', content: 'wrong', lines: ['wrong'], final_newline: true },
    ]) {
      assert.equal((await executeTool('write_file', args, { root })).ok, false);
      assert.equal(fs.readFileSync(path.join(root, 'exact.txt'), 'utf8'), 'LIVE-ENGINE-OK\n');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('API file tools reject a sibling task path without blocking the assigned path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-task-scope-'));
  try {
    const options = { root, protectedOtherPaths: ['ui.txt'] };
    const denied = await executeTool('write_file', { path: './ui.txt', content: 'UI' }, options);
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'TASK_SCOPE');
    assert.equal(fs.existsSync(path.join(root, 'ui.txt')), false);
    const allowed = await executeTool('write_file', { path: 'api.txt', content: 'API' }, options);
    assert.equal(allowed.ok, true);
    assert.equal(fs.readFileSync(path.join(root, 'api.txt'), 'utf8'), 'API');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('tools: edit_file inserts replacement text literally, including dollar tokens', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-edit-literal-'));
  const file = path.join(root, 'code.txt');
  try {
    for (const replacement of ['$&', '$$', '$`', "$'", 'const value = "$&";']) {
      fs.writeFileSync(file, 'prefix-before-suffix');
      const result = await executeTool('edit_file', { path: 'code.txt', old_string: 'before', new_string: replacement }, { root });
      assert.equal(result.ok, true, replacement);
      assert.equal(fs.readFileSync(file, 'utf8'), `prefix-${replacement}-suffix`, replacement);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tools: write_file, read_file, edit_file, list_dir, grep', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-tools-crud-'));

  try {
    // 1. write_file
    const writeRes = await executeTool('write_file', {
      path: 'docs/hello.txt',
      content: 'Line 1: Hello\nLine 2: World\nLine 3: Foo',
    }, { root });
    assert.equal(writeRes.ok, true);
    assert.ok(fs.existsSync(path.join(root, 'docs/hello.txt')));
    assert.match(writeRes.output, /Final LF newline: no/);
    const newlineRes = await executeTool('write_file', { path: 'newline.txt', content: 'line\n' }, { root });
    assert.match(newlineRes.output, /Final LF newline: yes/);
    const escapedRes = await executeTool('write_file', { path: 'escaped.txt', content: 'line\\n' }, { root });
    assert.match(escapedRes.output, /literal characters, not a newline/);
    const escapedRead = await executeTool('read_file', { path: 'escaped.txt' }, { root });
    assert.match(escapedRead.output, /literal backslash \+ n characters, not a final LF newline/);

    // 2. read_file full
    const readRes = await executeTool('read_file', { path: 'docs/hello.txt' }, { root });
    assert.equal(readRes.ok, true);
    assert.ok(readRes.output.includes('Line 1: Hello'));

    // 2b. read_file with offset and limit
    const sliceRes = await executeTool('read_file', {
      path: 'docs/hello.txt',
      offset: 2,
      limit: 1,
    }, { root });
    assert.equal(sliceRes.ok, true);
    assert.equal(sliceRes.output.trim(), 'Line 2: World');

    // 3. edit_file exact replace
    const editRes = await executeTool('edit_file', {
      path: 'docs/hello.txt',
      old_string: 'Line 2: World',
      new_string: 'Line 2: Moragent',
    }, { root });
    assert.equal(editRes.ok, true);

    const afterEdit = fs.readFileSync(path.join(root, 'docs/hello.txt'), 'utf8');
    assert.ok(afterEdit.includes('Line 2: Moragent'));
    assert.ok(!afterEdit.includes('Line 2: World'));

    // 3b. edit_file non-existent string fails
    const editFailRes = await executeTool('edit_file', {
      path: 'docs/hello.txt',
      old_string: 'Not there',
      new_string: 'Bar',
    }, { root });
    assert.equal(editFailRes.ok, false);

    // 4. list_dir
    const listRes = await executeTool('list_dir', { path: 'docs' }, { root });
    assert.equal(listRes.ok, true);
    assert.ok(listRes.output.includes('[FILE] hello.txt'));

    // 5. grep
    const grepRes = await executeTool('grep', { pattern: 'Moragent', path: '.' }, { root });
    assert.equal(grepRes.ok, true);
    assert.ok(grepRes.output.includes('docs/hello.txt:2: Line 2: Moragent'));

    // 6. Output truncation limit <= 20 KB
    const huge = 'A'.repeat(30 * 1024);
    const truncated = truncateOutput(huge);
    assert.ok(Buffer.byteLength(truncated, 'utf8') <= MAX_OUTPUT_BYTES);
    assert.ok(truncated.includes('output truncated to 20 KB'));
    for (const character of ['😀', '漢']) {
      const unicode = truncateOutput(character.repeat(20000));
      assert.ok(Buffer.byteLength(unicode, 'utf8') <= MAX_OUTPUT_BYTES);
      assert.doesNotMatch(unicode, /�/, 'truncation must not split a UTF-8 character');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('file API tools refuse a named pipe instead of blocking the terminal', { skip: process.platform === 'win32' }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-pipe-tools-'));
  try {
    const pipe = path.join(root, 'pipe');
    const created = spawnSync('mkfifo', [pipe]);
    if (created.error || created.status !== 0) return t.skip('mkfifo is unavailable');
    const moduleUrl = new URL('../src/providers/api/tools.js', import.meta.url).href;
    const script = `const { executeTool } = await import(process.argv[1]);
      const result = await executeTool(process.argv[2], { path: 'pipe', pattern: 'x', old_string: 'x', new_string: 'y', content: 'x' }, { root: process.argv[3] });
      process.stdout.write(JSON.stringify(result));`;
    for (const name of ['read_file', 'write_file', 'edit_file', 'grep']) {
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, moduleUrl, name, root], { timeout: 700, encoding: 'utf8' });
      assert.equal(child.status, 0, `${name} hung or crashed: ${child.error?.message || child.stderr}`);
      const result = JSON.parse(child.stdout);
      assert.equal(result.ok, false, name);
      assert.match(result.output, /regular file/i, name);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('grep stops at a global match limit and reports that its result is partial', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-grep-limit-'));
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'match\n'.repeat(1000));
    fs.writeFileSync(path.join(root, 'b.txt'), 'match-after-limit\n');
    const result = await executeTool('grep', { pattern: 'match', path: '.' }, { root });
    assert.equal(result.ok, true);
    assert.match(result.summary, /1000 matches/);
    assert.match(result.output, /search stopped after 1000 matches/);
    assert.doesNotMatch(result.output, /b\.txt/);
    const direct = await executeTool('grep', { pattern: 'match', path: 'a.txt' }, { root });
    assert.match(direct.summary, /1000 matches/);
    assert.match(direct.output, /search stopped after 1000 matches/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('grep yields to cancellation during a project search', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-grep-cancel-'));
  const controller = new AbortController();
  try {
    const nested = path.join(root, 'nested');
    fs.mkdirSync(nested);
    for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(nested, `${String(i).padStart(3, '0')}.txt`), `line ${i}\n`);
    const pending = executeTool('grep', { pattern: 'never-present', path: '.' }, { root, signal: controller.signal });
    setTimeout(() => controller.abort(), 0);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.match(result.output, /cancel|abort/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pathological grep regex cannot freeze cancellation or the search deadline', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-grep-regex-'));
  try {
    fs.writeFileSync(path.join(root, 'bad.txt'), `${'a'.repeat(30)}!\n`);
    const moduleUrl = new URL('../src/providers/api/tools.js', import.meta.url).href;
    const script = `const { executeTool } = await import(process.argv[1]);
      const controller = new AbortController();
      if (process.argv[3] === 'cancel') setTimeout(() => controller.abort(), 100);
      const result = await executeTool('grep', { pattern: '^(a+)+$', path: 'bad.txt' },
        { root: process.argv[2], signal: controller.signal });
      process.stdout.write(JSON.stringify(result));`;
    for (const mode of ['cancel', 'deadline']) {
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, moduleUrl, root, mode], {
        timeout: 2000, encoding: 'utf8', env: { ...process.env, MORAGENT_GREP_TIMEOUT_MS: '150' },
      });
      assert.equal(child.status, 0, `${mode} hung: ${child.error?.message || child.stderr}`);
      const result = JSON.parse(child.stdout);
      assert.equal(result.ok, false, mode);
      assert.match(result.output, mode === 'cancel' ? /cancel|abort/i : /time|límite/i);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('grep worker uses the session language instead of the process locale', async () => {
  const previous = { selected: getLang(), environment: process.env.MORAGENT_LANG };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-grep-lang-'));
  try {
    process.env.MORAGENT_LANG = 'es';
    setLang('en');
    const english = await executeTool('grep', { pattern: 'x', path: '../outside' }, { root });
    assert.equal(english.ok, false);
    assert.match(english.output, /escapes the project root/);
    process.env.MORAGENT_LANG = 'en';
    setLang('es');
    const spanish = await executeTool('grep', { pattern: 'x', path: '../outside' }, { root });
    assert.equal(spanish.ok, false);
    assert.match(spanish.output, /escapa de la raíz del proyecto/);
  } finally {
    setLang(previous.selected);
    if (previous.environment === undefined) delete process.env.MORAGENT_LANG;
    else process.env.MORAGENT_LANG = previous.environment;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('OpenAI-compatible tool loop receives grep results from its worker', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-grep-loop-'));
  let requests = 0;
  try {
    fs.writeFileSync(path.join(root, 'notes.txt'), 'alpha\nneedle here\nomega\n');
    setFetch(async (_url, options) => {
      requests++;
      if (requests === 1) return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'tool_calls', message: {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'grep-call', type: 'function', function: { name: 'grep', arguments: JSON.stringify({ pattern: 'needle', path: '.' }) } }],
      } }] }) };
      const messages = JSON.parse(options.body).messages;
      const toolResult = messages.at(-1);
      assert.equal(toolResult.role, 'tool');
      assert.equal(toolResult.tool_call_id, 'grep-call');
      assert.match(toolResult.content, /notes\.txt:2: needle here/);
      return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Found the note.' } }] }) };
    });
    const result = await openai.run({ root, prompt: 'Find the needle', apiKey: 'test-key', autonomy: 'readonly' });
    assert.equal(result.ok, true);
    assert.equal(result.text, 'Found the note.');
    assert.equal(requests, 2);
  } finally {
    resetFetch();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tools: unsandboxed bash requires explicit full autonomy', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-bash-test-'));

  try {
    // autonomy 'ask' -> refuse
    const askRes = await executeTool('bash', { command: 'echo "hello"' }, { root, autonomy: 'ask' });
    assert.equal(askRes.ok, false);
    assert.ok(askRes.summary.includes('Refused'));

    // autonomy 'auto' also refuses unsandboxed shell execution
    const autoRes = await executeTool('bash', { command: 'echo hello from bash' }, { root, autonomy: 'auto' });
    assert.equal(autoRes.ok, false);
    assert.match(autoRes.output, /full/);

    const fullRes = await executeTool('bash', { command: 'echo hello from bash' }, { root, autonomy: 'full' });
    assert.equal(fullRes.ok, true);
    assert.equal(fullRes.output.trim(), 'hello from bash');

    const askWrite = await executeTool('write_file', { path: 'blocked.txt', content: 'x' }, { root, autonomy: 'ask' });
    assert.equal(askWrite.ok, false);
    assert.equal(fs.existsSync(path.join(root, 'blocked.txt')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tools: bash decodes UTF-8 split across stdout and stderr chunks', { skip: process.platform === 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-bash-utf8-'));
  try {
    const command = String.raw`printf '\303'; sleep 0.05; printf '\261'; printf '\342' >&2; sleep 0.05; printf '\202\254' >&2`;
    const result = await executeTool('bash', { command }, { root, autonomy: 'full' });
    assert.equal(result.ok, true);
    assert.equal(result.output, 'ñ\n€');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tools: cancelling bash is responsive and stops child processes', { skip: process.platform === 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-bash-cancel-'));
  const controller = new AbortController();
  try {
    const started = Date.now();
    const pending = executeTool('bash', {
      command: 'sleep 1 && printf orphan > marker.txt & wait',
    }, { root, autonomy: 'full', signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.match(result.output, /cancel/i);
    assert.ok(Date.now() - started < 900, 'abort should not wait for the shell command');
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(fs.existsSync(path.join(root, 'marker.txt')), false, 'child process should be terminated too');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loop: abort during bash ends the turn without another provider request', { skip: process.platform === 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-loop-cancel-'));
  const controller = new AbortController();
  const events = [];
  let requests = 0;
  try {
    setFetch(async () => {
      requests++;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: {
            role: 'assistant', content: null,
            tool_calls: [{ id: 'call_slow', type: 'function', function: {
              name: 'bash', arguments: JSON.stringify({ command: 'sleep 3' }),
            } }],
          } }],
        }),
      };
    });
    const pending = openai.run({ root, prompt: 'Run a slow command', apiKey: 'fake', autonomy: 'full',
      signal: controller.signal, onEvent: (event) => events.push(event) });
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Aborted');
    assert.equal(requests, 1);
    assert.equal(events.filter((event) => event.type === 'done').length, 1);
  } finally {
    resetFetch();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tools: schema generators for Anthropic, OpenAI, and Gemini', () => {
  const ant = getAnthropicTools();
  assert.ok(Array.isArray(ant) && ant.length >= 5);
  assert.ok(ant.find((t) => t.name === 'read_file')?.input_schema);
  assert.equal(ant.some((t) => t.name === 'bash'), false);

  const oai = getOpenAITools();
  assert.ok(Array.isArray(oai) && oai.length >= 5);
  assert.equal(oai[0].type, 'function');

  const gem = getGeminiTools();
  assert.ok(Array.isArray(gem) && gem.length === 1);
  assert.ok(Array.isArray(gem[0].functionDeclarations) && gem[0].functionDeclarations.length >= 5);
  const gemWrite = gem[0].functionDeclarations.find((tool) => tool.name === 'write_file');
  assert.equal(gemWrite.parameters.properties.lines.type, 'ARRAY');
  assert.equal(gemWrite.parameters.properties.lines.items.type, 'STRING');
});

test('status: reports ready based on keys and ollama ping', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-status-test-'));
  const origHome = process.env.MORAGENT_HOME;
  const origAnthropic = process.env.ANTHROPIC_API_KEY;
  const origOpenai = process.env.OPENAI_API_KEY;
  const origOpenrouter = process.env.OPENROUTER_API_KEY;
  const origGemini = process.env.GEMINI_API_KEY;
  const origGoogle = process.env.GOOGLE_API_KEY;

  try {
    process.env.MORAGENT_HOME = tmpDir;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    // Keys not set
    assert.equal((await anthropic.status()).ready, false);
    assert.equal((await openai.status()).ready, false);
    assert.equal((await openrouter.status()).ready, false);
    assert.equal((await google.status()).ready, false);

    // Set keys
    setKey('anthropic', 'sk-ant-test');
    setKey('openai', 'sk-oai-test');
    setKey('openrouter', 'sk-or-test');
    setKey('google', 'gemini-key-test');

    assert.equal((await anthropic.status()).ready, true);
    assert.equal((await openai.status()).ready, true);
    assert.equal((await openrouter.status()).ready, true);
    assert.equal((await google.status()).ready, true);

    // Ollama status with mock fetch
    setFetch(async (url) => {
      if (String(url).includes('/api/tags')) {
        return { ok: true, status: 200, json: async () => ({ models: [] }) };
      }
      return { ok: false, status: 404 };
    });
    assert.equal((await ollama.status()).ready, true);

    // Ollama status when failing
    setFetch(async () => {
      throw new Error('Connection refused');
    });
    assert.equal((await ollama.status()).ready, false);
  } finally {
    resetFetch();
    if (origHome !== undefined) process.env.MORAGENT_HOME = origHome;
    else delete process.env.MORAGENT_HOME;
    if (origAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = origAnthropic;
    else delete process.env.ANTHROPIC_API_KEY;
    if (origOpenai !== undefined) process.env.OPENAI_API_KEY = origOpenai;
    else delete process.env.OPENAI_API_KEY;
    if (origOpenrouter !== undefined) process.env.OPENROUTER_API_KEY = origOpenrouter;
    else delete process.env.OPENROUTER_API_KEY;
    if (origGemini !== undefined) process.env.GEMINI_API_KEY = origGemini;
    else delete process.env.GEMINI_API_KEY;
    if (origGoogle !== undefined) process.env.GOOGLE_API_KEY = origGoogle;
    else delete process.env.GOOGLE_API_KEY;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('loop: Anthropic conversation with 2 tool calls (write_file + read_file) ending in text', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-anthropic-test-'));
  const events = [];
  let callCount = 0;

  try {
    setFetch(async (url, opts) => {
      callCount++;
      const body = JSON.parse(opts.body);

      if (callCount === 1) {
        // First turn: assistant calls write_file
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            stop_reason: 'tool_use',
            content: [
              { type: 'text', text: 'Creating greeting file...' },
              {
                type: 'tool_use',
                id: 'toolu_write_1',
                name: 'write_file',
                input: { path: 'greet.txt', content: '¡Hola desde Anthropic!' },
              },
            ],
            usage: { input_tokens: 15, output_tokens: 25 },
          }),
        };
      }

      if (callCount === 2) {
        // Second turn: assistant receives tool result and calls read_file
        // Verify that the previous tool_result was added to messages
        const lastMsg = body.messages[body.messages.length - 1];
        assert.equal(lastMsg.role, 'user');
        assert.equal(lastMsg.content[0].type, 'tool_result');
        assert.equal(lastMsg.content[0].tool_use_id, 'toolu_write_1');

        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'msg_2',
            type: 'message',
            role: 'assistant',
            stop_reason: 'tool_use',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_read_2',
                name: 'read_file',
                input: { path: 'greet.txt' },
              },
            ],
            usage: { input_tokens: 30, output_tokens: 20 },
          }),
        };
      }

      if (callCount === 3) {
        // Third turn: final text
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'msg_3',
            type: 'message',
            role: 'assistant',
            stop_reason: 'end_turn',
            content: [
              { type: 'text', text: 'El archivo greet.txt contiene: ¡Hola desde Anthropic!' },
            ],
            usage: { input_tokens: 45, output_tokens: 15 },
          }),
        };
      }

      throw new Error(`Unexpected call ${callCount}`);
    });

    const result = await anthropic.run({
      root,
      prompt: 'Escribe greet.txt y luego léelo',
      system: 'Eres un asistente útil',
      sessionId: 'session_ant_1',
      apiKey: 'sk-ant-fake-key',
      onEvent: (e) => events.push(e),
    });

    assert.equal(result.ok, true);
    assert.ok(result.text.includes('¡Hola desde Anthropic!'));
    assert.equal(result.sessionId, 'session_ant_1');
    assert.equal(result.usage.input, 90);
    assert.equal(result.usage.output, 60);

    // Verify file actually created on disk in root
    assert.equal(fs.readFileSync(path.join(root, 'greet.txt'), 'utf8'), '¡Hola desde Anthropic!');

    // Verify sequence of normalized events
    const types = events.map((e) => e.type);
    assert.deepEqual(types, [
      'start',
      'usage',
      'text',
      'tool',
      'tool_result',
      'usage',
      'tool',
      'tool_result',
      'usage',
      'text',
      'done',
    ]);

    const startEvent = events.find((e) => e.type === 'start');
    assert.equal(startEvent.provider, 'anthropic');
    assert.equal(startEvent.sessionId, 'session_ant_1');

    const doneEvent = events.find((e) => e.type === 'done');
    assert.equal(doneEvent.ok, true);
    assert.equal(doneEvent.error, null);
  } finally {
    resetFetch();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loop: OpenAI conversation with 2 tool calls (write_file + read_file) ending in text', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-openai-test-'));
  const events = [];
  let callCount = 0;

  try {
    setFetch(async (url, opts) => {
      callCount++;
      const body = JSON.parse(opts.body);

      if (callCount === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'chatcmpl_1',
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: 'Writing file...',
                  tool_calls: [
                    {
                      id: 'call_oai_write',
                      type: 'function',
                      function: {
                        name: 'write_file',
                        arguments: JSON.stringify({ path: 'oai.txt', content: 'hello from OpenAI' }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 20 },
          }),
        };
      }

      if (callCount === 2) {
        // Verify tool message
        const lastMsg = body.messages[body.messages.length - 1];
        assert.equal(lastMsg.role, 'tool');
        assert.equal(lastMsg.tool_call_id, 'call_oai_write');

        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'chatcmpl_2',
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      id: 'call_oai_read',
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: JSON.stringify({ path: 'oai.txt' }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 15 },
          }),
        };
      }

      if (callCount === 3) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'chatcmpl_3',
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: 'The file oai.txt contains "hello from OpenAI".',
                },
              },
            ],
            usage: { prompt_tokens: 30, completion_tokens: 10 },
          }),
        };
      }

      throw new Error(`Unexpected call ${callCount}`);
    });

    const result = await openai.run({
      root,
      prompt: 'Write and read oai.txt',
      sessionId: 'session_oai_1',
      apiKey: 'sk-oai-fake',
      onEvent: (e) => events.push(e),
    });

    assert.equal(result.ok, true);
    assert.ok(result.text.includes('hello from OpenAI'));
    assert.equal(fs.readFileSync(path.join(root, 'oai.txt'), 'utf8'), 'hello from OpenAI');

    const doneEvent = events.find((e) => e.type === 'done');
    assert.equal(doneEvent.ok, true);
    assert.equal(doneEvent.error, null);
  } finally {
    resetFetch();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loop: Gemini (Google) conversation with 2 tool calls (write_file + read_file) ending in text', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-gemini-test-'));
  const events = [];
  let callCount = 0;

  try {
    setFetch(async (url, opts) => {
      callCount++;
      const body = JSON.parse(opts.body);

      if (callCount === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    { text: 'Creating gemini.txt' },
                    {
                      functionCall: {
                        id: 'gemini-write-1',
                        name: 'write_file',
                        args: { path: 'gemini.txt', content: 'Gemini created this' },
                      },
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 18 },
          }),
        };
      }

      if (callCount === 2) {
        // Verify functionResponse in contents
        const lastContent = body.contents[body.contents.length - 1];
        assert.equal(lastContent.role, 'user');
        assert.ok(lastContent.parts[0].functionResponse);
        assert.equal(lastContent.parts[0].functionResponse.id, 'gemini-write-1');

        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    {
                      functionCall: {
                        id: 'gemini-read-2',
                        name: 'read_file',
                        args: { path: 'gemini.txt' },
                      },
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 25, candidatesTokenCount: 14 },
          }),
        };
      }

      if (callCount === 3) {
        const lastContent = body.contents[body.contents.length - 1];
        assert.equal(lastContent.parts[0].functionResponse.id, 'gemini-read-2');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [{ text: 'File gemini.txt verified successfully.' }],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 35, candidatesTokenCount: 8 },
          }),
        };
      }

      throw new Error(`Unexpected call ${callCount}`);
    });

    const result = await google.run({
      root,
      prompt: 'Create gemini.txt and read it',
      sessionId: 'session_gem_1',
      apiKey: 'fake-gemini-key',
      onEvent: (e) => events.push(e),
    });

    assert.equal(result.ok, true);
    assert.ok(result.text.includes('verified successfully'));
    assert.equal(fs.readFileSync(path.join(root, 'gemini.txt'), 'utf8'), 'Gemini created this');

    const doneEvent = events.find((e) => e.type === 'done');
    assert.equal(doneEvent.ok, true);
  } finally {
    resetFetch();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loop: abort and HTTP error handling', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-error-test-'));

  try {
    // 1. Missing API key returns ok: false, error without throwing
    const noKeyRes = await anthropic.run({
      root,
      prompt: 'hello',
      apiKey: null,
    });
    assert.equal(noKeyRes.ok, false);
    assert.ok(noKeyRes.error.includes('Missing API key'));

    // 2. Abort signal returns ok: false, error: 'Aborted'
    const controller = new AbortController();
    controller.abort();
    const abortRes = await anthropic.run({
      root,
      prompt: 'hello',
      apiKey: 'fake',
      signal: controller.signal,
    });
    assert.equal(abortRes.ok, false);
    assert.equal(abortRes.error, 'Aborted');

    // 3. HTTP 500 error returns ok: false without throwing
    setFetch(async () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'Rate limit exceeded or server error',
    }));

    const httpErrRes = await anthropic.run({
      root,
      prompt: 'hello',
      apiKey: 'fake',
    });
    assert.equal(httpErrRes.ok, false);
    assert.ok(httpErrRes.error.includes('HTTP 500'));
  } finally {
    resetFetch();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loop: stalled HTTP requests time out and honour cancellation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-http-timeout-'));
  const events = [];
  let requestSignal;
  try {
    setFetch((_url, options) => {
      requestSignal = options.signal;
      return new Promise(() => {}); // an endpoint that never sends response headers
    });
    const timedOut = await openai.run({ root, prompt: 'hello', apiKey: 'fake',
      requestTimeoutMs: 30, onEvent: (event) => events.push(event) });
    assert.equal(timedOut.ok, false);
    assert.match(timedOut.error, /timed out|excedió/i);
    assert.equal(requestSignal.aborted, true);
    assert.equal(events.filter((event) => event.type === 'done').length, 1);

    const controller = new AbortController();
    const pending = openai.run({ root, prompt: 'hello', apiKey: 'fake',
      requestTimeoutMs: 5000, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    const cancelled = await pending;
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.error, 'Aborted');
    assert.equal(requestSignal.aborted, true);

    setFetch(() => ({ ok: true, json: () => new Promise(() => {}) }));
    const bodyTimedOut = await openai.run({ root, prompt: 'hello', apiKey: 'fake', requestTimeoutMs: 30 });
    assert.equal(bodyTimedOut.ok, false);
    assert.match(bodyTimedOut.error, /timed out|excedió/i);
  } finally {
    resetFetch();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loop: openrouter and ollama runs execute with appropriate headers and defaults', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-or-ollama-test-'));
  const priorOllamaModel = process.env.MORAGENT_OLLAMA_MODEL;
  delete process.env.MORAGENT_OLLAMA_MODEL;

  try {
    let capturedHeaders = null;
    let capturedUrl = null;

    setFetch(async (url, opts) => {
      capturedUrl = url;
      capturedHeaders = opts.headers;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 'hello from openrouter' } }],
          usage: { prompt_tokens: 5, completion_tokens: 5 },
        }),
      };
    });

    // OpenRouter run
    const orRes = await openrouter.run({
      root,
      prompt: 'test openrouter',
      apiKey: 'sk-or-test-key',
    });
    assert.equal(orRes.ok, true);
    assert.equal(orRes.text, 'hello from openrouter');
    assert.equal(capturedHeaders['HTTP-Referer'], 'https://github.com/EduardoMoraga/moragent');
    assert.equal(capturedHeaders['X-Title'], 'MORAGENT');
    assert.ok(capturedUrl.includes('openrouter.ai'));

    // Ollama run (no key required) selects an installed chat model, not a
    // hard-coded default that may not exist on this local server.
    resetApiModelCache();
    let capturedModel = null;
    let catalogUrl = null;
    setFetch(async (url, opts) => {
      capturedUrl = url;
      if (String(url).endsWith('/api/tags')) {
        catalogUrl = String(url);
        return {
          ok: true,
          json: async () => ({ models: [
            { name: 'vector-model', capabilities: ['embedding'] },
            { name: 'text-only-model', capabilities: ['completion'] },
            { name: 'qwen-local:latest', capabilities: ['completion', 'tools'] },
          ] }),
        };
      }
      capturedModel = JSON.parse(opts.body).model;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 'hello from ollama' } }],
          usage: { prompt_tokens: 8, completion_tokens: 4 },
        }),
      };
    });

    const ollamaRes = await ollama.run({
      root,
      prompt: 'test ollama',
      baseUrl: 'http://127.0.0.1:44999',
    });
    assert.equal(ollamaRes.ok, true);
    assert.equal(ollamaRes.text, 'hello from ollama');
    assert.equal(catalogUrl, 'http://127.0.0.1:44999/api/tags');
    assert.ok(capturedUrl.includes('127.0.0.1:44999/v1/chat/completions'));
    assert.equal(capturedModel, 'qwen-local:latest');
  } finally {
    if (priorOllamaModel === undefined) delete process.env.MORAGENT_OLLAMA_MODEL;
    else process.env.MORAGENT_OLLAMA_MODEL = priorOllamaModel;
    resetApiModelCache();
    resetFetch();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Ollama reports missing installed tool-capable models instead of sending a phantom default', async () => {
  const priorOllamaModel = process.env.MORAGENT_OLLAMA_MODEL;
  delete process.env.MORAGENT_OLLAMA_MODEL;
  resetApiModelCache();
  const urls = [];
  try {
    setFetch(async (url) => {
      urls.push(String(url));
      return { ok: true, json: async () => ({ models: [
        { name: 'vectors', capabilities: ['embedding'] },
        { name: 'text-only', capabilities: ['completion'] },
      ] }) };
    });
    const result = await ollama.run({ root: os.tmpdir(), prompt: 'hello', baseUrl: 'http://localhost:11434' });
    assert.equal(result.ok, false);
    assert.match(result.error, /no installed tool-capable models|no informó modelos instalados capaces de usar herramientas/);
    assert.deepEqual(urls, ['http://localhost:11434/api/tags']);
  } finally {
    if (priorOllamaModel === undefined) delete process.env.MORAGENT_OLLAMA_MODEL;
    else process.env.MORAGENT_OLLAMA_MODEL = priorOllamaModel;
    resetApiModelCache();
    resetFetch();
  }
});

test('Ollama honors an explicit model and environment override without catalog discovery', async () => {
  const priorOllamaModel = process.env.MORAGENT_OLLAMA_MODEL;
  process.env.MORAGENT_OLLAMA_MODEL = 'from-environment';
  const models = [];
  try {
    setFetch(async (url, options) => {
      assert.match(String(url), /\/v1\/chat\/completions$/);
      models.push(JSON.parse(options.body).model);
      return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }) };
    });
    assert.equal((await ollama.run({ root: os.tmpdir(), prompt: 'test', model: 'explicit-model' })).ok, true);
    assert.equal((await ollama.run({ root: os.tmpdir(), prompt: 'test' })).ok, true);
    assert.deepEqual(models, ['explicit-model', 'from-environment']);
  } finally {
    if (priorOllamaModel === undefined) delete process.env.MORAGENT_OLLAMA_MODEL;
    else process.env.MORAGENT_OLLAMA_MODEL = priorOllamaModel;
    resetFetch();
  }
});

test('tools & loop: autonomy "readonly" permits read-only tools and refuses write/edit/bash', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-readonly-test-'));

  try {
    fs.writeFileSync(path.join(root, 'existing.txt'), 'readonly content');

    // 1. Schema generators in readonly only expose read_file, list_dir, grep
    const antTools = getAnthropicTools({ autonomy: 'readonly' });
    assert.equal(antTools.length, 3);
    assert.deepEqual(antTools.map((t) => t.name).sort(), ['grep', 'list_dir', 'read_file']);

    const oaiTools = getOpenAITools({ autonomy: 'readonly' });
    assert.equal(oaiTools.length, 3);
    assert.deepEqual(oaiTools.map((t) => t.function.name).sort(), ['grep', 'list_dir', 'read_file']);

    const gemTools = getGeminiTools({ autonomy: 'readonly' });
    assert.equal(gemTools[0].functionDeclarations.length, 3);
    assert.deepEqual(gemTools[0].functionDeclarations.map((t) => t.name).sort(), ['grep', 'list_dir', 'read_file']);

    // 2. Direct tool execution in readonly:
    // read_file works
    const readRes = await executeTool('read_file', { path: 'existing.txt' }, { root, autonomy: 'readonly' });
    assert.equal(readRes.ok, true);
    assert.equal(readRes.output, 'readonly content');

    // list_dir works
    const listRes = await executeTool('list_dir', { path: '.' }, { root, autonomy: 'readonly' });
    assert.equal(listRes.ok, true);

    // grep works
    const grepRes = await executeTool('grep', { pattern: 'readonly', path: '.' }, { root, autonomy: 'readonly' });
    assert.equal(grepRes.ok, true);

    // write_file refused
    const writeRes = await executeTool('write_file', { path: 'new.txt', content: 'fail' }, { root, autonomy: 'readonly' });
    assert.equal(writeRes.ok, false);
    assert.ok(writeRes.output.includes('readonly'));

    // edit_file refused
    const editRes = await executeTool('edit_file', { path: 'existing.txt', old_string: 'a', new_string: 'b' }, { root, autonomy: 'readonly' });
    assert.equal(editRes.ok, false);
    assert.ok(editRes.output.includes('readonly'));

    // bash refused
    const bashRes = await executeTool('bash', { command: 'echo "fail"' }, { root, autonomy: 'readonly' });
    assert.equal(bashRes.ok, false);
    assert.ok(bashRes.output.includes('readonly'));

    // 3. End-to-end loop with autonomy: 'readonly'
    let turn = 0;
    const events = [];
    setFetch(async (url, opts) => {
      turn++;
      const body = JSON.parse(opts.body);

      // Verify the tools sent in request are only the 3 read-only tools
      assert.equal(body.tools.length, 3);

      if (turn === 1) {
        // Model attempts to call write_file anyway
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      id: 'call_write_attempt',
                      type: 'function',
                      function: {
                        name: 'write_file',
                        arguments: JSON.stringify({ path: 'blocked.txt', content: 'should fail' }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        };
      }

      if (turn === 2) {
        // Tool result was returned with failure
        const toolMsg = body.messages[body.messages.length - 1];
        assert.equal(toolMsg.role, 'tool');
        assert.ok(toolMsg.content.includes('readonly'));

        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'Entendido, estoy en modo solo lectura.',
                },
              },
            ],
          }),
        };
      }

      throw new Error(`Unexpected turn ${turn}`);
    });

    const runRes = await openai.run({
      root,
      prompt: 'Crea el archivo blocked.txt',
      autonomy: 'readonly',
      apiKey: 'sk-fake-key',
      onEvent: (e) => events.push(e),
    });

    assert.equal(runRes.ok, true);
    assert.ok(runRes.text.includes('solo lectura'));
    assert.equal(fs.existsSync(path.join(root, 'blocked.txt')), false);

    const toolResultEvent = events.find((e) => e.type === 'tool_result');
    assert.equal(toolResultEvent.ok, false);
    assert.ok(toolResultEvent.summary.includes('readonly'));
  } finally {
    resetFetch();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
