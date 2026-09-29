import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig } from '../src/core/config.js';
import { scaffold } from '../src/commands/init.js';
import { createTask, getTask } from '../src/bus/tasks.js';
import done from '../src/commands/done.js';
import block from '../src/commands/block.js';

test('done and block publish terminal status only after their memory note exists', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-task-completion-'));
  const originalRename = fs.renameSync;
  try {
    scaffold(root, defaultConfig({ project: 'completion', preset: 'duo' }));
    const finished = createTask({ root, title: 'Finish', role: 'backend', body: 'Finish it' });
    const blocked = createTask({ root, title: 'Block', role: 'backend', body: 'Block it' });
    const statusAtNotePublish = [];
    fs.renameSync = (source, destination) => {
      if (destination.startsWith(path.join(root, '.moragent', 'memory', 'episodic')) && destination.endsWith('.md')) {
        statusAtNotePublish.push(['done', getTask(root, finished.id).status]);
      }
      if (destination.startsWith(path.join(root, '.moragent', 'memory', 'transient')) && destination.endsWith('.md')) {
        statusAtNotePublish.push(['block', getTask(root, blocked.id).status]);
      }
      return originalRename(source, destination);
    };
    await done.run({ _: [finished.id], flags: { summary: 'Finished work' } }, { root });
    await block.run({ _: [blocked.id], flags: { reason: 'Missing dependency' } }, { root });
    assert.deepEqual(statusAtNotePublish, [['done', 'queued'], ['block', 'queued']]);
    assert.equal(getTask(root, finished.id).status, 'done');
    assert.equal(getTask(root, blocked.id).status, 'blocked');
    assert.ok(fs.readdirSync(path.join(root, '.moragent', 'memory', 'episodic')).some((name) => name.endsWith('.md')));
    assert.ok(fs.readdirSync(path.join(root, '.moragent', 'memory', 'transient')).some((name) => name.endsWith('.md')));
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
