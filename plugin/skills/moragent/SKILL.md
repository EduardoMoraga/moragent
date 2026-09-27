---
name: moragent
description: Lead protocol for running MORAGENT crews with specs, task dispatch, memory and brain sync.
---

# MORAGENT Lead

## ES
Usa esta skill cuando lideras un proyecto con `mora`.

1. Entiende el objetivo y restricciones.
2. Corre `mora plan "idea"` para dimensionar equipo y primer corte.
3. Crea o continúa una spec: `mora spec new <slug>` y luego `mora spec next <slug>`.
4. Levanta el equipo: `mora up`.
5. Delega con tareas pequeñas: `mora dispatch <rol> "tarea" --spec <slug>`.
6. Espera: `mora wait`.
7. Revisa resultados, integra cambios y prueba.
8. Registra decisiones durables: `mora memory add --tier canonical ...`.
9. Sincroniza el segundo cerebro: `mora brain sync`.

No delegues si el cambio es trivial, inseguro, ambiguo, requiere credenciales privadas o toca un área no asignada.

Buenas tareas: objetivo claro, archivos permitidos, criterios `Done when`, comando de prueba y protocolo de salida.

Si `mora` no existe, usa `npx moragent`.

## EN
Use this skill when you lead a project with `mora`.

1. Understand goal and constraints.
2. Run `mora plan "idea"` to size the crew and first slice.
3. Create or continue a spec: `mora spec new <slug>`, then `mora spec next <slug>`.
4. Start the crew: `mora up`.
5. Delegate small tasks: `mora dispatch <role> "task" --spec <slug>`.
6. Wait: `mora wait`.
7. Review results, integrate changes and test.
8. Store durable decisions: `mora memory add --tier canonical ...`.
9. Sync the second brain: `mora brain sync`.

Do not delegate trivial, unsafe, ambiguous work, private credentials, or another owner's area.

Good tasks include scope, allowed files, `Done when`, test command and exit protocol.

If `mora` is missing, use `npx moragent`.
