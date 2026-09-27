import { getTask } from './tasks.js';

const TERMINAL = new Set(['done', 'failed', 'blocked']);
export const parseDuration = (value, fallback) => {
  if (value == null || value === true) return fallback;
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
  if (!match) return fallback;
  const scale = { ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2]?.toLowerCase() || 'ms'];
  return Number(match[1]) * scale;
};

export async function waitForTasks(root, ids, { timeoutMs = 1800000, intervalMs = 5000 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const tasks = ids.map((id) => getTask(root, id));
    if (tasks.every((task) => TERMINAL.has(task.status))) return { timedOut: false, tasks };
    if (Date.now() >= end) return { timedOut: true, tasks };
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(1, end - Date.now()))));
  }
}
