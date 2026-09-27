import { which, shq } from '../core/exec.js';
import { MoragentError } from '../core/errors.js';
import { t } from '../core/i18n.js';

const CLAUDE_TOOLS = [
  'Bash(mora:*)',
  'Bash(npm test:*)',
  'Bash(node:*)',
  'Bash(git status:*)',
  'Bash(git diff:*)',
];

const MODES = {
  claude: {
    auto: ['--permission-mode', 'acceptEdits', '--allowedTools', ...CLAUDE_TOOLS],
    full: ['--dangerously-skip-permissions'],
    ask: [],
  },
  codex: {
    auto: ['-s', 'workspace-write', '-a', 'never'],
    full: ['--dangerously-bypass-approvals-and-sandbox'],
    ask: [],
  },
  agy: {
    // accept-edits still prompts for every shell command (even `mora done`), which stalls a pane.
    // The sandbox confines writes to the workspace, so skipping prompts inside it is the safe default.
    auto: ['--sandbox', '--dangerously-skip-permissions'],
    full: ['--dangerously-skip-permissions'],
    ask: [],
  },
  gemini: {
    auto: ['--approval-mode', 'auto_edit'],
    full: ['--yolo'],
    ask: [],
  },
};

const extras = ({ args, model, member } = {}) => ({
  args: Array.isArray(args) ? args : Array.isArray(member?.args) ? member.args : [],
  model: model || member?.model || null,
});

export function autonomyFor({ autonomy, member, headless = false } = {}) {
  const wanted = autonomy || member?.autonomy || 'auto';
  if (!['auto', 'full', 'ask'].includes(wanted)) throw new MoragentError(
    'BAD_AUTONOMY',
    t(`Autonomía desconocida: ${wanted}`, `Unknown autonomy: ${wanted}`),
    'auto | full | ask',
  );
  return headless && wanted === 'ask' ? 'auto' : wanted;
}

const modeArgs = (id, options, headless = false) => {
  const mode = autonomyFor({ ...options, headless });
  if (headless && id === 'codex' && mode === 'auto') return ['-s', 'workspace-write'];
  return MODES[id]?.[mode] || [];
};

function adapter(def) {
  return {
    ...def,
    installed: () => !!which(def.bin),
    interactive(options = {}) {
      const extra = extras(options);
      const args = [...modeArgs(def.id, options)];
      if (extra.model) args.push('--model', extra.model);
      args.push(...extra.args);
      return [def.bin, ...args].map(shq).join(' ');
    },
    headless(options = {}) {
      const extra = extras(options);
      const args = [
        ...(def.subcommand ? [def.subcommand] : []),
        ...modeArgs(def.id, options, true),
        ...(extra.model ? ['--model', extra.model] : []),
        ...extra.args,
        ...(def.printFlag ? [def.printFlag] : []),
        options.prompt || '',
      ];
      return [def.bin, ...args];
    },
  };
}

export const ADAPTERS = {
  claude: adapter({
    id: 'claude', label: 'Claude Code', bin: 'claude', printFlag: '-p',
    instructionFiles: ['CLAUDE.md'], skillsDirs: ['.claude/skills'],
    docs: 'https://docs.anthropic.com/en/docs/claude-code',
    install: 'npm install -g @anthropic-ai/claude-code',
  }),
  codex: adapter({
    id: 'codex', label: 'Codex', bin: 'codex', subcommand: 'exec',
    instructionFiles: ['AGENTS.md'], skillsDirs: ['.agents/skills'],
    docs: 'https://developers.openai.com/codex/cli',
    install: 'npm install -g @openai/codex',
  }),
  agy: adapter({
    id: 'agy', label: 'Antigravity', bin: 'agy', printFlag: '-p',
    instructionFiles: ['GEMINI.md', 'AGENTS.md'], skillsDirs: ['.agents/skills'],
    docs: 'https://antigravity.google/docs',
    install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
  }),
  pi: adapter({
    id: 'pi', label: 'Pi', bin: 'pi', printFlag: '-p',
    instructionFiles: ['AGENTS.md'], skillsDirs: ['.agents/skills', '.pi/skills'],
    docs: 'https://github.com/badlogic/pi-mono',
    install: 'npm install -g @mariozechner/pi-coding-agent',
  }),
  opencode: adapter({
    id: 'opencode', label: 'OpenCode', bin: 'opencode', subcommand: 'run',
    instructionFiles: ['AGENTS.md'], skillsDirs: ['.agents/skills', '.opencode/skill'],
    docs: 'https://opencode.ai/docs',
    install: 'npm install -g opencode-ai',
  }),
  gemini: adapter({
    id: 'gemini', label: 'Gemini CLI', bin: 'gemini', printFlag: '-p',
    instructionFiles: ['GEMINI.md'], skillsDirs: ['.agents/skills'],
    docs: 'https://github.com/google-gemini/gemini-cli',
    install: 'npm install -g @google/gemini-cli',
  }),
};

export function getAdapter(id) {
  const found = ADAPTERS[id];
  if (found) return found;
  throw new MoragentError(
    'UNKNOWN_CLI',
    t(`CLI de agente desconocido: ${id}`, `Unknown agent CLI: ${id}`),
    Object.keys(ADAPTERS).join(' | '),
  );
}
