import { requireRoot } from '../core/paths.js';
import { isValidWorkerRole, loadConfig, saveConfig } from '../core/config.js';
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
  summary: { es: 'Lista, agrega o cambia roles del equipo', en: 'List, add, or change crew roles' },
  usage: 'mora crew [add <role> <cli> --mission "…" [--capabilities a,b] | set <role> <cli>] [--dry-run] [--json]',
  async run(argv, ctx) {
    const root = ctx.root || requireRoot();
    const cfg = ctx.config || loadConfig(root);
    if (argv._[0] === 'add') {
      const [, role, cli] = argv._;
      if (argv._.length !== 3 || !role || !cli) throw new MoragentError('USAGE', this.usage);
      if (!isValidWorkerRole(role)) throw new MoragentError('BAD_ROLE', t(`Nombre de rol inválido: ${role}`, `Invalid role name: ${role}`), 'a-z, 0-9, _, -; 1–40 caracteres; no lead');
      if (Object.hasOwn(cfg.crew || {}, role)) throw new MoragentError('ROLE_EXISTS', t(`El rol ya existe: ${role}`, `Role already exists: ${role}`));
      getAdapter(cli);
      const mission = argv.flags.mission;
      if (typeof mission !== 'string' || !mission.trim()) throw new MoragentError('MISSING_MISSION', t('Indica una misión con --mission.', 'Provide a mission with --mission.'), this.usage);
      const rawCapabilities = argv.flags.capabilities;
      if (rawCapabilities !== undefined && typeof rawCapabilities !== 'string') throw new MoragentError('BAD_CAPABILITIES', t('Usa --capabilities a,b.', 'Use --capabilities a,b.'));
      const capabilities = rawCapabilities === undefined ? [] : rawCapabilities.split(',').map((x) => x.trim());
      if (capabilities.some((x) => !x || !/^[a-z][a-z0-9_-]{0,39}$/.test(x))) throw new MoragentError('BAD_CAPABILITIES', t('Las capacidades deben ser etiquetas a-z, 0-9, _, -.', 'Capabilities must be a-z, 0-9, _, - labels.'));
      const member = { cli, title: role, mission: mission.trim(), capabilities: [...new Set(capabilities)] };
      const nextCfg = { ...cfg, crew: { ...cfg.crew, [role]: member } };
      const dryRun = !!argv.flags['dry-run'];
      if (!dryRun) saveConfig(root, nextCfg);
      const synced = await syncProject(root, nextCfg, { dryRun });
      if (ctx.json) { json({ ok: true, role, ...member, synced, dryRun }); return 0; }
      if (dryRun) info(t('Simulación — no se escribió ningún cambio.', 'Dry run — no changes were written.'));
      ok(t(`Rol ${role} agregado con ${cli}.`, `Role ${role} added with ${cli}.`));
      return 0;
    }
    if (argv._[0] === 'set') {
      const [, role, cli] = argv._;
      if (!role || !cli) throw new MoragentError('USAGE', this.usage);
      if (!Object.hasOwn(cfg.crew || {}, role)) throw new MoragentError('UNKNOWN_ROLE', t(`Rol desconocido: ${role}`, `Unknown role: ${role}`));
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
      return { role, cli: member.cli, mission: member.mission || '', capabilities: member.capabilities || [], installed: adapter.installed(), pane: alive ? pane.handle : null, mux: alive ? pane.mux : null };
    });
    if (ctx.json) { json({ crew: rows }); return 0; }
    out(t('ROL       CLI          INSTALADO  PANEL', 'ROLE      CLI          INSTALLED  PANE'));
    for (const row of rows) out(`${row.role.padEnd(10)} ${row.cli.padEnd(12)} ${(row.installed ? t('sí', 'yes') : 'no').padEnd(10)} ${row.pane || '—'}`);
    return 0;
  },
};
