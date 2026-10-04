import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTask, updateTask } from '../src/bus/tasks.js';
import { readStatus } from '../src/bus/status.js';
import { writeJSON } from '../src/core/fsx.js';

const bin = path.resolve('bin/mora.js');

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-status-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.moragent', 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(root, '.moragent', 'runs'), { recursive: true });
  writeJSON(path.join(root, '.moragent', 'moragent.json'), {
    project: 'status-test', lang: 'en', crew: { backend: { cli: 'codex' } },
  });
  return root;
}

function task(root, status = 'sent') {
  const created = createTask({ root, role: 'backend', body: 'Inspect the run' });
  return updateTask(root, created.id, { status });
}

test('headless live and dead processes have distinct observed states without changing records', (t) => {
  const root = project(t);
  const live = task(root);
  const dead = task(root);
  const runsFile = path.join(root, '.moragent', 'runs', 'headless.json');
  writeJSON(runsFile, {
    a: { root, taskId: live.id, handle: 'headless:backend', pid: process.pid, status: 'running', cli: 'codex', logFile: 'live.log', updatedAt: '2026-10-01T00:00:00Z' },
    b: { root, taskId: dead.id, handle: 'headless:backend', pid: 99999999, status: 'running', cli: 'codex', logFile: 'dead.log', updatedAt: '2026-10-01T00:00:00Z' },
  });
  const before = [live.id, dead.id].map((id) => fs.readFileSync(path.join(root, '.moragent', 'tasks', `${id}.json`), 'utf8'));
  const runBefore = fs.readFileSync(runsFile, 'utf8');
  const first = readStatus(root);
  const second = readStatus(root);
  assert.deepEqual(first, second);
  assert.equal(first.tasks[0].status, 'running');
  assert.equal(first.tasks[0].run.alive, true);
  assert.equal(first.tasks[1].status, 'unknown');
  assert.equal(first.tasks[1].reason, 'process_not_running');
  assert.equal(first.tasks[1].run.alive, false);
  assert.equal(first.tasks[1].logFile, 'dead.log');
  assert.deepEqual([live.id, dead.id].map((id) => fs.readFileSync(path.join(root, '.moragent', 'tasks', `${id}.json`), 'utf8')), before);
  assert.equal(fs.readFileSync(runsFile, 'utf8'), runBefore);
});

test('engine execution evidence distinguishes live task from a stale process', (t) => {
  const root = project(t);
  const live = task(root, 'running');
  const stale = task(root, 'running');
  updateTask(root, live.id, { execution: { mode: 'engine', pid: process.pid, handle: `pid:${process.pid}`, provider: 'codex', sessionId: 'session-1', logFile: 'engine.log' } });
  updateTask(root, stale.id, { execution: { mode: 'engine', pid: 99999999, handle: 'pid:99999999', provider: 'codex' } });
  const data = readStatus(root);
  assert.equal(data.tasks[0].status, 'running');
  assert.equal(data.tasks[0].run.sessionId, 'session-1');
  assert.equal(data.tasks[0].provider, 'codex');
  assert.equal(data.tasks[1].status, 'unknown');
  assert.equal(data.tasks[1].reason, 'process_not_running');
});

test('pane presence does not prove a sent task is executing; missing pane is unknown', (t) => {
  const root = project(t);
  const sent = task(root);
  updateTask(root, sent.id, { execution: { mode: 'pane', mux: 'tmux', handle: '%1', provider: 'codex' } });
  const alive = readStatus(root, sent.id, { probePane: () => true }).tasks[0];
  const gone = readStatus(root, sent.id, { probePane: () => false }).tasks[0];
  assert.equal(alive.status, 'sent');
  assert.equal(alive.run.alive, true);
  assert.equal(alive.reason, 'pane_alive_task_unverified');
  assert.equal(gone.status, 'unknown');
  assert.equal(gone.reason, 'pane_not_running');
});

test('terminal task evidence wins over stale runs, while malformed records stay unknown', (t) => {
  const root = project(t);
  const done = task(root, 'done');
  const failed = task(root, 'failed');
  const blocked = task(root, 'blocked');
  updateTask(root, done.id, { result: 'Shipped', files: ['result.md'], execution: { mode: 'engine', pid: 99999999 } });
  updateTask(root, failed.id, { result: 'Command exited 2' });
  updateTask(root, blocked.id, { result: 'Needs approval' });
  fs.writeFileSync(path.join(root, '.moragent', 'tasks', 'T-0004.json'), '{bad json');
  const rows = readStatus(root).tasks;
  assert.deepEqual(rows.map((x) => x.status), ['done', 'failed', 'blocked', 'unknown']);
  assert.equal(rows[0].result, 'Shipped');
  assert.deepEqual(rows[0].files, ['result.md']);
  assert.equal(rows[1].result, 'Command exited 2');
  assert.equal(rows[2].result, 'Needs approval');
  assert.equal(rows[3].reason, 'task_record_unreadable');
  assert.equal(readStatus(root, 'T-9999').tasks[0].reason, 'task_not_found');
});

test('corrupt and absent run records cannot make a sent task look running', (t) => {
  const root = project(t);
  const sent = task(root);
  assert.equal(readStatus(root, sent.id).tasks[0].reason, 'run_record_missing');
  fs.writeFileSync(path.join(root, '.moragent', 'runs', 'headless.json'), '{bad json');
  assert.equal(readStatus(root, sent.id).tasks[0].reason, 'run_record_unreadable');
});

test('mora status JSON and human command output expose evidence and next action', (t) => {
  const root = project(t);
  const stale = task(root);
  updateTask(root, stale.id, { execution: { mode: 'engine', pid: 99999999, handle: 'pid:99999999', logFile: 'worker.log' } });
  const args = ['status', stale.id, '--lang', 'en'];
  const machine = spawnSync(process.execPath, [bin, ...args, '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(machine.status, 0, machine.stderr);
  const json = JSON.parse(machine.stdout);
  assert.deepEqual(Object.keys(json), ['ok', 'project', 'tasks']);
  assert.equal(json.tasks[0].status, 'unknown');
  assert.equal(json.tasks[0].reason, 'process_not_running');
  assert.equal(json.tasks[0].nextAction.command, `mora task show ${stale.id}`);
  const alias = spawnSync(process.execPath, [bin, 'st', stale.id, '--lang', 'en', '--json'], { cwd: root, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(alias.stdout), json);
  const human = spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8' });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /UNKNOWN/);
  assert.match(human.stdout, /worker\.log/);
  assert.match(human.stdout, /mora task show/);
  const help = spawnSync(process.execPath, [bin, 'help', 'status', '--lang', 'en'], { cwd: root, encoding: 'utf8' });
  assert.match(help.stdout, /Use mora dashboard for the former project overview/);
});
