import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawnPlan } from '../src/core/exec.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'moragent-pack-smoke-'));
const isWindows = process.platform === 'win32';

function run(command, args = [], { cwd = root, env = process.env, allowFailure = false } = {}) {
  const plan = spawnPlan(command, args);
  const result = spawnSync(plan.file, plan.argv, {
    cwd, env, shell: plan.shell, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || (!allowFailure && result.status !== 0)) {
    const detail = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n').slice(-4000);
    throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? 'spawn'}): ${detail}`);
  }
  return result;
}

function assertEntry(entries, name) {
  if (!entries.has(`package/${name}`)) throw new Error(`Missing from tarball: ${name}`);
}

function fakeCli(directory, name) {
  const file = path.join(directory, `${name}${isWindows ? '.cmd' : ''}`);
  const content = isWindows
    ? `@echo off\r\nif "%~1"=="--version" (echo ${name} 0.0.0 & exit /b 0)\r\nexit /b 0\r\n`
    : `#!/bin/sh\n[ "\${1:-}" = "--version" ] && { echo "${name} 0.0.0"; exit 0; }\nexit 0\n`;
  fs.writeFileSync(file, content);
  if (!isWindows) fs.chmodSync(file, 0o755);
}

try {
  const packed = run('npm', ['pack', '--silent', '--pack-destination', temporary]);
  const archive = path.join(temporary, packed.stdout.trim().split(/\r?\n/).at(-1));
  if (!fs.existsSync(archive)) throw new Error(`npm pack did not create ${archive}`);
  const entries = new Set(run('tar', ['-tf', archive]).stdout.split(/\r?\n/).filter(Boolean));
  for (const name of [
    'bin/mora.js', 'src/cli.js', 'src/engine/workspace.js',
    'src/engine/workspace-async.js', 'src/engine/workspace-worker.js', 'templates/spec/es/proposal.md',
    'templates/skills/moragent/SKILL.md', 'plugin/skills/moragent/SKILL.md',
    'install.sh', 'install.ps1', 'docs/ARCHITECTURE.md', 'docs/demo.tape',
    'examples/quickstart/README.md', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json',
  ]) assertEntry(entries, name);
  for (const entry of entries) {
    if (/^package\/(?:\.crew|test|\.moragent|node_modules)(?:\/|$)/.test(entry) || entry.endsWith('.tgz')) {
      throw new Error(`Unexpected tarball entry: ${entry}`);
    }
  }

  const prefix = path.join(temporary, 'prefix');
  run('npm', ['install', '-g', '--no-audit', '--no-fund', '--prefix', prefix, archive]);
  const binaryDirectory = isWindows ? prefix : path.join(prefix, 'bin');
  const mora = path.join(binaryDirectory, `mora${isWindows ? '.cmd' : ''}`);
  if (!fs.existsSync(mora)) throw new Error(`Installed bin shim missing: ${mora}`);
  const fakeDirectory = path.join(temporary, 'fake-bin');
  fs.mkdirSync(fakeDirectory);
  fakeCli(fakeDirectory, 'codex');
  fakeCli(fakeDirectory, 'claude');
  const env = { ...process.env, PATH: [binaryDirectory, fakeDirectory, process.env.PATH || ''].join(path.delimiter) };

  const app = path.join(temporary, 'app');
  fs.mkdirSync(app);
  run(mora, ['--version'], { cwd: app, env });
  run(mora, ['init', '--yes', '--preset', 'trio'], { cwd: app, env });
  const claudeSettings = JSON.parse(fs.readFileSync(path.join(app, '.claude', 'settings.json'), 'utf8'));
  if (!JSON.stringify(claudeSettings).includes('memory capture --from claude')) throw new Error('Claude memory hook missing');
  if (fs.existsSync(path.join(app, '.codex', 'config.toml'))) throw new Error('Unexpected project Codex config');
  const doctor = run(mora, ['doctor', '--json'], { cwd: app, env, allowFailure: true });
  JSON.parse(doctor.stdout);
  run(mora, ['spec', 'new', 'x'], { cwd: app, env });
  run(mora, ['memory', 'add', 'a', '--body', 'b'], { cwd: app, env });
  run(mora, ['board'], { cwd: app, env });
  run(mora, ['help'], { cwd: app, env });
  run(mora, ['resend', '--help'], { cwd: app, env });
  run(mora, ['sync', '--hooks', '--dry-run'], { cwd: app, env });
  const dryRun = JSON.parse(run(mora, ['up', '--dry-run', '--json'], { cwd: app, env }).stdout);
  if (JSON.stringify(dryRun).includes('.moragent/runs/bin')) throw new Error('Dry run created a run shim');
  if (fs.existsSync(path.join(app, '.moragent', 'runs', 'bin'))) throw new Error('Dry run wrote a run shim');

  const localApp = path.join(temporary, 'local-app');
  fs.mkdirSync(localApp);
  run('npm', ['install', '--no-audit', '--no-fund', archive], { cwd: localApp, env });
  const localMora = path.join(localApp, 'node_modules', '.bin', `mora${isWindows ? '.cmd' : ''}`);
  run(localMora, ['--version'], { cwd: localApp, env });
  run(localMora, ['init', '--yes'], { cwd: localApp, env });
  if (!fs.existsSync(path.join(localApp, '.moragent', 'moragent.json'))) throw new Error('Local tarball install did not scaffold a project');

  process.stdout.write(`doctor exit code: ${doctor.status}\npack smoke ok: ${path.basename(archive)}\n`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
