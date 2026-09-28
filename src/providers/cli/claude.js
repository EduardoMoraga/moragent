import { autonomyArgsFor } from '../../crew/adapters.js';
import { cliStatus, jsonOutput } from './status.js';
import { resultOk, runStream, summary, usageEvent } from './stream.js';
import { makeCliModelLister, suggestedModels } from './models.js';

export function parseClaude(record, state) {
  const events = [];
  if (record.type === 'system' && record.subtype === 'init') {
    state.sessionId = record.session_id || state.sessionId;
    state.model = record.model || state.model;
    events.push({ type: 'start', sessionId: state.sessionId, model: state.model });
  }
  if (record.type === 'assistant') {
    state.sessionId = record.session_id || state.sessionId;
    state.model = record.message?.model || state.model;
    for (const block of record.message?.content || []) {
      if (block.type === 'text') events.push({ type: 'text', delta: block.text || '' });
      if (block.type === 'tool_use') events.push({
        type: 'tool', id: block.id, name: block.name, input: block.input ?? {},
      });
    }
  }
  if (record.type === 'user') {
    for (const block of record.message?.content || []) {
      if (block.type === 'tool_result') events.push({
        type: 'tool_result', id: block.tool_use_id, ok: resultOk(block), summary: summary(block.content),
      });
    }
  }
  if (record.type === 'result') {
    state.sessionId = record.session_id || state.sessionId;
    state.finalText = typeof record.result === 'string' ? record.result : state.text;
    state.ok = !record.is_error && record.subtype !== 'error';
    state.error = record.error || (state.ok ? null : summary(record.result));
    const usage = usageEvent(record.usage || {}, record.total_cost_usd ?? null);
    if (usage.input !== null || usage.output !== null || usage.costUsd !== null) events.push(usage);
  }
  return events;
}

const status = cliStatus({
  bin: 'claude',
  args: ['auth', 'status'],
  evaluate: (result) => jsonOutput(result).loggedIn === true,
  installHint: 'npm install -g @anthropic-ai/claude-code',
  loginHint: 'claude auth login',
});

export const loginCommand = ['claude', 'auth', 'login'];

// Claude Code exposes aliases through --help, but no non-interactive model-list command.
export const listModels = makeCliModelLister({
  key: 'claude',
  fallback: suggestedModels(['opus', 'sonnet', 'haiku', 'fable']),
});

export const claude = {
  id: 'claude',
  label: 'Claude Code',
  kind: 'subscription',
  loginCommand,
  listModels,
  status,
  async run(options) {
    const args = [
      ...autonomyArgsFor('claude', { autonomy: options.autonomy }, true),
      '-p', options.prompt,
      '--output-format', 'stream-json',
      '--verbose',
    ];
    if (options.system) args.push('--append-system-prompt', options.system);
    if (options.model) args.push('--model', options.model);
    if (options.sessionId) args.push('--resume', options.sessionId);
    return runStream({ ...options, provider: 'claude', command: 'claude', args, parser: parseClaude });
  },
};

export default claude;
