import { Worker } from 'node:worker_threads';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { withPublicationLock } from './publication-lock.js';

async function rescueOrphan(root, taskId, info) {
  const { container, projectRelative } = info.recoveryInfo || {};
  if (!container || typeof projectRelative !== 'string' || path.isAbsolute(projectRelative)
      || projectRelative.split(path.sep).includes('..')) throw new Error('invalid worker copy location');
  const temp = await fs.realpath(os.tmpdir());
  const actual = await fs.realpath(container);
  if (path.dirname(actual) !== temp || !path.basename(actual).startsWith('moragent-task-')) {
    throw new Error('worker copy is not in the expected temporary directory');
  }
  const project = await fs.realpath(root);
  const directory = path.join(project, '.moragent', 'runs', 'recovery');
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, `${String(taskId).replace(/[^A-Za-z0-9_-]/g, '_')}-${crypto.randomUUID()}`);
  try { await fs.rename(container, target); }
  catch (error) {
    if (error.code !== 'EXDEV') throw error;
    try { await fs.cp(container, target, { recursive: true }); }
    catch (copyError) { await fs.rm(target, { recursive: true, force: true }).catch(() => {}); throw copyError; }
    await fs.rm(container, { recursive: true, force: true });
  }
  // No baseline survived the crashed worker: this copy is intentionally manual-only.
  return path.join(target, 'project', projectRelative);
}

// Concurrent snapshots may be prepared in parallel, but publishing against one
// source must stay serial or two workers can both pass the same base check.
const publicationTails = new Map();

async function publishSerially(source, action, signal) {
  const previous = publicationTails.get(source) || Promise.resolve();
  let release;
  const tail = new Promise((resolve) => { release = resolve; });
  publicationTails.set(source, tail);
  try {
    await previous;
    // An aborted worker cannot publish: let it run its own cancellation path,
    // which preserves the private copy, without waiting for the source lock.
    if (signal?.aborted) return await action();
    try { return await withPublicationLock(source, action, { signal }); }
    catch (error) {
      if (signal?.aborted) return await action();
      throw error;
    }
  } finally {
    release();
    if (publicationTails.get(source) === tail) publicationTails.delete(source);
  }
}

// Keep filesystem-heavy clone, fingerprint and publish work off the TUI event loop.
// The worker owns the workspace baseline until one terminal operation closes it.
export async function createTaskWorkspaceAsync(root, taskId, { signal, onProgress, onWorker, publicationChecks = [], taskChecks = [], protectedOtherPaths = [] } = {}) {
  const cancelFlag = new Int32Array(new SharedArrayBuffer(4));
  const markCancelled = () => Atomics.store(cancelFlag, 0, 1);
  if (signal?.aborted) markCancelled();
  signal?.addEventListener('abort', markCancelled, { once: true });
  let container;
  try { container = await fs.mkdtemp(path.join(os.tmpdir(), 'moragent-task-')); }
  catch (error) { signal?.removeEventListener('abort', markCancelled); throw error; }
  let worker;
  try {
    worker = new Worker(new URL('./workspace-worker.js', import.meta.url), {
      workerData: { root, taskId, container, cancelBuffer: cancelFlag.buffer, publicationChecks, taskChecks, protectedOtherPaths },
      execArgv: [],
    });
  } catch (error) {
    signal?.removeEventListener('abort', markCancelled);
    await fs.rm(container, { recursive: true, force: true });
    throw error;
  }
  let nextId = 0;
  let closing = false;
  let closed = false;
  let readySettled = false;
  let failedError = null;
  let crashError = null;
  let exitFailure = null;
  let info;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const pending = new Map();
  const fail = (error) => {
    failedError = error;
    if (!readySettled) { readySettled = true; rejectReady(error); }
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  worker.on('message', (message) => {
    if (message.type === 'progress') {
      try { onProgress?.(message.phase); } catch { /* UI progress is best effort */ }
      return;
    }
    if (message.type === 'ready') {
      info = message;
      if (!readySettled) { readySettled = true; resolveReady(message); }
      return;
    }
    if (message.type === 'startup-error') {
      fail(new Error(message.error));
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(message.error));
  });
  worker.on('error', (error) => { crashError = error; });
  worker.on('exit', (code) => {
    if (closing) return;
    exitFailure = (async () => {
      let location = info?.root;
      let rescued = false;
      try {
        if (info) { location = await rescueOrphan(root, taskId, info); rescued = true; }
        else await fs.rm(container, { recursive: true, force: true });
      } catch { /* keep the original private path in the failure report */ }
      const reason = crashError?.message || `exit code ${code}`;
      const detail = location ? `${rescued ? 'Manual-only recovery' : 'Private copy may remain'}: ${location}. Inspect the source for partial publication.` : '';
      const error = new Error(`workspace worker exited before finishing (${reason}). ${detail}`.trim());
      fail(error);
      return error;
    })();
  });

  try { onWorker?.(worker, container); } catch { /* diagnostic callback is best effort */ }
  try { info = await ready; }
  catch (error) {
    signal?.removeEventListener('abort', markCancelled);
    closing = true;
    await worker.terminate();
    await fs.rm(container, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const close = async () => {
    closed = true;
    closing = true;
    signal?.removeEventListener('abort', markCancelled);
    await worker.terminate();
  };
  const invoke = async (method, options) => {
    if (closed) throw new Error('workspace already closed');
    if (exitFailure) throw await exitFailure;
    if (failedError) throw failedError;
    const id = ++nextId;
    let result;
    try {
      result = await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try { worker.postMessage({ id, method, options }); }
        catch (error) { pending.delete(id); reject(error); }
      });
    } catch (error) {
      if (method !== 'integrate') await close();
      throw error;
    }
    await close();
    return result;
  };
  return {
    root: info.root,
    get closed() { return closed; },
    rewritePaths(text) {
      let result = String(text || '');
      for (const prefix of info.rewriteInfo.prefixes) result = result.replaceAll(prefix, info.rewriteInfo.source);
      return result;
    },
    integrate: () => publishSerially(info.rewriteInfo.source, () => invoke('integrate'), signal),
    preserve: (options) => invoke('preserve', options),
    discard: () => invoke('discard'),
  };
}

// Explicit recovery uses the same synchronous publisher, but runs it away from
// the terminal event loop so another MORAGENT process cannot freeze the UI.
export function applyRecoveryAsync(root, identifier, { signal } = {}) {
  const cancelFlag = new Int32Array(new SharedArrayBuffer(4));
  const markCancelled = () => Atomics.store(cancelFlag, 0, 1);
  if (signal?.aborted) markCancelled();
  signal?.addEventListener('abort', markCancelled, { once: true });
  let worker;
  try {
    worker = new Worker(new URL('./recovery-worker.js', import.meta.url), {
      workerData: { root, identifier, cancelBuffer: cancelFlag.buffer }, execArgv: [],
    });
  } catch (error) {
    signal?.removeEventListener('abort', markCancelled);
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let workerError = null;
    const cleanup = () => signal?.removeEventListener('abort', markCancelled);
    worker.on('message', (message) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (message.ok) resolve(message.result);
      else reject(new Error(message.error));
    });
    worker.on('error', (error) => { workerError = error; });
    worker.on('exit', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`recovery worker exited before finishing (${workerError?.message || `exit code ${code}`}). Inspect the source for partial publication; the saved copy remains available.`));
    });
  });
}
