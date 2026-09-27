// BM25 search over memory notes with accent normalization, bilingual stopwords,
// field weighting (title x3, tags x2, body x1), and snippet extraction.

const STOPWORDS = new Set([
  // Spanish
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'e', 'o', 'u',
  'pero', 'es', 'son', 'era', 'eran', 'en', 'de', 'del', 'al', 'para', 'por',
  'con', 'sin', 'a', 'su', 'sus', 'se', 'no', 'que', 'como', 'este', 'esta',
  'estos', 'estas', 'lo', 'le', 'les', 'me', 'mi', 'tu', 'ya',
  // English
  'a', 'an', 'the', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'it', 'its', 'this',
  'that', 'these', 'those', 'as', 'not', 'we', 'you', 'they', 'he', 'she', 'do',
  'does', 'did', 'so', 'can', 'will', 'just'
]);

export function normalizeText(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export function stemWord(word) {
  if (!word || typeof word !== 'string') return '';
  const w = word.toLowerCase();
  if (w.length <= 3) return w;

  // 1. English -ing (length > 5): running -> run, testing -> test
  if (w.length > 5 && w.endsWith('ing')) {
    let base = w.slice(0, -3);
    if (base.length > 2 && base[base.length - 1] === base[base.length - 2] && /[bdfgmnprtz]/.test(base[base.length - 1])) {
      base = base.slice(0, -1);
    }
    return base;
  }

  // 2. English -ed (length > 4): started -> start, planned -> plan
  if (w.length > 4 && w.endsWith('ed')) {
    let base = w.slice(0, -2);
    if (base.length > 2 && base[base.length - 1] === base[base.length - 2] && /[bdfgmnprtz]/.test(base[base.length - 1])) {
      base = base.slice(0, -1);
    }
    return base;
  }

  // 3. Spanish plural with -es after consonants (d, l, n, r, s, z):
  // e.g. decisiones -> decision, roles -> rol, paneles -> panel, redes -> red
  if (w.length > 4 && w.endsWith('es') && /[dlnrsz]/.test(w[w.length - 3])) {
    return w.slice(0, -2);
  }

  // 4. Plural -s preceded by vowels (a, e, i, o, y) with length > 3:
  // e.g. cookies -> cookie, tareas -> tarea, usuarios -> usuario, keys -> key
  if (w.length > 3 && w.endsWith('s') && /[aeioy]/.test(w[w.length - 2])) {
    return w.slice(0, -1);
  }

  return w;
}

export function tokenize(s) {
  const norm = normalizeText(s);
  const raw = norm.match(/[a-z0-9_-]+/g) || [];
  return raw
    .filter((w) => w.length >= 1 && !STOPWORDS.has(w))
    .map((w) => stemWord(w));
}

// Extract a snippet centered around the highest concentration of query matches.
export function extractSnippet(body, queryTokens, maxWords = 25) {
  const cleanBody = String(body || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
  if (!cleanBody) return '';

  const words = cleanBody.split(/\s+/);
  if (words.length <= maxWords) return cleanBody;

  const targetTokens = new Set(queryTokens);
  if (targetTokens.size === 0) {
    return words.slice(0, maxWords).join(' ') + (words.length > maxWords ? ' ...' : '');
  }

  let bestScore = -1;
  let bestStart = 0;
  const step = 3;

  for (let i = 0; i < words.length; i += step) {
    const end = Math.min(i + maxWords, words.length);
    let windowScore = 0;
    for (let j = i; j < end; j++) {
      const wTokens = tokenize(words[j]);
      for (const wt of wTokens) {
        if (targetTokens.has(wt)) {
          windowScore += 2;
        }
      }
    }
    if (windowScore > bestScore) {
      bestScore = windowScore;
      bestStart = i;
    }
    if (end === words.length) break;
  }

  const bestEnd = Math.min(bestStart + maxWords, words.length);
  const snippet = words.slice(bestStart, bestEnd).join(' ');
  const prefix = bestStart > 0 ? '... ' : '';
  const suffix = bestEnd < words.length ? ' ...' : '';
  return `${prefix}${snippet}${suffix}`;
}

/**
 * Multi-field BM25 ranking.
 * Weights: title x3, tags x2, body x1.
 */
export function bm25Search(notes, query, { limit = 8, k1 = 1.5, b = 0.75 } = {}) {
  const qTokens = tokenize(query);
  if (qTokens.length === 0 || notes.length === 0) return [];

  const N = notes.length;
  const docs = [];
  let totalLength = 0;

  for (const note of notes) {
    const titleTokens = tokenize(note.title);
    const tagsTokens = tokenize(Array.isArray(note.tags) ? note.tags.join(' ') : note.tags);
    const bodyTokens = tokenize(note.body);

    const length = 3 * titleTokens.length + 2 * tagsTokens.length + 1 * bodyTokens.length;
    totalLength += length;

    const tfMap = new Map();
    for (const t of titleTokens) tfMap.set(t, (tfMap.get(t) || 0) + 3);
    for (const t of tagsTokens) tfMap.set(t, (tfMap.get(t) || 0) + 2);
    for (const t of bodyTokens) tfMap.set(t, (tfMap.get(t) || 0) + 1);

    docs.push({ note, length, tfMap });
  }

  const avgdl = totalLength / N || 1;

  // Calculate Document Frequency n(t) for each query token
  const dfMap = new Map();
  for (const t of qTokens) {
    let count = 0;
    for (const doc of docs) {
      if ((doc.tfMap.get(t) || 0) > 0) count++;
    }
    dfMap.set(t, count);
  }

  // Score each document
  const scored = [];
  for (const doc of docs) {
    let score = 0;
    for (const t of qTokens) {
      const tf = doc.tfMap.get(t) || 0;
      if (tf === 0) continue;
      const n = dfMap.get(t) || 0;
      // Lucene BM25 IDF variant: ln(1 + (N - n + 0.5) / (n + 0.5))
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const numerator = tf * (k1 + 1);
      const denominator = tf + k1 * (1 - b + (b * doc.length) / avgdl);
      score += idf * (numerator / denominator);
    }

    if (score > 0) {
      const snippet = extractSnippet(doc.note.body, qTokens);
      scored.push({
        note: doc.note,
        score: Math.round(score * 1000) / 1000,
        snippet,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
