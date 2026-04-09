import pytest


@pytest.fixture
def sample_agent_content():
    return """---
name: test-agent
model: opus
memory: project-scoped
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
user_invocable: true
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
