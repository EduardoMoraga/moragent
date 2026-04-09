# MORAGENT -- AI Agent Studio

> Design, learn, and deploy agentic AI projects in Claude Code.

```
You: /moragent
Claude: 9-option guided menu -> create project, agents, skills, learn, quality check...
```

## What is MORAGENT?

MORAGENT is an MCP plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) that turns it into a full **AI Agent Studio**. It provides 11 tools and a guided menu (`/moragent`) that helps you structure, create, and operate multi-agent projects -- without writing any code.

It works by scanning your workspace, understanding what agents and skills you already have, and recommending what to create next. Think of it as an opinionated framework that enforces good practices: reuse over duplication, quality gates before delivery, and teaching through analogies.

## Who is it for?

| Level | What MORAGENT gives you |
|---|---|
| **Beginners** | Learn what agents, skills, and CLAUDE.md are -- with simple analogies |
| **Intermediate** | Create complete projects with agents and skills in minutes |
| **Advanced** | Quality gates, reference search, multi-agent orchestration patterns |

You don't need to code. Just install Claude Code, type `/moragent`, and follow the menu.

## Quick Start

### Requirements
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed
- [Python 3.10+](https://python.org/downloads)
- `pip install "mcp[cli]"`

### Get started (3 commands)

```bash
git clone https://github.com/EduardoMoraga/moragent.git
cd moragent
claude
```

Claude Code auto-detects the MCP server and the `/moragent` skill. Type `/moragent` and you're in.

### Install in an existing project

```bash
cd my-project
python /path/to/moragent/install.py
claude
```

The installer copies `server.py`, creates `.mcp.json`, and registers `/moragent` in your project.

## Tools (11 MCP tools)

| Tool | Category | What it does |
|---|---|---|
| `moragent_advisor` | Core | Analyze your idea, scan existing infra, recommend architecture |
| `moragent_status` | Core | Dashboard of agents, skills, memories, projects |
| `moragent_glossary` | Core | 15 agentic AI concepts with analogies |
| `moragent_learn` | Core | 7 interactive lessons with diagrams |
| `moragent_create_agent` | Create | Create specialized agent with identity + memory |
| `moragent_create_skill` | Create | Create reusable skill (invoked as /name) |
| `moragent_scaffold_project` | Create | Scaffold complete project (CLAUDE.md + agents + skills) |
| `moragent_quality_check` | Operate | Checklist before delivering any output |
| `moragent_find_references` | Operate | Search previous work for templates and benchmarks |
| `moragent_onboard` | Operate | Visual explanation of how everything connects |
| `moragent_enrich` | Operate | Diagnose weak agents/skills and guide improvement |

## Menu (/moragent)

```
MORAGENT AI Agent Studio
========================

  1. New project        -- Describe your idea, get full structure
  2. Create agent       -- Specialized agent with role and memory
  3. Create skill       -- Reusable procedure (/name)
  4. My infrastructure  -- Dashboard of agents, skills, memories
  5. Learn              -- Agentic AI concepts with analogies
  6. Quality check      -- Checklist before delivering
  7. Find references    -- Previous work as starting point
  8. Onboarding         -- How everything works (folders, files, flow)
  9. Enrich             -- Improve an existing agent or skill
```

## Architecture

```
You type something
       |
       v
  CLAUDE.md (orchestrator)
  Decides which agents to use
       |
       v
  Agent activates:
    1. Reads CLAUDE.md (global context)
    2. Reads its identity (.claude/agents/*.md)
    3. Reads its memory (.claude/agent-memory/)
    4. Executes and returns result
       |
       v
  You receive consolidated output
```

### Workspace structure

```
my-project/
  CLAUDE.md                    <-- Orchestrator (project brain)
  .claude/
    agents/
      data-analyst.md          <-- Agent identity
      report-writer.md
    skills/
      etl-run.md               <-- Reusable procedure
      client-status.md
    agent-memory/
      data-analyst/
        MEMORY.md              <-- Persistent memory
  .mcp.json                    <-- MCP server config
```

## Key Concepts

| Concept | Analogy | Where it lives |
|---|---|---|
| **CLAUDE.md** | Company handbook -- everyone reads it | Project root |
| **Agent** | Specialized employee with memory | `.claude/agents/` |
| **Skill** | Standard operating procedure | `.claude/skills/` |
| **Memory** | Employee's accumulated experience | `.claude/agent-memory/` |
| **MCP** | Phone app (Gmail, Slack...) | `.mcp.json` |
| **Subagent** | Freelancer: gets task, delivers, leaves | Spawned by orchestrator |
| **Agent Team** | Team with shared Kanban board | Experimental feature |

## Orchestration Protocol

MORAGENT injects an orchestration protocol into every Claude Code session:

1. **Before starting a project** -- call `moragent_advisor` to scan infra and recommend architecture
2. **Before delivering output** -- call `moragent_quality_check` to verify quality
3. **Before starting from scratch** -- call `moragent_find_references` to find prior work
4. **After scaffolding** -- call `moragent_enrich` on each agent to ensure quality
5. **When creating agents** -- reuse existing ones first; 3 focused agents > 10 generic ones

## Real-World Example

In a single 45-minute session using MORAGENT:

- 3 specialized agents created (researcher, writer, data engineer)
- 6 reusable skills defined
- 1 research brief with 10 verified papers
- 1 LinkedIn post (1,050 words) ready to publish
- 1 weekly editorial calendar

All orchestrated with Agent Teams, zero fabricated data, real sources with URLs.

## FAQ

**Q: Does MORAGENT send my data anywhere?**
A: No. It runs 100% locally as a Python MCP server. It only reads/writes files in your project directory. No API calls, no telemetry, no external connections.

**Q: Can I use it with models other than Claude?**
A: Not currently. MORAGENT is built specifically for Claude Code's MCP protocol.

**Q: What if I already have agents and skills?**
A: MORAGENT scans your existing infrastructure first and recommends reusing what you have before creating anything new.

**Q: How do I update?**
A: `cd moragent && git pull` -- then restart Claude Code.

**Q: Can I contribute?**
A: Yes! See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Documentacion en Espanol

### Que es MORAGENT?

MORAGENT es un plugin MCP para Claude Code que lo convierte en un **AI Agent Studio** completo. Proporciona 11 herramientas y un menu guiado (`/moragent`) que te ayuda a estructurar, crear y operar proyectos multi-agente -- sin escribir codigo.

### Para quien es

- **Principiantes**: Aprende que es un agente, una skill, un CLAUDE.md -- con analogias simples.
- **Intermedios**: Crea proyectos completos con agentes y skills en minutos.
- **Avanzados**: Quality gates, busqueda de referencias, orquestacion multi-agente.

No necesitas saber programar. Solo necesitas Claude Code y escribir `/moragent`.

### Instalacion

```bash
git clone https://github.com/EduardoMoraga/moragent.git
cd moragent
claude
```

Claude Code detecta automaticamente el servidor MCP y el skill `/moragent`. Solo escribe `/moragent` y listo.

### Instalar en un proyecto existente

```bash
cd mi-proyecto
python /ruta/a/moragent/install.py
claude
```

### Conceptos clave

| Concepto | Analogia |
|---|---|
| **CLAUDE.md** | Manual de la empresa -- todos lo leen |
| **Agente** | Empleado especializado con memoria |
| **Skill** | Manual de procedimiento (/nombre) |
| **Memoria** | Experiencia acumulada del agente |
| **MCP** | App del telefono (Gmail, Slack...) |
| **Subagente** | Freelancer: recibe tarea, entrega, se va |
| **Team** | Equipo con Kanban compartido |

### Menu (/moragent)

```
  1. Nuevo proyecto     -- Describe tu idea y te armo todo
  2. Crear agente       -- Agente con rol, modelo y memoria
  3. Crear skill        -- Procedimiento reutilizable (/nombre)
  4. Mi infraestructura -- Dashboard completo
  5. Aprender           -- Conceptos con analogias y diagramas
  6. Verificar calidad  -- Checklist antes de entregar
  7. Buscar referencias -- Trabajo previo como base
  8. Onboarding         -- Como funciona todo
  9. Enriquecer         -- Mejorar un agente o skill existente
```

### Ejemplo real

En una sesion de 45 minutos, usando MORAGENT se construyo:

- 3 agentes especializados (investigador, redactor, ingeniero de datos)
- 6 skills reutilizables
- 1 research brief con 10 papers verificados
- 1 post LinkedIn de 1.050 palabras listo para publicar
- 1 calendario editorial semanal

Todo orquestado con Teams, cero datos inventados, fuentes reales con URL.

---

## License

MIT -- Eduardo Moraga, 2026

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.
