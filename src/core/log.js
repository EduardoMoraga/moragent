const enabled = () => !process.env.NO_COLOR && (process.stdout.isTTY || process.env.FORCE_COLOR);

const wrap = (open, close) => (s) => (enabled() ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

export const c = {
  bold: wrap(1, 22), dim: wrap(2, 22), italic: wrap(3, 23), underline: wrap(4, 24),
  red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39), blue: wrap(34, 39),
  magenta: wrap(35, 39), cyan: wrap(36, 39), gray: wrap(90, 39),
  // brand accent: violet
  brand: (s) => (enabled() ? `\x1b[38;5;141m${s}\x1b[39m` : String(s)),
};

export const out = (s = '') => process.stdout.write(s + '\n');
export const ok = (m) => out(`${c.green('✓')} ${m}`);
export const warn = (m) => out(`${c.yellow('!')} ${m}`);
export const err = (m) => process.stderr.write(`${c.red('✗')} ${m}\n`);
export const info = (m) => out(`${c.cyan('›')} ${m}`);
export const step = (n, m) => out(`${c.brand(String(n).padStart(2))} ${m}`);
export const json = (obj) => out(JSON.stringify(obj, null, 2));

// Strip ANSI for width math.
export const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
