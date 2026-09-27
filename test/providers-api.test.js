import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  getKey,
  setKey,
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
} from '../src/providers/api/loop.js';

import { anthropic } from '../src/providers/api/anthropic.js';
import { openai } from '../src/providers/api/openai.js';
import { openrouter } from '../src/providers/api/openrouter.js';
import { ollama } from '../src/providers/api/ollama.js';
import { google } from '../src/providers/api/google.js';

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
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tools: bash autonomy "ask" refuses, "auto" executes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-bash-test-'));

  try {
    // autonomy 'ask' -> refuse
    const askRes = await executeTool('bash', { command: 'echo "hello"' }, { root, autonomy: 'ask' });
    assert.equal(askRes.ok, false);
    assert.ok(askRes.summary.includes('Refused'));

    // autonomy 'auto' -> runs
    const autoRes = await executeTool('bash', { command: 'echo "hello from bash"' }, { root, autonomy: 'auto' });
    assert.equal(autoRes.ok, true);
    assert.equal(autoRes.output.trim(), 'hello from bash');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tools: schema generators for Anthropic, OpenAI, and Gemini', () => {
  const ant = getAnthropicTools();
  assert.ok(Array.isArray(ant) && ant.length >= 6);
  assert.ok(ant.find((t) => t.name === 'read_file')?.input_schema);

  const oai = getOpenAITools();
  assert.ok(Array.isArray(oai) && oai.length >= 6);
  assert.equal(oai[0].type, 'function');

  const gem = getGeminiTools();
  assert.ok(Array.isArray(gem) && gem.length === 1);
  assert.ok(Array.isArray(gem[0].functionDeclarations) && gem[0].functionDeclarations.length >= 6);
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

test('loop: openrouter and ollama runs execute with appropriate headers and defaults', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-or-ollama-test-'));

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

    // Ollama run (no key required)
    setFetch(async (url) => {
      capturedUrl = url;
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
      baseUrl: 'http://localhost:11434',
    });
    assert.equal(ollamaRes.ok, true);
    assert.equal(ollamaRes.text, 'hello from ollama');
    assert.ok(capturedUrl.includes('localhost:11434/v1/chat/completions'));
  } finally {
    resetFetch();
    fs.rmSync(root, { recursive: true, force: true });
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


