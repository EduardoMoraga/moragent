import os from 'node:os';
import path from 'node:path';
import { readJSON, writeJSON, readText, writeText } from './fsx.js';
import { which, shq } from './exec.js';
import { PKG_ROOT } from './paths.js';

// How another process (an agent pane, a hook) should call this exact installation. `mora` when it
// is on PATH, otherwise the absolute entry point of the running package (works for npx and clones).
export const moraArgv = () => (which('mora') ? ['mora'] : [process.execPath, path.join(PKG_ROOT, 'bin', 'mora.js')]);
export const moraCommand = () => moraArgv().map(shq).join(' ');

const CAPTURE_MARK = 'memory capture --from';

// Merge a SessionEnd hook into .claude/settings.json without touching the user's other hooks.
export function installClaudeHook(root, { dryRun = false } = {}) {
  const p = path.join(root, '.claude', 'settings.json');
  const settings = readJSON(p, {}) || {};
  const list = (settings.hooks ??= {}).SessionEnd ??= [];
  const present = list.some((m) => (m.hooks || []).some((h) => String(h.command || '').includes(CAPTURE_MARK)));
  if (present) return null;
  list.push({ hooks: [{ type: 'command', command: `${moraCommand()} memory capture --from claude` }] });
  if (!dryRun) writeJSON(p, settings);
  return p;
}

// Codex ignores `notify` in project-local .codex/config.toml (it warns on every launch), so the
// hook only works in the user-level file. That is global state: install it only on explicit
// request, and never when the user already has a notifier. The capture command is a silent no-op
// outside MORAGENT projects, so a global notify is harmless elsewhere.
export const codexUserConfig = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');

export function installCodexHook(file = codexUserConfig(), { dryRun = false } = {}) {
  const p = file;
  const before = readText(p);
  if (/^\s*notify\s*=/m.test(before)) return null;
  const argv = [...moraArgv(), 'memory', 'capture', '--from', 'codex'];
  const line = `# MORAGENT: store a session note after each Codex turn\nnotify = [${argv.map((a) => JSON.stringify(a)).join(', ')}]\n`;
  // notify is a top-level key: it must precede any [table] header.
  const firstTable = before.search(/^\s*\[/m);
  const next = firstTable < 0 ? (before ? before.replace(/\n*$/, '\n\n') : '') + line : before.slice(0, firstTable) + line + '\n' + before.slice(firstTable);
  if (!dryRun) writeText(p, next);
  return p;
}

// Project-scoped hooks only, unless `global` is set (Codex user config).
export function installHooks(root, clis, { global = false, ...opts } = {}) {
  const written = [];
  if (clis.includes('claude')) { const p = installClaudeHook(root, opts); if (p) written.push(p); }
  if (global && clis.includes('codex')) { const p = installCodexHook(codexUserConfig(), opts); if (p) written.push(p); }
  return written;
}
