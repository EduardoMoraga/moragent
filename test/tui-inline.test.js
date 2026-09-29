import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { renderLive, renderFinal, filterCommands, visualRows } from '../src/tui/inline/render.js';
import { runInline } from '../src/tui/inline/index.js';
import { plain } from '../src/core/log.js';
import { sampleState } from './fixtures/fake-engine.js';

test('renderLive fits 60 and 120 cols with slash menu and /tarea first', () => {
  const state = sampleState();
  state.agents.t1 = { id: 'T-0001', role: 'backend', provider: 'codex', status: 'running', taskId: 'T-0001', elapsedMs: 38000, lastLine: '5/5 tests' };
  for (const cols of [60, 120]) {
    const lines = renderLive(state, { input: '/', menu: { items: filterCommands('/'), selected: 0 } }, { cols });
    assert.ok(lines.every((l) => plain(l).length <= cols));
    assert.ok(plain(lines.join('\n')).includes('/tarea'));
    assert.ok(visualRows(lines, cols) >= lines.length);
  }
  assert.equal(filterCommands('/')[0].name, '/tarea');
  assert.equal(filterCommands('/orq')[0].name, '/orquestador');
  assert.ok(filterCommands('/zzz').some((x) => x.name === '/tarea'));
});

test('renderFinal wraps markdown in 60 and 120 cols', () => {
  const msg = { id: 'm1', from: 'orchestrator', text: '**Plan**\n- escribir conversor con pruebas largas '.repeat(8) };
  for (const cols of [60, 120]) {
    const lines = renderFinal(msg, { cols, lang: 'es' });
    assert.ok(lines.every((l) => plain(l).length <= cols));
    assert.ok(!plain(lines.join('\n')).includes('**'));
  }
});

test('blocked workers are not counted as actively working', () => {
  const state = sampleState();
  state.agents.t1 = { id: 'T-0001', role: 'backend', provider: 'compatible', status: 'blocked', taskId: 'T-0001' };
  state.orchestrator.status = 'idle';
  const text = plain(renderLive(state, { input: '' }, { cols: 80 }).join('\n'));
  assert.match(text, /sin agentes activos|no agents running/);
  assert.doesNotMatch(text, /agente trabajando|agent working/);
});

test('runInline prints updated message once when it becomes final and picker navigates', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (v) => { input.isRaw = v; };
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 80;
  let written = '';
  output.write = (chunk) => { written += String(chunk); return true; };
  const store = new EventEmitter();
  store.state = sampleState();
  store.state.messages = [{ id: 's', from: 'orchestrator', text: 'parcial', streaming: true }];
  const calls = [];
  const engine = { store, async send(t) { calls.push(['send', t]); }, async command(n, a) { calls.push([n, a]); }, stop() {} };
  const p = runInline({ engine, input, output });
  store.state.messages[0].text = 'final **único**';
  store.state.messages[0].streaming = false;
  store.emit('change');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal((plain(written).match(/final único/g) || []).length, 1);
  input.write('/zz\r');
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(plain(written).includes('/tarea'));
  assert.deepEqual(calls, []);
  input.write('\u001b');
  input.write('/tarea\r');
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(plain(written).includes('rol para /tarea'));
  input.write('\u001b[B');
  input.write('\r');
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(plain(written).includes('/tarea'));
  input.write('\u0003'); // first Ctrl+C clears the typed text
  input.write('\u0003'); // second one exits
  await p;
  assert.equal(input.isRaw, false);
});
