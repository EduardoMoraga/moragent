import { createOpenAIAdapter } from './openai.js';
import { runApiLoop, getFetch } from './loop.js';
import { getKey } from '../credentials.js';
import { t } from '../../core/i18n.js';

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

export const ollama = {
  id: 'ollama',
  label: 'Ollama (Local)',
  kind: 'api',

  async status() {
    const rawHost = getOllamaHost();
    const host = rawHost.replace(/\/v1$/, '');
    try {
      const fetchFn = getFetch();
      let signal;
      if (typeof AbortSignal?.timeout === 'function') {
        signal = AbortSignal.timeout(1500);
      } else {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 1500);
        signal = controller.signal;
      }

      const res = await fetchFn(`${host}/api/tags`, { method: 'GET', signal });
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
    });
  },
};

export default ollama;
