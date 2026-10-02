import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../src/core/config.js';
import { orchestratorSystem, isGreetingGoal } from '../src/engine/prompts.js';

const providers = [{ id: 'claude', ready: true }, { id: 'codex', ready: true }];
const config = (lang, goal) => ({ ...defaultConfig({ project: 'demo', lang, preset: 'duo', clis: { lead: 'claude', backend: 'codex' } }), goal });
const UNSET = { es: '(sin definir: pregúntalo si hace falta)', en: '(not set: ask if needed)' };

test('greeting-only goals are recognised after accent, case, space and punctuation normalisation', () => {
  for (const goal of ['Hola', 'hola', ' Hola! ', '¡Hola!', 'Hello', 'hello.', 'Hi', 'Buenos días', 'good morning!']) {
    assert.equal(isGreetingGoal(goal), true, goal);
  }
  for (const goal of ['Hola, crea una API', 'Hello world app', 'Build a REST API', '', null, undefined, 42]) {
    assert.equal(isGreetingGoal(goal), false, String(goal));
  }
});

test('a greeting goal is presented as unset in ES and EN without mutating the config', () => {
  for (const lang of ['es', 'en']) {
    for (const goal of ['Hola', 'Hello', '¡Hola!']) {
      const cfg = config(lang, goal);
      const before = JSON.stringify(cfg);
      const prompt = orchestratorSystem({ config: cfg, providers });
      const line = prompt.split('\n')[1];
      assert.ok(line.endsWith(UNSET[lang]), `${lang}/${goal}: ${line}`);
      assert.doesNotMatch(line, /hola|hello/i);
      assert.equal(JSON.stringify(cfg), before, `${lang}/${goal}: config must stay untouched`);
    }
  }
});

test('a real goal, including one that starts with a greeting, still reaches the prompt', () => {
  for (const lang of ['es', 'en']) {
    for (const goal of ['Hola, crea una API de pagos', 'Build a CLI for invoices']) {
      assert.equal(orchestratorSystem({ config: config(lang, goal), providers }).split('\n')[1].endsWith(goal), true);
    }
  }
});

test('open-ended repo questions require evidence, specific opportunities and one recommended first step', () => {
  const cases = {
    es: [/qué puede hacer o mejorar/, /evidencia disponible/, /cita en qué te basas/, /2-3 oportunidades específicas de este repo/,
      /beneficio concreto y cómo se verificaría/, /UNA primera acción concreta/, /no cierres con "elige una" sin recomendación/, /Evita listas genéricas/],
    en: [/what they could do or improve/, /available evidence/, /cite what you based it on/, /2-3 opportunities specific to this repo/,
      /concrete benefit and how it would be verified/, /ONE concrete first step/, /do not close with "pick one" without a recommendation/, /Avoid generic lists/],
  };
  for (const [lang, patterns] of Object.entries(cases)) {
    const prompt = orchestratorSystem({ config: config(lang, 'Build a CLI'), providers });
    for (const pattern of patterns) assert.match(prompt, pattern, `${lang}: ${pattern}`);
  }
});

test('exploratory questions grant no mutation authority and forbid claiming unexecuted work', () => {
  const cases = {
    es: [/sigue siendo informativa: no crees un plan ni despaches subagentes y no cambies archivos/, /nunca afirmes que ejecutaste, probaste o cambiaste algo que sólo sugieres/,
      /ofrece ejecutarla si la persona lo pide/, /responde directo y breve\. No crees un plan\./, /Si hay que cambiar archivos, crea un plan\./, /sólo puedes leer el repositorio/],
    en: [/still informational: do not make a plan, dispatch subagents or change files/, /never claim you ran, tested or changed something you are only suggesting/,
      /offer to carry it out if they ask/, /answer directly and briefly\. No plan\./, /If files must change, make a plan\./, /you can only read the repository/],
  };
  for (const [lang, patterns] of Object.entries(cases)) {
    const prompt = orchestratorSystem({ config: config(lang, 'Hola'), providers });
    for (const pattern of patterns) assert.match(prompt, pattern, `${lang}: ${pattern}`);
  }
});

test('orchestrator routes self-update to the native command without inventing remote status', () => {
  for (const lang of ['es', 'en']) {
    const prompt = orchestratorSystem({ config: config(lang, 'Build a CLI'), providers });
    assert.match(prompt, /\/update --check/);
    assert.match(prompt, lang === 'es' ? /No crees una tarea de subagente/ : /Do not plan a subagent task/);
    assert.match(prompt, lang === 'es' ? /sin consultar el remoto/ : /without checking the remote/);
  }
});
