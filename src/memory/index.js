import fs from 'node:fs';
import path from 'node:path';
import { dirs, requireRoot } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import { ensureDir, exists, readText, writeText, listFiles, slugify, today, nowISO } from '../core/fsx.js';
import { MoragentError } from '../core/errors.js';
import { flagList } from '../core/args.js';
import { t, setLang, getLang } from '../core/i18n.js';
import { parseFrontmatter, stringifyFrontmatter } from './frontmatter.js';
import { bm25Search } from './search.js';

export const TIERS = ['canonical', 'episodic', 'transient'];
export const KINDS = ['decision', 'convention', 'fact', 'episode', 'handoff', 'note'];

function defaultKind(tier) {
  if (tier === 'canonical') return 'decision';
  if (tier === 'episodic') return 'episode';
  return 'note';
}

function resolveIdAndPath(targetDir, tier, title) {
  const slug = slugify(title);
  const base = tier === 'canonical' ? slug : `${today()}-${slug}`;
  let id = base;
  let counter = 2;

  while (exists(path.join(targetDir, `${id}.md`))) {
    id = `${base}-${counter}`;
    counter++;
  }

  return { id, filePath: path.join(targetDir, `${id}.md`) };
}

export function add({
  root,
  tier = 'episodic',
  kind,
  title,
  body = '',
  tags = [],
  links = [],
  by,
} = {}) {
  const r = root || requireRoot();
  if (!title || !String(title).trim()) {
    throw new MoragentError('MISSING_TITLE', t('Se requiere un título para la nota.', 'Title is required for memory note.'));
  }
  if (!TIERS.includes(tier)) {
    throw new MoragentError('BAD_TIER', t(`Tier inválido: ${tier}`, `Invalid tier: ${tier}`), TIERS.join(' | '));
  }

  const d = dirs(r);
  const targetDir = d[tier];
  ensureDir(targetDir);

  const { id, filePath } = resolveIdAndPath(targetDir, tier, title);
  const actualKind = kind || defaultKind(tier);
  const tagList = Array.isArray(tags) ? tags : flagList(tags);
  const linkList = Array.isArray(links) ? links : flagList(links);
  const actualBy = by || process.env.MORAGENT_ROLE || 'user';

  const data = {
    id,
    tier,
    kind: actualKind,
    title: String(title).trim(),
    tags: tagList,
    links: linkList,
    by: String(actualBy),
    created: nowISO(),
  };

  const content = stringifyFrontmatter(data, body);
  writeText(filePath, content);

  return {
    id,
    path: filePath,
    note: { ...data, body, path: filePath },
  };
}

export function getNote(root, id) {
  const r = root || requireRoot();
  const d = dirs(r);
  const cleanId = String(id || '').replace(/\.md$/, '');

  for (const tier of TIERS) {
    const p = path.join(d[tier], `${cleanId}.md`);
    if (exists(p)) {
      const text = readText(p);
      const { data, body } = parseFrontmatter(text);
      return {
        ...data,
        id: data.id || cleanId,
        tier: data.tier || tier,
        body,
        path: p,
      };
    }
  }

  // Fallback: search across all files in all tiers matching data.id, ending with slug, or slug of title
  const notes = list({ root: r });
  return (
    notes.find(
      (n) =>
        n.id === cleanId ||
        n.id === id ||
        n.id.endsWith(`-${cleanId}`) ||
        slugify(n.title) === cleanId
    ) || null
  );
}

export function list({ root, tier, limit } = {}) {
  const r = root || requireRoot();
  const d = dirs(r);
  const tiersToScan = tier && tier !== 'all' ? [tier] : TIERS;
  const notes = [];

  for (const tName of tiersToScan) {
    const targetDir = d[tName];
    if (!targetDir || !exists(targetDir)) continue;

    const files = listFiles(targetDir, { ext: '.md' });
    for (const f of files) {
      const text = readText(f);
      const { data, body } = parseFrontmatter(text);
      const baseId = path.basename(f, '.md');
      notes.push({
        ...data,
        id: data.id || baseId,
        tier: data.tier || tName,
        title: data.title || baseId,
        tags: Array.isArray(data.tags) ? data.tags : [],
        links: Array.isArray(data.links) ? data.links : [],
        body,
        path: f,
      });
    }
  }

  // Sort newest first
  notes.sort((a, b) => {
    const timeA = a.created ? new Date(a.created).getTime() : 0;
    const timeB = b.created ? new Date(b.created).getTime() : 0;
    if (timeB !== timeA) return timeB - timeA;
    return b.id.localeCompare(a.id);
  });

  if (limit && Number(limit) > 0) {
    return notes.slice(0, Number(limit));
  }
  return notes;
}

export function listSpecsDocs(root) {
  const r = root || requireRoot();
  const specsDir = dirs(r).specs;
  if (!exists(specsDir)) return [];

  const docs = [];
  const specFiles = ['proposal.md', 'spec.md', 'design.md'];

  for (const ent of fs.readdirSync(specsDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const slug = ent.name;
    const folder = path.join(specsDir, slug);

    for (const f of specFiles) {
      const p = path.join(folder, f);
      if (exists(p)) {
        const text = readText(p);
        if (text && text.trim()) {
          const kindName = f.replace('.md', '');
          docs.push({
            id: `specs/${slug}/${f}`,
            tier: 'spec',
            kind: 'spec',
            title: `${slug}: ${kindName}`,
            tags: [slug, 'spec', kindName],
            links: [slug],
            body: text,
            path: p,
          });
        }
      }
    }
  }

  return docs;
}

export function recall({ root, query, tiers, limit = 8, includeSpecs = false } = {}) {
  const r = root || requireRoot();
  if (!query || !String(query).trim()) return [];

  const tierList = tiers ? (Array.isArray(tiers) ? tiers : [tiers]) : TIERS;
  const allNotes = list({ root: r });
  let candidateNotes = allNotes.filter((n) => tierList.includes(n.tier));

  if (includeSpecs || tierList.includes('spec')) {
    const specDocs = listSpecsDocs(r);
    candidateNotes = candidateNotes.concat(specDocs);
  }

  return bm25Search(candidateNotes, query, { limit });
}

export function promote({ root, id, kind = 'decision' } = {}) {
  const r = root || requireRoot();
  const note = getNote(r, id);
  if (!note) {
    throw new MoragentError(
      'NOTE_NOT_FOUND',
      t(`Nota no encontrada: ${id}`, `Note not found: ${id}`),
      'mora memory list'
    );
  }

  if (note.tier === 'canonical') {
    return note;
  }

  const d = dirs(r);
  ensureDir(d.canonical);

  const slug = slugify(note.title);
  let newId = slug;
  let counter = 2;
  while (exists(path.join(d.canonical, `${newId}.md`))) {
    newId = `${slug}-${counter}`;
    counter++;
  }

  const newPath = path.join(d.canonical, `${newId}.md`);
  const updatedData = {
    ...note,
    id: newId,
    tier: 'canonical',
    kind: kind || 'decision',
    promotedFrom: note.id,
    updated: nowISO(),
  };
  delete updatedData.path;

  // Write to canonical
  writeText(newPath, stringifyFrontmatter(updatedData, note.body));

  // Remove original note from episodic/transient
  if (exists(note.path)) {
    fs.unlinkSync(note.path);
  }

  // Add traceability note in episodic
  add({
    root: r,
    tier: 'episodic',
    kind: 'episode',
    title: `Promoted: ${note.title}`,
    body: `Promoted note [[${newId}]] from ${note.tier} to canonical. Original ID: ${note.id}.`,
    tags: ['promoted', ...(note.tags || [])],
    links: [newId],
    by: note.by || process.env.MORAGENT_ROLE || 'user',
  });

  return { ...updatedData, path: newPath };
}

export function gc({ root, days, dryRun = false } = {}) {
  const r = root || requireRoot();
  let cfg = null;
  try { cfg = loadConfig(r); } catch { /* ignore */ }

  const expirationDays = days !== undefined ? Number(days) : cfg?.memory?.transientDays ?? 7;
  const cutoffMs = Date.now() - expirationDays * 24 * 60 * 60 * 1000;

  const transientNotes = list({ root: r, tier: 'transient' });
  const removed = [];

  for (const n of transientNotes) {
    const createdMs = n.created ? new Date(n.created).getTime() : 0;
    if (createdMs < cutoffMs) {
      removed.push({
        id: n.id,
        path: n.path,
        title: n.title,
        created: n.created,
      });
      if (!dryRun && exists(n.path)) {
        fs.unlinkSync(n.path);
      }
    }
  }

  return { removed, count: removed.length, dryRun: !!dryRun };
}

export function contextPack({ root, role = 'agent', query = '', budget = 6000, includeSpecs = true, lang } = {}) {
  const r = root || requireRoot();
  let cfg = null;
  try { cfg = loadConfig(r); } catch { /* default config */ }

  const currentLang = lang || cfg?.lang || getLang();
  setLang(currentLang);

  const episodicLimit = cfg?.memory?.episodicInContext ?? 8;
  const canonicalNotes = list({ root: r, tier: 'canonical' });
  const episodicNotes = list({ root: r, tier: 'episodic', limit: episodicLimit });

  const handledIds = new Set();
  const lines = [
    t(`# Paquete de contexto: ${role}`, `# Context Pack: ${role}`),
    t(`Generado: ${nowISO()}`, `Generated: ${nowISO()}`),
    '',
  ];

  // 1) Canonical notes (full notes)
  lines.push(t('## Memoria canónica (decisiones y arquitectura)', '## Canonical Memory (Decisions & Architecture)'));
  if (canonicalNotes.length === 0) {
    lines.push(t('_Aún no hay decisiones canónicas registradas._', '_No canonical decisions recorded yet._'));
  } else {
    for (const note of canonicalNotes) {
      handledIds.add(note.id);
      lines.push(`### [[${note.id}]] ${note.title} (${note.kind})`);
      if (note.tags?.length) lines.push(t(`Etiquetas: ${note.tags.join(', ')}`, `Tags: ${note.tags.join(', ')}`));
      lines.push('');
      lines.push(note.body ? note.body.trim() : t('_Sin contenido._', '_No content._'));
      lines.push('');
    }
  }
  lines.push('');

  // 2) Recent episodic notes (summary with first body line preview <= 160 chars)
  lines.push(t(`## Episodios recientes (últimos ${episodicLimit})`, `## Recent Episodes (Last ${episodicLimit})`));
  if (episodicNotes.length === 0) {
    lines.push(t('_Sin episodios recientes._', '_No recent episodes._'));
  } else {
    for (const note of episodicNotes) {
      handledIds.add(note.id);
      const cleanBody = (note.body || '').replace(/^Links:\s*\[\[.*$/m, '').trim();
      const firstLine = cleanBody ? cleanBody.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '' : '';
      const summary = firstLine ? ` — ${firstLine.slice(0, 160)}` : '';
      const dateStr = note.created ? note.created.slice(0, 10) : today();
      lines.push(`- **${dateStr}** \`[[${note.id}]]\` ${note.title} (@${note.by || 'user'})${summary}`);
    }
  }
  lines.push('');

  // 3) Recall query matches (including specs by default)
  if (query && String(query).trim()) {
    const hits = recall({ root: r, query, limit: 6, includeSpecs });
    const relevantHits = hits.filter((h) => !handledIds.has(h.note.id));
    if (relevantHits.length > 0) {
      lines.push(t(`## Contexto relevante para la consulta: "${query}"`, `## Relevant Context for Query: "${query}"`));
      for (const hit of relevantHits) {
        lines.push(`- **[[${hit.note.id}]]** ${hit.note.title} (${hit.note.tier}, score: ${hit.score})`);
        if (hit.snippet) lines.push(`  > ${hit.snippet}`);
      }
      lines.push('');
    }
  }

  let pack = lines.join('\n');

  // Enforce budget
  if (budget && pack.length > budget) {
    const notice = t(
      `\n\n... [truncado para respetar presupuesto de ${budget} caracteres]`,
      `\n\n... [truncated to fit ${budget} character budget]`
    );
    pack = pack.slice(0, Math.max(0, budget - notice.length)) + notice;
  }

  // Save compiled context to .moragent/context/<role>.md
  const d = dirs(r);
  ensureDir(d.context);
  const contextFile = path.join(d.context, `${slugify(role)}.md`);
  writeText(contextFile, pack);

  return pack;
}

export {
  captureClaude,
  captureCodex,
  hookConfig,
  redactSecrets,
  parseClaudeTranscript,
} from './capture.js';
