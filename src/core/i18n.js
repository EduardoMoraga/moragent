let current = null;

export function detectLang() {
  const env = process.env.MORAGENT_LANG || process.env.LC_ALL || process.env.LANG || '';
  return /^es/i.test(env) ? 'es' : 'en';
}

export function setLang(lang) { current = lang === 'en' ? 'en' : 'es'; }

export function getLang() { return current || detectLang(); }

export const t = (es, en) => (getLang() === 'en' ? en : es);

// Pick from a { es, en } object.
export const tr = (obj) => (obj ? obj[getLang()] ?? obj.en ?? obj.es ?? '' : '');
