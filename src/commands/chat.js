import { createEngine } from '../engine/index.js';
import { MoragentError } from '../core/errors.js';
import { t } from '../core/i18n.js';

// The native app: `moragent` with no arguments in a terminal lands here.
export default {
  name: 'chat',
  aliases: ['app', 'tui'],
  group: 'start',
  summary: { es: 'Abre MORAGENT: conversa con el orquestador y sus subagentes', en: 'Open MORAGENT: talk to the orchestrator and its subagents' },
  usage: 'moragent  ·  mora chat',
  async run(argv, ctx) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new MoragentError('NO_TTY', t('La app necesita una terminal interactiva.', 'The app needs an interactive terminal.'), 'mora status · mora help');
    }
    let tui;
    try { tui = await import('../tui/inline/index.js'); } catch (e) {
      if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e;
      throw new MoragentError('NO_TUI', t('La interfaz todavía no está instalada.', 'The interface is not installed yet.'), 'mora status');
    }
    const engine = await createEngine({ root: ctx.root, config: ctx.config, cwd: ctx.cwd || process.cwd(), lang: typeof argv.flags.lang === 'string' ? ctx.lang : null });
    await engine.refreshProviders();
    engine.welcome({ brief: true });
    await tui.runInline({ engine });
    engine.stop();
    return 0;
  },
};
