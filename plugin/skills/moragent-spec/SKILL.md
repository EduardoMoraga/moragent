---
name: moragent-spec
description: Drive spec-driven development phases with mora spec next, EARS requirements, design and tasks.
---

# MORAGENT Spec

## ES
Usa SDD determinista: el estado sale de archivos, no de opiniones.

Fases: explore → propose → spec → design → tasks → apply → verify → archive.

Comandos:
- `mora spec status [slug]`
- `mora spec next <slug>`
- `mora spec tasks <slug> --dispatch`
- `mora spec archive <slug>`

Requisitos: `RF-n: Cuando <evento>, el sistema debe <respuesta>`.
Tareas: `- [ ] T1: título @rol — Done when: criterio`.

Avanza sólo cuando el archivo elimina `TODO:` y cumple la regla de la fase.

## EN
Use deterministic SDD: state comes from files, not opinions.

Phases: explore → propose → spec → design → tasks → apply → verify → archive.

Commands:
- `mora spec status [slug]`
- `mora spec next <slug>`
- `mora spec tasks <slug> --dispatch`
- `mora spec archive <slug>`

Requirements: `RF-n: When <trigger>, the system shall <response>`.
Tasks: `- [ ] T1: title @role — Done when: criterion`.

Advance only when the file removes `TODO:` and satisfies the phase rule.
