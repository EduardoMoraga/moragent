import { createOpenAIAdapter } from './openai.js';
import { runApiLoop, getFetch } from './loop.js';
import { getKey } from '../credentials.js';
import { t } from '../../core/i18n.js';
import { makeApiModelLister, withinTimeout } from './models.js';

function normalizeOllamaBase(url) {
  if (!url) return 'http://localhost:11434/v1';
  const clean = url.replace(/\/+$/, '');
  if (clean.endsWith('/v1')) return clean;
  return `${clean}/v1`;
}

function getOllamaHost() {
  const host = process.env.OLLAMA_HOST || getKey('ollama') || 'http://localhost:11434';
  return host.replace(/\/+$/, '');
}

function getOllamaBaseUrl() {
  return normalizeOllamaBase(getOllamaHost());
}

export const ollamaAdapter = createOpenAIAdapter({
  id: 'ollama',
  defaultModel: 'llama3',
  defaultBaseUrl: getOllamaBaseUrl(),
  requiresKey: false,
});

const ollamaHostFromBase = (baseUrl) => normalizeOllamaBase(baseUrl).replace(/\/v1$/, '');
const ollamaCatalog = (host) => makeApiModelLister({
  key: `ollama:${host}`,
  request: () => ({ url: `${host}/api/tags` }),
  parse: (json) => (json.models || [])
    .filter((model) => !Array.isArray(model.capabilities)
      || (model.capabilities.includes('completion') && model.capabilities.includes('tools')))
    .map((model) => ({ id: model.name || model.model, label: model.name || model.model })),
  fallback: [],
});

export const listModels = () => ollamaCatalog(getOllamaHost().replace(/\/v1$/, ''))();

export const ollama = {
  id: 'ollama',
  label: 'Ollama (Local)',
  kind: 'api',
  listModels,

  async status({ timeoutMs = 1500 } = {}) {
    const rawHost = getOllamaHost();
    const host = rawHost.replace(/\/v1$/, '');
    try {
      const res = await withinTimeout((signal) => getFetch()(`${host}/api/tags`, {
        method: 'GET', signal,
      }), timeoutMs);
      if (res && res.ok) {
        return {
          ready: true,
          detail: t('Ollama conectado', 'Ollama connected'),
          loginHint: '',
        };
      }
    } catch {
      // Fast fallback on network error or timeout
    }

    return {
      ready: false,
      detail: t('Ollama no responde', 'Ollama not responding'),
      loginHint: t('Inicia Ollama (ollama serve)', 'Start Ollama (ollama serve)'),
    };
  },

  async run(opts = {}) {
    const { baseUrl: rawBaseUrl, ...restOpts } = opts;
    const baseUrl = normalizeOllamaBase(rawBaseUrl || getOllamaBaseUrl());
    const key = getKey('ollama') || '';
    const model = restOpts.model || process.env.MORAGENT_OLLAMA_MODEL
      || (await ollamaCatalog(ollamaHostFromBase(baseUrl))())[0]?.id;
    if (!model) return { ok: false, text: '', error: t(
      'Ollama no informó modelos instalados capaces de usar herramientas. Instala uno o selecciónalo con /modelo.',
      'Ollama reported no installed tool-capable models. Install one or select it with /model.',
    ) };
    return runApiLoop({
      providerId: 'ollama',
      adapter: {
        ...ollamaAdapter,
        buildRequest(params) {
          return ollamaAdapter.buildRequest({
            ...params,
            baseUrl: normalizeOllamaBase(params.baseUrl || baseUrl),
          });
        },
      },
      apiKey: key,
      baseUrl,
      ...restOpts,
      model,
    });
  },
};

export default ollama;
