import { requireRoot } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import { t } from '../core/i18n.js';
import { json, out } from '../core/log.js';
import { listTasks } from '../bus/tasks.js';

const ORDER = ['queued', 'sent', 'running', 'blocked', 'failed', 'done'];
const label = (status) => ({
  queued: t('EN COLA', 'QUEUED'), sent: t('ENVIADA', 'SENT'), running: t('EN CURSO', 'RUNNING'),
  blocked: t('BLOQUEADA', 'BLOCKED'), failed: t('FALLIDA', 'FAILED'), done: t('LISTA', 'DONE'),
})[status] || status.toUpperCase();

function simpleBoard(tasks) {
  const lines = [];
  for (const status of ORDER) {
    const group = tasks.filter((task) => task.status === status);
    if (!group.length) continue;
    lines.push(`${label(status)} (${group.length})`);
    for (const task of group) lines.push(`  ${task.id}  ${task.role.padEnd(10)} ${task.title}`);
    lines.push('');
  }
  return lines.length ? lines.join('\n').trimEnd() : t('No hay tareas.', 'No tasks.');
}

export default {
  name: 'board',
  group: 'crew',
  summary: { es: 'Muestra el kanban de tareas', en: 'Show the task kanban' },
  usage: 'mora board [--json]',
  async run(argv, ctx) {
    const root = ctx.root || requireRoot();
    const cfg = ctx.config || loadConfig(root);
    const tasks = listTasks(root);
    if (ctx.json) { json({ tasks, columns: Object.fromEntries(ORDER.map((s) => [s, tasks.filter((task) => task.status === s)])) }); return 0; }
    try {
      const ui = await import('../ui/board.js');
      if (typeof ui.renderBoard === 'function') {
        const rendered = await ui.renderBoard(tasks, cfg);
        if (rendered !== undefined) out(rendered);
        return 0;
      }
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    }
    out(simpleBoard(tasks));
    return 0;
  },
};
