import { spawn } from 'node:child_process';
import { shq } from '../core/exec.js';
import { MoragentError } from '../core/errors.js';

export function remoteOpenArgs(remote, { persist = false } = {}) {
  // OpenSSH sends the trailing command through the remote POSIX shell. Quote
  // the root for that shell regardless of the local operating system.
  if (persist && !/^r-[0-9a-f]{16}$/.test(remote.remoteId || '')) {
    throw new MoragentError('BAD_REMOTE_ID', 'A registered remote ID is required for persistent sessions.');
  }
  const app = persist
    ? `exec tmux new-session -A -s ${shq(`mora-${remote.remoteId}`, 'linux')} ${shq('mora', 'linux')}`
    : 'exec mora';
  const command = `cd ${shq(remote.root, 'linux')} && ${app}`;
  return ['-tt', '-o', 'StrictHostKeyChecking=yes', '--', remote.host, command];
}

export async function openRemote(remote, { ssh = 'ssh', spawnImpl = spawn, input = process.stdin, output = process.stdout, persist = false } = {}) {
  if (!input.isTTY || !output.isTTY) throw new MoragentError('NO_TTY', 'Opening a remote MORAGENT session requires an interactive terminal.');
  return new Promise((resolve, reject) => {
    const child = spawnImpl(ssh, remoteOpenArgs(remote, { persist }), { stdio: 'inherit' });
    child.once('error', () => reject(new MoragentError('SSH_FAILED', `Could not start SSH for ${remote.host}.`)));
    child.once('exit', (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}
