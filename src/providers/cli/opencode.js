import { cliStatus } from './status.js';
import { resultOk, runStream, summary, usageEvent } from './stream.js';
import { makeCliModelLister, parseIdModels, suggestedModels } from './models.js';

function providerError(value) {
  if (typeof value === 'string') return summary(value);
  const detail = value?.data || value?.error?.data || {};
  const message = detail.message || value?.message || value?.error?.message
    || (typeof value?.error === 'string' ? value.error : null) || value?.name || 'OpenCode provider error';
  const code = Number(detail.statusCode ?? value?.statusCode);
  return `${Number.isInteger(code) && code >= 400 && code <= 599 ? `HTTP ${code}: ` : ''}${summary(message)}`;
}

// The current --format json shape was verified live on OpenCode 1.18.30.
// Keep alternate field names for older releases, but require a final stop marker.
export function parseOpenCode(record, state) {
  const events = [];
  const properties = record.properties || record.part || record;
  state.requireCompletion = true;
  if (record.type === 'session' || record.type === 'session.created' || record.type === 'step_start') {
    state.sessionId = record.sessionID || record.session_id || properties.sessionID || properties.session_id || state.sessionId;
    if (!state.started && state.sessionId) events.push({ type: 'start', sessionId: state.sessionId, model: state.model });
  }
  if (record.type === 'text' || properties.type === 'text') {
    const delta = properties.delta ?? properties.text ?? properties.content;
    if (typeof delta === 'string') {
      const messageID = properties.messageID || record.messageID;
      const newMessage = messageID && state.openCodeTextMessageID && messageID !== state.openCodeTextMessageID && state.text;
      const separator = !newMessage || delta.startsWith('\n') || state.text.endsWith('\n\n') ? ''
        : state.text.endsWith('\n') ? '\n' : '\n\n';
      if (messageID) state.openCodeTextMessageID = messageID;
      events.push({ type: 'text', delta: `${separator}${delta}` });
    }
  }
  if (record.type === 'tool' || properties.type === 'tool') {
    const id = properties.callID || properties.id;
    const toolState = properties.state || {};
    const status = String(toolState.status || properties.status || '').toLowerCase();
    events.push({ type: 'tool', id, name: properties.tool || properties.name, input: properties.input || toolState.input || {} });
    if (properties.output !== undefined || properties.error || ['completed', 'failed', 'error', 'cancelled', 'canceled'].includes(status)) events.push({
      type: 'tool_result', id, ok: resultOk(toolState, !properties.error),
      summary: summary(properties.output ?? toolState.output ?? properties.error ?? toolState.error ?? toolState),
    });
  }
  if (record.type === 'step_finish' || record.type === 'result') {
    if (record.error || properties.error) {
      state.ok = false;
      state.error = providerError(record.error || properties.error);
    } else if (!state.error) {
      // A step may end because the model requested tools or hit a limit. Only
      // a final stop (or an explicit successful result) confirms the turn.
      const reason = String(properties.reason || record.reason || '').toLowerCase();
      const status = String(properties.status || record.status || '').toLowerCase();
      if (['stop', 'end_turn', 'end-turn'].includes(reason)
          || (record.type === 'result' && (properties.ok === true || properties.success === true || ['success', 'completed'].includes(status)))) {
        state.ok = true;
      }
    }
    if (properties.usage || properties.tokens || properties.cost) events.push(usageEvent(properties.usage || properties.tokens || {}, properties.cost));
  }
  if (record.type === 'error') {
    state.ok = false;
    state.error = providerError(properties.error || properties.message || record);
  }
  return events;
}

const status = cliStatus({
  bin: 'opencode',
  installHint: 'npm install -g opencode-ai',
  loginHint: 'opencode auth login',
});

export const loginCommand = ['opencode', 'auth', 'login'];

export const listModels = makeCliModelLister({
  key: 'opencode', command: 'opencode', args: ['models'], parse: parseIdModels,
  fallback: suggestedModels(['anthropic/claude-sonnet-5', 'openai/gpt-4o']),
});

const READONLY_PERMISSION = JSON.stringify({
  '*': 'deny',
  read: { '*': 'allow', '*.env': 'deny', '*.env.*': 'deny', '*.env.example': 'allow' },
  glob: 'allow',
  grep: 'allow',
  lsp: 'allow',
  edit: 'deny',
  bash: 'deny',
  external_directory: 'deny',
});

export const opencode = {
  id: 'opencode',
  label: 'OpenCode',
  kind: 'subscription',
  loginCommand,
  listModels,
  status,
  async run(options) {
    const prompt = options.system ? `${options.system}\n\n${options.prompt}` : options.prompt;
    const args = ['run', '--format', 'json'];
    if (options.root) args.push('--dir', options.root);
    if (options.model) args.push('--model', options.model);
    if (options.sessionId) args.push('--session', options.sessionId);
    args.push(prompt);
    const readonly = options.autonomy === 'readonly' || options.autonomy === 'ask';
    return runStream({ ...options, provider: 'opencode', command: 'opencode', args, parser: parseOpenCode,
      ...(readonly ? { envOverrides: { OPENCODE_PERMISSION: READONLY_PERMISSION } } : {}) });
  },
};

export default opencode;
