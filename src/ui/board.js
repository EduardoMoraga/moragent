import { c, plain } from '../core/log.js';
import { t } from '../core/i18n.js';

// failed tasks share the "blocked" column: both need the lead's attention.
export const COLUMNS = [
  { id: 'queued', match: ['queued'], label: () => t('En cola', 'Queued'), color: c.gray },
  { id: 'sent', match: ['sent'], label: () => t('Enviada', 'Sent'), color: c.blue },
  { id: 'running', match: ['running'], label: () => t('En curso', 'Running'), color: c.cyan },
  { id: 'done', match: ['done'], label: () => t('Lista', 'Done'), color: c.green },
  { id: 'blocked', match: ['blocked', 'failed'], label: () => t('Bloqueada', 'Blocked'), color: c.red },
];

const MAX_CARDS = 8;
const GAP = 2;

const width = (s) => [...plain(s)].length;

function clip(s, w) {
  const chars = [...String(s)];
  return chars.length <= w ? chars.join('') : chars.slice(0, Math.max(0, w - 1)).join('') + '…';
}

// Word-wrap into at most `max` lines of width `w`; overflow ends in an ellipsis.
function wrap(text, w, max) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  for (const word of words) {
    const last = lines[lines.length - 1];
    if (last !== undefined && [...`${last} ${word}`].length <= w) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  if (lines.length > max) {
    lines.length = max;
    lines[max - 1] = clip(`${lines[max - 1]} …`, w);
  }
  return lines.map((l) => clip(l, w));
}

const padR = (s, w) => s + ' '.repeat(Math.max(0, w - width(s)));

const byUpdated = (a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''));

export function groupTasks(tasks) {
  const groups = Object.fromEntries(COLUMNS.map((col) => [col.id, []]));
  for (const task of tasks || []) {
    const col = COLUMNS.find((k) => k.match.includes(task.status)) || COLUMNS[0];
    groups[col.id].push(task);
  }
  for (const id of Object.keys(groups)) groups[id].sort(id === 'queued' ? (a, b) => String(a.id).localeCompare(String(b.id)) : byUpdated);
  return groups;
}

function card(task, w) {
  const mark = task.status === 'failed' ? c.red('✗ ') : '';
  const role = clip('@' + (task.role || '?'), Math.max(1, w - [...String(task.id)].length - 3));
  return [`${mark}${c.bold(task.id)} ${c.dim(role)}`, ...wrap(task.title, w, 2), ''];
}

function renderColumns(groups, cols) {
  const colW = Math.max(12, Math.floor((cols - GAP * (COLUMNS.length - 1)) / COLUMNS.length));
  const blocks = COLUMNS.map((col) => {
    const list = groups[col.id];
    const lines = [col.color(c.bold(clip(`${col.label()} ${list.length}`, colW))), c.dim('─'.repeat(colW))];
    for (const task of list.slice(0, MAX_CARDS)) lines.push(...card(task, colW));
    if (list.length > MAX_CARDS) lines.push(c.dim(t(`+${list.length - MAX_CARDS} más`, `+${list.length - MAX_CARDS} more`)));
    if (!list.length) lines.push(c.dim('·'));
    return lines;
  });
  const height = Math.max(...blocks.map((b) => b.length));
  const rows = [];
  for (let i = 0; i < height; i++) {
    rows.push(blocks.map((b) => padR(b[i] || '', colW)).join(' '.repeat(GAP)).trimEnd());
  }
  while (rows.length && !plain(rows[rows.length - 1]).trim()) rows.pop();
  return rows.join('\n');
}

function renderList(groups, cols) {
  const out = [];
  for (const col of COLUMNS) {
    const list = groups[col.id];
    if (!list.length) continue;
    out.push(col.color(c.bold(`${col.label()} (${list.length})`)));
    for (const task of list.slice(0, MAX_CARDS)) {
      const room = Math.max(10, cols - [...`  • ${task.id} @${task.role || '?'} `].length);
      out.push(`  ${task.status === 'failed' ? c.red('✗') : col.color('•')} ${c.bold(task.id)} ${c.dim('@' + (task.role || '?'))} ${clip(task.title || '', room)}`);
    }
    if (list.length > MAX_CARDS) out.push(c.dim(t(`  +${list.length - MAX_CARDS} más`, `  +${list.length - MAX_CARDS} more`)));
  }
  return out.join('\n');
}

// Kanban of the task bus. Adapts to the terminal width; below 80 columns it becomes a list.
export function renderBoard(tasks, cfg = {}, { columns } = {}) {
  const cols = columns || process.stdout.columns || 100;
  const list = tasks || [];
  const title = `${c.bold(t('Tablero', 'Board'))}${cfg.project ? c.dim(` · ${cfg.project}`) : ''} ${c.dim(`· ${list.length} ${t('tareas', 'tasks')}`)}`;
  if (!list.length) {
    return `${title}\n${c.dim(t('Sin tareas todavía. Crea una: mora dispatch <rol> "…"', 'No tasks yet. Create one: mora dispatch <role> "…"'))}`;
  }
  const groups = groupTasks(list);
  return `${title}\n\n${cols < 80 ? renderList(groups, cols) : renderColumns(groups, cols)}`;
}
