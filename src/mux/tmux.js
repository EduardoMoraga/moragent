import { which, run } from '../core/exec.js';
import { slugify } from '../core/fsx.js';
import { checked, paneCommand } from './util.js';

const call = (args, opts) => checked(run('tmux', args, opts), `tmux ${args[0]}`);
const sessionName = (root) => `moragent-${slugify(root.split(/[\\/]/).filter(Boolean).at(-1) || 'project')}`;

function ensureSession(root, cwd) {
  if (process.env.TMUX) return null;
  const session = sessionName(root);
  const exists = run('tmux', ['has-session', '-t', session]);
  if (exists.code !== 0) call(['new-session', '-d', '-s', session, '-c', cwd, '-n', 'moragent']);
  return session;
}

export default {
  name: 'tmux',
  available: () => !!which('tmux'),
  spawn({ root, role, command, cwd = root, anchor, direction = 'horizontal' }) {
    const session = ensureSession(root, cwd);
    const target = anchor || (session ? `${session}:0` : undefined);
    const args = ['split-window', direction === 'vertical' ? '-v' : '-h', '-P', '-F', '#{pane_id}', '-c', cwd];
    if (target) args.push('-t', target);
    if (command) args.push(paneCommand({ root, role, command }));
    const handle = call(args, { cwd }).stdout.trim().split(/\r?\n/).at(-1);
    if (target) run('tmux', ['select-layout', '-t', target, 'tiled']);
    return { handle, session };
  },
  send(handle, text, { enter = true } = {}) {
    call(['send-keys', '-t', handle, '-l', String(text)]);
    if (enter) call(['send-keys', '-t', handle, 'Enter']);
  },
  read(handle, { lines = 60 } = {}) {
    return call(['capture-pane', '-p', '-t', handle, '-S', `-${Math.max(1, Number(lines) || 60)}`]).stdout;
  },
  close(handle) { call(['kill-pane', '-t', handle]); },
  alive(handle) {
    const result = run('tmux', ['list-panes', '-a', '-F', '#{pane_id}']);
    return result.code === 0 && result.stdout.split(/\r?\n/).includes(handle);
  },
};
