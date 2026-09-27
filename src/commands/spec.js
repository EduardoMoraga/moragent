import path from 'node:path';
import { requireRoot } from '../core/paths.js';
import { t } from '../core/i18n.js';
import { out, json, ok, c } from '../core/log.js';
import { MoragentError } from '../core/errors.js';
import { PHASES, archiveSpec, listSpecs, newSpec, specState, tasksFromSpec } from '../spec/index.js';

export default {
  name: 'spec',
  aliases: ['s'],
  group: 'spec',
  summary: { es: 'Gestiona specs SDD deterministas', en: 'Manage deterministic SDD specs' },
  usage: 'mora spec new <slug> [--title] | status [slug] | next <slug> | tasks <slug> [--dispatch] | archive <slug> [--json]',
  async run(argv, ctx) {
    const sub = argv._[0] || 'status';
    const root = requireRoot();
    if (sub === 'new') return runNew(argv, ctx, root);
    if (sub === 'status') return runStatus(argv, ctx, root);
    if (sub === 'next') return runNext(argv, ctx, root);
    if (sub === 'tasks') return runTasks(argv, ctx, root);
    if (sub === 'archive') return runArchive(argv, ctx, root);
    throw new MoragentError('BAD_SPEC_COMMAND', t(`Subcomando spec desconocido: ${sub}`, `Unknown spec subcommand: ${sub}`), this.usage);
  },
};

async function runNew(argv, ctx, root) {
  const slug = argv._[1];
  if (!slug) throw new MoragentError('MISSING_SLUG', t('Falta slug.', 'Missing slug.'), 'mora spec new login --title "Login"');
  const title = typeof argv.flags.title === 'string' ? argv.flags.title : slug;
  const dir = newSpec({ root, slug, title, lang: ctx.config?.lang || ctx.lang });
  const state = specState(root, slug);
  if (ctx.json) json({ ok: true, slug, dir, state });
  else { ok(t(`Spec creada: ${path.relative(root, dir)}`, `Spec created: ${path.relative(root, dir)}`)); out(state.hint); }
  return 0;
}

async function runStatus(argv, ctx, root) {
  const slug = argv._[1];
  if (slug) {
    const state = specState(root, slug);
    if (ctx.json) json({ slug, ...state });
    else printStatus(slug, state);
    return 0;
  }
  const specs = listSpecs(root);
  if (ctx.json) json({ specs });
  else specs.forEach((s) => printStatus(s.slug, s));
  return 0;
}

async function runNext(argv, ctx, root) {
  const slug = needSlug(argv);
  const state = specState(root, slug);
  if (ctx.json) json({ slug, next: state.next, hint: state.hint, done: state.done });
  else out(state.hint);
  return 0;
}

async function runTasks(argv, ctx, root) {
  const slug = needSlug(argv);
  const tasks = tasksFromSpec(root, slug);
  if (argv.flags.dispatch) {
    const made = await dispatchTasks(root, slug, tasks);
    if (ctx.json) json({ slug, tasks, dispatched: made });
    else made.forEach((task) => ok(t(`Tarea creada: ${task.id} ${task.title}`, `Task created: ${task.id} ${task.title}`)));
    return 0;
  }
  if (ctx.json) json({ slug, tasks });
  else tasks.forEach((task, i) => out(`${task.done ? '[x]' : '[ ]'} T${i + 1}: ${task.title} @${task.role} — ${t('Listo cuando', 'Done when')}: ${task.doneWhen}`));
  return 0;
}

async function runArchive(argv, ctx, root) {
  const slug = needSlug(argv);
  const state = archiveSpec(root, slug);
  if (ctx.json) json({ slug, ...state });
  else ok(t(`Spec archivada: ${slug}`, `Spec archived: ${slug}`));
  return 0;
}

function needSlug(argv) {
  const slug = argv._[1];
  if (!slug) throw new MoragentError('MISSING_SLUG', t('Falta slug.', 'Missing slug.'), 'mora spec status');
  return slug;
}

function printStatus(slug, state) {
  const bar = PHASES
    .map((p) => state.done.includes(p) ? c.green('●') : p === state.phase ? c.yellow('◐') : c.gray('○'))
    .join('');
  out(`${bar} ${slug} → ${state.phase}`);
}

async function dispatchTasks(root, slug, tasks) {
  let createTask;
  try { ({ createTask } = await import('../bus/tasks.js')); }
  catch { throw new MoragentError('BUS_UNAVAILABLE', t('El bus de tareas aún no está disponible.', 'Task bus is not available yet.'), 'mora spec tasks <slug>'); }
  const made = [];
  for (const task of tasks.filter((x) => !x.done)) {
    made.push(createTask({ root, title: task.title, role: task.role, spec: slug, by: 'spec', body: `${task.title}\n\n${t('Done when', 'Done when')}: ${task.doneWhen}` }));
  }
  try {
    const mod = await import('./dispatch.js');
    if (mod?.default?.run) {
      for (const task of made) await mod.default.run({ _: [task.role, `Lee y ejecuta .moragent/tasks/${task.id}.md`], flags: { spec: slug } }, { root, json: false });
    }
  } catch { /* dispatch can be absent while backend is in progress */ }
  return made;
}
