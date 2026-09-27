import { autonomyArgsFor } from '../../crew/adapters.js';
import { cliStatus } from './status.js';
import { runStream, summary, usageEvent } from './stream.js';

export function parseCodex(record, state) {
  const events = [];
  if (record.type === 'thread.started') {
    state.sessionId = record.thread_id || state.sessionId;
    events.push({ type: 'start', sessionId: state.sessionId, model: state.model });
  }
  if (record.type === 'item.completed') {
    const item = record.item || {};
    if (item.type === 'agent_message') events.push({ type: 'text', delta: item.text || '' });
    if (item.type === 'command_execution') {
      events.push({ type: 'tool', id: item.id, name: 'command', input: { command: item.command || '' } });
      events.push({
        type: 'tool_result', id: item.id, ok: item.status === 'completed' || item.exit_code === 0,
        summary: summary(item.aggregated_output || item.output || item.status),
      });
    }
    if (item.type === 'file_change') {
      events.push({ type: 'tool', id: item.id, name: 'file_change', input: item.changes || {} });
      events.push({ type: 'tool_result', id: item.id, ok: item.status !== 'failed', summary: summary(item.status || item.changes) });
    }
    if (item.type === 'mcp_tool_call') {
      events.push({ type: 'tool', id: item.id, name: item.tool || item.name, input: item.arguments || {} });
      if (item.status) events.push({ type: 'tool_result', id: item.id, ok: item.status !== 'failed', summary: summary(item.result || item.status) });
    }
  }
  if (record.type === 'turn.completed') {
    state.ok = true;
    events.push(usageEvent(record.usage || {}));
  }
  if (record.type === 'turn.failed' || record.type === 'error') {
    state.ok = false;
    state.error = summary(record.error?.message || record.message || record.error);
  }
  return events;
}

const status = cliStatus({
  bin: 'codex',
  args: ['login', 'status'],
  evaluate: (result) => result.code === 0 && /logged in/i.test(`${result.stdout}\n${result.stderr}`),
  installHint: 'npm install -g @openai/codex',
  loginHint: 'codex login',
});

export const loginCommand = ['codex', 'login'];

export const codex = {
  id: 'codex',
  label: 'Codex',
  kind: 'subscription',
  loginCommand,
  status,
  async run(options) {
    const prompt = options.system ? `${options.system}\n\n${options.prompt}` : options.prompt;
    const args = options.sessionId ? ['exec', 'resume'] : ['exec'];
    args.push(
      '--json',
      ...autonomyArgsFor('codex', { autonomy: options.autonomy }, true),
      '--skip-git-repo-check',
    );
    if (options.model) args.push('--model', options.model);
    if (options.sessionId) args.push(options.sessionId);
    args.push(prompt);
    return runStream({ ...options, provider: 'codex', command: 'codex', args, parser: parseCodex });
  },
};

export default codex;
