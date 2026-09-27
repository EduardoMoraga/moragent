import { requireRoot } from '../core/paths.js';
import { json, out } from '../core/log.js';
import { MoragentError } from '../core/errors.js';
import { contextPack } from '../memory/index.js';

export default {
  name: 'context',
  aliases: ['ctx'],
  group: 'memory',
  summary: {
    es: 'Genera el paquete de contexto compilado para un rol',
    en: 'Compile and print context pack for a role',
  },
  usage: 'mora context <role> [--query "…"] [--budget 6000] [--json]',

  async run(argv, ctx) {
    const root = ctx.root || requireRoot();
    const role = argv._[0];

    if (!role) {
      throw new MoragentError('USAGE', 'mora context <role> [--query "…"] [--budget 6000] [--json]');
    }

    const query = typeof argv.flags.query === 'string' ? argv.flags.query : '';
    const budget = argv.flags.budget ? Number(argv.flags.budget) : 6000;

    const pack = contextPack({ root, role, query, budget, lang: ctx.lang });

    if (ctx.json) {
      json({
        ok: true,
        role,
        budget,
        chars: pack.length,
        context: pack,
      });
      return 0;
    }

    out(pack);
    return 0;
  },
};
