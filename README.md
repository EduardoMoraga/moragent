<div align="center">

```
█▀▄▀█ █▀█ █▀█ ▄▀█ █▀▀ █▀▀ █▄ █ ▀█▀
█ ▀ █ █▄█ █▀▄ █▀█ █▄█ ██▄ █ ▀█  █
```

**One terminal app. One executive orchestrator. Subagents from Claude, Codex, Antigravity, Pi or any API model — working inside it, with layered memory.**

[![version](https://img.shields.io/github/package-json/v/EduardoMoraga/moragent?color=8b5cf6&label=version)](https://github.com/EduardoMoraga/moragent)
[![license](https://img.shields.io/badge/license-MIT-8b5cf6)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A518-8b5cf6)](https://nodejs.org)
[![stars](https://img.shields.io/github/stars/EduardoMoraga/moragent?style=flat&color=8b5cf6)](https://github.com/EduardoMoraga/moragent/stargazers)

[Español](README.es.md) · [Website](https://eduardomoraga.github.io/moragent/) · [Engine Contract](docs/ENGINE.md) · [Architecture](docs/ARCHITECTURE.md)

</div>

## Install

To install or update this v5.3 beta on macOS/Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/EduardoMoraga/moragent/codex/poder-agentico/install.sh | MORAGENT_BRANCH=codex/poder-agentico sh
```

On Windows (PowerShell):

```powershell
$env:MORAGENT_BRANCH='codex/poder-agentico'; irm https://raw.githubusercontent.com/EduardoMoraga/moragent/codex/poder-agentico/install.ps1 | iex
```

<sub>The stable branch remains `master`. To install without the script: `npm i -g https://github.com/EduardoMoraga/moragent/archive/refs/heads/codex/poder-agentico.tar.gz`.</sub>

Then, inside any directory or repository:

```sh
moragent
```

Node ≥ 18, zero npm dependencies. If the folder has no `.moragent/` yet, a greeting such as `Hello` is answered without initialization or file writes. Sending a concrete request initializes the project inline in the terminal.

---

## How it works

```
$ moragent
MORAGENT v5.3 beta
 my-app · orchestrator claude
 connected: 2/12 · claude, codex · /login
◆ Project my-app. What are we doing? Ask, or use /task to deploy an agent.
› Research the topic and write a sourced report
◐ Orchestrator · thinking · 4s
● executor · codex  T-0001  8s  write_file report.md
› _
claude · 1 agent working · /help
```

1. **Launch `moragent`** in your project terminal. The app keeps the terminal's native scrollback and updates the active work in place.
2. **Type `/login`** to see every supported provider and its connection status. Selecting a connected subscription keeps you in MORAGENT and switches the orchestrator. If authentication is needed, it opens a separate connection pane when available; API keys use a masked prompt.
3. **Talk to the executive orchestrator** in plain language. It explores the project context, scopes the work, and derives a concrete plan.
4. **Subagents run inside the app**, with live activity below the conversation. Press Tab for recent logs. To open an agent in its own terminal pane, type `/open <role|id>` (e.g. `/open executor`).

---

## Log in with what you already have

MORAGENT has **no account and no servers**. It never acts as a proxy: every engine connects directly from your machine using your own vendor subscription or API key.

| Engine ID | Provider | Engine Type | Status & Verification |
|---|---|---|---|
| `claude` | Anthropic Claude Code | Subscription CLI | ✓ Verified live (Sep 27, 2026) |
| `codex` | OpenAI Codex CLI | Subscription CLI | ✓ Verified live (Sep 27, 2026) |
| `agy` | Google Antigravity CLI | Subscription CLI | ✓ Verified live (Sep 27, 2026) |
| `pi` | Mario Zechner's Pi | Subscription CLI | ✓ Verified live (Sep 27, 2026) |
| `opencode` | OpenCode AI | Subscription CLI | ✓ Live answer, tools and isolated working directory tested (Sep 28, 2026); readonly tool denial not yet live-verified |
| `gemini` | Google Gemini CLI | Subscription CLI | Best effort from `--help` (unverified) |
| `anthropic` | Anthropic (Claude API) | Native API loop | Messages API with tool use (`claude-sonnet-5`) |
| `openai` | OpenAI (GPT API) | Native API loop | Chat completions with tool calls (`gpt-4o`) |
| `openrouter` | OpenRouter | Native API loop | OpenAI-compatible endpoint (`anthropic/claude-sonnet-5`) |
| `google` | Google Gemini API | Native API loop | `generateContent` with function declarations (`gemini-2.0-flash`) |
| `ollama` | Ollama (Local) | Native API loop | ✓ Verified live with `qwen3.5:9b` writing and reading files |
| `compatible` | Any OpenAI-compatible endpoint | Native API loop | Configure a base URL and optional API key with `/login compatible` |

<sub>Default models can be changed per provider with `MORAGENT_<PROVIDER>_MODEL` (e.g. `MORAGENT_OPENAI_MODEL`). The OpenAI and Google defaults were not verified live.</sub>

OpenCode's model catalog may list IDs your account cannot use. On this machine its free-tier default returned HTTP 403 from MORAGENT, while one listed OpenAI ID returned HTTP 400; another connected Codex model worked. MORAGENT displays the provider's short error and HTTP code so you can choose a usable model with `/model`. In the picker, `·` means model access has not been tested; only the provider picker uses `✓` for a ready engine.

For Ollama, if you have not chosen a model, MORAGENT selects the first installed tool-capable model reported by `/api/tags`; it does not assume `llama3` is installed. An explicit `/model` choice or `MORAGENT_OLLAMA_MODEL` takes priority. If Ollama reports no tool-capable models, MORAGENT asks you to install or select one rather than sending a request with a phantom default. This path was verified live with `gemma4:latest`.

Subscription CLI output is decoded as UTF-8 across stream chunks. A single JSONL record is limited to 16 million characters to prevent an unbounded memory spike; increase `MORAGENT_CLI_MAX_LINE_CHARS` only if your CLI genuinely emits larger records.

API keys are stored locally in `~/.moragent/credentials.json` with strict POSIX permissions (`0600`), and standard environment variables take precedence (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`, `OLLAMA_HOST`). If `/login` saves a key while its environment variable is set, MORAGENT warns that the saved key is inactive; unset the variable and restart MORAGENT to use it.

Provider traces under `.moragent/runs/` may contain prompts, code and tool arguments. New logs are private (`0600` on POSIX); older logs are tightened when reopened. Previously created logs that are not reopened may need a manual permissions check. Windows ACL behavior has not been validated.

To connect another compatible server, choose `compatible` in `/login` and enter its base URL including `/v1` (for example `http://localhost:8000/v1`). Add a key if the server requires one, then choose its model with `/model`. You can also set `MORAGENT_COMPATIBLE_BASE_URL`, `MORAGENT_COMPATIBLE_API_KEY`, and `MORAGENT_COMPATIBLE_MODEL` in the environment. The URL and key environment variables override values saved through `/login`; the app warns when this happens.
Servers without `/models` can still be used: enter their chat model ID through `/model`. The picker omits recognizable embedding and other non-chat model IDs.

The native API loop provides file tools (`read_file`, `write_file`, `edit_file`, `list_dir`, `grep`) confined to the project root, with output limits (≤ 20 KB). `grep` runs away from the terminal thread, can be cancelled, times out after 30 seconds by default (`MORAGENT_GREP_TIMEOUT_MS`), and marks results partial after 1,000 matches. Its shell tool (`bash`) has no OS sandbox, so API agents can use it only with explicit `full` autonomy; shell commands have a 120-second timeout and `/cancel` stops the shell process tree. API requests time out after 10 minutes by default; set `MORAGENT_API_TIMEOUT_MS` for slower local models.

---

## In-App Commands

Type these slash commands inside `moragent`:

- `/help`: show available commands
- `/login`: connect subscriptions or configure API keys
- `/update` (or `mora update` inside the app): check the remote and update a Git checkout or a GitHub tarball installation created by `install.sh`/`install.ps1`; `--check` only checks. Restart the app after updating. Older packages without recorded source/branch metadata are left untouched; reinstall with `MORAGENT_BRANCH=...` to migrate previews.
- `/crew` (or `/equipo`): view the crew · `/crew <role> <engine>` to reassign roles. API choices affect native workers; the external pane keeps its CLI.
- `/orchestrator <engine>` (or `/orquestador <m>`): pick the orchestrator engine. If the preferred engine is unavailable, MORAGENT announces a temporary fallback and restores the preference when it reconnects.
- `/model` or `/model <role>` (or `/modelo`): browse models across all providers and pick one for the orchestrator or a role. `/model <name>` and `/model <role> <name>` set a model directly; `default` uses the selected provider's default.
- `/language <es|en>` (or `/idioma`): switch the interface and future answers to Spanish or English; saved per project. Start with `moragent --lang en` for a session-only override. Before creating a project, `MORAGENT_LANG=en` also selects English.
- `/recoveries [task-id]` (or `/recuperaciones`): list retained private copies. `/recoveries inspect <id>` shows captured file and directory changes and conflicts; `/recoveries apply <id>` explicitly applies those paths only if the source still matches the saved baseline. Copies that failed an exact acceptance check are marked manual-only and cannot be applied with this command. New copies remain applicable after moving the whole project; moving only a recovery folder is rejected. The copy and any private Git state remain available. Older copies without a manifest require manual recovery; older path-bound manifests must stay at their original path.
- `/memory [text]` (or `/memoria [texto]`): show memory summary or search notes
- `/plan <text>`: ask the orchestrator for an explicit plan
- `/open <role|id>` (or `/abrir <rol|id>`): take a subagent out into an external terminal pane
- `/cancel`: cancel running work, including a subscription CLI's process group
- `/exit` (or `/salir`): quit the app (or press Ctrl+C twice)

---

## Why MORAGENT

Running one AI coding agent in a single chat is straightforward. Running an entire crew that **shares work, preserves context, respects architectural decisions, and avoids stepping on each other** requires an orchestrator:

| Feature | MORAGENT v5 | [herdr](https://herdr.dev) | gentle-ai | hello-sdd | Plain tmux |
|---|:-:|:-:|:-:|:-:|:-:|
| Full native terminal harness (TUI) | ✓ | — | — | — | — |
| Single executive orchestrator | ✓ | — | — | — | — |
| Subagents run inside the app | ✓ | — | — | — | — |
| Optional pop-out panes on demand | ✓ (Orca · herdr · tmux) | ✓ | — | — | ✓ manual |
| Mix subscription CLIs & raw API models | ✓ | ✓ | ✓ | — | ✓ manual |
| Task bus between agents | ✓ `dispatch` / `done` / `wait` | ~ manual text | — | — | — |
| Layered memory | ✓ canonical · episodic · transient · skills | — | ~¹ | — | — |
| Spec-driven phases (SDD) | ✓ 8 phases derived from disk files | — | ✓ | ✓ | — |
| Obsidian second brain integration | ✓ `mora brain link` | — | — | — | — |
| One-line install, zero npm deps | ✓ | ✓ | ✓ | ✓ | — |

<sub>¹ gentle-ai ships persistent memory through Engram, a single store of observations with full-text search — durable, but not split into architectural layers.<br>Comparison based on public docs as of September 2026. MORAGENT does not replace herdr, Orca or tmux: it orchestrates agents natively and can drive multiplexers when you want external panes.</sub>

---

## The Engine Room: Memory, Specs & Second Brain

Everything from MORAGENT v4 remains the battle-tested foundation under the hood:

### Layered Memory

| Layer | Folder | What goes there | Lifetime |
|---|---|---|---|
| Canonical | `memory/canonical/` | architectural decisions, conventions | durable, git-tracked |
| Episodic | `memory/episodic/` | task results, session captures, findings | append-only, git-tracked |
| Transient | `memory/transient/` | scratchpads, handoffs | expires (`mora memory gc`) |
| Procedural | `skills/<name>/SKILL.md` | reusable how-tos | synced to every CLI (`mora sync`) |

`mora context <role> --query "…"` compiles a context pack for an agent: canonical decisions, recent episodes, and semantic recall matches, all within an exact character budget.

### Spec-Driven Phases (SDD)

`explore → propose → spec → design → tasks → apply → verify → archive`

Phases are **deterministically derived from files on disk** (EARS requirements in `spec.md`, `- [ ]` task items in `tasks.md`), so the software — not LLM hallucination — guarantees workflow progression.

### Obsidian Second Brain

`mora brain link` symlinks `.moragent/` into your Obsidian vault (or copies it with `--copy`). Notes use standard frontmatter and `[[wikilinks]]`. An auto-generated `Home.md` connects specs, tasks, and architectural decisions directly into your visual knowledge graph.

### Plugin for Claude Code and Codex

The repository ships plug-and-play skills for Claude Code and Codex:

```text
# Claude Code
/plugin marketplace add EduardoMoraga/moragent
/plugin install moragent@moragent
```

For Codex, `.codex-plugin/plugin.json` exposes the identical protocols from `plugin/skills/`.

---

## For Scripts and Other Agents: `mora` CLI

For CI/CD pipelines, headless automation, or external agents, the `mora` CLI continues to work:

You can register a directory or repository without changing it, and create roles for the actual work, such as research, writing, and review. In the terminal app, `Ctrl+J` adds a line to the draft and `Enter` sends it. Long drafts wrap to the terminal width.

```sh
cd my-app
mora project add .                              # register this directory, with or without Git
mora project list                               # list registered projects
mora project open <id>                          # show the path and a command to open it
mora project open <id> --chat                   # open MORAGENT in that project
mora remote add user@host /absolute/path        # register an SSH destination
mora remote probe <id>                           # check the connection and directory
mora remote open <id>                            # open MORAGENT on that host over SSH
mora remote open <id> --persist                  # attach or create a persistent remote tmux session
mora init --goal "Research a topic and produce a report" # adaptable crew by default
mora crew add researcher codex --mission "Research sources" --capabilities research,sources
mora doctor                                       # verify system health & installed engines
mora plan "Checkout flow and admin dashboard"     # size work and generate initial spec
mora spec status                                  # check spec phases
mora dispatch backend "Orders API" --spec <slug>  # dispatch a task to the bus
mora dispatch reviewer "Check the sources" --parent T-0001 # dispatch a child task
mora wait T-0001                                  # wait until task is completed
mora board                                        # terminal kanban board
mora memory add "Use UUIDv7" --tier canonical     # add an architectural decision
mora brain link                                   # link with Obsidian vault
```

Every read command accepts `--json`.

To serve **a registered project** through Telegram, set `MORAGENT_TELEGRAM_BOT_TOKEN` and `MORAGENT_TELEGRAM_ALLOWED_IDS` (comma separated numeric user IDs), then run `mora telegram listen --project <id>`. One bot serves one selected project at a time. The bridge accepts only private chats from those identities and retries temporary network failures. Test the channel with your own bot and account before relying on it. `mora remote open --persist` requires `tmux` and MORAGENT installed on the host; reopening attaches to the same tmux session. Live SSH validation and automatic network reconnection remain to be done.

---

## Autonomy and Safety

Every role and engine run operates under an explicit autonomy contract:

| Mode | What the agent may do without asking |
|---|---|
| `readonly` | Native API tools allow reading and search, and refuse writes and shell commands. Subscription CLIs use vendor policies; OpenCode receives explicit deny rules, not an OS sandbox. |
| `auto` **(default)** | Edit project files. Native API agents cannot run shell commands in this mode. Subscription CLI policies vary by vendor; a private MORAGENT workspace is not an OS sandbox. |
| `full` | Requests the broadest available vendor autonomy; exact permissions vary by CLI. Use only in throwaway disposable containers. |
| `ask` | Native API agents can read but cannot write or run commands until an interactive approval flow is available. |

---

## Tested with

> **Platforms.** Verified live on macOS (Apple Silicon). Linux and Windows run the full test suite in CI across Node 18, 20, and 22. Windows is **experimental**: the test suite passes there, but neither the terminal app nor external panes have been tried on a real Windows machine yet.

Verified live on September 27, 2026:
- **Codex 0.154**: headless streaming execution with `-s workspace-write -a never` (no prompts).
- **Claude Code 2.1.283**: headless streaming execution with `--permission-mode auto` and allowed tools.
- **Antigravity 1.2.x**: streaming execution with sandboxed permission bypass.
- **Pi 0.85**: streaming JSON execution and session recovery.
- **Ollama (local)**: tested live with `qwen3.5:9b`, executing multi-step tool calls (`write_file` + `read_file`) via the native loop.

---

## FAQ — Coming from a chat window

**Do I need tmux or Orca?**  
No. MORAGENT v5 runs inline inside any terminal (Terminal.app, iTerm2, Alacritty, Ghostty, Windows Terminal, etc.). Orca, herdr, or tmux are only used if you choose to pop an agent out into a separate terminal pane using `/open`.

**Is it one AI or several?**  
It is one executive orchestrator coordinating subagents by mission. The initial crew uses `executor`, `researcher`, and `reviewer`; you can add other roles with `mora crew add`. The older software presets remain available. Each role can use Claude, Pi, Codex, or another connected engine.

**Can parallel agents overwrite each other?**
Native-engine agents work in private project copies. MORAGENT integrates changed files and directories only if their originals have not changed; a conflict blocks the task and preserves its copy under `.moragent/runs/recovery/`. Empty directories and directory permission changes are included. Private Git commits, branches, tags, stashes, detached `HEAD`, local `.git/config` changes, or staged changes also keep the copy for recovery instead of silently losing Git state. Path recovery never transfers that Git state or deletes the saved copy. This prevents accidental merge overwrites, but it is not an OS security sandbox for unrestricted CLIs.

For exact text-file requirements, a plan can include structured `file_text` checks (lines plus an explicit final-newline flag). When the request explicitly calls for exact content or a final LF, MORAGENT requires such a check before dispatch; if it names one unambiguous file, the check must cover that path. For multiple files or lines, you can put an explicit contract in your request:

```moragent-checks
{"files":[{"path":"a.txt","lines":["first","second"],"finalNewline":true},{"path":"b.txt","lines":["last"],"finalNewline":false}]}
```

MORAGENT requires the plan to cover every listed file and independently compares each check with your block before workers start. Every task that changes a listed file must match your bytes before its private copy can publish, even if the plan placed that file's check on a later task. A mismatch blocks the task and preserves its copy for manual inspection, even if an agent claims success. Without an explicit block, MORAGENT anchors only unambiguous one-line literal requests; it does not infer arbitrary expected bytes from prose. Other acceptance criteria still require review.

Checks cannot target paths MORAGENT does not publish: `.git`, `node_modules`, or its internal `.moragent/{runs,tasks,sessions,memory}` directories.

Native API workers can write exact text with `write_file({path, lines, final_newline})`, which constructs LF bytes without relying on the model to escape `\n` inside a content string. The original `content` form remains available.

Internal symlinks are rebased into each worker copy. A symlink that points outside the project, including one under `node_modules`, stops worker preparation with a clear error: MORAGENT cannot claim an isolated copy while that link still reaches external files. This does not prevent a CLI from choosing an external absolute path on its own.

`node_modules` is copied for worker context but never published to the real project. Ordinary dependency changes are detected from filesystem metadata; they block integration and retain the worker copy. `/recoveries inspect` lists a sample, and applying other paths leaves dependency changes in that copy. This is not a byte-for-byte audit of every dependency file.

**Does it send my code to MORAGENT servers?**  
No. MORAGENT has no servers and does not collect telemetry. Your agent CLIs talk directly to their respective providers, and local Ollama runs completely offline.

**What does it cost?**  
MORAGENT is 100% free and open source (MIT). You only pay your existing vendor subscriptions or API usage.

**Can I run everything with just one tool?**  
Yes. You can run both the orchestrator and all subagents using a single engine (e.g. Claude Code only, Codex only, or 100% locally with Ollama).
When an API is the only ready provider on first run, MORAGENT saves it as the project orchestrator. `mora doctor` checks that API separately; missing CLIs warn about unavailable external panes rather than failing the native API workflow.

**Can I undo it?**  
Everything lives cleanly in `.moragent/` plus managed comment blocks in `AGENTS.md` / `CLAUDE.md`. Remove those and your repo is restored to its exact previous state.

---

## Contributing

Contributions are welcome — please read [CONTRIBUTING.md](CONTRIBUTING.md) and the contracts in [docs/ENGINE.md](docs/ENGINE.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Run `npm test` before submitting changes.

## License

[MIT](LICENSE) © Eduardo Moraga
