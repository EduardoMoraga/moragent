import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTask, createChildTask, getTask, listTasks, nextId, reserveTaskId, updateTask } from '../src/bus/tasks.js';
import { buildEnvelope, writeEnvelope } from '../src/bus/envelope.js';
import { ensureDir, readText, writeText } from '../src/core/fsx.js';
import { dirs } from '../src/core/paths.js';
import { parseDuration } from '../src/bus/wait.js';
import taskCommand from '../src/commands/task.js';

// These tests assert the POSIX command strings; Windows variants pass platform: 'win32' explicitly.
Object.defineProperty(process, 'platform', { value: 'linux' });

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora bus '));
  for (const key of ['tasks', 'specs']) ensureDir(dirs(root)[key]);
  return root;
}

const cfg = {
  lang: 'es',
  crew: { backend: { mission: 'Construye la lógica del servidor.' } },
};

test('task bus allocates ids, filters and preserves immutable fields', () => {
  const root = project();
  const one = createTask({ root, title: 'Primera', role: 'backend', body: 'Implementa uno', by: 'lead' });
  const two = createTask({ root, title: 'Segunda', role: 'helper', body: 'Revisa dos', by: 'lead' });
  assert.equal(one.id, 'T-0001');
  assert.equal(two.id, 'T-0002');
  assert.equal(nextId(root), 'T-0003');
  const done = updateTask(root, one.id, { id: 'evil', createdAt: 'never', status: 'done', result: 'listo' });
  assert.equal(done.id, one.id);
  assert.equal(done.createdAt, one.createdAt);
  assert.deepEqual(listTasks(root, { status: 'done' }).map((task) => task.id), ['T-0001']);
  assert.deepEqual(listTasks(root, { role: 'helper' }).map((task) => task.id), ['T-0002']);
  assert.equal(getTask(root, two.id).body, 'Revisa dos');
  assert.deepEqual([one.parentId, one.depth, one.dependencies], [null, 0, []]);
});

test('child tasks persist their ancestry and sibling dependencies', () => {
  const root = project();
  const parent = createTask({ root, role: 'investigador', body: 'Prepara el estudio' });
  updateTask(root, parent.id, { status: 'running' });
  const first = createChildTask({ root, parentId: parent.id, role: 'redactor', body: 'Redacta notas', maxDepth: 2 });
  updateTask(root, first.id, { status: 'done' });
  const second = createChildTask({ root, parentId: parent.id, role: 'revisor', body: 'Revisa notas', dependencies: [first.id], maxDepth: 2 });
  const grandchild = createChildTask({ root, parentId: second.id, role: 'revisor', body: 'Revisa fuentes', maxDepth: 2 });
  assert.deepEqual([getTask(root, second.id).parentId, getTask(root, second.id).depth, getTask(root, second.id).dependencies], [parent.id, 1, [first.id]]);
  assert.deepEqual([grandchild.parentId, grandchild.depth], [second.id, 2]);
  assert.deepEqual(listTasks(root, { parentId: parent.id }).map((task) => task.id), [first.id, second.id]);
  assert.deepEqual(listTasks(root, { parentId: null }).map((task) => task.id), [parent.id]);
  const patched = updateTask(root, second.id, { parentId: first.id, depth: 99, result: 'revisado' });
  assert.deepEqual([patched.parentId, patched.depth], [parent.id, 1]);
});

test('child limits and dependency validation reject unsafe trees without creating records', () => {
  const root = project();
  const parent = createTask({ root, role: 'investigador', body: 'Prepara el estudio' });
  const a = createChildTask({ root, parentId: parent.id, role: 'redactor', body: 'A', maxConcurrentChildren: 1 });
  assert.throws(() => createChildTask({ root, parentId: parent.id, role: 'redactor', body: 'B', maxConcurrentChildren: 1 }), (error) => error.code === 'TASK_CONCURRENCY_LIMIT');
  updateTask(root, a.id, { status: 'done' });
  const b = createChildTask({ root, parentId: parent.id, role: 'revisor', body: 'B', dependencies: [a.id], maxConcurrentChildren: 1 });
  assert.throws(() => createChildTask({ root, parentId: b.id, role: 'revisor', body: 'too deep', maxDepth: 1 }), (error) => error.code === 'TASK_DEPTH_LIMIT');
  assert.throws(() => createChildTask({ root, parentId: parent.id, role: 'revisor', body: 'bad dep', dependencies: [parent.id] }), (error) => error.code === 'BAD_DEPENDENCIES');
  assert.throws(() => updateTask(root, a.id, { dependencies: [b.id] }), (error) => error.code === 'BAD_DEPENDENCIES');
  assert.throws(() => updateTask(root, parent.id, { status: 'done' }), (error) => error.code === 'CHILD_TASKS_ACTIVE');
  updateTask(root, b.id, { status: 'done' });
  updateTask(root, parent.id, { status: 'done' });
  assert.throws(() => createChildTask({ root, parentId: parent.id, role: 'revisor', body: 'too late' }), (error) => error.code === 'PARENT_NOT_ACTIVE');
  assert.deepEqual(listTasks(root).map((task) => task.id), [parent.id, a.id, b.id]);
});

test('legacy task records remain readable and acquire tree fields on update', () => {
  const root = project();
  const legacy = createTask({ root, role: 'backend', body: 'Existing work' });
  const file = path.join(dirs(root).tasks, `${legacy.id}.json`);
  const old = { ...legacy };
  delete old.parentId; delete old.depth; delete old.dependencies;
  fs.writeFileSync(file, JSON.stringify(old));
  assert.equal(getTask(root, legacy.id).parentId, undefined);
  const updated = updateTask(root, legacy.id, { status: 'running' });
  assert.deepEqual([updated.parentId, updated.depth, updated.dependencies], [null, 0, []]);
});

test('task add --parent creates a visible child through the CLI command', async () => {
  const root = project();
  const parent = createTask({ root, role: 'backend', body: 'Lead the work' });
  await taskCommand.run({ _: ['add', 'backend', 'Inspect evidence'], flags: { parent: parent.id } }, { root, config: cfg, json: false });
  const children = listTasks(root, { parentId: parent.id });
  assert.equal(children.length, 1);
  assert.equal(children[0].depth, 1);
  assert.equal(children[0].body, 'Inspect evidence');
  assert.match(readText(path.join(dirs(root).tasks, `${children[0].id}.md`)), new RegExp(parent.id));
});

test('missing tasks produce a typed error', () => {
  const root = project();
  assert.throws(() => getTask(root, 'T-9999'), (error) => error.code === 'TASK_NOT_FOUND');
});

test('task ids are reserved exclusively before records are written', () => {
  const root = project();
  assert.equal(reserveTaskId(root), 'T-0001');
  assert.equal(reserveTaskId(root), 'T-0002');
  assert.equal(nextId(root), 'T-0003');
  const task = createTask({ root, role: 'backend', body: 'Concurrent work' });
  assert.equal(task.id, 'T-0003');
  assert.equal(getTask(root, task.id).body, 'Concurrent work');
});

test('durations without suffix default to seconds', () => {
  assert.equal(parseDuration('30', 1), 30000);
  assert.equal(parseDuration('30ms', 1), 30);
  assert.equal(parseDuration('2m', 1), 120000);
});

test('envelope includes mission, spec, acceptance and exit protocol', async () => {
  const root = project();
  const specDir = path.join(dirs(root).specs, 'auth');
  ensureDir(specDir);
  writeText(path.join(specDir, 'spec.md'), '# Auth\nUsar tokens rotatorios.');
  writeText(path.join(specDir, 'tasks.md'), '- [ ] Endpoint login');
  const task = createTask({ root, title: 'Login', role: 'backend', body: 'Implementa login', spec: 'auth', by: 'lead' });
  const text = await buildEnvelope({ root, task, config: cfg });
  assert.match(text, /Construye la lógica/);
  assert.match(text, /Usar tokens rotatorios/);
  assert.match(text, /Criterios de aceptación/);
  assert.match(text, /mora(\.js)?['"]? done T-0001/);
  const file = await writeEnvelope({ root, task, config: cfg });
  const withoutGeneratedAt = (value) => value.replace(/^(Generado|Generated): .+$/m, '$1: <timestamp>');
  assert.match(text, /^(Generado|Generated): \d{4}-\d{2}-\d{2}T/m);
  assert.equal(withoutGeneratedAt(readText(file)), withoutGeneratedAt(text));
});
