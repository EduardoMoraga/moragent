# Changelog

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
