import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/tui/render.js';
import { plain } from '../src/core/log.js';
import { LineEditor, decodeKey, decodeKeys } from '../src/tui/input.js';
import { LoginOverlay } from '../src/tui/login.js';
import { sampleState, FakeEngine } from './fixtures/fake-engine.js';

test('render 80x24 fits and collapses sidebar', () => {
  const state = sampleState();
  state.messages.push({ id: 'l', from: 'orchestrator', text: 'x '.repeat(200), at: Date.now() });
  const lines = render(state, { cols: 80, rows: 24, input: 'hola' });
  assert.equal(lines.length, 24);
  assert.ok(lines.every((l) => plain(l).length <= 80));
  assert.ok(lines.some((l) => plain(l).includes('agentes')));
  assert.ok(!lines.some((l) => plain(l).includes('Sin subagentes activos')));
});

test('render 140x40 fits with sidebar and wraps long messages', () => {
  const state = sampleState();
  state.messages.push({ id: 'l', from: 'agent', agent: 'backend (codex)', text: 'mensaje-largo '.repeat(80), at: Date.now() });
  const lines = render(state, { cols: 140, rows: 40, input: '' });
  assert.equal(lines.length, 40);
  assert.ok(lines.every((l) => plain(l).length <= 140));
  assert.ok(lines.some((l) => plain(l).includes('Equipo')));
  assert.ok(lines[0].includes('┬'));
  assert.ok(lines.some((l) => l.includes('┴')));
  assert.ok(lines.filter((l) => plain(l).includes('mensaje-largo')).length > 1);
});

test('render uses state.lang labels and avoids duplicate orchestrator glyph', () => {
  const state = sampleState();
  state.lang = 'es';
  state.messages = [{ id: 'g', from: 'orchestrator', text: '◆ Hola equipo', at: Date.now() }];
  let lines = render(state, { cols: 120, rows: 24 });
  const joined = plain(lines.join('\n'));
  assert.ok(joined.includes('Equipo'));
  assert.ok(joined.includes('Memoria'));
  assert.ok(joined.includes('Hola equipo'));
  assert.ok(!joined.includes('◆ ◆'));
  state.lang = 'en';
  state.messages = [{ id: 'u', from: 'user', text: 'hello', at: Date.now() }];
  lines = render(state, { cols: 80, rows: 24 });
  assert.ok(plain(lines.join('\n')).includes('you ›'));
});

test('sidebar agents include id, short title, lastLine and running spinner', () => {
  const state = sampleState();
  state.agents.backend = { id: 'backend', role: 'backend', provider: 'codex', status: 'running', title: 'API larga de tareas para recortar', lastLine: 'Ejecutando pruebas unitarias', startedAt: 1000 };
  const lines = render(state, { cols: 140, rows: 30 });
  const joined = plain(lines.join('\n'));
  assert.ok(joined.includes('backend'));
  assert.ok(joined.includes('API larga'));
  assert.ok(joined.includes('Ejecutando pruebas unitarias'));
  assert.ok(/[◐◓◑◒]/.test(joined));
});

test('line editor edits, history and completes slash commands', () => {
  const e = new LineEditor({ commands: ['/login', '/plan'] });
  e.handle(Buffer.from('abc'));
  e.handle({ name: 'left' });
  e.handle({ name: 'backspace' });
  assert.equal(e.value, 'ac');
  assert.equal(e.submit(), 'ac');
  e.handle(Buffer.from('/l'));
  e.handle({ name: 'tab' });
  assert.equal(e.value, '/login ');
  e.submit();
  e.handle({ name: 'up' });
  assert.equal(e.value, '/login');
  e.handle({ name: 'down' });
  assert.equal(e.value, '');
});

test('decode keys from raw mode sequences', () => {
  assert.equal(decodeKey('\u001b[A').name, 'up');
  assert.equal(decodeKey('\u001b[5~').name, 'pageup');
  assert.equal(decodeKey('\u0003').name, 'ctrl-c');
  assert.deepEqual(decodeKeys('/salir\r').map((k) => k.name), ['text', 'text', 'text', 'text', 'text', 'text', 'enter']);
});

test('login overlay renders and sends masked api key', async () => {
  const engine = new FakeEngine();
  const overlay = new LoginOverlay(engine.store.state);
  overlay.selected = engine.store.state.providers.findIndex((p) => p.id === 'anthropic');
  await overlay.handle({ name: 'enter' }, engine);
  assert.equal(overlay.snapshot().mode, 'key');
  await overlay.handle({ name: 'text', value: 's' }, engine);
  await overlay.handle({ name: 'text', value: 'k' }, engine);
  const lines = render(engine.store.state, { cols: 80, rows: 24, overlay: overlay.snapshot() });
  assert.ok(lines.some((l) => plain(l).includes('••_')));
  const res = await overlay.handle({ name: 'enter' }, engine);
  assert.equal(res.close, true);
  assert.equal(engine.store.state.providers.find((p) => p.id === 'anthropic').ready, true);
});
