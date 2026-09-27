import { which } from '../core/exec.js';
import { MoragentError } from '../core/errors.js';
import { t } from '../core/i18n.js';
import orca from './orca.js';
import herdr from './herdr.js';
import tmux from './tmux.js';
import headless from './headless.js';

const MUXES = { orca, herdr, tmux, headless };

export function detectMux(pref = 'auto') {
  if (pref && pref !== 'auto') {
    const mux = getMux(pref);
    if (!mux.available()) throw new MoragentError(
      'MUX_UNAVAILABLE',
      t(`Multiplexor no disponible: ${pref}`, `Multiplexer unavailable: ${pref}`),
      pref === 'headless' ? '' : t(`Instala ${pref} o usa --mux headless.`, `Install ${pref} or use --mux headless.`),
    );
    return pref;
  }
  if (process.env.TERM_PROGRAM === 'Orca' || process.env.ORCA_TERMINAL_HANDLE) return 'orca';
  if (process.env.HERDR_ENV === '1') return 'herdr';
  if (process.env.TMUX) return 'tmux';
  if (which('tmux')) return 'tmux';
  return 'headless';
}

export function getMux(name) {
  const mux = MUXES[name];
  if (mux) return mux;
  throw new MoragentError(
    'UNKNOWN_MUX',
    t(`Multiplexor desconocido: ${name}`, `Unknown multiplexer: ${name}`),
    Object.keys(MUXES).join(' | '),
  );
}

export { MUXES };
