import path from 'node:path';
import { dirs, findRoot } from '../core/paths.js';
import { loadConfig, saveConfig, defaultConfig, PRESETS } from '../core/config.js';
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
    orchestrator: { provider: config?.orchestrator || config?.crew?.lead?.cli || null, status: 'idle' },
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
        autonomy: 'readonly', signal: ac.signal, logFile: path.join(dirs(root).runs, 'orchestrator.log'),
        onEvent: (e) => {
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
    updateTask(root, task.id, { status: 'running' });
    store.setAgent(task.id, { status: 'running', startedAt: new Date().toISOString(), lastLine: t('empezando…', 'starting…') });
    const ac = new AbortController();
    controllers.add(ac);
    let text = '';
    let res;
    try {
      res = await p.run({
        root, prompt: envelope, autonomy: member.autonomy || 'auto', model: member.model, signal: ac.signal,
        logFile: path.join(dirs(root).runs, `${task.role}-${task.id}.log`),
        onEvent: (e) => {
          if (e.type === 'start' && e.sessionId) store.setAgent(task.id, { sessionId: e.sessionId });
          if (e.type === 'text') text += e.delta;
          const cur = store.state.agents[task.id];
          const line = lastLineFrom(e, cur?.lastLine);
          if (line !== cur?.lastLine) store.setAgent(task.id, { lastLine: line });
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
    store.setAgent(task.id, { status, endedAt: new Date().toISOString(), lastLine: summary.split('\n').filter(Boolean).pop()?.slice(0, 120) || status });
    const memory = closedByWorker ? null : await optional('../memory/index.js');
    try {
      memory?.add?.({ root, tier: 'episodic', kind: 'episode', title: `${task.id}: ${task.title}`, body: summary || status, tags: [task.role, planTask.provider], links: [task.id, task.spec].filter(Boolean), by: task.role });
    } catch { /* memory is best effort */ }
    await refreshBrain(root);
    await refreshCounts();
    store.addMessage({ from: 'agent', agent: task.role, provider: planTask.provider, taskId: task.id, text: `${status === 'done' ? '✓' : status === 'blocked' ? '!' : '✗'} ${task.id} ${task.title}${summary ? `\n${summary.slice(0, 600)}` : ''}` });
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
    store.set({ orchestrator: { ...store.state.orchestrator, status: 'idle' } });
    return Object.values(results);
  }

  async function handleAnswer(text) {
    const plan = text && extractPlan(text);
    if (!plan) return;
    if (plan.error) {
      store.addMessage({ from: 'system', text: t('El orquestador propuso un plan con formato inválido; pídele que lo reformule.', 'The orchestrator proposed a malformed plan; ask it to rephrase.') });
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
    const { detectMux, getMux } = await import('../mux/index.js');
    const { shq } = await import('../core/exec.js');
    const resume = { claude: (s) => `claude --resume ${shq(s)}`, codex: (s) => `codex resume ${shq(s)}`, agy: (s) => `agy --conversation ${shq(s)}`, pi: (s) => `pi --session ${shq(s)}` };
    const log = path.join(dirs(root).runs, `${a.role}-${a.id}.log`);
    const command = a.sessionId && resume[a.provider] ? resume[a.provider](a.sessionId) : `tail -n 200 -f ${shq(log)}`;
    let muxName;
    try { muxName = detectMux(config.mux); } catch { muxName = 'headless'; }
    if (muxName === 'headless') { store.addMessage({ from: 'system', text: t(`No hay multiplexor (Orca/herdr/tmux). Ejecuta en otra terminal:\n${command}`, `No multiplexer (Orca/herdr/tmux). Run in another terminal:\n${command}`) }); return; }
    try {
      const { handle } = getMux(muxName).spawn({ root, role: a.role, title: `${a.role} ${a.id}`, command, cwd: root, layout: config.layout || 'split' });
      store.addMessage({ from: 'system', text: t(`${a.id} abierto en ${muxName} (${handle}).`, `${a.id} opened in ${muxName} (${handle}).`) });
    } catch (e) {
      store.addMessage({ from: 'system', text: t(`No se pudo abrir el panel: ${e.message}\n${command}`, `Could not open the pane: ${e.message}\n${command}`) });
    }
  }

  engine.stop = () => { for (const ac of controllers) ac.abort(); };

  function helpText() {
    return t(`Escribe lo que necesitas y el orquestador decide si responde o reparte trabajo.
/login            conectar suscripciones o API keys
/equipo           ver el equipo · /equipo <rol> <motor> para cambiarlo
/orquestador <m>  elegir el motor del orquestador
/memoria [texto]  ver o buscar en la memoria
/plan <texto>     pedir un plan explícito
/abrir <rol|id>   sacar un subagente a un panel externo
/cancel           cancelar lo que está corriendo
/salir            salir (Ctrl+C dos veces)`, `Type what you need; the orchestrator either answers or delegates.
/login            connect subscriptions or API keys
/crew             show the crew · /crew <role> <engine> to change it
/orchestrator <e> pick the orchestrator engine
/memory [text]    show or search memory
/plan <text>      ask for an explicit plan
/open <role|id>   take a subagent out into a terminal pane
/cancel           cancel running work
/exit             quit (Ctrl+C twice)`);
  }

  if (root) ensureDir(dirs(root).runs);
  engine.welcome = () => {
    const ready = store.state.providers.filter((p) => p.ready).map((p) => p.label);
    const conn = ready.length ? t(`Conectado: ${ready.join(', ')}.`, `Connected: ${ready.join(', ')}.`) : t('Ningún motor conectado: usa /login.', 'No engine connected: use /login.');
    store.addMessage({ from: 'orchestrator', text: root
      ? t(`${conn}\nProyecto ${config.project}. ¿Qué hacemos? (/help para ver comandos)`, `${conn}\nProject ${config.project}. What are we doing? (/help for commands)`)
      : t(`${conn}\nEsta carpeta todavía no es un proyecto MORAGENT. Cuéntame qué quieres construir y lo preparo.`, `${conn}\nThis folder is not a MORAGENT project yet. Tell me what you want to build and I will set it up.`) });
  };
  return engine;
}
