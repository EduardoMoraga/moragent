import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { t } from '../../core/i18n.js';

let spawnImpl = nodeSpawn;

export const setSpawn = (fake) => { spawnImpl = fake; };
export const resetSpawn = () => { spawnImpl = nodeSpawn; };

export const summary = (value) => {
  const raw = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return raw.replace(/\s+/g, ' ').trim().slice(0, 200);
};

export const usageEvent = (usage = {}, costUsd = null) => ({
  type: 'usage',
  input: usage.input_tokens ?? usage.input ?? null,
  output: usage.output_tokens ?? usage.output ?? null,
  costUsd: costUsd ?? usage.cost_usd ?? usage.cost?.total ?? null,
});

function prepareLog(logFile) {
  if (!logFile) return () => {};
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  return (chunk) => fs.appendFileSync(logFile, chunk);
}

export async function runStream({
  provider, command, args, root, model = null, signal, onEvent, logFile, parser,
}) {
  const state = {
    provider,
    model,
    sessionId: null,
    text: '',
    finalText: null,
    usage: null,
    ok: null,
    error: null,
    started: false,
  };
  let child;
  let stderr = '';
  let buffer = '';
  let settled = false;
  let aborted = !!signal?.aborted;
  let writeLog;

  const emit = (event) => {
    if (!event) return;
    if (event.type === 'start') {
      if (state.started) return;
      state.started = true;
      state.sessionId = event.sessionId ?? state.sessionId;
      state.model = event.model ?? state.model;
      event = {
        type: 'start', sessionId: state.sessionId, provider, model: state.model,
      };
    } else if (event.type === 'text') {
      state.text += event.delta || '';
    } else if (event.type === 'usage') {
      state.usage = {
        input: event.input ?? null,
        output: event.output ?? null,
        costUsd: event.costUsd ?? null,
      };
    } else if (event.type === 'tool_result') {
      event = { ...event, summary: summary(event.summary) };
    }
    try { onEvent?.(event); } catch { /* consumer callbacks do not own the process */ }
  };

  const acceptLine = (line) => {
    const clean = line.trim();
    if (!clean) return;
    let record;
    try { record = JSON.parse(clean); } catch { return; }
    let events;
    try { events = parser(record, state) || []; } catch { return; }
    for (const event of Array.isArray(events) ? events : [events]) emit(event);
  };

  const acceptChunk = (chunk) => {
    writeLog(chunk);
    buffer += chunk.toString('utf8');
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) acceptLine(line);
  };

  const result = await new Promise((resolve) => {
    const finish = (code, spawnError = null) => {
      if (settled) return;
      settled = true;
      if (buffer) acceptLine(buffer);
      if (!state.started) emit({ type: 'start', sessionId: state.sessionId, model: state.model });
      const ok = !aborted && !spawnError && code === 0 && state.ok !== false;
      const text = state.finalText ?? state.text;
      const error = ok ? null : state.error || (aborted
        ? t('Ejecución cancelada.', 'Run cancelled.')
        : spawnError?.message || stderr.trim() || t(`El CLI terminó con código ${code}.`, `CLI exited with code ${code}.`));
      const done = { type: 'done', ok, text, sessionId: state.sessionId, error };
      emit(done);
      const value = { ok, text, sessionId: state.sessionId, usage: state.usage };
      if (!ok) value.error = error;
      resolve(value);
    };

    try {
      writeLog = prepareLog(logFile);
      child = spawnImpl(command, args, {
        cwd: root,
        // MORAGENT_ENGINE marks engine-driven runs: session hooks skip them and the engine closes tasks.
        env: { ...process.env, MORAGENT_ROLE: process.env.MORAGENT_ROLE || provider, MORAGENT_ENGINE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish(127, error);
      return;
    }

    const abort = () => {
      aborted = true;
      try { child.kill('SIGTERM'); } catch { /* it may already be gone */ }
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (aborted) abort();

    child.stdout?.on('data', acceptChunk);
    child.stderr?.on('data', (chunk) => {
      writeLog(chunk);
      stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => finish(127, error));
    child.once('close', (code) => {
      signal?.removeEventListener('abort', abort);
      finish(code ?? 1);
    });
  });

  return result;
}

