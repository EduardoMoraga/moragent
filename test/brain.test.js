import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, loadConfig } from '../src/core/config.js';
import { scaffold } from '../src/commands/init.js';
import { writeJSON, ensureDir } from '../src/core/fsx.js';
import { setExec, resetExec } from '../src/core/exec.js';
import { findVaults, link, buildHome, sync } from '../src/brain/obsidian.js';
import brainCmd from '../src/commands/brain.js';
import { add } from '../src/memory/index.js';

const tmp = (prefix = 'mora-brain-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const setupProject = (name = 'demo-project') => {
  const root = tmp('mora-proj-');
  const cfg = defaultConfig({ project: name, lang: 'es', preset: 'squad' });
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
  assert.match(content, /# my-system — Map of Content/);
  assert.match(content, /## Project Goal/);
  assert.match(content, /## Crew/);
  assert.match(content, /Lead/);
  assert.match(content, /Backend/);
  assert.match(content, /## Tasks/);
  assert.match(content, /\[\[tasks\/T-0001\.md\|T-0001\]\]: Setup authentication system/);
  assert.match(content, /## Canonical Decisions/);
  assert.match(content, /Session Cookie Settings/);
  assert.match(content, /## Recent Episodes/);
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
  process.stdout.write = (chunk) => { outLogs.push(chunk); return true; };

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
    assert.match(execCalls[0].args[0], /^obsidian:\/\/open\?path=/);
  } finally {
    process.stdout.write = origOut;
    resetExec();
  }
});
