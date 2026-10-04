import path from 'node:path';
import { dirs, findRoot } from '../core/paths.js';
import { loadConfig, saveConfig, defaultConfig, PRESETS } from '../core/config.js';
import fs from 'node:fs';
import { listFiles, writeText, ensureDir, nowISO } from '../core/fsx.js';
import { detectLang, setLang, t } from '../core/i18n.js';
import { syncProject } from '../core/sync.js';
import { installHooks } from '../core/hooks.js';
import { refreshBrain } from '../core/brain-refresh.js';
import { createTask, updateTask, getTask } from '../bus/tasks.js';
import { buildEnvelope } from '../bus/envelope.js';
import { readStatus } from '../bus/status.js';
import { formatStatus } from '../commands/status.js';
import { createStore } from './store.js';
import { extractPlan, stripPlan, assignProviders } from './plan.js';
import { orchestratorSystem, turnPrompt, reviewPrompt } from './prompts.js';

const CONCURRENCY = 3;
const MAX_REVIEW_ROUNDS = 1;

async function optional(rel) {
  try { return await import(new URL(rel, import.meta.url).href); } catch { return null; }
}

function memoryCounts(root) {
  if (!root) return { canonical: 0, episodic: 0, transient: 0, skills: 0 };
  const d = dirs(root);
  return {
    canonical: listFiles(d.canonical).length,
    episodic: listFiles(d.episodic).length,
    transient: listFiles(d.transient).length,
    skills: listFiles(d.skills, { ext: 'SKILL.md', recursive: true }).length,
  };
}

async function activeSpec(root) {
  if (!root) return null;
  const spec = await optional('../spec/index.js');
  if (!spec?.specState) return null;
  try {
    const names = fs.readdirSync(dirs(root).specs, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    let best = null;
    for (const slug of names) {
      const st = spec.specState(root, slug);
      if (st.phase === 'archive') continue;
      const mtime = fs.statSync(path.join(dirs(root).specs, slug)).mtimeMs;
      if (!best || mtime > best.mtime) best = { slug, phase: st.phase, mtime };
    }
    return best && { slug: best.slug, phase: best.phase };
  } catch { return null; }
}

// Summary line for the side panel from a streamed event.
function lastLineFrom(e, prev) {
  if (e.type === 'text') {
    const line = `${prev?.endsWith('\n') ? '' : prev || ''}${e.delta}`.split('\n').filter((l) => l.trim()).pop();
    return line ? line.slice(-120) : prev;
  }
  if (e.type === 'tool') return `→ ${e.name}${e.input?.file_path || e.input?.path ? ` ${e.input.file_path || e.input.path}` : ''}`;
  return prev;
}

// Language of a brand-new project follows the first message, not the shell locale.
export function guessLang(text, fallback = 'en') {
  const s = ` ${String(text).toLowerCase()} `;
  if (/[ñ¿¡áéíóú]/.test(s)) return 'es';
  const es = (s.match(/ (el|la|los|las|que|de|con|para|una?|y|crea|quiero|haz|necesito) /g) || []).length;
  const en = (s.match(/ (the|and|with|for|create|make|want|need|build|a|an) /g) || []).length;
  return es > en ? 'es' : en > es ? 'en' : fallback;
}

const LOG_MAX = 400;

// Fold one normalized event into an agent's activity log: text deltas are merged into the current
// line, tools and results get their own entries.
export function appendLog(log = [], e) {
  const at = new Date().toISOString();
  const next = log.slice(-LOG_MAX);
  if (e.type === 'text') {
    const parts = String(e.delta || '').split('\n');
    const last = next[next.length - 1];
    if (last && last.kind === 'text' && !last.closed) {
      next[next.length - 1] = { ...last, text: last.text + parts[0] };
    } else if (parts[0]) next.push({ at, kind: 'text', text: parts[0] });
    for (const part of parts.slice(1)) {
      if (next.length) next[next.length - 1] = { ...next[next.length - 1], closed: true };
      next.push({ at, kind: 'text', text: part });
    }
  } else if (e.type === 'tool') {
    const target = e.input?.file_path || e.input?.path || e.input?.command || '';
    next.push({ at, kind: 'tool', text: `${e.name}${target ? ` ${String(target).slice(0, 160)}` : ''}` });
  } else if (e.type === 'tool_result') {
    next.push({ at, kind: e.ok === false ? 'error' : 'result', text: String(e.summary || (e.ok === false ? 'error' : 'ok')).slice(0, 200) });
  } else if (e.type === 'done' && e.ok === false && e.error) {
    next.push({ at, kind: 'error', text: String(e.error).slice(0, 300) });
  }
  return next.filter((x) => x.kind !== 'text' || x.text.trim()).slice(-LOG_MAX);
}

// Chat shows the start of a long summary, cut on a line boundary; the full text lives in Tab / the log.
export function brief(text, max = 700) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  const cut = s.lastIndexOf('\n', max);
  const head = s.slice(0, cut > max * 0.4 ? cut : s.lastIndexOf(' ', max)).trimEnd();
  return `${head}\n${t('… (resumen completo: Tab o /agentes)', '… (full summary: Tab or /agents)')}`;
}

const blockedText = (text) => /^\s*(BLOQUEADO|BLOCKED)\s*:/i.test(text || '');

// `providers` ({ listProviders, getProvider }) is injectable for tests; defaults to src/providers.
export async function createEngine({ root = findRoot(), config = null, cwd = process.cwd(), providers = null } = {}) {
  if (root && !config) config = loadConfig(root);
  setLang(config?.lang || detectLang());
  const store = createStore({
    project: config?.project || path.basename(cwd),
    goal: config?.goal || '',
    lang: config?.lang || detectLang(),
    initialized: !!root,
    orchestrator: { provider: config?.orchestrator || config?.crew?.lead?.cli || null, model: config?.orchestratorModel || null, activeModel: null, status: 'idle' },
    messages: [],
    agents: {},
    memory: memoryCounts(root),
    spec: await activeSpec(root),
    brain: { linked: !!config?.brain?.vault, vault: config?.brain?.vault || null },
    providers: [],
    notice: null,
  });

  let providersMod = providers || await optional('../providers/index.js');
  let session = { id: null, provider: null };
  const controllers = new Set();
  let reviewRounds = 0;

  const engine = { store, get root() { return root; }, get config() { return config; } };

  // ---------- sessions: every conversation is saved and can be resumed ----------
  let sessionsMod = await optional('./sessions.js');
  let current = null;
  const listSaved = () => (root && sessionsMod?.listSessions ? sessionsMod.listSessions(root) : []);
  store.set({ sessions: listSaved(), sessionId: null });
  let saveTimer = null;
  const persist = () => {
    if (!root || !sessionsMod?.saveSession) return;
    if (!store.state.messages.some((m) => m.from === 'user')) return;
    if (!current) current = sessionsMod.createSession(root, { provider: store.state.orchestrator.provider });
    current.messages = store.state.messages.map((m) => ({ ...m, streaming: false }));
    current.agents = Object.fromEntries(Object.entries(store.state.agents).map(([k, a]) => [k, { ...a, log: (a.log || []).slice(-80) }]));
    current.provider = session.provider || store.state.orchestrator.provider;
    current.providerSessionId = session.id;
    current = sessionsMod.saveSession(root, current) || current;
    if (store.state.sessionId !== current.id) store.set({ sessionId: current.id });
  };
  store.on('change', () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; try { persist(); } catch { /* saving must never break the chat */ } }, 800);
    saveTimer.unref?.();
  });
  const ago = (iso) => {
    const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (min < 1) return t('recién', 'just now');
    if (min < 60) return t(`hace ${min} min`, `${min} min ago`);
    const h = Math.round(min / 60);
    return h < 24 ? t(`hace ${h} h`, `${h} h ago`) : t(`hace ${Math.round(h / 24)} d`, `${Math.round(h / 24)} d ago`);
  };

  engine.refreshProviders = async () => {
    providersMod = providersMod || await optional('../providers/index.js');
    if (!providersMod?.listProviders) { store.set({ providers: [], notice: t('Motor de proveedores no disponible.', 'Provider engine not available.') }); return []; }
    const list = await Promise.all(providersMod.listProviders().map(async (p) => {
      let st = { ready: false, detail: '', loginHint: '' };
      try { st = { ...st, ...(await p.status()) }; } catch (e) { st.detail = e.message; }
      return { id: p.id, label: p.label, kind: p.kind, ...st };
    }));
    store.set({ providers: list });
    const cur = store.state.orchestrator.provider;
    if (!cur || !list.find((p) => p.id === cur && p.ready)) {
      const pick = list.find((p) => p.kind === 'subscription' && p.ready) || list.find((p) => p.ready);
      store.set({ orchestrator: { ...store.state.orchestrator, provider: pick?.id || cur } });
    }
    return list;
  };

  const provider = (id) => providersMod?.getProvider?.(id);

  const refreshCounts = async () => store.set({ memory: memoryCounts(root), spec: await activeSpec(root) });

  // ---------- project bootstrap (first message in an empty folder) ----------
  async function ensureProject(goal) {
    if (root) return;
    const { installedClis, assignClis, scaffold } = await import('../commands/init.js');
    const lang = guessLang(goal, store.state.lang);
    setLang(lang);
    store.set({ lang });
    const clis = assignClis(PRESETS.squad.roles, installedClis());
    config = defaultConfig({ project: path.basename(cwd), lang, preset: 'squad', clis });
    config.goal = goal;
    scaffold(cwd, config);
    const r = await syncProject(cwd, config);
    installHooks(cwd, r.clis);
    root = cwd;
    store.set({ initialized: true, goal, project: config.project });
    store.addMessage({ from: 'system', text: t(`Proyecto creado en ${path.join(cwd, '.moragent')} (equipo: ${Object.keys(config.crew).join(', ')}).`, `Project created in ${path.join(cwd, '.moragent')} (crew: ${Object.keys(config.crew).join(', ')}).`) });
    await refreshCounts();
  }

  // ---------- orchestrator turn ----------
  async function orchestratorTurn(prompt, { status = 'thinking' } = {}) {
    const id = store.state.orchestrator.provider;
    const p = id && provider(id);
    if (!p) {
      store.addMessage({ from: 'system', text: t('No hay ningún motor listo. Usa /login para conectar una suscripción o una API key.', 'No engine is ready. Use /login to connect a subscription or an API key.') });
      return null;
    }
    store.set({ orchestrator: { ...store.state.orchestrator, status } });
    const msgId = store.addMessage({ from: 'orchestrator', text: '', streaming: true });
    const ac = new AbortController();
    controllers.add(ac);
    let text = '';
    const system = orchestratorSystem({ config, providers: store.state.providers });
    // Subscription engines keep their own conversation (resume); API engines get a short transcript.
    const resumable = p.kind === 'subscription' && session.provider === id && session.id;
    let fullPrompt = prompt;
    if (p.kind !== 'subscription') {
      const history = store.state.messages.filter((m) => m.from !== 'system' && m.text && m.id !== msgId).slice(-8)
        .map((m) => `${m.from === 'user' ? 'Persona' : m.from}: ${m.text}`).join('\n\n');
      fullPrompt = history ? `${history}\n\n---\n\n${prompt}` : prompt;
    }
    try {
      const res = await p.run({
        root, prompt: fullPrompt, system, sessionId: resumable ? session.id : null,
        autonomy: 'readonly', model: store.state.orchestrator.model || undefined, signal: ac.signal, logFile: path.join(dirs(root).runs, 'orchestrator.log'),
        onEvent: (e) => {
          if (e.type === 'start' && e.model) store.set({ orchestrator: { ...store.state.orchestrator, activeModel: e.model } });
          if (e.type === 'text') { text += e.delta; store.updateMessage(msgId, { text: stripPlan(text) }); }
          if (e.type === 'tool') store.set({ orchestrator: { ...store.state.orchestrator, status: 'reading' } });
        },
      });
      if (res?.sessionId) session = { id: res.sessionId, provider: id };
      if (!text && res?.text) text = res.text;
      const shown = stripPlan(text) || (res?.ok === false ? t(`Error del motor: ${res.error || 'sin detalle'}`, `Engine error: ${res.error || 'no detail'}`) : '');
      store.updateMessage(msgId, { text: shown, streaming: false });
      return text;
    } catch (e) {
      store.updateMessage(msgId, { text: t(`Error del motor: ${e.message}`, `Engine error: ${e.message}`), streaming: false });
      return null;
    } finally {
      controllers.delete(ac);
      store.set({ orchestrator: { ...store.state.orchestrator, status: 'idle' } });
    }
  }

  // ---------- subagents ----------
  async function runTask(task, planTask) {
    const member = config.crew?.[task.role] || {};
    const p = provider(planTask.provider);
    if (!p) {
      updateTask(root, task.id, { status: 'failed', result: 'no provider' });
      store.setAgent(task.id, { status: 'failed', lastLine: t('sin motor disponible', 'no engine available') });
      return { taskId: task.id, role: task.role, provider: planTask.provider, title: task.title, status: 'failed', summary: '' };
    }
    const envelope = await buildEnvelope({ root, task, config, exitProtocol: false });
    writeText(path.join(dirs(root).tasks, `${task.id}.md`), envelope);
    const logFile = path.join(dirs(root).runs, `${task.role}-${task.id}.log`);
    const execution = {
      mode: 'engine', handle: `pid:${process.pid}`, pid: process.pid,
      provider: planTask.provider, logFile, updatedAt: nowISO(),
    };
    updateTask(root, task.id, { status: 'running', execution });
    store.setAgent(task.id, { status: 'running', startedAt: new Date().toISOString(), lastLine: t('empezando…', 'starting…') });
    const ac = new AbortController();
    controllers.add(ac);
    let text = '';
    let res;
    try {
      res = await p.run({
        root, prompt: envelope, autonomy: member.autonomy || 'auto', model: member.model, signal: ac.signal,
        logFile,
        onEvent: (e) => {
          if (e.type === 'start') {
            store.setAgent(task.id, { ...(e.sessionId ? { sessionId: e.sessionId } : {}), ...(e.model ? { model: e.model } : {}) });
            if (e.sessionId) updateTask(root, task.id, { execution: { ...execution, sessionId: e.sessionId, updatedAt: nowISO() } });
          }
          if (e.type === 'text') text += e.delta;
          const cur = store.state.agents[task.id];
          const line = lastLineFrom(e, cur?.lastLine);
          store.setAgent(task.id, { lastLine: line, log: appendLog(cur?.log, e) });
        },
      });
    } catch (e) {
      res = { ok: false, error: e.message };
    } finally {
      controllers.delete(ac);
    }
    let summary = (res?.text || text || res?.error || '').trim();
    let status = ac.signal.aborted ? 'failed' : res?.ok === false ? 'failed' : blockedText(summary) ? 'blocked' : 'done';
    // A worker that followed AGENTS.md may have closed the task itself (mora done/block): keep its
    // verdict and its memory note instead of writing a second one.
    const closedByWorker = ['done', 'blocked'].includes(getTask(root, task.id).status);
    if (closedByWorker) {
      const own = getTask(root, task.id);
      status = own.status;
      summary = String(own.result || summary);
    } else {
      updateTask(root, task.id, { status, result: summary.slice(0, 4000) });
    }
    if (res?.sessionId) store.setAgent(task.id, { sessionId: res.sessionId });
    store.setAgent(task.id, { status, endedAt: new Date().toISOString(), elapsedMs: Date.now() - Date.parse(store.state.agents[task.id]?.startedAt || new Date().toISOString()), lastLine: summary.split('\n').filter(Boolean).pop()?.slice(0, 120) || status });
    const memory = closedByWorker ? null : await optional('../memory/index.js');
    try {
      memory?.add?.({ root, tier: 'episodic', kind: 'episode', title: `${task.id}: ${task.title}`, body: summary || status, tags: [task.role, planTask.provider], links: [task.id, task.spec].filter(Boolean), by: task.role });
    } catch { /* memory is best effort */ }
    await refreshBrain(root);
    await refreshCounts();
    store.addMessage({ from: 'agent', agent: task.role, provider: planTask.provider, taskId: task.id, text: `${status === 'done' ? '✓' : status === 'blocked' ? '!' : '✗'} ${task.id} ${task.title}${summary ? `\n${brief(summary)}` : ''}` });
    return { taskId: task.id, role: task.role, provider: planTask.provider, title: task.title, status, summary };
  }

  async function runPlan(plan) {
    assignProviders(plan, { crew: config.crew, providers: store.state.providers, orchestrator: store.state.orchestrator.provider });
    const spec = store.state.spec?.slug || null;
    const byPlanId = {};
    for (const pt of plan.tasks) {
      const body = pt.doneWhen ? `${pt.prompt}\n\n${t('Listo cuando', 'Done when')}: ${pt.doneWhen}` : pt.prompt;
      const task = createTask({ root, title: pt.title, role: pt.role, body, spec, by: 'lead' });
      byPlanId[pt.id] = { task, pt };
      store.setAgent(task.id, { id: task.id, role: pt.role, provider: pt.provider, status: 'queued', taskId: task.id, title: pt.title, lastLine: pt.dependsOn.length ? t(`espera ${pt.dependsOn.join(', ')}`, `waits for ${pt.dependsOn.join(', ')}`) : t('en cola', 'queued') });
    }
    store.set({ orchestrator: { ...store.state.orchestrator, status: 'running' } });
    const ticker = setInterval(() => {
      for (const a of Object.values(store.state.agents)) {
        if (a.status === 'running' && a.startedAt) store.setAgent(a.id, { elapsedMs: Date.now() - Date.parse(a.startedAt) });
      }
    }, 1000);
    ticker.unref?.();
    const results = {};
    const running = new Map();
    const pending = new Set(Object.keys(byPlanId));
    while (pending.size || running.size) {
      for (const pid of [...pending]) {
        if (running.size >= CONCURRENCY) break;
        const { pt } = byPlanId[pid];
        const depsDone = pt.dependsOn.every((d) => results[d]);
        const depsFailed = pt.dependsOn.some((d) => results[d] && results[d].status !== 'done');
        if (depsFailed) {
          pending.delete(pid);
          const { task } = byPlanId[pid];
          updateTask(root, task.id, { status: 'blocked', result: 'dependency failed' });
          store.setAgent(task.id, { status: 'blocked', lastLine: t('bloqueada: falló una dependencia', 'blocked: a dependency failed') });
          results[pid] = { taskId: task.id, role: task.role, provider: pt.provider, title: task.title, status: 'blocked', summary: 'dependency failed' };
          continue;
        }
        if (!depsDone) continue;
        pending.delete(pid);
        running.set(pid, runTask(byPlanId[pid].task, pt).then((r) => { results[pid] = r; running.delete(pid); }));
      }
      if (running.size) await Promise.race(running.values());
      else if (pending.size) break; // unreachable dependencies
    }
    clearInterval(ticker);
    store.set({ orchestrator: { ...store.state.orchestrator, status: 'idle' } });
    return Object.values(results);
  }

  async function handleAnswer(text, { retried = false } = {}) {
    const plan = text && extractPlan(text);
    if (!plan) return;
    if (plan.error) {
      if (!retried) {
        // One automatic repair round: the model re-emits only the block, the person does nothing.
        const again = await orchestratorTurn(t('Tu bloque moragent-plan no es JSON válido. Reemítelo completo y válido (escapa comillas y saltos de línea dentro de los strings), sin repetir la explicación.', 'Your moragent-plan block is not valid JSON. Re-emit it complete and valid (escape quotes and newlines inside strings), without repeating the explanation.'));
        return handleAnswer(again, { retried: true });
      }
      store.addMessage({ from: 'system', text: t('El orquestador no logró armar un plan válido. Reformula el pedido o divídelo en partes.', 'The orchestrator could not produce a valid plan. Rephrase the request or split it.') });
      return;
    }
    store.addMessage({ from: 'system', text: t(`Plan ${plan.size || ''} · ${plan.tasks.length} subagente(s): ${plan.summary}`, `Plan ${plan.size || ''} · ${plan.tasks.length} subagent(s): ${plan.summary}`) });
    const results = await runPlan(plan);
    if (!results.length) return;
    const review = await orchestratorTurn(reviewPrompt({ results, es: config.lang !== 'en' }), { status: 'reviewing' });
    if (review && extractPlan(review) && reviewRounds < MAX_REVIEW_ROUNDS) {
      reviewRounds++;
      await handleAnswer(review);
    }
  }

  // ---------- public API ----------
  engine.send = async (text) => {
    const msg = String(text || '').trim();
    if (!msg) return;
    store.addMessage({ from: 'user', text: msg });
    if (!store.state.providers.length) await engine.refreshProviders();
    await ensureProject(msg);
    reviewRounds = 0;
    let memory = '';
    const mem = await optional('../memory/index.js');
    try { memory = mem?.contextPack ? mem.contextPack({ root, role: 'lead', query: msg, budget: 4000, lang: config.lang }) : ''; } catch { memory = ''; }
    const answer = await orchestratorTurn(turnPrompt({ text: msg, memory, es: config.lang !== 'en' }));
    await handleAnswer(answer);
  };

  engine.command = async (name, args = []) => {
    const list = Array.isArray(args) ? args : [];
    switch (name) {
      case 'help': case 'ayuda':
        store.addMessage({ from: 'system', text: helpText() });
        return;
      case 'login': {
        if (args && !Array.isArray(args) && args.id && args.key) {
          const cred = await optional('../providers/credentials.js');
          cred?.setKey?.(args.id, args.key);
          store.addMessage({ from: 'system', text: t(`Clave guardada para ${args.id}.`, `Key saved for ${args.id}.`) });
        } else if (args && !Array.isArray(args) && args.id) {
          // Subscription engine without a session: run its own login in a real pane.
          const p = provider(args.id);
          const { shq } = await import('../core/exec.js');
          const cmd = Array.isArray(p?.loginCommand) ? p.loginCommand.map(shq).join(' ') : store.state.providers.find((x) => x.id === args.id)?.loginHint;
          if (cmd) await runInPane({ title: `login ${args.id}`, command: cmd, role: args.id });
        }
        await engine.refreshProviders();
        return;
      }
      case 'orquestador': case 'orchestrator': {
        const id = list[0];
        if (!id || !store.state.providers.find((p) => p.id === id)) {
          store.addMessage({ from: 'system', text: t(`Uso: /orquestador <${store.state.providers.map((p) => p.id).join('|')}>`, `Usage: /orchestrator <${store.state.providers.map((p) => p.id).join('|')}>`) });
          return;
        }
        session = { id: null, provider: null };
        store.set({ orchestrator: { ...store.state.orchestrator, provider: id } });
        if (root) { config.orchestrator = id; saveConfig(root, config); }
        store.addMessage({ from: 'system', text: t(`Orquestador: ${id}`, `Orchestrator: ${id}`) });
        return;
      }
      case 'tarea': case 'desplegar': case 'task': case 'deploy': {
        // Explicit deployment: one subagent for one task, no planning round.
        const roles = Object.keys(config?.crew || {}).filter((r) => r !== 'lead');
        const [role, ...words] = list;
        const body = words.join(' ').trim();
        if (!role || !body || (root && !roles.includes(role))) {
          store.addMessage({ from: 'system', text: t(`Uso: /tarea <rol> <qué hacer>\nRoles: ${roles.join(', ') || 'backend, frontend, helper, dev'}\nEjemplo: /tarea backend crea temp.js con cToF y su test`, `Usage: /task <role> <what to do>\nRoles: ${roles.join(', ') || 'backend, frontend, helper, dev'}\nExample: /task backend create temp.js with cToF and a test`) });
          return;
        }
        if (!store.state.providers.length) await engine.refreshProviders();
        store.addMessage({ from: 'user', text: `/tarea ${role} ${body}` });
        await ensureProject(body);
        const plan = { size: 'S', summary: body.slice(0, 80), tasks: [{ id: 't1', role, provider: null, title: body.slice(0, 100), prompt: body, doneWhen: '', dependsOn: [] }] };
        store.addMessage({ from: 'system', text: t(`Desplegando ${role} (${config.crew[role]?.cli || '?'})…`, `Deploying ${role} (${config.crew[role]?.cli || '?'})…`) });
        await runPlan(plan);
        return;
      }
      case 'modelo': case 'model': {
        // /modelo · /modelo <nombre> · /modelo <rol> <nombre> · "default" vuelve al del motor.
        const roles = Object.keys(config?.crew || {});
        const [a, b] = list;
        const clear = (v) => (v === 'default' || v === 'defecto' ? null : v);
        const hints = t('Ejemplos — claude: opus, sonnet, haiku · codex: su id de modelo (codex --help) · agy: ver `agy models` · pi: proveedor/modelo · ollama: qwen3.5:9b', 'Examples — claude: opus, sonnet, haiku · codex: its model id (codex --help) · agy: see `agy models` · pi: provider/model · ollama: qwen3.5:9b');
        if (!a) {
          const o = store.state.orchestrator;
          const rows = [`${t('orquestador', 'orchestrator')} ${o.provider || '-'} · ${o.model || t('por defecto', 'default')}${o.activeModel ? t(` (en uso: ${o.activeModel})`, ` (active: ${o.activeModel})`) : ''}`,
            ...roles.filter((r) => r !== 'lead').map((r) => `${r.padEnd(9)} ${config.crew[r].cli} · ${config.crew[r].model || t('por defecto', 'default')}`)];
          store.addMessage({ from: 'system', text: `${t('Modelos', 'Models')} (/modelo <nombre> · /modelo <rol> <nombre> · default):\n${rows.join('\n')}\n${hints}` });
          return;
        }
        if (b !== undefined && (roles.includes(a) || a === 'orquestador' || a === 'orchestrator')) {
          if (a === 'orquestador' || a === 'orchestrator' || a === 'lead') return engine.command('modelo', [b]);
          if (!root) { store.addMessage({ from: 'system', text: t('Todavía no hay proyecto.', 'No project yet.') }); return; }
          config.crew[a] = { ...config.crew[a], model: clear(b) };
          if (!config.crew[a].model) delete config.crew[a].model;
          saveConfig(root, config);
          store.addMessage({ from: 'system', text: t(`${a} usará ${clear(b) || 'el modelo por defecto'} (${config.crew[a].cli}).`, `${a} will use ${clear(b) || 'the default model'} (${config.crew[a].cli}).`) });
          return;
        }
        const model = clear(a);
        store.set({ orchestrator: { ...store.state.orchestrator, model, activeModel: null } });
        if (root) { if (model) config.orchestratorModel = model; else delete config.orchestratorModel; saveConfig(root, config); }
        store.addMessage({ from: 'system', text: t(`Orquestador: ${store.state.orchestrator.provider} · ${model || 'modelo por defecto'}. Si el modelo no existe, el motor lo dirá en la próxima respuesta.`, `Orchestrator: ${store.state.orchestrator.provider} · ${model || 'default model'}. If the model does not exist, the engine will say so on the next answer.`) });
        return;
      }
      case 'equipo': case 'crew': {
        if (!root) { store.addMessage({ from: 'system', text: t('Todavía no hay proyecto: escribe qué quieres construir.', 'No project yet: say what you want to build.') }); return; }
        const [role, cli] = list;
        if (role && cli) {
          config.crew[role] = { ...(config.crew[role] || { title: role, mission: '' }), cli };
          saveConfig(root, config);
          await syncProject(root, config);
          store.addMessage({ from: 'system', text: t(`${role} ahora usa ${cli}.`, `${role} now uses ${cli}.`) });
          return;
        }
        const rows = Object.entries(config.crew).map(([r, m]) => {
          const p = store.state.providers.find((x) => x.id === m.cli);
          return `${r.padEnd(9)} ${m.cli.padEnd(9)} ${p ? (p.ready ? '✓' : '○ ' + (p.loginHint || '')) : ''}`;
        });
        store.addMessage({ from: 'system', text: `${t('Equipo', 'Crew')} (/equipo <rol> <motor>):\n${rows.join('\n')}` });
        return;
      }
      case 'memoria': case 'memory': {
        if (!root) return;
        const mem = await optional('../memory/index.js');
        if (list.length && mem?.recall) {
          const hits = mem.recall({ root, query: list.join(' '), limit: 5, includeSpecs: true });
          store.addMessage({ from: 'system', text: hits.length ? hits.map((h) => `• [${h.note.tier}] ${h.note.title}\n  ${String(h.snippet || '').slice(0, 160)}`).join('\n') : t('Sin coincidencias.', 'No matches.') });
        } else {
          const m = store.state.memory;
          const recent = mem?.list ? mem.list({ root, limit: 5 }).map((n) => `• [${n.tier}] ${n.title}`).join('\n') : '';
          store.addMessage({ from: 'system', text: `${t('Memoria', 'Memory')}: ${m.canonical} ${t('canónica', 'canonical')} · ${m.episodic} ${t('episódica', 'episodic')} · ${m.transient} ${t('transitoria', 'transient')}\n${recent}\n${t('Busca con /memoria <texto>', 'Search with /memory <text>')}` });
        }
        return;
      }
      case 'abrir': case 'open':
        await openPane(list[0]);
        return;
      case 'sesiones': case 'sessions': {
        sessionsMod = sessionsMod || await optional('./sessions.js');
        const all = listSaved();
        store.set({ sessions: all });
        store.addMessage({ from: 'system', text: all.length
          ? `${t('Sesiones', 'Sessions')} (/sesion <n>):\n${all.slice(0, 15).map((x, i) => `${i + 1}. ${x.title || t('(sin título)', '(untitled)')} — ${ago(x.updatedAt)} · ${x.messages} ${t('mensajes', 'messages')}${x.id === store.state.sessionId ? t(' · actual', ' · current') : ''}`).join('\n')}`
          : t('Todavía no hay sesiones guardadas.', 'No saved sessions yet.') });
        return;
      }
      case 'sesion': case 'session': {
        const all = listSaved();
        const ref = list[0];
        const pick = /^\d+$/.test(ref || '') ? all[Number(ref) - 1] : all.find((x) => x.id === ref || x.id.startsWith(ref || '-'));
        const loaded = pick && sessionsMod?.loadSession?.(root, pick.id);
        if (!loaded) { store.addMessage({ from: 'system', text: t('Uso: /sesion <número> (ver /sesiones)', 'Usage: /session <number> (see /sessions)') }); return; }
        persist();
        current = loaded;
        session = { id: loaded.providerSessionId || null, provider: loaded.provider || null };
        store.set({
          messages: loaded.messages || [], agents: loaded.agents || {}, sessionId: loaded.id,
          orchestrator: { ...store.state.orchestrator, provider: loaded.provider || store.state.orchestrator.provider, status: 'idle' },
        });
        store.addMessage({ from: 'system', text: t(`Sesión retomada: ${loaded.title || loaded.id}. El orquestador conserva su contexto.`, `Session resumed: ${loaded.title || loaded.id}. The orchestrator keeps its context.`) });
        return;
      }
      case 'limpiar': case 'clear': {
        persist();
        current = null;
        session = { id: null, provider: null };
        store.set({ messages: [], agents: {}, sessionId: null, sessions: listSaved() });
        engine.welcome();
        return;
      }
      case 'agentes': case 'agents': {
        const agents = Object.values(store.state.agents);
        store.addMessage({ from: 'system', text: agents.length
          ? agents.map((a) => `${a.id} ${a.role} (${a.provider}) — ${a.status}${a.lastLine ? `: ${a.lastLine}` : ''}`).join('\n') + t('\nTab abre el detalle de cada proceso.', '\nTab opens each process in detail.')
          : t('Todavía no hay agentes en esta sesión.', 'No agents in this session yet.') });
        return;
      }
      case 'estado': case 'status': {
        store.addMessage({ from: 'system', text: root
          ? formatStatus(readStatus(root, list[0] || null, { config }))
          : t('No hay proyecto MORAGENT en esta carpeta.', 'No MORAGENT project in this folder.') });
        return;
      }
      case 'nuevo': case 'new': {
        // Start a separate project in the current folder instead of the one found above it.
        if (root && path.resolve(root) === path.resolve(cwd)) { store.addMessage({ from: 'system', text: t('Esta carpeta ya es el proyecto actual.', 'This folder already is the current project.') }); return; }
        root = null; config = null; session = { id: null, provider: null };
        store.set({ initialized: false, agents: {}, project: path.basename(cwd), goal: '', memory: memoryCounts(null), spec: null, brain: { linked: false, vault: null } });
        store.addMessage({ from: 'system', text: t(`Listo: el próximo mensaje crea un proyecto nuevo en ${cwd}.`, `Done: your next message creates a new project in ${cwd}.`) });
        return;
      }
      case 'cancel': case 'cancelar':
        for (const ac of controllers) ac.abort();
        store.addMessage({ from: 'system', text: t('Trabajo en curso cancelado.', 'Running work cancelled.') });
        return;
      case 'plan':
        if (list.length) await engine.send(`${t('Arma un plan para esto', 'Make a plan for this')}: ${list.join(' ')}`);
        return;
      default:
        store.addMessage({ from: 'system', text: t(`Comando desconocido: /${name}. Prueba /help`, `Unknown command: /${name}. Try /help`) });
    }
  };

  // Take a subagent out into a real terminal pane: resume its session interactively when the
  // engine supports it, otherwise follow its log.
  async function openPane(ref) {
    const agents = Object.values(store.state.agents);
    const a = agents.find((x) => x.id === String(ref || '').toUpperCase() || x.role === ref) || agents.filter((x) => x.role === ref).pop();
    if (!a) { store.addMessage({ from: 'system', text: t(`Uso: /abrir <rol|T-XXXX> (${agents.map((x) => x.id).join(', ') || 'sin agentes aún'})`, `Usage: /open <role|T-XXXX> (${agents.map((x) => x.id).join(', ') || 'no agents yet'})`) }); return; }
    const { shq } = await import('../core/exec.js');
    const resume = { claude: (s) => `claude --resume ${shq(s)}`, codex: (s) => `codex resume ${shq(s)}`, agy: (s) => `agy --conversation ${shq(s)}`, pi: (s) => `pi --session ${shq(s)}` };
    const log = path.join(dirs(root).runs, `${a.role}-${a.id}.log`);
    const command = a.sessionId && resume[a.provider] ? resume[a.provider](a.sessionId) : `tail -n 200 -f ${shq(log)}`;
    await runInPane({ title: `${a.role} ${a.id}`, command, role: a.role });
  }

  // Run a command in a real terminal pane next to this one (Orca/herdr/tmux), or tell the user
  // exactly what to run when there is no multiplexer.
  async function runInPane({ title, command, role }) {
    const { detectMux, getMux } = await import('../mux/index.js');
    let muxName;
    try { muxName = detectMux(config?.mux || 'auto'); } catch { muxName = 'headless'; }
    if (muxName === 'headless') { store.addMessage({ from: 'system', text: t(`No hay multiplexor (Orca/herdr/tmux). Ejecuta en otra terminal:\n${command}`, `No multiplexer (Orca/herdr/tmux). Run in another terminal:\n${command}`) }); return; }
    try {
      const { handle } = getMux(muxName).spawn({ root: root || cwd, role, title, command, cwd: root || cwd, layout: config?.layout || 'split' });
      store.addMessage({ from: 'system', text: t(`${title}: abierto en ${muxName} (${handle}).`, `${title}: opened in ${muxName} (${handle}).`) });
    } catch (e) {
      store.addMessage({ from: 'system', text: t(`No se pudo abrir el panel: ${e.message}\n${command}`, `Could not open the pane: ${e.message}\n${command}`) });
    }
  }

  // Model catalog of one engine, for pickers. Never throws.
  engine.listModels = async (id) => {
    try { return (await provider(id)?.listModels?.()) || []; } catch { return []; }
  };
  engine.roleEngine = (role) => config?.crew?.[role]?.cli || null;

  engine.stop = () => { for (const ac of controllers) ac.abort(); };

  function helpText() {
    return t(`Escribe lo que necesitas y el orquestador decide si responde o despliega agentes.
/tarea <rol> <texto>  desplegar un agente directo (ej: /tarea backend crea temp.js)
/login            conectar suscripciones o API keys
/equipo           ver el equipo · /equipo <rol> <motor> para cambiarlo
/orquestador <m>  elegir el motor del orquestador
/modelo [rol] <n> ver o cambiar el modelo (del orquestador o de un rol)
/memoria [texto]  ver o buscar en la memoria
/nuevo            crear un proyecto nuevo en esta carpeta
/sesiones         ver conversaciones guardadas · /sesion <n> retomar · /limpiar empezar de cero
/agentes          estado de los subagentes (Tab: detalle de cada proceso)
/estado [id]      estado local de tareas y próxima acción (solo lectura)
/plan <texto>     pedir un plan explícito
/abrir <rol|id>   sacar un subagente a un panel externo
/cancel           cancelar lo que está corriendo
/salir            salir (Ctrl+C dos veces)`, `Type what you need; the orchestrator either answers or deploys agents.
/task <role> <text>   deploy one agent directly (e.g. /task backend create temp.js)
/login            connect subscriptions or API keys
/crew             show the crew · /crew <role> <engine> to change it
/orchestrator <e> pick the orchestrator engine
/model [role] <n> show or change the model (orchestrator or a role)
/memory [text]    show or search memory
/new              create a new project in this folder
/sessions         saved conversations · /session <n> resume · /clear start fresh
/agents           subagent status (Tab: each process in detail)
/status [id]      local task health and next action (read-only)
/plan <text>      ask for an explicit plan
/open <role|id>   take a subagent out into a terminal pane
/cancel           cancel running work
/exit             quit (Ctrl+C twice)`);
  }

  if (root) ensureDir(dirs(root).runs);
  // brief: the terminal UI already printed the logo and connected engines; say only what to do next.
  engine.welcome = ({ brief = false } = {}) => {
    const ready = store.state.providers.filter((p) => p.ready).map((p) => p.label);
    const conn = brief ? (ready.length ? '' : t('Ningún motor conectado: usa /login.', 'No engine connected: use /login.'))
      : ready.length ? t(`Conectado: ${ready.join(', ')}.`, `Connected: ${ready.join(', ')}.`) : t('Ningún motor conectado: usa /login.', 'No engine connected: use /login.');
    const saved = (store.state.sessions || []).length;
    const resumeHint = saved ? t(`\n${saved} sesión(es) anterior(es): /sesiones para verlas.`, `\n${saved} previous session(s): /sessions to see them.`) : '';
    const elsewhere = root && path.resolve(root) !== path.resolve(cwd);
    const where = elsewhere ? t(` (en ${root}; para un proyecto nuevo en esta carpeta usa /nuevo)`, ` (in ${root}; for a new project in this folder use /new)`) : '';
    store.addMessage({ from: 'orchestrator', text: root
      ? t(`${conn ? `${conn}\n` : ''}Proyecto ${config.project}${where}. ¿Qué hacemos? Pide algo o usa /tarea para desplegar un agente.${resumeHint}`, `${conn ? `${conn}\n` : ''}Project ${config.project}${where}. What are we doing? Ask, or use /task to deploy an agent.${resumeHint}`)
      : t(`${conn ? `${conn}\n` : ''}Esta carpeta todavía no es un proyecto MORAGENT. Cuéntame qué quieres construir y lo preparo.`, `${conn ? `${conn}\n` : ''}This folder is not a MORAGENT project yet. Tell me what you want to build and I will set it up.`) });
  };
  return engine;
}
