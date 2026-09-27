import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repo = path.resolve('.');
const mora = path.join(repo, 'bin', 'mora.js');
const hasBackendCommands = ['dispatch.js', 'wait.js', 'done.js', 'block.js']
  .every((file) => fs.existsSync(path.join(repo, 'src', 'commands', file)));

function makeFakePath(tmp) {
  const bin = path.join(tmp, 'fake-bin');
  fs.mkdirSync(bin, { recursive: true });
  const fake = path.join(repo, 'test', 'fixtures', 'fake-agent.js');
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`);
  } else {
    const codex = path.join(bin, 'codex');
    fs.writeFileSync(codex, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
    fs.chmodSync(codex, 0o755);
  }
  return `${bin}${path.delimiter}${process.env.PATH || ''}`;
}

const runMaybe = hasBackendCommands ? test : test.skip;

runMaybe('e2e: dispatch headless to fake agent, wait, result file and episodic memory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moragent-e2e-'));
  const env = { ...process.env, PATH: makeFakePath(root), MORAGENT_BIN: mora, NO_COLOR: '1' };

  execFileSync(process.execPath, [mora, 'init', '--yes', '--preset', 'duo', '--dir', root, '--json'], { env, encoding: 'utf8' });

  const dispatched = JSON.parse(execFileSync(
    process.execPath,
    [mora, 'dispatch', 'backend', 'crear archivo', '--headless', '--json'],
    { cwd: root, env, encoding: 'utf8' },
  ));
  assert.equal(dispatched.task.id, 'T-0001');

  const waited = JSON.parse(execFileSync(
    process.execPath,
    [mora, 'wait', 'T-0001', '--timeout', '60s', '--interval', '100ms', '--json'],
    { cwd: root, env, encoding: 'utf8' },
  ));
  assert.equal(waited.ok, true);
  assert.equal(waited.tasks[0].status, 'done');
  assert.deepEqual(waited.tasks[0].files, [path.join('out', 'T-0001.txt')]);

  assert.equal(fs.readFileSync(path.join(root, 'out', 'T-0001.txt'), 'utf8'), 'fake ok T-0001\n');
  const episodic = path.join(root, '.moragent', 'memory', 'episodic');
  const notes = fs.readdirSync(episodic).filter((name) => name.endsWith('.md'));
  assert.ok(notes.length > 0, 'episodic memory note should be created by mora done');
  assert.ok(notes.some((name) => fs.readFileSync(path.join(episodic, name), 'utf8').includes('fake ok')));
});

runMaybe('e2e: spec tasks --dispatch creates one bus task per task and is idempotent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moragent-spec-dispatch-'));
  const env = { ...process.env, PATH: makeFakePath(root), MORAGENT_BIN: mora, NO_COLOR: '1' };

  execFileSync(process.execPath, [mora, 'init', '--yes', '--preset', 'duo', '--dir', root, '--json'], { env, encoding: 'utf8' });
  execFileSync(process.execPath, [mora, 'spec', 'new', 'api-tasks', '--title', 'API tasks', '--json'], { cwd: root, env, encoding: 'utf8' });

  const specDir = path.join(root, '.moragent', 'specs', 'api-tasks');
  fs.writeFileSync(path.join(specDir, 'proposal.md'), '# Propuesta\n\nCrear API de tareas.\n');
  fs.writeFileSync(path.join(specDir, 'spec.md'), '- RF-1: Cuando el usuario crea una tarea, el sistema debe guardarla.\n');
  fs.writeFileSync(path.join(specDir, 'design.md'), '# Diseño\n\nEndpoints CRUD simples.\n');
  fs.writeFileSync(path.join(specDir, 'tasks.md'), [
    '# Tareas',
    '',
    '- [ ] T1: Crear endpoint de tareas @backend — Listo cuando: existe POST /tasks',
    '- [ ] T2: Crear listado de tareas @backend — Done when: existe GET /tasks',
    '',
  ].join('\n'));

  const first = JSON.parse(execFileSync(
    process.execPath,
    [mora, 'spec', 'tasks', 'api-tasks', '--dispatch', '--json'],
    { cwd: root, env, encoding: 'utf8' },
  ));
  assert.equal(first.dispatched.length, 2);

  const taskDir = path.join(root, '.moragent', 'tasks');
  const jsonTasks = fs.readdirSync(taskDir).filter((name) => /^T-\d{4}\.json$/.test(name)).sort();
  const mdTasks = fs.readdirSync(taskDir).filter((name) => /^T-\d{4}\.md$/.test(name)).sort();
  assert.deepEqual(jsonTasks, ['T-0001.json', 'T-0002.json']);
  assert.deepEqual(mdTasks, ['T-0001.md', 'T-0002.md']);

  const records = jsonTasks.map((name) => JSON.parse(fs.readFileSync(path.join(taskDir, name), 'utf8')));
  assert.deepEqual(records.map((task) => task.title), ['Crear endpoint de tareas', 'Crear listado de tareas']);
  assert.ok(records.every((task) => task.spec === 'api-tasks'));
  assert.ok(records.every((task) => /tareas|tasks/i.test(task.body)));
  assert.ok(mdTasks.every((name) => /Exit protocol|Protocolo de salida/.test(fs.readFileSync(path.join(taskDir, name), 'utf8'))));

  const second = JSON.parse(execFileSync(
    process.execPath,
    [mora, 'spec', 'tasks', 'api-tasks', '--dispatch', '--json'],
    { cwd: root, env, encoding: 'utf8' },
  ));
  assert.equal(second.dispatched.length, 0);
  assert.equal(fs.readdirSync(taskDir).filter((name) => /^T-\d{4}\.json$/.test(name)).length, 2);
  assert.equal(fs.readdirSync(taskDir).filter((name) => /^T-\d{4}\.md$/.test(name)).length, 2);
});
