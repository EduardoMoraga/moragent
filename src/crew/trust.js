import { MoragentError } from '../core/errors.js';
import { t } from '../core/i18n.js';
import { out } from '../core/log.js';
import { loadPanes } from './panes.js';
import { getMux } from '../mux/index.js';

const SUPPORTED = new Set(['orca', 'herdr', 'tmux']);
const SPINNER = /(?:signing in|loading|[⣷⣯⣟⡿⢿⣻⣽⣾])/i;
const READY_LINE = /(?:⏵⏵|for shortcuts|›\s*ask codex|ask codex to do anything|\?\s*for shortcuts|^\s*❯\s*$|\(sub\)|%\/)/i;
const DIALOG_LINE = /(?:update available|do you .*\?|yes,\s*(?:continue|i trust)|no, exit|trust parent folder|do not trust|enter (?:to|select|confirm)|press enter)/i;
const pause = (ms) => {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

export const DEFAULT_TRUST_TIMEOUT = 25000;

export const nonEmptyTail = (text, lines = 12) => String(text || '')
  .split(/\r?\n/)
  .map((line) => line.trimEnd())
  .filter((line) => line.trim())
  .slice(-lines);

export function detectTrustDialog(text) {
  const screen = nonEmptyTail(text).join('\n');
  if (/update available!/i.test(screen)
    && /skip until next version/i.test(screen)
    && /press enter to continue/i.test(screen)) {
    return { kind: 'update', keys: ['down', 'down', 'enter'] };
  }
  if (/yes, i trust this folder/i.test(screen)
    && /no, exit/i.test(screen)
    && /enter to confirm/i.test(screen)) {
    return { kind: 'trust', cli: 'claude', keys: ['down', 'enter'] };
  }
  if (/do you trust the contents of this directory\?/i.test(screen)
    && /yes,\s*continue/i.test(screen)
    && /press enter to continue/i.test(screen)) {
    return { kind: 'trust', cli: 'codex', keys: ['enter'] };
  }
  if (/do you trust the contents of this project\?/i.test(screen)
    && /yes,\s*i trust this folder/i.test(screen)
    && /enter\s+confirm/i.test(screen)) {
    return { kind: 'trust', cli: 'agy', keys: ['enter'] };
  }
  if (/trust parent folder/i.test(screen)
    && /trust \(this session only\)/i.test(screen)
    && /do not trust/i.test(screen)
    && /enter\s+select/i.test(screen)) {
    return { kind: 'trust', cli: 'pi', keys: ['enter'] };
  }
  return null;
}

export function detectReadyPrompt(text) {
  return nonEmptyTail(text).some((line) => READY_LINE.test(line));
}

function readyIsLatest(text) {
  const lines = nonEmptyTail(text);
  let ready = -1;
  let dialog = -1;
  for (let i = 0; i < lines.length; i++) {
    if (READY_LINE.test(lines[i])) ready = i;
    if (DIALOG_LINE.test(lines[i])) dialog = i;
  }
  return ready >= 0 && ready > dialog;
}

export function detectExited(text) {
  const lines = nonEmptyTail(text);
  const last = lines.at(-1) || '';
  return /(?:^|\s)[%$]\s*$/.test(last)
    || (/cli program exited/i.test(lines.join('\n')) && !detectReadyPrompt(lines.join('\n')));
}

function readScreen(mux, pane) {
  return nonEmptyTail(mux.read(pane.handle, { lines: 80 })).join('\n');
}

function observe(mux, pane, deadline, { stableMs, pollMs }) {
  let candidate = null;
  let candidateAt = 0;
  let candidateReads = 0;
  let screen = '';
  for (;;) {
    screen = readScreen(mux, pane);
    const now = Date.now();
    if (detectExited(screen)) return { type: 'exited', screen };
    const busy = SPINNER.test(screen);
    if (!busy && readyIsLatest(screen)) return { type: 'ready', screen };
    const dialog = busy ? null : detectTrustDialog(screen);
    if (dialog) {
      if (screen === candidate) candidateReads++;
      else {
        candidate = screen;
        candidateAt = now;
        candidateReads = 1;
      }
      if (candidateReads >= 2 && now - candidateAt >= stableMs) return { type: 'dialog', dialog, screen };
    } else {
      candidate = null;
      candidateAt = 0;
      candidateReads = 0;
    }
    if (now >= deadline) return { type: 'unknown', screen };
    pause(Math.min(Math.max(0, pollMs), Math.max(0, deadline - now)));
  }
}

const finalAction = ({ trusted, skippedUpdate }) => skippedUpdate
  ? 'skipped-update+trusted'
  : trusted ? 'trusted' : 'ready';

const unknown = (role, mux, screen, dialogs) => ({
  role,
  mux: mux.name,
  action: 'unknown',
  dialogs,
  detail: nonEmptyTail(screen, 3).join('\n') || t('pantalla vacía', 'empty screen'),
});

const exited = (role, mux, screen, dialogs) => ({
  role,
  mux: mux.name,
  action: 'exited',
  dialogs,
  detail: nonEmptyTail(screen, 3).join('\n') || t('el proceso terminó', 'the process exited'),
  hint: `mora down ${role} && mora up ${role}`,
});

export function trustPane({
  mux,
  pane,
  role,
  timeoutMs = DEFAULT_TRUST_TIMEOUT,
  stableMs = 1000,
  pollMs = 250,
}) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let trusted = false;
  let skippedUpdate = false;
  let dialogs = 0;
  for (; dialogs < 3; dialogs++) {
    const state = observe(mux, pane, deadline, { stableMs, pollMs });
    if (state.type === 'exited') return exited(role, mux, state.screen, dialogs);
    if (state.type === 'ready') {
      return { role, mux: mux.name, action: finalAction({ trusted, skippedUpdate }), dialogs };
    }
    if (state.type !== 'dialog') return unknown(role, mux, state.screen, dialogs);
    if (typeof mux.key !== 'function') return unknown(role, mux, state.screen, dialogs);
    for (const key of state.dialog.keys) mux.key(pane.handle, key);
    trusted ||= state.dialog.kind === 'trust';
    skippedUpdate ||= state.dialog.kind === 'update';
  }
  const state = observe(mux, pane, deadline, { stableMs, pollMs });
  if (state.type === 'exited') return exited(role, mux, state.screen, dialogs);
  if (state.type === 'ready') {
    return { role, mux: mux.name, action: finalAction({ trusted, skippedUpdate }), dialogs };
  }
  return unknown(role, mux, state.screen, dialogs);
}

export function trustRoles({
  root,
  roles,
  strict = false,
  timeoutMs = DEFAULT_TRUST_TIMEOUT,
  stableMs = 1000,
  pollMs = 250,
}) {
  const panes = loadPanes(root);
  const wanted = roles?.length ? roles : Object.keys(panes);
  const results = [];
  for (const role of wanted) {
    const pane = panes[role];
    if (!pane) {
      if (!strict) continue;
      throw new MoragentError(
        'PANE_NOT_FOUND',
        t(`No hay panel registrado para ${role}.`, `No registered pane for ${role}.`),
        `mora up ${role}`,
      );
    }
    const mux = getMux(pane.mux);
    if (!mux.alive(pane.handle, { root })) {
      if (!strict) continue;
      throw new MoragentError(
        'PANE_NOT_FOUND',
        t(`El panel de ${role} no está activo.`, `The ${role} pane is not active.`),
        `mora up ${role}`,
      );
    }
    if (!SUPPORTED.has(mux.name)) {
      results.push({ role, mux: mux.name, action: 'ready', dialogs: 0 });
      continue;
    }
    results.push(trustPane({ mux, pane, role, timeoutMs, stableMs, pollMs }));
  }
  return results;
}

export function printTrustResults(results) {
  out(t('ROL       ACCIÓN', 'ROLE      ACTION'));
  for (const item of results) {
    const detail = item.action === 'unknown'
      ? ` — ${t('diálogo desconocido', 'unknown dialog')}: ${item.detail.replace(/\n/g, ' | ')}`
      : item.action === 'exited' ? ` — ${item.hint}` : '';
    out(`${item.role.padEnd(10)} ${item.action}${detail}`);
  }
}
