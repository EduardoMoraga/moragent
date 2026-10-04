import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const packageRoot = path.resolve('.');
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
const bin = path.join(packageRoot, manifest.bin.mora);

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-entry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const init = spawnSync(process.execPath, [bin, 'init', '--yes', '--dir', root, '--json'], { cwd: packageRoot, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  return root;
}

function invoke(root, name, args = [], { terminal = false } = {}) {
  if (!terminal) return spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8', timeout: 10000 });
  const launch = [
    'process.stdin.isTTY = true;',
    'process.stdout.isTTY = true;',
    `process.argv = [process.execPath, ${JSON.stringify(name)}, ...${JSON.stringify(args)}];`,
    `await import(${JSON.stringify(pathToFileURL(bin).href)});`,
  ].join(' ');
  return spawnSync(process.execPath, ['--input-type=module', '-e', launch], {
    cwd: root, input: '/exit\n', encoding: 'utf8', timeout: 10000,
  });
}

test('both installed bin names open the same chat harness as explicit chat in a terminal', (t) => {
  assert.equal(manifest.bin.mora, manifest.bin.moragent);
  const root = project(t);
  for (const name of ['mora', 'moragent']) {
    const launched = invoke(root, name, [], { terminal: true });
    assert.equal(launched.status, 0, `${name}: ${launched.stderr || launched.error?.message}`);
    assert.match(launched.stdout, /MORAGENT/);
    assert.match(launched.stdout, /> _/);
  }
  const explicit = invoke(root, 'mora', ['chat'], { terminal: true });
  assert.equal(explicit.status, 0, explicit.stderr || explicit.error?.message);
  assert.match(explicit.stdout, /MORAGENT/);
  assert.match(explicit.stdout, /> _/);
});

test('no-argument noninteractive launch fails predictably instead of showing a dashboard', (t) => {
  const root = project(t);
  for (const name of ['mora', 'moragent']) {
    const launched = invoke(root, name);
    assert.equal(launched.status, 1, `${name}: ${launched.stderr || launched.stdout}`);
    assert.match(launched.stderr, /interactive terminal|terminal interactiva/i);
  }
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-entry-empty-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  const uninitialized = invoke(empty, 'mora');
  assert.equal(uninitialized.status, 1, uninitialized.stderr);
  assert.equal(fs.existsSync(path.join(empty, '.moragent')), false);
});

test('help and explicit machine-readable commands remain noninteractive', (t) => {
  const root = project(t);
  const help = invoke(root, 'mora', ['help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /MORAGENT/);
  assert.match(help.stdout, /chat/);

  for (const command of ['dashboard', 'status']) {
    const result = invoke(root, 'mora', [command]);
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    assert.ok(result.stdout.trim());
  }

  for (const command of [['dashboard'], ['status'], ['task', 'list'], ['spec', 'status'], ['memory', 'list']]) {
    const result = invoke(root, 'mora', [...command, '--json']);
    assert.equal(result.status, 0, `${command.join(' ')}: ${result.stderr}`);
    assert.ok(JSON.parse(result.stdout));
  }
});
