"""
MORAGENT MCP Server v2
=======================
AI Agent Studio — MCP server for Claude Code.
Orchestration protocol + tools for designing, managing, and operating agentic AI projects.
Runs via stdio transport (spawned by Claude Code).

by Eduardo Moraga

Tools:
  Core (always available):
    moragent_advisor        — Analyze idea, recommend architecture, create structure
    moragent_status         — Dashboard of infrastructure
    moragent_glossary       — Explain agentic AI concepts (15 terms)
    moragent_learn          — Interactive lessons (7 topics)

  Create:
    moragent_create_agent   — Create specialized agent with identity + memory
    moragent_create_skill   — Create reusable skill (SOP)
    moragent_scaffold_project — Scaffold complete project

  Operate:
    moragent_quality_check  — Evaluate output quality before delivering
    moragent_find_references — Search previous projects for templates/examples
"""
import os
import json
import glob as glob_mod
from pathlib import Path
from datetime import datetime
from mcp.server.fastmcp import FastMCP

# ══════════════════════════════════════════════════════════════════════════════
# ORCHESTRATION PROTOCOL (injected via MCP instructions)
# Like engram's Memory Protocol, but for agent orchestration and quality.
# ══════════════════════════════════════════════════════════════════════════════

ORCHESTRATION_PROTOCOL = """MORAGENT AI Agent Studio — tools for designing and managing agentic AI infrastructure. Use these tools when the user wants to create agents, skills, or projects, understand agentic AI concepts, see their infrastructure, get architecture recommendations, or scaffold projects.

## Orchestration Protocol

### BEFORE starting any multi-agent project:
1. Call `moragent_advisor` with the user's idea — it scans existing agents/skills and recommends architecture
2. REUSE existing agents when possible. Only create new ones if no existing agent covers the need.
3. Check if relevant skills already exist before creating new ones.

### BEFORE delivering any significant output (proposal, report, dashboard, analysis):
1. Call `moragent_quality_check` with a description of what was produced
2. If quality check flags issues, FIX THEM before delivering
3. Quality standards: visual design (not walls of text), data-backed claims, actionable content

### WHEN the user asks about a topic that might have previous work:
1. Call `moragent_find_references` to search for related projects, templates, or past deliverables
2. Use found references as quality benchmarks and starting points — never start from zero when prior work exists

### WHEN creating agents for a project:
- Each agent must have a CLEAR, non-overlapping role
- 3 focused agents > 10 generic ones
- Assign model by complexity: opus for architecture/complex code, sonnet for routine/analysis, haiku for classification
- Always create agent memory directory

### WHEN the user asks to learn or understand concepts:
- Use `moragent_glossary` for single concepts
- Use `moragent_learn` for comprehensive lessons with diagrams and examples"""

# ══════════════════════════════════════════════════════════════════════════════
# INIT
# ══════════════════════════════════════════════════════════════════════════════

mcp = FastMCP("moragent", instructions=ORCHESTRATION_PROTOCOL)

def _cwd():
    return Path(os.environ.get("MORAGENT_WORKSPACE", os.getcwd()))

def _claude_dir(): return _cwd() / ".claude"
def _agents_dir(): return _claude_dir() / "agents"
def _skills_dir(): return _claude_dir() / "skills"
def _memory_dir(): return _claude_dir() / "agent-memory"
def _user_agents(): return Path.home() / ".claude" / "agents"
def _user_memory(): return Path.home() / ".claude" / "projects"

# ══════════════════════════════════════════════════════════════════════════════
# SCANNERS
# ══════════════════════════════════════════════════════════════════════════════

def _scan_agents() -> list[dict]:
    agents = []
    for d, scope in [(_agents_dir(), "project"), (_user_agents(), "user")]:
        if d.exists():
            for f in sorted(d.glob("*.md")):
                content = f.read_text(encoding="utf-8", errors="replace")
                name = model = desc = ""
                in_fm = False
                for line in content.split("\n"):
                    if line.strip() == "---": in_fm = not in_fm; continue
                    if in_fm:
                        if line.startswith("name:"): name = line.split(":",1)[1].strip()
                        elif line.startswith("model:"): model = line.split(":",1)[1].strip()
                    elif line.startswith("# ") and not desc: desc = line[2:].strip()
                agents.append({"name": name or f.stem, "model": model, "scope": scope, "description": desc, "path": str(f)})
    return agents

def _scan_skills() -> list[dict]:
    skills = []
    if _skills_dir().exists():
        for f in sorted(_skills_dir().glob("*.md")):
            content = f.read_text(encoding="utf-8", errors="replace")
            name = desc = ""
            for line in content.split("\n"):
                if line.startswith("name:"): name = line.split(":",1)[1].strip()
                elif line.startswith("description:"): desc = line.split(":",1)[1].strip()
            skills.append({"name": name or f.stem, "description": desc, "path": str(f)})
    return skills

def _scan_memories() -> list[dict]:
    memories = []
    if _memory_dir().exists():
        for sub in sorted(_memory_dir().iterdir()):
            if sub.is_dir():
                mf = sub / "MEMORY.md"
                lines = len(mf.read_text(encoding="utf-8", errors="replace").splitlines()) if mf.exists() else 0
                memories.append({"agent": sub.name, "lines": lines, "has_memory": mf.exists()})
    return memories

def _scan_project_folders() -> list[dict]:
    """Scan workspace for project folders (directories with CLAUDE.md)."""
    projects = []
    ws = _cwd()
    for d in sorted(ws.iterdir()):
        if d.is_dir() and (d / "CLAUDE.md").exists() and d.name not in [".claude", "engram", "node_modules", "__pycache__"]:
            claude_md = (d / "CLAUDE.md").read_text(encoding="utf-8", errors="replace")
            first_line = ""
            for line in claude_md.split("\n"):
                if line.startswith("# "): first_line = line[2:].strip(); break
            # Check for key deliverable files
            deliverables = []
            for ext in ["*.html", "*.xlsx", "*.pdf", "*.eml", "*.py"]:
                deliverables.extend([f.name for f in d.rglob(ext) if ".git" not in str(f)])
            projects.append({
                "name": d.name,
                "title": first_line,
                "path": str(d),
                "deliverables": deliverables[:10],
                "has_etl": any(f.name.endswith((".bat", ".ps1")) for f in d.rglob("*") if "etl" in f.name.lower()),
            })
    return projects

# ══════════════════════════════════════════════════════════════════════════════
# GLOSSARY
# ══════════════════════════════════════════════════════════════════════════════

GLOSSARY = {
    "Agente": {"que": "Un especialista IA con rol, expertise y memoria propios.", "analogia": "Es como un empleado: tiene cargo, CV, experiencia.", "donde": ".claude/agents/nombre.md", "tip": "3 agentes enfocados > 10 genericos."},
    "Orquestador": {"que": "El agente principal (CLAUDE.md). Coordina a todos.", "analogia": "Es el Project Manager. Asigna, coordina, consolida.", "donde": "CLAUDE.md en la raiz", "tip": "No lo sobrecargues con tareas tecnicas."},
    "Subagente": {"que": "Agente lanzado por el orquestador. Trabaja, devuelve resultado, termina.", "analogia": "Un freelancer: brief, entrega, se va. No habla con otros.", "donde": "Se invoca, no tiene archivo propio", "tip": "Para tareas independientes."},
    "Agent Team": {"que": "Grupo de agentes con task list compartida que se hablan entre si.", "analogia": "Equipo de proyecto con Kanban compartido.", "donde": "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1", "tip": "Mas tokens. Solo para colaboracion real."},
    "Skill": {"que": "Procedimiento paso a paso reutilizable. Se invoca con /nombre.", "analogia": "Un SOP. Cualquier persona entrenada puede ejecutarlo.", "donde": ".claude/skills/nombre.md", "tip": "Si lo haces mas de 2 veces, es una skill."},
    "Memoria": {"que": "Lo que un agente recuerda entre conversaciones.", "analogia": "La experiencia del empleado.", "donde": ".claude/agent-memory/nombre/MEMORY.md", "tip": "Pre-poblar = rendimiento inmediato."},
    "CLAUDE.md": {"que": "Manual de la empresa. TODOS los agentes lo leen.", "analogia": "Manual de induccion del dia 1.", "donde": "Raiz del workspace", "tip": "Corto y esencial. <200 lineas."},
    "MCP": {"que": "Conectores a servicios externos (Gmail, Slack, Asana...).", "analogia": "Apps instaladas en tu telefono.", "donde": "claude.ai/settings/connectors", "tip": "Solo conecta lo que uses."},
    "Trigger": {"que": "Tarea automatica programada en la nube.", "analogia": "Un despertador que ejecuta tareas.", "donde": "/schedule en Claude Code", "tip": "Max 3 en plan Pro."},
    "Hook": {"que": "Comando que reacciona a un evento.", "analogia": "Alarma de seguridad: evento > accion.", "donde": ".claude/settings.local.json", "tip": "Invisibles cuando funcionan bien."},
    "Plugin": {"que": "Extension que agrega funcionalidad.", "analogia": "Plugin de Chrome.", "donde": "~/.claude/plugins/", "tip": "Pocos y buenos."},
    "LLM": {"que": "El cerebro. Opus=Einstein, Sonnet=Ingeniero, Haiku=Pasante.", "analogia": "Mas inteligente = mas lento y caro.", "donde": "model: en agents/*.md", "tip": "80% Sonnet, 20% Opus."},
    "Orquestacion": {"que": "Estrategia de coordinacion de agentes.", "analogia": "Jefe que delega (sub) vs equipo autoorganizado (team).", "donde": "CLAUDE.md + /multi-agent", "tip": "Empieza con subagentes."},
    ".env": {"que": "Archivo de credenciales. NUNCA compartir.", "analogia": "La caja fuerte de la oficina.", "donde": "Raiz del workspace", "tip": "Un .env central."},
    "Workspace": {"que": "Tu carpeta de trabajo. Todo lo que el agente ve.", "analogia": "Tu escritorio.", "donde": "Donde abres Claude Code", "tip": "Organiza por cliente."},
}

# ══════════════════════════════════════════════════════════════════════════════
# TEMPLATES
# ══════════════════════════════════════════════════════════════════════════════

AGENT_TPL = """---
name: {name}
model: {model}
memory: {scope}-scoped
color: {color}
---

# {display}

## Identity
Eres **{display}**, un agente especializado en tu dominio dentro de este proyecto.
Tu rol principal: {role}

## Expertise
{expertise}

## Working Protocol
1. Lee el CLAUDE.md del proyecto para entender el contexto global
2. Lee tu memoria en agent-memory/{name}/MEMORY.md para contexto previo
3. Ejecuta la tarea con las herramientas disponibles
4. Guarda aprendizajes relevantes en tu memoria al terminar

## Tools
{tools}

## Rules
- Comunicacion en espanol, directa, orientada a accion
- NUNCA inventar datos — todo debe ser verificable
- Si no tienes certeza de un dato, declara la incertidumbre
- Usa caracteres espanoles completos (acentos: a, e, i, o, u; ene: n)
- Guardar aprendizajes en memoria al completar tareas
{extra}
"""

SKILL_TPL = """---
name: {name}
description: {description}
user_invocable: true
---

# {display}

{description}

## Argumentos
- `$ARGUMENTS`: {args}

## Pasos
{steps}

## Output
{output}
"""

COLORS = ["green","blue","cyan","yellow","magenta","red","purple"]
_ci = 0
def _nc():
    global _ci; c = COLORS[_ci % len(COLORS)]; _ci += 1; return c

# ══════════════════════════════════════════════════════════════════════════════
# LEARN CONTENT
# ══════════════════════════════════════════════════════════════════════════════

LEARN_CONTENT = {
    "architecture": """# Arquitectura de IA Agentica — Como se conecta todo

Imagina una empresa:
- **CLAUDE.md** = Manual de induccion (todos lo leen)
- **.claude/agents/** = Empleados especializados
- **.claude/skills/** = SOPs / Manuales de procedimiento
- **.claude/agent-memory/** = Experiencia acumulada
- **Triggers** = Tareas automaticas (despertador)
- **Hooks** = Alarmas reactivas (si pasa X, hacer Y)
- **MCP/Plugins** = Herramientas de oficina (Gmail, Slack, Asana)

## Flujo de una tarea:
```
Tu: "Necesito el reporte de Philips W14"
  |
  v
CLAUDE.md (orquestador): lee instruccion, decide que agentes lanzar
  |
  +-> data-analyst: extrae datos SQL (lee su MEMORY.md)
  |     devuelve: metricas y datos
  +-> developer: genera HTML + Excel (lee su MEMORY.md)
  |     devuelve: archivos
  v
Orquestador: consolida y entrega todo
```

Cada agente lee 4 capas de contexto:
1. CLAUDE.md (raiz) — contexto de empresa
2. CLAUDE.md (carpeta cliente) — contexto de proyecto
3. agents/*.md — su identidad
4. agent-memory/ — su experiencia""",

    "orchestration": """# Subagentes vs Agent Teams

## SUBAGENTES (lo mas comun)
```
Tu --> Orquestador
          |
     +----+----+
     |         |
  analyst   developer
     |         |
  resultado  resultado
     |         |
     +----+----+
          |
     Orquestador consolida
```
- Cada agente reporta SOLO al orquestador
- analyst NO puede hablarle a developer
- Ideal para: ETLs, reportes, tareas independientes
- Costo: bajo

## AGENT TEAMS (experimental)
```
Tu --> Team Lead
          |
     +----+----+----+
     |    |    |    |
  analyst developer reviewer
     |    |    |    |
     +--hablan--directamente--+
     Task list compartida (Kanban)
```
- Los agentes se comunican directamente
- Ideal para: proyectos complejos, code reviews
- Costo: ALTO (cada agente = sesion independiente)
- Requiere: CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1

## Cuando usar cada uno:
- **Subagentes**: reporte, ETL, dashboard, rutas (tareas independientes)
- **Team**: construir portal web, investigar bug, code review profundo
- **Hibrido**: subagentes para rutina + team para fases complejas""",

    "skills": """# Skills — Procedimientos Reutilizables

Una skill = una receta: ingredientes, pasos, resultado.

## Sin skill (50+ palabras cada vez):
"Oye, necesito que vayas a la base de datos de Philips, busques el schema philips, corras el run_etl.bat..."

## Con skill (4 palabras):
/etl-run Philips W14

## Anatomia de una skill:
```
---
name: etl-run
description: Corre el ETL semanal
user_invocable: true
---
## Pasos
1. Identificar cliente
2. Verificar config
3. Ejecutar .bat weekly
4. Validar resultado
## Output
Filas cargadas, tiempo, warnings
```

## Distincion clave:
- **Agente** = QUIEN hace el trabajo (el chef)
- **Skill** = COMO se hace (la receta)
- **Memoria** = QUE aprendio haciendolo (experiencia)
- **CLAUDE.md** = En QUE restaurante trabaja (contexto)""",

    "context": """# Memoria, CLAUDE.md y Contexto — 3 Capas

```
+--------------------------------------------------+
|  CLAUDE.md (raiz)                                 |
|  Contexto GLOBAL. Todos los agentes lo leen.      |
|  "Somos Increxa, 8 clientes, SQL Server"          |
|                                                    |
|  +--------------------------------------------+   |
|  |  CLAUDE.md (por cliente)                    |   |
|  |  Contexto de PROYECTO. Solo en esa carpeta. |   |
|  |  "Philips: schema philips, ETL weekly"      |   |
|  |                                              |   |
|  |  +--------------------------------------+   |   |
|  |  |  agent-memory/MEMORY.md              |   |   |
|  |  |  Contexto del AGENTE.                |   |   |
|  |  |  "El campo X viene inconsistente"    |   |   |
|  |  +--------------------------------------+   |   |
|  +--------------------------------------------+   |
+--------------------------------------------------+
```

Cuando un agente se activa, lee en orden:
1. CLAUDE.md (raiz) — contexto de la empresa
2. CLAUDE.md (carpeta) — contexto del proyecto
3. agents/*.md — su identidad y rol
4. agent-memory/ — su experiencia previa
5. Tu prompt — lo que le pides ahora

**Por eso nunca necesitas repetir instrucciones.**""",

    "automation": """# Triggers, Hooks y Automatizacion

## TRIGGER = tarea programada en la nube
Como un despertador. Corre solo a horas fijas.
- "Todos los dias a las 7:30AM, enviame briefing por Slack"
- Se crean con: /schedule create (en Claude Code)
- Corre en la nube de Anthropic, no en tu PC
- Limite: 3 en plan Pro

## HOOK = reaccion automatica a evento
Como una alarma de seguridad. Algo pasa y se activa.
- "Cada vez que corre un ETL, loguear en archivo"
- Se configura en: .claude/settings.local.json
- Corre localmente en tu maquina

## Diferencia clave:
- Trigger: CUANDO -> a las 7:30AM todos los dias
- Hook: SI -> si alguien corre un ETL, loguealo""",

    "plugins": """# Plugins y Conexiones MCP

Un agente sin conexiones solo lee/escribe archivos.
Con MCP y plugins, accede a servicios reales.

## MCP (Model Context Protocol)
Conectores nativos de Claude. Se configuran en claude.ai.
- Gmail: leer emails, crear borradores
- Slack: enviar/leer mensajes
- Asana: crear/leer tareas
- Notion: crear paginas, buscar en bases de datos
- Google Calendar: ver eventos

## APIs (via .env)
- Pipedrive: deals, contactos, pipeline (token)
- SQL Server: queries directas (credenciales en .env)

## Plugins
Extensiones de terceros.
- Telegram: enviar/recibir mensajes via bot

## Como agregar:
- MCP: claude.ai/settings/connectors
- API: guardar token en .env
- Plugin: claude plugin install [nombre]""",

    "example": None,  # Generated dynamically — see moragent_learn()
}

# ══════════════════════════════════════════════════════════════════════════════
# TOOLS — CORE
# ══════════════════════════════════════════════════════════════════════════════

@mcp.tool()
def moragent_status() -> str:
    """Dashboard of your agentic AI infrastructure — agents, skills, memories, connections, and config files."""
    agents = _scan_agents()
    skills = _scan_skills()
    memories = _scan_memories()
    projects = _scan_project_folders()
    ws = _cwd()

    lines = ["# MORAGENT — Infrastructure Dashboard\n"]

    lines.append("## Agents")
    lines.append("| Name | Model | Scope | Memory |")
    lines.append("|------|-------|-------|--------|")
    for a in agents:
        m = next((x for x in memories if x["agent"] == a["name"]), None)
        ms = f"{m['lines']}L" if m and m["has_memory"] and m["lines"] > 0 else "empty"
        lines.append(f"| {a['name']} | {a['model']} | {a['scope']} | {ms} |")

    lines.append("\n## Skills")
    lines.append("| Command | Description |")
    lines.append("|---------|-------------|")
    for s in skills:
        lines.append(f"| /{s['name']} | {s['description'][:60]} |")

    lines.append("\n## Projects with CLAUDE.md")
    for p in projects:
        lines.append(f"- **{p['name']}/** — {p['title']}")

    lines.append("\n## Infrastructure Files")
    for f in ["CLAUDE.md", "ARCHITECTURE.md", "PLAYBOOK.md", ".env"]:
        status = "OK" if (ws / f).exists() else "MISSING"
        lines.append(f"- {f}: **{status}**")

    lines.append(f"\n**Total:** {len(agents)} agents, {len(skills)} skills, "
                 f"{sum(1 for m in memories if m['has_memory'] and m['lines']>0)} memories, "
                 f"{len(projects)} projects")
    return "\n".join(lines)


@mcp.tool()
def moragent_glossary(term: str = "") -> str:
    """Explain agentic AI concepts. Pass a term (Agent, Skill, MCP, etc.) or leave empty for all."""
    if term and term in GLOSSARY:
        g = GLOSSARY[term]
        return (f"# {term}\n\n**Que es:** {g['que']}\n**Analogia:** {g['analogia']}\n"
                f"**Donde vive:** {g['donde']}\n**Tip:** {g['tip']}")
    elif term:
        matches = [k for k in GLOSSARY if term.lower() in k.lower()]
        if matches:
            return moragent_glossary(matches[0])
        return f"Termino '{term}' no encontrado. Disponibles: {', '.join(sorted(GLOSSARY.keys()))}"
    else:
        lines = ["# MORAGENT Glossary — Agentic AI Concepts\n"]
        for t in sorted(GLOSSARY.keys()):
            g = GLOSSARY[t]
            lines.append(f"## {t}\n- **Que es:** {g['que']}\n- **Analogia:** {g['analogia']}\n- **Donde:** {g['donde']}\n- **Tip:** {g['tip']}\n")
        return "\n".join(lines)


def _generate_dynamic_example() -> str:
    """Generate a real example based on the user's actual workspace."""
    projects = _scan_project_folders()
    agents = _scan_agents()
    skills = _scan_skills()

    # Pick first project with ETL, or first project, or use generic
    etl_project = next((p for p in projects if p.get("has_etl")), None)
    any_project = projects[0] if projects else None
    proj = etl_project or any_project

    if proj:
        proj_name = proj["name"]
        proj_title = proj.get("title", proj_name)
        agent_names = [a["name"] for a in agents[:2]] if agents else ["data-analyst", "developer"]
        skill_names = [f"/{s['name']}" for s in skills[:2]] if skills else ["/mi-skill"]

        return f"""# Ejemplo Real — Basado en TU workspace

## Tu proyecto: {proj_name}/ ({proj_title})

## PASO 1: Das la instruccion
"Necesito procesar los datos de {proj_name}"
{f'(o usando skill: {skill_names[0]} {proj_name})' if skills else ''}

## PASO 2: Orquestador (CLAUDE.md) lee contexto
- CLAUDE.md (raiz) → sabe que proyectos existen y como se conectan
- {proj_name}/CLAUDE.md → sabe la config especifica del proyecto
- Decide que agentes lanzar

## PASO 3: Lanza agente "{agent_names[0]}" (subagente)
- Lee su identidad en agents/{agent_names[0]}.md
- Lee su experiencia en agent-memory/{agent_names[0]}/MEMORY.md
- Ejecuta su parte → devuelve resultado al orquestador

{f'''## PASO 4: Lanza agente "{agent_names[1]}" (subagente)
- Trabaja en paralelo o secuencial segun la tarea
- Tambien lee su identidad + memoria
- Devuelve su parte''' if len(agent_names) > 1 else ''}

## PASO 5: Orquestador consolida
- Recibe resultados de todos los subagentes
- Los combina en un output coherente
- Te entrega todo listo

## Por que funciona:
- Los agentes YA SABEN como trabajar (tienen memoria)
- No necesitas repetir instrucciones (CLAUDE.md las tiene)
- Cada agente se enfoca en lo suyo (no se sobrecargan)
- Si algo falla, solo se relanza ese agente (no todo)

## Tu infraestructura actual:
- {len(_scan_agents())} agentes listos para trabajar
- {len(skills)} skills invocables con /nombre
- {len(projects)} proyectos con CLAUDE.md
"""
    else:
        return """# Ejemplo — Como funcionaria tu primer proyecto

## PASO 1: Creas el proyecto
/moragent nuevo proyecto "Dashboard de ventas para mi equipo"

## PASO 2: MORAGENT advisor analiza y recomienda
- Escanea si ya tienes agentes utiles
- Sugiere: 2 agentes (data-analyst + developer), orquestacion subagentes
- Te pregunta: "Quieres que lo cree?"

## PASO 3: Scaffold crea todo
```
mi-proyecto/
    ├── CLAUDE.md           ← contexto del proyecto
    ├── .claude/agents/     ← agentes creados
    └── .claude/agent-memory/ ← memoria vacia (se llenara)
```

## PASO 4: Trabajas
"Genera el dashboard con datos del CSV de ventas"
- El orquestador delega al agente correcto
- El agente lee su CLAUDE.md, su memoria, y ejecuta
- Te entrega el resultado

## PASO 5: La memoria crece
Cada vez que un agente trabaja, aprende.
La proxima vez lo hace mejor y mas rapido.
"""


@mcp.tool()
def moragent_learn(topic: str = "architecture") -> str:
    """Interactive lessons on agentic AI. Topics: architecture, orchestration, skills, context, automation, plugins, example."""
    if topic == "example":
        return _generate_dynamic_example()
    if topic in LEARN_CONTENT and LEARN_CONTENT[topic] is not None:
        return LEARN_CONTENT[topic]
    return f"Available topics: {', '.join(LEARN_CONTENT.keys())}"


# ══════════════════════════════════════════════════════════════════════════════
# TOOLS — CREATE
# ══════════════════════════════════════════════════════════════════════════════

@mcp.tool()
def moragent_create_agent(
    name: str,
    role: str,
    model: str = "sonnet",
    scope: str = "project",
    expertise: list[str] | None = None,
    tools: list[str] | None = None,
    team_ready: bool = False,
    overwrite: bool = False,
) -> str:
    """Create a new specialized AI agent with identity, memory, and role definition.

    Args:
        name: Agent name in kebab-case (e.g., data-analyst)
        role: What this agent does (e.g., "Extracts and analyzes SQL data")
        model: LLM model — sonnet (fast), opus (smart), haiku (cheap)
        scope: project (this workspace) or user (all projects)
        expertise: List of expertise areas
        tools: List of tools the agent can use
        team_ready: If true, agent can work in agent teams
        overwrite: If true, replace existing agent file (useful for enriching scaffolded agents)
    """
    name = name.lower().strip().replace(" ", "-")
    display = name.replace("-", " ").title()
    exp = "\n".join(f"- {e}" for e in (expertise or [role]))
    tls = "\n".join(f"- {t}" for t in (tools or ["Bash","Read","Write","Edit","Glob","Grep"]))
    extra = "- Puede trabajar en agent teams\n- Notificar al team lead al terminar" if team_ready else ""

    content = AGENT_TPL.format(name=name, model=model, scope=scope, color=_nc(),
        display=display, description=role, role=role, expertise=exp, tools=tls, extra=extra)

    d = _agents_dir() if scope == "project" else _user_agents()
    d.mkdir(parents=True, exist_ok=True)
    f = d / f"{name}.md"
    if f.exists() and not overwrite:
        return f"Agent {name} already exists at {f}. Use overwrite=true to replace it, or use a different name."
    f.write_text(content, encoding="utf-8")

    md = _memory_dir() / name
    md.mkdir(parents=True, exist_ok=True)
    mf = md / "MEMORY.md"
    if not mf.exists():
        mf.write_text(f"# {display} — Persistent Memory\n\n## Projects\n(fills automatically)\n\n## Lessons\n(fills automatically)\n", encoding="utf-8")

    return (f"# Agent Created: {name}\n\n"
            f"- **File:** .claude/agents/{name}.md\n"
            f"- **Memory:** .claude/agent-memory/{name}/MEMORY.md\n"
            f"- **Model:** {model}\n- **Scope:** {scope}\n- **Team-ready:** {'yes' if team_ready else 'no'}\n\n"
            f"To use: *\"Use the {name} agent to...\"*")


@mcp.tool()
def moragent_create_skill(
    name: str,
    description: str,
    steps: list[str],
    arguments: str = "context parameters",
    output: str = "(define output)",
    overwrite: bool = False,
) -> str:
    """Create a reusable skill (SOP) invocable with /name.

    Args:
        name: Skill name in kebab-case (invoked as /name)
        description: What the skill does (one line)
        steps: List of steps the skill follows
        arguments: What arguments the skill receives
        output: What the skill delivers
        overwrite: If true, replace existing skill file
    """
    name = name.lower().strip().replace(" ", "-")
    display = name.replace("-", " ").title()
    steps_md = "\n".join(f"{i+1}. {s}" for i, s in enumerate(steps))

    content = SKILL_TPL.format(name=name, display=display, description=description,
        args=arguments, steps=steps_md, output=output)

    _skills_dir().mkdir(parents=True, exist_ok=True)
    f = _skills_dir() / f"{name}.md"
    if f.exists() and not overwrite:
        return f"Skill /{name} already exists. Use overwrite=true to replace it, or use a different name."
    f.write_text(content, encoding="utf-8")

    return (f"# Skill Created: /{name}\n\n"
            f"- **File:** .claude/skills/{name}.md\n"
            f"- **Invoke:** `/{name} [arguments]`\n- **Steps:** {len(steps)}\n\n"
            f"The skill is now available in Claude Code.")


@mcp.tool()
def moragent_scaffold_project(
    project_name: str,
    description: str,
    folder: str = "",
    orchestration: str = "subagents",
    agents: list[dict] | None = None,
    skills: list[dict] | None = None,
    mcps: list[str] | None = None,
) -> str:
    """Scaffold a complete agentic AI project with CLAUDE.md, agents, skills, and memory.

    Args:
        project_name: Name of the project
        description: What the project does
        folder: Folder name (auto-generated from project_name if empty)
        orchestration: subagents, team, or hybrid
        agents: List of agents [{"name":"x","model":"sonnet","role":"..."}]
        skills: List of skills [{"name":"x","description":"..."}]
        mcps: List of MCP connections needed
    """
    folder = folder or project_name.lower().replace(" ", "-")[:30]
    target = _cwd() / folder
    target.mkdir(exist_ok=True)
    agents = agents or []
    skills = skills or []
    mcps = mcps or []

    orch_desc = {
        "subagents": "Orchestrator (CLAUDE.md) coordinates all agents. Agents report back to orchestrator only.",
        "team": "Agents work as a team with shared task list. They communicate directly. Requires CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1.",
        "hybrid": "Subagents for routine tasks. Agent teams for complex phases requiring collaboration.",
    }

    agents_md = "\n".join(f"- `{a['name']}` ({a.get('model','sonnet')}) — {a.get('role','')}" for a in agents)
    skills_md = "\n".join(f"- `/{s['name']}` — {s.get('description','')}" for s in skills)
    mcps_md = "\n".join(f"- {m}" for m in mcps)

    claude_content = f"""# {project_name}

## Overview
- **Description:** {description}
- **Orchestration:** {orchestration}
- **Created:** {datetime.now().strftime('%Y-%m-%d')}

## Orchestration
{orch_desc.get(orchestration, orchestration)}

## Agents
{agents_md or '(none yet)'}

## Skills
{skills_md or '(none yet)'}

## Connections
{mcps_md or '(none yet)'}
"""
    (target / "CLAUDE.md").write_text(claude_content, encoding="utf-8")

    created_agents = 0
    for a in agents:
        aname = a["name"].lower().replace(" ", "-")
        af = _agents_dir() / f"{aname}.md"
        if not af.exists():
            _agents_dir().mkdir(parents=True, exist_ok=True)
            extra = "- Puede trabajar en agent teams\n- Notificar al team lead al terminar" if orchestration in ["team","hybrid"] else ""
            role = a.get("role", "")
            # Generate expertise list from role + agent-specific areas
            expertise_items = [f"- {role}"] if role else []
            for area in a.get("expertise", []):
                expertise_items.append(f"- {area}")
            if not expertise_items:
                expertise_items = [f"- Especialista en {aname.replace('-', ' ')}"]
            af.write_text(AGENT_TPL.format(
                name=aname, model=a.get("model","sonnet"), scope="project", color=_nc(),
                display=aname.replace("-"," ").title(),
                role=role, expertise="\n".join(expertise_items),
                tools="- Bash\n- Read\n- Write\n- Edit\n- Glob\n- Grep", extra=extra,
            ), encoding="utf-8")
            created_agents += 1
            md = _memory_dir() / aname; md.mkdir(parents=True, exist_ok=True)
            (md / "MEMORY.md").write_text(f"# {aname.replace('-',' ').title()} — Memoria Persistente\n\n## Proyectos\n(se llena automaticamente)\n\n## Aprendizajes\n(se llena automaticamente)\n", encoding="utf-8")

    created_skills = 0
    for s in skills:
        sname = s["name"].lower().replace(" ", "-")
        sf = _skills_dir() / f"{sname}.md"
        if not sf.exists():
            _skills_dir().mkdir(parents=True, exist_ok=True)
            sdesc = s.get("description", "")
            # Generate meaningful default steps from description
            default_steps = [
                f"Leer contexto del proyecto en CLAUDE.md",
                f"Identificar los parametros necesarios desde $ARGUMENTS",
                f"Ejecutar: {sdesc}" if sdesc else "Ejecutar la tarea principal",
                f"Validar que el resultado sea completo y correcto",
                f"Entregar resultado al usuario",
            ]
            ssteps = s.get("steps", default_steps)
            if isinstance(ssteps, list):
                steps_md = "\n".join(f"{i+1}. {st}" for i, st in enumerate(ssteps))
            else:
                steps_md = str(ssteps)
            sf.write_text(SKILL_TPL.format(
                name=sname, display=sname.replace("-"," ").title(),
                description=sdesc, args=s.get("arguments", "parametros de contexto"),
                steps=steps_md, output=s.get("output", f"Resultado de: {sdesc}" if sdesc else "(definir output)"),
            ), encoding="utf-8")
            created_skills += 1

    return (f"# Project Scaffolded: {project_name}\n\n"
            f"- **Folder:** {folder}/\n- **CLAUDE.md:** {folder}/CLAUDE.md\n"
            f"- **Agents created:** {created_agents}\n- **Skills created:** {created_skills}\n"
            f"- **Orchestration:** {orchestration}\n\n"
            f"Open Claude Code in `{folder}/` to start working.")


# ══════════════════════════════════════════════════════════════════════════════
# TOOLS — OPERATE (NEW in v2)
# ══════════════════════════════════════════════════════════════════════════════

@mcp.tool()
def moragent_advisor(idea: str, industry: str = "", data_sources: str = "", outputs: str = "") -> str:
    """Analyze a project idea and recommend the optimal agentic AI architecture.
    Scans existing infrastructure, matches relevant agents/skills, and returns concrete recommendations.

    Args:
        idea: Description of the project
        industry: Industry context (optional)
        data_sources: Comma-separated data sources (optional)
        outputs: Comma-separated expected deliverables (optional)
    """
    agents = _scan_agents()
    skills = _scan_skills()
    memories = _scan_memories()
    projects = _scan_project_folders()

    idea_lower = idea.lower()
    idea_words = set(idea_lower.split())
    # Remove stop words for better matching
    stop_words = {"de", "la", "el", "los", "las", "un", "una", "para", "con", "en", "del", "al", "que", "y", "o", "a", "the", "for", "and", "with", "to"}
    idea_words = idea_words - stop_words

    # --- Smart matching: find reusable agents ---
    reusable = []
    for a in agents:
        name_words = set(a["name"].replace("-", " ").split()) - stop_words
        desc_words = set(a.get("description", "").lower().split()) - stop_words
        all_words = name_words | desc_words
        # Also read agent file for deeper matching if description is short
        agent_path = Path(a.get("path", ""))
        if agent_path.exists() and len(desc_words) < 5:
            try:
                content_words = set(agent_path.read_text(encoding="utf-8", errors="replace").lower().split()[:200]) - stop_words
                all_words |= content_words
            except: pass
        overlap = idea_words & all_words
        # Require at least 2 word overlap to avoid false matches
        # (e.g. "brand-architect" matching "research" just because both mention "proyecto")
        if len(overlap) >= 2:
            reusable.append({**a, "_match_score": len(overlap), "_matched": overlap})

    # Sort by match score, only keep top 3 most relevant
    reusable.sort(key=lambda x: x.get("_match_score", 0), reverse=True)
    reusable = reusable[:3]

    # --- Smart matching: find reusable skills ---
    reusable_skills = []
    for s in skills:
        s_words = set(s["name"].replace("-", " ").split()) | set(s.get("description", "").lower().split())
        if idea_words & s_words:
            reusable_skills.append(s)

    # --- Similar projects ---
    similar = []
    for p in projects:
        p_words = set(p["name"].lower().split()) | set(p.get("title", "").lower().split())
        if idea_words & p_words:
            similar.append(p)

    # --- Orchestration recommendation ---
    complexity_signals = {
        "high": ["portal", "plataforma", "platform", "full-stack", "chatbot", "multi-fase", "investigar"],
        "low": ["reporte", "report", "etl", "dashboard", "analisis", "ruta", "route", "encuesta"],
    }
    is_complex = any(w in idea_lower for w in complexity_signals["high"])
    is_simple = any(w in idea_lower for w in complexity_signals["low"])

    if is_complex and not is_simple:
        orch_rec = "hybrid"
        orch_why = "El proyecto tiene multiples fases interdependientes. Subagentes para tareas independientes + team para fases que requieren colaboracion."
    else:
        orch_rec = "subagents"
        orch_why = "Las tareas son independientes entre si. Cada agente reporta al orquestador, mas barato y predecible."

    # --- MCP recommendations ---
    mcp_keywords = {
        "Gmail": ["email", "correo", "mail", "enviar"],
        "Slack": ["slack", "notificar", "mensaje", "dm"],
        "Asana": ["tarea", "task", "proyecto", "asana", "seguimiento"],
        "Notion": ["notion", "documentar", "knowledge", "wiki", "hub"],
        "Google Calendar": ["calendario", "calendar", "reunion", "meeting"],
        "Jotform": ["formulario", "form", "encuesta", "survey"],
        "SQL Server": ["sql", "base de datos", "database", "query", "etl"],
    }
    recommended_mcps = []
    for mcp_name, keywords in mcp_keywords.items():
        if any(k in idea_lower for k in keywords):
            recommended_mcps.append(mcp_name)

    # --- Build response ---
    reusable_md = "\n".join(
        f"  - **{a['name']}** ({a['model']}) — REUSAR. Ya existe y cubre parte del scope."
        for a in reusable
    ) if reusable else "  (ningun agente existente matchea directamente)"

    new_agents_needed = ""
    if not reusable:
        new_agents_needed = "  - Necesitaras crear agentes nuevos. Usa `moragent_create_agent` o `/moragent crear agente`."
    elif len(reusable) < 2:
        new_agents_needed = "  - Considera crear 1-2 agentes adicionales para cubrir gaps."

    reusable_skills_md = "\n".join(
        f"  - **/{s['name']}** — {s['description'][:60]}"
        for s in reusable_skills
    ) if reusable_skills else "  (ninguna skill existente matchea)"

    similar_md = "\n".join(
        f"  - **{p['name']}/** — {p['title']}. Revisar como referencia."
        for p in similar
    ) if similar else "  (sin proyectos similares previos)"

    mcps_md = "\n".join(f"  - {m}" for m in recommended_mcps) if recommended_mcps else "  (sin MCPs detectados — agrega segun necesidad)"

    return f"""# MORAGENT Advisor — Recomendacion de Arquitectura

## Proyecto
**Idea:** {idea}
{f'**Industria:** {industry}' if industry else ''}
{f'**Fuentes de datos:** {data_sources}' if data_sources else ''}
{f'**Outputs esperados:** {outputs}' if outputs else ''}

---

## 1. AGENTES — Reusar vs Crear

**Agentes existentes que puedes reusar ({len(reusable)}/{len(agents)}):**
{reusable_md}

{new_agents_needed}

**Total en tu infra:** {len(agents)} agentes, {sum(1 for m in memories if m['has_memory'] and m['lines']>0)} con memoria activa.

## 2. ORQUESTACION — {orch_rec.upper()}

**Recomendacion:** `{orch_rec}`
**Por que:** {orch_why}

| Modo | Cuando usarlo |
|---|---|
| subagents | Tareas independientes (ETL, reporte, dashboard) — **90% de los casos** |
| team | Colaboracion real entre agentes (code review, investigacion) |
| hybrid | Subagentes para rutina + team para fases complejas |

## 3. SKILLS EXISTENTES

{reusable_skills_md}

## 4. CONEXIONES MCP RECOMENDADAS

{mcps_md}

## 5. PROYECTOS SIMILARES (referencias)

{similar_md}

## 6. FASES SUGERIDAS

1. **Setup** — Crear estructura (CLAUDE.md, agentes, skills, memoria)
2. **Desarrollo** — Implementar logica core del proyecto
3. **Validacion** — Testear con datos reales, quality check
4. **Entrega** — Output final, documentacion, deploy

---

## Siguiente paso

Quieres que cree la estructura del proyecto? Responde "si" y llamare `moragent_scaffold_project` con esta configuracion.

O ajusta la recomendacion: "cambiar orquestacion a team", "agregar agente X", "no necesito Y".
"""


@mcp.tool()
def moragent_quality_check(output_description: str, output_type: str = "general") -> str:
    """Evaluate output quality before delivering to user. Call this BEFORE presenting final results.

    Args:
        output_description: Brief description of what was produced (e.g., "Technical proposal for MercadoPago Chile")
        output_type: Type of output — proposal, report, dashboard, analysis, code, general
    """
    checks = {
        "proposal": [
            "Has professional visual design (not a wall of text)?",
            "Includes diagrams, flowcharts, or visual schemas?",
            "Contains specific metrics and data (not generic claims)?",
            "References past successful projects as evidence?",
            "Has clear structure with executive summary?",
            "Addresses evaluation criteria point by point?",
            "Includes financial simulation with scenarios?",
            "Has actionable next steps?",
        ],
        "report": [
            "Has visual charts or tables (not just text)?",
            "Contains specific KPIs with numbers?",
            "Compares against benchmarks or targets?",
            "Has executive summary in first paragraph?",
            "Includes data sources and methodology?",
            "Has actionable recommendations?",
        ],
        "dashboard": [
            "Uses HTML with professional CSS (not plain markdown)?",
            "Has responsive layout (works on different screens)?",
            "Includes charts, graphs, or visual KPIs?",
            "Has data filters or interactivity?",
            "Color coding for status (green/yellow/red)?",
            "Print-friendly layout?",
        ],
        "analysis": [
            "Based on real data (not assumptions)?",
            "Includes methodology description?",
            "Has statistical rigor (correlations, not just averages)?",
            "Compares multiple scenarios?",
            "Identifies risks and limitations?",
            "Provides actionable insights (not just descriptions)?",
        ],
        "code": [
            "Has error handling for edge cases?",
            "Follows existing code patterns in the project?",
            "Includes comments where logic is non-obvious?",
            "Has been tested (or includes test plan)?",
            "Uses environment variables for credentials (not hardcoded)?",
            "Handles encoding (PYTHONUTF8=1 on Windows)?",
        ],
        "general": [
            "Answers what was actually asked (not tangential)?",
            "Has professional quality (not draft-level)?",
            "Is specific and actionable (not generic)?",
            "References relevant context and data?",
            "Would the user be proud to share this with a client?",
        ],
    }

    checklist = checks.get(output_type, checks["general"])

    return f"""# MORAGENT Quality Check — {output_type.upper()}

## Output: {output_description}

## Quality Checklist
Review each item. If ANY item fails, fix it before delivering.

{chr(10).join(f'- [ ] {c}' for c in checklist)}

## Instructions
1. Go through each checkbox mentally
2. For any unchecked item, describe what's missing
3. Fix the issues BEFORE delivering to user
4. If the output is a "wall of text" without visual design, that is a FAIL — restructure with tables, diagrams, panels
5. If the output lacks specific data/numbers, that is a FAIL — add real metrics

## Quality Standards
- Specific and actionable content (not generic or vague)
- Visual design matters: structured layouts > walls of text
- Reference past projects when they exist (use moragent_find_references)
- Match or exceed the quality of previous deliverables in this workspace
"""


@mcp.tool()
def moragent_find_references(query: str, scope: str = "all") -> str:
    """Search previous projects, deliverables, and memories for templates, examples, and quality benchmarks.
    Use this BEFORE starting work to find relevant prior art. Never start from zero when past work exists.

    Args:
        query: What to search for (e.g., "proposal", "dashboard Philips", "ETL report")
        scope: Where to search — all, projects, memories, deliverables
    """
    results = []
    ws = _cwd()
    query_lower = query.lower()

    # Search project folders
    if scope in ("all", "projects"):
        for d in sorted(ws.iterdir()):
            if d.is_dir() and (d / "CLAUDE.md").exists() and d.name not in [".claude", "engram", "node_modules"]:
                claude_md = (d / "CLAUDE.md").read_text(encoding="utf-8", errors="replace").lower()
                if query_lower in claude_md or query_lower in d.name.lower():
                    results.append(f"**PROJECT:** {d.name}/ — has CLAUDE.md matching '{query}'")

    # Search for deliverable files
    if scope in ("all", "deliverables"):
        for ext in ["*.html", "*.xlsx", "*.pdf", "*.eml"]:
            for f in ws.rglob(ext):
                if query_lower in f.name.lower() or query_lower in str(f.parent.name).lower():
                    if ".git" not in str(f) and "node_modules" not in str(f):
                        rel = f.relative_to(ws)
                        size_kb = f.stat().st_size // 1024
                        results.append(f"**FILE:** {rel} ({size_kb}KB)")

    # Search memory files
    if scope in ("all", "memories"):
        mem_dir = Path.home() / ".claude" / "projects"
        if mem_dir.exists():
            for mf in mem_dir.rglob("*.md"):
                try:
                    content = mf.read_text(encoding="utf-8", errors="replace").lower()
                    if query_lower in content:
                        # Extract first meaningful line
                        for line in mf.read_text(encoding="utf-8", errors="replace").split("\n"):
                            if line.startswith("name:"):
                                results.append(f"**MEMORY:** {line.split(':',1)[1].strip()} ({mf.name})")
                                break
                except: pass

    # Search agent memories
    if scope in ("all", "memories") and _memory_dir().exists():
        for sub in _memory_dir().iterdir():
            if sub.is_dir():
                mf = sub / "MEMORY.md"
                if mf.exists():
                    content = mf.read_text(encoding="utf-8", errors="replace").lower()
                    if query_lower in content:
                        results.append(f"**AGENT MEMORY:** {sub.name} — mentions '{query}'")

    if not results:
        return f"# No references found for '{query}'\n\nNo previous projects, deliverables, or memories match this query. Starting from scratch is OK in this case."

    return f"""# MORAGENT References — '{query}'

Found {len(results)} relevant references:

{chr(10).join(f'- {r}' for r in results[:20])}

## Instructions
Use these references as:
1. **Quality benchmarks** — match or exceed the quality of previous work
2. **Templates** — reuse structures, layouts, and patterns that worked before
3. **Context** — understand what was done previously to avoid duplication
4. **Starting points** — don't start from zero when prior art exists

Read the most relevant files before starting new work.
"""


# ══════════════════════════════════════════════════════════════════════════════
# TOOLS — ONBOARD (guided setup for new users)
# ══════════════════════════════════════════════════════════════════════════════

@mcp.tool()
def moragent_onboard() -> str:
    """Visual guided explanation of the entire agentic AI workspace structure.
    Shows what each folder and file does, how agents process requests, and how to get started.
    For first-time users or anyone who wants to understand the system."""

    ws = _cwd()
    agents = _scan_agents()
    skills = _scan_skills()
    projects = _scan_project_folders()

    # Detect what exists
    has_claude_md = (ws / "CLAUDE.md").exists()
    has_agents = len(agents) > 0
    has_skills = len(skills) > 0
    has_env = (ws / ".env").exists()
    has_arch = (ws / "ARCHITECTURE.md").exists()

    agent_list = "\n".join(f"    │   ├── {a['name']}.md  ({a['model']}, {a['scope']})" for a in agents[:8])
    if len(agents) > 8:
        agent_list += f"\n    │   └── ... y {len(agents)-8} mas"

    skill_list = "\n".join(f"    │   ├── {s['name']}.md  (/{s['name']})" for s in skills[:8])
    if len(skills) > 8:
        skill_list += f"\n    │   └── ... y {len(skills)-8} mas"

    project_list = "\n".join(f"    ├── {p['name']}/  — {p['title']}" for p in projects[:6])
    if len(projects) > 6:
        project_list += f"\n    ├── ... y {len(projects)-6} mas"

    return f"""# MORAGENT Onboarding — Como funciona tu workspace

## Tu Workspace (vista de pajaro)
```
{ws.name}/
    │
    ├── CLAUDE.md              {"<-- ORQUESTADOR: manual principal. Todos los agentes lo leen." if has_claude_md else "<-- NO EXISTE. Necesitas crear este archivo."}
    ├── ARCHITECTURE.md        {"<-- Mapa tecnico del sistema" if has_arch else "<-- (opcional) Arquitectura del proyecto"}
    ├── .env                   {"<-- Credenciales (APIs, DB). NUNCA compartir." if has_env else "<-- NO EXISTE. Necesario para APIs y DB."}
    │
    ├── .claude/               <-- Carpeta oculta. Aqui vive TODO el sistema de agentes.
    │   ├── agents/            <-- Tus agentes especializados (uno por archivo .md)
{agent_list or "    │   │   (vacio — aun no hay agentes)"}
    │   │
    │   ├── skills/            <-- Procedimientos reutilizables (invocables con /nombre)
{skill_list or "    │   │   (vacio — aun no hay skills)"}
    │   │
    │   └── agent-memory/      <-- Lo que cada agente recuerda entre sesiones
    │       ├── [agente]/MEMORY.md
    │       └── ...
    │
    ├── .mcp.json              <-- Conexiones MCP (MORAGENT esta aqui)
    │
{project_list or "    (sin proyectos con CLAUDE.md aun)"}
```

## Que es cada cosa (en simple)

| Componente | Analogia | Para que sirve |
|---|---|---|
| **CLAUDE.md** | Manual de la empresa | Contexto global. TODOS los agentes lo leen al activarse. |
| **Agente** (.md) | Empleado especializado | Tiene nombre, rol, modelo (cerebro) y memoria propia. |
| **Skill** (.md) | Manual de procedimiento | Receta paso a paso. Se invoca con /nombre. |
| **Memoria** | Experiencia del empleado | Lo que aprendio trabajando. Persiste entre sesiones. |
| **MCP** | App del telefono | Conectores a servicios (Gmail, Slack, Asana, Notion...). |
| **.env** | Caja fuerte | Credenciales y tokens. Nunca se comparte. |
| **Hook** | Alarma de seguridad | "Si pasa X, ejecutar Y" (automatico, local). |
| **Trigger** | Despertador | Tarea programada en la nube (ej: briefing a las 7:30AM). |

## Como fluye una tarea

```
Tu escribes: "Necesito el reporte de Philips W14"
       |
       v
  CLAUDE.md (orquestador)
  Lee: contexto global, clientes, tools
       |
       v
  Decide: lanzar subagente "bi-partner-analyst"
       |
       v
  Subagente se activa:
    1. Lee CLAUDE.md (global)
    2. Lee Philips/CLAUDE.md (proyecto)
    3. Lee agents/bi-partner-analyst.md (su identidad)
    4. Lee agent-memory/ (su experiencia)
    5. Ejecuta la tarea
    6. Devuelve resultado al orquestador
       |
       v
  Orquestador consolida y te entrega
```

## Subagentes vs Agent Teams

| | Subagentes | Agent Teams |
|---|---|---|
| **Como funciona** | Cada agente reporta al orquestador | Los agentes se hablan entre si |
| **Analogia** | Jefe que delega a freelancers | Equipo con Kanban compartido |
| **Costo** | Bajo (un contexto por agente) | Alto (cada agente = sesion) |
| **Ideal para** | ETLs, reportes, dashboards | Proyectos complejos, code review |
| **Activar** | Default (ya funciona) | `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` |
| **Recomendacion** | **Usar el 90% del tiempo** | Solo cuando hay dependencias cruzadas |

## Tu infraestructura actual
- **{len(agents)} agentes** configurados
- **{len(skills)} skills** disponibles
- **{len(projects)} proyectos** con CLAUDE.md

## Que hacer ahora

1. **Ya tienes infra:** Escribe `/moragent` para ver el menu completo
2. **Quieres crear algo nuevo:** Escribe `/moragent nuevo proyecto [tu idea]`
3. **Quieres aprender mas:** Escribe `/moragent aprender`
4. **Quieres ver el estado:** Escribe `/moragent status`

Todo esta conectado. Cada vez que crees algo con MORAGENT, se integra automaticamente a tu workspace.
"""


# ══════════════════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    mcp.run(transport="stdio")
