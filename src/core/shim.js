import fs from 'node:fs';
import path from 'node:path';
import { dirs, PKG_ROOT } from './paths.js';
import { ensureDir, writeText, exists } from './fsx.js';

// Every agent pane must be able to run `mora`, whatever way MORAGENT was installed (global npm,
// npx, a git clone). `mora up` writes a tiny shim for the running installation and panes get its
// directory prepended to PATH.
export const shimDir = (root) => path.join(dirs(root).runs, 'bin');

export function ensureShim(root) {
  const dir = ensureDir(shimDir(root));
  const bin = path.join(PKG_ROOT, 'bin', 'mora.js');
  const sh = path.join(dir, 'mora');
  writeText(sh, `#!/bin/sh\nexec "${process.execPath}" "${bin}" "$@"\n`);
  fs.chmodSync(sh, 0o755);
  writeText(path.join(dir, 'mora.cmd'), `@echo off\r\n"${process.execPath}" "${bin}" %*\r\n`);
  return dir;
}

export const shimFor = (root) => (root && exists(shimDir(root)) ? shimDir(root) : null);
