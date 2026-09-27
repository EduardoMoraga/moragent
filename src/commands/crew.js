import { requireRoot } from '../core/paths.js';
import { loadConfig, saveConfig } from '../core/config.js';
import { syncProject } from '../core/sync.js';
import { MoragentError } from '../core/errors.js';
import { t } from '../core/i18n.js';
import { json, out, ok, info } from '../core/log.js';
import { getAdapter } from '../crew/adapters.js';
import { loadPanes } from '../crew/panes.js';
import { getMux } from '../mux/index.js';

export default {
  name: 'crew',
  group: 'crew',
  summary: { es: 'Lista el equipo o cambia el CLI de un rol', en: 'List the crew or change a role CLI' },
  usage: 'mora crew [set <role> <cli>] [--dry-run] [--json]',
  async run(argv, ctx) {
    const root = ctx.root || requireRoot();
    const cfg = ctx.config || loadConfig(root);
    if (argv._[0] === 'set') {
      const [, role, cli] = argv._;
      if (!role || !cli) throw new MoragentError('USAGE', this.usage);
      if (!cfg.crew?.[role]) throw new MoragentError('UNKNOWN_ROLE', t(`Rol desconocido: ${role}`, `Unknown role: ${role}`));
      getAdapter(cli);
      cfg.crew[role].cli = cli;
      const dryRun = !!argv.flags['dry-run'];
      if (!dryRun) saveConfig(root, cfg);
      const synced = await syncProject(root, cfg, { dryRun });
      if (ctx.json) { json({ ok: true, role, cli, synced, dryRun }); return 0; }
      if (dryRun) info(t('Simulación — no se escribió ningún cambio.', 'Dry run — no changes were written.'));
      ok(t(`${role} ahora usa ${cli}.`, `${role} now uses ${cli}.`));
      return 0;
    }
    if (argv._.length) throw new MoragentError('USAGE', this.usage);
    const panes = loadPanes(root);
    const rows = Object.entries(cfg.crew || {}).map(([role, member]) => {
      const adapter = getAdapter(member.cli);
      const pane = panes[role];
      const alive = pane ? getMux(pane.mux).alive(pane.handle) : false;
      return { role, cli: member.cli, installed: adapter.installed(), pane: alive ? pane.handle : null, mux: alive ? pane.mux : null };
    });
    if (ctx.json) { json({ crew: rows }); return 0; }
    out(t('ROL       CLI          INSTALADO  PANEL', 'ROLE      CLI          INSTALLED  PANE'));
    for (const row of rows) out(`${row.role.padEnd(10)} ${row.cli.padEnd(12)} ${(row.installed ? t('sí', 'yes') : 'no').padEnd(10)} ${row.pane || '—'}`);
    return 0;
  },
};
