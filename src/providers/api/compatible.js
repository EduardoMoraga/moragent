import { createOpenAIAdapter } from './openai.js';
import { getFetch, runApiLoop } from './loop.js';
import { makeApiModelLister, withinTimeout } from './models.js';
import { getEndpoint, getKey } from '../credentials.js';
import { t } from '../../core/i18n.js';

const endpoint = () => getEndpoint('compatible')?.replace(/\/+$/, '') || null;
const headers = () => getKey('compatible') ? { authorization: `Bearer ${getKey('compatible')}` } : {};

export const listModels = makeApiModelLister({
  key: 'compatible',
  request: () => endpoint() ? { url: `${endpoint()}/models`, headers: headers() } : null,
  parse: (json) => (json.data || json.models || []).map((model) => ({ id: model.id || model.name, label: model.name || model.id })),
  fallback: [],
});

const adapter = createOpenAIAdapter({ id: 'compatible', defaultModel: 'default', requiresKey: false });

const compatible = {
  id: 'compatible',
  label: 'OpenAI-compatible',
  kind: 'api',
  listModels,
  async status({ timeoutMs = 1500 } = {}) {
    const base = endpoint();
    if (!base) return { ready: false, detail: t('Falta URL base', 'Missing base URL'), loginHint: t('Usa /login para configurar URL y clave opcional', 'Use /login to set a URL and optional key') };
    try {
      const response = await withinTimeout((signal) => getFetch()(`${base}/models`, {
        method: 'GET', headers: headers(), signal,
      }), timeoutMs);
      if (response?.ok) return { ready: true, detail: t('Servidor conectado', 'Server connected'), loginHint: '' };
      if ([404, 405, 501].includes(response?.status)) {
        return { ready: true, detail: t('URL accesible sin catálogo; elige un ID de modelo con /modelo', 'Endpoint reachable without a catalog; choose a model ID with /model'), loginHint: '' };
      }
      return { ready: false, detail: `HTTP ${response?.status || '?'}`, loginHint: t('Revisa la URL o la clave con /login', 'Check the URL or key with /login') };
    } catch {
      return { ready: false, detail: t('El servidor no responde', 'Server not responding'), loginHint: t('Revisa la URL con /login', 'Check the URL with /login') };
    }
  },
  async run(opts = {}) {
    const baseUrl = endpoint();
    if (!baseUrl) return { ok: false, text: '', error: t('Configura una URL base con /login.', 'Set a base URL with /login.') };
    const model = opts.model || process.env.MORAGENT_COMPATIBLE_MODEL || (await listModels())[0]?.id;
    if (!model) return { ok: false, text: '', error: t('No hay un ID de modelo disponible. Elígelo con /modelo o revisa la URL.', 'No model ID is available. Choose one with /model or check the URL.') };
    return runApiLoop({ providerId: 'compatible', adapter, apiKey: getKey('compatible'), baseUrl, ...opts, model });
  },
};

export default compatible;
