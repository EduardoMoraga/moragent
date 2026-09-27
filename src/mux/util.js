import { shq } from '../core/exec.js';
import { shimFor } from '../core/shim.js';
import { MoragentError } from '../core/errors.js';
import { t } from '../core/i18n.js';

export function paneCommand({ root, role, command, platform = process.platform }) {
  if (!command) return '';
  const shim = shimFor(root);
  if (platform === 'win32') {
    const cd = root ? `cd /d "${String(root).replace(/"/g, '""')}" && ` : '';
    const env = role ? `set "MORAGENT_ROLE=${String(role).replace(/"/g, '')}" && ` : '';
    const p = shim ? `set "PATH=${shim};%PATH%" && ` : '';
    return `${cd}${env}${p}${command}`;
  }
  const cd = root ? `cd ${shq(root)} && ` : '';
  const env = role ? `MORAGENT_ROLE=${shq(role)} ` : '';
  const p = shim ? `PATH=${shq(shim)}:"$PATH" ` : '';
  return `${cd}${env}${p}${command}`;
}

export function checked(result, label) {
  if (result.code === 0) return result;
  const detail = String(result.stderr || result.stdout || '').trim();
  throw new MoragentError(
    'MUX_ERROR',
    t(`Falló ${label}.`, `${label} failed.`),
    detail || t('Revisa que el multiplexor esté activo.', 'Check that the multiplexer is running.'),
  );
}

export function parseJSON(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { /* try an embedded object below */ }
  const starts = [raw.indexOf('{'), raw.indexOf('[')].filter((n) => n >= 0).sort((a, b) => a - b);
  if (!starts.length) return null;
  try { return JSON.parse(raw.slice(starts[0])); } catch { return null; }
}

export function findValue(value, keys) {
  if (!value || typeof value !== 'object') return null;
  for (const key of keys) if (typeof value[key] === 'string' && value[key]) return value[key];
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      const found = findValue(child, keys);
      if (found) return found;
    }
  }
  return null;
}

export function containsValue(value, wanted) {
  if (value == null) return false;
  if (typeof value !== 'object') return String(value) === String(wanted);
  return Object.values(value).some((child) => containsValue(child, wanted));
}

export function plainHandle(text) {
  const raw = String(text || '').trim();
  const line = raw.split(/\r?\n/).find((s) => s.trim()) || '';
  const match = line.match(/(?:pane|terminal|handle|id)\s*[:=]\s*([\w:%.-]+)/i);
  return match?.[1] || (/^[\w:%.-]+$/.test(line) ? line : null);
}
