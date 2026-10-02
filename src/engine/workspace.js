import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { withPublicationLockSync } from './publication-lock.js';
import { isValidFileTextCheck, verifyTaskChecks } from './acceptance.js';

const IGNORED = new Set(['.git', 'node_modules']);
const virtualEnv = (name) => /^\.venv(?:[-_][^/\\]+)?$/i.test(name);
const ignored = (name) => IGNORED.has(name) || virtualEnv(name);
const INTERNAL = new Set(['runs', 'tasks', 'sessions', 'memory']);
const PROJECT_ID = '.project-id';

function recoveryProjectId(directory, create = false) {
  const file = path.join(directory, PROJECT_ID);
  if (create) {
    try { fs.writeFileSync(file, `${crypto.randomUUID()}\n`, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    const id = fs.readFileSync(file, 'utf8').trim();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ? id : null;
  } catch { return null; }
}

export function listRecoveries(root) {
  const project = fs.realpathSync(root);
  const directory = path.join(project, '.moragent', 'runs', 'recovery');
  if (!fs.existsSync(directory)) return [];
  const repository = gitTop(project);
  const projectRelative = path.relative(repository || project, project);
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^T-\d+-[a-f0-9-]{36}$/.test(entry.name))
    .map((entry) => {
      const saved = path.join(directory, entry.name);
      return {
        id: entry.name,
        taskId: entry.name.slice(0, -37),
        path: path.join(saved, 'project', projectRelative),
        savedAt: fs.statSync(saved).mtime.toISOString(),
      };
    })
    .filter((entry) => fs.existsSync(entry.path))
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

function canonicalLinkTarget(target) {
  let current = target;
  const missing = [];
  for (;;) {
    try { return path.join(fs.realpathSync(current), ...missing); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`unresolved symlink target: ${target}`); }
      catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

function copyProject(source, target, shouldCancel = () => false) {
  const links = [];
  fs.cpSync(source, target, {
    recursive: true,
    mode: fs.constants.COPYFILE_FICLONE,
    filter: (entry) => {
      if (shouldCancel()) throw new Error('workspace preparation cancelled');
      const rel = path.relative(source, entry);
      if (!rel) return true;
      if (rel.split(path.sep).includes('.git')) return false;
      const parts = rel.split(path.sep);
      // A Python virtual environment is generated, often large, and its
      // interpreter symlinks commonly point to the system installation.
      if (parts.some(virtualEnv)) return false;
      if (parts.some((part, index) => part === 'runs' && parts[index - 1] === '.moragent')) return false;
      if (fs.lstatSync(entry).isSymbolicLink()) links.push(rel);
      return true;
    },
  });
  // Node's recursive copy can leave absolute links pointing back at the real
  // project. Rebase every internal link, including ones inside node_modules.
  for (const rel of links) {
    const original = path.join(source, rel);
    const raw = fs.readlinkSync(original);
    const resolved = canonicalLinkTarget(path.resolve(path.dirname(original), raw));
    const inside = path.relative(source, resolved);
    if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
      throw new Error(`symlink points outside project and cannot be isolated: ${rel}`);
    }
    const copy = path.join(target, rel);
    const rebased = path.join(target, inside);
    const type = (() => { try { return fs.statSync(original).isDirectory() ? 'dir' : 'file'; } catch { return 'file'; } })();
    fs.unlinkSync(copy);
    fs.symlinkSync(process.platform === 'win32' && type === 'dir' ? rebased : path.relative(path.dirname(copy), rebased),
      copy, process.platform === 'win32' && type === 'dir' ? 'junction' : type);
  }
}

function fingerprint(file, stat, shouldCancel = () => false) {
  if (stat.isSymbolicLink()) return `link:${fs.readlinkSync(file)}`;
  if (stat.isDirectory()) return `directory:${(stat.mode & 0o7777).toString(8)}`;
  if (!stat.isFile()) return `other:${stat.mode}`;
  const digest = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const chunk = Buffer.allocUnsafe(64 * 1024);
  try {
    let size;
    while ((size = fs.readSync(descriptor, chunk, 0, chunk.length, null)) > 0) {
      if (shouldCancel()) throw new Error('workspace preparation cancelled');
      digest.update(chunk.subarray(0, size));
    }
  } finally { fs.closeSync(descriptor); }
  const hash = digest.digest('hex');
  return `file:${stat.mode & 0o777}:${hash}`;
}

function dependencyFingerprint(file, stat) {
  if (stat.isSymbolicLink()) return `link:${fs.readlinkSync(file)}`;
  const type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
  // Metadata avoids reading every dependency byte on every worker. ctimeNs
  // catches ordinary rewrites even when a tool restores the file's mtime.
  return `${type}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}`;
}

function snapshot(root, dependencies = null, shouldCancel = () => false) {
  const entries = new Map();
  function visitDependencies(file, rel) {
    if (shouldCancel()) throw new Error('workspace preparation cancelled');
    const stat = fs.lstatSync(file, { bigint: true });
    dependencies.set(rel, dependencyFingerprint(file, stat));
    if (stat.isDirectory()) {
      for (const item of fs.readdirSync(file, { withFileTypes: true })) {
        visitDependencies(path.join(file, item.name), path.join(rel, item.name));
      }
    }
  }
  function visit(dir, rel = '') {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (shouldCancel()) throw new Error('workspace preparation cancelled');
      if (item.name === 'node_modules') {
        if (dependencies) {
          const name = rel ? path.join(rel, item.name) : item.name;
          visitDependencies(path.join(root, name), name);
        }
        continue;
      }
      if (ignored(item.name)) continue;
      if (path.basename(rel) === '.moragent' && INTERNAL.has(item.name)) continue;
      const name = rel ? path.join(rel, item.name) : item.name;
      const file = path.join(root, name);
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) { entries.set(name, fingerprint(file, stat, shouldCancel)); visit(file, name); }
      else entries.set(name, fingerprint(file, stat, shouldCancel));
    }
  }
  visit(root);
  return entries;
}

function fingerprintAt(root, rel) {
  const file = path.join(root, rel);
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  return fingerprint(file, stat);
}

function gitTop(project) {
  try {
    const top = execFileSync('git', ['-C', project, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    execFileSync('git', ['-C', top, 'rev-parse', '--verify', 'HEAD'], { stdio: 'ignore' });
    return fs.realpathSync(top);
  } catch { return null; }
}

function gitClone(source, target) {
  try {
    execFileSync('git', ['clone', '--quiet', '--shared', '--no-checkout', '--', source, target], { stdio: 'ignore' });
    execFileSync('git', ['-C', target, 'reset', '--mixed', 'HEAD'], { stdio: 'ignore' });
    return true;
  } catch {
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    return false;
  }
}

function gitRefs(directory) {
  return execFileSync('git', ['-C', directory, 'for-each-ref', '--sort=refname', '--format=%(refname) %(objectname)'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

function gitIndex(directory) {
  return execFileSync('git', ['-C', directory, 'diff', '--cached', '--raw', '--no-ext-diff'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024,
  });
}

function detachGitObjects(directory) {
  const alternates = path.join(directory, '.git', 'objects', 'info', 'alternates');
  if (!fs.existsSync(alternates)) return true;
  try {
    // A shared clone is fast for every worker, but a retained recovery must not
    // depend on the source repository staying at its original path.
    execFileSync('git', ['-C', directory, 'repack', '-a', '-d', '-q'], { stdio: 'ignore' });
    const backup = `${alternates}.moragent-${crypto.randomUUID()}`;
    fs.renameSync(alternates, backup);
    try {
      execFileSync('git', ['-C', directory, 'fsck', '--full', '--connectivity-only'], { stdio: 'ignore' });
      fs.unlinkSync(backup);
      return true;
    } catch {
      fs.renameSync(backup, alternates);
      return false;
    }
  } catch {
    return false;
  }
}

function removeWorkspace(workspace) {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmdirSync(path.dirname(workspace));
}

function safeParent(root, rel) {
  let current = root;
  for (const part of path.dirname(rel).split(path.sep)) {
    if (part === '.') continue;
    current = path.join(current, part);
    if (fs.existsSync(current) && !fs.lstatSync(current).isDirectory()) return false;
  }
  return true;
}

function changedPaths(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((rel) => before.get(rel) !== after.get(rel)).sort();
}

const isDirectoryFingerprint = (value) => typeof value === 'string' && /^directory:[0-7]{1,4}$/.test(value);
const directoryMode = (value) => Number.parseInt(value.slice('directory:'.length), 8);

function pathConflicts(source, workspace, before, after, paths) {
  return paths.filter((rel) => {
    const original = before.get(rel);
    const current = after.get(rel);
    const supported = (value) => value === undefined || isDirectoryFingerprint(value) || value.startsWith('file:');
    return !safeParent(source, rel) || !safeParent(workspace, rel)
      || fingerprintAt(source, rel) !== original
      || fingerprintAt(workspace, rel) !== current
      || !supported(original) || !supported(current)
      || (original !== undefined && current !== undefined && isDirectoryFingerprint(original) !== isDirectoryFingerprint(current));
  });
}

function publishPaths(source, workspace, before, after, paths, shouldCancel = () => false) {
  const checkCancelled = () => { if (shouldCancel()) throw new Error('cancelled before publication completed'); };
  if (shouldCancel()) return { ok: false, conflicts: ['cancelled before publication'] };
  const conflicts = pathConflicts(source, workspace, before, after, paths);
  if (conflicts.length) return { ok: false, conflicts };
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'moragent-merge-'));
  const operations = [];
  try {
    for (const [index, rel] of paths.entries()) {
      checkCancelled();
      const destination = path.join(source, rel);
      const wasDirectory = isDirectoryFingerprint(before.get(rel));
      const isDirectory = isDirectoryFingerprint(after.get(rel));
      const previous = before.has(rel) && !wasDirectory ? path.join(staging, `${index}.before`) : null;
      const next = after.has(rel) && !isDirectory ? path.join(staging, `${index}.after`) : null;
      if (previous) fs.copyFileSync(destination, previous);
      if (next) {
        const origin = path.join(workspace, rel);
        fs.copyFileSync(origin, next);
        fs.chmodSync(next, fs.statSync(origin).mode & 0o777);
      }
      operations.push({ destination, previous, next, wasDirectory, isDirectory,
        beforeMode: wasDirectory ? directoryMode(before.get(rel)) : null,
        afterMode: isDirectory ? directoryMode(after.get(rel)) : null });
    }
    const depth = (op) => path.relative(source, op.destination).split(path.sep).length;
    const ordered = [
      ...operations.filter((op) => op.isDirectory && !op.wasDirectory).sort((a, b) => depth(a) - depth(b)).map((op) => ({ ...op, kind: 'mkdir' })),
      ...operations.filter((op) => !op.isDirectory && !op.wasDirectory).map((op) => ({ ...op, kind: 'file' })),
      ...operations.filter((op) => op.wasDirectory && !op.isDirectory).sort((a, b) => depth(b) - depth(a)).map((op) => ({ ...op, kind: 'rmdir' })),
      ...operations.filter((op) => op.isDirectory).sort((a, b) => depth(b) - depth(a)).map((op) => ({ ...op, kind: 'chmod' })),
    ];
    const applied = [];
    try {
      for (const op of ordered) {
        checkCancelled();
        if (op.kind === 'mkdir') {
          fs.mkdirSync(op.destination, { mode: 0o700 });
          applied.push(op);
          fs.chmodSync(op.destination, 0o700);
          continue;
        }
        if (op.kind === 'rmdir') fs.rmdirSync(op.destination);
        else if (op.kind === 'chmod') fs.chmodSync(op.destination, op.afterMode);
        else if (op.next) {
          fs.mkdirSync(path.dirname(op.destination), { recursive: true });
          const temp = `${op.destination}.moragent-${crypto.randomUUID()}.tmp`;
          try {
            fs.copyFileSync(op.next, temp);
            fs.chmodSync(temp, fs.statSync(op.next).mode & 0o777);
            fs.renameSync(temp, op.destination);
          } finally {
            if (fs.existsSync(temp)) fs.unlinkSync(temp);
          }
        } else fs.unlinkSync(op.destination);
        applied.push(op);
      }
      checkCancelled();
    } catch (error) {
      const rollbackErrors = [];
      for (const op of applied.reverse()) {
        try {
          if (op.kind === 'mkdir') fs.rmdirSync(op.destination);
          else if (op.kind === 'rmdir') { fs.mkdirSync(op.destination, { mode: op.beforeMode }); fs.chmodSync(op.destination, op.beforeMode); }
          else if (op.kind === 'chmod') fs.chmodSync(op.destination, op.wasDirectory ? op.beforeMode : 0o700);
          else if (op.previous) fs.copyFileSync(op.previous, op.destination);
          else fs.unlinkSync(op.destination);
        } catch (rollbackError) { rollbackErrors.push(rollbackError.message); }
      }
      return { ok: false, conflicts: [error.message, ...rollbackErrors] };
    }
    return { ok: true, files: paths };
  } catch (error) {
    return { ok: false, conflicts: [error.message] };
  } finally {
    try { fs.rmSync(staging, { recursive: true, force: true }); }
    catch { /* temporary staging is best effort */ }
  }
}

function validRecoveryPath(rel) {
  if (typeof rel !== 'string' || !rel || /[\u0000-\u001f\u007f]/.test(rel) || path.isAbsolute(rel) || path.normalize(rel) !== rel) return false;
  const parts = rel.split(path.sep);
  if (parts.some((part) => !part || part === '.' || part === '..' || ignored(part))) return false;
  return !parts.some((part, index) => part === 'runs' && parts[index - 1] === '.moragent');
}

function validExcludedPath(rel) {
  if (typeof rel !== 'string' || !rel || /[\u0000-\u001f\u007f]/.test(rel) || path.isAbsolute(rel) || path.normalize(rel) !== rel) return false;
  const parts = rel.split(path.sep);
  return parts.includes('node_modules') && !parts.some((part) => !part || part === '.' || part === '..' || part === '.git');
}

function loadRecovery(root, identifier) {
  const project = fs.realpathSync(root);
  const source = gitTop(project) || project;
  const matches = listRecoveries(project).filter((item) =>
    item.id.toLowerCase() === String(identifier || '').toLowerCase()
      || item.taskId.toLowerCase() === String(identifier || '').toLowerCase());
  if (!matches.length) return { ok: false, code: 'not-found', error: 'Recovery not found' };
  if (matches.length > 1) return { ok: false, code: 'ambiguous', error: 'Ambiguous task ID; use a full recovery ID', ids: matches.map((item) => item.id) };
  const item = matches[0];
  const directory = path.join(project, '.moragent', 'runs', 'recovery', item.id);
  const workspace = path.join(directory, 'project');
  let manifest;
  try {
    if (!fs.lstatSync(path.join(directory, 'manifest.json')).isFile()) throw new Error('not a regular manifest');
    if (fs.realpathSync(workspace) !== path.resolve(workspace)) throw new Error('recovery workspace is a symlink');
    manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  } catch {
    return { ok: false, code: 'manifest-missing', error: 'Recovery has no valid manifest; inspect the saved copy manually', ...item };
  }
  const sameProject = manifest?.version === 1
    ? manifest.source === source
    : manifest?.version === 2 && manifest.projectId && manifest.projectId === recoveryProjectId(path.dirname(directory));
  if (!manifest || typeof manifest !== 'object' || !sameProject
      || manifest.projectRelative !== path.relative(source, project)
      || manifest.taskId !== item.taskId || !Array.isArray(manifest.files)) {
    return { ok: false, code: 'manifest-mismatch', error: 'Recovery manifest does not match this project', ...item };
  }
  if (manifest.manualOnlyReason !== undefined && !['acceptance-check-failed', 'task-scope-violation'].includes(manifest.manualOnlyReason)) {
    return { ok: false, code: 'manifest-invalid', error: 'Recovery manifest contains an invalid manual-only reason', ...item };
  }
  const seen = new Set();
  const before = new Map();
  const after = new Map();
  for (const file of manifest.files) {
    if (!file || !validRecoveryPath(file.path) || seen.has(file.path)
        || (file.before !== null && typeof file.before !== 'string')
        || (file.after !== null && typeof file.after !== 'string')
        || file.before === file.after) {
      return { ok: false, code: 'manifest-invalid', error: 'Recovery manifest contains an invalid path or fingerprint', ...item };
    }
    seen.add(file.path);
    if (file.before !== null) before.set(file.path, file.before);
    if (file.after !== null) after.set(file.path, file.after);
  }
  let excludedCount = null;
  let excludedPaths = [];
  if (manifest.excludedCount !== undefined || manifest.excludedPaths !== undefined) {
    excludedCount = manifest.excludedCount;
    excludedPaths = manifest.excludedPaths;
    if (!Number.isSafeInteger(excludedCount) || excludedCount < 0 || !Array.isArray(excludedPaths)
        || excludedPaths.length !== Math.min(excludedCount, 50)
        || new Set(excludedPaths).size !== excludedPaths.length
        || excludedPaths.some((rel) => !validExcludedPath(rel))) {
      return { ok: false, code: 'manifest-invalid', error: 'Recovery manifest contains invalid excluded paths', ...item };
    }
  }
  const files = [...seen].sort();
  let conflicts;
  try { conflicts = pathConflicts(source, workspace, before, after, files); }
  catch { return { ok: false, code: 'inspect-failed', error: 'Recovery paths could not be inspected', ...item }; }
  const gitPortable = !fs.existsSync(path.join(workspace, '.git', 'objects', 'info', 'alternates'));
  return { ok: true, ...item, files, conflicts,
    canApply: !manifest.manualOnlyReason && files.length > 0 && conflicts.length === 0,
    manualOnlyReason: manifest.manualOnlyReason || null,
    gitPortable, excludedCount, excludedPaths, source, workspace, before, after };
}

export function inspectRecovery(root, identifier) {
  const recovery = loadRecovery(root, identifier);
  if (!recovery.ok) return recovery;
  const { id, taskId, path: savedPath, savedAt, files, conflicts, canApply, manualOnlyReason, gitPortable, excludedCount, excludedPaths } = recovery;
  return { ok: true, id, taskId, path: savedPath, savedAt, files, conflicts, canApply, manualOnlyReason, gitPortable, excludedCount, excludedPaths };
}

export function applyRecovery(root, identifier, { shouldCancel = () => false } = {}) {
  const recovery = loadRecovery(root, identifier);
  if (!recovery.ok) return recovery;
  if (recovery.manualOnlyReason) return { id: recovery.id, path: recovery.path, ok: false, code: 'manual-only', error: 'Recovery failed an exact acceptance check or task-scope guard; inspect the saved copy manually' };
  if (!recovery.files.length) return { id: recovery.id, path: recovery.path, ok: false, code: 'no-files', error: 'Recovery has no path changes to apply; Git metadata remains in the saved copy' };
  if (recovery.conflicts.length) return { id: recovery.id, path: recovery.path, ok: false, code: 'conflict', error: 'Source or saved files changed; nothing was applied', conflicts: recovery.conflicts };
  let published;
  try {
    published = withPublicationLockSync(recovery.source,
      () => publishPaths(recovery.source, recovery.workspace, recovery.before, recovery.after, recovery.files, shouldCancel), shouldCancel);
  } catch (error) {
    return { id: recovery.id, path: recovery.path, ok: false, code: shouldCancel() ? 'cancelled' : 'lock', error: error.message };
  }
  if (!published.ok && shouldCancel()) published.code = 'cancelled';
  return { ...published, id: recovery.id, taskId: recovery.taskId, workspace: recovery.path, retained: true,
    excludedCount: recovery.excludedCount, excludedPaths: recovery.excludedPaths };
}

// A worker receives a private copy. Integration is optimistic: changed paths are published only
// when their source version is still the snapshot. Writes are staged and rolled back on I/O errors.
// This is not an OS security sandbox; CLI agents may still access paths outside their cwd.
export function createTaskWorkspace(root, taskId = 'task', { onProgress, shouldCancel = () => false, preparedContainer, publicationLockManaged = false, publicationChecks = [], taskChecks = [], protectedOtherPaths = [] } = {}) {
  if (!Array.isArray(publicationChecks) || publicationChecks.some((check) => !isValidFileTextCheck(check))
      || !Array.isArray(taskChecks) || taskChecks.some((check) => !isValidFileTextCheck(check))
      || !Array.isArray(protectedOtherPaths) || protectedOtherPaths.some((entry) => typeof entry !== 'string' || !entry || path.isAbsolute(entry) || entry.split(/[\\/]/).includes('..'))) {
    throw new Error('invalid exact checks');
  }
  const project = fs.realpathSync(root);
  const repository = gitTop(project);
  const source = repository || project;
  const projectRelative = path.relative(source, project);
  // Async callers reserve this directory in the parent process so it can be
  // cleaned up even if the worker dies before sending its first message.
  if (preparedContainer) {
    const actual = fs.realpathSync(preparedContainer);
    if (path.dirname(actual) !== fs.realpathSync(os.tmpdir()) || !path.basename(actual).startsWith('moragent-task-')) {
      throw new Error('invalid prepared workspace container');
    }
  }
  const container = preparedContainer || fs.mkdtempSync(path.join(os.tmpdir(), 'moragent-task-'));
  const workspace = path.join(container, 'project');
  try {
    if (shouldCancel()) throw new Error('workspace preparation cancelled');
    if (!repository) fs.mkdirSync(workspace);
    else if (!gitClone(source, workspace)) throw new Error(`could not clone Git project into ${workspace}`);
    if (shouldCancel()) throw new Error('workspace preparation cancelled');
    onProgress?.('copying');
    copyProject(source, workspace, shouldCancel);
    onProgress?.('snapshot');
    const baselineDependencies = new Map();
    const baseline = snapshot(workspace, baselineDependencies, shouldCancel);
    if (shouldCancel()) throw new Error('workspace preparation cancelled');
    const canonicalWorkspace = fs.realpathSync(workspace);
    const baselineHead = repository ? execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() : null;
    const baselineHeadFile = repository ? fingerprintAt(path.join(workspace, '.git'), 'HEAD') : null;
    const baselineGitConfig = repository ? fingerprintAt(path.join(workspace, '.git'), 'config') : null;
    const baselineRefs = repository ? gitRefs(workspace) : null;
    const baselineIndex = repository ? gitIndex(workspace) : null;
    let closed = false;
    let recovery = null;
    let lastSnapshot = null;
    let lastDependencyChanges = null;
    function preserve({ manualOnlyReason = null } = {}) {
      if (manualOnlyReason !== null && !['acceptance-check-failed', 'task-scope-violation'].includes(manualOnlyReason)) throw new Error('invalid manual-only reason');
      if (recovery) return path.join(recovery, 'project', projectRelative);
      if (closed) throw new Error('workspace already closed');
      const gitPortable = !repository || detachGitObjects(workspace);
      let manifest = null;
      try {
        let after = lastSnapshot;
        let dependencyChanges = lastDependencyChanges;
        if (!after || dependencyChanges === null) {
          const dependencyAfter = new Map();
          after = snapshot(workspace, dependencyAfter);
          dependencyChanges = changedPaths(baselineDependencies, dependencyAfter);
        }
        const directory = path.join(project, '.moragent', 'runs', 'recovery');
        fs.mkdirSync(directory, { recursive: true });
        const projectId = recoveryProjectId(directory, true);
        if (!projectId) throw new Error('recovery project identity unavailable');
        manifest = {
          version: 2,
          taskId,
          source,
          projectRelative,
          projectId,
          gitPortable,
          ...(manualOnlyReason ? { manualOnlyReason } : {}),
          excludedCount: dependencyChanges.length,
          excludedPaths: dependencyChanges.slice(0, 50),
          files: changedPaths(baseline, after).map((rel) => ({
            path: rel, before: baseline.get(rel) ?? null, after: after.get(rel) ?? null,
          })),
        };
      } catch { /* still preserve the copy for manual recovery */ }
      const directory = path.join(project, '.moragent', 'runs', 'recovery');
      fs.mkdirSync(directory, { recursive: true });
      const target = path.join(directory, `${String(taskId).replace(/[^A-Za-z0-9_-]/g, '_')}-${crypto.randomUUID()}`);
      try {
        fs.renameSync(container, target);
      } catch (error) {
        if (error.code !== 'EXDEV') return path.join(workspace, projectRelative);
        try {
          fs.cpSync(container, target, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
          fs.rmSync(container, { recursive: true, force: true });
        } catch {
          if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
          return path.join(workspace, projectRelative);
        }
      }
      recovery = target;
      closed = true;
      if (manifest) {
        try { fs.writeFileSync(path.join(recovery, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n'); }
        catch { /* the saved project remains available for manual recovery */ }
      }
      return path.join(recovery, 'project', projectRelative);
    }
    const rewriteInfo = { source, prefixes: [...new Set([canonicalWorkspace, workspace])].sort((a, b) => b.length - a.length) };
    return {
      root: path.join(workspace, projectRelative),
      rewriteInfo,
      recoveryInfo: { container, projectRelative },
      rewritePaths(text) {
        let result = String(text || '');
        for (const prefix of rewriteInfo.prefixes) {
          result = result.replaceAll(prefix, source);
        }
        return result;
      },
      // On conflict or unsupported file type, preserve the private workspace for recovery.
      integrate(shouldCancel = () => false) {
        if (closed) throw new Error('workspace already closed');
        if (shouldCancel()) return { ok: false, conflicts: ['cancelled before publication'], workspace: preserve() };
        if (!baselineHead && fs.existsSync(path.join(workspace, '.git'))) {
          return { ok: false, conflicts: ['private Git repository created; history is not transferred'], workspace: preserve() };
        }
        if (baselineHead) {
          let head;
          try { head = execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
          catch { head = null; }
          if (head !== baselineHead) return { ok: false, conflicts: ['private Git history changed; commits are not transferred'], workspace: preserve() };
          if (fingerprintAt(path.join(workspace, '.git'), 'HEAD') !== baselineHeadFile) {
            return { ok: false, conflicts: ['private Git HEAD changed; branch or detached state is not transferred'], workspace: preserve() };
          }
          if (fingerprintAt(path.join(workspace, '.git'), 'config') !== baselineGitConfig) {
            return { ok: false, conflicts: ['private Git config changed; repository settings are not transferred'], workspace: preserve() };
          }
          let refs;
          try { refs = gitRefs(workspace); }
          catch { refs = null; }
          if (refs !== baselineRefs) return { ok: false, conflicts: ['private Git refs changed; branches, tags or stashes are not transferred'], workspace: preserve() };
          let index;
          try { index = gitIndex(workspace); }
          catch { index = null; }
          if (index !== baselineIndex) return { ok: false, conflicts: ['private Git index changed; staged changes are not transferred'], workspace: preserve() };
        }
        const dependencyAfter = new Map();
        const changed = snapshot(workspace, dependencyAfter);
        lastSnapshot = changed;
        const dependencyChanges = changedPaths(baselineDependencies, dependencyAfter);
        lastDependencyChanges = dependencyChanges;
        if (dependencyChanges.length) {
          const preview = dependencyChanges.slice(0, 5).join(', ');
          return { ok: false, conflicts: [`node_modules changed but is not integrated: ${preview}${dependencyChanges.length > 5 ? ', …' : ''}`], workspace: preserve() };
        }
        const paths = changedPaths(baseline, changed);
        const crossed = protectedOtherPaths.filter((entry) => paths.includes(path.join(projectRelative, ...entry.split('/'))));
        if (crossed.length) {
          const failures = crossed.map((entry) => `task scope violation: ${entry} belongs to another task`);
          return { ok: false, conflicts: failures, acceptanceFailures: failures, scopeFailures: failures,
            workspace: preserve({ manualOnlyReason: 'task-scope-violation' }) };
        }
        // A user-authored exact contract applies to every writer in this plan,
        // even if the model put its matching check on a later task. Never publish
        // intermediate wrong bytes and hope that a downstream checker repairs them.
        const changedPath = (check) => paths.includes(path.join(projectRelative, ...check.path.split('/')));
        const guarded = publicationChecks.filter(changedPath);
        const touchedTaskChecks = taskChecks.filter(changedPath);
        const untouchedTaskChecks = taskChecks.filter((check) => !changedPath(check));
        const acceptanceFailures = verifyTaskChecks(path.join(workspace, projectRelative), [...guarded, ...touchedTaskChecks]);
        if (acceptanceFailures.length) {
          return { ok: false, conflicts: acceptanceFailures, acceptanceFailures,
            workspace: preserve({ manualOnlyReason: 'acceptance-check-failed' }) };
        }
        const publish = () => {
          // A read-only check against the private snapshot can become stale
          // while the worker runs. Validate the current source under the same
          // project lock that serializes MORAGENT publications.
          const sourceFailures = verifyTaskChecks(project, untouchedTaskChecks);
          if (sourceFailures.length) return { ok: false, conflicts: sourceFailures, acceptanceFailures: sourceFailures };
          return publishPaths(source, workspace, baseline, changed, paths, shouldCancel);
        };
        const published = publicationLockManaged ? publish() : withPublicationLockSync(source, publish, shouldCancel);
        if (!published.ok) return { ...published, workspace: preserve(published.acceptanceFailures?.length ? { manualOnlyReason: 'acceptance-check-failed' } : undefined) };
        closed = true;
        try { removeWorkspace(workspace); } catch { /* merge already committed */ }
        return guarded.length ? { ...published, verifiedChecks: guarded.map((check) => check.path) } : published;
      },
      preserve,
      discard() {
        if (recovery) fs.rmSync(recovery, { recursive: true, force: true });
        else if (!closed) removeWorkspace(workspace);
        closed = true;
      },
    };
  } catch (error) {
    try { removeWorkspace(workspace); } catch { /* preserve failed setup for inspection */ }
    throw error;
  }
}
