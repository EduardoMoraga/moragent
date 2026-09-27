import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from './core/args.js';
import { findRoot, PKG_ROOT } from './core/paths.js';
import { loadConfig } from './core/config.js';
import { setLang, getLang, detectLang, t } from './core/i18n.js';
import { MoragentError } from './core/errors.js';
import { err, c, out } from './core/log.js';
import { COMMANDS } from './commands/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const version = () => JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version;

// Load every command module that exists on disk (modules still under construction are skipped).
export async function loadCommands() {
  const mods = [];
  for (const name of COMMANDS) {
    const file = path.join(here, 'commands', `${name}.js`);
    if (!fs.existsSync(file)) continue;
    const mod = (await import(pathToFileURL(file).href)).default;
    if (mod?.name && typeof mod.run === 'function') mods.push(mod);
  }
  return mods;
}

export async function resolveCommand(name) {
  const mods = await loadCommands();
  return mods.find((m) => m.name === name || (m.aliases || []).includes(name)) || null;
}

export async function main(tokens) {
  const argv = parse(tokens);
  const root = findRoot();
  let config = null;
  if (root) { try { config = loadConfig(root); } catch { /* commands that need it will fail loudly */ } }
  const flagLang = typeof argv.flags.lang === 'string' ? argv.flags.lang : null;
  setLang(flagLang || config?.lang || detectLang());

  if (argv.flags.version && argv._.length === 0) { out(version()); return 0; }

  let name = argv._[0];
  if (!name) name = argv.flags.help ? 'help' : root ? 'dashboard' : 'init';
  const cmd = await resolveCommand(name);
  if (!cmd) {
    err(t(`Comando desconocido: ${name}`, `Unknown command: ${name}`));
    out(c.dim(t('Prueba: mora help', 'Try: mora help')));
    return 2;
  }
  if (argv._[0]) argv._.shift();
  if (argv.flags.help && cmd.name !== 'help') {
    const help = await resolveCommand('help');
    return help.run({ _: [cmd.name], flags: {} }, { root, config, lang: getLang(), json: false });
  }
  const ctx = { root, config, lang: getLang(), json: !!argv.flags.json };
  try {
    return (await cmd.run(argv, ctx)) ?? 0;
  } catch (e) {
    if (e instanceof MoragentError) {
      if (ctx.json) out(JSON.stringify({ ok: false, code: e.code, error: e.message, hint: e.hint }));
      else { err(e.message); if (e.hint) out(c.dim(`  → ${e.hint}`)); }
      return 1;
    }
    throw e;
  }
}
