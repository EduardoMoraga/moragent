import fs from 'node:fs';
import path from 'node:path';
import { dirs, findRoot } from '../core/paths.js';
import { defaultConfig, PRESETS, DEFAULT_CLI, CLI_IDS, saveConfig } from '../core/config.js';
import { ensureDir, writeIfAbsent, writeText, exists, nowISO, today } from '../core/fsx.js';
import { which } from '../core/exec.js';
import { syncProject } from '../core/sync.js';
import { installHooks } from '../core/hooks.js';
import { setLang, t, detectLang } from '../core/i18n.js';
import { ok, info, warn, out, c, json } from '../core/log.js';
import { MoragentError } from '../core/errors.js';

const BIN = { claude: 'claude', codex: 'codex', agy: 'agy', pi: 'pi', opencode: 'opencode', gemini: 'gemini' };
const PREFERENCE = ['claude', 'codex', 'pi', 'agy', 'opencode', 'gemini'];

export const installedClis = () => CLI_IDS.filter((id) => which(BIN[id]));

// Keep the default CLI for a role when installed, otherwise the first installed one.
export function assignClis(roles, installed, overrides = {}) {
  const out = {};
  for (const role of roles) {
    const want = overrides[role] || DEFAULT_CLI[role];
    out[role] = installed.includes(want) || overrides[role] ? want : PREFERENCE.find((id) => installed.includes(id)) || want;
  }
  return out;
}

const GITIGNORE = `# MORAGENT — local-only state
memory/transient/
context/
runs/
`;

export function scaffold(root, cfg) {
  const d = dirs(root);
  for (const k of ['canonical', 'episodic', 'transient', 'specs', 'tasks', 'skills', 'context', 'runs']) ensureDir(d[k]);
  saveConfig(root, cfg);
  writeIfAbsent(path.join(d.mora, '.gitignore'), GITIGNORE);
  const es = cfg.lang === 'es';
  writeIfAbsent(path.join(d.canonical, 'project.md'), `---
id: project
tier: canonical
kind: fact
title: ${cfg.project}
tags: [project]
links: []
by: moragent
created: ${nowISO()}
---
${cfg.goal || (es ? 'Describe aquí el objetivo del proyecto en 2-3 líneas.' : 'Describe the project goal here in 2-3 lines.')}

${es ? 'Creado con' : 'Created with'} \`mora init\` ${es ? 'el' : 'on'} ${today()} — preset \`${cfg.preset}\`.
`);
}

export default {
  name: 'init',
  group: 'start',
  summary: { es: 'Convierte esta carpeta en un proyecto agéntico', en: 'Turn this folder into an agentic project' },
  usage: 'mora init [name] [--preset solo|duo|trio|squad] [--lang es|en] [--goal "…"] [--crew backend=codex,dev=pi] [--no-hooks] [--yes] [--force]',
  async run(argv, ctx) {
    const cwd = path.resolve(typeof argv.flags.dir === 'string' ? argv.flags.dir : process.cwd());
    const existing = findRoot(cwd);
    if (existing === cwd && !argv.flags.force) {
      throw new MoragentError('ALREADY_INIT', t('Este proyecto ya tiene MORAGENT.', 'This project already has MORAGENT.'), 'mora  ·  mora init --force');
    }
    const installed = installedClis();
    let answers = {
      project: argv._[0] || path.basename(cwd),
      lang: typeof argv.flags.lang === 'string' ? argv.flags.lang : (ctx.config?.lang || detectLang()),
      preset: typeof argv.flags.preset === 'string' ? argv.flags.preset : 'squad',
      goal: typeof argv.flags.goal === 'string' ? argv.flags.goal : '',
      clis: {},
    };
    if (typeof argv.flags.crew === 'string') {
      for (const pair of argv.flags.crew.split(',')) { const [r, cli] = pair.split('='); if (r && cli) answers.clis[r.trim()] = cli.trim(); }
    }

    const interactive = process.stdin.isTTY && process.stdout.isTTY && !argv.flags.yes && !ctx.json;
    if (interactive) {
      try {
        const { runWizard } = await import('../ui/wizard.js');
        const w = await runWizard({ defaults: answers, installed, presets: PRESETS });
        if (!w) return 1;
        answers = { ...answers, ...w };
      } catch (e) {
        if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e;
      }
    }
    setLang(answers.lang);
    if (!PRESETS[answers.preset]) throw new MoragentError('BAD_PRESET', `preset: ${answers.preset}`, Object.keys(PRESETS).join(' | '));

    const clis = assignClis(PRESETS[answers.preset].roles, installed, answers.clis);
    const cfg = defaultConfig({ project: answers.project, lang: answers.lang, preset: answers.preset, clis });
    if (answers.goal) cfg.goal = answers.goal;
    scaffold(cwd, cfg);
    const r = await syncProject(cwd, cfg);
    r.hooks = argv.flags.hooks === false ? [] : installHooks(cwd, r.clis);

    if (ctx.json) { json({ ok: true, root: cwd, config: cfg, installed, synced: r }); return 0; }
    out();
    ok(t(`Proyecto ${c.bold(cfg.project)} listo en .moragent/`, `Project ${c.bold(cfg.project)} ready in .moragent/`));
    for (const [role, m] of Object.entries(cfg.crew)) {
      const has = installed.includes(m.cli);
      out(`   ${has ? c.green('●') : c.yellow('○')} ${role.padEnd(9)} ${m.cli}${has ? '' : c.yellow(t('  (no instalado)', '  (not installed)'))}`);
    }
    ok(t(`Instrucciones: ${r.files.map((f) => path.basename(f)).join(', ')}`, `Instructions: ${r.files.map((f) => path.basename(f)).join(', ')}`));
    if (r.hooks.length) ok(t('Memoria automática: cada sesión de Claude/Codex deja una nota episódica (--no-hooks para omitir)', 'Automatic memory: every Claude/Codex session leaves an episodic note (--no-hooks to skip)'));
    if (!installed.length) warn(t('No encontré ningún CLI de agentes. Instala al menos uno: npm i -g @anthropic-ai/claude-code', 'No agent CLI found. Install at least one: npm i -g @anthropic-ai/claude-code'));
    out();
    info(t('Siguiente paso:', 'Next:'));
    out(`   ${c.brand('mora up')}        ${c.dim(t('abre el equipo en paneles', 'open the crew in panes'))}`);
    out(`   ${c.brand('mora plan "…"')}  ${c.dim(t('describe lo que quieres construir', 'describe what you want to build'))}`);
    out(`   ${c.brand('mora brain link')} ${c.dim(t('conecta tu vault de Obsidian', 'connect your Obsidian vault'))}`);
    return 0;
  },
};
