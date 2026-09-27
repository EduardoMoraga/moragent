import { cliStatus } from './status.js';
import { runStream, summary, usageEvent } from './stream.js';

// OpenCode's --format json schema is not stable across releases; keep the mapping permissive.
export function parseOpenCode(record, state) {
  const events = [];
  const properties = record.properties || record.part || record;
  if (record.type === 'session' || record.type === 'session.created' || record.type === 'step_start') {
    state.sessionId = properties.sessionID || properties.session_id || properties.id || state.sessionId;
    if (!state.started && state.sessionId) events.push({ type: 'start', sessionId: state.sessionId, model: state.model });
  }
  if (record.type === 'text' || properties.type === 'text') {
    const delta = properties.delta || properties.text || properties.content;
    if (typeof delta === 'string') events.push({ type: 'text', delta });
  }
  if (record.type === 'tool' || properties.type === 'tool') {
    const id = properties.callID || properties.id;
    events.push({ type: 'tool', id, name: properties.tool || properties.name, input: properties.input || {} });
    if (properties.output || properties.error || properties.state?.status === 'completed') events.push({
      type: 'tool_result', id, ok: !properties.error, summary: summary(properties.output || properties.error || properties.state),
    });
  }
  if (record.type === 'step_finish' || record.type === 'result') {
    state.ok = !record.error;
    state.error = record.error ? summary(record.error) : null;
    if (properties.usage || properties.tokens || properties.cost) events.push(usageEvent(properties.usage || properties.tokens || {}, properties.cost));
  }
  if (record.type === 'error') {
    state.ok = false;
    state.error = summary(properties.message || properties.error || record);
  }
  return events;
}

const status = cliStatus({
  bin: 'opencode',
  installHint: 'npm install -g opencode-ai',
  loginHint: 'opencode auth login',
});

export const opencode = {
  id: 'opencode',
  label: 'OpenCode',
  kind: 'subscription',
  status,
  async run(options) {
    const prompt = options.system ? `${options.system}\n\n${options.prompt}` : options.prompt;
    const args = ['run', '--format', 'json'];
    if (options.model) args.push('--model', options.model);
    if (options.sessionId) args.push('--session', options.sessionId);
    args.push(prompt);
    return runStream({ ...options, provider: 'opencode', command: 'opencode', args, parser: parseOpenCode });
  },
};

export default opencode;

