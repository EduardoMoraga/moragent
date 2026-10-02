import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createStore } from '../src/engine/store.js';
import { plain } from '../src/core/log.js';
import { runInline } from '../src/tui/inline/index.js';
import { renderLive, renderFinal } from '../src/tui/inline/render.js';
import { decodeKeys, TerminalKeyDecoder } from '../src/tui/input.js';

const pause = () => new Promise((resolve) => setTimeout(resolve, 20));

function harness() {
  const input = new PassThrough();
  const output = new PassThrough();
  output.columns = 80;
  let shown = '';
  output.on('data', (chunk) => { shown += chunk.toString(); });
  const calls = [];
  const store = createStore({
    project: 'demo', lang: 'en', messages: [], agents: {},
    orchestrator: { provider: 'claude', status: 'idle' },
    providers: [
      { id: 'claude', label: 'Claude Code', kind: 'subscription', ready: true },
      { id: 'openai', label: 'OpenAI API', kind: 'api', ready: true },
    ],
  });
  const engine = {
    store, root: null,
    async send(text) { calls.push({ name: 'send', text }); },
    listModels: async (id) => id === 'claude' ? [{ id: 'sonnet' }] : [{ id: 'gpt-test' }],
    roleEngine: (role) => role === 'backend' ? 'claude' : null,
    async command(name, args) { calls.push({ name, args }); },
    stop() {},
  };
  const send = async (keys) => { input.write(keys); await pause(); };
  return { input, output, engine, calls, send, get shown() { return shown; } };
}

test('inline slash menu uses English command names after switching language and keeps Spanish aliases', async () => {
  const h = harness();
  h.engine.store.set({ lang: 'es' });
  const done = runInline(h);
  await h.send('/');
  assert.match(h.shown, /\/tarea\s+desplegar/);
  await h.send('\x03');
  h.engine.store.set({ lang: 'en' });
  const before = h.shown.length;
  await h.send('/');
  const englishMenu = h.shown.slice(before);
  assert.match(englishMenu, /\/task\s+deploy/);
  assert.match(englishMenu, /\/orchestrator\s+pick/);
  assert.doesNotMatch(englishMenu, /\/tarea\s+deploy/);
  await h.send('\x03');
  await h.send('/tarea\r');
  assert.match(h.shown, /role for \/task/);
  await h.send('\x1b');
  await h.send('/exit\r');
  await done;
});

test('inline /login masks an API key and never records it in terminal output', async () => {
  const h = harness();
  const done = runInline(h);
  await h.send('/login openai\r');
  assert.match(h.shown, /API key for OpenAI API/);
  await h.send('sk-private-value');
  assert.doesNotMatch(h.shown, /sk-private-value/);
  await h.send('\r');
  assert.deepEqual(h.calls.at(-1), { name: 'login', args: { id: 'openai', key: 'sk-private-value' } });
  assert.doesNotMatch(h.shown, /sk-private-value/);
  await h.send('/exit\r');
  await done;
});

test('inline /login configures a compatible URL and optional masked key', async () => {
  const h = harness();
  h.engine.store.set((state) => ({ providers: [...state.providers, { id: 'compatible', label: 'OpenAI-compatible', kind: 'api', ready: false }] }));
  const done = runInline(h);
  await h.send('/login compatible\r');
  assert.match(h.shown, /base URL/);
  await h.send('http://localhost:7777/v1\r');
  assert.deepEqual(h.calls.at(-1), { name: 'login', args: { id: 'compatible', url: 'http://localhost:7777/v1' } });
  assert.match(h.shown, /Optional API key/);
  await h.send('secret-for-local\r');
  assert.deepEqual(h.calls.at(-1), { name: 'login', args: { id: 'compatible', key: 'secret-for-local' } });
  assert.doesNotMatch(h.shown, /secret-for-local/);
  await h.send('/exit\r');
  await done;
});

test('inline selects ready subscription providers without opening their CLI', async () => {
  const h = harness();
  h.engine.store.set((state) => ({ providers: [...state.providers, { id: 'pi', label: 'Pi', kind: 'subscription', ready: true }] }));
  let refreshes = 0;
  h.engine.refreshProviders = async () => { refreshes++; };
  const done = runInline(h);
  await h.send('/login claude\r');
  await h.send('/login pi\r');
  assert.deepEqual(h.calls.filter((call) => call.name === 'orquestador'), [
    { name: 'orquestador', args: ['claude'] },
    { name: 'orquestador', args: ['pi'] },
  ]);
  assert.equal(h.calls.some((call) => call.name === 'login'), false);
  assert.equal(refreshes, 2);
  await h.send('/help\r');
  assert.deepEqual(h.calls.at(-1), { name: 'help', args: [] });
  await h.send('/exit\r');
  await done;
});

test('inline /model shows every engine and switches provider with the selected model', async () => {
  const h = harness();
  const done = runInline(h);
  await h.send('/model\r');
  assert.match(h.shown, /Claude Code/);
  assert.match(h.shown, /OpenAI API/);
  assert.match(h.shown, /gpt-test/);
  await h.send('gpt-test');
  assert.match(h.shown, /search: gpt-test/);
  await h.send('\r');
  assert.deepEqual(h.calls.slice(-2), [
    { name: 'orquestador', args: ['openai'] },
    { name: 'modelo', args: ['gpt-test'] },
  ]);
  await h.send('/exit\r');
  await done;
});

test('inline role model picker assigns its provider before its model', async () => {
  const h = harness();
  const done = runInline(h);
  await h.send('/model backend\r');
  await h.send('gpt-test');
  await h.send('\r');
  assert.deepEqual(h.calls.slice(-2), [
    { name: 'equipo', args: ['backend', 'openai'] },
    { name: 'modelo', args: ['backend', 'gpt-test'] },
  ]);
  await h.send('/exit\r');
  await done;
});

test('model picker does not mark catalog-listed models as verified access in English or Spanish', async () => {
  for (const [lang, command, legend] of [
    ['en', '/model', /model access unverified/],
    ['es', '/modelo', /acceso al modelo sin verificar/],
  ]) {
    const h = harness();
    h.engine.store.set({ lang });
    const done = runInline(h);
    const before = h.shown.length;
    await h.send(`${command}\r`);
    const picker = h.shown.slice(before);
    assert.match(picker, legend);
    assert.match(picker, /·\s+gpt-test/);
    assert.doesNotMatch(picker, /✓\s+gpt-test/);
    await h.send('\x1b');
    await h.send('/exit\r');
    await done;
  }
});

test('inline /model shows available models while another catalog is still loading', async () => {
  const h = harness();
  let releaseClaude;
  h.engine.listModels = (id) => id === 'claude'
    ? new Promise((resolve) => { releaseClaude = resolve; })
    : Promise.resolve([{ id: 'gpt-fast', label: 'GPT Fast' }]);
  const done = runInline(h);
  await h.send('/model\r');
  assert.match(h.shown, /GPT Fast/);
  releaseClaude([{ id: 'sonnet' }]);
  await pause();
  await h.send('\x1b');
  await h.send('/exit\r');
  await done;
  const finalOutput = h.shown;
  await pause();
  assert.equal(h.shown, finalOutput, 'no redraw is scheduled after exit');
});

test('inline /model coalesces catalog updates into one terminal redraw', async () => {
  const h = harness();
  h.engine.store.set(() => ({ providers: Array.from({ length: 12 }, (_, index) => ({
    id: `provider-${index}`, label: `Provider ${index}`, kind: 'api', ready: true,
  })) }));
  h.engine.listModels = async (id) => [{ id: `${id}-model` }];
  const done = runInline(h);
  await h.send('/model\r');
  assert.equal((h.shown.match(/Orchestrator model  ·  search:/g) || []).length, 1);
  assert.match(h.shown, /provider-0-model/);
  await h.send('\x1b');
  await h.send('/exit\r');
  await done;
});

test('an old model catalog cannot overwrite a newly opened picker', async () => {
  const h = harness();
  let releaseOld;
  let firstClaude = true;
  h.engine.listModels = (id) => {
    if (id === 'claude' && firstClaude) {
      firstClaude = false;
      return new Promise((resolve) => { releaseOld = resolve; });
    }
    return Promise.resolve([{ id: 'current', label: 'Current Model' }]);
  };
  const done = runInline(h);
  await h.send('/model\r');
  await h.send('\x1b');
  await h.send('/model\r');
  assert.match(h.shown, /Current Model/);
  releaseOld([{ id: 'stale', label: 'Stale Model' }]);
  await pause();
  assert.doesNotMatch(h.shown, /Stale Model/);
  await h.send('\x1b');
  await h.send('/exit\r');
  await done;
});

test('live view shows orchestrator phase, tool and elapsed time', () => {
  const lines = renderLive({ lang: 'en', messages: [], agents: {}, providers: [], orchestrator: {
    provider: 'claude', status: 'reading', activity: 'read_file src/index.js', startedAt: new Date(Date.now() - 3000).toISOString(),
  } }, { input: '' }, { cols: 80 }).join('\n');
  assert.match(lines, /Orchestrator · using tool · 3s · read_file src\/index\.js/);
});

test('live view shows a worker preparing its private copy', () => {
  const lines = renderLive({ lang: 'en', messages: [], providers: [], orchestrator: { provider: 'codex', status: 'running' }, agents: {
    'T-0001': { id: 'T-0001', taskId: 'T-0001', role: 'backend', provider: 'codex', status: 'preparing', lastLine: 'copying project…' },
  } }, { input: '' }, { cols: 80 }).join('\n');
  assert.match(lines, /backend · codex.*copying project/);
});

test('live crew panel summarizes parallel work, outcomes and task context', () => {
  const state = { lang: 'en', messages: [], providers: [], orchestrator: { status: 'running' }, agents: {
    'T-0001': { id: 'T-0001', taskId: 'T-0001', role: 'backend', provider: 'codex', status: 'running', title: 'Add API', lastLine: 'editing src/api.ts', startedAt: new Date(Date.now() - 12000).toISOString() },
    'T-0002': { id: 'T-0002', taskId: 'T-0002', role: 'frontend', provider: 'claude', status: 'preparing', title: 'Build panel', lastLine: 'copying project' },
    'T-0003': { id: 'T-0003', taskId: 'T-0003', role: 'tests', provider: 'openai', status: 'done', title: 'Add regression test' },
    'T-0004': { id: 'T-0004', taskId: 'T-0004', role: 'docs', provider: 'pi', status: 'blocked', title: 'Update docs' },
  } };
  const lines = renderLive(state, { input: '' }, { cols: 90 }).join('\n');
  assert.match(lines, /Crew · 2 active · 1 done · 1 blocked/);
  assert.match(lines, /backend · codex  T-0001.*Add API.*editing src\/api\.ts/);
  assert.match(lines, /frontend · claude  T-0002.*Build panel/);
});

test('live crew panel compacts cleanly on narrow terminals and preserves completed outcomes', () => {
  const state = { lang: 'es', messages: [], providers: [], orchestrator: { status: 'idle' }, agents: {
    'T-0001': { id: 'T-0001', role: 'api', provider: 'ollama', status: 'done', title: 'API terminada' },
  } };
  const lines = renderLive(state, { input: '' }, { cols: 36 }).join('\n');
  assert.match(lines, /Equipo · 1 terminada/);
  assert.match(lines, /último resultado · api/);
  assert.ok(lines.split('\n').every((line) => line.replace(/\u001b\[[0-9;]*m/g, '').length <= 36));
});

test('Ctrl-C cancels an orchestrator tool call instead of exiting the inline app', async () => {
  const h = harness();
  let stopped = false;
  h.engine.stop = () => { stopped = true; };
  const done = runInline(h);
  h.engine.store.set((state) => ({ orchestrator: { ...state.orchestrator, status: 'reading', activity: 'read_file note.txt' } }));
  await h.send('\x03');
  assert.deepEqual(h.calls.at(-1), { name: 'cancel', args: undefined });
  assert.equal(stopped, false);
  await h.send('/exit\r');
  await done;
  assert.equal(stopped, true);
});

test('a slow send does not block /cancel in the same terminal input chunk', async () => {
  const h = harness();
  let release;
  h.engine.send = () => new Promise((resolve) => { release = resolve; });
  const done = runInline(h);
  await h.send('long request\r/cancel\r');
  assert.deepEqual(h.calls.at(-1), { name: 'cancel', args: [] });
  release?.();
  await h.send('/exit\r');
  await done;
});

test('a slow explicit /task does not block /cancel in the same input chunk', async () => {
  const h = harness();
  let release;
  h.engine.command = (name, args) => {
    h.calls.push({ name, args });
    if (name === 'task') return new Promise((resolve) => { release = resolve; });
    return Promise.resolve();
  };
  const done = runInline(h);
  await h.send('/task backend long request\r/cancel\r');
  assert.deepEqual(h.calls.map((call) => call.name), ['task', 'cancel']);
  release?.();
  await h.send('/exit\r');
  await done;
});

test('a slow /recoveries apply does not block /cancel in the same terminal input chunk', async () => {
  const h = harness();
  let release;
  h.engine.command = (name, args) => {
    h.calls.push({ name, args });
    if (name === 'recoveries') return new Promise((resolve) => { release = resolve; });
    return Promise.resolve();
  };
  const done = runInline(h);
  await h.send('/recoveries apply T-0033\r/cancel\r');
  assert.deepEqual(h.calls.slice(-2), [
    { name: 'recoveries', args: ['apply', 'T-0033'] },
    { name: 'cancel', args: [] },
  ]);
  release?.();
  await h.send('/exit\r');
  await done;
});

test('Ctrl-C cancels recovery application instead of exiting the inline app', async () => {
  const h = harness();
  let stopped = false;
  h.engine.stop = () => { stopped = true; };
  const done = runInline(h);
  h.engine.store.set({ recoveryApplying: true });
  await h.send('\x03');
  assert.deepEqual(h.calls.at(-1), { name: 'cancel', args: undefined });
  assert.equal(stopped, false);
  await h.send('/exit\r');
  await done;
});

test('a failed background turn still appears as a system error', async () => {
  const h = harness();
  h.engine.send = async () => { throw new Error('provider unavailable'); };
  const done = runInline(h);
  await h.send('hello\r');
  assert.match(h.shown, /provider unavailable/);
  await h.send('/exit\r');
  await done;
});

test('Ctrl-C dismisses the model picker and returns to normal input', async () => {
  const h = harness();
  const done = runInline(h);
  await h.send('/model\r');
  await h.send('\x03');
  await h.send('hello\r');
  assert.deepEqual(h.calls.at(-1), { name: 'send', text: 'hello' });
  await h.send('/exit\r');
  await done;
});

test('inline transcript does not print an empty orchestrator bubble for a plan-only answer', () => {
  assert.deepEqual(renderFinal({ from: 'orchestrator', text: '' }, { lang: 'en' }), []);
});

test('inline rendering does not emit terminal controls supplied by an engine', async () => {
  const hostile = 'visible\x1b[2J\x1b]52;c;clipboard\x07\rhidden';
  const final = renderFinal({ from: 'orchestrator', text: hostile }, { lang: 'en' }).join('\n');
  assert.match(final, /visible/);
  assert.doesNotMatch(final, /\x1b\[2J|\x1b\]52|\x07|\r/);

  const live = renderLive({ lang: 'en', messages: [], providers: [], orchestrator: { provider: 'openai', status: 'reading', activity: hostile }, agents: {
    'T-0001': { id: 'T-0001', role: 'backend', provider: 'openai', status: 'running', lastLine: hostile, log: [{ kind: 'text', text: hostile }] },
  } }, { input: '' }, { cols: 80 }).join('\n');
  assert.doesNotMatch(live, /\x1b\[2J|\x1b\]52|\x07|\r/);

  const h = harness();
  h.engine.store.set(() => ({ agents: { 'T-0001': { id: 'T-0001', role: 'backend', provider: 'openai', status: 'done', log: [{ kind: 'text', text: hostile }] } } }));
  const done = runInline(h);
  await h.send('/agents backend\r');
  assert.doesNotMatch(h.shown, /\x1b\[2J|\x1b\]52|\x07|\rhidden/);
  await h.send('/exit\r');
  await done;
});

test('keyboard decoder keeps escape sequences and adjacent pasted text separate', () => {
  assert.deepEqual(decodeKeys('\x1b/exit\r').map((key) => key.name), ['escape', 'text', 'text', 'text', 'text', 'text', 'enter']);
  assert.deepEqual(decodeKeys('\x1b[B\x1b[A').map((key) => key.name), ['down', 'up']);
});

test('inline editor keeps split arrow sequences and UTF-8 characters intact', async () => {
  const h = harness();
  const done = runInline(h);
  await h.send('ab');
  await h.send('\x1b[');
  await h.send('D');
  await h.send('X\r');
  assert.deepEqual(h.calls.at(-1), { name: 'send', text: 'aXb' });
  const phrase = Buffer.from('Español\r');
  const split = phrase.indexOf(0xc3);
  await h.send(phrase.subarray(0, split + 1));
  await h.send(phrase.subarray(split + 1));
  assert.deepEqual(h.calls.at(-1), { name: 'send', text: 'Español' });
  await h.send('/exit\r');
  await done;
});

test('terminal key decoder buffers partial mouse and multibyte sequences, but flushes a lone Esc', () => {
  const decoder = new TerminalKeyDecoder();
  assert.deepEqual(decoder.push(Buffer.from('\x1b[<64;10;')).map((key) => key.name), []);
  assert.deepEqual(decoder.push(Buffer.from('10M')).map((key) => key.name), ['wheel-up']);
  const accent = Buffer.from('ñ');
  assert.deepEqual(decoder.push(accent.subarray(0, 1)), []);
  assert.deepEqual(decoder.push(accent.subarray(1)).map((key) => key.value), ['ñ']);
  assert.deepEqual(decoder.push(Buffer.from('\x1b')).map((key) => key.name), []);
  assert.deepEqual(decoder.flush().map((key) => key.name), ['escape']);
  assert.deepEqual(decoder.push(Buffer.from('x')).map((key) => key.value), ['x']);
});

test('terminal key decoder treats split bracketed paste as one literal event', () => {
  const decoder = new TerminalKeyDecoder();
  assert.deepEqual(decoder.push(Buffer.from('\x1b[20')), []);
  assert.equal(decoder.hasPendingEscape, false, 'partial paste marker must not be flushed as Esc');
  assert.deepEqual(decoder.push(Buffer.from('0~first\nsecond\x1b[20')), []);
  assert.deepEqual(decoder.push(Buffer.from('1~\r')), [
    { name: 'paste', value: 'first\nsecond' },
    { name: 'enter' },
  ]);
  assert.deepEqual(decoder.push(Buffer.from('\x1b[200~\x03\x1b[A\n\x1b[201~')), [
    { name: 'paste', value: '\x03\x1b[A\n' },
  ]);
});

test('inline multiline paste stays one draft until Enter submits it', async () => {
  const h = harness();
  const done = runInline(h);
  await h.send('\x1b[200~first line\nsecond line\x1b[201~');
  assert.deepEqual(h.calls, []);
  await h.send('\r');
  assert.deepEqual(h.calls, [{ name: 'send', text: 'first line\nsecond line' }]);
  await h.send('/exit\r');
  await done;
});

test('plain LF and Ctrl+J keep a multiline draft until CR submits it', async () => {
  const h = harness();
  const done = runInline(h);
  await h.send('first line\nsecond line');
  assert.deepEqual(h.calls, []);
  assert.match(h.shown, /first line/);
  assert.match(h.shown, /second line/);
  await h.send('\nthird line');
  assert.deepEqual(h.calls, []);
  await h.send('\r');
  assert.deepEqual(h.calls, [{ name: 'send', text: 'first line\nsecond line\nthird line' }]);
  await h.send('/exit\r');
  await done;
});

test('a long slash-command prompt remains visible after its arguments start', () => {
  const input = '/task backend ' + 'explain the repository and all the required changes '.repeat(4);
  const rendered = renderLive({ lang: 'en' }, { input, cursor: input.length }, { cols: 36 });
  const text = rendered.join('\n');
  assert.doesNotMatch(text, /deploy one agent directly/);
  assert.match(text, /required changes/);
  assert.match(text, /Enter send · Ctrl\+J new line/);
  assert.ok(rendered.length > 5, 'the prompt wraps into visible rows');
  assert.ok(rendered.every((line) => plain(line).length <= 36));
});

test('inline /task and /plan preserve line breaks in pasted instructions', async () => {
  const h = harness();
  const done = runInline(h);
  await h.send('\x1b[200~/task backend first line\r\nsecond line\x1b[201~\r');
  assert.deepEqual(h.calls.at(-1), { name: 'task', args: ['backend', 'first line\nsecond line'] });
  await h.send('\x1b[200~/plan first line\nsecond line\x1b[201~\r');
  assert.deepEqual(h.calls.at(-1), { name: 'plan', args: ['first line\nsecond line'] });
  await h.send('/plan\r');
  assert.deepEqual(h.calls.at(-1), { name: 'plan', args: [] });
  await h.send('/exit\r');
  await done;
});

test('inline enables and restores bracketed paste mode only for a TTY', async () => {
  const h = harness();
  h.input.isTTY = true;
  h.output.isTTY = true;
  h.input.setRawMode = (value) => { h.input.isRaw = value; };
  const done = runInline(h);
  assert.match(h.shown, /\x1b\[\?2004h/);
  await h.send('/exit\r');
  await done;
  assert.match(h.shown, /\x1b\[\?2004l/);
  assert.equal(h.input.isRaw, false);
});

test('unready subscription opens a separate connection flow and keeps MORAGENT input active', async () => {
  const h = harness();
  h.input.isTTY = true;
  h.output.isTTY = true;
  h.input.setRawMode = (value) => { h.input.isRaw = value; };
  h.engine.store.set((state) => ({ providers: [...state.providers, { id: 'pi', label: 'Pi', kind: 'subscription', ready: false }] }));
  h.engine.refreshProviders = async () => {};
  const done = runInline(h);
  await h.send('/login pi\r');
  assert.deepEqual(h.calls.at(-1), { name: 'login', args: { id: 'pi' } });
  assert.match(h.shown, /MORAGENT stays active/);
  assert.equal(h.input.isRaw, true);
  assert.equal(h.shown.match(/\x1b\[\?2004[hl]/g)?.at(-1), '\x1b[?2004h');
  await h.send('/help\r');
  assert.deepEqual(h.calls.at(-1), { name: 'help', args: [] });
  await h.send('/exit\r');
  await done;
});

test('a pending subscription model is selected after authentication when the provider is chosen again', async () => {
  const h = harness();
  h.engine.store.set((state) => ({ providers: [state.providers[0], { id: 'pi', label: 'Pi', kind: 'subscription', ready: false }] }));
  h.engine.refreshProviders = async () => {};
  const done = runInline(h);
  await h.send('/model\r');
  await h.send('pi');
  await h.send('\r');
  assert.deepEqual(h.calls.at(-1), { name: 'login', args: { id: 'pi' } });
  h.engine.store.set((state) => ({ providers: state.providers.map((provider) => provider.id === 'pi' ? { ...provider, ready: true } : provider) }));
  await h.send('/login pi\r');
  assert.deepEqual(h.calls.slice(-2), [
    { name: 'orquestador', args: ['pi'] },
    { name: 'modelo', args: ['default'] },
  ]);
  await h.send('/exit\r');
  await done;
});

test('failed subscription connection leaves MORAGENT commands usable', async () => {
  const h = harness();
  h.engine.store.set((state) => ({ providers: [...state.providers, { id: 'pi', label: 'Pi', kind: 'subscription', ready: false }] }));
  h.engine.refreshProviders = async () => {};
  const command = h.engine.command;
  h.engine.command = async (name, args) => {
    if (name === 'login') throw new Error('connection pane unavailable');
    return command(name, args);
  };
  const done = runInline(h);
  await h.send('/login pi\r');
  assert.match(h.shown, /connection pane unavailable/);
  await h.send('/help\r');
  assert.deepEqual(h.calls.at(-1), { name: 'help', args: [] });
  await h.send('/exit\r');
  await done;
});

test('a lone Esc closes the inline picker after the sequence window', async () => {
  const h = harness();
  const done = runInline(h);
  await h.send('/model\r');
  await h.send('\x1b');
  await new Promise((resolve) => setTimeout(resolve, 70));
  await h.send('hello\r');
  assert.deepEqual(h.calls.at(-1), { name: 'send', text: 'hello' });
  await h.send('/exit\r');
  await done;
});
