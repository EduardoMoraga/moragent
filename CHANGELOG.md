# Changelog

All notable changes to MORAGENT are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/).

## [3.0.0] - 2026-07-05

### Added
- **Zero-friction install**: new `run_server.py` launcher — no global `pip install`
  needed; it bootstraps a repo-local `.venv` with `mcp[cli]` on first run, sidestepping
  PEP 668 (Homebrew/Debian managed Pythons). Self-healing: repairs half-installed
  environments (interrupted first runs) and tolerates concurrent first launches.
  Fails with actionable messages on Python < 3.10 and missing `python3-venv` (Debian)
- Repo `CLAUDE.md` so the clone-and-run flow greets first-time users correctly
- **Full bilingual system (ES/EN)**: new `moragent_language` tool (12th tool) with persistent
  setting in `.claude/moragent.json`; menu, glossary, lessons, checklists, and generated
  templates all follow the configured language
- **Modern orchestration patterns**: new `patterns` lesson covering the 5 designs from
  Anthropic's *Building Effective Agents* (pipeline, parallel, orchestrator-workers,
  evaluator-optimizer, router); advisor now recommends a pattern with reasoning
- **New brand identity**: MORAGENT ASCII wordmark, branded headers (`◢◤ MORAGENT ◥◣`) across
  all tool outputs, redesigned 10-option menu grouped in LEARN / CREATE / OPERATE
- Glossary expanded from 15 to 25 terms per language (new: Plugin Marketplace, Plan Mode,
  Headless, Context, Checkpoint, Permissions, and the 5 orchestration patterns)
- `moragent_enrich` now validates frontmatter: flags missing `description` (critical for
  Claude Code auto-delegation) in agents and skills
- Skills scanner now supports the modern `.claude/skills/<name>/SKILL.md` format, the flat
  legacy format, and `.claude/commands/*.md`

### Changed
- **BREAKING — agent template frontmatter fixed**: generated agents now include `description:`
  (required by Claude Code for auto-delegation); removed the non-standard `memory:` field
- **BREAKING — orchestration values**: `subagents`/`team` replaced by the 6 pattern values
  (`pipeline`, `parallel`, `orchestrator`, `evaluator`, `router`, `hybrid`); legacy values
  still accepted and mapped automatically
- `moragent_create_skill` now writes the modern format (`.claude/skills/<name>/SKILL.md`)
  and drops the non-standard `user_invocable` frontmatter field
- `VALID_MODELS` updated to current lineup: `haiku`, `sonnet`, `opus`, `fable`, `inherit`
- Educational content updated to current Claude Code: skills as the primary format
  (commands are legacy), expanded hook events, `/schedule` cloud routines, checkpoints,
  plugin marketplace (`/plugin marketplace add owner/repo`)
- `/moragent` entry point migrated from `.claude/commands/moragent.md` to
  `.claude/skills/moragent/SKILL.md`; also shipped at plugin root (`skills/moragent/`)
- `install.py` reads the skill from the repo (single source of truth) instead of embedding it
- `hooks/hooks.json` now cross-platform (`${PYTHON_CMD:-python3}`)
- Advisor section numbering fixed (was 1, 2, 4, 5)

### Fixed (public-readiness audit)
- Onboarding tour and dynamic example no longer present user-scoped agents
  (`~/.claude/agents`) as if they were files of the current project — the workspace
  tree shows project agents only, with global agents reported as a separate count
- `install.py` writes a relative launcher path in the generated `.mcp.json`
  (portable/committable) and drops a `.gitignore` so the bootstrap `.venv` never
  pollutes the user's git history; global pip failure no longer aborts the install
- `moragent_status` reports `.env` as optional instead of MISSING
- CONTRIBUTING glossary example matched the real bilingual `what/analogy/where/tip`
  format (the old example would have crashed the glossary)
- `skills/advisor/` renamed to `skills/moragent-advisor/` to match its frontmatter name

### Known limitations
- Installation as a marketplace plugin (`/plugin marketplace add`) is not wired up yet
  (the repo ships the `.claude-plugin/` manifest, but `.mcp.json` paths target the
  clone-and-run flow); planned for 3.1
- The SessionStart hook uses POSIX env expansion and may not run on Windows when
  installed as a plugin (cosmetic: the banner is skipped)

### Removed
- Unused `glob` import in server.py
- Legacy `.claude/commands/moragent.md` (replaced by the skill)

## [2.0.0] - 2026-04-09

### Added
- Bilingual README (English primary, Spanish section)
- CHANGELOG.md, CONTRIBUTING.md
- `/examples` directory with reference agent, skill, and project
- `/tests` directory with pytest unit tests
- GitHub issue templates (bug report, feature request)
- Input validation for model names, orchestration types, agent/skill names
- `__version__ = "2.0.0"` constant
- `_read_safe()` helper for safe file reading
- `_parse_frontmatter()` helper for markdown frontmatter parsing
- Module-level constants: `EXCLUDED_DIRS`, `VALID_MODELS`, `VALID_ORCHESTRATIONS`, `MCP_KEYWORDS`, `DELIVERABLE_EXTENSIONS`

### Changed
- Extracted duplicated encoding pattern to `_read_safe()` helper (10 occurrences)
- Extracted frontmatter parsing to `_parse_frontmatter()` helper
- Moved MCP keywords dict from inside `moragent_advisor()` to module-level constant
- Unified excluded directory lists (was inconsistent between scan functions)
- Renamed `_nc()` to `_next_color()` for clarity
- Updated session-start.py banner to v2.0.0
- Updated plugin.json to version 2.0.0

### Fixed
- Bare `except: pass` in `moragent_find_references` -- now catches specific exceptions
- Double file read in `moragent_find_references` memory search
- Version string inconsistencies (was "v2" in server.py, "v3" in session-start.py, "1.1.0" in plugin.json)
- Missing tools in server.py docstring (`moragent_onboard`, `moragent_enrich`)

## [1.1.0] - 2026-04-08

### Added
- `moragent_enrich` tool for diagnosing and improving agents/skills
- Smarter advisor with full infrastructure inventory presentation
- 9th menu option: Enriquecer
- Generic templates approach (removed predefined templates)

### Changed
- Simplified installation to: `git clone` + `cd` + `claude`

## [1.0.0] - 2026-04-07

### Added
- Initial release
- 10 MCP tools: advisor, status, glossary, learn, create_agent, create_skill, scaffold_project, quality_check, find_references, onboard
- `/moragent` skill with 8-option guided menu
- `install.py` for installing in other projects
- Session start hooks with infrastructure banner
- 15-term agentic AI glossary
- 7 interactive lessons (architecture, orchestration, skills, context, automation, plugins, example)
- Orchestration protocol injected via MCP instructions
- MIT license
