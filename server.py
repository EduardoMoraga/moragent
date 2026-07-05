"""
MORAGENT MCP Server v3.0.0
===========================
AI Agent Studio — MCP server for Claude Code.
Orchestration protocol + tools for designing, learning, and operating agentic AI projects.
Fully bilingual (Spanish / English). Runs via stdio transport (spawned by Claude Code).

by Eduardo Moraga

Tools (12):
  Core:
    moragent_advisor        — Analyze idea, recommend architecture + orchestration pattern
    moragent_status         — Dashboard of infrastructure
    moragent_glossary       — Explain agentic AI concepts (25 terms, ES/EN)
    moragent_learn          — Interactive lessons (8 topics, ES/EN)
    moragent_language       — Get or switch MORAGENT language (es/en)

  Create:
    moragent_create_agent   — Create specialized subagent with identity + memory
    moragent_create_skill   — Create reusable skill (SKILL.md format)
    moragent_scaffold_project — Scaffold complete project

  Operate:
    moragent_quality_check  — Evaluate output quality before delivering
    moragent_find_references — Search previous projects for templates/examples
    moragent_onboard        — Visual guided tour of the workspace
    moragent_enrich         — Diagnose and improve agents/skills
"""
import os
import json
from pathlib import Path
from datetime import datetime
from mcp.server.fastmcp import FastMCP

__version__ = "3.0.0"

# ── Constants ────────────────────────────────────────────────────────────────

EXCLUDED_DIRS = {".claude", "engram", "node_modules", "__pycache__", ".git", ".venv", "dist", "build"}

DELIVERABLE_EXTENSIONS = ["*.html", "*.xlsx", "*.pdf", "*.eml", "*.py"]

VALID_MODELS = {"sonnet", "opus", "haiku", "fable", "inherit"}

VALID_LANGS = {"es", "en"}

# Modern orchestration patterns (see moragent_learn "patterns")
VALID_ORCHESTRATIONS = {"pipeline", "parallel", "orchestrator", "evaluator", "router", "hybrid"}

# Backwards compatibility with MORAGENT 2.x values
LEGACY_ORCHESTRATIONS = {"subagents": "orchestrator", "team": "orchestrator"}

MCP_KEYWORDS = {
    "Gmail": ["email", "correo", "mail", "enviar", "send"],
    "Slack": ["slack", "notificar", "notify", "mensaje", "message", "dm"],
    "Asana": ["tarea", "task", "proyecto", "asana", "seguimiento", "tracking"],
    "Notion": ["notion", "documentar", "document", "knowledge", "wiki", "hub"],
    "Google Calendar": ["calendario", "calendar", "reunion", "meeting", "agenda"],
    "Jotform": ["formulario", "form", "encuesta", "survey"],
    "SQL / Database": ["sql", "base de datos", "database", "query", "etl", "warehouse"],
    "GitHub": ["github", "repo", "pull request", "issue", "ci"],
}

# ── Brand ────────────────────────────────────────────────────────────────────

LOGO = """█▀▄▀█ █▀█ █▀█ ▄▀█ █▀▀ █▀▀ █▄░█ ▀█▀
█░▀░█ █▄█ █▀▄ █▀█ █▄█ ██▄ █░▀█ ░█░"""

WORDMARK = "◢◤ MORAGENT ◥◣"

TAGLINE = f"AI AGENT STUDIO · v{__version__}"


# ══════════════════════════════════════════════════════════════════════════════
# ORCHESTRATION PROTOCOL (injected via MCP instructions)
# ══════════════════════════════════════════════════════════════════════════════

ORCHESTRATION_PROTOCOL = """MORAGENT AI Agent Studio — tools for designing and managing agentic AI infrastructure. Use these tools when the user wants to create agents, skills, or projects, understand agentic AI concepts, see their infrastructure, get architecture recommendations, or scaffold projects.

## Language
MORAGENT is bilingual. Call `moragent_language` (no args) to check the configured language and ALWAYS respond to MORAGENT interactions in that language. The user can switch anytime with `moragent_language("es")` or `moragent_language("en")`.

## Orchestration Protocol

### BEFORE starting any multi-agent project:
1. Call `moragent_advisor` with the user's idea — it scans existing agents/skills and recommends architecture + orchestration pattern (pipeline, parallel, orchestrator-workers, evaluator-optimizer, router)
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
- Each agent must have a CLEAR, non-overlapping role and a `description` frontmatter field (Claude Code uses it to auto-delegate)
- 3 focused agents > 10 generic ones
- Assign model by complexity: haiku for classification/mechanical tasks, sonnet for routine work and analysis (~80% of cases), opus/fable for architecture and deep reasoning
- Always create the agent memory directory

### AFTER scaffolding a project:
1. Call `moragent_enrich` on each created agent to check quality
2. If enrich flags issues (GENERIC, TOO SHORT, MISSING), fix them before the user starts working
3. Rich agents produce better results than many thin agents

### WHEN the user asks to learn or understand concepts:
- Use `moragent_glossary` for single concepts (25 terms)
- Use `moragent_learn` for full lessons with diagrams (8 topics, including modern orchestration patterns)"""

# ══════════════════════════════════════════════════════════════════════════════
# INIT
# ══════════════════════════════════════════════════════════════════════════════

mcp = FastMCP("moragent", instructions=ORCHESTRATION_PROTOCOL)

def _cwd():
    # MORAGENT_WORKSPACE wins if set; otherwise use CLAUDE_PROJECT_DIR (Claude Code
    # sets it in the MCP server's env to the project root) so workspace resolution
    # does not depend on the spawned process's working directory. cwd is last resort.
    return Path(
        os.environ.get("MORAGENT_WORKSPACE")
        or os.environ.get("CLAUDE_PROJECT_DIR")
        or os.getcwd()
    )

def _claude_dir(): return _cwd() / ".claude"
def _agents_dir(): return _claude_dir() / "agents"
def _skills_dir(): return _claude_dir() / "skills"
def _commands_dir(): return _claude_dir() / "commands"
def _memory_dir(): return _claude_dir() / "agent-memory"
def _user_agents(): return Path.home() / ".claude" / "agents"
def _user_memory(): return Path.home() / ".claude" / "projects"

# ══════════════════════════════════════════════════════════════════════════════
# I18N — persistent language setting
# ══════════════════════════════════════════════════════════════════════════════

DEFAULT_LANG = "es"
_lang_cache: str | None = None

def _config_path() -> Path:
    return _claude_dir() / "moragent.json"

def _load_config() -> dict:
    try:
        return json.loads(_config_path().read_text(encoding="utf-8"))
    except (OSError, IOError, json.JSONDecodeError):
        return {}

def _get_lang() -> str:
    global _lang_cache
    if _lang_cache in VALID_LANGS:
        return _lang_cache
    lang = _load_config().get("lang", DEFAULT_LANG)
    _lang_cache = lang if lang in VALID_LANGS else DEFAULT_LANG
    return _lang_cache

def _set_lang(lang: str) -> None:
    global _lang_cache
    cfg = _load_config()
    cfg["lang"] = lang
    _claude_dir().mkdir(parents=True, exist_ok=True)
    _config_path().write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")
    _lang_cache = lang

def _t(es: str, en: str) -> str:
    """Return the string for the configured language."""
    return es if _get_lang() == "es" else en

def _hdr(title_es: str, title_en: str) -> str:
    """Branded header for tool outputs."""
    return f"# {WORDMARK} {_t(title_es, title_en)}\n"

# ══════════════════════════════════════════════════════════════════════════════
# HELPERS
# ══════════════════════════════════════════════════════════════════════════════

def _read_safe(path: Path) -> str:
    """Read a file with UTF-8 encoding, replacing errors. Returns empty string on failure."""
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except (OSError, IOError):
        return ""

def _parse_frontmatter(content: str) -> dict[str, str]:
    """Parse YAML-like frontmatter from markdown content."""
    result = {}
    in_fm = False
    for line in content.split("\n"):
        stripped = line.strip()
        if stripped == "---":
            if in_fm:
                break
            in_fm = True
            continue
        if in_fm and ":" in line:
            key, _, value = line.partition(":")
            result[key.strip()] = value.strip().strip('"').strip("'")
    return result

# ══════════════════════════════════════════════════════════════════════════════
# SCANNERS
# ══════════════════════════════════════════════════════════════════════════════

def _scan_agents() -> list[dict]:
    agents = []
    for d, scope in [(_agents_dir(), "project"), (_user_agents(), "user")]:
        if d.exists():
            for f in sorted(d.glob("*.md")):
                content = _read_safe(f)
                fm = _parse_frontmatter(content)
                desc = fm.get("description", "")
                if not desc:
                    for line in content.split("\n"):
                        if line.startswith("# "):
                            desc = line[2:].strip()
                            break
                agents.append({
                    "name": fm.get("name", f.stem),
                    "model": fm.get("model", ""),
                    "scope": scope,
                    "description": desc,
                    "has_description_fm": "description" in fm,
                    "path": str(f),
                })
    return agents

def _scan_skills() -> list[dict]:
    """Scan skills in both modern (skills/<name>/SKILL.md) and flat/legacy formats."""
    skills = []
    seen = set()
    if _skills_dir().exists():
        # Modern format: .claude/skills/<name>/SKILL.md
        for f in sorted(_skills_dir().glob("*/SKILL.md")):
            fm = _parse_frontmatter(_read_safe(f))
            name = fm.get("name", f.parent.name)
            seen.add(name)
            skills.append({"name": name, "description": fm.get("description", ""),
                           "kind": "skill", "path": str(f)})
        # Flat legacy format: .claude/skills/<name>.md
        for f in sorted(_skills_dir().glob("*.md")):
            fm = _parse_frontmatter(_read_safe(f))
            name = fm.get("name", f.stem)
            if name not in seen:
                seen.add(name)
                skills.append({"name": name, "description": fm.get("description", ""),
                               "kind": "skill", "path": str(f)})
    # Legacy commands: .claude/commands/<name>.md (still invocable as /name)
    if _commands_dir().exists():
        for f in sorted(_commands_dir().glob("*.md")):
            fm = _parse_frontmatter(_read_safe(f))
            name = fm.get("name", f.stem)
            if name not in seen:
                seen.add(name)
                skills.append({"name": name, "description": fm.get("description", ""),
                               "kind": "command", "path": str(f)})
    return skills

def _scan_memories() -> list[dict]:
    memories = []
    if _memory_dir().exists():
        for sub in sorted(_memory_dir().iterdir()):
            if sub.is_dir():
                mf = sub / "MEMORY.md"
                lines = len(_read_safe(mf).splitlines()) if mf.exists() else 0
                memories.append({"agent": sub.name, "lines": lines, "has_memory": mf.exists()})
    return memories

def _scan_project_folders() -> list[dict]:
    """Scan workspace for project folders (directories with CLAUDE.md)."""
    projects = []
    ws = _cwd()
    for d in sorted(ws.iterdir()):
        if d.is_dir() and (d / "CLAUDE.md").exists() and d.name not in EXCLUDED_DIRS:
            claude_md = _read_safe(d / "CLAUDE.md")
            first_line = ""
            for line in claude_md.split("\n"):
                if line.startswith("# "): first_line = line[2:].strip(); break
            deliverables = []
            for ext in DELIVERABLE_EXTENSIONS:
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
# GLOSSARY — 25 terms, bilingual
# Field keys are language-neutral; labels are localized at render time.
# ══════════════════════════════════════════════════════════════════════════════

GLOSSARY = {
"es": {
    "Agente": {"what": "Un especialista IA con rol, herramientas y memoria propios.", "analogy": "Un empleado: tiene cargo, CV y experiencia.", "where": ".claude/agents/nombre.md", "tip": "3 agentes enfocados > 10 genericos."},
    "Subagente": {"what": "Agente que la sesion principal lanza para una tarea. Trabaja en su propio contexto y devuelve el resultado.", "analogy": "Un freelancer: recibe brief, entrega y se va.", "where": "Se invoca desde la sesion (Task tool)", "tip": "Ideal para tareas independientes y paralelas."},
    "Orquestador": {"what": "La sesion principal: decide, delega a subagentes y consolida resultados.", "analogy": "El Project Manager del equipo.", "where": "Tu sesion de Claude Code + CLAUDE.md", "tip": "Que delegue, no que haga todo el trabajo."},
    "Skill": {"what": "Procedimiento paso a paso reutilizable. Se invoca con /nombre. Formato moderno: carpeta con SKILL.md.", "analogy": "Un SOP: cualquier persona entrenada lo ejecuta.", "where": ".claude/skills/nombre/SKILL.md", "tip": "Si lo haces mas de 2 veces, es una skill."},
    "Comando": {"what": "El formato clasico de las skills: un solo markdown. Sigue funcionando, pero las skills son el estandar actual.", "analogy": "La version 1.0 de un SOP.", "where": ".claude/commands/nombre.md (legacy)", "tip": "Para cosas nuevas usa skills/nombre/SKILL.md."},
    "Memoria": {"what": "Lo que un agente recuerda entre conversaciones.", "analogy": "La experiencia acumulada del empleado.", "where": ".claude/agent-memory/nombre/MEMORY.md", "tip": "Pre-poblar la memoria = rendimiento inmediato."},
    "CLAUDE.md": {"what": "Manual del proyecto. TODOS los agentes lo leen al activarse.", "analogy": "Manual de induccion del dia 1.", "where": "Raiz del workspace (y por carpeta)", "tip": "Corto y esencial: <200 lineas."},
    "MCP": {"what": "Model Context Protocol: conectores a servicios externos (Gmail, Slack, Asana, bases de datos...).", "analogy": "Las apps instaladas en tu telefono.", "where": ".mcp.json / claude mcp add", "tip": "Conecta solo lo que uses."},
    "Hook": {"what": "Comando que reacciona a eventos de la sesion: SessionStart, PreToolUse, PostToolUse, Stop...", "analogy": "Alarma de seguridad: evento -> accion.", "where": ".claude/settings.json o hooks/ del plugin", "tip": "Invisibles cuando funcionan bien."},
    "Plugin": {"what": "Paquete instalable que agrupa skills + agentes + hooks + MCP en una unidad distribuible.", "analogy": "Una extension de Chrome.", "where": "/plugin en Claude Code", "tip": "MORAGENT es un plugin. Puedes crear el tuyo."},
    "Marketplace": {"what": "Catalogo de plugins instalables directo desde un repo git.", "analogy": "La App Store de Claude Code.", "where": "/plugin marketplace add usuario/repo", "tip": "Publicar el tuyo = un repo con .claude-plugin/."},
    "Modelo": {"what": "El cerebro del agente. Haiku=rapido y barato, Sonnet=caballo de batalla, Opus/Fable=razonamiento profundo.", "analogy": "Pasante, ingeniero senior, arquitecto principal.", "where": "model: en el frontmatter del agente", "tip": "80% Sonnet. Opus/Fable solo para lo dificil."},
    "Contexto": {"what": "La memoria de trabajo del modelo. Se llena con la conversacion y se compacta cuando crece demasiado.", "analogy": "Un escritorio: si lo tapas de papeles, no se puede trabajar.", "where": "/context y /compact en Claude Code", "tip": "Contexto limpio = respuestas mejores y mas baratas."},
    "Plan Mode": {"what": "Modo de solo lectura: Claude disena el plan antes de tocar archivos.", "analogy": "El arquitecto dibuja antes de que entre la retroexcavadora.", "where": "Shift+Tab en Claude Code", "tip": "Para cambios grandes, siempre planifica primero."},
    "Headless": {"what": "Claude Code sin interfaz, para scripts, pipelines y CI.", "analogy": "El motor del auto sin la carroceria.", "where": "claude -p \"prompt\" en terminal", "tip": "Es la base para automatizar con agentes."},
    "Pipeline": {"what": "Patron secuencial: la salida de un paso alimenta al siguiente, con validaciones entre medio.", "analogy": "Linea de produccion con control de calidad por etapa.", "where": "Patron de orquestacion (ver /moragent aprender)", "tip": "Agrega gates de validacion entre pasos."},
    "Paralelizacion": {"what": "Varios subagentes trabajan a la vez sobre subtareas independientes; luego se consolidan.", "analogy": "5 analistas, un capitulo cada uno, al mismo tiempo.", "where": "Patron de orquestacion", "tip": "Solo si las subtareas NO dependen entre si."},
    "Orchestrator-Workers": {"what": "Un orquestador descompone el problema en vivo, delega a workers y sintetiza.", "analogy": "Gerente que arma el plan y reparte el trabajo.", "where": "Patron de orquestacion", "tip": "El patron mas usado en proyectos reales."},
    "Evaluator-Optimizer": {"what": "Un agente genera, otro critica, y se itera hasta pasar el gate de calidad.", "analogy": "Escritor + editor: nadie publica el primer borrador.", "where": "Patron de orquestacion", "tip": "Usalo en todo output de cara al cliente."},
    "Routing": {"what": "Un clasificador liviano dirige cada input al flujo especializado correcto.", "analogy": "Recepcionista que deriva al departamento indicado.", "where": "Patron de orquestacion", "tip": "Router barato (haiku) + especialistas potentes."},
    "Trigger": {"what": "Tarea programada que corre sola en la nube segun horario.", "analogy": "Un despertador que ejecuta trabajo.", "where": "/schedule en Claude Code", "tip": "Briefing diario = trigger, no ritual manual."},
    "Checkpoint": {"what": "Snapshot automatico antes de cada edicion; permite volver atras.", "analogy": "Puntos de guardado en un videojuego.", "where": "Esc Esc en Claude Code para retroceder", "tip": "Experimenta sin miedo: siempre puedes volver."},
    "Permisos": {"what": "Control de que puede ejecutar Claude sin preguntar.", "analogy": "Las llaves que le das a un empleado nuevo.", "where": "/permissions y settings.json", "tip": "Allowlist para lo repetitivo y seguro."},
    "Workspace": {"what": "Tu carpeta de trabajo: todo lo que el agente puede ver.", "analogy": "Tu oficina y tu escritorio.", "where": "Donde abres Claude Code", "tip": "Organiza por cliente o por dominio."},
    ".env": {"what": "Archivo de credenciales y tokens. NUNCA se commitea ni comparte.", "analogy": "La caja fuerte de la oficina.", "where": "Raiz del workspace + .gitignore", "tip": "Un .env central, siempre en .gitignore."},
},
"en": {
    "Agent": {"what": "An AI specialist with its own role, tools, and memory.", "analogy": "An employee: job title, resume, experience.", "where": ".claude/agents/name.md", "tip": "3 focused agents > 10 generic ones."},
    "Subagent": {"what": "An agent the main session spawns for one task. Works in its own context and returns the result.", "analogy": "A freelancer: gets a brief, delivers, leaves.", "where": "Invoked from the session (Task tool)", "tip": "Ideal for independent, parallel tasks."},
    "Orchestrator": {"what": "The main session: decides, delegates to subagents, and consolidates results.", "analogy": "The team's Project Manager.", "where": "Your Claude Code session + CLAUDE.md", "tip": "It should delegate, not do everything itself."},
    "Skill": {"what": "A reusable step-by-step procedure invoked with /name. Modern format: a folder with SKILL.md.", "analogy": "An SOP: anyone trained can run it.", "where": ".claude/skills/name/SKILL.md", "tip": "If you do it more than twice, it's a skill."},
    "Command": {"what": "The classic single-markdown skill format. Still works, but skills are today's standard.", "analogy": "Version 1.0 of an SOP.", "where": ".claude/commands/name.md (legacy)", "tip": "For new things use skills/name/SKILL.md."},
    "Memory": {"what": "What an agent remembers between conversations.", "analogy": "The employee's accumulated experience.", "where": ".claude/agent-memory/name/MEMORY.md", "tip": "Pre-populating memory = instant performance."},
    "CLAUDE.md": {"what": "The project handbook. ALL agents read it on activation.", "analogy": "Day-1 onboarding manual.", "where": "Workspace root (and per folder)", "tip": "Short and essential: <200 lines."},
    "MCP": {"what": "Model Context Protocol: connectors to external services (Gmail, Slack, Asana, databases...).", "analogy": "The apps installed on your phone.", "where": ".mcp.json / claude mcp add", "tip": "Only connect what you actually use."},
    "Hook": {"what": "A command that reacts to session events: SessionStart, PreToolUse, PostToolUse, Stop...", "analogy": "A security alarm: event -> action.", "where": ".claude/settings.json or the plugin's hooks/", "tip": "Invisible when they work well."},
    "Plugin": {"what": "An installable package bundling skills + agents + hooks + MCP into one distributable unit.", "analogy": "A Chrome extension.", "where": "/plugin in Claude Code", "tip": "MORAGENT is a plugin. You can build your own."},
    "Marketplace": {"what": "A catalog of plugins installable straight from a git repo.", "analogy": "Claude Code's App Store.", "where": "/plugin marketplace add user/repo", "tip": "Publishing yours = a repo with .claude-plugin/."},
    "Model": {"what": "The agent's brain. Haiku=fast and cheap, Sonnet=workhorse, Opus/Fable=deep reasoning.", "analogy": "Intern, senior engineer, principal architect.", "where": "model: in the agent frontmatter", "tip": "80% Sonnet. Opus/Fable only for the hard stuff."},
    "Context": {"what": "The model's working memory. Fills up with the conversation and gets compacted when it grows.", "analogy": "A desk: bury it in papers and no work gets done.", "where": "/context and /compact in Claude Code", "tip": "Clean context = better, cheaper answers."},
    "Plan Mode": {"what": "Read-only mode: Claude designs the plan before touching files.", "analogy": "The architect draws before the excavator arrives.", "where": "Shift+Tab in Claude Code", "tip": "For big changes, always plan first."},
    "Headless": {"what": "Claude Code without UI, for scripts, pipelines, and CI.", "analogy": "The car's engine without the body.", "where": "claude -p \"prompt\" in the terminal", "tip": "The foundation for agent automation."},
    "Pipeline": {"what": "Sequential pattern: each step's output feeds the next, with checks in between.", "analogy": "A production line with QA at each station.", "where": "Orchestration pattern (see /moragent learn)", "tip": "Add validation gates between steps."},
    "Parallelization": {"what": "Several subagents work at once on independent subtasks; results get consolidated.", "analogy": "5 analysts, one chapter each, at the same time.", "where": "Orchestration pattern", "tip": "Only if subtasks do NOT depend on each other."},
    "Orchestrator-Workers": {"what": "An orchestrator decomposes the problem on the fly, delegates to workers, synthesizes.", "analogy": "A manager who builds the plan and assigns the work.", "where": "Orchestration pattern", "tip": "The most used pattern in real projects."},
    "Evaluator-Optimizer": {"what": "One agent generates, another critiques, iterating until the quality gate passes.", "analogy": "Writer + editor: nobody publishes the first draft.", "where": "Orchestration pattern", "tip": "Use it on every client-facing output."},
    "Routing": {"what": "A lightweight classifier directs each input to the right specialized flow.", "analogy": "A receptionist routing you to the right department.", "where": "Orchestration pattern", "tip": "Cheap router (haiku) + powerful specialists."},
    "Trigger": {"what": "A scheduled task that runs on its own in the cloud.", "analogy": "An alarm clock that executes work.", "where": "/schedule in Claude Code", "tip": "Daily briefing = a trigger, not a manual ritual."},
    "Checkpoint": {"what": "Automatic snapshot before each edit; lets you roll back.", "analogy": "Save points in a video game.", "where": "Esc Esc in Claude Code to rewind", "tip": "Experiment fearlessly: you can always go back."},
    "Permissions": {"what": "Control over what Claude can run without asking.", "analogy": "The keys you hand a new employee.", "where": "/permissions and settings.json", "tip": "Allowlist the repetitive, safe stuff."},
    "Workspace": {"what": "Your working folder: everything the agent can see.", "analogy": "Your office and your desk.", "where": "Wherever you open Claude Code", "tip": "Organize by client or by domain."},
    ".env": {"what": "Credentials and tokens file. NEVER commit or share it.", "analogy": "The office safe.", "where": "Workspace root + .gitignore", "tip": "One central .env, always in .gitignore."},
},
}

GLOSSARY_LABELS = {
    "es": {"what": "Que es", "analogy": "Analogia", "where": "Donde vive", "tip": "Tip"},
    "en": {"what": "What it is", "analogy": "Analogy", "where": "Where it lives", "tip": "Tip"},
}

# ══════════════════════════════════════════════════════════════════════════════
# TEMPLATES — bilingual
# Frontmatter follows current Claude Code subagent spec: name + description are
# required (description drives auto-delegation), model accepts alias or full ID.
# ══════════════════════════════════════════════════════════════════════════════

AGENT_TPL = {
"es": """---
name: {name}
description: {description}
model: {model}
color: {color}
---

# {display}

## Identity
Eres **{display}**, un agente especializado dentro de este proyecto.
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
- Comunicacion directa, orientada a accion
- NUNCA inventar datos — todo debe ser verificable
- Si no tienes certeza de un dato, declara la incertidumbre
- Guardar aprendizajes en memoria al completar tareas
{extra}
""",
"en": """---
name: {name}
description: {description}
model: {model}
color: {color}
---

# {display}

## Identity
You are **{display}**, a specialized agent within this project.
Your primary role: {role}

## Expertise
{expertise}

## Working Protocol
1. Read the project's CLAUDE.md to understand global context
2. Read your memory at agent-memory/{name}/MEMORY.md for prior context
3. Execute the task with the available tools
4. Save relevant learnings to your memory when done

## Tools
{tools}

## Rules
- Direct, action-oriented communication
- NEVER fabricate data — everything must be verifiable
- If unsure about a fact, state the uncertainty
- Save learnings to memory when completing tasks
{extra}
""",
}

SKILL_TPL = {
"es": """---
name: {name}
description: {description}
---

# {display}

{description}

## Argumentos
- `$ARGUMENTS`: {args}

## Pasos
{steps}

## Output
{output}
""",
"en": """---
name: {name}
description: {description}
---

# {display}

{description}

## Arguments
- `$ARGUMENTS`: {args}

## Steps
{steps}

## Output
{output}
""",
}

COLORS = ["green", "blue", "cyan", "yellow", "purple", "red", "orange", "pink"]
_color_index = 0

def _next_color() -> str:
    """Return next color in the cycle for agent assignment."""
    global _color_index
    color = COLORS[_color_index % len(COLORS)]
    _color_index += 1
    return color

# ══════════════════════════════════════════════════════════════════════════════
# LEARN CONTENT — 8 lessons, bilingual
# ══════════════════════════════════════════════════════════════════════════════

LEARN_CONTENT = {
"es": {
    "architecture": """# Arquitectura de IA Agentica — Como se conecta todo

Imagina una empresa:
- **CLAUDE.md** = Manual de induccion (todos lo leen)
- **.claude/agents/** = Empleados especializados
- **.claude/skills/** = SOPs / Manuales de procedimiento (skills/nombre/SKILL.md)
- **.claude/agent-memory/** = Experiencia acumulada
- **Triggers (/schedule)** = Tareas automaticas (despertador)
- **Hooks** = Alarmas reactivas (si pasa X, hacer Y)
- **MCP / Plugins** = Herramientas de oficina (Gmail, Slack, Asana...)

## Flujo de una tarea:
```
Tu: "Necesito el reporte de ventas semana 14"
  |
  v
Orquestador (tu sesion + CLAUDE.md): decide que agentes lanzar
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
2. CLAUDE.md (carpeta proyecto) — contexto de proyecto
3. agents/*.md — su identidad (el `description:` decide cuando se le delega)
4. agent-memory/ — su experiencia

**Regla de oro:** el orquestador delega y consolida; los especialistas ejecutan.""",

    "orchestration": """# Orquestacion — Como trabajan los agentes en Claude Code hoy

## SUBAGENTES (la base de todo)
Un subagente es un agente que tu sesion principal lanza para una tarea.
Corre en su PROPIO contexto (no ensucia el tuyo) y devuelve solo el resultado.

```
Tu --> Orquestador (sesion principal)
          |
     +----+----+
     |         |
  analyst   developer     <- corren EN PARALELO si las tareas
     |         |             son independientes
  resultado  resultado
     +----+----+
          |
     Orquestador consolida
```

- Se definen en `.claude/agents/nombre.md`
- El campo `description:` del frontmatter es CLAVE: Claude lo usa para decidir
  cuando delegarle trabajo automaticamente
- Pueden correr en paralelo (varios a la vez) o en background
  (siguen trabajando mientras tu haces otra cosa)

## AGENT TEAMS (colaboracion real)
Para proyectos donde los agentes necesitan hablarse entre si y compartir
una lista de tareas, Claude Code tiene agent teams: agentes con task list
compartida que se coordinan solos. Mas potente, mas costoso en tokens.

## Cuando usar que:
| Necesidad | Usa |
|---|---|
| Tarea puntual aislada | 1 subagente |
| Varias tareas independientes | Subagentes en paralelo |
| Tarea larga mientras haces otra cosa | Subagente en background |
| Agentes que deben coordinarse entre si | Agent team |

**Siguiente nivel:** los 5 patrones de diseno -> `/moragent aprender patterns`""",

    "patterns": """# Patrones de Orquestacion — Los 5 disenos que debes conocer

Basados en "Building Effective Agents" (Anthropic). De simple a complejo:

## 1. PIPELINE (secuencial)
La salida de un paso alimenta al siguiente. Gates de validacion entre medio.
```
brief -> [investigar] -> ok? -> [redactar] -> ok? -> [formatear] -> entrega
```
**Usalo cuando:** el orden importa y cada paso depende del anterior.
Ej: investigar -> escribir -> editar -> publicar.

## 2. ROUTING (clasificar y derivar)
Un clasificador liviano dirige cada input al flujo especializado.
```
input -> [router (haiku)] -+-> consulta simple -> respuesta directa
                           +-> bug complejo   -> agente senior
                           +-> factura        -> flujo administrativo
```
**Usalo cuando:** recibes inputs de tipos distintos que requieren
tratamientos distintos. Router barato, especialistas potentes.

## 3. PARALELIZACION (fan-out / fan-in)
Subtareas independientes corren a la vez; un paso final consolida.
```
        +-> [agente: capitulo 1] -+
tarea --+-> [agente: capitulo 2] -+-> [consolidar] -> entrega
        +-> [agente: capitulo 3] -+
```
Dos variantes:
- **Seccionar:** dividir el trabajo (cada uno hace una parte)
- **Votar:** varios agentes hacen LO MISMO y se comparan resultados
  (ideal para verificacion: 3 revisores independientes > 1)
**Usalo cuando:** las subtareas NO dependen entre si.

## 4. ORCHESTRATOR-WORKERS (el mas usado)
Un orquestador descompone el problema EN VIVO, delega y sintetiza.
A diferencia del pipeline, los pasos no estan predefinidos.
```
tarea -> [orquestador] -> analiza y decide
              |
      +-------+-------+
      v       v       v
  [worker] [worker] [worker]
      +-------+-------+
              v
        [orquestador sintetiza]
```
**Usalo cuando:** no sabes de antemano cuantas subtareas habra
(ej: "migra todos los archivos que usen la API vieja").

## 5. EVALUATOR-OPTIMIZER (generar + criticar)
Un agente genera, otro evalua contra criterios claros, y se itera.
```
[generador] -> borrador -> [evaluador] -> feedback -> [generador] -> v2 -> ... -> aprobado
```
**Usalo cuando:** la calidad importa mas que la velocidad.
Ej: propuestas a clientes, posts publicos, codigo critico.

## Regla practica
Empieza SIEMPRE con el patron mas simple que funcione.
Pipeline > agregar routing si hay tipos distintos > paralelizar si hay
independencia > orchestrator-workers si la descomposicion es dinamica >
evaluator-optimizer como gate de calidad al final de cualquiera.""",

    "skills": """# Skills — Procedimientos Reutilizables

Una skill = una receta: ingredientes, pasos, resultado.

## Sin skill (50+ palabras cada vez):
"Oye, necesito que vayas a la base de datos del cliente, busques el schema
de ventas, corras el run_etl.bat..."

## Con skill (4 palabras):
/etl-run ClienteX W14

## Formato moderno (carpeta + SKILL.md):
```
.claude/skills/
  etl-run/
    SKILL.md        <- la receta
    referencias/    <- (opcional) archivos de apoyo que la skill usa
```

## Anatomia de SKILL.md:
```
---
name: etl-run
description: Corre el ETL semanal de un cliente
---
## Pasos
1. Identificar cliente
2. Verificar config
3. Ejecutar el script semanal
4. Validar resultado
## Output
Filas cargadas, tiempo, warnings
```

Nota: `.claude/commands/nombre.md` (un solo archivo) sigue funcionando,
pero el formato carpeta permite adjuntar recursos y es el estandar actual.

## Distincion clave:
- **Agente** = QUIEN hace el trabajo (el chef)
- **Skill** = COMO se hace (la receta)
- **Memoria** = QUE aprendio haciendolo (experiencia)
- **CLAUDE.md** = En QUE restaurante trabaja (contexto)""",

    "context": """# Memoria, CLAUDE.md y Contexto — Las capas del sistema

```
+--------------------------------------------------+
|  CLAUDE.md (raiz)                                 |
|  Contexto GLOBAL. Todos los agentes lo leen.      |
|                                                    |
|  +--------------------------------------------+   |
|  |  CLAUDE.md (por proyecto)                   |   |
|  |  Contexto de PROYECTO. Solo en esa carpeta. |   |
|  |                                              |   |
|  |  +--------------------------------------+   |   |
|  |  |  agent-memory/MEMORY.md              |   |   |
|  |  |  Contexto del AGENTE.                |   |   |
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

**Por eso nunca necesitas repetir instrucciones.**

## La ventana de contexto (y por que importa)
El contexto es la memoria de trabajo del modelo: TODO lo que ve ahora.
- Se llena con la conversacion, archivos leidos, resultados de tools
- Cuando crece demasiado, Claude Code lo COMPACTA (resume lo viejo)
- Contexto saturado = respuestas peores y mas caras

## Higiene de contexto:
- Delega trabajo pesado a subagentes (usan SU contexto, no el tuyo)
- CLAUDE.md corto: solo lo que TODOS necesitan saber siempre
- Lo que es de un agente, a su memoria; lo que es de un proyecto, a su carpeta""",

    "automation": """# Automatizacion — Triggers, Hooks y Headless

## TRIGGER = tarea programada en la nube
Como un despertador. Corre solo a horas fijas, sin tu PC encendida.
- "Todos los dias a las 7:30AM, enviame el briefing por Slack"
- Se crean con /schedule en Claude Code
- Soporta: horario recurrente, ejecucion unica, disparo por API o GitHub

## HOOK = reaccion automatica a un evento de la sesion
Como una alarma de seguridad. Algo pasa y se activa. Corre local.
Eventos principales:
| Evento | Cuando dispara |
|---|---|
| SessionStart | Al abrir una sesion |
| UserPromptSubmit | Al enviar tu cada prompt |
| PreToolUse / PostToolUse | Antes/despues de cada tool |
| Stop | Cuando Claude termina su turno |
| SubagentStop | Cuando termina un subagente |
| PreCompact | Antes de compactar el contexto |

Se configuran en `.claude/settings.json` (o en hooks/ de un plugin).

## HEADLESS = Claude Code sin interfaz
`claude -p "corre el ETL y reporta"` — para scripts, cron y CI/CD.
Es el pegamento entre Claude y cualquier automatizacion externa.

## Diferencia clave:
- Trigger: CUANDO -> a las 7:30AM todos los dias (nube)
- Hook: SI -> si corre un ETL, loguearlo (local, reactivo)
- Headless: DESDE AFUERA -> otro sistema invoca a Claude""",

    "plugins": """# Plugins, Marketplace y MCP

Un agente sin conexiones solo lee/escribe archivos.
Con MCP y plugins, accede a servicios reales y gana capacidades.

## MCP (Model Context Protocol)
Conectores a servicios externos. Se configuran en .mcp.json o claude.ai.
- Gmail: leer emails, crear borradores
- Slack: enviar/leer mensajes
- Asana / Notion / Calendar: gestion y documentacion
- Bases de datos: queries directas

## PLUGIN = paquete distribuible
Un plugin agrupa en una unidad instalable:
```
mi-plugin/
  .claude-plugin/plugin.json   <- manifiesto (nombre, version)
  skills/                      <- skills que aporta
  agents/                      <- agentes que aporta
  hooks/hooks.json             <- hooks que aporta
  .mcp.json                    <- servidores MCP que aporta
```
MORAGENT es exactamente esto: un plugin con servidor MCP + skill + hooks.

## MARKETPLACE
Instalar plugins directo desde un repo git:
```
/plugin marketplace add usuario/repo
/plugin install nombre
```
Publicar el tuyo = subir un repo con la estructura de arriba a GitHub.

## Como agregar conexiones:
- MCP remoto: claude.ai/settings/connectors
- MCP local: claude mcp add (o editar .mcp.json)
- Plugin: /plugin marketplace add usuario/repo""",

    "example": None,  # Generated dynamically — see moragent_learn()
},
"en": {
    "architecture": """# Agentic AI Architecture — How everything connects

Picture a company:
- **CLAUDE.md** = Onboarding manual (everyone reads it)
- **.claude/agents/** = Specialized employees
- **.claude/skills/** = SOPs / procedure manuals (skills/name/SKILL.md)
- **.claude/agent-memory/** = Accumulated experience
- **Triggers (/schedule)** = Automatic tasks (alarm clock)
- **Hooks** = Reactive alarms (if X happens, do Y)
- **MCP / Plugins** = Office tools (Gmail, Slack, Asana...)

## Flow of a task:
```
You: "I need the week 14 sales report"
  |
  v
Orchestrator (your session + CLAUDE.md): decides which agents to launch
  |
  +-> data-analyst: extracts SQL data (reads its MEMORY.md)
  |     returns: metrics and data
  +-> developer: generates HTML + Excel (reads its MEMORY.md)
  |     returns: files
  v
Orchestrator: consolidates and delivers everything
```

Each agent reads 4 layers of context:
1. CLAUDE.md (root) — company context
2. CLAUDE.md (project folder) — project context
3. agents/*.md — its identity (the `description:` drives delegation)
4. agent-memory/ — its experience

**Golden rule:** the orchestrator delegates and consolidates; specialists execute.""",

    "orchestration": """# Orchestration — How agents work in Claude Code today

## SUBAGENTS (the foundation)
A subagent is an agent your main session spawns for one task.
It runs in its OWN context (doesn't pollute yours) and returns only the result.

```
You --> Orchestrator (main session)
          |
     +----+----+
     |         |
  analyst   developer     <- run IN PARALLEL when tasks
     |         |             are independent
  result    result
     +----+----+
          |
     Orchestrator consolidates
```

- Defined in `.claude/agents/name.md`
- The frontmatter `description:` field is KEY: Claude uses it to decide
  when to auto-delegate work to that agent
- They can run in parallel (several at once) or in the background
  (they keep working while you do something else)

## AGENT TEAMS (real collaboration)
For projects where agents need to talk to each other and share a task
list, Claude Code has agent teams: agents with a shared task list that
coordinate on their own. More powerful, more token-expensive.

## When to use what:
| Need | Use |
|---|---|
| One isolated task | 1 subagent |
| Several independent tasks | Parallel subagents |
| Long task while you do other things | Background subagent |
| Agents that must coordinate with each other | Agent team |

**Next level:** the 5 design patterns -> `/moragent learn patterns`""",

    "patterns": """# Orchestration Patterns — The 5 designs you must know

Based on Anthropic's "Building Effective Agents". From simple to complex:

## 1. PIPELINE (sequential)
Each step's output feeds the next. Validation gates in between.
```
brief -> [research] -> ok? -> [write] -> ok? -> [format] -> deliver
```
**Use it when:** order matters and each step depends on the previous one.
E.g.: research -> write -> edit -> publish.

## 2. ROUTING (classify and dispatch)
A lightweight classifier directs each input to the right specialized flow.
```
input -> [router (haiku)] -+-> simple question -> direct answer
                           +-> complex bug     -> senior agent
                           +-> invoice         -> admin flow
```
**Use it when:** you receive different input types needing different
treatment. Cheap router, powerful specialists.

## 3. PARALLELIZATION (fan-out / fan-in)
Independent subtasks run at once; a final step consolidates.
```
        +-> [agent: chapter 1] -+
task  --+-> [agent: chapter 2] -+-> [consolidate] -> deliver
        +-> [agent: chapter 3] -+
```
Two flavors:
- **Sectioning:** split the work (each does one part)
- **Voting:** several agents do THE SAME thing and results are compared
  (great for verification: 3 independent reviewers > 1)
**Use it when:** subtasks do NOT depend on each other.

## 4. ORCHESTRATOR-WORKERS (the most used)
An orchestrator decomposes the problem ON THE FLY, delegates, synthesizes.
Unlike a pipeline, the steps aren't predefined.
```
task -> [orchestrator] -> analyzes and decides
              |
      +-------+-------+
      v       v       v
  [worker] [worker] [worker]
      +-------+-------+
              v
        [orchestrator synthesizes]
```
**Use it when:** you don't know upfront how many subtasks there will be
(e.g.: "migrate every file using the old API").

## 5. EVALUATOR-OPTIMIZER (generate + critique)
One agent generates, another evaluates against clear criteria, iterate.
```
[generator] -> draft -> [evaluator] -> feedback -> [generator] -> v2 -> ... -> approved
```
**Use it when:** quality matters more than speed.
E.g.: client proposals, public posts, critical code.

## Practical rule
ALWAYS start with the simplest pattern that works.
Pipeline > add routing if input types differ > parallelize when independent >
orchestrator-workers when decomposition is dynamic > evaluator-optimizer
as the quality gate at the end of any of them.""",

    "skills": """# Skills — Reusable Procedures

A skill = a recipe: ingredients, steps, result.

## Without a skill (50+ words every time):
"Hey, I need you to go to the client's database, find the sales schema,
run the run_etl.bat..."

## With a skill (4 words):
/etl-run ClientX W14

## Modern format (folder + SKILL.md):
```
.claude/skills/
  etl-run/
    SKILL.md        <- the recipe
    references/     <- (optional) support files the skill uses
```

## Anatomy of SKILL.md:
```
---
name: etl-run
description: Runs a client's weekly ETL
---
## Steps
1. Identify the client
2. Verify config
3. Run the weekly script
4. Validate results
## Output
Rows loaded, time, warnings
```

Note: `.claude/commands/name.md` (single file) still works, but the
folder format allows attaching resources and is today's standard.

## Key distinction:
- **Agent** = WHO does the work (the chef)
- **Skill** = HOW it's done (the recipe)
- **Memory** = WHAT was learned doing it (experience)
- **CLAUDE.md** = WHICH restaurant they work at (context)""",

    "context": """# Memory, CLAUDE.md and Context — The system's layers

```
+--------------------------------------------------+
|  CLAUDE.md (root)                                 |
|  GLOBAL context. All agents read it.              |
|                                                    |
|  +--------------------------------------------+   |
|  |  CLAUDE.md (per project)                    |   |
|  |  PROJECT context. Only in that folder.      |   |
|  |                                              |   |
|  |  +--------------------------------------+   |   |
|  |  |  agent-memory/MEMORY.md              |   |   |
|  |  |  AGENT context.                      |   |   |
|  |  +--------------------------------------+   |   |
|  +--------------------------------------------+   |
+--------------------------------------------------+
```

When an agent activates, it reads in order:
1. CLAUDE.md (root) — company context
2. CLAUDE.md (folder) — project context
3. agents/*.md — its identity and role
4. agent-memory/ — its prior experience
5. Your prompt — what you're asking now

**That's why you never need to repeat instructions.**

## The context window (and why it matters)
Context is the model's working memory: EVERYTHING it sees right now.
- It fills up with conversation, files read, tool results
- When it grows too much, Claude Code COMPACTS it (summarizes the old)
- Saturated context = worse, more expensive answers

## Context hygiene:
- Delegate heavy work to subagents (they use THEIR context, not yours)
- Keep CLAUDE.md short: only what EVERYONE always needs to know
- Agent-specific info goes to its memory; project info to its folder""",

    "automation": """# Automation — Triggers, Hooks and Headless

## TRIGGER = scheduled task in the cloud
Like an alarm clock. Runs on its own at set times, no PC needed.
- "Every day at 7:30AM, send me the briefing on Slack"
- Created with /schedule in Claude Code
- Supports: recurring schedule, one-off runs, API or GitHub triggers

## HOOK = automatic reaction to a session event
Like a security alarm. Something happens and it fires. Runs locally.
Main events:
| Event | When it fires |
|---|---|
| SessionStart | When a session opens |
| UserPromptSubmit | On every prompt you send |
| PreToolUse / PostToolUse | Before/after each tool |
| Stop | When Claude finishes its turn |
| SubagentStop | When a subagent finishes |
| PreCompact | Before compacting context |

Configured in `.claude/settings.json` (or a plugin's hooks/).

## HEADLESS = Claude Code without UI
`claude -p "run the ETL and report"` — for scripts, cron and CI/CD.
It's the glue between Claude and any external automation.

## Key difference:
- Trigger: WHEN -> at 7:30AM every day (cloud)
- Hook: IF -> if an ETL runs, log it (local, reactive)
- Headless: FROM OUTSIDE -> another system invokes Claude""",

    "plugins": """# Plugins, Marketplace and MCP

An agent without connections only reads/writes files.
With MCP and plugins, it reaches real services and gains capabilities.

## MCP (Model Context Protocol)
Connectors to external services. Configured in .mcp.json or claude.ai.
- Gmail: read emails, create drafts
- Slack: send/read messages
- Asana / Notion / Calendar: management and documentation
- Databases: direct queries

## PLUGIN = distributable package
A plugin bundles into one installable unit:
```
my-plugin/
  .claude-plugin/plugin.json   <- manifest (name, version)
  skills/                      <- skills it provides
  agents/                      <- agents it provides
  hooks/hooks.json             <- hooks it provides
  .mcp.json                    <- MCP servers it provides
```
MORAGENT is exactly this: a plugin with MCP server + skill + hooks.

## MARKETPLACE
Install plugins straight from a git repo:
```
/plugin marketplace add user/repo
/plugin install name
```
Publishing yours = pushing a repo with the structure above to GitHub.

## How to add connections:
- Remote MCP: claude.ai/settings/connectors
- Local MCP: claude mcp add (or edit .mcp.json)
- Plugin: /plugin marketplace add user/repo""",

    "example": None,  # Generated dynamically — see moragent_learn()
},
}

# ══════════════════════════════════════════════════════════════════════════════
# TOOLS — CORE
# ══════════════════════════════════════════════════════════════════════════════

@mcp.tool()
def moragent_language(lang: str = "") -> str:
    """Get or set MORAGENT's language. Call with no args to check the current language;
    call with "es" (Spanish) or "en" (English) to switch. The setting persists in
    .claude/moragent.json and all MORAGENT tools respect it.

    Args:
        lang: Target language — "es" or "en" (also accepts espanol/spanish/english/ingles). Empty = just report.
    """
    normalized = lang.strip().lower()
    aliases = {
        "es": "es", "espanol": "es", "español": "es", "spanish": "es", "castellano": "es",
        "en": "en", "english": "en", "ingles": "en", "inglés": "en",
    }
    if not normalized:
        current = _get_lang()
        name = "Espanol" if current == "es" else "English"
        return (f"{WORDMARK}\n\n"
                + _t(f"**Idioma actual:** {name} (`{current}`)\n\nPara cambiar: `moragent_language(\"en\")` o pide \"switch to English\".",
                     f"**Current language:** {name} (`{current}`)\n\nTo switch: `moragent_language(\"es\")` or ask \"cambiar a espanol\".")
                + "\n\nIMPORTANT for Claude: respond to MORAGENT interactions in this language.")
    if normalized not in aliases:
        return f"Error: unknown language '{lang}'. Valid: es, en."
    target = aliases[normalized]
    _set_lang(target)
    if target == "es":
        return (f"{WORDMARK}\n\nListo — MORAGENT ahora habla **Espanol**.\n"
                "Menu, lecciones, glosario y plantillas quedan en espanol.\n\n"
                "IMPORTANT for Claude: from now on, respond to MORAGENT interactions in Spanish.")
    return (f"{WORDMARK}\n\nDone — MORAGENT now speaks **English**.\n"
            "Menu, lessons, glossary and templates switch to English.\n\n"
            "IMPORTANT for Claude: from now on, respond to MORAGENT interactions in English.")


@mcp.tool()
def moragent_status() -> str:
    """Dashboard of your agentic AI infrastructure — agents, skills, memories, projects, and config files."""
    agents = _scan_agents()
    skills = _scan_skills()
    memories = _scan_memories()
    projects = _scan_project_folders()
    ws = _cwd()
    lang_name = "Espanol" if _get_lang() == "es" else "English"

    lines = [_hdr("Dashboard de Infraestructura", "Infrastructure Dashboard")]
    lines.append(f"```\n{LOGO}\n{TAGLINE} · {lang_name}\n```\n")

    lines.append(_t("## Agentes", "## Agents"))
    lines.append(_t("| Nombre | Modelo | Alcance | Memoria |", "| Name | Model | Scope | Memory |"))
    lines.append("|------|-------|-------|--------|")
    for a in agents:
        m = next((x for x in memories if x["agent"] == a["name"]), None)
        ms = f"{m['lines']}L" if m and m["has_memory"] and m["lines"] > 0 else _t("vacia", "empty")
        lines.append(f"| {a['name']} | {a['model']} | {a['scope']} | {ms} |")
    if not agents:
        lines.append(_t("| _(sin agentes aun)_ | | | |", "| _(no agents yet)_ | | | |"))

    lines.append(_t("\n## Skills", "\n## Skills"))
    lines.append(_t("| Comando | Tipo | Descripcion |", "| Command | Kind | Description |"))
    lines.append("|---------|------|-------------|")
    for s in skills:
        lines.append(f"| /{s['name']} | {s['kind']} | {s['description'][:60]} |")
    if not skills:
        lines.append(_t("| _(sin skills aun)_ | | |", "| _(no skills yet)_ | | |"))

    lines.append(_t("\n## Proyectos con CLAUDE.md", "\n## Projects with CLAUDE.md"))
    for p in projects:
        lines.append(f"- **{p['name']}/** — {p['title']}")
    if not projects:
        lines.append(_t("- _(sin proyectos aun)_", "- _(no projects yet)_"))

    lines.append(_t("\n## Archivos de infraestructura", "\n## Infrastructure files"))
    for f in ["CLAUDE.md", ".mcp.json", ".env"]:
        status = "OK" if (ws / f).exists() else _t("FALTA", "MISSING")
        lines.append(f"- {f}: **{status}**")

    lines.append(_t(
        f"\n**Total:** {len(agents)} agentes, {len(skills)} skills, "
        f"{sum(1 for m in memories if m['has_memory'] and m['lines']>0)} memorias, "
        f"{len(projects)} proyectos",
        f"\n**Total:** {len(agents)} agents, {len(skills)} skills, "
        f"{sum(1 for m in memories if m['has_memory'] and m['lines']>0)} memories, "
        f"{len(projects)} projects"))
    return "\n".join(lines)


@mcp.tool()
def moragent_glossary(term: str = "") -> str:
    """Explain agentic AI concepts (25 terms, bilingual). Pass a term (Agent, Skill, MCP, Pipeline...)
    or leave empty to list all terms in the configured language."""
    lang = _get_lang()
    glossary = GLOSSARY[lang]
    labels = GLOSSARY_LABELS[lang]

    def render(t: str) -> str:
        g = glossary[t]
        return (f"{_hdr(t, t)}\n**{labels['what']}:** {g['what']}\n**{labels['analogy']}:** {g['analogy']}\n"
                f"**{labels['where']}:** {g['where']}\n**{labels['tip']}:** {g['tip']}")

    if term:
        # Exact match in current language
        if term in glossary:
            return render(term)
        # Partial match in current language
        matches = [k for k in glossary if term.lower() in k.lower()]
        if matches:
            return render(matches[0])
        # Cross-language lookup (e.g. asking "Agent" while in Spanish)
        other = "en" if lang == "es" else "es"
        other_matches = [k for k in GLOSSARY[other] if term.lower() in k.lower()]
        if other_matches:
            idx = list(GLOSSARY[other].keys()).index(other_matches[0])
            local_key = list(glossary.keys())[idx]
            return render(local_key)
        return _t(f"Termino '{term}' no encontrado. Disponibles: {', '.join(sorted(glossary.keys()))}",
                  f"Term '{term}' not found. Available: {', '.join(sorted(glossary.keys()))}")

    lines = [_hdr("Glosario — 25 conceptos de IA agentica", "Glossary — 25 agentic AI concepts") ]
    for t in glossary:
        g = glossary[t]
        lines.append(f"## {t}\n- **{labels['what']}:** {g['what']}\n- **{labels['analogy']}:** {g['analogy']}\n- **{labels['where']}:** {g['where']}\n- **{labels['tip']}:** {g['tip']}\n")
    return "\n".join(lines)


def _generate_dynamic_example() -> str:
    """Generate a real example based on the user's actual workspace."""
    projects = _scan_project_folders()
    agents = _scan_agents()
    skills = _scan_skills()

    etl_project = next((p for p in projects if p.get("has_etl")), None)
    proj = etl_project or (projects[0] if projects else None)

    if proj:
        proj_name = proj["name"]
        proj_title = proj.get("title", proj_name)
        agent_names = [a["name"] for a in agents[:2]] if agents else ["data-analyst", "developer"]
        skill_names = [f"/{s['name']}" for s in skills[:2]] if skills else ["/my-skill"]
        second_agent_es = f'''## PASO 4: Lanza agente "{agent_names[1]}" (subagente)
- Trabaja en paralelo o secuencial segun el patron elegido
- Tambien lee su identidad + memoria
- Devuelve su parte''' if len(agent_names) > 1 else ''
        second_agent_en = f'''## STEP 4: Launches agent "{agent_names[1]}" (subagent)
- Works in parallel or sequentially depending on the chosen pattern
- Also reads its identity + memory
- Returns its part''' if len(agent_names) > 1 else ''

        return _t(f"""# Ejemplo Real — Basado en TU workspace

## Tu proyecto: {proj_name}/ ({proj_title})

## PASO 1: Das la instruccion
"Necesito procesar los datos de {proj_name}"
{f'(o usando skill: {skill_names[0]} {proj_name})' if skills else ''}

## PASO 2: El orquestador lee contexto
- CLAUDE.md (raiz) -> sabe que proyectos existen y como se conectan
- {proj_name}/CLAUDE.md -> sabe la config especifica del proyecto
- Decide que agentes lanzar y con que patron (pipeline? paralelo?)

## PASO 3: Lanza agente "{agent_names[0]}" (subagente)
- Lee su identidad en agents/{agent_names[0]}.md
- Lee su experiencia en agent-memory/{agent_names[0]}/MEMORY.md
- Ejecuta su parte -> devuelve resultado al orquestador

{second_agent_es}

## PASO 5: El orquestador consolida
- Recibe resultados de todos los subagentes
- Los combina en un output coherente
- Te entrega todo listo

## Por que funciona:
- Los agentes YA SABEN como trabajar (tienen memoria)
- No necesitas repetir instrucciones (CLAUDE.md las tiene)
- Cada agente se enfoca en lo suyo (contextos separados)
- Si algo falla, solo se relanza ese agente (no todo)

## Tu infraestructura actual:
- {len(agents)} agentes listos para trabajar
- {len(skills)} skills invocables con /nombre
- {len(projects)} proyectos con CLAUDE.md
""", f"""# Real Example — Based on YOUR workspace

## Your project: {proj_name}/ ({proj_title})

## STEP 1: You give the instruction
"I need to process the {proj_name} data"
{f'(or using a skill: {skill_names[0]} {proj_name})' if skills else ''}

## STEP 2: The orchestrator reads context
- CLAUDE.md (root) -> knows which projects exist and how they connect
- {proj_name}/CLAUDE.md -> knows the project's specific config
- Decides which agents to launch and with which pattern (pipeline? parallel?)

## STEP 3: Launches agent "{agent_names[0]}" (subagent)
- Reads its identity in agents/{agent_names[0]}.md
- Reads its experience in agent-memory/{agent_names[0]}/MEMORY.md
- Executes its part -> returns the result to the orchestrator

{second_agent_en}

## STEP 5: The orchestrator consolidates
- Receives results from all subagents
- Combines them into one coherent output
- Delivers everything ready

## Why it works:
- Agents ALREADY KNOW how to work (they have memory)
- You never repeat instructions (CLAUDE.md holds them)
- Each agent focuses on its part (separate contexts)
- If something fails, only that agent is relaunched (not everything)

## Your current infrastructure:
- {len(agents)} agents ready to work
- {len(skills)} skills invocable with /name
- {len(projects)} projects with CLAUDE.md
""")
    return _t("""# Ejemplo — Como funcionaria tu primer proyecto

## PASO 1: Creas el proyecto
/moragent nuevo proyecto "Dashboard de ventas para mi equipo"

## PASO 2: MORAGENT advisor analiza y recomienda
- Escanea si ya tienes agentes utiles
- Sugiere: 2 agentes (data-analyst + developer) y el patron de orquestacion
- Te pregunta: "Quieres que lo cree?"

## PASO 3: Scaffold crea todo
```
mi-proyecto/
    ├── CLAUDE.md               <- contexto del proyecto
    ├── .claude/agents/         <- agentes creados
    └── .claude/agent-memory/   <- memoria vacia (se llenara)
```

## PASO 4: Trabajas
"Genera el dashboard con datos del CSV de ventas"
- El orquestador delega al agente correcto
- El agente lee su CLAUDE.md, su memoria, y ejecuta
- Te entrega el resultado

## PASO 5: La memoria crece
Cada vez que un agente trabaja, aprende.
La proxima vez lo hace mejor y mas rapido.
""", """# Example — How your first project would work

## STEP 1: You create the project
/moragent new project "Sales dashboard for my team"

## STEP 2: MORAGENT advisor analyzes and recommends
- Scans whether you already have useful agents
- Suggests: 2 agents (data-analyst + developer) and the orchestration pattern
- Asks you: "Want me to create it?"

## STEP 3: Scaffold creates everything
```
my-project/
    ├── CLAUDE.md               <- project context
    ├── .claude/agents/         <- created agents
    └── .claude/agent-memory/   <- empty memory (it will fill up)
```

## STEP 4: You work
"Generate the dashboard from the sales CSV"
- The orchestrator delegates to the right agent
- The agent reads its CLAUDE.md, its memory, and executes
- Delivers the result

## STEP 5: Memory grows
Every time an agent works, it learns.
Next time it does it better and faster.
""")


@mcp.tool()
def moragent_learn(topic: str = "architecture") -> str:
    """Interactive lessons on agentic AI (bilingual).
    Topics: architecture, orchestration, patterns, skills, context, automation, plugins, example."""
    lang = _get_lang()
    content = LEARN_CONTENT[lang]
    if topic == "example":
        return _generate_dynamic_example()
    if topic in content and content[topic] is not None:
        return content[topic]
    return _t(f"Temas disponibles: {', '.join(content.keys())}",
              f"Available topics: {', '.join(content.keys())}")


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
    """Create a new specialized AI subagent with identity, memory, and role definition.
    The generated frontmatter includes `description` (required by Claude Code for auto-delegation).

    Args:
        name: Agent name in kebab-case (e.g., data-analyst)
        role: What this agent does — becomes the frontmatter description (e.g., "Extracts and analyzes SQL data")
        model: LLM model — haiku (fast/cheap), sonnet (workhorse), opus/fable (deep reasoning), inherit (session model)
        scope: project (this workspace) or user (all projects)
        expertise: List of expertise areas
        tools: List of tools the agent can use
        team_ready: If true, agent gets team collaboration notes
        overwrite: If true, replace existing agent file (useful for enriching scaffolded agents)
    """
    name = name.lower().strip().replace(" ", "-")
    if not name:
        return _t("Error: el nombre del agente no puede estar vacio.", "Error: Agent name cannot be empty.")
    if model not in VALID_MODELS:
        return f"Error: Invalid model '{model}'. Valid options: {', '.join(sorted(VALID_MODELS))}"
    if scope not in ("project", "user"):
        return f"Error: Invalid scope '{scope}'. Valid options: project, user"

    lang = _get_lang()
    display = name.replace("-", " ").title()
    exp = "\n".join(f"- {e}" for e in (expertise or [role]))
    tls = "\n".join(f"- {t}" for t in (tools or ["Bash", "Read", "Write", "Edit", "Glob", "Grep"]))
    extra = _t("- Puede coordinarse con otros agentes del equipo\n- Notificar al orquestador al terminar",
               "- Can coordinate with other team agents\n- Notify the orchestrator when done") if team_ready else ""

    content = AGENT_TPL[lang].format(name=name, model=model, color=_next_color(),
        display=display, description=role, role=role, expertise=exp, tools=tls, extra=extra)

    d = _agents_dir() if scope == "project" else _user_agents()
    d.mkdir(parents=True, exist_ok=True)
    f = d / f"{name}.md"
    if f.exists() and not overwrite:
        return _t(f"El agente {name} ya existe en {f}. Usa overwrite=true para reemplazarlo, o elige otro nombre.",
                  f"Agent {name} already exists at {f}. Use overwrite=true to replace it, or use a different name.")
    f.write_text(content, encoding="utf-8")

    md = _memory_dir() / name
    md.mkdir(parents=True, exist_ok=True)
    mf = md / "MEMORY.md"
    if not mf.exists():
        mf.write_text(_t(f"# {display} — Memoria Persistente\n\n## Proyectos\n(se llena automaticamente)\n\n## Aprendizajes\n(se llena automaticamente)\n",
                         f"# {display} — Persistent Memory\n\n## Projects\n(fills automatically)\n\n## Lessons\n(fills automatically)\n"), encoding="utf-8")

    return (_hdr(f"Agente creado: {name}", f"Agent created: {name}") + "\n"
            + _t(f"- **Archivo:** .claude/agents/{name}.md\n"
                 f"- **Memoria:** .claude/agent-memory/{name}/MEMORY.md\n"
                 f"- **Modelo:** {model}\n- **Alcance:** {scope}\n- **Team-ready:** {'si' if team_ready else 'no'}\n\n"
                 f"Para usarlo: *\"Usa el agente {name} para...\"*",
                 f"- **File:** .claude/agents/{name}.md\n"
                 f"- **Memory:** .claude/agent-memory/{name}/MEMORY.md\n"
                 f"- **Model:** {model}\n- **Scope:** {scope}\n- **Team-ready:** {'yes' if team_ready else 'no'}\n\n"
                 f"To use it: *\"Use the {name} agent to...\"*"))


@mcp.tool()
def moragent_create_skill(
    name: str,
    description: str,
    steps: list[str],
    arguments: str = "context parameters",
    output: str = "(define output)",
    overwrite: bool = False,
) -> str:
    """Create a reusable skill invocable with /name, in the modern SKILL.md format
    (.claude/skills/<name>/SKILL.md).

    Args:
        name: Skill name in kebab-case (invoked as /name)
        description: What the skill does (one line)
        steps: List of steps the skill follows
        arguments: What arguments the skill receives
        output: What the skill delivers
        overwrite: If true, replace existing skill file
    """
    name = name.lower().strip().replace(" ", "-")
    if not name:
        return _t("Error: el nombre de la skill no puede estar vacio.", "Error: Skill name cannot be empty.")
    lang = _get_lang()
    display = name.replace("-", " ").title()
    steps_md = "\n".join(f"{i+1}. {s}" for i, s in enumerate(steps))

    content = SKILL_TPL[lang].format(name=name, display=display, description=description,
        args=arguments, steps=steps_md, output=output)

    skill_dir = _skills_dir() / name
    skill_dir.mkdir(parents=True, exist_ok=True)
    f = skill_dir / "SKILL.md"
    legacy = _skills_dir() / f"{name}.md"
    if (f.exists() or legacy.exists()) and not overwrite:
        return _t(f"La skill /{name} ya existe. Usa overwrite=true para reemplazarla, o elige otro nombre.",
                  f"Skill /{name} already exists. Use overwrite=true to replace it, or use a different name.")
    f.write_text(content, encoding="utf-8")

    return (_hdr(f"Skill creada: /{name}", f"Skill created: /{name}") + "\n"
            + _t(f"- **Archivo:** .claude/skills/{name}/SKILL.md\n"
                 f"- **Invocar:** `/{name} [argumentos]`\n- **Pasos:** {len(steps)}\n\n"
                 f"La skill ya esta disponible en Claude Code.",
                 f"- **File:** .claude/skills/{name}/SKILL.md\n"
                 f"- **Invoke:** `/{name} [arguments]`\n- **Steps:** {len(steps)}\n\n"
                 f"The skill is now available in Claude Code."))


@mcp.tool()
def moragent_scaffold_project(
    project_name: str,
    description: str,
    folder: str = "",
    orchestration: str = "orchestrator",
    agents: list[dict] | None = None,
    skills: list[dict] | None = None,
    mcps: list[str] | None = None,
) -> str:
    """Scaffold a complete agentic AI project with CLAUDE.md, agents, skills, and memory.

    Args:
        project_name: Name of the project
        description: What the project does
        folder: Folder name (auto-generated from project_name if empty)
        orchestration: Orchestration pattern — pipeline, parallel, orchestrator, evaluator, router, hybrid
        agents: List of agents [{"name":"x","model":"sonnet","role":"..."}]
        skills: List of skills [{"name":"x","description":"..."}]
        mcps: List of MCP connections needed
    """
    if not project_name.strip():
        return _t("Error: el nombre del proyecto no puede estar vacio.", "Error: Project name cannot be empty.")
    orchestration = LEGACY_ORCHESTRATIONS.get(orchestration, orchestration)
    if orchestration not in VALID_ORCHESTRATIONS:
        return f"Error: Invalid orchestration '{orchestration}'. Valid options: {', '.join(sorted(VALID_ORCHESTRATIONS))}"

    lang = _get_lang()
    folder = folder or project_name.lower().replace(" ", "-")[:30]
    target = _cwd() / folder
    target.mkdir(exist_ok=True)
    agents = agents or []
    skills = skills or []
    mcps = mcps or []

    orch_desc = {
        "es": {
            "pipeline": "Pipeline secuencial: cada paso alimenta al siguiente, con gates de validacion entre medio.",
            "parallel": "Paralelizacion: subagentes independientes corren a la vez y un paso final consolida.",
            "orchestrator": "Orchestrator-workers: el orquestador descompone el problema, delega a agentes especializados y sintetiza.",
            "evaluator": "Evaluator-optimizer: un agente genera, otro critica contra criterios claros, y se itera hasta pasar el gate.",
            "router": "Routing: un clasificador liviano dirige cada input al agente o flujo especializado correcto.",
            "hybrid": "Hibrido: combina patrones — p.ej. orchestrator-workers para el grueso + evaluator-optimizer como gate final.",
        },
        "en": {
            "pipeline": "Sequential pipeline: each step feeds the next, with validation gates in between.",
            "parallel": "Parallelization: independent subagents run at once and a final step consolidates.",
            "orchestrator": "Orchestrator-workers: the orchestrator decomposes the problem, delegates to specialized agents, synthesizes.",
            "evaluator": "Evaluator-optimizer: one agent generates, another critiques against clear criteria, iterating until the gate passes.",
            "router": "Routing: a lightweight classifier directs each input to the right specialized agent or flow.",
            "hybrid": "Hybrid: combines patterns — e.g. orchestrator-workers for the bulk + evaluator-optimizer as the final gate.",
        },
    }

    agents_md = "\n".join(f"- `{a['name']}` ({a.get('model','sonnet')}) — {a.get('role','')}" for a in agents)
    skills_md = "\n".join(f"- `/{s['name']}` — {s.get('description','')}" for s in skills)
    mcps_md = "\n".join(f"- {m}" for m in mcps)
    none_yet = _t("(aun nada)", "(none yet)")

    claude_content = f"""# {project_name}

## Overview
- **{_t('Descripcion', 'Description')}:** {description}
- **{_t('Orquestacion', 'Orchestration')}:** {orchestration}
- **{_t('Creado', 'Created')}:** {datetime.now().strftime('%Y-%m-%d')}

## {_t('Orquestacion', 'Orchestration')}
{orch_desc[lang].get(orchestration, orchestration)}

## {_t('Agentes', 'Agents')}
{agents_md or none_yet}

## Skills
{skills_md or none_yet}

## {_t('Conexiones', 'Connections')}
{mcps_md or none_yet}
"""
    (target / "CLAUDE.md").write_text(claude_content, encoding="utf-8")

    created_agents = 0
    for a in agents:
        aname = a["name"].lower().replace(" ", "-")
        af = _agents_dir() / f"{aname}.md"
        if not af.exists():
            _agents_dir().mkdir(parents=True, exist_ok=True)
            extra = _t("- Puede coordinarse con otros agentes del equipo\n- Notificar al orquestador al terminar",
                       "- Can coordinate with other team agents\n- Notify the orchestrator when done") if orchestration in ("parallel", "hybrid", "evaluator") else ""
            role = a.get("role", "")
            expertise_items = [f"- {role}"] if role else []
            for area in a.get("expertise", []):
                expertise_items.append(f"- {area}")
            if not expertise_items:
                expertise_items = [_t(f"- Especialista en {aname.replace('-', ' ')}", f"- Specialist in {aname.replace('-', ' ')}")]
            af.write_text(AGENT_TPL[lang].format(
                name=aname, model=a.get("model", "sonnet"), color=_next_color(),
                display=aname.replace("-", " ").title(),
                description=role or _t(f"Especialista en {aname.replace('-', ' ')}", f"Specialist in {aname.replace('-', ' ')}"),
                role=role, expertise="\n".join(expertise_items),
                tools="- Bash\n- Read\n- Write\n- Edit\n- Glob\n- Grep", extra=extra,
            ), encoding="utf-8")
            created_agents += 1
            md = _memory_dir() / aname; md.mkdir(parents=True, exist_ok=True)
            (md / "MEMORY.md").write_text(_t(
                f"# {aname.replace('-',' ').title()} — Memoria Persistente\n\n## Proyectos\n(se llena automaticamente)\n\n## Aprendizajes\n(se llena automaticamente)\n",
                f"# {aname.replace('-',' ').title()} — Persistent Memory\n\n## Projects\n(fills automatically)\n\n## Lessons\n(fills automatically)\n"), encoding="utf-8")

    created_skills = 0
    for s in skills:
        sname = s["name"].lower().replace(" ", "-")
        skill_dir = _skills_dir() / sname
        sf = skill_dir / "SKILL.md"
        legacy_sf = _skills_dir() / f"{sname}.md"
        if not sf.exists() and not legacy_sf.exists():
            skill_dir.mkdir(parents=True, exist_ok=True)
            sdesc = s.get("description", "")
            default_steps = [
                _t("Leer contexto del proyecto en CLAUDE.md", "Read project context in CLAUDE.md"),
                _t("Identificar los parametros necesarios desde $ARGUMENTS", "Identify required parameters from $ARGUMENTS"),
                (_t(f"Ejecutar: {sdesc}", f"Execute: {sdesc}") if sdesc else _t("Ejecutar la tarea principal", "Execute the main task")),
                _t("Validar que el resultado sea completo y correcto", "Validate that the result is complete and correct"),
                _t("Entregar resultado al usuario", "Deliver the result to the user"),
            ]
            ssteps = s.get("steps", default_steps)
            if isinstance(ssteps, list):
                steps_md = "\n".join(f"{i+1}. {st}" for i, st in enumerate(ssteps))
            else:
                steps_md = str(ssteps)
            sf.write_text(SKILL_TPL[lang].format(
                name=sname, display=sname.replace("-", " ").title(),
                description=sdesc, args=s.get("arguments", _t("parametros de contexto", "context parameters")),
                steps=steps_md, output=s.get("output", (_t(f"Resultado de: {sdesc}", f"Result of: {sdesc}") if sdesc else _t("(definir output)", "(define output)"))),
            ), encoding="utf-8")
            created_skills += 1

    return (_hdr(f"Proyecto scaffoldeado: {project_name}", f"Project scaffolded: {project_name}") + "\n"
            + _t(f"- **Carpeta:** {folder}/\n- **CLAUDE.md:** {folder}/CLAUDE.md\n"
                 f"- **Agentes creados:** {created_agents}\n- **Skills creadas:** {created_skills}\n"
                 f"- **Patron de orquestacion:** {orchestration}\n\n"
                 f"## Siguientes pasos\n"
                 f"1. Abre Claude Code en `{folder}/`\n"
                 f"2. Claude leera el CLAUDE.md y los agentes/skills creados\n"
                 f"3. Pide a Claude **enriquecer** cada agente con expertise, protocolos y reglas mas profundos\n"
                 f"4. Pide a Claude **detallar** cada skill con pasos especificos para tu caso\n\n"
                 f"**Tip:** Usa `moragent_enrich` para diagnosticar que le falta a cada agente/skill.",
                 f"- **Folder:** {folder}/\n- **CLAUDE.md:** {folder}/CLAUDE.md\n"
                 f"- **Agents created:** {created_agents}\n- **Skills created:** {created_skills}\n"
                 f"- **Orchestration pattern:** {orchestration}\n\n"
                 f"## Next steps\n"
                 f"1. Open Claude Code in `{folder}/`\n"
                 f"2. Claude will read CLAUDE.md and the agents/skills created\n"
                 f"3. Ask Claude to **enrich** each agent with deeper expertise, protocols, and rules\n"
                 f"4. Ask Claude to **detail** each skill with specific steps for your use case\n\n"
                 f"**Tip:** Use `moragent_enrich` to diagnose what each agent/skill is missing."))


# ══════════════════════════════════════════════════════════════════════════════
# TOOLS — OPERATE
# ══════════════════════════════════════════════════════════════════════════════

@mcp.tool()
def moragent_advisor(idea: str, industry: str = "", data_sources: str = "", outputs: str = "") -> str:
    """Analyze a project idea and recommend the optimal agentic AI architecture.
    Scans existing infrastructure, matches relevant agents/skills, and recommends an
    orchestration pattern (pipeline, parallel, orchestrator, evaluator, router).

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

    # Build full inventory for Claude to evaluate — instead of naive keyword
    # matching, present ALL agents with descriptions and let Claude decide.
    agents_inventory = []
    for a in agents:
        agent_info = f"  - **{a['name']}** ({a['model']}, {a['scope']})"
        desc = a.get("description", "")
        agent_path = Path(a.get("path", ""))
        if agent_path.exists() and not a.get("has_description_fm"):
            lines = _read_safe(agent_path).split("\n")
            in_fm = False
            content_lines = []
            for line in lines:
                if line.strip() == "---":
                    in_fm = not in_fm
                    continue
                if not in_fm and line.strip() and not line.startswith("#"):
                    content_lines.append(line.strip())
                    if len(content_lines) >= 2:
                        break
            if content_lines:
                desc = " ".join(content_lines)
        agent_info += f" — {desc[:120]}" if desc else ""
        agents_inventory.append(agent_info)

    skills_inventory = [f"  - **/{s['name']}** — {s.get('description', '')[:80]}" for s in skills]
    projects_inventory = [f"  - **{p['name']}/** — {p.get('title', '')}" for p in projects]

    recommended_mcps = []
    for mcp_name, keywords in MCP_KEYWORDS.items():
        if any(k in idea_lower for k in keywords):
            recommended_mcps.append(mcp_name)
    mcps_md = "\n".join(f"  - {m}" for m in recommended_mcps) if recommended_mcps else _t(
        "  (sin MCPs detectados — agrega segun necesidad)", "  (no MCPs detected — add as needed)")

    return _hdr("Advisor — Recomendacion de Arquitectura", "Advisor — Architecture Recommendation") + _t(f"""
## Proyecto
**Idea:** {idea}
{f'**Industria:** {industry}' if industry else ''}
{f'**Fuentes de datos:** {data_sources}' if data_sources else ''}
{f'**Outputs esperados:** {outputs}' if outputs else ''}

---

## 1. INVENTARIO — Tu infraestructura existente

**IMPORTANTE para Claude:** Revisa cada agente y skill abajo. Solo recomienda REUSAR un agente si su rol es DIRECTAMENTE relevante para el proyecto. No reusar por coincidencia de palabras — evalua si el agente realmente sirve para esta idea.

### Agentes ({len(agents)}):
{chr(10).join(agents_inventory) if agents_inventory else '  (sin agentes — se crearan nuevos)'}

### Skills ({len(skills)}):
{chr(10).join(skills_inventory) if skills_inventory else '  (sin skills)'}

### Proyectos con CLAUDE.md ({len(projects)}):
{chr(10).join(projects_inventory) if projects_inventory else '  (sin proyectos previos)'}

### Memorias activas: {sum(1 for m in memories if m['has_memory'] and m['lines']>0)}

## 2. PATRON DE ORQUESTACION

| Patron | Cuando usarlo | Costo |
|---|---|---|
| pipeline | Pasos secuenciales donde el orden importa (investigar -> redactar -> editar) | Bajo |
| parallel | Subtareas independientes a la vez (5 capitulos, 5 agentes) | Medio |
| orchestrator | Descomposicion dinamica: no sabes cuantas subtareas habra — **el mas comun** | Medio |
| evaluator | Generar + criticar en loop hasta pasar el gate de calidad | Medio-Alto |
| router | Inputs de tipos distintos que van a flujos distintos | Bajo |
| hybrid | Combinar: p.ej. orchestrator + evaluator como gate final | Variable |

**Para Claude:** Evalua las dependencias entre subtareas. Si son independientes -> parallel. Si el orden importa -> pipeline. Si la descomposicion es dinamica -> orchestrator. Si la calidad es critica -> agrega evaluator como gate. Empieza siempre por el patron mas simple que funcione.

## 3. CONEXIONES MCP RECOMENDADAS

{mcps_md}

## 4. FASES SUGERIDAS

1. **Setup** — Crear estructura (CLAUDE.md, agentes, skills, memoria)
2. **Desarrollo** — Implementar logica core del proyecto
3. **Validacion** — Testear con datos reales, quality check
4. **Entrega** — Output final, documentacion, deploy

---

## Siguiente paso

Quieres que cree la estructura del proyecto? Responde "si" y llamare `moragent_scaffold_project` con esta configuracion.

O ajusta la recomendacion: "cambiar orquestacion a parallel", "agregar agente X", "no necesito Y".
""", f"""
## Project
**Idea:** {idea}
{f'**Industry:** {industry}' if industry else ''}
{f'**Data sources:** {data_sources}' if data_sources else ''}
{f'**Expected outputs:** {outputs}' if outputs else ''}

---

## 1. INVENTORY — Your existing infrastructure

**IMPORTANT for Claude:** Review each agent and skill below. Only recommend REUSING an agent if its role is DIRECTLY relevant to the project. Don't reuse on keyword coincidence — evaluate whether the agent truly serves this idea.

### Agents ({len(agents)}):
{chr(10).join(agents_inventory) if agents_inventory else '  (no agents — new ones will be created)'}

### Skills ({len(skills)}):
{chr(10).join(skills_inventory) if skills_inventory else '  (no skills)'}

### Projects with CLAUDE.md ({len(projects)}):
{chr(10).join(projects_inventory) if projects_inventory else '  (no previous projects)'}

### Active memories: {sum(1 for m in memories if m['has_memory'] and m['lines']>0)}

## 2. ORCHESTRATION PATTERN

| Pattern | When to use it | Cost |
|---|---|---|
| pipeline | Sequential steps where order matters (research -> write -> edit) | Low |
| parallel | Independent subtasks at once (5 chapters, 5 agents) | Medium |
| orchestrator | Dynamic decomposition: unknown number of subtasks — **the most common** | Medium |
| evaluator | Generate + critique loop until the quality gate passes | Medium-High |
| router | Different input types going to different flows | Low |
| hybrid | Combine: e.g. orchestrator + evaluator as the final gate | Variable |

**For Claude:** Evaluate dependencies between subtasks. Independent -> parallel. Order matters -> pipeline. Dynamic decomposition -> orchestrator. Quality critical -> add evaluator as gate. Always start with the simplest pattern that works.

## 3. RECOMMENDED MCP CONNECTIONS

{mcps_md}

## 4. SUGGESTED PHASES

1. **Setup** — Create structure (CLAUDE.md, agents, skills, memory)
2. **Development** — Implement the project's core logic
3. **Validation** — Test with real data, quality check
4. **Delivery** — Final output, documentation, deploy

---

## Next step

Want me to create the project structure? Answer "yes" and I'll call `moragent_scaffold_project` with this configuration.

Or adjust the recommendation: "change orchestration to parallel", "add agent X", "I don't need Y".
""")


QUALITY_CHECKS = {
"en": {
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
},
"es": {
    "proposal": [
        "Tiene diseno visual profesional (no un muro de texto)?",
        "Incluye diagramas, flujos o esquemas visuales?",
        "Contiene metricas y datos especificos (no claims genericos)?",
        "Referencia proyectos exitosos previos como evidencia?",
        "Tiene estructura clara con resumen ejecutivo?",
        "Responde los criterios de evaluacion punto por punto?",
        "Incluye simulacion financiera con escenarios?",
        "Tiene siguientes pasos accionables?",
    ],
    "report": [
        "Tiene graficos o tablas visuales (no solo texto)?",
        "Contiene KPIs especificos con numeros?",
        "Compara contra benchmarks o metas?",
        "Tiene resumen ejecutivo en el primer parrafo?",
        "Incluye fuentes de datos y metodologia?",
        "Tiene recomendaciones accionables?",
    ],
    "dashboard": [
        "Usa HTML con CSS profesional (no markdown plano)?",
        "Tiene layout responsive (funciona en distintas pantallas)?",
        "Incluye graficos o KPIs visuales?",
        "Tiene filtros de datos o interactividad?",
        "Usa codigo de colores para estados (verde/amarillo/rojo)?",
        "Layout apto para imprimir?",
    ],
    "analysis": [
        "Se basa en datos reales (no supuestos)?",
        "Incluye descripcion de la metodologia?",
        "Tiene rigor estadistico (correlaciones, no solo promedios)?",
        "Compara multiples escenarios?",
        "Identifica riesgos y limitaciones?",
        "Entrega insights accionables (no solo descripciones)?",
    ],
    "code": [
        "Maneja errores y casos borde?",
        "Sigue los patrones de codigo existentes del proyecto?",
        "Tiene comentarios donde la logica no es obvia?",
        "Fue testeado (o incluye plan de tests)?",
        "Usa variables de entorno para credenciales (no hardcodeadas)?",
        "Maneja encoding (PYTHONUTF8=1 en Windows)?",
    ],
    "general": [
        "Responde lo que realmente se pidio (no algo tangencial)?",
        "Tiene calidad profesional (no nivel borrador)?",
        "Es especifico y accionable (no generico)?",
        "Referencia contexto y datos relevantes?",
        "El usuario estaria orgulloso de compartirlo con un cliente?",
    ],
},
}


@mcp.tool()
def moragent_quality_check(output_description: str, output_type: str = "general") -> str:
    """Evaluate output quality before delivering to user. Call this BEFORE presenting final results.

    Args:
        output_description: Brief description of what was produced (e.g., "Technical proposal for client X")
        output_type: Type of output — proposal, report, dashboard, analysis, code, general
    """
    lang = _get_lang()
    checks = QUALITY_CHECKS[lang]
    checklist = checks.get(output_type, checks["general"])

    return _hdr(f"Quality Check — {output_type.upper()}", f"Quality Check — {output_type.upper()}") + _t(f"""
## Output: {output_description}

## Checklist de calidad
Revisa cada item. Si CUALQUIERA falla, corrigelo antes de entregar.

{chr(10).join(f'- [ ] {c}' for c in checklist)}

## Instrucciones
1. Recorre cada checkbox mentalmente
2. Para cada item no cumplido, describe que falta
3. Corrige los problemas ANTES de entregar al usuario
4. Si el output es un "muro de texto" sin diseno visual, es un FAIL — reestructura con tablas, diagramas, paneles
5. Si el output no tiene datos/numeros especificos, es un FAIL — agrega metricas reales

## Estandares de calidad
- Contenido especifico y accionable (no generico ni vago)
- El diseno visual importa: layouts estructurados > muros de texto
- Referencia proyectos previos cuando existan (usa moragent_find_references)
- Iguala o supera la calidad de entregables previos en este workspace
""", f"""
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
""")


@mcp.tool()
def moragent_find_references(query: str, scope: str = "all") -> str:
    """Search previous projects, deliverables, and memories for templates, examples, and quality benchmarks.
    Use this BEFORE starting work to find relevant prior art. Never start from zero when past work exists.

    Args:
        query: What to search for (e.g., "proposal", "dashboard", "ETL report")
        scope: Where to search — all, projects, memories, deliverables
    """
    results = []
    ws = _cwd()
    query_lower = query.lower()

    if scope in ("all", "projects"):
        for d in sorted(ws.iterdir()):
            if d.is_dir() and (d / "CLAUDE.md").exists() and d.name not in EXCLUDED_DIRS:
                claude_md = _read_safe(d / "CLAUDE.md").lower()
                if query_lower in claude_md or query_lower in d.name.lower():
                    results.append(f"**PROJECT:** {d.name}/ — CLAUDE.md matches '{query}'")

    if scope in ("all", "deliverables"):
        for ext in ["*.html", "*.xlsx", "*.pdf", "*.eml"]:
            for f in ws.rglob(ext):
                if query_lower in f.name.lower() or query_lower in str(f.parent.name).lower():
                    if ".git" not in str(f) and "node_modules" not in str(f):
                        rel = f.relative_to(ws)
                        size_kb = f.stat().st_size // 1024
                        results.append(f"**FILE:** {rel} ({size_kb}KB)")

    if scope in ("all", "memories"):
        mem_dir = _user_memory()
        if mem_dir.exists():
            for mf in mem_dir.rglob("*.md"):
                try:
                    content = _read_safe(mf)
                    if query_lower in content.lower():
                        for line in content.split("\n"):
                            if line.startswith("name:"):
                                results.append(f"**MEMORY:** {line.split(':',1)[1].strip()} ({mf.name})")
                                break
                except (OSError, IOError, UnicodeDecodeError):
                    continue

    if scope in ("all", "memories") and _memory_dir().exists():
        for sub in _memory_dir().iterdir():
            if sub.is_dir():
                mf = sub / "MEMORY.md"
                if mf.exists():
                    content = _read_safe(mf).lower()
                    if query_lower in content:
                        results.append(f"**AGENT MEMORY:** {sub.name} — mentions '{query}'")

    if not results:
        return _hdr(f"Referencias — '{query}'", f"References — '{query}'") + _t(
            f"\nNo se encontraron proyectos, entregables ni memorias que coincidan. Partir de cero esta OK en este caso.",
            f"\nNo previous projects, deliverables, or memories match this query. Starting from scratch is OK in this case.")

    return _hdr(f"Referencias — '{query}'", f"References — '{query}'") + _t(f"""
Encontre {len(results)} referencias relevantes:

{chr(10).join(f'- {r}' for r in results[:20])}

## Instrucciones
Usa estas referencias como:
1. **Benchmark de calidad** — iguala o supera la calidad del trabajo previo
2. **Templates** — reusa estructuras, layouts y patrones que ya funcionaron
3. **Contexto** — entiende que se hizo antes para no duplicar
4. **Punto de partida** — nunca partir de cero cuando existe trabajo previo

Lee los archivos mas relevantes antes de empezar trabajo nuevo.
""", f"""
Found {len(results)} relevant references:

{chr(10).join(f'- {r}' for r in results[:20])}

## Instructions
Use these references as:
1. **Quality benchmarks** — match or exceed the quality of previous work
2. **Templates** — reuse structures, layouts, and patterns that worked before
3. **Context** — understand what was done previously to avoid duplication
4. **Starting points** — don't start from zero when prior art exists

Read the most relevant files before starting new work.
""")


@mcp.tool()
def moragent_onboard() -> str:
    """Visual guided tour of the entire agentic AI workspace structure.
    Shows what each folder and file does, how agents process requests, and how to get started.
    For first-time users or anyone who wants to understand the system."""

    ws = _cwd()
    agents = _scan_agents()
    skills = _scan_skills()
    projects = _scan_project_folders()

    has_claude_md = (ws / "CLAUDE.md").exists()
    has_env = (ws / ".env").exists()

    agent_list = "\n".join(f"    │   ├── {a['name']}.md  ({a['model']}, {a['scope']})" for a in agents[:8])
    if len(agents) > 8:
        agent_list += _t(f"\n    │   └── ... y {len(agents)-8} mas", f"\n    │   └── ... and {len(agents)-8} more")

    skill_list = "\n".join(f"    │   ├── {s['name']}/  (/{s['name']})" for s in skills[:8])
    if len(skills) > 8:
        skill_list += _t(f"\n    │   └── ... y {len(skills)-8} mas", f"\n    │   └── ... and {len(skills)-8} more")

    project_list = "\n".join(f"    ├── {p['name']}/  — {p['title']}" for p in projects[:6])
    if len(projects) > 6:
        project_list += _t(f"\n    ├── ... y {len(projects)-6} mas", f"\n    ├── ... and {len(projects)-6} more")

    return _hdr("Onboarding — Como funciona tu workspace", "Onboarding — How your workspace works") + f"""
```
{LOGO}
{TAGLINE}
```
""" + _t(f"""
## Tu Workspace (vista de pajaro)
```
{ws.name}/
    │
    ├── CLAUDE.md              {"<- ORQUESTADOR: manual principal. Todos los agentes lo leen." if has_claude_md else "<- NO EXISTE. Crea este archivo primero."}
    ├── .env                   {"<- Credenciales (APIs, DB). NUNCA compartir." if has_env else "<- (opcional) Necesario para APIs y DB."}
    │
    ├── .claude/               <- Carpeta oculta. Aqui vive TODO el sistema de agentes.
    │   ├── agents/            <- Tus agentes especializados (uno por archivo .md)
{agent_list or "    │   │   (vacio — aun no hay agentes)"}
    │   │
    │   ├── skills/            <- Procedimientos reutilizables (skills/nombre/SKILL.md -> /nombre)
{skill_list or "    │   │   (vacio — aun no hay skills)"}
    │   │
    │   └── agent-memory/      <- Lo que cada agente recuerda entre sesiones
    │       └── [agente]/MEMORY.md
    │
    ├── .mcp.json              <- Conexiones MCP (MORAGENT esta aqui)
    │
{project_list or "    (sin proyectos con CLAUDE.md aun)"}
```

## Que es cada cosa (en simple)

| Componente | Analogia | Para que sirve |
|---|---|---|
| **CLAUDE.md** | Manual de la empresa | Contexto global. TODOS los agentes lo leen al activarse. |
| **Agente** (.md) | Empleado especializado | Nombre, rol, modelo (cerebro) y memoria propia. Su `description:` decide cuando se le delega. |
| **Skill** (SKILL.md) | Manual de procedimiento | Receta paso a paso. Se invoca con /nombre. |
| **Memoria** | Experiencia del empleado | Lo que aprendio trabajando. Persiste entre sesiones. |
| **MCP** | App del telefono | Conectores a servicios (Gmail, Slack, Asana, Notion...). |
| **Plugin** | Extension instalable | Paquete de skills + agentes + hooks + MCP (como MORAGENT). |
| **Hook** | Alarma de seguridad | "Si pasa X, ejecutar Y" (automatico, local). |
| **Trigger** | Despertador | Tarea programada en la nube (/schedule). |

## Como fluye una tarea

```
Tu escribes: "Necesito el reporte de ventas semana 14"
       |
       v
  Orquestador (tu sesion + CLAUDE.md)
  Lee: contexto global, proyectos, tools
       |
       v
  Decide patron: 1 subagente? varios en paralelo? pipeline?
       |
       v
  Subagente se activa:
    1. Lee CLAUDE.md (global)
    2. Lee mi-proyecto/CLAUDE.md (proyecto)
    3. Lee agents/data-analyst.md (su identidad)
    4. Lee agent-memory/ (su experiencia)
    5. Ejecuta la tarea
    6. Devuelve resultado al orquestador
       |
       v
  Orquestador consolida y te entrega
```

## Los 5 patrones de orquestacion (resumen)

| Patron | En una frase |
|---|---|
| **Pipeline** | Pasos en secuencia con validacion entre medio |
| **Parallel** | Subtareas independientes, todas a la vez |
| **Orchestrator-workers** | El orquestador descompone y delega en vivo |
| **Evaluator-optimizer** | Uno genera, otro critica, iteran hasta aprobar |
| **Router** | Un clasificador deriva cada input al flujo correcto |

Detalle completo: `/moragent aprender patterns`

## Tu infraestructura actual
- **{len(agents)} agentes** configurados
- **{len(skills)} skills** disponibles
- **{len(projects)} proyectos** con CLAUDE.md

## Que hacer ahora

1. **Ver el menu completo:** `/moragent`
2. **Crear algo nuevo:** `/moragent nuevo proyecto [tu idea]`
3. **Aprender mas:** `/moragent aprender`
4. **Cambiar idioma:** `/moragent english`

Todo esta conectado. Cada vez que crees algo con MORAGENT, se integra automaticamente a tu workspace.
""", f"""
## Your Workspace (bird's-eye view)
```
{ws.name}/
    │
    ├── CLAUDE.md              {"<- ORCHESTRATOR: main handbook. All agents read it." if has_claude_md else "<- MISSING. Create this file first."}
    ├── .env                   {"<- Credentials (APIs, DB). NEVER share." if has_env else "<- (optional) Needed for APIs and DB."}
    │
    ├── .claude/               <- Hidden folder. The ENTIRE agent system lives here.
    │   ├── agents/            <- Your specialized agents (one .md file each)
{agent_list or "    │   │   (empty — no agents yet)"}
    │   │
    │   ├── skills/            <- Reusable procedures (skills/name/SKILL.md -> /name)
{skill_list or "    │   │   (empty — no skills yet)"}
    │   │
    │   └── agent-memory/      <- What each agent remembers between sessions
    │       └── [agent]/MEMORY.md
    │
    ├── .mcp.json              <- MCP connections (MORAGENT lives here)
    │
{project_list or "    (no projects with CLAUDE.md yet)"}
```

## What each thing is (in plain terms)

| Component | Analogy | What it's for |
|---|---|---|
| **CLAUDE.md** | Company handbook | Global context. ALL agents read it on activation. |
| **Agent** (.md) | Specialized employee | Name, role, model (brain) and own memory. Its `description:` drives delegation. |
| **Skill** (SKILL.md) | Procedure manual | Step-by-step recipe. Invoked with /name. |
| **Memory** | Employee's experience | What it learned working. Persists across sessions. |
| **MCP** | Phone app | Connectors to services (Gmail, Slack, Asana, Notion...). |
| **Plugin** | Installable extension | Bundle of skills + agents + hooks + MCP (like MORAGENT). |
| **Hook** | Security alarm | "If X happens, run Y" (automatic, local). |
| **Trigger** | Alarm clock | Scheduled task in the cloud (/schedule). |

## How a task flows

```
You type: "I need the week 14 sales report"
       |
       v
  Orchestrator (your session + CLAUDE.md)
  Reads: global context, projects, tools
       |
       v
  Picks a pattern: 1 subagent? several in parallel? a pipeline?
       |
       v
  Subagent activates:
    1. Reads CLAUDE.md (global)
    2. Reads my-project/CLAUDE.md (project)
    3. Reads agents/data-analyst.md (its identity)
    4. Reads agent-memory/ (its experience)
    5. Executes the task
    6. Returns the result to the orchestrator
       |
       v
  Orchestrator consolidates and delivers
```

## The 5 orchestration patterns (summary)

| Pattern | In one sentence |
|---|---|
| **Pipeline** | Sequential steps with validation in between |
| **Parallel** | Independent subtasks, all at once |
| **Orchestrator-workers** | The orchestrator decomposes and delegates live |
| **Evaluator-optimizer** | One generates, another critiques, iterate to approval |
| **Router** | A classifier dispatches each input to the right flow |

Full detail: `/moragent learn patterns`

## Your current infrastructure
- **{len(agents)} agents** configured
- **{len(skills)} skills** available
- **{len(projects)} projects** with CLAUDE.md

## What to do now

1. **See the full menu:** `/moragent`
2. **Create something new:** `/moragent new project [your idea]`
3. **Learn more:** `/moragent learn`
4. **Switch language:** `/moragent espanol`

Everything is connected. Whatever you create with MORAGENT integrates automatically into your workspace.
""")


@mcp.tool()
def moragent_enrich(target: str, target_type: str = "agent") -> str:
    """Analyze an existing agent or skill and return a diagnosis of what's missing or weak,
    with specific instructions for Claude to enrich it.

    Args:
        target: Name of the agent or skill to enrich (e.g., "data-analyst" or "etl-run")
        target_type: "agent" or "skill"
    """
    if target_type == "agent":
        f = _agents_dir() / f"{target}.md"
        if not f.exists():
            f = _user_agents() / f"{target}.md"
        if not f.exists():
            return _t(f"Agente '{target}' no encontrado en .claude/agents/ ni ~/.claude/agents/",
                      f"Agent '{target}' not found in .claude/agents/ or ~/.claude/agents/")
    else:
        f = _skills_dir() / target / "SKILL.md"
        if not f.exists():
            f = _skills_dir() / f"{target}.md"
        if not f.exists():
            f = _commands_dir() / f"{target}.md"
        if not f.exists():
            return _t(f"Skill '{target}' no encontrada en .claude/skills/ ni .claude/commands/",
                      f"Skill '{target}' not found in .claude/skills/ or .claude/commands/")

    content = _read_safe(f)
    fm = _parse_frontmatter(content)
    lines = content.split("\n")
    total_lines = len([l for l in lines if l.strip()])

    sections = set()
    for line in lines:
        if line.startswith("## "):
            sections.add(line[3:].strip().lower())

    issues = []
    suggestions = []

    if target_type == "agent":
        # Frontmatter checks — description is REQUIRED for auto-delegation
        if not fm.get("description"):
            issues.append(_t(
                "CRITICO: Falta `description:` en el frontmatter — Claude Code lo usa para decidir cuando delegar a este agente.",
                "CRITICAL: Missing `description:` in frontmatter — Claude Code uses it to decide when to delegate to this agent."))
        if not fm.get("name"):
            issues.append(_t("FALTA: `name:` en el frontmatter.", "MISSING: `name:` in frontmatter."))

        expected_sections = {
            "identity": _t("Quien es este agente, su personalidad y enfoque", "Who this agent is, its personality and focus"),
            "expertise": _t("Lista detallada de areas de conocimiento (minimo 5)", "Detailed list of expertise areas (minimum 5)"),
            "working protocol": _t("Pasos que sigue al recibir una tarea", "Steps it follows when receiving a task"),
            "tools": _t("Herramientas que puede usar", "Tools it can use"),
            "rules": _t("Reglas y restricciones", "Rules and constraints"),
        }
        optional_sections = {
            "team collaboration": _t("Como interactua con otros agentes (si es team_ready)", "How it interacts with other agents (if team_ready)"),
            "output format": _t("Formato estandar de sus entregas", "Standard format of its deliveries"),
            "references": _t("Fuentes, autores o recursos de referencia", "Sources, authors, or reference resources"),
        }

        for section, desc in expected_sections.items():
            if section not in sections:
                issues.append(_t(f"FALTA seccion `## {section.title()}` — {desc}", f"MISSING section `## {section.title()}` — {desc}"))

        expertise_lines = []
        in_expertise = False
        for line in lines:
            if line.startswith("## ") and "expertise" in line.lower():
                in_expertise = True
                continue
            if line.startswith("## ") and in_expertise:
                break
            if in_expertise and line.strip().startswith("- "):
                expertise_lines.append(line)
        if len(expertise_lines) < 3:
            issues.append(_t(f"DEBIL: Expertise tiene solo {len(expertise_lines)} items (recomendado: 5+)",
                             f"WEAK: Expertise has only {len(expertise_lines)} items (recommended: 5+)"))

        generic_markers = ["agente especializado", "a specialized agent"]
        has_generic_identity = any(marker in content.lower() for marker in generic_markers)
        if has_generic_identity:
            issues.append(_t("GENERICO: Identity usa texto de template. Necesita personalidad y contexto real.",
                             "GENERIC: Identity uses template text. It needs real personality and context."))

        is_team = "team_ready: true" in content or "team collaboration" in sections
        if is_team and "team collaboration" not in sections:
            issues.append(_t("FALTA: Agente es team_ready pero no tiene seccion ## Team Collaboration",
                             "MISSING: Agent is team_ready but has no ## Team Collaboration section"))

        for section, desc in optional_sections.items():
            if section not in sections:
                suggestions.append(_t(f"OPCIONAL: Agregar `## {section.title()}` — {desc}",
                                      f"OPTIONAL: Add `## {section.title()}` — {desc}"))

        if total_lines < 30:
            issues.append(_t(f"MUY CORTO: Solo {total_lines} lineas no vacias. Un agente bien configurado tiene 60-120.",
                             f"TOO SHORT: Only {total_lines} non-empty lines. A well-configured agent has 60-120."))

    else:  # skill
        if not fm.get("description"):
            issues.append(_t("FALTA: `description:` en el frontmatter — define cuando se usa la skill.",
                             "MISSING: `description:` in frontmatter — defines when the skill is used."))
        # A section counts as present in either language
        section_pairs = [("argumentos", "arguments"), ("pasos", "steps"), ("output", "output")]
        for es_name, en_name in section_pairs:
            if es_name not in sections and en_name not in sections:
                label = es_name if _get_lang() == "es" else en_name
                issues.append(_t(f"FALTA seccion `## {label.title()}`", f"MISSING section `## {label.title()}`"))

        has_define_steps = "(define steps)" in content or "(define output)" in content or "(definir output)" in content
        if has_define_steps:
            issues.append(_t("GENERICO: Los pasos/output dicen '(definir...)' — necesitan contenido real y detallado",
                             "GENERIC: Steps/output say '(define...)' — they need real, detailed content"))

        step_count = sum(1 for line in lines if line.strip() and line.strip()[0].isdigit() and ". " in line)
        if step_count < 3:
            issues.append(_t(f"POCOS PASOS: Solo {step_count} pasos. Una skill util tiene 5-8.",
                             f"FEW STEPS: Only {step_count} steps. A useful skill has 5-8."))

        if total_lines < 15:
            issues.append(_t(f"MUY CORTO: Solo {total_lines} lineas no vacias.",
                             f"TOO SHORT: Only {total_lines} non-empty lines."))

    status = _t("NECESITA TRABAJO", "NEEDS WORK") if issues else _t("BIEN CONFIGURADO", "WELL CONFIGURED")
    issues_md = "\n".join(f"- {i}" for i in issues) if issues else _t("- Ninguno detectado", "- None detected")
    suggestions_md = "\n".join(f"- {s}" for s in suggestions) if suggestions else _t("- Ninguna", "- None")

    quality_ref = _t('''- Frontmatter con `name`, `description` (clave para delegacion) y `model`
- Identity con personalidad y contexto (no generico)
- Expertise con 5-10 areas especificas
- Working Protocol con pasos numerados
- Rules con al menos 5 reglas claras
- 60-120 lineas totales''', '''- Frontmatter with `name`, `description` (key for delegation) and `model`
- Identity with personality and context (not generic)
- Expertise with 5-10 specific areas
- Working Protocol with numbered steps
- Rules with at least 5 clear rules
- 60-120 total lines''') if target_type == "agent" else _t('''- 5-8 pasos detallados y accionables
- Argumentos claros con ejemplos
- Output con formato especifico
- 25-50 lineas totales''', '''- 5-8 detailed, actionable steps
- Clear arguments with examples
- Output with a specific format
- 25-50 total lines''')

    fix_hint = _t(
        "Usa `moragent_create_agent` con `overwrite=true` para reemplazar, o edita el archivo directamente con Edit.",
        "Use `moragent_create_agent` with `overwrite=true` to replace, or edit the file directly with Edit."
    ) if target_type == "agent" else _t(
        "Usa `moragent_create_skill` con `overwrite=true` para reemplazar, o edita el archivo directamente con Edit.",
        "Use `moragent_create_skill` with `overwrite=true` to replace, or edit the file directly with Edit.")

    return _hdr(f"Enrich — Diagnostico de {target_type}: `{target}`", f"Enrich — Diagnosis of {target_type}: `{target}`") + _t(f"""
## Estado: {status}
**Lineas:** {total_lines} | **Secciones:** {', '.join(sorted(sections)) or 'ninguna'}

## Problemas detectados
{issues_md}

## Sugerencias opcionales
{suggestions_md}

## Instrucciones para Claude

**Lee el archivo `{f}` y enriquecelo** aplicando estos cambios:

{chr(10).join(f'{i+1}. Resolver: {issue}' for i, issue in enumerate(issues))}

{fix_hint}

**Referencia de calidad:** Un {target_type} bien configurado tiene:
{quality_ref}
""", f"""
## Status: {status}
**Lines:** {total_lines} | **Sections:** {', '.join(sorted(sections)) or 'none'}

## Detected issues
{issues_md}

## Optional suggestions
{suggestions_md}

## Instructions for Claude

**Read the file `{f}` and enrich it** applying these changes:

{chr(10).join(f'{i+1}. Resolve: {issue}' for i, issue in enumerate(issues))}

{fix_hint}

**Quality reference:** A well-configured {target_type} has:
{quality_ref}
""")


# ══════════════════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    mcp.run(transport="stdio")
