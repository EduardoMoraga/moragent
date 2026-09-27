import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENV_MAP = {
  anthropic: () => process.env.ANTHROPIC_API_KEY,
  openai: () => process.env.OPENAI_API_KEY,
  openrouter: () => process.env.OPENROUTER_API_KEY,
  google: () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
  ollama: () => process.env.OLLAMA_HOST,
};

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

function readCredentialsFile() {
  const file = getCredentialsPath();
  try {
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeCredentialsFile(data) {
  const dir = getCredentialsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = getCredentialsPath();
  const text = JSON.stringify(data, null, 2) + '\n';
  fs.writeFileSync(file, text, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Ignore chmod errors on platforms that do not support POSIX modes
  }
}

export function getKey(id) {
  if (!id) return null;
  const envGetter = ENV_MAP[id];
  if (envGetter) {
    const envVal = envGetter();
    if (envVal && typeof envVal === 'string' && envVal.trim()) {
      return envVal.trim();
    }
  }
  const fileData = readCredentialsFile();
  if (fileData && typeof fileData[id] === 'string' && fileData[id].trim()) {
    return fileData[id].trim();
  }
  return null;
}

export function setKey(id, value) {
  if (!id) return;
  const data = readCredentialsFile();
  data[id] = String(value ?? '');
  writeCredentialsFile(data);
}

export function removeKey(id) {
  if (!id) return;
  const data = readCredentialsFile();
  if (id in data) {
    delete data[id];
    writeCredentialsFile(data);
  }
}

export function listKeys() {
  const known = ['anthropic', 'openai', 'openrouter', 'google', 'ollama'];
  const fileData = readCredentialsFile();
  const allIds = new Set([...known, ...Object.keys(fileData)]);
  const results = [];

  for (const id of allIds) {
    const envGetter = ENV_MAP[id];
    const envVal = envGetter ? envGetter() : null;
    if (envVal && typeof envVal === 'string' && envVal.trim()) {
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
