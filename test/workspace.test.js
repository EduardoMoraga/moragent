import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { applyRecovery, createTaskWorkspace, inspectRecovery, listRecoveries } from '../src/engine/workspace.js';
import { createTaskWorkspaceAsync } from '../src/engine/workspace-async.js';

const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'moragent-workspace-test-'));

test('asynchronous worker workspace integrates a private edit', async () => {
  const root = temporary();
  try {
    fs.writeFileSync(path.join(root, 'note.txt'), 'before');
    const workspace = await createTaskWorkspaceAsync(root, 'T-9001');
    fs.writeFileSync(path.join(workspace.root, 'note.txt'), 'after');
    assert.equal(workspace.rewritePaths(workspace.root), fs.realpathSync(root));
    assert.deepEqual(await workspace.integrate(), { ok: true, files: ['note.txt'] });
    assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'after');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('publication checks guard the exact changed path in sync and async workspaces', async () => {
  const root = temporary();
  const check = { type: 'file_text', path: 'exact.txt', lines: ['RIGHT'], finalNewline: true };
  try {
    const wrong = createTaskWorkspace(root, 'T-9015', { publicationChecks: [check] });
    fs.writeFileSync(path.join(wrong.root, 'exact.txt'), 'WRONG\n');
    const rejected = wrong.integrate();
    assert.equal(rejected.ok, false);
    assert.match(rejected.acceptanceFailures[0], /exact\.txt.*expected.*got/);
    assert.equal(fs.existsSync(path.join(root, 'exact.txt')), false);
    assert.equal(inspectRecovery(root, listRecoveries(root)[0].id).manualOnlyReason, 'acceptance-check-failed');

    const right = await createTaskWorkspaceAsync(root, 'T-9016', { publicationChecks: [check] });
    fs.writeFileSync(path.join(right.root, 'exact.txt'), 'RIGHT\n');
    assert.deepEqual(await right.integrate(), { ok: true, files: ['exact.txt'], verifiedChecks: ['exact.txt'] });
    assert.equal(fs.readFileSync(path.join(root, 'exact.txt'), 'utf8'), 'RIGHT\n');

    const unrelated = await createTaskWorkspaceAsync(root, 'T-9017', { publicationChecks: [check] });
    fs.writeFileSync(path.join(unrelated.root, 'other.txt'), 'other');
    assert.deepEqual(await unrelated.integrate(), { ok: true, files: ['other.txt'] });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a checked worker cannot publish a sibling checked path even when its bytes match', async () => {
  const root = temporary();
  try {
    const own = { type: 'file_text', path: 'api.txt', lines: ['API'], finalNewline: true };
    const other = { type: 'file_text', path: 'ui.txt', lines: ['UI'], finalNewline: false };
    const workspace = await createTaskWorkspaceAsync(root, 'T-9018', {
      publicationChecks: [own, other], taskChecks: [own], protectedOtherPaths: ['ui.txt'],
    });
    fs.writeFileSync(path.join(workspace.root, 'api.txt'), 'API\n');
    fs.writeFileSync(path.join(workspace.root, 'ui.txt'), 'UI');
    const result = await workspace.integrate();
    assert.equal(result.ok, false);
    assert.match(result.conflicts.join(' '), /task scope violation: ui\.txt/);
    assert.equal(fs.existsSync(path.join(root, 'api.txt')), false);
    assert.equal(fs.existsSync(path.join(root, 'ui.txt')), false);
    assert.equal(inspectRecovery(root, listRecoveries(root)[0].id).manualOnlyReason, 'task-scope-violation');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('asynchronous workspace reports copy and snapshot phases', async () => {
  const root = temporary();
  let workspace;
  try {
    fs.writeFileSync(path.join(root, 'note.txt'), 'before');
    const phases = [];
    workspace = await createTaskWorkspaceAsync(root, 'T-9008', { onProgress: (phase) => phases.push(phase) });
    assert.deepEqual(phases, ['copying', 'snapshot']);
  } finally {
    if (workspace) await workspace.discard();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('private copy stops when cancelled during file traversal', () => {
  const root = temporary();
  try {
    for (let index = 0; index < 20; index++) fs.writeFileSync(path.join(root, `f-${index}.txt`), 'source');
    let checks = 0;
    assert.throws(() => createTaskWorkspace(root, 'T-9009', { shouldCancel: () => ++checks >= 5 }), /cancelled/);
    assert.ok(checks >= 5);
    assert.equal(fs.readFileSync(path.join(root, 'f-0.txt'), 'utf8'), 'source');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('asynchronous copy observes cancellation from its progress callback', async () => {
  const root = temporary();
  const controller = new AbortController();
  try {
    const dependencies = path.join(root, 'node_modules', 'fixture');
    fs.mkdirSync(dependencies, { recursive: true });
    for (let index = 0; index < 5000; index++) fs.writeFileSync(path.join(dependencies, `f-${index}.js`), 'x'.repeat(256));
    let sawCopy = false;
    await assert.rejects(createTaskWorkspaceAsync(root, 'T-9010', {
      signal: controller.signal,
      onProgress: (phase) => { if (phase === 'copying') { sawCopy = true; controller.abort(); } },
    }), /cancelled/);
    assert.equal(sawCopy, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a worker crash during preparation removes its unfinished temporary copy', async () => {
  const root = temporary();
  let worker;
  let container;
  try {
    const dependencies = path.join(root, 'node_modules', 'fixture');
    fs.mkdirSync(dependencies, { recursive: true });
    for (let index = 0; index < 4000; index++) fs.writeFileSync(path.join(dependencies, `f-${index}.js`), 'x');
    fs.writeFileSync(path.join(root, 'source.txt'), 'source');
    let interrupted = false;
    await assert.rejects(createTaskWorkspaceAsync(root, 'T-9012', {
      onWorker: (handle, directory) => { worker = handle; container = directory; },
      onProgress: (phase) => {
        if (phase === 'copying') { interrupted = true; void worker.terminate(); }
      },
    }), /workspace worker exited/);
    assert.equal(interrupted, true);
    assert.equal(fs.existsSync(container), false);
    assert.equal(fs.readFileSync(path.join(root, 'source.txt'), 'utf8'), 'source');
    assert.deepEqual(listRecoveries(root), []);
  } finally {
    if (worker) await worker.terminate();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('asynchronous workspace preparation leaves the event loop responsive', async () => {
  const root = temporary();
  let workspace;
  try {
    const dependencies = path.join(root, 'node_modules', 'fixture');
    fs.mkdirSync(dependencies, { recursive: true });
    for (let index = 0; index < 1200; index++) fs.writeFileSync(path.join(dependencies, `file-${index}.js`), 'x'.repeat(256));
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 1);
    try { workspace = await createTaskWorkspaceAsync(root, 'T-9002'); }
    finally { clearInterval(timer); }
    assert.ok(ticks > 0, 'the main event loop ran while the worker prepared the copy');
  } finally {
    if (workspace) await workspace.discard();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cancelling an asynchronous workspace before integration retains edits without publishing', async () => {
  const root = temporary();
  const controller = new AbortController();
  try {
    fs.writeFileSync(path.join(root, 'note.txt'), 'before');
    const workspace = await createTaskWorkspaceAsync(root, 'T-9003', { signal: controller.signal });
    fs.writeFileSync(path.join(workspace.root, 'note.txt'), 'private');
    controller.abort();
    const result = await workspace.integrate();
    assert.equal(result.ok, false);
    assert.match(result.conflicts.join(' '), /cancelled/);
    assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'before');
    assert.equal(fs.readFileSync(path.join(result.workspace, 'note.txt'), 'utf8'), 'private');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cancellation during multi-file publication rolls back earlier writes', () => {
  const root = temporary();
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'old-a');
    fs.writeFileSync(path.join(root, 'b.txt'), 'old-b');
    const workspace = createTaskWorkspace(root, 'T-9004');
    fs.writeFileSync(path.join(workspace.root, 'a.txt'), 'new-a');
    fs.writeFileSync(path.join(workspace.root, 'b.txt'), 'new-b');
    let checks = 0;
    const result = workspace.integrate(() => ++checks >= 6);
    assert.equal(result.ok, false);
    assert.match(result.conflicts.join(' '), /cancelled/);
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'old-a');
    assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'old-b');
    assert.equal(fs.readFileSync(path.join(result.workspace, 'a.txt'), 'utf8'), 'new-a');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('parallel asynchronous integrations retain optimistic conflict detection', async () => {
  const root = temporary();
  try {
    fs.writeFileSync(path.join(root, 'shared.txt'), 'base');
    const [first, second] = await Promise.all([
      createTaskWorkspaceAsync(root, 'T-9005'),
      createTaskWorkspaceAsync(root, 'T-9006'),
    ]);
    fs.writeFileSync(path.join(first.root, 'shared.txt'), 'first');
    fs.writeFileSync(path.join(second.root, 'shared.txt'), 'second');
    const [a, b] = await Promise.all([first.integrate(), second.integrate()]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, false);
    assert.deepEqual(b.conflicts, ['shared.txt']);
    assert.equal(fs.readFileSync(path.join(root, 'shared.txt'), 'utf8'), 'first');
    assert.equal(fs.readFileSync(path.join(b.workspace, 'shared.txt'), 'utf8'), 'second');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('publication waits for another MORAGENT process and reclaims its dead lock', async () => {
  const root = temporary();
  let child;
  let workspace;
  const lockModule = new URL('../src/engine/publication-lock.js', import.meta.url).href;
  const holdLock = async () => {
    const code = `import { withPublicationLock } from ${JSON.stringify(lockModule)};
      await withPublicationLock(${JSON.stringify(root)}, async () => {
        process.stdout.write('locked\\n');
        await new Promise((resolve) => process.stdin.once('data', resolve));
      });`;
    const processHandle = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      processHandle.stdout.once('data', (data) => String(data).includes('locked') ? resolve() : reject(new Error(`unexpected lock response: ${data}`)));
      processHandle.once('error', reject);
      processHandle.once('exit', (exitCode) => reject(new Error(`lock holder exited early: ${exitCode}`)));
    });
    return processHandle;
  };
  try {
    fs.writeFileSync(path.join(root, 'note.txt'), 'before');
    workspace = await createTaskWorkspaceAsync(root, 'T-9013');
    fs.writeFileSync(path.join(workspace.root, 'note.txt'), 'after');
    child = await holdLock();
    let settled = false;
    const integration = workspace.integrate().then((result) => { settled = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(settled, false, 'the other process still owns publication');
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    child = null;
    assert.deepEqual(await integration, { ok: true, files: ['note.txt'] });
    assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'after');
  } finally {
    if (child) child.kill('SIGKILL');
    if (workspace && !workspace.closed) await workspace.discard();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('asynchronous preparation rejects an external symlink without touching its target', { skip: process.platform === 'win32' }, async () => {
  const parent = temporary();
  try {
    const root = path.join(parent, 'project');
    const outside = path.join(parent, 'outside.txt');
    fs.mkdirSync(root);
    fs.writeFileSync(outside, 'untouched');
    fs.symlinkSync(outside, path.join(root, 'alias.txt'));
    await assert.rejects(createTaskWorkspaceAsync(root, 'T-9007'), /symlink points outside project/);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched');
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('a crashed workspace worker leaves edited files in manual-only recoveries', async () => {
  const root = temporary();
  let worker;
  try {
    fs.writeFileSync(path.join(root, 'note.txt'), 'source');
    const workspace = await createTaskWorkspaceAsync(root, 'T-9011', { onWorker: (handle) => { worker = handle; } });
    fs.writeFileSync(path.join(workspace.root, 'note.txt'), 'private');
    await worker.terminate();
    await assert.rejects(workspace.integrate(), /Manual-only recovery/);
    assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'source');
    const saved = listRecoveries(root);
    assert.equal(saved.length, 1);
    assert.equal(fs.readFileSync(path.join(saved[0].path, 'note.txt'), 'utf8'), 'private');
    assert.equal(inspectRecovery(root, saved[0].id).code, 'manifest-missing');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('independent workers publish disjoint files and a dependent worker sees both', () => {
  const root = temporary();
  fs.writeFileSync(path.join(root, 'base.txt'), 'original');
  const first = createTaskWorkspace(root);
  const second = createTaskWorkspace(root, 'T-0002');
  assert.notEqual(first.root, second.root);
  fs.writeFileSync(path.join(first.root, 'a.txt'), 'A');
  fs.writeFileSync(path.join(second.root, 'b.txt'), 'B');
  const privateLink = `[a](${fs.realpathSync(path.join(first.root, 'a.txt'))})`;
  assert.equal(first.rewritePaths(privateLink), `[a](${path.join(fs.realpathSync(root), 'a.txt')})`);
  assert.deepEqual(first.integrate().files, ['a.txt']);
  assert.deepEqual(second.integrate().files, ['b.txt']);
  const dependent = createTaskWorkspace(root);
  assert.equal(fs.readFileSync(path.join(dependent.root, 'a.txt'), 'utf8'), 'A');
  assert.equal(fs.readFileSync(path.join(dependent.root, 'b.txt'), 'utf8'), 'B');
  dependent.discard();
});

test('an absolute symlink within a project does not let a worker edit the real project', { skip: process.platform === 'win32' }, () => {
  const root = temporary();
  let workspace;
  try {
    const target = path.join(root, 'target.txt');
    fs.writeFileSync(target, 'original');
    fs.symlinkSync(target, path.join(root, 'alias.txt'));
    workspace = createTaskWorkspace(root, 'T-0019');
    fs.writeFileSync(path.join(workspace.root, 'alias.txt'), 'private');
    assert.equal(fs.readFileSync(target, 'utf8'), 'original');
    assert.equal(fs.readFileSync(path.join(workspace.root, 'target.txt'), 'utf8'), 'private');
    assert.equal(workspace.integrate().ok, true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'private');
  } finally {
    workspace?.discard();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a relative internal symlink stays inside the worker copy', { skip: process.platform === 'win32' }, () => {
  const root = temporary();
  let workspace;
  try {
    fs.mkdirSync(path.join(root, 'lib'));
    fs.writeFileSync(path.join(root, 'lib', 'target.txt'), 'original');
    fs.symlinkSync(path.join('lib', 'target.txt'), path.join(root, 'alias.txt'));
    workspace = createTaskWorkspace(root, 'T-0020');
    fs.writeFileSync(path.join(workspace.root, 'alias.txt'), 'private');
    assert.equal(fs.readFileSync(path.join(root, 'lib', 'target.txt'), 'utf8'), 'original');
    assert.equal(fs.readFileSync(path.join(workspace.root, 'lib', 'target.txt'), 'utf8'), 'private');
  } finally {
    workspace?.discard();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an external symlink prevents unsafe worker preparation', { skip: process.platform === 'win32' }, () => {
  const parent = temporary();
  const root = path.join(parent, 'project');
  const outside = path.join(parent, 'outside.txt');
  try {
    fs.mkdirSync(root);
    fs.writeFileSync(outside, 'untouched');
    fs.symlinkSync(outside, path.join(root, 'external.txt'));
    assert.throws(() => createTaskWorkspace(root, 'T-0021'), /symlink.*outside|enlace.*fuera/i);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('external symlinks inside node_modules are also rejected', { skip: process.platform === 'win32' }, () => {
  const parent = temporary();
  const root = path.join(parent, 'project');
  try {
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    fs.symlinkSync(parent, path.join(root, 'node_modules', 'shared'));
    assert.throws(() => createTaskWorkspace(root, 'T-0022'), /symlink.*outside/i);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('a dependency edit is preserved instead of silently reported as integrated', () => {
  const root = temporary();
  let workspace;
  try {
    fs.mkdirSync(path.join(root, 'node_modules', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'demo', 'index.js'), 'original');
    workspace = createTaskWorkspace(root, 'T-0023');
    fs.writeFileSync(path.join(workspace.root, 'node_modules', 'demo', 'index.js'), 'private edit');
    const merge = workspace.integrate();
    assert.equal(merge.ok, false);
    assert.match(merge.conflicts[0], /node_modules/);
    assert.equal(fs.readFileSync(path.join(root, 'node_modules', 'demo', 'index.js'), 'utf8'), 'original');
    assert.equal(fs.readFileSync(path.join(merge.workspace, 'node_modules', 'demo', 'index.js'), 'utf8'), 'private edit');
    const preview = inspectRecovery(root, 'T-0023');
    assert.equal(preview.ok, true);
    assert.equal(preview.excludedCount, 1);
    assert.deepEqual(preview.excludedPaths, [path.join('node_modules', 'demo', 'index.js')]);
    assert.equal(preview.canApply, false);
  } finally {
    workspace?.discard();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('file recovery reports dependency changes that remain only in the saved copy', () => {
  const root = temporary();
  let workspace;
  try {
    fs.writeFileSync(path.join(root, 'app.txt'), 'old app');
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'node_modules', 'dep.js'), 'old dep');
    workspace = createTaskWorkspace(root, 'T-0025');
    fs.writeFileSync(path.join(workspace.root, 'app.txt'), 'new app');
    fs.writeFileSync(path.join(workspace.root, 'node_modules', 'dep.js'), 'new dep');
    const merge = workspace.integrate();
    assert.equal(merge.ok, false);
    assert.equal(fs.readFileSync(path.join(root, 'app.txt'), 'utf8'), 'old app');
    const preview = inspectRecovery(root, 'T-0025');
    assert.deepEqual(preview.files, ['app.txt']);
    assert.deepEqual(preview.excludedPaths, [path.join('node_modules', 'dep.js')]);
    const applied = applyRecovery(root, preview.id);
    assert.equal(applied.ok, true);
    assert.equal(applied.excludedCount, 1);
    assert.equal(fs.readFileSync(path.join(root, 'app.txt'), 'utf8'), 'new app');
    assert.equal(fs.readFileSync(path.join(root, 'node_modules', 'dep.js'), 'utf8'), 'old dep');
    assert.equal(fs.readFileSync(path.join(merge.workspace, 'node_modules', 'dep.js'), 'utf8'), 'new dep');
  } finally {
    workspace?.discard();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('new dependency files are preserved instead of disappearing', () => {
  const root = temporary();
  let workspace;
  try {
    fs.mkdirSync(path.join(root, 'node_modules'));
    workspace = createTaskWorkspace(root, 'T-0024');
    fs.writeFileSync(path.join(workspace.root, 'node_modules', 'new.js'), 'new dependency');
    const merge = workspace.integrate();
    assert.equal(merge.ok, false);
    assert.equal(fs.existsSync(path.join(root, 'node_modules', 'new.js')), false);
    assert.equal(fs.readFileSync(path.join(merge.workspace, 'node_modules', 'new.js'), 'utf8'), 'new dependency');
  } finally {
    workspace?.discard();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('empty directory additions and removals survive worker integration', () => {
  const root = temporary();
  let workspace;
  try {
    fs.mkdirSync(path.join(root, 'remove-me'));
    workspace = createTaskWorkspace(root, 'T-0015');
    fs.rmdirSync(path.join(workspace.root, 'remove-me'));
    fs.mkdirSync(path.join(workspace.root, 'new', 'empty'), { recursive: true });
    const merge = workspace.integrate();
    assert.equal(merge.ok, true);
    assert.equal(fs.existsSync(path.join(root, 'remove-me')), false);
    assert.equal(fs.statSync(path.join(root, 'new', 'empty')).isDirectory(), true);
    assert.deepEqual(merge.files, ['new', path.join('new', 'empty'), 'remove-me']);
  } finally {
    workspace?.discard();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('directory permission changes survive worker integration', { skip: process.platform === 'win32' }, () => {
  const root = temporary();
  let workspace;
  try {
    fs.mkdirSync(path.join(root, 'private'));
    fs.chmodSync(path.join(root, 'private'), 0o755);
    workspace = createTaskWorkspace(root, 'T-0016');
    fs.chmodSync(path.join(workspace.root, 'private'), 0o700);
    const merge = workspace.integrate();
    assert.equal(merge.ok, true);
    assert.deepEqual(merge.files, ['private']);
    assert.equal(fs.statSync(path.join(root, 'private')).mode & 0o777, 0o700);
  } finally {
    workspace?.discard();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a failed directory publish rolls back earlier file and directory changes', { skip: process.platform === 'win32' }, () => {
  const root = temporary();
  const canonical = fs.realpathSync(root);
  let workspace;
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'original');
    workspace = createTaskWorkspace(root, 'T-0017');
    fs.writeFileSync(path.join(workspace.root, 'a.txt'), 'worker');
    fs.mkdirSync(path.join(workspace.root, 'new'));
    fs.chmodSync(path.join(workspace.root, 'new'), 0o755);
    const originalChmod = fs.chmodSync;
    let injected = false;
    fs.chmodSync = (file, mode) => {
      if (!injected && file === path.join(canonical, 'new') && mode === 0o755) {
        injected = true;
        throw Object.assign(new Error('injected directory failure'), { code: 'EIO' });
      }
      return originalChmod(file, mode);
    };
    let merge;
    try { merge = workspace.integrate(); }
    finally { fs.chmodSync = originalChmod; }
    assert.equal(injected, true);
    assert.equal(merge.ok, false);
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'original');
    assert.equal(fs.existsSync(path.join(root, 'new')), false);
    assert.equal(fs.statSync(path.join(merge.workspace, 'new')).isDirectory(), true);
  } finally {
    workspace?.discard();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('conflicting edits do not overwrite the first worker and preserve the second workspace', () => {
  const root = temporary();
  fs.writeFileSync(path.join(root, 'shared.txt'), 'original');
  const first = createTaskWorkspace(root);
  const second = createTaskWorkspace(root, 'T-0002');
  fs.writeFileSync(path.join(first.root, 'shared.txt'), 'first');
  fs.writeFileSync(path.join(second.root, 'shared.txt'), 'second');
  assert.equal(first.integrate().ok, true);
  const merge = second.integrate();
  assert.equal(merge.ok, false);
  assert.deepEqual(merge.conflicts, ['shared.txt']);
  assert.equal(fs.readFileSync(path.join(root, 'shared.txt'), 'utf8'), 'first');
  assert.equal(fs.readFileSync(path.join(merge.workspace, 'shared.txt'), 'utf8'), 'second');
  assert.ok(merge.workspace.includes(path.join('.moragent', 'runs', 'recovery')));
  assert.deepEqual(listRecoveries(root).map((item) => item.path), [merge.workspace]);
  const inspection = inspectRecovery(root, 'T-0002');
  assert.equal(inspection.ok, true);
  assert.deepEqual(inspection.files, ['shared.txt']);
  assert.deepEqual(inspection.conflicts, ['shared.txt']);
  assert.equal(inspection.canApply, false);
  assert.equal(applyRecovery(root, 'T-0002').ok, false);
  assert.equal(fs.readFileSync(path.join(root, 'shared.txt'), 'utf8'), 'first');
  fs.writeFileSync(path.join(root, 'shared.txt'), 'original');
  const applied = applyRecovery(root, inspection.id);
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.files, ['shared.txt']);
  assert.equal(fs.readFileSync(path.join(root, 'shared.txt'), 'utf8'), 'second');
  assert.equal(fs.readFileSync(path.join(merge.workspace, 'shared.txt'), 'utf8'), 'second');
  second.discard();
  assert.deepEqual(listRecoveries(root), []);
});

test('a failed multi-file publish restores executable permissions as well as contents', { skip: process.platform === 'win32' }, () => {
  const root = temporary();
  const script = path.join(root, 'a.sh');
  const second = path.join(root, 'b.txt');
  const canonicalSecond = path.join(fs.realpathSync(root), 'b.txt');
  let workspace;
  try {
    fs.writeFileSync(script, 'original\n', { mode: 0o755 });
    fs.chmodSync(script, 0o755);
    fs.writeFileSync(second, 'original\n');
    workspace = createTaskWorkspace(root, 'T-0012');
    fs.writeFileSync(path.join(workspace.root, 'a.sh'), 'worker\n');
    fs.chmodSync(path.join(workspace.root, 'a.sh'), 0o644);
    fs.writeFileSync(path.join(workspace.root, 'b.txt'), 'worker\n');
    const originalRename = fs.renameSync;
    let injected = false;
    fs.renameSync = (from, to) => {
      if (!injected && to === canonicalSecond) {
        injected = true;
        throw Object.assign(new Error('injected publish failure'), { code: 'EIO' });
      }
      return originalRename(from, to);
    };
    let merge;
    try { merge = workspace.integrate(); }
    finally { fs.renameSync = originalRename; }
    assert.equal(injected, true);
    assert.equal(merge.ok, false);
    assert.equal(fs.readFileSync(script, 'utf8'), 'original\n');
    assert.equal(fs.statSync(script).mode & 0o777, 0o755);
    assert.equal(fs.readFileSync(second, 'utf8'), 'original\n');
  } finally {
    workspace?.discard();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('git clone keeps dirty tracked and untracked files without sharing repository metadata', () => {
  const root = temporary();
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'MORAGENT Test']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'committed');
  execFileSync('git', ['-C', root, 'add', 'tracked.txt']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'initial']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'dirty');
  fs.writeFileSync(path.join(root, 'untracked.txt'), 'new');
  const workspace = createTaskWorkspace(root);
  assert.equal(fs.readFileSync(path.join(workspace.root, 'tracked.txt'), 'utf8'), 'dirty');
  assert.equal(fs.readFileSync(path.join(workspace.root, 'untracked.txt'), 'utf8'), 'new');
  assert.equal(fs.existsSync(path.join(workspace.root, '.git')), true);
  const sourceHead = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', workspace.root, 'config', 'user.name', 'MORAGENT Test']);
  execFileSync('git', ['-C', workspace.root, 'config', 'user.email', 'test@example.invalid']);
  execFileSync('git', ['-C', workspace.root, 'add', '-A']);
  execFileSync('git', ['-C', workspace.root, 'commit', '-qm', 'private commit']);
  assert.equal(execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceHead);
  fs.writeFileSync(path.join(workspace.root, 'output.txt'), 'task result');
  const conflict = workspace.integrate();
  assert.equal(conflict.ok, false, 'private commits are not silently lost');
  assert.match(conflict.conflicts[0], /Git history changed/);
  assert.equal(fs.existsSync(path.join(root, 'output.txt')), false);
  workspace.discard();
  const cleanWorkspace = createTaskWorkspace(root);
  fs.writeFileSync(path.join(cleanWorkspace.root, 'output.txt'), 'task result');
  assert.equal(cleanWorkspace.integrate().ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'output.txt'), 'utf8'), 'task result');
  assert.equal(fs.readFileSync(path.join(root, 'tracked.txt'), 'utf8'), 'dirty');
});

test('private Git refs are preserved instead of being silently discarded', () => {
  const root = temporary();
  let workspace;
  try {
    execFileSync('git', ['init', '-q', root]);
    fs.writeFileSync(path.join(root, 'base.txt'), 'base');
    execFileSync('git', ['-C', root, 'add', 'base.txt']);
    execFileSync('git', ['-C', root, '-c', 'user.name=Moragent Smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-qm', 'initial']);
    workspace = createTaskWorkspace(root, 'T-0003');
    execFileSync('git', ['-C', workspace.root, 'branch', 'private-idea']);
    fs.writeFileSync(path.join(workspace.root, 'result.txt'), 'would be lost');
    const merge = workspace.integrate();
    assert.equal(merge.ok, false);
    assert.match(merge.conflicts[0], /Git.*ref|Git.*history/i);
    assert.equal(fs.existsSync(path.join(root, 'result.txt')), false);
    assert.equal(execFileSync('git', ['-C', merge.workspace, 'rev-parse', '--verify', 'private-idea'], { encoding: 'utf8' }).trim().length, 40);
    const inspection = inspectRecovery(root, 'T-0003');
    assert.equal(inspection.canApply, true);
    assert.equal(inspection.gitPortable, true);
    assert.deepEqual(inspection.files, ['result.txt']);
    const alternates = path.join(merge.workspace, '.git', 'objects', 'info', 'alternates');
    fs.writeFileSync(alternates, `${path.join(root, '.git', 'objects')}\n`);
    assert.equal(inspectRecovery(root, inspection.id).gitPortable, false, 'legacy shared copies are marked as path-dependent');
    fs.unlinkSync(alternates);
    const applied = applyRecovery(root, inspection.id);
    assert.equal(applied.ok, true);
    assert.equal(fs.readFileSync(path.join(root, 'result.txt'), 'utf8'), 'would be lost');
    assert.equal(execFileSync('git', ['-C', merge.workspace, 'rev-parse', '--verify', 'private-idea'], { encoding: 'utf8' }).trim().length, 40);
  } finally {
    workspace?.discard();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a private detached HEAD is preserved even when its commit is unchanged', () => {
  const root = temporary();
  let workspace;
  try {
    execFileSync('git', ['init', '-q', root]);
    fs.writeFileSync(path.join(root, 'base.txt'), 'base');
    execFileSync('git', ['-C', root, 'add', 'base.txt']);
    execFileSync('git', ['-C', root, '-c', 'user.name=Moragent Smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-qm', 'initial']);
    workspace = createTaskWorkspace(root, 'T-0013');
    execFileSync('git', ['-C', workspace.root, 'checkout', '--detach', '-q', 'HEAD']);
    fs.writeFileSync(path.join(workspace.root, 'result.txt'), 'private result');
    const merge = workspace.integrate();
    assert.equal(merge.ok, false);
    assert.match(merge.conflicts[0], /Git.*HEAD/i);
    assert.equal(fs.existsSync(path.join(root, 'result.txt')), false);
    assert.equal(fs.readFileSync(path.join(merge.workspace, 'result.txt'), 'utf8'), 'private result');
    assert.throws(() => execFileSync('git', ['-C', merge.workspace, 'symbolic-ref', '-q', 'HEAD'], { stdio: 'ignore' }));
  } finally {
    workspace?.discard();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('private Git configuration is preserved instead of silently discarded', () => {
  const root = temporary();
  let workspace;
  try {
    execFileSync('git', ['init', '-q', root]);
    fs.writeFileSync(path.join(root, 'base.txt'), 'base');
    execFileSync('git', ['-C', root, 'add', 'base.txt']);
    execFileSync('git', ['-C', root, '-c', 'user.name=Moragent Smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-qm', 'initial']);
    workspace = createTaskWorkspace(root, 'T-0014');
    execFileSync('git', ['-C', workspace.root, 'config', 'user.name', 'Private Agent']);
    fs.writeFileSync(path.join(workspace.root, 'result.txt'), 'private result');
    const merge = workspace.integrate();
    assert.equal(merge.ok, false);
    assert.match(merge.conflicts[0], /Git.*config/i);
    assert.equal(fs.existsSync(path.join(root, 'result.txt')), false);
    assert.equal(execFileSync('git', ['-C', merge.workspace, 'config', 'user.name'], { encoding: 'utf8' }).trim(), 'Private Agent');
  } finally {
    workspace?.discard();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('preserved Git objects remain readable after their project is moved', () => {
  const parent = temporary();
  const root = path.join(parent, 'source');
  const moved = path.join(parent, 'moved');
  try {
    fs.mkdirSync(root);
    execFileSync('git', ['init', '-q', root]);
    fs.writeFileSync(path.join(root, 'base.txt'), 'base');
    execFileSync('git', ['-C', root, 'add', 'base.txt']);
    execFileSync('git', ['-C', root, '-c', 'user.name=Moragent Smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-qm', 'initial']);
    const workspace = createTaskWorkspace(root, 'T-0008');
    execFileSync('git', ['-C', workspace.root, 'branch', 'private-idea']);
    fs.writeFileSync(path.join(workspace.root, 'result.txt'), 'saved');
    const merge = workspace.integrate();
    assert.equal(merge.ok, false);
    assert.equal(inspectRecovery(root, 'T-0008').gitPortable, true);
    const savedRelative = path.relative(fs.realpathSync(root), merge.workspace);
    fs.renameSync(root, moved);
    const saved = path.join(moved, savedRelative);
    assert.equal(fs.readFileSync(path.join(saved, 'result.txt'), 'utf8'), 'saved');
    assert.doesNotThrow(() => execFileSync('git', ['-C', saved, 'cat-file', '-e', 'private-idea^{commit}'], { stdio: 'ignore' }));
    const preview = inspectRecovery(moved, 'T-0008');
    assert.equal(preview.ok, true);
    assert.equal(preview.canApply, true);
    assert.equal(applyRecovery(moved, preview.id).ok, true);
    assert.equal(fs.readFileSync(path.join(moved, 'result.txt'), 'utf8'), 'saved');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('a recovery directory copied without its project identity cannot apply elsewhere', () => {
  const parent = temporary();
  const origin = path.join(parent, 'origin');
  const other = path.join(parent, 'other');
  try {
    fs.mkdirSync(origin);
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(origin, 'shared.txt'), 'same baseline');
    fs.writeFileSync(path.join(other, 'shared.txt'), 'same baseline');
    const workspace = createTaskWorkspace(origin, 'T-0010');
    fs.writeFileSync(path.join(workspace.root, 'shared.txt'), 'private edit');
    workspace.preserve();
    const saved = listRecoveries(origin)[0];
    const target = path.join(other, '.moragent', 'runs', 'recovery', saved.id);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(path.dirname(saved.path), target, { recursive: true });
    assert.equal(inspectRecovery(other, saved.id).code, 'manifest-mismatch');
    assert.equal(applyRecovery(other, saved.id).ok, false);
    assert.equal(fs.readFileSync(path.join(other, 'shared.txt'), 'utf8'), 'same baseline');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('a moved Git recovery retains staged private content', () => {
  const parent = temporary();
  const root = path.join(parent, 'source');
  const moved = path.join(parent, 'moved');
  try {
    fs.mkdirSync(root);
    execFileSync('git', ['init', '-q', root]);
    fs.writeFileSync(path.join(root, 'base.txt'), 'base');
    execFileSync('git', ['-C', root, 'add', 'base.txt']);
    execFileSync('git', ['-C', root, '-c', 'user.name=Moragent Smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-qm', 'initial']);
    const workspace = createTaskWorkspace(root, 'T-0009');
    fs.writeFileSync(path.join(workspace.root, 'staged.txt'), 'private staged data');
    execFileSync('git', ['-C', workspace.root, 'add', 'staged.txt']);
    const merge = workspace.integrate();
    assert.equal(merge.ok, false);
    const savedRelative = path.relative(fs.realpathSync(root), merge.workspace);
    fs.renameSync(root, moved);
    const saved = path.join(moved, savedRelative);
    assert.equal(execFileSync('git', ['-C', saved, 'show', ':staged.txt'], { encoding: 'utf8' }), 'private staged data');
    assert.doesNotThrow(() => execFileSync('git', ['-C', saved, 'cat-file', '-e', 'HEAD^{commit}'], { stdio: 'ignore' }));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('private staged Git state is preserved instead of being silently discarded', () => {
  const root = temporary();
  let workspace;
  try {
    execFileSync('git', ['init', '-q', root]);
    fs.writeFileSync(path.join(root, 'base.txt'), 'base');
    execFileSync('git', ['-C', root, 'add', 'base.txt']);
    execFileSync('git', ['-C', root, '-c', 'user.name=Moragent Smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-qm', 'initial']);
    workspace = createTaskWorkspace(root, 'T-0004');
    fs.writeFileSync(path.join(workspace.root, 'staged.txt'), 'staged');
    execFileSync('git', ['-C', workspace.root, 'add', 'staged.txt']);
    const merge = workspace.integrate();
    assert.equal(merge.ok, false);
    assert.match(merge.conflicts[0], /Git.*index|Git.*staged/i);
    assert.equal(fs.existsSync(path.join(root, 'staged.txt')), false);
    assert.match(execFileSync('git', ['-C', merge.workspace, 'diff', '--cached', '--name-only'], { encoding: 'utf8' }), /staged.txt/);
  } finally {
    workspace?.discard();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recovery requires an exact copy and refuses legacy or tampered manifests', () => {
  const root = temporary();
  const copies = [];
  try {
    fs.writeFileSync(path.join(root, 'shared.txt'), 'baseline');
    for (const content of ['first', 'second']) {
      const workspace = createTaskWorkspace(root, 'T-0005');
      copies.push(workspace);
      fs.writeFileSync(path.join(workspace.root, 'shared.txt'), content);
    }
    fs.writeFileSync(path.join(root, 'shared.txt'), 'user edit');
    for (const workspace of copies) assert.equal(workspace.integrate().ok, false);
    const saved = listRecoveries(root).filter((entry) => entry.taskId === 'T-0005');
    assert.equal(saved.length, 2);
    assert.equal(inspectRecovery(root, 'T-0005').code, 'ambiguous');
    assert.equal(applyRecovery(root, 'T-0005').code, 'ambiguous');
    assert.equal(inspectRecovery(root, saved[0].id).ok, true);

    const manifestPath = path.join(root, '.moragent', 'runs', 'recovery', saved[0].id, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const identityPath = path.join(root, '.moragent', 'runs', 'recovery', '.project-id');
    const identity = fs.readFileSync(identityPath, 'utf8');
    fs.writeFileSync(identityPath, '00000000-0000-0000-0000-000000000000\n');
    assert.equal(inspectRecovery(root, saved[0].id).code, 'manifest-mismatch');
    fs.writeFileSync(identityPath, identity);
    const legacy = { ...manifest, version: 1 };
    delete legacy.projectId;
    fs.writeFileSync(manifestPath, JSON.stringify(legacy));
    assert.equal(inspectRecovery(root, saved[0].id).ok, true, 'existing path-bound manifests remain usable');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    manifest.files[0].path = '../escape.txt';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.equal(inspectRecovery(root, saved[0].id).code, 'manifest-invalid');
    assert.equal(applyRecovery(root, saved[0].id).ok, false);
    fs.writeFileSync(manifestPath, 'null');
    assert.equal(inspectRecovery(root, saved[0].id).code, 'manifest-mismatch');

    const oldManifest = path.join(root, '.moragent', 'runs', 'recovery', saved[1].id, 'manifest.json');
    fs.unlinkSync(oldManifest);
    assert.equal(inspectRecovery(root, saved[1].id).code, 'manifest-missing');
    assert.equal(applyRecovery(root, saved[1].id).ok, false);
    assert.equal(fs.readFileSync(path.join(root, 'shared.txt'), 'utf8'), 'user edit');
  } finally {
    for (const workspace of copies) workspace.discard();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('explicit recovery applies additions, edits and deletions while retaining the copy', () => {
  const root = temporary();
  let workspace;
  try {
    fs.writeFileSync(path.join(root, 'edit.txt'), 'before');
    fs.writeFileSync(path.join(root, 'delete.txt'), 'remove me');
    workspace = createTaskWorkspace(root, 'T-0007');
    fs.writeFileSync(path.join(workspace.root, 'edit.txt'), 'after');
    fs.unlinkSync(path.join(workspace.root, 'delete.txt'));
    fs.writeFileSync(path.join(workspace.root, 'add.txt'), 'new');
    workspace.preserve();
    const preview = inspectRecovery(root, 'T-0007');
    assert.equal(preview.canApply, true);
    assert.deepEqual(preview.files, ['add.txt', 'delete.txt', 'edit.txt']);
    const applied = applyRecovery(root, preview.id);
    assert.equal(applied.ok, true);
    assert.equal(fs.readFileSync(path.join(root, 'add.txt'), 'utf8'), 'new');
    assert.equal(fs.readFileSync(path.join(root, 'edit.txt'), 'utf8'), 'after');
    assert.equal(fs.existsSync(path.join(root, 'delete.txt')), false);
    assert.equal(fs.readFileSync(path.join(preview.path, 'add.txt'), 'utf8'), 'new');
    assert.equal(applyRecovery(root, preview.id).ok, false, 'repeated application needs a fresh matching baseline');
  } finally {
    workspace?.discard();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('explicit recovery applies empty directory changes and permissions', { skip: process.platform === 'win32' }, () => {
  const root = temporary();
  let workspace;
  try {
    fs.mkdirSync(path.join(root, 'retired'));
    workspace = createTaskWorkspace(root, 'T-0018');
    fs.rmdirSync(path.join(workspace.root, 'retired'));
    fs.mkdirSync(path.join(workspace.root, 'new', 'private'), { recursive: true });
    fs.chmodSync(path.join(workspace.root, 'new', 'private'), 0o700);
    workspace.preserve();
    const preview = inspectRecovery(root, 'T-0018');
    assert.equal(preview.canApply, true);
    assert.deepEqual(preview.files, ['new', path.join('new', 'private'), 'retired']);
    assert.equal(applyRecovery(root, preview.id).ok, true);
    assert.equal(fs.existsSync(path.join(root, 'retired')), false);
    assert.equal(fs.statSync(path.join(root, 'new', 'private')).mode & 0o777, 0o700);
  } finally {
    workspace?.discard();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a project inside a monorepo keeps its relative cwd and can publish sibling changes safely', () => {
  const repo = temporary();
  const project = path.join(repo, 'apps', 'demo');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(repo, 'packages', 'shared'), { recursive: true });
  fs.writeFileSync(path.join(project, 'app.txt'), 'app');
  fs.writeFileSync(path.join(repo, 'packages', 'shared', 'util.txt'), 'old');
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Moragent Smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-qm', 'initial']);
  const workspace = createTaskWorkspace(project);
  assert.equal(fs.readFileSync(path.join(workspace.root, 'app.txt'), 'utf8'), 'app');
  fs.writeFileSync(path.resolve(workspace.root, '../../packages/shared/util.txt'), 'new');
  const merge = workspace.integrate();
  assert.equal(merge.ok, true);
  assert.deepEqual(merge.files, [path.join('packages', 'shared', 'util.txt')]);
  assert.equal(fs.readFileSync(path.join(repo, 'packages', 'shared', 'util.txt'), 'utf8'), 'new');
});

test('a monorepo project can recover a sibling file after its conflict is resolved', () => {
  const repo = temporary();
  const project = path.join(repo, 'apps', 'demo');
  const sibling = path.join(repo, 'packages', 'shared', 'util.txt');
  let workspace;
  try {
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.dirname(sibling), { recursive: true });
    fs.writeFileSync(path.join(project, 'app.txt'), 'app');
    fs.writeFileSync(sibling, 'old');
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, '-c', 'user.name=Moragent Smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-qm', 'initial']);
    workspace = createTaskWorkspace(project, 'T-0006');
    fs.writeFileSync(path.resolve(workspace.root, '../../packages/shared/util.txt'), 'worker');
    fs.writeFileSync(sibling, 'user');
    assert.equal(workspace.integrate().ok, false);
    const preview = inspectRecovery(project, 'T-0006');
    assert.equal(preview.ok, true);
    assert.deepEqual(preview.conflicts, [path.join('packages', 'shared', 'util.txt')]);
    fs.writeFileSync(sibling, 'old');
    assert.equal(applyRecovery(project, preview.id).ok, true);
    assert.equal(fs.readFileSync(sibling, 'utf8'), 'worker');
    assert.equal(listRecoveries(project).length, 1);
  } finally {
    workspace?.discard();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('a Git repository initialized only inside a non-Git worker copy is not silently discarded', () => {
  const root = temporary();
  const workspace = createTaskWorkspace(root);
  execFileSync('git', ['init', '-q', workspace.root]);
  fs.writeFileSync(path.join(workspace.root, 'first.txt'), 'first');
  const merge = workspace.integrate();
  assert.equal(merge.ok, false);
  assert.match(merge.conflicts[0], /history is not transferred/);
  assert.equal(fs.existsSync(path.join(root, '.git')), false);
  assert.equal(fs.existsSync(path.join(merge.workspace, '.git')), true);
  workspace.discard();
});
