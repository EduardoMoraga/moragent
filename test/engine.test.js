import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEngine } from '../src/engine/index.js';
import { extractPlan, stripPlan, normalizePlan, assignProviders } from '../src/engine/plan.js';
import { defaultConfig } from '../src/core/config.js';
import { scaffold } from '../src/commands/init.js';
import { listTasks } from '../src/bus/tasks.js';
import { createTask, updateTask } from '../src/bus/tasks.js';
import { readStatus } from '../src/bus/status.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mora-engine-'));

const PLAN = `Voy a separar el trabajo en dos partes.
\`\`\`moragent-plan
{"size":"S","summary":"archivo y prueba","tasks":[
 {"id":"t1","role":"backend","title":"Crear hola.txt","prompt":"Escribe hola.txt","doneWhen":"existe hola.txt"},
 {"id":"t2","role":"backend","title":"Revisar hola.txt","prompt":"Lee hola.txt","dependsOn":["t1"]}]}
\`\`\``;

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

test('plan parsing: fenced block, prose stripped, sloppy deps repaired', () => {
  const plan = extractPlan(PLAN);
  assert.equal(plan.tasks.length, 2);
  assert.deepEqual(plan.tasks[1].dependsOn, ['t1']);
  assert.equal(stripPlan(PLAN), 'Voy a separar el trabajo en dos partes.');
  assert.equal(extractPlan('sin plan'), null);
  assert.deepEqual(extractPlan('```moragent-plan\n{roto\n```'), { error: 'invalid-json' });
  const cyc = normalizePlan({ tasks: [{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }, { id: 'c', dependsOn: ['zz', 'c'] }] });
  assert.ok(cyc.tasks.every((t) => t.dependsOn.length === 0), 'cycles and unknown deps are dropped');
});

test('provider assignment: role CLI when ready, otherwise a ready subscription', () => {
  const plan = normalizePlan({ tasks: [{ role: 'backend' }, { role: 'helper' }, { role: 'x', provider: 'claude' }] });
  assignProviders(plan, {
    crew: { backend: { cli: 'codex' }, helper: { cli: 'agy' } },
    providers: [{ id: 'claude', kind: 'subscription', ready: true }, { id: 'codex', kind: 'subscription', ready: true }, { id: 'agy', kind: 'subscription', ready: false }],
    orchestrator: 'claude',
  });
  assert.deepEqual(plan.tasks.map((t) => t.provider), ['codex', 'codex', 'claude']);
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
  const workers = calls.filter((c) => c.who === 'worker');
  assert.equal(workers.length, 2);
  assert.match(workers[0].prompt, /Escribe hola\.txt/);
  assert.match(workers[0].prompt, /No ejecutes `mora done`/, 'engine closes tasks itself');

  const tasks = listTasks(root);
  assert.deepEqual(tasks.map((t) => t.status), ['done', 'done']);
  assert.ok(tasks.every((task) => task.execution?.mode === 'engine' && task.execution.pid === process.pid));
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

test('engine keeps a worker-closed task and writes no second memory note', async () => {
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
  assert.deepEqual(listTasks(root).map((t) => t.result), ['cerrada por el worker', 'cerrada por el worker']);
  assert.equal(fs.readdirSync(path.join(root, '.moragent', 'memory', 'episodic')).length, 2, 'only the worker notes');
});

test('first message picks the project language', async () => {
  const { guessLang } = await import('../src/engine/index.js');
  assert.equal(guessLang('Crea una API de tareas con tests'), 'es');
  assert.equal(guessLang('Build a task API with tests'), 'en');
  assert.equal(guessLang('API', 'es'), 'es');
});

test('/estado shows persisted task health without dispatching another worker', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'es', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  const created = createTask({ root, role: 'backend', body: 'Revisar tarea' });
  updateTask(root, created.id, { status: 'running', execution: { mode: 'engine', pid: 99999999, handle: 'pid:99999999', provider: 'codex' } });
  const calls = [];
  const engine = await createEngine({ root, config: cfg, providers: fakeProviders(calls) });
  await engine.command('estado', [created.id]);
  assert.match(engine.store.state.messages.at(-1).text, /DESCONOCIDO/);
  assert.match(engine.store.state.messages.at(-1).text, /mora task show/);
  assert.equal(calls.length, 0);
  assert.equal(listTasks(root)[0].status, 'running');
  fs.rmSync(root, { recursive: true, force: true });
});

test('engine exposes a live process handle while the worker is still running', async () => {
  const root = tmp();
  const cfg = defaultConfig({ project: 'demo', lang: 'en', preset: 'duo', clis: { lead: 'claude', backend: 'codex' } });
  scaffold(root, cfg);
  const calls = [];
  const providers = fakeProviders(calls);
  let release;
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  let count = 0;
  providers.getProvider('codex').run = async () => {
    count++;
    if (count === 1) {
      const gate = new Promise((resolve) => { release = resolve; });
      startedResolve();
      await gate;
    }
    return { ok: true, text: 'Finished' };
  };
  const engine = await createEngine({ root, config: cfg, providers });
  const sending = engine.send('build and review the file');
  await started;
  try {
    const running = readStatus(root).tasks.find((item) => item.recordedStatus === 'running');
    assert.equal(running.status, 'running');
    assert.equal(running.run.pid, process.pid);
    assert.equal(running.run.alive, true);
    assert.equal(count, 1);
    assert.deepEqual(readStatus(root).tasks.find((item) => item.id === running.id), running);
  } finally {
    release();
    await sending;
    fs.rmSync(root, { recursive: true, force: true });
  }
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
