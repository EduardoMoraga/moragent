import { refreshBrain } from '../core/brain-refresh.js';
import { requireRoot } from '../core/paths.js';
import { flagList } from '../core/args.js';
import { MoragentError } from '../core/errors.js';
import { t } from '../core/i18n.js';
import { json, ok } from '../core/log.js';
import { getTask, updateTask } from '../bus/tasks.js';

async function remember(root, task, summary) {
  try {
    const memory = await import(new URL('../memory/index.js', import.meta.url).href);
    if (typeof memory.add === 'function') await memory.add({
      root, tier: 'episodic', kind: 'episode',
      title: `${task.id}: ${task.title}`, body: summary,
      tags: [task.role], links: [task.id, task.spec].filter(Boolean), by: task.role,
    });
  } catch { /* memory is an optional integration */ }
}

export default {
  name: 'done',
  group: 'crew',
  summary: { es: 'Marca una tarea como terminada', en: 'Mark a task as done' },
  usage: 'mora done <id> --summary "…" [--files a,b] [--json]',
  async run(argv, ctx) {
    const root = ctx.root || requireRoot();
    const id = argv._[0];
    const summary = argv.flags.summary;
    if (!id || typeof summary !== 'string' || !summary.trim()) throw new MoragentError('USAGE', this.usage);
    const before = getTask(root, id);
    const files = flagList(argv.flags.files);
    // `mora wait` treats status=done as a completion barrier. Write the memory
    // note first so a concurrent waiter cannot observe done before it exists.
    await remember(root, before, summary.trim());
    const task = updateTask(root, id, { status: 'done', result: summary.trim(), files: files.length ? files : before.files || [] });
    await refreshBrain(root);
    if (ctx.json) json({ ok: true, task });
    else ok(t(`${task.id} terminada.`, `${task.id} done.`));
    return 0;
  },
};
