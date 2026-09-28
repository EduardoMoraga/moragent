import { render } from './render.js';
import { LineEditor, decodeKeys } from './input.js';
import { TerminalScreen } from './screen.js';
import { LoginOverlay } from './login.js';

export async function runTui({ engine, input = process.stdin, output = process.stdout }) {
  const editor = new LineEditor();
  let scroll = 0;
  let newCount = 0;
  let lastMessageCount = 0;
  let overlay = null;
  let sidebar = true;
  let mouse = true;
  let ctrlC = 0;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const screen = new TerminalScreen({ input, output });
  const state = () => engine.store?.state || {};
  const page = () => Math.max(3, Math.floor((screen.size().rows || 24) / 2));
  const atBottom = () => scroll === 0;
  const draw = ({ cols, rows }) => render(state(), { cols, rows, input: editor.value, scroll, overlay: overlay?.snapshot?.() || overlay, sidebar, newCount });
  const exit = () => { cleanup(); engine.stop?.(); screen.restore(); resolveDone(); };
  const sigint = () => exit();
  const sigterm = () => exit();
  function cleanup() {
    engine.store?.off?.('change', onChange);
    input.off?.('data', onData);
    process.off('SIGINT', sigint);
    process.off('SIGTERM', sigterm);
  }
  function onChange() {
    const count = (state().messages || []).length;
    if (!atBottom() && count > lastMessageCount) newCount += count - lastMessageCount;
    lastMessageCount = count;
    screen.requestRender();
  }
  function openAgents() { overlay = { type: 'agents', selected: 0, scroll: 0 }; }
  function openSessions() { overlay = { type: 'sessions', selected: 0, scroll: 0 }; }
  async function submit(line) {
    if (!line) return;
    ctrlC = 0;
    if (line.startsWith('/')) {
      const [cmd, ...rest] = line.slice(1).split(/\s+/);
      if (cmd === 'salir' || cmd === 'exit') return exit();
      if (cmd === 'login') overlay = new LoginOverlay(state());
      else if (cmd === 'agentes' || cmd === 'agents') openAgents();
      else if (cmd === 'sesiones' || cmd === 'sessions') openSessions();
      else if (cmd === 'mouse') { mouse = !mouse; output.write(mouse ? '\x1b[?1000h\x1b[?1006h' : '\x1b[?1006l\x1b[?1000l'); }
      else await engine.command(cmd, rest.length ? rest : []);
    } else await engine.send(line);
  }
  async function handleOverlay(key) {
    if (overlay?.handle) {
      const r = await overlay.handle(key, engine);
      if (r.close) overlay = null;
      return;
    }
    if (key.name === 'escape') { overlay = null; return; }
    if (overlay?.type === 'agents') {
      const n = Object.keys(state().agents || {}).length;
      if (key.name === 'up') overlay.selected = Math.max(0, (overlay.selected || 0) - 1);
      else if (key.name === 'down') overlay.selected = Math.min(Math.max(0, n - 1), (overlay.selected || 0) + 1);
      else if (key.name === 'pageup') overlay.scroll = Math.max(0, (overlay.scroll || 0) - page());
      else if (key.name === 'pagedown') overlay.scroll = (overlay.scroll || 0) + page();
      return;
    }
    if (overlay?.type === 'sessions') {
      const sessions = state().sessions || [];
      if (key.name === 'up') overlay.selected = Math.max(0, (overlay.selected || 0) - 1);
      else if (key.name === 'down') overlay.selected = Math.min(Math.max(0, sessions.length - 1), (overlay.selected || 0) + 1);
      else if (key.name === 'enter') {
        const s = sessions[overlay.selected || 0];
        if (s) await engine.command('sesion', [s.id]);
        overlay = null;
      }
    }
  }
  async function onData(buf) {
    const raw = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
    if (/^\/(salir|exit)\r?\n?$/.test(raw.trimEnd())) return exit();
    for (const key of decodeKeys(buf)) {
      if (overlay) { await handleOverlay(key); screen.requestRender(); continue; }
      if (key.name === 'tab') { openAgents(); screen.requestRender(); continue; }
      if (key.name === 'ctrl-b') { sidebar = !sidebar; if (colsNarrow()) overlay = sidebar ? { type: 'sidebar' } : null; screen.requestRender(); continue; }
      if (key.name === 'ctrl-c') {
        ctrlC++;
        const busy = ['thinking', 'running', 'reviewing'].includes(state().orchestrator?.status);
        if (ctrlC === 1 && busy) { await engine.command('cancel'); screen.requestRender(); continue; }
        return exit();
      }
      ctrlC = 0;
      if (key.name === 'escape') { overlay = null; screen.requestRender(); continue; }
      if (key.name === 'pageup') { scroll += page(); screen.requestRender(); continue; }
      if (key.name === 'pagedown') { scroll = Math.max(0, scroll - page()); if (scroll === 0) newCount = 0; screen.requestRender(); continue; }
      if (key.name === 'shift-up' || key.name === 'wheel-up') { scroll += 1; screen.requestRender(); continue; }
      if (key.name === 'shift-down' || key.name === 'wheel-down') { scroll = Math.max(0, scroll - 1); if (scroll === 0) newCount = 0; screen.requestRender(); continue; }
      if (key.name === 'end') { scroll = 0; newCount = 0; screen.requestRender(); continue; }
      if (key.name === 'enter') await submit(editor.submit());
      else editor.handle(key);
      screen.requestRender();
    }
  }
  function colsNarrow() { return (screen.size().cols || 80) < 100; }
  lastMessageCount = (state().messages || []).length;
  engine.store?.on?.('change', onChange);
  input.on?.('data', onData);
  process.once('SIGINT', sigint);
  process.once('SIGTERM', sigterm);
  screen.start(draw);
  return done;
}
