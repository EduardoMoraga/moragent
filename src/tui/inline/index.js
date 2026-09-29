import { spawn } from 'node:child_process';
import { c, plain } from '../../core/log.js';
import { LineEditor, TerminalKeyDecoder } from '../input.js';
import { renderLive, renderFinal, visualRows, filterCommands } from './render.js';
import { terminalText } from '../terminal-text.js';
import { COMMANDS as REGISTRY, welcomeLines } from '../../engine/commands.js';

// Slash menu entries come from the engine's registry; /tarea first because it is how you deploy an agent.
const DEFAULT_COMMANDS = [...REGISTRY]
  .sort((a, b) => (a.name === 'tarea' ? -1 : b.name === 'tarea' ? 1 : 0))
  .map((x) => ({ name: `/${x.name}`, aliases: (x.aliases || []).map((a) => `/${a}`), args: x.args, es: x.es, en: x.en }));

const ENGLISH_MENU_NAMES = {
  tarea: 'task', orquestador: 'orchestrator', modelo: 'model', idioma: 'language',
  recuperaciones: 'recoveries', equipo: 'crew', memoria: 'memory', abrir: 'open',
  agentes: 'agents', sesiones: 'sessions', sesion: 'session', limpiar: 'clear',
  nuevo: 'new', salir: 'exit',
};
const menuCommands = (lang) => DEFAULT_COMMANDS.map((cmd) => {
  const english = ENGLISH_MENU_NAMES[cmd.name.slice(1)];
  const name = lang === 'en' && english ? `/${english}` : cmd.name;
  return { ...cmd, name, aliases: [...new Set([cmd.name, ...cmd.aliases])].filter((alias) => alias !== name) };
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeLine = (value) => terminalText(value, { singleLine: true });

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
  return ref ? agents.find((a) => a.id === ref || a.taskId === ref || a.role === ref) : agents[0];
}

export async function runInline({ engine, input = process.stdin, output = process.stdout, spawnLogin = spawn }) {
  const editor = new LineEditor({ commands: DEFAULT_COMMANDS.flatMap((x) => [x.name, ...(x.aliases || [])]) });
  const keyDecoder = new TerminalKeyDecoder();
  const ui = { input: '', showAgents: false, commands: menuCommands(engine.store?.state?.lang), menu: null, picker: null, prompt: null, showWelcome: false };
  const printed = new Set();
  let liveRows = 0;
  let closed = false;
  let timer = null;
  let escapeTimer = null;
  let pulse = null;
  let wasRaw = false;
  let lastCtrlC = 0;
  let printedWelcome = false;
  let pendingModel = null;

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
    ui.input = ui.prompt?.kind === 'key' ? '•'.repeat(editor.value.length) : editor.value.replace(/\r\n?|\n/g, ' ↵ ');
    ui.menu = !ui.prompt && editor.value.startsWith('/') ? { ...(ui.menu || {}), items: filterCommands(editor.value, ui.commands) } : null;
    const lines = renderLive(state(), ui, { cols: cols() });
    output.write(lines.join('\n'));
    liveRows = visualRows(lines, cols());
  };
  const schedule = () => { if (!closed && !timer) timer = setTimeout(() => { timer = null; flushFinal(); redraw(); }, 16); };
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
      const summary = safeLine(a.lastLine || '').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
      const line = `${status} ${safeLine(a.role || a.id)} · ${safeLine(a.provider || '?')}  ${safeLine(a.taskId || a.id)}  ${a.elapsedMs ? `${Math.floor(a.elapsedMs / 1000)}s` : ''}  ${summary}`;
      const max = cols();
      writeBlock([plain(line).length > max ? `${line.slice(0, Math.max(0, max - 1 + (line.length - plain(line).length)))}…` : line]);
      printed.add(id);
    }
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    if (escapeTimer) clearTimeout(escapeTimer);
    if (pulse) clearInterval(pulse);
    eraseLive();
    if (input.isTTY && output.isTTY) output.write('\x1b[?2004l');
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
  const onChange = () => { ui.commands = menuCommands(state().lang); schedule(); };

  async function printAgentLog(ref) {
    const a = findAgent(state(), ref);
    eraseLive();
    if (!a) writeBlock([c.gray(tr('Sin agentes todavía.', 'No agents yet.'))]);
    else {
      writeBlock([`${safeLine(a.role || a.id)} · ${safeLine(a.provider || '?')} · ${safeLine(a.taskId || a.id)}`]);
      const lines = (a.log || []).map((x) => `[${safeLine(x.kind || 'text')}] ${terminalText(x.text)}`);
      writeBlock(lines.length ? lines : [c.gray(terminalText(a.lastLine || tr('sin registro', 'no log')))]);
    }
    redraw();
  }
  function openPicker(kind, items, title, extra = {}) { ui.picker = { kind, items, allItems: items, query: '', title, selected: 0, ...extra }; }
  function filterPicker(p, preserveSelection = false) {
    const selected = preserveSelection ? p.items?.[p.selected || 0] : null;
    const query = (p.query || '').toLocaleLowerCase();
    p.items = query ? p.allItems.filter((item) => `${item.label || ''} ${item.id || ''} ${item.provider || ''} ${item.model || ''}`.toLocaleLowerCase().includes(query)) : p.allItems;
    const match = selected ? p.items.findIndex((item) => item.id === selected.id && item.provider === selected.provider && item.model === selected.model) : -1;
    p.selected = match >= 0 ? match : 0;
  }
  const tr = (es, en) => state().lang === 'en' ? en : es;
  function openCatalog(role = null) {
    const providers = [...(state().providers || [])].sort((a, b) => Number(b.ready) - Number(a.ready));
    const kind = role ? 'model-role' : 'model-orchestrator';
    openPicker(kind, [{ id: '__loading__', label: tr('Cargando catálogo…', 'Loading catalog…') }], role ? tr(`Modelo para ${role}`, `Model for ${role}`) : tr('Modelo del orquestador', 'Orchestrator model'), { role });
    const picker = ui.picker;
    const catalogs = new Map();
    const updateCatalog = () => {
      if (ui.picker !== picker) return;
      picker.allItems = providers.flatMap((provider) => [
        { id: 'default', provider: provider.id, model: 'default', ready: provider.ready, label: `${provider.label || provider.id} · ${tr('predeterminado', 'default')}` },
        ...(catalogs.has(provider.id)
          ? catalogs.get(provider.id).map((m) => ({ id: m.id, provider: provider.id, model: m.id, ready: provider.ready, label: `  ${m.label || m.id}${m.note ? ` (${tr('sugerido', 'suggested')})` : ''}` }))
          : [{ id: '__loading__', provider: provider.id, ready: provider.ready, label: `  ${tr('Cargando catálogo…', 'Loading catalog…')}` }]),
        { id: '__other__', provider: provider.id, ready: provider.ready, label: `  ${tr('Otro ID de modelo…', 'Other model ID…')}` },
      ]);
      filterPicker(picker, true);
      schedule();
    };
    updateCatalog();
    for (const provider of providers) {
      Promise.resolve().then(() => engine.listModels?.(provider.id)).then((models) => {
        catalogs.set(provider.id, Array.isArray(models) ? models : []);
        updateCatalog();
      }).catch(() => {
        catalogs.set(provider.id, []);
        updateCatalog();
      });
    }
  }
  async function runSubscriptionLogin(id) {
    const command = engine.loginCommand?.(id);
    if (!command?.length) { await engine.command('login', { id }); return; }
    eraseLive();
    output.write(`\n${tr('Conectando', 'Connecting')} ${id}…\n`);
    input.off?.('data', onData);
    input.pause?.();
    if (input.isTTY && output.isTTY) output.write('\x1b[?2004l');
    if (input.isTTY && input.setRawMode) input.setRawMode(false);
    let error = null;
    try {
      await new Promise((resolve) => {
        const child = spawnLogin(command[0], command.slice(1), { stdio: 'inherit', cwd: engine.root || process.cwd() });
        child.once('error', (e) => { error = e.message; resolve(); });
        child.once('close', (code) => { if (code) error = `${tr('salió con código', 'exited with code')} ${code}`; resolve(); });
      });
    } catch (e) {
      error = e.message;
    } finally {
      if (!closed && input.isTTY && input.setRawMode) input.setRawMode(true);
      if (!closed && input.isTTY && output.isTTY) output.write('\x1b[?2004h');
      input.on?.('data', onData);
      input.resume?.();
      await engine.refreshProviders?.();
      if (pendingModel?.provider === id && state().providers?.some((p) => p.id === id && p.ready)) {
        const selected = pendingModel; pendingModel = null;
        await applyModel(selected.provider, selected.model, selected.role);
      }
      if (error) engine.store?.addMessage?.({ from: 'system', text: `${id}: ${error}` });
      redraw();
    }
  }
  async function beginLogin(id) {
    const provider = state().providers?.find((p) => p.id === id);
    if (!provider) return;
    if (provider.kind === 'subscription') return runSubscriptionLogin(id);
    if (id === 'ollama') {
      await engine.refreshProviders?.();
      if (!state().providers?.find((p) => p.id === id)?.ready) engine.store?.addMessage?.({ from: 'system', text: tr('Inicia Ollama con `ollama serve` y vuelve a usar /login.', 'Start Ollama with `ollama serve`, then use /login again.') });
      return;
    }
    if (id === 'compatible') {
      editor.setValue('');
      ui.prompt = { kind: 'endpoint', provider: id, title: tr('URL base HTTP(S), incluida /v1', 'HTTP(S) base URL, including /v1') };
      return;
    }
    editor.setValue('');
    ui.prompt = { kind: 'key', provider: id, title: tr(`Clave de API para ${provider.label || id}`, `API key for ${provider.label || id}`) };
  }
  async function applyModel(provider, model, role = null) {
    if (role) {
      await engine.command('equipo', [role, provider]);
      await engine.command('modelo', [role, model]);
    } else {
      await engine.command('orquestador', [provider]);
      await engine.command('modelo', [model]);
    }
  }
  async function acceptPicker() {
    const p = ui.picker; if (!p) return;
    const item = p.items[p.selected || 0];
    ui.picker = null;
    if (!item) { ui.picker = p; return; }
    if (p.kind === 'role-task') { editor.setValue(`${tr('/tarea', '/task')} ${item.id} `); return; }
    if (item.id === '__loading__') { ui.picker = p; return; }
    if (p.kind === 'login') { await beginLogin(item.id); return; }
    if (p.kind === 'orchestrator') { await engine.command('orquestador', [item.id]); openCatalog(); return; }
    if (p.kind === 'model-orchestrator' || p.kind === 'model-role') {
      if (!item.ready) {
        if (item.id !== '__other__') pendingModel = { provider: item.provider, model: item.model, role: p.role };
        await beginLogin(item.provider);
        return;
      }
      if (item.id === '__other__') { editor.setValue(''); ui.prompt = { kind: 'model', provider: item.provider, role: p.role, title: tr(`ID de modelo para ${item.provider}`, `Model ID for ${item.provider}`) }; return; }
      await applyModel(item.provider, item.model, p.role);
    }
  }
  async function submit(line) {
    const value = String(line || '').trim();
    if (!value) return;
    const observe = (work) => Promise.resolve(work).catch((error) => {
      if (closed) return;
      engine.store?.addMessage?.({ from: 'system', text: tr(`Error: ${error.message}`, `Error: ${error.message}`) });
      schedule();
    });
    if (!value.startsWith('/')) {
      // The engine serializes turns itself. Do not hold the terminal key loop
      // hostage to a slow provider: /cancel may be in this very same data chunk.
      observe(engine.send(value));
      return;
    }
    const [cmd, ...rest] = value.slice(1).split(/\s+/);
    const slash = `/${cmd}`;
    const rawArgs = value.slice(slash.length).trimStart();
    const taskCommand = ['/tarea', '/task', '/desplegar', '/deploy'].includes(slash);
    const known = commandFor(slash);
    if (!known) { editor.setValue(value); ui.menu = { items: filterCommands(value, ui.commands), selected: 0 }; return; }
    if (['/salir', '/exit', '/quit'].includes(slash)) return exit();
    if (['/agentes', '/agents'].includes(slash) && rest.length) return printAgentLog(rest[0]);
    if (['/agentes', '/agents'].includes(slash)) { ui.showAgents = !ui.showAgents; return; }
    if (taskCommand && rest.length < 2) { openPicker('role-task', roles(state()), tr('rol para /tarea', 'role for /task')); return; }
    if (slash === '/login') {
      const providers = [...(state().providers || [])].sort((a, b) => Number(b.ready) - Number(a.ready));
      if (rest.length && providers.some((p) => p.id === rest[0])) return beginLogin(rest[0]);
      openPicker('login', providers.map((p) => ({ id: p.id, label: p.label || p.id, ready: p.ready, note: p.detail || p.loginHint })), tr('Conectar un proveedor', 'Connect a provider'));
      return;
    }
    if (['/orquestador', '/orchestrator'].includes(slash) && !rest.length) { openPicker('orchestrator', [...(state().providers || [])].sort((a, b) => Number(b.ready) - Number(a.ready)).map((p) => ({ id: p.id, label: p.label || p.id, ready: p.ready, note: p.detail || p.loginHint })), tr('Orquestador', 'Orchestrator')); return; }
    if (['/modelo', '/model'].includes(slash) && !rest.length) { openCatalog(); return; }
    if (['/modelo', '/model'].includes(slash) && rest.length === 1 && engine.roleEngine?.(rest[0])) { openCatalog(rest[0]); return; }
    const args = taskCommand ? [rest[0], rawArgs.slice(rest[0].length).trimStart()]
      : slash === '/plan' ? (rawArgs ? [rawArgs] : []) : rest;
    const work = engine.command(cmd, args);
    if (['plan', 'tarea', 'task', 'desplegar', 'deploy'].includes(cmd)
        || (['recuperaciones', 'recoveries'].includes(cmd) && ['aplicar', 'apply'].includes(rest[0]))) observe(work);
    else await work;
  }
  async function onData(buf, flushEscape = false) {
    try {
    if (escapeTimer) { clearTimeout(escapeTimer); escapeTimer = null; }
    for (const key of flushEscape ? keyDecoder.flush() : keyDecoder.push(buf)) {
      if (ui.prompt) {
        if (key.name === 'escape' || key.name === 'ctrl-c') { ui.prompt = null; pendingModel = null; editor.setValue(''); }
        else if (key.name === 'enter') {
          const answer = editor.value.trim();
          const prompt = ui.prompt;
          editor.setValue(''); ui.prompt = null;
          if (answer && prompt.kind === 'endpoint') {
            try {
              const url = new URL(answer);
              if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid');
              await engine.command('login', { id: prompt.provider, url: answer });
              ui.prompt = { kind: 'key', provider: prompt.provider, title: tr('Clave de API opcional (Enter para omitir)', 'Optional API key (Enter to skip)') };
            } catch {
              engine.store?.addMessage?.({ from: 'system', text: tr('Escribe una URL HTTP(S) sin credenciales.', 'Enter an HTTP(S) URL without embedded credentials.') });
              ui.prompt = prompt;
            }
          }
          if (answer && prompt.kind === 'key') {
            await engine.command('login', { id: prompt.provider, key: answer });
          }
          if (prompt.kind === 'key' && !answer) await engine.refreshProviders?.();
          if (prompt.kind === 'key' && pendingModel?.provider === prompt.provider && state().providers?.some((p) => p.id === prompt.provider && p.ready)) {
            const selected = pendingModel; pendingModel = null;
            await applyModel(selected.provider, selected.model, selected.role);
          }
          if (answer && prompt.kind === 'model') await applyModel(prompt.provider, answer, prompt.role);
        } else editor.handle(key.name === 'paste' ? { ...key, value: key.value.replace(/[\r\n]+/g, '') } : key);
        schedule(); continue;
      }
      if (ui.picker) {
        if (key.name === 'escape' || key.name === 'ctrl-c') ui.picker = null;
        else if (key.name === 'up') ui.picker.selected = Math.max(0, (ui.picker.selected || 0) - 1);
        else if (key.name === 'down') ui.picker.selected = Math.min(ui.picker.items.length - 1, (ui.picker.selected || 0) + 1);
        else if (key.name === 'enter' || key.name === 'tab') await acceptPicker();
        else if (key.name === 'text' || key.name === 'paste') { ui.picker.query += key.value.replace(/[\r\n]+/g, ' '); filterPicker(ui.picker); }
        else if (key.name === 'backspace') { ui.picker.query = ui.picker.query.slice(0, -1); filterPicker(ui.picker); }
        schedule(); continue;
      }
      if (key.name === 'ctrl-c' && (editor.value || ui.picker)) { editor.setValue(''); ui.picker = null; ui.menu = null; redraw(); continue; }
      if (key.name === 'ctrl-c') {
        const now = Date.now();
        const busy = state().recoveryApplying || Object.values(state().agents || {}).some((a) => a.status === 'running') || ['thinking', 'reading', 'running', 'reviewing'].includes(state().orchestrator?.status);
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
      else editor.handle(key.name === 'paste' ? { ...key, value: key.value.replace(/\r\n?|\n/g, '\n') } : key);
      schedule();
    }
    if (keyDecoder.hasPendingEscape && !closed) {
      escapeTimer = setTimeout(() => { escapeTimer = null; void onData(null, true); }, 40);
    }
    } catch (error) {
      engine.store?.addMessage?.({ from: 'system', text: tr(`Error: ${error.message}`, `Error: ${error.message}`) });
      schedule();
    }
  }

  if (input.isTTY && input.setRawMode) { wasRaw = input.isRaw; input.setRawMode(true); input.resume(); }
  if (input.isTTY && output.isTTY) output.write('\x1b[?2004h');
  output.write('\x1b[?25h');
  input.on?.('data', onData); output.on?.('resize', onResize); engine.store?.on?.('change', onChange);
  process.once('SIGINT', onSig); process.once('SIGTERM', onSig);
  pulse = setInterval(() => {
    if (['thinking', 'reading', 'running', 'reviewing'].includes(state().orchestrator?.status) || Object.values(state().agents || {}).some((a) => a.status === 'running')) schedule();
  }, 1000);
  pulse.unref?.();
  flushFinal(); redraw();
  return done;
}
