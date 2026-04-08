---
name: moragent-advisor
description: "Analyze a project idea and recommend the optimal agentic AI architecture — agents, orchestration, skills, MCPs, phases, risks."
---

# MORAGENT Project Advisor

When the user describes a project idea, analyze it and recommend the architecture.

## Steps
1. Scan existing infrastructure (.claude/agents/, .claude/skills/, .claude/agent-memory/)
2. Analyze the user's idea for: complexity, data sources, outputs, industry
3. Recommend agents (reuse existing when possible, create new only if needed)
4. Recommend orchestration mode (subagents vs team vs hybrid) with reasoning
5. Recommend skills (existing + new)
6. Recommend MCP connections
7. Suggest memory pre-population
8. Define implementation phases
9. Identify risks
10. Offer to create the full structure

## Output Format
Use structured panels with clear sections for each recommendation.
Always indicate if an agent/skill is EXISTING or NEW.
Always explain WHY each recommendation.
