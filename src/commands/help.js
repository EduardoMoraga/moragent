import { loadCommands, version } from '../cli.js';
import { tr, t } from '../core/i18n.js';
import { out, c } from '../core/log.js';

const GROUPS = [
  ['start', { es: 'Empezar', en: 'Start' }],
  ['crew', { es: 'Equipo y tareas', en: 'Crew & tasks' }],
  ['spec', { es: 'Specs (SDD)', en: 'Specs (SDD)' }],
  ['memory', { es: 'Memoria', en: 'Memory' }],
  ['brain', { es: 'Segundo cerebro', en: 'Second brain' }],
  ['system', { es: 'Sistema', en: 'System' }],
];

export default {
  name: 'help',
  aliases: ['h', '?'],
  group: 'system',
  summary: { es: 'Muestra esta ayuda', en: 'Show this help' },
  usage: 'mora help [command]',
  async run(argv) {
    const mods = await loadCommands();
    const one = argv._[0] && mods.find((m) => m.name === argv._[0] || (m.aliases || []).includes(argv._[0]));
    if (one) {
      out(`${c.bold(one.name)} — ${tr(one.summary)}`);
      out(`  ${c.cyan(one.usage || `mora ${one.name}`)}`);
      if (one.aliases?.length) out(c.dim(`  alias: ${one.aliases.join(', ')}`));
      if (one.details) out('\n' + tr(one.details));
      return 0;
    }
    out(`${c.brand(c.bold('MORAGENT'))} ${c.dim('v' + version())} — ${t('orquestador ejecutivo para desarrollo agéntico', 'the executive orchestrator for agentic development')}`);
    out(c.dim(`  mora <${t('comando', 'command')}> [--json] [--lang es|en]`));
    for (const [g, label] of GROUPS) {
      const list = mods.filter((m) => (m.group || 'system') === g);
      if (!list.length) continue;
      out('\n' + c.bold(tr(label)));
      for (const m of list) out(`  ${c.cyan(m.name.padEnd(10))} ${tr(m.summary)}`);
    }
    out('\n' + c.dim(t('Detalle: mora help <comando>  ·  Docs: https://github.com/EduardoMoraga/moragent', 'Details: mora help <command>  ·  Docs: https://github.com/EduardoMoraga/moragent')));
    return 0;
  },
};
