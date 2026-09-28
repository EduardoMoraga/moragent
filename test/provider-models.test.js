import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetExec, setExec } from '../src/core/exec.js';
import { PROVIDERS } from '../src/providers/index.js';
import { resetCliModelCache } from '../src/providers/cli/models.js';
import { resetApiModelCache } from '../src/providers/api/models.js';
import { resetFetch, setFetch } from '../src/providers/api/loop.js';

const ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OLLAMA_HOST', 'CODEX_HOME', 'MORAGENT_HOME',
];
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  resetExec();
  resetFetch();
  resetCliModelCache();
  resetApiModelCache();
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

test('every provider exposes a never-throwing listModels function', () => {
  for (const provider of Object.values(PROVIDERS)) assert.equal(typeof provider.listModels, 'function', provider.id);
});

test('CLI model catalogs parse verified commands, use 3s timeouts and cache per process', async () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-codex-models-'));
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-configured"\n');
  process.env.CODEX_HOME = codexHome;
  const calls = [];
  setExec((command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'agy') return { code: 0, stdout: 'gemini-pro\tGemini Pro\ngemini-flash\tGemini Flash\n', stderr: '' };
    if (command === 'pi') return {
      code: 0,
      stdout: 'provider  model     context  max-out  thinking  images\nopenai    gpt-test  128K     16K      yes       no\n',
      stderr: '',
    };
    if (command === 'opencode') return { code: 0, stdout: 'anthropic/claude-test\nopenai/gpt-test\n', stderr: '' };
    throw new Error(`unexpected command: ${command}`);
  });

  try {
    assert.deepEqual(await PROVIDERS.agy.listModels(), [
      { id: 'gemini-pro', label: 'Gemini Pro' },
      { id: 'gemini-flash', label: 'Gemini Flash' },
    ]);
    assert.deepEqual(await PROVIDERS.pi.listModels(), [
      { id: 'openai/gpt-test', label: 'gpt-test (openai)' },
    ]);
    assert.deepEqual(await PROVIDERS.opencode.listModels(), [
      { id: 'anthropic/claude-test', label: 'anthropic/claude-test' },
      { id: 'openai/gpt-test', label: 'openai/gpt-test' },
    ]);
    assert.deepEqual((await PROVIDERS.codex.listModels()).map((model) => model.id), ['gpt-configured', 'o3']);
    assert.deepEqual((await PROVIDERS.claude.listModels()).map((model) => model.id), ['opus', 'sonnet', 'haiku', 'fable']);
    assert.ok((await PROVIDERS.gemini.listModels()).every((model) => model.note === 'sugerido'));

    await PROVIDERS.agy.listModels();
    assert.equal(calls.filter((call) => call.command === 'agy').length, 1, 'catalog is cached');
    assert.ok(calls.every((call) => call.options.timeoutMs === 3000));
    assert.deepEqual(calls.find((call) => call.command === 'agy').args, ['models']);
    assert.deepEqual(calls.find((call) => call.command === 'pi').args, ['--list-models']);
    assert.deepEqual(calls.find((call) => call.command === 'opencode').args, ['models']);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('CLI model catalogs never throw and mark fallbacks as suggested', async () => {
  setExec(() => { throw new Error('CLI unavailable'); });
  const models = await PROVIDERS.agy.listModels();
  assert.ok(models.length > 0);
  assert.ok(models.every((model) => model.note === 'sugerido'));
});

test('API model catalogs use provider endpoints, normalize responses and cache fetches', async () => {
  process.env.ANTHROPIC_API_KEY = 'anthropic-test';
  process.env.OPENAI_API_KEY = 'openai-test';
  process.env.OPENROUTER_API_KEY = 'openrouter-test';
  process.env.GEMINI_API_KEY = 'google-test';
  process.env.OLLAMA_HOST = 'http://localhost:11434';
  const calls = [];
  setFetch(async (url, options) => {
    calls.push({ url: String(url), options });
    assert.ok(options.signal instanceof AbortSignal);
    if (String(url).includes('api.anthropic.com')) return {
      ok: true, json: async () => ({ data: [{ id: 'claude-test', display_name: 'Claude Test' }] }),
    };
    if (String(url).includes('api.openai.com')) return {
      ok: true, json: async () => ({ data: [{ id: 'gpt-test' }] }),
    };
    if (String(url).includes('openrouter.ai')) return {
      ok: true, json: async () => ({ data: [{ id: 'vendor/model', name: 'Vendor Model' }] }),
    };
    if (String(url).includes('generativelanguage.googleapis.com')) return {
      ok: true,
      json: async () => ({ models: [
        { name: 'models/gemini-test', displayName: 'Gemini Test', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/embed-test', supportedGenerationMethods: ['embedContent'] },
      ] }),
    };
    if (String(url).endsWith('/api/tags')) return {
      ok: true, json: async () => ({ models: [{ name: 'llama-test:latest' }] }),
    };
    return { ok: false, json: async () => ({}) };
  });

  assert.deepEqual(await PROVIDERS.anthropic.listModels(), [{ id: 'claude-test', label: 'Claude Test' }]);
  assert.deepEqual(await PROVIDERS.openai.listModels(), [{ id: 'gpt-test', label: 'gpt-test' }]);
  assert.deepEqual(await PROVIDERS.openrouter.listModels(), [{ id: 'vendor/model', label: 'Vendor Model' }]);
  assert.deepEqual(await PROVIDERS.google.listModels(), [{ id: 'gemini-test', label: 'Gemini Test' }]);
  assert.deepEqual(await PROVIDERS.ollama.listModels(), [{ id: 'llama-test:latest', label: 'llama-test:latest' }]);

  await PROVIDERS.openai.listModels();
  assert.equal(calls.filter((call) => call.url.includes('api.openai.com')).length, 1, 'catalog is cached');
  assert.equal(calls.length, 5);
  assert.ok(calls.every((call) => call.options.method === 'GET'));
  assert.match(calls.find((call) => call.url.includes('api.openai.com')).options.headers.authorization, /^Bearer /);
  assert.equal(calls.find((call) => call.url.includes('api.anthropic.com')).options.headers['anthropic-version'], '2023-06-01');
});

test('API model catalogs never throw and return suggested fallbacks', async () => {
  process.env.ANTHROPIC_API_KEY = 'anthropic-test';
  setFetch(async () => { throw new Error('network unavailable'); });
  const models = await PROVIDERS.anthropic.listModels();
  assert.deepEqual(models, [{ id: 'claude-sonnet-5', label: 'claude-sonnet-5', note: 'sugerido' }]);
});
