import { which, shq } from '../core/exec.js';
import { MoragentError } from '../core/errors.js';
import { t } from '../core/i18n.js';

const extras = ({ args, model, member } = {}) => ({
  args: Array.isArray(args) ? args : Array.isArray(member?.args) ? member.args : [],
  model: model || member?.model || null,
});

function adapter(def) {
  const interactiveBase = def.interactive || [def.bin];
  return {
    ...def,
    installed: () => !!which(def.bin),
    interactive(options = {}) {
      const extra = extras(options);
      const args = [...interactiveBase.slice(1)];
      if (extra.model) args.push('--model', extra.model);
      args.push(...extra.args);
      return [interactiveBase[0], ...args].map(shq).join(' ');
    },
    headless(options = {}) {
      const extra = extras(options);
      const base = def.headlessBefore || def.headless || [];
      const optionsArgs = [...(extra.model ? ['--model', extra.model] : []), ...extra.args];
      const args = def.optionsFirst ? [...optionsArgs, ...base] : [...base, ...optionsArgs];
      args.push(options.prompt || '');
      args.push(...(def.headlessAfter || []));
      return [def.bin, ...args];
    },
  };
}

export const ADAPTERS = {
  claude: adapter({
    id: 'claude', label: 'Claude Code', bin: 'claude',
    headlessBefore: ['-p'], headlessAfter: ['--permission-mode', 'acceptEdits'], optionsFirst: true,
    instructionFiles: ['CLAUDE.md'], skillsDirs: ['.claude/skills'],
    docs: 'https://docs.anthropic.com/en/docs/claude-code',
    install: 'npm install -g @anthropic-ai/claude-code',
  }),
  codex: adapter({
    id: 'codex', label: 'Codex', bin: 'codex',
    interactive: ['codex', '-s', 'workspace-write', '-a', 'never'],
    headless: ['exec', '-s', 'workspace-write'],
    instructionFiles: ['AGENTS.md'], skillsDirs: ['.agents/skills'],
    docs: 'https://developers.openai.com/codex/cli',
    install: 'npm install -g @openai/codex',
  }),
  agy: adapter({
    id: 'agy', label: 'Antigravity', bin: 'agy',
    headlessBefore: ['-p'], headlessAfter: ['--dangerously-skip-permissions'], optionsFirst: true,
    instructionFiles: ['GEMINI.md', 'AGENTS.md'], skillsDirs: ['.agents/skills'],
    docs: 'https://antigravity.google/docs',
    install: 'npm install -g @google/antigravity-cli',
  }),
  pi: adapter({
    id: 'pi', label: 'Pi', bin: 'pi', headless: ['-p'], optionsFirst: true,
    instructionFiles: ['AGENTS.md'], skillsDirs: ['.agents/skills', '.pi/skills'],
    docs: 'https://github.com/badlogic/pi-mono',
    install: 'npm install -g @mariozechner/pi-coding-agent',
  }),
  opencode: adapter({
    id: 'opencode', label: 'OpenCode', bin: 'opencode', headless: ['run'],
    instructionFiles: ['AGENTS.md'], skillsDirs: ['.agents/skills', '.opencode/skill'],
    docs: 'https://opencode.ai/docs',
    install: 'npm install -g opencode-ai',
  }),
  gemini: adapter({
    id: 'gemini', label: 'Gemini CLI', bin: 'gemini',
    headlessBefore: ['-p'], headlessAfter: ['--yolo'], optionsFirst: true,
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
