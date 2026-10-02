import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import compatible from '../src/providers/api/compatible.js';
import { ollama } from '../src/providers/api/ollama.js';
import { getEndpoint, getKey, setEndpoint, setKey } from '../src/providers/credentials.js';
import { resetApiModelCache } from '../src/providers/api/models.js';
import { resetFetch, setFetch } from '../src/providers/api/loop.js';
import { createEngine } from '../src/engine/index.js';
import { defaultConfig } from '../src/core/config.js';
import { scaffold } from '../src/commands/init.js';
import { listTasks } from '../src/bus/tasks.js';

test('a compatible endpoint can be configured and used without an adapter or mandatory key', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-compatible-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-compatible-project-'));
  const previous = process.env.MORAGENT_HOME;
  const previousUrl = process.env.MORAGENT_COMPATIBLE_BASE_URL;
  const previousKey = process.env.MORAGENT_COMPATIBLE_API_KEY;
  const previousModel = process.env.MORAGENT_COMPATIBLE_MODEL;
  try {
    process.env.MORAGENT_HOME = home;
    delete process.env.MORAGENT_COMPATIBLE_BASE_URL;
    delete process.env.MORAGENT_COMPATIBLE_API_KEY;
    delete process.env.MORAGENT_COMPATIBLE_MODEL;
    assert.equal((await compatible.status()).ready, false);
    assert.throws(() => setEndpoint('compatible', 'file:///tmp/model'), /HTTP\(S\)/);
    setEndpoint('compatible', 'http://127.0.0.1:7777/v1/');
    assert.equal(getEndpoint('compatible'), 'http://127.0.0.1:7777/v1');
    assert.equal(getKey('compatible'), null);

    const calls = [];
    setFetch(async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith('/models')) return { ok: true, json: async () => ({ data: [{ id: 'toy-model' }, { id: 'text-embedding-toy' }] }) };
      return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: 'ready' } }] }) };
    });
    assert.equal((await compatible.status()).ready, true);
    assert.deepEqual(await compatible.listModels(), [{ id: 'toy-model', label: 'toy-model' }]);
    const result = await compatible.run({ root, prompt: 'hello', onEvent() {} });
    assert.equal(result.ok, true);
    assert.equal(result.text, 'ready');
    assert.equal(calls.at(-1).url, 'http://127.0.0.1:7777/v1/chat/completions');
    assert.equal(JSON.parse(calls.at(-1).options.body).model, 'toy-model');

    resetApiModelCache();
    setFetch(async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith('/models')) return { ok: false, status: 404 };
      return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: 'manual model ready' } }] }) };
    });
    assert.equal((await compatible.status()).ready, true, 'a reachable chat server need not expose /models');
    assert.deepEqual(await compatible.listModels(), []);
    const missingModel = await compatible.run({ root, prompt: 'hello', onEvent() {} });
    assert.equal(missingModel.ok, false);
    assert.match(missingModel.error, /modelo|model/);
    const manual = await compatible.run({ root, prompt: 'hello', model: 'manual-chat', onEvent() {} });
    assert.equal(manual.ok, true);
    assert.equal(JSON.parse(calls.at(-1).options.body).model, 'manual-chat');

    setKey('compatible', 'secret-key');
    assert.equal(getKey('compatible'), 'secret-key');
    assert.equal(fs.statSync(path.join(home, 'credentials.json')).mode & 0o777, 0o600);
  } finally {
    resetFetch(); resetApiModelCache();
    if (previous === undefined) delete process.env.MORAGENT_HOME; else process.env.MORAGENT_HOME = previous;
    if (previousUrl === undefined) delete process.env.MORAGENT_COMPATIBLE_BASE_URL; else process.env.MORAGENT_COMPATIBLE_BASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.MORAGENT_COMPATIBLE_API_KEY; else process.env.MORAGENT_COMPATIBLE_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.MORAGENT_COMPATIBLE_MODEL; else process.env.MORAGENT_COMPATIBLE_MODEL = previousModel;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('compatible API plan repair reaches HTTP without tools while workers keep them', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-compatible-repair-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-compatible-repair-project-'));
  const previous = {
    MORAGENT_HOME: process.env.MORAGENT_HOME,
    MORAGENT_COMPATIBLE_BASE_URL: process.env.MORAGENT_COMPATIBLE_BASE_URL,
    MORAGENT_COMPATIBLE_MODEL: process.env.MORAGENT_COMPATIBLE_MODEL,
    MORAGENT_COMPATIBLE_API_KEY: process.env.MORAGENT_COMPATIBLE_API_KEY,
  };
  let engine;
  try {
    process.env.MORAGENT_HOME = home;
    process.env.MORAGENT_COMPATIBLE_BASE_URL = 'http://127.0.0.1:7777/v1';
    process.env.MORAGENT_COMPATIBLE_MODEL = 'toy-chat';
    delete process.env.MORAGENT_COMPATIBLE_API_KEY;
    const config = defaultConfig({ project: 'repair', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
    config.orchestrator = 'compatible';
    config.crew.backend.provider = 'compatible';
    scaffold(root, config);
    const calls = [];
    setFetch(async (url, options = {}) => {
      if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ data: [{ id: 'toy-chat' }] }) };
      assert.equal(String(url), 'http://127.0.0.1:7777/v1/chat/completions');
      const body = JSON.parse(options.body);
      calls.push(body);
      let message;
      if (calls.length === 1) {
        message = { role: 'assistant', content: '```moragent-plan\n{"tasks":[{"id":"t1","role":"invented","prompt":"Create exact.txt"}]}\n```' };
      } else if (calls.length === 2) {
        message = { role: 'assistant', content: '```moragent-plan\n{"tasks":[{"id":"t1","role":"backend","prompt":"Create exact.txt","checks":[{"type":"file_text","path":"exact.txt","lines":["OK"],"finalNewline":true}]}]}\n```' };
      } else if (calls.length === 3) {
        message = { role: 'assistant', content: null, tool_calls: [{ id: 'write_1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'exact.txt', lines: ['OK'], final_newline: true }) } }] };
      } else if (calls.length === 4) {
        message = { role: 'assistant', content: 'Created exact.txt.' };
      } else {
        message = { role: 'assistant', content: 'Reviewed.' };
      }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message }] }) };
    });
    engine = await createEngine({ root, config, providers: { listProviders: () => [compatible], getProvider: () => compatible }, lang: 'en' });
    await engine.send('Create exact.txt containing exactly OK with a final LF newline.');
    assert.equal(calls.length, 5);
    assert.ok(calls[0].tools?.length > 0);
    assert.equal(Object.hasOwn(calls[1], 'tools'), false, 'plan repair must not send tools');
    assert.ok(calls[1].messages[0].content.length < calls[0].messages[0].content.length);
    assert.ok(calls[2].tools.some((tool) => tool.function.name === 'write_file'), 'worker tools remain available');
    assert.equal(fs.readFileSync(path.join(root, 'exact.txt'), 'utf8'), 'OK\n');
    assert.equal(listTasks(root)[0].status, 'done');
  } finally {
    engine?.stop();
    resetFetch(); resetApiModelCache();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('local provider status checks finish when fetch ignores abort', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-status-timeout-'));
  const previous = process.env.MORAGENT_HOME;
  try {
    process.env.MORAGENT_HOME = home;
    setEndpoint('compatible', 'http://127.0.0.1:7777/v1');
    setFetch(() => new Promise(() => {}));
    const checks = Promise.all([
      compatible.status({ timeoutMs: 30 }),
      ollama.status({ timeoutMs: 30 }),
    ]);
    let guard;
    const result = await Promise.race([
      checks,
      new Promise((resolve) => { guard = setTimeout(() => resolve('hung'), 200); }),
    ]);
    clearTimeout(guard);
    assert.notEqual(result, 'hung');
    assert.deepEqual(result.map((status) => status.ready), [false, false]);
  } finally {
    resetFetch();
    if (previous === undefined) delete process.env.MORAGENT_HOME; else process.env.MORAGENT_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('API-only first run works in a separate process with no agent CLIs or git on PATH', { timeout: 30000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-api-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-api-project-'));
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/models') {
      response.end(JSON.stringify({ data: [{ id: 'toy-chat' }] }));
      return;
    }
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404).end('{}');
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    let message;
    if (requests.length === 1) {
      message = { role: 'assistant', content: '```moragent-plan\n{"tasks":[{"id":"t1","role":"executor","prompt":"Create api-only.txt"}]}\n```' };
    } else if (requests.length === 2) {
      message = { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'api-only.txt', content: 'API only\n' }) } }] };
    } else if (requests.length === 3) {
      message = { role: 'assistant', content: 'Created api-only.txt.' };
    } else {
      message = { role: 'assistant', content: 'Reviewed.' };
    }
    response.end(JSON.stringify({ choices: [{ message }] }));
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const engineUrl = new URL('../src/engine/index.js', import.meta.url).href;
    const initUrl = new URL('../src/commands/init.js', import.meta.url).href;
    const tasksUrl = new URL('../src/bus/tasks.js', import.meta.url).href;
    const doctorUrl = new URL('../src/commands/doctor.js', import.meta.url).href;
    const code = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';
      import { createEngine } from ${JSON.stringify(engineUrl)};
      import { installedClis } from ${JSON.stringify(initUrl)};
      import { listTasks } from ${JSON.stringify(tasksUrl)};
      import { diagnose } from ${JSON.stringify(doctorUrl)};
      const root = ${JSON.stringify(project)};
      assert.deepEqual(installedClis(), []);
      const engine = await createEngine({ root: null, cwd: root, lang: 'en' });
      await engine.refreshProviders();
      assert.equal(engine.store.state.orchestrator.provider, 'compatible');
      await engine.send('Build an API-only file');
      assert.equal(fs.readFileSync(path.join(root, 'api-only.txt'), 'utf8'), 'API only\\n');
      assert.equal(listTasks(root)[0].status, 'done');
      const config = JSON.parse(fs.readFileSync(path.join(root, '.moragent', 'moragent.json'), 'utf8'));
      assert.equal(config.orchestrator, 'compatible');
      const diagnosis = await diagnose(root);
      assert.equal(diagnosis.ok, true, JSON.stringify(diagnosis.checks.filter((item) => item.status === 'fail')));
      assert.equal(diagnosis.checks.find((item) => item.group === 'providers' && item.id === 'compatible').status, 'ok');
      assert.equal(diagnosis.checks.filter((item) => item.group === 'clis' && item.status === 'ok').length, 0);
      const reopened = await createEngine({ root });
      await reopened.refreshProviders();
      assert.equal(reopened.store.state.orchestrator.provider, 'compatible');
      reopened.stop();
      engine.stop();
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: project,
      env: {
        PATH: '',
        MORAGENT_HOME: home,
        MORAGENT_COMPATIBLE_BASE_URL: baseUrl,
        MORAGENT_COMPATIBLE_MODEL: 'toy-chat',
        MORAGENT_LANG: 'en',
        OLLAMA_HOST: 'http://127.0.0.1:1',
      },
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    const exit = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
    assert.deepEqual(exit, { code: 0, signal: null }, `${stdout}\n${stderr}`);
    assert.equal(requests.length, 4);
    assert.ok(requests.every((body) => body.model === 'toy-chat'));
    assert.ok(requests[1].tools.some((tool) => tool.function.name === 'write_file'));
    assert.ok(requests[2].messages.some((message) => message.role === 'tool'));
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});
