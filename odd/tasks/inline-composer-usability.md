# Inline composer usability

## Objective
Make the no-argument `mora` composer usable for long and pasted prompts without changing command or noninteractive routing.

## Problem and evidence
An 80-column PTY reproduction showed that ordinary text appears, but a long draft is truncated with an ellipsis in a one-line box. A bracketed multi-line paste delivered in one chunk was dropped. The current renderer clips the draft, and the input decoder treats an ESC-prefixed paste chunk as one unknown key.

## Scope and constraints
- Change only the inline TUI input/composer path, its focused tests, and relevant user documentation.
- Keep final transcript messages in native terminal scrollback, preserve slash commands, no-argument launch, and noninteractive behavior.
- Use the existing Node.js standard-library runtime and bilingual UI copy.
- The referenced `.moragent/specs/redisenar-moragent-para-una/*` files are not present in this worktree; use the brief's stated paste/Enter distinction as the requirement.

## Tasks
- [x] C1 (direct inline: worker must execute personally; no subdelegation): Add a wrapped, cursor-visible inline draft and persistent send/newline/clear/help hints; decode bracketed paste safely without submission. Cover ordinary typing, long wrapping, paste/newline, redraw, and resize with executable tests. Update inline TUI documentation.

## Acceptance and checks
- Draft remains visible after typing and store redraws; long input wraps; multi-line paste remains editable until explicit Enter.
- Bracketed-paste mode is enabled only during inline TUI lifetime and restored on exit.
- Run focused `node --test test/tui-inline.test.js test/tui.test.js`, `npm test`, `npm run build`, and `npm run pack:smoke`.
- Reproduce the corrected path in a PTY.

## Progress
- Branch: `fm/moragent-v4-composer-ux-e1`.
- Baseline PTY reproduction: ordinary draft shown; long draft ellipsized; bracketed paste dropped.
- Regression tests first failed on clipping and paste submission, then passed after implementation.
- Verification: focused tests 16/16; full `npm test` 211/211; `npm run build` passed; `npm run pack:smoke` passed; `git diff --check` passed; PTY showed wrapped draft and paste; `--help` still exits 0 and noninteractive no-arg still rejects input with exit 1.
- Implementation: a bounded draft viewport follows the cursor, keeping the live region smaller than the terminal for long prompts. Bracketed paste is enabled only during inline TUI lifetime and decoded across data chunks.
- Follow-up: a richer composer could add vertical navigation and selection while retaining native scrollback.
- Work-unit commit: `a0883be` (`fix(tui): keep long and pasted drafts visible`).
- Next: Firstmate-owned no-mistakes validation and PR handoff.
