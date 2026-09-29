import fs from 'node:fs';
import path from 'node:path';
import { executeTool } from './tools.js';
import { DEFAULT_PRIVATE_LOG_MAX_BYTES, openPrivateLog, writeBoundedPrivateLog } from '../../core/private-log.js';
import { t } from '../../core/i18n.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

let customFetch = null;

export const setFetch = (fn) => {
  customFetch = fn;
};

export const resetFetch = () => {
  customFetch = null;
};

export const getFetch = () => customFetch || globalThis.fetch;

function appendLog(logFile, data, maxLogBytes) {
  if (!logFile) return;
  let fd;
  try {
    let line = typeof data === 'string' ? data : JSON.stringify(data);
    if (Buffer.byteLength(line) + 1 > maxLogBytes) {
      const compact = { type: data?.type || 'event', ts: data?.ts, truncated: true, originalBytes: Buffer.byteLength(line) };
      if (data?.type === 'done') Object.assign(compact, { ok: data.ok, sessionId: data.sessionId, error: data.error?.slice?.(0, 96) });
      else if (data?.type === 'tool') Object.assign(compact, { id: data.id, name: data.name, path: data.path, command: data.command?.slice?.(0, 96) });
      line = JSON.stringify(compact);
    }
    if (Buffer.byteLength(line) + 1 > maxLogBytes) line = JSON.stringify({ type: data?.type || 'event', truncated: true });
    fd = openPrivateLog(logFile);
    writeBoundedPrivateLog(fd, line + '\n', maxLogBytes, { lineDelimited: true });
  } catch {
    // Ignore logging failures
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* optional log */ } }
  }
}

function getRequestTimeout(override) {
  const configured = override ?? process.env.MORAGENT_API_TIMEOUT_MS;
  const parsed = Number(configured);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REQUEST_TIMEOUT_MS;
}

function emptyResponseReason(json) {
  const error = json?.error;
  const message = typeof error === 'string' ? error : error?.message;
  if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 300);
  const blockReason = json?.promptFeedback?.blockReason;
  if (typeof blockReason === 'string' && blockReason.trim()) return blockReason.trim().slice(0, 300);
  return null;
}

async function requestJson(fetchFn, req, signal, timeoutMs) {
  const controller = new AbortController();
  let rejectInterrupted;
  const interrupted = new Promise((_, reject) => { rejectInterrupted = reject; });
  const interrupt = (message) => {
    rejectInterrupted(new Error(message));
    controller.abort();
  };
  const abort = () => interrupt('Aborted');
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => interrupt(t(
    `La solicitud API excedió ${timeoutMs} ms. Configura MORAGENT_API_TIMEOUT_MS si el modelo necesita más tiempo.`,
    `API request timed out after ${timeoutMs} ms. Set MORAGENT_API_TIMEOUT_MS if the model needs longer.`,
  )), timeoutMs);

  try {
    if (signal?.aborted) abort();
    const response = await Promise.race([
      Promise.resolve().then(() => fetchFn(req.url, {
        method: req.method || 'POST',
        headers: req.headers,
        body: typeof req.body === 'string' ? req.body : JSON.stringify(req.body),
        signal: controller.signal,
      })),
      interrupted,
    ]);
    if (!response.ok) {
      const errorText = await Promise.race([response.text().catch(() => ''), interrupted]);
      return { response, errorText };
    }
    const json = await Promise.race([response.json(), interrupted]);
    return { response, json };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export async function runApiLoop({
  providerId,
  adapter,
  root,
  prompt,
  system,
  sessionId,
  autonomy = 'auto',
  model,
  signal,
  onEvent,
  logFile,
  apiKey,
  baseUrl,
  requestTimeoutMs,
  toolsEnabled = true,
  protectedOtherPaths = [],
  maxLogBytes = DEFAULT_PRIVATE_LOG_MAX_BYTES,
}) {
  const effectiveSessionId = sessionId || `session_${providerId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  // MORAGENT_ANTHROPIC_MODEL, MORAGENT_OPENAI_MODEL… override the built-in default without a code change.
  const effectiveModel = model || process.env[`MORAGENT_${String(providerId).toUpperCase()}_MODEL`] || adapter.defaultModel;

  let doneEmitted = false;
  const emit = (event) => {
    if (event.type === 'done') {
      if (doneEmitted) return;
      doneEmitted = true;
    }
    if (onEvent) {
      try {
        onEvent(event);
      } catch {
        // Consumer callback errors should not crash the agent loop
      }
    }
    if (logFile) {
      appendLog(logFile, { ...event, ts: Date.now() }, maxLogBytes);
    }
  };

  emit({
    type: 'start',
    sessionId: effectiveSessionId,
    provider: providerId,
    model: effectiveModel,
  });

  const totalUsage = { input: null, output: null, costUsd: null };
  let accumulatedText = '';
  const unresolvedFileFailures = new Map();

  try {
    if (adapter.requiresKey !== false && !apiKey) {
      const err = `Missing API key for provider "${providerId}"`;
      emit({ type: 'done', ok: false, text: '', sessionId: effectiveSessionId, error: err });
      return { ok: false, text: '', sessionId: effectiveSessionId, error: err, usage: totalUsage };
    }

    if (signal?.aborted) {
      emit({ type: 'done', ok: false, text: '', sessionId: effectiveSessionId, error: 'Aborted' });
      return { ok: false, text: '', sessionId: effectiveSessionId, error: 'Aborted', usage: totalUsage };
    }

    const state = adapter.initConversation({ prompt, system });

    for (let step = 0; step < 40; step++) {
      if (signal?.aborted) {
        emit({ type: 'done', ok: false, text: accumulatedText, sessionId: effectiveSessionId, error: 'Aborted' });
        return { ok: false, text: accumulatedText, sessionId: effectiveSessionId, error: 'Aborted', usage: totalUsage };
      }

      const req = adapter.buildRequest({
        state,
        model: effectiveModel,
        system,
        apiKey,
        baseUrl,
        root,
        autonomy,
        toolsEnabled,
      });

      const fetchFn = getFetch();
      const { response: resp, json, errorText = '' } = await requestJson(
        fetchFn, req, signal, getRequestTimeout(requestTimeoutMs),
      );

      if (!resp.ok) {
        const errMsg = `HTTP ${resp.status}${resp.statusText ? ` ${resp.statusText}` : ''}: ${errorText.slice(0, 300)}`;
        emit({ type: 'done', ok: false, text: accumulatedText, sessionId: effectiveSessionId, error: errMsg });
        return { ok: false, text: accumulatedText, sessionId: effectiveSessionId, error: errMsg, usage: totalUsage };
      }

      const parsed = adapter.parseResponse(json);

      if (parsed.usage) {
        if (parsed.usage.input != null) {
          totalUsage.input = (totalUsage.input ?? 0) + parsed.usage.input;
        }
        if (parsed.usage.output != null) {
          totalUsage.output = (totalUsage.output ?? 0) + parsed.usage.output;
        }
        if (parsed.usage.costUsd != null) {
          totalUsage.costUsd = (totalUsage.costUsd ?? 0) + parsed.usage.costUsd;
        }
        emit({
          type: 'usage',
          input: totalUsage.input,
          output: totalUsage.output,
          costUsd: totalUsage.costUsd,
        });
      }

      // HTTP 200 can contain a truncated or filtered response. Count its usage,
      // but never publish partial text as final or execute tool calls from it.
      if (parsed.stopIssue) {
        const errMsg = t(
          `El proveedor "${providerId}" detuvo la respuesta antes de completarla (${parsed.stopIssue}). No se ejecutaron sus herramientas.`,
          `Provider "${providerId}" stopped before completing its response (${parsed.stopIssue}). Its tools were not executed.`,
        );
        emit({ type: 'done', ok: false, text: accumulatedText, sessionId: effectiveSessionId, error: errMsg });
        return { ok: false, text: accumulatedText, sessionId: effectiveSessionId, error: errMsg, usage: totalUsage };
      }

      if (!toolsEnabled && parsed.toolCalls?.length) {
        const errMsg = t(
          `El proveedor "${providerId}" devolvió una llamada a herramienta aunque las herramientas estaban desactivadas. No se ejecutó.`,
          `Provider "${providerId}" returned a tool call while tools were disabled. It was not executed.`,
        );
        emit({ type: 'done', ok: false, text: accumulatedText, sessionId: effectiveSessionId, error: errMsg });
        return { ok: false, text: accumulatedText, sessionId: effectiveSessionId, error: errMsg, usage: totalUsage };
      }

      if (parsed.text) {
        accumulatedText += (accumulatedText.length > 0 && !accumulatedText.endsWith('\n') ? '\n' : '') + parsed.text;
        emit({ type: 'text', delta: parsed.text });
      }

      if (parsed.toolCalls && parsed.toolCalls.length > 0) {
        adapter.appendAssistant({ state, parsed, rawMessage: parsed.rawAssistantMessage });

        for (const call of parsed.toolCalls) {
          if (signal?.aborted) {
            emit({ type: 'done', ok: false, text: accumulatedText, sessionId: effectiveSessionId, error: 'Aborted' });
            return { ok: false, text: accumulatedText, sessionId: effectiveSessionId, error: 'Aborted', usage: totalUsage };
          }

          emit({
            type: 'tool',
            id: call.id,
            name: call.name,
            input: call.args,
          });

          const result = await executeTool(call.name, call.args, { root, autonomy, signal, protectedOtherPaths });
          if (['write_file', 'edit_file'].includes(call.name) && !['readonly', 'ask'].includes(autonomy)) {
            const target = path.normalize(String(call.args?.path || call.args?.file_path || '?'));
            if (result.ok) unresolvedFileFailures.delete(target);
            else if (result.code !== 'TASK_SCOPE') unresolvedFileFailures.set(target, result.summary || call.name);
          }

          emit({
            type: 'tool_result',
            id: call.id,
            ok: result.ok,
            summary: result.summary,
          });

          if (signal?.aborted) {
            emit({ type: 'done', ok: false, text: accumulatedText, sessionId: effectiveSessionId, error: 'Aborted' });
            return { ok: false, text: accumulatedText, sessionId: effectiveSessionId, error: 'Aborted', usage: totalUsage };
          }

          adapter.appendToolResult({
            state,
            callId: call.id,
            toolName: call.name,
            result,
          });
        }
        // Continue to next loop step to send results back
        continue;
      }

      // An empty HTTP 200 (or a provider-side refusal without text) is not a completed task.
      if (typeof parsed.text !== 'string' || !parsed.text.trim()) {
        const reason = emptyResponseReason(json);
        const errMsg = t(
          `El proveedor "${providerId}" no devolvió texto ni herramientas. Revisa el modelo y la respuesta del servidor.`,
          `Provider "${providerId}" returned neither text nor tools. Check the model and server response.`,
        ) + (reason ? ` (${reason})` : '');
        emit({ type: 'done', ok: false, text: accumulatedText, sessionId: effectiveSessionId, error: errMsg });
        return { ok: false, text: accumulatedText, sessionId: effectiveSessionId, error: errMsg, usage: totalUsage };
      }

      // No tool calls: this response is the final answer. Earlier text emitted alongside
      // tool calls was progress, not authoritative content (it may contain a draft plan).
      const finalText = parsed.text;
      if (unresolvedFileFailures.size) {
        const failures = [...unresolvedFileFailures].slice(0, 3).map(([target, detail]) => `${JSON.stringify(target)} (${detail})`).join(', ');
        const errMsg = t(
          `Una herramienta de archivo falló sin un reintento exitoso: ${failures}. El informe final no confirma la tarea.`,
          `A file tool failed without a successful retry: ${failures}. The final report does not confirm the task.`,
        );
        emit({ type: 'done', ok: false, text: accumulatedText, sessionId: effectiveSessionId, error: errMsg });
        return { ok: false, text: accumulatedText, sessionId: effectiveSessionId, error: errMsg, usage: totalUsage };
      }
      emit({
        type: 'done',
        ok: true,
        text: finalText,
        sessionId: effectiveSessionId,
        error: null,
      });

      return {
        ok: true,
        text: finalText,
        sessionId: effectiveSessionId,
        usage: totalUsage,
      };
    }

    // Step limit of 40 reached
    const limitErr = 'Step limit exceeded (40 steps)';
    emit({
      type: 'done',
      ok: false,
      text: accumulatedText,
      sessionId: effectiveSessionId,
      error: limitErr,
    });

    return {
      ok: false,
      text: accumulatedText,
      sessionId: effectiveSessionId,
      error: limitErr,
      usage: totalUsage,
    };
  } catch (err) {
    const errMsg = err?.message || String(err);
    emit({
      type: 'done',
      ok: false,
      text: accumulatedText,
      sessionId: effectiveSessionId,
      error: errMsg,
    });
    return {
      ok: false,
      text: accumulatedText,
      sessionId: effectiveSessionId,
      error: errMsg,
      usage: totalUsage,
    };
  }
}
