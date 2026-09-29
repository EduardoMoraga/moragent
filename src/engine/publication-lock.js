import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const RETRY_MS = 50;
const TIMEOUT_MS = 30_000;
const pauseWord = new Int32Array(new SharedArrayBuffer(4));

function locations(source) {
  const runs = path.join(source, '.moragent', 'runs');
  fs.mkdirSync(runs, { recursive: true });
  return { lock: path.join(runs, '.publication-lock'), reclaim: path.join(runs, '.publication-reclaim') };
}

function ownerOf(directory) {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'), 'utf8'));
    if (Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.token === 'string') return owner;
  } catch { /* an incomplete lock is not safe to steal automatically */ }
  return null;
}

function dead(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

function reclaimDeadOwner({ lock, reclaim }) {
  const owner = ownerOf(lock);
  if (!owner || !dead(owner.pid)) return;
  try { fs.mkdirSync(reclaim); }
  catch (error) { if (error.code === 'EEXIST') return; throw error; }
  try {
    const current = ownerOf(lock);
    if (!current || current.token !== owner.token || !dead(current.pid)) return;
    const stale = `${lock}.stale-${crypto.randomUUID()}`;
    try { fs.renameSync(lock, stale); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    try {
      fs.unlinkSync(path.join(stale, 'owner.json'));
      fs.rmdirSync(stale);
    } catch { /* leave an unexpected stale directory for manual inspection */ }
  } finally { fs.rmdirSync(reclaim); }
}

function tryAcquire(paths) {
  if (fs.existsSync(paths.reclaim)) return null;
  try { fs.mkdirSync(paths.lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    reclaimDeadOwner(paths);
    return null;
  }
  const token = crypto.randomUUID();
  try { fs.writeFileSync(path.join(paths.lock, 'owner.json'), JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 }); }
  catch (error) { fs.rmdirSync(paths.lock); throw error; }
  return () => {
    if (ownerOf(paths.lock)?.token !== token) throw new Error(`publication lock ownership changed: ${paths.lock}`);
    fs.unlinkSync(path.join(paths.lock, 'owner.json'));
    fs.rmdirSync(paths.lock);
  };
}

function timeoutError(paths) {
  const owner = ownerOf(paths.lock);
  return new Error(`timed out waiting for publication lock ${paths.lock}${owner ? ` (PID ${owner.pid})` : ''}; inspect the lock before retrying`);
}

export async function withPublicationLock(source, action, { signal } = {}) {
  const paths = locations(source);
  const deadline = Date.now() + TIMEOUT_MS;
  let release;
  while (!release) {
    if (signal?.aborted) throw new Error('cancelled before publication');
    release = tryAcquire(paths);
    if (release) break;
    if (Date.now() >= deadline) throw timeoutError(paths);
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
  try { return await action(); }
  finally { release(); }
}

export function withPublicationLockSync(source, action, shouldCancel = () => false) {
  const paths = locations(source);
  const deadline = Date.now() + TIMEOUT_MS;
  let release;
  while (!release) {
    if (shouldCancel()) throw new Error('cancelled before publication');
    release = tryAcquire(paths);
    if (release) break;
    if (Date.now() >= deadline) throw timeoutError(paths);
    Atomics.wait(pauseWord, 0, 0, RETRY_MS);
  }
  try { return action(); }
  finally { release(); }
}
