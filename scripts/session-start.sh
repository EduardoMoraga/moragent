#!/bin/bash
# MORAGENT v3.0.0 — Session start hook (shell fallback)
cat <<'EOF'
## MORAGENT AI Agent Studio v3.0.0 — Active

Entry point: `/moragent` — guided menu to learn, create, and operate agentic AI projects.
Bilingual: check the configured language with moragent_language() and respond in it.

12 MCP tools available:
- moragent_advisor: Analyze idea and recommend architecture + orchestration pattern
- moragent_quality_check: Quality gate before delivering outputs
- moragent_find_references: Search previous work for references
- moragent_onboard: Visual guided tour of the workspace
- moragent_enrich: Diagnose and improve agents/skills
- moragent_status: Dashboard of agents, skills, memories
- moragent_glossary: 25 agentic AI concepts (ES/EN)
- moragent_learn: Interactive lessons (8 topics)
- moragent_language: Get or switch language (es/en)
- moragent_create_agent: Create a new specialized agent
- moragent_create_skill: Create a reusable skill (SKILL.md)
- moragent_scaffold_project: Scaffold a complete project
EOF
