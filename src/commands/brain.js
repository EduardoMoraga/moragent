import readline from 'node:readline';
import path from 'node:path';
import { requireRoot, dirs } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import { json, out, ok, warn, info, c } from '../core/log.js';
import { t, setLang } from '../core/i18n.js';
import { run } from '../core/exec.js';
import { exists, listFiles } from '../core/fsx.js';
import { MoragentError } from '../core/errors.js';
import { findVaults, link, sync, buildHome } from '../brain/obsidian.js';
import { list as listMemory } from '../memory/index.js';

export default {
  name: 'brain',
  aliases: ['obsidian'],
  group: 'brain',
  summary: {
    es: 'Conecta el segundo cerebro con Obsidian (enlace, sincronización y visualización)',
    en: 'Connect second brain with Obsidian (link, sync, open)',
  },
  usage: 'mora brain [link|sync|open|status] [--vault <path|name>] [--folder Moragent] [--copy] [--json]',

  async run(argv, ctx) {
    if (ctx.lang) setLang(ctx.lang);
    if (argv.flags.lang) setLang(argv.flags.lang);
    const root = ctx.root || requireRoot();
    const cfg = loadConfig(root);
    const sub = argv._[0] || 'status';

    if (sub === 'link') {
      let vaultParam = argv.flags.vault;
      const folder = argv.flags.folder || cfg.brain?.folder || 'Moragent';
      const mode = argv.flags.copy ? 'copy' : 'link';

      if (!vaultParam) {
        const vaults = findVaults();
        if (vaults.length === 0) {
          throw new MoragentError(
            'NO_VAULTS',
            t('No se encontraron Obsidian vaults en el sistema.', 'No Obsidian vaults found on this system.'),
            'mora brain link --vault <path>'
          );
        }

        if (vaults.length === 1) {
          vaultParam = vaults[0].path;
        } else if (process.stdin.isTTY && !ctx.json) {
          out(c.bold(t('Múltiples Obsidian vaults encontrados:', 'Multiple Obsidian vaults found:')));
          vaults.forEach((v, idx) => {
            const openTag = v.open ? c.green(t(' [abierto]', ' [open]')) : '';
            out(`  ${c.cyan(String(idx + 1))}) ${v.name} (${c.dim(v.path)})${openTag}`);
          });

          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const answer = await new Promise((resolve) => {
            rl.question(t(`Selecciona un vault [1-${vaults.length}] (1): `, `Select a vault [1-${vaults.length}] (1): `), resolve);
          });
          rl.close();

          const selectedIdx = parseInt(answer.trim(), 10);
          const chosen = selectedIdx >= 1 && selectedIdx <= vaults.length ? vaults[selectedIdx - 1] : vaults[0];
          vaultParam = chosen.path;
        } else {
          // Non-TTY: pick the first open vault, or first vault
          const openVault = vaults.find((v) => v.open) || vaults[0];
          warn(t(
            `Varios vaults encontrados. Usando: ${openVault.name} (${openVault.path})`,
            `Multiple vaults found. Using: ${openVault.name} (${openVault.path})`
          ));
          vaultParam = openVault.path;
        }
      }

      const res = await link({ root, vault: vaultParam, folder, mode });

      if (ctx.json) {
        json({ ok: true, ...res });
        return 0;
      }

      ok(t(
        `Proyecto enlazado a Obsidian: ${c.bold(res.vault)} [${res.mode}]`,
        `Project linked to Obsidian: ${c.bold(res.vault)} [${res.mode}]`
      ));
      info(t(`Destino: ${res.target}`, `Destination: ${res.target}`));
      return 0;
    }

    if (sub === 'sync') {
      const res = await sync(root);
      if (ctx.json) {
        json({ ok: true, ...res });
        return 0;
      }
      ok(t('Obsidian brain sincronizado y Home.md actualizado.', 'Obsidian brain synced and Home.md updated.'));
      return 0;
    }

    if (sub === 'open') {
      const currentVault = cfg.brain?.vault;
      if (!currentVault) {
        throw new MoragentError(
          'NOT_LINKED',
          t('El proyecto no está enlazado a un Obsidian vault.', 'Project is not linked to an Obsidian vault.'),
          'mora brain link'
        );
      }

      const projectName = cfg.project || path.basename(root);
      const folder = cfg.brain?.folder || 'Moragent';
      const targetPath = path.join(currentVault, folder, projectName);

      const uri = `obsidian://open?path=${encodeURIComponent(targetPath)}`;

      let bin = 'xdg-open';
      let cmdArgs = [uri];

      if (process.platform === 'darwin') {
        bin = 'open';
        cmdArgs = [uri];
      } else if (process.platform === 'win32') {
        bin = 'cmd.exe';
        cmdArgs = ['/c', 'start', '', uri];
      }

      const r = run(bin, cmdArgs);

      if (ctx.json) {
        json({ ok: true, uri, code: r.code });
        return 0;
      }

      ok(t(`Abriendo Obsidian: ${c.cyan(uri)}`, `Opening Obsidian: ${c.cyan(uri)}`));
      return 0;
    }

    if (sub === 'status') {
      const currentVault = cfg.brain?.vault;
      const folder = cfg.brain?.folder || 'Moragent';
      const mode = cfg.brain?.mode || 'link';
      const projectName = cfg.project || path.basename(root);
      const targetPath = currentVault ? path.join(currentVault, folder, projectName) : null;
      const linked = !!(targetPath && exists(targetPath));

      const homeFile = path.join(dirs(root).mora, 'Home.md');
      const hasHome = exists(homeFile);

      const canonicalCount = listMemory({ root, tier: 'canonical' }).length;
      const episodicCount = listMemory({ root, tier: 'episodic' }).length;
      const transientCount = listMemory({ root, tier: 'transient' }).length;

      const taskDir = dirs(root).tasks;
      const taskCount = exists(taskDir) ? listFiles(taskDir, { ext: '.json' }).length : 0;

      const statusObj = {
        linked,
        vault: currentVault,
        folder,
        mode,
        target: targetPath,
        home: hasHome ? homeFile : null,
        memory: {
          canonical: canonicalCount,
          episodic: episodicCount,
          transient: transientCount,
        },
        tasks: taskCount,
      };

      if (ctx.json) {
        json(statusObj);
        return 0;
      }

      out(c.bold(t('Estado del Obsidian Second Brain:', 'Obsidian Second Brain status:')));
      out(`  ${t('Enlazado', 'Linked')}: ${linked ? c.green(t('Sí', 'Yes')) : c.yellow(t('No', 'No'))}`);
      if (currentVault) {
        out(`  ${t('Vault', 'Vault')}: ${currentVault}`);
        out(`  ${t('Modo', 'Mode')}: ${mode}`);
        out(`  ${t('Destino', 'Destination')}: ${targetPath}`);
      }
      out(`  ${t('Home MOC', 'Home MOC')}: ${hasHome ? c.green('Home.md') : c.dim(t('No generado', 'Not generated'))}`);
      const canStr = t(
        canonicalCount === 1 ? '1 canónica' : `${canonicalCount} canónicas`,
        `${canonicalCount} canonical`
      );
      const epiStr = t(
        episodicCount === 1 ? '1 episódica' : `${episodicCount} episódicas`,
        `${episodicCount} episodic`
      );
      const traStr = t(
        transientCount === 1 ? '1 transitoria' : `${transientCount} transitorias`,
        `${transientCount} transient`
      );
      out(`  ${t('Memoria', 'Memory')}: ${c.cyan(canStr)}, ${c.green(epiStr)}, ${c.yellow(traStr)}`);
      out(`  ${t('Tareas', 'Tasks')}: ${taskCount}`);
      return 0;
    }

    throw new MoragentError('USAGE', t(`Subcomando de brain desconocido: ${sub}`, `Unknown brain subcommand: ${sub}`), this.usage);
  },
};
