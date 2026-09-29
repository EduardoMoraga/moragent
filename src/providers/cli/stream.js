import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import { DEFAULT_PRIVATE_LOG_MAX_BYTES, openPrivateLog, writeBoundedPrivateLog } from '../../core/private-log.js';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { t } from '../../core/i18n.js';
import { spawnPlan, terminateTree } from '../../core/exec.js';

let spawnImpl = nodeSpawn;
const DEFAULT_MAX_LINE_CHARS = 16 * 1024 * 1024;
const MAX_STDERR_CHARS = 64 * 1024;

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

const objectValues = (value) => {
  if (!value || typeof value !== 'object') return [];
  return [value, value.result, value.output, value.metadata, value.details]
    .filter((entry) => entry && typeof entry === 'object');
};

// Vendor tool events disagree on field casing and sometimes expose a terminal status alongside
// an exit code. The exit code is authoritative for commands; an explicit error/success flag comes
// next, then the terminal status. This keeps a completed command with exit code 0 out of the error
// path while still treating a non-zero exit as failed even if the surrounding step is "done".
export const resultOk = (value, fallback = true) => {
  const values = objectValues(value);
  for (const entry of values) {
    const raw = entry.exit_code ?? entry.exitCode ?? entry.code;
    if (raw !== undefined && raw !== null && raw !== '') {
      const code = Number(raw);
      if (Number.isFinite(code)) return code === 0;
    }
  }
  for (const entry of values) {
    const isError = entry.is_error ?? entry.isError;
    if (typeof isError === 'boolean') return !isError;
    if (typeof entry.success === 'boolean') return entry.success;
    if (entry.error) return false;
  }
  for (const entry of values) {
    const status = String(entry.status ?? '').trim().toLowerCase();
    if (['completed', 'success', 'succeeded', 'ok'].includes(status)) return true;
    if (['failed', 'failure', 'error', 'errored', 'cancelled', 'canceled', 'timed_out', 'timeout'].includes(status)) return false;
  }
  return fallback;
};

function prepareLog(logFile, maxLogBytes) {
  if (!logFile) return { write: () => {}, close: () => {} };
  let fd;
  try { fd = openPrivateLog(logFile); }
  catch { return { write: () => {}, close: () => {} }; }
  let writable = true;
  const close = () => {
    if (fd === undefined) return;
    try { fs.closeSync(fd); } catch { /* logging remains optional */ }
    fd = undefined;
  };
  return {
    write(chunk) {
      if (!writable) return;
      try { writeBoundedPrivateLog(fd, chunk, maxLogBytes); }
      catch { writable = false; close(); }
    },
    close,
  };
}

export async function runStream({
  provider, command, args, root, model = null, signal, onEvent, logFile, parser, maxLineChars, envOverrides,
  maxLogBytes = DEFAULT_PRIVATE_LOG_MAX_BYTES,
}) {
  const configuredLineLimit = Number(maxLineChars ?? process.env.MORAGENT_CLI_MAX_LINE_CHARS);
  const lineLimit = Number.isSafeInteger(configuredLineLimit) && configuredLineLimit > 0
    ? configuredLineLimit : DEFAULT_MAX_LINE_CHARS;
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
    requireFinalText: false,
    requireCompletion: false,
  };
  let child;
  let stderr = '';
  let buffer = '';
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  let settled = false;
  let aborted = !!signal?.aborted;
  let writeLog = () => {};
  let closeLog = () => {};
  let forceTimer;
  let abort = () => {};
  let lineLimitExceeded = false;

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

  const acceptText = (text) => {
    if (lineLimitExceeded) return;
    let start = 0;
    while (start < text.length) {
      const end = text.indexOf('\n', start);
      const segment = text.slice(start, end < 0 ? undefined : end);
      if (buffer.length + segment.length > lineLimit) {
        lineLimitExceeded = true;
        state.ok = false;
        state.error = t(
          `La línea JSON del CLI excedió ${lineLimit} caracteres. Ajusta MORAGENT_CLI_MAX_LINE_CHARS si es necesario.`,
          `CLI JSON line exceeded ${lineLimit} characters. Adjust MORAGENT_CLI_MAX_LINE_CHARS if needed.`,
        );
        terminateTree(child, { force: true });
        return;
      }
      buffer += segment;
      if (end < 0) return;
      acceptLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
      buffer = '';
      start = end + 1;
    }
  };

  const acceptChunk = (chunk) => {
    if (settled || lineLimitExceeded) return;
    writeLog(chunk);
    acceptText(stdoutDecoder.write(chunk));
  };

  const result = await new Promise((resolve) => {
    const finish = (code, spawnError = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      signal?.removeEventListener('abort', abort);
      closeLog();
      if (!lineLimitExceeded) acceptText(stdoutDecoder.end());
      stderr += stderrDecoder.end().slice(0, Math.max(0, MAX_STDERR_CHARS - stderr.length));
      if (!lineLimitExceeded && buffer) acceptLine(buffer);
      if (!state.started) emit({ type: 'start', sessionId: state.sessionId, model: state.model });
      const rawText = state.requireFinalText ? state.finalText : (state.finalText ?? state.text);
      const text = typeof rawText === 'string' ? rawText : '';
      const completed = !state.requireCompletion || state.ok === true;
      const ok = !aborted && !spawnError && code === 0 && state.ok !== false && completed && !!text.trim();
      const error = ok ? null : state.error || (aborted
        ? t('Ejecución cancelada.', 'Run cancelled.')
        : spawnError?.message || stderr.trim() || (code === 0 && !completed
          ? t('El CLI terminó sin confirmar el turno.', 'CLI exited without confirming turn completion.')
          : code === 0 && !text.trim()
          ? t('El CLI terminó sin respuesta final.', 'CLI exited without a final answer.')
          : t(`El CLI terminó con código ${code}.`, `CLI exited with code ${code}.`)));
      const done = { type: 'done', ok, text, sessionId: state.sessionId, error };
      emit(done);
      const value = { ok, text, sessionId: state.sessionId, usage: state.usage };
      if (!ok) value.error = error;
      resolve(value);
    };

    try {
      const log = prepareLog(logFile, maxLogBytes);
      writeLog = log.write;
      closeLog = log.close;
      const plan = spawnPlan(command, args);
      child = spawnImpl(plan.file, plan.argv, {
        cwd: root,
        // MORAGENT_ENGINE marks engine-driven runs: session hooks skip them and the engine closes tasks.
        env: { ...process.env, ...envOverrides, ...(root ? { PWD: path.resolve(root) } : {}), MORAGENT_ROLE: process.env.MORAGENT_ROLE || provider, MORAGENT_ENGINE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: plan.shell,
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      finish(127, error);
      return;
    }

    abort = () => {
      aborted = true;
      terminateTree(child);
      if (process.platform !== 'win32' && child.pid) {
        forceTimer = setTimeout(() => terminateTree(child, { force: true }), 1000);
        forceTimer.unref?.();
      }
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (aborted) abort();

    child.stdout?.on('data', acceptChunk);
    child.stderr?.on('data', (chunk) => {
      if (settled) return;
      writeLog(chunk);
      const decoded = stderrDecoder.write(chunk);
      stderr += decoded.slice(0, Math.max(0, MAX_STDERR_CHARS - stderr.length));
    });
    child.once('error', (error) => finish(127, error));
    child.once('close', (code) => finish(code ?? 1));
  });

  return result;
}
