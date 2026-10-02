import { MoragentError } from '../core/errors.js';
import { json, out } from '../core/log.js';
import { t } from '../core/i18n.js';
import { loadConfig } from '../core/config.js';
import fs from 'node:fs';
import path from 'node:path';
import { listProjects, registerProject, resolveProject } from '../projects/registry.js';

const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export default {
  name: 'project',
  aliases: ['projects', 'proyecto', 'proyectos'],
  group: 'start',
  summary: { es: 'Registra, lista y abre directorios o repositorios', en: 'Register, list, and open directories or repositories' },
  usage: 'mora project add [path] [--name NAME] | list | open <id|name|path> [--chat|--json]',
  async run(argv, ctx) {
    const [action = 'list', ...args] = argv._;
    if (action === 'add') {
      if (args.length > 1 || argv.flags.name === true) throw new MoragentError('USAGE', this.usage);
      const result = registerProject(args[0], { name: argv.flags.name });
      if (ctx.json) json({ ok: true, ...result });
      else out(`${result.created ? t('Registrado', 'Registered') : t('Ya registrado', 'Already registered')}: ${result.project.name} (${result.project.projectId})\n${result.project.root}`);
      return 0;
    }
    if (action === 'list') {
      if (args.length) throw new MoragentError('USAGE', this.usage);
      const projects = listProjects();
      if (ctx.json) json({ ok: true, projects });
      else if (!projects.length) out(t('No hay proyectos registrados. Usa: mora project add [path]', 'No registered projects. Use: mora project add [path]'));
      else for (const p of projects) out(`${p.projectId}  ${p.name}  [${p.kind}]\n  ${p.root}`);
      return 0;
    }
    if (action === 'open') {
      if (args.length !== 1) throw new MoragentError('USAGE', this.usage);
      const project = resolveProject(args[0]);
      if (argv.flags.chat) {
        if (ctx.json) throw new MoragentError('USAGE', 'Choose either --chat or --json.');
        const { default: chat } = await import('./chat.js');
        // A registered directory is its own workspace, even inside another
        // MORAGENT project. Never inherit an ancestor's memory or tasks.
        const root = fs.existsSync(path.join(project.root, '.moragent', 'moragent.json')) ? project.root : null;
        return chat.run({ _: [], flags: {} }, { ...ctx, root, config: root ? loadConfig(root) : null, cwd: project.root });
      }
      const command = `cd ${shellQuote(project.root)}`;
      if (ctx.json) json({ ok: true, project, command });
      else out(`${project.name} (${project.projectId})\n${project.root}\n${t('Para abrirlo en tu shell', 'To open it in your shell')}: ${command}`);
      return 0;
    }
    throw new MoragentError('USAGE', this.usage);
  },
};
