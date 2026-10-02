import { loadConfig } from '../core/config.js';
import { MoragentError } from '../core/errors.js';
import { t } from '../core/i18n.js';
import { out } from '../core/log.js';
import { createEngine } from '../engine/index.js';
import { resolveProject } from '../projects/registry.js';
import { acquireTelegramListenerLock, allowedTelegramIds, assertTelegramToken, TelegramBridge, telegramBotLockFile, telegramStateFile } from '../telegram/bridge.js';

export function retryDelay(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, { once: true });
  });
}

export default {
  name: 'telegram',
  group: 'start',
  summary: { es: 'Atiende un proyecto desde un bot de Telegram', en: 'Serve a project through a Telegram bot' },
  usage: 'mora telegram listen --project <id|name|path>  (MORAGENT_TELEGRAM_BOT_TOKEN, MORAGENT_TELEGRAM_ALLOWED_IDS)',
  async run(argv) {
    if (argv._.length !== 1 || argv._[0] !== 'listen' || typeof argv.flags.project !== 'string') throw new MoragentError('USAGE', this.usage);
    const project = resolveProject(argv.flags.project);
    const config = loadConfig(project.root);
    const token = assertTelegramToken(process.env.MORAGENT_TELEGRAM_BOT_TOKEN);
    const allowedIds = allowedTelegramIds(process.env.MORAGENT_TELEGRAM_ALLOWED_IDS);
    const stateFile = telegramStateFile(token);
    const release = acquireTelegramListenerLock(telegramBotLockFile(token));
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    let engine;
    try {
      engine = await createEngine({ root: project.root, config });
      const bridge = new TelegramBridge({ token, allowedIds, projectId: project.projectId, engine, stateFile });
      await engine.refreshProviders();
      await bridge.recoverPending(controller.signal);
      out(t(`Telegram conectado a ${project.name}. Ctrl+C para detener.`, `Telegram connected to ${project.name}. Ctrl+C to stop.`));
      let delay = 1000;
      while (!controller.signal.aborted) {
        try {
          await bridge.pollOnce(controller.signal);
          delay = 1000;
        } catch (error) {
          if (controller.signal.aborted) break;
          if (error?.code !== 'TELEGRAM_API') throw error;
          out(t(`Telegram sin conexión; reintentando en ${Math.ceil(delay / 1000)} s.`, `Telegram disconnected; retrying in ${Math.ceil(delay / 1000)} s.`));
          await retryDelay(delay, controller.signal);
          delay = Math.min(delay * 2, 30000);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      engine?.stop();
      release();
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
    return 0;
  },
};
