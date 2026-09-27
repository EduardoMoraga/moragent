// The orchestrator answers in prose; when work must be delegated it adds ONE fenced block:
//
// ```moragent-plan
// { "size": "M", "summary": "…", "tasks": [
//   { "id": "t1", "role": "backend", "title": "…", "prompt": "…", "doneWhen": "…", "dependsOn": [] } ] }
// ```
const FENCE = /```moragent-plan\s*\n([\s\S]*?)```/i;

export function extractPlan(text) {
  const m = String(text || '').match(FENCE);
  if (!m) return null;
  let raw;
  try { raw = JSON.parse(m[1]); } catch { return { error: 'invalid-json' }; }
  return normalizePlan(raw);
}

// The prose the user sees, without the machine-readable block.
export const stripPlan = (text) => String(text || '').replace(FENCE, '').replace(/\n{3,}/g, '\n\n').trim();

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
