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
