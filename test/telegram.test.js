import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramBridge, acquireTelegramListenerLock, allowedTelegramIds, telegramBotLockFile, telegramStateFile } from '../src/telegram/bridge.js';
import { retryDelay } from '../src/commands/telegram.js';

const TOKEN = '123456:' + 'a'.repeat(32);

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-telegram-'));
  const calls = [];
  const engine = { store: { state: { messages: [] } }, async send(text) {
    calls.push(['engine', text]);
    this.store.state.messages.push({ from: 'user', text }, { from: 'orchestrator', text: `Resultado: ${text}` });
  } };
  const fetchImpl = async (url, options) => {
    const method = url.split('/').at(-1);
    const body = JSON.parse(options.body);
    calls.push([method, body]);
    return { ok: true, async json() { return { ok: true, result: method === 'getUpdates' ? [] : {} }; } };
  };
  const bridge = new TelegramBridge({ token: TOKEN, allowedIds: allowedTelegramIds('42'), projectId: 'p-test', engine, fetchImpl, stateFile: path.join(dir, 'state.json') });
  return { dir, calls, engine, bridge };
}

test('Telegram bridge accepts only allowlisted private messages and does not execute duplicates', async () => {
  const h = fixture();
  try {
    const update = (id, actor, type = 'private') => ({ update_id: id, message: { from: { id: actor }, chat: { id: actor, type }, text: 'Investiga este tema' } });
    assert.equal(await h.bridge.handleUpdate(update(1, 9)), false);
    assert.equal(await h.bridge.handleUpdate(update(2, 42, 'group')), false);
    assert.equal(await h.bridge.handleUpdate(update(3, 42)), true);
    assert.equal(await h.bridge.handleUpdate(update(3, 42)), false);
    assert.deepEqual(h.calls.filter(([method]) => method === 'engine'), [['engine', 'Investiga este tema']]);
    assert.deepEqual(h.calls.filter(([method]) => method === 'sendMessage').map(([, body]) => body), [
      { chat_id: 42, text: 'MORAGENT · p-test\nSolicitud recibida.' },
      { chat_id: 42, text: 'Resultado: Investiga este tema' },
    ]);
    const resumed = new TelegramBridge({ token: TOKEN, allowedIds: new Set(['42']), projectId: 'p-test', engine: h.engine, fetchImpl: h.bridge.fetchImpl, stateFile: h.bridge.stateFile });
    assert.equal(await resumed.handleUpdate(update(3, 42)), false);
    await resumed.pollOnce();
    assert.equal(h.calls.findLast(([method]) => method === 'getUpdates')[1].offset, 4);
  } finally { fs.rmSync(h.dir, { recursive: true, force: true }); }
});

test('Telegram bridge requires a numeric allowlist and splits long replies', async () => {
  assert.throws(() => allowedTelegramIds(''), (error) => error.code === 'TELEGRAM_ALLOWLIST_REQUIRED');
  assert.throws(() => allowedTelegramIds('someone'), (error) => error.code === 'TELEGRAM_ALLOWLIST_REQUIRED');
  const h = fixture();
  try {
    h.engine.send = async () => { h.engine.store.state.messages.push({ from: 'orchestrator', text: '😀'.repeat(4500) }); };
    await h.bridge.handleUpdate({ update_id: 1, message: { from: { id: 42 }, chat: { id: 42, type: 'private' }, text: 'Resume' } });
    const parts = h.calls.filter(([method]) => method === 'sendMessage').map(([, body]) => body.text).slice(1);
    assert.equal(parts.length, 2);
    assert.equal(parts.join(''), '😀'.repeat(4500));
    assert.ok(parts.every((part) => Array.from(part).length <= 4000));
  } finally { fs.rmSync(h.dir, { recursive: true, force: true }); }
});

test('an interrupted Telegram request is reported without executing it a second time', async () => {
  const h = fixture();
  try {
    h.engine.send = async () => { throw new Error('worker interrupted'); };
    await assert.rejects(h.bridge.handleUpdate({ update_id: 7, message: { from: { id: 42 }, chat: { id: 42, type: 'private' }, text: 'Do work' } }));
    const resumed = new TelegramBridge({ token: TOKEN, allowedIds: new Set(['42']), projectId: 'p-test', engine: h.engine, fetchImpl: h.bridge.fetchImpl, stateFile: h.bridge.stateFile });
    assert.equal(await resumed.recoverPending(), true);
    assert.equal(await resumed.recoverPending(), false);
    assert.equal(resumed.state.lastCompleted, 7);
    assert.match(h.calls.findLast(([method]) => method === 'sendMessage')[1].text, /estado es incierto/);
  } finally { fs.rmSync(h.dir, { recursive: true, force: true }); }
});

test('network errors do not expose the Telegram token', async () => {
  const h = fixture();
  try {
    h.bridge.fetchImpl = async () => { throw new Error(`request failed: https://api.telegram.org/bot${TOKEN}/getUpdates`); };
    await assert.rejects(h.bridge.pollOnce(), (error) => error.code === 'TELEGRAM_API' && !error.message.includes(TOKEN));
  } finally { fs.rmSync(h.dir, { recursive: true, force: true }); }
});

test('Telegram distinguishes permanent API errors and cancels retry waits promptly', async () => {
  const h = fixture();
  try {
    h.bridge.fetchImpl = async () => ({ ok: false, status: 401, async json() { return { ok: false, description: 'Unauthorized' }; } });
    await assert.rejects(h.bridge.pollOnce(), { code: 'TELEGRAM_API_CONFIG' });
    const controller = new AbortController();
    const started = Date.now();
    const waiting = retryDelay(10000, controller.signal);
    controller.abort();
    await waiting;
    assert.ok(Date.now() - started < 1000);
  } finally { fs.rmSync(h.dir, { recursive: true, force: true }); }
});

test('only one Telegram listener can own a bot and project at a time', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-telegram-lock-'));
  try {
    const file = path.join(dir, 'state.json');
    const release = acquireTelegramListenerLock(file);
    assert.throws(() => acquireTelegramListenerLock(file), (error) => error.code === 'TELEGRAM_ALREADY_RUNNING');
    release();
    const next = acquireTelegramListenerLock(file);
    next();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('one bot has one cursor and one listener across project switches', () => {
  assert.equal(telegramStateFile(TOKEN, 'one'), telegramStateFile(TOKEN, 'two'));
  assert.equal(telegramBotLockFile(TOKEN), telegramBotLockFile(TOKEN));
  assert.notEqual(telegramBotLockFile(TOKEN), telegramBotLockFile('654321:' + 'b'.repeat(32)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-telegram-bot-lock-'));
  try {
    const release = acquireTelegramListenerLock(path.join(dir, 'bot.lock'));
    assert.throws(() => acquireTelegramListenerLock(path.join(dir, 'bot.lock')), { code: 'TELEGRAM_ALREADY_RUNNING' });
    release();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Telegram recovery respects the current allowlist and keeps pending work in its original project', async () => {
  const h = fixture();
  try {
    fs.writeFileSync(h.bridge.stateFile, JSON.stringify({ projectId: 'p-test', lastStarted: 7, lastCompleted: 6, pendingChatId: 42 }));
    assert.throws(() => new TelegramBridge({ token: TOKEN, allowedIds: new Set(['42']), projectId: 'other', engine: h.engine, fetchImpl: h.bridge.fetchImpl, stateFile: h.bridge.stateFile }), { code: 'TELEGRAM_PENDING_PROJECT' });
    const resumed = new TelegramBridge({ token: TOKEN, allowedIds: new Set(['9']), projectId: 'p-test', engine: h.engine, fetchImpl: h.bridge.fetchImpl, stateFile: h.bridge.stateFile });
    assert.equal(await resumed.recoverPending(), true);
    assert.equal(resumed.state.lastCompleted, 7);
    assert.equal(h.calls.filter(([method]) => method === 'sendMessage').length, 0);
    const switched = new TelegramBridge({ token: TOKEN, allowedIds: new Set(['9']), projectId: 'other', engine: h.engine, fetchImpl: h.bridge.fetchImpl, stateFile: h.bridge.stateFile });
    assert.equal(switched.state.lastStarted, 7);
  } finally { fs.rmSync(h.dir, { recursive: true, force: true }); }
});
