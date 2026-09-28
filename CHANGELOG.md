# Changelog

## [5.2.0] - 2026-09-27

MORAGENT now behaves like a terminal tool (Claude Code / Codex style), after real use feedback.

### Changed
- Inline terminal UI replaces the full-screen box: everything is printed to the normal terminal scrollback (native scroll, selection and copy; history stays after exit). A live region at the bottom shows running agents, the input box and a status line.
- Logo and a three-line welcome: project, orchestrator engine and model, connected engines, how to start.
- Language follows the macOS system language when the shell locale is English.

### Added
- Slash menu: typing `/` lists every command with a one-line description, filtered as you type; Enter runs the highlighted one.
- Pickers: `/orquestador` lists engines with their status, then that engine's models; `/modelo` and `/modelo <rol>` list the right engine's models (real catalogs where the CLI can list them, marked suggestions otherwise).
- `/tarea <rol> <texto>` (alias `/desplegar`) deploys one agent directly, with a role picker.

### Fixed
- Codex as orchestrator: session resume put `-s` after `resume`, which Codex rejects; exec options now precede the subcommand (verified live).
- Subagents answer in the project language; agent summaries are cut on line boundaries.

## [5.1.1] - 2026-09-27

### Added
- `/modelo` shows the model of the orchestrator and of each role; `/modelo <name>` changes the orchestrator's, `/modelo <role> <name>` a role's, `default` goes back to the engine's own. Saved in the project. Verified live: `haiku` on Claude and `gemini-3.8-flash-low` on Antigravity.

## [5.1.0] - 2026-09-27

A usable chat, after the first real use.

### Added
- Live agent cards in the chat: role, engine, task, elapsed time and last activity, updated in place.
- Process view (Tab or `/agentes`): each subagent's full activity — text, tool calls, commands, results — scrollable.
- Scrollback: mouse wheel, PgUp/PgDn, Shift+↑/↓, End; the view stays put while you read and shows how many new messages arrived.
- Markdown rendering (bold, lists, code blocks, headings, links, tables) sized to the terminal.
- Sessions: every conversation is saved; `/sesiones` lists them, `/sesion <n>` resumes one with the orchestrator's model context, `/limpiar` starts fresh.
- Sidebar toggle (Ctrl+B) at any width; a real status bar with each agent's state on narrow terminals.
- `/nuevo` creates a separate project in the current folder.

### Fixed
- Plans whose task prompts contain code fences or raw newlines are parsed correctly; a malformed plan gets one automatic repair round.
- The orchestrator knows it runs inside the app and points to in-app commands instead of shell commands.
- Project discovery stops at the enclosing git repository (a repo without `.moragent/` no longer joins a workspace project above it).
- Labels follow the project language; single prompt glyph.

## [5.0.0] - 2026-09-27

MORAGENT becomes a native terminal app. v4 drove other CLIs in visible panes; v5 runs them inside.

### Added
- `moragent` (or `mora` with no arguments in a terminal) opens a full-screen app: chat with an executive orchestrator, live crew panel, memory, spec and Obsidian status.
- Executive orchestrator: answers informational questions directly; for changes it sizes the work (S/M/L), emits a plan and runs subagents in parallel respecting dependencies, then reviews their results in the same session. It runs read-only; subagents implement.
- Subscription engines (no API key needed): Claude Code, Codex, Antigravity and Pi run headless with streaming JSON and resumable sessions — all four verified live. OpenCode and Gemini CLI supported best-effort.
- API providers with a native tool loop (read/write/edit/list/grep/bash confined to the project): Anthropic, OpenAI, OpenRouter, Google and local Ollama (verified live with qwen3.5:9b). Keys in `~/.moragent/credentials.json` (0600); environment variables win; `MORAGENT_<PROVIDER>_MODEL` overrides defaults.
- `/login` detects which engines are ready, stores API keys, and opens a subscription's own login in a pane.
- `/abrir <role|task>` takes a subagent out into a real pane (Orca, herdr, tmux), resuming its session when the engine supports it.
- An empty folder becomes a project from the first message; the project language follows that message.

### Changed
- Engine-run subagents are tagged `MORAGENT_ENGINE=1`: the engine closes their tasks (one episodic note per task) and session hooks skip them.

## 4.0.0

- Added `mora init` project scaffolding: `.moragent/`, managed `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`, bundled skills, project config and optional Claude memory hook.
- Added crew orchestration commands: `up`, `down`, `dispatch`, `resend`, `wait`, `done`, `block`, `task`, `board`, `crew` and `run`-style headless execution through real CLIs or multiplexers.
- Added adapter support for Claude Code, Codex, Antigravity (`agy`), Pi, OpenCode and Gemini with autonomy modes (`auto`, `ask`, `full`).
- Added multiplexer support for Orca, herdr, tmux and persistent headless sessions, including per-project `.moragent/runs/bin/mora` shim so agent panes call the same installed MORAGENT.
- Added disk task bus in `.moragent/tasks/` with markdown task envelopes and JSON task state.
- Added spec-driven development under `.moragent/specs/` with deterministic phases, EARS requirements, task parsing and `mora spec` commands.
- Added layered memory (`canonical`, `episodic`, `transient`), context packs, memory recall, promotion, garbage collection and session capture hooks.
- Added Obsidian brain linking/copying, generated Home map and brain sync/refresh.
- Added `doctor`, dashboard, plan sizing, config, sync, hooks dry-run and bilingual CLI output.
- Added bundled skills and plugin manifests for Claude Code and Codex, plus `prepack` generation of `plugin/skills`.
- Added POSIX and PowerShell installers, CI, package smoke test, VHS demo script and quickstart example.
