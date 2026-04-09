---
name: moragent
description: MORAGENT AI Agent Studio - punto de entrada principal. Menu guiado para aprender, crear, operar y gestionar proyectos de IA agentica.
user_invocable: true
---

# MORAGENT AI Agent Studio

Punto de entrada principal del framework. Guia al usuario paso a paso.

## Argumentos
- `$ARGUMENTS`: Accion a ejecutar (opcional). Si no se pasa, mostrar menu principal.

## Menu Principal

Si `$ARGUMENTS` esta vacio o dice "menu", presentar este menu:

```
MORAGENT AI Agent Studio
========================

  1. Nuevo proyecto     — Describe tu idea y te armo todo
  2. Crear agente       — Agente especializado con rol y memoria
  3. Crear skill        — Procedimiento reutilizable (/nombre)
  4. Mi infraestructura — Dashboard de agentes, skills, memorias
  5. Aprender           — Conceptos de IA agentica con analogias
  6. Verificar calidad  — Checklist antes de entregar
  7. Buscar referencias — Trabajo previo como punto de partida
  8. Onboarding         — Como funciona todo (carpetas, archivos, flujo)
  9. Enriquecer         — Mejorar un agente o skill existente

Escribe el numero o describe que quieres hacer.
```

## Flujo por opcion

### 1. Nuevo proyecto
1. Preguntar: "Describe tu proyecto en una frase"
2. Llamar `moragent_advisor` con la idea
3. Recomendar arquitectura: que agentes REUSAR, cuales crear
4. Preguntar: "Quieres que lo cree?"
5. Si acepta: llamar `moragent_scaffold_project`

### 2. Crear agente
1. Preguntar: nombre, rol, modelo (sonnet=rapido, opus=inteligente, haiku=barato)
2. Llamar `moragent_create_agent`

### 3. Crear skill
1. Preguntar: nombre, pasos, output
2. Llamar `moragent_create_skill`

### 4. Mi infraestructura
1. Llamar `moragent_status`

### 5. Aprender
Submenu: architecture, orchestration, skills, context, automation, plugins, example, glosario.
Llamar `moragent_learn` o `moragent_glossary`.

### 6. Verificar calidad
1. Preguntar tipo: proposal, report, dashboard, analysis, code
2. Llamar `moragent_quality_check`

### 7. Buscar referencias
1. Llamar `moragent_find_references`

### 8. Onboarding
1. Llamar `moragent_onboard`

### 9. Enriquecer
1. Preguntar: nombre del agente o skill, y tipo (agente/skill)
2. Llamar `moragent_enrich`
3. Aplicar las mejoras sugeridas

## Atajos directos
| Input | Accion |
|-------|--------|
| "nuevo proyecto [idea]" | Flujo 1 |
| "crear agente [nombre]" | Flujo 2 |
| "status" o "infra" | Flujo 4 |
| "aprender [tema]" | Flujo 5 |
| "onboarding" | Flujo 8 |
| "enriquecer [nombre]" | Flujo 9 |
| numero (1-9) | Flujo correspondiente |
