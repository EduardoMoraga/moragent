# MORAGENT — AI Agent Studio (plugin repository)

This is the MORAGENT plugin repo: an MCP server (`server.py`, 12 `moragent_*` tools)
plus the `/moragent` skill (`.claude/skills/moragent/SKILL.md`). Bilingual ES/EN.

If the user just cloned this repo, suggest typing `/moragent` to start — it shows a
guided menu (learn, create, operate). Language check first: call `moragent_language()`
and respond in the configured language.

- MCP server entry point: `run_server.py` (auto-creates `.venv` with `mcp[cli]` on first run)
- Tests: `python -m pytest tests/`
- Docs: `README.md` (EN + ES), `CHANGELOG.md`
