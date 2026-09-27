import { requireRoot } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import { MoragentError } from '../core/errors.js';
import { t } from '../core/i18n.js';
import { json, out, ok } from '../core/log.js';
import { createTask, getTask, listTasks } from '../bus/tasks.js';
import { writeEnvelope } from '../bus/envelope.js';

export default {
  name: 'task',
  group: 'crew',
  summary: { es: 'Gestiona tareas del bus', en: 'Manage task bus records' },
  usage: 'mora task add <role> "<tarea>" [--title "…"] [--spec slug] | list [--status x] [--role x] | show <id> [--json]',
  async run(argv, ctx) {
    const root = ctx.root || requireRoot();
    const cfg = ctx.config || loadConfig(root);
    const [op, first, ...rest] = argv._;
    if (op === 'add') {
      const body = rest.join(' ').trim();
      if (!first || !body) throw new MoragentError('USAGE', this.usage);
      if (!cfg.crew?.[first]) throw new MoragentError('UNKNOWN_ROLE', t(`Rol desconocido: ${first}`, `Unknown role: ${first}`));
      const task = createTask({
        root, role: first, body,
        title: typeof argv.flags.title === 'string' ? argv.flags.title : undefined,
        spec: typeof argv.flags.spec === 'string' ? argv.flags.spec : null,
        by: 'lead',
      });
      const envelope = await writeEnvelope({ root, task, config: cfg });
      if (ctx.json) json({ ok: true, task, envelope });
      else ok(t(`${task.id} agregada a la cola.`, `${task.id} added to the queue.`));
      return 0;
    }
    if (!op || op === 'list') {
      const tasks = listTasks(root, {
        status: typeof argv.flags.status === 'string' ? argv.flags.status : undefined,
        role: typeof argv.flags.role === 'string' ? argv.flags.role : undefined,
      });
      if (ctx.json) { json({ tasks }); return 0; }
      if (!tasks.length) { out(t('No hay tareas.', 'No tasks.')); return 0; }
      out(t('ID      ESTADO    ROL        TÍTULO', 'ID      STATUS    ROLE       TITLE'));
      for (const task of tasks) out(`${task.id.padEnd(7)} ${task.status.padEnd(9)} ${task.role.padEnd(10)} ${task.title}`);
      return 0;
    }
    if (op === 'show') {
      if (!first) throw new MoragentError('USAGE', this.usage);
      const task = getTask(root, first);
      if (ctx.json) json(task);
      else {
        out(`${task.id} — ${task.title}`);
        out(`${t('estado', 'status')}: ${task.status}  ${t('rol', 'role')}: ${task.role}`);
        out('');
        out(task.body);
        if (task.result) out(`\n${t('resultado', 'result')}: ${task.result}`);
      }
      return 0;
    }
    throw new MoragentError('USAGE', this.usage);
  },
};
