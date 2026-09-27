# Contributing to MORAGENT

Gracias por aportar. Mantén cambios pequeños, testeables y alineados con `docs/ARCHITECTURE.md`.

## Setup

```sh
npm test
node bin/mora.js init --yes --json
```

## Rules

- Node >= 18 stdlib only at runtime.
- ESM, 2 spaces, single quotes.
- User-visible text should be bilingual via `t('es', 'en')` when in CLI code.
- Do not commit secrets or local `.moragent/runs`, context or transient memory.
- Add `node:test` coverage for new behavior.

## Pull requests

Include: summary, files changed, test commands, risks and screenshots/logs if UI-facing.
