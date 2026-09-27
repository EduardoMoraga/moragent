import fs from 'node:fs';
import path from 'node:path';
import { requireRoot, dirs } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import { readText, readJSON, listFiles, exists } from '../core/fsx.js';
import { t } from '../core/i18n.js';
import { out, c, json } from '../core/log.js';
import { version } from '../cli.js';
import { bannerSmall } from '../ui/banner.js';
import { table } from '../ui/table.js';
import { cliCatalog } from '../ui/clis.js';

const STATUSES = ['queued', 'sent', 'running', 'done', 'failed', 'blocked'];
const PLACEHOLDER = /^(Describe aquí|Describe the project goal)/;

export function readGoal(root, cfg) {
  if (cfg.goal) return cfg.goal;
  const raw = readText(path.join(dirs(root).canonical, 'project.md'));
  const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  const first = body.split(/\n\s*\n/)[0]?.trim() || '';
  return PLACEHOLDER.test(first) ? '' : first;
}

export function readTasks(root) {
  return listFiles(dirs(root).tasks, { ext: '.json' })
    .map((f) => readJSON(f, null))
    .filter((x) => x && x.id);
}

export function taskSummary(tasks) {
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const task of tasks) byStatus[task.status] = (byStatus[task.status] || 0) + 1;
  return { total: tasks.length, byStatus };
}

export function memoryCounts(root) {
  const d = dirs(root);
  const count = (dir) => listFiles(dir, { ext: '.md', recursive: true }).length;
  const skills = exists(d.skills) ? fs.readdirSync(d.skills, { withFileTypes: true }).filter((e) => e.isDirectory()).length : 0;
  return { canonical: count(d.canonical), episodic: count(d.episodic), transient: count(d.transient), skills };
}

// Pane registry plus a liveness probe through the backend's mux, when it exists.
async function paneStatus(root) {
  const panes = readJSON(path.join(dirs(root).runs, 'panes.json'), {}) || {};
  let getMux = null;
  try { ({ getMux } = await import(new URL('../mux/index.js', import.meta.url).href)); } catch { /* not built */ }
  const res = {};
  for (const [role, p] of Object.entries(panes)) {
    let alive = null;
    try { if (getMux && p?.mux && p?.handle) alive = !!getMux(p.mux).alive(p.handle); } catch { alive = null; }
    res[role] = { mux: p?.mux || null, handle: p?.handle || null, alive };
  }
  return res;
}

// The spec being worked on: the most recently touched one that is not archived.
async function activeSpec(root) {
  const base = dirs(root).specs;
  if (!exists(base)) return { active: null, count: 0 };
  const slugs = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  let specState = null;
  try { ({ specState } = await import(new URL('../spec/index.js', import.meta.url).href)); } catch { /* not built */ }
  const rows = slugs.map((slug) => {
    let state = null;
    try { state = specState ? specState(root, slug) : null; } catch { state = null; }
    const mtime = Math.max(0, ...listFiles(path.join(base, slug), { ext: '' }).map((f) => fs.statSync(f).mtimeMs));
    return { slug, phase: state?.phase || null, hint: state?.hint || null, mtime };
  }).filter((r) => r.phase !== 'archive').sort((a, b) => b.mtime - a.mtime);
  const top = rows[0];
  return { active: top ? { slug: top.slug, phase: top.phase, hint: top.hint } : null, count: slugs.length };
}

export function suggestNext({ tasks, panes, cfg, spec }) {
  const next = [];
  const blocked = (tasks.byStatus.blocked || 0) + (tasks.byStatus.failed || 0);
  const livePanes = Object.values(panes).filter((p) => p.alive !== false).length;
  if (blocked) next.push({ cmd: 'mora board', why: t(`${blocked} tarea(s) bloqueada(s) necesitan tu decisión`, `${blocked} blocked task(s) need your call`) });
  if (!tasks.total) next.push({ cmd: 'mora plan "…"', why: t('describe lo que quieres construir y MORAGENT arma el plan', 'describe what you want to build and MORAGENT sizes the plan') });
  else if (spec?.active && spec.active.phase && !['apply', 'verify', 'archive'].includes(spec.active.phase)) {
    next.push({ cmd: `mora spec next ${spec.active.slug}`, why: t(`la spec va en la fase ${spec.active.phase}`, `the spec is in the ${spec.active.phase} phase`) });
  }
  if (!livePanes) next.push({ cmd: 'mora up', why: t('abre el equipo en paneles', 'open the crew in panes') });
  const active = (tasks.byStatus.sent || 0) + (tasks.byStatus.running || 0);
  if (active && livePanes) next.push({ cmd: 'mora board', why: t(`${active} tarea(s) en curso`, `${active} task(s) in flight`) });
  if (!cfg.brain?.vault) next.push({ cmd: 'mora brain link', why: t('conecta tu vault de Obsidian', 'connect your Obsidian vault') });
  if (!next.length) next.push({ cmd: 'mora dispatch <rol> "…"', why: t('todo en orden: reparte la siguiente tarea', 'all clear: hand out the next task') });
  return next;
}

export async function collect(root) {
  const cfg = loadConfig(root);
  const catalog = await cliCatalog();
  const panes = await paneStatus(root);
  const crew = Object.entries(cfg.crew || {}).map(([role, m]) => {
    const info = catalog.find((x) => x.id === m.cli);
    return { role, cli: m.cli, label: info?.label || m.cli, installed: !!info?.installed, install: info?.install || null, pane: panes[role] || null };
  });
  const tasks = taskSummary(readTasks(root));
  const spec = await activeSpec(root);
  const data = {
    ok: true, root, project: cfg.project, goal: readGoal(root, cfg), preset: cfg.preset, lang: cfg.lang,
    crew, tasks, memory: memoryCounts(root), spec: spec.active, specs: spec.count,
    brain: { vault: cfg.brain?.vault || null, mode: cfg.brain?.mode || null },
  };
  data.next = suggestNext({ tasks, panes, cfg, spec });
  return data;
}

function paneLabel(pane) {
  if (!pane) return c.dim(t('sin panel', 'no pane'));
  if (pane.alive === false) return c.red(t(`panel caído (${pane.mux})`, `pane down (${pane.mux})`));
  return c.green(`${pane.mux}${pane.handle ? c.dim(' ' + String(pane.handle).slice(0, 14)) : ''}`);
}

const label = (s) => c.bold(s.padEnd(9));

function render(d) {
  const tagCount = (n, label, color) => (n ? color(`${n} ${label}`) : c.dim(`0 ${label}`));
  out(bannerSmall({ version: version() }));
  out();
  out(`${c.bold(d.project)} ${c.dim(`· ${d.preset} · ${d.lang}`)}`);
  out(d.goal ? `  ${d.goal}` : c.dim(t('  (sin objetivo — edita .moragent/memory/canonical/project.md)', '  (no goal — edit .moragent/memory/canonical/project.md)')));
  out();
  out(c.bold(t('Equipo', 'Crew')));
  out(table(d.crew.map((m) => [
    m.installed ? c.green('✓') : c.red('✗'), c.bold(m.role), m.label,
    m.installed ? paneLabel(m.pane) : c.yellow(m.install || t('no instalado', 'not installed')),
  ]), null, { indent: '  ' }));
  out();
  const s = d.tasks.byStatus;
  out(`${label(t('Tareas', 'Tasks'))}${[
    tagCount(s.queued, t('en cola', 'queued'), c.gray),
    tagCount(s.sent + s.running, t('en curso', 'in flight'), c.cyan),
    tagCount(s.done, t('listas', 'done'), c.green),
    tagCount(s.blocked + s.failed, t('bloqueadas', 'blocked'), c.red),
  ].join(c.dim(' · '))}`);
  const m = d.memory;
  out(`${label(t('Memoria', 'Memory'))}${c.dim(t('canónica', 'canonical'))} ${m.canonical}  ${c.dim(t('episódica', 'episodic'))} ${m.episodic}  ${c.dim(t('transitoria', 'transient'))} ${m.transient}  ${c.dim('skills')} ${m.skills}`);
  out(`${label('Spec')}${d.spec ? `${d.spec.slug} ${c.dim('→')} ${c.brand(d.spec.phase || '?')}${d.specs > 1 ? c.dim(t(`  (+${d.specs - 1} más)`, `  (+${d.specs - 1} more)`)) : ''}` : c.dim(t('ninguna activa', 'none active'))}`);
  out(`${label('Brain')}${d.brain.vault ? `${d.brain.vault} ${c.dim(`(${d.brain.mode})`)}` : c.dim(t('sin vault de Obsidian', 'no Obsidian vault'))}`);
  out();
  out(c.bold(t('Siguiente paso sugerido', 'Suggested next step')));
  d.next.slice(0, 3).forEach((n, i) => out(`  ${i ? ' ' : c.brand('›')} ${(i ? c.cyan : (x) => c.brand(c.bold(x)))(n.cmd.padEnd(24))} ${c.dim(n.why)}`));
  out(c.dim(`\n  mora help  ·  mora board  ·  mora doctor`));
}

export default {
  name: 'dashboard',
  aliases: ['status', 'st'],
  group: 'start',
  summary: { es: 'Estado del proyecto: equipo, tareas, memoria y siguiente paso', en: 'Project status: crew, tasks, memory and next step' },
  usage: 'mora [dashboard|status] [--json]',
  async run(argv, ctx) {
    const root = ctx.root || requireRoot();
    const data = await collect(root);
    if (ctx.json) json(data);
    else render(data);
    return 0;
  },
};
