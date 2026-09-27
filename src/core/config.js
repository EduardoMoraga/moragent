import path from 'node:path';
import { readJSON, writeJSON } from './fsx.js';
import { dirs } from './paths.js';
import { MoragentError } from './errors.js';

export const CLI_IDS = ['claude', 'codex', 'agy', 'pi', 'opencode', 'gemini'];

// Default missions per role. The lead is the executive: it plans, dispatches, integrates, never
// disappears into implementation.
export const ROLES = {
  lead: {
    title: 'Lead',
    mission: {
      es: 'Orquestador ejecutivo. Entiende el objetivo, dimensiona el alcance, escribe la spec, reparte tareas con `mora dispatch`, espera con `mora wait`, integra y verifica. No implementa lo que puede delegar.',
      en: 'Executive orchestrator. Understands the goal, sizes scope, writes the spec, dispatches tasks with `mora dispatch`, waits with `mora wait`, integrates and verifies. Does not implement what it can delegate.',
    },
  },
  backend: {
    title: 'Backend',
    mission: {
      es: 'Backend: APIs, datos, lógica de negocio, integraciones, rendimiento y seguridad del lado servidor.',
      en: 'Backend: APIs, data, business logic, integrations, server-side performance and security.',
    },
  },
  frontend: {
    title: 'Frontend',
    mission: {
      es: 'Frontend: interfaz, experiencia de usuario, accesibilidad, diseño visual y documentación de cara al usuario.',
      en: 'Frontend: interface, user experience, accessibility, visual design and user-facing docs.',
    },
  },
  helper: {
    title: 'Helper',
    mission: {
      es: 'Ayudante: investigación, revisión cruzada, pruebas y verificación independiente del trabajo de otros.',
      en: 'Helper: research, cross review, tests and independent verification of other members\' work.',
    },
  },
  dev: {
    title: 'Dev',
    mission: {
      es: 'Dev: tooling, scripts, empaquetado, CI/CD, instaladores y todo lo que hace que el proyecto se instale y corra.',
      en: 'Dev: tooling, scripts, packaging, CI/CD, installers and everything that makes the project install and run.',
    },
  },
};

export const PRESETS = {
  solo: { roles: ['lead'], summary: { es: '1 agente — cambios chicos', en: '1 agent — small changes' } },
  duo: { roles: ['lead', 'backend'], summary: { es: 'Lead + backend — una feature', en: 'Lead + backend — one feature' } },
  trio: { roles: ['lead', 'backend', 'frontend'], summary: { es: 'Lead + backend + frontend — producto full-stack', en: 'Lead + backend + frontend — full-stack product' } },
  squad: { roles: ['lead', 'backend', 'frontend', 'helper', 'dev'], summary: { es: '5 agentes — proyecto completo', en: '5 agents — complete project' } },
};

// Default CLI per role; `init` swaps in whatever is actually installed.
export const DEFAULT_CLI = { lead: 'claude', backend: 'codex', frontend: 'claude', helper: 'agy', dev: 'pi' };

export function defaultConfig({ project, lang = 'es', preset = 'squad', clis = {} } = {}) {
  if (!PRESETS[preset]) throw new MoragentError('BAD_PRESET', `Unknown preset: ${preset}`, Object.keys(PRESETS).join(' | '));
  const crew = {};
  for (const role of PRESETS[preset].roles) {
    crew[role] = { cli: clis[role] || DEFAULT_CLI[role], title: ROLES[role].title, mission: ROLES[role].mission[lang] || ROLES[role].mission.en };
  }
  return {
    version: 1,
    project: project || 'project',
    lang,
    mux: 'auto',
    preset,
    crew,
    memory: { transientDays: 7, episodicInContext: 8 },
    brain: { vault: null, folder: 'Moragent', mode: 'link' },
  };
}

export function loadConfig(root) {
  const p = dirs(root).config;
  const cfg = readJSON(p, null);
  if (!cfg) throw new MoragentError('BAD_CONFIG', `Cannot read ${path.relative(root, p)}`, 'mora init --force');
  return cfg;
}

export const saveConfig = (root, cfg) => writeJSON(dirs(root).config, cfg);

export const crewRoles = (cfg) => Object.keys(cfg.crew || {});
