# Changelog

All notable changes to MORAGENT are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/).

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
