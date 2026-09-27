import path from 'node:path';
import { spawnDetached } from '../core/exec.js';
import { shimFor } from '../core/shim.js';
import { nowISO, readJSON, readText, writeJSON } from '../core/fsx.js';
import { dirs, findRoot } from '../core/paths.js';
import { MoragentError } from '../core/errors.js';
import { t } from '../core/i18n.js';
import { getAdapter } from '../crew/adapters.js';

const sessions = new Map();

export const headlessStatePath = (root) => path.join(dirs(root).runs, 'headless.json');
const loadRecords = (root) => root ? readJSON(headlessStatePath(root), {}) || {} : {};

function rootFor(state, options = {}) {
  return options.root || state?.root || findRoot() || null;
}

function getRecord(handle, options = {}) {
  const cached = sessions.get(handle);
  const root = rootFor(cached, options);
  if (cached) return cached;
  const record = loadRecords(root)[handle] || null;
  if (record) sessions.set(handle, record);
  return record;
}

function saveRecord(record) {
  sessions.set(record.handle, record);
  const records = loadRecords(record.root);
  records[record.handle] = record;
  writeJSON(headlessStatePath(record.root), records);
  return record;
}

function removeRecord(handle, options = {}) {
  const state = getRecord(handle, options);
  sessions.delete(handle);
  const root = rootFor(state, options);
  if (!root) return;
  const records = loadRecords(root);
  if (!records[handle]) return;
  delete records[handle];
  writeJSON(headlessStatePath(root), records);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function clearHeadlessCache() { sessions.clear(); }

export default {
  name: 'headless',
  available: () => true,
  spawn({ root, role, cwd = root, adapter, member, taskId, autonomy }) {
    const handle = `headless:${role}`;
    const previous = getRecord(handle, { root }) || {};
    const record = {
      ...previous,
      handle,
      root,
      role,
      cwd,
      cli: adapter?.id || member?.cli || previous.cli,
      autonomy: autonomy || member?.autonomy || previous.autonomy || 'auto',
      taskId: taskId || null,
      pid: null,
      logFile: taskId ? null : previous.logFile || null,
      status: taskId ? 'launching' : 'idle',
      updatedAt: nowISO(),
    };
    saveRecord(record);
    return { handle };
  },
  send(handle, text, options = {}) {
    const persisted = getRecord(handle, options) || {};
    const state = { ...persisted, ...options };
    const root = rootFor(state, options);
    const role = state.role || handle.replace(/^headless:/, '');
    if (!root) throw new MoragentError(
      'NO_PROJECT',
      t('No se pudo resolver el proyecto para la sesión headless.', 'Could not resolve the project for the headless session.'),
      'mora init',
    );
    const adapter = state.adapter || getAdapter(state.cli || state.member?.cli);
    const taskId = state.taskId || 'task';
    const [cmd, ...args] = adapter.headless({
      root, role, prompt: text, member: state.member, autonomy: state.autonomy,
    });
    const logFile = path.join(dirs(root).runs, `${role}-${taskId}.log`);
    const launched = {
      ...spawnDetached(cmd, args, {
        cwd: state.cwd || root,
        logFile,
        env: { MORAGENT_ROLE: role, ...(shimFor(root) ? { PATH: `${shimFor(root)}${path.delimiter}${process.env.PATH || ''}` } : {}) },
      }),
      logFile,
    };
    saveRecord({
      handle, root, role, cwd: state.cwd || root,
      cli: adapter.id, autonomy: state.autonomy || state.member?.autonomy || 'auto',
      taskId, pid: launched.pid, logFile, status: 'running', updatedAt: nowISO(),
    });
    return launched;
  },
  read(handle, { lines = 60, root } = {}) {
    const state = getRecord(handle, { root });
    if (!state?.logFile) return '';
    return readText(state.logFile).split(/\r?\n/).slice(-lines).join('\n');
  },
  close(handle, { root } = {}) {
    const state = getRecord(handle, { root });
    if (pidAlive(state?.pid)) {
      try { process.kill(state.pid, 'SIGTERM'); } catch { /* process already exited */ }
    }
    removeRecord(handle, { root });
  },
  alive(handle, { root } = {}) {
    const state = getRecord(handle, { root });
    if (!state) return false;
    if (state.status === 'idle') return true;
    return pidAlive(state.pid);
  },
};
