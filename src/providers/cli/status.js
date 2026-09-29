import { which, runAsync } from '../../core/exec.js';
import { t } from '../../core/i18n.js';

const localizedHint = (hint) => {
  if (typeof hint === 'function') return hint();
  return hint ? t(hint, hint) : '';
};

export function cliStatus({ bin, args = null, evaluate = null, installHint, loginHint }) {
  return async () => {
    try {
      if (!which(bin)) return {
        ready: false,
        detail: t(`${bin} no está instalado.`, `${bin} is not installed.`),
        loginHint: localizedHint(installHint),
      };
      if (!args) return {
        ready: true,
        detail: t(`${bin} está instalado; no expone un estado de sesión.`, `${bin} is installed; it exposes no session status.`),
        loginHint: localizedHint(loginHint),
      };
      const result = await runAsync(bin, args, { timeoutMs: 3000 });
      const ready = result.code === 0 && (evaluate ? evaluate(result) : true);
      return {
        ready,
        detail: result.code === 124
          ? t(`La comprobación de ${bin} excedió el tiempo límite.`, `${bin} status check timed out.`)
          : ready
            ? t(`${bin} está instalado y autenticado.`, `${bin} is installed and authenticated.`)
            : t(`${bin} está instalado, pero no está autenticado.`, `${bin} is installed but not authenticated.`),
        loginHint: localizedHint(loginHint),
      };
    } catch (error) {
      return {
        ready: false,
        detail: t(`No se pudo verificar ${bin}: ${error.message}`, `Could not check ${bin}: ${error.message}`),
        loginHint: localizedHint(loginHint || installHint),
      };
    }
  };
}

export function jsonOutput(result) {
  try { return JSON.parse(result.stdout || result.stderr || '{}'); } catch { return {}; }
}
