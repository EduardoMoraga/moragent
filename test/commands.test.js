import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, findCommand, matchCommands, welcomeLines, getVersion, LOGO } from '../src/engine/commands.js';
import { plain } from '../src/core/log.js';

test('COMMANDS registry includes all engine commands with valid schema', () => {
  assert.ok(Array.isArray(COMMANDS));
  assert.ok(COMMANDS.length >= 16);

  const expected = [
    'login',
    'orquestador',
    'modelo',
    'idioma',
    'recuperaciones',
    'equipo',
    'memoria',
    'plan',
    'tarea',
    'abrir',
    'agentes',
    'sesiones',
    'sesion',
    'limpiar',
    'nuevo',
    'cancel',
    'help',
    'salir',
    'mouse',
  ];

  const names = COMMANDS.map((c) => c.name);
  for (const exp of expected) {
    assert.ok(names.includes(exp), `Missing command: ${exp}`);
  }

  const tareaCmd = COMMANDS.find((c) => c.name === 'tarea');
  assert.ok(tareaCmd);
  assert.deepEqual(tareaCmd.aliases, ['desplegar', 'task', 'deploy']);
  assert.equal(tareaCmd.args, '<rol> <texto>');
  assert.equal(tareaCmd.es, 'desplegar un agente ahora');

  // Schema validation for every entry: { name, aliases, args, es, en, group }
  for (const cmd of COMMANDS) {
    assert.equal(typeof cmd.name, 'string');
    assert.ok(cmd.name.length > 0);
    assert.ok(Array.isArray(cmd.aliases), `Aliases for ${cmd.name} should be array`);
    assert.equal(typeof cmd.args, 'string');
    assert.equal(typeof cmd.es, 'string');
    assert.ok(cmd.es.length > 5, `ES description for ${cmd.name} too short`);
    assert.ok(!cmd.es.includes('\n'), `ES description for ${cmd.name} has newline`);
    assert.equal(typeof cmd.en, 'string');
    assert.ok(cmd.en.length > 5, `EN description for ${cmd.name} too short`);
    assert.ok(!cmd.en.includes('\n'), `EN description for ${cmd.name} has newline`);
    assert.equal(typeof cmd.group, 'string');
    assert.ok(cmd.group.length > 0);
  }

  // Check unique names
  const unique = new Set(names);
  assert.equal(unique.size, names.length);
});

test('findCommand resolves commands by name or alias, with or without leading slash', () => {
  const login = findCommand('login');
  assert.ok(login);
  assert.equal(login.name, 'login');

  const withSlash = findCommand('/login');
  assert.ok(withSlash);
  assert.equal(withSlash.name, 'login');

  const orq = findCommand('orchestrator');
  assert.ok(orq);
  assert.equal(orq.name, 'orquestador');

  const salir = findCommand('/exit');
  assert.ok(salir);
  assert.equal(salir.name, 'salir');

  const ayuda = findCommand('ayuda');
  assert.ok(ayuda);
  assert.equal(ayuda.name, 'help');

  const tarea = findCommand('tarea');
  assert.ok(tarea);
  assert.equal(tarea.name, 'tarea');

  const desplegar = findCommand('/desplegar');
  assert.ok(desplegar);
  assert.equal(desplegar.name, 'tarea');

  const task = findCommand('task');
  assert.ok(task);
  assert.equal(task.name, 'tarea');

  const deploy = findCommand('/deploy');
  assert.ok(deploy);
  assert.equal(deploy.name, 'tarea');

  assert.equal(findCommand('/language')?.name, 'idioma');
  assert.equal(findCommand('/recoveries')?.name, 'recuperaciones');

  const nonExistent = findCommand('desconocido');
  assert.equal(nonExistent, null);

  const empty = findCommand('');
  assert.equal(empty, null);
});

test('matchCommands finds commands by prefix for slash menu autocomplete', () => {
  const matchesOr = matchCommands('/or');
  assert.ok(matchesOr.some((c) => c.name === 'orquestador'));

  const matchesSes = matchCommands('ses');
  assert.ok(matchesSes.some((c) => c.name === 'sesiones'));
  assert.ok(matchesSes.some((c) => c.name === 'sesion'));

  const all = matchCommands('');
  assert.equal(all.length, COMMANDS.length);
});

test('getVersion reads version from package.json', () => {
  const v = getVersion();
  assert.equal(typeof v, 'string');
  assert.match(v, /^\d+\.\d+\.\d+/);
});

test('welcomeLines renders 2-line logo and header fitting 60 cols', () => {
  const state = {
    project: 'propinas',
    orchestrator: { provider: 'codex', model: 'gpt-5.6-sol' },
    providers: [
      { id: 'claude', ready: true },
      { id: 'codex', ready: true },
      { id: 'agy', ready: true },
      { id: 'pi', ready: true },
      { id: 'ollama', ready: true },
    ],
    lang: 'es',
    crew: { lead: {}, investigador: { cli: 'codex' } },
  };

  const lines = welcomeLines(state, { cols: 60 });
  assert.equal(lines.length, 5);

  for (const l of lines) {
    assert.ok(plain(l).length <= 60, `Line exceeds 60: "${plain(l)}"`);
  }

  // Line 1: Logo line 1
  assert.ok(plain(lines[0]).includes(LOGO[0]));
  // Line 2: Logo line 2 + version
  assert.ok(plain(lines[1]).includes(LOGO[1].trimEnd()));
  assert.ok(plain(lines[1]).includes(`v${getVersion()}`));
  // Line 3: project · orchestrator
  assert.ok(plain(lines[2]).includes('propinas · orquestador codex (gpt-5.6-sol)'));
  // Line 4: connected engines
  assert.ok(plain(lines[3]).includes('conectados: 5/5 · claude, codex, agy, +2 · /login'));
  // Line 5: tips
  assert.ok(plain(lines[4]).includes('pide algo o /tarea investigador … · / comandos'));
});

test('welcomeLines degrades logo to text under 40 columns', () => {
  const state = {
    project: 'moragent',
    orchestrator: { provider: 'codex' },
    providers: [{ id: 'codex', ready: true }],
    lang: 'es',
  };

  const lines = welcomeLines(state, { cols: 35 });
  assert.equal(lines.length, 4);

  for (const l of lines) {
    assert.ok(plain(l).length <= 35, `Line exceeds 35: "${plain(l)}"`);
  }

  // Degraded logo: single text line
  assert.ok(plain(lines[0]).includes('MORAGENT'));
  assert.ok(plain(lines[0]).includes(`v${getVersion()}`));
  assert.ok(!plain(lines[0]).includes('█▀▄▀█'));
});

test('welcomeLines handles English language correctly', () => {
  const state = {
    project: 'my-project',
    orchestrator: { provider: 'claude', activeModel: 'sonnet-4' },
    providers: [
      { id: 'claude', ready: true },
      { id: 'codex', ready: false },
    ],
    lang: 'en',
    crew: { lead: {}, researcher: { cli: 'pi' } },
  };

  const lines = welcomeLines(state, { cols: 80 });
  assert.ok(plain(lines[2]).includes('my-project · orchestrator claude (sonnet-4)'));
  assert.ok(plain(lines[3]).includes('connected: 1/2 · claude · /login'));
  assert.ok(plain(lines[4]).includes('ask or /task researcher … · / commands · Tab agents'));
});

test('welcomeLines never throws on empty or missing state and respects narrow widths', () => {
  for (const width of [10, 20, 40, 60, 120]) {
    assert.doesNotThrow(() => {
      const lines = welcomeLines({}, { cols: width });
      assert.ok(Array.isArray(lines));
      assert.ok(lines.every((l) => plain(l).length <= width), `Failed at width ${width}`);
    });

    assert.doesNotThrow(() => {
      const lines = welcomeLines(null, { cols: width });
      assert.ok(Array.isArray(lines));
      assert.ok(lines.every((l) => plain(l).length <= width), `Failed at width ${width}`);
    });
  }
});
