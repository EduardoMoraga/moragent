import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { c as defaultColors, plain } from '../core/log.js';

const PKG_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');

export const LOGO = [
  '█▀▄▀█ █▀█ █▀█ ▄▀█ █▀▀ █▀▀ █▄ █ ▀█▀',
  '█ ▀ █ █▄█ █▀▄ █▀█ █▄█ ██▄ █ ▀█  █ ',
];

export function getVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
    return pkg.version || '5.2.0';
  } catch {
    return '5.2.0';
  }
}

export const COMMANDS = [
  {
    name: 'login',
    aliases: [],
    args: '[motor]',
    es: 'conectar suscripciones o API keys',
    en: 'connect subscriptions or API keys',
    group: 'config',
  },
  {
    name: 'orquestador',
    aliases: ['orchestrator'],
    args: '[motor]',
    es: 'elegir o cambiar el motor del orquestador',
    en: 'pick or change the orchestrator engine',
    group: 'config',
  },
  {
    name: 'modelo',
    aliases: ['model'],
    args: '[rol] <nombre>',
    es: 'ver o cambiar el modelo (del orquestador o de un rol)',
    en: 'show or change the model (orchestrator or a role)',
    group: 'config',
  },
  {
    name: 'equipo',
    aliases: ['crew'],
    args: '[rol] [motor]',
    es: 'ver el equipo o cambiar el motor de un rol',
    en: 'show the crew or change a role\'s engine',
    group: 'config',
  },
  {
    name: 'memoria',
    aliases: ['memory'],
    args: '[texto]',
    es: 'ver resumen de memoria o buscar notas',
    en: 'view memory summary or search notes',
    group: 'project',
  },
  {
    name: 'plan',
    aliases: [],
    args: '<texto>',
    es: 'pedir un plan explícito al orquestador',
    en: 'ask the orchestrator for an explicit plan',
    group: 'chat',
  },
  {
    name: 'tarea',
    aliases: ['desplegar', 'task', 'deploy'],
    args: '<rol> <texto>',
    es: 'desplegar un agente ahora',
    en: 'deploy an agent right now',
    group: 'agents',
  },
  {
    name: 'abrir',
    aliases: ['open'],
    args: '<rol|id>',
    es: 'sacar un subagente a un panel externo de terminal',
    en: 'open a subagent in an external terminal pane',
    group: 'agents',
  },
  {
    name: 'agentes',
    aliases: ['agents'],
    args: '[rol|id]',
    es: 'estado de los subagentes (Tab: detalle en vivo)',
    en: 'subagent status (Tab: live detail)',
    group: 'agents',
  },
  {
    name: 'estado',
    aliases: ['status'],
    args: '[id]',
    es: 'estado local de tareas y próxima acción (solo lectura)',
    en: 'local task health and next action (read-only)',
    group: 'agents',
  },
  {
    name: 'sesiones',
    aliases: ['sessions'],
    args: '',
    es: 'ver conversaciones guardadas',
    en: 'view saved conversations',
    group: 'session',
  },
  {
    name: 'sesion',
    aliases: ['session'],
    args: '<n|id>',
    es: 'retomar una conversación anterior conservando contexto',
    en: 'resume a previous conversation keeping context',
    group: 'session',
  },
  {
    name: 'limpiar',
    aliases: ['clear'],
    args: '',
    es: 'empezar una nueva conversación vacía',
    en: 'start a fresh empty conversation',
    group: 'session',
  },
  {
    name: 'nuevo',
    aliases: ['new'],
    args: '',
    es: 'crear un proyecto MORAGENT nuevo en esta carpeta',
    en: 'create a new MORAGENT project in this folder',
    group: 'project',
  },
  {
    name: 'cancel',
    aliases: ['cancelar'],
    args: '',
    es: 'cancelar el trabajo o tarea en curso',
    en: 'cancel running work',
    group: 'chat',
  },
  {
    name: 'help',
    aliases: ['ayuda'],
    args: '',
    es: 'mostrar comandos disponibles y ayuda',
    en: 'show available commands and help',
    group: 'general',
  },
  {
    name: 'salir',
    aliases: ['exit', 'quit'],
    args: '',
    es: 'salir de moragent (Ctrl+C dos veces)',
    en: 'exit moragent (Ctrl+C twice)',
    group: 'general',
  },
  {
    name: 'mouse',
    aliases: [],
    args: '',
    es: 'activar o desactivar el soporte de ratón en terminal',
    en: 'toggle terminal mouse support',
    group: 'general',
  },
];

export function findCommand(nameOrAlias) {
  if (!nameOrAlias) return null;
  const raw = String(nameOrAlias).trim().replace(/^\//, '').toLowerCase();
  if (!raw) return null;
  return COMMANDS.find((cmd) => cmd.name === raw || (cmd.aliases && cmd.aliases.includes(raw))) || null;
}

export function matchCommands(prefix) {
  const p = String(prefix || '').trim().replace(/^\//, '').toLowerCase();
  if (!p) return [...COMMANDS];
  return COMMANDS.filter((cmd) => {
    if (cmd.name.startsWith(p)) return true;
    return cmd.aliases && cmd.aliases.some((a) => a.startsWith(p));
  });
}

function sliceAnsi(str, max) {
  let visible = 0;
  let res = '';
  let inEsc = false;
  let hadEsc = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '\x1b') {
      inEsc = true;
      hadEsc = true;
      res += ch;
      continue;
    }
    if (inEsc) {
      res += ch;
      if (ch === 'm') inEsc = false;
      continue;
    }
    if (visible >= max) break;
    res += ch;
    visible++;
  }
  return hadEsc ? res + '\x1b[0m' : res;
}

export function welcomeLines(state = {}, options = {}) {
  const cols = typeof options === 'number' ? options : Math.max(1, options?.cols || 80);
  const colors = options?.c || defaultColors;
  const version = options?.version || state?.version || getVersion();
  const isEs = (state?.lang || 'es') !== 'en';

  const out = [];

  // 1. Logo & version
  if (cols < 40) {
    const brandMoragent = colors.brand ? colors.brand(colors.bold('MORAGENT')) : 'MORAGENT';
    const dimVersion = colors.dim ? colors.dim(`v${version}`) : `v${version}`;
    out.push(` ${brandMoragent} ${dimVersion}`);
  } else {
    const l1 = LOGO[0];
    const l2 = LOGO[1].trimEnd();
    const brandL1 = colors.brand ? colors.brand(l1) : l1;
    const brandL2 = colors.brand ? colors.brand(l2) : l2;
    const dimVersion = colors.dim ? colors.dim(`v${version}`) : `v${version}`;

    out.push(` ${brandL1}`);
    out.push(` ${brandL2}   ${dimVersion}`);
  }

  // 2. Project · orchestrator (engine + model)
  const project = state?.project || (isEs ? 'sin proyecto' : 'no project');
  const orchEngine = state?.orchestrator?.provider || (isEs ? 'sin motor' : 'no engine');
  const orchModel = state?.orchestrator?.activeModel || state?.orchestrator?.model || '';
  const orchLabel = isEs ? 'orquestador' : 'orchestrator';
  const modelPart = orchModel ? ` (${orchModel})` : '';

  out.push(` ${project} · ${orchLabel} ${orchEngine}${modelPart}`);

  // 3. Connected engines (✓/○)
  const connLabel = isEs ? 'conectados:' : 'connected:';
  const providers = Array.isArray(state?.providers) ? state.providers : [];
  if (providers.length > 0) {
    const items = providers.map((p) => {
      const mark = p.ready
        ? (colors.green ? colors.green('✓') : '✓')
        : (colors.dim ? colors.dim('○') : '○');
      return `${p.id} ${mark}`;
    });
    out.push(` ${connLabel} ${items.join(' ')}`);
  } else {
    const noneText = isEs ? '(ninguno: usa /login)' : '(none: use /login)';
    out.push(` ${connLabel} ${noneText}`);
  }

  // 4. One line of tips
  const tips = isEs
    ? 'pide algo o /tarea backend … · / comandos · Tab agentes'
    : 'ask or /task backend … · / commands · Tab agents';
  out.push(` ${tips}`);

  // Guarantee visible width <= cols on all returned lines
  return out.map((line) => (plain(line).length <= cols ? line : sliceAnsi(line, cols)));
}
