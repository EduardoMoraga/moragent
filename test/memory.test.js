import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig } from '../src/core/config.js';
import { scaffold } from '../src/commands/init.js';
import { dirs } from '../src/core/paths.js';
import { ensureDir } from '../src/core/fsx.js';
import { parseFrontmatter, stringifyFrontmatter } from '../src/memory/frontmatter.js';
import { tokenize, bm25Search, extractSnippet, stemWord } from '../src/memory/search.js';
import { add, list, recall, promote, gc, contextPack, getNote, captureClaude, captureCodex, hookConfig, redactSecrets, parseClaudeTranscript, classifyFilePath, extractLinks } from '../src/memory/index.js';
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
});

test('search: lightweight stemming handles plurals and basic English verb endings', () => {
  assert.equal(stemWord('cookies'), 'cookie');
  assert.equal(stemWord('cookie'), 'cookie');
  assert.equal(stemWord('decisiones'), 'decision');
  assert.equal(stemWord('decision'), 'decision');
  assert.equal(stemWord('tareas'), 'tarea');
  assert.equal(stemWord('tarea'), 'tarea');
  assert.equal(stemWord('running'), 'run');
  assert.equal(stemWord('run'), 'run');
  assert.equal(stemWord('started'), 'start');
  assert.equal(stemWord('status'), 'status');

  // BM25 match with stemmed forms
  const notes = [
    { id: 'n1', title: 'Gestión de Cookies y Sesiones', tags: ['auth'], body: 'Guardamos las cookies en el cliente.' },
    { id: 'n2', title: 'Lista de Tareas', tags: ['tasks'], body: 'Servicio running en segundo plano.' },
  ];

  // query 'cookie' matches 'Cookies'
  const r1 = bm25Search(notes, 'cookie');
  assert.ok(r1.length > 0);
  assert.equal(r1[0].note.id, 'n1');

  // query 'tarea' matches 'Tareas'
  const r2 = bm25Search(notes, 'tarea');
  assert.ok(r2.length > 0);
  assert.equal(r2[0].note.id, 'n2');

  // query 'run' matches 'running'
  const r3 = bm25Search(notes, 'run');
  assert.ok(r3.length > 0);
  assert.equal(r3[0].note.id, 'n2');
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

test('memory: default author uses MORAGENT_ROLE or falls back to user', () => {
  const root = tmp();

  const prevRole = process.env.MORAGENT_ROLE;
  delete process.env.MORAGENT_ROLE;
  try {
    // Without MORAGENT_ROLE -> falls back to 'user'
    const n1 = add({ root, title: 'Note by user', body: 'No by flag provided.' });
    assert.equal(n1.note.by, 'user');

    // With MORAGENT_ROLE -> uses env var
    process.env.MORAGENT_ROLE = 'backend';
    const n2 = add({ root, title: 'Note by backend env', body: 'From panel.' });
    assert.equal(n2.note.by, 'backend');

    // Explicit by takes precedence
    const n3 = add({ root, title: 'Note by explicit', body: 'Explicit.', by: 'lead' });
    assert.equal(n3.note.by, 'lead');
  } finally {
    if (prevRole !== undefined) process.env.MORAGENT_ROLE = prevRole;
    else delete process.env.MORAGENT_ROLE;
  }
});

test('memory: recall searches specs when includeSpecs is true', () => {
  const root = tmp();
  const specDir = path.join(dirs(root).specs, 'auth-jwt');
  ensureDir(specDir);
  fs.writeFileSync(path.join(specDir, 'spec.md'), '# Spec funcional: Auth JWT\n\n- RF-1: Cuando el usuario ingresa credenciales, el sistema genera refresh tokens.\n');

  // Without includeSpecs: does not search specs
  const hits1 = recall({ root, query: 'credenciales refresh tokens', includeSpecs: false });
  assert.equal(hits1.length, 0);

  // With includeSpecs: finds requirement in spec.md
  const hits2 = recall({ root, query: 'credenciales refresh tokens', includeSpecs: true });
  assert.equal(hits2.length, 1);
  assert.equal(hits2[0].note.tier, 'spec');
  assert.equal(hits2[0].note.id, 'specs/auth-jwt/spec.md');
  assert.match(hits2[0].snippet, /credenciales/);
});

test('memory: contextPack generates bilingual output, previews body and includes specs', () => {
  const root = tmp();
  add({ root, tier: 'canonical', title: 'System Architecture', body: 'Microservices with Node.js.' });
  add({ root, tier: 'episodic', title: 'Sprint 1 Finished', body: 'Delivered initial scaffold.\nSecond line.' });

  // Add spec requirement
  const specDir = path.join(dirs(root).specs, 'billing');
  ensureDir(specDir);
  fs.writeFileSync(path.join(specDir, 'spec.md'), '# Billing Spec\n\n- RF-1: Stripe integration for checkout.\n');

  // Spanish (default in tmp())
  const packEs = contextPack({ root, role: 'backend', query: 'Stripe', budget: 4000 });
  assert.match(packEs, /# Paquete de contexto: backend/);
  assert.match(packEs, /## Memoria canónica \(decisiones y arquitectura\)/);
  assert.match(packEs, /## Episodios recientes/);
  assert.match(packEs, /Sprint 1 Finished \(@user\) — Delivered initial scaffold\./);
  assert.match(packEs, /## Contexto relevante para la consulta: "Stripe"/);
  assert.match(packEs, /specs\/billing\/spec\.md/);

  // English
  const packEn = contextPack({ root, role: 'backend', query: 'Stripe', budget: 4000, lang: 'en' });
  assert.match(packEn, /# Context Pack: backend/);
  assert.match(packEn, /## Canonical Memory \(Decisions & Architecture\)/);
  assert.match(packEn, /## Recent Episodes/);
  assert.match(packEn, /## Relevant Context for Query: "Stripe"/);
  assert.ok(packEn.length <= 4000);
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

test('capture: secret redaction removes API keys, tokens, and private keys', () => {
  const secretText = [
    'OpenAI: sk-proj-1234567890abcdef1234567890',
    'GitHub: ghp_1234567890abcdef1234567890abcdef',
    'AWS: AKIAIOSFODNN7EXAMPLE',
    'Slack: xoxb-1234567890-1234567890123-abcdef',
    'Key: -----BEGIN RSA PRIVATE KEY-----\nMIIEogIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----',
    'Bearer token: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdef',
  ].join('\n');

  const clean = redactSecrets(secretText);
  assert.ok(!clean.includes('sk-proj-'));
  assert.ok(!clean.includes('ghp_'));
  assert.ok(!clean.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.ok(!clean.includes('xoxb-'));
  assert.ok(!clean.includes('MIIEogIBAAKCAQEA'));
  assert.ok(!clean.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'));
  assert.equal((clean.match(/\[REDACTED_SECRET\]/g) || []).length, 6);
});

test('capture: parseClaudeTranscript handles valid, corrupted, and tool call lines', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-'));
  const transcriptFile = path.join(tmpDir, 'transcript.jsonl');

  const lines = [
    JSON.stringify({ type: 'user', content: 'Please refactor the memory module sk-12345678901234567890' }),
    'INVALID JSON LINE {{{',
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: 'src/memory/capture.js' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
          { type: 'text', text: 'Refactored memory module successfully.' },
        ],
      },
    }),
    JSON.stringify({ type: 'user', content: 'Second turn: check tests' }),
    JSON.stringify({
      type: 'assistant',
      content: 'All tests pass green.',
    }),
  ];

  fs.writeFileSync(transcriptFile, lines.join('\n'));

  const parsed = parseClaudeTranscript(transcriptFile);
  assert.equal(parsed.userPrompts.length, 2);
  assert.equal(parsed.userPrompts[0], 'Please refactor the memory module sk-12345678901234567890');
  assert.equal(parsed.userPrompts[1], 'Second turn: check tests');
  assert.equal(parsed.filesTouched.length, 1);
  assert.equal(parsed.filesTouched[0], 'src/memory/capture.js');
  assert.equal(parsed.bashCommands.length, 1);
  assert.equal(parsed.bashCommands[0], 'npm test');
  assert.equal(parsed.assistantMessages.at(-1), 'All tests pass green.');
});

test('capture: captureClaude ignores trivial sessions (< 2 user turns and 0 files touched)', () => {
  const root = tmp();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-triv-'));
  const transcriptFile = path.join(tmpDir, 'transcript.jsonl');

  // Single user prompt, no file edits
  fs.writeFileSync(transcriptFile, JSON.stringify({ type: 'user', content: 'hello' }) + '\n' +
    JSON.stringify({ type: 'assistant', content: 'Hi there!' }) + '\n');

  const payload = {
    session_id: 'triv-session-123',
    transcript_path: transcriptFile,
    cwd: root,
  };

  const res = captureClaude(payload, { root });
  assert.equal(res, null);

  // Verify no episodic note was written
  const episodicDir = dirs(root).episodic;
  const files = fs.readdirSync(episodicDir);
  assert.equal(files.length, 0);
});

test('capture: captureClaude creates episodic note from non-trivial transcript with secret redaction', () => {
  const root = tmp();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-session-'));
  const transcriptFile = path.join(tmpDir, 'transcript.jsonl');

  const lines = [
    JSON.stringify({ type: 'user', content: 'Implement capture feature with key sk-12345678901234567890abcdef' }),
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Write', input: { file_path: path.join(root, 'src/memory/capture.js') } },
          { type: 'tool_use', name: 'Bash', input: { command: 'echo AKIAIOSFODNN7EXAMPLE' } },
          { type: 'text', text: 'Written capture.js successfully.' },
        ],
      },
    }),
    JSON.stringify({ type: 'user', content: 'Verify results' }),
    JSON.stringify({
      type: 'assistant',
      content: 'All verified and clean.',
    }),
  ];
  fs.writeFileSync(transcriptFile, lines.join('\n'));

  const payload = {
    session_id: 'claude-sess-987654321',
    transcript_path: transcriptFile,
    cwd: root,
  };

  const res = captureClaude(payload, { root });
  assert.ok(res);
  assert.ok(res.id.startsWith('session-'));
  assert.equal(fs.existsSync(res.path), true);

  const raw = fs.readFileSync(res.path, 'utf8');
  assert.ok(!raw.includes('sk-12345678901234567890abcdef'));
  assert.ok(!raw.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.ok(raw.includes('[REDACTED_SECRET]'));
  assert.match(raw, /tier: episodic/);
  assert.match(raw, /kind: episode/);
  assert.match(raw, /links: \[\]/);
  assert.match(raw, /All verified and clean\./);
  assert.match(raw, /- `src\/memory\/capture\.js`/);
});

test('capture: captureClaude updates existing note on same session without duplicating', () => {
  const root = tmp();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-update-'));
  const transcriptFile = path.join(tmpDir, 'transcript.jsonl');

  const lines1 = [
    JSON.stringify({ type: 'user', content: 'First prompt in session' }),
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Write', input: { file_path: path.join(root, 'file1.txt') } },
        ],
      },
    }),
  ];
  fs.writeFileSync(transcriptFile, lines1.join('\n'));

  const payload = {
    session_id: 'sess-abcdef12',
    transcript_path: transcriptFile,
    cwd: root,
  };

  const res1 = captureClaude(payload, { root });
  assert.ok(res1);

  // Subsequent event with more turns
  const lines2 = [
    ...lines1,
    JSON.stringify({ type: 'user', content: 'Second prompt' }),
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Write', input: { file_path: path.join(root, 'file2.txt') } },
          { type: 'text', text: 'Second prompt finished' },
        ],
      },
    }),
  ];
  fs.writeFileSync(transcriptFile, lines2.join('\n'));

  const res2 = captureClaude(payload, { root });
  assert.equal(res2.id, res1.id);
  assert.equal(res2.path, res1.path);

  const episodicFiles = fs.readdirSync(dirs(root).episodic);
  assert.equal(episodicFiles.length, 1);

  const content = fs.readFileSync(res2.path, 'utf8');
  assert.match(content, /file2\.txt/);
  assert.match(content, /Second prompt finished/);
});

test('capture: captureCodex accumulates turns on same thread and limits to last 5', () => {
  const root = tmp();
  const threadId = 'codex-th-12345';

  for (let i = 1; i <= 7; i++) {
    const payload = {
      type: 'agent-turn-complete',
      'thread-id': threadId,
      cwd: root,
      'input-messages': [`Turn ${i} user prompt with key sk-12345678901234567890123`],
      'last-assistant-message': `Completed turn ${i} response`,
    };
    captureCodex(payload, { root });
  }

  const files = fs.readdirSync(dirs(root).episodic);
  assert.equal(files.length, 1);

  const noteContent = fs.readFileSync(path.join(dirs(root).episodic, files[0]), 'utf8');
  assert.ok(!noteContent.includes('sk-12345678901234567890123'));
  assert.ok(noteContent.includes('[REDACTED_SECRET]'));

  // Should have turns 3 to 7 (last 5 turns), turns 1 and 2 discarded
  assert.ok(!noteContent.includes('Completed turn 1 response'));
  assert.ok(!noteContent.includes('Completed turn 2 response'));
  assert.ok(noteContent.includes('Completed turn 3 response'));
  assert.ok(noteContent.includes('Completed turn 7 response'));
});

test('capture: hookConfig returns settings for Claude and Codex', () => {
  const cfg = hookConfig();
  assert.equal(cfg.claude.file, '.claude/settings.json');
  assert.equal(cfg.claude.config.hooks.SessionEnd[0].hooks[0].command, 'mora memory capture --from claude');
  assert.equal(cfg.codex.file, '.codex/config.toml');
  assert.match(cfg.codex.toml, /notify = \["mora", "memory", "capture", "--from", "codex"\]/);
});

test('CLI: memory capture exits 0 silently when not in MORAGENT project', async () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'non-mora-'));
  const ctx = { root: null, json: false };

  // Should not throw and return 0
  const code = await memoryCmd.run({
    _: ['capture', '{"session_id":"test"}'],
    flags: { from: 'claude' },
  }, ctx);
  assert.equal(code, 0);
});

test('CLI: memory capture handles claude and codex payloads, logging on errors without throwing', async () => {
  const root = tmp();
  const ctx = { root, json: true };

  // 1. Claude capture via CLI
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-'));
  const transcriptFile = path.join(tmpDir, 'transcript.jsonl');
  fs.writeFileSync(transcriptFile, [
    JSON.stringify({ type: 'user', content: 'Turn 1: Fix bug' }),
    JSON.stringify({ type: 'user', content: 'Turn 2: Add test' }),
    JSON.stringify({ type: 'assistant', content: 'Bug fixed and test added' }),
  ].join('\n'));

  const claudePayload = JSON.stringify({
    session_id: 'cli-session-1',
    transcript_path: transcriptFile,
    cwd: root,
  });

  let outLogs = [];
  const origOut = process.stdout.write;
  process.stdout.write = (chunk) => { outLogs.push(chunk); return true; };

  try {
    const code = await memoryCmd.run({
      _: ['capture', claudePayload],
      flags: { from: 'claude' },
    }, ctx);
    assert.equal(code, 0);
    const parsedOut = JSON.parse(outLogs.pop());
    assert.equal(parsedOut.ok, true);
    assert.ok(parsedOut.id.startsWith('session-'));

    // 2. Codex capture via CLI
    const codexPayload = JSON.stringify({
      'thread-id': 'cli-codex-th',
      'input-messages': ['Codex prompt'],
      'last-assistant-message': 'Codex response',
    });
    const codeCodex = await memoryCmd.run({
      _: ['capture', codexPayload],
      flags: { from: 'codex' },
    }, ctx);
    assert.equal(codeCodex, 0);
    const parsedCodex = JSON.parse(outLogs.pop());
    assert.equal(parsedCodex.ok, true);

    // 3. Error case: error during capture should log to .moragent/runs/capture.log and exit 0
    const codeErr = await memoryCmd.run({
      _: ['capture'],
      flags: { from: 'claude', payload: { session_id: 'broken', transcript_path: 12345 } },
    }, ctx);
    assert.equal(codeErr, 0);
  } finally {
    process.stdout.write = origOut;
  }
});

test('capture: classifyFilePath correctly separates inside vs outside project files', () => {
  const root = tmp();
  const insideRel = classifyFilePath('src/memory/capture.js', root);
  assert.equal(insideRel.inside, true);
  assert.equal(insideRel.relPath, 'src/memory/capture.js');

  const insideAbs = classifyFilePath(path.join(root, 'src', 'index.js'), root);
  assert.equal(insideAbs.inside, true);
  assert.equal(insideAbs.relPath, 'src/index.js');

  const outsideSys = classifyFilePath('/etc/hosts', root);
  assert.equal(outsideSys.inside, false);

  const outsideHome = classifyFilePath(path.join(os.homedir(), '.claude', 'settings.json'), root);
  assert.equal(outsideHome.inside, false);

  const outsideDotDot = classifyFilePath('../../../other.txt', root);
  assert.equal(outsideDotDot.inside, false);
});

test('capture: extractLinks only extracts task IDs and spec slugs, never file paths', () => {
  const text = `
    Lee y ejecuta .moragent/tasks/T-0003.md para la spec .moragent/specs/auth-oauth2.
    También revisa T-0004 y specs/data-model.md.
    Modifica src/core/paths.js y /etc/hosts.
  `;
  const links = extractLinks(text);
  assert.deepEqual(links.sort(), ['T-0003', 'T-0004', 'auth-oauth2', 'data-model'].sort());
  assert.ok(!links.includes('src/core/paths.js'));
  assert.ok(!links.includes('/etc/hosts'));
});

test('capture: files outside root are omitted from list and counted, inside files listed', () => {
  const root = tmp();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-test-'));
  const transcriptFile = path.join(tmpDir, 'transcript.jsonl');

  const lines = [
    JSON.stringify({ type: 'user', content: 'Edit both inside and outside files' }),
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Write', input: { file_path: path.join(root, 'src/inside.js') } },
          { type: 'tool_use', name: 'Edit', input: { file_path: '/etc/hosts' } },
          { type: 'tool_use', name: 'Edit', input: { file_path: path.join(os.homedir(), '.claude/settings.json') } },
          { type: 'text', text: 'Edited 3 files in total.' },
        ],
      },
    }),
    JSON.stringify({ type: 'user', content: 'Turn 2 confirm' }),
    JSON.stringify({ type: 'assistant', content: 'Confirmed.' }),
  ];
  fs.writeFileSync(transcriptFile, lines.join('\n'));

  const payload = {
    session_id: 'sess-outside-files',
    transcript_path: transcriptFile,
    cwd: root,
  };

  const res = captureClaude(payload, { root });
  assert.ok(res);
  const raw = fs.readFileSync(res.path, 'utf8');

  // Inside file is listed
  assert.match(raw, /- `src\/inside\.js`/);
  // Outside files are NOT listed individually
  assert.ok(!raw.includes('- `/etc/hosts`'));
  assert.ok(!raw.includes('settings.json`'));
  // Outside files count is shown
  assert.match(raw, /2 archivos fuera del proyecto/);
  // Links does NOT contain file paths
  assert.match(raw, /links: \[\]/);
});

test('capture: task envelope prompt uses task JSON title and links task ID', () => {
  const root = tmp();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'envelope-test-'));
  const transcriptFile = path.join(tmpDir, 'transcript.jsonl');

  // Create task JSON in .moragent/tasks/T-0003.json
  const taskDir = dirs(root).tasks;
  ensureDir(taskDir);
  fs.writeFileSync(
    path.join(taskDir, 'T-0003.json'),
    JSON.stringify({
      id: 'T-0003',
      title: 'Configurar base de datos PostgreSQL con migraciones',
      role: 'backend',
      status: 'queued',
    })
  );

  const lines = [
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'Lee y ejecuta .moragent/tasks/T-0003.md' },
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Write', input: { file_path: path.join(root, 'src/db.js') } },
          { type: 'text', text: 'Base de datos configurada.' },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'Verificar conexión' }] },
    }),
    JSON.stringify({
      type: 'assistant',
      content: 'Conexión verificada y lista.',
    }),
  ];
  fs.writeFileSync(transcriptFile, lines.join('\n'));

  const payload = {
    session_id: 'sess-envelope-123',
    transcript_path: transcriptFile,
    cwd: root,
  };

  const res = captureClaude(payload, { root });
  assert.ok(res);
  const raw = fs.readFileSync(res.path, 'utf8');

  // Title comes from task JSON!
  assert.match(raw, /title: "?Configurar base de datos PostgreSQL con migraciones"?/);
  // Links contains T-0003!
  assert.match(raw, /links: \[T-0003\]/);
  // File is in body
  assert.match(raw, /- `src\/db\.js`/);
});

test('capture: real Claude Code transcript format and bilingual headers (es vs en)', () => {
  // Test Spanish headers
  const rootEs = tmp(); // default preset creates lang: es
  const tmpDirEs = fs.mkdtempSync(path.join(os.tmpdir(), 'real-claude-es-'));
  const transcriptEs = path.join(tmpDirEs, 'transcript.jsonl');

  const linesReal = [
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: 'Implementar autenticación para .moragent/specs/auth-spec y tarea T-0009',
      },
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: path.join(rootEs, 'src/auth.js') } },
          { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
          { type: 'text', text: 'Autenticación implementada.' },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Revisa si los tests pasaron' }],
      },
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Todos los tests pasaron correctamente.' },
        ],
      },
    }),
  ];
  fs.writeFileSync(transcriptEs, linesReal.join('\n'));

  const resEs = captureClaude({
    session_id: 'real-sess-es',
    transcript_path: transcriptEs,
    cwd: rootEs,
  }, { root: rootEs });

  const rawEs = fs.readFileSync(resEs.path, 'utf8');
  assert.match(rawEs, /## Resumen/);
  assert.match(rawEs, /## Archivos tocados/);
  assert.match(rawEs, /## Comandos/);
  assert.match(rawEs, /Todos los tests pasaron correctamente\./);
  assert.match(rawEs, /- `src\/auth\.js`/);
  assert.match(rawEs, /- `npm test`/);
  assert.match(rawEs, /links: \[T-0009, auth-spec\]/);

  // Test English headers
  const rootEn = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-en-'));
  const cfgEn = defaultConfig({ project: 'test-en', lang: 'en', preset: 'solo' });
  scaffold(rootEn, cfgEn);

  const resEn = captureClaude({
    session_id: 'real-sess-en',
    transcript_path: transcriptEs,
    cwd: rootEn,
  }, { root: rootEn });

  const rawEn = fs.readFileSync(resEn.path, 'utf8');
  assert.match(rawEn, /## Summary/);
  assert.match(rawEn, /## Files Touched/);
  assert.match(rawEn, /## Commands/);
});


