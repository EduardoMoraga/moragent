import { requireRoot } from '../core/paths.js';
import { loadConfig, saveConfig } from '../core/config.js';
import { json, out, ok } from '../core/log.js';
import { t } from '../core/i18n.js';
import { MoragentError } from '../core/errors.js';

// Dotted-path get/set: mora config get crew.backend.cli · mora config set lang en
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
function setPath(o, p, v) {
  const keys = p.split('.');
  let cur = o;
  for (const k of keys.slice(0, -1)) cur = cur[k] ??= {};
  cur[keys.at(-1)] = v;
}
const coerce = (v) => (v === 'true' ? true : v === 'false' ? false : v === 'null' ? null : /^\d+$/.test(v) ? Number(v) : v);

export default {
  name: 'config',
  group: 'system',
  summary: { es: 'Lee o cambia la configuración (.moragent/moragent.json)', en: 'Read or change the config (.moragent/moragent.json)' },
  usage: 'mora config [get <path> | set <path> <value>]',
  async run(argv, ctx) {
    const root = ctx.root || requireRoot();
    const cfg = loadConfig(root);
    const [op, key, value] = argv._;
    if (!op || op === 'show') { json(cfg); return 0; }
    if (op === 'get') { const v = getPath(cfg, key || ''); ctx.json || typeof v === 'object' ? json(v ?? null) : out(String(v ?? '')); return 0; }
    if (op === 'set') {
      if (!key || value === undefined) throw new MoragentError('USAGE', 'mora config set <path> <value>');
      setPath(cfg, key, coerce(value));
      saveConfig(root, cfg);
      ok(t(`${key} = ${value}`, `${key} = ${value}`));
      return 0;
    }
    throw new MoragentError('USAGE', this.usage);
  },
};
