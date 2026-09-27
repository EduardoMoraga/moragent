import { requireRoot } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import { nowISO } from '../core/fsx.js';
import { MoragentError } from '../core/errors.js';
import { t } from '../core/i18n.js';
import { json, out, info, warn } from '../core/log.js';
import { getAdapter } from '../crew/adapters.js';
import { loadPanes, savePanes } from '../crew/panes.js';
import { printTrustResults, trustRoles } from '../crew/trust.js';
import { parseDuration } from '../bus/wait.js';
import { ensureShim } from '../core/shim.js';
import { detectMux, getMux } from '../mux/index.js';

export const flagOn = (value) => value !== undefined && value !== false && value !== 'false' && value !== '0';

export function isCurrentLead(cfg, env = process.env) {
  if (env.MORAGENT_ROLE) return env.MORAGENT_ROLE === 'lead';
  const cli = env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT ? 'claude'
    : env.CODEX_SESSION_ID || env.CODEX_THREAD_ID ? 'codex'
      : env.GEMINI_CLI ? 'gemini'
        : null;
  return !!cli && cli === cfg.crew?.lead?.cli;
}

export default {
  name: 'up',
  group: 'crew',
  summary: { es: 'Abre paneles para el equipo', en: 'Open panes for the crew' },
  usage: 'mora up [roles…] [--mux orca|herdr|tmux|headless] [--with-lead] [--yolo] [--trust] [--timeout 25s] [--dry-run] [--json]',
  async run(argv, ctx) {
    const root = ctx.root || requireRoot();
    const cfg = ctx.config || loadConfig(root);
    const positionals = [...argv._];
    if (typeof argv.flags['with-lead'] === 'string' && cfg.crew?.[argv.flags['with-lead']]) positionals.push(argv.flags['with-lead']);
    if (typeof argv.flags.yolo === 'string' && cfg.crew?.[argv.flags.yolo]) positionals.push(argv.flags.yolo);
    if (typeof argv.flags.trust === 'string' && cfg.crew?.[argv.flags.trust]) positionals.push(argv.flags.trust);
    const requested = positionals.length ? positionals : Object.keys(cfg.crew || {});
    const withLead = flagOn(argv.flags['with-lead']);
    const yolo = flagOn(argv.flags.yolo);
    const acceptTrust = flagOn(argv.flags.trust);
    const leadCurrent = !withLead && requested.includes('lead') && isCurrentLead(cfg);
    const roles = requested.filter((role) => role !== 'lead' || !leadCurrent);
    for (const role of requested) if (!cfg.crew?.[role]) throw new MoragentError('UNKNOWN_ROLE', t(`Rol desconocido: ${role}`, `Unknown role: ${role}`));
    const muxName = detectMux(typeof argv.flags.mux === 'string' ? argv.flags.mux : cfg.mux);
    const mux = getMux(muxName);
    const panes = loadPanes(root);
    if (!argv.flags['dry-run']) ensureShim(root);
    const opened = [];
    let anchor;
    for (const role of roles) {
      const member = cfg.crew[role];
      const adapter = getAdapter(member.cli);
      if (!adapter.installed()) {
        if (!ctx.json) warn(t(`${role}: ${member.cli} no está instalado; se omitió.`, `${role}: ${member.cli} is not installed; skipped.`));
        opened.push({ role, cli: member.cli, mux: muxName, handle: null, status: 'missing' });
        continue;
      }
      const autonomy = yolo ? 'full' : member.autonomy || 'auto';
      const command = adapter.interactive({ root, role, member, autonomy });
      const current = panes[role];
      const alive = current?.mux === muxName && mux.alive(current.handle);
      const sameSession = alive
        && current.cli === member.cli
        && (current.autonomy || 'auto') === autonomy;
      if (sameSession) {
        opened.push({ role, cli: member.cli, mux: muxName, handle: panes[role].handle, status: 'existing' });
        anchor = panes[role].handle;
        continue;
      }
      if (alive && argv.flags['dry-run']) {
        opened.push({ role, cli: member.cli, mux: muxName, handle: current.handle, command, autonomy, status: 'restart' });
        continue;
      }
      if (alive) {
        mux.close(current.handle, { layout: current.layout });
        delete panes[role];
      }
      if (argv.flags['dry-run']) {
        opened.push({ role, cli: member.cli, mux: muxName, handle: null, command, autonomy, status: 'dry-run' });
        continue;
      }
      const result = mux.spawn({ root, role, title: member.title || role, command, cwd: root, anchor, member, adapter, autonomy, layout: cfg.layout || 'split' });
      panes[role] = { mux: muxName, handle: result.handle, cli: member.cli, autonomy, layout: result.layout, startedAt: nowISO() };
      opened.push({ role, cli: member.cli, mux: muxName, handle: result.handle, layout: result.layout, status: 'opened', session: result.session });
      anchor = result.handle;
    }
    if (!argv.flags['dry-run']) savePanes(root, panes);
    const trustable = opened.filter((item) => item.handle && ['opened', 'existing'].includes(item.status)).map((item) => item.role);
    const trust = acceptTrust && trustable.length && !argv.flags['dry-run'] && muxName !== 'headless'
      ? trustRoles({ root, roles: trustable, strict: false, timeoutMs: parseDuration(argv.flags.timeout, 25000) })
      : [];
    const trustComplete = trust.every((item) => !['unknown', 'exited'].includes(item.action));
    if (ctx.json) { json({ ok: trustComplete, mux: muxName, panes: opened, trust, leadCurrent, dryRun: !!argv.flags['dry-run'] }); return trustComplete ? 0 : 3; }
    if (argv.flags['dry-run']) info(t('Simulación — no se abrió ningún panel.', 'Dry run — no pane was opened.'));
    out(t('ROL       CLI          PANEL', 'ROLE      CLI          PANE'));
    for (const item of opened) out(`${item.role.padEnd(10)} ${item.cli.padEnd(12)} ${item.handle || item.status}`);
    if (trust.length) { out(''); printTrustResults(trust); }
    if (leadCurrent) info(t('El lead usa la terminal actual. Usa --with-lead para abrir otro panel.', 'The lead uses the current terminal. Use --with-lead to open another pane.'));
    if (!acceptTrust && !argv.flags['dry-run'] && muxName !== 'headless' && opened.some((item) => item.status === 'opened')) {
      info(t('Si un panel pregunta si confías en esta carpeta, acepta el diálogo antes de despachar tareas.', 'If a pane asks whether you trust this folder, accept the dialog before dispatching tasks.'));
    }
    const session = opened.find((item) => item.session)?.session;
    if (session) info(`tmux attach -t ${session}`);
    return trustComplete ? 0 : 3;
  },
};
