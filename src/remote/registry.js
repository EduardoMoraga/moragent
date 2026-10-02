import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeJSON } from '../core/fsx.js';
import { MoragentError } from '../core/errors.js';
import { withRegistryLock } from '../core/registry-lock.js';

const VERSION = 1;
const HOST = /^(?:[A-Za-z_][A-Za-z0-9_.-]*@)?[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function remotesFile() {
  const home = process.env.MORAGENT_HOME?.trim();
  return path.join(home ? path.resolve(home) : path.join(os.homedir(), '.moragent'), 'remotes.json');
}

function readRegistry() {
  const file = remotesFile();
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: VERSION, remotes: [] };
    throw new MoragentError('BAD_REMOTE_REGISTRY', `Cannot read remote registry: ${file}`, 'Repair or restore remotes.json before retrying.');
  }
  if (data?.version !== VERSION || !Array.isArray(data.remotes) ||
      !data.remotes.every((r) => r && typeof r.remoteId === 'string' && typeof r.host === 'string' && typeof r.root === 'string' && typeof r.name === 'string')) {
    throw new MoragentError('BAD_REMOTE_REGISTRY', `Invalid remote registry: ${file}`, 'Repair or restore remotes.json before retrying.');
  }
  return data;
}

export function listRemotes() {
  return readRegistry().remotes;
}

export function registerRemote(host, root, { name } = {}) {
  if (typeof host !== 'string' || !HOST.test(host)) {
    throw new MoragentError('BAD_REMOTE_HOST', 'Use an SSH host alias, hostname, or user@host without options.');
  }
  if (typeof root !== 'string' || !root.startsWith('/') || /[\0\r\n]/.test(root)) {
    throw new MoragentError('BAD_REMOTE_ROOT', 'Remote root must be an absolute path without newlines.');
  }
  const remoteName = name === undefined ? host : String(name).trim();
  if (!remoteName) throw new MoragentError('BAD_REMOTE_NAME', 'Remote name cannot be empty.');
  const remote = {
    remoteId: `r-${createHash('sha256').update(`${host}\0${root}`).digest('hex').slice(0, 16)}`,
    name: remoteName,
    host,
    root,
    addedAt: new Date().toISOString(),
  };
  return withRegistryLock(remotesFile(), () => {
    const registry = readRegistry();
    const existing = registry.remotes.find((r) => r.host === host && r.root === root);
    if (existing) return { remote: existing, created: false };
    registry.remotes.push(remote);
    writeJSON(remotesFile(), registry);
    return { remote, created: true };
  });
}

export function resolveRemote(selector) {
  if (!selector) throw new MoragentError('REMOTE_REQUIRED', 'Provide a remote ID, name, or host.');
  const matches = listRemotes().filter((r) => r.remoteId === selector || r.name === selector || r.host === selector);
  if (matches.length > 1) throw new MoragentError('AMBIGUOUS_REMOTE', `Several remotes match: ${selector}`, 'Use the remote ID shown by mora remote list.');
  if (!matches.length) throw new MoragentError('UNKNOWN_REMOTE', `Unknown remote: ${selector}`, 'Run mora remote list.');
  return matches[0];
}
