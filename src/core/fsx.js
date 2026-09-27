import fs from 'node:fs';
import path from 'node:path';

export const exists = (p) => fs.existsSync(p);

export function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }

export function readText(p, fallback = '') {
  try { return fs.readFileSync(p, 'utf8'); } catch { return fallback; }
}

// Atomic write: temp file in the same dir, then rename.
export function writeText(p, s) {
  ensureDir(path.dirname(p));
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, s);
  fs.renameSync(tmp, p);
  return p;
}

export function readJSON(p, fallback = null) {
  const raw = readText(p, null);
  if (raw === null) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

export const writeJSON = (p, obj) => writeText(p, JSON.stringify(obj, null, 2) + '\n');

export function writeIfAbsent(p, s) {
  if (exists(p)) return false;
  writeText(p, s);
  return true;
}

// Replace (or append) the block between <!-- moragent:<id>:start --> and <!-- moragent:<id>:end -->.
export function upsertBlock(text, id, body) {
  const start = `<!-- moragent:${id}:start -->`;
  const end = `<!-- moragent:${id}:end -->`;
  const block = `${start}\n${body.trim()}\n${end}`;
  const i = text.indexOf(start);
  const j = text.indexOf(end);
  if (i >= 0 && j > i) return text.slice(0, i) + block + text.slice(j + end.length);
  const sep = text.length === 0 ? '' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return text + sep + block + '\n';
}

export function slugify(s) {
  return String(s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'item';
}

const pad = (n) => String(n).padStart(2, '0');

export function today(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Local time ISO with offset, e.g. 2026-09-27T14:03:00-03:00
export function nowISO(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${today(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

export function listFiles(dir, { ext = '.md', recursive = false } = {}) {
  if (!exists(dir)) return [];
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) { if (recursive) out.push(...listFiles(p, { ext, recursive })); }
    else if (!ext || ent.name.endsWith(ext)) out.push(p);
  }
  return out.sort();
}

// Recursive copy of a directory (files only overwrite when content differs). Returns written paths.
export function copyDir(src, dst) {
  const written = [];
  if (!exists(src)) return written;
  ensureDir(dst);
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) written.push(...copyDir(s, d));
    else {
      const body = fs.readFileSync(s);
      if (!exists(d) || !fs.readFileSync(d).equals(body)) { ensureDir(path.dirname(d)); fs.writeFileSync(d, body); written.push(d); }
    }
  }
  return written;
}
