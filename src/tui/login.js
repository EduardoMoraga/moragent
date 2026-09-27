import { decodeKey } from './input.js';

export class LoginOverlay {
  constructor(state) {
    this.type = 'login';
    this.selected = 0;
    this.mode = 'list';
    this.key = '';
    this.providerId = null;
    this.state = state;
  }
  providers() { return this.state.providers || []; }
  current() { return this.providers()[this.selected]; }
  snapshot() { return { type: 'login', selected: this.selected, mode: this.mode, key: this.key, providerId: this.providerId }; }
  async handle(raw, engine) {
    const key = typeof raw === 'string' || Buffer.isBuffer(raw) ? decodeKey(raw) : raw;
    if (key.name === 'escape') return { close: true };
    if (this.mode === 'key') {
      if (key.name === 'enter') {
        await engine.command('login', { id: this.providerId, key: this.key });
        return { close: true };
      }
      if (key.name === 'backspace') this.key = this.key.slice(0, -1);
      if (key.name === 'text') this.key += key.value;
      return { dirty: true };
    }
    if (key.name === 'up') this.selected = Math.max(0, this.selected - 1);
    if (key.name === 'down') this.selected = Math.min(Math.max(0, this.providers().length - 1), this.selected + 1);
    if (key.name === 'enter') {
      const p = this.current();
      if (!p) return { close: true };
      if (p.kind === 'api') { this.mode = 'key'; this.providerId = p.id; this.key = ''; return { dirty: true }; }
      await engine.command('login', { id: p.id });
      return { close: true };
    }
    return { dirty: true };
  }
}
