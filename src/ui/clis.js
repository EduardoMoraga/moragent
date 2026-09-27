import { CLI_IDS } from '../core/config.js';
import { which } from '../core/exec.js';

// Antigravity ships its own installer, not an npm package (verified by the lead).
const AGY_INSTALL = process.platform === 'win32'
  ? 'irm https://antigravity.google/cli/install.ps1 | iex'
  : 'curl -fsSL https://antigravity.google/cli/install.sh | bash';

// Facts verified against the real tools; they win over adapter data.
const VERIFIED = { agy: { install: AGY_INSTALL } };

// Fallback facts about each agent CLI. When the backend's adapters exist, their fields win.
const FALLBACK = {
  claude: { label: 'Claude Code', bin: 'claude', install: 'npm i -g @anthropic-ai/claude-code', auth: 'claude  →  /login', docs: 'https://docs.anthropic.com/en/docs/claude-code' },
  codex: { label: 'Codex', bin: 'codex', install: 'npm i -g @openai/codex', auth: 'codex login', docs: 'https://github.com/openai/codex' },
  agy: { label: 'Antigravity', bin: 'agy', install: AGY_INSTALL, auth: 'agy', docs: 'https://github.com/google-antigravity/antigravity-cli' },
  pi: { label: 'Pi', bin: 'pi', install: 'npm i -g @mariozechner/pi-coding-agent', auth: 'pi  →  /login', docs: 'https://github.com/badlogic/pi-mono' },
  opencode: { label: 'OpenCode', bin: 'opencode', install: 'npm i -g opencode-ai', auth: 'opencode auth login', docs: 'https://opencode.ai' },
  gemini: { label: 'Gemini CLI', bin: 'gemini', install: 'npm i -g @google/gemini-cli', auth: 'gemini', docs: 'https://github.com/google-gemini/gemini-cli' },
};

export const MUXES = {
  orca: { label: 'Orca', bin: 'orca', install: 'https://github.com/stablyai/orca' },
  herdr: { label: 'herdr', bin: 'herdr', install: 'https://herdr.dev' },
  tmux: { label: 'tmux', bin: 'tmux', install: process.platform === 'darwin' ? 'brew install tmux' : 'sudo apt install tmux' },
};

export async function loadAdapters() {
  try {
    const mod = await import(new URL('../crew/adapters.js', import.meta.url).href);
    return mod.ADAPTERS || {};
  } catch { return {}; }
}

// [{ id, label, bin, install, auth, docs, path, installed }] for every known CLI.
export async function cliCatalog() {
  const adapters = await loadAdapters();
  return CLI_IDS.map((id) => {
    const a = adapters[id] || {};
    const info = { ...FALLBACK[id], ...pickDefined(a, ['label', 'bin', 'install', 'docs', 'auth']), ...VERIFIED[id], id };
    const path = which(info.bin);
    return { ...info, path, installed: !!path };
  });
}

const pickDefined = (obj, keys) => Object.fromEntries(keys.filter((k) => typeof obj[k] === 'string' && obj[k]).map((k) => [k, obj[k]]));

// Same auto-detection rule the backend uses (§8); used only when src/mux/index.js is absent.
export function detectMuxFallback(pref = 'auto', env = process.env) {
  if (pref && pref !== 'auto') return pref;
  if (env.TERM_PROGRAM === 'Orca' || env.ORCA_TERMINAL_HANDLE) return 'orca';
  if (env.HERDR_ENV === '1') return 'herdr';
  if (env.TMUX) return 'tmux';
  if (which('tmux')) return 'tmux';
  return 'headless';
}

export async function detectMux(pref = 'auto') {
  try {
    const mod = await import(new URL('../mux/index.js', import.meta.url).href);
    if (typeof mod.detectMux === 'function') return mod.detectMux(pref);
  } catch { /* backend module not built yet */ }
  return detectMuxFallback(pref);
}
