import fs from 'node:fs';
import path from 'node:path';
import { executeTool } from './tools.js';

let customFetch = null;

export const setFetch = (fn) => {
  customFetch = fn;
};

export const resetFetch = () => {
  customFetch = null;
};

export const getFetch = () => customFetch || globalThis.fetch;

function appendLog(logFile, data) {
  if (!logFile) return;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const line = typeof data === 'string' ? data : JSON.stringify(data);
    fs.appendFileSync(logFile, line + '\n', 'utf8');
  } catch {
    // Ignore logging failures
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
      appendLog(logFile, { ...event, ts: Date.now() });
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
      });

      const fetchFn = getFetch();
      const resp = await fetchFn(req.url, {
        method: req.method || 'POST',
        headers: req.headers,
        body: typeof req.body === 'string' ? req.body : JSON.stringify(req.body),
        signal,
      });

      if (!resp.ok) {
        const errorText = await resp.text().catch(() => '');
        const errMsg = `HTTP ${resp.status}${resp.statusText ? ` ${resp.statusText}` : ''}: ${errorText.slice(0, 300)}`;
        emit({ type: 'done', ok: false, text: accumulatedText, sessionId: effectiveSessionId, error: errMsg });
        return { ok: false, text: accumulatedText, sessionId: effectiveSessionId, error: errMsg, usage: totalUsage };
      }

      const json = await resp.json();
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

          const result = await executeTool(call.name, call.args, { root, autonomy });

          emit({
            type: 'tool_result',
            id: call.id,
            ok: result.ok,
            summary: result.summary,
          });

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

      // No tool calls: final text response reached
      emit({
        type: 'done',
        ok: true,
        text: accumulatedText,
        sessionId: effectiveSessionId,
        error: null,
      });

      return {
        ok: true,
        text: accumulatedText,
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
