import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { INSTALL_METADATA, selfUpdate } from '../src/core/self-update.js';
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

test('self update refuses a packaged installation without recorded provenance', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-update-package-'));
  try {
    fs.writeFileSync(path.join(directory, 'package.json'), '{"name":"moragent"}\n');
    assert.deepEqual(await selfUpdate({ packageRoot: directory }), {
      status: 'unsupported', reason: 'missing-provenance',
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('self update reports a non-package directory without guessing provenance', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-update-empty-'));
  try {
    assert.deepEqual(await selfUpdate({ packageRoot: directory }), {
      status: 'unsupported', reason: 'not-git-checkout',
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

function packagedInstall(home, revision = 'a'.repeat(40)) {
  const root = path.join(home, 'lib', 'node_modules', 'moragent');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"moragent"}\n');
  fs.writeFileSync(path.join(root, 'bin', 'mora.js'), '#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(root, INSTALL_METADATA), `${JSON.stringify({
    schemaVersion: 1,
    installedAt: '2026-01-01T00:00:00.000Z',
    revision,
    source: {
      type: 'github-tarball',
      repoUrl: 'https://github.com/EduardoMoraga/moragent.git',
      branch: 'preview/test',
      ref: 'refs/heads/preview/test',
      tarballUrl: `https://github.com/EduardoMoraga/moragent/archive/${revision}.tar.gz`,
    },
  })}\n`);
  return root;
}

function fakePackagedExec({ latest = 'a'.repeat(40), failNpm = false, calls = [] } = {}) {
  return async (file, args) => {
    calls.push([file, ...args]);
    if (file === 'git' && args[0] === '-C') throw Object.assign(new Error('not a checkout'), { code: 128 });
    if (file === 'git' && args[0] === 'ls-remote') return { stdout: `${latest}\trefs/heads/preview/test\n` };
    if (file === 'npm' && args.includes('i')) {
      if (failNpm) throw Object.assign(new Error('npm failed'), { code: 1 });
      return { stdout: 'ok\n' };
    }
    throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
  };
}

test('packaged self update checks GitHub provenance without modifying files', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-update-packaged-'));
  try {
    const root = packagedInstall(home);
    const before = fs.readFileSync(path.join(root, INSTALL_METADATA), 'utf8');
    const calls = [];
    const result = await selfUpdate({ packageRoot: root, check: true, execFileImpl: fakePackagedExec({ latest: 'b'.repeat(40), calls }) });
    assert.equal(result.status, 'available');
    assert.equal(result.current, 'a'.repeat(40));
    assert.equal(result.latest, 'b'.repeat(40));
    assert.equal(fs.readFileSync(path.join(root, INSTALL_METADATA), 'utf8'), before);
    assert.equal(calls.some(([file]) => file === 'npm'), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('packaged self update reports current when recorded revision matches branch', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-update-packaged-current-'));
  try {
    const root = packagedInstall(home);
    const result = await selfUpdate({ packageRoot: root, execFileImpl: fakePackagedExec() });
    assert.equal(result.status, 'current');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('packaged self update installs same-origin tarball and records the new revision', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-update-packaged-apply-'));
  try {
    const root = packagedInstall(home);
    const calls = [];
    const result = await selfUpdate({ packageRoot: root, execFileImpl: fakePackagedExec({ latest: 'c'.repeat(40), calls }) });
    assert.equal(result.status, 'updated');
    assert.deepEqual(calls.find(([file]) => file === 'npm'), ['npm', 'i', '-g', '--prefix', fs.realpathSync(home), `https://github.com/EduardoMoraga/moragent/archive/${'c'.repeat(40)}.tar.gz`]);
    const metadata = JSON.parse(fs.readFileSync(path.join(root, INSTALL_METADATA), 'utf8'));
    assert.equal(metadata.revision, 'c'.repeat(40));
    assert.equal(metadata.source.branch, 'preview/test');
    assert.equal(metadata.source.tarballUrl, `https://github.com/EduardoMoraga/moragent/archive/${'c'.repeat(40)}.tar.gz`);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('packaged self update keeps previous metadata when npm install fails', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-update-packaged-fail-'));
  try {
    const root = packagedInstall(home);
    const before = fs.readFileSync(path.join(root, INSTALL_METADATA), 'utf8');
    const result = await selfUpdate({ packageRoot: root, execFileImpl: fakePackagedExec({ latest: 'd'.repeat(40), failNpm: true }) });
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'npm-install-failed');
    assert.equal(fs.readFileSync(path.join(root, INSTALL_METADATA), 'utf8'), before);
    assert.equal(fs.existsSync(path.join(root, 'bin', 'mora.js')), true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('packaged self update reads PowerShell 5.1 UTF-8 BOM metadata', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-update-packaged-bom-'));
  try {
    const root = packagedInstall(home);
    const file = path.join(root, INSTALL_METADATA);
    fs.writeFileSync(file, `\uFEFF${fs.readFileSync(file, 'utf8')}`, 'utf8');
    const result = await selfUpdate({ packageRoot: root, check: true, execFileImpl: fakePackagedExec({ latest: 'b'.repeat(40) }) });
    assert.equal(result.status, 'available');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('packaged self update refuses untrusted or unfixed metadata before npm', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-update-packaged-invalid-'));
  try {
    const root = packagedInstall(home);
    const metadataPath = path.join(root, INSTALL_METADATA);
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    metadata.source.tarballUrl = 'https://github.com/EduardoMoraga/moragent/archive/refs/heads/preview/test.tar.gz';
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`);
    const calls = [];
    const result = await selfUpdate({ packageRoot: root, execFileImpl: fakePackagedExec({ latest: 'e'.repeat(40), calls }) });
    assert.equal(result.status, 'unsupported');
    assert.equal(result.reason, 'untrusted-tarball');
    assert.equal(calls.some(([file]) => file === 'npm'), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('packaged self update restores previous package when npm leaves an invalid install', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-update-packaged-restore-'));
  try {
    const root = packagedInstall(home);
    const beforeMetadata = fs.readFileSync(path.join(root, INSTALL_METADATA), 'utf8');
    const beforeBin = fs.readFileSync(path.join(root, 'bin', 'mora.js'), 'utf8');
    const calls = [];
    const result = await selfUpdate({ packageRoot: root, execFileImpl: async (file, args) => {
      calls.push([file, ...args]);
      if (file === 'git' && args[0] === '-C') throw Object.assign(new Error('not a checkout'), { code: 128 });
      if (file === 'git' && args[0] === 'ls-remote') return { stdout: `${'f'.repeat(40)}\trefs/heads/preview/test\n` };
      if (file === 'npm') {
        fs.rmSync(path.join(root, 'bin'), { recursive: true, force: true });
        return { stdout: 'partial install\n' };
      }
      throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
    } });
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'invalid-installation-after-npm');
    assert.equal(fs.readFileSync(path.join(root, INSTALL_METADATA), 'utf8'), beforeMetadata);
    assert.equal(fs.readFileSync(path.join(root, 'bin', 'mora.js'), 'utf8'), beforeBin);
    assert.equal(calls.some(([file]) => file === 'npm'), true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
