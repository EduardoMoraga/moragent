import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { registerRemote, remotesFile } from '../src/remote/registry.js';
import { openRemote, remoteOpenArgs } from '../src/remote/open.js';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mora.js');

function fixture(fn) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-remote-'));
  const old = process.env.MORAGENT_HOME;
  process.env.MORAGENT_HOME = path.join(temp, 'home');
  try { return fn(temp); }
  finally {
    if (old === undefined) delete process.env.MORAGENT_HOME;
    else process.env.MORAGENT_HOME = old;
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function fakeSSH(temp) {
  const bin = path.join(temp, 'bin');
  fs.mkdirSync(bin);
  const ssh = path.join(bin, 'ssh');
  fs.writeFileSync(ssh, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.SSH_FAKE_LOG, JSON.stringify({ args: process.argv.slice(2), input: fs.readFileSync(0, 'utf8') }));
process.exit(Number(process.env.SSH_FAKE_STATUS || 0));
`, { mode: 0o755 });
  return bin;
}

function run(env, ...args) {
  const result = spawnSync(process.execPath, [cli, 'remote', ...args, '--json'], {
    env: { ...process.env, ...env, NO_COLOR: '1' }, encoding: 'utf8',
  });
  assert.equal(result.error, undefined);
  return { code: result.status, body: JSON.parse(result.stdout) };
}

test('registers host and remote root locally without opening SSH', () => fixture((temp) => {
  const bin = fakeSSH(temp);
  const log = path.join(temp, 'ssh-log.json');
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, SSH_FAKE_LOG: log };
  const first = run(env, 'add', 'builder', '/srv/my project', '--name', 'Build box');
  assert.equal(first.code, 0);
  assert.equal(first.body.created, true);
  assert.match(first.body.remote.remoteId, /^r-[0-9a-f]{16}$/);
  assert.equal(first.body.remote.root, '/srv/my project');
  const second = run(env, 'add', 'builder', '/srv/my project', '--name', 'Changed');
  assert.equal(second.body.created, false);
  assert.deepEqual(second.body.remote, first.body.remote);
  assert.equal(run(env, 'list').body.remotes.length, 1);
  assert.ok(!fs.existsSync(log));
  assert.equal(remotesFile(), path.join(temp, 'home', 'remotes.json'));
}));

test('probe passes host as one argument and remote path only through stdin', () => fixture((temp) => {
  const bin = fakeSSH(temp);
  const log = path.join(temp, 'ssh-log.json');
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, SSH_FAKE_LOG: log };
  const root = "/srv/person's files; touch /tmp/should-not-run";
  const remote = registerRemote('user@builder', root).remote;
  const result = run(env, 'probe', remote.remoteId);
  assert.equal(result.code, 0);
  assert.equal(result.body.status, 'ready');
  const call = JSON.parse(fs.readFileSync(log, 'utf8'));
  assert.deepEqual(call.args.slice(0, 10), [
    '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=5', '-o', 'ConnectionAttempts=1', '--',
  ]);
  assert.equal(call.args[10], 'user@builder');
  assert.equal(call.args.length, 12);
  assert.ok(!call.args[11].includes(root));
  assert.equal(call.input, `${root}\n`);
}));

test('probe reports missing root and unreachable host without retrying or running tasks', () => fixture((temp) => {
  const bin = fakeSSH(temp);
  const log = path.join(temp, 'ssh-log.json');
  const remote = registerRemote('builder', '/srv/work').remote;
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, SSH_FAKE_LOG: log };
  const missing = run({ ...env, SSH_FAKE_STATUS: '1' }, 'probe', remote.remoteId);
  assert.equal(missing.code, 1);
  assert.equal(missing.body.status, 'missing_root');
  const unreachable = run({ ...env, SSH_FAKE_STATUS: '255' }, 'probe', remote.remoteId);
  assert.equal(unreachable.code, 1);
  assert.equal(unreachable.body.status, 'unreachable');
  assert.equal(run(env, 'list').body.remotes.length, 1);
}));

test('rejects SSH options as hosts, relative roots, and corrupt registry data', () => fixture((temp) => {
  assert.throws(() => registerRemote('-oProxyCommand=evil', '/srv/work'), { code: 'BAD_REMOTE_HOST' });
  assert.throws(() => registerRemote('builder', 'relative/path'), { code: 'BAD_REMOTE_ROOT' });
  assert.throws(() => registerRemote('builder', '/srv/work\nmalicious'), { code: 'BAD_REMOTE_ROOT' });
  fs.mkdirSync(path.dirname(remotesFile()), { recursive: true });
  fs.writeFileSync(remotesFile(), '{invalid');
  assert.throws(() => registerRemote('builder', '/srv/work'), { code: 'BAD_REMOTE_REGISTRY' });
  assert.equal(fs.readFileSync(remotesFile(), 'utf8'), '{invalid');
}));

test('remote open quotes the project path and requires a terminal', async () => {
  const remote = { host: 'user@builder', root: "/srv/person's notes; echo unsafe" };
  assert.deepEqual(remoteOpenArgs(remote), [
    '-tt', '-o', 'StrictHostKeyChecking=yes', '--', 'user@builder',
    "cd '/srv/person'\\''s notes; echo unsafe' && exec mora",
  ]);
  await assert.rejects(openRemote(remote, { input: { isTTY: false }, output: { isTTY: false } }), (error) => error.code === 'NO_TTY');
  let invoked;
  const code = await openRemote(remote, { input: { isTTY: true }, output: { isTTY: true }, spawnImpl(file, args, options) {
    invoked = { file, args, options };
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0, null));
    return child;
  } });
  assert.equal(code, 0);
  assert.equal(invoked.file, 'ssh');
  assert.deepEqual(invoked.args, remoteOpenArgs(remote));
  assert.equal(invoked.options.stdio, 'inherit');
});

test('persistent SSH open reconnects to one tmux session per registered remote', async () => {
  const remote = { remoteId: 'r-0123456789abcdef', host: 'user@builder', root: "/srv/person's notes" };
  assert.deepEqual(remoteOpenArgs(remote, { persist: true }), [
    '-tt', '-o', 'StrictHostKeyChecking=yes', '--', 'user@builder',
    "cd '/srv/person'\\''s notes' && exec tmux new-session -A -s mora-r-0123456789abcdef mora",
  ]);
  assert.throws(() => remoteOpenArgs({ ...remote, remoteId: 'unsafe;command' }, { persist: true }), { code: 'BAD_REMOTE_ID' });
  let args;
  await openRemote(remote, { persist: true, input: { isTTY: true }, output: { isTTY: true }, spawnImpl(_ssh, actual) {
    args = actual;
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0, null));
    return child;
  } });
  assert.deepEqual(args, remoteOpenArgs(remote, { persist: true }));
});
