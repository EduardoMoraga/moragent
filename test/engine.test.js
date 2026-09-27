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
