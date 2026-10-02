# MORAGENT v5 — native harness contract

> v4 drove other CLIs in visible panes. v5 is a **native terminal app**: you type `moragent`, you
> land inside MORAGENT, you `/login`, you talk to one executive orchestrator, and it runs
> subagents **inside** the app (streamed into its live region). Panes become optional (`/abrir`).
> Everything from v4 (bus, envelopes, memory, specs, brain, sync) is the engine room — reuse it.

## 1. User experience (the acceptance test)

```
$ moragent
 MORAGENT v5.2.0
 my-app · orchestrator claude
 connected: 2/12 · claude, codex · /login
◆ Project my-app. What are we doing?
› Build a task API
◐ Orchestrator · thinking · 4s
● backend · codex  T-0001  8s  write_file src/tasks.js
› _
claude · 1 agent working · /help
```

- `moragent` (TTY, no args) → inline terminal app with native scrollback. `mora <cmd>` keeps working for scripts/agents.
- First run in a folder without `.moragent/` → the TUI runs init inline (asks goal, creates project).
- `/login` → provider picker, connected subscriptions switch the orchestrator without leaving the app;
  authentication uses a separate connection pane when available. API keys are masked, and OpenAI-compatible
  endpoints are configurable. No MORAGENT account or server.
- `/idioma <es|en>` (`/language`) changes the interface language without restarting. An initialized
  project persists the choice; for a new project, an explicit choice overrides first-message guessing.
- The inline `/` menu displays command names in the active language (`/tarea` or `/task`, etc.)
  while accepting both aliases. A live PTY checked the language switch, help, menu and clean exit.

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
PROVIDERS: { claude, codex, agy, pi, gemini, opencode,                    // kind 'subscription'
             anthropic, openai, openrouter, ollama, google, compatible } // kind 'api'
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
waits on stdin), cwd and `PWD` = root, env `MORAGENT_ROLE`. OpenCode additionally receives
`--dir root`; without it, a live run wrote in the parent repository despite the child cwd.
On `signal` abort, terminate the process group
on POSIX or the process tree with `taskkill /T /F` on Windows. Windows `.cmd`/`.bat` shims use
the shared shell-quoting plan in `src/core/exec.js`. Decode stdout/stderr incrementally as UTF-8;
a JSONL line over 16 million characters fails the run explicitly (override with
`MORAGENT_CLI_MAX_LINE_CHARS` or `maxLineChars`). Keep in-memory stderr diagnostics to 64 KiB.
An unwritable optional raw log does not crash the provider stream. API event logs, CLI raw logs,
and detached-process logs use private `0600` files on POSIX, tighten existing log permissions
when reopened, and reject a final-path symlink. These logs may still contain prompts, code,
tool arguments and provider output; file permissions do not redact their contents. Windows ACL
behavior needs separate validation. API and foreground CLI traces are capped at 5 MiB by default
(override with `maxLogBytes`); API JSONL preserves complete recent events and marks omitted history.
Detached-process output is not yet byte-capped.
Real fixtures:
`test/fixtures/streams/{claude,codex,agy,pi}.jsonl` (captured 2026-09-27 on this machine).

| id | command | resume |
|---|---|---|
| claude | `claude -p <prompt> --output-format stream-json --verbose` + autonomy flags from `src/crew/adapters.js` (`--permission-mode auto --allowedTools …`) + `--append-system-prompt <system>` | `--resume <session_id>` |
| codex | `codex exec --json -s workspace-write --skip-git-repo-check <prompt>` (system prepended to prompt) | `codex exec --json -s workspace-write --skip-git-repo-check resume <thread_id> <prompt>` |
| agy | `agy -p <prompt> --output-format stream-json --sandbox --dangerously-skip-permissions` | `--conversation <id>` |
| pi | `pi -p --mode json <prompt>` (`--append-system-prompt`) | `--session <id>` |
| opencode | `opencode run --format json --dir <root> <prompt>`; live ES/EN orchestrator-worker and project directory tested | `--session <id>` |
| gemini | best effort from `--help`; unverified in a live run | |

OpenCode `readonly` and headless `ask` runs pass a deny policy via `OPENCODE_PERMISSION`
(edits, shell and external directories denied). A live readonly prompt asking it to create a
file ended with the model saying writing was unavailable and no file was created; it did not
attempt a write tool call, so actual denial on a call remains unverified. Its `auto` mode is not
an OS sandbox.
On a later probe, OpenCode 1.18.30 returned HTTP 403 for its free-tier default and HTTP 400 for
one catalog-listed OpenAI model that this ChatGPT account cannot use; another configured Codex
model answered in readonly without attempting an edit. The adapter now reports the vendor message
and HTTP code without dumping response headers. Catalog presence is not proof of entitlement.
See [OpenCode permissions](https://opencode.ai/docs/permissions/) for the vendor policy model.

Event mapping (see fixtures): claude `assistant.message.content[]` text/tool_use, `user` tool_result,
`result` → done; codex `thread.started` → start, `item.completed` agent_message/command_execution/
file_change → text/tool/tool_result, `turn.completed` usage → done; agy `step_update.text_delta` →
text, `result.response` → done; pi `message_update`/`message_end` assistant → text, tool events →
tool, `agent_end` → done. `status()`: binary on PATH + logged in (claude: `claude auth status` or
equivalent — verify; codex: `codex login status`; agy/pi: best available check, else "installed").
OpenCode text parts carry `messageID`; MORAGENT inserts a paragraph break between different
assistant messages while preserving adjacent parts of the same message. Its live English and
Spanish plans each created one exact-LF file with a verified `file_text` check. The review prompt
identifies these checks as MORAGENT's pre-publication byte evidence, distinct from the worker's
claims; a repeated Spanish run reviewed the exact bytes without treating a plain text read as
the only evidence for the final LF.
Pi can emit `agent_end` and exit zero even when the final assistant has `stopReason: error`.
The adapter accepts only a completed final assistant turn (`stop` or absent reason), surfaces
`errorMessage` ahead of stderr warnings, and rejects truncated or missing final turns. Live local
Pi runs passed as orchestrator and worker in English and Spanish with byte-exact `file_text` checks;
an unsupported worker model failed without publishing its file.

### 3b. API providers + native tool loop (owner: helper/Antigravity) — `src/providers/api/*.js`
- `anthropic` (Messages API, tool use), `openai` + `openrouter` + `ollama` + `compatible` (OpenAI-compatible
  chat completions with tools; ollama base `http://localhost:11434/v1`), `google` (Gemini API).
- With no explicit model, Ollama uses the first installed tool-capable model from its own `/api/tags`
  endpoint (including when a custom base URL is supplied). An explicit model or environment override
  takes precedence. An empty usable catalog fails clearly instead of falling back to an uninstalled name.
- `compatible` accepts a reachable endpoint without `/models` (HTTP 404/405/501) when a chat model ID
  is supplied manually. Common non-chat model IDs are hidden from API catalogs. Real local tool-loop
  checks passed against Ollama and LM Studio; this does not prove every compatible server behaves alike.
- Native file tools (`src/providers/api/tools.js`) confined to `root`: `read_file`, `write_file`,
  `edit_file` (exact replace), `list_dir`, `grep`. `bash` starts with cwd `root` but has no OS sandbox;
  it is exposed only under explicit `full` autonomy and has a 120 s timeout. It runs asynchronously;
  abort terminates the shell process tree (POSIX process group, Windows `taskkill /T /F`).
  Its stdout and stderr use separate incremental UTF-8 decoders so characters split between chunks
  remain intact.
  Under `readonly` or `ask`, only `read_file`, `list_dir`, `grep` are active. Under `auto`, file
  writes are enabled but `bash` is refused.
  `write_file` accepts either an explicit `content` string (including `""` for an empty file) or
  `lines: string[]` plus a required `final_newline: boolean`. The latter constructs LF bytes without
  JSON escape ambiguity. Mixed or malformed forms fail before touching the file; Gemini's array
  schema includes `items: STRING`.
  `edit_file` requires a nonempty string to find and an explicit string replacement; omitting either
  cannot silently overwrite or delete existing content. Its replacement is literal: dollar-prefixed
  sequences such as `$&` and `$$` are not interpreted as JavaScript replacement tokens.
  `read_file` streams selected lines asynchronously, bounds output to 20 KiB, and observes
  cancellation even when scanning a large file for a distant offset. `edit_file` still needs a
  full-file replacement and rejects files over 16 MiB before reading them. `list_dir` labels symlinks as `[LINK]` without following them to
  reveal an external target's size. These are process-safety and metadata-confinement guards,
  not an OS sandbox.
  Direct file reads, writes, edits and searches reject non-regular targets such as named pipes, which
  could otherwise block the terminal indefinitely. The type check is not an OS sandbox and does not
  remove races if another process replaces a path between checking and opening it.
  `grep` streams files in a dedicated worker, stops globally after 1,000 matches with an explicit
  partial-result notice, and is terminated on `/cancel` or after 30 seconds by default
  (`MORAGENT_GREP_TIMEOUT_MS`). The worker receives the selected session language so path errors
  do not revert to the process locale. Pathological JavaScript regexes or very long lines may still consume
  worker CPU/memory until termination; this is isolation of the terminal event loop, not an OS sandbox.
- Loop: send → tool calls → execute → send results → until final text or 40 steps. Emits §2 events.
- A successful HTTP status does not imply a complete assistant turn. OpenAI-compatible and Anthropic
  adapters accept their known completion/tool-use reasons and reject any other explicit finish/stop
  reason (including token limits, filters and refusals) before executing tools from that response.
  Gemini likewise rejects non-`STOP` finish reasons. Usage is still counted. Missing finish metadata
  remains tolerated for compatible endpoints that omit it. Gemini function responses echo a call ID
  when the server supplies one; ID-less calls retain the older ID-less form.
- Text emitted beside a tool call is provisional progress. The last assistant response without tool
  calls is the authoritative `done.text` and provider `result.text`; an earlier draft plan must not
  be concatenated into it or dispatched after the model changes its mind.
- If an API orchestrator gets a tool-protocol HTTP 5xx before emitting text or using any tool, it
  retries that turn once without tools. All API adapters omit tool declarations for this mode, and
  an unexpected tool call is rejected before execution. The terminal warns that the retry cannot
  inspect the repository; the model must block or delegate inspection rather than claim it read
  files. Generic server errors, partial output, used tools and worker turns do not trigger this
  retry. A tool-free response still must pass the normal plan and exact-file checks.
- An API-only plan repair uses a shorter bilingual system contract, the latest user request and
  recent result context, and no tools. This reduces context pressure and avoids tool-protocol
  failures during JSON correction; it does not relax plan validation or change worker tools.
  A model can still exhaust its output/context budget or omit a required check, in which case no
  task is dispatched.
- Under editable API autonomy, an unsuccessful `write_file` or `edit_file` must be followed by a
  successful file tool call on the same path before the run can return `ok: true`. A model's final
  prose cannot convert an unrecovered file-tool error into a completed worker task. Read-tool
  failures and expected readonly denials remain available to the model as tool results.
- Each API request (including response-body parsing) has a 10-minute default timeout, configurable
  with `MORAGENT_API_TIMEOUT_MS` or `requestTimeoutMs` in the provider run options. Parent cancellation
  interrupts a pending request and prevents another request after a cancelled tool.
- `fetch` injectable for tests (`setFetch`). No SDKs, Node ≥ 18 `fetch`.
- Credentials `src/providers/credentials.js`: `~/.moragent/credentials.json` (mode 0600;
  `MORAGENT_HOME` overrides dir for tests): `getKey(id)`, `setKey(id, value)`, `removeKey(id)`,
  `listKeys() -> [{id, source: 'env'|'file', masked}]`. Env wins: `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`, `OLLAMA_HOST`,
  `MORAGENT_COMPATIBLE_API_KEY`; `MORAGENT_COMPATIBLE_BASE_URL` overrides the saved compatible
  endpoint. Writes use a private temporary file and atomic replacement; an unreadable or invalid
  existing file is preserved. `/login` warns when a newly saved key or URL remains inactive due to
  an env override.

## 4. Engine — `src/engine/` (owner: lead)

```js
createEngine({ root, config }) -> engine
engine.store            // EventEmitter; engine.store.state (read-only snapshot), emits 'change'
engine.send(text)       // user message to the orchestrator
engine.command(name, args)   // slash commands: login, plan, equipo, memoria, abrir, spec, help, salir …
engine.stop()
```

`config.orchestrator` may name a subscription CLI, a native API provider, or an
OpenAI-compatible endpoint. `config.crew[*].cli` is separate: those IDs belong to
the external CLI crew used by commands such as `mora up` and validated by
`mora doctor`. A role selected through the native app may additionally have a
`provider` override; the engine uses that provider when ready, then falls back
to the role's CLI. Selecting an API orchestrator or worker must not replace a
`crew[*].cli` with an API ID.
When an API is the only ready engine before project creation, it is persisted as
`config.orchestrator`. `mora doctor` checks that API's readiness independently;
missing crew CLIs are warnings for external panes while the API is ready, but an
unavailable configured API remains a failure.

`send` calls are serialized per engine instance. A plan may contain at most eight tasks, with unique
IDs, configured non-lead crew roles, nonempty prompts, and existing acyclic dependencies. The engine
asks the orchestrator once to repair an invalid plan before dispatching anything. `/cancel` aborts
active providers, fails queued tasks without starting them, and discards messages queued before the
cancel request.
Plan text fields must actually be strings and dependency IDs must be strings; object/array values
are rejected with a repair request instead of being coerced into `[object Object]` worker instructions.
An explicit `provider` on a plan task must name a currently ready provider; an unavailable or
unknown explicit ID is a plan error to repair, not a silent reroute to another service. Tasks
without an explicit provider still use the role's native override/CLI and normal ready fallback.

Each native-engine worker runs in a private snapshot (`src/engine/workspace.js`). Git projects use a
separate local clone (including dirty and untracked files); non-Git projects use a private directory
copy. Success requires both `ok: true` and a nonempty final answer; streamed progress cannot replace
an explicitly empty final answer. Otherwise the task fails and its private copy is retained.
The engine prepares and integrates snapshots in a worker thread (`workspace-async.js`), so large copies
do not block terminal input. Preparations may overlap, but integrations for one source project are
serialized to preserve conflict checks. A project-local publication lock also coordinates separate
MORAGENT processes and explicit recovery application. Native-engine tasks wait without blocking the
terminal's event loop. The interactive `/recuperaciones aplicar` command also uses a worker thread,
so the terminal remains responsive while it waits or publishes; `/cancel` and Ctrl-C stop it and
retain the saved copy. Direct library calls to `applyRecovery()` remain synchronous. Cancellation
while an engine task waits preserves its worker copy. Locks owned by a dead process are reclaimed, but an
incomplete or unidentifiable lock times out after 30 seconds and needs manual inspection rather than
being stolen from a possibly live process. Cancellation is checked before and during publication; a
mid-publication cancellation rolls back applied paths and retains the private copy.
If a recovery-application worker exits unexpectedly during publication, inspect the source for
partial changes before retrying; its saved recovery copy remains available.
The parent reserves each temporary workspace directory before starting its thread. If the thread
exits during preparation, before any provider can edit the copy, the parent removes that incomplete
directory instead of leaving an unlisted temporary copy behind.
During preparation, the live agent row reports copying and snapshot phases. Cancellation is also
checked while traversing the copy and fingerprinting files, so unused preparation stops early; a
single blocking Git clone or large file-copy operation may still have to finish before it can stop.
Unexpected errors before a provider starts discard its unused copy; errors after a provider could
have edited the copy preserve it for inspection and include the recovery path in the task error.
An unexpected workspace worker-thread exit after preparation moves its private copy into
`.moragent/runs/recovery/` and reports the path in the task error. This crash recovery has no
manifest and is manual-only; inspect the source project before retrying because an exit during
publication may have left some source paths modified.
On success, changed files and directories (including empty directories and directory modes)
are integrated only if their originals still match the snapshot.
The task record's `files` field contains the paths actually integrated (an empty list for
read-only or unsuccessful tasks). The orchestrator's review receives these paths alongside
each task's `doneWhen` criterion and the worker's report. Published paths are evidence of
integration, not proof that the acceptance criterion passed; the reviewer can read files.
Plans may also include optional exact text checks on a task, for example
`"checks":[{"type":"file_text","path":"hello.txt","lines":["hello"],"finalNewline":true}]`.
`lines` holds text lines without newline characters; `finalNewline` explicitly controls the final LF.
Check paths must be publishable project files: `.git`, `node_modules` and the excluded
`.moragent/{runs,tasks,sessions,memory}` trees are rejected during request/plan validation.
Before integration, MORAGENT compares the private file's UTF-8 bytes with the constructed expected
bytes. A mismatch blocks publication, retains the private copy, and reports expected/actual byte
length, final-LF state, and a short escaped tail. Passing paths are recorded as `verifiedChecks` in
the task and review evidence. If a checked path was not changed by this task, MORAGENT also checks
the current source under the project publication lock; a stale private snapshot cannot certify it.
This verifies only exact structured checks; it does not
turn arbitrary natural-language `doneWhen` criteria into machine proofs or replace human review.
When the user explicitly requests exact file content, `file_text`, or a final LF, the engine rejects
a plan with no matching check and grants one plan-repair turn before dispatch. If the request names
exactly one recognizable file path, the check must target it. For unambiguous one-line EN/ES literal
requests with an explicit final-LF requirement, the engine independently derives the requested line
and newline state and rejects a disagreeing plan before any worker starts. For multiple files or
lines, the user can supply one fenced `moragent-checks` JSON block with a `files` array of
`{path,lines,finalNewline}` objects. The engine validates the block before provider discovery or
project creation, then requires every listed path and exact byte expectation in the plan before
dispatch. Missing or altered checks get one bounded plan-repair turn. This avoids relying solely on
the model to transcribe those bytes. Every private task copy also carries the user-authored checks:
if it changes a covered path, that path must match the user bytes before that task can publish,
even when the model assigned its plan check to a later task. A failed publication retains a
manual-only recovery; a passing publication records the guarded path as independently verified.
For a worker with its own exact checks, other user-checked paths belong to sibling tasks: API
`write_file`/`edit_file` reject attempts to edit them, and integration rejects any such changed
path regardless of provider (including CLI workers). The whole private copy is retained for manual
inspection, with no partial publication. A task with no checks can still be an upstream writer for
a later checker; all user-authored bytes remain guarded at publication. Worker memory is marked as
background and the assigned task appears after it to reduce scope confusion in smaller models.
After review, MORAGENT rechecks the user's explicit contract against the real project and shows an
`INCOMPLETE` system notice if anything is still missing or wrong, even if model prose claims success.
When it passes, a separate `VERIFIED` system receipt lists the checked paths and final-LF state;
this deterministic receipt is authoritative even when the model's suggested command output is not.
Arbitrary multi-line prose is not inferred; outside literal
one-line requests or explicit blocks, expected bytes still come from the plan and require review
against the person's request. The review prompt distinguishes plan-declared byte checks from
user-level proof.
Conflicts or private Git HEAD (commit or branch/detached state), refs (branches/tags/stashes),
local `.git/config` changes, or staged-index changes block integration and preserve the worker directory under
`.moragent/runs/recovery/`; its path is shown in the task result and listed by `/recuperaciones`
(`/recoveries`). New recoveries include a manifest of changed file paths and baseline fingerprints,
plus a project identity stored beside the recovery directories. Moving the whole project retains
that identity and allows inspection/application at the new path; copying an individual recovery
directory to another project does not. Older version-1 manifests remain path-bound.
`/recuperaciones inspeccionar <id>` previews those changes; `/recuperaciones aplicar <id>` explicitly
publishes files through the same conflict-checking module only when the source still matches the
baseline. It refuses while engine turns are active and keeps the recovery copy and private Git state.
If a worker fails an exact `file_text` acceptance check, its recovery manifest records that failure:
inspection remains available, but automatic application is refused even if the source has no conflicts.
The user must inspect and correct that saved work manually.
Legacy copies without a manifest remain manual-only. A dependent task snapshots after
its prerequisites have integrated. This is edit isolation, **not an OS security sandbox**: a CLI with unrestricted filesystem access can
still write outside its working directory. `node_modules` and internal `.moragent` run/task/session/
memory state are copied for worker context but never integrated. Workspace copying can still take time
on very large projects even though the terminal remains responsive; Windows/Linux terminal behavior
and provider permissions need live validation.
Internal symlinks are rebased to the private copy, including links under `node_modules`.
An external symlink fails worker preparation rather than leaving a write-through path to the
original filesystem. This is still not a sandbox against a CLI choosing an external path itself.
For `node_modules`, snapshots record metadata (type, mode, size, inode, nanosecond mtime/ctime)
without hashing dependency bytes. Ordinary changes block integration and retain the copy;
the recovery manifest records the count and up to 50 excluded paths. `/recoveries apply` may
publish other changed paths explicitly, but leaves dependencies in the retained copy.

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

## 5. Original full-screen TUI design (superseded by §7)

`runTui({ engine, input = process.stdin, output = process.stdout }) -> Promise<void>` (resolves on exit).
- Alternate screen, raw mode, full redraw on `store 'change'` (throttle ~30 fps) and on resize.
- Layout ≥ 100 cols: chat left, sidebar right (Equipo tree with status glyphs + provider, Memoria,
  Spec, Obsidian). < 100 cols: sidebar collapses to a one-line status bar.
- Chat: wraps text, streaming messages update in place, scroll with PgUp/PgDn; agent lines
  prefixed with role + provider.
- Input: line editor (←/→, Home/End, ⌫, ⌥/Ctrl word jump if easy), ↑/↓ history, Tab completes
  slash commands, Enter sends (`engine.send` or `engine.command` for `/…`), Ctrl+C: first
  cancels running work, including the orchestrator's tool-use (`reading`) phase
  (`engine.command('cancel')`), second exits. Esc or Ctrl+C dismisses overlays first.
- Text supplied by providers, tools, model catalogs, project metadata and input is stripped of
  terminal control sequences before rendering in the active inline UI. MORAGENT applies its own
  styles afterward; the stored conversation is not rewritten for display safety.
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
createSession(root, { title = '', provider = null, model = null }) -> session
  // session = { id, title, createdAt, updatedAt, provider, model, providerSessionId, messages: [], agents: {} }
saveSession(root, session) -> session          // bumps updatedAt; derives title from first user message (≤ 60 chars)
loadSession(root, id) -> session | null         // id or unique prefix
listSessions(root) -> [{ id, title, updatedAt, messages, provider }]   // newest first
latestSession(root) -> session | null
deleteSession(root, id) -> bool
```
Engine commands (lead): `/sesiones` (list), `/sesion <n|id>` (resume: restores messages, agents,
provider, selected model and the provider's session ID), `/limpiar` (new empty session).
Older session files without `model` remain readable and resume with the provider default.
A provider session ID is adopted only after a completed nonempty answer. A failed, thrown,
cancelled, or empty turn discards the resumable ID, and the TUI tells the user that the next
attempt starts a new provider session.
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
  running agent (role · engine · id · elapsed · last activity), the input box, menus/pickers, and a status line.
- Printing rule: when something becomes final (user message, orchestrator answer, system message, agent end)
  the live region is erased, the final block is printed (markdown-rendered), then the live region is redrawn.
- **Slash menu**: typing `/` shows matching commands with a one-line description (↑/↓ select, Tab/Enter
  complete, Esc close). Source: `COMMANDS` registry (§7c).
- **Pickers**: `/orquestador` with no args → list of engines (ready first, ✓/○); `/modelo`
  with no args → models across all engines; `/modelo <rol>` → the same catalog for a role. Type to search by
  engine or model, ↑/↓ and Enter to select, Esc to close; "other model ID" accepts an arbitrary ID.
- **Provider fallback**: an unavailable preferred orchestrator may use a ready temporary engine. The TUI
  prints the substitution and does not pass the preferred model to it. A refreshed, ready preferred engine
  and its model are restored after the active turn ends; explicitly selecting another engine replaces the
  preference. Engine/model/role-provider changes during active work are rejected with a wait/cancel hint.
- **Login**: `/login` lists all engines. Selecting a ready CLI engine switches the orchestrator inside MORAGENT.
  An unready CLI opens its authentication command in a separate pane when available; the app remains interactive.
  After authentication, select the engine again. API keys use a masked input. `compatible` asks for an HTTP(S)
  base URL and optional key.
- **Paste**: in a TTY, bracketed paste mode keeps a multiline paste as one literal draft (including newlines);
  the next deliberate Enter submits it once. `/task <role> …` and `/plan …` preserve line breaks in their instruction
  bodies, including pasted CRLF normalized to LF. The mode is disabled on exit.
- **Responsiveness**: normal messages and explicit `/task` or `/plan` work do not wait in the terminal input loop;
  later keys and `/cancel` remain usable even when they arrive in the same input chunk as a slow request. A
  cancellation during `/task` or worker preparation must prevent a later worker dispatch or file publication.
- **Tab** toggles the crew detail in the live region (last 6 log lines per recent agent, including completed workers). `/agentes <rol|id>`
  prints that agent's full log to the scrollback.
- Ctrl+C: first cancels running work, second (within 2 s) exits. Resize: redraw live region only.

### 7a. TUI inline — `src/tui/inline/*` (owner: dev/Pi)
`runInline({ engine, input = process.stdin, output = process.stdout }) -> Promise<void>`.
Pure helpers for tests: `renderLive(state, ui, { cols }) -> string[]`, `renderFinal(message, { cols, lang }) -> string[]`.
The engine's store is the same (§4, §6a). The TUI keeps its own `printedIds` set so each message prints once
(messages may be updated while streaming; print only when `streaming` is false).

### 7b. Model catalogs — `provider.listModels() -> Promise<[{ id, label, note? }]>` (owner: backend/Codex)
Fast (≤ 3 s), never throws, cached per process. claude: aliases (`opus`, `sonnet`, `haiku`, `fable`) + verify
anything better from `claude --help`; codex: from its CLI if it can list, else the model in `~/.codex/config.toml`
+ known ids from `codex --help`; agy: parse `agy models`; pi: its model listing command if any (`pi --help`);
opencode/gemini: best effort; API: model endpoints for Anthropic, OpenAI, OpenRouter, Google, the configured
compatible server, and Ollama `/api/tags`. Mark unverified sources in code comments.

### 7c. Command registry & welcome — `src/engine/commands.js` (owner: helper/Antigravity)
`COMMANDS: [{ name, aliases: [], args: '<rol> <modelo>', es, en, group }]` — every slash command the engine
supports (read `engine.command` in src/engine/index.js), one-line descriptions ES/EN. `welcomeLines(state, { cols })`
→ logo (≤ 60 cols, 2 lines, brand color) + version + project · orchestrator (engine + model) + connected engines
(✓/○) + one line of tips; fits 60 cols (logo degrades to text under 40).
