---
name: moragent-advisor
description: "Analyze a project idea and recommend the optimal agentic AI architecture — agents, orchestration pattern, skills, MCPs, phases, risks."
---

# MORAGENT Project Advisor

When the user describes a project idea, analyze it and recommend the architecture.
Respond in the language configured via `moragent_language()`.

## Steps
1. Scan existing infrastructure (.claude/agents/, .claude/skills/, .claude/agent-memory/)
2. Analyze the user's idea for: complexity, data sources, outputs, industry
3. Recommend agents (reuse existing when possible, create new only if needed)
4. Recommend an orchestration pattern with reasoning:
   - **pipeline** — sequential steps where order matters
   - **parallel** — independent subtasks running at once
   - **orchestrator** — dynamic decomposition and delegation (most common)
   - **evaluator** — generate + critique loop for quality-critical outputs
   - **router** — classify inputs and dispatch to specialized flows
   - **hybrid** — combinations (e.g. orchestrator + evaluator gate)
5. Recommend skills (existing + new)
6. Recommend MCP connections
7. Suggest memory pre-population
8. Define implementation phases
9. Identify risks
10. Offer to create the full structure

## Output Format
Use structured panels with clear sections for each recommendation.
Always indicate if an agent/skill is EXISTING or NEW.
Always explain WHY each recommendation — especially the orchestration pattern choice.
