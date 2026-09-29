import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const ENV_MAP = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  ollama: ['OLLAMA_HOST'],
  compatible: ['MORAGENT_COMPATIBLE_API_KEY'],
};

export function getKeyEnvironment(id) {
  return ENV_MAP[id]?.find((name) => typeof process.env[name] === 'string' && process.env[name].trim()) || null;
}

export function getEndpointEnvironment(id) {
  return id === 'compatible' && process.env.MORAGENT_COMPATIBLE_BASE_URL?.trim() ? 'MORAGENT_COMPATIBLE_BASE_URL' : null;
}

export function getCredentialsDir() {
  if (process.env.MORAGENT_HOME) {
    const mh = path.resolve(process.env.MORAGENT_HOME);
    if (path.basename(mh) === '.moragent' || fs.existsSync(path.join(mh, 'credentials.json'))) {
      return mh;
    }
    const sub = path.join(mh, '.moragent');
    if (fs.existsSync(sub)) {
      return sub;
    }
    return mh;
  }
  return path.join(os.homedir(), '.moragent');
}

export function getCredentialsPath() {
  return path.join(getCredentialsDir(), 'credentials.json');
}

export function maskKey(val) {
  if (!val || typeof val !== 'string') return '';
  const s = val.trim();
  if (s.length <= 4) return '…' + s.slice(-2);
  if (s.startsWith('sk-')) {
    return 'sk-…' + s.slice(-4);
  }
  if (s.length <= 8) {
    return s.slice(0, 1) + '…' + s.slice(-2);
  }
  return s.slice(0, 3) + '…' + s.slice(-4);
}

function readCredentialsFile({ forWrite = false } = {}) {
  const file = getCredentialsPath();
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid credentials format');
    return data;
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    if (forWrite) throw new Error('Cannot update credentials: the existing credentials.json is unreadable or invalid. Repair or back it up first.');
    return {};
  }
}

function writeCredentialsFile(data) {
  const dir = getCredentialsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = getCredentialsPath();
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const text = JSON.stringify(data, null, 2) + '\n';
  try {
    fs.writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Ignore chmod errors on platforms that do not support POSIX modes
    }
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
}

export function getKey(id) {
  if (!id) return null;
  const envName = getKeyEnvironment(id);
  if (envName) return process.env[envName].trim();
  const fileData = readCredentialsFile();
  if (fileData && typeof fileData[id] === 'string' && fileData[id].trim()) {
    return fileData[id].trim();
  }
  return null;
}

export function setKey(id, value) {
  if (!id) return;
  const data = readCredentialsFile({ forWrite: true });
  data[id] = String(value ?? '');
  writeCredentialsFile(data);
}

export function getEndpoint(id) {
  const envName = getEndpointEnvironment(id);
  if (envName) return process.env[envName].trim();
  return readCredentialsFile().endpoints?.[id] || null;
}

export function setEndpoint(id, value) {
  const url = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Endpoint must be an HTTP(S) URL without embedded credentials');
  const data = readCredentialsFile({ forWrite: true });
  data.endpoints = { ...(data.endpoints || {}), [id]: url.toString().replace(/\/+$/, '') };
  writeCredentialsFile(data);
}

export function removeKey(id) {
  if (!id) return;
  const data = readCredentialsFile({ forWrite: true });
  if (id in data) {
    delete data[id];
    writeCredentialsFile(data);
  }
}

export function listKeys() {
  const known = ['anthropic', 'openai', 'openrouter', 'google', 'ollama', 'compatible'];
  const fileData = readCredentialsFile();
  const allIds = new Set([...known, ...Object.keys(fileData)]);
  const results = [];

  for (const id of allIds) {
    const envName = getKeyEnvironment(id);
    if (envName) {
      const envVal = process.env[envName];
      results.push({
        id,
        source: 'env',
        masked: maskKey(envVal.trim()),
      });
      continue;
    }
    const fileVal = fileData[id];
    if (fileVal && typeof fileVal === 'string' && fileVal.trim()) {
      results.push({
        id,
        source: 'file',
        masked: maskKey(fileVal.trim()),
      });
    }
  }

  return results.sort((a, b) => a.id.localeCompare(b.id));
}
