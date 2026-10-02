import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { selfUpdate } from '../src/core/self-update.js';
import { resolveCommand } from '../src/cli.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

test('update is a native MORAGENT command', async () => {
  const command = await resolveCommand('update');
  assert.equal(command?.name, 'update');
  assert.equal(command?.group, 'system');
});

test('self update checks remote HEAD before fast-forwarding the installation', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-update-'));
  const source = path.join(home, 'source');
  const remote = path.join(home, 'remote.git');
  const installed = path.join(home, 'installed');
  try {
    fs.mkdirSync(source);
    git(source, 'init', '-q');
    git(source, 'config', 'user.email', 'test@example.invalid');
    git(source, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(source, 'package.json'), '{"version":"1"}\n');
    git(source, 'add', 'package.json');
    git(source, 'commit', '-qm', 'first');
    git(home, 'init', '--bare', '-q', remote);
    git(source, 'remote', 'add', 'origin', remote);
    git(source, 'push', '-qu', 'origin', 'HEAD');
    git(home, 'clone', '-q', remote, installed);

    fs.writeFileSync(path.join(source, 'package.json'), '{"version":"2"}\n');
    git(source, 'commit', '-qam', 'second');
    git(source, 'push', '-q');
    const before = git(installed, 'rev-parse', 'HEAD');
    const check = await selfUpdate({ packageRoot: installed, check: true });
    assert.equal(check.status, 'available');
    assert.equal(check.behind, 1);
    assert.equal(git(installed, 'rev-parse', 'HEAD'), before);

    fs.writeFileSync(path.join(installed, 'local-notes.txt'), 'keep me\n');
    const applied = await selfUpdate({ packageRoot: installed });
    assert.equal(applied.status, 'updated');
    assert.equal(git(installed, 'rev-parse', 'HEAD'), git(source, 'rev-parse', 'HEAD'));
    assert.equal(fs.readFileSync(path.join(installed, 'local-notes.txt'), 'utf8'), 'keep me\n');

    fs.writeFileSync(path.join(source, 'package.json'), '{"version":"3"}\n');
    git(source, 'commit', '-qam', 'third');
    git(source, 'push', '-q');
    fs.writeFileSync(path.join(installed, 'package.json'), '{"version":"local"}\n');
    const dirty = await selfUpdate({ packageRoot: installed });
    assert.equal(dirty.status, 'dirty');
    assert.equal(git(installed, 'rev-parse', 'HEAD'), applied.latest);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('self update refuses an installation without a known Git source', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-update-package-'));
  try {
    assert.deepEqual(await selfUpdate({ packageRoot: directory }), {
      status: 'unsupported', reason: 'not-git-checkout',
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
