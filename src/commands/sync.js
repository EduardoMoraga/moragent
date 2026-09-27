import path from 'node:path';
import { requireRoot } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import { syncProject } from '../core/sync.js';
import { installHooks } from '../core/hooks.js';
import { ok, info, json, c } from '../core/log.js';
import { t } from '../core/i18n.js';

export default {
  name: 'sync',
  group: 'system',
  summary: { es: 'Regenera AGENTS.md/CLAUDE.md/GEMINI.md y copia skills a cada CLI', en: 'Regenerate AGENTS.md/CLAUDE.md/GEMINI.md and copy skills to every CLI' },
  usage: 'mora sync [--hooks [--global]] [--dry-run] [--json]',
  details: {
    es: '--hooks instala la captura automática de memoria: hook SessionEnd en .claude/settings.json (proyecto). Con --global también agrega notify a ~/.codex/config.toml (Codex ignora notify a nivel de proyecto). Nunca reemplaza hooks ni un notify existente.',
    en: '--hooks installs automatic memory capture: a SessionEnd hook in .claude/settings.json (project). With --global it also adds notify to ~/.codex/config.toml (Codex ignores project-level notify). Never replaces existing hooks or an existing notify.',
  },
  async run(argv, ctx) {
    const root = ctx.root || requireRoot();
    const cfg = ctx.config || loadConfig(root);
    const r = await syncProject(root, cfg, { dryRun: !!argv.flags['dry-run'] });
    r.hooks = argv.flags.hooks ? installHooks(root, r.clis, { dryRun: !!argv.flags['dry-run'], global: !!argv.flags.global }) : [];
    if (ctx.json) { json({ ok: true, ...r }); return 0; }
    const rel = (p) => path.relative(root, p) || p;
    if (argv.flags['dry-run']) info(t('Simulación — no se escribió nada', 'Dry run — nothing written'));
    ok(t(`Instrucciones: ${r.files.length ? r.files.map(rel).join(', ') : 'sin cambios'}`, `Instructions: ${r.files.length ? r.files.map(rel).join(', ') : 'up to date'}`));
    ok(t(`Skills: ${r.skills.length} archivo(s) para ${r.clis.join(', ')}`, `Skills: ${r.skills.length} file(s) for ${r.clis.join(', ')}`));
    if (argv.flags.hooks) ok(t(`Hooks de memoria: ${r.hooks.length ? r.hooks.map(rel).join(', ') : 'ya instalados'}`, `Memory hooks: ${r.hooks.length ? r.hooks.map(rel).join(', ') : 'already installed'}`));
    if (!r.skills.length && !r.files.length && !argv.flags.hooks) info(c.dim(t('Todo al día.', 'Everything up to date.')));
    return 0;
  },
};
