import { EventEmitter } from 'node:events';

export class FakeEngine {
  constructor() {
    this.store = new EventEmitter();
    this.store.state = sampleState();
    this.timers = [];
    this.tick = null;
  }
  emit() { this.store.emit('change'); }
  startDemo() {
    const s = this.store.state;
    for (let i = 0; i < 60; i++) s.messages.push({ id: `hist-${i}`, from: i % 7 ? 'orchestrator' : 'system', text: `Mensaje histórico **${i + 1}** con markdown, lista y contexto para probar scroll.`, at: Date.now() - (60 - i) * 1000 });
    this.timers.push(setTimeout(() => {
      s.orchestrator.status = 'thinking';
      s.messages.push({ id: 'm2', from: 'user', text: 'API de tareas con tests', at: Date.now() });
      s.messages.push({ id: 'm3', from: 'orchestrator', text: '## Plan\n- backend implementa la API\n- frontend consume el contrato\n\n**M · 2 subagentes** en ejecución.', at: Date.now(), streaming: true });
      this.emit();
    }, 600));
    this.timers.push(setTimeout(() => {
      s.orchestrator.status = 'running';
      s.messages.at(-1).streaming = false;
      const now = Date.now();
      s.agents.backend = { id: 'backend', role: 'backend', provider: 'codex', status: 'running', taskId: 'T-0001', title: 'API', lastLine: 'Implementando rutas y persistencia', startedAt: now, elapsedMs: 0, log: [{ at: now, kind: 'text', text: 'Leyendo spec y memoria' }] };
      s.agents.frontend = { id: 'frontend', role: 'frontend', provider: 'claude', status: 'running', taskId: 'T-0002', title: 'UI', lastLine: 'Esperando contrato', startedAt: now, elapsedMs: 0, log: [{ at: now, kind: 'text', text: 'Preparando fixture visual' }] };
      this.emit();
      this.tick = setInterval(() => {
        const t = Date.now();
        for (const a of Object.values(s.agents)) {
          if (a.status === 'running') {
            a.elapsedMs = t - a.startedAt;
            const text = a.id === 'backend' ? `npm test paso ${Math.floor(a.elapsedMs / 700)}` : `renderizando estado ${Math.floor(a.elapsedMs / 900)}`;
            a.lastLine = text;
            a.log.push({ at: t, kind: 'text', text });
            a.log = a.log.slice(-400);
          }
        }
        this.emit();
      }, 700);
    }, 1500));
    this.timers.push(setTimeout(() => {
      s.agents.backend.status = 'done';
      s.agents.backend.lastLine = 'T-0001 terminado ✓ API + tests';
      s.agents.backend.log.push({ at: Date.now(), kind: 'result', text: 'Listo: API + tests verdes' });
      this.emit();
    }, 5200));
    this.timers.push(setTimeout(() => {
      clearInterval(this.tick);
      s.orchestrator.status = 'idle';
      s.agents.frontend.status = 'done';
      s.agents.frontend.lastLine = 'T-0002 terminado ✓ UI demo';
      s.agents.frontend.log.push({ at: Date.now(), kind: 'result', text: 'Listo: UI demo verificada' });
      s.messages.push({ id: 'm5', from: 'orchestrator', text: '### Revisión\nIntegración lista. **Tests verdes** y resumen actualizado. Ver `/agentes` para logs completos.', at: Date.now() });
      s.notice = 'demo completa';
      this.emit();
    }, 7600));
    this.emit();
  }
  async send(text) {
    this.store.state.messages.push({ id: String(Date.now()), from: 'user', text, at: Date.now() });
    this.emit();
  }
  async command(name, args = {}) {
    if (name === 'login') {
      const id = args.id || 'provider';
      const p = this.store.state.providers.find((x) => x.id === id);
      if (p) { p.ready = true; p.detail = 'key guardada'; }
      this.store.state.notice = `login ${id}`;
    } else if (name === 'sesion') {
      this.store.state.notice = `sesion ${Array.isArray(args) ? args[0] : args?.id}`;
    } else if (name === 'cancel') {
      this.store.state.orchestrator.status = 'idle';
      this.store.state.notice = 'trabajo cancelado';
    } else this.store.state.notice = `/${name}`;
    this.emit();
  }
  stop() { for (const t of this.timers) clearTimeout(t); if (this.tick) clearInterval(this.tick); }
}

export function sampleState() {
  return {
    project: 'my-app', goal: 'Demo MORAGENT v5', lang: 'es',
    orchestrator: { provider: 'claude', status: 'idle' },
    messages: [{ id: 'm1', from: 'orchestrator', text: 'Hola. Conectado: Claude (suscripción), Codex. ¿Qué construimos?', at: Date.now() }],
    agents: {},
    memory: { canonical: 3, episodic: 9, transient: 1, skills: 4 },
    spec: { slug: 'tareas', phase: 'apply' },
    brain: { linked: true, vault: 'Obsidian' },
    providers: [
      { id: 'claude', label: 'Claude', kind: 'subscription', ready: true, detail: 'sesión local activa', loginHint: 'claude login' },
      { id: 'codex', label: 'Codex', kind: 'subscription', ready: true, detail: 'sesión local activa', loginHint: 'codex login' },
      { id: 'anthropic', label: 'Anthropic', kind: 'api', ready: false, detail: '', loginHint: 'pega ANTHROPIC_API_KEY' },
      { id: 'openai', label: 'OpenAI', kind: 'api', ready: false, detail: '', loginHint: 'pega OPENAI_API_KEY' }
    ],
    sessions: [
      { id: 's1abcdef', title: 'API de tareas con tests', updatedAt: Date.now() - 60_000, messages: 18, provider: 'claude' },
      { id: 's2abcdef', title: 'Checkout flow', updatedAt: Date.now() - 3_600_000, messages: 42, provider: 'codex' }
    ],
    notice: null
  };
}
