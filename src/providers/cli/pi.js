import { autonomyArgsFor } from '../../crew/adapters.js';
import { cliStatus, jsonOutput } from './status.js';
import { resultOk, runStream, summary, usageEvent } from './stream.js';

const textFrom = (message) => (message?.content || [])
  .filter((part) => part.type === 'text')
  .map((part) => part.text || '')
  .join('');

export function parsePi(record, state) {
  const events = [];
  if (record.type === 'session') {
    state.sessionId = record.id || state.sessionId;
    events.push({ type: 'start', sessionId: state.sessionId, model: state.model });
  }
  if (record.type === 'message_start' && record.message?.role === 'assistant') {
    state.model = record.message.model || state.model;
  }
  if (record.type === 'message_update') {
    const update = record.assistantMessageEvent || {};
    if (update.type === 'text_delta') events.push({ type: 'text', delta: update.delta || '' });
    if (update.type === 'toolcall_start' || update.type === 'tool_call_start') events.push({
      type: 'tool', id: update.toolCallId || update.id, name: update.toolName || update.name, input: update.args || update.input || {},
    });
  }
  if (record.type === 'tool_execution_start') events.push({
    type: 'tool', id: record.toolCallId || record.id, name: record.toolName || record.name, input: record.args || {},
  });
  if (record.type === 'tool_execution_end') events.push({
    type: 'tool_result', id: record.toolCallId || record.id, ok: resultOk(record),
    summary: summary(record.result || record.error),
  });
  if (record.type === 'message_end' && record.message?.role === 'assistant') {
    if (!state.text) {
      const text = textFrom(record.message);
      if (text) events.push({ type: 'text', delta: text });
    }
    if (record.message.usage) events.push(usageEvent(record.message.usage));
  }
  if (record.type === 'agent_end') {
    const assistant = [...(record.messages || [])].reverse().find((message) => message.role === 'assistant');
    state.finalText = textFrom(assistant) || state.text;
    state.ok = !record.error && !record.willRetry;
    state.error = record.error ? summary(record.error) : null;
  }
  return events;
}

const status = cliStatus({
  bin: 'pi',
  args: ['auth', 'check', '--provider', 'openai-codex', '--json', '--no-refresh'],
  evaluate: (result) => result.code === 0 && jsonOutput(result).status === 'ready',
  installHint: 'npm install -g @mariozechner/pi-coding-agent',
  loginHint: 'pi',
});

// Pi has no shell-level auth login command. Its documented `pi` command opens the TUI,
// where /login is available; passing `/login` as argv would send it as a model prompt.
export const loginCommand = ['pi'];

export const pi = {
  id: 'pi',
  label: 'Pi',
  kind: 'subscription',
  loginCommand,
  status,
  async run(options) {
    const args = [
      ...autonomyArgsFor('pi', { autonomy: options.autonomy }, true),
      '-p', '--mode', 'json', options.prompt,
    ];
    if (options.system) args.push('--append-system-prompt', options.system);
    if (options.model) args.push('--model', options.model);
    if (options.sessionId) args.push('--session', options.sessionId);
    return runStream({ ...options, provider: 'pi', command: 'pi', args, parser: parsePi });
  },
};

export default pi;
