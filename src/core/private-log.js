import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_PRIVATE_LOG_MAX_BYTES = 5 * 1024 * 1024;

// Provider traces can contain prompts, code and tool arguments. Open only a
// regular file, reject final-path symlinks, and tighten older logs on append.
export function openPrivateLog(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('log path is a symlink');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const flags = fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT
    | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  const fd = fs.openSync(file, flags, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink > 1) throw new Error('log path is not a private regular file');
    if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
    return fd;
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* preserve the original failure */ }
    throw error;
  }
}

export function writePrivateLog(fd, data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error('could not write provider log');
    offset += written;
  }
}

export function writeBoundedPrivateLog(fd, data, maxBytes = DEFAULT_PRIVATE_LOG_MAX_BYTES, { lineDelimited = false } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 128) throw new RangeError('private log limit must be at least 128 bytes');
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  if (!bytes.length) return;
  const size = fs.fstatSync(fd).size;
  if (size + bytes.length <= maxBytes) {
    writePrivateLog(fd, bytes);
    return;
  }

  const marker = Buffer.from('\n[… earlier log data omitted; recent output follows …]\n');
  const tailLimit = Math.max(0, maxBytes - marker.length - bytes.length);
  const priorSize = Math.min(size, tailLimit);
  const prior = Buffer.alloc(priorSize);
  if (priorSize) fs.readSync(fd, prior, 0, priorSize, size - priorSize);
  let priorStart = 0;
  if (lineDelimited && priorSize) {
    const newline = prior.indexOf(0x0a);
    priorStart = newline < 0 ? priorSize : newline + 1;
  }
  const previousTail = prior.subarray(priorStart);
  const currentLimit = maxBytes - marker.length - previousTail.length;
  let start = Math.max(0, bytes.length - currentLimit);
  if (lineDelimited && start > 0) {
    const newline = bytes.indexOf(0x0a, start);
    start = newline < 0 ? bytes.length : newline + 1;
  }
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  const tail = bytes.subarray(start);
  fs.ftruncateSync(fd, 0);
  writePrivateLog(fd, marker.subarray(0, Math.min(marker.length, maxBytes - tail.length - previousTail.length)));
  writePrivateLog(fd, previousTail);
  writePrivateLog(fd, tail);
}
