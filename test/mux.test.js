import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setExec, resetExec } from '../src/core/exec.js';
import { detectMux, getMux } from '../src/mux/index.js';
import { paneCommand } from '../src/mux/util.js';
import headless, { clearHeadlessCache, headlessStatePath } from '../src/mux/headless.js';
import { readJSON, writeJSON, writeText } from '../src/core/fsx.js';
import dispatchCommand from '../src/commands/dispatch.js';
import { loadPanes, savePanes } from '../src/crew/panes.js';

afterEach(() => resetExec());

test('orca parses nested handles and keeps spaced commands as one argument', () => {
  const calls = [];
  setExec((cmd, args) => {
    calls.push([cmd, args]);
    if (args[1] === 'split') return { code: 0, stdout: JSON.stringify({ ok: true, result: { terminal: { handle: 'term-42' } } }), stderr: '' };
    if (args[1] === 'list') return { code: 0, stdout: JSON.stringify({ terminals: [{ handle: 'term-42' }] }), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  });
  const mux = getMux('orca');
  const pane = mux.spawn({ root: '/tmp/project space', role: 'backend', cwd: '/tmp/project space', command: "codex 'do work'", anchor: 'term-1' });
  assert.equal(pane.handle, 'term-42');
  assert.equal(calls[0][1][calls[0][1].indexOf('--command') + 1], "cd '/tmp/project space' && MORAGENT_ROLE=backend codex 'do work'");
  assert.equal(mux.alive('term-42'), true);
  mux.send('term-42', 'hello world');
  assert.ok(calls.at(-1)[1].includes('--enter'));
});

test('herdr maps directions and uses run for entered text', () => {
  const calls = [];
  setExec((cmd, args) => {
    calls.push([cmd, args]);
    if (args[1] === 'split') return { code: 0, stdout: 'pane_id: pane-9\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  });
  const mux = getMux('herdr');
  const pane = mux.spawn({ root: '/tmp/p', role: 'helper', cwd: '/tmp/p', command: 'pi', anchor: 'pane-1', direction: 'vertical' });
  assert.equal(pane.handle, 'pane-9');
  assert.ok(calls[0][1].includes('down'));
  assert.deepEqual(calls.find((call) => call[1][1] === 'run')[1], ['pane', 'run', 'pane-9', 'cd /tmp/p && MORAGENT_ROLE=helper pi']);
  mux.send('pane-9', 'do it');
  assert.deepEqual(calls.at(-1)[1], ['pane', 'run', 'pane-9', 'do it']);
});

test('tmux uses argument arrays for cwd and command', () => {
  const old = process.env.TMUX;
  process.env.TMUX = 'inside';
  const calls = [];
  setExec((cmd, args) => {
    calls.push([cmd, args]);
    if (args[0] === 'split-window') return { code: 0, stdout: '%7\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  });
  try {
    const pane = getMux('tmux').spawn({ root: '/tmp/a b', role: 'backend', cwd: '/tmp/a b', command: "codex 'hello world'" });
    assert.equal(pane.handle, '%7');
    assert.ok(calls[0][1].includes('/tmp/a b'));
    assert.equal(calls[0][1].at(-1), "cd '/tmp/a b' && MORAGENT_ROLE=backend codex 'hello world'");
  } finally {
    if (old === undefined) delete process.env.TMUX;
    else process.env.TMUX = old;
  }
});

test('pane command supports Windows cwd and role syntax', () => {
  assert.equal(
    paneCommand({ root: 'C:\\Work Space', role: 'dev', command: 'pi', platform: 'win32' }),
    'cd /d "C:\\Work Space" && set "MORAGENT_ROLE=dev" && pi',
  );
  assert.equal(paneCommand({ command: 'pi' }), 'pi');
  assert.equal(paneCommand({ role: 'dev', command: 'pi' }), 'MORAGENT_ROLE=dev pi');
  assert.equal(paneCommand({ root: '/tmp/a b', command: 'pi' }), "cd '/tmp/a b' && pi");
});

test('headless state survives memory cache loss and dead processes are not alive', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-headless-'));
  const { handle } = headless.spawn({
    root, role: 'backend', cwd: root,
    adapter: { id: 'codex' }, member: { cli: 'codex' }, autonomy: 'auto',
  });
  assert.equal(readJSON(headlessStatePath(root))[handle].cli, 'codex');
  clearHeadlessCache();
  assert.equal(headless.alive(handle, { root }), true);

  const logFile = path.join(root, '.moragent', 'runs', 'backend-T-0001.log');
  writeText(logFile, 'one\ntwo\n');
  const records = readJSON(headlessStatePath(root));
  records[handle] = { ...records[handle], status: 'running', pid: 2147483647, logFile };
  writeJSON(headlessStatePath(root), records);
  clearHeadlessCache();
  assert.equal(headless.read(handle, { root }), 'one\ntwo\n');
  assert.equal(headless.alive(handle, { root }), false);
  headless.close(handle, { root });
  assert.equal(readJSON(headlessStatePath(root))[handle], undefined);
});

test('dispatch removes a dead registered pane before headless fallback', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-dead-pane-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const codex = path.join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  fs.writeFileSync(codex, '');
  if (process.platform !== 'win32') fs.chmodSync(codex, 0o755);
  savePanes(root, { backend: { mux: 'tmux', handle: '%dead', cli: 'codex' } });
  setExec(() => ({ code: 0, stdout: '%other\n', stderr: '' }));
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath || ''}`;
  try {
    await dispatchCommand.run(
      { _: ['backend', 'dry run'], flags: { 'dry-run': true } },
      { root, config: { lang: 'en', crew: { backend: { cli: 'codex' } } }, json: false },
    );
    assert.equal(loadPanes(root).backend, undefined);
  } finally {
    process.env.PATH = oldPath;
  }
});

test('orca read joins the real tail array response', () => {
  setExec((cmd, args) => {
    assert.equal(cmd, 'orca');
    assert.equal(args[1], 'read');
    return {
      code: 0,
      stdout: JSON.stringify({ ok: true, result: { terminal: { tail: ['first', 'second'] } } }),
      stderr: '',
    };
  });
  assert.equal(getMux('orca').read('term-1'), 'first\nsecond');
});

test('orca send maps agent_prompt_blocked to PANE_NOT_READY', () => {
  setExec(() => ({ code: 1, stdout: '', stderr: 'agent_prompt_blocked: menu visible' }));
  assert.throws(() => getMux('orca').send('term-1', 'work'), (error) => error.code === 'PANE_NOT_READY');
});

test('environment detection has deterministic priority', () => {
  const old = { term: process.env.TERM_PROGRAM, orca: process.env.ORCA_TERMINAL_HANDLE, herdr: process.env.HERDR_ENV, tmux: process.env.TMUX };
  try {
    process.env.TERM_PROGRAM = 'Orca';
    process.env.HERDR_ENV = '1';
    process.env.TMUX = 'yes';
    assert.equal(detectMux(), 'orca');
    delete process.env.TERM_PROGRAM;
    delete process.env.ORCA_TERMINAL_HANDLE;
    assert.equal(detectMux(), 'herdr');
    delete process.env.HERDR_ENV;
    assert.equal(detectMux(), 'tmux');
    assert.equal(detectMux('headless'), 'headless');
  } finally {
    for (const [key, value] of Object.entries({ TERM_PROGRAM: old.term, ORCA_TERMINAL_HANDLE: old.orca, HERDR_ENV: old.herdr, TMUX: old.tmux })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
