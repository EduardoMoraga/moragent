import { c, plain } from '../../core/log.js';
import { renderMarkdown } from '../markdown.js';

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

const width = (s) => plain(s).length;
const lang = (state) => state?.lang === 'en' ? 'en' : 'es';
const tr = (state, es, en) => lang(state) === 'en' ? en : es;

export function visualRows(lines, cols) {
  return lines.reduce((n, l) => n + Math.max(1, Math.ceil(width(l) / Math.max(1, cols))), 0);
}

// Fit a line to exactly `cols` visible columns: cut with an ellipsis, or pad so box borders line up.
function clip(s, cols) {
  const p = plain(s);
  if (p.length > cols) return p.slice(0, Math.max(0, cols - 1)) + '…';
  return s + ' '.repeat(Math.max(0, cols - p.length));
}

function statusGlyph(status) {
  if (status === 'done' || status === 'ready' || status === true) return c.green('✓');
  if (status === 'failed') return c.red('✗');
  if (status === 'blocked') return c.yellow('!');
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

export function renderFinal(message, { cols = 80, lang = 'es' } = {}) {
  const state = { lang };
  const w = Math.max(20, cols);
  if (message.from === 'user') return wrapText(`> ${message.text || ''}`, w);
  const prefix = message.from === 'system' ? `${tr(state, 'sistema', 'system')} ` : message.from === 'agent' ? `${message.agent || tr(state, 'agente', 'agent')} ` : '◆ ';
  const head = prefix;
  const lines = renderMarkdown(message.text || '', Math.max(8, w - width(head)), { c });
  return lines.map((l, i) => (i === 0 ? head : ' '.repeat(width(head))) + l);
}

function logo(cols) {
  if (cols < 40) return [c.brand('MORAGENT v5.2')];
  return [
    c.brand('█▀▄▀█ █▀█ █▀█ ▄▀█ █▀▀ █▀▀ █▄ █ ▀█▀'),
    c.brand('█ ▀ █ █▄█ █▀▄ █▀█ █▄█ ██▄ █ ▀█  █   v5.2'),
  ].map((l) => clip(l, Math.min(cols, 60)));
}

export function welcomeLines(state, { cols = 80 } = {}) {
  const o = state.orchestrator || {};
  const providers = state.providers || [];
  const ready = providers.map((p) => `${p.id} ${plain(statusGlyph(p.ready))}`).join(' ');
  const model = o.model || o.activeModel || '';
  return [
    ...logo(cols),
    clip(`${state.project || 'proyecto'} · ${tr(state, 'orquestador', 'orchestrator')} ${o.provider || '-'}${model ? ` (${model})` : ''}`, cols),
    clip(`${tr(state, 'conectados', 'connected')}: ${ready || '-'}`, cols),
    clip(`${tr(state, 'escribe lo que necesitas', 'type what you need')} · / ${tr(state, 'comandos', 'commands')} · Tab ${tr(state, 'agentes', 'agents')}`, cols),
  ];
}

function runningAgents(state) {
  return Object.values(state.agents || {}).filter((a) => ['queued', 'running', 'blocked'].includes(a.status));
}

function agentLine(a, cols) {
  const elapsed = a.elapsedMs ? ` ${formatElapsed(a.elapsedMs)}` : '';
  const body = `${plain(statusGlyph(a.status))} ${a.role || a.id} · ${a.provider || '?'}  ${a.taskId || a.id}${elapsed}  ${a.lastLine || a.title || ''}`;
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
  if (!ui.menu && !(ui.input || '').startsWith('/')) return [];
  const selected = ui.menu?.selected || 0;
  const w = Math.min(cols, Math.max(28, Math.min(64, cols - 2)));
  const lines = ['╭' + '─'.repeat(w - 2) + '╮'];
  lines.push('│ ' + clip(`> ${ui.input || ''}_`, w - 4) + ' │');
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const desc = lang(state) === 'en' ? m.en : m.es;
    lines.push('│ ' + clip(`${i === selected ? '›' : ' '} ${m.name.padEnd(14)} ${desc || ''}`, w - 4) + ' │');
  }
  lines.push('╰' + '─'.repeat(w - 2) + '╯');
  return lines;
}

function renderPicker(ui, state, cols) {
  if (!ui.picker) return [];
  const p = ui.picker;
  const items = p.items || [];
  const w = Math.min(cols, Math.max(34, Math.min(72, cols - 2)));
  const lines = ['╭' + '─'.repeat(w - 2) + '╮'];
  lines.push('│ ' + clip(p.title || tr(state, 'Elegir', 'Pick'), w - 4) + ' │');
  // Show a window of 8 rows that follows the selection, with ↑/↓ hints when more exist.
  const sel = p.selected || 0;
  const start = Math.max(0, Math.min(sel - 3, items.length - 8));
  if (start > 0) lines.push('│ ' + clip(c.gray(`  ↑ ${start} ${tr(state, 'más', 'more')}`), w - 4) + ' │');
  items.slice(start, start + 8).forEach((item, k) => {
    const i = start + k;
    lines.push('│ ' + clip(`${i === sel ? '›' : ' '} ${item.ready === false ? '○' : item.ready === true ? '✓' : ' '} ${item.label || item.id}${item.note ? ` · ${item.note}` : ''}`, w - 4) + ' │');
  });
  if (start + 8 < items.length) lines.push('│ ' + clip(c.gray(`  ↓ ${items.length - start - 8} ${tr(state, 'más', 'more')}`), w - 4) + ' │');
  lines.push('╰' + '─'.repeat(w - 2) + '╯');
  return lines;
}

function statusLine(state, ui, cols) {
  const o = state.orchestrator || {};
  const busy = runningAgents(state).length;
  const model = o.model || o.activeModel || '';
  return c.gray(clip(`${o.provider || '-'}${model ? ` · ${model}` : ''} · ${busy === 0 ? tr(state, 'sin agentes activos', 'no agents running') : `${busy} ${busy === 1 ? tr(state, 'agente trabajando', 'agent working') : tr(state, 'agentes trabajando', 'agents working')}`} · /help`, cols));
}

function composerLines(ui, cols, maxRows) {
  const inner = Math.max(1, cols - 4);
  const input = String(ui.input || '');
  const cursor = Math.max(0, Math.min(input.length, ui.cursor ?? input.length));
  const marked = input.slice(0, cursor) + '\0' + input.slice(cursor);
  const rows = [];
  let cursorRow = 0;
  let first = true;
  for (const logical of marked.split('\n')) {
    let rest = logical.replace(/\t/g, '  ');
    do {
      const prefix = first ? '> ' : '  ';
      const size = Math.max(1, inner - prefix.length);
      const chunk = rest.slice(0, size);
      if (chunk.includes('\0')) cursorRow = rows.length;
      rows.push(prefix + chunk.replace('\0', '_'));
      rest = rest.slice(size);
      first = false;
    } while (rest);
  }
  const start = Math.max(0, Math.min(cursorRow - Math.floor(maxRows / 2), rows.length - maxRows));
  const end = Math.min(rows.length, start + maxRows);
  const topHint = start ? ` ↑${start} ` : '';
  const bottomHint = end < rows.length ? ` ↓${rows.length - end} ` : '';
  const border = `╭${topHint}${'─'.repeat(cols - 2 - topHint.length)}╮`;
  const bottom = `╰${bottomHint}${'─'.repeat(cols - 2 - bottomHint.length)}╯`;
  return [border, ...rows.slice(start, end).map((row) => `│ ${clip(row, inner)} │`), bottom];
}

function controlsLines(state, cols) {
  const controls = [
    tr(state, 'Enter enviar', 'Enter send'),
    tr(state, 'Ctrl+J salto', 'Ctrl+J newline'),
    tr(state, 'Ctrl+C limpiar', 'Ctrl+C clear'),
    '/help',
  ];
  const lines = [];
  for (const control of controls) {
    const last = lines.length - 1;
    if (last >= 0 && width(lines[last]) + width(control) + 3 <= cols) lines[last] += ` · ${control}`;
    else lines.push(control);
  }
  return lines.map((line) => c.gray(line));
}

export function renderLive(state = {}, ui = {}, { cols = 80, rows = 24 } = {}) {
  const w = Math.max(20, cols | 0);
  const out = [];
  if (ui.showWelcome) out.push(...welcomeLines(state, { cols: w }));
  const streaming = (state.messages || []).filter((m) => m.streaming).slice(-1)[0];
  if (streaming) out.push(...renderFinal(streaming, { cols: w, lang: lang(state) }).slice(-8));
  const agents = runningAgents(state);
  for (const a of agents) out.push(agentLine(a, w));
  if (ui.showAgents) {
    for (const a of agents) {
      const log = (a.log || []).slice(-6).map((x) => `  ${x.kind || 'text'} · ${x.text}`);
      for (const l of log) out.push(...wrapText(c.gray(l), w));
    }
  }
  out.push(...renderPicker(ui, state, w));
  out.push(...renderMenu(ui, state, w));
  const fit = (lines) => lines.flatMap((l) => width(l) <= w ? [l] : wrapText(l, w));
  const footer = fit([...controlsLines(state, w), statusLine(state, ui, w)]);
  const height = Math.max(1, (rows | 0) - 1);
  const above = fit(out);
  const room = height - footer.length - 2;
  const composerRows = Math.max(1, Math.min(Math.floor(height * 0.4), Math.max(3, room - above.length), room));
  const composer = composerLines(ui, w, composerRows);
  const kept = Math.max(0, height - footer.length - composer.length);
  return [...(kept ? above.slice(-kept) : []), ...composer, ...footer];
}
