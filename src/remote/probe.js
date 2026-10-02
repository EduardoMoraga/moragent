import { spawnSync } from 'node:child_process';

// SSH runs this fixed command remotely. The path is read as data from stdin, never
// interpolated into the command or passed as an SSH option.
const CHECK_DIRECTORY = `sh -c 'IFS= read -r remote_root || exit 2; test -d "$remote_root"'`;

export function probeRemote(remote, { ssh = 'ssh' } = {}) {
  const args = [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=5',
    '-o', 'ConnectionAttempts=1',
    '--', remote.host, CHECK_DIRECTORY,
  ];
  const result = spawnSync(ssh, args, {
    input: `${remote.root}\n`,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  const status = result.status === 0 ? 'ready' : result.status === 1 ? 'missing_root' : 'unreachable';
  return { remoteId: remote.remoteId, host: remote.host, root: remote.root, status };
}
