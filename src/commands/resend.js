import { requireRoot } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import { MoragentError } from '../core/errors.js';
import { t } from '../core/i18n.js';
import { json, ok } from '../core/log.js';
import { getTask, updateTask } from '../bus/tasks.js';
import { writeEnvelope } from '../bus/envelope.js';
import { getAdapter } from '../crew/adapters.js';
import { loadPanes } from '../crew/panes.js';
import { ensureShim } from '../core/shim.js';
import { nowISO } from '../core/fsx.js';
import { getMux } from '../mux/index.js';
import { assertPaneReady } from './dispatch.js';

const RESENDABLE = new Set(['queued', 'sent']);

export default {
  name: 'resend',
  group: 'crew',
  summary: { es: 'Reenvía una tarea a su panel activo', en: 'Resend a task to its active pane' },
  usage: 'mora resend <id> [--json]',
  async run(argv, ctx) {
    const root = ctx.root || requireRoot();
    const cfg = ctx.config || loadConfig(root);
    const id = argv._[0];
    if (!id) throw new MoragentError('USAGE', this.usage);
    const task = getTask(root, id);
    if (!RESENDABLE.has(task.status)) throw new MoragentError(
      'TASK_NOT_RESENDABLE',
      t(`La tarea ${task.id} está ${task.status} y no se puede reenviar.`, `Task ${task.id} is ${task.status} and cannot be resent.`),
      t('Sólo se pueden reenviar tareas queued o sent.', 'Only queued or sent tasks can be resent.'),
    );
    const pane = loadPanes(root)[task.role];
    if (!pane) throw new MoragentError(
      'PANE_NOT_FOUND',
      t(`No hay panel registrado para ${task.role}.`, `No registered pane for ${task.role}.`),
      `mora up ${task.role}`,
    );
    const mux = getMux(pane.mux);
    if (!mux.alive(pane.handle, { root })) throw new MoragentError(
      'PANE_NOT_FOUND',
      t(`El panel de ${task.role} no está activo.`, `The ${task.role} pane is not active.`),
      `mora up ${task.role}`,
    );
    assertPaneReady(mux, pane, task.role);
    const envelope = await writeEnvelope({ root, task, config: cfg });
    const prompt = cfg.lang === 'en'
      ? `Read and execute .moragent/tasks/${task.id}.md`
      : `Lee y ejecuta .moragent/tasks/${task.id}.md`;
    const member = cfg.crew?.[task.role] || {};
    let execution;
    if (mux.name === 'headless') {
      ensureShim(root);
      const adapter = getAdapter(pane.cli || member.cli);
      mux.send(pane.handle, prompt, {
        root,
        role: task.role,
        adapter,
        member,
        taskId: task.id,
        autonomy: pane.autonomy || member.autonomy,
      });
    } else {
      mux.send(pane.handle, prompt);
      execution = { mode: 'pane', mux: mux.name, handle: pane.handle, provider: pane.cli || member.cli, updatedAt: nowISO() };
    }
    const resent = updateTask(root, task.id, { status: 'sent', execution });
    if (ctx.json) json({ ok: true, task: resent, envelope, mux: mux.name });
    else ok(t(`${task.id} reenviada a ${task.role} vía ${mux.name}.`, `${task.id} resent to ${task.role} via ${mux.name}.`));
    return 0;
  },
};
