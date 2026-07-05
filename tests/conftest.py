import sys
from pathlib import Path

import pytest

# Add parent dir so we can import server
sys.path.insert(0, str(Path(__file__).parent.parent))
import server  # noqa: E402


@pytest.fixture(autouse=True)
def isolate_language(tmp_path, monkeypatch):
    """Keep language state isolated per test: default 'es', config in tmp dir."""
    server._lang_cache = None
    monkeypatch.setattr(server, "_config_path", lambda: tmp_path / "moragent.json")
    monkeypatch.setattr(server, "_claude_dir", lambda: tmp_path)
    yield
    server._lang_cache = None


@pytest.fixture
def sample_agent_content():
    return """---
name: test-agent
description: Agent used for unit testing the scanners
model: opus
color: green
---

# Test Agent

## Identity
Eres **Test Agent**, un agente de prueba.

## Expertise
- Testing
- Quality assurance
- Automation

## Working Protocol
1. Lee CLAUDE.md
2. Ejecuta tests
3. Reporta resultados

## Tools
- Bash
- Read

## Rules
- No inventar datos
- Verificar fuentes
"""


@pytest.fixture
def sample_skill_content():
    return """---
name: test-skill
description: A test skill for unit testing
---

# Test Skill

## Arguments
- `$ARGUMENTS`: Test input

## Steps
1. Step one
2. Step two
3. Step three

## Output
Test result summary
"""
