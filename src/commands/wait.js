import { requireRoot } from '../core/paths.js';
import { MoragentError } from '../core/errors.js';
import { t } from '../core/i18n.js';
import { json, out, warn } from '../core/log.js';
import { parseDuration, waitForTasks } from '../bus/wait.js';

export default {
  name: 'wait',
  group: 'crew',
  summary: { es: 'Espera el resultado de tareas', en: 'Wait for task results' },
  usage: 'mora wait <id…> [--timeout 30m] [--interval 5s] [--json]',
  async run(argv, ctx) {
    const root = ctx.root || requireRoot();
    if (!argv._.length) throw new MoragentError('USAGE', this.usage);
    const result = await waitForTasks(root, argv._, {
      timeoutMs: parseDuration(argv.flags.timeout, 1800000),
      intervalMs: parseDuration(argv.flags.interval, 5000),
    });
    const code = result.timedOut ? 4 : result.tasks.every((task) => task.status === 'done') ? 0 : 3;
    if (ctx.json) { json({ ok: code === 0, timedOut: result.timedOut, tasks: result.tasks }); return code; }
    for (const task of result.tasks) out(`${task.id}  ${task.status.padEnd(8)} ${task.result || task.title}`);
    if (result.timedOut) warn(t('Se agotó el tiempo de espera.', 'Wait timed out.'));
    return code;
  },
};
