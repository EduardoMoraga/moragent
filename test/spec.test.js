import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { dirs } from '../src/core/paths.js';
import { defaultConfig, saveConfig } from '../src/core/config.js';
import { ensureDir, writeText } from '../src/core/fsx.js';
import { newSpec, specState, tasksFromSpec, archiveSpec } from '../src/spec/index.js';

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moragent-spec-'));
  const d = dirs(root);
  for (const k of ['mora', 'specs', 'tasks', 'skills', 'runs', 'context', 'canonical', 'episodic', 'transient']) ensureDir(d[k]);
  saveConfig(root, defaultConfig({ project: 'spec-test', lang: 'es', preset: 'solo' }));
  return root;
}

test('newSpec creates templates and derives phases deterministically', () => {
  const root = project();
  newSpec({ root, slug: 'login', title: 'Login', lang: 'es' });
  const initial = specState(root, 'login');
  assert.equal(initial.phase, 'propose');
  assert.deepEqual(initial.done, ['explore']);

  const dir = path.join(dirs(root).specs, 'login');
  writeText(path.join(dir, 'proposal.md'), '# Propuesta\n\nProblema claro sin pendientes.\n');
  assert.equal(specState(root, 'login').phase, 'spec');

  writeText(path.join(dir, 'spec.md'), '- RF-1: Cuando el usuario envía credenciales válidas, el sistema debe iniciar sesión.\n');
  assert.equal(specState(root, 'login').phase, 'design');

  writeText(path.join(dir, 'design.md'), '# Diseño\n\nMódulo auth con validación.\n');
  assert.equal(specState(root, 'login').phase, 'tasks');

  writeText(path.join(dir, 'tasks.md'), '- [ ] T1: Implementar login @backend — Done when: tests pasan\n');
  assert.equal(specState(root, 'login').phase, 'apply');
  assert.deepEqual(tasksFromSpec(root, 'login'), [{ title: 'Implementar login', role: 'backend', doneWhen: 'tests pasan', done: false }]);

  writeText(path.join(dir, 'tasks.md'), '- [x] T1: Implementar login @backend — Done when: tests pasan\n');
  assert.equal(specState(root, 'login').phase, 'verify');

  writeText(path.join(dir, 'tasks.md'), '- [x] T1: Implementar login @backend — Done when: tests pasan\n\n## Verificación\nOK: npm test.\n');
  assert.equal(specState(root, 'login').phase, 'archive');

  const archived = archiveSpec(root, 'login');
  assert.equal(archived.phase, 'archive');
  assert.ok(archived.done.includes('archive'));
});

test('placeholder task template lines are ignored', () => {
  const root = project();
  newSpec({ root, slug: 'tasks-placeholders', title: 'Tasks placeholders', lang: 'es' });
  const dir = path.join(dirs(root).specs, 'tasks-placeholders');
  writeText(path.join(dir, 'proposal.md'), '# Propuesta\n\nLista.\n');
  writeText(path.join(dir, 'spec.md'), '- RF-1: Cuando ocurre algo, el sistema debe responder.\n');
  writeText(path.join(dir, 'design.md'), '# Diseño\n\nListo.\n');
  writeText(path.join(dir, 'tasks.md'), '- [ ] T1: <título> @backend — Done when: <criterio verificable>\n');

  assert.equal(specState(root, 'tasks-placeholders').phase, 'tasks');
  assert.deepEqual(tasksFromSpec(root, 'tasks-placeholders'), []);

  writeText(path.join(dir, 'tasks.md'), '- [ ] T1: Crear archivo @backend — Done when: archivo existe\n');
  assert.equal(specState(root, 'tasks-placeholders').phase, 'apply');
});

test('CLI spec smoke in initialized temporary project', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moragent-cli-'));
  const bin = path.resolve('bin/mora.js');
  execFileSync(process.execPath, [bin, 'init', '--yes', '--dir', root, '--json'], { encoding: 'utf8' });
  execFileSync(process.execPath, [bin, 'spec', 'new', 'checkout', '--title', 'Checkout', '--json'], { cwd: root, encoding: 'utf8' });
  const status = execFileSync(process.execPath, [bin, 'spec', 'status', 'checkout', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(JSON.parse(status).phase, 'propose');
  const next = execFileSync(process.execPath, [bin, 'spec', 'next', 'checkout'], { cwd: root, encoding: 'utf8' });
  assert.match(next, /proposal\.md/);
});
