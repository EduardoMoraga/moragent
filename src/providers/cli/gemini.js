import { autonomyArgsFor } from '../../crew/adapters.js';
import { cliStatus } from './status.js';
import { runStream, summary, usageEvent } from './stream.js';

// Gemini was not installed on the v5 probe machine. This parser and its resume flags are
// deliberately best-effort, based on the public stream-json shape used by Gemini CLI.
export function parseGemini(record, state) {
  const events = [];
  if (record.type === 'init') {
    state.sessionId = record.session_id || record.sessionId || state.sessionId;
    state.model = record.model || state.model;
    events.push({ type: 'start', sessionId: state.sessionId, model: state.model });
  }
  if ((record.type === 'message' || record.type === 'assistant') && (record.role || 'assistant') === 'assistant') {
    const delta = record.delta || record.content || record.text;
    if (typeof delta === 'string') events.push({ type: 'text', delta });
  }
  if (record.type === 'tool_use' || record.type === 'tool_call') events.push({
    type: 'tool', id: record.tool_id || record.id, name: record.tool_name || record.name,
    input: record.parameters || record.input || {},
  });
  if (record.type === 'tool_result') events.push({
    type: 'tool_result', id: record.tool_id || record.id, ok: !record.error,
    summary: summary(record.output || record.result || record.error),
  });
  if (record.type === 'result') {
    state.finalText = record.response || record.result || state.text;
    state.ok = record.status ? /success|ok/i.test(record.status) : !record.error;
    state.error = record.error ? summary(record.error) : null;
    if (record.usage || record.stats) events.push(usageEvent(record.usage || record.stats));
  }
  return events;
}

const status = cliStatus({
  bin: 'gemini',
  installHint: 'npm install -g @google/gemini-cli',
  loginHint: 'gemini',
});

// Gemini was absent on the probe machine; launching its TUI is the documented auth entrypoint.
export const loginCommand = ['gemini'];

export const gemini = {
  id: 'gemini',
  label: 'Gemini CLI',
  kind: 'subscription',
  loginCommand,
  status,
  async run(options) {
    const args = [
      ...autonomyArgsFor('gemini', { autonomy: options.autonomy }, true),
      '-p', options.prompt,
      '--output-format', 'stream-json',
    ];
    if (options.system) args.push('--append-system-prompt', options.system);
    if (options.model) args.push('--model', options.model);
    if (options.sessionId) args.push('--resume', options.sessionId);
    return runStream({ ...options, provider: 'gemini', command: 'gemini', args, parser: parseGemini });
  },
};

export default gemini;
