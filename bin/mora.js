#!/usr/bin/env node
import { main } from '../src/cli.js';

// `mora board | head` closes the pipe early; that is not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code ?? 0; },
  (e) => { console.error(e?.stack || e); process.exitCode = 1; },
);
