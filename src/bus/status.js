import fs from 'node:fs';
import path from 'node:path';
import { dirs } from '../core/paths.js';
import { getMux } from '../mux/index.js';

const TASK_ID = /^T-\d+$/i;
const FINAL = new Set(['done', 'failed', 'blocked']);

function readRecord(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { value, reason: null }
      : { value: null, reason: 'unreadable' };
  } catch (error) {
    return { value: null, reason: error?.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
}

function probePid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'ESRCH' ? false : null; }
}

function probePane(mux, handle, root) {
  try { return getMux(mux).alive(handle, { root }); }
  catch { return null; }
}

function nextAction(id, status, reason) {
  if (reason === 'task_not_found') return { command: 'mora task list', reason: 'find_task' };
  if (reason === 'task_record_unreadable') return { command: `cat .moragent/tasks/${id}.json`, reason: 'inspect_task_record' };
  if (reason === 'run_record_unreadable') return { command: 'cat .moragent/runs/headless.json', reason: 'inspect_run_record' };
  if (status === 'queued') return { command: 'mora board', reason: 'review_queue' };
  if (status === 'running' || status === 'sent') return { command: `mora status ${id}`, reason: 'check_again' };
  if (status === 'unknown') return { command: `mora task show ${id}`, reason: 'inspect_before_retry' };
  return { command: `mora task show ${id}`, reason: status === 'blocked' ? 'resolve_blocker' : 'review_result' };
}

function executionFor(task, runs) {
  if (task && Object.hasOwn(task, 'execution')) {
    const run = task.execution;
    if (!run || typeof run !== 'object' || Array.isArray(run)) return { run: null, reason: 'execution_record_unreadable' };
    return { run, reason: null };
  }
  if (runs.reason === 'unreadable') return { run: null, reason: 'run_record_unreadable' };
  const run = Object.values(runs.value || {}).find((entry) => entry && typeof entry === 'object' && !Array.isArray(entry) && entry.taskId === task?.id);
  return { run: run || null, reason: run ? null : 'run_record_missing' };
}

function projectTask(root, id, runs, settings, probes) {
  const loaded = readRecord(path.join(dirs(root).tasks, `${id}.json`));
  const task = loaded.value?.id?.toUpperCase?.() === id ? loaded.value : null;
  const { run, reason: runReason } = executionFor(task, runs);
  const mode = run?.mode || (run?.handle?.startsWith?.('headless:') ? 'headless' : null);
  const pid = Number.isSafeInteger(run?.pid) ? run.pid : null;
  const handle = typeof run?.handle === 'string' ? run.handle : null;
  const mux = typeof run?.mux === 'string' ? run.mux : null;
  const wrongProject = typeof run?.root === 'string' && path.resolve(run.root) !== path.resolve(root);
  const runInfo = {
    id: typeof run?.runId === 'string' ? run.runId : null,
    mode, mux, handle, pid,
    sessionId: typeof run?.sessionId === 'string' ? run.sessionId : null,
    updatedAt: typeof run?.updatedAt === 'string' ? run.updatedAt : null,
    alive: null,
  };

  let status = 'unknown';
  let reason = null;
  if (!task) reason = loaded.reason === 'missing' ? 'task_not_found' : 'task_record_unreadable';
  else if (FINAL.has(task.status)) status = task.status;
  else if (task.status === 'queued') status = 'queued';
  else if (!['sent', 'running'].includes(task.status)) reason = 'unrecognized_task_status';
  else if (runReason) reason = runReason;
  else if (run.root != null && typeof run.root !== 'string') reason = 'execution_record_unreadable';
  else if (wrongProject) reason = 'run_project_mismatch';
  else if (mode === 'pane') {
    if (!mux || !handle) reason = 'execution_handle_missing';
    else {
      runInfo.alive = probes.pane(mux, handle, root);
      if (runInfo.alive === true) {
        status = task.status === 'running' ? 'running' : 'sent';
        if (status === 'sent') reason = 'pane_alive_task_unverified';
      }
      else reason = runInfo.alive === false ? 'pane_not_running' : 'pane_unreadable';
    }
  } else if (mode === 'headless' || mode === 'engine') {
    if (mode === 'headless' && run.status && run.status !== 'running') reason = 'run_not_running';
    else if (!pid || pid <= 0) reason = 'process_handle_missing';
    else {
      runInfo.alive = probes.pid(pid);
      if (runInfo.alive === true) status = 'running';
      else reason = runInfo.alive === false ? 'process_not_running' : 'process_unreadable';
    }
  } else reason = 'execution_handle_missing';

  const taskAt = typeof task?.updatedAt === 'string' ? task.updatedAt : null;
  const runAt = runInfo.updatedAt;
  const lastEvent = runAt && (!taskAt || Date.parse(runAt) > Date.parse(taskAt))
    ? { type: 'run_update', at: runAt, status: typeof run?.status === 'string' ? run.status : null }
    : taskAt ? { type: 'task_update', at: taskAt, status: task.status || null } : null;
  return {
    id,
    title: typeof task?.title === 'string' ? task.title : null,
    role: typeof task?.role === 'string' ? task.role : null,
    provider: typeof run?.provider === 'string' ? run.provider : typeof run?.cli === 'string' ? run.cli : settings?.crew?.[task?.role]?.cli || null,
    status,
    recordedStatus: typeof task?.status === 'string' ? task.status : null,
    reason,
    run: runInfo,
    lastUpdate: lastEvent?.at || null,
    lastEvent,
    logFile: typeof run?.logFile === 'string' ? run.logFile : null,
    result: task?.result ?? null,
    files: Array.isArray(task?.files) ? task.files : [],
    nextAction: nextAction(id, status, reason),
  };
}

// Projection only: no task, run, or session record is changed by a status read.
export function readStatus(root, taskId = null, { config = null, probePid: pid = probePid, probePane: pane = probePane } = {}) {
  const settings = config || readRecord(dirs(root).config).value || {};
  const runs = readRecord(path.join(dirs(root).runs, 'headless.json'));
  let ids;
  if (taskId) {
    const id = String(taskId).toUpperCase();
    if (!TASK_ID.test(id)) return { ok: false, project: settings.project || path.basename(root), tasks: [] };
    ids = [id];
  } else {
    try {
      ids = fs.readdirSync(dirs(root).tasks)
        .filter((name) => /^T-\d+\.json$/i.test(name))
        .map((name) => name.slice(0, -5).toUpperCase()).sort();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      ids = [];
    }
  }
  return { ok: true, project: settings.project || path.basename(root), tasks: ids.map((id) => projectTask(root, id, runs, settings, { pid, pane })) };
}
