#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code ?? 0; },
  (e) => { console.error(e?.stack || e); process.exitCode = 1; },
);
