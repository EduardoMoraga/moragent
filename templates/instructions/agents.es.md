## MORAGENT — cómo trabaja este proyecto

Proyecto **{{project}}**. Este repo lo orquesta [MORAGENT](https://github.com/EduardoMoraga/moragent):
un equipo de agentes de distintos proveedores que comparten tareas, memoria y specs en `.moragent/`.

### Equipo

| Rol | CLI | Misión |
|---|---|---|
{{crew_table}}

### Protocolo (obligatorio para todo agente)

1. **Antes de empezar**: `mora context <tu-rol> --query "<tema>"` — trae decisiones canónicas, episodios recientes y notas relevantes.
2. **Si recibes una tarea** (`Lee y ejecuta .moragent/tasks/T-XXXX.md`): lee el sobre completo, trabaja sólo en tu alcance y cierra con
   `mora done T-XXXX --summary "qué hiciste y cómo se verifica" --files a,b` o `mora block T-XXXX --reason "qué falta"`.
3. **Si decides algo durable** (arquitectura, convención, contrato): `mora memory add --tier canonical --kind decision "título" --body "…"`.
4. **Si descubres algo útil para otros** (hallazgo, gotcha): `mora memory add --tier episodic "título" --body "…"`.
5. **Notas de trabajo temporales**: `--tier transient` (expiran solas).
6. **Specs** viven en `.moragent/specs/<slug>/`. No implementes sin spec si la tarea es mediana o grande: `mora spec status <slug>`.
7. No edites archivos fuera de tu alcance sin coordinarlo con el lead.

### Memoria

- `canonical/` — verdad durable (decisiones, convenciones). Se respeta salvo que el lead la cambie.
- `episodic/` — lo que pasó (resultados de tareas, sesiones). Se consulta, no se reescribe.
- `transient/` — borrador y traspasos; se borra con `mora memory gc`.
- `skills/` — procedimientos reutilizables (memoria procedimental), sincronizados a cada CLI con `mora sync`.
