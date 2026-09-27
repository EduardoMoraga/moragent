import { EventEmitter } from 'node:events';

export class FakeEngine {
  constructor() {
    this.store = new EventEmitter();
    this.store.state = sampleState();
    this.timers = [];
  }
  emit() { this.store.emit('change'); }
  startDemo() {
    this.timers.push(setTimeout(() => {
      this.store.state.orchestrator.status = 'thinking';
      this.store.state.messages.push({ id: 'm2', from: 'user', text: 'API de tareas con tests', at: Date.now() });
      this.store.state.messages.push({ id: 'm3', from: 'orchestrator', text: 'Plan (M · 2 subagentes) preparando tareas y validaciones.', at: Date.now(), streaming: true });
      this.emit();
    }, 600));
    this.timers.push(setTimeout(() => {
      this.store.state.orchestrator.status = 'running';
      this.store.state.messages.at(-1).streaming = false;
      this.store.state.agents.backend = { id: 'backend', role: 'backend', provider: 'codex', status: 'running', taskId: 'T-0001', title: 'API', lastLine: 'Implementando rutas y persistencia', startedAt: Date.now() };
      this.store.state.agents.frontend = { id: 'frontend', role: 'frontend', provider: 'claude', status: 'running', taskId: 'T-0002', title: 'UI', lastLine: 'Armando componentes de estado', startedAt: Date.now() };
      this.store.state.messages.push({ id: 'm4', from: 'agent', agent: 'backend (codex)', text: 'Creando endpoints REST, fixtures y pruebas de contrato.', at: Date.now() });
      this.emit();
    }, 1500));
    this.timers.push(setTimeout(() => {
      this.store.state.orchestrator.status = 'idle';
      this.store.state.agents.backend.status = 'done';
      this.store.state.agents.backend.lastLine = 'T-0001 terminado ✓';
      this.store.state.agents.frontend.status = 'done';
      this.store.state.agents.frontend.lastLine = 'T-0002 terminado ✓';
      this.store.state.messages.push({ id: 'm5', from: 'orchestrator', text: 'Integración lista. Tests verdes y resumen actualizado.', at: Date.now() });
      this.store.state.notice = 'demo completa';
      this.emit();
    }, 3000));
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
    } else if (name === 'cancel') {
      this.store.state.orchestrator.status = 'idle';
      this.store.state.notice = 'trabajo cancelado';
    } else this.store.state.notice = `/${name}`;
    this.emit();
  }
  stop() { for (const t of this.timers) clearTimeout(t); }
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
    notice: null
  };
}
