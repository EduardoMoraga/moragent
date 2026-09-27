## MORAGENT — how this project works

Project **{{project}}**. This repo is orchestrated by [MORAGENT](https://github.com/EduardoMoraga/moragent):
a crew of agents from different vendors sharing tasks, memory and specs in `.moragent/`.

### Crew

| Role | CLI | Mission |
|---|---|---|
{{crew_table}}

### Protocol (mandatory for every agent)

1. **Before starting**: `mora context <your-role> --query "<topic>"` — pulls canonical decisions, recent episodes and relevant notes.
2. **When you receive a task** (`Read and run .moragent/tasks/T-XXXX.md`): read the whole envelope, work only in your scope, and close with
   `mora done T-XXXX --summary "what you did and how to verify it" --files a,b` or `mora block T-XXXX --reason "what is missing"`.
3. **When you decide something durable** (architecture, convention, contract): `mora memory add --tier canonical --kind decision "title" --body "…"`.
4. **When you find something useful to others** (finding, gotcha): `mora memory add --tier episodic "title" --body "…"`.
5. **Temporary working notes**: `--tier transient` (they expire).
6. **Specs** live in `.moragent/specs/<slug>/`. Do not implement medium or large work without a spec: `mora spec status <slug>`.
7. Do not edit files outside your scope without coordinating with the lead.

### Memory

- `canonical/` — durable truth (decisions, conventions). Respected unless the lead changes it.
- `episodic/` — what happened (task results, sessions). Read it, don't rewrite it.
- `transient/` — scratch and handoffs; removed by `mora memory gc`.
- `skills/` — reusable procedures (procedural memory), synced to every CLI with `mora sync`.
