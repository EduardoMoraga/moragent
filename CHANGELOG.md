# Changelog

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
