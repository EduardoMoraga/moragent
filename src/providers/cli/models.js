import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../../core/exec.js';

const cache = new Map();
const ANSI = /\x1B\[[0-?]*[ -/]*[@-~]/g;

const clean = (value) => String(value || '').replace(ANSI, '').trim();

export const suggestedModels = (models) => models.map((model) => ({
  id: typeof model === 'string' ? model : model.id,
  label: typeof model === 'string' ? model : (model.label || model.id),
  note: 'sugerido',
}));

export const normalizeModels = (models) => {
  const seen = new Set();
  const result = [];
  for (const model of models || []) {
    const id = clean(model?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, label: clean(model.label) || id, ...(model.note ? { note: model.note } : {}) });
  }
  return result;
};

export const parseTabModels = (output) => normalizeModels(clean(output).split(/\r?\n/).filter((line) => line.includes('\t')).map((line) => {
  const [id, ...label] = line.split('\t');
  return { id, label: label.join(' ').trim() || id };
}));

export const parsePiModels = (output) => normalizeModels(clean(output).split(/\r?\n/).map((line) => {
  const [provider, model] = line.trim().split(/\s{2,}/);
  if (!provider || !model || provider === 'provider') return null;
  return { id: `${provider}/${model}`, label: `${model} (${provider})` };
}));

export const parseIdModels = (output) => normalizeModels(clean(output).split(/\r?\n/).map((line) => {
  const id = line.trim();
  return id && !/\s/.test(id) && id.includes('/') ? { id, label: id } : null;
}));

export function codexSuggestions() {
  const ids = [];
  try {
    const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    const configured = /^\s*model\s*=\s*["']([^"']+)["']/m.exec(config)?.[1];
    if (configured) ids.push(configured);
  } catch { /* a missing or unreadable config simply removes this suggestion */ }
  ids.push('o3'); // `codex --help` uses o3 as its only concrete model-id example.
  return suggestedModels([...new Set(ids)]);
}

export function makeCliModelLister({ key, command, args = [], parse, fallback }) {
  return async function listModels() {
    if (cache.has(key)) return (await cache.get(key)).map((model) => ({ ...model }));
    const pending = Promise.resolve().then(() => {
      try {
        if (command) {
          const result = run(command, args, { timeoutMs: 3000 });
          if (result?.code === 0) {
            const models = normalizeModels(parse?.(result.stdout || '') || []);
            if (models.length) return models;
          }
        }
      } catch { /* fall through to stable suggestions */ }
      try { return normalizeModels(typeof fallback === 'function' ? fallback() : fallback); } catch { return []; }
    });
    cache.set(key, pending);
    return (await pending).map((model) => ({ ...model }));
  };
}

export const resetCliModelCache = () => cache.clear();
