import { render } from './render.js';
import { LineEditor, decodeKeys } from './input.js';
import { TerminalScreen } from './screen.js';
import { LoginOverlay } from './login.js';

export async function runTui({ engine, input = process.stdin, output = process.stdout }) {
  const editor = new LineEditor();
  let scroll = 0;
  let overlay = null;
  let ctrlC = 0;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const screen = new TerminalScreen({ input, output });
  const state = () => engine.store?.state || {};
  const draw = ({ cols, rows }) => render(state(), { cols, rows, input: editor.value, scroll, overlay: overlay?.snapshot?.() || overlay });
  const exit = () => { cleanup(); engine.stop?.(); screen.restore(); resolveDone(); };
  const sigint = () => exit();
  const sigterm = () => exit();
  function cleanup() {
    engine.store?.off?.('change', onChange);
    input.off?.('data', onData);
    process.off('SIGINT', sigint);
    process.off('SIGTERM', sigterm);
  }
  function onChange() { screen.requestRender(); }
  async function submit(line) {
    if (!line) return;
    ctrlC = 0;
    if (line.startsWith('/')) {
      const [cmd, ...rest] = line.slice(1).split(/\s+/);
      if (cmd === 'salir' || cmd === 'exit') return exit();
      if (cmd === 'login') overlay = new LoginOverlay(state());
      else await engine.command(cmd, rest.length ? { args: rest } : {});
    } else await engine.send(line);
  }
  async function onData(buf) {
    const raw = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
    if (/^\/(salir|exit)\r?\n?$/.test(raw.trimEnd())) return exit();
    for (const key of decodeKeys(buf)) {
      if (overlay) {
        const r = await overlay.handle(key, engine);
        if (r.close) overlay = null;
        screen.requestRender();
        continue;
      }
      if (key.name === 'ctrl-c') {
        ctrlC++;
        const busy = ['thinking', 'running', 'reviewing'].includes(state().orchestrator?.status);
        if (ctrlC === 1 && busy) { await engine.command('cancel'); screen.requestRender(); continue; }
        return exit();
      }
      ctrlC = 0;
      if (key.name === 'escape') { overlay = null; screen.requestRender(); continue; }
      if (key.name === 'pageup') { scroll += 5; screen.requestRender(); continue; }
      if (key.name === 'pagedown') { scroll = Math.max(0, scroll - 5); screen.requestRender(); continue; }
      if (key.name === 'enter') await submit(editor.submit());
      else editor.handle(key);
      screen.requestRender();
    }
  }
  engine.store?.on?.('change', onChange);
  input.on?.('data', onData);
  process.once('SIGINT', sigint);
  process.once('SIGTERM', sigterm);
  screen.start(draw);
  return done;
}
