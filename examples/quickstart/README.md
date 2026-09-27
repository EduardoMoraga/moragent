# MORAGENT quickstart / inicio rápido

## ES — API de tareas en 5 minutos

Este recorrido crea un proyecto ejemplo para una API de tareas con frontend React. No requiere agentes instalados para ver la estructura; los comandos `--dry-run` simulan la orquestación.

### 1. Crear el proyecto

```sh
mkdir tareas-demo && cd tareas-demo
mora init --yes --preset trio --lang es
```

Aparecen:

```text
AGENTS.md
CLAUDE.md
GEMINI.md
.moragent/moragent.json
.moragent/memory/canonical/project.md
.moragent/specs/
.moragent/tasks/
```

### 2. Convertir la idea en spec

```sh
mora plan "API de tareas con frontend React"
mora spec status
```

Aparece una carpeta similar a:

```text
.moragent/specs/api-de-tareas-con-frontend-react/
├── proposal.md
├── spec.md
├── design.md
├── tasks.md
└── state.json
```

Edita cada archivo siguiendo `mora spec next <slug>`. El estado avanza cuando los archivos cumplen las reglas: propuesta sin `TODO:`, requisitos EARS `RF-n`, diseño sin pendientes y tareas con `Done when`.

### 3. Simular equipo y tareas

```sh
mora up --dry-run
mora dispatch backend "Crear endpoints CRUD de tareas" --dry-run
mora dispatch frontend "Crear UI React para listar y completar tareas" --dry-run
mora board
```

Cuando quites `--dry-run`, MORAGENT crea sobres en:

```text
.moragent/tasks/T-0001.json
.moragent/tasks/T-0001.md
```

El `.md` es el sobre que lee el agente; el `.json` es el estado del bus.

### 4. Registrar memoria

```sh
mora memory add "Arquitectura API tareas" --tier canonical --kind decision --body "La API expondrá /tasks con CRUD básico."
mora memory recall tareas
```

Aparecen notas en:

```text
.moragent/memory/canonical/
.moragent/memory/episodic/
.moragent/memory/transient/
```

### 5. Próximo paso real

Completa la spec, divide `tasks.md` en tareas pequeñas y ejecuta:

```sh
mora up
mora spec tasks <slug> --dispatch
mora wait T-0001
```

## EN — Task API in 5 minutes

This walkthrough creates an example project for a task API with a React frontend. You do not need agent CLIs installed to inspect the structure; `--dry-run` simulates orchestration.

### 1. Create the project

```sh
mkdir tasks-demo && cd tasks-demo
mora init --yes --preset trio --lang en
```

Files appear:

```text
AGENTS.md
CLAUDE.md
GEMINI.md
.moragent/moragent.json
.moragent/memory/canonical/project.md
.moragent/specs/
.moragent/tasks/
```

### 2. Turn the idea into a spec

```sh
mora plan "Task API with a React frontend"
mora spec status
```

A folder appears:

```text
.moragent/specs/task-api-with-a-react-frontend/
├── proposal.md
├── spec.md
├── design.md
├── tasks.md
└── state.json
```

Edit each file following `mora spec next <slug>`. State advances when files meet the rules: proposal without `TODO:`, EARS `RF-n` requirements, design without placeholders and tasks with `Done when`.

### 3. Simulate crew and tasks

```sh
mora up --dry-run
mora dispatch backend "Create task CRUD endpoints" --dry-run
mora dispatch frontend "Create React UI to list and complete tasks" --dry-run
mora board
```

Without `--dry-run`, MORAGENT creates envelopes in:

```text
.moragent/tasks/T-0001.json
.moragent/tasks/T-0001.md
```

The `.md` file is the agent envelope; the `.json` file is bus state.

### 4. Save memory

```sh
mora memory add "Task API architecture" --tier canonical --kind decision --body "The API exposes /tasks with basic CRUD."
mora memory recall tasks
```

Notes appear in:

```text
.moragent/memory/canonical/
.moragent/memory/episodic/
.moragent/memory/transient/
```

### 5. Real next step

Complete the spec, split `tasks.md` into small tasks and run:

```sh
mora up
mora spec tasks <slug> --dispatch
mora wait T-0001
```
