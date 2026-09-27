import { requireRoot } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import { MoragentError } from '../core/errors.js';
import { t } from '../core/i18n.js';
import { json, info } from '../core/log.js';
import { printTrustResults, trustRoles } from '../crew/trust.js';

export default {
  name: 'trust',
  group: 'crew',
  summary: { es: 'Acepta diálogos conocidos de confianza', en: 'Accept known trust dialogs' },
  usage: 'mora trust [roles…] [--json]',
  async run(argv, ctx) {
    const root = ctx.root || requireRoot();
    const cfg = ctx.config || loadConfig(root);
    for (const role of argv._) if (!cfg.crew?.[role]) throw new MoragentError(
      'UNKNOWN_ROLE',
      t(`Rol desconocido: ${role}`, `Unknown role: ${role}`),
    );
    const results = trustRoles({ root, roles: argv._, strict: argv._.length > 0, waitMs: 750 });
    const complete = results.every((item) => item.action !== 'unknown');
    if (ctx.json) json({ ok: complete, panes: results });
    else if (results.length) printTrustResults(results);
    else info(t('No hay paneles vivos que revisar.', 'There are no live panes to inspect.'));
    return complete ? 0 : 3;
  },
};
