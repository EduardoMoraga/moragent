import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTask, getTask, listTasks, nextId, reserveTaskId, updateTask } from '../src/bus/tasks.js';
import { buildEnvelope, writeEnvelope } from '../src/bus/envelope.js';
import { ensureDir, readText, writeText } from '../src/core/fsx.js';
import { dirs } from '../src/core/paths.js';
import { parseDuration } from '../src/bus/wait.js';

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
