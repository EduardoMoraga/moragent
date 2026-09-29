import { autonomyArgsFor } from '../../crew/adapters.js';
import { cliStatus } from './status.js';
import { resultOk, runStream, summary, usageEvent } from './stream.js';
import { codexSuggestions, makeCliModelLister } from './models.js';

const textFromItem = (item) => {
  if (item.type === 'agent_message') return item.text || '';
  if (item.type !== 'reasoning') return '';
  if (typeof item.text === 'string') return item.text;
  if (Array.isArray(item.summary)) return item.summary.map((part) => part?.text || part || '').join('');
  return '';
};

export function parseCodex(record, state) {
  // Codex emits reasoning/progress as text too, but only an agent_message in a
  // completed turn is an authoritative answer.
  state.requireFinalText = true;
  state.requireCompletion = true;
  const events = [];
  if (record.type === 'thread.started') {
    state.sessionId = record.thread_id || state.sessionId;
    events.push({ type: 'start', sessionId: state.sessionId, model: state.model });
  }
  if (record.type === 'item.completed') {
    const item = record.item || {};
    // Codex also reports the input as a user_message item. It can contain the full task envelope,
    // but it is not assistant output and must never be rendered in the agent activity stream.
    const text = textFromItem(item);
    if (text) {
      if (item.type === 'agent_message') state.finalText = text;
      events.push({ type: 'text', delta: state.text ? `\n\n${text}` : text });
    }
    if (item.type === 'command_execution') {
      events.push({ type: 'tool', id: item.id, name: 'command', input: { command: item.command || '' } });
      events.push({
        type: 'tool_result', id: item.id, ok: resultOk(item),
        summary: summary(item.aggregated_output || item.output || item.status),
      });
    }
    if (item.type === 'file_change') {
      events.push({ type: 'tool', id: item.id, name: 'file_change', input: item.changes || {} });
      events.push({ type: 'tool_result', id: item.id, ok: resultOk(item), summary: summary(item.status || item.changes) });
    }
    if (item.type === 'mcp_tool_call') {
      events.push({ type: 'tool', id: item.id, name: item.tool || item.name, input: item.arguments || {} });
      if (item.status) events.push({ type: 'tool_result', id: item.id, ok: resultOk(item), summary: summary(item.result || item.status) });
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

// Codex has no model-list subcommand; use its configured model plus the id documented by --help.
export const listModels = makeCliModelLister({ key: 'codex', fallback: codexSuggestions });

export const codex = {
  id: 'codex',
  label: 'Codex',
  kind: 'subscription',
  loginCommand,
  listModels,
  status,
  async run(options) {
    const prompt = options.system ? `${options.system}\n\n${options.prompt}` : options.prompt;
    // `codex exec resume` rejects -s/--sandbox: every exec-level option goes before the subcommand
    // (verified live with codex-cli 0.154: `codex exec -s read-only --json … resume <id> <prompt>`).
    const args = [
      'exec', '--json',
      ...autonomyArgsFor('codex', { autonomy: options.autonomy }, true),
      '--skip-git-repo-check',
    ];
    if (options.model) args.push('--model', options.model);
    if (options.sessionId) args.push('resume', options.sessionId);
    args.push(prompt);
    return runStream({ ...options, provider: 'codex', command: 'codex', args, parser: parseCodex });
  },
};

export default codex;
