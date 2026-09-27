import path from 'node:path';
import { dirs, requireRoot } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import { exists, nowISO, slugify } from '../core/fsx.js';
import { MoragentError } from '../core/errors.js';
import { t } from '../core/i18n.js';
import { json, ok, info } from '../core/log.js';
import { createTask, nextId, updateTask } from '../bus/tasks.js';
import { writeEnvelope } from '../bus/envelope.js';
import { parseDuration, waitForTasks } from '../bus/wait.js';
import { getAdapter } from '../crew/adapters.js';
import { loadPanes, savePanes } from '../crew/panes.js';
import { ensureShim } from '../core/shim.js';
import { getMux } from '../mux/index.js';

// Startup dialogs that swallow a prompt: folder trust (Claude, Codex, agy) and update menus.
// Only the bottom of the screen matters — an accepted dialog stays visible in the scrollback above.
const BLOCKING_DIALOG = /(?:do you trust|trust this folder|do not trust|conf[ií]as en|press enter to continue|enter to confirm|enter select)/i;

export function assertPaneReady(mux, pane, role) {
  if (mux.name !== 'orca') return;
  const bottom = mux.read(pane.handle, { lines: 80 }).split(/\r?\n/).filter((l) => l.trim()).slice(-8).join('\n');
  if (!BLOCKING_DIALOG.test(bottom)) return;
  throw new MoragentError(
    'PANE_NOT_READY',
    t(`El panel ${role} espera confirmación de confianza.`, `The ${role} pane is waiting for trust confirmation.`),
    t(`Acepta el diálogo en el panel ${role} y reintenta.`, `Accept the dialog in the ${role} pane and retry.`),
  );
}

export default {
  name: 'dispatch',
  aliases: ['d'],
  group: 'crew',
  summary: { es: 'Crea y envía una tarea a un rol', en: 'Create and send a task to a role' },
  usage: 'mora dispatch <role> "<tarea>" [--spec slug] [--title "…"] [--headless] [--wait] [--dry-run] [--json]',
  async run(argv, ctx) {
    const root = ctx.root || requireRoot();
    const cfg = ctx.config || loadConfig(root);
    const [role, ...words] = argv._;
    const body = words.join(' ').trim();
    if (!role || !body) throw new MoragentError('USAGE', this.usage);
    const member = cfg.crew?.[role];
    if (!member) throw new MoragentError('UNKNOWN_ROLE', t(`Rol desconocido: ${role}`, `Unknown role: ${role}`));
    const requestedSpec = typeof argv.flags.spec === 'string' ? slugify(argv.flags.spec) : null;
    if (requestedSpec && !exists(path.join(dirs(root).specs, requestedSpec))) throw new MoragentError(
      'SPEC_NOT_FOUND',
      t(`No existe la spec ${requestedSpec}.`, `Spec ${requestedSpec} does not exist.`),
      `mora spec new ${requestedSpec}`,
    );
    const adapter = getAdapter(member.cli);
    const panes = loadPanes(root);
    if (!argv.flags['dry-run']) ensureShim(root);
    let pane = panes[role];
    let registeredPane = pane;
    let mux = pane && !argv.flags.headless ? getMux(pane.mux) : null;
    if (mux && !mux.alive(pane.handle)) {
      delete panes[role];
      savePanes(root, panes);
      mux = null;
      pane = null;
      registeredPane = null;
    }
    if (!mux) {
      if (!adapter.installed()) throw new MoragentError(
        'CLI_NOT_INSTALLED',
        t(`${adapter.label} no está instalado.`, `${adapter.label} is not installed.`),
        adapter.install,
      );
      mux = getMux('headless');
    }
    if (argv.flags['dry-run']) {
      const preview = { id: nextId(root), role, cli: member.cli, mux: mux.name, body, spec: requestedSpec };
      if (ctx.json) json({ ok: true, dryRun: true, task: preview });
      else info(t(`Simulación: ${preview.id} se enviaría a ${role} vía ${mux.name}.`, `Dry run: ${preview.id} would be sent to ${role} via ${mux.name}.`));
      return 0;
    }
    if (pane) assertPaneReady(mux, pane, role);
    let task = createTask({
      root,
      title: typeof argv.flags.title === 'string' ? argv.flags.title : undefined,
      role,
      body,
      spec: requestedSpec,
      by: 'lead',
    });
    const envelope = await writeEnvelope({ root, task, config: cfg });
    const prompt = cfg.lang === 'en'
      ? `Read and execute .moragent/tasks/${task.id}.md`
      : `Lee y ejecuta .moragent/tasks/${task.id}.md`;
    let launch = null;
    try {
      if (mux.name === 'headless') {
        const autonomy = pane?.mux === 'headless' ? pane.autonomy : member.autonomy;
        const result = mux.spawn({ root, role, cwd: root, adapter, member, taskId: task.id, autonomy });
        launch = mux.send(result.handle, prompt, { root, role, adapter, member, taskId: task.id, autonomy });
        if (!argv.flags.headless || !registeredPane) {
          panes[role] = { mux: 'headless', handle: result.handle, cli: member.cli, autonomy: autonomy || 'auto', startedAt: nowISO() };
          savePanes(root, panes);
        }
      } else {
        mux.send(pane.handle, prompt);
      }
    } catch (error) {
      updateTask(root, task.id, { status: 'failed', result: error.message });
      throw error;
    }
    task = updateTask(root, task.id, { status: 'sent' });
    if (argv.flags.wait) {
      const waited = await waitForTasks(root, [task.id], { timeoutMs: parseDuration(argv.flags.timeout, 1800000) });
      task = waited.tasks[0];
      if (waited.timedOut) {
        if (ctx.json) json({ ok: false, task, envelope, timedOut: true });
        else info(t(`Tiempo agotado esperando ${task.id}.`, `Timed out waiting for ${task.id}.`));
        return 4;
      }
      if (ctx.json) json({ ok: task.status === 'done', task, envelope, launch });
      else ok(`${task.id}: ${task.status}`);
      return task.status === 'done' ? 0 : 3;
    }
    if (ctx.json) { json({ ok: true, task, envelope, mux: mux.name, launch }); return 0; }
    ok(t(`${task.id} enviada a ${role} vía ${mux.name}.`, `${task.id} sent to ${role} via ${mux.name}.`));
    return 0;
  },
};
