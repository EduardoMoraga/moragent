import { MoragentError } from '../core/errors.js';
import { t } from '../core/i18n.js';
import { out } from '../core/log.js';
import { loadPanes } from './panes.js';
import { getMux } from '../mux/index.js';

const SUPPORTED = new Set(['orca', 'herdr', 'tmux']);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export const nonEmptyTail = (text, lines = 12) => String(text || '')
  .split(/\r?\n/)
  .map((line) => line.trimEnd())
  .filter((line) => line.trim())
  .slice(-lines);

export function detectTrustDialog(text) {
  const screen = nonEmptyTail(text).join('\n');
  if (/update available!/i.test(screen) && /(?:update now|skip until next version|press enter to continue)/i.test(screen)) {
    return { kind: 'update', keys: ['down', 'down', 'enter'] };
  }
  if (/yes, i trust this folder/i.test(screen) && /(?:no, exit|enter to confirm)/i.test(screen)) {
    return { kind: 'trust', cli: 'claude', keys: ['down', 'enter'] };
  }
  if (/do you trust the contents of this directory\?/i.test(screen) && /yes,\s*continue/i.test(screen)) {
    return { kind: 'trust', cli: 'codex', keys: ['enter'] };
  }
  if (/do you trust the contents of this project\?/i.test(screen) && /yes,\s*i trust this folder/i.test(screen)) {
    return { kind: 'trust', cli: 'agy', keys: ['enter'] };
  }
  if (/trust parent folder/i.test(screen) && /trust \(this session only\)/i.test(screen) && /do not trust/i.test(screen)) {
    return { kind: 'trust', cli: 'pi', keys: ['enter'] };
  }
  return null;
}

const READY_PROMPT = /(?:^|\n)\s*[›❯>→]\s*$/;
const DIALOGISH = /(?:update available|do you .*\?|enter (?:to|select)|esc to cancel|↑↓\s*navigate|[❯→]\s+\S|\b\d+\.\s+\S)/i;

function readScreen(mux, pane) {
  return nonEmptyTail(mux.read(pane.handle, { lines: 80 })).join('\n');
}

function waitForSignal(mux, pane, waitMs) {
  let screen = readScreen(mux, pane);
  const until = Date.now() + Math.max(0, waitMs || 0);
  while (Date.now() < until && !detectTrustDialog(screen) && !DIALOGISH.test(screen) && !READY_PROMPT.test(screen)) {
    pause(75);
    screen = readScreen(mux, pane);
  }
  return screen;
}

function waitForChange(mux, pane, previous, waitMs) {
  const until = Date.now() + Math.max(0, waitMs || 0);
  let screen = readScreen(mux, pane);
  while (Date.now() < until && (
    screen === previous
    || (!detectTrustDialog(screen) && !DIALOGISH.test(screen) && !READY_PROMPT.test(screen))
  )) {
    pause(50);
    screen = readScreen(mux, pane);
  }
  return screen;
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

export function trustPane({ mux, pane, role, waitMs = 0, settleMs = 750 }) {
  let screen = waitForSignal(mux, pane, waitMs);
  let trusted = false;
  let skippedUpdate = false;
  let dialogs = 0;
  for (; dialogs < 3; dialogs++) {
    if (READY_PROMPT.test(screen)) {
      return { role, mux: mux.name, action: finalAction({ trusted, skippedUpdate }), dialogs };
    }
    const dialog = detectTrustDialog(screen);
    if (!dialog) {
      if (!screen || DIALOGISH.test(screen)) return unknown(role, mux, screen, dialogs);
      return { role, mux: mux.name, action: finalAction({ trusted, skippedUpdate }), dialogs };
    }
    if (typeof mux.key !== 'function') return unknown(role, mux, screen, dialogs);
    for (const key of dialog.keys) mux.key(pane.handle, key);
    trusted ||= dialog.kind === 'trust';
    skippedUpdate ||= dialog.kind === 'update';
    const previous = screen;
    screen = waitForChange(mux, pane, previous, settleMs);
    if (screen === previous) return unknown(role, mux, screen, dialogs + 1);
  }
  if (!READY_PROMPT.test(screen) && (detectTrustDialog(screen) || DIALOGISH.test(screen))) {
    return unknown(role, mux, screen, dialogs);
  }
  return { role, mux: mux.name, action: finalAction({ trusted, skippedUpdate }), dialogs };
}

export function trustRoles({ root, roles, strict = false, waitMs = 0 }) {
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
    results.push(trustPane({ mux, pane, role, waitMs }));
  }
  return results;
}

export function printTrustResults(results) {
  out(t('ROL       ACCIÓN', 'ROLE      ACTION'));
  for (const item of results) {
    const detail = item.action === 'unknown'
      ? ` — ${t('diálogo desconocido', 'unknown dialog')}: ${item.detail.replace(/\n/g, ' | ')}`
      : '';
    out(`${item.role.padEnd(10)} ${item.action}${detail}`);
  }
}
