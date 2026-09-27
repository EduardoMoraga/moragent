<div align="center">

```
█▀▄▀█ █▀█ █▀█ ▄▀█ █▀▀ █▀▀ █▄ █ ▀█▀
█ ▀ █ █▄█ █▀▄ █▀█ █▄█ ██▄ █ ▀█  █
```

**One crew of AI coding agents — Claude Code, Codex, Antigravity, Pi — working together in real terminal panes, with shared tasks, layered memory and an Obsidian second brain.**

[![version](https://img.shields.io/github/package-json/v/EduardoMoraga/moragent?color=8b5cf6&label=version)](https://github.com/EduardoMoraga/moragent)
[![license](https://img.shields.io/badge/license-MIT-8b5cf6)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A518-8b5cf6)](https://nodejs.org)
[![stars](https://img.shields.io/github/stars/EduardoMoraga/moragent?style=flat&color=8b5cf6)](https://github.com/EduardoMoraga/moragent/stargazers)

[Español](README.es.md) · [Website](https://eduardomoraga.github.io/moragent/) · [Architecture](docs/ARCHITECTURE.md)

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
mora
```

No project yet → a short wizard (five questions, Enter accepts the default). Project already there → a dashboard with the next step to take. Node ≥ 18, zero npm dependencies.

<p align="center"><img src="docs/assets/demo.gif" alt="Illustration: mora up opening three agent panes next to the lead" width="820"><br><sub>Illustration — the real recording is generated with <code>vhs docs/demo.tape</code>.</sub></p>

## Why MORAGENT

Running several coding agents at once is easy. Getting them to **share work, remember decisions and not step on each other** is the hard part. MORAGENT is a thin executive layer on top of the tools you already use:

| | MORAGENT | [herdr](https://herdr.dev) | gentle-ai | hello-sdd | tmux by hand |
|---|:-:|:-:|:-:|:-:|:-:|
| Agents in real panes | ✓ (Orca · herdr · tmux · headless) | ✓ | — | — | ✓ |
| Mix vendors in one crew | ✓ | ✓ | ✓ | — | ✓ manual |
| Task bus between agents | ✓ `dispatch` / `done` / `wait` | ~ send text to panes | — | — | — |
| Layered memory | ✓ canonical · episodic · transient · skills | — | ~¹ | — | — |
| Spec-driven phases | ✓ 8 phases, state derived from files | — | ✓ | ✓ | — |
| Obsidian second brain | ✓ `brain link` | — | — | — | — |
| One-line install | ✓ | ✓ | ✓ | ✓ | — |

<sub>¹ gentle-ai ships persistent memory through Engram, a single store of observations with full-text search — durable, but not split into layers.<br>Comparison based on each project's public docs as of September 2026 — open an issue if something is wrong. MORAGENT does not replace herdr, Orca or tmux: it **drives** them.</sub>

## 60-second tour

```sh
cd my-app
mora init --preset trio --goal "Online coffee shop"   # or just `mora` for the wizard
mora doctor                                           # Node, CLIs, multiplexers, Obsidian, project
mora plan "Stripe checkout, admin dashboard and email receipts"
#   prints size (S/M/L/XL), recommended preset and roles, and creates the first spec
mora spec status                                      # every spec with its phase and slug
mora up                                               # one pane per role, next to yours
mora dispatch backend "Orders API with Stripe webhooks" --spec <slug>
mora dispatch frontend "Checkout screen" --spec <slug>
mora wait T-0001 T-0002                               # blocks until done / blocked / failed
mora board                                            # kanban of the task bus
mora memory add "Orders use UUIDv7" --tier canonical --kind decision --body "…"
mora brain link                                       # .moragent/ shows up in your Obsidian vault
```

Every read command takes `--json`. Every command works without a TTY, so the lead agent itself can run all of this. Add `--dry-run` to `up` or `dispatch` to see what would happen without opening panes or sending anything.

## How it flows

```mermaid
flowchart LR
  you([You]) -->|goal| lead[Lead agent<br/>your terminal]
  lead -->|mora plan · spec| spec[(.moragent/specs)]
  lead -->|mora dispatch| bus[(Task bus<br/>.moragent/tasks)]
  bus -->|"Read and run T-0001.md"| p1[backend pane<br/>Codex]
  bus --> p2[frontend pane<br/>Claude Code]
  bus --> p3[helper pane<br/>Antigravity]
  p1 & p2 & p3 -->|mora done / block| bus
  bus -->|results| mem[(Memory<br/>canonical · episodic · transient)]
  mem -->|mora context| p1 & p2 & p3
  mem --> obs[[Obsidian vault]]
  lead -->|mora wait · board| bus
```

1. The **lead** (your current terminal) sizes the work and writes a spec.
2. `mora dispatch` writes a task **envelope** (`.moragent/tasks/T-0001.md`: mission, task, spec excerpt, relevant memory, acceptance criteria, exit protocol) and types one line into the worker's pane: *Read and run .moragent/tasks/T-0001.md*.
3. The worker finishes with `mora done T-0001 --summary "…"` or `mora block T-0001 --reason "…"`. The result becomes episodic memory.
4. The lead `mora wait`s, reviews, integrates, and promotes durable decisions to canonical memory.
5. Everything is markdown in `.moragent/`, which doubles as an Obsidian folder.

## Concepts

**Crew.** Roles with a mission and a CLI each. Presets: `solo` (lead), `duo` (+backend), `trio` (+frontend), `squad` (+helper, +dev). Change who does what with `mora crew set <role> <cli>`.

**Bus.** Tasks are JSON files with a status: `queued → sent → running → done | failed | blocked`. No server, no daemon — any agent from any vendor can read and write them. If a prompt got lost (for example, typed into a dialog), `mora resend <id>` sends the envelope again to the same pane.

**Memory in three layers, plus procedures.**

| Layer | Folder | What goes there | Lifetime |
|---|---|---|---|
| Canonical | `memory/canonical/` | decisions, conventions, architecture | durable, git-tracked |
| Episodic | `memory/episodic/` | task results, sessions, findings | append-only, git-tracked |
| Transient | `memory/transient/` | scratch, handoffs | expires (`mora memory gc`) |
| Procedural | `skills/<name>/SKILL.md` | reusable how-tos | synced to every CLI (`mora sync`) |

`mora context <role> --query "…"` compiles a context pack for an agent: canonical notes, recent episodes and the best recall matches, within a character budget.

**Spec-driven phases.** `explore → propose → spec → design → tasks → apply → verify → archive`. The phase is **derived from the files on disk** (EARS requirements in `spec.md`, `- [ ]` items in `tasks.md`…), so the binary — not the model — decides what comes next: `mora spec next <slug>`.

**Second brain.** `mora brain link` symlinks `.moragent/` into your Obsidian vault (or copies it with `--copy`). Notes use frontmatter and `[[wikilinks]]`, and `Home.md` is a generated map of content, so the graph view shows tasks, specs and decisions connected. With a vault linked, `Home.md` is rebuilt automatically after every `mora done` and `mora block`.

## Supported CLIs and multiplexers

| Agent CLI | Reads | Skills | Install |
|---|---|---|---|
| Claude Code (`claude`) | `CLAUDE.md` → `@AGENTS.md` | `.claude/skills` | `npm i -g @anthropic-ai/claude-code` |
| Codex (`codex`) | `AGENTS.md` | `.agents/skills` | `npm i -g @openai/codex` |
| Antigravity (`agy`) | `GEMINI.md`, `AGENTS.md` | `.agents/skills` | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` · Windows: `irm https://antigravity.google/cli/install.ps1 \| iex` ([repo](https://github.com/google-antigravity/antigravity-cli)) |
| Pi (`pi`) | `AGENTS.md` | `.agents/skills`, `.pi/skills` | `npm i -g @mariozechner/pi-coding-agent` |
| OpenCode (`opencode`) | `AGENTS.md` | `.agents/skills`, `.opencode/skill` | `npm i -g opencode-ai` |
| Gemini CLI (`gemini`) | `GEMINI.md` | `.agents/skills` | `npm i -g @google/gemini-cli` |

| Multiplexer | Picked when | Notes |
|---|---|---|
| Orca | running inside Orca (`ORCA_TERMINAL_HANDLE`) | splits next to your terminal |
| herdr | `HERDR_ENV=1` | panes managed by herdr |
| tmux | inside tmux, or tmux is installed | outside tmux it creates a detached session and tells you how to attach |
| headless | nothing else available | agents run in the background, logs in `.moragent/runs/` |

Force one with `mora up --mux tmux` or `mora config set mux tmux`.

**Layout.** `layout` is `split` (default) or `tabs`. In Orca, `split` opens each agent next to your terminal; when the split fails or the tab already holds 4 panes, that agent gets its own tab named after its role. `mora config set layout tabs` always uses tabs.

**`mora` inside every pane.** `mora up` writes a small shim to `.moragent/runs/bin` and puts it first on each pane's `PATH`, so workers can run `mora done` even if you installed MORAGENT with `npx` or from a git clone.

`mora sync` keeps one canonical `AGENTS.md` and writes a managed block (between `<!-- moragent:… -->` markers) into each file the crew needs. It never touches your text outside the markers.

## Autonomy and safety

A worker that stops to ask "may I run `mora done`?" in a pane nobody is watching stalls the whole crew. So every role has an autonomy level, set in `crew.<role>.autonomy`:

| Mode | What the agent may do without asking | Flags MORAGENT passes |
|---|---|---|
| `auto` **(default)** | edit files in the repo and run `mora …`, `node`, `npm test`, `git status` and `git diff`; other shell commands are decided by Claude's auto-mode classifier (Claude) or stay inside the workspace sandbox (Codex, Antigravity) | Claude: `--permission-mode auto --allowedTools "Bash(mora:*)" "Bash(npm test:*)" "Bash(node:*)" "Bash(git status:*)" "Bash(git diff:*)"` · Codex: `-s workspace-write -a never` · Antigravity: `--sandbox --dangerously-skip-permissions` · Gemini: `--approval-mode auto_edit` |
| `full` | anything — no prompts, no sandbox | Claude/Antigravity: `--dangerously-skip-permissions` · Codex: `--dangerously-bypass-approvals-and-sandbox` · Gemini: `--yolo` |
| `ask` | nothing; the CLI's own prompts apply | none |

Pi and OpenCode do not prompt for permissions, so they get no extra flags. Headless runs are never `ask` (nobody could answer): they run at least as `auto`.

**Why `auto` is the default:** it is the smallest set of permissions that lets a worker finish a task and report back on its own. Codex keeps its workspace sandbox, and Claude can only run the commands on the list without asking. Antigravity's `accept-edits` mode still asks before *every* shell command (even `mora done`), so `auto` runs it inside its sandbox without prompts instead: writes outside the workspace are refused.

```sh
mora config set crew.backend.autonomy full   # one role, persisted in moragent.json
mora up --yolo                               # every pane opened by this command runs in full
```

Use `full` / `--yolo` only in a disposable environment (container, VM, throwaway branch) you are fine losing. The first time a CLI opens in a folder it may ask whether you trust it: `mora up` reminds you, and `dispatch` to an Orca pane refuses to send while a trust or update dialog is at the bottom of the screen (see [Troubleshooting](#troubleshooting)).

## Automatic memory

Every finished task already becomes memory through `mora done`, whatever the CLI. On top of that, agent sessions can leave a note on their own:

- **Claude Code** — `mora init` adds a `SessionEnd` hook to the project's `.claude/settings.json` (skip with `--no-hooks`; add it later with `mora sync --hooks`).
- **Codex** — Codex ignores `notify` in a project-level config (and warns on every launch), so the only place it works is your user config. MORAGENT touches it only when you ask: `mora sync --hooks --global` adds `notify` to `~/.codex/config.toml`, and never if you already have a `notify`. Outside MORAGENT projects the capture is a silent no-op.

The hooks call the same MORAGENT installation you ran (`mora` when it is on your PATH, otherwise its absolute path, so npx and git clones work too). `mora sync --hooks --dry-run` shows what would be written, and existing hooks are never replaced.

Capture is deterministic (no LLM): it keeps the first request, the last answer, the files edited and a few relevant commands, as **one note per session**. It skips trivial sessions and redacts anything that looks like a secret (`sk-…`, `ghp_…`, `AKIA…`, private keys). A capture error never breaks your agent: it is logged to `.moragent/runs/capture.log`.

## Tested with

> **Platforms.** Verified live on macOS with Orca. Linux and Windows run the full test suite in CI (Node 18/20/22). On Windows, agent panes are **experimental** (untested on a real machine yet); headless mode (`--mux headless`) is the safe path there. Reports welcome.

End-to-end on September 27, 2026 in Orca: each CLI as a worker through `mora up` → `mora dispatch` → `mora done`, in `auto` mode.

| CLI | Version | `auto` flags | Result |
|---|---|---|---|
| Codex | 0.154 | `-s workspace-write -a never` | ✓ no prompts |
| Claude Code | 2.1.283 | `--permission-mode auto --allowedTools …` (mora, node, npm test, git status/diff) | ✓ no prompts |
| Antigravity | 1.2.x | `--sandbox --dangerously-skip-permissions` | ✓ no prompts; the sandbox refused `touch ../outside.txt` |
| Pi | 0.85 | — (Pi does not ask for permissions) | ✓ — Pi shows its own trust dialog the first time |

OpenCode and Gemini CLI are supported by the adapters but were not part of this run.

## Plugin for Claude Code and Codex

The same repo is a plugin for both, shipping the MORAGENT skills (lead protocol, worker protocol, specs, memory):

```text
# Claude Code
/plugin marketplace add EduardoMoraga/moragent
/plugin install moragent@moragent

```

For Codex, the repo ships `.codex-plugin/plugin.json`, which points at the same skills in `plugin/skills/`.

The skills call the `mora` CLI (falling back to `npx github:EduardoMoraga/moragent` when it is not installed).

## Troubleshooting

**A pane shows "Do you trust this folder?"** Claude Code, Codex, Antigravity and Pi ask once per folder. Accept it in that pane; it does not come back.

**`dispatch` fails with `PANE_NOT_READY`.** The bottom of that pane shows a trust or update dialog, which would have swallowed the prompt. Accept the dialog in the pane and run the same `dispatch` again. If the task was already created or its prompt got lost, use `mora resend <id>` (works for `queued` and `sent` tasks).

**Panes are too narrow.** Orca already moves to a new tab after 4 panes; to give every agent its own tab, run `mora config set layout tabs`, then `mora down` and `mora up` (panes that are already running are kept as they are).

**Codex sessions do not appear in memory.** Codex only reads `notify` from `~/.codex/config.toml`. Run `mora sync --hooks --global` (it will not overwrite an existing `notify`). Tasks closed with `mora done` are recorded either way.

**A worker says `mora: command not found`.** Panes opened by `mora up` get `mora` on their `PATH`; panes you opened by hand do not. Reopen the role with `mora up <role>`.

For everything else, `mora doctor` checks Node, each CLI, the multiplexers, Obsidian and the project files, and prints a one-line fix for each problem.

## FAQ — coming from a chat window

**Do I need to know tmux?** No. Inside Orca or herdr panes open by themselves; with only tmux installed, MORAGENT creates the session and prints the one command to attach. With nothing, agents run headless and you watch the board.

**Is it one AI or several?** Several independent agent CLIs, each in its own pane, each logged in with its own account. MORAGENT gives them a shared to-do list and a shared memory.

**Does it send my code anywhere?** MORAGENT itself makes no network calls. The agent CLIs you run talk to their own providers, exactly as they do without MORAGENT.

**What does it cost?** MORAGENT is free (MIT). Each agent CLI uses your existing subscription or API key.

**I only have Claude Code.** That works: every role can use the same CLI. `mora doctor` tells you what is missing and how to install it.

**Can I undo it?** Everything lives in `.moragent/` plus a marked block in `AGENTS.md` / `CLAUDE.md` / `GEMINI.md`. Delete those and you are back where you started.

## Contributing

Issues and PRs welcome — read [CONTRIBUTING.md](CONTRIBUTING.md) and the contract in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). `npm test` runs the whole suite; tests never launch a real agent or multiplexer.

## License

[MIT](LICENSE) © Eduardo Moraga

---

<p align="center">If MORAGENT saves you a few context switches, <a href="https://github.com/EduardoMoraga/moragent">give it a ⭐</a> — it helps other people find it.</p>
