import { createOpenAIAdapter } from './openai.js';
import { runApiLoop } from './loop.js';
import { getKey } from '../credentials.js';
import { t } from '../../core/i18n.js';
import { makeApiModelLister, suggestedApiModels } from './models.js';

export const openrouterAdapter = createOpenAIAdapter({
  id: 'openrouter',
  defaultModel: 'anthropic/claude-sonnet-5',
  defaultBaseUrl: 'https://openrouter.ai/api/v1',
  requiresKey: true,
  extraHeaders: {
    'HTTP-Referer': 'https://github.com/EduardoMoraga/moragent',
    'X-Title': 'MORAGENT',
  },
});

export const listModels = makeApiModelLister({
  key: 'openrouter',
  request: () => {
    const apiKey = getKey('openrouter');
    return apiKey ? {
      url: 'https://openrouter.ai/api/v1/models',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://github.com/EduardoMoraga/moragent',
        'X-Title': 'MORAGENT',
      },
    } : null;
  },
  parse: (json) => (json.data || []).map((model) => ({ id: model.id, label: model.name || model.id })),
  fallback: suggestedApiModels(['anthropic/claude-sonnet-5']),
});

export const openrouter = {
  id: 'openrouter',
  label: 'OpenRouter',
  kind: 'api',
  listModels,

  async status() {
    const key = getKey('openrouter');
    if (key) {
      return {
        ready: true,
        detail: t('API key configurada', 'API key configured'),
        loginHint: '',
      };
    }
    return {
      ready: false,
      detail: t('Falta API key', 'Missing API key'),
      loginHint: t('Exporta OPENROUTER_API_KEY o usa /login', 'Export OPENROUTER_API_KEY or use /login'),
    };
  },

  async run(opts = {}) {
    const key = getKey('openrouter');
    return runApiLoop({
      providerId: 'openrouter',
      adapter: openrouterAdapter,
      apiKey: key,
      ...opts,
    });
  },
};

export default openrouter;
