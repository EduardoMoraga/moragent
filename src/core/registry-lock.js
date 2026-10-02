import fs from 'node:fs';
import path from 'node:path';
import { MoragentError } from './errors.js';

const pause = new Int32Array(new SharedArrayBuffer(4));

// Registries are shared by independent CLI processes. Keep the read/modify/
// write cycle under one lock; writeJSON already replaces the file atomically.
export function withRegistryLock(file, action) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const until = Date.now() + 5000;
  let fd;
  while (fd === undefined) {
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
      try { fs.writeFileSync(fd, String(process.pid)); }
      catch (error) { fs.closeSync(fd); fs.unlinkSync(lock); throw error; }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const owner = Number(fs.readFileSync(lock, 'utf8'));
        if (Number.isSafeInteger(owner) && owner > 0) {
          try { process.kill(owner, 0); }
          catch (probe) { if (probe?.code === 'ESRCH') { fs.unlinkSync(lock); continue; } }
        } else if (Date.now() - fs.statSync(lock).mtimeMs > 30000) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch (readError) { if (readError?.code !== 'ENOENT') throw readError; }
      if (Date.now() >= until) throw new MoragentError('REGISTRY_BUSY', `Registry is busy: ${file}`);
      Atomics.wait(pause, 0, 0, 20);
    }
  }
  try { return action(); }
  finally {
    fs.closeSync(fd);
    try { if (fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock); } catch { /* removed */ }
  }
}
