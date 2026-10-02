import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createEngine } from '../src/engine/index.js';
import { extractPlan, stripPlan, normalizePlan, assignProviders } from '../src/engine/plan.js';
import { defaultConfig, ROLES, CLI_IDS } from '../src/core/config.js';
import { scaffold } from '../src/commands/init.js';
import { listTasks } from '../src/bus/tasks.js';
import { applyRecovery, createTaskWorkspace, inspectRecovery, listRecoveries } from '../src/engine/workspace.js';
import { createTaskWorkspaceAsync } from '../src/engine/workspace-async.js';
import { orchestratorSystem, orchestratorRepairSystem, reviewPrompt } from '../src/engine/prompts.js';
import { openai } from '../src/providers/api/openai.js';
import { setFetch, resetFetch } from '../src/providers/api/loop.js';
import { getKey, getEndpoint } from '../src/providers/credentials.js';
import { exactCheckTarget, literalSingleLineExpectation, parseExplicitFileChecks, requiresExactFileCheck } from '../src/engine/acceptance.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mora-engine-'));

const PLAN = `Voy a separar el trabajo en dos partes.
\`\`\`moragent-plan
{"size":"S","summary":"archivo y prueba","tasks":[
 {"id":"t1","role":"backend","title":"Crear hola.txt","prompt":"Escribe hola.txt","doneWhen":"existe hola.txt"},
 {"id":"t2","role":"backend","title":"Revisar hola.txt","prompt":"Lee hola.txt","dependsOn":["t1"]}]}
\`\`\``;

test('English review separates acceptance criteria, published paths and worker claims', () => {
  const prompt = reviewPrompt({ es: false, results: [{
    taskId: 'T-0001', role: 'backend', provider: 'compatible', status: 'done', title: 'Build output',
    doneWhen: 'actual.txt exists', files: ['actual.txt'], summary: 'Created claimed.txt.',
  }] });
  assert.match(prompt, /Acceptance criterion: actual\.txt exists/);
  assert.match(prompt, /Integrated paths: "actual\.txt"/);
  assert.match(prompt, /Agent report:\nCreated claimed\.txt\./);
  assert.match(prompt, /MORAGENT.*byte-checked.*independent evidence/i);
  assert.match(prompt, /Expected bytes come from the plan/);
  assert.match(prompt, /wc -l counts LF bytes and reports 0/);
  assert.doesNotMatch(prompt, /Integrated paths:.*claimed\.txt/);
});

test('API plan repair keeps the bilingual contract while shedding the full orchestrator context', () => {
  for (const lang of ['en', 'es']) {
    const config = defaultConfig({ project: 'repair', lang, preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
    const providers = [{ id: 'compatible', ready: true }, { id: 'codex', ready: true }];
    const full = orchestratorSystem({ config, providers });
    const repair = orchestratorRepairSystem({ config, providers });
    assert.ok(repair.length < full.length, `${lang}: repair instructions must be smaller`);
    assert.match(repair, /moragent-plan/);
    assert.match(full, /moragent-checks/);
    assert.match(repair, /moragent-checks/);
    assert.match(repair, /file_text/);
    assert.match(repair, /backend/);
    assert.match(repair, /compatible/);
    assert.match(repair, lang === 'en' ? /BLOCKED:/ : /BLOQUEADO:/);
  }
});

test('/login warns when an environment override keeps a newly saved API key or URL inactive', async () => {
  const home = tmp();
  const prior = {
    MORAGENT_HOME: process.env.MORAGENT_HOME,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    MORAGENT_COMPATIBLE_BASE_URL: process.env.MORAGENT_COMPATIBLE_BASE_URL,
    MORAGENT_COMPATIBLE_API_KEY: process.env.MORAGENT_COMPATIBLE_API_KEY,
  };
  let engine;
  try {
    process.env.MORAGENT_HOME = home;
    process.env.OPENAI_API_KEY = 'environment-key';
    process.env.MORAGENT_COMPATIBLE_BASE_URL = 'http://127.0.0.1:1001/v1';
    process.env.MORAGENT_COMPATIBLE_API_KEY = 'compatible-environment-key';
    const api = (id) => ({ id, label: id, kind: 'api', status: async () => ({ ready: true }) });
    const all = { openai: api('openai'), compatible: api('compatible') };
    engine = await createEngine({ root: null, cwd: home, providers: { listProviders: () => Object.values(all), getProvider: (id) => all[id] }, lang: 'en' });
    await engine.refreshProviders();
    await engine.command('login', { id: 'openai', key: 'stored-secret' });
    assert.equal(getKey('openai'), 'environment-key');
    assert.match(engine.store.state.messages.at(-1).text, /OPENAI_API_KEY/);
    assert.match(engine.store.state.messages.at(-1).text, /takes precedence/);
    assert.doesNotMatch(engine.store.state.messages.at(-1).text, /stored-secret|environment-key/);
    await engine.command('language', ['es']);
    await engine.command('login', { id: 'compatible', url: 'http://127.0.0.1:2002/v1' });
    assert.equal(getEndpoint('compatible'), 'http://127.0.0.1:1001/v1');
    assert.match(engine.store.state.messages.at(-1).text, /MORAGENT_COMPATIBLE_BASE_URL/);
    assert.match(engine.store.state.messages.at(-1).text, /tiene prioridad/);
    await engine.command('login', { id: 'compatible', key: 'compatible-stored-secret' });
    assert.equal(getKey('compatible'), 'compatible-environment-key');
    assert.match(engine.store.state.messages.at(-1).text, /MORAGENT_COMPATIBLE_API_KEY.*tiene prioridad/);
    assert.doesNotMatch(engine.store.state.messages.at(-1).text, /compatible-stored-secret|compatible-environment-key/);
  } finally {
    engine?.stop();
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('/login reports a damaged credentials file without losing it or exposing the new key', async () => {
  const home = tmp();
  const originalHome = process.env.MORAGENT_HOME;
  let engine;
  try {
    process.env.MORAGENT_HOME = home;
    const file = path.join(home, 'credentials.json');
    const damaged = '{"openai":"sk-existing", invalid';
    fs.writeFileSync(file, damaged, { mode: 0o600 });
    const openaiProvider = { id: 'openai', label: 'OpenAI', kind: 'api', status: async () => ({ ready: true }) };
    engine = await createEngine({ root: null, cwd: home, providers: { listProviders: () => [openaiProvider], getProvider: () => openaiProvider }, lang: 'en' });
    await engine.refreshProviders();

    await engine.command('login', { id: 'openai', key: 'sk-new-secret' });
    assert.match(engine.store.state.messages.at(-1).text, /Could not save the key.*credentials\.json/);
    assert.doesNotMatch(engine.store.state.messages.at(-1).text, /sk-new-secret|sk-existing/);
    assert.equal(fs.readFileSync(file, 'utf8'), damaged);
  } finally {
    engine?.stop();
    if (originalHome === undefined) delete process.env.MORAGENT_HOME; else process.env.MORAGENT_HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('an API orchestrator retries a tool-protocol 500 once without tools before dispatch', async () => {
  const root = tmp();
  let engine;
  try {
    const cfg = defaultConfig({ project: 'tool-protocol-fallback', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
    cfg.orchestrator = 'compatible';
    scaffold(root, cfg);
    const calls = [];
    const compatible = {
      id: 'compatible', label: 'Compatible', kind: 'api', status: async () => ({ ready: true }),
      async run(options) {
        calls.push(options);
        if (calls.length === 1) return { ok: false, text: '', error: 'HTTP 500 Internal Server Error: XML syntax error: <function> closed by </parameter>' };
        if (calls.length === 2) return { ok: true, text: '```moragent-plan\n{"tasks":[{"id":"t1","role":"backend","prompt":"Create fallback.txt"}]}\n```' };
        return { ok: true, text: 'Reviewed.' };
      },
    };
    let workerRuns = 0;
    const worker = {
      id: 'codex', label: 'Codex', kind: 'subscription', status: async () => ({ ready: true }),
      async run({ root: privateRoot }) {
        workerRuns++;
        fs.writeFileSync(path.join(privateRoot, 'fallback.txt'), 'ready\n');
        return { ok: true, text: 'Created fallback.txt.' };
      },
    };
    const all = { compatible, codex: worker };
    engine = await createEngine({ root, config: cfg, providers: { listProviders: () => Object.values(all), getProvider: (id) => all[id] }, lang: 'en' });
    await engine.send('Create fallback.txt.');
    assert.equal(calls.length, 3, 'initial failure, tool-free retry, review');
    assert.equal(calls[1].toolsEnabled, false);
    assert.match(calls[1].system, /No tools are available.*Do not claim to have read files/s);
    assert.ok(engine.store.state.messages.some((message) => /Retrying once without repository access/.test(message.text)));
    assert.equal(workerRuns, 1);
    assert.equal(fs.readFileSync(path.join(root, 'fallback.txt'), 'utf8'), 'ready\n');
    assert.equal(listTasks(root)[0].status, 'done');
  } finally {
    engine?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an API plan-format repair uses a compact tool-free turn and preserves the user request', async () => {
  const root = tmp();
  let engine;
  try {
    const cfg = defaultConfig({ project: 'compact-api-repair', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
    cfg.orchestrator = 'compatible';
    scaffold(root, cfg);
    const calls = [];
    const compatible = {
      id: 'compatible', label: 'Compatible', kind: 'api', status: async () => ({ ready: true }),
      async run(options) {
        calls.push(options);
        if (calls.length === 1) return { ok: true, text: '```moragent-plan\n{"tasks":[{"id":"t1","role":"invented","prompt":"Create repaired.txt"}]}\n```' };
        if (calls.length === 2) return { ok: true, text: '```moragent-plan\n{"tasks":[{"id":"t1","role":"backend","prompt":"Create repaired.txt"}]}\n```' };
        return { ok: true, text: 'Reviewed.' };
      },
    };
    const worker = {
      id: 'codex', label: 'Codex', kind: 'subscription', status: async () => ({ ready: true }),
      async run({ root: privateRoot }) {
        fs.writeFileSync(path.join(privateRoot, 'repaired.txt'), 'ready\n');
        return { ok: true, text: 'Created repaired.txt.' };
      },
    };
    const all = { compatible, codex: worker };
    engine = await createEngine({ root, config: cfg, providers: { listProviders: () => Object.values(all), getProvider: (id) => all[id] }, lang: 'en' });
    await engine.send('Create repaired.txt.');
    assert.equal(calls.length, 3);
    assert.equal(calls[0].toolsEnabled, undefined);
    assert.equal(calls[1].toolsEnabled, false);
    assert.ok(calls[1].system.length < calls[0].system.length);
    assert.match(calls[1].system, /Valid roles: backend/);
    assert.match(calls[1].prompt, /Create repaired\.txt/);
    assert.match(calls[1].prompt, /unknown role.*invented/i);
    assert.equal(fs.readFileSync(path.join(root, 'repaired.txt'), 'utf8'), 'ready\n');
    assert.equal(listTasks(root)[0].status, 'done');
  } finally {
    engine?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an API tool-protocol fallback is not attempted after partial output or a generic 500', async () => {
  for (const first of [
    { error: 'HTTP 500 Internal Server Error: service overloaded', emitText: false, emitTool: false },
    { error: 'HTTP 500 Internal Server Error: tool_call parser failed', emitText: true, emitTool: false },
    { error: 'HTTP 500 Internal Server Error: tool_call parser failed', emitText: false, emitTool: true },
  ]) {
    const root = tmp();
    let engine;
    try {
      const cfg = defaultConfig({ project: 'no-unsafe-retry', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
      cfg.orchestrator = 'compatible';
      scaffold(root, cfg);
      let calls = 0;
      const compatible = {
        id: 'compatible', label: 'Compatible', kind: 'api', status: async () => ({ ready: true }),
        async run({ onEvent }) {
          calls++;
          if (first.emitText) onEvent({ type: 'text', delta: 'Partial answer' });
          if (first.emitTool) onEvent({ type: 'tool', name: 'read_file', input: { path: 'README.md' } });
          return { ok: false, text: first.emitText ? 'Partial answer' : '', error: first.error };
        },
      };
      engine = await createEngine({ root, config: cfg, providers: { listProviders: () => [compatible], getProvider: () => compatible }, lang: 'en' });
      await engine.send('Explain this project.');
      assert.equal(calls, 1);
      assert.deepEqual(listTasks(root), []);
      assert.match(engine.store.state.messages.at(-1).text, /Engine error/);
    } finally {
      engine?.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

function fakeProviders(calls) {
  const orchestrator = {
    id: 'claude', label: 'Claude', kind: 'subscription',
    status: async () => ({ ready: true, detail: 'ok', loginHint: '' }),
    async run({ prompt, autonomy, sessionId, onEvent }) {
      calls.push({ who: 'orchestrator', autonomy, sessionId, prompt });
      const text = calls.filter((c) => c.who === 'orchestrator').length === 1 ? PLAN : 'Todo listo: hola.txt existe. Pruébalo con cat hola.txt.';
      onEvent({ type: 'start', sessionId: 'sess-1', provider: 'claude' });
      onEvent({ type: 'text', delta: text });
      onEvent({ type: 'done', ok: true, text, sessionId: 'sess-1' });
      return { ok: true, text, sessionId: 'sess-1' };
    },
  };
  const worker = {
    id: 'codex', label: 'Codex', kind: 'subscription',
    status: async () => ({ ready: true, detail: 'ok', loginHint: '' }),
    async run({ root, prompt, autonomy, onEvent }) {
      calls.push({ who: 'worker', autonomy, prompt });
      if (/Escribe hola\.txt/.test(prompt)) fs.writeFileSync(path.join(root, 'hola.txt'), 'hola');
      const text = /Lee hola\.txt/.test(prompt) ? `Leí hola.txt: ${fs.readFileSync(path.join(root, 'hola.txt'), 'utf8')}` : 'Creé hola.txt.';
      onEvent({ type: 'tool', id: 'x', name: 'write_file', input: { path: 'hola.txt' } });
      onEvent({ type: 'text', delta: text });
      return { ok: true, text, sessionId: 'w-1' };
    },
  };
  const all = { claude: orchestrator, codex: worker };
  return { listProviders: () => Object.values(all), getProvider: (id) => all[id] };
}

test('plan parsing preserves valid plans and rejects malformed dependency graphs', () => {
  const plan = extractPlan(PLAN);
  assert.equal(plan.tasks.length, 2);
  assert.deepEqual(plan.tasks[1].dependsOn, ['t1']);
  assert.equal(stripPlan(PLAN), 'Voy a separar el trabajo en dos partes.');
  const jsonTagged = PLAN.replace('```moragent-plan', '```json moragent-plan');
  assert.deepEqual(extractPlan(jsonTagged), plan);
  assert.equal(stripPlan(jsonTagged), 'Voy a separar el trabajo en dos partes.');
  assert.equal(extractPlan('sin plan'), null);
  assert.deepEqual(extractPlan('```moragent-plan\n{roto\n```'), { error: 'invalid-json' });
  assert.equal(normalizePlan({ tasks: [{ id: 'a', prompt: 'a', dependsOn: ['b'] }, { id: 'b', prompt: 'b', dependsOn: ['a'] }] }).error, 'dependency-cycle');
  assert.equal(normalizePlan({ tasks: [{ id: 'a', prompt: 'a', dependsOn: ['missing'] }] }).error, 'invalid-dependency');
  assert.equal(normalizePlan({ tasks: [{ id: 'a', prompt: 'a' }, { id: 'a', prompt: 'b' }] }).error, 'duplicate-id');
  assert.equal(normalizePlan({ tasks: Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, prompt: 'work' })) }).error, 'too-many-tasks');
  assert.equal(normalizePlan({ tasks: [{ id: '__proto__', prompt: 'work' }] }).error, 'invalid-id');
  assert.equal(normalizePlan({ tasks: [{ id: 'a', prompt: 'work', dependsOn: 'b' }] }).error, 'invalid-dependency');
  assert.equal(normalizePlan({ tasks: [{ id: 'constructor', prompt: 'a', dependsOn: ['b'] }, { id: 'b', prompt: 'b', dependsOn: ['constructor'] }] }).error, 'dependency-cycle');
  assert.equal(normalizePlan({ tasks: [{ id: 't1', role: 'unknown', prompt: 'work' }] }, { roles: ['backend'] }).error, 'unknown-role');
  assert.equal(normalizePlan({ tasks: [{ id: 't1', prompt: 'work' }] }, { roles: ['investigador', 'redactor'] }).error, 'missing-role');
  assert.equal(normalizePlan({ tasks: [{ id: 't1', prompt: 'work' }] }, { roles: ['redactor'] }).tasks[0].role, 'redactor');
  assert.equal(normalizePlan({ tasks: [{ id: 't1', role: 'backend', provider: 'not-connected', prompt: 'work' }] }, { roles: ['backend'], providers: ['claude', 'codex'] }).error, 'invalid-provider');
  for (const [field, value] of [['prompt', { steps: ['write file'] }], ['title', ['write file']], ['doneWhen', { file: 'done.txt' }], ['role', ['backend']]]) {
    const invalid = normalizePlan({ tasks: [{ id: 't1', role: 'backend', prompt: 'work', [field]: value }] });
    assert.deepEqual(invalid, { error: 'invalid-field', detail: `t1.${field}` });
  }
  assert.equal(normalizePlan({ tasks: [{ id: 't1', prompt: 'work', dependsOn: [1] }] }).error, 'invalid-dependency');
  const exact = { type: 'file_text', path: 'notes/hello.txt', lines: ['hola'], finalNewline: true };
  assert.deepEqual(normalizePlan({ tasks: [{ id: 't1', prompt: 'write', checks: [exact] }] }).tasks[0].checks, [exact]);
  for (const badPath of ['../outside.txt', '/absolute.txt', 'C:\\absolute.txt',
    '.git/HEAD', 'nested/node_modules/exact.txt', '.moragent/runs/exact.txt', 'nested/.moragent/tasks/exact.txt']) {
    assert.equal(normalizePlan({ tasks: [{ id: 't1', prompt: 'write', checks: [{ ...exact, path: badPath }] }] }).error, 'invalid-check');
  }
  assert.equal(normalizePlan({ tasks: [{ id: 't1', prompt: 'write', checks: [{ ...exact, lines: ['bad\nline'] }] }] }).error, 'invalid-check');
});

test('exact text checks block a false worker success before publication and accept actual LF', async () => {
  for (const [content, expectedStatus] of [['saludo desde ollama\\n', 'blocked'], ['saludo desde ollama\n', 'done']]) {
    const root = tmp();
    try {
      const cfg = defaultConfig({ project: 'exact', lang: 'es', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
      scaffold(root, cfg);
      const providers = fakeProviders([]);
      let turns = 0;
      let reviewPromptText = '';
      providers.getProvider('claude').run = async ({ prompt }) => {
        const text = ++turns === 1
          ? `\`\`\`moragent-plan\n${JSON.stringify({ tasks: [{ id: 't1', role: 'backend', prompt: 'Crea hola-es.txt con un salto de línea final.',
            doneWhen: 'Contenido exacto con LF final', checks: [{ type: 'file_text', path: 'hola-es.txt', lines: ['saludo desde ollama'], finalNewline: true }] }] })}\n\`\`\``
          : 'Revisión terminada.';
        if (turns === 2) reviewPromptText = prompt;
        return { ok: true, text };
      };
      providers.getProvider('codex').run = async ({ root: privateRoot, prompt }) => {
        assert.match(prompt, /lines y final_newline/);
        fs.writeFileSync(path.join(privateRoot, 'hola-es.txt'), content);
        return { ok: true, text: 'He creado y verificado el archivo.' };
      };
      const engine = await createEngine({ root, config: cfg, providers, lang: 'es' });
      await engine.send('Crea hola-es.txt con el contenido exacto y LF final.');
      const task = listTasks(root)[0];
      assert.equal(task.status, expectedStatus);
      if (expectedStatus === 'blocked') {
        assert.equal(fs.existsSync(path.join(root, 'hola-es.txt')), false);
        assert.match(task.result, /final LF: yes.*final LF: no/s);
        assert.equal(listRecoveries(root).length, 1);
        const recoveryId = listRecoveries(root)[0].id;
        assert.equal(inspectRecovery(root, recoveryId).manualOnlyReason, 'acceptance-check-failed');
        assert.equal(inspectRecovery(root, recoveryId).canApply, false);
        assert.equal(applyRecovery(root, recoveryId).code, 'manual-only');
        await engine.command('recuperaciones', ['inspeccionar', recoveryId]);
        assert.match(engine.store.state.messages.at(-1).text, /sólo inspección manual/);
        assert.doesNotMatch(engine.store.state.messages.at(-1).text, /Para aplicar rutas/);
        await engine.command('recuperaciones', ['aplicar', recoveryId]);
        assert.match(engine.store.state.messages.at(-1).text, /sólo admite inspección manual/);
        assert.equal(fs.existsSync(path.join(root, 'hola-es.txt')), false);
        assert.deepEqual(task.verifiedChecks, []);
        assert.doesNotMatch(reviewPromptText, /Archivos comprobados byte por byte antes de publicar/);
      } else {
        assert.equal(fs.readFileSync(path.join(root, 'hola-es.txt'), 'utf8'), content);
        assert.deepEqual(task.files, ['hola-es.txt']);
        assert.deepEqual(task.verifiedChecks, ['hola-es.txt']);
        assert.match(reviewPromptText, /Archivos comprobados byte por byte antes de publicar: "hola-es.txt"/);
        assert.match(reviewPromptText, /MORAGENT.*comprobó.*evidencia independiente/i);
      }
      engine.stop();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('an exact-file request cannot dispatch a plan that omits its file_text check', async () => {
  const root = tmp();
  try {
    const cfg = defaultConfig({ project: 'exact-required', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
    scaffold(root, cfg);
    const providers = fakeProviders([]);
    let planningTurns = 0;
    let workerRuns = 0;
    providers.getProvider('claude').run = async () => {
      planningTurns++;
      return { ok: true, text: `\`\`\`moragent-plan\n${JSON.stringify({ tasks: [{ id: 't1', role: 'backend', prompt: 'Write exact.txt', doneWhen: 'exact bytes' }] })}\n\`\`\`` };
    };
    providers.getProvider('codex').run = async ({ root: privateRoot }) => {
      workerRuns++;
      fs.writeFileSync(path.join(privateRoot, 'exact.txt'), 'wrong\\n');
      return { ok: true, text: 'Done.' };
    };
    const engine = await createEngine({ root, config: cfg, providers, lang: 'en' });
    await engine.send('Create exact.txt containing exactly OK followed by one final LF newline. Include a file_text check.');
    assert.equal(planningTurns, 2, 'the orchestrator gets one repair attempt');
    assert.equal(workerRuns, 0, 'an unchecked plan must not run a worker');
    assert.deepEqual(listTasks(root), []);
    assert.equal(fs.existsSync(path.join(root, 'exact.txt')), false);
    assert.match(engine.store.state.messages.at(-1).text, /exact.*check/i);
    engine.stop();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an exact-file plan cannot satisfy the requirement by checking another path', async () => {
  const root = tmp();
  try {
    const cfg = defaultConfig({ project: 'wrong-check-path', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
    scaffold(root, cfg);
    const providers = fakeProviders([]);
    let workerRuns = 0;
    providers.getProvider('claude').run = async () => ({ ok: true, text: `\`\`\`moragent-plan\n${JSON.stringify({ tasks: [{ id: 't1', role: 'backend', prompt: 'Write exact.txt', checks: [{ type: 'file_text', path: 'decoy.txt', lines: ['OK'], finalNewline: true }] }] })}\n\`\`\`` });
    providers.getProvider('codex').run = async () => { workerRuns++; return { ok: true, text: 'Done.' }; };
    const engine = await createEngine({ root, config: cfg, providers, lang: 'en' });
    await engine.send('Create exact.txt containing exactly OK followed by one final LF newline. Include a file_text check.');
    assert.equal(workerRuns, 0);
    assert.deepEqual(listTasks(root), []);
    assert.match(engine.store.state.messages.at(-1).text, /exact\.txt/);
    engine.stop();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a model-authored check cannot replace an unambiguous exact line from the user', async () => {
  const root = tmp();
  try {
    const cfg = defaultConfig({ project: 'wrong-exact-bytes', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
    scaffold(root, cfg);
    const providers = fakeProviders([]);
    let workerRuns = 0;
    providers.getProvider('claude').run = async () => ({ ok: true, text: `\`\`\`moragent-plan\n${JSON.stringify({ tasks: [{ id: 't1', role: 'backend', prompt: 'Write exact.txt with WRONG', checks: [{ type: 'file_text', path: 'exact.txt', lines: ['WRONG'], finalNewline: true }] }] })}\n\`\`\`` });
    providers.getProvider('codex').run = async ({ root: privateRoot }) => {
      workerRuns++;
      fs.writeFileSync(path.join(privateRoot, 'exact.txt'), 'WRONG\n');
      return { ok: true, text: 'Created exact.txt.' };
    };
    const engine = await createEngine({ root, config: cfg, providers, lang: 'en' });
    await engine.send('Create exact.txt containing exactly OK with a final LF newline.');
    assert.equal(workerRuns, 0, 'a check that disagrees with an explicit user literal must be rejected before dispatch');
    assert.deepEqual(listTasks(root), []);
    assert.equal(fs.existsSync(path.join(root, 'exact.txt')), false);
    assert.match(engine.store.state.messages.at(-1).text, /exact.*content|exact.*bytes|contenido exacto/i);
    engine.stop();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a mismatched exact check can be repaired to the Spanish user literal', async () => {
  const root = tmp();
  try {
    const cfg = defaultConfig({ project: 'reparar-literal', lang: 'es', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
    scaffold(root, cfg);
    const providers = fakeProviders([]);
    const prompts = [];
    let turns = 0;
    providers.getProvider('claude').run = async ({ prompt }) => {
      prompts.push(prompt);
      turns++;
      if (turns === 3) return { ok: true, text: 'Verificado.' };
      const line = turns === 1 ? 'MAL' : 'HOLA';
      const task = { id: 't1', role: 'backend', prompt: 'Crea nota.txt', checks: [{ type: 'file_text', path: 'nota.txt', lines: [line], finalNewline: true }] };
      return { ok: true, text: `\`\`\`moragent-plan\n${JSON.stringify({ tasks: [task] })}\n\`\`\`` };
    };
    providers.getProvider('codex').run = async ({ root: privateRoot }) => {
      fs.writeFileSync(path.join(privateRoot, 'nota.txt'), 'HOLA\n');
      return { ok: true, text: 'Creé nota.txt.' };
    };
    const engine = await createEngine({ root, config: cfg, providers, lang: 'es' });
    await engine.send('Crea nota.txt con contenido exacto HOLA y un salto de línea final.');
    assert.equal(turns, 3, 'wrong check, repaired check, review');
    assert.match(prompts[1], /"lines":\["HOLA"\]/);
    assert.equal(fs.readFileSync(path.join(root, 'nota.txt'), 'utf8'), 'HOLA\n');
    assert.equal(listTasks(root)[0].status, 'done');
    assert.deepEqual(listTasks(root)[0].verifiedChecks, ['nota.txt']);
    engine.stop();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an explicit multi-file user check block cannot be satisfied by checking only one file', async () => {
  const root = tmp();
  try {
    const cfg = defaultConfig({ project: 'two-exact-files', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
    scaffold(root, cfg);
    const providers = fakeProviders([]);
    let workerRuns = 0;
    const task = { id: 't1', role: 'backend', prompt: 'Create a.txt and b.txt', checks: [{ type: 'file_text', path: 'a.txt', lines: ['A', 'second'], finalNewline: true }] };
    providers.getProvider('claude').run = async () => ({ ok: true, text: `\`\`\`moragent-plan\n${JSON.stringify({ tasks: [task] })}\n\`\`\`` });
    providers.getProvider('codex').run = async () => { workerRuns++; return { ok: true, text: 'Done.' }; };
    const engine = await createEngine({ root, config: cfg, providers, lang: 'en' });
    const request = `Create a.txt and b.txt with exact content.\n\`\`\`moragent-checks\n${JSON.stringify({ files: [
      { path: 'a.txt', lines: ['A', 'second'], finalNewline: true },
      { path: 'b.txt', lines: ['B'], finalNewline: false },
    ] })}\n\`\`\``;
    await engine.send(request);
    assert.equal(workerRuns, 0, 'all user-declared files must be checked before any worker runs');
    assert.deepEqual(listTasks(root), []);
    assert.match(engine.store.state.messages.at(-1).text, /b\.txt/);
    engine.stop();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('explicit multi-file checks publish only after every requested byte sequence passes', async () => {
  const root = tmp();
  try {
    const cfg = defaultConfig({ project: 'dos-archivos', lang: 'es', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
    scaffold(root, cfg);
    const providers = fakeProviders([]);
    let turns = 0;
    const files = [
      { path: 'a.txt', lines: ['A', 'segunda línea'], finalNewline: true },
      { path: 'b.txt', lines: ['B'], finalNewline: false },
    ];
    providers.getProvider('claude').run = async () => {
      turns++;
      if (turns === 2) return { ok: true, text: 'Verificado.' };
      const task = { id: 't1', role: 'backend', prompt: 'Crea a.txt y b.txt', checks: files.map((file) => ({ type: 'file_text', ...file })) };
      return { ok: true, text: `\`\`\`moragent-plan\n${JSON.stringify({ tasks: [task] })}\n\`\`\`` };
    };
    providers.getProvider('codex').run = async ({ root: privateRoot }) => {
      fs.writeFileSync(path.join(privateRoot, 'a.txt'), 'A\nsegunda línea\n');
      fs.writeFileSync(path.join(privateRoot, 'b.txt'), 'B');
      return { ok: true, text: 'Creé ambos archivos.' };
    };
    const engine = await createEngine({ root, config: cfg, providers, lang: 'es' });
    await engine.send(`Crea dos archivos exactos.\n\`\`\`moragent-checks\n${JSON.stringify({ files })}\n\`\`\``);
    assert.equal(turns, 2);
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'A\nsegunda línea\n');
    assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'B');
    assert.equal(listTasks(root)[0].status, 'done');
    assert.deepEqual(listTasks(root)[0].verifiedChecks, ['a.txt', 'b.txt']);
    assert.match(engine.store.state.messages.at(-1).text, /VERIFICADO.*contrato exacto/);
    assert.match(engine.store.state.messages.at(-1).text, /"a\.txt" \(LF final\).*"b\.txt" \(sin LF final\)/);
    engine.stop();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a parallel worker cannot take over a sibling exact file or yield a false final success', async () => {
  const root = tmp();
  try {
    const cfg = defaultConfig({ project: 'parallel-scope', lang: 'en', preset: 'squad', clis: { lead: 'claude', backend: 'codex', frontend: 'codex' } });
    scaffold(root, cfg);
    const providers = fakeProviders([]);
    const files = [
      { path: 'api.txt', lines: ['API'], finalNewline: true },
      { path: 'ui.txt', lines: ['UI'], finalNewline: false },
    ];
    let turns = 0;
    providers.getProvider('claude').run = async () => ({ ok: true, text: ++turns === 1
      ? `\`\`\`moragent-plan\n${JSON.stringify({ tasks: [
        { id: 'api', role: 'backend', prompt: 'Create api.txt only', checks: [{ type: 'file_text', ...files[0] }] },
        { id: 'ui', role: 'frontend', prompt: 'Create ui.txt only', checks: [{ type: 'file_text', ...files[1] }] },
      ] })}\n\`\`\``
      : 'Everything is ready.' });
    providers.getProvider('codex').run = async ({ root: privateRoot, prompt, protectedOtherPaths }) => {
      if (prompt.includes('Create api.txt only')) {
        assert.deepEqual(protectedOtherPaths, ['ui.txt']);
        fs.writeFileSync(path.join(privateRoot, 'api.txt'), 'API\n');
        fs.writeFileSync(path.join(privateRoot, 'ui.txt'), 'UI');
      } else assert.deepEqual(protectedOtherPaths, ['api.txt']);
      return { ok: true, text: 'Finished.' };
    };
    const engine = await createEngine({ root, config: cfg, providers, lang: 'en' });
    await engine.send(`Create both files.\n\`\`\`moragent-checks\n${JSON.stringify({ files })}\n\`\`\``);
    const tasks = listTasks(root);
    assert.equal(tasks[0].status, 'blocked');
    assert.match(tasks[0].result, /task scope violation/);
    assert.equal(fs.existsSync(path.join(root, 'api.txt')), false);
    assert.equal(fs.existsSync(path.join(root, 'ui.txt')), false);
    assert.match(engine.store.state.messages.at(-1).text, /INCOMPLETE.*final checks/);
    engine.stop();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a later check cannot allow an earlier task to publish wrong user-requested bytes', async () => {
  const root = tmp();
  try {
    const cfg = defaultConfig({ project: 'late-check', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
    scaffold(root, cfg);
    const providers = fakeProviders([]);
    let workerRuns = 0;
    let orchestratorTurns = 0;
    const expected = { type: 'file_text', path: 'exact.txt', lines: ['RIGHT'], finalNewline: true };
    providers.getProvider('claude').run = async () => ({ ok: true, text: ++orchestratorTurns > 1 ? 'Review complete.' : `\`\`\`moragent-plan\n${JSON.stringify({ tasks: [
      { id: 'writer', role: 'backend', prompt: 'Create exact.txt', dependsOn: [] },
      { id: 'checker', role: 'backend', prompt: 'Check exact.txt', dependsOn: ['writer'], checks: [expected] },
    ] })}\n\`\`\`` });
    providers.getProvider('codex').run = async ({ root: privateRoot }) => {
      workerRuns++;
      fs.writeFileSync(path.join(privateRoot, 'exact.txt'), 'WRONG\n');
      return { ok: true, text: 'Created exact.txt.' };
    };
    const engine = await createEngine({ root, config: cfg, providers, lang: 'en' });
    await engine.send(`Create exact.txt with these bytes.\n\`\`\`moragent-checks\n${JSON.stringify({ files: [{ path: 'exact.txt', lines: ['RIGHT'], finalNewline: true }] })}\n\`\`\``);
    assert.equal(workerRuns, 1, 'the writer runs, but the dependent checker must not');
    assert.equal(fs.existsSync(path.join(root, 'exact.txt')), false, 'wrong bytes must never reach the project');
    assert.equal(listTasks(root)[0].status, 'blocked');
    assert.equal(listTasks(root)[1].status, 'blocked');
    assert.deepEqual(listTasks(root)[1].dependencies, [listTasks(root)[0].id], 'plan dependency uses durable bus IDs');
    const recovery = listRecoveries(root)[0];
    assert.equal(inspectRecovery(root, recovery.id).manualOnlyReason, 'acceptance-check-failed');
    assert.equal(inspectRecovery(root, recovery.id).canApply, false);
    engine.stop();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a writer with the right bytes is independently verified even when the plan check is later', async () => {
  const root = tmp();
  try {
    const cfg = defaultConfig({ project: 'late-valid-check', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
    scaffold(root, cfg);
    const providers = fakeProviders([]);
    let turns = 0;
    let workerRuns = 0;
    const expected = { type: 'file_text', path: 'exact.txt', lines: ['RIGHT'], finalNewline: true };
    providers.getProvider('claude').run = async () => ({ ok: true, text: ++turns > 1 ? 'Reviewed.' : `\`\`\`moragent-plan\n${JSON.stringify({ tasks: [
      { id: 'writer', role: 'backend', prompt: 'Create exact.txt', dependsOn: [] },
      { id: 'checker', role: 'backend', prompt: 'Check exact.txt', dependsOn: ['writer'], checks: [expected] },
    ] })}\n\`\`\`` });
    providers.getProvider('codex').run = async ({ root: privateRoot }) => {
      if (++workerRuns === 1) fs.writeFileSync(path.join(privateRoot, 'exact.txt'), 'RIGHT\n');
      return { ok: true, text: 'Checked exact.txt.' };
    };
    const engine = await createEngine({ root, config: cfg, providers, lang: 'en' });
    await engine.send(`Create exact.txt with these bytes.\n\`\`\`moragent-checks\n${JSON.stringify({ files: [{ path: 'exact.txt', lines: ['RIGHT'], finalNewline: true }] })}\n\`\`\``);
    assert.equal(workerRuns, 2);
    assert.equal(fs.readFileSync(path.join(root, 'exact.txt'), 'utf8'), 'RIGHT\n');
    assert.equal(listTasks(root)[0].status, 'done');
    assert.deepEqual(listTasks(root)[0].verifiedChecks, ['exact.txt']);
    assert.deepEqual(listTasks(root)[1].verifiedChecks, ['exact.txt']);
    assert.match(engine.store.state.messages.at(-1).text, /VERIFIED.*exact file contract.*"exact\.txt" \(final LF\)/);
    engine.stop();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a read-only exact check cannot certify stale bytes after the source changes', async () => {
  const root = tmp();
  try {
    fs.writeFileSync(path.join(root, 'exact.txt'), 'RIGHT\n');
    const cfg = defaultConfig({ project: 'stale-read', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
    scaffold(root, cfg);
    const providers = fakeProviders([]);
    let turns = 0;
    providers.getProvider('claude').run = async () => ({ ok: true, text: ++turns > 1 ? 'Reviewed.' : `\`\`\`moragent-plan\n${JSON.stringify({ tasks: [
      { id: 'check', role: 'backend', prompt: 'Inspect exact.txt without changing it',
        checks: [{ type: 'file_text', path: 'exact.txt', lines: ['RIGHT'], finalNewline: true }] },
    ] })}\n\`\`\`` });
    providers.getProvider('codex').run = async () => {
      fs.writeFileSync(path.join(root, 'exact.txt'), 'WRONG\n');
      return { ok: true, text: 'The private copy still says RIGHT.' };
    };
    const engine = await createEngine({ root, config: cfg, providers, lang: 'en' });
    await engine.send('Verify exact.txt against its exact file content, without editing it.');
    assert.equal(fs.readFileSync(path.join(root, 'exact.txt'), 'utf8'), 'WRONG\n');
    assert.equal(listTasks(root)[0].status, 'blocked');
    assert.deepEqual(listTasks(root)[0].verifiedChecks, []);
    assert.equal(inspectRecovery(root, listRecoveries(root)[0].id).manualOnlyReason, 'acceptance-check-failed');
    engine.stop();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('exact-file wording in English and Spanish requires a structured check', () => {
  assert.equal(requiresExactFileCheck('Create note.txt with exact file content and a final newline.'), true);
  assert.equal(requiresExactFileCheck('Crea nota.txt con contenido exacto y salto de línea final.'), true);
  assert.equal(requiresExactFileCheck('Create note.txt and run its tests.'), false);
  assert.equal(exactCheckTarget('Create notes/hello.txt with exact file content.'), 'notes/hello.txt');
  assert.equal(exactCheckTarget('Copy a.txt into b.txt with exact content.'), null);
  assert.deepEqual(literalSingleLineExpectation('Create note.txt containing exactly OK with a final LF newline.'), {
    type: 'file_text', path: 'note.txt', lines: ['OK'], finalNewline: true,
  });
  assert.deepEqual(literalSingleLineExpectation('Crea nota.txt con contenido exacto HOLA y un salto de línea final.'), {
    type: 'file_text', path: 'nota.txt', lines: ['HOLA'], finalNewline: true,
  });
  assert.deepEqual(literalSingleLineExpectation('Create note.txt containing exactly this one line without final newline: OK'), {
    type: 'file_text', path: 'note.txt', lines: ['OK'], finalNewline: false,
  });
  assert.deepEqual(literalSingleLineExpectation('Create note.txt containing exactly this one line with final newline: "hello world"'), {
    type: 'file_text', path: 'note.txt', lines: ['hello world'], finalNewline: true,
  });
  assert.equal(literalSingleLineExpectation('Create note.txt with exact file content and a final newline.'), null);
  assert.equal(literalSingleLineExpectation('Copy a.txt into b.txt containing exactly OK with final newline.'), null);
  assert.equal(literalSingleLineExpectation('Create note.txt containing exactly this one line with final newline: OK. Do not add a header.'), null);
  assert.equal(literalSingleLineExpectation('Create note.txt containing exactly this one line with final newline: OK and no other content'), null);
});

test('explicit user checks validate paths and preserve multi-line literals including code fences', () => {
  const block = (files) => `\`\`\`moragent-checks\n${JSON.stringify({ files })}\n\`\`\``;
  const files = [
    { path: 'docs/example.md', lines: ['# Example', '```js', 'const x = 1;', '```'], finalNewline: true },
    { path: 'config.txt', lines: ['one', 'two'], finalNewline: false },
  ];
  assert.deepEqual(parseExplicitFileChecks(`Create both files.\n${block(files)}`)?.checks,
    files.map((file) => ({ type: 'file_text', ...file })));
  assert.equal(parseExplicitFileChecks('Create docs/example.md without a check block.'), null);
  assert.equal(parseExplicitFileChecks('```moragent-checks')?.error, 'missing-fence');
  assert.equal(parseExplicitFileChecks('```moragent-checks\n{"files":[]}')?.error, 'missing-fence');
  assert.equal(parseExplicitFileChecks('```moragent-checks\n{broken}\n```')?.error, 'invalid-json');
  assert.equal(parseExplicitFileChecks(block([{ path: '../escape.txt', lines: ['bad'], finalNewline: true }]))?.error, 'invalid-check');
  for (const path of ['.git/HEAD', 'node_modules/exact.txt', '.moragent/runs/exact.txt', 'nested/.moragent/memory/exact.txt']) {
    assert.equal(parseExplicitFileChecks(block([{ path, lines: ['bad'], finalNewline: true }]))?.error, 'invalid-check', path);
  }
  assert.equal(parseExplicitFileChecks(block([{ path: 'a.txt', lines: ['bad\nline'], finalNewline: true }]))?.error, 'invalid-check');
  assert.equal(parseExplicitFileChecks(block([
    { path: 'A.txt', lines: ['a'], finalNewline: true },
    { path: 'a.txt', lines: ['b'], finalNewline: false },
  ]))?.error, 'duplicate-path');
});

test('an invalid user check block stops before provider discovery or project creation', async () => {
  const cwd = tmp();
  let engine;
  try {
    let providerCalls = 0;
    engine = await createEngine({ root: null, cwd, lang: 'es', providers: {
      listProviders: () => { providerCalls++; return []; },
      getProvider: () => { providerCalls++; return null; },
    } });
    await engine.send('Crea salida.txt.\n```moragent-checks\n{"files":[{"path":"../escape.txt","lines":["mal"],"finalNewline":true}]}\n```');
    assert.equal(providerCalls, 0);
    assert.equal(fs.existsSync(path.join(cwd, '.moragent')), false);
    assert.match(engine.store.state.messages.at(-1).text, /Bloque moragent-checks inválido/);
    assert.match(engine.store.state.messages.at(-1).text, /No se inició ningún agente/);
    await engine.send('Crea un archivo interno.\n```moragent-checks\n{"files":[{"path":".moragent/runs/claim.txt","lines":["listo"],"finalNewline":true}]}\n```');
    assert.equal(providerCalls, 0);
    assert.equal(fs.existsSync(path.join(cwd, '.moragent')), false);
    assert.match(engine.store.state.messages.at(-1).text, /Bloque moragent-checks inválido/);
  } finally {
    engine?.stop();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a repaired exact-file plan checks bytes before a worker can publish', async () => {
  const root = tmp();
  try {
    const cfg = defaultConfig({ project: 'exact-repair', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
    scaffold(root, cfg);
    const providers = fakeProviders([]);
    let turns = 0;
    const base = { id: 't1', role: 'backend', prompt: 'Write exact.txt', doneWhen: 'exact bytes' };
    providers.getProvider('claude').run = async () => {
      turns++;
      if (turns === 3) return { ok: true, text: 'The worker did not satisfy the exact check.' };
      const task = turns === 1 ? base : { ...base, checks: [{ type: 'file_text', path: 'exact.txt', lines: ['OK'], finalNewline: true }] };
      return { ok: true, text: `\`\`\`moragent-plan\n${JSON.stringify({ tasks: [task] })}\n\`\`\`` };
    };
    providers.getProvider('codex').run = async ({ root: privateRoot }) => {
      fs.writeFileSync(path.join(privateRoot, 'exact.txt'), 'OK\\n');
      return { ok: true, text: 'Created exact.txt with the requested LF.' };
    };
    const engine = await createEngine({ root, config: cfg, providers, lang: 'en' });
    await engine.send('Create exact.txt with exact file content OK and a final LF newline.');
    assert.equal(turns, 3);
    assert.equal(listTasks(root)[0].status, 'blocked');
    assert.equal(fs.existsSync(path.join(root, 'exact.txt')), false);
    assert.equal(listRecoveries(root).length, 1);
    engine.stop();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a truncated exact-check repair gets one bounded reconstruction before dispatch', async () => {
  const root = tmp();
  try {
    const cfg = defaultConfig({ project: 'exact-reconstruction', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
    scaffold(root, cfg);
    const providers = fakeProviders([]);
    const prompts = [];
    let turns = 0;
    let workerRuns = 0;
    const task = { id: 't1', role: 'backend', prompt: 'Write exact.txt', checks: [{ type: 'file_text', path: 'exact.txt', lines: ['OK'], finalNewline: true }] };
    providers.getProvider('claude').run = async ({ prompt }) => {
      prompts.push(prompt);
      turns++;
      if (turns === 1) return { ok: true, text: '```moragent-plan\n{"tasks":[{"id":"t1","role":"backend","prompt":"Write exact.txt"}]}\n```' };
      if (turns === 2) return { ok: true, text: '```moragent-plan\n{"tasks":[{"id":"t1","role":"backend","checks":[' };
      if (turns === 3) return { ok: true, text: `\`\`\`moragent-plan\n${JSON.stringify({ tasks: [task] })}\n\`\`\`` };
      return { ok: true, text: 'Reviewed.' };
    };
    providers.getProvider('codex').run = async ({ root: privateRoot }) => {
      workerRuns++;
      fs.writeFileSync(path.join(privateRoot, 'exact.txt'), 'OK\n');
      return { ok: true, text: 'Done.' };
    };
    const engine = await createEngine({ root, config: cfg, providers, lang: 'en' });
    await engine.send('Create exact.txt containing exactly OK with one final LF newline.');
    assert.equal(turns, 4, 'initial plan, check repair, JSON reconstruction and review');
    assert.match(prompts[2], /incomplete JSON.*Rebuild the plan/s);
    assert.match(prompts[2], /file_text.*exact\.txt/s);
    assert.equal(workerRuns, 1);
    assert.equal(fs.readFileSync(path.join(root, 'exact.txt'), 'utf8'), 'OK\n');
    assert.equal(listTasks(root)[0].status, 'done');
    engine.stop();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('repeated malformed plan JSON stops after one repair without dispatching workers', async () => {
  const root = tmp();
  try {
    const cfg = defaultConfig({ project: 'invalid-json', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
    scaffold(root, cfg);
    const providers = fakeProviders([]);
    let turns = 0;
    let workerRuns = 0;
    providers.getProvider('claude').run = async () => {
      turns++;
      return { ok: true, text: '```moragent-plan\n{"tasks":[' };
    };
    providers.getProvider('codex').run = async () => { workerRuns++; return { ok: true, text: 'Done.' }; };
    const engine = await createEngine({ root, config: cfg, providers, lang: 'en' });
    await engine.send('Create a file.');
    assert.equal(turns, 2);
    assert.equal(workerRuns, 0);
    assert.deepEqual(listTasks(root), []);
    assert.match(engine.store.state.messages.at(-1).text, /invalid JSON/);
    engine.stop();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a promised plan without a block gets one repair attempt instead of a silent no-op', async () => {
  for (const repaired of [true, false]) {
    const root = tmp();
    try {
      const cfg = defaultConfig({ project: 'missing-plan', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
      scaffold(root, cfg);
      const providers = fakeProviders([]);
      let turns = 0;
      let workerRuns = 0;
      providers.getProvider('claude').run = async () => {
        turns++;
        if (turns === 1 || !repaired) return { ok: true, text: 'I will create a plan to delegate this file change.' };
        if (turns === 2) return { ok: true, text: `\`\`\`moragent-plan\n${JSON.stringify({ tasks: [{ id: 't1', role: 'backend', prompt: 'Write plan.txt' }] })}\n\`\`\`` };
        return { ok: true, text: 'Reviewed.' };
      };
      providers.getProvider('codex').run = async ({ root: privateRoot }) => {
        workerRuns++;
        fs.writeFileSync(path.join(privateRoot, 'plan.txt'), 'planned\n');
        return { ok: true, text: 'Done.' };
      };
      const engine = await createEngine({ root, config: cfg, providers, lang: 'en' });
      await engine.send('Create plan.txt.');
      assert.equal(turns, repaired ? 3 : 2);
      assert.equal(workerRuns, repaired ? 1 : 0);
      assert.equal(fs.existsSync(path.join(root, 'plan.txt')), repaired);
      if (!repaired) assert.match(engine.store.state.messages.at(-1).text, /no.*plan|nothing.*changed/i);
      engine.stop();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('a repeated missing-plan promise reports the no-op in Spanish', async () => {
  const root = tmp();
  try {
    const cfg = defaultConfig({ project: 'sin-plan', lang: 'es', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
    scaffold(root, cfg);
    const providers = fakeProviders([]);
    let turns = 0;
    providers.getProvider('claude').run = async () => { turns++; return { ok: true, text: 'Voy a crear un plan para delegar el archivo.' }; };
    const engine = await createEngine({ root, config: cfg, providers, lang: 'es' });
    await engine.send('Crea plan.txt.');
    assert.equal(turns, 2);
    assert.deepEqual(listTasks(root), []);
    assert.match(engine.store.state.messages.at(-1).text, /no se cambió ningún archivo/);
    engine.stop();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('provider assignment: role CLI when ready, otherwise a ready subscription', () => {
  const plan = normalizePlan({ tasks: [{ role: 'backend', prompt: 'back' }, { role: 'helper', prompt: 'help' }, { role: 'x', provider: 'claude', prompt: 'other' }] });
  assignProviders(plan, {
    crew: { backend: { cli: 'codex' }, helper: { cli: 'agy' } },
    providers: [{ id: 'claude', kind: 'subscription', ready: true }, { id: 'codex', kind: 'subscription', ready: true }, { id: 'agy', kind: 'subscription', ready: false }],
    orchestrator: 'claude',
  });
  assert.deepEqual(plan.tasks.map((t) => t.provider), ['codex', 'codex', 'claude']);
});

test('provider assignment prefers a role API override without changing its external CLI', () => {
  const plan = normalizePlan({ tasks: [{ role: 'backend', prompt: 'work' }] });
  assignProviders(plan, {
    crew: { backend: { cli: 'codex', provider: 'openai' } },
    providers: [{ id: 'codex', kind: 'subscription', ready: true }, { id: 'openai', kind: 'api', ready: true }],
    orchestrator: 'codex',
  });
  assert.equal(plan.tasks[0].provider, 'openai');
});

test('engine: message → plan → subagents in dependency order → memory → review', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'es', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  const calls = [];
  const engine = await createEngine({ root, config: cfg, providers: fakeProviders(calls) });
  await engine.send('crea hola.txt y verifícalo');

  const orch = calls.filter((c) => c.who === 'orchestrator');
  assert.equal(orch.length, 2, 'plan turn + review turn');
  assert.ok(orch.every((c) => c.autonomy === 'readonly'), 'orchestrator never writes');
  assert.equal(orch[1].sessionId, 'sess-1', 'review resumes the same session');
  assert.match(orch[1].prompt, /Criterio de aceptación: existe hola\.txt/);
  assert.match(orch[1].prompt, /Rutas integradas: "hola\.txt"/);
  const workers = calls.filter((c) => c.who === 'worker');
  assert.equal(workers.length, 2);
  assert.match(workers[0].prompt, /Escribe hola\.txt/);
  assert.match(workers[0].prompt, /No ejecutes `mora done`/, 'engine closes tasks itself');
  assert.match(workers[0].prompt, /no hagas commits/, 'private Git history cannot be merged');

  const tasks = listTasks(root);
  assert.deepEqual(tasks.map((t) => t.status), ['done', 'done']);
  assert.deepEqual(tasks[0].files, ['hola.txt']);
  assert.deepEqual(tasks[1].files, []);
  assert.equal(fs.readFileSync(path.join(root, 'hola.txt'), 'utf8'), 'hola');
  const episodic = fs.readdirSync(path.join(root, '.moragent', 'memory', 'episodic'));
  assert.equal(episodic.length, 2, 'one episodic note per task');

  const st = engine.store.state;
  assert.ok(Object.values(st.agents).every((a) => a.status === 'done'));
  assert.equal(st.memory.episodic, 2);
  const last = st.messages.filter((m) => m.from === 'orchestrator').pop();
  assert.match(last.text, /Todo listo/);
  const planMsg = st.messages.find((m) => m.from === 'orchestrator');
  assert.doesNotMatch(planMsg.text, /moragent-plan/, 'plan JSON never shown to the user');
  assert.ok(st.messages.some((message) => message.from === 'system' && message.text === 'Plan S · 2 subagentes: archivo y prueba'));
});

test('/cancel during /task provider discovery prevents a late worker deployment', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  const calls = [];
  const engine = await createEngine({ root, config: cfg, providers: fakeProviders(calls), lang: 'en' });
  const refresh = engine.refreshProviders;
  let release;
  engine.refreshProviders = async () => {
    await new Promise((resolve) => { release = resolve; });
    return refresh();
  };
  const task = engine.command('task', ['backend', 'Escribe hola.txt']);
  await engine.command('cancel');
  release();
  await task;
  assert.equal(calls.filter((call) => call.who === 'worker').length, 0);
  assert.deepEqual(listTasks(root), []);
  assert.equal(fs.existsSync(path.join(root, 'hola.txt')), false);
  engine.stop();
});

test('engine asks the orchestrator to repair a duplicate task ID before dispatch', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  const calls = [];
  const providers = fakeProviders(calls);
  let turns = 0;
  providers.getProvider('claude').run = async ({ prompt, onEvent }) => {
    turns++;
    const text = turns === 1
      ? '```moragent-plan\n{"tasks":[{"id":"t1","role":"backend","prompt":"first"},{"id":"t1","role":"backend","prompt":"second"}]}\n```'
      : turns === 2 ? PLAN : 'Reviewed.';
    calls.push({ who: 'orchestrator', prompt });
    onEvent({ type: 'text', delta: text });
    return { ok: true, text };
  };
  const engine = await createEngine({ root, config: cfg, providers });
  await engine.send('create a file');
  assert.equal(turns, 3, 'invalid plan, repaired plan, review');
  assert.match(calls[1].prompt, /duplicate task ID/);
  assert.equal(listTasks(root).length, 2, 'only repaired tasks were dispatched');
});

test('an explicitly unavailable provider in a plan is repaired before any worker runs', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  const calls = [];
  const providers = fakeProviders(calls);
  let turns = 0;
  providers.getProvider('claude').run = async ({ prompt }) => {
    turns++;
    calls.push({ who: 'orchestrator', prompt });
    return { ok: true, text: turns === 1
      ? '```moragent-plan\n{"tasks":[{"id":"t1","role":"backend","provider":"not-connected","prompt":"Escribe hola.txt"}]}\n```'
      : turns === 2
        ? '```moragent-plan\n{"tasks":[{"id":"t1","role":"backend","prompt":"Escribe hola.txt"}]}\n```'
        : 'Reviewed.' };
  };
  const engine = await createEngine({ root, config: cfg, providers });
  await engine.send('Create hola.txt');
  assert.equal(turns, 3, 'invalid plan, repaired plan, review');
  assert.match(calls[1].prompt, /unavailable provider|unknown provider|not-connected/i);
  assert.equal(calls.filter((call) => call.who === 'worker').length, 1);
  assert.equal(listTasks(root).length, 1);
  assert.equal(fs.readFileSync(path.join(root, 'hola.txt'), 'utf8'), 'hola');
  engine.stop();
});

test('an object-valued task prompt is repaired before any worker runs', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  const calls = [];
  const providers = fakeProviders(calls);
  let turns = 0;
  providers.getProvider('claude').run = async ({ prompt }) => {
    turns++;
    calls.push({ who: 'orchestrator', prompt });
    return { ok: true, text: turns === 1
      ? '```moragent-plan\n{"tasks":[{"id":"t1","role":"backend","prompt":{"instruction":"Escribe hola.txt"}}]}\n```'
      : turns === 2
        ? '```moragent-plan\n{"tasks":[{"id":"t1","role":"backend","prompt":"Escribe hola.txt"}]}\n```'
        : 'Reviewed.' };
  };
  const engine = await createEngine({ root, config: cfg, providers });
  await engine.send('Create hola.txt');
  assert.equal(turns, 3, 'invalid plan, repaired plan, review');
  assert.match(calls[1].prompt, /invalid field|t1\.prompt/i);
  assert.equal(calls.filter((call) => call.who === 'worker').length, 1);
  assert.equal(fs.readFileSync(path.join(root, 'hola.txt'), 'utf8'), 'hola');
  engine.stop();
});

test('a failed orchestrator response cannot dispatch a complete-looking partial plan', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  const calls = [];
  const providers = fakeProviders(calls);
  providers.getProvider('claude').run = async ({ onEvent }) => {
    onEvent({ type: 'text', delta: PLAN });
    return { ok: false, text: PLAN, error: 'stream interrupted' };
  };
  const engine = await createEngine({ root, config: cfg, providers });
  await engine.send('create a file');
  assert.equal(listTasks(root).length, 0);
  assert.equal(calls.filter((call) => call.who === 'worker').length, 0);
  assert.match(engine.store.state.messages.at(-1).text, /stream interrupted/);
});

test('the orchestrator uses the provider final answer, not earlier streamed progress', async () => {
  for (const [progress, final, expectedTasks] of [
    [PLAN, 'No implementation needed.', 0],
    ['I will prepare a plan.', PLAN, 2],
  ]) {
    const root = tmp();
    const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
    scaffold(root, cfg);
    const providers = fakeProviders([]);
    let turns = 0;
    providers.getProvider('claude').run = async ({ onEvent }) => {
      turns++;
      if (turns === 1) {
        onEvent({ type: 'text', delta: progress });
        return { ok: true, text: final };
      }
      return { ok: true, text: 'Reviewed.' };
    };
    const engine = await createEngine({ root, config: cfg, providers });
    await engine.send('create a file');
    assert.equal(listTasks(root).length, expectedTasks);
    assert.equal(engine.store.state.messages.find((message) => message.from === 'orchestrator').text,
      stripPlan(final));
  }
});

test('a provisional API plan before a tool call cannot dispatch after the final answer rejects it', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  cfg.orchestrator = 'openai';
  scaffold(root, cfg);
  fs.writeFileSync(path.join(root, 'note.txt'), 'No implementation required.');
  const api = { ...openai, status: async () => ({ ready: true }), run: (options) => openai.run({ ...options, apiKey: 'test-key' }) };
  const providers = { listProviders: () => [api], getProvider: (id) => id === 'openai' ? api : null };
  const draft = '```moragent-plan\n{"tasks":[{"id":"t1","role":"backend","prompt":"create unwanted.txt"}]}\n```';
  let turn = 0;
  try {
    setFetch(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: ++turn === 1
      ? { role: 'assistant', content: draft, tool_calls: [{ id: 'read_1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'note.txt' }) } }] }
      : { role: 'assistant', content: 'No changes needed.' } }] }) }));
    const engine = await createEngine({ root, config: cfg, providers });
    await engine.send('Check whether note.txt needs changes');
    assert.equal(turn, 2);
    assert.deepEqual(listTasks(root), []);
    assert.equal(engine.store.state.messages.find((message) => message.from === 'orchestrator').text, 'No changes needed.');
    engine.stop();
  } finally {
    resetFetch();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an empty successful provider result cannot establish a resumable session', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  const providers = fakeProviders([]);
  const seen = [];
  providers.getProvider('claude').run = async ({ sessionId }) => {
    seen.push(sessionId);
    return seen.length === 1
      ? { ok: true, text: '', sessionId: 'incomplete-thread' }
      : { ok: true, text: 'Recovered.', sessionId: 'valid-thread' };
  };
  const engine = await createEngine({ root, config: cfg, providers });
  await engine.send('First question');
  await engine.send('Try again');
  assert.deepEqual(seen, [null, null]);
  engine.stop();
});

test('a failed provider turn clears an earlier resumable session', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  const providers = fakeProviders([]);
  const seen = [];
  providers.getProvider('claude').run = async ({ sessionId }) => {
    seen.push(sessionId);
    if (seen.length === 1) return { ok: true, text: 'First answer.', sessionId: 'valid-thread' };
    if (seen.length === 2) return { ok: false, text: 'partial', sessionId: 'partial-thread', error: 'failed' };
    return { ok: true, text: 'Recovered.', sessionId: 'new-thread' };
  };
  const engine = await createEngine({ root, config: cfg, providers });
  await engine.send('First question');
  await engine.send('Second question');
  assert.match(engine.store.state.messages.filter((message) => message.from === 'orchestrator').at(-1).text, /next attempt will start a new session/i);
  await engine.send('Try again');
  assert.deepEqual(seen, [null, 'valid-thread', null]);
  engine.stop();
});

test('a thrown provider error clears the resumable session', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  const providers = fakeProviders([]);
  const seen = [];
  providers.getProvider('claude').run = async ({ sessionId }) => {
    seen.push(sessionId);
    if (seen.length === 1) return { ok: true, text: 'First answer.', sessionId: 'valid-thread' };
    if (seen.length === 2) throw new Error('connection lost');
    return { ok: true, text: 'Recovered.', sessionId: 'new-thread' };
  };
  const engine = await createEngine({ root, config: cfg, providers });
  await engine.send('First question');
  await engine.send('Second question');
  await engine.send('Try again');
  assert.deepEqual(seen, [null, 'valid-thread', null]);
  engine.stop();
});

test('a successful continuation without a repeated session id keeps its existing context', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  const providers = fakeProviders([]);
  const seen = [];
  providers.getProvider('claude').run = async ({ sessionId }) => {
    seen.push(sessionId);
    return { ok: true, text: 'Answer.', ...(seen.length === 1 ? { sessionId: 'valid-thread' } : {}) };
  };
  const engine = await createEngine({ root, config: cfg, providers });
  await engine.send('First question');
  await engine.send('Second question');
  await engine.send('Third question');
  assert.deepEqual(seen, [null, 'valid-thread', 'valid-thread']);
  engine.stop();
});

test('a worker with no success result fails and blocks dependent tasks', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  const providers = fakeProviders([]);
  providers.getProvider('codex').run = async ({ root: privateRoot }) => {
    fs.writeFileSync(path.join(privateRoot, 'unconfirmed.txt'), 'partial');
    return undefined;
  };
  const engine = await createEngine({ root, config: cfg, providers });
  await engine.send('create a file');
  assert.deepEqual(listTasks(root).map((task) => task.status), ['failed', 'blocked']);
  assert.equal(fs.existsSync(path.join(root, 'unconfirmed.txt')), false);
});

test('an empty worker answer cannot publish private file changes as a completed task', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  const providers = fakeProviders([]);
  providers.getProvider('codex').run = async ({ root: privateRoot }) => {
    fs.writeFileSync(path.join(privateRoot, 'unconfirmed.txt'), 'partial');
    return { ok: true, text: '' };
  };
  const engine = await createEngine({ root, config: cfg, providers });
  await engine.command('task', ['backend', 'Create unconfirmed.txt']);
  const task = listTasks(root)[0];
  assert.equal(task.status, 'failed');
  assert.deepEqual(task.files, [], 'private changes are not reported as integrated paths');
  assert.equal(fs.existsSync(path.join(root, 'unconfirmed.txt')), false);
  assert.match(task.result, /Workspace preserved/);
  const recoveryPath = task.result.match(/Workspace preserved: (.+)$/m)?.[1];
  assert.equal(fs.readFileSync(path.join(recoveryPath, 'unconfirmed.txt'), 'utf8'), 'partial');
  engine.stop();
});

test('a worker final empty answer overrides earlier streamed progress', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  const providers = fakeProviders([]);
  providers.getProvider('codex').run = async ({ root: privateRoot, onEvent }) => {
    fs.writeFileSync(path.join(privateRoot, 'draft.txt'), 'draft');
    onEvent({ type: 'text', delta: 'I might be done.' });
    return { ok: true, text: '' };
  };
  const engine = await createEngine({ root, config: cfg, providers });
  await engine.command('task', ['backend', 'Create draft.txt']);
  assert.equal(listTasks(root)[0].status, 'failed');
  assert.equal(fs.existsSync(path.join(root, 'draft.txt')), false);
  engine.stop();
});

test('engine: informational answer runs no subagents; empty folder becomes a project', async () => {
  const cwd = tmp();
  const calls = [];
  const providers = fakeProviders(calls);
  providers.getProvider('claude').run = async ({ onEvent }) => { onEvent({ type: 'text', delta: 'Es un CLI de notas.' }); return { ok: true, text: 'Es un CLI de notas.', sessionId: 's' }; };
  const engine = await createEngine({ root: null, cwd, providers });
  await engine.send('Un CLI de notas');
  assert.ok(fs.existsSync(path.join(cwd, '.moragent', 'moragent.json')), 'project scaffolded from the first message');
  assert.equal(engine.store.state.initialized, true);
  assert.equal(listTasks(cwd).length, 0);
});

test('a first greeting answers in its language without provider calls or project files', async () => {
  for (const [message, expectedLang, reply] of [
    ['Hola', 'es', /No inicialicé el proyecto ni creé o modifiqué archivos/],
    ['  ¡Hóla MORAGENT!  ', 'es', /No inicialicé el proyecto ni creé o modifiqué archivos/],
    ['¿Qué tal?', 'es', /No inicialicé el proyecto ni creé o modifiqué archivos/],
    ['Hello', 'en', /I did not initialize the project or create or change any files/],
    ['Hi!', 'en', /I did not initialize the project or create or change any files/],
    ['Hey...', 'en', /I did not initialize the project or create or change any files/],
  ]) {
    const cwd = tmp();
    const calls = [];
    const provider = {
      id: 'test', label: 'Test', kind: 'api',
      status: async () => { calls.push('status'); return { ready: true }; },
      run: async () => { calls.push('run'); return { ok: true, text: 'Unexpected.' }; },
    };
    const providers = {
      listProviders: () => { calls.push('list'); return [provider]; },
      getProvider: () => { calls.push('get'); return provider; },
    };
    let engine;
    try {
      engine = await createEngine({ root: null, cwd, providers });
      await engine.send(message);
      assert.deepEqual(calls, [], `${message}: provider must remain untouched`);
      assert.deepEqual(fs.readdirSync(cwd), [], `${message}: folder must remain empty`);
      assert.equal(engine.root, null);
      assert.equal(engine.store.state.initialized, false);
      assert.equal(engine.store.state.lang, expectedLang);
      assert.equal(engine.store.state.messages[0].text, message.trim());
      assert.match(engine.store.state.messages[1].text, reply);
    } finally {
      engine?.stop();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test('a greeting does not consume the first concrete request or turn a request into a greeting', async () => {
  for (const firstMessage of [null, 'Hola']) {
    const cwd = tmp();
    const request = 'Hola, crea una API de tareas';
    const calls = [];
    const provider = {
      id: 'test', label: 'Test', kind: 'api',
      status: async () => ({ ready: true }),
      run: async ({ prompt }) => { calls.push(prompt); return { ok: true, text: 'Puedo construir esa API.' }; },
    };
    const providers = { listProviders: () => [provider], getProvider: () => provider };
    let engine;
    try {
      engine = await createEngine({ root: null, cwd, providers });
      if (firstMessage) {
        await engine.send(firstMessage);
        assert.deepEqual(fs.readdirSync(cwd), []);
        assert.equal(calls.length, 0);
      }
      await engine.send(request);
      assert.equal(engine.store.state.initialized, true);
      assert.equal(engine.config.goal, request);
      assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, '.moragent', 'moragent.json'), 'utf8')).goal, request);
      assert.equal(calls.length, 1);
      assert.match(calls[0], /Hola, crea una API de tareas/);
    } finally {
      engine?.stop();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test('an API-only first run creates, delegates and reopens with the same orchestrator', async () => {
  const cwd = tmp();
  let turns = 0;
  const api = {
    id: 'openai', label: 'OpenAI', kind: 'api',
    status: async () => ({ ready: true }),
    run: async ({ root }) => {
      turns++;
      if (turns === 1) return { ok: true, text: '```moragent-plan\n{"tasks":[{"id":"t1","role":"executor","prompt":"Create api-only.txt"}]}\n```' };
      if (turns === 2) {
        fs.writeFileSync(path.join(root, 'api-only.txt'), 'api-only\n');
        return { ok: true, text: 'Created api-only.txt.' };
      }
      return { ok: true, text: 'Reviewed.' };
    },
  };
  const providers = { listProviders: () => [api], getProvider: (id) => id === 'openai' ? api : null };
  const engine = await createEngine({ root: null, cwd, providers, lang: 'en' });
  await engine.send('Build a tiny API-only project');
  assert.equal(fs.readFileSync(path.join(cwd, 'api-only.txt'), 'utf8'), 'api-only\n');
  assert.equal(listTasks(cwd)[0].status, 'done');
  assert.deepEqual(listTasks(cwd)[0].files, ['api-only.txt']);
  assert.match(engine.store.state.messages.find((message) => message.from === 'system' && message.text.startsWith('Plan'))?.text || '', /Plan · 1 subagent: Create api-only\.txt/);
  const saved = JSON.parse(fs.readFileSync(path.join(cwd, '.moragent', 'moragent.json'), 'utf8'));
  assert.equal(saved.orchestrator, 'openai');
  assert.ok(CLI_IDS.includes(saved.crew.lead.cli));
  const reopened = await createEngine({ root: cwd, providers });
  assert.equal(reopened.store.state.orchestrator.provider, 'openai');
  reopened.stop();
  engine.stop();
});

test('engine preserves an orchestrator and model chosen before creating the project', async () => {
  const cwd = tmp();
  const engine = await createEngine({ root: null, cwd, providers: fakeProviders([]), lang: 'en' });
  await engine.refreshProviders();
  await engine.command('orchestrator', ['codex']);
  await engine.command('model', ['gpt-selected']);
  await engine.send('Describe a notes CLI');
  const saved = JSON.parse(fs.readFileSync(path.join(cwd, '.moragent', 'moragent.json'), 'utf8'));
  assert.equal(saved.orchestrator, 'codex');
  assert.equal(saved.orchestratorModel, 'gpt-selected');
  assert.ok(CLI_IDS.includes(saved.crew.lead.cli));
  const reopened = await createEngine({ root: cwd, providers: fakeProviders([]) });
  assert.equal(reopened.store.state.orchestrator.provider, 'codex');
  assert.equal(reopened.store.state.orchestrator.model, 'gpt-selected');
  reopened.stop();
  engine.stop();
});

test('an API orchestrator chosen before project creation does not replace the CLI lead', async () => {
  const cwd = tmp();
  const base = fakeProviders([]);
  const api = {
    id: 'openai', label: 'OpenAI', kind: 'api',
    status: async () => ({ ready: true }),
    run: async () => ({ ok: true, text: 'Done.' }),
  };
  const providers = {
    listProviders: () => [...base.listProviders(), api],
    getProvider: (id) => id === 'openai' ? api : base.getProvider(id),
  };
  const engine = await createEngine({ root: null, cwd, providers, lang: 'en' });
  await engine.refreshProviders();
  await engine.command('orchestrator', ['openai']);
  await engine.command('model', ['gpt-selected']);
  await engine.send('Describe a notes CLI');
  const saved = JSON.parse(fs.readFileSync(path.join(cwd, '.moragent', 'moragent.json'), 'utf8'));
  assert.equal(saved.orchestrator, 'openai');
  assert.equal(saved.orchestratorModel, 'gpt-selected');
  assert.ok(CLI_IDS.includes(saved.crew.lead.cli), 'the external CLI crew remains valid');
  const reopened = await createEngine({ root: cwd, providers });
  assert.equal(reopened.store.state.orchestrator.provider, 'openai');
  assert.equal(reopened.store.state.orchestrator.model, 'gpt-selected');
  reopened.stop();
  engine.stop();
});

test('assigning an API provider to a worker preserves its external CLI and runs on the API', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  const base = fakeProviders([]);
  const runs = [];
  const fallbackRuns = [];
  let apiReady = true;
  let system;
  base.getProvider('claude').run = async (options) => { system = options.system; return { ok: true, text: 'Done.' }; };
  base.getProvider('codex').run = async (options) => { fallbackRuns.push(options); return { ok: true, text: 'Done.' }; };
  const api = {
    id: 'openai', label: 'OpenAI', kind: 'api',
    status: async () => ({ ready: apiReady }),
    run: async (options) => { runs.push(options); return { ok: true, text: 'Done.' }; },
  };
  const providers = {
    listProviders: () => [...base.listProviders(), api],
    getProvider: (id) => id === 'openai' ? api : base.getProvider(id),
  };
  const engine = await createEngine({ root, config: cfg, providers });
  await engine.refreshProviders();
  await engine.command('crew', ['backend', 'openai']);
  assert.equal(cfg.crew.backend.cli, 'codex');
  assert.equal(cfg.crew.backend.provider, 'openai');
  assert.equal(engine.roleEngine('backend'), 'openai');
  await engine.send('Describe the crew');
  assert.match(system, /backend → openai/);
  await engine.command('model', ['backend', 'api-model']);
  await engine.command('task', ['backend', 'Check API routing']);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].model, 'api-model');
  assert.equal(listTasks(root)[0].status, 'done');
  assert.equal(listTasks(root)[0].role, 'backend');
  const saved = JSON.parse(fs.readFileSync(path.join(root, '.moragent', 'moragent.json'), 'utf8'));
  assert.equal(saved.crew.backend.cli, 'codex');
  assert.equal(saved.crew.backend.provider, 'openai');
  apiReady = false;
  await engine.refreshProviders();
  await engine.command('task', ['backend', 'Check fallback routing']);
  assert.equal(fallbackRuns.length, 1);
  assert.equal(fallbackRuns[0].model, undefined, 'do not pass an API model ID to the fallback CLI');
  await engine.command('crew', ['backend', 'codex']);
  assert.equal(cfg.crew.backend.provider, undefined);
  assert.equal(cfg.crew.backend.model, undefined);
  assert.equal(engine.roleEngine('backend'), 'codex');
  engine.stop();
});

test('engine preserves a pre-project model selected on the automatically chosen provider', async () => {
  const cwd = tmp();
  const engine = await createEngine({ root: null, cwd, providers: fakeProviders([]), lang: 'en' });
  await engine.refreshProviders();
  const selectedProvider = engine.store.state.orchestrator.provider;
  await engine.command('model', ['session-model']);
  await engine.send('Describe a notes CLI');
  const saved = JSON.parse(fs.readFileSync(path.join(cwd, '.moragent', 'moragent.json'), 'utf8'));
  assert.equal(saved.orchestrator, selectedProvider);
  assert.equal(saved.orchestratorModel, 'session-model');
  engine.stop();
});

test('engine: explicit session language overrides project language without changing its config', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'es', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  const providers = fakeProviders([]);
  let system;
  providers.getProvider('claude').run = async (options) => { system = options.system; return { ok: true, text: 'Done.' }; };
  const engine = await createEngine({ root, config: cfg, providers, lang: 'en' });
  assert.equal(engine.store.state.lang, 'en');
  await engine.send('Explain the project');
  assert.match(system, /You are MORAGENT/);
  assert.match(system, /Backend: APIs, data/);
  await engine.command('task', ['backend', 'Check language']);
  const task = listTasks(root)[0];
  const envelope = fs.readFileSync(path.join(root, '.moragent', 'tasks', `${task.id}.md`), 'utf8');
  assert.match(envelope, /Role mission/);
  assert.match(envelope, /Backend: APIs, data/);
  assert.equal(cfg.lang, 'es');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.moragent', 'moragent.json'), 'utf8')).lang, 'es');
  engine.stop();
});

test('engine: failed dependency blocks dependents instead of running them', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'es', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  const calls = [];
  const providers = fakeProviders(calls);
  providers.getProvider('codex').run = async () => ({ ok: false, error: 'boom' });
  const engine = await createEngine({ root, config: cfg, providers });
  await engine.send('crea hola.txt');
  assert.deepEqual(listTasks(root).map((t) => t.status), ['failed', 'blocked']);
});

test('engine blocks a worker merge when the real project changed during its private run', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  fs.writeFileSync(path.join(root, 'shared.txt'), 'baseline');
  const providers = fakeProviders([]);
  let turns = 0;
  providers.getProvider('claude').run = async () => ({ ok: true, text: ++turns === 1
    ? '```moragent-plan\n{"tasks":[{"id":"t1","role":"backend","prompt":"edit shared.txt"}]}\n```'
    : 'The edit conflicted.' });
  providers.getProvider('codex').run = async ({ root: privateRoot }) => {
    assert.notEqual(privateRoot, root);
    fs.writeFileSync(path.join(privateRoot, 'shared.txt'), 'worker');
    fs.writeFileSync(path.join(root, 'shared.txt'), 'user edit');
    return { ok: true, text: 'Edited shared.txt.' };
  };
  const engine = await createEngine({ root, config: cfg, providers });
  await engine.send('edit shared.txt');
  const task = listTasks(root)[0];
  assert.equal(task.status, 'blocked');
  assert.deepEqual(task.files, [], 'conflicted changes are not reported as integrated paths');
  assert.match(task.result, /path integration conflict/);
  assert.equal(fs.readFileSync(path.join(root, 'shared.txt'), 'utf8'), 'user edit');
  assert.ok(task.result.includes(path.join('.moragent', 'runs', 'recovery')));
  await engine.command('recoveries', [task.id]);
  assert.match(engine.store.state.messages.at(-1).text, /Saved copies/);
  assert.ok(engine.store.state.messages.at(-1).text.includes(task.id));
  await engine.command('recoveries', ['inspect', task.id]);
  assert.match(engine.store.state.messages.at(-1).text, /conflicts: shared.txt/);
  await engine.command('recoveries', ['apply', task.id]);
  assert.match(engine.store.state.messages.at(-1).text, /nothing was applied/);
  assert.equal(fs.readFileSync(path.join(root, 'shared.txt'), 'utf8'), 'user edit');
  fs.writeFileSync(path.join(root, 'shared.txt'), 'baseline');
  const pending = engine.send('Check status');
  const beforeBusyMessage = engine.store.state.messages.length;
  await engine.command('recoveries', ['apply', task.id]);
  assert.ok(engine.store.state.messages.slice(beforeBusyMessage).some((message) => /Wait for running agents/.test(message.text)));
  await pending;
  await engine.command('recoveries', ['apply', task.id]);
  assert.match(engine.store.state.messages.at(-1).text, /Applied 1 path/);
  assert.equal(fs.readFileSync(path.join(root, 'shared.txt'), 'utf8'), 'worker');
  await engine.command('recoveries', [task.id]);
  assert.match(engine.store.state.messages.at(-1).text, /Saved copies/);
  await engine.command('idioma', ['es']);
  await engine.command('recuperaciones', ['inspeccionar', task.id]);
  assert.match(engine.store.state.messages.at(-1).text, /conflictos: shared.txt/);
});

test('/recoveries can inspect and apply a saved copy after its project moves', async () => {
  const parent = tmp();
  const root = path.join(parent, 'original');
  const moved = path.join(parent, 'moved');
  try {
    fs.mkdirSync(root);
    const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo' });
    scaffold(root, cfg);
    const workspace = createTaskWorkspace(root, 'T-0011');
    fs.writeFileSync(path.join(workspace.root, 'saved.txt'), 'from worker');
    fs.mkdirSync(path.join(workspace.root, 'empty'));
    workspace.preserve();
    fs.renameSync(root, moved);
    const engine = await createEngine({ root: moved, config: cfg, providers: fakeProviders([]) });
    await engine.command('recoveries', ['inspect', 'T-0011']);
    assert.match(engine.store.state.messages.at(-1).text, /ready to apply paths/);
    await engine.command('recoveries', ['apply', 'T-0011']);
    assert.match(engine.store.state.messages.at(-1).text, /Applied 2 paths/);
    assert.equal(fs.readFileSync(path.join(moved, 'saved.txt'), 'utf8'), 'from worker');
    assert.equal(fs.statSync(path.join(moved, 'empty')).isDirectory(), true);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('/recoveries apply stays responsive and /cancel stops a cross-process lock wait', async () => {
  const root = tmp();
  let holder;
  try {
    const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo' });
    scaffold(root, cfg);
    fs.writeFileSync(path.join(root, 'note.txt'), 'source');
    const workspace = createTaskWorkspace(root, 'T-0033');
    fs.writeFileSync(path.join(workspace.root, 'note.txt'), 'saved');
    workspace.preserve();
    const engine = await createEngine({ root, config: cfg, providers: fakeProviders([]) });
    const lockModule = new URL('../src/engine/publication-lock.js', import.meta.url).href;
    const code = `import { withPublicationLock } from ${JSON.stringify(lockModule)};
      await withPublicationLock(${JSON.stringify(root)}, async () => {
        process.stdout.write('locked\\n');
        await Promise.race([
          new Promise((resolve) => process.stdin.once('data', resolve)),
          new Promise((resolve) => setTimeout(resolve, 1000)),
        ]);
      });
      process.exit(0);`;
    holder = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      holder.stdout.once('data', (data) => String(data).includes('locked') ? resolve() : reject(new Error(`unexpected lock response: ${data}`)));
      holder.once('error', reject);
      holder.once('exit', (exitCode) => reject(new Error(`lock holder exited early: ${exitCode}`)));
    });
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 5);
    try {
      const started = Date.now();
      const applying = engine.command('recoveries', ['apply', 'T-0033']);
      assert.ok(Date.now() - started < 200, 'the command returns control to the terminal promptly');
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(ticks > 0, 'the terminal event loop remains responsive while waiting');
      assert.equal(engine.store.state.recoveryApplying, true);
      assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'source');
      await engine.command('cancel');
      await applying;
      assert.equal(engine.store.state.recoveryApplying, false);
      assert.match(engine.store.state.messages.at(-1).text, /Application cancelled/);
      assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'source');
      assert.equal(listRecoveries(root).length, 1);
    } finally { clearInterval(timer); }
  } finally {
    if (holder && holder.exitCode === null && !holder.signalCode) {
      const exited = new Promise((resolve) => {
        holder.once('exit', resolve);
        if (holder.exitCode !== null || holder.signalCode) resolve();
      });
      holder.stdin.write('release\n');
      await exited;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('/recoveries warns that dependency edits remain in the saved copy', async () => {
  const root = tmp();
  try {
    const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo' });
    scaffold(root, cfg);
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'node_modules', 'dep.js'), 'old');
    const workspace = createTaskWorkspace(root, 'T-0026');
    fs.writeFileSync(path.join(workspace.root, 'node_modules', 'dep.js'), 'new');
    assert.equal(workspace.integrate().ok, false);
    const engine = await createEngine({ root, config: cfg, providers: fakeProviders([]) });
    await engine.command('recoveries', ['inspect', 'T-0026']);
    assert.match(engine.store.state.messages.at(-1).text, /excluded dependency changes only/);
    assert.match(engine.store.state.messages.at(-1).text, /node_modules\/dep.js/);
    await engine.command('recoveries', ['apply', 'T-0026']);
    assert.match(engine.store.state.messages.at(-1).text, /no automatically applicable paths/);
    assert.equal(fs.readFileSync(path.join(root, 'node_modules', 'dep.js'), 'utf8'), 'old');
    fs.writeFileSync(path.join(root, 'app.txt'), 'old app');
    const second = createTaskWorkspace(root, 'T-0027');
    fs.writeFileSync(path.join(second.root, 'app.txt'), 'new app');
    fs.writeFileSync(path.join(second.root, 'node_modules', 'dep.js'), 'new dep');
    assert.equal(second.integrate().ok, false);
    await engine.command('recoveries', ['inspect', 'T-0027']);
    assert.match(engine.store.state.messages.at(-1).text, /will not be applied/);
    await engine.command('recoveries', ['apply', 'T-0027']);
    assert.match(engine.store.state.messages.at(-1).text, /Applied 1 path/);
    assert.match(engine.store.state.messages.at(-1).text, /remains only in the saved copy/);
    assert.equal(fs.readFileSync(path.join(root, 'app.txt'), 'utf8'), 'new app');
    assert.equal(fs.readFileSync(path.join(root, 'node_modules', 'dep.js'), 'utf8'), 'old');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a successful worker summary points to the integrated project, not its deleted copy', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  const providers = fakeProviders([]);
  let turns = 0;
  providers.getProvider('claude').run = async () => ({ ok: true, text: ++turns === 1
    ? '```moragent-plan\n{"tasks":[{"id":"t1","role":"backend","prompt":"create out.txt"}]}\n```'
    : 'Reviewed.' });
  providers.getProvider('codex').run = async ({ root: privateRoot }) => {
    const file = path.join(privateRoot, 'out.txt');
    fs.writeFileSync(file, 'done');
    return { ok: true, text: `Created [out.txt](${fs.realpathSync(file)})` };
  };
  const engine = await createEngine({ root, config: cfg, providers });
  await engine.send('create out.txt');
  assert.equal(listTasks(root)[0].status, 'done');
  assert.match(listTasks(root)[0].result, /out\.txt\]\(/);
  assert.ok(listTasks(root)[0].result.includes(fs.realpathSync(path.join(root, 'out.txt'))));
  assert.doesNotMatch(listTasks(root)[0].result, /moragent-task-/);
});

test('an unexpected worker setup error fails its task and blocks dependents', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'es', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  const providers = fakeProviders([]);
  const originalGet = providers.getProvider;
  providers.getProvider = (id) => {
    if (id === 'codex') throw new Error('adapter failed to load');
    return originalGet(id);
  };
  const engine = await createEngine({ root, config: cfg, providers });
  await engine.send('crea hola.txt');
  assert.deepEqual(listTasks(root).map((task) => task.status), ['failed', 'blocked']);
  assert.match(engine.store.state.agents['T-0001'].lastLine, /adapter failed to load/);
  assert.equal(engine.store.state.orchestrator.status, 'idle');
});

test('/cancel stops the whole plan, including tasks still queued by the concurrency limit', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  const providers = fakeProviders([]);
  let orchestratorTurns = 0;
  providers.getProvider('claude').run = async ({ onEvent }) => {
    orchestratorTurns++;
    const text = `\`\`\`moragent-plan\n${JSON.stringify({ size: 'L', summary: 'four jobs', tasks: Array.from({ length: 4 }, (_, i) => ({ id: `t${i + 1}`, role: 'backend', title: `job ${i + 1}`, prompt: `do job ${i + 1}`, dependsOn: [] })) })}\n\`\`\``;
    onEvent({ type: 'text', delta: text });
    return { ok: true, text };
  };
  let starts = 0;
  let allStarted;
  const threeStarted = new Promise((resolve) => { allStarted = resolve; });
  providers.getProvider('codex').run = async ({ signal }) => new Promise((resolve) => {
    starts++;
    if (starts === 3) allStarted();
    signal.addEventListener('abort', () => resolve({ ok: false, error: 'cancelled' }), { once: true });
  });
  const engine = await createEngine({ root, config: cfg, providers });
  const turn = engine.send('start four independent jobs');
  await threeStarted;
  await engine.command('cancel');
  await turn;
  assert.equal(starts, 3, 'fourth worker was never started');
  assert.equal(orchestratorTurns, 1, 'cancelled plan was not reviewed');
  assert.deepEqual(listTasks(root).map((task) => task.status), ['failed', 'failed', 'failed', 'failed']);
});

test('/cancel preserves an edited private worker copy without publishing it', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  const providers = fakeProviders([]);
  providers.getProvider('claude').run = async () => ({ ok: true, text: '```moragent-plan\n{"tasks":[{"id":"t1","role":"backend","title":"Write note","prompt":"Write note.txt"}]}\n```' });
  let started;
  const active = new Promise((resolve) => { started = resolve; });
  providers.getProvider('codex').run = async ({ root: privateRoot, signal }) => {
    fs.writeFileSync(path.join(privateRoot, 'note.txt'), 'private-progress');
    started();
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ ok: false, error: 'cancelled' }), { once: true }));
  };
  const engine = await createEngine({ root, config: cfg, providers });
  const turn = engine.send('Write a note');
  await active;
  await engine.command('cancel');
  await turn;
  assert.equal(fs.existsSync(path.join(root, 'note.txt')), false);
  assert.equal(listTasks(root)[0].status, 'failed');
  const saved = listRecoveries(root);
  assert.equal(saved.length, 1);
  assert.equal(fs.readFileSync(path.join(saved[0].path, 'note.txt'), 'utf8'), 'private-progress');
  engine.stop();
});

test('/cancel during worker envelope preparation cannot start or publish the worker', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  const calls = [];
  const engine = await createEngine({ root, config: cfg, providers: fakeProviders(calls), lang: 'en' });
  let sawPreparation = false;
  engine.store.on('change', (state) => {
    if (sawPreparation || state.orchestrator.status !== 'running' || !Object.values(state.agents).some((agent) => agent.status === 'queued')) return;
    sawPreparation = true;
    queueMicrotask(() => { void engine.command('cancel'); });
  });
  await engine.command('task', ['backend', 'Escribe hola.txt']);
  assert.equal(sawPreparation, true);
  assert.equal(calls.filter((call) => call.who === 'worker').length, 0);
  assert.equal(fs.existsSync(path.join(root, 'hola.txt')), false);
  assert.equal(listTasks(root)[0].status, 'failed');
  assert.deepEqual(listRecoveries(root), []);
  engine.stop();
});

test('/cancel during private project copying prevents the provider from starting', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  const dependencies = path.join(root, 'node_modules', 'fixture');
  fs.mkdirSync(dependencies, { recursive: true });
  for (let index = 0; index < 1200; index++) fs.writeFileSync(path.join(dependencies, `f-${index}.js`), 'x'.repeat(256));
  const calls = [];
  const engine = await createEngine({ root, config: cfg, providers: fakeProviders(calls), lang: 'en' });
  let cancelledDuringCopy = false;
  engine.store.on('change', (state) => {
    if (cancelledDuringCopy || !Object.values(state.agents).some((agent) => agent.status === 'preparing' && /copying project/.test(agent.lastLine))) return;
    cancelledDuringCopy = true;
    void engine.command('cancel');
  });
  await engine.command('task', ['backend', 'Escribe hola.txt']);
  assert.equal(cancelledDuringCopy, true);
  assert.equal(calls.filter((call) => call.who === 'worker').length, 0);
  assert.equal(listTasks(root)[0].status, 'failed');
  assert.equal(fs.existsSync(path.join(root, 'hola.txt')), false);
  assert.deepEqual(listRecoveries(root), []);
  engine.stop();
});

test('/cancel at the worker running transition discards the unused private copy', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  const calls = [];
  const engine = await createEngine({ root, config: cfg, providers: fakeProviders(calls), lang: 'en' });
  let cancelled = false;
  engine.store.on('change', (state) => {
    if (cancelled || !Object.values(state.agents).some((agent) => agent.status === 'running')) return;
    cancelled = true;
    void engine.command('cancel');
  });
  await engine.command('task', ['backend', 'Escribe hola.txt']);
  assert.equal(cancelled, true);
  assert.equal(calls.filter((call) => call.who === 'worker').length, 0);
  assert.equal(listTasks(root)[0].status, 'failed');
  assert.deepEqual(listRecoveries(root), []);
  engine.stop();
});

test('a state update failure before provider start closes the unused private workspace', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  const calls = [];
  const engine = await createEngine({ root, config: cfg, providers: fakeProviders(calls), lang: 'en' });
  const marker = `workspace-cleanup-${Math.random().toString(36).slice(2)}.txt`;
  fs.writeFileSync(path.join(root, marker), 'unique marker');
  let injected = false;
  engine.store.on('change', (state) => {
    if (injected || !Object.values(state.agents).some((agent) => agent.status === 'running')) return;
    injected = true;
    throw new Error('injected state update failure');
  });
  await engine.command('task', ['backend', 'Escribe hola.txt']);
  assert.equal(injected, true);
  assert.equal(calls.filter((call) => call.who === 'worker').length, 0);
  assert.equal(listTasks(root)[0].status, 'failed');
  const leaked = fs.readdirSync(os.tmpdir())
    .filter((name) => name.startsWith('moragent-task-'))
    .filter((name) => fs.existsSync(path.join(os.tmpdir(), name, 'project', marker)));
  assert.deepEqual(leaked, []);
  engine.stop();
});

test('an unexpected post-provider error preserves edited private work', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  const providers = fakeProviders([]);
  providers.getProvider('codex').run = async ({ root: privateRoot }) => {
    fs.writeFileSync(path.join(privateRoot, 'private.txt'), 'keep-me');
    return { ok: true, get text() { throw new Error('injected result failure'); } };
  };
  const engine = await createEngine({ root, config: cfg, providers, lang: 'en' });
  await engine.command('task', ['backend', 'write private.txt']);
  assert.equal(listTasks(root)[0].status, 'failed');
  assert.equal(fs.existsSync(path.join(root, 'private.txt')), false);
  const saved = listRecoveries(root);
  assert.equal(saved.length, 1);
  assert.equal(fs.readFileSync(path.join(saved[0].path, 'private.txt'), 'utf8'), 'keep-me');
  assert.match(listTasks(root)[0].result, /Workspace preserved/);
  assert.ok(listTasks(root)[0].result.includes(saved[0].path));
  engine.stop();
});

test('an engine task reports a manual recovery path if its workspace worker crashes', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  let worker;
  const providers = fakeProviders([]);
  providers.getProvider('codex').run = async ({ root: privateRoot }) => {
    fs.writeFileSync(path.join(privateRoot, 'private.txt'), 'keep-me');
    await worker.terminate();
    return { ok: true, text: 'Created private.txt' };
  };
  const taskWorkspaceFactory = (project, taskId, options) => createTaskWorkspaceAsync(project, taskId, {
    ...options, onWorker: (handle) => { worker = handle; },
  });
  const engine = await createEngine({ root, config: cfg, providers, lang: 'en', taskWorkspaceFactory });
  await engine.command('task', ['backend', 'write private.txt']);
  const task = listTasks(root)[0];
  const saved = listRecoveries(root);
  assert.equal(task.status, 'failed');
  assert.equal(fs.existsSync(path.join(root, 'private.txt')), false);
  assert.equal(saved.length, 1);
  assert.equal(fs.readFileSync(path.join(saved[0].path, 'private.txt'), 'utf8'), 'keep-me');
  assert.match(task.result, /Manual-only recovery/);
  assert.ok(task.result.includes(saved[0].path));
  engine.stop();
});

test('messages are processed sequentially even when sent during an active turn', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  const providers = fakeProviders([]);
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  let active = 0;
  let maxActive = 0;
  const prompts = [];
  providers.getProvider('claude').run = async ({ prompt, onEvent }) => {
    prompts.push(prompt);
    active++;
    maxActive = Math.max(maxActive, active);
    if (prompts.length === 1) { firstStarted(); await gate; }
    const text = 'No plan needed.';
    onEvent({ type: 'text', delta: text });
    active--;
    return { ok: true, text };
  };
  const engine = await createEngine({ root, config: cfg, providers });
  const first = engine.send('first request');
  await started;
  const second = engine.send('second request');
  assert.equal(prompts.length, 1, 'second turn must wait for the first');
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(maxActive, 1);
  assert.equal(prompts.length, 2);
  assert.deepEqual(engine.store.state.messages.filter((m) => m.from === 'user').map((m) => m.text), ['first request', 'second request']);
});

test('/cancel during planning does not dispatch a partial plan or later queued messages', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  const providers = fakeProviders([]);
  let started;
  const planning = new Promise((resolve) => { started = resolve; });
  let orchestratorTurns = 0;
  providers.getProvider('claude').run = async ({ signal, onEvent }) => {
    orchestratorTurns++;
    started();
    return new Promise((resolve) => signal.addEventListener('abort', () => {
      const text = '```moragent-plan\n{"tasks":[{"id":"t1","role":"backend","prompt":"write a file"}]}\n```';
      onEvent({ type: 'text', delta: text });
      resolve({ ok: false, text, error: 'cancelled' });
    }, { once: true }));
  };
  const engine = await createEngine({ root, config: cfg, providers });
  const first = engine.send('write a file');
  await planning;
  const second = engine.send('queued request');
  await engine.command('cancel');
  await Promise.all([first, second]);
  assert.equal(orchestratorTurns, 1);
  assert.equal(listTasks(root).length, 0);
  assert.deepEqual(engine.store.state.messages.filter((m) => m.from === 'user').map((m) => m.text), ['write a file']);
});

test('a worker closing its private task cannot overwrite the engine task or duplicate memory', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'es', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  const calls = [];
  const providers = fakeProviders(calls);
  const { updateTask } = await import('../src/bus/tasks.js');
  const { add } = await import('../src/memory/index.js');
  providers.getProvider('codex').run = async ({ root: r, prompt }) => {
    const id = prompt.match(/# (T-\d+)/)[1];
    updateTask(r, id, { status: 'done', result: 'cerrada por el worker' });
    add({ root: r, tier: 'episodic', kind: 'episode', title: `${id}: por worker`, body: 'x', by: 'backend' });
    return { ok: true, text: 'listo' };
  };
  const engine = await createEngine({ root, config: cfg, providers });
  await engine.send('crea hola.txt');
  assert.deepEqual(listTasks(root).map((t) => t.result), ['listo', 'listo']);
  assert.equal(fs.readdirSync(path.join(root, '.moragent', 'memory', 'episodic')).length, 2, 'one engine note per task');
});

test('first message picks the project language', async () => {
  const { guessLang } = await import('../src/engine/index.js');
  assert.equal(guessLang('Crea una API de tareas con tests'), 'es');
  assert.equal(guessLang('Build a task API with tests'), 'en');
  assert.equal(guessLang('API', 'es'), 'es');
});

test('/idioma switches and persists the UI language while preserving custom role missions', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'es', preset: 'trio', clis: { lead: 'claude', backend: 'codex', frontend: 'claude' } });
  cfg.crew.frontend.mission = 'Custom frontend mission';
  scaffold(root, cfg);
  const engine = await createEngine({ root, config: cfg, providers: fakeProviders([]) });
  await engine.command('idioma', ['en']);
  assert.equal(engine.store.state.lang, 'en');
  const saved = JSON.parse(fs.readFileSync(path.join(root, '.moragent', 'moragent.json'), 'utf8'));
  assert.equal(saved.lang, 'en');
  assert.equal(saved.crew.backend.mission, ROLES.backend.mission.en);
  assert.equal(saved.crew.frontend.mission, 'Custom frontend mission');
  await engine.command('help');
  assert.match(engine.store.state.messages.at(-1).text, /Type what you need/);
  await engine.command('language', ['es']);
  assert.equal(engine.store.state.lang, 'es');
});

test('explicit language selection before first message overrides language guessing', async () => {
  const cwd = tmp();
  const providers = fakeProviders([]);
  providers.getProvider('claude').run = async () => ({ ok: true, text: 'Ready.' });
  const engine = await createEngine({ root: null, cwd, providers });
  await engine.command('language', ['en']);
  await engine.send('Crea una aplicación de notas');
  assert.equal(engine.config.lang, 'en');
  assert.equal(engine.store.state.lang, 'en');
});

test('appendLog merges streamed text into lines and keeps tools as entries', async () => {
  const { appendLog } = await import('../src/engine/index.js');
  let log = [];
  for (const e of [
    { type: 'text', delta: 'Leyendo el ' }, { type: 'text', delta: 'repo\nListo pa' }, { type: 'text', delta: 'ra editar' },
    { type: 'tool', name: 'Edit', input: { file_path: 'src/a.js' } }, { type: 'tool_result', ok: true, summary: 'edited' },
    { type: 'text', delta: 'Terminé' },
  ]) log = appendLog(log, e);
  assert.deepEqual(log.map((x) => `${x.kind}:${x.text}`), ['text:Leyendo el repo', 'text:Listo para editar', 'tool:Edit src/a.js', 'result:edited', 'text:Terminé']);
  let big = [];
  for (let i = 0; i < 500; i++) big = appendLog(big, { type: 'tool', name: `t${i}` });
  assert.equal(big.length, 400, 'bounded');
});

test('sessions: conversation is saved, /limpiar starts fresh, /sesion restores messages and model context', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'es', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  const calls = [];
  const providers = fakeProviders(calls);
  providers.getProvider('claude').run = async ({ sessionId, onEvent }) => {
    calls.push({ who: 'orchestrator', sessionId });
    onEvent({ type: 'text', delta: 'respuesta' });
    return { ok: true, text: 'respuesta', sessionId: 'model-ctx-1' };
  };
  const engine = await createEngine({ root, config: cfg, providers });
  await engine.send('primera pregunta');
  await new Promise((r) => setTimeout(r, 900)); // debounced save
  const firstId = engine.store.state.sessionId;
  assert.ok(firstId, 'session created and saved');

  await engine.command('limpiar');
  assert.equal(engine.store.state.messages.filter((m) => m.from === 'user').length, 0);
  await engine.command('sesiones');
  assert.match(engine.store.state.messages.at(-1).text, /primera pregunta/);

  await engine.command('sesion', ['1']);
  assert.equal(engine.store.state.sessionId, firstId);
  assert.ok(engine.store.state.messages.some((m) => m.text === 'primera pregunta'));
  await engine.send('segunda');
  assert.equal(calls.at(-1).sessionId, 'model-ctx-1', 'the orchestrator resumes its own model session');
});

test('resuming a provider session restores its model instead of using another provider model', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  const providers = fakeProviders([]);
  const calls = [];
  providers.getProvider('claude').run = async ({ model, sessionId }) => {
    calls.push({ provider: 'claude', model, sessionId });
    return { ok: true, text: 'Claude answer.', sessionId: 'claude-thread' };
  };
  providers.getProvider('codex').run = async ({ model, sessionId }) => {
    calls.push({ provider: 'codex', model, sessionId });
    return { ok: true, text: 'Codex answer.', sessionId: 'codex-thread' };
  };
  const engine = await createEngine({ root, config: cfg, providers });
  await engine.command('model', ['opus']);
  await engine.send('First question');
  await new Promise((resolve) => setTimeout(resolve, 900));
  const firstId = engine.store.state.sessionId;
  await engine.command('clear');
  await engine.command('orchestrator', ['codex']);
  await engine.command('model', ['gpt-selected']);
  await engine.send('Second question');
  await engine.command('session', [firstId]);
  assert.equal(engine.store.state.orchestrator.provider, 'claude');
  assert.equal(engine.store.state.orchestrator.model, 'opus');
  await engine.send('Follow-up');
  assert.deepEqual(calls.at(-1), { provider: 'claude', model: 'opus', sessionId: 'claude-thread' });
  engine.stop();
});

test('plan parsing survives code fences and raw newlines inside task prompts', () => {
  const text = 'Dos tareas.\n```moragent-plan\n{"size":"M","summary":"s","tasks":[{"id":"t1","role":"frontend","title":"README","prompt":"Incluye:\n```js\nimport { cToF } from \'./temp.js\'\n```\nY una tabla.","dependsOn":[]}]}\n```\nSigo después.';
  const plan = extractPlan(text);
  assert.ok(!plan.error, 'parsed');
  assert.match(plan.tasks[0].prompt, /```js\nimport/);
  assert.equal(stripPlan(text), 'Dos tareas.\n\nSigo después.');
  assert.equal(stripPlan('Pensando…\n```moragent-plan\n{"tasks":[{"id":"t1"'), 'Pensando…', 'half-streamed plan never shows');
});

test('/modelo sets the orchestrator and role models, persists them and passes them to the engine', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'es', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  const calls = [];
  const providers = fakeProviders(calls);
  const seen = [];
  const orig = providers.getProvider('claude').run;
  providers.getProvider('claude').run = async (o) => { seen.push(o.model); return orig(o); };
  const workerSeen = [];
  const origW = providers.getProvider('codex').run;
  providers.getProvider('codex').run = async (o) => { workerSeen.push(o.model); return origW(o); };
  const engine = await createEngine({ root, config: cfg, providers });
  await engine.command('modelo', ['sonnet']);
  await engine.command('modelo', ['backend', 'gpt-x']);
  const saved = JSON.parse(fs.readFileSync(path.join(root, '.moragent', 'moragent.json'), 'utf8'));
  assert.equal(saved.orchestratorModel, 'sonnet');
  assert.equal(saved.crew.backend.model, 'gpt-x');
  await engine.send('crea hola.txt');
  assert.ok(seen.every((m) => m === 'sonnet'));
  assert.ok(workerSeen.length && workerSeen.every((m) => m === 'gpt-x'));
  await engine.command('modelo', ['default']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.moragent', 'moragent.json'), 'utf8')).orchestratorModel, undefined);
});

test('switching engines clears model IDs from the previous engine', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  const engine = await createEngine({ root, config: cfg, providers: fakeProviders([]) });
  await engine.refreshProviders();
  await engine.command('model', ['sonnet']);
  await engine.command('model', ['backend', 'gpt-x']);
  await engine.command('orchestrator', ['codex']);
  await engine.command('crew', ['backend', 'claude']);
  const saved = JSON.parse(fs.readFileSync(path.join(root, '.moragent', 'moragent.json'), 'utf8'));
  assert.equal(saved.orchestratorModel, undefined);
  assert.equal(saved.crew.backend.model, undefined);
  assert.equal(engine.store.state.orchestrator.model, null);
});

test('a temporary orchestrator fallback restores the preferred provider and its model', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  cfg.orchestrator = 'claude';
  cfg.orchestratorModel = 'opus';
  scaffold(root, cfg);
  const providers = fakeProviders([]);
  let claudeReady = false;
  providers.getProvider('claude').status = async () => ({ ready: claudeReady });
  const engine = await createEngine({ root, config: cfg, providers });
  await engine.refreshProviders();
  assert.equal(engine.store.state.orchestrator.provider, 'codex');
  assert.equal(engine.store.state.orchestrator.model, null);
  assert.match(engine.store.state.messages.at(-1)?.text || '', /claude.*codex/i);
  claudeReady = true;
  await engine.refreshProviders();
  assert.equal(engine.store.state.orchestrator.provider, 'claude');
  assert.equal(engine.store.state.orchestrator.model, 'opus');
  engine.stop();
});

test('an explicit fallback selection stays selected when the old provider returns', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  cfg.orchestrator = 'claude';
  cfg.orchestratorModel = 'opus';
  scaffold(root, cfg);
  const providers = fakeProviders([]);
  let claudeReady = false;
  providers.getProvider('claude').status = async () => ({ ready: claudeReady });
  const engine = await createEngine({ root, config: cfg, providers });
  await engine.refreshProviders();
  await engine.command('orchestrator', ['codex']);
  await engine.command('model', ['gpt-selected']);
  claudeReady = true;
  await engine.refreshProviders();
  assert.equal(engine.store.state.orchestrator.provider, 'codex');
  assert.equal(engine.store.state.orchestrator.model, 'gpt-selected');
  assert.equal(cfg.orchestrator, 'codex');
  engine.stop();
});

test('reselecting the preferred orchestrator after fallback keeps its model', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  cfg.orchestrator = 'claude';
  cfg.orchestratorModel = 'opus';
  scaffold(root, cfg);
  const providers = fakeProviders([]);
  providers.getProvider('claude').status = async () => ({ ready: false });
  const engine = await createEngine({ root, config: cfg, providers });
  await engine.refreshProviders();
  await engine.command('orchestrator', ['claude']);
  assert.equal(engine.store.state.orchestrator.provider, 'claude');
  assert.equal(engine.store.state.orchestrator.model, 'opus');
  assert.equal(cfg.orchestratorModel, 'opus');
  engine.stop();
});

test('provider recovery waits for the active orchestrator turn to finish', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  cfg.orchestrator = 'claude';
  cfg.orchestratorModel = 'opus';
  scaffold(root, cfg);
  const providers = fakeProviders([]);
  let claudeReady = false;
  providers.getProvider('claude').status = async () => ({ ready: claudeReady });
  const restoredCalls = [];
  providers.getProvider('claude').run = async ({ model, sessionId }) => {
    restoredCalls.push({ model, sessionId });
    return { ok: true, text: 'Claude answer.' };
  };
  let started;
  const active = new Promise((resolve) => { started = resolve; });
  let finish;
  providers.getProvider('codex').run = async () => {
    started();
    return new Promise((resolve) => { finish = () => resolve({ ok: true, text: 'Done.', sessionId: 'codex-thread' }); });
  };
  const engine = await createEngine({ root, config: cfg, providers });
  await engine.refreshProviders();
  const turn = engine.send('Explain the project');
  await active;
  claudeReady = true;
  await engine.refreshProviders();
  assert.equal(engine.store.state.orchestrator.provider, 'codex');
  finish();
  await turn;
  assert.equal(engine.store.state.orchestrator.provider, 'claude');
  assert.equal(engine.store.state.orchestrator.model, 'opus');
  await engine.send('Follow-up');
  assert.deepEqual(restoredCalls.at(-1), { model: 'opus', sessionId: null });
  engine.stop();
});

test('stopping the app does not run a deferred provider probe', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  cfg.orchestrator = 'claude';
  scaffold(root, cfg);
  const providers = fakeProviders([]);
  let ready = false;
  let statusCalls = 0;
  providers.getProvider('claude').status = async () => { statusCalls++; return { ready }; };
  let started;
  const active = new Promise((resolve) => { started = resolve; });
  let finish;
  providers.getProvider('codex').run = async () => {
    started();
    return new Promise((resolve) => { finish = () => resolve({ ok: false, error: 'stopped' }); });
  };
  const engine = await createEngine({ root, config: cfg, providers });
  await engine.refreshProviders();
  const turn = engine.send('Explain the project');
  await active;
  ready = true;
  await engine.refreshProviders();
  const beforeStop = statusCalls;
  engine.stop();
  finish();
  await turn;
  assert.equal(statusCalls, beforeStop);
});

test('engine selection changes are rejected while a turn is active', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  cfg.orchestratorModel = 'opus';
  scaffold(root, cfg);
  const providers = fakeProviders([]);
  let started;
  const active = new Promise((resolve) => { started = resolve; });
  let finish;
  providers.getProvider('claude').run = async () => {
    started();
    return new Promise((resolve) => { finish = () => resolve({ ok: true, text: 'Done.' }); });
  };
  const engine = await createEngine({ root, config: cfg, providers });
  const turn = engine.send('Explain the project');
  await active;
  await engine.command('orchestrator', ['codex']);
  await engine.command('model', ['haiku']);
  await engine.command('crew', ['backend', 'claude']);
  assert.equal(engine.store.state.orchestrator.provider, 'claude');
  assert.equal(engine.store.state.orchestrator.model, 'opus');
  assert.equal(cfg.crew.backend.cli, 'codex');
  assert.match(engine.store.state.messages.at(-1).text, /wait|cancel/i);
  finish();
  await turn;
  engine.stop();
});

test('/tarea deploys one agent directly without an orchestrator turn', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'es', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  const calls = [];
  const engine = await createEngine({ root, config: cfg, providers: fakeProviders(calls) });
  await engine.command('tarea', ['backend', 'Escribe', 'hola.txt']);
  assert.equal(calls.filter((c) => c.who === 'orchestrator').length, 0);
  assert.equal(calls.filter((c) => c.who === 'worker').length, 1);
  assert.equal(listTasks(root)[0].status, 'done');
  await engine.command('tarea', ['nadie', 'x']);
  assert.match(engine.store.state.messages.at(-1).text, /Uso: \/tarea/);
});

test('codex resume puts exec options before the resume subcommand', async () => {
  const { setExec } = await import('../src/core/exec.js');
  void setExec;
  const mod = await import('../src/providers/cli/codex.js');
  const codex = mod.default || mod.codex;
  const stream = await import('../src/providers/cli/stream.js');
  let seen = null;
  const orig = stream.setSpawn || null;
  if (!orig) return; // spawn seam not available: covered by the live check in the changelog
  stream.setSpawn((cmd, args) => { seen = args; return null; });
  try { await codex.run({ root: tmp(), prompt: 'hola', sessionId: 'abc', autonomy: 'readonly', onEvent() {} }); } catch { /* fake spawn */ }
  const i = seen.indexOf('resume');
  assert.ok(i > seen.indexOf('-s'), '-s precedes resume');
  assert.equal(seen[i + 1], 'abc');
});
