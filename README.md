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

```sh
curl -fsSL https://raw.githubusercontent.com/EduardoMoraga/moragent/master/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/EduardoMoraga/moragent/master/install.ps1 | iex
```

<sub>Prefer npm? `npm i -g https://github.com/EduardoMoraga/moragent/archive/refs/heads/master.tar.gz` · try without installing: `npx github:EduardoMoraga/moragent`</sub>

Then, inside any repo:

```sh
moragent
```

Node ≥ 18, zero npm dependencies. If the folder has no `.moragent/` yet, the app runs project initialization inline right inside the terminal.

---

## How it works

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

1. **Launch `moragent`** in your project terminal. You land directly inside a full-screen, native harness.
2. **Type `/login`** to see detected subscription CLIs (already logged in or hints to log in) and manage API keys or local Ollama.
3. **Talk to the executive orchestrator** in plain language. It explores your repo, scopes features, and derives a concrete plan.
4. **Subagents run inside the app**, streamed directly into the session. You track progress in real time in the sidebar. If you want to interact directly with any agent in its own terminal pane, type `/open <role|id>` (e.g. `/open backend`) to pop it out into Orca, herdr, or tmux.

---

## Log in with what you already have

MORAGENT has **no account and no servers**. It never acts as a proxy: every engine connects directly from your machine using your own vendor subscription or API key.

| Engine ID | Provider | Engine Type | Status & Verification |
|---|---|---|---|
| `claude` | Anthropic Claude Code | Subscription CLI | ✓ Verified live (Sep 27, 2026) |
| `codex` | OpenAI Codex CLI | Subscription CLI | ✓ Verified live (Sep 27, 2026) |
| `agy` | Google Antigravity CLI | Subscription CLI | ✓ Verified live (Sep 27, 2026) |
| `pi` | Mario Zechner's Pi | Subscription CLI | ✓ Verified live (Sep 27, 2026) |
| `opencode` | OpenCode AI | Subscription CLI | Supported via adapter |
| `gemini` | Google Gemini CLI | Subscription CLI | Best effort from `--help` (unverified) |
| `anthropic` | Anthropic (Claude API) | Native API loop | Messages API with tool use (`claude-sonnet-5`) |
| `openai` | OpenAI (GPT API) | Native API loop | Chat completions with tool calls (`gpt-4o`) |
| `openrouter` | OpenRouter | Native API loop | OpenAI-compatible endpoint (`anthropic/claude-sonnet-5`) |
| `google` | Google Gemini API | Native API loop | `generateContent` with function declarations (`gemini-2.0-flash`) |

<sub>Default models can be changed per provider with `MORAGENT_<PROVIDER>_MODEL` (e.g. `MORAGENT_OPENAI_MODEL`). The OpenAI and Google defaults were not verified live.</sub>
| `ollama` | Ollama (Local) | Native API loop | ✓ Verified live with `qwen3.5:9b` writing and reading files |

API keys are stored locally in `~/.moragent/credentials.json` with strict POSIX permissions (`0600`), and standard environment variables take precedence (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`, `OLLAMA_HOST`).

The native API loop provides built-in tools (`read_file`, `write_file`, `edit_file`, `list_dir`, `grep`, `bash`), all strictly confined to the project root with output limits (≤ 20 KB) and execution timeouts (120 s).

---

## In-App Commands

Type these slash commands inside `moragent`:

- `/help`: show available commands
- `/login`: connect subscriptions or configure API keys
- `/crew` (or `/equipo`): view the crew · `/crew <role> <engine>` to reassign roles
- `/orchestrator <engine>` (or `/orquestador <m>`): pick the orchestrator engine
- `/memory [text]` (or `/memoria [texto]`): show memory summary or search notes
- `/plan <text>`: ask the orchestrator for an explicit plan
- `/open <role|id>` (or `/abrir <rol|id>`): take a subagent out into an external terminal pane
- `/cancel`: cancel running work
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

```sh
cd my-app
mora init --preset trio --goal "Online store"     # initialize a project
mora doctor                                       # verify system health & installed engines
mora plan "Checkout flow and admin dashboard"     # size work and generate initial spec
mora spec status                                  # check spec phases
mora dispatch backend "Orders API" --spec <slug>  # dispatch a task to the bus
mora wait T-0001                                  # wait until task is completed
mora board                                        # terminal kanban board
mora memory add "Use UUIDv7" --tier canonical     # add an architectural decision
mora brain link                                   # link with Obsidian vault
```

Every read command accepts `--json`.

---

## Autonomy and Safety

Every role and engine run operates under an explicit autonomy contract:

| Mode | What the agent may do without asking |
|---|---|
| `readonly` | Read repository files (`read_file`, `list_dir`, `grep`). Writes (`write_file`, `edit_file`) and shell execution (`bash`) are strictly refused with a clear message. Ideal for orchestrators. |
| `auto` **(default)** | Edit files within the repo and run safe verification commands (`mora`, `node`, `npm test`, `git status`, `git diff`). Shell writes outside the workspace are blocked by vendor sandboxes. |
| `full` | Unrestricted operations without prompts or sandboxes (`--dangerously-skip-permissions` / `--yolo`). Use only in throwaway disposable containers. |
| `ask` | Never run commands or edits without explicit user confirmation. |

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
No. MORAGENT v5 is a standalone, full-screen terminal app that runs inside any terminal (Terminal.app, iTerm2, Alacritty, Ghostty, Windows Terminal, etc.). Orca, herdr, or tmux are only used if you choose to pop an agent out into a separate terminal pane using `/open`.

**Is it one AI or several?**  
It is one executive orchestrator coordinating multiple specialized subagents (backend, frontend, helper, dev). Each subagent can use whichever engine or API model best suits its task.

**Does it send my code to MORAGENT servers?**  
No. MORAGENT has no servers and does not collect telemetry. Your agent CLIs talk directly to their respective providers, and local Ollama runs completely offline.

**What does it cost?**  
MORAGENT is 100% free and open source (MIT). You only pay your existing vendor subscriptions or API usage.

**Can I run everything with just one tool?**  
Yes. You can run both the orchestrator and all subagents using a single engine (e.g. Claude Code only, Codex only, or 100% locally with Ollama).

**Can I undo it?**  
Everything lives cleanly in `.moragent/` plus managed comment blocks in `AGENTS.md` / `CLAUDE.md`. Remove those and your repo is restored to its exact previous state.

---

## Contributing

Contributions are welcome — please read [CONTRIBUTING.md](CONTRIBUTING.md) and the contracts in [docs/ENGINE.md](docs/ENGINE.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Run `npm test` before submitting changes.

## License

[MIT](LICENSE) © Eduardo Moraga
