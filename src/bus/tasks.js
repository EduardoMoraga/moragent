import fs from 'node:fs';
import path from 'node:path';
import { dirs } from '../core/paths.js';
import { ensureDir, nowISO, readJSON, writeJSON } from '../core/fsx.js';
import { MoragentError } from '../core/errors.js';
import { t } from '../core/i18n.js';

const normalizeId = (id) => String(id || '').toUpperCase();
const taskPath = (root, id) => path.join(dirs(root).tasks, `${normalizeId(id)}.json`);

export function nextId(root) {
  const dir = dirs(root).tasks;
  ensureDir(dir);
  let max = 0;
  for (const name of fs.readdirSync(dir)) {
    const match = name.match(/^T-(\d+)\.json$/i);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `T-${String(max + 1).padStart(4, '0')}`;
}

function reserveTaskFile(root) {
  const dir = dirs(root).tasks;
  ensureDir(dir);
  let number = Number(nextId(root).slice(2));
  for (;;) {
    const id = `T-${String(number).padStart(4, '0')}`;
    const file = taskPath(root, id);
    try {
      return { id, file, fd: fs.openSync(file, 'wx') };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      number++;
    }
  }
}

export function reserveTaskId(root) {
  const reserved = reserveTaskFile(root);
  fs.closeSync(reserved.fd);
  return reserved.id;
}

export function createTask({ root, title, role, body, spec = null, by = 'lead' }) {
  if (!root || !role || !body) throw new MoragentError(
    'BAD_TASK',
    t('La tarea requiere rol y descripción.', 'A task requires a role and description.'),
    'mora task add <role> "…"',
  );
  const reserved = reserveTaskFile(root);
  fs.closeSync(reserved.fd);
  const id = reserved.id;
  const at = nowISO();
  const task = {
    id,
    title: title || String(body).split(/\r?\n/)[0].slice(0, 100),
    role,
    status: 'queued',
    spec: spec || null,
    body: String(body),
    createdAt: at,
    updatedAt: at,
    result: null,
    files: [],
    by,
  };
  try {
    writeJSON(reserved.file, task);
  } catch (error) {
    try { fs.unlinkSync(reserved.file); } catch { /* preserve original error */ }
    throw error;
  }
  return task;
}

export function getTask(root, id) {
  const normalized = normalizeId(id);
  const task = readJSON(taskPath(root, normalized), null);
  if (!task) throw new MoragentError(
    'TASK_NOT_FOUND',
    t(`No existe la tarea ${normalized}.`, `Task ${normalized} does not exist.`),
    'mora task list',
  );
  return task;
}

export function listTasks(root, { status, role } = {}) {
  const dir = dirs(root).tasks;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => /^T-\d+\.json$/i.test(name))
    .map((name) => readJSON(path.join(dir, name), null))
    .filter(Boolean)
    .filter((task) => !status || task.status === status)
    .filter((task) => !role || task.role === role)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function updateTask(root, id, patch) {
  const current = getTask(root, id);
  const next = {
    ...current,
    ...patch,
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: nowISO(),
  };
  writeJSON(taskPath(root, current.id), next);
  return next;
}
