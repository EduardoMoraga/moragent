import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mora.js');

function run(home, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args, '--json'], { env: { ...process.env, MORAGENT_HOME: home, NO_COLOR: '1' } });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${args.join(' ')}: ${stderr}`)));
  });
}

test('concurrent project and remote registrations retain every entry', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-registry-concurrency-'));
  const home = path.join(temp, 'home');
  try {
    const jobs = [];
    for (let i = 0; i < 12; i++) {
      const root = path.join(temp, `project-${i}`);
      fs.mkdirSync(root);
      jobs.push(run(home, ['project', 'add', root]));
      jobs.push(run(home, ['remote', 'add', `host${i}`, '/srv/work']));
    }
    await Promise.all(jobs);
    const projects = JSON.parse(fs.readFileSync(path.join(home, 'projects.json'), 'utf8')).projects;
    const remotes = JSON.parse(fs.readFileSync(path.join(home, 'remotes.json'), 'utf8')).remotes;
    assert.equal(projects.length, 12);
    assert.equal(remotes.length, 12);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
