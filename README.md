# MORAGENT — AI Agent Studio

```
█▀▄▀█ █▀█ █▀█ ▄▀█ █▀▀ █▀▀ █▄░█ ▀█▀
█░▀░█ █▄█ █▀▄ █▀█ █▄█ ██▄ █░▀█ ░█░
─────────────────────────────────────────────
 AI AGENT STUDIO · v3.0.0 · Bilingual ES/EN
─────────────────────────────────────────────
```

> Design, learn, and deploy agentic AI projects in Claude Code.
> [Documentación en español más abajo ↓](#-documentación-en-español)

![Version](https://img.shields.io/badge/version-3.0.0-blueviolet) ![Python](https://img.shields.io/badge/python-3.10+-blue) ![License](https://img.shields.io/badge/license-MIT-green) ![Language](https://img.shields.io/badge/lang-ES%20%E2%87%84%20EN-orange)

```
You: /moragent
Claude: 10-option guided menu → learn agentic AI, create projects,
        agents & skills, quality-check your outputs... in ES or EN.
```

## What is MORAGENT?

MORAGENT is an MCP plugin for [Claude Code](https://code.claude.com/docs) that turns it into a full **AI Agent Studio**. It provides 12 tools and a guided menu (`/moragent`) that helps you understand, structure, create, and operate multi-agent projects — without writing any code.

It works by scanning your workspace, understanding what agents and skills you already have, and recommending what to create next — including which **orchestration pattern** fits your project (pipeline, parallel, orchestrator-workers, evaluator-optimizer, router). Think of it as an opinionated framework that enforces good practices: reuse over duplication, quality gates before delivery, and teaching through analogies.

**Fully bilingual:** switch between Spanish and English anytime with `/moragent english` or `/moragent espanol`. Menu, lessons, glossary, and generated templates all follow your language.

## Who is it for?

| Level | What MORAGENT gives you |
|---|---|
| **Beginners** | Learn what agents, skills, and CLAUDE.md are — with simple analogies, in your language |
| **Intermediate** | Create complete projects with agents and skills in minutes |
| **Advanced** | Orchestration patterns, quality gates, reference search, enrichment diagnostics |

You don't need to code. Just install Claude Code, type `/moragent`, and follow the menu.

## Quick Start

### Requirements
- [Claude Code](https://code.claude.com/docs) installed
- [Python 3.10+](https://python.org/downloads)

### Get started (macOS / Linux)

```bash
git clone https://github.com/EduardoMoraga/moragent.git
cd moragent
claude
```

That's it — two commands and open Claude Code. When Claude Code asks to enable the `moragent` MCP server, say yes. On first launch, `run_server.py` automatically creates a local `.venv` and installs `mcp[cli]` inside it (30-60s, one time only) — no global pip install, no PEP 668 "externally-managed-environment" errors. Then type `/moragent` and you're in.

> Optional: if you prefer managing the dependency yourself, `python3 -m pip install "mcp[cli]"` (or `pip install -r requirements.txt`) before launching also works — the launcher uses your interpreter directly when `mcp` is already available.
>
> If the very first connection times out while the environment is being created (slow network), just reconnect with `/mcp` — the setup is self-healing and resumes where it left off.

### Get started (Windows)

Same steps, but on Windows the Python launcher is usually `python` (not `python3`). Tell the MCP server which interpreter to use by setting `PYTHON_CMD` once, then launch:

```powershell
git clone https://github.com/EduardoMoraga/moragent.git
cd moragent
setx PYTHON_CMD python   # one-time; open a NEW terminal afterward
claude
```

> `.mcp.json` resolves the interpreter as `${PYTHON_CMD:-python3}` — it defaults to `python3` (macOS/Linux) and falls back to whatever you set in `PYTHON_CMD` (e.g. `python` on Windows).

### Install in an existing project

```bash
cd my-project
python /path/to/moragent/install.py
claude
```

The installer copies `server.py`, creates `.mcp.json`, and installs the `/moragent` skill in your project.

## Tools (12 MCP tools)

| Tool | Category | What it does |
|---|---|---|
| `moragent_advisor` | Core | Analyze your idea, scan existing infra, recommend architecture + orchestration pattern |
| `moragent_status` | Core | Dashboard of agents, skills, memories, projects |
| `moragent_glossary` | Core | 25 agentic AI concepts with analogies (ES/EN) |
| `moragent_learn` | Core | 8 interactive lessons with diagrams (ES/EN) |
| `moragent_language` | Core | Get or switch MORAGENT's language (es/en, persisted) |
| `moragent_create_agent` | Create | Create specialized agent with identity + memory (delegation-ready frontmatter) |
| `moragent_create_skill` | Create | Create reusable skill in modern SKILL.md format (invoked as /name) |
| `moragent_scaffold_project` | Create | Scaffold complete project (CLAUDE.md + agents + skills) |
| `moragent_quality_check` | Operate | Checklist before delivering any output |
| `moragent_find_references` | Operate | Search previous work for templates and benchmarks |
| `moragent_onboard` | Operate | Visual guided tour of how everything connects |
| `moragent_enrich` | Operate | Diagnose weak agents/skills and guide improvement |

## Menu (/moragent)

```
 LEARN
   1 · Workspace tour       First time? Start here
   2 · Lessons              8 lessons: patterns, skills, context...
   3 · Glossary             25 agentic AI concepts

 CREATE
   4 · New project          Your idea → architecture + structure
   5 · Create agent         Specialist with role, model and memory
   6 · Create skill         Reusable procedure (/name)

 OPERATE
   7 · My infrastructure    Dashboard of agents, skills, memories
   8 · Enrich               Diagnose and improve agents/skills
   9 · Quality check        Checklist before delivering
  10 · Find references      Prior work as a starting point
```

## Orchestration Patterns

MORAGENT teaches and recommends the 5 core patterns from Anthropic's *Building Effective Agents*:

| Pattern | In one sentence | Use when |
|---|---|---|
| **Pipeline** | Sequential steps with validation gates | Order matters (research → write → edit) |
| **Parallel** | Independent subtasks run at once, then consolidate | Subtasks don't depend on each other |
| **Orchestrator-workers** | Orchestrator decomposes on the fly and delegates | You don't know the subtasks upfront |
| **Evaluator-optimizer** | Generate + critique loop until the gate passes | Quality matters more than speed |
| **Router** | Classifier dispatches inputs to specialized flows | Different input types, different treatment |

The advisor recommends the right pattern for your project — and always starts with the simplest one that works.

## Architecture

```
You type something
       |
       v
  Orchestrator (your session + CLAUDE.md)
  Picks a pattern and decides which agents to launch
       |
       v
  Agent activates:
    1. Reads CLAUDE.md (global context)
    2. Reads its identity (.claude/agents/*.md — description drives delegation)
    3. Reads its memory (.claude/agent-memory/)
    4. Executes and returns result
       |
       v
  You receive consolidated output
```

### Workspace structure

```
my-project/
  CLAUDE.md                    <-- Orchestrator handbook (project brain)
  .claude/
    agents/
      data-analyst.md          <-- Agent identity (frontmatter: name, description, model)
      report-writer.md
    skills/
      etl-run/
        SKILL.md               <-- Reusable procedure (modern format)
    agent-memory/
      data-analyst/
        MEMORY.md              <-- Persistent memory
    moragent.json              <-- MORAGENT config (language)
  .mcp.json                    <-- MCP server config
```

## Key Concepts

| Concept | Analogy | Where it lives |
|---|---|---|
| **CLAUDE.md** | Company handbook — everyone reads it | Project root |
| **Agent** | Specialized employee with memory | `.claude/agents/` |
| **Skill** | Standard operating procedure | `.claude/skills/<name>/SKILL.md` |
| **Memory** | Employee's accumulated experience | `.claude/agent-memory/` |
| **MCP** | Phone app (Gmail, Slack...) | `.mcp.json` |
| **Subagent** | Freelancer: gets task, delivers, leaves | Spawned by orchestrator |
| **Plugin** | Installable extension bundle | `/plugin` in Claude Code |

Full glossary: 25 terms via `moragent_glossary`.

## Orchestration Protocol

MORAGENT injects an orchestration protocol into every Claude Code session:

1. **Before starting a project** — call `moragent_advisor` to scan infra and recommend architecture + pattern
2. **Before delivering output** — call `moragent_quality_check` to verify quality
3. **Before starting from scratch** — call `moragent_find_references` to find prior work
4. **After scaffolding** — call `moragent_enrich` on each agent to ensure quality
5. **When creating agents** — reuse existing ones first; 3 focused agents > 10 generic ones

## FAQ

**Q: Does MORAGENT send my data anywhere?**
A: No. It runs 100% locally as a Python MCP server. It only reads/writes files in your project directory. No API calls, no telemetry. The only network access is the one-time download of `mcp[cli]` from PyPI during first-run setup.

**Q: Can I use it with models other than Claude?**
A: Not currently. MORAGENT is built specifically for Claude Code's MCP protocol.

**Q: What if I already have agents and skills?**
A: MORAGENT scans your existing infrastructure first and recommends reusing what you have before creating anything new.

**Q: How do I switch languages?**
A: `/moragent english` or `/moragent espanol` — the setting persists in `.claude/moragent.json`.

**Q: How do I update?**
A: If you cloned the repo: `cd moragent && git pull` — then restart Claude Code. If you installed into a project with `install.py`: pull the repo and re-run `python /path/to/moragent/install.py` in your project (it updates `server.py`, refreshes the skill, and migrates any legacy files from v2). Your language setting is preserved.

**Q: Can I contribute?**
A: Yes! See [CONTRIBUTING.md](CONTRIBUTING.md).

---

# 🇪🇸 Documentación en Español

## ¿Qué es MORAGENT?

MORAGENT es un plugin MCP para Claude Code que lo convierte en un **AI Agent Studio** completo. Proporciona 12 herramientas y un menú guiado (`/moragent`) que te ayuda a entender, estructurar, crear y operar proyectos multi-agente — sin escribir código.

Escanea tu workspace, entiende qué agentes y skills ya tienes, y recomienda qué crear — incluyendo qué **patrón de orquestación** conviene a tu proyecto (pipeline, paralelo, orchestrator-workers, evaluator-optimizer, router).

**100% bilingüe:** cambia entre español e inglés cuando quieras con `/moragent english` o `/moragent espanol`. Menú, lecciones, glosario y plantillas generadas siguen tu idioma.

## ¿Para quién es?

- **Principiantes**: Aprende qué es un agente, una skill, un CLAUDE.md — con analogías simples, en tu idioma.
- **Intermedios**: Crea proyectos completos con agentes y skills en minutos.
- **Avanzados**: Patrones de orquestación, quality gates, búsqueda de referencias, diagnóstico de agentes.

No necesitas saber programar. Solo necesitas Claude Code y escribir `/moragent`.

## Instalación (macOS / Linux)

```bash
git clone https://github.com/EduardoMoraga/moragent.git
cd moragent
claude
```

Eso es todo — dos comandos y abrir Claude Code. Cuando pregunte si habilitas el servidor MCP `moragent`, di que sí. En el primer arranque, `run_server.py` crea automáticamente un `.venv` local e instala `mcp[cli]` adentro (30-60s, solo una vez) — sin pip global, sin errores de "externally-managed-environment". Después escribe `/moragent` y listo.

> Si la primera conexión expira mientras se crea el entorno (red lenta), reconecta con `/mcp` — el setup se auto-repara y continúa donde quedó.

## Instalación (Windows)

Los mismos pasos, pero en Windows el intérprete suele ser `python` (no `python3`). Indícaselo con `PYTHON_CMD` una sola vez:

```powershell
git clone https://github.com/EduardoMoraga/moragent.git
cd moragent
setx PYTHON_CMD python   # una vez; abre una terminal NUEVA después
claude
```

## Instalar en un proyecto existente

```bash
cd mi-proyecto
python /ruta/a/moragent/install.py
claude
```

## Menú (/moragent)

```
 APRENDE
   1 · Tour del workspace   ¿Primera vez? Empieza acá
   2 · Lecciones            8 lecciones: patrones, skills, contexto...
   3 · Glosario             25 conceptos de IA agéntica

 CREA
   4 · Nuevo proyecto       Tu idea → arquitectura + estructura
   5 · Crear agente         Especialista con rol, modelo y memoria
   6 · Crear skill          Procedimiento reutilizable (/nombre)

 OPERA
   7 · Mi infraestructura   Dashboard de agentes, skills, memorias
   8 · Enriquecer           Diagnostica y mejora agentes/skills
   9 · Verificar calidad    Checklist antes de entregar
  10 · Buscar referencias   Trabajo previo como punto de partida
```

## Los 5 patrones de orquestación

| Patrón | En una frase | Úsalo cuando |
|---|---|---|
| **Pipeline** | Pasos en secuencia con gates de validación | El orden importa (investigar → redactar → editar) |
| **Paralelo** | Subtareas independientes a la vez, luego consolidar | Las subtareas no dependen entre sí |
| **Orchestrator-workers** | El orquestador descompone en vivo y delega | No conoces las subtareas de antemano |
| **Evaluator-optimizer** | Generar + criticar en loop hasta aprobar | La calidad importa más que la velocidad |
| **Router** | Un clasificador deriva cada input al flujo correcto | Inputs distintos, tratamientos distintos |

## Conceptos clave

| Concepto | Analogía |
|---|---|
| **CLAUDE.md** | Manual de la empresa — todos lo leen |
| **Agente** | Empleado especializado con memoria |
| **Skill** | Manual de procedimiento (/nombre) |
| **Memoria** | Experiencia acumulada del agente |
| **MCP** | App del teléfono (Gmail, Slack...) |
| **Subagente** | Freelancer: recibe tarea, entrega, se va |
| **Plugin** | Extensión instalable (como MORAGENT) |

Glosario completo: 25 términos vía `moragent_glossary`.

## Preguntas frecuentes

**¿MORAGENT envía mis datos a algún lado?**
No. Corre 100% local como servidor MCP en Python. Solo lee/escribe archivos en tu proyecto. Sin llamadas a APIs, sin telemetría. El único acceso a red es la descarga única de `mcp[cli]` desde PyPI durante el setup inicial.

**¿Cómo cambio el idioma?**
`/moragent english` o `/moragent espanol` — la preferencia persiste en `.claude/moragent.json`.

**¿Cómo actualizo?**
Si clonaste el repo: `cd moragent && git pull` — y reinicia Claude Code. Si lo instalaste en un proyecto con `install.py`: actualiza el repo y vuelve a correr `python /ruta/a/moragent/install.py` en tu proyecto (actualiza `server.py`, refresca el skill y migra los archivos legacy de v2). Tu idioma configurado se conserva.

---

## License

MIT — Eduardo Moraga, 2026

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.
