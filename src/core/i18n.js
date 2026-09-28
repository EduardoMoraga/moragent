import { spawnSync } from 'node:child_process';
let current = null;

let systemLang;

// macOS terminals often run with LANG=en_US while the person's system language is Spanish.
function macLanguage() {
  if (systemLang !== undefined) return systemLang;
  systemLang = null;
  if (process.platform !== 'darwin') return systemLang;
  try {
    const r = spawnSync('defaults', ['read', '-g', 'AppleLanguages'], { encoding: 'utf8', timeout: 1500 });
    const first = (r.stdout || '').match(/"?([a-z]{2})[-_A-Za-z]*"?/);
    systemLang = first ? first[1].toLowerCase() : null;
  } catch { /* keep null */ }
  return systemLang;
}

export function detectLang() {
  if (process.env.MORAGENT_LANG) return /^es/i.test(process.env.MORAGENT_LANG) ? 'es' : 'en';
  const env = process.env.LC_ALL || process.env.LANG || '';
  if (/^es/i.test(env)) return 'es';
  return macLanguage() === 'es' ? 'es' : 'en';
}

export function setLang(lang) { current = lang === 'en' ? 'en' : 'es'; }

export function getLang() { return current || detectLang(); }

export const t = (es, en) => (getLang() === 'en' ? en : es);

// Pick from a { es, en } object.
export const tr = (obj) => (obj ? obj[getLang()] ?? obj.en ?? obj.es ?? '' : '');
