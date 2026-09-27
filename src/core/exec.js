import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const isWin = process.platform === 'win32';

export function which(bin) {
  const exts = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, bin + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* keep looking */ }
    }
  }
  return null;
}

function realRun(cmd, args = [], { cwd, input, timeoutMs = 30000, env } = {}) {
  const r = spawnSync(cmd, args, {
    cwd, input, timeout: timeoutMs, encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
    shell: isWin, maxBuffer: 32 * 1024 * 1024,
  });
  return { code: r.status ?? (r.error ? 127 : 1), stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error.message) : '') };
}

let impl = realRun;

// Test seam: replace every run() call with a fake. fake(cmd, args, opts) -> { code, stdout, stderr }
export const setExec = (fake) => { impl = fake; };
export const resetExec = () => { impl = realRun; };
export const run = (cmd, args, opts) => impl(cmd, args, opts);

export function spawnDetached(cmd, args = [], { cwd, logFile, env } = {}) {
  let fd = 'ignore';
  if (logFile) { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fd = fs.openSync(logFile, 'a'); }
  const child = spawn(cmd, args, {
    cwd, detached: true, stdio: ['ignore', fd, fd], shell: isWin,
    env: env ? { ...process.env, ...env } : process.env,
  });
  child.unref();
  return { pid: child.pid };
}

// Quote one argument for a POSIX shell command string.
export const shq = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
