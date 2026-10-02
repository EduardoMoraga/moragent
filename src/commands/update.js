import { selfUpdate, updateMessage } from '../core/self-update.js';
import { getLang } from '../core/i18n.js';
import { json, out } from '../core/log.js';
import { MoragentError } from '../core/errors.js';

export default {
  name: 'update',
  aliases: ['actualizar'],
  group: 'system',
  summary: { es: 'Comprueba o actualiza MORAGENT', en: 'Check or update MORAGENT' },
  usage: 'mora update [--check]',
  async run(argv, ctx) {
    if (argv._.length || Object.keys(argv.flags).some((key) => !['check', 'json', 'lang'].includes(key))) {
      throw new MoragentError('USAGE', this.usage);
    }
    const result = await selfUpdate({ check: !!argv.flags.check });
    const failureStatuses = ['unsupported', 'dirty', 'diverged', 'failed'];
    if (ctx.json) json({ ok: !failureStatuses.includes(result.status), ...result });
    else out(updateMessage(result, getLang()));
    return failureStatuses.includes(result.status) ? 1 : 0;
  },
};
