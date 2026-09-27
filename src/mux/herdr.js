import { which, run } from '../core/exec.js';
import { MoragentError } from '../core/errors.js';
import { t } from '../core/i18n.js';
import { checked, containsValue, findValue, parseJSON, plainHandle } from './util.js';

const call = (args, opts) => checked(run('herdr', ['pane', ...args], opts), `herdr pane ${args[0]}`);

function handleFrom(text) {
  const data = parseJSON(text);
  return findValue(data, ['paneId', 'pane_id', 'handle', 'id']) || plainHandle(text);
}

export default {
  name: 'herdr',
  available: () => !!which('herdr'),
  spawn({ root, title, command, cwd = root, anchor, direction = 'horizontal' }) {
    const args = ['split'];
    if (anchor) args.push(anchor);
    else args.push('--current');
    args.push('--direction', direction === 'vertical' ? 'down' : 'right', '--cwd', cwd, '--no-focus');
    const result = call(args, { cwd });
    const handle = handleFrom(result.stdout);
    if (!handle) throw new MoragentError(
      'BAD_MUX_OUTPUT',
      t('Herdr no devolvió el id del panel.', 'Herdr did not return the pane id.'),
      String(result.stdout).trim().slice(0, 200),
    );
    if (title) {
      const renamed = run('herdr', ['pane', 'rename', handle, title], { cwd });
      if (renamed.code !== 0) { /* title is cosmetic */ }
    }
    if (command) call(['run', handle, command], { cwd });
    return { handle };
  },
  send(handle, text, { enter = true } = {}) {
    call(enter ? ['run', handle, String(text)] : ['send-text', handle, String(text)]);
  },
  read(handle, { lines = 60 } = {}) {
    return call(['read', handle, '--source', 'recent-unwrapped', '--lines', String(lines), '--format', 'text']).stdout;
  },
  close(handle) { call(['close', handle]); },
  alive(handle) {
    const result = run('herdr', ['pane', 'list']);
    if (result.code !== 0) return false;
    const data = parseJSON(result.stdout);
    return containsValue(data, handle) || result.stdout.includes(handle);
  },
};
