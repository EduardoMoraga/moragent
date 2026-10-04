import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { renderLive, renderFinal, filterCommands, visualRows } from '../src/tui/inline/render.js';
import { InlineInputDecoder } from '../src/tui/inline/input.js';
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

test('inline composer shows the complete wrapped draft and editing cursor', () => {
  const draft = `START ${'long prompt '.repeat(12)} END`;
  const lines = renderLive(sampleState(), { input: draft, cursor: draft.length - 4 }, { cols: 42 });
  const visible = plain(lines.join('\n'));
  assert.ok(lines.every((line) => plain(line).length <= 42));
  assert.ok(visible.includes('START'));
  assert.ok(visible.includes('_ END'));
  assert.ok(lines.filter((line) => plain(line).startsWith('│')).length > 1);
  assert.ok(!visible.includes('…'));
  assert.ok(visible.includes('Enter'));
  assert.ok(visible.includes('Ctrl+J'));
  assert.ok(visible.includes('Ctrl+C'));
  assert.ok(visible.includes('/help'));
});

test('very long drafts keep the cursor in a bounded visible viewport', () => {
  const draft = `START ${'long prompt '.repeat(300)} END`;
  const bottom = renderLive(sampleState(), { input: draft, cursor: draft.length }, { cols: 42, rows: 24 });
  assert.ok(bottom.length <= 17);
  assert.ok(plain(bottom.join('\n')).includes('END_'));
  assert.ok(plain(bottom.join('\n')).includes('↑'));

  const top = renderLive(sampleState(), { input: draft, cursor: 0 }, { cols: 42, rows: 24 });
  assert.ok(plain(top.join('\n')).includes('> _START'));
  assert.ok(plain(top.join('\n')).includes('↓'));
});

test('inline input decoder preserves split UTF-8 and distinguishes Shift+Enter from send', () => {
  const decoder = new InlineInputDecoder();
  const emoji = Buffer.from('🧭');
  assert.deepEqual(decoder.push(emoji.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(emoji.subarray(2)), [{ name: 'text', value: '🧭' }]);
  assert.deepEqual(decoder.push('\x1b[13;2u'), [{ name: 'newline' }]);
  assert.deepEqual(decoder.push('\r'), [{ name: 'enter' }]);
});

test('inline typing and redraw preserve draft; paste and newline do not send', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value) => { input.isRaw = value; };
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 48;
  output.rows = 24;
  let written = '';
  output.write = (chunk) => { written += String(chunk); return true; };
  const store = new EventEmitter();
  store.state = sampleState();
  const sent = [];
  const engine = { store, async send(value) { sent.push(value); }, async command() {}, stop() {} };
  const done = runInline({ engine, input, output });

  input.write('ordinary draft');
  store.state.messages.push({ id: 'status', from: 'system', text: 'status changed' });
  store.emit('change');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(plain(written.slice(written.lastIndexOf('\x1b[J'))).includes('ordinary draft'));

  input.write('\x1b[200~first line\r\nsecond line\x1b[201~');
  input.write('\nthird line');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(sent, []);
  let visible = plain(written.slice(written.lastIndexOf('\x1b[J')));
  assert.ok(visible.includes('first line'));
  assert.ok(visible.includes('second line'));
  assert.ok(visible.includes('third line'));

  output.columns = 36;
  output.emit('resize');
  await new Promise((resolve) => setTimeout(resolve, 80));
  visible = plain(written.slice(written.lastIndexOf('\x1b[J')));
  assert.ok(visible.includes('ordinary draft'));
  assert.ok(visible.includes('third line'));
  assert.deepEqual(sent, []);

  input.write('\r');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(sent, ['ordinary draftfirst line\nsecond line\nthird line']);
  input.write('\x03');
  await done;
  assert.equal(input.isRaw, false);
  assert.ok(written.includes('\x1b[?2004h'));
  assert.ok(written.includes('\x1b[?2004l'));
});

test('split bracketed paste markers keep a multiline draft editable', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 60;
  let written = '';
  output.write = (chunk) => { written += String(chunk); return true; };
  const store = new EventEmitter();
  store.state = sampleState();
  const sent = [];
  const done = runInline({ engine: { store, async send(value) { sent.push(value); }, stop() {} }, input, output });
  input.write('\x1b[20');
  input.write('0~alpha\nbe');
  input.write('ta\x1b[20');
  input.write('1~');
  assert.deepEqual(sent, []);
  assert.ok(plain(written.slice(written.lastIndexOf('\x1b[J'))).includes('beta'));
  input.write('\r');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(sent, ['alpha\nbeta']);
  input.write('\x03');
  await done;
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
