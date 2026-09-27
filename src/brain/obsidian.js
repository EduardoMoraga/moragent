import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dirs, requireRoot } from '../core/paths.js';
import { loadConfig, saveConfig } from '../core/config.js';
import { ensureDir, exists, readJSON, readText, writeText, copyDir, listFiles, nowISO } from '../core/fsx.js';
import { MoragentError } from '../core/errors.js';
import { t, setLang } from '../core/i18n.js';
import { list as listMemory } from '../memory/index.js';

export function getObsidianConfigPaths() {
  if (process.env.MORAGENT_OBSIDIAN_CONFIG) {
    return [process.env.MORAGENT_OBSIDIAN_CONFIG];
  }

  const home = os.homedir();
  const platform = process.platform;

  if (platform === 'darwin') {
    return [
      path.join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json'),
    ];
  }

  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return [path.join(appData, 'obsidian', 'obsidian.json')];
  }

  // Linux & others
  return [
    path.join(home, '.config', 'obsidian', 'obsidian.json'),
    path.join(home, '.var', 'app', 'md.obsidian.Obsidian', 'config', 'obsidian', 'obsidian.json'),
  ];
}

export function findVaults() {
  const configPaths = getObsidianConfigPaths();
  let rawConfig = null;

  for (const cp of configPaths) {
    if (exists(cp)) {
      rawConfig = readJSON(cp, null);
      if (rawConfig) break;
    }
  }

  if (!rawConfig || !rawConfig.vaults) {
    return [];
  }

  const rawList = Array.isArray(rawConfig.vaults)
    ? rawConfig.vaults
    : Object.values(rawConfig.vaults);

  const vaults = [];
  for (const entry of rawList) {
    if (!entry || !entry.path) continue;
    const vPath = path.resolve(entry.path);
    if (!exists(vPath)) continue;

    vaults.push({
      path: vPath,
      name: entry.name || path.basename(vPath),
      open: !!entry.open,
      ts: entry.ts || 0,
    });
  }

  vaults.sort((a, b) => {
    if (a.open !== b.open) return a.open ? -1 : 1;
    return (b.ts || 0) - (a.ts || 0);
  });

  return vaults.map(({ path: p, name, open }) => ({ path: p, name, open }));
}

export function resolveVault(vaultNameOrPath) {
  if (!vaultNameOrPath) return null;
  const resolved = path.resolve(vaultNameOrPath);
  if (exists(resolved)) {
    return { path: resolved, name: path.basename(resolved), open: false };
  }

  const known = findVaults();
  const match = known.find(
    (v) =>
      v.name.toLowerCase() === vaultNameOrPath.toLowerCase() ||
      v.path.toLowerCase() === vaultNameOrPath.toLowerCase()
  );
  return match || null;
}

export async function link({ root, vault, folder = 'Moragent', mode = 'link' } = {}) {
  const r = root || requireRoot();
  const cfg = loadConfig(r);

  let targetVault = null;
  if (vault) {
    targetVault = resolveVault(vault);
    if (!targetVault) {
      throw new MoragentError(
        'VAULT_NOT_FOUND',
        t(`No se encontró el vault: ${vault}`, `Obsidian vault not found: ${vault}`),
        t('Usa un path absoluto o el nombre exacto del vault.', 'Use an absolute path or exact vault name.')
      );
    }
  } else {
    const vaults = findVaults();
    if (vaults.length === 0) {
      throw new MoragentError(
        'NO_VAULTS',
        t('No se encontraron Obsidian vaults en el sistema.', 'No Obsidian vaults found on this system.'),
        'mora brain link --vault <path>'
      );
    }
    targetVault = vaults[0];
  }

  const projectName = cfg.project || path.basename(r);
  const destDir = path.join(targetVault.path, folder, projectName);
  const moraDir = dirs(r).mora;

  ensureDir(path.dirname(destDir));

  let destExists = false;
  let isSymlink = false;
  let pointsToUs = false;

  try {
    const stat = fs.lstatSync(destDir);
    destExists = true;
    isSymlink = stat.isSymbolicLink();
    if (isSymlink) {
      const linkTarget = fs.readlinkSync(destDir).replace(/^\\\\\?\\|^\\\?\?\\/, '');
      const absLink = path.resolve(path.dirname(destDir), linkTarget);
      pointsToUs = absLink === path.resolve(moraDir);
    }
  } catch {
    destExists = false;
  }

  if (mode === 'link') {
    if (destExists) {
      if (isSymlink && pointsToUs) {
        // Idempotent: already linked to us
      } else {
        throw new MoragentError(
          'VAULT_TARGET_EXISTS',
          t(`El destino ${destDir} ya existe y no es nuestro enlace.`, `Target ${destDir} already exists and is not our link.`),
          t(`Elimina o renombra ${destDir} antes de enlazar.`, `Remove or rename ${destDir} before linking.`)
        );
      }
    } else {
      const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
      fs.symlinkSync(moraDir, destDir, symlinkType);
    }
  } else if (mode === 'copy') {
    if (destExists && isSymlink) {
      throw new MoragentError(
        'VAULT_TARGET_EXISTS',
        t(`El destino ${destDir} es un symlink existente.`, `Target ${destDir} is an existing symlink.`),
        t(`Elimina el symlink antes de usar modo copia.`, `Remove the symlink before using copy mode.`)
      );
    }
    copyDir(moraDir, destDir);
  } else {
    throw new MoragentError('BAD_MODE', t(`Modo inválido: ${mode}`, `Invalid mode: ${mode}`), 'link | copy');
  }

  cfg.brain = {
    vault: targetVault.path,
    folder,
    mode,
  };
  saveConfig(r, cfg);

  await buildHome(r);

  if (mode === 'copy') {
    copyDir(moraDir, destDir);
  }

  return {
    target: destDir,
    vault: targetVault.path,
    mode,
  };
}

const PLACEHOLDER_GOAL = /^(?:Describe aquí|Describe the project goal)/i;

export function resolveGoal(root, cfg) {
  if (cfg?.lang) {
    setLang(cfg.lang);
  }

  if (cfg?.goal && String(cfg.goal).trim()) {
    return String(cfg.goal).trim();
  }

  const projectMdPath = path.join(dirs(root).canonical, 'project.md');
  if (exists(projectMdPath)) {
    const raw = readText(projectMdPath, '');
    const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const firstPara = paragraphs.find((p) => !/^(?:Creado con|Created with)\s+`mora init`/i.test(p)) || '';
    if (firstPara && !PLACEHOLDER_GOAL.test(firstPara)) {
      return firstPara;
    }
  }

  return t(
    'Sin objetivo — edita .moragent/memory/canonical/project.md',
    'No goal yet — edit .moragent/memory/canonical/project.md'
  );
}

export async function buildHome(root) {
  const r = root || requireRoot();
  const cfg = loadConfig(r);
  const d = dirs(r);

  const lang = cfg.lang || 'en';
  setLang(lang);

  const goalText = resolveGoal(r, cfg);

  const lines = [
    t(`# ${cfg.project || path.basename(r)} — Mapa de contenido`, `# ${cfg.project || path.basename(r)} — Map of Content`),
    '',
    t(`> Moragent Obsidian Second Brain — Generado ${nowISO()}`, `> Moragent Obsidian Second Brain — Generated ${nowISO()}`),
    '',
    t('## Objetivo del proyecto', '## Project Goal'),
    goalText,
    '',
    t('## Equipo', '## Crew'),
  ];

  const crew = cfg.crew || {};
  for (const [role, info] of Object.entries(crew)) {
    const title = info.title || role;
    const cli = info.cli || 'cli';
    const mission = info.mission || '';
    lines.push(`- **${title}** (\`${cli}\`): ${mission}`);
  }
  lines.push('');

  // Specs section with phase if available
  lines.push(t('## Especificaciones', '## Specs'));
  let specStateFn = null;
  try {
    const specMod = await import('../spec/index.js');
    if (typeof specMod.specState === 'function') {
      specStateFn = specMod.specState;
    }
  } catch {
    // spec module is optional / owned by dev
  }

  const specDirs = [];
  if (exists(d.specs)) {
    for (const ent of fs.readdirSync(d.specs, { withFileTypes: true })) {
      if (ent.isDirectory()) specDirs.push(ent.name);
    }
  }

  if (specDirs.length === 0) {
    lines.push(t('_Aún no hay especificaciones definidas._', '_No specs defined yet._'));
  } else {
    for (const slug of specDirs) {
      let phaseInfo = '';
      if (specStateFn) {
        try {
          const st = specStateFn(r, slug);
          if (st?.phase) phaseInfo = t(` (fase: \`${st.phase}\`)`, ` (phase: \`${st.phase}\`)`);
        } catch { /* ignore */ }
      }
      lines.push(`- [[specs/${slug}/spec.md|${slug}]]${phaseInfo}`);
    }
  }
  lines.push('');

  // Tasks by status
  lines.push(t('## Tareas', '## Tasks'));
  const tasksByStatus = {};
  if (exists(d.tasks)) {
    const taskFiles = listFiles(d.tasks, { ext: '.json' });
    for (const tf of taskFiles) {
      const task = readJSON(tf, null);
      if (task && task.id) {
        const st = task.status || 'unknown';
        tasksByStatus[st] = tasksByStatus[st] || [];
        tasksByStatus[st].push(task);
      }
    }
  }

  const statusOrder = ['running', 'queued', 'sent', 'done', 'failed', 'blocked'];
  let totalTasks = 0;
  for (const st of statusOrder) {
    const list = tasksByStatus[st];
    if (list && list.length > 0) {
      totalTasks += list.length;
      lines.push(`### ${st.toUpperCase()}`);
      for (const tItem of list) {
        const taskTitle = tItem.title || t('Sin título', 'Untitled');
        const taskRole = tItem.role || t('equipo', 'crew');
        lines.push(`- [[tasks/${tItem.id}.md|${tItem.id}]]: ${taskTitle} (@${taskRole})`);
      }
      lines.push('');
    }
  }
  if (totalTasks === 0) {
    lines.push(t('_Aún no hay tareas registradas._', '_No tasks registered yet._'));
    lines.push('');
  }

  // Canonical Decisions
  lines.push(t('## Decisiones canónicas', '## Canonical Decisions'));
  const canonicalNotes = listMemory({ root: r, tier: 'canonical' }).filter((n) => n.id !== 'project');
  if (canonicalNotes.length === 0) {
    lines.push(t('_Aún no hay decisiones canónicas registradas._', '_No canonical decisions recorded yet._'));
  } else {
    for (const note of canonicalNotes) {
      lines.push(`- [[memory/canonical/${note.id}.md|${note.title}]] (${note.kind})`);
    }
  }
  lines.push('');

  // Recent Episodes
  lines.push(t('## Episodios recientes', '## Recent Episodes'));
  const episodicNotes = listMemory({ root: r, tier: 'episodic', limit: 10 });
  if (episodicNotes.length === 0) {
    lines.push(t('_Sin episodios recientes._', '_No recent episodes._'));
  } else {
    for (const note of episodicNotes) {
      const author = note.by || t('equipo', 'crew');
      lines.push(`- [[memory/episodic/${note.id}.md|${note.title}]] (@${author})`);
    }
  }
  lines.push('');

  // Dataview block (optional commented out for Obsidian)
  lines.push('## Dataview');
  lines.push('%%');
  lines.push('```dataview');
  lines.push('TABLE status, role, spec');
  lines.push('FROM "tasks"');
  lines.push('SORT status ASC');
  lines.push('```');
  lines.push('%%');
  lines.push('');

  const homeFile = path.join(d.mora, 'Home.md');
  writeText(homeFile, lines.join('\n'));
  return homeFile;
}

export async function sync(root) {
  const r = root || requireRoot();
  const cfg = loadConfig(r);
  const homeFile = await buildHome(r);

  if (cfg.brain?.vault && cfg.brain?.mode === 'copy') {
    const projectName = cfg.project || path.basename(r);
    const destDir = path.join(cfg.brain.vault, cfg.brain.folder || 'Moragent', projectName);
    copyDir(dirs(r).mora, destDir);
  }

  return { home: homeFile, synced: true };
}
