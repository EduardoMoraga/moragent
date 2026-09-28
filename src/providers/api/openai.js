import { getOpenAITools } from './tools.js';
import { runApiLoop } from './loop.js';
import { getKey } from '../credentials.js';
import { t } from '../../core/i18n.js';
import { makeApiModelLister, suggestedApiModels } from './models.js';

export function createOpenAIAdapter({
  id = 'openai',
  defaultModel = 'gpt-4o',
  defaultBaseUrl = 'https://api.openai.com/v1',
  requiresKey = true,
  extraHeaders = {},
} = {}) {
  return {
    id,
    defaultModel,
    requiresKey,

    initConversation({ prompt, system }) {
      const messages = [];
      if (system) {
        messages.push({ role: 'system', content: system });
      }
      messages.push({ role: 'user', content: prompt });
      return { messages, system };
    },

    buildRequest({ state, model, apiKey, baseUrl, autonomy }) {
      const base = baseUrl || defaultBaseUrl;
      const cleanBase = base.replace(/\/+$/, '');
      const url = cleanBase.endsWith('/chat/completions')
        ? cleanBase
        : `${cleanBase}/chat/completions`;

      const headers = {
        'content-type': 'application/json',
        ...extraHeaders,
      };
      if (apiKey) {
        headers.authorization = `Bearer ${apiKey}`;
      }

      const body = {
        model,
        messages: state.messages,
        tools: getOpenAITools({ autonomy }),
      };

      return {
        url,
        headers,
        body,
      };
    },

    parseResponse(json) {
      const choice = json.choices?.[0];
      const message = choice?.message || {};
      const text = message.content || '';

      const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      const toolCalls = rawCalls.map((tc) => {
        let args = {};
        try {
          args = typeof tc.function?.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : (tc.function?.arguments || {});
        } catch {
          args = {};
        }
        return {
          id: tc.id,
          name: tc.function?.name,
          args,
        };
      });

      const usage = json.usage
        ? {
            input: json.usage.prompt_tokens ?? null,
            output: json.usage.completion_tokens ?? null,
            costUsd: null,
          }
        : null;

      return {
        text,
        toolCalls,
        usage,
        rawAssistantMessage: message,
      };
    },

    appendAssistant({ state, rawMessage }) {
      state.messages.push(rawMessage);
    },

    appendToolResult({ state, callId, result }) {
      state.messages.push({
        role: 'tool',
        tool_call_id: callId,
        content: result.output,
      });
    },
  };
}

export const openaiAdapter = createOpenAIAdapter({
  id: 'openai',
  defaultModel: 'gpt-4o',
  defaultBaseUrl: 'https://api.openai.com/v1',
  requiresKey: true,
});

export const listModels = makeApiModelLister({
  key: 'openai',
  request: () => {
    const apiKey = getKey('openai');
    return apiKey ? {
      url: 'https://api.openai.com/v1/models',
      headers: { authorization: `Bearer ${apiKey}` },
    } : null;
  },
  parse: (json) => (json.data || []).map((model) => ({ id: model.id, label: model.id })),
  fallback: suggestedApiModels(['gpt-4o']),
});

export const openai = {
  id: 'openai',
  label: 'OpenAI (GPT API)',
  kind: 'api',
  listModels,

  async status() {
    const key = getKey('openai');
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
      loginHint: t('Exporta OPENAI_API_KEY o usa /login', 'Export OPENAI_API_KEY or use /login'),
    };
  },

  async run(opts = {}) {
    const key = getKey('openai');
    return runApiLoop({
      providerId: 'openai',
      adapter: openaiAdapter,
      apiKey: key,
      ...opts,
    });
  },
};

export default openai;
