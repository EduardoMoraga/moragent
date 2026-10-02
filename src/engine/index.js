import path from 'node:path';
import { dirs, findRoot } from '../core/paths.js';
import { loadConfig, saveConfig, defaultConfig, PRESETS, ROLES, CLI_IDS } from '../core/config.js';
import fs from 'node:fs';
import { listFiles, writeText, ensureDir } from '../core/fsx.js';
import { detectLang, setLang, t } from '../core/i18n.js';
import { syncProject } from '../core/sync.js';
import { installHooks } from '../core/hooks.js';
import { refreshBrain } from '../core/brain-refresh.js';
import { createTask, updateTask, getTask } from '../bus/tasks.js';
import { buildEnvelope } from '../bus/envelope.js';
import { createStore } from './store.js';
import { extractPlan, stripPlan, assignProviders } from './plan.js';
import { exactCheckTarget, literalSingleLineExpectation, parseExplicitFileChecks, requiresExactFileCheck, verifyTaskChecks } from './acceptance.js';
import { orchestratorSystem, orchestratorRepairSystem, turnPrompt, reviewPrompt } from './prompts.js';
import { isGreeting, normalizeGreeting } from '../core/greeting.js';
import { inspectRecovery, listRecoveries } from './workspace.js';
import { applyRecoveryAsync, createTaskWorkspaceAsync } from './workspace-async.js';

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

// Match only complete, short greetings. A greeting followed by a request must bootstrap normally.
function greetingLanguage(text) {
  const greeting = normalizeGreeting(text);
  if (isGreeting(greeting)) return /^(hello|hi|hey|hiya|howdy|greetings|good\s)/.test(greeting) ? 'en' : 'es';
  return null;
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
const promisedPlan = (text) => /\b(?:I will|I'll|I’m going to|I'm going to|voy a|vamos a)\b[^\n]{0,160}\bplan\b/i.test(String(text || ''));
const toolProtocolFailure = (error) => /^HTTP 5\d\d\b/i.test(String(error || ''))
  && /XML syntax|tool[ _-]?call|function/i.test(String(error || ''));

// `providers` ({ listProviders, getProvider }) is injectable for tests; defaults to src/providers.
export async function createEngine({ root = findRoot(), config = null, cwd = process.cwd(), providers = null, lang = null, taskWorkspaceFactory = createTaskWorkspaceAsync } = {}) {
  if (root && !config) config = loadConfig(root);
  const initialLang = lang || config?.lang || detectLang();
  const initialProvider = config?.orchestrator || config?.crew?.lead?.cli || null;
  const initialModel = config?.orchestratorModel || null;
  setLang(initialLang);
  const store = createStore({
    project: config?.project || path.basename(cwd),
    goal: config?.goal || '',
    lang: initialLang,
    initialized: !!root,
    orchestrator: { provider: initialProvider, model: initialModel, activeModel: null, status: 'idle' },
    messages: [],
    agents: {},
    memory: memoryCounts(root),
    spec: await activeSpec(root),
    brain: { linked: !!config?.brain?.vault, vault: config?.brain?.vault || null },
    providers: [],
    notice: null,
    recoveryApplying: false,
  });

  let providersMod = providers || await optional('../providers/index.js');
  let session = { id: null, provider: null };
  const controllers = new Set();
  const activePlans = new Set();
  let sendTail = Promise.resolve();
  let pendingTurns = 0;
  let pendingDeployments = 0;
  let turnEpoch = 0;
  let languagePinned = !!lang || !!process.env.MORAGENT_LANG;
  let preferredProvider = initialProvider;
  let preferredModel = initialModel;
  let providerRefreshDeferred = false;
  let stopped = false;
  let recoveryApplying = false;
  let reviewRounds = 0;

  const engine = { store, get root() { return root; }, get config() { return config; } };
  const promptConfig = () => ({
    ...config,
    lang: store.state.lang,
    crew: Object.fromEntries(Object.entries(config?.crew || {}).map(([role, member]) => {
      const defaults = ROLES[role]?.mission;
      const mission = defaults && member.mission === defaults[config.lang] ? defaults[store.state.lang] : member.mission;
      return [role, { ...member, mission }];
    })),
  });

  // ---------- sessions: every conversation is saved and can be resumed ----------
  let sessionsMod = await optional('./sessions.js');
  let current = null;
  const listSaved = () => (root && sessionsMod?.listSessions ? sessionsMod.listSessions(root) : []);
  store.set({ sessions: listSaved(), sessionId: null });
  let saveTimer = null;
  const persist = () => {
    if (!root || !sessionsMod?.saveSession) return;
    if (!store.state.messages.some((m) => m.from === 'user')) return;
    if (!current) current = sessionsMod.createSession(root, { provider: store.state.orchestrator.provider, model: store.state.orchestrator.model });
    current.messages = store.state.messages.map((m) => ({ ...m, streaming: false }));
    current.agents = Object.fromEntries(Object.entries(store.state.agents).map(([k, a]) => [k, { ...a, log: (a.log || []).slice(-80) }]));
    current.provider = session.provider || store.state.orchestrator.provider;
    current.model = store.state.orchestrator.model;
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
  const applyDeferredProviderRefresh = async () => {
    if (stopped || !providerRefreshDeferred || pendingTurns || pendingDeployments) return;
    providerRefreshDeferred = false;
    try { await engine.refreshProviders(); }
    catch (error) { store.addMessage({ from: 'system', text: t(`No pude actualizar los motores: ${error.message}`, `Could not refresh engines: ${error.message}`) }); }
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
    const ready = (id) => !!id && list.some((p) => p.id === id && p.ready);
    const preferredReady = ready(preferredProvider);
    const pick = list.find((p) => p.kind === 'subscription' && p.ready) || list.find((p) => p.ready);
    const next = preferredReady ? preferredProvider : ready(cur) ? cur : pick?.id || preferredProvider || cur;
    if (next !== cur && ['thinking', 'reading', 'running', 'reviewing'].includes(store.state.orchestrator.status)) {
      providerRefreshDeferred = true;
      return list;
    }
    const nextModel = next === preferredProvider ? preferredModel : next === cur ? store.state.orchestrator.model : null;
    if (next !== cur || nextModel !== store.state.orchestrator.model) {
      if (next !== cur) session = { id: null, provider: null };
      store.set({ orchestrator: { ...store.state.orchestrator, provider: next, model: nextModel, activeModel: null } });
      if (preferredProvider && next !== preferredProvider) {
        store.addMessage({ from: 'system', text: t(`El motor preferido ${preferredProvider} no está disponible; usando ${next} temporalmente. Su modelo no se enviará al sustituto.`, `Preferred engine ${preferredProvider} is unavailable; using ${next} temporarily. Its model will not be sent to the fallback.`) });
      } else if (preferredReady && cur && cur !== preferredProvider) {
        store.addMessage({ from: 'system', text: t(`${preferredProvider} volvió a estar disponible; restauré su modelo.`, `${preferredProvider} is available again; its model was restored.`) });
      }
    }
    return list;
  };

  const provider = (id) => providersMod?.getProvider?.(id);

  const refreshCounts = async () => store.set({ memory: memoryCounts(root), spec: await activeSpec(root) });

  // ---------- project bootstrap (first message in an empty folder) ----------
  async function ensureProject(goal) {
    if (root) return;
    const { installedClis, assignClis, scaffold } = await import('../commands/init.js');
    const lang = languagePinned ? store.state.lang : guessLang(goal, store.state.lang);
    setLang(lang);
    store.set({ lang });
    const clis = assignClis(PRESETS.adaptive.roles, installedClis());
    config = defaultConfig({ project: path.basename(cwd), lang, preset: 'adaptive', clis });
    config.goal = goal;
    // An automatically chosen API is still this project's orchestrator, not a one-turn accident.
    if (!preferredProvider) preferredProvider = store.state.orchestrator.provider;
    if (preferredProvider) config.orchestrator = preferredProvider;
    if (preferredModel) config.orchestratorModel = preferredModel;
    scaffold(cwd, config);
    const r = await syncProject(cwd, config);
    installHooks(cwd, r.clis);
    root = cwd;
    store.set({ initialized: true, goal, project: config.project });
    store.addMessage({ from: 'system', text: t(`Proyecto creado en ${path.join(cwd, '.moragent')} (equipo: ${Object.keys(config.crew).join(', ')}).`, `Project created in ${path.join(cwd, '.moragent')} (crew: ${Object.keys(config.crew).join(', ')}).`) });
    await refreshCounts();
  }

  // ---------- orchestrator turn ----------
  async function orchestratorTurn(prompt, { status = 'thinking', planRepair = false } = {}) {
    const id = store.state.orchestrator.provider;
    let p = null;
    try { if (id) p = provider(id); } catch { /* stale provider in project config */ }
    if (!p || !store.state.providers.some((entry) => entry.id === id && entry.ready)) {
      store.addMessage({ from: 'system', text: t('No hay ningún motor listo. Usa /login para conectar una suscripción o una API key.', 'No engine is ready. Use /login to connect a subscription or an API key.') });
      return null;
    }
    store.set({ orchestrator: { ...store.state.orchestrator, status, startedAt: new Date().toISOString(), activity: null } });
    const msgId = store.addMessage({ from: 'orchestrator', text: '', streaming: true });
    const ac = new AbortController();
    controllers.add(ac);
    let text = '';
    let sawTool = false;
    const system = planRepair && p.kind === 'api'
      ? orchestratorRepairSystem({ config: promptConfig(), providers: store.state.providers })
      : orchestratorSystem({ config: promptConfig(), providers: store.state.providers });
    // Subscription engines keep their own conversation (resume); API engines get a short transcript.
    const resumable = p.kind === 'subscription' && session.provider === id && session.id;
    let fullPrompt = prompt;
    if (p.kind !== 'subscription') {
      const past = store.state.messages.filter((m) => m.from !== 'system' && m.text && m.id !== msgId);
      const latestUser = past.findLastIndex((m) => m.from === 'user');
      const selected = planRepair
        ? past.filter((_, index) => index === latestUser || index >= past.length - 2)
        : past.slice(-8);
      const history = selected
        .map((m) => `${m.from === 'user' ? t('Persona', 'User') : m.from}: ${m.text}`).join('\n\n');
      fullPrompt = history ? `${history}\n\n---\n\n${prompt}` : prompt;
    }
    try {
      const runOptions = {
        root, prompt: fullPrompt, system, sessionId: resumable ? session.id : null,
        autonomy: 'readonly', toolsEnabled: planRepair && p.kind === 'api' ? false : undefined,
        model: store.state.orchestrator.model || undefined, signal: ac.signal, logFile: path.join(dirs(root).runs, 'orchestrator.log'),
        onEvent: (e) => {
          if (e.type === 'start' && e.model) store.set({ orchestrator: { ...store.state.orchestrator, activeModel: e.model } });
          if (e.type === 'text') { text += e.delta; store.updateMessage(msgId, { text: stripPlan(text) }); }
          if (e.type === 'tool') {
            sawTool = true;
            const target = e.input?.file_path || e.input?.path || e.input?.command || '';
            store.set({ orchestrator: { ...store.state.orchestrator, status: 'reading', activity: `${e.name}${target ? ` ${String(target).slice(0, 100)}` : ''}` } });
          }
          if (e.type === 'tool_result') store.set({ orchestrator: { ...store.state.orchestrator, status, activity: e.summary || null } });
        },
      };
      let res = await p.run(runOptions);
      // Some OpenAI-compatible servers fail while decoding a model's tool-call markup.
      // A readonly turn with no emitted text or tool use is safe to retry once without
      // offering tools. The worker still gets its normal tools after plan validation.
      if (p.kind === 'api' && !planRepair && !ac.signal.aborted && !text.trim() && !String(res?.text || '').trim()
          && !sawTool && res?.ok === false && toolProtocolFailure(res.error)) {
        store.addMessage({ from: 'system', text: t(
          'El servidor falló al generar una llamada a herramienta. Reintento una vez sin acceso al repositorio; si hace falta inspeccionarlo, el orquestador debe bloquearse o delegar esa inspección.',
          'The server failed while generating a tool call. Retrying once without repository access; if inspection is needed, the orchestrator must block or delegate that inspection.',
        ) });
        const fallbackSystem = `${system}\n\n${t(
          'En este intento no hay herramientas disponibles. No afirmes haber leído archivos. Si necesitas inspeccionar el repositorio para responder, comienza con BLOQUEADO: y explica por qué. Si puedes delegar la tarea, indica al worker que inspeccione los archivos necesarios.',
          'No tools are available in this attempt. Do not claim to have read files. If repository inspection is needed to answer, begin with BLOCKED: and explain why. If you can delegate the task, instruct the worker to inspect the necessary files.',
        )}`;
        res = await p.run({ ...runOptions, system: fallbackSystem, toolsEnabled: false });
      }
      // The provider's completed answer is authoritative. Streamed text can include
      // reasoning or a draft plan that the model superseded before finishing.
      if (typeof res?.text === 'string') text = res.text;
      const succeeded = res?.ok === true && !ac.signal.aborted && !!text.trim();
      if (succeeded) {
        if (typeof res.sessionId === 'string' && res.sessionId) session = { id: res.sessionId, provider: id };
        else if (!resumable) session = { id: null, provider: null };
      } else session = { id: null, provider: null };
      const error = res?.error || t('respuesta incompleta o vacía', 'incomplete or empty response');
      const resetHint = resumable ? t('El próximo intento abrirá una sesión nueva.', 'The next attempt will start a new session.') : '';
      const shown = succeeded ? stripPlan(text) : `${t(`Error del motor: ${error}`, `Engine error: ${error}`)}${resetHint ? `\n${resetHint}` : ''}`;
      store.updateMessage(msgId, { text: shown, streaming: false });
      return succeeded ? text : null;
    } catch (e) {
      session = { id: null, provider: null };
      const resetHint = resumable ? t('El próximo intento abrirá una sesión nueva.', 'The next attempt will start a new session.') : '';
      store.updateMessage(msgId, { text: `${t(`Error del motor: ${e.message}`, `Engine error: ${e.message}`)}${resetHint ? `\n${resetHint}` : ''}`, streaming: false });
      return null;
    } finally {
      controllers.delete(ac);
      store.set({ orchestrator: { ...store.state.orchestrator, status: 'idle', activity: null, startedAt: null } });
    }
  }

  // ---------- subagents ----------
  async function runTask(task, planTask, planState) {
    const cancelledBeforeStart = () => {
      const summary = t('cancelada antes de iniciar', 'cancelled before starting');
      updateTask(root, task.id, { status: 'failed', result: summary });
      store.setAgent(task.id, { status: 'failed', lastLine: summary, endedAt: new Date().toISOString() });
      return { taskId: task.id, role: task.role, provider: planTask.provider, title: task.title, status: 'failed', summary, doneWhen: planTask.doneWhen, files: null };
    };
    if (planState.cancelled || stopped) return cancelledBeforeStart();
    const member = config.crew?.[task.role] || {};
    const p = planTask.provider ? provider(planTask.provider) : null;
    if (!p || !store.state.providers.some((entry) => entry.id === planTask.provider && entry.ready)) {
      updateTask(root, task.id, { status: 'failed', result: 'no provider' });
      store.setAgent(task.id, { status: 'failed', lastLine: t('sin motor disponible', 'no engine available') });
      return { taskId: task.id, role: task.role, provider: planTask.provider, title: task.title, status: 'failed', summary: '', doneWhen: planTask.doneWhen, files: null };
    }
    const envelope = await buildEnvelope({ root, task, config: promptConfig(), exitProtocol: false });
    const ownCheckPaths = new Set((planTask.checks || []).map((check) => check.path));
    // A task with its own exact contract must not take over a sibling's checked file.
    // Tasks without checks may be legitimate upstream writers for a later checker.
    const protectedOtherPaths = ownCheckPaths.size
      ? planState.requiredChecks.filter((check) => !ownCheckPaths.has(check.path)).map((check) => check.path)
      : [];
    if (planState.cancelled || stopped) return cancelledBeforeStart();
    writeText(path.join(dirs(root).tasks, `${task.id}.md`), envelope);
    store.setAgent(task.id, { status: 'preparing', startedAt: new Date().toISOString(), lastLine: t('preparando copia privada…', 'preparing private copy…') });
    let workspace;
    try {
      workspace = await taskWorkspaceFactory(root, task.id, {
        signal: planState.controller.signal,
        publicationChecks: planState.requiredChecks,
        taskChecks: planTask.checks,
        protectedOtherPaths,
        onProgress: (phase) => {
          if (planState.cancelled || stopped) return;
          const line = phase === 'snapshot' ? t('verificando copia privada…', 'indexing private copy…') : t('copiando proyecto…', 'copying project…');
          store.setAgent(task.id, { lastLine: line });
        },
      });
    } catch (error) {
      if (planState.cancelled || stopped) return cancelledBeforeStart();
      throw error;
    }
    if (planState.cancelled || stopped) { await workspace.discard(); return cancelledBeforeStart(); }
    const ac = new AbortController();
    let providerStarted = false;
    try {
    controllers.add(ac);
    updateTask(root, task.id, { status: 'running' });
    store.setAgent(task.id, { status: 'running', startedAt: new Date().toISOString(), lastLine: t('empezando…', 'starting…') });
    if (planState.cancelled || ac.signal.aborted || stopped) {
      await workspace.discard();
      return cancelledBeforeStart();
    }
    let text = '';
    let res;
    try {
      providerStarted = true;
      res = await p.run({
        root: workspace.root, prompt: envelope, autonomy: member.autonomy || 'auto', model: planTask.provider === (member.provider || member.cli) ? member.model : undefined, signal: ac.signal,
        protectedOtherPaths,
        logFile: path.join(dirs(root).runs, `${task.role}-${task.id}.log`),
        onEvent: (e) => {
          if (e.type === 'start') store.setAgent(task.id, { ...(e.sessionId ? { sessionId: e.sessionId } : {}), ...(e.model ? { model: e.model } : {}) });
          if (e.type === 'text') text += e.delta;
          const cur = store.state.agents[task.id];
          const log = appendLog(cur?.log, e);
          const line = e.type === 'text' ? (log.filter((entry) => entry.kind === 'text').at(-1)?.text.slice(-120) || cur?.lastLine) : lastLineFrom(e, cur?.lastLine);
          store.setAgent(task.id, { lastLine: line, log });
        },
      });
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    // The completed result supersedes streamed progress, including an explicitly empty answer.
    const finalAnswer = typeof res?.text === 'string' ? res.text : text;
    const confirmed = String(finalAnswer || '').trim();
    let summary = String(res?.ok === true ? confirmed : res?.error || confirmed || '').trim();
    let integratedFiles = null;
    let integratedVerifiedChecks = [];
    let succeeded = res?.ok === true && !ac.signal.aborted && !planState.cancelled && !!confirmed;
    let acceptanceBlocked = false;
    if (!succeeded && !summary) summary = t('El motor no confirmó el resultado.', 'Engine did not confirm a result.');
    if (succeeded && !blockedText(summary) && planTask.checks?.length) {
      const failures = verifyTaskChecks(workspace.root, planTask.checks);
      if (failures.length) {
        acceptanceBlocked = true;
        succeeded = false;
        summary = `${t('BLOQUEADO: comprobación exacta fallida', 'BLOCKED: exact acceptance check failed')}: ${failures.join('; ')}`;
      }
    }
    if (succeeded && !blockedText(summary)) {
      let merge;
      try { merge = await workspace.integrate(); }
      catch (error) { merge = { ok: false, conflicts: [error.message], workspace: await workspace.preserve() }; }
      if (!merge.ok) {
        if (planState.cancelled) {
          succeeded = false;
          summary = `${t('Trabajo cancelado', 'Work cancelled')}. ${t('Espacio de trabajo conservado', 'Workspace preserved')}: ${merge.workspace}`;
        } else {
          const detail = merge.conflicts.join(', ');
          if (merge.acceptanceFailures?.length) {
            acceptanceBlocked = true;
            succeeded = false;
            const label = merge.scopeFailures?.length
              ? t('BLOQUEADO: tarea fuera de alcance', 'BLOCKED: task scope violation')
              : t('BLOQUEADO: comprobación exacta fallida', 'BLOCKED: exact acceptance check failed');
            summary = `${label}: ${detail}. ${t('Trabajo conservado en', 'Work preserved at')} ${merge.workspace}`;
          } else {
            summary = `${t('BLOQUEADO', 'BLOCKED')}: ${t('conflicto al incorporar rutas', 'path integration conflict')} (${detail}). ${t('Trabajo conservado en', 'Work preserved at')} ${merge.workspace}`;
          }
        }
      } else {
        integratedFiles = merge.files;
        integratedVerifiedChecks = merge.verifiedChecks || [];
        summary = workspace.rewritePaths(summary);
      }
    } else {
      const saved = await workspace.preserve(acceptanceBlocked ? { manualOnlyReason: 'acceptance-check-failed' } : undefined);
      summary = `${summary}${summary ? '\n' : ''}${t('Espacio de trabajo conservado', 'Workspace preserved')}: ${saved}`;
    }
    let status = acceptanceBlocked ? 'blocked' : !succeeded ? 'failed' : blockedText(summary) ? 'blocked' : 'done';
    // A worker that followed AGENTS.md may have closed the task itself (mora done/block): keep its
    // verdict and its memory note instead of writing a second one.
    const closedByWorker = status === 'done' && ['done', 'blocked'].includes(getTask(root, task.id).status);
    if (closedByWorker) {
      const own = getTask(root, task.id);
      status = own.status;
      summary = String(own.result || summary);
      updateTask(root, task.id, { files: integratedFiles || [], verifiedChecks: status === 'done' ? [...new Set([...(planTask.checks?.map((check) => check.path) || []), ...integratedVerifiedChecks])] : [] });
    } else {
      updateTask(root, task.id, { status, result: summary.slice(0, 4000), files: integratedFiles || [], verifiedChecks: status === 'done' ? [...new Set([...(planTask.checks?.map((check) => check.path) || []), ...integratedVerifiedChecks])] : [] });
    }
    const verifiedChecks = status === 'done' ? [...new Set([...(planTask.checks?.map((check) => check.path) || []), ...integratedVerifiedChecks])] : [];
    if (res?.sessionId) store.setAgent(task.id, { sessionId: res.sessionId });
    store.setAgent(task.id, { status, endedAt: new Date().toISOString(), elapsedMs: Date.now() - Date.parse(store.state.agents[task.id]?.startedAt || new Date().toISOString()), lastLine: summary.split('\n').filter(Boolean).pop()?.slice(0, 120) || status });
    const memory = closedByWorker ? null : await optional('../memory/index.js');
    try {
      memory?.add?.({ root, tier: 'episodic', kind: 'episode', title: `${task.id}: ${task.title}`, body: summary || status, tags: [task.role, planTask.provider], links: [task.id, task.spec].filter(Boolean), by: task.role });
    } catch { /* memory is best effort */ }
    await refreshBrain(root);
    await refreshCounts();
    store.addMessage({ from: 'agent', agent: task.role, provider: planTask.provider, taskId: task.id, text: `${status === 'done' ? '✓' : status === 'blocked' ? '!' : '✗'} ${task.id} ${task.title}${summary ? `\n${brief(summary)}` : ''}` });
    return { taskId: task.id, role: task.role, provider: planTask.provider, title: task.title, status, summary, doneWhen: planTask.doneWhen, files: integratedFiles, verifiedChecks };
    } catch (error) {
      let recoveryPath = null;
      if (!workspace.closed) {
        try { if (providerStarted) recoveryPath = await workspace.preserve(); else await workspace.discard(); }
        catch { /* retain the original error; worker failure is reported by the task */ }
      }
      if (recoveryPath) throw new Error(`${String(error?.message || error)}\n${t('Espacio de trabajo conservado', 'Workspace preserved')}: ${recoveryPath}`, { cause: error });
      throw error;
    } finally {
      controllers.delete(ac);
    }
  }

  async function runPlan(plan, requiredChecks = []) {
    const planState = { cancelled: false, controller: new AbortController(), requiredChecks };
    assignProviders(plan, { crew: config.crew, providers: store.state.providers, orchestrator: store.state.orchestrator.provider });
    const spec = store.state.spec?.slug || null;
    const byPlanId = Object.create(null);
    for (const pt of plan.tasks) {
      const exactChecks = pt.checks?.length ? `\n\n${t('Comprobaciones exactas antes de publicar', 'Exact checks before publication')}:\n${pt.checks.map((check) =>
        `${check.path}: ${t('líneas', 'lines')} ${JSON.stringify(check.lines)}; ${t('salto de línea final', 'final LF newline')}: ${check.finalNewline ? 'sí/yes' : 'no'}.`).join('\n')}\n${t(
        'Si usas la herramienta API write_file, envía lines y final_newline como campos separados; no escribas los caracteres literales \\n al final del contenido.',
        'If using the API write_file tool, send lines and final_newline as separate fields; do not write literal \\n characters at the end of content.',
      )}\n${t('Si otra descripción de la tarea contradice estas comprobaciones exactas, sigue las líneas y el LF indicados aquí.', 'If another task description conflicts with these exact checks, follow the lines and final-LF value shown here.')}` : '';
      const body = `${pt.prompt}${pt.doneWhen ? `\n\n${t('Listo cuando', 'Done when')}: ${pt.doneWhen}` : ''}${exactChecks}`;
      const task = createTask({ root, title: pt.title, role: pt.role, body, spec, by: 'lead' });
      byPlanId[pt.id] = { task, pt };
      store.setAgent(task.id, { id: task.id, role: pt.role, provider: pt.provider, status: 'queued', taskId: task.id, title: pt.title, lastLine: pt.dependsOn.length ? t(`espera ${pt.dependsOn.join(', ')}`, `waits for ${pt.dependsOn.join(', ')}`) : t('en cola', 'queued') });
    }
    // Persist the DAG with durable bus IDs after all tasks have been reserved.
    for (const { task, pt } of Object.values(byPlanId)) {
      if (pt.dependsOn.length) updateTask(root, task.id, { dependencies: pt.dependsOn.map((id) => byPlanId[id].task.id) });
    }
    activePlans.add(planState);
    store.set({ orchestrator: { ...store.state.orchestrator, status: 'running' } });
    const ticker = setInterval(() => {
      for (const a of Object.values(store.state.agents)) {
        if (a.status === 'running' && a.startedAt) store.setAgent(a.id, { elapsedMs: Date.now() - Date.parse(a.startedAt) });
      }
    }, 1000);
    ticker.unref?.();
    const results = Object.create(null);
    const running = new Map();
    const pending = new Set(Object.keys(byPlanId));
    try {
      while (pending.size || running.size) {
        for (const pid of [...pending]) {
          const { task, pt } = byPlanId[pid];
          if (planState.cancelled) {
            pending.delete(pid);
            const summary = t('cancelada antes de iniciar', 'cancelled before starting');
            updateTask(root, task.id, { status: 'failed', result: summary });
            store.setAgent(task.id, { status: 'failed', lastLine: summary });
            results[pid] = { taskId: task.id, role: task.role, provider: pt.provider, title: task.title, status: 'failed', summary, doneWhen: pt.doneWhen, files: null };
            continue;
          }
          if (running.size >= CONCURRENCY) break;
          const depsDone = pt.dependsOn.every((d) => results[d]);
          const depsFailed = pt.dependsOn.some((d) => results[d] && results[d].status !== 'done');
          if (depsFailed) {
            pending.delete(pid);
            updateTask(root, task.id, { status: 'blocked', result: 'dependency failed' });
            store.setAgent(task.id, { status: 'blocked', lastLine: t('bloqueada: falló una dependencia', 'blocked: a dependency failed') });
            results[pid] = { taskId: task.id, role: task.role, provider: pt.provider, title: task.title, status: 'blocked', summary: 'dependency failed', doneWhen: pt.doneWhen, files: null };
            continue;
          }
          if (!depsDone) continue;
          pending.delete(pid);
          running.set(pid, runTask(task, pt, planState).catch((error) => {
            const summary = String(error?.message || error);
            try { updateTask(root, task.id, { status: 'failed', result: summary }); } catch { /* keep original error */ }
            store.setAgent(task.id, { status: 'failed', lastLine: summary, endedAt: new Date().toISOString() });
            return { taskId: task.id, role: task.role, provider: pt.provider, title: task.title, status: 'failed', summary, doneWhen: pt.doneWhen, files: null };
          }).then((result) => { results[pid] = result; running.delete(pid); }));
        }
        if (running.size) await Promise.race(running.values());
        else if (pending.size) break; // validated graphs cannot reach this without an external error
      }
      return planState.cancelled ? [] : Object.values(results);
    } finally {
      clearInterval(ticker);
      activePlans.delete(planState);
      store.set({ orchestrator: { ...store.state.orchestrator, status: 'idle' } });
    }
  }

  async function handleAnswer(text, { repairCount = 0, previousError = null, requireExactCheck = false, exactCheckPath = null, requiredChecks = [] } = {}) {
    const roles = Object.keys(config?.crew || {}).filter((role) => role !== 'lead');
    const readyProviders = store.state.providers.filter((entry) => entry.ready).map((entry) => entry.id);
    const parsed = text && extractPlan(text, { roles, providers: readyProviders });
    let plan = parsed;
    if (parsed && !parsed.error) {
      const allChecks = parsed.tasks.flatMap((task) => task.checks);
      if (requiredChecks.length) {
        for (const required of requiredChecks) {
          const matching = allChecks.filter((check) => check.path === required.path);
          if (!matching.length) { plan = { error: 'missing-exact-check', detail: required.path }; break; }
          if (matching.some((check) => check.finalNewline !== required.finalNewline
              || check.lines.length !== required.lines.length
              || check.lines.some((line, index) => line !== required.lines[index]))) {
            plan = { error: 'mismatched-exact-check', detail: required.path };
            break;
          }
        }
      } else if (requireExactCheck && !allChecks.some((check) => !exactCheckPath || check.path === exactCheckPath)) {
        plan = { error: 'missing-exact-check', detail: exactCheckPath };
      }
    }
    if (!plan) {
      if (repairCount === 0 && promisedPlan(text)) {
        const again = await orchestratorTurn(t(
          'Dijiste que crearías un plan, pero faltó el bloque moragent-plan. Emite ahora el bloque completo de JSON válido, o explica claramente por qué no puedes proceder. No anuncies otro plan futuro.',
          'You said you would create a plan, but omitted the moragent-plan block. Emit the complete valid JSON block now, or clearly explain why you cannot proceed. Do not announce another future plan.',
        ), { planRepair: true });
        return handleAnswer(again, { repairCount: 1, previousError: 'missing-plan', requireExactCheck, exactCheckPath, requiredChecks });
      }
      if (repairCount > 0) store.addMessage({ from: 'system', text: t(
        'El orquestador no entregó un plan ejecutable; no se cambió ningún archivo.',
        'The orchestrator did not provide an executable plan; nothing was changed.',
      ) });
      return;
    }
    if (plan.error) {
      const reasons = {
        'invalid-json': t('JSON inválido', 'invalid JSON'),
        'no-tasks': t('sin tareas', 'no tasks'),
        'too-many-tasks': t('más de ocho tareas', 'more than eight tasks'),
        'invalid-task': t('una tarea no es un objeto', 'a task is not an object'),
        'invalid-field': t('campo con tipo inválido; usa texto', 'invalid field type; use text'),
        'invalid-id': t('ID de tarea inválido', 'invalid task ID'),
        'duplicate-id': t('ID de tarea duplicado', 'duplicate task ID'),
        'unknown-role': t(`rol desconocido; usa ${roles.join(', ') || 'ninguno'}`, `unknown role; use ${roles.join(', ') || 'none'}`),
        'invalid-provider': t(`proveedor no disponible; usa ${readyProviders.join(', ') || 'ninguno'}`, `unavailable provider; use ${readyProviders.join(', ') || 'none'}`),
        'empty-prompt': t('tarea sin instrucciones', 'task without instructions'),
        'invalid-dependency': t('dependencia inexistente o propia', 'missing or self dependency'),
        'dependency-cycle': t('dependencias cíclicas', 'cyclic dependencies'),
        'invalid-check': t('comprobación exacta inválida', 'invalid exact acceptance check'),
        'missing-exact-check': t('falta una comprobación exacta file_text solicitada', 'a requested exact file_text check is missing'),
        'mismatched-exact-check': t('la comprobación exacta contradice el contenido pedido', 'the exact check conflicts with the requested content'),
      };
      const reason = `${reasons[plan.error] || plan.error}${plan.detail ? `: ${plan.detail}` : ''}`;
      // One normal repair, plus one extra only when that repair introduces malformed JSON.
      // Never dispatch a partial plan or keep retrying the same failure indefinitely.
      const canRepair = repairCount === 0 || (repairCount === 1 && plan.error === 'invalid-json' && previousError !== 'invalid-json');
      if (canRepair) {
        const checksJson = JSON.stringify(requiredChecks);
        const checkHint = requiredChecks.length
          ? checksJson.length <= 2000
            ? t(` Las comprobaciones exigidas por el pedido son ${checksJson}.`, ` The user-requested checks are ${checksJson}.`)
            : t(' Copia exactamente todas las comprobaciones del bloque moragent-checks del usuario.', ' Copy every check from the user’s moragent-checks block exactly.')
          : requireExactCheck ? t(
            ` Incluye checks file_text con las líneas y el LF final exigidos${exactCheckPath ? ` para ${exactCheckPath}` : ''}.`,
            ` Include file_text checks with the required lines and final-LF value${exactCheckPath ? ` for ${exactCheckPath}` : ''}.`,
          ) : '';
        const retryPrompt = repairCount === 1
          ? t(
            `La corrección anterior tenía JSON incompleto. Reconstruye el plan desde el pedido original; no continúes el texto truncado. Emite un solo bloque \`\`\`moragent-plan con JSON completo, cerrando todos los corchetes, llaves y el bloque. No incluyas marcas XML ni llamadas a herramientas.${checkHint}`,
            `The previous repair had incomplete JSON. Rebuild the plan from the original request; do not continue the truncated text. Emit one \`\`\`moragent-plan block with complete JSON, closing every bracket, brace and fence. Do not include XML or tool-call markup.${checkHint}`,
          )
          : t(
            `Tu plan moragent-plan es inválido (${reason}). Reemite el bloque completo con IDs únicos, dependencias válidas, roles del equipo, proveedores listos y hasta ocho tareas.${checkHint} No repitas la explicación.`,
            `Your moragent-plan is invalid (${reason}). Re-emit the complete block with unique IDs, valid dependencies, crew roles, ready providers and at most eight tasks.${checkHint} Do not repeat the explanation.`,
          );
        const again = await orchestratorTurn(retryPrompt, { planRepair: true });
        return handleAnswer(again, { repairCount: repairCount + 1, previousError: plan.error, requireExactCheck, exactCheckPath, requiredChecks });
      }
      store.addMessage({ from: 'system', text: t(`El orquestador no logró armar un plan válido (${reason}). Reformula el pedido o divídelo en partes.`, `The orchestrator could not produce a valid plan (${reason}). Rephrase the request or split it.`) });
      return;
    }
    const size = plan.size ? ` ${plan.size}` : '';
    const count = plan.tasks.length;
    const summary = plan.summary.trim() || `${plan.tasks.slice(0, 3).map((task) => task.title).join(', ')}${count > 3 ? '…' : ''}`;
    const agents = t(`${count} ${count === 1 ? 'subagente' : 'subagentes'}`, `${count} ${count === 1 ? 'subagent' : 'subagents'}`);
    store.addMessage({ from: 'system', text: `Plan${size} · ${agents}: ${summary}` });
    const results = await runPlan(plan, requiredChecks);
    if (!results.length) return;
    const review = await orchestratorTurn(reviewPrompt({ results, es: store.state.lang !== 'en' }), { status: 'reviewing' });
    if (review && extractPlan(review) && reviewRounds < MAX_REVIEW_ROUNDS) {
      reviewRounds++;
      await handleAnswer(review, { requireExactCheck, exactCheckPath, requiredChecks });
      return;
    }
    if (requiredChecks.length) {
      const failures = verifyTaskChecks(root, requiredChecks);
      if (failures.length) store.addMessage({ from: 'system', text: `${t('INCOMPLETO: el proyecto no pasó las comprobaciones finales', 'INCOMPLETE: the project did not pass final checks')}: ${failures.join('; ')}` });
      else {
        const shown = requiredChecks.slice(0, 6).map((check) => `${JSON.stringify(check.path)} (${check.finalNewline ? t('LF final', 'final LF') : t('sin LF final', 'no final LF')})`);
        if (requiredChecks.length > shown.length) shown.push(`+${requiredChecks.length - shown.length}`);
        store.addMessage({ from: 'system', text: `${t('VERIFICADO: el contrato exacto del usuario coincide con los archivos del proyecto', 'VERIFIED: the user’s exact file contract matches the project files')}: ${shown.join(', ')}` });
      }
    }
  }

  // ---------- public API ----------
  engine.send = (text) => {
    const msg = String(text || '').trim();
    if (!msg) return Promise.resolve();
    pendingTurns++;
    const epoch = turnEpoch;
    const turn = sendTail.then(async () => {
      if (epoch !== turnEpoch) return;
      store.addMessage({ from: 'user', text: msg });
      if (!root) {
        const greetingLang = greetingLanguage(msg);
        if (greetingLang) {
          if (!languagePinned && store.state.lang !== greetingLang) {
            setLang(greetingLang);
            store.set({ lang: greetingLang });
          }
          store.addMessage({ from: 'system', text: t(
            '¡Hola! Puedo ayudarte a explorar ideas o a construir algo aquí. No inicialicé el proyecto ni creé o modifiqué archivos. Cuéntame qué necesitas cuando quieras empezar.',
            'Hello! I can help you explore ideas or build something here. I did not initialize the project or create or change any files. Tell me what you need when you are ready to start.',
          ) });
          return;
        }
      }
      const explicit = parseExplicitFileChecks(msg);
      if (explicit?.error) {
        const reasons = {
          'multiple-blocks': t('hay más de un bloque', 'more than one block'),
          'missing-fence': t('falta cerrar el bloque', 'the block is not closed'),
          'too-large': t('el bloque supera 256 KiB', 'the block exceeds 256 KiB'),
          'invalid-json': t('JSON inválido', 'invalid JSON'),
          'invalid-files': t('files debe contener entre 1 y 32 archivos', 'files must contain 1 to 32 files'),
          'invalid-check': t('ruta, líneas o finalNewline inválidos', 'invalid path, lines or finalNewline'),
          'duplicate-path': t('hay rutas duplicadas', 'duplicate paths'),
        };
        const reason = reasons[explicit.error] || explicit.error;
        store.addMessage({ from: 'system', text: t(
          `Bloque moragent-checks inválido (${reason}). No se inició ningún agente ni se cambió ningún archivo.`,
          `Invalid moragent-checks block (${reason}). No agent started and no files changed.`,
        ) });
        return;
      }
      if (!store.state.providers.length) await engine.refreshProviders();
      await ensureProject(msg);
      if (epoch !== turnEpoch) return;
      reviewRounds = 0;
      let memory = '';
      const mem = await optional('../memory/index.js');
      try { memory = mem?.contextPack ? mem.contextPack({ root, role: 'lead', query: msg, budget: 4000, lang: store.state.lang, sessionId: store.state.sessionId }) : ''; } catch { memory = ''; }
      if (epoch !== turnEpoch) return;
      const answer = await orchestratorTurn(turnPrompt({ text: msg, memory, es: store.state.lang !== 'en' }));
      const inferred = explicit ? null : literalSingleLineExpectation(msg);
      const requiredChecks = explicit?.checks || (inferred ? [inferred] : []);
      if (epoch === turnEpoch) await handleAnswer(answer, {
        requireExactCheck: requiredChecks.length > 0 || requiresExactFileCheck(msg),
        exactCheckPath: requiredChecks.length === 1 ? requiredChecks[0].path : exactCheckTarget(msg),
        requiredChecks,
      });
    });
    const settled = turn.finally(async () => { pendingTurns--; await applyDeferredProviderRefresh(); });
    sendTail = settled.catch(() => {});
    return settled;
  };

  const rejectBusyConfiguration = () => {
    if (!pendingTurns && !pendingDeployments && !activePlans.size) return false;
    store.addMessage({ from: 'system', text: t('Espera a que termine el trabajo activo o usa /cancel antes de cambiar motores y modelos.', 'Wait for active work to finish, or use /cancel before changing engines and models.') });
    return true;
  };

  engine.command = async (name, args = []) => {
    const list = Array.isArray(args) ? args : [];
    switch (name) {
      case 'help': case 'ayuda':
        store.addMessage({ from: 'system', text: helpText() });
        return;
      case 'update': case 'actualizar': {
        if (rejectBusyConfiguration()) return;
        if (list.some((arg) => arg !== '--check')) {
          store.addMessage({ from: 'system', text: t('Uso: /update [--check]', 'Usage: /update [--check]') });
          return;
        }
        const { selfUpdate, updateMessage } = await import('../core/self-update.js');
        try {
          const result = await selfUpdate({ check: list.includes('--check') });
          store.addMessage({ from: 'system', text: updateMessage(result, store.state.lang) });
        } catch (error) {
          store.addMessage({ from: 'system', text: t(`No se pudo comprobar la actualización: ${error.message}`, `Could not check for updates: ${error.message}`) });
        }
        return;
      }
      case 'idioma': case 'language': case 'lang': {
        const requested = String(list[0] || '').toLowerCase();
        if (!['es', 'en'].includes(requested)) {
          store.addMessage({ from: 'system', text: t(`Idioma actual: ${store.state.lang}. Uso: /idioma <es|en>`, `Current language: ${store.state.lang}. Usage: /language <es|en>`) });
          return;
        }
        const previous = store.state.lang;
        languagePinned = true;
        setLang(requested);
        store.set({ lang: requested });
        if (root && config) {
          config.lang = requested;
          for (const [role, member] of Object.entries(config.crew || {})) {
            const defaults = ROLES[role]?.mission;
            if (defaults && member.mission === defaults[previous]) member.mission = defaults[requested];
          }
          saveConfig(root, config);
        }
        store.addMessage({ from: 'system', text: t('Idioma: español. Se aplicará a las próximas respuestas.', 'Language: English. It applies to future answers.') });
        return;
      }
      case 'recuperaciones': case 'recoveries': {
        if (!root) {
          store.addMessage({ from: 'system', text: t('Todavía no hay proyecto ni copias por recuperar.', 'No project or recoverable copies yet.') });
          return;
        }
        const action = String(list[0] || '').toLowerCase();
        const inspecting = ['inspeccionar', 'inspect'].includes(action);
        const applying = ['aplicar', 'apply'].includes(action);
        const identifier = inspecting || applying ? list[1] : list[0];
        const explain = (result) => {
          const messages = {
            'not-found': t('No existe esa recuperación.', 'Recovery not found.'),
            ambiguous: t('Hay varias copias de esa tarea; usa el ID completo.', 'There are several copies of that task; use the full recovery ID.'),
            'manifest-missing': t('Esta copia no tiene manifiesto aplicable; inspecciónala manualmente.', 'This copy has no applicable manifest; inspect it manually.'),
            'manifest-mismatch': t('El manifiesto no corresponde a este proyecto.', 'The manifest does not match this project.'),
            'manifest-invalid': t('El manifiesto contiene rutas o huellas inválidas.', 'The manifest contains invalid paths or fingerprints.'),
            'inspect-failed': t('No se pudieron inspeccionar las rutas de la copia.', 'Could not inspect the saved paths.'),
            'no-files': t('La copia no contiene rutas aplicables automáticamente. Revisa en ella el estado Git o las dependencias excluidas.', 'The copy has no automatically applicable paths. Inspect it for Git state or excluded dependencies.'),
            'manual-only': t('La copia falló una comprobación exacta o violó el alcance de la tarea y sólo admite inspección manual; no se aplicó nada.', 'The copy failed an exact acceptance check or task-scope guard and requires manual inspection; nothing was applied.'),
            conflict: t('El origen o la copia cambiaron; no se aplicó nada.', 'The source or saved copy changed; nothing was applied.'),
            lock: t('No se pudo obtener el bloqueo de publicación.', 'Could not acquire the publication lock.'),
            cancelled: t('Aplicación cancelada; la copia permanece guardada.', 'Application cancelled; the saved copy remains available.'),
          };
          const detail = result.ids?.length ? `\n${result.ids.join('\n')}` : result.conflicts?.length ? `\n${result.conflicts.join('\n')}` : result.code === 'lock' && result.error ? `\n${result.error}` : '';
          return `${messages[result.code] || t('No se pudo aplicar la recuperación.', 'Could not apply the recovery.')}${detail}`;
        };
        try {
          if (inspecting || applying) {
            if (!identifier) {
              store.addMessage({ from: 'system', text: t('Uso: /recuperaciones <inspeccionar|aplicar> <id>', 'Usage: /recoveries <inspect|apply> <id>') });
              return;
            }
            if (applying && recoveryApplying) {
              store.addMessage({ from: 'system', text: t('Ya se está aplicando una recuperación.', 'A recovery is already being applied.') });
              return;
            }
            if (applying && (pendingTurns || pendingDeployments || controllers.size || activePlans.size || Object.values(store.state.agents).some((agent) => agent.status === 'running'))) {
              store.addMessage({ from: 'system', text: t('Espera a que terminen los agentes antes de aplicar una recuperación.', 'Wait for running agents before applying a recovery.') });
              return;
            }
            let result;
            if (applying) {
              const recoveryController = new AbortController();
              recoveryApplying = true;
              store.set({ recoveryApplying: true });
              controllers.add(recoveryController);
              store.addMessage({ from: 'system', text: t('Aplicando recuperación… /cancel para detener.', 'Applying recovery… /cancel to stop.') });
              try { result = await applyRecoveryAsync(root, identifier, { signal: recoveryController.signal }); }
              finally { controllers.delete(recoveryController); recoveryApplying = false; store.set({ recoveryApplying: false }); }
            } else result = inspectRecovery(root, identifier);
            if (!result.ok) {
              store.addMessage({ from: 'system', text: explain(result) });
              return;
            }
            if (applying) {
              const count = result.files.length;
              const excluded = result.excludedCount > 0 ? t(
                `\nAviso: ${result.excludedCount === 1 ? '1 cambio' : `${result.excludedCount} cambios`} en node_modules ${result.excludedCount === 1 ? 'permanece' : 'permanecen'} sólo en la copia guardada.`,
                `\nWarning: ${result.excludedCount === 1 ? '1 node_modules change remains' : `${result.excludedCount} node_modules changes remain`} only in the saved copy.`,
              ) : '';
              const message = count === 1 ? t(
                `Se aplicó 1 ruta. La copia y su estado Git permanecen en ${result.workspace}`,
                `Applied 1 path. The saved copy and its Git state remain at ${result.workspace}`,
              ) : t(
                `Se aplicaron ${count} rutas. La copia y su estado Git permanecen en ${result.workspace}`,
                `Applied ${count} paths. The saved copy and its Git state remain at ${result.workspace}`,
              );
              store.addMessage({ from: 'system', text: `${message}${excluded}` });
              return;
            }
            const files = result.files.slice(0, 30).join('\n') || t('(sin cambios de rutas)', '(no path changes)');
            const more = result.files.length > 30 ? t(`\n… y ${result.files.length - 30} más`, `\n… and ${result.files.length - 30} more`) : '';
            const state = result.manualOnlyReason ? result.manualOnlyReason === 'task-scope-violation'
              ? t('sólo inspección manual: la tarea editó una ruta ajena', 'manual inspection only: the task edited another task’s path')
              : t('sólo inspección manual: falló una comprobación exacta', 'manual inspection only: an exact acceptance check failed')
              : result.canApply ? t('lista para aplicar rutas', 'ready to apply paths')
              : result.conflicts.length ? t(`conflictos: ${result.conflicts.join(', ')}`, `conflicts: ${result.conflicts.join(', ')}`)
                : result.excludedCount > 0 ? t('sólo cambios de dependencias excluidas', 'excluded dependency changes only')
                  : t('sin rutas aplicables automáticamente', 'no automatically applicable paths');
            const hint = result.manualOnlyReason
              ? t('Revisa la copia guardada y corrige el trabajo manualmente; no se puede aplicar con este comando.', 'Inspect the saved copy and correct the work manually; this command cannot apply it.')
              : result.canApply
              ? `${t('Para aplicar rutas: /recuperaciones aplicar', 'To apply paths: /recoveries apply')} ${result.id}`
              : result.conflicts.length
                ? t('Resuelve los conflictos del origen antes de aplicar. La copia permanece intacta.', 'Resolve source conflicts before applying. The saved copy remains intact.')
                : t('No hay rutas que aplicar; inspecciona el estado Git o las dependencias en la copia.', 'No paths to apply; inspect Git state or dependencies in the saved copy.');
            const dependencyWarning = result.excludedCount > 0 ? t(
              `\nAviso: ${result.excludedCount === 1 ? '1 cambio' : `${result.excludedCount} cambios`} en node_modules no ${result.excludedCount === 1 ? 'se aplicará' : 'se aplicarán'}: ${result.excludedPaths.slice(0, 5).join(', ')}. ${result.excludedCount === 1 ? 'Permanece' : 'Permanecen'} en la copia.`,
              `\nWarning: ${result.excludedCount === 1 ? '1 node_modules change will' : `${result.excludedCount} node_modules changes will`} not be applied: ${result.excludedPaths.slice(0, 5).join(', ')}. ${result.excludedCount === 1 ? 'It remains' : 'They remain'} in the copy.`,
            ) : '';
            const gitWarning = result.gitPortable ? '' : t(
              '\nAviso: el Git de esta copia depende de objetos del proyecto original; consérvalo en su ubicación actual.',
              '\nWarning: this copy’s Git history depends on objects in the original project; keep it at its current location.',
            );
            store.addMessage({ from: 'system', text: `${result.id} · ${state}\n${files}${more}\n${result.path}\n${hint}${dependencyWarning}${gitWarning}` });
            return;
          }
          const saved = listRecoveries(root);
          const matches = identifier ? saved.filter((item) => item.taskId.toLowerCase() === identifier.toLowerCase() || item.id.toLowerCase() === identifier.toLowerCase()) : saved;
          if (!matches.length) {
            store.addMessage({ from: 'system', text: identifier ? t(`No hay copia guardada para ${identifier}.`, `No saved copy for ${identifier}.`) : t('No hay copias guardadas por conflictos.', 'No copies saved from conflicts.') });
            return;
          }
          const rows = matches.slice(0, 20).map((item) => `${item.id} · ${item.savedAt}\n${item.path}`).join('\n');
          const more = matches.length > 20 ? t(`\n… y ${matches.length - 20} más`, `\n… and ${matches.length - 20} more`) : '';
          store.addMessage({ from: 'system', text: `${t('Copias guardadas (no se aplican automáticamente)', 'Saved copies (not applied automatically)')}:\n${rows}${more}` });
        } catch (error) {
          store.addMessage({ from: 'system', text: t(`No se pudo inspeccionar la recuperación: ${error.message}`, `Could not inspect recovery: ${error.message}`) });
        }
        return;
      }
      case 'login': {
        if (args && !Array.isArray(args) && args.id === 'compatible' && args.url) {
          try {
            const cred = await optional('../providers/credentials.js');
            cred?.setEndpoint?.('compatible', args.url);
            const catalogs = await optional('../providers/api/models.js');
            catalogs?.resetApiModelCache?.();
            const override = cred?.getEndpointEnvironment?.('compatible');
            store.addMessage({ from: 'system', text: override
              ? t(`URL guardada, pero ${override} tiene prioridad. Quita esa variable y reinicia MORAGENT para usar la URL guardada.`, `URL saved, but ${override} takes precedence. Unset it and restart MORAGENT to use the saved URL.`)
              : t('URL del proveedor compatible guardada.', 'Compatible provider URL saved.') });
          } catch (error) {
            store.addMessage({ from: 'system', text: t(`No se pudo guardar la URL: ${error.message}`, `Could not save the URL: ${error.message}`) });
            return;
          }
        } else if (args && !Array.isArray(args) && args.id && args.key) {
          if (!store.state.providers.some((p) => p.id === args.id && p.kind !== 'subscription' && p.id !== 'ollama')) {
            store.addMessage({ from: 'system', text: t('Elige un proveedor de API válido.', 'Choose a valid API provider.') });
            return;
          }
          try {
            const cred = await optional('../providers/credentials.js');
            cred?.setKey?.(args.id, args.key);
            const catalogs = await optional('../providers/api/models.js');
            catalogs?.resetApiModelCache?.();
            const override = cred?.getKeyEnvironment?.(args.id);
            store.addMessage({ from: 'system', text: override
              ? t(`Clave guardada para ${args.id}, pero ${override} tiene prioridad. Quita esa variable y reinicia MORAGENT para usar la clave guardada.`, `Key saved for ${args.id}, but ${override} takes precedence. Unset it and restart MORAGENT to use the saved key.`)
              : t(`Clave guardada para ${args.id}.`, `Key saved for ${args.id}.`) });
          } catch (error) {
            store.addMessage({ from: 'system', text: t(`No se pudo guardar la clave: ${error.message}`, `Could not save the key: ${error.message}`) });
            return;
          }
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
        if (rejectBusyConfiguration()) return;
        const preferenceChanged = preferredProvider !== id;
        const changed = store.state.orchestrator.provider !== id || preferenceChanged;
        preferredProvider = id;
        if (preferenceChanged) preferredModel = null;
        if (changed) session = { id: null, provider: null };
        store.set({ orchestrator: { ...store.state.orchestrator, provider: id, ...(changed ? { model: preferredModel, activeModel: null } : {}) } });
        if (root) { config.orchestrator = id; if (preferenceChanged) delete config.orchestratorModel; saveConfig(root, config); }
        store.addMessage({ from: 'system', text: t(`Orquestador: ${id}`, `Orchestrator: ${id}`) });
        return;
      }
      case 'tarea': case 'desplegar': case 'task': case 'deploy': {
        // Explicit deployment: one subagent for one task, no planning round.
        const epoch = turnEpoch;
        const roles = Object.keys(config?.crew || {}).filter((r) => r !== 'lead');
        const [role, ...words] = list;
        const body = words.join(' ').trim();
        if (!role || !body || (root && !roles.includes(role))) {
          const example = roles[0] || '<rol>';
          store.addMessage({ from: 'system', text: t(`Uso: /tarea <rol> <qué hacer>\nRoles: ${roles.join(', ') || 'ninguno configurado'}\nEjemplo: /tarea ${example} investiga la solicitud y entrega fuentes`, `Usage: /task <role> <what to do>\nRoles: ${roles.join(', ') || 'none configured'}\nExample: /task ${example} research the request and report sources`) });
          return;
        }
        pendingDeployments++;
        try {
          if (!store.state.providers.length) await engine.refreshProviders();
          if (epoch !== turnEpoch || stopped) return;
          store.addMessage({ from: 'user', text: `/tarea ${role} ${body}` });
          await ensureProject(body);
          if (epoch !== turnEpoch || stopped) return;
          const plan = { size: 'S', summary: body.slice(0, 80), tasks: [{ id: 't1', role, provider: null, title: body.slice(0, 100), prompt: body, doneWhen: '', dependsOn: [] }] };
          const selected = config.crew[role]?.provider || config.crew[role]?.cli || '?';
          store.addMessage({ from: 'system', text: t(`Desplegando ${role} (${selected})…`, `Deploying ${role} (${selected})…`) });
          await runPlan(plan);
        } finally { pendingDeployments--; await applyDeferredProviderRefresh(); }
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
            ...roles.filter((r) => r !== 'lead').map((r) => `${r.padEnd(9)} ${config.crew[r].provider || config.crew[r].cli} · ${config.crew[r].model || t('por defecto', 'default')}`)];
          store.addMessage({ from: 'system', text: `${t('Modelos', 'Models')} (/modelo <nombre> · /modelo <rol> <nombre> · default):\n${rows.join('\n')}\n${hints}` });
          return;
        }
        if (rejectBusyConfiguration()) return;
        if (b !== undefined && (roles.includes(a) || a === 'orquestador' || a === 'orchestrator')) {
          if (a === 'orquestador' || a === 'orchestrator' || a === 'lead') return engine.command('modelo', [b]);
          if (!root) { store.addMessage({ from: 'system', text: t('Todavía no hay proyecto.', 'No project yet.') }); return; }
          config.crew[a] = { ...config.crew[a], model: clear(b) };
          if (!config.crew[a].model) delete config.crew[a].model;
          saveConfig(root, config);
          store.addMessage({ from: 'system', text: t(`${a} usará ${clear(b) || 'el modelo por defecto'} (${config.crew[a].provider || config.crew[a].cli}).`, `${a} will use ${clear(b) || 'the default model'} (${config.crew[a].provider || config.crew[a].cli}).`) });
          return;
        }
        const model = clear(a);
        if (store.state.orchestrator.provider !== preferredProvider) {
          preferredProvider = store.state.orchestrator.provider;
          if (root) config.orchestrator = preferredProvider;
        }
        preferredModel = model;
        if (store.state.orchestrator.model !== model) session = { id: null, provider: null };
        store.set({ orchestrator: { ...store.state.orchestrator, model, activeModel: null } });
        if (root) { if (model) config.orchestratorModel = model; else delete config.orchestratorModel; saveConfig(root, config); }
        store.addMessage({ from: 'system', text: t(`Orquestador: ${store.state.orchestrator.provider} · ${model || 'modelo por defecto'}. Si el modelo no existe, el motor lo dirá en la próxima respuesta.`, `Orchestrator: ${store.state.orchestrator.provider} · ${model || 'default model'}. If the model does not exist, the engine will say so on the next answer.`) });
        return;
      }
      case 'equipo': case 'crew': {
        if (!root) { store.addMessage({ from: 'system', text: t('Todavía no hay proyecto: describe qué quieres lograr.', 'No project yet: describe what you want to accomplish.') }); return; }
        const [role, cli] = list;
        if (role && cli) {
          if (rejectBusyConfiguration()) return;
          const known = store.state.providers.find((p) => p.id === cli);
          if (!config.crew[role] || !known) {
            store.addMessage({ from: 'system', text: t(`Rol o motor desconocido: ${role} ${cli}.`, `Unknown role or engine: ${role} ${cli}.`) });
            return;
          }
          const member = config.crew[role];
          const changed = (member.provider || member.cli) !== cli;
          const cliChanged = CLI_IDS.includes(cli) && member.cli !== cli;
          if (CLI_IDS.includes(cli)) {
            member.cli = cli;
            delete member.provider;
          } else member.provider = cli;
          if (changed) delete config.crew[role].model;
          saveConfig(root, config);
          if (cliChanged) await syncProject(root, config);
          store.addMessage({ from: 'system', text: t(`${role} ahora usa ${cli}.`, `${role} now uses ${cli}.`) });
          return;
        }
        const rows = Object.entries(config.crew).map(([r, m]) => {
          const selected = m.provider || m.cli;
          const p = store.state.providers.find((x) => x.id === selected);
          const backup = m.provider ? ` (${t('CLI panel', 'pane CLI')}: ${m.cli})` : '';
          return `${r.padEnd(9)} ${selected.padEnd(9)} ${p ? (p.ready ? '✓' : '○ ' + (p.loginHint || '')) : ''}${backup}`;
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
        preferredProvider = loaded.provider || store.state.orchestrator.provider;
        preferredModel = loaded.model || null;
        store.set({
          messages: loaded.messages || [], agents: loaded.agents || {}, sessionId: loaded.id,
          orchestrator: { ...store.state.orchestrator, provider: loaded.provider || store.state.orchestrator.provider, model: loaded.model || null, activeModel: null, status: 'idle' },
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
      case 'nuevo': case 'new': {
        // Start a separate project in the current folder instead of the one found above it.
        if (root && path.resolve(root) === path.resolve(cwd)) { store.addMessage({ from: 'system', text: t('Esta carpeta ya es el proyecto actual.', 'This folder already is the current project.') }); return; }
        root = null; config = null; session = { id: null, provider: null };
        store.set({ initialized: false, agents: {}, project: path.basename(cwd), goal: '', memory: memoryCounts(null), spec: null, brain: { linked: false, vault: null } });
        store.addMessage({ from: 'system', text: t(`Listo: el próximo mensaje crea un proyecto nuevo en ${cwd}.`, `Done: your next message creates a new project in ${cwd}.`) });
        return;
      }
      case 'cancel': case 'cancelar':
        turnEpoch++;
        for (const plan of activePlans) { plan.cancelled = true; plan.controller.abort(); }
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
  engine.loginCommand = (id) => {
    try {
      const p = provider(id);
      return p?.kind === 'subscription' && Array.isArray(p.loginCommand) ? [...p.loginCommand] : null;
    } catch { return null; }
  };
  engine.roleEngine = (role) => config?.crew?.[role]?.provider || config?.crew?.[role]?.cli || null;

  engine.stop = () => { stopped = true; providerRefreshDeferred = false; turnEpoch++; for (const plan of activePlans) { plan.cancelled = true; plan.controller.abort(); } for (const ac of controllers) ac.abort(); };

  function helpText() {
    return t(`Escribe lo que necesitas y el orquestador decide si responde o despliega agentes.
/tarea <rol> <texto>  desplegar un agente directo según su misión
/login            conectar suscripciones o API keys
/update [--check] comprobar o actualizar MORAGENT desde Git
/equipo           ver el equipo · /equipo <rol> <motor> para cambiarlo
/orquestador <m>  elegir el motor del orquestador
/modelo [rol] <n> ver o cambiar el modelo (del orquestador o de un rol)
/idioma <es|en>  cambiar el idioma de MORAGENT
/recuperaciones  ver copias; inspeccionar/aplicar <id>
/memoria [texto]  ver o buscar en la memoria
/nuevo            crear un proyecto nuevo en esta carpeta
/sesiones         ver conversaciones guardadas · /sesion <n> retomar · /limpiar empezar de cero
/agentes          estado de los subagentes (Tab: detalle de cada proceso)
/plan <texto>     pedir un plan explícito
/abrir <rol|id>   sacar un subagente a un panel externo
/cancel           cancelar lo que está corriendo
/salir            salir (Ctrl+C dos veces)`, `Type what you need; the orchestrator either answers or deploys agents.
/task <role> <text>   deploy one agent directly by its mission
/login            connect subscriptions or API keys
/update [--check] check or update MORAGENT from Git
/crew             show the crew · /crew <role> <engine> to change it
/orchestrator <e> pick the orchestrator engine
/model [role] <n> show or change the model (orchestrator or a role)
/language <es|en> change MORAGENT language
/recoveries       list copies; inspect/apply <id>
/memory [text]    show or search memory
/new              create a new project in this folder
/sessions         saved conversations · /session <n> resume · /clear start fresh
/agents           subagent status (Tab: each process in detail)
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
      : t(`${conn ? `${conn}\n` : ''}Esta carpeta todavía no es un proyecto MORAGENT. Cuéntame qué quieres lograr y lo preparo.`, `${conn ? `${conn}\n` : ''}This folder is not a MORAGENT project yet. Tell me what you want to accomplish and I will set it up.`) });
  };
  return engine;
}
