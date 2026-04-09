# MORAGENT AI Agent Studio

Tu asistente para diseñar, aprender y operar proyectos con agentes de IA en Claude Code.

```
Tú: /moragent
Claude: Menú con 8 opciones → crear proyecto, agentes, skills, aprender, verificar calidad...
```

## Para quién es

- **Principiantes**: Aprende qué es un agente, una skill, un CLAUDE.md — con analogías simples.
- **Intermedios**: Crea proyectos completos con agentes y skills en minutos.
- **Avanzados**: Quality gates, búsqueda de referencias, orquestación multi-agente.

No necesitas saber programar. Solo necesitas Claude Code y escribir `/moragent`.

## Instalación

### Requisitos
- [Claude Code](https://claude.ai/download) instalado
- [Python 3.10+](https://python.org/downloads)

### Instalar (3 pasos)

```bash
# 1. Descargar MORAGENT
git clone https://github.com/EduardoMoraga/moragent.git

# 2. Ir a tu proyecto (donde quieres usar agentes)
cd mi-proyecto

# 3. Instalar
python ../moragent/install.py
```

El instalador:
- Copia el server MCP a tu proyecto
- Crea `.mcp.json` (Claude Code lo detecta automáticamente)
- Crea `/moragent` como comando disponible

### Instalar manualmente (sin script)

1. Copia `server.py` a `tu-proyecto/moragent-plugin/server.py`
2. Instala dependencia: `pip install "mcp[cli]"`
3. Crea `tu-proyecto/.mcp.json`:
```json
{
  "mcpServers": {
    "moragent": {
      "command": "python",
      "args": ["moragent-plugin/server.py"],
      "env": {"PYTHONUTF8": "1"}
    }
  }
}
```
4. Copia `.claude/commands/moragent.md` a tu proyecto
5. Abre Claude Code → acepta activar MORAGENT → escribe `/moragent`

## Qué incluye

### 11 herramientas MCP

| Herramienta | Qué hace |
|---|---|
| `moragent_advisor` | Describe tu idea → analiza tu infra y recomienda arquitectura |
| `moragent_onboard` | Explica visualmente cómo funciona tu workspace |
| `moragent_status` | Dashboard de toda tu infraestructura |
| `moragent_quality_check` | Checklist de calidad antes de entregar |
| `moragent_find_references` | Busca trabajo previo como referencia |
| `moragent_create_agent` | Crea un agente especializado (soporta overwrite) |
| `moragent_create_skill` | Crea un procedimiento reutilizable (soporta overwrite) |
| `moragent_scaffold_project` | Crea proyecto completo (CLAUDE.md + agentes + skills) |
| `moragent_enrich` | Diagnostica agentes/skills débiles y guía su mejora |
| `moragent_glossary` | 15 conceptos de IA agéntica con analogías |
| `moragent_learn` | 7 lecciones interactivas |

### Skill /moragent

Menú guiado con 8 opciones:

```
1. Nuevo proyecto     — Describe tu idea y te armo todo
2. Crear agente       — Agente con rol, modelo y memoria
3. Crear skill        — Procedimiento reutilizable (/nombre)
4. Mi infraestructura — Dashboard completo
5. Aprender           — Conceptos con analogías y diagramas
6. Verificar calidad  — Checklist antes de entregar
7. Buscar referencias — Trabajo previo como base
8. Onboarding         — Cómo funciona todo
9. Enriquecer         — Mejorar un agente o skill existente
```

## Conceptos clave (en 30 segundos)

| Concepto | Analogía |
|---|---|
| **CLAUDE.md** | Manual de la empresa — todos lo leen |
| **Agente** | Empleado especializado con memoria |
| **Skill** | Manual de procedimiento (/nombre) |
| **Memoria** | Experiencia acumulada del agente |
| **MCP** | App del teléfono (Gmail, Slack...) |
| **Subagente** | Freelancer: recibe tarea, entrega, se va |
| **Team** | Equipo con Kanban compartido |

## Cómo funciona

```
Tú escribes algo
       |
       v
  CLAUDE.md (orquestador)
  Decide qué agentes usar
       |
       v
  Agente se activa:
    1. Lee CLAUDE.md (contexto global)
    2. Lee su identidad (agents/*.md)
    3. Lee su memoria (agent-memory/)
    4. Ejecuta y devuelve resultado
       |
       v
  Tú recibes todo consolidado
```

## Ejemplo real

En una sesión de 45 minutos, usando MORAGENT se construyó:

- 3 agentes especializados (investigador, redactor, ingeniero de datos)
- 6 skills reutilizables
- 1 research brief con 10 papers verificados
- 1 post LinkedIn de 1.050 palabras listo para publicar
- 1 calendario editorial semanal

Todo orquestado con Teams, cero datos inventados, fuentes reales con URL.

## Licencia

MIT — Eduardo Moraga, 2026
