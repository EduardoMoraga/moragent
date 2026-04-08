"""MORAGENT session-start hook — injects orchestration awareness into Claude Code."""
import sys, json, os
from pathlib import Path

try:
    data = json.load(sys.stdin)
except:
    data = {}

cwd = data.get("cwd", os.getcwd())
ws = Path(cwd)
claude_dir = ws / ".claude"

# Count infrastructure
agents = len(list((claude_dir / "agents").glob("*.md"))) if (claude_dir / "agents").exists() else 0
skills = len(list((claude_dir / "skills").glob("*.md"))) if (claude_dir / "skills").exists() else 0
memories = len([d for d in (claude_dir / "agent-memory").iterdir() if d.is_dir()]) if (claude_dir / "agent-memory").exists() else 0

print(f"""## MORAGENT AI Agent Studio v3 — Active

Infrastructure: {agents} agents, {skills} skills, {memories} memories.

Entry point: `/moragent` — menu guiado para crear, aprender y operar.

10 MCP tools disponibles:
- moragent_advisor: Analiza idea, escanea infra, recomienda arquitectura concreta
- moragent_quality_check: Gate de calidad ANTES de entregar outputs
- moragent_find_references: Busca trabajo previo como referencia
- moragent_onboard: Explica visualmente como funciona todo el workspace
- moragent_status: Dashboard de agentes, skills, memorias, proyectos
- moragent_glossary: Conceptos de IA agentica con analogias
- moragent_learn: Lecciones interactivas (7 temas)
- moragent_create_agent: Crear agente con identidad y memoria
- moragent_create_skill: Crear skill invocable con /nombre
- moragent_scaffold_project: Scaffoldear proyecto completo""")
