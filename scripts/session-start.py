"""MORAGENT session-start hook — injects orchestration awareness into Claude Code."""
import sys, json, os
from pathlib import Path

try:
    data = json.load(sys.stdin)
except (json.JSONDecodeError, ValueError):
    data = {}

cwd = data.get("cwd", os.getcwd())
ws = Path(cwd)
claude_dir = ws / ".claude"

# Count infrastructure
agents = len(list((claude_dir / "agents").glob("*.md"))) if (claude_dir / "agents").exists() else 0

skills = 0
skills_dir = claude_dir / "skills"
if skills_dir.exists():
    names = {f.parent.name for f in skills_dir.glob("*/SKILL.md")} | {f.stem for f in skills_dir.glob("*.md")}
    skills = len(names)
commands_dir = claude_dir / "commands"
if commands_dir.exists():
    skills += len(list(commands_dir.glob("*.md")))

memories = len([d for d in (claude_dir / "agent-memory").iterdir() if d.is_dir()]) if (claude_dir / "agent-memory").exists() else 0

# Configured language (persisted by moragent_language)
lang = "es"
try:
    cfg = json.loads((claude_dir / "moragent.json").read_text(encoding="utf-8"))
    if cfg.get("lang") in ("es", "en"):
        lang = cfg["lang"]
except (OSError, IOError, json.JSONDecodeError):
    pass

print(f"""## MORAGENT AI Agent Studio v3.0.0 — Active

Infrastructure: {agents} agents, {skills} skills, {memories} memories.
Language: {lang} (respond to MORAGENT interactions in this language; switch via moragent_language).

Entry point: `/moragent` — guided menu to learn, create, and operate agentic AI projects.

12 MCP tools available:
- moragent_advisor: Analyze idea, scan infra, recommend architecture + orchestration pattern
- moragent_quality_check: Quality gate BEFORE delivering outputs
- moragent_find_references: Search previous work for references
- moragent_onboard: Visual guided tour of the workspace
- moragent_enrich: Diagnose weak agents/skills and guide improvement
- moragent_status: Dashboard of agents, skills, memories, projects
- moragent_glossary: 25 agentic AI concepts with analogies (ES/EN)
- moragent_learn: Interactive lessons (8 topics, incl. orchestration patterns)
- moragent_language: Get or switch MORAGENT language (es/en)
- moragent_create_agent: Create agent with identity and memory
- moragent_create_skill: Create skill invocable as /name (SKILL.md format)
- moragent_scaffold_project: Scaffold a complete project""")
