import { c, plain } from '../core/log.js';

const COMMANDS = ['/login', '/plan', '/equipo', '/memoria', '/abrir', '/help'];

function tr(state, es, en) { return state?.lang === 'en' ? en : es; }

export function stripAnsi(s) { return plain(s); }

function width(s) { return plain(s).length; }
function clip(s, n) {
  if (n <= 0) return '';
  const p = plain(s);
  if (p.length <= n) return s + ' '.repeat(n - p.length);
  return p.slice(0, Math.max(0, n - 1)) + '…';
}
function bareClip(s, n) { return clip(String(s ?? ''), n); }
function pad(s, n) { return clip(s, n); }
function border(top, w, title = '') {
  const label = title ? ` ${title} ` : '';
  const fill = Math.max(0, w - 2 - width(label));
  return `┌${label}${'─'.repeat(fill)}┐`;
}
function mid(w, title = '') {
  const label = title ? ` ${title} ` : '';
  const fill = Math.max(0, w - 2 - width(label));
  return `├${label}${'─'.repeat(fill)}┤`;
}
function bottom(w) { return `└${'─'.repeat(Math.max(0, w - 2))}┘`; }
function row(content, w) { return `│${pad(content, Math.max(0, w - 2))}│`; }

function wrapText(text, w) {
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    let line = raw;
    if (!line) { out.push(''); continue; }
    while (width(line) > w) {
      let cut = Math.max(1, w);
      const probe = plain(line).slice(0, cut + 1);
      const sp = probe.lastIndexOf(' ');
      if (sp > Math.max(8, Math.floor(w * 0.45))) cut = sp;
      out.push(plain(line).slice(0, cut).trimEnd());
      line = plain(line).slice(cut).trimStart();
    }
    out.push(line);
  }
  return out;
}

function statusGlyph(status) {
  if (status === 'done' || status === 'ready' || status === true) return c.green('✓');
  if (status === 'failed') return c.red('✗');
  if (status === 'running' || status === 'thinking' || status === 'reviewing') return c.brand('●');
  return c.gray('○');
}

function agentSpinner(a) {
  if (a.status !== 'running') return statusGlyph(a.status);
  const frames = ['◐', '◓', '◑', '◒'];
  const seed = Math.floor(((a.startedAt || 0) / 250) % frames.length);
  return c.brand(frames[seed]);
}

function roleColor(role = '') {
  const r = String(role).toLowerCase();
  if (r.includes('backend') || r.includes('codex')) return c.cyan;
  if (r.includes('frontend') || r.includes('claude')) return c.magenta;
  if (r.includes('helper') || r.includes('agy') || r.includes('antigravity')) return c.yellow;
  if (r.includes('dev') || r.includes('pi')) return c.brand;
  return c.green;
}

function messageLines(state, w) {
  const lines = [];
  for (const m of state.messages || []) {
    let text = String(m.text || '');
    let head;
    if (m.from === 'user') {
      head = `${tr(state, 'tú', 'you')} › `;
    } else {
      const hasGlyph = /^\s*◆/.test(text);
      const glyph = hasGlyph ? '' : `${c.brand('◆')} `;
      if (hasGlyph) text = text.replace(/^\s*◆\s*/, '');
      if (m.from === 'agent') {
        const who = roleColor(m.agent)(m.agent || tr(state, 'agente', 'agent'));
        head = `${glyph}${who}${m.streaming ? ' …' : ''} `;
      } else if (m.from === 'system') {
        head = `${glyph}${tr(state, 'sistema', 'system')}${m.streaming ? ' …' : ''} `;
      } else {
        head = `${glyph}${m.streaming ? '… ' : ''}`;
      }
    }
    const prefix = width(head);
    const chunks = wrapText(text, Math.max(8, w - prefix));
    if (!chunks.length) chunks.push('');
    lines.push(head + chunks[0]);
    for (const x of chunks.slice(1)) lines.push(' '.repeat(prefix) + x);
  }
  if (!lines.length) lines.push(`${c.brand('◆')} ${tr(state, 'Hola. ¿Qué construimos?', 'Hello. What shall we build?')}`);
  return lines;
}

function teamLines(state, w) {
  const lines = [];
  const o = state.orchestrator || {};
  lines.push(`${c.brand('◆')} ${tr(state, 'Orquestador', 'Orchestrator')} ${statusGlyph(o.status)} ${o.provider || ''}`.trim());
  const agents = Object.values(state.agents || {});
  for (const a of agents) {
    const title = a.title ? ` · ${bareClip(a.title, Math.max(8, Math.floor(w * 0.45))).trimEnd()}` : '';
    lines.push(`${agentSpinner(a)} ${a.id}${title}`.trim());
    if (a.lastLine) lines.push(c.gray(`  ${bareClip(a.lastLine, Math.max(6, w - 4)).trimEnd()}`));
  }
  if (!agents.length) lines.push(c.gray(tr(state, 'Sin subagentes activos', 'No active subagents')));
  return lines;
}

function renderSidebar(state, w, h) {
  const mem = state.memory || {};
  const spec = state.spec;
  const brain = state.brain || {};
  const lines = [border(true, w, tr(state, 'Equipo', 'Team'))];
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

function renderLogin(state, cols, rows, overlay) {
  const w = Math.min(cols - 4, 74);
  const providers = state.providers || [];
  const selected = Math.max(0, Math.min(overlay?.selected ?? 0, providers.length - 1));
  const box = [];
  box.push(border(true, w, tr(state, '/login · proveedores', '/login · providers')));
  box.push(row(tr(state, 'Selecciona proveedor. API keys se ingresan enmascaradas.', 'Select a provider. API keys are entered masked.'), w));
  box.push(mid(w));
  providers.forEach((p, i) => {
    const mark = i === selected ? c.brand('›') : ' ';
    const ready = p.ready ? c.green('✓') : c.gray('○');
    box.push(row(`${mark} ${ready} ${p.id} · ${p.label || p.id} · ${p.kind || ''}`, w));
    const detail = p.ready ? p.detail : (p.loginHint || p.detail || '');
    if (detail) box.push(row(c.gray(`    ${detail}`), w));
  });
  if (!providers.length) box.push(row(c.gray(tr(state, 'No hay proveedores configurados.', 'No providers configured.')), w));
  if (overlay?.mode === 'key') {
    box.push(mid(w, 'API key'));
    box.push(row(`${overlay.providerId || ''} › ${'•'.repeat(String(overlay.key || '').length)}_`, w));
  }
  box.push(row(c.gray(tr(state, 'Enter confirma · Esc cierra · ↑/↓ navega', 'Enter confirms · Esc closes · ↑/↓ moves')), w));
  box.push(bottom(w));
  const left = Math.floor((cols - w) / 2);
  const top = Math.max(1, Math.floor((rows - box.length) / 2));
  const out = Array.from({ length: rows }, () => ' '.repeat(cols));
  for (let i = 0; i < box.length && top + i < rows; i++) {
    out[top + i] = ' '.repeat(left) + clip(box[i], w) + ' '.repeat(Math.max(0, cols - left - w));
  }
  return out;
}

export function render(state = {}, { cols = 80, rows = 24, input = '', scroll = 0, overlay = null } = {}) {
  cols = Math.max(40, cols | 0); rows = Math.max(10, rows | 0);
  const title = `MORAGENT · ${state.project || 'project'}`;
  const showSide = cols >= 100;
  const inputH = 3;
  const mainH = rows - inputH;
  let out = [];
  if (showSide) {
    const sideW = Math.min(38, Math.max(30, Math.floor(cols * 0.32)));
    const chatW = cols - sideW;
    const chat = [border(true, chatW, title)];
    const bodyH = mainH - 2;
    const msgs = messageLines(state, chatW - 2);
    const start = Math.max(0, msgs.length - bodyH - Math.max(0, scroll));
    const visible = msgs.slice(start, start + bodyH);
    while (visible.length < bodyH) visible.unshift('');
    for (const l of visible) chat.push(row(l, chatW));
    chat.push(bottom(chatW));
    const side = renderSidebar(state, sideW, mainH);
    if (side[0]?.startsWith('┌')) side[0] = '┬' + side[0].slice(1);
    if (side[mainH - 1]?.startsWith('└')) side[mainH - 1] = '┴' + side[mainH - 1].slice(1);
    for (let i = 0; i < mainH; i++) out.push(chat[i].slice(0, -1) + side[i]);
  } else {
    out.push(border(true, cols, title));
    const status = `${statusGlyph(state.orchestrator?.status)} ${state.orchestrator?.provider || tr(state, 'orquestador', 'orchestrator')} · ${Object.values(state.agents || {}).filter((a) => a.status === 'running').length} ${tr(state, 'agentes', 'agents')} · ${tr(state, 'mem', 'mem')} ${(state.memory?.canonical ?? 0)}/${(state.memory?.episodic ?? 0)}`;
    out.push(row(status, cols));
    const bodyH = mainH - 3;
    const msgs = messageLines(state, cols - 2);
    const start = Math.max(0, msgs.length - bodyH - Math.max(0, scroll));
    const visible = msgs.slice(start, start + bodyH);
    while (visible.length < bodyH) visible.unshift('');
    for (const l of visible) out.push(row(l, cols));
    out.push(bottom(cols));
  }
  const commands = COMMANDS.join(' ');
  out.push(`├${'─'.repeat(cols - 2)}┤`);
  out.push(row(`› ${input}_ ${c.gray(commands)}`, cols));
  out.push(bottom(cols));
  out = out.slice(0, rows);
  while (out.length < rows) out.push(' '.repeat(cols));
  out = out.map((l) => clip(l, cols));
  if (overlay?.type === 'login') return renderLogin(state, cols, rows, overlay);
  return out;
}
