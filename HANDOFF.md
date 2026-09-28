# HANDOFF — MORAGENT (para Codex)

Fecha: 2026-09-27 · Versión publicada: 5.2.0 · Repo: github.com/EduardoMoraga/moragent (rama `master`)
Carpeta local: `/Users/eduardomoraga/Moragent/04-LAB/moragent-v4` (rama local `main` → push a `master`).
Commits SIEMPRE con `eduardo.moraga.o@gmail.com` (ya configurado en este repo). Nunca usar la cuenta EduMoraga26.

## Qué quiere Edu (la visión)
Una app de terminal propia: se escribe `moragent`, se entra a MORAGENT (no a Claude ni a Codex), se hace login con
lo que uno tenga (suscripciones o API keys), se conversa con un orquestador ejecutivo que despliega subagentes
**por dentro**, con memoria en capas y Obsidian. Debe sentirse como Claude Code / Codex CLI: terminal real, rápida,
obvia de usar, donde se ve el procesamiento.

## Estado (qué funciona, verificado en vivo en esta Mac)
- Motores de suscripción headless con sesión reanudable: claude, codex, agy (Antigravity), pi. API: anthropic,
  openai, openrouter, google, ollama (ollama probado con qwen3.5:9b).
- Motor del orquestador: plan → subagentes en paralelo → memoria episódica → revisión (Claude y Codex como orquestador).
- UI inline (scrollback nativo), menú `/`, selector de motor, `/tarea`, `/modelo`, `/sesiones`.
- 193 tests (`npm test`), CI 9/9, `npm run pack:smoke`.

## Problemas abiertos — reportados por Edu tras usarlo (prioridad en este orden)
1. **`/login` no hace nada visible.** En la UI inline, `/login` sólo refresca estados (`engine.command('login')`),
   no hay pantalla. Debe abrir un selector con TODOS los proveedores (✓ conectado / ○ no), y al elegir uno:
   suscripción → abrir su login real (`provider.loginCommand`, ya existe) ; API → pedir la key enmascarada
   (`engine.command('login', { id, key })` ya la guarda en ~/.moragent/credentials.json).
2. **No ve "todos los LLM".** El selector de `/modelo` muestra sólo los modelos sugeridos del motor actual
   (p. ej. claude: opus/sonnet/haiku/fable). Edu quiere UNA lista con todos los motores y modelos disponibles
   (agrupados por motor, con estado de conexión), elegir cualquiera como orquestador o para un rol.
   Catálogos: `provider.listModels()` en src/providers/cli/*.js y src/providers/api/*.js (agy lista real con
   `agy models`; ollama `/api/tags`; APIs `/v1/models`; claude/codex son sugerencias).
3. **No ve el procesamiento.** Mientras el orquestador piensa o un agente trabaja, la zona viva muestra poco.
   Debe verse como Claude Code: spinner, herramienta/comando actual, texto en streaming, tiempo. Datos disponibles:
   `state.orchestrator.status`, `state.agents[id].log` (texto, tools, resultados), `elapsedMs`.
4. **Idioma mezclado.** En un proyecto creado con lang `en` salen rótulos en inglés junto a respuestas en español
   ("system Orchestrator: claude · default model…", "default of the engine", "other… (type the model id)").
   Revisar `config.lang` / detección y usar `t()` en todos los textos del engine y de src/tui/inline.
5. "La terminal es horrible": ver src/tui/inline/render.js e index.js; compararla lado a lado con `codex` y `claude`.

## Mapa del código
- `bin/mora.js` → `src/cli.js` (sin args + TTY → `src/commands/chat.js` → `src/tui/inline/index.js#runInline`)
- `src/engine/index.js` — createEngine: store, send, command (todos los /comandos), runPlan, sesiones
- `src/engine/{plan,prompts,commands,sessions,store}.js` — plan parser, prompt del orquestador, registro de comandos + bienvenida, sesiones
- `src/providers/` — `index.js` (registro), `cli/*` (suscripciones), `api/*` (loop nativo con herramientas), `credentials.js`
- `src/tui/inline/*` — UI actual · `src/tui/markdown.js` · `src/tui/input.js` (editor de línea)
- `src/{bus,memory,brain,spec,mux,crew}` — tareas, memoria, Obsidian, specs, paneles externos, adaptadores
- Contratos: `docs/ENGINE.md` (v5) y `docs/ARCHITECTURE.md` (v4)

## Cómo probar
```sh
cd /Users/eduardomoraga/Moragent/04-LAB/moragent-v4
npm test
mkdir -p /tmp/prueba && cd /tmp/prueba && git init -q && node /Users/eduardomoraga/Moragent/04-LAB/moragent-v4/bin/mora.js
```
Publicar: `npm run pack:smoke`, commit, `git push origin main:master`, tag `vX.Y.Z`, `gh release create`.
Instalar para el usuario: `curl -fsSL https://raw.githubusercontent.com/EduardoMoraga/moragent/master/install.sh | sh`.
