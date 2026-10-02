import path from 'node:path';
import { readJSON, writeJSON } from './fsx.js';
import { dirs } from './paths.js';
import { MoragentError } from './errors.js';

export const CLI_IDS = ['claude', 'codex', 'agy', 'pi', 'opencode', 'gemini'];

// Role names become object keys and are used in local run/context paths. Keep them
// predictable and reject inherited Object keys even when a caller supplies a plain object.
const ROLE_ID = /^[a-z][a-z0-9_-]{0,39}$/;
const RESERVED_ROLE_NAMES = new Set(['lead', ...Object.getOwnPropertyNames(Object.prototype)]);
export const isValidWorkerRole = (name) => typeof name === 'string'
  && ROLE_ID.test(name)
  && !RESERVED_ROLE_NAMES.has(name);

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
  executor: {
    title: 'Executor',
    mission: {
      es: 'Produce entregables concretos según la solicitud y verifica el resultado.',
      en: 'Produce concrete deliverables for the request and verify the result.',
    },
  },
  researcher: {
    title: 'Researcher',
    mission: {
      es: 'Investiga fuentes y contexto; comunica hallazgos con procedencia y dudas.',
      en: 'Research sources and context; report findings with provenance and uncertainties.',
    },
  },
  reviewer: {
    title: 'Reviewer',
    mission: {
      es: 'Revisa el trabajo de otros, comprueba evidencia y detecta problemas concretos.',
      en: 'Review others’ work, check evidence, and find concrete issues.',
    },
  },
};

export const PRESETS = {
  solo: { roles: ['lead'], summary: { es: '1 agente — cambios chicos', en: '1 agent — small changes' } },
  duo: { roles: ['lead', 'backend'], summary: { es: 'Lead + backend — una feature', en: 'Lead + backend — one feature' } },
  trio: { roles: ['lead', 'backend', 'frontend'], summary: { es: 'Lead + backend + frontend — producto full-stack', en: 'Lead + backend + frontend — full-stack product' } },
  squad: { roles: ['lead', 'backend', 'frontend', 'helper', 'dev'], summary: { es: '5 agentes — proyecto completo', en: '5 agents — complete project' } },
  adaptive: { roles: ['lead', 'executor', 'researcher', 'reviewer'], summary: { es: 'Equipo adaptable para cualquier proyecto', en: 'Adaptable crew for any project' } },
};

// Default CLI per role; `init` swaps in whatever is actually installed.
export const DEFAULT_CLI = { lead: 'claude', backend: 'codex', frontend: 'claude', helper: 'agy', dev: 'pi', executor: 'codex', researcher: 'pi', reviewer: 'claude' };

export function defaultConfig({ project, lang = 'es', preset = 'adaptive', clis = {} } = {}) {
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
