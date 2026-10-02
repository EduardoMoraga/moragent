import fs from 'node:fs';
import path from 'node:path';
import { dirs } from '../core/paths.js';
import { ensureDir, nowISO, readJSON, writeJSON } from '../core/fsx.js';
import { MoragentError } from '../core/errors.js';
import { t } from '../core/i18n.js';
import { withPublicationLockSync } from '../engine/publication-lock.js';

const normalizeId = (id) => String(id || '').toUpperCase();
const TASK_ID = /^T-\d+$/;
const ACTIVE = new Set(['queued', 'sent', 'running']);
export const DEFAULT_MAX_TASK_DEPTH = 3;
export const DEFAULT_MAX_CONCURRENT_CHILDREN = 3;
const taskPath = (root, id) => path.join(dirs(root).tasks, `${normalizeId(id)}.json`);

function validTaskId(id) { return TASK_ID.test(normalizeId(id)); }

function taskError(code, es, en) { return new MoragentError(code, t(es, en)); }

function childDepth(root, parent) {
  const seen = new Set();
  let depth = 1;
  let current = parent;
  while (current) {
    if (seen.has(current.id)) throw taskError('BAD_TASK_TREE', 'El árbol de tareas contiene un ciclo.', 'Task tree contains a cycle.');
    seen.add(current.id);
    if (!current.parentId) break;
    current = getTask(root, current.parentId);
    depth++;
  }
  return depth;
}

function validateDependencies(root, parentId, taskId, dependencies) {
  if (!Array.isArray(dependencies) || dependencies.some((id) => !validTaskId(id))) {
    throw taskError('BAD_DEPENDENCIES', 'Dependencias inválidas.', 'Invalid dependencies.');
  }
  const ids = dependencies.map(normalizeId);
  if (new Set(ids).size !== ids.length || ids.includes(taskId)) {
    throw taskError('BAD_DEPENDENCIES', 'Dependencias duplicadas o cíclicas.', 'Duplicate or cyclic dependencies.');
  }
  for (const id of ids) {
    const dependency = getTask(root, id);
    if ((dependency.parentId || null) !== parentId) {
      throw taskError('BAD_DEPENDENCIES', 'Las dependencias deben ser tareas hermanas.', 'Dependencies must be sibling tasks.');
    }
    // Updating an existing task can close a cycle through previously saved edges.
    const seen = new Set();
    const visit = (current) => {
      if (current === taskId) return true;
      if (seen.has(current)) return false;
      seen.add(current);
      const task = getTask(root, current);
      return (task.dependencies || []).some((next) => visit(normalizeId(next)));
    };
    if (taskId && visit(id)) throw taskError('BAD_DEPENDENCIES', 'Las dependencias forman un ciclo.', 'Dependencies form a cycle.');
  }
  return ids;
}

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

function persistTask({ root, title, role, body, spec, by, parentId, depth, dependencies }) {
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
    parentId,
    depth,
    dependencies,
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

export function createTask({ root, title, role, body, spec = null, by = 'lead', dependencies = [] }) {
  if (!root || !role || !body) throw new MoragentError(
    'BAD_TASK',
    t('La tarea requiere rol y descripción.', 'A task requires a role and description.'),
    'mora task add <role> "…"',
  );
  const ids = validateDependencies(root, null, null, dependencies);
  return persistTask({ root, title, role, body, spec, by, parentId: null, depth: 0, dependencies: ids });
}

export function createChildTask({ root, parentId, title, role, body, spec, by, dependencies = [],
  maxDepth = DEFAULT_MAX_TASK_DEPTH, maxConcurrentChildren = DEFAULT_MAX_CONCURRENT_CHILDREN } = {}) {
  if (!root || !validTaskId(parentId) || !role || !body) {
    throw taskError('BAD_TASK', 'Una subtarea requiere padre, rol y descripción.', 'A child task requires a parent, role, and description.');
  }
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || !Number.isSafeInteger(maxConcurrentChildren) || maxConcurrentChildren < 1) {
    throw taskError('BAD_TASK_LIMIT', 'Límites de subtareas inválidos.', 'Invalid child-task limits.');
  }
  // The project publication lock serializes check-and-create across MORAGENT processes.
  return withPublicationLockSync(root, () => {
    const parent = getTask(root, parentId);
    if (!ACTIVE.has(parent.status)) throw taskError('PARENT_NOT_ACTIVE', 'La tarea padre ya terminó.', 'The parent task has already ended.');
    const depth = childDepth(root, parent);
    if (depth > maxDepth) throw taskError('TASK_DEPTH_LIMIT', 'Se alcanzó el límite de profundidad.', 'Task depth limit reached.');
    const siblings = listTasks(root, { parentId: parent.id });
    if (siblings.filter((task) => ACTIVE.has(task.status)).length >= maxConcurrentChildren) {
      throw taskError('TASK_CONCURRENCY_LIMIT', 'Se alcanzó el límite de subtareas activas.', 'Active child-task limit reached.');
    }
    const ids = validateDependencies(root, parent.id, null, dependencies);
    return persistTask({ root, title, role, body, spec: spec === undefined ? parent.spec : spec,
      by: by || parent.role, parentId: parent.id, depth, dependencies: ids });
  });
}

export function getTask(root, id) {
  const normalized = normalizeId(id);
  if (!validTaskId(normalized)) throw new MoragentError('TASK_NOT_FOUND', t(`No existe la tarea ${normalized}.`, `Task ${normalized} does not exist.`));
  const task = readJSON(taskPath(root, normalized), null);
  if (!task) throw new MoragentError(
    'TASK_NOT_FOUND',
    t(`No existe la tarea ${normalized}.`, `Task ${normalized} does not exist.`),
    'mora task list',
  );
  return task;
}

export function listTasks(root, { status, role, parentId } = {}) {
  const dir = dirs(root).tasks;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => /^T-\d+\.json$/i.test(name))
    .map((name) => readJSON(path.join(dir, name), null))
    .filter(Boolean)
    .filter((task) => !status || task.status === status)
    .filter((task) => !role || task.role === role)
    .filter((task) => parentId === undefined || (task.parentId || null) === (parentId === null ? null : normalizeId(parentId)))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function updateTaskUnlocked(root, id, patch) {
  const current = getTask(root, id);
  if (patch.status === 'done' && listTasks(root, { parentId: current.id }).some((child) => ACTIVE.has(child.status))) {
    throw taskError('CHILD_TASKS_ACTIVE', 'Espera a que terminen las subtareas antes de cerrar la tarea padre.', 'Wait for child tasks before completing the parent task.');
  }
  const dependencies = Object.hasOwn(patch, 'dependencies')
    ? validateDependencies(root, current.parentId || null, current.id, patch.dependencies)
    : current.dependencies || [];
  const next = {
    ...current,
    ...patch,
    id: current.id,
    parentId: current.parentId || null,
    depth: Number.isSafeInteger(current.depth) ? current.depth : 0,
    dependencies,
    createdAt: current.createdAt,
    updatedAt: nowISO(),
  };
  writeJSON(taskPath(root, current.id), next);
  return next;
}

export function updateTask(root, id, patch) {
  // Closing a parent and creating a child must observe one another atomically.
  return patch.status === 'done'
    ? withPublicationLockSync(root, () => updateTaskUnlocked(root, id, patch))
    : updateTaskUnlocked(root, id, patch);
}
