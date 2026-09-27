import path from 'node:path';
import { dirs } from '../core/paths.js';
import { readJSON, writeJSON } from '../core/fsx.js';

export const panesPath = (root) => path.join(dirs(root).runs, 'panes.json');
export const loadPanes = (root) => readJSON(panesPath(root), {}) || {};
export const savePanes = (root, panes) => writeJSON(panesPath(root), panes);
