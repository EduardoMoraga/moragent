# Contributing to MORAGENT

Thanks for your interest in improving MORAGENT! This guide covers how to set up your environment, make changes, and submit contributions.

## Setup

```bash
git clone https://github.com/EduardoMoraga/moragent.git
cd moragent
pip install "mcp[cli]"
pip install pytest  # for running tests
```

Verify everything works:

```bash
python -c "import server; print(server.__version__)"
python -m pytest tests/ -v
```

## Architecture

MORAGENT is intentionally a **single-file MCP server** (`server.py`). This keeps it simple to install, understand, and debug. Please don't split it into multiple modules unless there's a very strong reason.

### Key sections in server.py

| Section | What it contains |
|---|---|
| Constants | `__version__`, `EXCLUDED_DIRS`, `VALID_MODELS`, etc. |
| Orchestration Protocol | Instructions injected into every Claude Code session |
| Helpers | `_read_safe()`, `_parse_frontmatter()`, `_next_color()` |
| Scanners | `_scan_agents()`, `_scan_skills()`, `_scan_memories()`, `_scan_project_folders()` |
| Glossary & Learn | Static educational content (Spanish) |
| Templates | `AGENT_TPL`, `SKILL_TPL` for code generation |
| Tools | 11 MCP tool functions decorated with `@mcp.tool()` |

## How to contribute

### Adding a new MCP tool

1. Add the function in the appropriate section (Core, Create, or Operate)
2. Decorate with `@mcp.tool()`
3. Add a clear docstring with `Args:` section
4. Update the docstring at the top of `server.py`
5. Add the tool to `scripts/session-start.py` banner
6. Add tests in `tests/test_server.py`

### Adding a glossary term

Add to the `GLOSSARY` dict following the existing format:

```python
"TermName": {
    "que": "What it is",
    "analogia": "Simple analogy",
    "donde": "Where it lives in the workspace",
    "tip": "Practical tip",
}
```

### Adding a lesson topic

Add to the `LEARN_CONTENT` dict. Use markdown with headers, diagrams, and examples. Keep the teaching style: analogy first, then technical detail.

## Code style

- Python 3.10+ (use `list[str]` not `List[str]`)
- UTF-8 everywhere (use `_read_safe()` for file reads)
- Spanish is OK for user-facing content (glossary, lessons, error messages)
- English for code comments and docstrings
- No external dependencies beyond `mcp[cli]`

## Pull requests

1. Fork the repo and create a feature branch
2. Make your changes
3. Run tests: `python -m pytest tests/ -v`
4. Verify import: `python -c "import server; print(server.__version__)"`
5. Submit a PR with a clear description of what changed and why

## Reporting issues

Use the [GitHub issue templates](https://github.com/EduardoMoraga/moragent/issues/new/choose) for bug reports and feature requests.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
