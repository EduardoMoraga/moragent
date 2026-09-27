import path from 'node:path';
import fs from 'node:fs';
import { TEMPLATES, dirs } from '../core/paths.js';
import { ensureDir, exists, readText, writeText, readJSON, writeJSON, slugify, nowISO } from '../core/fsx.js';
import { MoragentError } from '../core/errors.js';
import { t } from '../core/i18n.js';

export const PHASES = ['explore', 'propose', 'spec', 'design', 'tasks', 'apply', 'verify', 'archive'];
const FILES = ['proposal.md', 'spec.md', 'design.md', 'tasks.md'];

export function newSpec({ root, slug, title, lang = 'es' }) {
  if (!root) throw new MoragentError('NO_PROJECT', 'No MORAGENT project here / No hay proyecto MORAGENT aquí', 'mora init');
  const id = slugify(slug || title || 'spec');
  const dir = path.join(dirs(root).specs, id);
  if (exists(dir)) throw new MoragentError('SPEC_EXISTS', `Spec already exists / La spec ya existe: ${id}`, `mora spec status ${id}`);
  ensureDir(dir);
  const locale = lang === 'en' ? 'en' : 'es';
  for (const file of FILES) {
    const src = path.join(TEMPLATES, 'spec', locale, file);
    const body = readText(src)
      .replaceAll('{{slug}}', id)
      .replaceAll('{{title}}', title || id)
      .replaceAll('{{createdAt}}', nowISO());
    writeText(path.join(dir, file), body);
  }
  writeJSON(path.join(dir, 'state.json'), { slug: id, title: title || id, createdAt: nowISO(), archived: false });
  return dir;
}

export function specState(root, slug) {
  const dir = specDir(root, slug);
  const proposal = readText(path.join(dir, 'proposal.md'));
  const spec = readText(path.join(dir, 'spec.md'));
  const design = readText(path.join(dir, 'design.md'));
  const tasks = readText(path.join(dir, 'tasks.md'));
  const state = readJSON(path.join(dir, 'state.json'), {});
  const done = ['explore'];
  if (proposalDone(proposal)) done.push('propose');
  if (specDone(spec)) done.push('spec');
  if (designDone(design)) done.push('design');
  if (tasksDone(tasks)) done.push('tasks');
  if (done.includes('tasks') && allTasksChecked(tasks)) done.push('apply');
  if (verifyDone(tasks) || verifyDone(design) || verifyDone(spec)) done.push('verify');
  if (state.archived) done.push('archive');
  const phase = state.archived ? 'archive' : nextPhase(done);
  return { phase, done, next: phase, hint: hintFor(root, slug, phase) };
}

export const advance = (root, slug) => specState(root, slug);

export function tasksFromSpec(root, slug) {
  const text = readText(path.join(specDir(root, slug), 'tasks.md'));
  return parseTasks(text);
}

export function archiveSpec(root, slug) {
  const dir = specDir(root, slug);
  const statePath = path.join(dir, 'state.json');
  const state = readJSON(statePath, {});
  state.archived = true;
  state.archivedAt = nowISO();
  writeJSON(statePath, state);
  return specState(root, slug);
}

export function listSpecs(root) {
  const base = dirs(root).specs;
  if (!exists(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ slug: e.name, ...specState(root, e.name) }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

function specDir(root, slug) {
  const dir = path.join(dirs(root).specs, slugify(slug));
  if (!exists(dir)) throw new MoragentError('SPEC_NOT_FOUND', `Spec not found / Spec no encontrada: ${slug}`, 'mora spec status');
  return dir;
}

function proposalDone(text) { return !!text.trim() && !/TODO:/i.test(text); }
function specDone(text) { return !/TODO:/i.test(text) && /^\s*[-*]?\s*RF-\d+\s*[:.-]\s*(Cuando .+?, el sistema debe .+|When .+?, the system shall .+)/im.test(text); }
function designDone(text) { return !!text.trim() && !/TODO:/i.test(text); }
function tasksDone(text) { return !/TODO:/i.test(text) && parseTasks(text).length > 0; }
function allTasksChecked(text) {
  const tasks = parseTasks(text);
  return tasks.length > 0 && tasks.every((task) => task.done);
}
function parseTasks(text) {
  const tasks = [];
  const re = /^- \[( |x|X)\]\s*(?:T\d*:?\s*)?(.+?)\s+@([a-z][a-z0-9_-]*)\s+[—-]\s+(?:Done when|Listo cuando):\s*(.+)$/gm;
  let m;
  while ((m = re.exec(text))) {
    const title = m[2].trim();
    const role = m[3].trim();
    const doneWhen = m[4].trim();
    if (hasPlaceholder(title) || hasPlaceholder(role) || hasPlaceholder(doneWhen)) continue;
    tasks.push({ title, role, doneWhen, done: m[1].toLowerCase() === 'x' });
  }
  return tasks;
}
function hasPlaceholder(s) { return /<[^>]+>/.test(s); }
function verifyDone(text) { return !/TODO:/i.test(text) && /^##\s*(Verificación|Verification)\s*\n[\s\S]*\S/im.test(text); }
function nextPhase(done) { return PHASES.slice(1).find((p) => !done.includes(p)) || 'archive'; }

function hintFor(root, slug, phase) {
  const dir = path.join(dirs(root).specs, slugify(slug));
  const rel = path.relative(root, dir);
  const prompts = {
    propose: t(`Edita ${rel}/proposal.md. Prompt: Explora el problema, define objetivo, usuarios, alcance y riesgos. Elimina todos los TODO:.`, `Edit ${rel}/proposal.md. Prompt: Explore the problem, define goal, users, scope and risks. Remove every TODO:.`),
    spec: t(`Edita ${rel}/spec.md. Prompt: Convierte la propuesta en requisitos EARS RF-n: "Cuando <evento>, el sistema debe <respuesta>".`, `Edit ${rel}/spec.md. Prompt: Turn the proposal into EARS RF-n requirements: "When <trigger>, the system shall <response>".`),
    design: t(`Edita ${rel}/design.md. Prompt: Diseña arquitectura, flujos, datos, riesgos y validación. Elimina todos los TODO:.`, `Edit ${rel}/design.md. Prompt: Design architecture, flows, data, risks and validation. Remove every TODO:.`),
    tasks: t(`Edita ${rel}/tasks.md. Prompt: Divide el diseño en tareas: - [ ] T1: <título> @rol — Done when: <criterio>.`, `Edit ${rel}/tasks.md. Prompt: Split the design into tasks: - [ ] T1: <title> @role — Done when: <criterion>.`),
    apply: t(`Ejecuta las tareas de ${rel}/tasks.md y marca cada casilla [x] cuando cumpla su Done when.`, `Execute the tasks in ${rel}/tasks.md and mark each box [x] when its Done when is met.`),
    verify: t(`Agrega en ${rel}/tasks.md una sección ## Verificación con resultado, comandos ejecutados y evidencia.`, `Add a ## Verification section to ${rel}/tasks.md with result, commands run and evidence.`),
    archive: t(`Archiva con: mora spec archive ${slug}.`, `Archive with: mora spec archive ${slug}.`),
  };
  return prompts[phase] || t(`Crea/actualiza ${rel}.`, `Create/update ${rel}.`);
}
