import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const isWin = process.platform === 'win32';

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

export function which(bin) {
  if (!bin) return null;
  if (path.isAbsolute(bin)) return isFile(bin) ? bin : null;
  const exts = isWin && !path.extname(bin) ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, bin + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* keep looking */ }
    }
  }
  return null;
}

// cmd.exe quoting: inside double quotes & | < > ^ are literal; inner quotes are doubled.
export const winQuote = (s) => (/^[\w@+=:,./\\-]+$/.test(String(s)) ? String(s) : `"${String(s).replace(/"/g, '""')}"`);

// On Windows npm CLIs are .cmd shims that only run through cmd.exe. Resolve the binary first:
// real executables run without a shell; shims run through cmd.exe with every argument quoted,
// so user text (task titles, URLs with &) can never become a second command.
function winPlan(cmd, args) {
  if (!isWin) return { file: cmd, argv: args, shell: false };
  const resolved = which(cmd) || cmd;
  if (/\.(cmd|bat)$/i.test(resolved)) return { file: [resolved, ...args].map(winQuote).join(' '), argv: [], shell: true };
  return { file: resolved, argv: args, shell: false };
}

function realRun(cmd, args = [], { cwd, input, timeoutMs = 30000, env } = {}) {
  const plan = winPlan(cmd, args);
  const r = spawnSync(plan.file, plan.argv, {
    cwd, input, timeout: timeoutMs, encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
    shell: plan.shell, maxBuffer: 32 * 1024 * 1024,
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
  const plan = winPlan(cmd, args);
  const child = spawn(plan.file, plan.argv, {
    cwd, detached: true, stdio: ['ignore', fd, fd], shell: plan.shell,
    env: env ? { ...process.env, ...env } : process.env,
  });
  child.unref();
  return { pid: child.pid };
}

// Quote one argument for the platform shell that will run the command string
// (POSIX sh, or cmd.exe on Windows where single quotes are literal characters).
export const shq = (s, platform = process.platform) => (platform === 'win32' ? winQuote(s)
  : /^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
