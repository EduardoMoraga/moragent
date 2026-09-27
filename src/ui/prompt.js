import readline from 'node:readline';
import { c } from '../core/log.js';
import { t } from '../core/i18n.js';

// Line-based prompts over any stream. One readline interface per prompter so buffered input
// (piped stdin, test streams) is never lost between questions. When input ends, every pending
// and future question resolves to its default — that is how prompts degrade without a TTY.
export function createPrompter({ input = process.stdin, output = process.stdout } = {}) {
  const rl = readline.createInterface({ input, terminal: false });
  const lines = [];
  const waiters = [];
  let closed = false;
  rl.on('line', (l) => (waiters.length ? waiters.shift()(l) : lines.push(l)));
  rl.on('close', () => { closed = true; while (waiters.length) waiters.shift()(null); });

  const write = (s) => output.write(s);
  const nextLine = () => {
    if (lines.length) return Promise.resolve(lines.shift());
    if (closed) return Promise.resolve(null);
    return new Promise((r) => waiters.push(r));
  };
  const line = async (label) => {
    write(label);
    const l = await nextLine();
    // A real TTY echoes what was typed; piped input does not, so echo it to keep logs readable.
    if (l === null || !input.isTTY) write(`${l ?? ''}\n`);
    return l === null ? null : l.trim();
  };

  async function ask(q, def = '') {
    const hint = def ? c.dim(` (${def})`) : '';
    const a = await line(`${c.brand('?')} ${c.bold(q)}${hint} ${c.dim('›')} `);
    return a ? a : def;
  }

  async function confirm(q, def = true) {
    const hint = c.dim(def ? ' (S/n)' : ' (s/N)');
    const hintEn = c.dim(def ? ' (Y/n)' : ' (y/N)');
    for (let i = 0; i < 3; i++) {
      const a = await line(`${c.brand('?')} ${c.bold(q)}${t(hint, hintEn)} ${c.dim('›')} `);
      if (!a) return def;
      const v = parseYesNo(a);
      if (v !== null) return v;
      write(c.yellow(t('  Responde s o n.\n', '  Answer y or n.\n')));
    }
    return def;
  }

  async function select(q, options, def) {
    const opts = normalize(options);
    const defIdx = Math.max(0, opts.findIndex((o) => o.value === def));
    write(`${c.brand('?')} ${c.bold(q)}\n`);
    printOptions(write, opts, (i) => i === defIdx);
    for (let i = 0; i < 3; i++) {
      const a = await line(`  ${c.dim(t(`Número (Enter = ${defIdx + 1})`, `Number (Enter = ${defIdx + 1})`))} ${c.dim('›')} `);
      if (!a) return opts[defIdx].value;
      const hit = pick(opts, a);
      if (hit) return hit.value;
      write(c.yellow(t(`  Elige un número entre 1 y ${opts.length}.\n`, `  Pick a number from 1 to ${opts.length}.\n`)));
    }
    return opts[defIdx].value;
  }

  async function multiselect(q, options, defs = []) {
    const opts = normalize(options);
    const chosen = new Set(defs);
    write(`${c.brand('?')} ${c.bold(q)}\n`);
    printOptions(write, opts, (i) => chosen.has(opts[i].value), true);
    for (let i = 0; i < 3; i++) {
      const a = await line(`  ${c.dim(t('Números separados por coma, "todos" o Enter', 'Numbers separated by commas, "all" or Enter'))} ${c.dim('›')} `);
      if (!a) return opts.filter((o) => chosen.has(o.value)).map((o) => o.value);
      if (/^(all|todos|\*)$/i.test(a)) return opts.map((o) => o.value);
      const hits = a.split(/[\s,]+/).filter(Boolean).map((tok) => pick(opts, tok));
      if (hits.every(Boolean)) return [...new Set(hits.map((o) => o.value))];
      write(c.yellow(t(`  Usa números entre 1 y ${opts.length}.\n`, `  Use numbers from 1 to ${opts.length}.\n`)));
    }
    return opts.filter((o) => chosen.has(o.value)).map((o) => o.value);
  }

  return { ask, confirm, select, multiselect, write, close: () => rl.close() };
}

export function parseYesNo(s) {
  const a = String(s).trim().toLowerCase();
  if (/^(s|si|sí|y|yes|ok)$/.test(a)) return true;
  if (/^(n|no)$/.test(a)) return false;
  return null;
}

const normalize = (options) => options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));

function printOptions(write, opts, marked, checkbox = false) {
  opts.forEach((o, i) => {
    const on = marked(i);
    const mark = checkbox ? (on ? c.brand('◉') : c.dim('○')) : (on ? c.brand('›') : ' ');
    const num = c.dim(`${String(i + 1).padStart(2)}.`);
    const hint = o.hint ? `  ${c.dim(o.hint)}` : '';
    write(`  ${mark} ${num} ${on ? c.bold(o.label) : o.label}${hint}\n`);
  });
}

// Accept a 1-based number, an exact value or an unambiguous label prefix.
function pick(opts, a) {
  const n = Number(a);
  if (Number.isInteger(n) && n >= 1 && n <= opts.length) return opts[n - 1];
  const low = a.toLowerCase();
  const exact = opts.find((o) => String(o.value).toLowerCase() === low);
  if (exact) return exact;
  const pre = opts.filter((o) => String(o.label).toLowerCase().startsWith(low));
  return pre.length === 1 ? pre[0] : null;
}

// One-shot helpers over stdin/stdout for commands that ask a single question.
async function once(fn, ...args) {
  const p = createPrompter();
  try { return await p[fn](...args); } finally { p.close(); }
}
export const ask = (q, def) => once('ask', q, def);
export const confirm = (q, def) => once('confirm', q, def);
export const select = (q, options, def) => once('select', q, options, def);
export const multiselect = (q, options, defs) => once('multiselect', q, options, defs);
