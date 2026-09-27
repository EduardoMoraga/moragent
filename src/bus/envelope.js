import { moraCommand } from '../core/hooks.js';
import path from 'node:path';
import { dirs } from '../core/paths.js';
import { readText, writeText } from '../core/fsx.js';

const clip = (text, size = 5000) => String(text || '').trim().slice(0, size);

async function memoryContext(root, task) {
  try {
    const mod = await import(new URL('../memory/index.js', import.meta.url).href);
    if (typeof mod.contextPack !== 'function') return '';
    return clip(await mod.contextPack({ root, role: task.role, query: task.body }), 6000);
  } catch { return ''; }
}

function specContext(root, slug) {
  if (!slug) return '';
  const base = path.join(dirs(root).specs, slug);
  const parts = [];
  for (const name of ['spec.md', 'tasks.md']) {
    const body = clip(readText(path.join(base, name)), 3500);
    if (body) parts.push(`### ${name}\n\n${body}`);
  }
  return parts.join('\n\n');
}

// exitProtocol=false: the native engine closes the task itself from the agent's final answer.
export async function buildEnvelope({ root, task, config, exitProtocol = true }) {
  const es = config.lang !== 'en';
  const member = config.crew?.[task.role] || {};
  const mission = typeof member.mission === 'object'
    ? member.mission[config.lang] || member.mission.en || member.mission.es
    : member.mission;
  const spec = specContext(root, task.spec);
  const memory = await memoryContext(root, task);
  const sections = [
    `# ${task.id} — ${task.title}`,
    `## ${es ? 'Misión del rol' : 'Role mission'}\n\n${mission || (es ? 'Ejecuta esta tarea dentro de tu especialidad.' : 'Execute this task within your specialty.')}`,
    `## ${es ? 'Tarea' : 'Task'}\n\n${task.body}`,
  ];
  if (spec) sections.push(`## ${es ? 'Extracto de la spec' : 'Spec excerpt'}\n\n${spec}`);
  if (memory) sections.push(`## ${es ? 'Contexto de memoria' : 'Memory context'}\n\n${memory}`);
  sections.push(`## ${es ? 'Criterios de aceptación' : 'Acceptance criteria'}

- ${es ? 'La tarea está implementada y verificada.' : 'The task is implemented and verified.'}
- ${es ? 'Los cambios se limitan al alcance indicado.' : 'Changes stay within the stated scope.'}
- ${es ? 'Las pruebas relevantes pasan o los riesgos quedan documentados.' : 'Relevant tests pass or risks are documented.'}`);
  if (!exitProtocol) {
    sections.push(`## ${es ? 'Al terminar' : 'When you finish'}\n\n${es
      ? 'Termina con un resumen breve: qué cambiaste (archivos) y cómo se verifica. No ejecutes `mora done` ni `mora block`: MORAGENT cierra la tarea con tu respuesta final. Si no puedes completarla, empieza tu respuesta final con `BLOQUEADO:` y explica qué falta.'
      : 'End with a short summary: what you changed (files) and how to verify it. Do not run `mora done` or `mora block`: MORAGENT closes the task from your final answer. If you cannot complete it, start your final answer with `BLOCKED:` and explain what is missing.'}`);
  } else {
    sections.push(`## ${es ? 'Protocolo de salida' : 'Exit protocol'}

  ${es ? 'Al terminar ejecuta' : 'When finished run'}:

  \`${moraCommand()} done ${task.id} --summary "…" --files a,b\`

  ${es ? 'Si quedas bloqueado, ejecuta' : 'If blocked, run'}:

  \`${moraCommand()} block ${task.id} --reason "…"\``);
  }
  return sections.join('\n\n') + '\n';
}

export async function writeEnvelope({ root, task, config }) {
  const file = path.join(dirs(root).tasks, `${task.id}.md`);
  writeText(file, await buildEnvelope({ root, task, config }));
  return file;
}
