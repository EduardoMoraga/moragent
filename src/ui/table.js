import { plain } from '../core/log.js';

const len = (s) => [...plain(s)].length;
const pad = (s, w) => s + ' '.repeat(Math.max(0, w - len(s)));

// Aligned text table. Widths are measured on plain() so colored cells line up.
// rows: array of arrays (cells are coerced to strings). headers: optional array.
export function table(rows, headers, { indent = '', gap = '  ', headerStyle = (s) => s } = {}) {
  const all = headers ? [headers, ...rows] : rows;
  if (!all.length) return '';
  const n = Math.max(...all.map((r) => r.length));
  const cells = all.map((r) => Array.from({ length: n }, (_, i) => (r[i] === undefined || r[i] === null ? '' : String(r[i]))));
  const widths = Array.from({ length: n }, (_, i) => Math.max(...cells.map((r) => len(r[i]))));
  const line = (r) => (indent + r.map((cell, i) => (i === n - 1 ? cell : pad(cell, widths[i]))).join(gap)).trimEnd();
  const out = [];
  if (headers) {
    out.push(headerStyle(line(cells[0])));
    out.push(indent + widths.map((w) => '─'.repeat(w)).join(gap));
  }
  for (const r of headers ? cells.slice(1) : cells) out.push(line(r));
  return out.join('\n');
}
