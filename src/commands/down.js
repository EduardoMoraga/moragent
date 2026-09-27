import { requireRoot } from '../core/paths.js';
import { MoragentError } from '../core/errors.js';
import { t } from '../core/i18n.js';
import { json, ok, warn } from '../core/log.js';
import { loadPanes, savePanes } from '../crew/panes.js';
import { getMux } from '../mux/index.js';

export default {
  name: 'down',
  group: 'crew',
  summary: { es: 'Cierra los paneles registrados', en: 'Close registered crew panes' },
  usage: 'mora down [roles…] [--dry-run] [--json]',
  async run(argv, ctx) {
    const root = ctx.root || requireRoot();
    const panes = loadPanes(root);
    const roles = argv._.length ? argv._ : Object.keys(panes);
    const closed = [];
    for (const role of roles) {
      const pane = panes[role];
      if (!pane) {
        if (argv._.length) throw new MoragentError('PANE_NOT_FOUND', t(`No hay panel registrado para ${role}.`, `No registered pane for ${role}.`));
        continue;
      }
      const mux = getMux(pane.mux);
      if (mux.alive(pane.handle)) {
        if (!argv.flags['dry-run']) mux.close(pane.handle, { layout: pane.layout });
      }
      else {
        if (!argv.flags['dry-run'] && pane.mux === 'headless') mux.close(pane.handle);
        if (!ctx.json) warn(t(`${role}: el panel ya no estaba activo.`, `${role}: pane was already inactive.`));
      }
      if (!argv.flags['dry-run']) delete panes[role];
      closed.push(role);
    }
    if (!argv.flags['dry-run']) savePanes(root, panes);
    if (ctx.json) { json({ ok: true, closed, dryRun: !!argv.flags['dry-run'] }); return 0; }
    ok(t(`Paneles cerrados: ${closed.join(', ') || 'ninguno'}`, `Closed panes: ${closed.join(', ') || 'none'}`));
    return 0;
  },
};
