import { isValidFileTextCheck } from './acceptance.js';

// The orchestrator answers in prose; when work must be delegated it adds ONE fenced block:
//
// ```moragent-plan
// { "size": "M", "summary": "…", "tasks": [
//   { "id": "t1", "role": "backend", "title": "…", "prompt": "…", "doneWhen": "…", "dependsOn": [] } ] }
// ```
// Smaller models sometimes put the JSON language tag before the plan marker.
const OPEN = /```(?:moragent-plan\b|json[ \t]+moragent-plan\b)[^\n]*\n?/i;

// Locate the plan block by matching braces (string-aware) instead of the closing fence: task
// prompts often contain their own ``` code examples, which would end a naive fenced match early.
function locate(text) {
  const src = String(text || '');
  const open = src.match(OPEN);
  if (!open) return null;
  const from = open.index + open[0].length;
  const first = src.indexOf('{', from);
  if (first < 0) return { start: open.index, end: src.length, json: null };
  let depth = 0; let inStr = false; let esc = false; let out = '';
  for (let i = first; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) { esc = false; out += ch; continue; }
      if (ch === '\\') { esc = true; out += ch; continue; }
      if (ch === '"') inStr = false;
      // Models sometimes put raw newlines/tabs inside JSON strings; escape them instead of failing.
      out += ch === '\n' ? '\\n' : ch === '\r' ? '' : ch === '\t' ? '\\t' : ch;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') depth--;
    out += ch;
    if (depth === 0) {
      const close = src.slice(i + 1).match(/^\s*```/);
      return { start: open.index, end: i + 1 + (close ? close[0].length : 0), json: out };
    }
  }
  return { start: open.index, end: src.length, json: null };
}

export function extractPlan(text, options = {}) {
  const found = locate(text);
  if (!found) return null;
  if (!found.json) return { error: 'invalid-json' };
  let raw;
  try { raw = JSON.parse(found.json); } catch { return { error: 'invalid-json' }; }
  return normalizePlan(raw, options);
}

// The prose the user sees, without the machine-readable block (even when it is still streaming).
export function stripPlan(text) {
  const found = locate(text);
  const src = String(text || '');
  const out = found ? src.slice(0, found.start) + src.slice(found.end) : src;
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

export function normalizePlan(raw, { roles = null, providers = null } = {}) {
  if (!raw || !Array.isArray(raw.tasks) || !raw.tasks.length) return { error: 'no-tasks' };
  if (raw.tasks.length > 8) return { error: 'too-many-tasks' };
  if (raw.tasks.some((task) => !task || typeof task !== 'object' || Array.isArray(task))) return { error: 'invalid-task' };
  for (const field of ['size', 'summary']) {
    if (raw[field] != null && typeof raw[field] !== 'string') return { error: 'invalid-field', detail: field };
  }
  for (const [index, task] of raw.tasks.entries()) {
    const id = typeof task.id === 'string' && task.id ? task.id : `t${index + 1}`;
    for (const field of ['id', 'role', 'provider', 'title', 'prompt', 'doneWhen']) {
      if (task[field] != null && typeof task[field] !== 'string') return { error: 'invalid-field', detail: `${id}.${field}` };
    }
    if (task.dependsOn != null && (!Array.isArray(task.dependsOn) || task.dependsOn.some((dependency) => typeof dependency !== 'string'))) {
      return { error: 'invalid-dependency', detail: `${id}.dependsOn` };
    }
    if (task.checks != null) {
      if (!Array.isArray(task.checks) || task.checks.length > 8) return { error: 'invalid-check', detail: `${id}.checks` };
      for (const [checkIndex, check] of task.checks.entries()) {
        if (!isValidFileTextCheck(check)) {
          return { error: 'invalid-check', detail: `${id}.checks[${checkIndex}]` };
        }
      }
    }
  }
  const ids = new Set();
  const tasks = raw.tasks.map((t, i) => {
    const id = String(t.id || `t${i + 1}`);
    return {
      id,
      role: String(t.role || 'backend').toLowerCase(),
      provider: t.provider ? String(t.provider) : null,
      title: String(t.title || t.prompt || `Tarea ${i + 1}`).slice(0, 120),
      prompt: String(t.prompt || t.title || ''),
      doneWhen: t.doneWhen ? String(t.doneWhen) : '',
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : [],
      checks: t.checks || [],
    };
  });
  for (const task of tasks) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(task.id)) return { error: 'invalid-id', detail: task.id };
    if (ids.has(task.id)) return { error: 'duplicate-id', detail: task.id };
    ids.add(task.id);
    if (roles && !roles.includes(task.role)) return { error: 'unknown-role', detail: task.role };
    if (providers && task.provider && !providers.includes(task.provider)) return { error: 'invalid-provider', detail: task.provider };
    if (!task.prompt.trim()) return { error: 'empty-prompt', detail: task.id };
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency) || dependency === task.id) return { error: 'invalid-dependency', detail: `${task.id} → ${dependency}` };
    }
  }
  if (hasCycle(tasks)) return { error: 'dependency-cycle' };
  return { size: String(raw.size || '').toUpperCase() || null, summary: String(raw.summary || ''), tasks };
}

function hasCycle(tasks) {
  const deps = new Map(tasks.map((t) => [t.id, t.dependsOn]));
  const state = new Map();
  const visit = (id) => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    if ((deps.get(id) || []).some(visit)) return true;
    state.set(id, 2);
    return false;
  };
  return tasks.some((t) => visit(t.id));
}

// Provider per task: explicit and ready → role's native override → role's CLI → any ready engine.
export function assignProviders(plan, { crew = {}, providers = [], orchestrator }) {
  const ready = providers.filter((p) => p.ready);
  const isReady = (id) => ready.some((p) => p.id === id);
  const fallback = ready.find((p) => p.kind === 'subscription' && p.id !== orchestrator)?.id
    || ready.find((p) => p.kind === 'subscription')?.id || ready[0]?.id || null;
  for (const t of plan.tasks) {
    const roleProvider = crew[t.role]?.provider;
    const roleCli = crew[t.role]?.cli;
    t.provider = (t.provider && isReady(t.provider) && t.provider)
      || (roleProvider && isReady(roleProvider) && roleProvider)
      || (roleCli && isReady(roleCli) && roleCli)
      || fallback;
  }
  return plan;
}
