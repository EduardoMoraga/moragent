import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig } from '../src/core/config.js';
import { scaffold } from '../src/commands/init.js';
import {
  createSession,
  deleteSession,
  latestSession,
  listSessions,
  loadSession,
  saveSession,
} from '../src/engine/sessions.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mora-sessions-'));
const sessionDir = (root) => path.join(root, '.moragent', 'sessions');

test('createSession persists the exact initial schema with an atomic JSON write', () => {
  const root = tmp();
  try {
    const session = createSession(root, { title: 'Mi sesión', provider: 'claude' });
    assert.match(session.id, /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
    assert.equal(session.title, 'Mi sesión');
    assert.equal(session.createdAt, session.updatedAt);
    assert.equal(session.provider, 'claude');
    assert.equal(session.providerSessionId, null);
    assert.deepEqual(session.messages, []);
    assert.deepEqual(session.agents, {});

    const entries = fs.readdirSync(sessionDir(root));
    assert.deepEqual(entries, [`${session.id}.json`]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sessionDir(root), entries[0]), 'utf8')), session);
    assert.equal(entries.some((name) => name.includes('.tmp')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('saveSession derives a bounded title before retaining the newest 500 messages', () => {
  const root = tmp();
  try {
    const session = createSession(root, { provider: 'codex' });
    const title = '  Diseña   una API de tareas con persistencia, autenticación y una documentación realmente extensa  ';
    const messages = Array.from({ length: 510 }, (_, index) => ({
      id: `m${index}`,
      from: index === 0 ? 'user' : 'orchestrator',
      text: index === 0 ? title : `mensaje ${index}`,
    }));
    const saved = saveSession(root, {
      ...session,
      updatedAt: '2000-01-01T00:00:00.000Z',
      providerSessionId: 'thread-1',
      messages,
      agents: { backend: { id: 'backend', status: 'done' } },
    });

    assert.equal([...saved.title].length, 60);
    assert.equal(saved.title, [...title.replace(/\s+/g, ' ').trim()].slice(0, 60).join(''));
    assert.equal(saved.messages.length, 500);
    assert.equal(saved.messages[0].id, 'm10');
    assert.equal(saved.messages.at(-1).id, 'm509');
    assert.equal(saved.providerSessionId, 'thread-1');
    assert.deepEqual(saved.agents.backend, { id: 'backend', status: 'done' });
    assert.ok(Date.parse(saved.updatedAt) > Date.parse('2000-01-01T00:00:00.000Z'));
    assert.equal(messages.length, 510, 'saving does not mutate the caller array');
    assert.deepEqual(loadSession(root, session.id), saved);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('saveSession preserves an explicit title', () => {
  const root = tmp();
  try {
    const session = createSession(root, { title: 'Título elegido' });
    const saved = saveSession(root, {
      ...session,
      messages: [{ from: 'user', text: 'Este texto no debe reemplazar el título' }],
    });
    assert.equal(saved.title, 'Título elegido');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadSession accepts exact ids and only unique prefixes', () => {
  const root = tmp();
  try {
    const one = saveSession(root, {
      id: 'prefix-one', title: 'Uno', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      provider: null, providerSessionId: null, messages: [], agents: {},
    });
    saveSession(root, {
      id: 'prefix-two', title: 'Dos', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      provider: null, providerSessionId: null, messages: [], agents: {},
    });

    assert.deepEqual(loadSession(root, 'prefix-one'), one);
    assert.equal(loadSession(root, 'prefix-on').id, 'prefix-one');
    assert.equal(loadSession(root, 'prefix-'), null, 'ambiguous prefix is rejected');
    assert.equal(loadSession(root, '../prefix-one'), null, 'path traversal is rejected');
    assert.equal(loadSession(root, 'missing'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listSessions ignores corrupt sessions, returns counts and sorts by updatedAt', () => {
  const root = tmp();
  try {
    const older = createSession(root, { title: 'Anterior', provider: 'claude' });
    const newer = createSession(root, { title: 'Reciente', provider: 'codex' });
    const forcedNewest = saveSession(root, {
      ...older,
      updatedAt: '2100-01-01T00:00:00.000Z',
      messages: [{ from: 'user', text: 'hola' }, { from: 'orchestrator', text: 'hola' }],
    });
    saveSession(root, { ...newer, messages: [{ from: 'user', text: 'otra' }] });
    fs.writeFileSync(path.join(sessionDir(root), 'broken.json'), '{not-json');
    fs.writeFileSync(path.join(sessionDir(root), 'invalid.json'), JSON.stringify({ id: 'invalid' }));

    const listed = listSessions(root);
    assert.deepEqual(listed.map((session) => session.id), [forcedNewest.id, newer.id]);
    assert.deepEqual(listed[0], {
      id: forcedNewest.id,
      title: 'Anterior',
      updatedAt: forcedNewest.updatedAt,
      messages: 2,
      provider: 'claude',
    });
    assert.equal(latestSession(root).id, forcedNewest.id);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deleteSession supports exact and unique-prefix ids but rejects ambiguous prefixes', () => {
  const root = tmp();
  try {
    saveSession(root, {
      id: 'delete-one', title: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      provider: null, providerSessionId: null, messages: [], agents: {},
    });
    saveSession(root, {
      id: 'delete-two', title: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      provider: null, providerSessionId: null, messages: [], agents: {},
    });

    assert.equal(deleteSession(root, 'delete-'), false);
    assert.equal(deleteSession(root, 'delete-on'), true);
    assert.equal(loadSession(root, 'delete-one'), null);
    assert.equal(deleteSession(root, 'delete-two'), true);
    assert.equal(deleteSession(root, 'delete-two'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scaffold adds sessions/ to the generated local-state gitignore', () => {
  const root = tmp();
  try {
    const config = defaultConfig({ project: 'sessions', lang: 'es', preset: 'solo', clis: { lead: 'claude' } });
    scaffold(root, config);
    const lines = fs.readFileSync(path.join(root, '.moragent', '.gitignore'), 'utf8').trim().split('\n');
    assert.equal(lines.filter((line) => line === 'sessions/').length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

