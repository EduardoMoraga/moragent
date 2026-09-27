import { getAnthropicTools } from './tools.js';
import { runApiLoop } from './loop.js';
import { getKey } from '../credentials.js';
import { t } from '../../core/i18n.js';

export const anthropicAdapter = {
  id: 'anthropic',
  defaultModel: 'claude-sonnet-5',
  requiresKey: true,

  initConversation({ prompt, system }) {
    return {
      system,
      messages: [{ role: 'user', content: prompt }],
    };
  },

  buildRequest({ state, model, system, apiKey, baseUrl, autonomy }) {
    const sys = system || state.system;
    const body = {
      model,
      max_tokens: 4096,
      messages: state.messages,
      tools: getAnthropicTools({ autonomy }),
    };
    if (sys) {
      body.system = sys;
    }
    const url = baseUrl || 'https://api.anthropic.com/v1/messages';
    return {
      url,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body,
    };
  },

  parseResponse(json) {
    const content = Array.isArray(json.content) ? json.content : [];
    const textBlocks = content.filter((b) => b.type === 'text').map((b) => b.text || '');
    const text = textBlocks.join('\n');

    const toolCalls = content
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({
        id: b.id,
        name: b.name,
        args: b.input || {},
      }));

    const usage = json.usage
      ? {
          input: json.usage.input_tokens ?? null,
          output: json.usage.output_tokens ?? null,
          costUsd: null,
        }
      : null;

    return {
      text,
      toolCalls,
      usage,
      rawAssistantMessage: content,
    };
  },

  appendAssistant({ state, rawMessage }) {
    state.messages.push({
      role: 'assistant',
      content: rawMessage,
    });
  },

  appendToolResult({ state, callId, result }) {
    const block = {
      type: 'tool_result',
      tool_use_id: callId,
      content: result.output,
      is_error: !result.ok,
    };

    const lastMsg = state.messages[state.messages.length - 1];
    if (lastMsg && lastMsg.role === 'user' && Array.isArray(lastMsg.content) && lastMsg.content[0]?.type === 'tool_result') {
      lastMsg.content.push(block);
    } else {
      state.messages.push({
        role: 'user',
        content: [block],
      });
    }
  },
};

export const anthropic = {
  id: 'anthropic',
  label: 'Anthropic (Claude API)',
  kind: 'api',

  async status() {
    const key = getKey('anthropic');
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
      loginHint: t('Exporta ANTHROPIC_API_KEY o usa /login', 'Export ANTHROPIC_API_KEY or use /login'),
    };
  },

  async run(opts = {}) {
    const key = getKey('anthropic');
    return runApiLoop({
      providerId: 'anthropic',
      adapter: anthropicAdapter,
      apiKey: key,
      ...opts,
    });
  },
};

export default anthropic;
