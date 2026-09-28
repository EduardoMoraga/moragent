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
  assert.ok(joined.includes('●'));
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
  assert.equal(decodeKey('\u0002').name, 'ctrl-b');
  assert.equal(decodeKey('\u001b[1;2A').name, 'shift-up');
  assert.equal(decodeKey('\u001b[<64;10;10M').name, 'wheel-up');
  assert.deepEqual(decodeKeys('/salir\r').map((k) => k.name), ['text', 'text', 'text', 'text', 'text', 'text', 'enter']);
});

test('render agent cards, markdown, narrow status and new message indicator', () => {
  const state = sampleState();
  state.messages.push({ id: 'md', from: 'orchestrator', text: '**Plan**\n- uno\n- dos', at: Date.now() });
  state.agents['T-0001'] = { id: 'T-0001', role: 'backend', provider: 'codex', status: 'running', taskId: 'T-0001', title: 'API', elapsedMs: 72_000, log: [{ kind: 'text', text: '**listo** `npm test`' }, { kind: 'tool', text: '**listo** `npm test`' }, { kind: 'tool', text: '- ejecutando verificación' }] };
  const lines = render(state, { cols: 70, rows: 24, scroll: 1, newCount: 3 });
  const joined = plain(lines.join('\n'));
  assert.ok(joined.includes('backend ● 1m12s'));
  assert.ok(joined.includes('backend · codex · T-0001 · 1m12s'));
  assert.ok(!joined.includes('T-0001 · codex · T-0001'));
  assert.ok(!joined.includes('**listo**'));
  assert.ok(!joined.includes('`npm test`'));
  assert.equal((joined.match(/listo npm test/g) || []).length, 1);
  assert.ok(joined.includes('• uno'));
  assert.ok(joined.includes('↓ 3 nuevos · End'));
  assert.ok(lines.every((l) => plain(l).length <= 70));
});

test('render agents and sessions overlays', () => {
  const state = sampleState();
  state.root = '/Users/eduardo/app';
  state.agents.backend = { id: 'backend', role: 'backend', provider: 'codex', status: 'done', taskId: 'T-0001', title: 'API', log: [{ kind: 'text', text: '/Users/eduardo/app/src/api/routes.js ' + 'a'.repeat(80) }] };
  let lines = render(state, { cols: 80, rows: 24, overlay: { type: 'agents', selected: 0, scroll: 0 } });
  let joined = plain(lines.join('\n'));
  assert.ok(joined.includes('Agentes'));
  assert.ok(joined.includes('backend'));
  assert.ok(joined.includes('src/api/routes.js'));
  assert.ok(!joined.includes('/Users/eduardo/app/src/api/routes.js'));
  lines = render(state, { cols: 80, rows: 24, overlay: { type: 'sessions', selected: 0 } });
  joined = plain(lines.join('\n'));
  assert.ok(joined.includes('Sesiones'));
  assert.ok(joined.includes('API de tareas con tests'));
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
