import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MoragentError } from '../core/errors.js';

const API = 'https://api.telegram.org';
const MAX_MESSAGE = 4000;

export function telegramStateFile(token) {
  const home = process.env.MORAGENT_HOME?.trim();
  const key = createHash('sha256').update(token).digest('hex').slice(0, 24);
  return path.join(home ? path.resolve(home) : path.join(os.homedir(), '.moragent'), 'telegram', `${key}.json`);
}

export function telegramBotLockFile(token) {
  return `${telegramStateFile(token)}.lock`;
}

export function acquireTelegramListenerLock(stateFile) {
  const file = stateFile;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => {
        try { if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file); } catch { /* already released */ }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const owner = Number(fs.readFileSync(file, 'utf8'));
      if (Number.isSafeInteger(owner) && owner > 0) {
        try { process.kill(owner, 0); } catch (probe) {
          if (probe?.code === 'ESRCH') { fs.unlinkSync(file); continue; }
        }
      }
      throw new MoragentError('TELEGRAM_ALREADY_RUNNING', 'A Telegram listener is already running for this bot.');
    }
  }
  throw new MoragentError('TELEGRAM_ALREADY_RUNNING', 'Could not acquire the Telegram listener lock.');
}

function readState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Number.isSafeInteger(state.lastStarted) && state.lastStarted >= 0 &&
        Number.isSafeInteger(state.lastCompleted) && state.lastCompleted >= 0) return state;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new MoragentError('BAD_TELEGRAM_STATE', `Cannot read Telegram state: ${file}`);
  }
  return { lastStarted: 0, lastCompleted: 0 };
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function chunks(text) {
  const chars = Array.from(String(text || ''));
  const out = [];
  for (let i = 0; i < chars.length; i += MAX_MESSAGE) out.push(chars.slice(i, i + MAX_MESSAGE).join(''));
  return out.length ? out : ['(sin respuesta)'];
}

export function allowedTelegramIds(value) {
  const ids = String(value || '').split(',').map((id) => id.trim()).filter(Boolean);
  if (!ids.length || ids.some((id) => !/^\d+$/.test(id))) throw new MoragentError('TELEGRAM_ALLOWLIST_REQUIRED', 'Set MORAGENT_TELEGRAM_ALLOWED_IDS to numeric user IDs separated by commas.');
  return new Set(ids);
}

export function assertTelegramToken(token) {
  if (typeof token !== 'string' || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
    throw new MoragentError('TELEGRAM_TOKEN_REQUIRED', 'Set MORAGENT_TELEGRAM_BOT_TOKEN.');
  }
  return token;
}

export class TelegramBridge {
  constructor({ token, allowedIds, projectId, engine, fetchImpl = globalThis.fetch, stateFile } = {}) {
    assertTelegramToken(token);
    if (!projectId || !engine?.send) throw new MoragentError('TELEGRAM_PROJECT_REQUIRED', 'Select a registered MORAGENT project.');
    this.token = token;
    this.allowedIds = allowedIds instanceof Set ? allowedIds : allowedTelegramIds(allowedIds);
    this.projectId = projectId;
    this.engine = engine;
    this.fetchImpl = fetchImpl;
    this.stateFile = stateFile || telegramStateFile(token);
    this.state = readState(this.stateFile);
    if (this.state.projectId && this.state.projectId !== projectId && this.state.lastStarted > this.state.lastCompleted) {
      throw new MoragentError('TELEGRAM_PENDING_PROJECT', `Telegram has an unfinished request for project ${this.state.projectId}. Resume that project first.`);
    }
    this.state.projectId = projectId;
    writeState(this.stateFile, this.state);
  }

  async api(method, body, signal) {
    let response;
    let data;
    try {
      response = await this.fetchImpl(`${API}/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
      });
      data = await response.json();
    } catch (error) {
      if (signal?.aborted) throw error;
      // Fetch errors can include the URL, which contains the bot token.
      throw new MoragentError('TELEGRAM_API', `Telegram ${method} could not connect.`);
    }
    if (!response.ok || data?.ok !== true) {
      const detail = String(data?.description || response.status).replaceAll(this.token, '[redacted]');
      const permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
      throw new MoragentError(permanent ? 'TELEGRAM_API_CONFIG' : 'TELEGRAM_API', `Telegram ${method} failed: ${detail}`);
    }
    return data.result;
  }

  async send(chatId, text, signal) {
    for (const part of chunks(text)) await this.api('sendMessage', { chat_id: chatId, text: part }, signal);
  }

  async handleUpdate(update, signal) {
    const id = update?.update_id;
    if (!Number.isSafeInteger(id) || id < 0) return false;
    if (id <= this.state.lastStarted) return false;
    const message = update.message;
    const actor = message?.from?.id;
    const chat = message?.chat;
    // The bridge only serves allowlisted people in private chats. Ignore all
    // other update kinds without feeding their content to the engine.
    if (!Number.isSafeInteger(actor) || !this.allowedIds.has(String(actor)) || chat?.type !== 'private' || chat.id !== actor || typeof message.text !== 'string') {
      this.state.lastStarted = id;
      this.state.lastCompleted = id;
      writeState(this.stateFile, this.state);
      return false;
    }
    const request = message.text.trim();
    this.state.lastStarted = id;
    this.state.pendingChatId = chat.id;
    writeState(this.stateFile, this.state);
    if (!request) {
      this.state.lastCompleted = id;
      delete this.state.pendingChatId;
      writeState(this.stateFile, this.state);
      return false;
    }
    if (request === '/start' || request === '/help') {
      await this.send(chat.id, `MORAGENT · ${this.projectId}\nEnvía una solicitud para este proyecto.`, signal);
    } else {
      await this.send(chat.id, `MORAGENT · ${this.projectId}\nSolicitud recibida.`, signal);
      const before = this.engine.store?.state?.messages?.length || 0;
      await this.engine.send(request);
      const messages = (this.engine.store?.state?.messages || []).slice(before)
        .filter((item) => ['orchestrator', 'agent', 'system'].includes(item.from) && !item.streaming && item.text?.trim());
      const answer = messages.map((item) => item.text.trim()).join('\n\n') || 'La solicitud terminó sin una respuesta visible. Revisa la sesión local.';
      await this.send(chat.id, answer, signal);
    }
    this.state.lastCompleted = id;
    delete this.state.pendingChatId;
    writeState(this.stateFile, this.state);
    return true;
  }

  async recoverPending(signal) {
    if (this.state.lastStarted <= this.state.lastCompleted || !Number.isSafeInteger(this.state.pendingChatId)) return false;
    if (this.allowedIds.has(String(this.state.pendingChatId))) {
      await this.send(this.state.pendingChatId, 'MORAGENT se reinició durante una solicitud. Su estado es incierto; revisa la sesión local antes de repetirla.', signal);
    }
    this.state.lastCompleted = this.state.lastStarted;
    delete this.state.pendingChatId;
    writeState(this.stateFile, this.state);
    return true;
  }

  async pollOnce(signal) {
    const updates = await this.api('getUpdates', {
      offset: this.state.lastStarted + 1, limit: 1, timeout: 20, allowed_updates: ['message'],
    }, signal);
    for (const update of updates || []) await this.handleUpdate(update, signal);
    return updates?.length || 0;
  }
}
