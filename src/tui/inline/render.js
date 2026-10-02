import { c, plain } from '../../core/log.js';
import { renderMarkdown } from '../markdown.js';
import { terminalText } from '../terminal-text.js';
import { cellWidth, clipCells, graphemes } from '../cell-width.js';

const safeLine = (value) => terminalText(value, { singleLine: true });

export const DEFAULT_COMMANDS = [
  { name: '/tarea', aliases: ['/task', '/desplegar'], es: 'desplegar un agente directo', en: 'deploy one agent directly' },
  { name: '/login', es: 'conectar suscripciones o API keys', en: 'connect subscriptions or API keys' },
  { name: '/equipo', aliases: ['/crew'], es: 'ver o cambiar el equipo', en: 'show or change the crew' },
  { name: '/orquestador', aliases: ['/orchestrator'], es: 'elegir motor', en: 'pick the orchestrator engine' },
  { name: '/modelo', aliases: ['/model'], es: 'ver o cambiar modelo', en: 'show or change model' },
  { name: '/memoria', aliases: ['/memory'], es: 'ver o buscar memoria', en: 'show or search memory' },
  { name: '/sesiones', aliases: ['/sessions'], es: 'ver sesiones guardadas', en: 'show saved sessions' },
  { name: '/sesion', aliases: ['/session'], es: 'retomar sesión', en: 'resume session' },
  { name: '/limpiar', aliases: ['/clear'], es: 'empezar de cero', en: 'start fresh' },
  { name: '/agentes', aliases: ['/agents'], es: 'ver agentes o log completo', en: 'show agents or full log' },
  { name: '/plan', es: 'pedir plan explícito', en: 'ask for an explicit plan' },
  { name: '/abrir', aliases: ['/open'], es: 'abrir agente en panel', en: 'open agent in a pane' },
  { name: '/cancel', es: 'cancelar trabajo', en: 'cancel running work' },
  { name: '/help', es: 'mostrar ayuda', en: 'show help' },
  { name: '/salir', aliases: ['/exit'], es: 'salir', en: 'quit' },
];

const width = (s) => cellWidth(plain(s));
const lang = (state) => state?.lang === 'en' ? 'en' : 'es';
const tr = (state, es, en) => lang(state) === 'en' ? en : es;

export function visualRows(lines, cols) {
  return lines.reduce((n, l) => n + Math.max(1, Math.ceil(width(l) / Math.max(1, cols))), 0);
}

// Fit a line to exactly `cols` visible columns: cut with an ellipsis, or pad so box borders line up.
function clip(s, cols) {
  const p = plain(s);
  if (width(s) > cols) return clipCells(p, cols);
  return s + ' '.repeat(Math.max(0, cols - width(s)));
}

function statusGlyph(status) {
  if (status === 'done' || status === 'ready' || status === true) return c.green('✓');
  if (status === 'failed') return c.red('✗');
  if (status === 'blocked') return c.yellow('!');
  if (status === 'preparing') return c.brand('◐');
  if (status === 'running' || status === 'thinking' || status === 'reviewing') return c.brand('●');
  return c.gray('○');
}

export function formatElapsed(ms) {
  if (!ms) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

function wrapText(text, cols) {
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    const rendered = renderMarkdown(raw, cols, { c });
    out.push(...rendered);
  }
  return out.length ? out : [''];
}

function draftLines(value, cursor, cols, prefix = '› ') {
  const draft = String(value ?? '');
  const at = Math.max(0, Math.min(draft.length, cursor ?? draft.length));
  const marked = `${terminalText(draft.slice(0, at))}_${terminalText(draft.slice(at))}`;
  const limit = Math.max(1, cols - width(prefix));
  const lines = [];
  for (const logical of marked.split('\n')) {
    let part = '';
    for (const char of graphemes(logical)) {
      if (width(part + char) > limit && part) {
        lines.push(`${lines.length ? ' '.repeat(width(prefix)) : prefix}${part}`);
        part = '';
      }
      part += char;
    }
    lines.push(`${lines.length ? ' '.repeat(width(prefix)) : prefix}${part}`);
  }
  return lines;
}

export function renderFinal(message, { cols = 80, lang = 'es' } = {}) {
  const body = terminalText(message.text || '');
  if (!body.trim()) return [];
  const state = { lang };
  const w = Math.max(20, cols);
  if (message.from === 'user') return wrapText(`> ${body}`, w);
  const prefix = message.from === 'system' ? `${tr(state, 'sistema', 'system')} ` : message.from === 'agent' ? `${safeLine(message.agent || tr(state, 'agente', 'agent'))} ` : '◆ ';
  const head = prefix;
  const lines = renderMarkdown(body, Math.max(8, w - width(head)), { c });
  return lines.map((l, i) => (i === 0 ? head : ' '.repeat(width(head))) + l);
}

function logo(cols) {
  if (cols < 40) return [c.brand('MORAGENT v5.3 beta')];
  return [
    c.brand('█▀▄▀█ █▀█ █▀█ ▄▀█ █▀▀ █▀▀ █▄ █ ▀█▀'),
    c.brand('█ ▀ █ █▄█ █▀▄ █▀█ █▄█ ██▄ █ ▀█  █   v5.3 beta'),
  ].map((l) => clip(l, Math.min(cols, 60)));
}

export function welcomeLines(state, { cols = 80 } = {}) {
  const o = state.orchestrator || {};
  const providers = state.providers || [];
  const ready = providers.map((p) => `${safeLine(p.id)} ${plain(statusGlyph(p.ready))}`).join(' ');
  const model = safeLine(o.model || o.activeModel || '');
  return [
    ...logo(cols),
    clip(`${safeLine(state.project || 'proyecto')} · ${tr(state, 'orquestador', 'orchestrator')} ${safeLine(o.provider || '-')}${model ? ` (${model})` : ''}`, cols),
    clip(`${tr(state, 'conectados', 'connected')}: ${ready || '-'}`, cols),
    clip(`${tr(state, 'escribe lo que necesitas', 'type what you need')} · / ${tr(state, 'comandos', 'commands')} · Tab ${tr(state, 'agentes', 'agents')}`, cols),
  ];
}

function runningAgents(state) {
  return Object.values(state.agents || {}).filter((a) => ['queued', 'preparing', 'running'].includes(a.status));
}

function crewAgents(state) {
  return Object.values(state.agents || {}).filter((a) => ['queued', 'preparing', 'running', 'done', 'failed', 'blocked'].includes(a.status));
}

function crewPanel(state, cols) {
  const agents = crewAgents(state);
  if (!agents.length) return [];
  const counts = {
    active: agents.filter((a) => ['queued', 'preparing', 'running'].includes(a.status)).length,
    done: agents.filter((a) => a.status === 'done').length,
    blocked: agents.filter((a) => a.status === 'blocked').length,
    failed: agents.filter((a) => a.status === 'failed').length,
  };
  const summary = [
    counts.active ? `${counts.active} ${tr(state, counts.active === 1 ? 'activa' : 'activas', 'active')}` : '',
    counts.done ? `${counts.done} ${tr(state, counts.done === 1 ? 'terminada' : 'terminadas', 'done')}` : '',
    counts.blocked ? `${counts.blocked} ${tr(state, counts.blocked === 1 ? 'bloqueada' : 'bloqueadas', 'blocked')}` : '',
    counts.failed ? `${counts.failed} ${tr(state, counts.failed === 1 ? 'fallida' : 'fallidas', 'failed')}` : '',
  ].filter(Boolean).join(' · ') || tr(state, 'sin tareas activas', 'no active tasks');
  const heading = ` ${tr(state, 'Equipo', 'Crew')} · ${summary} `;
  const out = [clip(`╭─${heading}${'─'.repeat(Math.max(0, cols - width(`╭─${heading}╮`))) }╮`, cols)];
  const active = agents.filter((a) => ['queued', 'preparing', 'running'].includes(a.status));
  for (const a of active) {
    const elapsedMs = ['preparing', 'running'].includes(a.status) && a.startedAt ? Date.now() - Date.parse(a.startedAt) : a.elapsedMs;
    const elapsed = elapsedMs ? ` ${formatElapsed(elapsedMs)}` : '';
    const role = safeLine(a.role || a.id);
    const task = safeLine(a.title || a.taskId || a.id);
    const detail = safeLine(a.lastLine || '');
    const row = cols < 58
      ? `${statusGlyph(a.status)} ${role} · ${safeLine(a.provider || '?')}${elapsed}`
      : `${statusGlyph(a.status)} ${role} · ${safeLine(a.provider || '?')}  ${safeLine(a.taskId || a.id)}${elapsed}  ${task}${detail && detail !== task ? ` — ${detail}` : ''}`;
    out.push(clip(`│ ${row}`, cols));
  }
  if (!active.length) {
    const latest = agents.at(-1);
    const label = latest.status === 'done' ? tr(state, 'último resultado', 'latest result') : tr(state, 'última tarea', 'latest task');
    out.push(clip(`│ ${statusGlyph(latest.status)} ${label} · ${safeLine(latest.role || latest.id)}  ${safeLine(latest.title || latest.taskId || '')}`, cols));
  }
  out.push(clip(`╰${'─'.repeat(Math.max(0, cols - 2))}╯`, cols));
  return out;
}

function agentLine(a, cols) {
  const elapsedMs = ['preparing', 'running'].includes(a.status) && a.startedAt ? Date.now() - Date.parse(a.startedAt) : a.elapsedMs;
  const elapsed = elapsedMs ? ` ${formatElapsed(elapsedMs)}` : '';
  const body = `${plain(statusGlyph(a.status))} ${safeLine(a.role || a.id)} · ${safeLine(a.provider || '?')}  ${safeLine(a.taskId || a.id)}${elapsed}  ${safeLine(a.lastLine || a.title || '')}`;
  return clip(body, cols);
}

export function filterCommands(query, commands = DEFAULT_COMMANDS) {
  const q = String(query || '').toLowerCase();
  const raw = q.startsWith('/') ? q : `/${q}`;
  const found = commands.filter((cmd) => cmd.name.startsWith(raw) || (cmd.aliases || []).some((a) => a.startsWith(raw)) || !q);
  return found.length ? found : commands;
}

function renderMenu(ui, state, cols) {
  const matches = ui.menu?.items || filterCommands(ui.input || '/', ui.commands || DEFAULT_COMMANDS);
  if (!ui.menu && !/^\/[^\s]*$/.test(ui.input || '')) return [];
  const selected = Math.min(ui.menu?.selected || 0, Math.max(0, matches.length - 1));
  const w = Math.min(cols, Math.max(28, Math.min(64, cols - 2)));
  const lines = ['╭' + '─'.repeat(w - 2) + '╮'];
  lines.push(...draftLines(ui.input || '', ui.cursor, w - 4, '> ').map((line) => '│ ' + clip(line, w - 4) + ' │'));
  const start = Math.max(0, Math.min(selected - 3, matches.length - 8));
  if (start > 0) lines.push('│ ' + clip(c.gray(`  ↑ ${start} ${tr(state, 'más', 'more')}`), w - 4) + ' │');
  for (let i = start; i < Math.min(matches.length, start + 8); i++) {
    const m = matches[i];
    const desc = lang(state) === 'en' ? m.en : m.es;
    lines.push('│ ' + clip(`${i === selected ? '›' : ' '} ${m.name.padEnd(14)} ${desc || ''}`, w - 4) + ' │');
  }
  if (start + 8 < matches.length) lines.push('│ ' + clip(c.gray(`  ↓ ${matches.length - start - 8} ${tr(state, 'más', 'more')}`), w - 4) + ' │');
  lines.push('╰' + '─'.repeat(w - 2) + '╯');
  return lines;
}

function renderPicker(ui, state, cols) {
  if (!ui.picker) return [];
  const p = ui.picker;
  const modelPicker = p.kind === 'model-orchestrator' || p.kind === 'model-role';
  const items = p.items || [];
  const w = Math.min(cols, Math.max(34, Math.min(72, cols - 2)));
  const lines = ['╭' + '─'.repeat(w - 2) + '╮'];
  lines.push('│ ' + clip(`${safeLine(p.title || tr(state, 'Elegir', 'Pick'))}  ·  ${tr(state, 'buscar', 'search')}: ${safeLine(p.query || '')}_`, w - 4) + ' │');
  // Show a window of 8 rows that follows the selection, with ↑/↓ hints when more exist.
  const sel = p.selected || 0;
  const start = Math.max(0, Math.min(sel - 3, items.length - 8));
  if (!items.length) lines.push('│ ' + clip(tr(state, 'Sin coincidencias', 'No matches'), w - 4) + ' │');
  if (start > 0) lines.push('│ ' + clip(c.gray(`  ↑ ${start} ${tr(state, 'más', 'more')}`), w - 4) + ' │');
  items.slice(start, start + 8).forEach((item, k) => {
    const i = start + k;
    // Provider readiness does not prove that this account can use a catalog
    // model. Reserve ✓ for provider pickers, where it actually means ready.
    const glyph = item.ready === false ? '○' : modelPicker ? '·' : item.ready === true ? '✓' : ' ';
    lines.push('│ ' + clip(`${i === sel ? '›' : ' '} ${glyph} ${safeLine(item.label || item.id)}${item.note ? ` · ${safeLine(item.note)}` : ''}`, w - 4) + ' │');
  });
  if (start + 8 < items.length) lines.push('│ ' + clip(c.gray(`  ↓ ${items.length - start - 8} ${tr(state, 'más', 'more')}`), w - 4) + ' │');
  if (modelPicker) lines.push('│ ' + clip(c.gray(tr(state, '· acceso al modelo sin verificar · ○ motor desconectado', '· model access unverified · ○ engine disconnected')), w - 4) + ' │');
  lines.push('╰' + '─'.repeat(w - 2) + '╯');
  return lines;
}

function statusLine(state, ui, cols) {
  const o = state.orchestrator || {};
  const busy = runningAgents(state).length;
  const model = safeLine(o.model || o.activeModel || '');
  const activity = state.recoveryApplying ? tr(state, 'aplicando recuperación', 'applying recovery')
    : busy > 0 ? `${busy} ${busy === 1 ? tr(state, 'agente trabajando', 'agent working') : tr(state, 'agentes trabajando', 'agents working')}`
    : o.status && o.status !== 'idle' ? tr(state, 'orquestador trabajando', 'orchestrator working') : tr(state, 'sin agentes activos', 'no agents running');
  return c.gray(clip(`${safeLine(o.provider || '-')}${model ? ` · ${model}` : ''} · ${activity} · /help`, cols));
}

export function renderLive(state = {}, ui = {}, { cols = 80 } = {}) {
  const w = Math.max(20, cols | 0);
  const out = [];
  if (ui.showWelcome) out.push(...welcomeLines(state, { cols: w }));
  const streaming = (state.messages || []).filter((m) => m.streaming).slice(-1)[0];
  const orchestrator = state.orchestrator || {};
  if (orchestrator.status && orchestrator.status !== 'idle') {
    const frame = ['◐', '◓', '◑', '◒'][Math.floor(Date.now() / 250) % 4];
    const phase = ({ thinking: tr(state, 'pensando', 'thinking'), reading: tr(state, 'usando herramienta', 'using tool'), running: tr(state, 'trabajando', 'working'), reviewing: tr(state, 'revisando', 'reviewing') })[orchestrator.status] || safeLine(orchestrator.status);
    const elapsed = orchestrator.startedAt ? formatElapsed(Date.now() - Date.parse(orchestrator.startedAt)) : '';
    out.push(clip(`${frame} ${tr(state, 'Orquestador', 'Orchestrator')} · ${phase}${elapsed ? ` · ${elapsed}` : ''}${orchestrator.activity ? ` · ${safeLine(orchestrator.activity)}` : ''}`, w));
  }
  if (streaming) out.push(...renderFinal(streaming, { cols: w, lang: lang(state) }).slice(-8));
  const agents = runningAgents(state);
  out.push(...crewPanel(state, w));
  if (ui.showAgents) {
    for (const a of crewAgents(state).slice(-6)) {
      out.push(c.gray(agentLine(a, w)));
      const log = (a.log || []).slice(-6).map((x) => `  ${safeLine(x.kind || 'text')} · ${safeLine(x.text)}`);
      for (const l of log) out.push(...wrapText(l, w).map(c.gray));
    }
  }
  out.push(...renderPicker(ui, state, w));
  out.push(...renderMenu(ui, state, w));
  if (ui.prompt) out.push(c.brand(clip(safeLine(ui.prompt.title), w)), ...draftLines(ui.input || '', ui.cursor, w));
  else if (!ui.picker && !(ui.menu || /^\/[^\s]*$/.test(ui.input || ''))) {
    out.push(...draftLines(ui.input || '', ui.cursor, w));
    out.push(c.gray(clip(tr(state, 'Enter enviar · Ctrl+J nueva línea', 'Enter send · Ctrl+J new line'), w)));
  }
  out.push(statusLine(state, ui, w));
  return out.flatMap((l) => width(l) <= w ? [l] : wrapText(l, w));
}
