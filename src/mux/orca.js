import { which, run } from '../core/exec.js';
import { MoragentError } from '../core/errors.js';
import { t } from '../core/i18n.js';
import { checked, containsValue, findValue, paneCommand, parseJSON } from './util.js';

const call = (args, opts) => checked(run('orca', ['terminal', ...args], opts), `orca terminal ${args[0]}`);

function handleFrom(text) {
  const data = parseJSON(text);
  if (data?.ok === false) return null;
  const found = findValue(data, ['handle', 'terminalHandle', 'terminal_handle', 'paneId', 'pane_id']);
  if (found) return found;
  const terminal = data?.result?.terminal ?? data?.terminal;
  return typeof terminal === 'string' && /^term[_-]/.test(terminal) ? terminal : null;
}

export default {
  name: 'orca',
  available: () => !!which('orca'),
  spawn({ root, role, title, command, cwd = root, anchor, direction = 'horizontal' }) {
    const base = anchor || process.env.ORCA_TERMINAL_HANDLE;
    const args = ['split'];
    if (base) args.push('--terminal', base);
    args.push('--direction', direction === 'vertical' ? 'vertical' : 'horizontal');
    if (command) args.push('--command', paneCommand({ root, role, command }));
    args.push('--json');
    const result = call(args, { cwd });
    const handle = handleFrom(result.stdout);
    if (!handle) throw new MoragentError(
      'BAD_MUX_OUTPUT',
      t('Orca no devolvió el handle del panel.', 'Orca did not return the pane handle.'),
      title || String(result.stdout).trim().slice(0, 200),
    );
    return { handle };
  },
  send(handle, text, { enter = true } = {}) {
    const args = ['send', '--terminal', handle, '--text', String(text)];
    if (enter) args.push('--enter');
    const result = run('orca', ['terminal', ...args]);
    const detail = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (/agent_prompt_blocked/i.test(detail)) throw new MoragentError(
      'PANE_NOT_READY',
      t('El panel de Orca no está listo para recibir la tarea.', 'The Orca pane is not ready to receive the task.'),
      t(`Completa el diálogo o menú del panel ${handle} y reintenta.`, `Complete the dialog or menu in pane ${handle} and retry.`),
    );
    checked(result, 'orca terminal send');
  },
  read(handle, { lines = 60 } = {}) {
    const result = call(['read', '--terminal', handle, '--screen', '--json']);
    const data = parseJSON(result.stdout);
    const tail = data?.result?.terminal?.tail ?? data?.terminal?.tail;
    const screen = Array.isArray(tail) ? tail.join('\n')
      : typeof tail === 'string' ? tail
        : findValue(data, ['screen', 'text', 'output', 'content']) ?? result.stdout;
    return String(screen).split(/\r?\n/).slice(-lines).join('\n');
  },
  close(handle) { call(['close', '--terminal', handle]); },
  alive(handle) {
    const result = run('orca', ['terminal', 'list', '--json']);
    if (result.code !== 0) return false;
    const data = parseJSON(result.stdout);
    return data?.ok !== false && (containsValue(data, handle) || result.stdout.includes(handle));
  },
};
