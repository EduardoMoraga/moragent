import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJSON, writeJSON } from '../core/fsx.js';

const MAX_MESSAGES = 500;
const VALID_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

const sessionsDir = (root) => path.join(root, '.moragent', 'sessions');

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));

function isSession(value, expectedId = null) {
  return isObject(value)
    && typeof value.id === 'string'
    && VALID_ID.test(value.id)
    && (!expectedId || value.id === expectedId)
    && typeof value.title === 'string'
    && validDate(value.createdAt)
    && validDate(value.updatedAt)
    && (value.provider === null || typeof value.provider === 'string')
    && (value.providerSessionId === null || typeof value.providerSessionId === 'string')
    && Array.isArray(value.messages)
    && isObject(value.agents);
}

function titleFrom(messages) {
  const first = messages.find((message) => message?.from === 'user' || message?.role === 'user');
  const text = typeof first?.text === 'string' ? first.text : '';
  return [...text.replace(/\s+/g, ' ').trim()].slice(0, 60).join('');
}

function nextUpdatedAt(previous) {
  const now = Date.now();
  const before = Date.parse(previous || '');
  return new Date(Number.isFinite(before) && before >= now ? before + 1 : now).toISOString();
}

function sessionIds(root) {
  try {
    return fs.readdirSync(sessionsDir(root), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.slice(0, -5));
  } catch {
    return [];
  }
}

function resolveId(root, id) {
  const wanted = String(id || '');
  if (!VALID_ID.test(wanted)) return null;
  const ids = sessionIds(root);
  if (ids.includes(wanted)) return wanted;
  const matches = ids.filter((candidate) => candidate.startsWith(wanted));
  return matches.length === 1 ? matches[0] : null;
}

export function createSession(root, { title = '', provider = null } = {}) {
  const dir = ensureDir(sessionsDir(root));
  let id;
  do { id = randomUUID(); } while (fs.existsSync(path.join(dir, `${id}.json`)));
  const at = new Date().toISOString();
  const session = {
    id,
    title: typeof title === 'string' ? title : '',
    createdAt: at,
    updatedAt: at,
    provider: typeof provider === 'string' ? provider : null,
    providerSessionId: null,
    messages: [],
    agents: {},
  };
  writeJSON(path.join(dir, `${id}.json`), session);
  return session;
}

export function saveSession(root, session) {
  if (!isObject(session) || typeof session.id !== 'string' || !VALID_ID.test(session.id)) {
    throw new TypeError('A session with a valid id is required');
  }
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const now = nextUpdatedAt(session.updatedAt);
  const next = {
    ...session,
    title: typeof session.title === 'string' && session.title.trim()
      ? session.title
      : titleFrom(messages),
    createdAt: validDate(session.createdAt) ? session.createdAt : now,
    updatedAt: now,
    provider: typeof session.provider === 'string' ? session.provider : null,
    providerSessionId: typeof session.providerSessionId === 'string' ? session.providerSessionId : null,
    messages: messages.slice(-MAX_MESSAGES),
    agents: isObject(session.agents) ? session.agents : {},
  };
  writeJSON(path.join(sessionsDir(root), `${next.id}.json`), next);
  return next;
}

export function loadSession(root, id) {
  const resolved = resolveId(root, id);
  if (!resolved) return null;
  const session = readJSON(path.join(sessionsDir(root), `${resolved}.json`), null);
  return isSession(session, resolved) ? session : null;
}

export function listSessions(root) {
  const sessions = [];
  for (const id of sessionIds(root)) {
    const session = readJSON(path.join(sessionsDir(root), `${id}.json`), null);
    if (!isSession(session, id)) continue;
    sessions.push({
      id: session.id,
      title: session.title,
      updatedAt: session.updatedAt,
      messages: session.messages.length,
      provider: session.provider,
    });
  }
  return sessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
}

export function latestSession(root) {
  const latest = listSessions(root)[0];
  return latest ? loadSession(root, latest.id) : null;
}

export function deleteSession(root, id) {
  const resolved = resolveId(root, id);
  if (!resolved) return false;
  try {
    fs.unlinkSync(path.join(sessionsDir(root), `${resolved}.json`));
    return true;
  } catch {
    return false;
  }
}
