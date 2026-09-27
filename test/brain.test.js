import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, loadConfig } from '../src/core/config.js';
import { scaffold } from '../src/commands/init.js';
import { writeJSON, writeText, ensureDir } from '../src/core/fsx.js';
import { setExec, resetExec } from '../src/core/exec.js';
import { findVaults, link, buildHome, sync, resolveGoal } from '../src/brain/obsidian.js';
import brainCmd from '../src/commands/brain.js';
import { add } from '../src/memory/index.js';

const tmp = (prefix = 'mora-brain-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const setupProject = (name = 'demo-project', overrides = {}) => {
  const root = tmp('mora-proj-');
  const base = defaultConfig({ project: name, lang: overrides.lang || 'es', preset: overrides.preset || 'squad' });
  const cfg = { ...base, ...overrides };
  scaffold(root, cfg);
  return { root, cfg };
};

test('brain: findVaults reads obsidian.json from MORAGENT_OBSIDIAN_CONFIG and respects open flag', () => {
  const baseDir = tmp('mora-obs-');
  const vault1 = path.join(baseDir, 'VaultOne');
  const vault2 = path.join(baseDir, 'VaultTwo');
  ensureDir(path.join(vault1, '.obsidian'));
  ensureDir(path.join(vault2, '.obsidian'));

  const configFile = path.join(baseDir, 'obsidian.json');
  writeJSON(configFile, {
    vaults: {
      v1: { path: vault1, ts: 1000, open: false },
      v2: { path: vault2, ts: 2000, open: true },
    },
  });

  const prevEnv = process.env.MORAGENT_OBSIDIAN_CONFIG;
  try {
    process.env.MORAGENT_OBSIDIAN_CONFIG = configFile;
    const vaults = findVaults();
    assert.equal(vaults.length, 2);
    // VaultTwo has open: true, so it must be first
    assert.equal(vaults[0].name, 'VaultTwo');
    assert.equal(vaults[0].open, true);
    assert.equal(vaults[1].name, 'VaultOne');
    assert.equal(vaults[1].open, false);
  } finally {
    process.env.MORAGENT_OBSIDIAN_CONFIG = prevEnv;
  }
});

test('brain: link creates symlink, updates config, and is idempotent', async () => {
  const { root } = setupProject('alpha');
  const vaultDir = tmp('mora-vlt-');
  ensureDir(path.join(vaultDir, '.obsidian'));

  // Link in symlink mode
  const res = await link({ root, vault: vaultDir, folder: 'Projects', mode: 'link' });
  assert.equal(res.mode, 'link');
  assert.ok(fs.existsSync(res.target));
  assert.ok(fs.lstatSync(res.target).isSymbolicLink());

  // Check saved config
  const cfg = loadConfig(root);
  assert.equal(cfg.brain.vault, vaultDir);
  assert.equal(cfg.brain.folder, 'Projects');
  assert.equal(cfg.brain.mode, 'link');

  // Idempotent call must not fail
  const again = await link({ root, vault: vaultDir, folder: 'Projects', mode: 'link' });
  assert.equal(again.target, res.target);
});

test('brain: link fails if target already exists and is not our symlink', async () => {
  const { root } = setupProject('beta');
  const vaultDir = tmp('mora-vlt-');
  ensureDir(path.join(vaultDir, '.obsidian'));

  // Pre-create an ordinary directory where link would go
  const conflict = path.join(vaultDir, 'Moragent', 'beta');
  ensureDir(conflict);
  fs.writeFileSync(path.join(conflict, 'unrelated.txt'), 'content');

  await assert.rejects(
    async () => {
      await link({ root, vault: vaultDir, folder: 'Moragent', mode: 'link' });
    },
    { name: 'MoragentError', code: 'VAULT_TARGET_EXISTS' }
  );
});

test('brain: link in copy mode copies files and registers config', async () => {
  const { root } = setupProject('gamma');
  const vaultDir = tmp('mora-vlt-');
  ensureDir(path.join(vaultDir, '.obsidian'));

  const res = await link({ root, vault: vaultDir, folder: 'Moragent', mode: 'copy' });
  assert.equal(res.mode, 'copy');
  assert.ok(fs.existsSync(res.target));
  assert.ok(fs.existsSync(path.join(res.target, 'moragent.json')));
  assert.ok(!fs.lstatSync(res.target).isSymbolicLink());

  const cfg = loadConfig(root);
  assert.equal(cfg.brain.mode, 'copy');
});

test('brain: buildHome generates Map of Content with crew, tasks, memory, and wikilinks', async () => {
  const { root } = setupProject('my-system');

  // Add sample task
  const taskDir = path.join(root, '.moragent', 'tasks');
  ensureDir(taskDir);
  writeJSON(path.join(taskDir, 'T-0001.json'), {
    id: 'T-0001',
    title: 'Setup authentication system',
    role: 'backend',
    status: 'running',
  });

  // Add sample canonical and episodic memories
  add({ root, tier: 'canonical', kind: 'decision', title: 'Session Cookie Settings', body: 'HttpOnly and SameSite=Lax.' });
  add({ root, tier: 'episodic', kind: 'episode', title: 'Initial Sprint Planning', body: 'Assigned roles.' });

  const homePath = await buildHome(root);
  assert.ok(fs.existsSync(homePath));

  const content = fs.readFileSync(homePath, 'utf8');
  assert.match(content, /# my-system — Mapa de contenido/);
  assert.match(content, /## Objetivo del proyecto/);
  assert.match(content, /Sin objetivo — edita \.moragent\/memory\/canonical\/project\.md/);
  assert.ok(!content.includes('Autonomous agentic development workspace'));
  assert.match(content, /## Equipo/);
  assert.match(content, /Lead/);
  assert.match(content, /Backend/);
  assert.match(content, /## Tareas/);
  assert.match(content, /\[\[tasks\/T-0001\.md\|T-0001\]\]: Setup authentication system/);
  assert.match(content, /## Decisiones canónicas/);
  assert.match(content, /Session Cookie Settings/);
  assert.match(content, /## Episodios recientes/);
  assert.match(content, /Initial Sprint Planning/);
  assert.match(content, /```dataview/);
});

test('brain: sync updates Home.md and recopies in copy mode', async () => {
  const { root } = setupProject('delta');
  const vaultDir = tmp('mora-vlt-');
  ensureDir(path.join(vaultDir, '.obsidian'));

  await link({ root, vault: vaultDir, folder: 'Moragent', mode: 'copy' });

  // Add new decision
  add({ root, tier: 'canonical', title: 'New DB Layer', body: 'PostgreSQL.' });

  const res = await sync(root);
  assert.equal(res.synced, true);

  // Check destination vault copy has the updated Home.md
  const destHome = path.join(vaultDir, 'Moragent', 'delta', 'Home.md');
  assert.ok(fs.existsSync(destHome));
  const content = fs.readFileSync(destHome, 'utf8');
  assert.match(content, /New DB Layer/);
});

test('CLI: brain command link, status, sync, and open with setExec stub', async () => {
  const { root } = setupProject('epsilon');
  const vaultDir = tmp('mora-vlt-');
  ensureDir(path.join(vaultDir, '.obsidian'));

  const ctx = { root, json: true, lang: 'en' };
  let outLogs = [];
  const origOut = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => (typeof chunk === 'string' ? (outLogs.push(chunk), true) : origOut.call(process.stdout, chunk, ...rest));

  let execCalls = [];
  setExec((cmd, args) => {
    execCalls.push({ cmd, args });
    return { code: 0, stdout: '', stderr: '' };
  });

  try {
    // 1. Link via CLI
    await brainCmd.run({ _: ['link'], flags: { vault: vaultDir } }, ctx);
    const linkRes = JSON.parse(outLogs.pop());
    assert.equal(linkRes.ok, true);
    assert.equal(linkRes.vault, vaultDir);

    // 2. Status via CLI
    await brainCmd.run({ _: ['status'], flags: {} }, ctx);
    const statusRes = JSON.parse(outLogs.pop());
    assert.equal(statusRes.linked, true);
    assert.equal(statusRes.vault, vaultDir);
    assert.ok(statusRes.home.endsWith('Home.md'));

    // 3. Sync via CLI
    await brainCmd.run({ _: ['sync'], flags: {} }, ctx);
    const syncRes = JSON.parse(outLogs.pop());
    assert.equal(syncRes.ok, true);
    assert.equal(syncRes.synced, true);

    // 4. Open via CLI (should trigger exec)
    await brainCmd.run({ _: ['open'], flags: {} }, ctx);
    const openRes = JSON.parse(outLogs.pop());
    assert.equal(openRes.ok, true);
    assert.match(openRes.uri, /^obsidian:\/\/open\?path=/);
    assert.equal(execCalls.length, 1);
    // Windows opens through cmd.exe /c start "" <uri>; the URI is always the last argument.
    assert.match(execCalls[0].args.at(-1), /^obsidian:\/\/open\?path=/);
  } finally {
    process.stdout.write = origOut;
    resetExec();
  }
});

test('CLI: brain status respects --lang en printing English counters and labels', async () => {
  const { root } = setupProject('omega-en');
  const vaultDir = tmp('mora-vlt-');
  ensureDir(path.join(vaultDir, '.obsidian'));

  // Link to vault
  await link({ root, vault: vaultDir, folder: 'Moragent', mode: 'link' });

  // Add sample memories (2 canonical, 1 episodic, 0 transient)
  add({ root, tier: 'canonical', title: 'Architecture Decision 1', body: 'Use microservices.' });
  add({ root, tier: 'canonical', title: 'Architecture Decision 2', body: 'Use JWT.' });
  add({ root, tier: 'episodic', title: 'Sprint 1 Review', body: 'Completed auth.' });

  // Test in English
  const ctxEn = { root, json: false, lang: 'en' };
  let logsEn = [];
  const origOut = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => (typeof chunk === 'string' ? (logsEn.push(chunk), true) : origOut.call(process.stdout, chunk, ...rest));

  try {
    await brainCmd.run({ _: ['status'], flags: { lang: 'en' } }, ctxEn);
  } finally {
    process.stdout.write = origOut;
  }

  const outputEn = logsEn.join('');
  // Check English headers and labels
  assert.match(outputEn, /Obsidian Second Brain status:/);
  assert.match(outputEn, /Linked:.*Yes/);
  assert.match(outputEn, /Memory:.*3 canonical.*1 episodic.*0 transient/);
  assert.ok(!outputEn.includes('canónicas'));
  assert.ok(!outputEn.includes('episódicas'));
  assert.ok(!outputEn.includes('transitorias'));

  // Test in Spanish
  const ctxEs = { root, json: false, lang: 'es' };
  let logsEs = [];
  process.stdout.write = (chunk, ...rest) => (typeof chunk === 'string' ? (logsEs.push(chunk), true) : origOut.call(process.stdout, chunk, ...rest));

  try {
    await brainCmd.run({ _: ['status'], flags: { lang: 'es' } }, ctxEs);
  } finally {
    process.stdout.write = origOut;
  }

  const outputEs = logsEs.join('');
  assert.match(outputEs, /Estado del Obsidian Second Brain:/);
  assert.match(outputEs, /Enlazado:.*Sí/);
  assert.match(outputEs, /Memoria:.*3 canónicas.*1 episódica.*0 transitorias/);
});

test('brain: buildHome in English uses cfg.goal and generates English section titles', async () => {
  const { root } = setupProject('en-system', {
    lang: 'en',
    goal: 'Build an autonomous multi-agent swarm',
  });

  const homePath = await buildHome(root);
  assert.ok(fs.existsSync(homePath));
  const content = fs.readFileSync(homePath, 'utf8');

  // English header and goal
  assert.match(content, /# en-system — Map of Content/);
  assert.match(content, /> Moragent Obsidian Second Brain — Generated/);
  assert.match(content, /## Project Goal/);
  assert.match(content, /Build an autonomous multi-agent swarm/);
  assert.ok(!content.includes('Autonomous agentic development workspace'));

  // English section titles and empty states
  assert.match(content, /## Crew/);
  assert.match(content, /## Specs/);
  assert.match(content, /_No specs defined yet\._/);
  assert.match(content, /## Tasks/);
  assert.match(content, /_No tasks registered yet\._/);
  assert.match(content, /## Canonical Decisions/);
  assert.match(content, /_No canonical decisions recorded yet\._/);
  assert.match(content, /## Recent Episodes/);
  assert.match(content, /_No recent episodes\._/);

  // Assert no Spanish sections
  assert.ok(!content.includes('Mapa de contenido'));
  assert.ok(!content.includes('## Objetivo del proyecto'));
  assert.ok(!content.includes('## Equipo'));
  assert.ok(!content.includes('## Especificaciones'));
  assert.ok(!content.includes('## Tareas'));
  assert.ok(!content.includes('## Decisiones canónicas'));
  assert.ok(!content.includes('## Episodios recientes'));
});

test('brain: buildHome resolves goal from project.md body when cfg.goal is not set', async () => {
  const { root } = setupProject('es-custom-goal', { lang: 'es' });

  // Overwrite project.md with a non-placeholder custom goal
  const projectMdPath = path.join(root, '.moragent', 'memory', 'canonical', 'project.md');
  writeText(
    projectMdPath,
    `---
id: project
tier: canonical
kind: fact
title: es-custom-goal
tags: [project]
links: []
by: moragent
created: 2026-09-27T00:00:00Z
---
Desarrollar una plataforma distribuida de trading algorítmico en tiempo real.

Creado con \`mora init\` el 2026-09-27 — preset \`squad\`.
`
  );

  const homePath = await buildHome(root);
  assert.ok(fs.existsSync(homePath));
  const content = fs.readFileSync(homePath, 'utf8');

  assert.match(content, /## Objetivo del proyecto/);
  assert.match(content, /Desarrollar una plataforma distribuida de trading algorítmico en tiempo real\./);
  assert.ok(!content.includes('Sin objetivo — edita'));
  assert.ok(!content.includes('Autonomous agentic development workspace'));
});

test('brain: resolveGoal and buildHome show placeholder fallback in English and Spanish', async () => {
  // English with placeholder
  const { root: rootEn, cfg: cfgEn } = setupProject('en-default', { lang: 'en' });
  const goalEn = resolveGoal(rootEn, cfgEn);
  assert.equal(goalEn, 'No goal yet — edit .moragent/memory/canonical/project.md');

  const homePathEn = await buildHome(rootEn);
  const contentEn = fs.readFileSync(homePathEn, 'utf8');
  assert.match(contentEn, /## Project Goal/);
  assert.match(contentEn, /No goal yet — edit \.moragent\/memory\/canonical\/project\.md/);

  // Spanish with placeholder
  const { root: rootEs, cfg: cfgEs } = setupProject('es-default', { lang: 'es' });
  const goalEs = resolveGoal(rootEs, cfgEs);
  assert.equal(goalEs, 'Sin objetivo — edita .moragent/memory/canonical/project.md');

  const homePathEs = await buildHome(rootEs);
  const contentEs = fs.readFileSync(homePathEs, 'utf8');
  assert.match(contentEs, /## Objetivo del proyecto/);
  assert.match(contentEs, /Sin objetivo — edita \.moragent\/memory\/canonical\/project\.md/);
});


