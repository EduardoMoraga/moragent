import { autonomyArgsFor } from '../../crew/adapters.js';
import { cliStatus } from './status.js';
import { runStream, summary, usageEvent } from './stream.js';

export function parseAgy(record, state) {
  const events = [];
  if (record.event === 'init') {
    state.sessionId = record.conversation_id || record.init?.conversation_id || state.sessionId;
    state.model = record.model || record.init?.model || state.model;
    events.push({ type: 'start', sessionId: state.sessionId, model: state.model });
  }
  if (record.event === 'step_update') {
    const update = record.step_update || {};
    if (update.step_type === 'agent_response' && update.text_delta) {
      events.push({ type: 'text', delta: update.text_delta });
    }
    if (update.step_type === 'tool_call' && update.state === 'ACTIVE') events.push({
      type: 'tool', id: update.step_id || String(update.step_index),
      name: update.tool_name || update.name || 'tool', input: update.input || {},
    });
    if (update.step_type === 'tool_call' && update.state === 'DONE') events.push({
      type: 'tool_result', id: update.step_id || String(update.step_index),
      ok: !update.error, summary: summary(update.output || update.error || update.state),
    });
  }
  if (record.event === 'result') {
    const result = record.result || {};
    state.sessionId = result.conversation_id || state.sessionId;
    state.finalText = result.response ?? state.text;
    state.ok = result.status === 'SUCCESS';
    state.error = state.ok ? null : summary(result.error || result.status);
    if (result.usage) events.push(usageEvent(result.usage));
  }
  return events;
}

const status = cliStatus({
  bin: 'agy',
  installHint: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
  loginHint: 'agy',
});

export const agy = {
  id: 'agy',
  label: 'Antigravity',
  kind: 'subscription',
  status,
  async run(options) {
    const prompt = options.system ? `${options.system}\n\n${options.prompt}` : options.prompt;
    const args = [
      ...autonomyArgsFor('agy', { autonomy: options.autonomy }, true),
      '-p', prompt,
      '--output-format', 'stream-json',
    ];
    if (options.model) args.push('--model', options.model);
    if (options.sessionId) args.push('--conversation', options.sessionId);
    return runStream({ ...options, provider: 'agy', command: 'agy', args, parser: parseAgy });
  },
};

export default agy;

