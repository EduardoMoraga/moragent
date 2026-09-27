import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig } from '../src/core/config.js';
import { scaffold } from '../src/commands/init.js';
import { parseFrontmatter, stringifyFrontmatter } from '../src/memory/frontmatter.js';
import { tokenize, bm25Search, extractSnippet } from '../src/memory/search.js';
import { add, list, recall, promote, gc, contextPack, getNote } from '../src/memory/index.js';
import memoryCmd from '../src/commands/memory.js';
import contextCmd from '../src/commands/context.js';

const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-mem-'));
  const cfg = defaultConfig({ project: 'test-app', lang: 'es', preset: 'squad' });
  scaffold(d, cfg);
  return d;
};

test('frontmatter: parses strings, numbers, booleans, arrays, and handles colons in titles', () => {
  const raw = `---
id: 2026-09-27-auth-uses-jwt
tier: canonical # durable truth
kind: decision
title: Auth: JWT with refresh: rotation
tags: [auth, backend, security]
links: [T-0004, auth-login]
by: backend
active: true
count: 42
created: 2026-09-27T14:03:00-03:00
---
Body text with description.`;

  const { data, body } = parseFrontmatter(raw);
  assert.equal(data.id, '2026-09-27-auth-uses-jwt');
  assert.equal(data.tier, 'canonical');
  assert.equal(data.kind, 'decision');
  assert.equal(data.title, 'Auth: JWT with refresh: rotation');
  assert.deepEqual(data.tags, ['auth', 'backend', 'security']);
  assert.deepEqual(data.links, ['T-0004', 'auth-login']);
  assert.equal(data.by, 'backend');
  assert.equal(data.active, true);
  assert.equal(data.count, 42);
  assert.equal(data.created, '2026-09-27T14:03:00-03:00');
  assert.match(body, /Body text with description\./);
});

test('frontmatter: serializes notes and renders wikilinks for Obsidian graph', () => {
  const data = {
    id: 'my-note',
    tier: 'canonical',
    kind: 'decision',
    title: 'Database: SQLite with WAL mode',
    tags: ['db', 'sqlite'],
    links: ['T-0001', 'spec-db'],
    by: 'backend',
  };
  const body = 'We choose SQLite for local simplicity.';
  const str = stringifyFrontmatter(data, body);

  assert.match(str, /^---\n/);
  assert.match(str, /title: "Database: SQLite with WAL mode"/);
  assert.match(str, /tags: \[db, sqlite\]/);
  assert.match(str, /links: \[T-0001, spec-db\]/);
  assert.match(str, /Links: \[\[T-0001\]\] \[\[spec-db\]\]/);

  // Roundtrip
  const parsed = parseFrontmatter(str);
  assert.equal(parsed.data.id, 'my-note');
  assert.equal(parsed.data.title, 'Database: SQLite with WAL mode');
  assert.deepEqual(parsed.data.tags, ['db', 'sqlite']);
  assert.deepEqual(parsed.data.links, ['T-0001', 'spec-db']);
});

test('search: tokenizer normalizes accents and filters bilingual stop words', () => {
  const tokens = tokenize('Autenticación y configuración con JWT para el backend');
  assert.ok(tokens.includes('autenticacion'));
  assert.ok(tokens.includes('configuracion'));
  assert.ok(tokens.includes('jwt'));
  assert.ok(tokens.includes('backend'));
  assert.ok(!tokens.includes('y'));
  assert.ok(!tokens.includes('con'));
  assert.ok(!tokens.includes('para'));
  assert.ok(!tokens.includes('el'));
});

test('search: BM25 weights title x3, tags x2, body x1 and ranks correctly', () => {
  const notes = [
    { id: '1', title: 'Cache Strategy', tags: ['redis'], body: 'Details about session storage.' },
    { id: '2', title: 'Authentication Setup', tags: ['auth', 'jwt'], body: 'We use JWT with refresh rotation.' },
    { id: '3', title: 'Database Migrations', tags: ['sql'], body: 'Auth token table definition with jwt column.' },
  ];

  const results = bm25Search(notes, 'jwt authentication', { limit: 5 });
  assert.ok(results.length >= 2);
  // Note 2 matches in title and tags and body, should rank #1
  assert.equal(results[0].note.id, '2');
  assert.ok(results[0].score > results[1].score);
});

test('search: snippet extracts matching zone', () => {
  const body = 'First sentence. Second sentence with nothing. Then we configured JWT token refresh rotation in the server. Ending note.';
  const snippet = extractSnippet(body, ['jwt', 'refresh']);
  assert.match(snippet, /JWT token refresh/);
});

test('memory: add, list, and collision suffixing', () => {
  const root = tmp();

  // Add episodic note
  const ep1 = add({ root, tier: 'episodic', title: 'First Task Complete', body: 'Finished setup.', tags: ['init'] });
  assert.match(ep1.id, /^\d{4}-\d{2}-\d{2}-first-task-complete$/);
  assert.ok(fs.existsSync(ep1.path));

  // Add another note with the same title -> should have -2
  const ep2 = add({ root, tier: 'episodic', title: 'First Task Complete', body: 'Finished duplicate.' });
  assert.match(ep2.id, /^\d{4}-\d{2}-\d{2}-first-task-complete-2$/);

  // Add canonical note -> uses slug without date prefix
  const can = add({ root, tier: 'canonical', title: 'Use ESM Modules', body: 'Pure ESM codebase.' });
  assert.equal(can.id, 'use-esm-modules');

  // List all (includes scaffolded project.md + 2 episodic + 1 canonical)
  const all = list({ root });
  assert.equal(all.length, 4);
  // Newest first
  assert.equal(all[0].id, can.id);

  // Filter by tier
  const canList = list({ root, tier: 'canonical' });
  assert.equal(canList.length, 2);
  assert.ok(canList.some((n) => n.id === 'use-esm-modules'));
  assert.ok(canList.some((n) => n.id === 'project'));

  // getNote helper
  assert.equal(getNote(root, 'use-esm-modules')?.id, 'use-esm-modules');
  assert.equal(getNote(root, ep1.id)?.title, 'First Task Complete');
});

test('memory: recall query with accent normalization', () => {
  const root = tmp();
  add({ root, tier: 'canonical', title: 'Políticas de Autorización', body: 'Control de acceso basado en roles RBAC.', tags: ['seguridad'] });
  add({ root, tier: 'canonical', title: 'Frontend UI Components', body: 'Buttons and modals in React.' });

  // Query with no accents matches note with accents
  const hits = recall({ root, query: 'politicas autorizacion' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].note.id, 'politicas-de-autorizacion');
  assert.ok(hits[0].score > 0);
  assert.match(hits[0].snippet, /Control de acceso/);
});

test('memory: promote moves note to canonical, changes tier/kind, and adds episodic traceability', () => {
  const root = tmp();
  const ep = add({ root, tier: 'episodic', kind: 'episode', title: 'Architecture Decision for Cache', body: 'Redis chosen.' });
  assert.ok(fs.existsSync(ep.path));

  const promoted = promote({ root, id: ep.id, kind: 'decision' });
  assert.equal(promoted.tier, 'canonical');
  assert.equal(promoted.kind, 'decision');
  assert.equal(promoted.id, 'architecture-decision-for-cache');
  assert.ok(fs.existsSync(promoted.path));

  // Original file should be removed
  assert.ok(!fs.existsSync(ep.path));

  // Check episodic traceability note was added
  const episodes = list({ root, tier: 'episodic' });
  const traceNote = episodes.find((e) => e.title.includes('Promoted: Architecture Decision for Cache'));
  assert.ok(traceNote, 'Traceability note must exist in episodic tier');
  assert.ok(traceNote.links.includes(promoted.id));
});

test('memory: gc removes expired transient notes and supports dry-run', () => {
  const root = tmp();
  const tr1 = add({ root, tier: 'transient', title: 'Old scratch note', body: 'Temp data.' });
  const tr2 = add({ root, tier: 'transient', title: 'Fresh scratch note', body: 'Active.' });

  // Manually backdate tr1 in file
  const tr1Content = fs.readFileSync(tr1.path, 'utf8').replace(/created: .*/, 'created: 2020-01-01T00:00:00-03:00');
  fs.writeFileSync(tr1.path, tr1Content);

  // Dry run: reports tr1 but doesn't delete
  const dryRes = gc({ root, days: 7, dryRun: true });
  assert.equal(dryRes.count, 1);
  assert.equal(dryRes.removed[0].id, tr1.id);
  assert.ok(fs.existsSync(tr1.path));

  // Real run: deletes tr1
  const realRes = gc({ root, days: 7, dryRun: false });
  assert.equal(realRes.count, 1);
  assert.ok(!fs.existsSync(tr1.path));
  assert.ok(fs.existsSync(tr2.path));
});

test('memory: contextPack generates ordered markdown within budget and writes file', () => {
  const root = tmp();
  add({ root, tier: 'canonical', title: 'System Architecture', body: 'Microservices with Node.js.' });
  add({ root, tier: 'episodic', title: 'Sprint 1 Finished', body: 'Delivered initial scaffold.' });

  const pack = contextPack({ root, role: 'backend', query: 'architecture', budget: 4000 });
  assert.match(pack, /# Context Pack: backend/);
  assert.match(pack, /## Canonical Memory/);
  assert.match(pack, /System Architecture/);
  assert.match(pack, /## Recent Episodes/);
  assert.match(pack, /Sprint 1 Finished/);

  // Check file written to .moragent/context/backend.md
  const contextPath = path.join(root, '.moragent', 'context', 'backend.md');
  assert.ok(fs.existsSync(contextPath));
  assert.equal(fs.readFileSync(contextPath, 'utf8'), pack);
  assert.ok(pack.length <= 4000);
});

test('CLI: memory command add, list, recall, show, promote, gc with --json', async () => {
  const root = tmp();
  const ctx = { root, json: true, lang: 'en' };

  // Capture stdout
  let outLogs = [];
  const origOut = process.stdout.write;
  process.stdout.write = (chunk) => { outLogs.push(chunk); return true; };

  try {
    // 1. Add
    await memoryCmd.run({ _: ['add', 'API spec for auth'], flags: { tier: 'canonical', body: 'Use OAuth2.' } }, ctx);
    const addOutput = JSON.parse(outLogs.pop());
    assert.equal(addOutput.ok, true);
    assert.equal(addOutput.tier, 'canonical');

    // 2. List
    await memoryCmd.run({ _: ['list'], flags: {} }, ctx);
    const listOutput = JSON.parse(outLogs.pop());
    assert.ok(Array.isArray(listOutput));
    assert.equal(listOutput.length, 2); // project.md + api-spec-for-auth

    // 3. Show
    await memoryCmd.run({ _: ['show', addOutput.id], flags: {} }, ctx);
    const showOutput = JSON.parse(outLogs.pop());
    assert.equal(showOutput.id, addOutput.id);
    assert.equal(showOutput.title, 'API spec for auth');

    // 4. Recall
    await memoryCmd.run({ _: ['recall', 'OAuth2'], flags: {} }, ctx);
    const recallOutput = JSON.parse(outLogs.pop());
    assert.ok(Array.isArray(recallOutput));
    assert.equal(recallOutput.length, 1);
    assert.equal(recallOutput[0].note.id, addOutput.id);

    // 5. GC
    await memoryCmd.run({ _: ['gc'], flags: { 'dry-run': true } }, ctx);
    const gcOutput = JSON.parse(outLogs.pop());
    assert.equal(gcOutput.dryRun, true);
  } finally {
    process.stdout.write = origOut;
  }
});

test('CLI: context command prints context pack with --json', async () => {
  const root = tmp();
  const ctx = { root, json: true, lang: 'en' };

  let outLogs = [];
  const origOut = process.stdout.write;
  process.stdout.write = (chunk) => { outLogs.push(chunk); return true; };

  try {
    await contextCmd.run({ _: ['helper'], flags: { budget: '2000' } }, ctx);
    const res = JSON.parse(outLogs.pop());
    assert.equal(res.ok, true);
    assert.equal(res.role, 'helper');
    assert.equal(res.budget, 2000);
    assert.match(res.context, /# Context Pack: helper/);
  } finally {
    process.stdout.write = origOut;
  }
});
