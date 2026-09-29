import { refreshBrain } from '../core/brain-refresh.js';
import { requireRoot } from '../core/paths.js';
import { MoragentError } from '../core/errors.js';
import { t } from '../core/i18n.js';
import { json, warn } from '../core/log.js';
import { getTask, updateTask } from '../bus/tasks.js';

async function remember(root, task, reason) {
  try {
    const memory = await import(new URL('../memory/index.js', import.meta.url).href);
    if (typeof memory.add === 'function') await memory.add({
      root, tier: 'transient', kind: 'handoff',
      title: `${task.id} blocked`, body: reason,
      tags: [task.role, 'blocked'], links: [task.id, task.spec].filter(Boolean), by: task.role,
    });
  } catch { /* memory is an optional integration */ }
}

export default {
  name: 'block',
  group: 'crew',
  summary: { es: 'Marca una tarea como bloqueada', en: 'Mark a task as blocked' },
  usage: 'mora block <id> --reason "…" [--json]',
  async run(argv, ctx) {
    const root = ctx.root || requireRoot();
    const id = argv._[0];
    const reason = argv.flags.reason;
    if (!id || typeof reason !== 'string' || !reason.trim()) throw new MoragentError('USAGE', this.usage);
    const before = getTask(root, id);
    // Keep the terminal task status as the completion barrier for waiters.
    await remember(root, before, reason.trim());
    const task = updateTask(root, id, { status: 'blocked', result: reason.trim() });
    await refreshBrain(root);
    if (ctx.json) json({ ok: true, task });
    else warn(t(`${task.id} bloqueada: ${reason.trim()}`, `${task.id} blocked: ${reason.trim()}`));
    return 0;
  },
};
