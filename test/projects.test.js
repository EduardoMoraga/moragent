import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listProjects, projectsFile, registerProject, resolveProject } from '../src/projects/registry.js';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mora.js');

function fixture(fn) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-projects-'));
  const previous = process.env.MORAGENT_HOME;
  process.env.MORAGENT_HOME = path.join(temp, 'home');
  try { return fn(temp); }
  finally {
    if (previous === undefined) delete process.env.MORAGENT_HOME;
    else process.env.MORAGENT_HOME = previous;
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function run(...args) {
  return JSON.parse(execFileSync(process.execPath, [cli, 'project', ...args, '--json'], {
    encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
  }));
}

test('registers an ordinary directory without changing its contents and keeps its identity', () => fixture((temp) => {
  const root = path.join(temp, "notes and ideas");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'draft.txt'), 'keep me');
  const canonicalRoot = fs.realpathSync(root);
  const first = run('add', root, '--name', 'Research');
  assert.equal(first.created, true);
  assert.equal(first.project.kind, 'directory');
  assert.equal(first.project.name, 'Research');
  assert.match(first.project.projectId, /^p-[0-9a-f]{16}$/);
  assert.deepEqual(fs.readdirSync(root), ['draft.txt']);
  const second = run('add', root, '--name', 'A different name');
  assert.equal(second.created, false);
  assert.deepEqual(second.project, first.project);
  assert.equal(run('list').projects.length, 1);
  const opened = run('open', first.project.projectId);
  assert.equal(opened.project.root, canonicalRoot);
  assert.equal(opened.command, `cd '${canonicalRoot}'`);
  assert.equal(fs.readFileSync(path.join(root, 'draft.txt'), 'utf8'), 'keep me');
  assert.ok(!fs.existsSync(path.join(root, '.moragent')));
  assert.equal(projectsFile(), path.join(temp, 'home', 'projects.json'));
}));

test('recognizes a Git repository and resolves its nested directory without initializing MORAGENT', () => fixture((temp) => {
  const repo = path.join(temp, 'repo');
  const nested = path.join(repo, 'docs');
  fs.mkdirSync(nested, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  const added = run('add', nested);
  assert.equal(added.project.kind, 'git');
  assert.equal(added.project.root, fs.realpathSync(nested));
  assert.equal(added.project.gitRoot, fs.realpathSync(repo));
  assert.equal(resolveProject(nested).projectId, added.project.projectId);
  assert.ok(!fs.existsSync(path.join(nested, '.moragent')));
  assert.equal(listProjects().length, 1);
}));

test('refuses invalid registry data without overwriting it', () => fixture((temp) => {
  const root = path.join(temp, 'work');
  fs.mkdirSync(root);
  fs.mkdirSync(path.dirname(projectsFile()), { recursive: true });
  fs.writeFileSync(projectsFile(), '{invalid');
  assert.throws(() => registerProject(root), { code: 'BAD_PROJECT_REGISTRY' });
  assert.equal(fs.readFileSync(projectsFile(), 'utf8'), '{invalid');
  assert.deepEqual(fs.readdirSync(root), []);
}));

test('open shell command quotes apostrophes in a project path', () => fixture((temp) => {
  const root = path.join(temp, "person's notes");
  fs.mkdirSync(root);
  const { project } = registerProject(root);
  const opened = run('open', project.projectId);
  assert.equal(opened.command, `cd '${fs.realpathSync(root).replaceAll("'", "'\\''")}'`);
}));

test('open --chat selects the registered directory and requires a terminal', () => fixture((temp) => {
  const root = path.join(temp, 'new project');
  fs.mkdirSync(root);
  const { project } = registerProject(root);
  assert.throws(() => execFileSync(process.execPath, [cli, 'project', 'open', project.projectId, '--chat'], {
    encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  }), (error) => error.status === 1 && error.stderr.includes('terminal interactiva'));
  assert.deepEqual(fs.readdirSync(root), []);
}));
