import { c, plain } from '../core/log.js';
import { renderMarkdown } from './markdown.js';

const COMMANDS = ['/login', '/plan', '/equipo', '/memoria', '/abrir', '/agentes', '/sesiones', '/help'];

function tr(state, es, en) { return state?.lang === 'en' ? en : es; }
export function stripAnsi(s) { return plain(s); }
const width = (s) => plain(s).length;
function clip(s, n) { if (n <= 0) return ''; const p = plain(s); return p.length <= n ? s + ' '.repeat(n - p.length) : p.slice(0, Math.max(0, n - 1)) + '…'; }
const pad = clip;
function border(w, title = '') { const label = title ? ` ${title} ` : ''; return `┌${label}${'─'.repeat(Math.max(0, w - 2 - width(label)))}┐`; }
function mid(w, title = '') { const label = title ? ` ${title} ` : ''; return `├${label}${'─'.repeat(Math.max(0, w - 2 - width(label)))}┤`; }
function bottom(w) { return `└${'─'.repeat(Math.max(0, w - 2))}┘`; }
function row(content, w) { return `│${pad(content, Math.max(0, w - 2))}│`; }

function statusGlyph(status) {
  if (status === 'done' || status === 'ready' || status === true) return c.green('✓');
  if (status === 'failed') return c.red('✗');
  if (status === 'blocked') return c.yellow('!');
  if (status === 'running' || status === 'thinking' || status === 'reviewing') return c.brand('●');
  return c.gray('○');
}
function roleColor(role = '') {
  const r = String(role).toLowerCase();
  if (r.includes('backend') || r.includes('codex')) return c.cyan;
  if (r.includes('frontend') || r.includes('claude')) return c.magenta;
  if (r.includes('helper') || r.includes('agy')) return c.yellow;
  if (r.includes('dev') || r.includes('pi')) return c.brand;
  return c.green;
}
function formatElapsed(ms) {
  if (!ms) return '';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}
function wrapMarkdown(text, w) { return renderMarkdown(text, w, { c }); }

function messageLines(state, w) {
  const lines = [];
  for (const m of state.messages || []) {
    let text = String(m.text || '');
    let head;
    if (m.from === 'user') head = `${tr(state, 'tú', 'you')} › `;
    else {
      const hasGlyph = /^\s*◆/.test(text);
      const glyph = hasGlyph ? '' : `${c.brand('◆')} `;
      if (hasGlyph) text = text.replace(/^\s*◆\s*/, '');
      if (m.from === 'agent') head = `${glyph}${roleColor(m.agent)(m.agent || tr(state, 'agente', 'agent'))}${m.streaming ? ' …' : ''} `;
      else if (m.from === 'system') head = `${glyph}${tr(state, 'sistema', 'system')}${m.streaming ? ' …' : ''} `;
      else head = `${glyph}${m.streaming ? '… ' : ''}`;
    }
    const chunks = wrapMarkdown(text, Math.max(8, w - width(head)));
    lines.push(head + (chunks[0] || ''));
    for (const x of chunks.slice(1)) lines.push(' '.repeat(width(head)) + x);
  }
  if (!lines.length) lines.push(`${c.brand('◆')} ${tr(state, 'Hola. ¿Qué construimos?', 'Hello. What shall we build?')}`);
  for (const a of Object.values(state.agents || {})) lines.push(...agentCardLines(state, a, w));
  return lines;
}

function uniqueTail(items, n = 2) {
  const out = [];
  for (const item of items.filter(Boolean)) {
    const key = plain(String(item)).trim();
    if (!key || out.some((x) => plain(String(x)).trim() === key)) continue;
    out.push(item);
  }
  return out.slice(-n);
}

function agentCardLines(state, a, w) {
  const color = roleColor(a.role || a.id || a.provider);
  const role = a.role || a.id || tr(state, 'agente', 'agent');
  const task = a.taskId || a.id;
  const head = `${statusGlyph(a.status)} ${role} · ${a.provider || '?'}${task ? ` · ${task}` : ''}${a.elapsedMs ? ` · ${formatElapsed(a.elapsedMs)}` : ''}`;
  const lines = [color(head)];
  const log = Array.isArray(a.log) ? a.log : [];
  const tail = uniqueTail(log.length ? log.map((x) => x.text) : [a.lastLine]);
  for (const l of tail) for (const md of wrapMarkdown(l, Math.max(8, w - 4))) lines.push(c.gray(`  ${clip(md, Math.max(8, w - 2)).trimEnd()}`));
  if (['done', 'failed', 'blocked'].includes(a.status) && a.lastLine && !tail.some((x) => plain(String(x)).trim() === plain(String(a.lastLine)).trim())) {
    for (const md of wrapMarkdown(a.lastLine, Math.max(8, w - 4))) lines.push(c.gray(`  ${clip(md, Math.max(8, w - 2)).trimEnd()}`));
  }
  return lines;
}

function teamLines(state, w) {
  const lines = [];
  const o = state.orchestrator || {};
  lines.push(`${c.brand('◆')} ${tr(state, 'Orquestador', 'Orchestrator')} ${statusGlyph(o.status)} ${o.provider || ''}`.trim());
  const agents = Object.values(state.agents || {});
  for (const a of agents) {
    const title = a.title ? ` · ${clip(a.title, Math.max(8, Math.floor(w * 0.45))).trimEnd()}` : '';
    lines.push(`${statusGlyph(a.status)} ${a.id}${title}`.trim());
    if (a.lastLine) lines.push(c.gray(`  ${clip(a.lastLine, Math.max(6, w - 4)).trimEnd()}`));
  }
  if (!agents.length) lines.push(c.gray(tr(state, 'Sin subagentes activos', 'No active subagents')));
  return lines;
}
function narrowStatus(state, w) {
  const agents = Object.values(state.agents || {});
  const text = agents.length
    ? agents.map((a) => `${a.role || a.id} ${plain(statusGlyph(a.status))}${a.elapsedMs && a.status === 'running' ? ` ${formatElapsed(a.elapsedMs)}` : ''}`).join(' · ')
    : `${plain(statusGlyph(state.orchestrator?.status))} ${state.orchestrator?.provider || tr(state, 'orquestador', 'orchestrator')}`;
  return row(text, w);
}
function renderSidebar(state, w, h) {
  const mem = state.memory || {}, spec = state.spec, brain = state.brain || {};
  const lines = [border(w, tr(state, 'Equipo', 'Team'))];
  for (const l of teamLines(state, w - 2).slice(0, Math.max(1, Math.floor(h * 0.45)))) lines.push(row(l, w));
  lines.push(mid(w, tr(state, 'Memoria', 'Memory')));
  lines.push(row(`${tr(state, 'canónica', 'canonical')} ${mem.canonical ?? 0} · ${tr(state, 'episod.', 'episodic')} ${mem.episodic ?? 0}`, w));
  lines.push(row(`${tr(state, 'trans.', 'trans.')} ${mem.transient ?? 0} · skills ${mem.skills ?? 0}`, w));
  lines.push(mid(w, 'Spec'));
  lines.push(row(spec ? `${spec.slug} → ${spec.phase}` : tr(state, 'sin spec activa', 'no active spec'), w));
  lines.push(mid(w, 'Obsidian'));
  lines.push(row(brain.linked ? `${statusGlyph('done')} ${brain.vault || tr(state, 'conectado', 'linked')}` : `${statusGlyph('idle')} ${tr(state, 'no conectado', 'not linked')}`, w));
  while (lines.length < h - 1) lines.push(row('', w));
  lines.push(bottom(w));
  return lines.slice(0, h);
}

function overlayBox(cols, rows, box) {
  const w = Math.min(cols - 2, Math.max(...box.map(width), 30));
  const left = Math.max(0, Math.floor((cols - w) / 2));
  const top = Math.max(0, Math.floor((rows - box.length) / 2));
  const out = Array.from({ length: rows }, () => ' '.repeat(cols));
  for (let i = 0; i < box.length && top + i < rows; i++) out[top + i] = ' '.repeat(left) + clip(box[i], w) + ' '.repeat(Math.max(0, cols - left - w));
  return out;
}
function renderLogin(state, cols, rows, overlay) {
  const w = Math.min(cols - 4, 74), providers = state.providers || [];
  const selected = Math.max(0, Math.min(overlay?.selected ?? 0, providers.length - 1));
  const box = [border(w, tr(state, '/login · proveedores', '/login · providers')), row(tr(state, 'Selecciona proveedor. API keys se ingresan enmascaradas.', 'Select a provider. API keys are entered masked.'), w), mid(w)];
  providers.forEach((p, i) => { box.push(row(`${i === selected ? c.brand('›') : ' '} ${p.ready ? c.green('✓') : c.gray('○')} ${p.id} · ${p.label || p.id} · ${p.kind || ''}`, w)); const d = p.ready ? p.detail : (p.loginHint || p.detail || ''); if (d) box.push(row(c.gray(`    ${d}`), w)); });
  if (!providers.length) box.push(row(c.gray(tr(state, 'No hay proveedores configurados.', 'No providers configured.')), w));
  if (overlay?.mode === 'key') { box.push(mid(w, 'API key')); box.push(row(`${overlay.providerId || ''} › ${'•'.repeat(String(overlay.key || '').length)}_`, w)); }
  box.push(row(c.gray(tr(state, 'Enter confirma · Esc cierra · ↑/↓ navega', 'Enter confirms · Esc closes · ↑/↓ moves')), w)); box.push(bottom(w));
  return overlayBox(cols, rows, box);
}
function relativizeRoot(text, state) {
  const root = state.root || state.cwd || state.projectRoot;
  if (!root) return text;
  const clean = String(root).replace(/\/$/, '');
  return String(text ?? '').split(clean + '/').join('');
}

function renderAgentsOverlay(state, cols, rows, overlay = {}) {
  const w = Math.min(cols - 2, 96), h = Math.min(rows - 2, rows);
  const agents = Object.values(state.agents || {});
  const sel = Math.max(0, Math.min(overlay.selected ?? 0, agents.length - 1));
  const a = agents[sel];
  const box = [border(w, tr(state, 'Agentes', 'Agents'))];
  if (!agents.length) box.push(row(c.gray(tr(state, 'Sin agentes todavía', 'No agents yet')), w));
  else {
    agents.forEach((x, i) => box.push(row(`${i === sel ? c.brand('›') : ' '} ${statusGlyph(x.status)} ${x.id} · ${x.provider || ''} · ${x.taskId || ''} ${x.title || ''}`, w)));
    box.push(mid(w, a?.id || 'log'));
    const log = (a?.log || []).map((x) => `[${x.kind || 'text'}] ${relativizeRoot(x.text, state)}`);
    const logLines = log.flatMap((x) => wrapMarkdown(x, w - 4));
    const max = Math.max(1, h - box.length - 2);
    const start = Math.max(0, Math.min(overlay.scroll || 0, Math.max(0, logLines.length - max)));
    for (const l of logLines.slice(start, start + max)) box.push(row(c.gray(l), w));
  }
  box.push(row(c.gray(tr(state, 'Esc cierra · ↑/↓ agente · PgUp/PgDn log', 'Esc closes · ↑/↓ agent · PgUp/PgDn log')), w));
  box.push(bottom(w));
  return overlayBox(cols, rows, box.slice(0, h));
}
function relative(ts) { const s = Math.max(0, Math.floor((Date.now() - new Date(ts || Date.now()).getTime()) / 1000)); if (s < 60) return `${s}s`; if (s < 3600) return `${Math.floor(s / 60)}m`; return `${Math.floor(s / 3600)}h`; }
function renderSessionsOverlay(state, cols, rows, overlay = {}) {
  const w = Math.min(cols - 2, 84), sessions = state.sessions || [];
  const sel = Math.max(0, Math.min(overlay.selected ?? 0, sessions.length - 1));
  const box = [border(w, tr(state, 'Sesiones', 'Sessions'))];
  if (!sessions.length) box.push(row(c.gray(tr(state, 'Sin sesiones guardadas', 'No saved sessions')), w));
  sessions.forEach((s, i) => box.push(row(`${i === sel ? c.brand('›') : ' '} ${s.title || s.id} · ${relative(s.updatedAt)} · ${s.messages ?? 0} msg`, w)));
  box.push(row(c.gray(tr(state, 'Enter reanuda · Esc cierra', 'Enter resumes · Esc closes')), w));
  box.push(bottom(w));
  return overlayBox(cols, rows, box);
}

export function render(state = {}, { cols = 80, rows = 24, input = '', scroll = 0, overlay = null, sidebar = true, newCount = 0 } = {}) {
  cols = Math.max(40, cols | 0); rows = Math.max(10, rows | 0);
  const title = `MORAGENT · ${state.project || 'project'}`;
  const showSide = sidebar && cols >= 100;
  const inputH = 3, mainH = rows - inputH;
  let out = [];
  if (showSide) {
    const sideW = Math.min(38, Math.max(30, Math.floor(cols * 0.32))), chatW = cols - sideW;
    const chat = [border(chatW, title)], bodyH = mainH - 2;
    const msgs = messageLines(state, chatW - 2);
    const start = Math.max(0, msgs.length - bodyH - Math.max(0, scroll));
    const visible = msgs.slice(start, start + bodyH); while (visible.length < bodyH) visible.unshift('');
    for (const l of visible) chat.push(row(l, chatW)); chat.push(bottom(chatW));
    const side = renderSidebar(state, sideW, mainH); if (side[0]?.startsWith('┌')) side[0] = '┬' + side[0].slice(1); if (side[mainH - 1]?.startsWith('└')) side[mainH - 1] = '┴' + side[mainH - 1].slice(1);
    for (let i = 0; i < mainH; i++) out.push(chat[i].slice(0, -1) + side[i]);
  } else {
    out.push(border(cols, title)); out.push(narrowStatus(state, cols));
    const bodyH = mainH - 3, msgs = messageLines(state, cols - 2);
    const start = Math.max(0, msgs.length - bodyH - Math.max(0, scroll));
    const visible = msgs.slice(start, start + bodyH); while (visible.length < bodyH) visible.unshift('');
    for (const l of visible) out.push(row(l, cols)); out.push(bottom(cols));
  }
  out.push(`├${'─'.repeat(cols - 2)}┤`);
  const hint = newCount > 0 ? c.yellow(`↓ ${newCount} ${tr(state, 'nuevos · End', 'new · End')}`) : c.gray(COMMANDS.join(' '));
  out.push(row(`› ${input}_ ${hint}`, cols)); out.push(bottom(cols));
  out = out.slice(0, rows); while (out.length < rows) out.push(' '.repeat(cols)); out = out.map((l) => clip(l, cols));
  if (overlay?.type === 'login') return renderLogin(state, cols, rows, overlay);
  if (overlay?.type === 'agents') return renderAgentsOverlay(state, cols, rows, overlay);
  if (overlay?.type === 'sessions') return renderSessionsOverlay(state, cols, rows, overlay);
  if (overlay?.type === 'sidebar') return overlayBox(cols, rows, renderSidebar(state, Math.min(42, cols - 2), Math.min(rows - 2, rows)));
  return out;
}
