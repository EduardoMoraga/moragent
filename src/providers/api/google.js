import { getGeminiTools } from './tools.js';
import { runApiLoop } from './loop.js';
import { getKey } from '../credentials.js';
import { t } from '../../core/i18n.js';
import { makeApiModelLister, suggestedApiModels } from './models.js';

export const googleAdapter = {
  id: 'google',
  defaultModel: 'gemini-2.0-flash',
  requiresKey: true,

  initConversation({ prompt, system }) {
    return {
      system,
      callSeq: 0,
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ],
    };
  },

  buildRequest({ state, model, system, apiKey, baseUrl, autonomy }) {
    const sys = system || state.system;
    const base = baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
    const cleanBase = base.replace(/\/+$/, '');
    const url = `${cleanBase}/models/${model}:generateContent?key=${encodeURIComponent(apiKey || '')}`;

    const body = {
      contents: state.contents,
      tools: getGeminiTools({ autonomy }),
    };

    if (sys) {
      body.systemInstruction = {
        parts: [{ text: sys }],
      };
    }

    return {
      url,
      headers: {
        'content-type': 'application/json',
      },
      body,
    };
  },

  parseResponse(json) {
    const candidate = json.candidates?.[0]?.content;
    const parts = Array.isArray(candidate?.parts) ? candidate.parts : [];

    const textParts = parts.filter((p) => p.text).map((p) => p.text);
    const text = textParts.join('\n');

    let seq = 0;
    const toolCalls = parts
      .filter((p) => p.functionCall)
      .map((p) => {
        seq++;
        return {
          id: p.functionCall.id || `call_gemini_${Date.now()}_${seq}`,
          name: p.functionCall.name,
          args: p.functionCall.args || {},
        };
      });

    const usage = json.usageMetadata
      ? {
          input: json.usageMetadata.promptTokenCount ?? null,
          output: json.usageMetadata.candidatesTokenCount ?? null,
          costUsd: null,
        }
      : null;

    return {
      text,
      toolCalls,
      usage,
      rawAssistantMessage: candidate || { role: 'model', parts },
    };
  },

  appendAssistant({ state, rawMessage }) {
    state.contents.push(rawMessage);
  },

  appendToolResult({ state, callId, toolName, result }) {
    const responsePart = {
      functionResponse: {
        name: toolName,
        response: {
          name: toolName,
          output: result.output,
          ok: result.ok,
        },
      },
    };

    const last = state.contents[state.contents.length - 1];
    if (last && last.role === 'user' && Array.isArray(last.parts) && last.parts[0]?.functionResponse) {
      last.parts.push(responsePart);
    } else {
      state.contents.push({
        role: 'user',
        parts: [responsePart],
      });
    }
  },
};

export const listModels = makeApiModelLister({
  key: 'google',
  request: () => {
    const apiKey = getKey('google');
    return apiKey ? {
      url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
    } : null;
  },
  parse: (json) => (json.models || [])
    .filter((model) => !model.supportedGenerationMethods
      || model.supportedGenerationMethods.includes('generateContent'))
    .map((model) => ({
      id: String(model.name || '').replace(/^models\//, ''),
      label: model.displayName || String(model.name || '').replace(/^models\//, ''),
    })),
  fallback: suggestedApiModels(['gemini-2.0-flash']),
});

export const google = {
  id: 'google',
  label: 'Google (Gemini API)',
  kind: 'api',
  listModels,

  async status() {
    const key = getKey('google');
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
      loginHint: t('Exporta GEMINI_API_KEY o GOOGLE_API_KEY o usa /login', 'Export GEMINI_API_KEY or GOOGLE_API_KEY or use /login'),
    };
  },

  async run(opts = {}) {
    const key = getKey('google');
    return runApiLoop({
      providerId: 'google',
      adapter: googleAdapter,
      apiKey: key,
      ...opts,
    });
  },
};

export default google;
