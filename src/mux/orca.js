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

// Past this many panes a split leaves every agent too narrow to read (seen live: 11 columns).
const MAX_SPLITS = 4;

function panesInTab(handle) {
  const result = run('orca', ['terminal', 'list', '--json']);
  const list = parseJSON(result.stdout)?.result?.terminals;
  if (result.code !== 0 || !Array.isArray(list)) return 0;
  const tab = list.find((term) => term.handle === handle)?.tabId;
  return tab ? list.filter((term) => term.tabId === tab).length : 0;
}

export default {
  name: 'orca',
  available: () => !!which('orca'),
  // Split next to the anchor; when Orca cannot split (pane too small, no anchor) or the
  // project prefers tabs, open the agent in its own tab named after the role.
  spawn({ root, role, title, command, cwd = root, anchor, direction = 'horizontal', layout = 'split' }) {
    const base = anchor || process.env.ORCA_TERMINAL_HANDLE;
    const cmd = command ? paneCommand({ root, role, command }) : null;
    if (layout !== 'tabs' && base && panesInTab(base) < MAX_SPLITS) {
      const args = ['split', '--terminal', base, '--direction', direction === 'vertical' ? 'vertical' : 'horizontal'];
      if (cmd) args.push('--command', cmd);
      args.push('--json');
      const result = run('orca', ['terminal', ...args], { cwd });
      const handle = result.code === 0 ? handleFrom(result.stdout) : null;
      if (handle) return { handle, layout: 'split' };
    }
    const args = ['create', '--title', title || role || 'agent'];
    if (cmd) args.push('--command', cmd);
    args.push('--json');
    const result = call(args, { cwd });
    const handle = handleFrom(result.stdout);
    if (!handle) throw new MoragentError(
      'BAD_MUX_OUTPUT',
      t('Orca no devolvió el handle del panel.', 'Orca did not return the pane handle.'),
      title || String(result.stdout).trim().slice(0, 200),
    );
    return { handle, layout: 'tab' };
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
  key(handle, key) {
    const text = key === 'down' ? '\x1b[B' : key === 'enter' ? '\r' : String(key);
    call(['send', '--terminal', handle, '--text', text]);
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
  close(handle, { layout } = {}) {
    const args = ['close', '--terminal', handle];
    if (layout === 'tab') args.push('--tab');
    call(args);
  },
  alive(handle) {
    const result = run('orca', ['terminal', 'list', '--json']);
    if (result.code !== 0) return false;
    const data = parseJSON(result.stdout);
    return data?.ok !== false && (containsValue(data, handle) || result.stdout.includes(handle));
  },
};
