import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setExec, resetExec, shq } from '../src/core/exec.js';
import { detectMux, getMux } from '../src/mux/index.js';
import { paneCommand } from '../src/mux/util.js';
import headless, { clearHeadlessCache, headlessStatePath } from '../src/mux/headless.js';
import { readJSON, writeJSON, writeText } from '../src/core/fsx.js';
import { ensureShim, shimDir } from '../src/core/shim.js';
import { createTask, getTask, updateTask } from '../src/bus/tasks.js';
import { detectExited, detectReadyPrompt, detectTrustDialog, trustRoles } from '../src/crew/trust.js';
import dispatchCommand from '../src/commands/dispatch.js';
import downCommand from '../src/commands/down.js';
import resendCommand from '../src/commands/resend.js';
import upCommand from '../src/commands/up.js';
import { loadPanes, savePanes } from '../src/crew/panes.js';

// These tests assert the POSIX command strings; Windows variants pass platform: 'win32' explicitly.
const IS_WIN = process.platform === 'win32'; // real host, for fake binaries that which() must find
Object.defineProperty(process, 'platform', { value: 'linux' });

afterEach(() => resetExec());

test('orca parses nested handles and keeps spaced commands as one argument', () => {
  const calls = [];
  setExec((cmd, args) => {
    calls.push([cmd, args]);
    if (args[1] === 'split') return { code: 0, stdout: JSON.stringify({ ok: true, result: { terminal: { handle: 'term-42' } } }), stderr: '' };
    if (args[1] === 'list') return { code: 0, stdout: JSON.stringify({ ok: true, result: { terminals: [{ handle: 'term-1', tabId: 'tab-1' }, { handle: 'term-42', tabId: 'tab-1' }] } }), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  });
  const mux = getMux('orca');
  const pane = mux.spawn({ root: '/tmp/project space', role: 'backend', cwd: '/tmp/project space', command: "codex 'do work'", anchor: 'term-1' });
  assert.equal(pane.handle, 'term-42');
  const split = calls.find((call) => call[1][1] === 'split');
  assert.equal(split[1][split[1].indexOf('--command') + 1], "cd '/tmp/project space' && MORAGENT_ROLE=backend codex 'do work'");
  assert.equal(mux.alive('term-42'), true);
  mux.send('term-42', 'hello world');
  assert.ok(calls.at(-1)[1].includes('--enter'));
});

test('orca falls back from a failed split to a titled tab', () => {
  const calls = [];
  setExec((cmd, args) => {
    calls.push([cmd, args]);
    if (args[1] === 'list') return { code: 0, stdout: JSON.stringify({ ok: true, result: { terminals: [{ handle: 'term-anchor', tabId: 'tab-1' }] } }), stderr: '' };
    if (args[1] === 'split') return { code: 1, stdout: '', stderr: 'Timed out waiting for split pane handle' };
    if (args[1] === 'create') return { code: 0, stdout: JSON.stringify({ ok: true, result: { terminal: { handle: 'term-tab' } } }), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  });
  const pane = getMux('orca').spawn({ root: '/tmp/p', role: 'backend', command: 'codex', anchor: 'term-anchor' });
  assert.deepEqual(pane, { handle: 'term-tab', layout: 'tab' });
  assert.deepEqual(calls.map((call) => call[1][1]), ['list', 'split', 'create']);
  const create = calls.find((call) => call[1][1] === 'create');
  assert.deepEqual(create[1].slice(2, 4), ['--title', 'backend']);
});

test('orca opens a tab without attempting split when the anchor tab already has four panes', () => {
  const calls = [];
  setExec((cmd, args) => {
    calls.push([cmd, args]);
    if (args[1] === 'list') return {
      code: 0,
      stdout: JSON.stringify({ ok: true, result: { terminals: ['anchor', 'two', 'three', 'four'].map((handle) => ({ handle, tabId: 'tab-full' })) } }),
      stderr: '',
    };
    if (args[1] === 'create') return { code: 0, stdout: JSON.stringify({ handle: 'term-new-tab' }), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  });
  const pane = getMux('orca').spawn({ root: '/tmp/p', role: 'helper', command: 'pi', anchor: 'anchor' });
  assert.deepEqual(pane, { handle: 'term-new-tab', layout: 'tab' });
  assert.deepEqual(calls.map((call) => call[1][1]), ['list', 'create']);
});

test('trust recognizes every verified startup dialog and chooses safe keys', () => {
  assert.deepEqual(
    detectTrustDialog('Yes, I trust this folder\n❯ No, exit\nEnter to confirm · Esc to cancel'),
    { kind: 'trust', cli: 'claude', keys: ['down', 'enter'] },
  );
  assert.deepEqual(
    detectTrustDialog('Do you trust the contents of this directory?\n› 1. Yes, continue\nPress enter to continue'),
    { kind: 'trust', cli: 'codex', keys: ['enter'] },
  );
  assert.deepEqual(
    detectTrustDialog('Update available!\n1. Update now\n2. Skip\n3. Skip until next version\nPress enter to continue'),
    { kind: 'update', keys: ['down', 'down', 'enter'] },
  );
  assert.deepEqual(
    detectTrustDialog('Do you trust the contents of this project?\n> Yes, I trust this folder\nenter Confirm'),
    { kind: 'trust', cli: 'agy', keys: ['enter'] },
  );
  assert.deepEqual(
    detectTrustDialog('→ Trust\nTrust parent folder\nTrust (this session only)\nDo not trust\n↑↓ navigate  enter select'),
    { kind: 'trust', cli: 'pi', keys: ['enter'] },
  );
  assert.equal(detectTrustDialog('Do you trust the contents of this project?\n> Yes, I trust this folder'), null);
  assert.equal(detectTrustDialog('Do you trust the contents of this directory?\n› 1. Yes, continue'), null);
});

test('trust recognizes ready TUI prompts and distinguishes a shell prompt', () => {
  for (const screen of [
    'Claude Code\n⏵⏵ accept edits on\n❯',
    'Claude Code\n? for shortcuts\n❯',
    '› Ask Codex\nAsk Codex to do anything',
    'Antigravity\n? for shortcuts',
    'pi model: sonnet (sub)\n42%/ context',
  ]) assert.equal(detectReadyPrompt(screen), true, screen);
  assert.equal(detectExited('agy CLI program exited\nproject %'), true);
  assert.equal(detectExited('pi model (sub)\n42%/ context'), false);
});

test('trust skips a Codex update, accepts trust and uses raw Orca keys', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-trust-chain-'));
  savePanes(root, { backend: { mux: 'orca', handle: 'term-backend', cli: 'codex' } });
  const screens = [
    ['Update available!', '› 1. Update now', '2. Skip', '3. Skip until next version', 'Press enter to continue'],
    ['Do you trust the contents of this directory?', '› 1. Yes, continue', 'Press enter to continue'],
    ['Ready', '› Ask Codex', 'Ask Codex to do anything'],
  ];
  let screen = 0;
  const sent = [];
  setExec((cmd, args) => {
    if (args[1] === 'list') return { code: 0, stdout: JSON.stringify({ ok: true, result: { terminals: [{ handle: 'term-backend' }] } }), stderr: '' };
    if (args[1] === 'read') return { code: 0, stdout: JSON.stringify({ ok: true, result: { terminal: { tail: screens[screen] } } }), stderr: '' };
    if (args[1] === 'send') {
      const text = args[args.indexOf('--text') + 1];
      sent.push(text);
      if (text === '\r') screen++;
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  });
  const results = trustRoles({ root, roles: ['backend'], strict: true, timeoutMs: 100, stableMs: 0, pollMs: 0 });
  assert.deepEqual(results, [{ role: 'backend', mux: 'orca', action: 'skipped-update+trusted', dialogs: 2 }]);
  assert.deepEqual(sent, ['\x1b[B', '\x1b[B', '\r', '\r']);
});

test('trust never sends keys for an unknown dialog and reports its last three lines', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-trust-unknown-'));
  savePanes(root, { helper: { mux: 'orca', handle: 'term-helper', cli: 'agy' } });
  const calls = [];
  setExec((cmd, args) => {
    calls.push([cmd, args]);
    if (args[1] === 'list') return { code: 0, stdout: JSON.stringify({ terminals: [{ handle: 'term-helper' }] }), stderr: '' };
    if (args[1] === 'read') return { code: 0, stdout: JSON.stringify({ result: { terminal: { tail: ['Choose startup mode', 'details', '❯ Custom mode', 'Enter to select'] } } }), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  });
  const results = trustRoles({ root, roles: ['helper'], strict: true, timeoutMs: 0, stableMs: 0, pollMs: 0 });
  assert.equal(results[0].action, 'unknown');
  assert.equal(results[0].detail, 'details\n❯ Custom mode\nEnter to select');
  assert.equal(calls.some((call) => call[1][1] === 'send'), false);
});

test('trust treats a newer ready prompt as ready when an accepted dialog remains above', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-trust-ready-'));
  savePanes(root, { backend: { mux: 'orca', handle: 'term-ready', cli: 'codex' } });
  const calls = [];
  setExec((cmd, args) => {
    calls.push([cmd, args]);
    if (args[1] === 'list') return { code: 0, stdout: JSON.stringify({ terminals: [{ handle: 'term-ready' }] }), stderr: '' };
    if (args[1] === 'read') return {
      code: 0,
      stdout: JSON.stringify({ result: { terminal: { tail: ['Do you trust the contents of this directory?', '› 1. Yes, continue', 'Press enter to continue', 'Accepted', '› Ask Codex'] } } }),
      stderr: '',
    };
    return { code: 0, stdout: '', stderr: '' };
  });
  assert.deepEqual(trustRoles({ root, roles: ['backend'], strict: true, timeoutMs: 10, stableMs: 0, pollMs: 0 }), [
    { role: 'backend', mux: 'orca', action: 'ready', dialogs: 0 },
  ]);
  assert.equal(calls.some((call) => call[1][1] === 'send'), false);
});

test('trust waits through an agy spinner and for two stable complete dialog reads', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-trust-stable-'));
  savePanes(root, { helper: { mux: 'orca', handle: 'term-agy', cli: 'agy' } });
  let reads = 0;
  let accepted = false;
  let readsAtSend = 0;
  setExec((cmd, args) => {
    if (args[1] === 'list') return { code: 0, stdout: JSON.stringify({ terminals: [{ handle: 'term-agy' }] }), stderr: '' };
    if (args[1] === 'read') {
      reads++;
      const tail = accepted
        ? ['Antigravity', '? for shortcuts']
        : reads === 1
          ? ['⣷ Signing in...', 'Do you trust the contents of this project?', '> Yes, I trust this folder', 'enter Confirm']
          : ['Do you trust the contents of this project?', '> Yes, I trust this folder', 'enter Confirm'];
      return { code: 0, stdout: JSON.stringify({ result: { terminal: { tail } } }), stderr: '' };
    }
    if (args[1] === 'send') {
      readsAtSend = reads;
      accepted = true;
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  });
  assert.deepEqual(
    trustRoles({ root, roles: ['helper'], strict: true, timeoutMs: 100, stableMs: 0, pollMs: 0 }),
    [{ role: 'helper', mux: 'orca', action: 'trusted', dialogs: 1 }],
  );
  assert.ok(readsAtSend >= 3, `sent after only ${readsAtSend} reads`);
});

test('trust reports exited when accepting a dialog returns to the shell', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-trust-exited-'));
  savePanes(root, { helper: { mux: 'orca', handle: 'term-agy', cli: 'agy' } });
  let exited = false;
  setExec((cmd, args) => {
    if (args[1] === 'list') return { code: 0, stdout: JSON.stringify({ terminals: [{ handle: 'term-agy' }] }), stderr: '' };
    if (args[1] === 'read') {
      const tail = exited
        ? ['CLI program exited', 'project %']
        : ['Do you trust the contents of this project?', '> Yes, I trust this folder', 'enter Confirm'];
      return { code: 0, stdout: JSON.stringify({ result: { terminal: { tail } } }), stderr: '' };
    }
    if (args[1] === 'send') {
      exited = true;
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  });
  const [result] = trustRoles({ root, roles: ['helper'], strict: true, timeoutMs: 100, stableMs: 0, pollMs: 0 });
  assert.equal(result.action, 'exited');
  assert.equal(result.hint, 'mora down helper && mora up helper');
  assert.match(result.detail, /project %/);
});

test('mux trust keys use named tmux keys and raw Herdr input', () => {
  const calls = [];
  setExec((cmd, args) => {
    calls.push([cmd, args]);
    return { code: 0, stdout: '', stderr: '' };
  });
  getMux('tmux').key('%7', 'down');
  getMux('tmux').key('%7', 'enter');
  getMux('herdr').key('pane-7', 'down');
  getMux('herdr').key('pane-7', 'enter');
  assert.deepEqual(calls[0], ['tmux', ['send-keys', '-t', '%7', 'Down']]);
  assert.deepEqual(calls[1], ['tmux', ['send-keys', '-t', '%7', 'Enter']]);
  assert.deepEqual(calls[2], ['herdr', ['pane', 'send-text', 'pane-7', '\x1b[B']]);
  assert.deepEqual(calls[3], ['herdr', ['pane', 'send-text', 'pane-7', '\r']]);
});

test('up --trust accepts a recognized dialog after opening the pane', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-up-trust-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ['codex', 'tmux']) {
    const file = path.join(bin, IS_WIN ? `${name}.cmd` : name);
    fs.writeFileSync(file, '');
    if (!IS_WIN) fs.chmodSync(file, 0o755);
  }
  const previousPath = process.env.PATH;
  const previousTmux = process.env.TMUX;
  process.env.PATH = `${bin}${path.delimiter}${previousPath || ''}`;
  process.env.TMUX = 'inside';
  let accepted = false;
  const calls = [];
  setExec((cmd, args) => {
    calls.push([cmd, args]);
    if (args[0] === 'split-window') return { code: 0, stdout: '%7\n', stderr: '' };
    if (args[0] === 'list-panes') return { code: 0, stdout: '%7\n', stderr: '' };
    if (args[0] === 'capture-pane') return {
      code: 0,
      stdout: accepted
        ? 'Ready\n› Ask Codex\nAsk Codex to do anything\n'
        : 'Do you trust the contents of this directory?\n› 1. Yes, continue\nPress enter to continue\n',
      stderr: '',
    };
    if (args[0] === 'send-keys' && args.at(-1) === 'Enter') accepted = true;
    return { code: 0, stdout: '', stderr: '' };
  });
  try {
    const code = await upCommand.run(
      { _: ['backend'], flags: { mux: 'tmux', trust: true } },
      { root, config: { lang: 'en', mux: 'tmux', crew: { backend: { cli: 'codex', title: 'Backend' } } }, json: false },
    );
    assert.equal(code, 0);
    assert.equal(accepted, true);
    assert.equal(loadPanes(root).backend.handle, '%7');
    assert.equal(calls.some((call) => call[0] === 'tmux' && call[1].at(-1) === 'Enter'), true);
    assert.match(upCommand.usage, /--trust/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = previousTmux;
  }
});

test('orca tabs layout skips split and closes the whole tab', () => {
  const calls = [];
  setExec((cmd, args) => {
    calls.push([cmd, args]);
    if (args[1] === 'split') throw new Error('split must not be called for tabs layout');
    if (args[1] === 'create') return { code: 0, stdout: JSON.stringify({ handle: 'term-tabs' }), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  });
  const mux = getMux('orca');
  const pane = mux.spawn({ root: '/tmp/p', role: 'frontend', command: 'codex', anchor: 'term-anchor', layout: 'tabs' });
  assert.deepEqual(pane, { handle: 'term-tabs', layout: 'tab' });
  assert.equal(calls.filter((call) => call[1][1] === 'create').length, 1);
  assert.equal(calls.some((call) => call[1][1] === 'split'), false);
  mux.close(pane.handle, { layout: pane.layout });
  assert.deepEqual(calls.at(-1)[1], ['terminal', 'close', '--terminal', 'term-tabs', '--tab']);
});

test('down forwards a registered Orca tab layout and removes the pane', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-down-tab-'));
  const calls = [];
  savePanes(root, { backend: { mux: 'orca', handle: 'term-tabs', layout: 'tab', cli: 'codex' } });
  setExec((cmd, args) => {
    calls.push([cmd, args]);
    if (args[1] === 'list') return { code: 0, stdout: JSON.stringify({ terminals: [{ handle: 'term-tabs' }] }), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  });
  await downCommand.run({ _: ['backend'], flags: {} }, { root, json: false });
  assert.deepEqual(calls.find((call) => call[1][1] === 'close')[1], ['terminal', 'close', '--terminal', 'term-tabs', '--tab']);
  assert.equal(loadPanes(root).backend, undefined);
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

test('pane command prepends an existing project shim to PATH', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-pane-shim-'));
  ensureShim(root);
  const command = paneCommand({ root, role: 'backend', command: 'codex' });
  assert.ok(command.includes(`PATH=${shq(shimDir(root))}:"$PATH"`), command);
  assert.match(command, /MORAGENT_ROLE=backend/);
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
  const codex = path.join(bin, IS_WIN ? 'codex.cmd' : 'codex');
  fs.writeFileSync(codex, '');
  if (!IS_WIN) fs.chmodSync(codex, 0o755);
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

test('resend checks readiness and resends a queued task to its live role pane', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-resend-'));
  const task = createTask({ root, role: 'backend', body: 'Implement the retry' });
  savePanes(root, { backend: { mux: 'orca', handle: 'term-backend', cli: 'codex' } });
  const calls = [];
  let blocked = true;
  setExec((cmd, args) => {
    calls.push([cmd, args]);
    if (args[1] === 'list') return { code: 0, stdout: JSON.stringify({ ok: true, result: { terminals: [{ handle: 'term-backend', tabId: 'tab-1' }] } }), stderr: '' };
    if (args[1] === 'read') return {
      code: 0,
      stdout: JSON.stringify({ ok: true, result: { terminal: { tail: blocked ? ['Do you trust the files in this folder?'] : ['Ready', '›'] } } }),
      stderr: '',
    };
    return { code: 0, stdout: '', stderr: '' };
  });
  const ctx = { root, config: { lang: 'en', crew: { backend: { cli: 'codex', mission: 'Build backend.' } } }, json: false };
  await assert.rejects(
    resendCommand.run({ _: [task.id], flags: {} }, ctx),
    (error) => error.code === 'PANE_NOT_READY',
  );
  assert.equal(calls.some((call) => call[1][1] === 'send'), false);
  blocked = false;
  await resendCommand.run({ _: [task.id], flags: {} }, ctx);
  const sent = calls.find((call) => call[1][1] === 'send');
  assert.equal(sent[1][sent[1].indexOf('--text') + 1], `Read and execute .moragent/tasks/${task.id}.md`);
  assert.equal(getTask(root, task.id).status, 'sent');
  assert.equal(fs.existsSync(path.join(root, '.moragent', 'tasks', `${task.id}.md`)), true);

  updateTask(root, task.id, { status: 'done' });
  await assert.rejects(
    resendCommand.run({ _: [task.id], flags: {} }, ctx),
    (error) => error.code === 'TASK_NOT_RESENDABLE',
  );
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
