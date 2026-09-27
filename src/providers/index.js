import { MoragentError } from '../core/errors.js';
import { t } from '../core/i18n.js';
import claude from './cli/claude.js';
import codex from './cli/codex.js';
import agy from './cli/agy.js';
import pi from './cli/pi.js';
import gemini from './cli/gemini.js';
import opencode from './cli/opencode.js';

export const PROVIDERS = { claude, codex, agy, pi, gemini, opencode };

const apiIds = ['anthropic', 'openai', 'openrouter', 'ollama', 'google'];

const apiProviders = await Promise.all(apiIds.map(async (id) => {
  const target = new URL(`./api/${id}.js`, import.meta.url);
  try {
    const module = await import(target.href);
    return module.default || module[id] || module.provider || null;
  } catch (error) {
    // The API-provider owner may not have integrated yet. Only tolerate the target file itself
    // being absent; errors inside an existing provider remain visible.
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' || error?.url !== target.href) throw error;
    return null;
  }
}));

apiIds.forEach((id, index) => {
  if (apiProviders[index]) PROVIDERS[id] = apiProviders[index];
});

export function getProvider(id) {
  const provider = PROVIDERS[id];
  if (provider) return provider;
  throw new MoragentError(
    'UNKNOWN_PROVIDER',
    t(`Proveedor desconocido: ${id}`, `Unknown provider: ${id}`),
    Object.keys(PROVIDERS).join(' | '),
  );
}

export const listProviders = () => Object.values(PROVIDERS);
