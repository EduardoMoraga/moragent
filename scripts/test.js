// Portable test runner: `node --test <dir>` behaves differently across Node 18/20/22.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = path.resolve('test');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(dir, f));
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env: { ...process.env, NO_COLOR: '1' } });
process.exit(r.status ?? 1);
