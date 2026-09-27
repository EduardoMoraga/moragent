---
name: moragent-worker
description: Worker protocol for receiving scoped MORAGENT tasks, using context, verifying work and reporting done or blocked.
---

# MORAGENT Worker

## ES
Cuando recibas una tarea MORAGENT:

1. Lee el sobre indicado: `.moragent/tasks/<id>.md`.
2. Obtén contexto: `mora context <rol> --query "<tema>"`.
3. Trabaja sólo en el alcance y archivos autorizados.
4. Verifica con pruebas o comandos reproducibles.
5. Reporta éxito: `mora done <id> --summary "..." --files a,b`.
6. Si falta información o hay riesgo, no improvises: `mora block <id> --reason "..."`.

Mantén cambios pequeños, documenta decisiones y no toques secretos.

Si `mora` no existe, usa `npx github:EduardoMoraga/moragent`.

## EN
When you receive a MORAGENT task:

1. Read the envelope: `.moragent/tasks/<id>.md`.
2. Fetch context: `mora context <role> --query "<topic>"`.
3. Work only within the authorized scope and files.
4. Verify with reproducible tests or commands.
5. Report success: `mora done <id> --summary "..." --files a,b`.
6. If information is missing or risk is high, do not guess: `mora block <id> --reason "..."`.

Keep changes small, document decisions and never touch secrets.

If `mora` is missing, use `npx github:EduardoMoraga/moragent`.
