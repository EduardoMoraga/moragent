import { parentPort, workerData } from 'node:worker_threads';
import { searchFiles } from './tools.js';
import { setLang } from '../../core/i18n.js';

try {
  setLang(workerData.lang);
  parentPort.postMessage(await searchFiles(workerData.args, workerData.root));
} catch (error) {
  parentPort.postMessage({ ok: false, output: `Error: ${String(error?.message || error)}`, summary: 'Search failed' });
}
