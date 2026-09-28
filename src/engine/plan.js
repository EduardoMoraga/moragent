// The orchestrator answers in prose; when work must be delegated it adds ONE fenced block:
//
// ```moragent-plan
// { "size": "M", "summary": "…", "tasks": [
//   { "id": "t1", "role": "backend", "title": "…", "prompt": "…", "doneWhen": "…", "dependsOn": [] } ] }
// ```
const OPEN = /```moragent-plan[^\n]*\n?/i;

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

export function extractPlan(text) {
  const found = locate(text);
  if (!found) return null;
  if (!found.json) return { error: 'invalid-json' };
  let raw;
  try { raw = JSON.parse(found.json); } catch { return { error: 'invalid-json' }; }
  return normalizePlan(raw);
}

// The prose the user sees, without the machine-readable block (even when it is still streaming).
export function stripPlan(text) {
  const found = locate(text);
  const src = String(text || '');
  const out = found ? src.slice(0, found.start) + src.slice(found.end) : src;
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

export function normalizePlan(raw) {
  if (!raw || !Array.isArray(raw.tasks) || !raw.tasks.length) return { error: 'no-tasks' };
  const ids = new Set();
  const tasks = raw.tasks.slice(0, 8).map((t, i) => {
    const id = String(t.id || `t${i + 1}`);
    ids.add(id);
    return {
      id,
      role: String(t.role || 'backend').toLowerCase(),
      provider: t.provider ? String(t.provider) : null,
      title: String(t.title || t.prompt || `Tarea ${i + 1}`).slice(0, 120),
      prompt: String(t.prompt || t.title || ''),
      doneWhen: t.doneWhen ? String(t.doneWhen) : '',
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : [],
    };
  });
  // Drop unknown dependencies and self-references so a sloppy plan can still run.
  for (const t of tasks) t.dependsOn = t.dependsOn.filter((d) => ids.has(d) && d !== t.id);
  if (hasCycle(tasks)) for (const t of tasks) t.dependsOn = [];
  return { size: String(raw.size || '').toUpperCase() || null, summary: String(raw.summary || ''), tasks };
}

function hasCycle(tasks) {
  const deps = Object.fromEntries(tasks.map((t) => [t.id, t.dependsOn]));
  const state = {};
  const visit = (id) => {
    if (state[id] === 1) return true;
    if (state[id] === 2) return false;
    state[id] = 1;
    if ((deps[id] || []).some(visit)) return true;
    state[id] = 2;
    return false;
  };
  return tasks.some((t) => visit(t.id));
}

// Provider per task: explicit and ready → role's configured CLI if ready → any ready subscription → any ready.
export function assignProviders(plan, { crew = {}, providers = [], orchestrator }) {
  const ready = providers.filter((p) => p.ready);
  const isReady = (id) => ready.some((p) => p.id === id);
  const fallback = ready.find((p) => p.kind === 'subscription' && p.id !== orchestrator)?.id
    || ready.find((p) => p.kind === 'subscription')?.id || ready[0]?.id || null;
  for (const t of plan.tasks) {
    const roleCli = crew[t.role]?.cli;
    t.provider = (t.provider && isReady(t.provider) && t.provider) || (roleCli && isReady(roleCli) && roleCli) || fallback;
  }
  return plan;
}
