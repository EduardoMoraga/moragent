import { parentPort, workerData } from 'node:worker_threads';
import { createTaskWorkspace } from './workspace.js';

const cancelFlag = new Int32Array(workerData.cancelBuffer);
let workspace;
try {
  workspace = createTaskWorkspace(workerData.root, workerData.taskId, {
    preparedContainer: workerData.container,
    publicationLockManaged: true,
    publicationChecks: workerData.publicationChecks,
    taskChecks: workerData.taskChecks,
    protectedOtherPaths: workerData.protectedOtherPaths,
    onProgress: (phase) => parentPort.postMessage({ type: 'progress', phase }),
    shouldCancel: () => Atomics.load(cancelFlag, 0) !== 0,
  });
  parentPort.postMessage({ type: 'ready', root: workspace.root, rewriteInfo: workspace.rewriteInfo, recoveryInfo: workspace.recoveryInfo });
} catch (error) {
  parentPort.postMessage({ type: 'startup-error', error: String(error?.message || error) });
  parentPort.close();
}

if (workspace) parentPort.on('message', ({ id, method, options }) => {
  try {
    if (!['integrate', 'preserve', 'discard'].includes(method)) throw new Error(`unsupported workspace operation: ${method}`);
    const result = method === 'integrate'
      ? workspace.integrate(() => Atomics.load(cancelFlag, 0) !== 0)
      : workspace[method](options);
    parentPort.postMessage({ id, ok: true, result });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: String(error?.message || error) });
  }
});
