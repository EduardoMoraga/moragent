import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PKG_ROOT } from './paths.js';

const execFileAsync = promisify(execFile);

async function git(root, args) {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], {
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

// Update the code that is actually running MORAGENT, never the user's project.
// Other installation types need recorded provenance before an updater can safely
// choose a source and branch; guessing master could silently downgrade a preview.
export async function selfUpdate({ packageRoot = PKG_ROOT, check = false } = {}) {
  const root = fs.realpathSync(packageRoot);
  let top;
  try { top = fs.realpathSync(await git(root, ['rev-parse', '--show-toplevel'])); }
  catch { return { status: 'unsupported', reason: 'not-git-checkout' }; }
  if (top !== root) return { status: 'unsupported', reason: 'not-package-repository' };

  let branch;
  let upstream;
  try {
    branch = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    upstream = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  } catch { return { status: 'unsupported', reason: 'no-tracking-branch' }; }

  const remote = await git(root, ['config', '--get', `branch.${branch}.remote`]);
  await git(root, ['fetch', '--no-tags', remote]);
  const [ahead, behind] = (await git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']))
    .split(/\s+/).map(Number);
  if (!Number.isInteger(ahead) || !Number.isInteger(behind)) throw new Error('Invalid Git revision count');
  const dirty = !!(await git(root, ['status', '--porcelain=v1', '--untracked-files=no']));
  const base = { branch, upstream, ahead, behind, dirty,
    current: await git(root, ['rev-parse', 'HEAD']),
    latest: await git(root, ['rev-parse', '@{upstream}']) };

  if (!behind) return { ...base, status: ahead ? 'ahead' : 'current' };
  if (ahead) return { ...base, status: 'diverged' };
  if (check) return { ...base, status: 'available' };
  if (dirty) return { ...base, status: 'dirty' };

  await git(root, ['merge', '--ff-only', '@{upstream}']);
  return { ...base, status: 'updated' };
}

export function updateMessage(result, lang = 'es') {
  const es = lang !== 'en';
  switch (result.status) {
    case 'current': return es ? `MORAGENT ya está al día en ${result.branch} (${result.current.slice(0, 7)}).` : `MORAGENT is up to date on ${result.branch} (${result.current.slice(0, 7)}).`;
    case 'available': return es ? `Hay ${result.behind} commit(s) nuevos en ${result.upstream}. Ejecuta /update para aplicarlos.` : `${result.behind} new commit(s) on ${result.upstream}. Run /update to apply them.`;
    case 'updated': return es ? `MORAGENT se actualizó a ${result.latest.slice(0, 7)} desde ${result.upstream}. Reinicia la app para usar el código nuevo.` : `MORAGENT updated to ${result.latest.slice(0, 7)} from ${result.upstream}. Restart the app to use the new code.`;
    case 'dirty': return es ? 'Hay cambios locales en archivos versionados de MORAGENT. No se actualizó; guárdalos o resuélvelos antes.' : 'MORAGENT has local changes to tracked files. No update was applied; save or resolve them first.';
    case 'ahead': return es ? `La instalación local tiene ${result.ahead} commit(s) propios y no hay novedades remotas.` : `The local installation has ${result.ahead} local commit(s) and no remote updates.`;
    case 'diverged': return es ? 'La rama local y su remoto divergen. No se aplicó ningún cambio automáticamente.' : 'The local branch and upstream have diverged. No automatic update was applied.';
    default: return es ? 'No puedo actualizar esta instalación automáticamente: no se conoce con seguridad su origen o rama Git.' : 'Cannot safely update this installation automatically: its Git source or branch is unknown.';
  }
}
