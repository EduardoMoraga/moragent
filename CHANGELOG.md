# Changelog

## Unreleased

### Added
- `/login` now opens an in-app provider picker. Subscription login runs in the same terminal; API keys use masked input.
- `/modelo` searches a combined catalog across all providers and can assign a provider and model to the orchestrator or a role.
- `compatible` connects an OpenAI-compatible server using a base URL and optional API key, configured through `/login` or environment variables.
- Live activity shows orchestrator phase, tool and elapsed time, alongside running agent logs.
- `/idioma <es|en>` (`/language`) switches the app language immediately and persists it in the project, preserving customized role missions.
- `/recuperaciones` (`/recoveries`) lists conflict-preserved worker copies from inside the terminal without applying or deleting them.
- Native-engine workers now use private project snapshots. Git projects keep their history in a separate clone and include dirty/untracked files; conflicting edits or private commits preserve the worker copy instead of overwriting the project.
- The live terminal view now summarizes the crew (active, completed, blocked and failed), with each active worker's provider, task, elapsed time and activity; Tab includes recent completed-worker logs and the roster compacts on narrow terminals.
- Optional API and foreground CLI logs are private and bounded to 5 MiB by default, with configurable limits and an omission marker. API event records remain valid JSONL when older history is rotated out.

### Fixed
- The `/model` picker no longer marks every catalog-listed model with a readiness checkmark; it distinguishes unverified model access from disconnected engines in English and Spanish.
- OpenCode provider failures now show the HTTP code and vendor message instead of dumping nested API error JSON and response headers. A catalog-listed model may still be unavailable to the connected account.
- The inline `/` menu now shows English command aliases in English sessions and Spanish names in Spanish sessions, while accepting either language after a live language switch. The task role picker also continues with `/task` in English.
- OpenCode text parts from distinct assistant messages now render as separate paragraphs, while parts of one message remain contiguous. Live English and Spanish orchestrator-worker runs passed exact file checks; review prompts now identify MORAGENT's byte checks as independent evidence rather than a worker claim.
- Pi's headless adapter now rejects assistant error/truncation stop reasons even when the CLI exits zero, and displays the actual model error instead of a preceding stderr warning. Live English and Spanish orchestrator-worker runs passed exact file checks; a failed worker model published no file.
- Native `read_file` now streams selected lines from large files without blocking the terminal, respects cancellation without a late stream error, and keeps its 20 KiB output limit on UTF-8 boundaries. `edit_file` rejects files over 16 MiB before loading them; `list_dir` no longer follows symlinks to reveal external file sizes.
- `mora done` and `mora block` publish terminal task status only after their memory notes are written, so `mora wait` cannot report completion before those notes exist.
- Input redraws are batched; long slash menus stay within an eight-row window and combined escape/text input is decoded correctly.
- Switching providers clears a model ID from the previous provider. API model catalogs refresh after credentials change.
- Codex task summaries use the final assistant message, with separate progress messages in the activity log.
- English project prompts and terminal labels no longer contain the identified Spanish fragments.
- Native API agents expose the unsandboxed shell only under explicit `full` autonomy; `ask` now refuses writes until approval is implemented.
- Invalid multiagent plans (duplicate IDs, unknown roles, broken or cyclic dependencies, empty work, or more than eight tasks) receive one repair attempt instead of silently dropping tasks or dependencies.
- Cancelling now stops queued plan tasks and prevents partial plans from dispatching. User messages run sequentially, so overlapping turns cannot corrupt the orchestrator session.
- Successful worker summaries now point to files in the real project, not deleted private workspace paths.
- Workspace integration checks source fingerprints only for paths the worker changed, rather than rehashing the entire real project.
- OpenAI-compatible endpoints without `/models` remain selectable with a manually entered chat model ID; the catalog omits recognizable non-chat models. Native `write_file` results explicitly report whether the file ends in an LF newline.
- API `bash` no longer blocks the event loop; `/cancel` terminates its shell process tree and does not issue another model request. Stalled API requests now time out (10 minutes by default, configurable) and can be cancelled while waiting for headers or a response body.
- Subscription CLI cancellation now terminates the child process group on POSIX (Windows uses `taskkill /T /F`). Streaming CLI launches share the Windows `.cmd`/`.bat` shim plan already used by synchronous commands.
- Streaming CLI output now preserves UTF-8 characters split across chunks. Oversized JSONL records fail explicitly instead of growing memory without bound; stderr diagnostics are bounded in memory.
- A failed optional CLI log write no longer crashes the provider stream.
- Worker integration preserves private Git refs and staged-index changes, not just commits that move `HEAD`, so branches, tags, stashes and staged work are not silently discarded.
- `/recuperaciones inspeccionar|aplicar <id>` now previews and explicitly applies conflict-preserved file changes when their source baseline still matches, without deleting the saved copy or transferring private Git metadata. Ambiguous task IDs, legacy copies, tampered manifests and concurrent engine turns are refused.
- Package smoke now uses a portable Node runner, builds its tarball only in a temporary directory, and runs on Windows as well as Ubuntu/macOS in the 3×3 CI matrix. The old shell script that deleted root-level `moragent-*.tgz` files was removed.
- Empty API responses no longer count as successful turns for OpenAI-compatible, Anthropic or Google adapters. OpenAI-compatible text parts are rendered as plain text, and malformed tool-call arguments fail before a tool can run.
- API error bodies and Google block reasons are surfaced when a provider returns no answer. File tools reject dangling symlinks instead of treating them as new files, closing an outside-project write path; names beginning with `..` that remain inside the project are accepted.
- A failed orchestrator response can no longer dispatch a complete-looking partial plan. Workers need an explicit successful provider result before their private files are integrated or dependent tasks run; CLIs exiting zero without a final answer now fail visibly.
- Orchestrator decisions use the provider's completed answer rather than earlier streamed progress, so a superseded draft plan cannot deploy agents and a final-only plan is not missed.
- Verified subscription CLI adapters now require their own terminal result marker. Codex additionally requires a final assistant message, so reasoning-only or truncated streams no longer count as completed answers. Claude, Codex, Antigravity and Pi passed short live adapter runs after this change.
- Local `compatible` and Ollama readiness checks now have an effective timeout even if a fetch implementation ignores abort, preventing provider discovery from hanging indefinitely.
- CLI auth/model probes are asynchronous and bounded, so slow commands no longer freeze the terminal. Model catalog probes allow up to eight seconds, reveal providers progressively in `/modelo`, and retry after transient failures instead of caching suggestions forever. A timed-out auth probe cannot report ready from partial output.
- Conflict-preserved Git clones now copy their shared object dependencies before retention and verify the result without alternates. Their commits and staged content remain readable after the original project moves; inspection warns when an older or incomplete copy still depends on the original object store.
- Version-2 recovery manifests use a project identity so `/recoveries inspect/apply` still works after moving the whole project. An isolated recovery directory copied elsewhere remains inapplicable, and existing version-1 manifests keep their original-path behavior.
- Worker integration now retains the private Git copy when its `HEAD` representation or repository config changes, even if the commit, refs and staged diff are unchanged. A fault-injection test also guards rollback of content and executable permissions after a partial multi-file publish failure.
- The OpenCode adapter now pins both `PWD` and `--dir` to its private project. A live run previously wrote to the parent repository despite `cwd`; subsequent live `pwd` and file-tool runs stayed inside the temporary workspace. OpenCode requires a final stop marker and maps nested tool input/results accurately. Readonly/ask runs pass a deny policy for edits, shell and external directories; its resolved config was checked locally, but a live denial test could not complete because the provider returned HTTP 403.
- Workspace snapshots and recovery manifests now include directories and their permission modes. Empty-directory creation/removal no longer disappears after a successful worker turn, and recovery can apply those changes; a fault-injection test covers rollback after a directory operation fails.
- Worker preparation now rebases internal symlinks into the private copy and rejects links that resolve outside the project, including under `node_modules`. A live-code reproduction showed an absolute internal link previously let a worker modify the real project before integration; the corrected test keeps that edit private until integration.
- Ordinary `node_modules` edits/additions now block integration instead of vanishing with a deleted worker copy. Metadata-based detection avoids reading dependency contents; recovery manifests and bilingual terminal messages disclose excluded paths, and explicitly applying other paths leaves dependency changes in the retained copy.

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
