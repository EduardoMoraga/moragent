import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setExec, resetExec } from '../src/core/exec.js';
import { detectMux, getMux } from '../src/mux/index.js';

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
  const pane = mux.spawn({ root: '/tmp/project space', cwd: '/tmp/project space', command: "codex 'do work'", anchor: 'term-1' });
  assert.equal(pane.handle, 'term-42');
  assert.equal(calls[0][1][calls[0][1].indexOf('--command') + 1], "codex 'do work'");
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
  const pane = mux.spawn({ root: '/tmp/p', cwd: '/tmp/p', command: 'pi', anchor: 'pane-1', direction: 'vertical' });
  assert.equal(pane.handle, 'pane-9');
  assert.ok(calls[0][1].includes('down'));
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
    const pane = getMux('tmux').spawn({ root: '/tmp/a b', cwd: '/tmp/a b', command: "codex 'hello world'" });
    assert.equal(pane.handle, '%7');
    assert.ok(calls[0][1].includes('/tmp/a b'));
    assert.equal(calls[0][1].at(-1), "codex 'hello world'");
  } finally {
    if (old === undefined) delete process.env.TMUX;
    else process.env.TMUX = old;
  }
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
