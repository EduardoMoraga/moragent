# MORAGENT v5 — native harness contract

> v4 drove other CLIs in visible panes. v5 is a **native terminal app**: you type `moragent`, you
> land inside MORAGENT, you `/login`, you talk to one executive orchestrator, and it runs
> subagents **inside** the app (streamed into a side panel). Panes become optional (`/abrir`).
> Everything from v4 (bus, envelopes, memory, specs, brain, sync) is the engine room — reuse it.

## 1. User experience (the acceptance test)

```
$ moragent
┌─ MORAGENT · my-app ─────────────────────────────┬─ Equipo ───────────────┐
│ ◆ Hola. Conectado: Claude (suscripción), Codex  │ ◆ Orquestador  listo   │
│   ¿Qué construimos?                             │                        │
│ tú › API de tareas con tests                    ├─ Memoria ──────────────┤
│ ◆ Plan (M · 2 subagentes) …                     │ canónica 3 · episod. 9 │
│ ◆ backend (codex) terminó T-0001 ✓              │ spec: tareas → apply   │
├─────────────────────────────────────────────────┴────────────────────────┤
│ › _                              /login /plan /equipo /memoria /abrir /help│
└──────────────────────────────────────────────────────────────────────────┘
```

- `mora` or `moragent` (TTY, no args) → interactive chat harness. Without a TTY, no-arg launch fails instead of showing the dashboard. `mora help` lists commands; `mora <cmd>` keeps working for scripts/agents.
- First run in a folder without `.moragent/` → the TUI runs init inline (asks goal, creates project).
- `/login` → provider screen: detected subscriptions (logged in or not + how to log in) and API
  keys (add/remove). No MORAGENT account, no server.

## 2. Normalized events — every provider emits exactly these via `onEvent(e)`

```js
{ type: 'start',  sessionId, provider, model }          // once, as soon as known
{ type: 'text',   delta }                               // assistant text (streamed or whole)
{ type: 'tool',   id, name, input }                     // a tool call began (summary-friendly)
{ type: 'tool_result', id, ok, summary }                // ≤ 200 chars
{ type: 'usage',  input, output, costUsd }              // any field may be null
{ type: 'done',   ok, text, sessionId, error }          // exactly once, last
```

## 3. Providers — `src/providers/`

```js
// src/providers/index.js
PROVIDERS: { claude, codex, agy, pi, gemini, opencode,        // kind 'subscription' (CLI engines)
             anthropic, openai, openrouter, ollama, google }  // kind 'api' (native loop)
getProvider(id) -> provider              // throws MoragentError('UNKNOWN_PROVIDER')
listProviders() -> provider[]

provider = {
  id, label, kind: 'subscription' | 'api',
  async status() -> { ready: bool, detail: string, loginHint: string },   // fast (< 3 s), never throws
  // autonomy: 'readonly' (orchestrator: may read the repo, never writes/executes changes) | 'auto' | 'full' | 'ask'
  async run({ root, prompt, system, sessionId, autonomy = 'auto', model, signal, onEvent, logFile })
      -> { ok, text, sessionId, usage }                                    // never throws on agent failure: ok:false + error
}
```

### 3a. Subscription engines (owner: backend/Codex) — `src/providers/cli/*.js`
Run the vendor CLI headless with streaming JSON, **stdin closed** (`'ignore'` — Codex otherwise
waits on stdin), cwd = root, env `MORAGENT_ROLE`, kill on `signal` abort. Real fixtures:
`test/fixtures/streams/{claude,codex,agy,pi}.jsonl` (captured 2026-09-27 on this machine).

| id | command | resume |
|---|---|---|
| claude | `claude -p <prompt> --output-format stream-json --verbose` + autonomy flags from `src/crew/adapters.js` (`--permission-mode auto --allowedTools …`) + `--append-system-prompt <system>` | `--resume <session_id>` |
| codex | `codex exec --json -s workspace-write --skip-git-repo-check <prompt>` (system prepended to prompt) | `codex exec resume <thread_id> …` (verify with `codex exec resume --help`) |
| agy | `agy -p <prompt> --output-format stream-json --sandbox --dangerously-skip-permissions` | `--conversation <id>` |
| pi | `pi -p --mode json <prompt>` (`--append-system-prompt`) | `--session <id>` |
| gemini / opencode | best effort from `--help`; mark unverified in code comments | |

Event mapping (see fixtures): claude `assistant.message.content[]` text/tool_use, `user` tool_result,
`result` → done; codex `thread.started` → start, `item.completed` agent_message/command_execution/
file_change → text/tool/tool_result, `turn.completed` usage → done; agy `step_update.text_delta` →
text, `result.response` → done; pi `message_update`/`message_end` assistant → text, tool events →
tool, `agent_end` → done. `status()`: binary on PATH + logged in (claude: `claude auth status` or
equivalent — verify; codex: `codex login status`; agy/pi: best available check, else "installed").

### 3b. API providers + native tool loop (owner: helper/Antigravity) — `src/providers/api/*.js`
- `anthropic` (Messages API, tool use), `openai` + `openrouter` + `ollama` (OpenAI-compatible
  chat completions with tools; ollama base `http://localhost:11434/v1`), `google` (Gemini API).
- Native tools (`src/providers/api/tools.js`), all confined to `root`: `read_file`, `write_file`,
  `edit_file` (exact replace), `list_dir`, `grep`, `bash` (cwd root, timeout 120 s; autonomy `ask` → refuse).
  Under autonomy `readonly` (orchestrator), only `read_file`, `list_dir`, `grep` are active;
  `write_file`, `edit_file`, and `bash` are refused with a clear message.
- Loop: send → tool calls → execute → send results → until final text or 40 steps. Emits §2 events.
- `fetch` injectable for tests (`setFetch`). No SDKs, Node ≥ 18 `fetch`.
- Credentials `src/providers/credentials.js`: `~/.moragent/credentials.json` (mode 0600;
  `MORAGENT_HOME` overrides dir for tests): `getKey(id)`, `setKey(id, value)`, `removeKey(id)`,
  `listKeys() -> [{id, source: 'env'|'file', masked}]`. Env wins: `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`, `OLLAMA_HOST`.

## 4. Engine — `src/engine/` (owner: lead)

```js
createEngine({ root, config }) -> engine
engine.store            // EventEmitter; engine.store.state (read-only snapshot), emits 'change'
engine.send(text)       // user message to the orchestrator
engine.command(name, args)   // slash commands: login, plan, equipo, memoria, abrir, spec, help, salir …
engine.stop()
```

`store.state`:
```js
{
  project, goal, lang,
  orchestrator: { provider, status: 'idle'|'thinking'|'running'|'reviewing' },
  messages: [{ id, from: 'user'|'orchestrator'|'agent'|'system', agent?, text, at, streaming? }],
  agents: { [agentId]: { id, role, provider, status: 'queued'|'running'|'done'|'failed'|'blocked',
                         taskId, title, lastLine, sessionId, startedAt, endedAt } },
  memory: { canonical, episodic, transient, skills },
  spec: { slug, phase } | null,
  brain: { linked, vault },
  providers: [{ id, label, kind, ready, detail, loginHint }],
  notice: string | null,
}
```

## 5. TUI — `src/tui/` (owner: dev/Pi)

`runTui({ engine, input = process.stdin, output = process.stdout }) -> Promise<void>` (resolves on exit).
- Alternate screen, raw mode, full redraw on `store 'change'` (throttle ~30 fps) and on resize.
- Layout ≥ 100 cols: chat left, sidebar right (Equipo tree with status glyphs + provider, Memoria,
  Spec, Obsidian). < 100 cols: sidebar collapses to a one-line status bar.
- Chat: wraps text, streaming messages update in place, scroll with PgUp/PgDn; agent lines
  prefixed with role + provider.
- Input: line editor (←/→, Home/End, ⌫, ⌥/Ctrl word jump if easy), ↑/↓ history, Tab completes
  slash commands, Enter sends (`engine.send` or `engine.command` for `/…`), Ctrl+C: first
  cancels running work (`engine.command('cancel')`), second exits. Esc closes overlays.
- `/login` overlay: list `state.providers` (✓ ready / ○ not ready + loginHint); selecting an api
  provider asks for the key (masked) → `engine.command('login', { id, key })`.
- Pure render function `render(state, { cols, rows, input, scroll }) -> string[]` (lines) so it is
  testable without a TTY. Colors via `src/core/log.js#c`; respects `NO_COLOR`.
- Bilingual via `t()`; Spanish neutral (no voseo).

## 6. v5.1 — chat usable (added after Edu's first real use)

### 6a. Agent activity log (engine → TUI)
`state.agents[id].log`: array (last 400) of `{ at, kind: 'text'|'tool'|'result'|'error', text }` built from §2 events
(consecutive text deltas are merged per line). `state.agents[id].elapsedMs` updated while running.

### 6b. Sessions — `src/engine/sessions.js` (owner: backend/Codex)
Stored in `.moragent/sessions/<id>.json` (git-ignored, atomic writes, messages capped at 500).
```js
createSession(root, { title = '', provider = null }) -> session
  // session = { id, title, createdAt, updatedAt, provider, providerSessionId, messages: [], agents: {} }
saveSession(root, session) -> session          // bumps updatedAt; derives title from first user message (≤ 60 chars)
loadSession(root, id) -> session | null         // id or unique prefix
listSessions(root) -> [{ id, title, updatedAt, messages, provider }]   // newest first
latestSession(root) -> session | null
deleteSession(root, id) -> bool
```
Engine commands (lead): `/sesiones` (list), `/sesion <n|id>` (resume: restores messages, agents and the
orchestrator's provider session so the model keeps its context), `/limpiar` (new empty session).
The engine saves after every message. On start it resumes nothing automatically; the welcome says
how many previous sessions exist and how to resume.

### 6c. Markdown — `src/tui/markdown.js` (owner: helper/Antigravity)
`renderMarkdown(text, width, { c }) -> string[]` — pure. Bold, italic, inline code, headings, bullet and
numbered lists with hanging indent, block quotes, fenced code blocks (dim, no wrap past width: hard-wrap),
links as `text (url)`, tables degrade to aligned rows. Every returned line has `plain(line).length <= width`.
Never throws on malformed markdown (unclosed ** or ```).

## 7. v5.2 — a real terminal (Edu: "no es terminal", "interfaz horrible", "no puedo cambiar el orquestador")

The full-screen boxed app is replaced by an **inline** terminal UI, like Claude Code / Codex / Pi:

```
$ moragent
 █▀▄▀█ █▀█ █▀█ ▄▀█ █▀▀ █▀▀ █▄ █ ▀█▀
 █ ▀ █ █▄█ █▀▄ █▀█ █▄█ ██▄ █ ▀█  █   v5.2
 propinas · orquestador codex (gpt-5.6-sol)
 conectados: claude ✓ codex ✓ agy ✓ pi ✓ ollama ✓
 escribe lo que necesitas · / comandos · Tab agentes

> crea un conversor de temperaturas          ← printed to normal scrollback
◆ Plan M · 2 subagentes …                    ← printed when final
✓ backend · codex  T-0001  38s  5/5 tests    ← printed when the agent ends
                                             ── live region (redrawn in place) ──
  ● frontend · claude  T-0002  12s  escribiendo README
╭──────────────────────────────────────╮
│ > /orq_                              │
│   /orquestador  elegir motor         │    ← slash menu while typing "/"
╰──────────────────────────────────────╯
  codex · gpt-5.6-sol · 1 agente trabajando · /help
```

Rules:
- **No alternate screen, no full-screen box, no mouse capture.** Finished content is written once to stdout and
  lives in the terminal's own scrollback (native scroll, selection, copy; it stays after exit).
- A **live region** at the bottom is redrawn in place (cursor up + clear, no flicker, throttle ~20 fps):
  streaming orchestrator text (last ~8 lines while streaming; the full text is printed when it ends), one line per
  running agent (role · engine · id · elapsed · last activity), a full-width wrapped draft box, menus/pickers, and a
  status line. The whole live region is budgeted to stay shorter than the terminal; long drafts use the remaining
  rows as a viewport around the editing cursor. The draft is rendered again after status updates and resize.
- Printing rule: when something becomes final (user message, orchestrator answer, system message, agent end)
  the live region is erased, the final block is printed (markdown-rendered), then the live region is redrawn.
- **Slash menu**: typing `/` shows matching commands with a one-line description (↑/↓ select, Tab/Enter
  complete, Esc close). Source: `COMMANDS` registry (§7c).
- **Pickers**: `/orquestador` with no args → list of engines (ready first, ✓/○) → then its model list; `/modelo`
  with no args → model list of the orchestrator's engine; `/modelo <rol>` → that role's engine models. ↑/↓, Enter,
  Esc; a free-text row "otro…" lets the user type any model id.
- **Tab** toggles the agents detail in the live region (last 6 log lines per running agent). `/agentes <rol|id>`
  prints that agent's full log to the scrollback.
- **Composer**: Enter explicitly sends; Ctrl+J, Alt+Enter (or Shift+Enter where the terminal reports it) inserts a
  newline. Multi-line bracketed paste stays in the editable draft and never sends; pasted tabs are kept verbatim and
  only expanded for display. The visible hint lists send, newline, clear, and `/help`. Ctrl+C clears a nonempty
  draft; a standalone Esc (no key within ~40 ms) clears it when no picker is open, while other Meta/Alt chords never
  clear the draft. With an empty draft, Ctrl+C cancels running work (a second press within 2 s
  exits) or exits when idle.
  Resize redraws the live region without changing the draft. Terminal scrollback keeps finalized messages.
- A future richer composer can add vertical cursor navigation and selection; this inline viewport deliberately keeps
  native scrollback and follows the current insertion cursor instead of replacing the terminal screen.

### 7a. TUI inline — `src/tui/inline/*` (owner: dev/Pi)
`runInline({ engine, input = process.stdin, output = process.stdout }) -> Promise<void>`.
Pure helpers for tests: `renderLive(state, ui, { cols }) -> string[]`, `renderFinal(message, { cols, lang }) -> string[]`.
The engine's store is the same (§4, §6a). The TUI keeps its own `printedIds` set so each message prints once
(messages may be updated while streaming; print only when `streaming` is false).

### 7b. Model catalogs — `provider.listModels() -> Promise<[{ id, label, note? }]>` (owner: backend/Codex)
Fast (≤ 3 s), never throws, cached per process. claude: aliases (`opus`, `sonnet`, `haiku`, `fable`) + verify
anything better from `claude --help`; codex: from its CLI if it can list, else the model in `~/.codex/config.toml`
+ known ids from `codex --help`; agy: parse `agy models`; pi: its model listing command if any (`pi --help`);
opencode/gemini: best effort; api: `GET /v1/models` (anthropic, openai, openrouter), Gemini models list, Ollama
`/api/tags`. Mark unverified sources in code comments.

### 7c. Command registry & welcome — `src/engine/commands.js` (owner: helper/Antigravity)
`COMMANDS: [{ name, aliases: [], args: '<rol> <modelo>', es, en, group }]` — every slash command the engine
supports (read `engine.command` in src/engine/index.js), one-line descriptions ES/EN. `welcomeLines(state, { cols })`
→ logo (≤ 60 cols, 2 lines, brand color) + version + project · orchestrator (engine + model) + connected engines
(✓/○) + one line of tips; fits 60 cols (logo degrades to text under 40).
