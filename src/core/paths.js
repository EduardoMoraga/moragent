import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exists } from './fsx.js';
import { MoragentError } from './errors.js';

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TEMPLATES = path.join(PKG_ROOT, 'templates');

// Walks up like git does, but never past the enclosing git repository: a repo without its own
// .moragent/ must not silently join a project that lives above it (e.g. a workspace root).
export function findRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (exists(path.join(dir, '.moragent', 'moragent.json'))) return dir;
    if (exists(path.join(dir, '.git'))) return null;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function requireRoot(start) {
  const root = findRoot(start);
  if (!root) {
    throw new MoragentError('NO_PROJECT',
      'No MORAGENT project here / No hay proyecto MORAGENT aquí',
      'mora init');
  }
  return root;
}

export function dirs(root) {
  const mora = path.join(root, '.moragent');
  const memory = path.join(mora, 'memory');
  return {
    root, mora, memory,
    canonical: path.join(memory, 'canonical'),
    episodic: path.join(memory, 'episodic'),
    transient: path.join(memory, 'transient'),
    specs: path.join(mora, 'specs'),
    tasks: path.join(mora, 'tasks'),
    skills: path.join(mora, 'skills'),
    context: path.join(mora, 'context'),
    runs: path.join(mora, 'runs'),
    config: path.join(mora, 'moragent.json'),
  };
}
