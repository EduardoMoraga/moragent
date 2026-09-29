import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { openPrivateLog } from './private-log.js';

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
export function spawnPlan(cmd, args = [], platform = process.platform) {
  if (platform !== 'win32') return { file: cmd, argv: args, shell: false };
  const resolved = which(cmd) || cmd;
  if (/\.(cmd|bat)$/i.test(resolved)) return { file: [resolved, ...args].map(winQuote).join(' '), argv: [], shell: true };
  return { file: resolved, argv: args, shell: false };
}

export function terminateTree(child, { force = false, platform = process.platform } = {}) {
  if (!child) return;
  if (platform === 'win32' && child.pid) {
    try {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true,
      });
      killer.on('error', () => { try { child.kill(); } catch { /* already exited */ } });
      killer.unref();
      return;
    } catch { /* fall back to direct child */ }
  }
  if (platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
      return;
    } catch { /* fall back to direct child */ }
  }
  try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch { /* already exited */ }
}

function realRun(cmd, args = [], { cwd, input, timeoutMs = 30000, env } = {}) {
  const plan = spawnPlan(cmd, args);
  const r = spawnSync(plan.file, plan.argv, {
    cwd, input, timeout: timeoutMs, encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
    shell: plan.shell, maxBuffer: 32 * 1024 * 1024,
  });
  return { code: r.status ?? (r.error ? 127 : 1), stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error.message) : '') };
}

function realRunAsync(cmd, args = [], { cwd, timeoutMs = 30000, env } = {}) {
  return new Promise((resolve) => {
    const maxBytes = 1024 * 1024;
    const stdout = [];
    const stderr = [];
    let outBytes = 0;
    let errBytes = 0;
    let child;
    let timer;
    let settled = false;
    const capture = (chunks, chunk, isStdout) => {
      const used = isStdout ? outBytes : errBytes;
      const remaining = Math.max(0, maxBytes - used);
      if (remaining) chunks.push(chunk.subarray(0, remaining));
      if (isStdout) outBytes += chunk.length;
      else errBytes += chunk.length;
    };
    const finish = (code, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: [Buffer.concat(stderr).toString('utf8'), error?.message].filter(Boolean).join('\n'),
      });
    };
    try {
      const plan = spawnPlan(cmd, args);
      child = spawn(plan.file, plan.argv, {
        cwd, env: env ? { ...process.env, ...env } : process.env,
        shell: plan.shell, detached: !isWin, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (chunk) => capture(stdout, chunk, true));
      child.stderr.on('data', (chunk) => capture(stderr, chunk, false));
      child.once('error', (error) => finish(127, error));
      child.once('close', (code) => finish(code ?? 1));
      timer = setTimeout(() => {
        terminateTree(child, { force: true });
        finish(124, new Error(`Timed out after ${timeoutMs} ms`));
      }, timeoutMs);
    } catch (error) {
      finish(127, error);
    }
  });
}

let impl = realRun;
let asyncImpl = realRunAsync;

// Test seam: replace every run() call with a fake. fake(cmd, args, opts) -> { code, stdout, stderr }
export const setExec = (fake) => { impl = fake; asyncImpl = (...args) => Promise.resolve().then(() => fake(...args)); };
export const resetExec = () => { impl = realRun; asyncImpl = realRunAsync; };
export const run = (cmd, args, opts) => impl(cmd, args, opts);
export const runAsync = (cmd, args, opts) => asyncImpl(cmd, args, opts);

export function spawnDetached(cmd, args = [], { cwd, logFile, env } = {}) {
  let fd = 'ignore';
  if (logFile) fd = openPrivateLog(logFile);
  const plan = spawnPlan(cmd, args);
  try {
    const child = spawn(plan.file, plan.argv, {
      cwd, detached: true, stdio: ['ignore', fd, fd], shell: plan.shell,
      env: env ? { ...process.env, ...env } : process.env,
    });
    child.unref();
    return { pid: child.pid };
  } finally {
    // The child has its own descriptor; keeping the parent's open leaks one per task.
    if (typeof fd === 'number') { try { fs.closeSync(fd); } catch { /* child inherited its descriptor */ } }
  }
}

// Quote one argument for the platform shell that will run the command string
// (POSIX sh, or cmd.exe on Windows where single quotes are literal characters).
export const shq = (s, platform = process.platform) => (platform === 'win32' ? winQuote(s)
  : /^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
