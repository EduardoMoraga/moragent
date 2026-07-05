---
name: moragent
description: MORAGENT AI Agent Studio — main entry point. Guided menu to learn, create, and operate agentic AI projects. Bilingual (ES/EN).
---

# MORAGENT AI Agent Studio

Main entry point of the framework. Guides the user step by step.

## Language protocol (ALWAYS FIRST)

1. Call `moragent_language()` (no args) to check the configured language.
2. Render the menu and ALL responses in that language.
3. If `$ARGUMENTS` contains "english", "ingles", "espanol", "español", "spanish", "idioma" or "language", call `moragent_language` with the requested language and confirm.

## Arguments
- `$ARGUMENTS`: Action to execute (optional). If empty, show the main menu.

## Main Menu

If `$ARGUMENTS` is empty or says "menu", render this menu VERBATIM inside a code block, in the configured language:

### Spanish version

```
█▀▄▀█ █▀█ █▀█ ▄▀█ █▀▀ █▀▀ █▄░█ ▀█▀
█░▀░█ █▄█ █▀▄ █▀█ █▄█ ██▄ █░▀█ ░█░
─────────────────────────────────────────────────
 AI AGENT STUDIO · v3.0.0 · by Eduardo Moraga
─────────────────────────────────────────────────

 APRENDE
   1 · Tour del workspace   Primera vez? Empieza aca
   2 · Lecciones            8 lecciones: patrones, skills, contexto...
   3 · Glosario             25 conceptos de IA agentica

 CREA
   4 · Nuevo proyecto       Tu idea → arquitectura + estructura
   5 · Crear agente         Especialista con rol, modelo y memoria
   6 · Crear skill          Procedimiento reutilizable (/nombre)

 OPERA
   7 · Mi infraestructura   Dashboard de agentes, skills, memorias
   8 · Enriquecer           Diagnostica y mejora agentes/skills
   9 · Verificar calidad    Checklist antes de entregar
  10 · Buscar referencias   Trabajo previo como punto de partida

─────────────────────────────────────────────────
 Escribe un numero o describe que necesitas.
 English? → /moragent english
```

### English version

```
█▀▄▀█ █▀█ █▀█ ▄▀█ █▀▀ █▀▀ █▄░█ ▀█▀
█░▀░█ █▄█ █▀▄ █▀█ █▄█ ██▄ █░▀█ ░█░
─────────────────────────────────────────────────
 AI AGENT STUDIO · v3.0.0 · by Eduardo Moraga
─────────────────────────────────────────────────

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

─────────────────────────────────────────────────
 Type a number or describe what you need.
 Espanol? → /moragent espanol
```

## Flow per option

### 1. Workspace tour
1. Call `moragent_onboard`

### 2. Lessons
Submenu: architecture, orchestration, patterns, skills, context, automation, plugins, example.
Call `moragent_learn` with the chosen topic. Recommend starting order for beginners:
architecture → orchestration → patterns → skills → context → automation → plugins → example.

### 3. Glossary
1. Call `moragent_glossary` (empty for all terms, or with a specific term)

### 4. New project
1. Ask: "Describe your project in one sentence" / "Describe tu proyecto en una frase"
2. Call `moragent_advisor` with the idea
3. Recommend architecture: which agents to REUSE, which to create, and the orchestration pattern (pipeline, parallel, orchestrator, evaluator, router)
4. Ask: "Want me to create it?" / "Quieres que lo cree?"
5. If accepted: call `moragent_scaffold_project`
6. After scaffolding: call `moragent_enrich` on each created agent and fix flagged issues

### 5. Create agent
1. Ask: name, role, model (haiku=fast/cheap, sonnet=workhorse, opus/fable=deep reasoning)
2. Call `moragent_create_agent`

### 6. Create skill
1. Ask: name, steps, output
2. Call `moragent_create_skill`

### 7. My infrastructure
1. Call `moragent_status`

### 8. Enrich
1. Ask: agent or skill name, and type (agent/skill)
2. Call `moragent_enrich`
3. Apply the suggested improvements

### 9. Quality check
1. Ask type: proposal, report, dashboard, analysis, code
2. Call `moragent_quality_check`

### 10. Find references
1. Call `moragent_find_references`

## Direct shortcuts
| Input | Action |
|-------|--------|
| "nuevo proyecto [idea]" / "new project [idea]" | Flow 4 |
| "crear agente [nombre]" / "create agent [name]" | Flow 5 |
| "crear skill [nombre]" / "create skill [name]" | Flow 6 |
| "status" or "infra" | Flow 7 |
| "aprender [tema]" / "learn [topic]" | Flow 2 |
| "glosario [termino]" / "glossary [term]" | Flow 3 |
| "tour" or "onboarding" | Flow 1 |
| "enriquecer [nombre]" / "enrich [name]" | Flow 8 |
| "english" / "espanol" / "idioma" / "language" | Switch language |
| number (1-10) | Corresponding flow |
