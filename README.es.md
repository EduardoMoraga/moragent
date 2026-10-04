<div align="center">

```
█▀▄▀█ █▀█ █▀█ ▄▀█ █▀▀ █▀▀ █▄ █ ▀█▀
█ ▀ █ █▄█ █▀▄ █▀█ █▄█ ██▄ █ ▀█  █
```

**Una aplicación de terminal. Un orquestador ejecutivo. Subagentes de Claude, Codex, Antigravity, Pi o cualquier modelo por API — trabajando por dentro, con memoria en capas.**

[![versión](https://img.shields.io/github/package-json/v/EduardoMoraga/moragent?color=8b5cf6&label=versión)](https://github.com/EduardoMoraga/moragent)
[![licencia](https://img.shields.io/badge/licencia-MIT-8b5cf6)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A518-8b5cf6)](https://nodejs.org)
[![estrellas](https://img.shields.io/github/stars/EduardoMoraga/moragent?style=flat&color=8b5cf6)](https://github.com/EduardoMoraga/moragent/stargazers)

[English](README.md) · [Sitio web](https://eduardomoraga.github.io/moragent/) · [Contrato del motor](docs/ENGINE.md) · [Arquitectura](docs/ARCHITECTURE.md)

</div>

## Instalación

```sh
curl -fsSL https://raw.githubusercontent.com/EduardoMoraga/moragent/master/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/EduardoMoraga/moragent/master/install.ps1 | iex
```

<sub>¿Prefieres npm? `npm i -g https://github.com/EduardoMoraga/moragent/archive/refs/heads/master.tar.gz` · probar sin instalar: `npx github:EduardoMoraga/moragent`</sub>

Luego, dentro de cualquier repositorio, abre una terminal interactiva y ejecuta:

```sh
mora  # o: moragent
```

Ambos nombres abren el harness conversacional de MORAGENT. Ejecuta `mora help` para ver los comandos explícitos; úsalos en scripts. Una ejecución sin argumentos fuera de una terminal interactiva termina con un error en vez de mostrar un dashboard. Node ≥ 18, cero dependencias npm. Si la carpeta aún no tiene `.moragent/`, la aplicación inicia el proyecto en línea directamente dentro de la terminal.

---

## Cómo funciona

```
$ moragent
┌─ MORAGENT · mi-app ─────────────────────────────┬─ Equipo ───────────────┐
│ ◆ Hola. Conectado: Claude (suscripción), Codex  │ ◆ Orquestador  listo   │
│   ¿Qué construimos?                             │                        │
│ tú › API de tareas con tests                    ├─ Memoria ──────────────┤
│ ◆ Plan (M · 2 subagentes) …                     │ canónica 3 · episod. 9 │
│ ◆ backend (codex) terminó T-0001 ✓              │ spec: tareas → apply   │
├─────────────────────────────────────────────────┴────────────────────────┤
│ › _                              /login /plan /equipo /memoria /abrir /help│
└──────────────────────────────────────────────────────────────────────────┘
```

1. **Inicias `mora` o `moragent`** en la terminal de tu proyecto. Entras directamente al harness conversacional.
2. **Escribes `/login`** para ver las suscripciones detectadas (con sesión iniciada o con la instrucción para conectarte) y gestionar tus claves de API o tu instancia local de Ollama.
3. **Le hablas al orquestador ejecutivo** en lenguaje natural. Explora tu repositorio, dimensiona el trabajo y elabora el plan de ejecución.
4. **Los subagentes trabajan por dentro de la aplicación**, transmitiendo su actividad en tiempo real al panel de conversación y al panel lateral de equipo. Si quieres interactuar directamente con un subagente en su propio panel de terminal, usa `/abrir <rol|id>` (ej. `/abrir backend`) para sacarlo a Orca, herdr o tmux.

---

## Inicia sesión con lo que ya tienes

MORAGENT **no tiene cuenta ni servidores**. Nunca actúa como intermediario: cada motor se conecta directamente desde tu máquina usando tu propia sesión de suscripción o tu propia clave de API.

| ID de motor | Proveedor | Tipo de motor | Estado y verificación |
|---|---|---|---|
| `claude` | Anthropic Claude Code | Suscripción CLI | ✓ Verificado en vivo (27-sep-2026) |
| `codex` | OpenAI Codex CLI | Suscripción CLI | ✓ Verificado en vivo (27-sep-2026) |
| `agy` | Google Antigravity CLI | Suscripción CLI | ✓ Verificado en vivo (27-sep-2026) |
| `pi` | Mario Zechner's Pi | Suscripción CLI | ✓ Verificado en vivo (27-sep-2026) |
| `opencode` | OpenCode AI | Suscripción CLI | Soportado mediante adaptador |
| `gemini` | Google Gemini CLI | Suscripción CLI | Mejor esfuerzo desde `--help` (no verificado) |
| `anthropic` | Anthropic (Claude API) | Bucle nativo de API | Messages API con uso de herramientas (`claude-sonnet-5`) |
| `openai` | OpenAI (GPT API) | Bucle nativo de API | Chat completions con llamadas a herramientas (`gpt-4o`) |
| `openrouter` | OpenRouter | Bucle nativo de API | Punto de acceso compatible con OpenAI (`anthropic/claude-sonnet-5`) |
| `google` | Google Gemini API | Bucle nativo de API | `generateContent` con declaraciones de función (`gemini-2.0-flash`) |

<sub>El modelo por defecto de cada proveedor se cambia con `MORAGENT_<PROVEEDOR>_MODEL` (p. ej. `MORAGENT_OPENAI_MODEL`). Los defaults de OpenAI y Google no se verificaron en vivo.</sub>
| `ollama` | Ollama (Local) | Bucle nativo de API | ✓ Verificado en vivo con `qwen3.5:9b` escribiendo y leyendo archivos |

Las claves de API se guardan localmente en `~/.moragent/credentials.json` con permisos estrictos POSIX (`0600`), y las variables de entorno estándar tienen prioridad (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`, `OLLAMA_HOST`).

El bucle nativo de API incluye herramientas integradas (`read_file`, `write_file`, `edit_file`, `list_dir`, `grep`, `bash`), estrictamente confinadas a la raíz del proyecto, con límites de tamaño de salida (≤ 20 KB) y tiempos máximos de ejecución (120 s).

---

## Comandos dentro de la app

Escribe estos comandos dentro de `moragent`:

- `/help` (o `/ayuda`): ver la lista de comandos disponibles
- `/login`: conectar suscripciones o configurar claves de API
- `/equipo` (o `/crew`): ver el equipo actual · `/equipo <rol> <motor>` para reasignar roles
- `/orquestador <m>` (o `/orchestrator`): elegir el motor del orquestador ejecutivo
- `/modelo [rol] <nombre>` (o `/model`): ver o cambiar el modelo del orquestador o de un rol (`/modelo sonnet`, `/modelo backend gpt-5.5`; `default` vuelve al del motor)
- `/memoria [texto]` (o `/memory`): ver resumen de memoria o buscar notas
- `/plan <texto>`: pedir un plan explícito con estimación y spec
- `/abrir <rol|id>` (o `/open`): sacar un subagente a un panel externo de terminal
- `/cancel` (o `/cancelar`): cancelar el trabajo en ejecución
- `/salir` (o `/exit`): salir de la aplicación (o presionar Ctrl+C dos veces)

---

## Por qué MORAGENT

Ejecutar un agente de IA en una ventana de chat es simple. Lograr que un equipo completo **se reparta el trabajo, conserve el contexto, respete las decisiones de arquitectura y no se pise** requiere un orquestador:

| Característica | MORAGENT v5 | [herdr](https://herdr.dev) | gentle-ai | hello-sdd | tmux a mano |
|---|:-:|:-:|:-:|:-:|:-:|
| Aplicación de terminal nativa (TUI) | ✓ | — | — | — | — |
| Un único orquestador ejecutivo | ✓ | — | — | — | — |
| Subagentes ejecutados por dentro de la app | ✓ | — | — | — | — |
| Paneles externos bajo demanda | ✓ (Orca · herdr · tmux) | ✓ | — | — | ✓ manual |
| Mezclar suscripciones y APIs en un equipo | ✓ | ✓ | ✓ | — | ✓ manual |
| Bus de tareas entre agentes | ✓ `dispatch` / `done` / `wait` | ~ texto manual | — | — | — |
| Memoria en capas | ✓ canónica · episódica · transitoria · skills | — | ~¹ | — | — |
| Fases guiadas por spec (SDD) | ✓ 8 fases derivadas de archivos en disco | — | ✓ | ✓ | — |
| Segundo cerebro en Obsidian | ✓ `mora brain link` | — | — | — | — |
| Instalación en una línea, cero dependencias | ✓ | ✓ | ✓ | ✓ | — |

<sub>¹ gentle-ai ofrece memoria persistente mediante Engram, un único almacén de observaciones con búsqueda de texto completo: es duradero, pero no está separado en capas arquitectónicas.<br>Comparación basada en la documentación pública a septiembre de 2026. MORAGENT no reemplaza a herdr, Orca ni tmux: orquesta a los agentes nativamente y puede dirigir multiplexores cuando requieres paneles externos.</sub>

---

## La sala de máquinas: Memoria, Specs y Segundo Cerebro

Todo lo probado de MORAGENT v4 sigue siendo la base sólida en el interior:

### Memoria en capas

| Capa | Carpeta | Qué va ahí | Duración |
|---|---|---|---|
| Canónica | `memory/canonical/` | decisiones de arquitectura, convenciones | duradera, rastreada en git |
| Episódica | `memory/episodic/` | resultados de tareas, capturas de sesiones, hallazgos | sólo adición, en git |
| Transitoria | `memory/transient/` | borradores, traspasos entre agentes | expira (`mora memory gc`) |
| Procedural | `skills/<nombre>/SKILL.md` | procedimientos reutilizables | sincronizada a cada CLI (`mora sync`) |

`mora context <rol> --query "…"` compila un paquete de contexto para un agente: notas canónicas, episodios recientes y coincidencias de búsqueda semántica, dentro de un presupuesto exacto de caracteres.

### Fases guiadas por spec (SDD)

`explore → propose → spec → design → tasks → apply → verify → archive`

Las fases **se derivan determinísticamente de los archivos en disco** (requisitos EARS en `spec.md`, ítems `- [ ]` en `tasks.md`), por lo que el sistema —y no una alucinación del modelo— garantiza el avance del flujo de trabajo.

### Segundo cerebro en Obsidian

`mora brain link` enlaza mediante symlink `.moragent/` dentro de tu vault de Obsidian (o lo copia con `--copy`). Las notas usan frontmatter estándar y `[[wikilinks]]`. Un archivo autogenerado `Home.md` conecta specs, tareas y decisiones directamente en tu grafo visual de conocimiento.

### Plugin para Claude Code y Codex

El repositorio incluye habilidades listas para usar con Claude Code y Codex:

```text
# Claude Code
/plugin marketplace add EduardoMoraga/moragent
/plugin install moragent@moragent
```

Para Codex, `.codex-plugin/plugin.json` expone los mismos protocolos desde `plugin/skills/`.

---

## Para scripts y otros agentes: CLI `mora`

Para canalizaciones de CI/CD, automatización o agentes CLI tradicionales, el comando `mora` sigue funcionando:

```sh
cd mi-app
mora init --preset trio --goal "Tienda online"        # inicializa un proyecto
mora doctor                                          # verifica la salud del sistema y motores
mora plan "Flujo de checkout y panel de control"     # dimensiona y crea la primera spec
mora spec status                                     # consulta el estado de las specs
mora dispatch backend "API de órdenes" --spec <slug> # envía una tarea al bus
mora wait T-0001                                     # espera a que termine la tarea
mora board                                           # tablero kanban en terminal
mora status [T-0001] --json                          # estado local y próxima acción, sin reintentos
mora memory add "Usar UUIDv7" --tier canonical       # registra una decisión de arquitectura
mora brain link                                      # enlaza con tu vault de Obsidian
```

Todos los comandos de lectura admiten `--json`.
`mora status` (y `mora st`) ahora muestra el estado de tareas y ejecuciones; usa `mora dashboard` para el resumen anterior del proyecto.

---

## Autonomía y seguridad

Cada rol y ejecución opera bajo un contrato explícito de autonomía:

| Modo | Qué puede hacer el agente sin consultar |
|---|---|
| `readonly` | Leer archivos del repositorio (`read_file`, `list_dir`, `grep`). Las escrituras (`write_file`, `edit_file`) y la ejecución de comandos (`bash`) se rechazan con un mensaje claro. Ideal para el orquestador. |
| `auto` **(por defecto)** | Editar archivos dentro del repositorio y ejecutar comandos de verificación seguros (`mora`, `node`, `npm test`, `git status`, `git diff`). Las escrituras fuera del espacio de trabajo quedan bloqueadas por el sandbox del proveedor. |
| `full` | Operaciones sin restricciones ni solicitudes de confirmación (`--dangerously-skip-permissions` / `--yolo`). Usar únicamente en entornos descartables o contenedores aislados. |
| `ask` | Nunca ejecuta comandos ni ediciones sin la confirmación explícita del usuario. |

---

## Probado con

> **Plataformas.** Verificado en vivo sobre macOS (Apple Silicon). Linux y Windows ejecutan la suite completa de pruebas en CI en Node 18, 20 y 22. Windows es **experimental**: la suite de pruebas pasa, pero ni la app de terminal ni los paneles externos se han probado todavía en una máquina Windows real.

Verificado en vivo el 27 de septiembre de 2026:
- **Codex 0.154**: ejecución en streaming desatendida con `-s workspace-write -a never` (sin diálogos de confirmación).
- **Claude Code 2.1.283**: ejecución en streaming con `--permission-mode auto` y herramientas autorizadas.
- **Antigravity 1.2.x**: ejecución en streaming con omisión de permisos en sandbox.
- **Pi 0.85**: ejecución en streaming JSON y reanudación de sesiones.
- **Ollama (local)**: probado en vivo con `qwen3.5:9b`, ejecutando llamadas a herramientas en múltiples turnos (`write_file` + `read_file`) mediante el bucle nativo.

---

## Preguntas frecuentes

**¿Necesito tmux u Orca?**  
No. MORAGENT v5 es una aplicación de terminal autónoma que corre en cualquier emulador de terminal (Terminal.app, iTerm2, Alacritty, Ghostty, Windows Terminal, etc.). Orca, herdr o tmux sólo se utilizan si decides sacar un agente a un panel independiente con `/abrir`.

**¿Es una sola IA o varias?**  
Es un orquestador ejecutivo coordinando a múltiples subagentes especializados (backend, frontend, helper, dev). Cada subagente puede usar el motor de suscripción o la API que mejor se adapte a su tarea.

**¿Envía mi código a servidores de MORAGENT?**  
No. MORAGENT no tiene servidores ni recolecta telemetría. Tus CLIs de agentes se comunican directamente con sus respectivos proveedores, y las instancias locales de Ollama corren completamente fuera de línea.

**¿Cuánto cuesta?**  
MORAGENT es 100% gratuito y de código abierto (MIT). Sólo pagas tus propias suscripciones o el consumo de API directamente a cada proveedor.

**¿Puedo usar un solo motor para todo?**  
Sí. Puedes configurar tanto el orquestador como los subagentes con el mismo motor (por ejemplo, sólo Claude Code, sólo Codex, o 100% local con Ollama).

**¿Puedo revertir los cambios de MORAGENT?**  
Todo se almacena limpiamente en `.moragent/` junto con bloques de comentarios gestionados en `AGENTS.md` o `CLAUDE.md`. Si los eliminas, tu repositorio vuelve exactamente a su estado original.

---

## Contribuir

Las contribuciones son bienvenidas: consulta [CONTRIBUTING.md](CONTRIBUTING.md) y los contratos técnicos en [docs/ENGINE.md](docs/ENGINE.md) y [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Ejecuta `npm test` antes de enviar tus cambios.

## Licencia

[MIT](LICENSE) © Eduardo Moraga
