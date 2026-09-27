import { c } from '../core/log.js';
import { t } from '../core/i18n.js';

export const LOGO = [
  '█▀▄▀█ █▀█ █▀█ ▄▀█ █▀▀ █▀▀ █▄ █ ▀█▀',
  '█ ▀ █ █▄█ █▀▄ █▀█ █▄█ ██▄ █ ▀█  █ ',
];

export const tagline = () => t(
  'un equipo de agentes de IA, en paneles reales, con memoria',
  'one crew of AI agents, in real panes, with memory',
);

// Full banner (wizard, first run). Plain ASCII-safe fallback when the terminal is very narrow.
export function banner({ version } = {}) {
  const cols = process.stdout.columns || 80;
  const v = version ? c.dim(` v${version}`) : '';
  if (cols < 40) return `${c.brand(c.bold('MORAGENT'))}${v}\n${c.dim(tagline())}`;
  return [...LOGO.map((l) => c.brand(l)), `${c.dim(tagline())}${v}`].join('\n');
}

// One-line header for dense screens (dashboard).
export const bannerSmall = ({ version } = {}) =>
  `${c.brand('◆')} ${c.bold('MORAGENT')}${version ? c.dim(` v${version}`) : ''}`;
