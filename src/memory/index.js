import fs from 'node:fs';
import path from 'node:path';
import { dirs, requireRoot } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import { ensureDir, exists, readText, writeText, listFiles, slugify, today, nowISO } from '../core/fsx.js';
import { MoragentError } from '../core/errors.js';
import { flagList } from '../core/args.js';
import { t, setLang, getLang } from '../core/i18n.js';
import { parseFrontmatter, stringifyFrontmatter } from './frontmatter.js';
import { bm25Search, normalizeText } from './search.js';
import { isGreeting } from '../core/greeting.js';

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

function contextIdentity(note) {
  const body = normalizeText((note.body || '').replace(/^Links:\s*\[\[.*$/gm, '')).replace(/\s+/g, ' ').trim();
  const title = normalizeText(note.title || '').replace(/\s+/g, ' ').trim();
  return body.length >= 24 ? `body:${body}` : `short:${title}|${body}`;
}

function contextSource(root, note, currentLang) {
  const source = note.source || (note.path ? path.relative(root, note.path).replaceAll(path.sep, '/') : note.id);
  const scope = ['global', 'project', 'session'].includes(note.scope) ? note.scope : 'project';
  return currentLang === 'en' ? `Source: ${source} · scope: ${scope}` : `Fuente: ${source} · alcance: ${scope}`;
}

export function contextPack({ root, role = 'agent', query = '', budget = 6000, includeSpecs = true, lang, sessionId } = {}) {
  const r = root || requireRoot();
  let cfg = null;
  try { cfg = loadConfig(r); } catch { /* default config */ }

  const currentLang = lang || cfg?.lang || getLang();
  setLang(currentLang);

  const maxChars = Number.isFinite(Number(budget)) && Number(budget) > 0 ? Math.floor(Number(budget)) : 6000;
  const episodicLimit = cfg?.memory?.episodicInContext ?? 8;
  const inScope = (note) => note.scope !== 'session' || (sessionId && note.sessionId === sessionId);
  const canonicalNotes = list({ root: r, tier: 'canonical' }).filter((note) => {
    if (!inScope(note)) return false;
    if (note.id !== 'project') return true;
    // `mora init` appends provenance after the goal; judge only the goal paragraph.
    return !isGreeting((note.body || '').split(/\n\s*\n/, 1)[0]);
  });
  const relevance = new Map(bm25Search(canonicalNotes, query, { limit: canonicalNotes.length }).map((hit) => [hit.note.path, hit.score]));
  canonicalNotes.sort((a, b) => (relevance.get(b.path) || 0) - (relevance.get(a.path) || 0)
    || Number(b.id === 'project') - Number(a.id === 'project')
    || String(b.created || '').localeCompare(String(a.created || '')) || a.id.localeCompare(b.id));
  const episodicNotes = list({ root: r, tier: 'episodic' }).filter(inScope);
  const seen = new Set();
  let pack = '';
  const append = (block) => {
    const next = `${pack ? '\n' : ''}${block}`;
    if (pack.length + next.length > maxChars) return false;
    pack += next;
    return true;
  };
  const addNote = (note, block) => {
    const identity = contextIdentity(note);
    if (seen.has(identity)) return false;
    if (!append(block)) return false;
    seen.add(identity);
    return true;
  };

  const heading = t(`# Paquete de contexto: ${role}`, `# Context Pack: ${role}`);
  if (!append(heading)) pack = heading.slice(0, maxChars);
  append(t(`Generado: ${nowISO()}`, `Generated: ${nowISO()}`));
  append(t('## Memoria canónica (decisiones y arquitectura)', '## Canonical Memory (Decisions & Architecture)'));
  if (!canonicalNotes.length) append(t('_Aún no hay decisiones canónicas registradas._', '_No canonical decisions recorded yet._'));
  let canonicalOmitted = false;
  for (let i = 0; i < canonicalNotes.length; i++) {
    const note = canonicalNotes[i];
    if (seen.has(contextIdentity(note))) continue;
    const header = `### [[${note.id}]] ${note.title} (${note.kind})\n${contextSource(r, note, currentLang)}`;
    const tags = note.tags?.length ? `\n${t('Etiquetas', 'Tags')}: ${note.tags.join(', ')}` : '';
    const base = header + tags;
    const body = (note.body || '').trim() || t('_Sin contenido._', '_No content._');
    const remainingNotes = canonicalNotes.length - i - 1;
    const remaining = maxChars - pack.length - 1;
    const bodyCap = Math.min(900, Math.max(0, remaining - base.length - remainingNotes * 100 - 2));
    const preview = body.length <= bodyCap ? body : bodyCap > 3 ? `${body.slice(0, bodyCap - 1)}…` : '';
    if (!addNote(note, `${base}${preview ? `\n${preview}` : ''}`)) canonicalOmitted = true;
  }

  const episodeHeading = t(`## Episodios recientes (últimos ${episodicLimit})`, `## Recent Episodes (Last ${episodicLimit})`);
  if (!canonicalOmitted && append(episodeHeading)) {
    let episodesAdded = 0;
    for (const note of episodicNotes) {
      if (episodesAdded >= episodicLimit) break;
      const cleanBody = (note.body || '').replace(/^Links:\s*\[\[.*$/m, '').trim();
      const firstLine = cleanBody ? cleanBody.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '' : '';
      const summary = firstLine ? ` — ${firstLine.slice(0, 160)}` : '';
      const dateStr = note.created ? note.created.slice(0, 10) : today();
      const entry = `- **${dateStr}** \`[[${note.id}]]\` ${note.title} (@${note.by || 'user'})${summary}\n  ${contextSource(r, note, currentLang)}`;
      if (addNote(note, entry)) episodesAdded++;
    }
    if (!episodesAdded) append(t('_Sin episodios recientes._', '_No recent episodes._'));
  }

  if (!canonicalOmitted && query && String(query).trim()) {
    const hits = recall({ root: r, query, limit: 20, includeSpecs });
    const relevantHeading = t(`## Contexto relevante para la consulta: "${query}"`, `## Relevant Context for Query: "${query}"`);
    for (const hit of hits) {
      if (hit.note.tier === 'canonical' || !inScope(hit.note) || seen.has(contextIdentity(hit.note))) continue;
      const source = contextSource(r, hit.note, currentLang);
      const entry = `- **[[${hit.note.id}]]** ${hit.note.title} (${hit.note.tier}, score: ${hit.score})\n  ${source}${hit.snippet ? `\n  > ${hit.snippet}` : ''}`;
      if (!pack.includes(relevantHeading)) {
        if (pack.length + relevantHeading.length + entry.length + 2 > maxChars) continue;
        append(relevantHeading);
      }
      addNote(hit.note, entry);
    }
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
  classifyFilePath,
  extractLinks,
} from './capture.js';
