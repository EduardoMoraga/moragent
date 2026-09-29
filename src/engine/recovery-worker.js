import { parentPort, workerData } from 'node:worker_threads';
import { applyRecovery } from './workspace.js';

const cancelFlag = new Int32Array(workerData.cancelBuffer);
try {
  const result = applyRecovery(workerData.root, workerData.identifier, {
    shouldCancel: () => Atomics.load(cancelFlag, 0) !== 0,
  });
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({ ok: false, error: String(error?.message || error) });
} finally { parentPort.close(); }
