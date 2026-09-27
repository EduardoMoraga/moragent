#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'templates', 'skills');
const dst = path.join(root, 'plugin', 'skills');

fs.rmSync(dst, { recursive: true, force: true });
copy(src, dst);
console.log(`Built plugin skills: ${path.relative(root, dst)}`);

function copy(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, ent.name);
    const d = path.join(to, ent.name);
    if (ent.isDirectory()) copy(s, d);
    else fs.copyFileSync(s, d);
  }
}
