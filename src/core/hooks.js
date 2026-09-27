import path from 'node:path';
import { readJSON, writeJSON, readText, writeText } from './fsx.js';
import { which } from './exec.js';

// The hook command must work even when MORAGENT was only ever run through npx.
export const moraCommand = () => (which('mora') ? 'mora' : 'npx -y moragent');

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

// Codex reads a top-level `notify = [...]` from .codex/config.toml (project, when trusted) or ~/.codex.
// We only add it when no notify is configured, so we never override the user's own notifier.
export function installCodexHook(root, { dryRun = false } = {}) {
  const p = path.join(root, '.codex', 'config.toml');
  const before = readText(p);
  if (/^\s*notify\s*=/m.test(before)) return null;
  const argv = moraCommand() === 'mora'
    ? ['mora', 'memory', 'capture', '--from', 'codex']
    : ['npx', '-y', 'moragent', 'memory', 'capture', '--from', 'codex'];
  const line = `# MORAGENT: store a session note after each Codex turn\nnotify = [${argv.map((a) => JSON.stringify(a)).join(', ')}]\n`;
  // notify is a top-level key: it must precede any [table] header.
  const firstTable = before.search(/^\s*\[/m);
  const next = firstTable < 0 ? (before ? before.replace(/\n*$/, '\n\n') : '') + line : before.slice(0, firstTable) + line + '\n' + before.slice(firstTable);
  if (!dryRun) writeText(p, next);
  return p;
}

export function installHooks(root, clis, opts = {}) {
  const written = [];
  if (clis.includes('claude')) { const p = installClaudeHook(root, opts); if (p) written.push(p); }
  if (clis.includes('codex')) { const p = installCodexHook(root, opts); if (p) written.push(p); }
  return written;
}
