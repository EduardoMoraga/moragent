import { getFetch } from './loop.js';

const cache = new Map();

export const suggestedApiModels = (models) => models.map((model) => ({
  id: typeof model === 'string' ? model : model.id,
  label: typeof model === 'string' ? model : (model.label || model.id),
  note: 'sugerido',
}));

const normalize = (models) => {
  const seen = new Set();
  return (models || []).flatMap((model) => {
    const id = String(model?.id || '').trim();
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{ id, label: String(model.label || id).trim(), ...(model.note ? { note: model.note } : {}) }];
  });
};

async function withinTimeout(operation) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Model catalog timeout'));
    }, 3000);
    timer.unref?.();
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function makeApiModelLister({ key, request, parse, fallback }) {
  return async function listModels() {
    if (cache.has(key)) return (await cache.get(key)).map((model) => ({ ...model }));
    const pending = Promise.resolve().then(async () => {
      try {
        const spec = request();
        if (spec?.url) {
          const models = await withinTimeout(async (signal) => {
            const response = await getFetch()(spec.url, {
              method: 'GET', headers: spec.headers || {}, signal,
            });
            if (!response?.ok) return [];
            return normalize(parse(await response.json()));
          });
          if (models.length) return models;
        }
      } catch { /* network, auth and parsing failures use stable suggestions */ }
      try { return normalize(typeof fallback === 'function' ? fallback() : fallback); } catch { return []; }
    });
    cache.set(key, pending);
    return (await pending).map((model) => ({ ...model }));
  };
}

export const resetApiModelCache = () => cache.clear();
