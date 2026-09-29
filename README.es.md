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

Luego, dentro de cualquier repositorio:

```sh
moragent
```

Node ≥ 18, cero dependencias npm. Si la carpeta aún no tiene `.moragent/`, la aplicación inicia el proyecto en línea directamente dentro de la terminal.

---

## Cómo funciona

```
$ moragent
 MORAGENT v5.2.0
 mi-app · orquestador claude
 conectados: 2/12 · claude, codex · /login
◆ Proyecto mi-app. ¿Qué hacemos? Pide algo o usa /tarea para desplegar un agente.
› Crea una API de tareas con tests
◐ Orquestador · pensando · 4s
● backend · codex  T-0001  8s  write_file src/tasks.js
› _
claude · 1 agente trabajando · /help
```

1. **Inicias `moragent`** en la terminal de tu proyecto. La app conserva el historial visible de la terminal y actualiza el trabajo activo en el mismo lugar.
2. **Escribes `/login`** para ver todos los proveedores compatibles y su conexión. El login de una suscripción ocurre en esa misma terminal; las claves de API se escriben en un campo oculto.
3. **Le hablas al orquestador ejecutivo** en lenguaje natural. Explora tu repositorio, dimensiona el trabajo y elabora el plan de ejecución.
4. **Los subagentes trabajan por dentro de la aplicación**, con actividad visible debajo de la conversación. Tab muestra los registros recientes. Si quieres abrir un subagente en un panel propio, usa `/abrir <rol|id>` (ej. `/abrir backend`).

---

## Inicia sesión con lo que ya tienes

MORAGENT **no tiene cuenta ni servidores**. Nunca actúa como intermediario: cada motor se conecta directamente desde tu máquina usando tu propia sesión de suscripción o tu propia clave de API.

| ID de motor | Proveedor | Tipo de motor | Estado y verificación |
|---|---|---|---|
| `claude` | Anthropic Claude Code | Suscripción CLI | ✓ Verificado en vivo (27-sep-2026) |
| `codex` | OpenAI Codex CLI | Suscripción CLI | ✓ Verificado en vivo (27-sep-2026) |
| `agy` | Google Antigravity CLI | Suscripción CLI | ✓ Verificado en vivo (27-sep-2026) |
| `pi` | Mario Zechner's Pi | Suscripción CLI | ✓ Verificado en vivo (27-sep-2026) |
| `opencode` | OpenCode AI | Suscripción CLI | ✓ Respuesta, herramientas y directorio aislado probados en vivo (28-sep-2026); denegación de herramientas en readonly aún sin verificar en vivo |
| `gemini` | Google Gemini CLI | Suscripción CLI | Mejor esfuerzo desde `--help` (no verificado) |
| `anthropic` | Anthropic (Claude API) | Bucle nativo de API | Messages API con uso de herramientas (`claude-sonnet-5`) |
| `openai` | OpenAI (GPT API) | Bucle nativo de API | Chat completions con llamadas a herramientas (`gpt-4o`) |
| `openrouter` | OpenRouter | Bucle nativo de API | Punto de acceso compatible con OpenAI (`anthropic/claude-sonnet-5`) |
| `google` | Google Gemini API | Bucle nativo de API | `generateContent` con declaraciones de función (`gemini-2.0-flash`) |
| `ollama` | Ollama (Local) | Bucle nativo de API | ✓ Verificado en vivo con `qwen3.5:9b` escribiendo y leyendo archivos |
| `compatible` | Cualquier servidor compatible con OpenAI | Bucle nativo de API | Configura URL base y clave opcional con `/login compatible` |

<sub>El modelo por defecto de cada proveedor se cambia con `MORAGENT_<PROVEEDOR>_MODEL` (p. ej. `MORAGENT_OPENAI_MODEL`). Los defaults de OpenAI y Google no se verificaron en vivo.</sub>

El catálogo de OpenCode puede incluir ID que tu cuenta no admite. En esta máquina, su modelo gratuito por defecto devolvió HTTP 403 desde MORAGENT y otro ID listado de OpenAI devolvió HTTP 400; un modelo Codex conectado sí respondió. MORAGENT muestra el mensaje breve del proveedor y el código HTTP para que elijas un modelo utilizable con `/modelo`. En el selector, `·` indica que no se probó el acceso al modelo; sólo el selector de proveedores usa `✓` para un motor listo.

En Ollama, si no eliges un modelo, MORAGENT selecciona el primer modelo instalado capaz de usar herramientas que informa `/api/tags`; no supone que `llama3` esté instalado. Una elección explícita con `/modelo` o `MORAGENT_OLLAMA_MODEL` tiene prioridad. Si Ollama no informa modelos con herramientas, MORAGENT pide instalar o seleccionar uno en vez de enviar una solicitud con un modelo inexistente. Se verificó esta ruta en vivo con `gemma4:latest`.

La salida de los CLI de suscripción se decodifica como UTF-8 aunque una letra llegue dividida entre fragmentos. Cada registro JSONL tiene un límite de 16 millones de caracteres para evitar un crecimiento ilimitado de memoria; aumenta `MORAGENT_CLI_MAX_LINE_CHARS` sólo si tu CLI genera registros mayores.

Las claves de API se guardan localmente en `~/.moragent/credentials.json` con permisos estrictos POSIX (`0600`), y las variables de entorno estándar tienen prioridad (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`, `OLLAMA_HOST`). Si `/login` guarda una clave mientras su variable de entorno está definida, MORAGENT avisa que la clave guardada está inactiva; quita la variable y reinicia MORAGENT para usarla.

Las trazas de proveedores en `.moragent/runs/` pueden contener prompts, código y argumentos de herramientas. Los logs nuevos son privados (`0600` en POSIX); los anteriores se ajustan al reabrirse. Conviene revisar manualmente los permisos de logs antiguos que no se vuelvan a abrir. El comportamiento de ACL en Windows aún no está validado.

Para conectar otro servidor compatible, elige `compatible` en `/login` e introduce su URL base incluyendo `/v1` (por ejemplo, `http://localhost:8000/v1`). Agrega una clave si la requiere y luego selecciona el modelo con `/modelo`. También puedes usar `MORAGENT_COMPATIBLE_BASE_URL`, `MORAGENT_COMPATIBLE_API_KEY` y `MORAGENT_COMPATIBLE_MODEL`. Las variables de URL y clave prevalecen sobre lo guardado con `/login`; la app avisa cuando ocurre.
Los servidores sin `/models` también se pueden usar: introduce el ID de su modelo de chat con `/modelo`. El selector omite los ID reconocibles de embeddings y otros modelos que no son de chat.

El bucle nativo de API ofrece herramientas de archivos (`read_file`, `write_file`, `edit_file`, `list_dir`, `grep`) confinadas a la raíz del proyecto, con salidas de hasta 20 KB. `grep` corre fuera del hilo de la terminal, admite cancelación, vence a los 30 segundos por defecto (`MORAGENT_GREP_TIMEOUT_MS`) e indica que el resultado es parcial al llegar a 1.000 coincidencias. La herramienta de shell (`bash`) no tiene sandbox del sistema operativo: los agentes API sólo pueden usarla con autonomía `full` explícita y un límite de 120 segundos; `/cancel` detiene el árbol de procesos del shell. Las solicitudes API tienen un límite predeterminado de 10 minutos; `MORAGENT_API_TIMEOUT_MS` permite ampliarlo para modelos locales lentos.

---

## Comandos dentro de la app

Escribe estos comandos dentro de `moragent`:

- `/help` (o `/ayuda`): ver la lista de comandos disponibles
- `/login`: conectar suscripciones o configurar claves de API
- `/equipo` (o `/crew`): ver el equipo actual · `/equipo <rol> <motor>` para reasignar roles. Si eliges una API, el worker nativo la usa y el panel externo conserva su CLI.
- `/orquestador <m>` (o `/orchestrator`): elegir el motor del orquestador ejecutivo. Si no está disponible, MORAGENT anuncia un sustituto temporal y recupera la preferencia cuando vuelve a conectarse.
- `/modelo` o `/modelo <rol>` (o `/model`): explorar modelos de todos los proveedores y elegir uno para el orquestador o un rol. `/modelo <nombre>` y `/modelo <rol> <nombre>` asignan el modelo directamente; `default` usa el predeterminado del motor elegido.
- `/idioma <es|en>` (o `/language`): cambiar la interfaz y las próximas respuestas a español o inglés; se guarda por proyecto. Inicia con `moragent --lang en` para cambiar sólo esa sesión. Antes de crear un proyecto, `MORAGENT_LANG=en` también selecciona inglés.
- `/recuperaciones [id-tarea]` (o `/recoveries`): listar copias privadas conservadas. `/recuperaciones inspeccionar <id>` muestra cambios de archivos y directorios y sus conflictos; `/recuperaciones aplicar <id>` incorpora esas rutas explícitamente sólo si el origen aún coincide con la versión base. Las copias que fallaron una comprobación exacta quedan marcadas como manuales y este comando no puede aplicarlas. Las demás copias nuevas siguen siendo aplicables tras mover el proyecto completo; mover sólo una carpeta de recuperación se rechaza. La copia y su estado Git privado permanecen disponibles. Las copias antiguas sin manifiesto requieren recuperación manual; los manifiestos antiguos ligados a una ruta deben permanecer en su ubicación original.
- `/memoria [texto]` (o `/memory`): ver resumen de memoria o buscar notas
- `/plan <texto>`: pedir un plan explícito con estimación y spec
- `/abrir <rol|id>` (o `/open`): sacar un subagente a un panel externo de terminal
- `/cancel` (o `/cancelar`): cancelar el trabajo en ejecución, incluido el grupo de procesos de un CLI de suscripción
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
mora memory add "Usar UUIDv7" --tier canonical       # registra una decisión de arquitectura
mora brain link                                      # enlaza con tu vault de Obsidian
```

Todos los comandos de lectura admiten `--json`.

---

## Autonomía y seguridad

Cada rol y ejecución opera bajo un contrato explícito de autonomía:

| Modo | Qué puede hacer el agente sin consultar |
|---|---|
| `readonly` | Las herramientas API permiten lectura y búsqueda, y rechazan escrituras y shell. Los CLI usan políticas propias; OpenCode recibe reglas explícitas de denegación, no un sandbox del SO. |
| `auto` **(por defecto)** | Editar archivos del proyecto. Los agentes API no ejecutan shell en este modo. Las políticas de CLI varían según proveedor; la copia privada de MORAGENT no es un sandbox del SO. |
| `full` | Solicita la mayor autonomía disponible al proveedor; los permisos exactos varían por CLI. Usar únicamente en entornos descartables o contenedores aislados. |
| `ask` | Los agentes API pueden leer, pero no escriben ni ejecutan comandos hasta que exista una aprobación interactiva. |

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

**¿Pueden pisarse los cambios de agentes paralelos?**
Los agentes del motor nativo trabajan en copias privadas. MORAGENT incorpora archivos y directorios sólo si los originales no cambiaron; ante un conflicto bloquea la tarea y conserva su copia en `.moragent/runs/recovery/`. También incluye directorios vacíos y cambios de permisos de directorio. Los commits, ramas, etiquetas, stashes, `HEAD` desacoplado, cambios locales en `.git/config` o cambios staged privados conservan la copia para no perder estado Git silenciosamente. Recuperar rutas nunca traslada ese estado Git ni borra la copia guardada. Evita sobrescrituras accidentales al integrar, pero no es una barrera de seguridad del sistema operativo para CLIs sin restricciones.

Para requisitos de contenido exacto en archivos de texto, el plan puede incluir comprobaciones estructuradas `file_text` (líneas y una bandera explícita para el salto de línea final). Si la solicitud exige explícitamente contenido exacto o LF final, MORAGENT requiere esa comprobación antes de desplegar; cuando nombra un solo archivo inequívoco, debe cubrir esa ruta. Para varios archivos o líneas, puedes agregar un contrato explícito al pedido:

```moragent-checks
{"files":[{"path":"a.txt","lines":["primera","segunda"],"finalNewline":true},{"path":"b.txt","lines":["última"],"finalNewline":false}]}
```

MORAGENT exige que el plan cubra todos los archivos y coteja cada comprobación con tu bloque antes de desplegar workers. Toda tarea que cambie uno de esos archivos debe igualar tus bytes antes de publicar su copia privada, aunque el plan haya puesto su comprobación en una tarea posterior. Una diferencia bloquea la tarea y conserva la copia para inspección manual aunque el agente afirme haber terminado. Sin un bloque explícito, sólo ancla pedidos literales inequívocos de una línea; no deduce bytes arbitrarios de la prosa. Los demás criterios aún requieren revisión.

Las comprobaciones no pueden apuntar a rutas que MORAGENT no publica: `.git`, `node_modules` ni sus directorios internos `.moragent/{runs,tasks,sessions,memory}`.

Los workers API nativos pueden escribir texto exacto con `write_file({path, lines, final_newline})`, que construye los bytes LF sin depender de que el modelo escape `\n` dentro de una cadena. La forma original con `content` sigue disponible.

Los enlaces simbólicos internos se redirigen hacia cada copia privada. Un enlace que apunta fuera del proyecto, incluso dentro de `node_modules`, impide preparar el worker y muestra un error: MORAGENT no puede llamar «aislada» a una copia cuyo enlace aún alcanza archivos externos. Esto no impide que un CLI elija por sí mismo una ruta absoluta externa.

`node_modules` se copia como contexto del agente, pero nunca se publica en el proyecto real. Los cambios ordinarios de dependencias se detectan por metadatos del sistema de archivos; bloquean la integración y conservan la copia. `/recuperaciones inspeccionar` muestra una muestra, y aplicar otras rutas deja las dependencias en esa copia. Esto no equivale a comparar byte por byte todos los archivos de dependencias.

**¿Envía mi código a servidores de MORAGENT?**  
No. MORAGENT no tiene servidores ni recolecta telemetría. Tus CLIs de agentes se comunican directamente con sus respectivos proveedores, y las instancias locales de Ollama corren completamente fuera de línea.

**¿Cuánto cuesta?**  
MORAGENT es 100% gratuito y de código abierto (MIT). Sólo pagas tus propias suscripciones o el consumo de API directamente a cada proveedor.

**¿Puedo usar un solo motor para todo?**  
Sí. Puedes configurar tanto el orquestador como los subagentes con el mismo motor (por ejemplo, sólo Claude Code, sólo Codex, o 100% local con Ollama).
Si una API es el único proveedor listo en el primer uso, MORAGENT la guarda como orquestador del proyecto. `mora doctor` comprueba esa API por separado; los CLIs ausentes advierten que no habrá paneles externos, sin invalidar el flujo nativo con API.

**¿Puedo revertir los cambios de MORAGENT?**  
Todo se almacena limpiamente en `.moragent/` junto con bloques de comentarios gestionados en `AGENTS.md` o `CLAUDE.md`. Si los eliminas, tu repositorio vuelve exactamente a su estado original.

---

## Contribuir

Las contribuciones son bienvenidas: consulta [CONTRIBUTING.md](CONTRIBUTING.md) y los contratos técnicos en [docs/ENGINE.md](docs/ENGINE.md) y [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Ejecuta `npm test` antes de enviar tus cambios.

## Licencia

[MIT](LICENSE) © Eduardo Moraga
