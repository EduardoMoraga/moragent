import { MoragentError } from '../core/errors.js';
import { json, out } from '../core/log.js';
import { t } from '../core/i18n.js';
import { listRemotes, registerRemote, resolveRemote } from '../remote/registry.js';
import { probeRemote } from '../remote/probe.js';
import { openRemote } from '../remote/open.js';

export default {
  name: 'remote',
  aliases: ['remoto'],
  group: 'start',
  summary: { es: 'Registra y comprueba destinos SSH', en: 'Register and probe SSH destinations' },
  usage: 'mora remote add <host> <absolute-root> [--name NAME] | list | probe <id|name|host> | open <id|name|host> [--persist]',
  async run(argv, ctx) {
    const [action = 'list', ...args] = argv._;
    if (action === 'add') {
      if (args.length !== 2 || argv.flags.name === true) throw new MoragentError('USAGE', this.usage);
      const result = registerRemote(args[0], args[1], { name: argv.flags.name });
      if (ctx.json) json({ ok: true, ...result });
      else out(`${result.created ? t('Registrado', 'Registered') : t('Ya registrado', 'Already registered')}: ${result.remote.name} (${result.remote.remoteId})\n${result.remote.host}:${result.remote.root}`);
      return 0;
    }
    if (action === 'list') {
      if (args.length) throw new MoragentError('USAGE', this.usage);
      const remotes = listRemotes();
      if (ctx.json) json({ ok: true, remotes });
      else if (!remotes.length) out(t('No hay destinos SSH. Usa: mora remote add <host> <ruta>', 'No SSH destinations. Use: mora remote add <host> <path>'));
      else for (const r of remotes) out(`${r.remoteId}  ${r.name}\n  ${r.host}:${r.root}`);
      return 0;
    }
    if (action === 'probe') {
      if (args.length !== 1) throw new MoragentError('USAGE', this.usage);
      const result = probeRemote(resolveRemote(args[0]));
      if (ctx.json) json({ ok: result.status === 'ready', ...result });
      else out(`${result.host}:${result.root} — ${result.status}`);
      return result.status === 'ready' ? 0 : 1;
    }
    if (action === 'open') {
      if (args.length !== 1 || ctx.json) throw new MoragentError('USAGE', this.usage);
      return openRemote(resolveRemote(args[0]), { persist: argv.flags.persist === true });
    }
    throw new MoragentError('USAGE', this.usage);
  },
};
