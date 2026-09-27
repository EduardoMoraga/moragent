// Frontmatter parser and serializer for MORAGENT memory notes (Obsidian-compatible).

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function parseValue(raw) {
  let val = raw.trim();
  // Strip trailing comments if not quoted: e.g. canonical # comment
  if (!val.startsWith('"') && !val.startsWith("'")) {
    const commentIdx = val.search(/\s+#/);
    if (commentIdx >= 0) val = val.slice(0, commentIdx).trim();
  }

  // Booleans
  if (val === 'true') return true;
  if (val === 'false') return false;

  // Numbers
  if (/^-?\d+(?:\.\d+)?$/.test(val)) return Number(val);

  // Arrays: [a, b, c]
  if (val.startsWith('[') && val.endsWith(']')) {
    const inner = val.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }

  // Quoted strings
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    try {
      return JSON.parse(val.startsWith("'") ? `"${val.slice(1, -1).replace(/"/g, '\\"')}"` : val);
    } catch {
      return val.slice(1, -1);
    }
  }

  return val;
}

export function parseFrontmatter(content) {
  const text = String(content || '');
  const match = text.match(FRONTMATTER_REGEX);
  if (!match) {
    return { data: {}, body: text };
  }

  const rawYaml = match[1];
  const body = match[2];
  const data = {};

  for (const line of rawYaml.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const valStr = trimmed.slice(colonIdx + 1).trim();
    data[key] = parseValue(valStr);
  }

  return { data, body };
}

function serializeValue(val) {
  if (Array.isArray(val)) {
    return `[${val.map((x) => String(x).trim()).join(', ')}]`;
  }
  if (typeof val === 'boolean' || typeof val === 'number') {
    return String(val);
  }
  const s = String(val ?? '');
  // Quote strings with special characters, spaces, or colons
  if (
    s === '' ||
    /[:#\[\]{}'"\n]/.test(s) ||
    /^\s|\s$/.test(s) ||
    s === 'true' ||
    s === 'false' ||
    /^-?\d+(?:\.\d+)?$/.test(s)
  ) {
    return JSON.stringify(s);
  }
  return s;
}

export function renderWikilinks(links) {
  if (!Array.isArray(links) || links.length === 0) return '';
  return `Links: ${links.map((l) => `[[${l}]]`).join(' ')}`;
}

export function applyWikilinks(body, links) {
  const trimmed = (body || '').trim();
  if (!links || links.length === 0) return trimmed;

  const linksLine = renderWikilinks(links);
  const linksRegex = /^Links:\s*\[\[.*$/m;

  if (linksRegex.test(trimmed)) {
    return trimmed.replace(linksRegex, linksLine);
  }
  return trimmed ? `${trimmed}\n\n${linksLine}` : linksLine;
}

const PREFERRED_KEYS = ['id', 'tier', 'kind', 'title', 'tags', 'links', 'by', 'created'];

export function stringifyFrontmatter(data = {}, body = '') {
  const lines = ['---'];
  const handled = new Set();

  for (const k of PREFERRED_KEYS) {
    if (data[k] !== undefined && data[k] !== null) {
      lines.push(`${k}: ${serializeValue(data[k])}`);
      handled.add(k);
    }
  }

  for (const [k, v] of Object.entries(data)) {
    if (!handled.has(k) && v !== undefined && v !== null) {
      lines.push(`${k}: ${serializeValue(v)}`);
    }
  }

  lines.push('---');

  const links = Array.isArray(data.links) ? data.links : [];
  const finalBody = applyWikilinks(body, links);

  return lines.join('\n') + (finalBody ? `\n${finalBody}\n` : '\n');
}
