import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PKG_ROOT } from './paths.js';

const execFileAsync = promisify(execFile);
export const INSTALL_METADATA = '.moragent-install.json';
const OFFICIAL_REPO_URL = 'https://github.com/EduardoMoraga/moragent.git';
const OFFICIAL_TARBALL_PREFIX = 'https://github.com/EduardoMoraga/moragent/archive/';
const SHA_RE = /^[0-9a-f]{40}$/i;
const BRANCH_RE = /^(?!\/)(?!.*(?:\.\.|\/\/))(?!.*\/$)[A-Za-z0-9._/-]+$/;

async function run(execFileImpl, file, args, options = {}) {
  const { stdout } = await execFileImpl(file, args, {
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    ...options,
  });
  return String(stdout ?? '').trim();
}

async function git(root, args, execFileImpl = execFileAsync) {
  return run(execFileImpl, 'git', ['-C', root, ...args]);
}

function normalizeRepoUrl(url) {
  return url === 'https://github.com/EduardoMoraga/moragent' ? OFFICIAL_REPO_URL : url;
}

function tarballUrlForRevision(revision) {
  return `${OFFICIAL_TARBALL_PREFIX}${revision}.tar.gz`;
}

function isOfficialRevisionTarball(url, revision) {
  return url === tarballUrlForRevision(revision)
    || url === `${OFFICIAL_TARBALL_PREFIX}${revision}.zip`;
}

function readInstallMetadata(root) {
  const file = path.join(root, INSTALL_METADATA);
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const metadata = JSON.parse(raw);
    if (metadata?.source?.type !== 'github-tarball') return null;
    const source = metadata.source;
    if (!source.repoUrl || !source.branch || !source.ref || !source.tarballUrl || !metadata.revision) return null;
    return { ...metadata, path: file };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function validateInstallMetadata(metadata) {
  const source = metadata?.source || {};
  if (!SHA_RE.test(String(metadata?.revision || ''))) return 'invalid-revision';
  if (!BRANCH_RE.test(String(source.branch || ''))) return 'invalid-branch';
  if (source.ref !== `refs/heads/${source.branch}`) return 'invalid-ref';
  if (normalizeRepoUrl(source.repoUrl) !== OFFICIAL_REPO_URL) return 'untrusted-repository';
  if (!isOfficialRevisionTarball(source.tarballUrl, metadata.revision)) return 'untrusted-tarball';
  return null;
}

function writeInstallMetadata(root, metadata) {
  fs.writeFileSync(path.join(root, INSTALL_METADATA), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
}

function prefixForPackageRoot(root) {
  const parent = path.dirname(root);
  if (path.basename(parent) !== 'node_modules') return null;
  const maybeLib = path.dirname(parent);
  if (path.basename(maybeLib) === 'lib') return path.dirname(maybeLib);
  return maybeLib;
}

function unsupportedPackagedReason(root) {
  return fs.existsSync(path.join(root, 'package.json')) ? 'missing-provenance' : 'not-git-checkout';
}

function copyDirectory(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true, force: true, verbatimSymlinks: true });
}

function restorePackageRoot(root, backup) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(root), { recursive: true });
  copyDirectory(backup, root);
}

async function selfUpdatePackaged(root, { check, execFileImpl }) {
  const metadata = readInstallMetadata(root);
  if (!metadata) return { status: 'unsupported', reason: unsupportedPackagedReason(root) };
  const invalidReason = validateInstallMetadata(metadata);
  if (invalidReason) return { status: 'unsupported', reason: invalidReason };

  const latest = await run(execFileImpl, 'git', ['ls-remote', OFFICIAL_REPO_URL, metadata.source.ref]);
  const [latestRevision, latestRef] = latest.split(/\s+/);
  if (!SHA_RE.test(latestRevision) || latestRef !== metadata.source.ref) {
    throw new Error(`Cannot resolve ${metadata.source.ref} from ${OFFICIAL_REPO_URL}`);
  }

  const base = {
    source: 'github-tarball',
    branch: metadata.source.branch,
    upstream: `${OFFICIAL_REPO_URL}#${metadata.source.branch}`,
    current: metadata.revision,
    latest: latestRevision,
  };
  if (metadata.revision === latestRevision) return { ...base, status: 'current' };
  if (check) return { ...base, status: 'available', behind: 1 };

  const prefix = prefixForPackageRoot(root);
  if (!prefix) return { ...base, status: 'unsupported', reason: 'unsupported-package-layout' };

  const backup = fs.mkdtempSync(path.join(path.dirname(root), '.moragent-backup-'));
  copyDirectory(root, backup);
  try {
    await run(execFileImpl, 'npm', ['i', '-g', '--prefix', prefix, tarballUrlForRevision(latestRevision)], { timeout: 120000 });
    if (!fs.existsSync(path.join(root, 'package.json')) || !fs.existsSync(path.join(root, 'bin', 'mora.js'))) {
      restorePackageRoot(root, backup);
      return { ...base, status: 'failed', reason: 'invalid-installation-after-npm' };
    }
    writeInstallMetadata(root, {
      ...metadata,
      installedAt: new Date().toISOString(),
      revision: latestRevision,
      source: { ...metadata.source, repoUrl: OFFICIAL_REPO_URL, tarballUrl: tarballUrlForRevision(latestRevision) },
    });
    return { ...base, status: 'updated' };
  } catch (error) {
    restorePackageRoot(root, backup);
    return { ...base, status: 'failed', reason: 'npm-install-failed', error: error.message };
  } finally {
    fs.rmSync(backup, { recursive: true, force: true });
  }
}

// Update the code that is actually running MORAGENT, never the user's project.
// Git checkouts keep the historical fast-forward path. Packaged GitHub tarball
// installs are updated only when install.sh/install.ps1 recorded exact source
// provenance; old packages without metadata are refused instead of guessed.
export async function selfUpdate({ packageRoot = PKG_ROOT, check = false, execFileImpl = execFileAsync } = {}) {
  const root = fs.realpathSync(packageRoot);
  let top;
  try { top = fs.realpathSync(await git(root, ['rev-parse', '--show-toplevel'], execFileImpl)); }
  catch { return selfUpdatePackaged(root, { check, execFileImpl }); }
  if (top !== root) return { status: 'unsupported', reason: 'not-package-repository' };

  let branch;
  let upstream;
  try {
    branch = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], execFileImpl);
    upstream = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], execFileImpl);
  } catch { return { status: 'unsupported', reason: 'no-tracking-branch' }; }

  const remote = await git(root, ['config', '--get', `branch.${branch}.remote`], execFileImpl);
  await git(root, ['fetch', '--no-tags', remote], execFileImpl);
  const [ahead, behind] = (await git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], execFileImpl))
    .split(/\s+/).map(Number);
  if (!Number.isInteger(ahead) || !Number.isInteger(behind)) throw new Error('Invalid Git revision count');
  const dirty = !!(await git(root, ['status', '--porcelain=v1', '--untracked-files=no'], execFileImpl));
  const base = { source: 'git', branch, upstream, ahead, behind, dirty,
    current: await git(root, ['rev-parse', 'HEAD'], execFileImpl),
    latest: await git(root, ['rev-parse', '@{upstream}'], execFileImpl) };

  if (!behind) return { ...base, status: ahead ? 'ahead' : 'current' };
  if (ahead) return { ...base, status: 'diverged' };
  if (check) return { ...base, status: 'available' };
  if (dirty) return { ...base, status: 'dirty' };

  await git(root, ['merge', '--ff-only', '@{upstream}'], execFileImpl);
  return { ...base, status: 'updated' };
}

export function updateMessage(result, lang = 'es') {
  const es = lang !== 'en';
  switch (result.status) {
    case 'current': return es ? `MORAGENT ya está al día en ${result.branch} (${result.current.slice(0, 7)}).` : `MORAGENT is up to date on ${result.branch} (${result.current.slice(0, 7)}).`;
    case 'available': return es ? `Hay una revisión nueva en ${result.upstream}. Ejecuta /update para aplicarla.` : `A new revision is available on ${result.upstream}. Run /update to apply it.`;
    case 'updated': return es ? `MORAGENT se actualizó a ${result.latest.slice(0, 7)} desde ${result.upstream}. Reinicia la app para usar el código nuevo.` : `MORAGENT updated to ${result.latest.slice(0, 7)} from ${result.upstream}. Restart the app to use the new code.`;
    case 'dirty': return es ? 'Hay cambios locales en archivos versionados de MORAGENT. No se actualizó; guárdalos o resuélvelos antes.' : 'MORAGENT has local changes to tracked files. No update was applied; save or resolve them first.';
    case 'ahead': return es ? `La instalación local tiene ${result.ahead} commit(s) propios y no hay novedades remotas.` : `The local installation has ${result.ahead} local commit(s) and no remote updates.`;
    case 'diverged': return es ? 'La rama local y su remoto divergen. No se aplicó ningún cambio automáticamente.' : 'The local branch and upstream have diverged. No automatic update was applied.';
    case 'failed': return es ? 'Falló la actualización. La instalación anterior se restauró; revisa npm y vuelve a intentarlo.' : 'Update failed. The previous installation was restored; check npm and try again.';
    default:
      if (result.reason === 'missing-provenance') return es ? 'No puedo actualizar esta instalación antigua: no registra origen ni rama. Migra reinstalando con install.sh/install.ps1 y MORAGENT_BRANCH si usas una preview.' : 'Cannot update this older installation: source and branch were not recorded. Migrate by reinstalling with install.sh/install.ps1 and MORAGENT_BRANCH if you use a preview.';
      return es ? 'No puedo actualizar esta instalación automáticamente: no se conoce con seguridad su origen o rama Git.' : 'Cannot safely update this installation automatically: its Git source or branch is unknown.';
  }
}
