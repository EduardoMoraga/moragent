import { requireRoot } from '../core/paths.js';
import { MoragentError } from '../core/errors.js';
import { t } from '../core/i18n.js';
import { json, out } from '../core/log.js';
import { readStatus } from '../bus/status.js';

const labels = {
  queued: ['EN COLA', 'QUEUED'], sent: ['ENVIADA', 'SENT'], running: ['EN CURSO', 'RUNNING'],
  blocked: ['BLOQUEADA', 'BLOCKED'], done: ['TERMINADA', 'DONE'],
  failed: ['FALLIDA', 'FAILED'], unknown: ['DESCONOCIDO', 'UNKNOWN'],
};

const reasons = {
  task_not_found: ['No existe un registro local de esta tarea.', 'No local task record exists.'],
  task_record_unreadable: ['El registro de la tarea no se puede leer.', 'The task record is unreadable.'],
  run_record_unreadable: ['El registro local de ejecuciones no se puede leer.', 'The local run record is unreadable.'],
  run_record_missing: ['No hay un registro de ejecución verificable.', 'No verifiable execution record exists.'],
  execution_record_unreadable: ['Los datos de ejecución de la tarea no se pueden leer.', 'The task execution data is unreadable.'],
  run_project_mismatch: ['La ejecución registrada pertenece a otro proyecto.', 'The recorded run belongs to another project.'],
  unrecognized_task_status: ['El estado guardado de la tarea no se reconoce.', 'The stored task status is not recognized.'],
  run_not_running: ['La ejecución registrada no está en curso.', 'The recorded run is not running.'],
  process_not_running: ['El proceso registrado ya no existe; no se conoce su resultado.', 'The recorded process is gone; its outcome is unknown.'],
  process_handle_missing: ['Falta un PID válido para verificar la ejecución.', 'A valid PID is missing for this run.'],
  process_unreadable: ['No se pudo verificar el proceso registrado.', 'The recorded process could not be inspected.'],
  execution_handle_missing: ['Falta un handle de ejecución verificable.', 'A verifiable execution handle is missing.'],
  pane_not_running: ['El panel ya no existe; no se conoce el resultado de la tarea.', 'The pane is gone; the task outcome is unknown.'],
  pane_unreadable: ['No se pudo verificar el panel registrado.', 'The recorded pane could not be inspected.'],
  pane_alive_task_unverified: ['El panel está activo, pero aún no hay prueba de que esta tarea esté en curso.', 'The pane is alive, but there is no proof this task is running yet.'],
};

const actions = {
  find_task: ['Busca el ID correcto.', 'Find the correct task ID.'],
  inspect_task_record: ['Inspecciona el registro antes de intervenir.', 'Inspect the record before intervening.'],
  inspect_run_record: ['Inspecciona el registro de ejecuciones.', 'Inspect the execution record.'],
  review_queue: ['Revisa la cola antes de despachar.', 'Review the queue before dispatching.'],
  check_again: ['Vuelve a consultar el estado antes de intervenir.', 'Check status again before intervening.'],
  inspect_before_retry: ['Inspecciona el registro y el log antes de decidir si crear otra tarea.', 'Inspect the record and log before deciding whether to create another task.'],
  resolve_blocker: ['Lee el bloqueo y resuelve la decisión pendiente.', 'Read the blocker and resolve the pending decision.'],
  review_result: ['Revisa el resultado y los archivos.', 'Review the result and files.'],
};

export function formatStatus(data) {
  if (!data.tasks.length) return t('No hay tareas locales.', 'No local tasks.');
  return data.tasks.map((task) => {
    const lines = [`${task.id} — ${t(...labels[task.status])}${task.title ? ` · ${task.title}` : ''}`];
    if (task.role || task.provider) lines.push(`${t('Rol', 'Role')}: ${task.role || '—'} · ${t('Proveedor', 'Provider')}: ${task.provider || '—'}`);
    if (task.run.mode || task.run.handle || task.run.pid) {
      lines.push(`${t('Ejecución', 'Run')}: ${task.run.id || task.run.handle || task.run.mode || '—'}${task.run.pid ? ` · PID: ${task.run.pid}` : ''}${task.run.sessionId ? ` · ${t('Sesión', 'Session')}: ${task.run.sessionId}` : ''}`);
    }
    if (task.lastEvent) lines.push(`${t('Último evento', 'Last event')}: ${task.lastEvent.at} · ${task.lastEvent.status || task.lastEvent.type}`);
    if (task.reason) lines.push(`${t('Motivo', 'Reason')}: ${t(...reasons[task.reason])}`);
    if (task.result) lines.push(`${t('Resultado', 'Result')}: ${task.result}`);
    if (task.files.length) lines.push(`${t('Archivos', 'Files')}: ${task.files.join(', ')}`);
    if (task.logFile) lines.push(`${t('Log', 'Log')}: ${task.logFile}`);
    lines.push(`${t('Siguiente acción', 'Next action')}: ${task.nextAction.command} — ${t(...actions[task.nextAction.reason])}`);
    return lines.join('\n');
  }).join('\n\n');
}

export default {
  name: 'status',
  aliases: ['st'],
  group: 'crew',
  summary: { es: 'Estado local de tareas, ejecución y próxima acción', en: 'Local task/run health and next action' },
  usage: 'mora status [<taskId>] [--json]',
  details: {
    es: 'mora status ahora consulta tareas y ejecuciones. Usa mora dashboard para el resumen anterior del proyecto. La consulta nunca reintenta ni cambia registros.',
    en: 'mora status now inspects tasks and runs. Use mora dashboard for the former project overview. Reading status never retries or changes records.',
  },
  async run(argv, ctx) {
    if (argv._.length > 1) throw new MoragentError('USAGE', this.usage);
    const root = ctx.root || requireRoot();
    const data = readStatus(root, argv._[0] || null, { config: ctx.config });
    if (!data.ok) throw new MoragentError('USAGE', this.usage);
    if (ctx.json) json(data);
    else out(formatStatus(data));
    return 0;
  },
};
