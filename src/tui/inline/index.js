import { c, plain } from '../../core/log.js';
import { LineEditor, decodeKeys } from '../input.js';
import { renderLive, renderFinal, visualRows, filterCommands } from './render.js';
import { COMMANDS as REGISTRY, welcomeLines } from '../../engine/commands.js';

// Slash menu entries come from the engine's registry; /tarea first because it is how you deploy an agent.
const DEFAULT_COMMANDS = [...REGISTRY]
  .sort((a, b) => (a.name === 'tarea' ? -1 : b.name === 'tarea' ? 1 : 0))
  .map((x) => ({ name: `/${x.name}`, aliases: (x.aliases || []).map((a) => `/${a}`), args: x.args, es: x.es, en: x.en }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeArgs(args) { return Array.isArray(args) ? args : args?.args || []; }
function roles(state) {
  const fromAgents = Object.values(state.agents || {}).map((a) => a.role).filter(Boolean);
  return [...new Set([...fromAgents, 'backend', 'frontend', 'helper', 'dev'])].map((id) => ({ id, label: id }));
}
function commandFor(input) {
  const name = String(input || '').trim().split(/\s+/)[0];
  return DEFAULT_COMMANDS.find((cmd) => cmd.name === name || (cmd.aliases || []).includes(name));
}
function findAgent(state, ref) {
  const agents = Object.values(state.agents || {});
  return agents.find((a) => a.id === ref || a.taskId === ref || a.role === ref) || agents[0];
}

export async function runInline({ engine, input = process.stdin, output = process.stdout }) {
  const editor = new LineEditor({ commands: DEFAULT_COMMANDS.flatMap((x) => [x.name, ...(x.aliases || [])]) });
  const ui = { input: '', showAgents: false, commands: DEFAULT_COMMANDS, menu: null, picker: null, showWelcome: false };
  const printed = new Set();
  let liveRows = 0;
  let closed = false;
  let timer = null;
  let wasRaw = false;
  let lastCtrlC = 0;
  let printedWelcome = false;

  const state = () => engine.store?.state || {};
  // One column of slack so a full-width line never triggers the terminal's auto-wrap.
  const cols = () => Math.max(20, (output.columns || 80) - 1);
  const eraseLive = () => {
    // The cursor sits on the last live row: go to column 0, up to the first live row, clear below.
    if (liveRows > 0) output.write(`\r${liveRows > 1 ? `\x1b[${liveRows - 1}A` : ''}\x1b[J`);
    liveRows = 0;
  };
  const writeBlock = (lines) => { if (lines.length) output.write(lines.join('\n') + '\n'); };
  const redraw = () => {
    if (closed) return;
    eraseLive();
    ui.input = editor.value;
    ui.menu = editor.value.startsWith('/') ? { ...(ui.menu || {}), items: filterCommands(editor.value, ui.commands) } : null;
    const lines = renderLive(state(), ui, { cols: cols() });
    output.write(lines.join('\n'));
    liveRows = visualRows(lines, cols());
  };
  const schedule = () => { if (!timer) timer = setTimeout(() => { timer = null; flushFinal(); redraw(); }, 50); };
  const flushFinal = () => {
    if (!printedWelcome) { eraseLive(); writeBlock(welcomeLines(state(), { cols: cols() })); printedWelcome = true; }
    for (const m of state().messages || []) {
      if (printed.has(m.id) || m.streaming) continue;
      eraseLive();
      writeBlock(renderFinal(m, { cols: cols(), lang: state().lang || 'es' }));
      printed.add(m.id);
    }
    for (const a of Object.values(state().agents || {})) {
      const id = `agent:${a.id || a.taskId}:${a.status}:${a.endedAt || ''}`;
      if (!['done', 'failed', 'blocked'].includes(a.status) || printed.has(id)) continue;
      eraseLive();
      const status = plain(a.status === 'done' ? c.green('✓') : a.status === 'blocked' ? c.yellow('!') : c.red('✗'));
      // One clean line per finished agent: markdown marks stripped, cut to the terminal width.
      const summary = String(a.lastLine || '').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
      const line = `${status} ${a.role || a.id} · ${a.provider || '?'}  ${a.taskId || a.id}  ${a.elapsedMs ? `${Math.floor(a.elapsedMs / 1000)}s` : ''}  ${summary}`;
      const max = cols();
      writeBlock([plain(line).length > max ? `${line.slice(0, Math.max(0, max - 1 + (line.length - plain(line).length)))}…` : line]);
      printed.add(id);
    }
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    eraseLive();
    output.write('\x1b[?25h');
    if (input.isTTY && input.setRawMode) input.setRawMode(Boolean(wasRaw));
    input.pause?.();
    input.off?.('data', onData);
    output.off?.('resize', onResize);
    engine.store?.off?.('change', onChange);
    process.off('SIGINT', onSig);
    process.off('SIGTERM', onSig);
  };
  const exit = () => { cleanup(); engine.stop?.(); resolveDone(); };
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const onSig = () => exit();
  const onResize = () => schedule();
  const onChange = () => schedule();

  async function printAgentLog(ref) {
    const a = findAgent(state(), ref);
    eraseLive();
    if (!a) writeBlock([c.gray('Sin agentes todavía.')]);
    else {
      writeBlock([`${a.role || a.id} · ${a.provider || '?'} · ${a.taskId || a.id}`]);
      const lines = (a.log || []).map((x) => `[${x.kind || 'text'}] ${x.text}`);
      writeBlock(lines.length ? lines : [c.gray(a.lastLine || 'sin log')]);
    }
    redraw();
  }
  function openPicker(kind, items, title, extra = {}) { ui.picker = { kind, items, title, selected: 0, ...extra }; }
  // Model pickers open immediately and fill in when the engine's catalog answers.
  function openModelPicker(kind, engineId, title, extra = {}) {
    const other = { id: '__other__', label: state().lang === 'en' ? 'other… (type the model id)' : 'otro… (escribe el id del modelo)' };
    const reset = { id: 'default', label: state().lang === 'en' ? 'default of the engine' : 'por defecto del motor' };
    openPicker(kind, [{ id: '__loading__', label: state().lang === 'en' ? 'loading models…' : 'cargando modelos…' }], title, extra);
    redraw();
    Promise.resolve(engine.listModels?.(engineId) || []).catch(() => []).then((models) => {
      if (!ui.picker || ui.picker.kind !== kind) return;
      ui.picker.items = [...models.map((m) => ({ id: m.id, label: m.note ? `${m.label || m.id}  (${m.note})` : (m.label || m.id) })), reset, other];
      ui.picker.selected = 0;
      redraw();
    });
  }
  async function acceptPicker() {
    const p = ui.picker; if (!p) return;
    const item = p.items[p.selected || 0];
    ui.picker = null;
    if (!item) return;
    if (p.kind === 'role-task') { editor.setValue(`/tarea ${item.id} `); return; }
    if (item.id === '__loading__') { ui.picker = p; return; }
    if (item.id === '__other__') { editor.setValue(p.kind === 'model-role' ? `/modelo ${p.role} ` : '/modelo '); return; }
    if (p.kind === 'orchestrator') { await engine.command('orquestador', [item.id]); openModelPicker('model-orchestrator', item.id, `modelo · ${item.id}`); return; }
    if (p.kind === 'model-orchestrator') { await engine.command('modelo', [item.id]); return; }
    if (p.kind === 'model-role') { await engine.command('modelo', [p.role, item.id]); return; }
  }
  async function submit(line) {
    const value = String(line || '').trim();
    if (!value) return;
    if (!value.startsWith('/')) { await engine.send(value); return; }
    const [cmd, ...rest] = value.slice(1).split(/\s+/);
    const slash = `/${cmd}`;
    const known = commandFor(slash);
    if (!known) { editor.setValue(value); ui.menu = { items: filterCommands(value, ui.commands), selected: 0 }; return; }
    if (['/salir', '/exit'].includes(slash)) return exit();
    if (['/agentes', '/agents'].includes(slash) && rest.length) return printAgentLog(rest[0]);
    if (['/agentes', '/agents'].includes(slash)) { ui.showAgents = !ui.showAgents; return; }
    if (['/tarea', '/task', '/desplegar'].includes(slash) && rest.length < 2) { openPicker('role-task', roles(state()), 'rol para /tarea'); return; }
    if (['/orquestador', '/orchestrator'].includes(slash) && !rest.length) { openPicker('orchestrator', [...(state().providers || [])].sort((a, b) => Number(b.ready) - Number(a.ready)).map((p) => ({ id: p.id, label: p.label || p.id, ready: p.ready, note: p.detail || p.loginHint })), 'orquestador'); return; }
    if (['/modelo', '/model'].includes(slash) && !rest.length) { const e = state().orchestrator?.provider; openModelPicker('model-orchestrator', e, `modelo · orquestador (${e})`); return; }
    if (['/modelo', '/model'].includes(slash) && rest.length === 1 && engine.roleEngine?.(rest[0])) { const e = engine.roleEngine(rest[0]); openModelPicker('model-role', e, `modelo · ${rest[0]} (${e})`, { role: rest[0] }); return; }
    await engine.command(cmd, rest);
  }
  async function onData(buf) {
    for (const key of decodeKeys(buf)) {
      if (ui.picker) {
        if (key.name === 'escape') ui.picker = null;
        else if (key.name === 'up') ui.picker.selected = Math.max(0, (ui.picker.selected || 0) - 1);
        else if (key.name === 'down') ui.picker.selected = Math.min(ui.picker.items.length - 1, (ui.picker.selected || 0) + 1);
        else if (key.name === 'enter' || key.name === 'tab') await acceptPicker();
        redraw(); continue;
      }
      if (key.name === 'ctrl-c' && (editor.value || ui.picker)) { editor.setValue(''); ui.picker = null; ui.menu = null; redraw(); continue; }
      if (key.name === 'ctrl-c') {
        const now = Date.now();
        const busy = Object.values(state().agents || {}).some((a) => a.status === 'running') || ['thinking', 'running', 'reviewing'].includes(state().orchestrator?.status);
        if (busy && now - lastCtrlC > 2000) { lastCtrlC = now; await engine.command('cancel'); redraw(); continue; }
        return exit();
      }
      if (key.name === 'tab' && editor.value.startsWith('/')) {
        const items = filterCommands(editor.value, ui.commands);
        const item = items[ui.menu?.selected || 0] || items[0];
        if (item) editor.setValue(item.name + ' ');
      } else if (key.name === 'tab') ui.showAgents = !ui.showAgents;
      else if (key.name === 'up' && editor.value.startsWith('/')) ui.menu = { items: filterCommands(editor.value, ui.commands), selected: Math.max(0, (ui.menu?.selected || 0) - 1) };
      else if (key.name === 'down' && editor.value.startsWith('/')) { const items = filterCommands(editor.value, ui.commands); ui.menu = { items, selected: Math.min(items.length - 1, (ui.menu?.selected || 0) + 1) }; }
      else if (key.name === 'escape') { ui.menu = null; editor.setValue(''); }
      else if (key.name === 'enter') {
        // "/orq" + Enter runs the highlighted command, like picking it from the menu.
        const v = editor.value;
        if (v.startsWith('/') && !/\s/.test(v.trim())) {
          const items = filterCommands(v, ui.commands);
          const item = items[ui.menu?.selected || 0] || items[0];
          const typed = v.trim().toLowerCase();
          const matches = item && [item.name, ...(item.aliases || [])].some((n) => n.toLowerCase().startsWith(typed));
          if (matches) editor.setValue(item.name);
        }
        ui.menu = null;
        await submit(editor.submit());
      }
      else editor.handle(key);
      redraw();
    }
  }

  if (input.isTTY && input.setRawMode) { wasRaw = input.isRaw; input.setRawMode(true); input.resume(); }
  output.write('\x1b[?25h');
  input.on?.('data', onData); output.on?.('resize', onResize); engine.store?.on?.('change', onChange);
  process.once('SIGINT', onSig); process.once('SIGTERM', onSig);
  flushFinal(); redraw();
  return done;
}
