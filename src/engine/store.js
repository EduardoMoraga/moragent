import { EventEmitter } from 'node:events';

let seq = 0;
export const nextId = (prefix = 'm') => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;

// Single source of truth for the TUI. Mutations go through set()/message helpers so every change
// emits one 'change' event; the TUI throttles redraws on its side.
export function createStore(initial) {
  const store = new EventEmitter();
  store.state = initial;
  store.set = (patch) => {
    const next = typeof patch === 'function' ? patch(store.state) : patch;
    store.state = { ...store.state, ...next };
    store.emit('change', store.state);
  };
  store.addMessage = (msg) => {
    const m = { id: nextId(), at: new Date().toISOString(), ...msg };
    store.set((s) => ({ messages: [...s.messages, m] }));
    return m.id;
  };
  store.updateMessage = (id, patch) => {
    store.set((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, ...(typeof patch === 'function' ? patch(m) : patch) } : m)) }));
  };
  store.setAgent = (id, patch) => {
    store.set((s) => ({ agents: { ...s.agents, [id]: { ...(s.agents[id] || { id }), ...patch } } }));
  };
  return store;
}
