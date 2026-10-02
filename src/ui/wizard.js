import { createPrompter } from './prompt.js';
import { banner } from './banner.js';
import { cliCatalog } from './clis.js';
import { table } from './table.js';
import { assignClis } from '../commands/init.js';
import { setLang, t, tr } from '../core/i18n.js';
import { c } from '../core/log.js';

// What each role does, in words for someone who never used an agentic terminal.
const ROLE_PLAIN = {
  lead: { es: 'coordina: entiende la meta, reparte el trabajo y revisa', en: 'coordinates: understands the goal, splits the work, reviews' },
  backend: { es: 'lógica, datos y APIs', en: 'logic, data and APIs' },
  frontend: { es: 'pantallas, diseño y textos para el usuario', en: 'screens, design and user-facing text' },
  helper: { es: 'investiga, prueba y revisa el trabajo de otros', en: 'researches, tests and reviews others\' work' },
  dev: { es: 'instalación, scripts y automatización', en: 'install, scripts and automation' },
  executor: { es: 'produce y verifica entregables', en: 'builds and verifies deliverables' },
  researcher: { es: 'investiga fuentes y contexto', en: 'researches sources and context' },
  reviewer: { es: 'revisa evidencia y resultados', en: 'reviews evidence and results' },
};

const PRESET_PLAIN = {
  solo: { es: 'un agente; ideal para arreglos y cambios chicos', en: 'one agent; best for fixes and small changes' },
  duo: { es: 'un coordinador y un ejecutor; una funcionalidad a la vez', en: 'a coordinator and a builder; one feature at a time' },
  trio: { es: 'coordinador + backend + frontend; una app completa', en: 'coordinator + backend + frontend; a full app' },
  squad: { es: 'equipo completo de 5; proyectos grandes o de varias partes', en: 'full crew of 5; large or multi-part projects' },
  adaptive: { es: 'coordinación, ejecución, investigación y revisión; cualquier proyecto', en: 'coordination, execution, research and review; any project' },
};

// Interactive `mora init`. Returns answers for init, or null when the user cancels.
// `input`/`output` are injectable so tests can drive it with streams.
export async function runWizard({ defaults = {}, installed = [], presets = {}, input, output, catalog } = {}) {
  const p = createPrompter({ input, output });
  const say = (s = '') => p.write(s + '\n');
  try {
    say();
    say(banner());
    say();

    const lang = await p.select('Idioma / Language', [
      { value: 'es', label: 'Español' },
      { value: 'en', label: 'English' },
    ], defaults.lang === 'en' ? 'en' : 'es');
    setLang(lang);
    say();

    const project = (await p.ask(t('Nombre del proyecto', 'Project name'), defaults.project || 'my-app')).replace(/\s+/g, '-');
    say();

    say(c.dim(t('  En una frase, como se lo explicarías a un colega. Puedes dejarlo vacío.', '  One sentence, the way you would tell a colleague. You can leave it empty.')));
    const goal = await p.ask(t('¿Qué quieres lograr?', 'What do you want to accomplish?'), defaults.goal || '');
    say();

    const presetIds = Object.keys(presets).length ? Object.keys(presets) : ['solo', 'duo', 'trio', 'squad', 'adaptive'];
    say(c.dim(t('  Cada agente es un asistente de IA en su propio panel. Trabajan en paralelo y se pasan tareas.', '  Each agent is an AI assistant in its own pane. They work in parallel and hand tasks to each other.')));
    const preset = await p.select(t('¿Qué tamaño de equipo?', 'How big a crew?'), presetIds.map((id) => ({
      value: id,
      label: `${id.padEnd(6)} ${c.dim(`${(presets[id]?.roles || [id]).length}×`)}`,
      hint: tr(PRESET_PLAIN[id]) || tr(presets[id]?.summary),
    })), presets[defaults.preset] ? defaults.preset : presetIds[presetIds.length - 1]);
    say();

    const roles = presets[preset]?.roles || ['lead'];
    const clis = assignClis(roles, installed, defaults.clis || {});
    const cat = catalog || await cliCatalog();
    const label = (id) => cat.find((x) => x.id === id)?.label || id;
    say(c.bold(t('Tu equipo', 'Your crew')));
    say(table(roles.map((role) => [
      installed.includes(clis[role]) ? c.green('●') : c.yellow('○'),
      c.bold(role),
      label(clis[role]),
      c.dim(tr(ROLE_PLAIN[role]) || ''),
    ]), null, { indent: '  ' }));
    say();

    const missing = cat.filter((x) => !installed.includes(x.id));
    say(`${c.bold(t('CLIs detectados', 'Detected CLIs'))}  ${installed.length ? installed.map((id) => c.green('✓ ' + label(id))).join('  ') : c.yellow(t('ninguno', 'none'))}`);
    if (missing.length) {
      say(c.dim(t('  Faltan (opcional, instala los que quieras usar):', '  Missing (optional, install the ones you want):')));
      say(table(missing.map((x) => [c.yellow('○'), x.label, c.cyan(x.install || x.docs || '')]), null, { indent: '  ' }));
    }
    if (!installed.length) say(c.yellow(t('  Necesitas al menos uno. El más simple: npm i -g @anthropic-ai/claude-code', '  You need at least one. Easiest: npm i -g @anthropic-ai/claude-code')));
    say(c.dim(t('  Puedes cambiar quién hace qué después: mora crew set <rol> <cli>', '  You can change who does what later: mora crew set <role> <cli>')));
    say();

    const go = await p.confirm(t(`¿Creo el proyecto ${project} aquí?`, `Create project ${project} here?`), true);
    if (!go) { say(c.dim(t('Cancelado. No se escribió nada.', 'Cancelled. Nothing was written.'))); return null; }
    return { project, lang, preset, goal, clis: defaults.clis || {} };
  } finally {
    p.close();
  }
}
