#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const mora = process.env.MORAGENT_BIN || path.join(repo, 'bin', 'mora.js');
const prompt = process.argv.slice(2).join(' ');
const match = prompt.match(/\.moragent[\/]tasks[\/](T-\d{4})\.md/i);

if (!match) {
  process.stderr.write(`fake-agent: no task envelope in prompt: ${prompt}\n`);
  process.exit(2);
}

const id = match[1].toUpperCase();
const envelopePath = path.join(process.cwd(), '.moragent', 'tasks', `${id}.md`);
const envelope = fs.readFileSync(envelopePath, 'utf8');

if (/\bFAIL\b/.test(envelope)) {
  execFileSync(process.execPath, [mora, 'block', id, '--reason', 'fake fail'], { cwd: process.cwd(), stdio: 'inherit' });
  process.exit(0);
}

const outDir = path.join(process.cwd(), 'out');
fs.mkdirSync(outDir, { recursive: true });
const rel = path.join('out', `${id}.txt`);
fs.writeFileSync(path.join(process.cwd(), rel), `fake ok ${id}\n`);
execFileSync(process.execPath, [mora, 'done', id, '--summary', 'fake ok', '--files', rel], { cwd: process.cwd(), stdio: 'inherit' });
