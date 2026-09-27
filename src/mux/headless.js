import path from 'node:path';
import { spawnDetached } from '../core/exec.js';
import { dirs } from '../core/paths.js';
import { readText } from '../core/fsx.js';
import { getAdapter } from '../crew/adapters.js';

const sessions = new Map();

export default {
  name: 'headless',
  available: () => true,
  spawn({ root, role, cwd = root, adapter, member, taskId }) {
    const handle = `headless:${role}`;
    sessions.set(handle, { root, role, cwd, adapter, member, taskId });
    return { handle };
  },
  send(handle, text, options = {}) {
    const state = { ...(sessions.get(handle) || {}), ...options };
    const root = state.root || process.cwd();
    const role = state.role || handle.replace(/^headless:/, '');
    const adapter = state.adapter || getAdapter(state.cli || state.member?.cli);
    const taskId = state.taskId || 'task';
    const [cmd, ...args] = adapter.headless({ root, role, prompt: text, member: state.member });
    const logFile = path.join(dirs(root).runs, `${role}-${taskId}.log`);
    const launched = { ...spawnDetached(cmd, args, { cwd: state.cwd || root, logFile }), logFile };
    sessions.set(handle, { ...state, logFile });
    return launched;
  },
  read(handle) {
    const state = sessions.get(handle);
    if (!state?.logFile) return '';
    return readText(state.logFile);
  },
  close(handle) { sessions.delete(handle); },
  alive: () => true,
};
