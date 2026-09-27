#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
VERSION="$(node -p "require('./package.json').version")"

rm -f moragent-*.tgz
TARBALL="$(npm pack --silent | tail -n 1)"
TARBALL_PATH="$ROOT/$TARBALL"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; rm -f "$TARBALL_PATH"' EXIT

# List once: `tar | grep -q` under pipefail fails when grep exits early and tar gets SIGPIPE.
LISTING="$(tar -tf "$TARBALL_PATH")"

assert_has() {
  local pattern="$1"
  if ! grep -Eq "$pattern" <<<"$LISTING"; then
    echo "Missing from tarball: $pattern" >&2
    exit 1
  fi
}

assert_not_has() {
  local pattern="$1"
  if grep -Eq "$pattern" <<<"$LISTING"; then
    echo "Unexpected tarball entry: $pattern" >&2
    grep -E "$pattern" <<<"$LISTING" >&2
    exit 1
  fi
}

assert_has '^package/bin/mora\.js$'
assert_has '^package/src/cli\.js$'
assert_has '^package/templates/spec/es/proposal\.md$'
assert_has '^package/templates/skills/moragent/SKILL\.md$'
assert_has '^package/plugin/skills/moragent/SKILL\.md$'
assert_has '^package/install\.sh$'
assert_has '^package/install\.ps1$'
assert_has '^package/docs/ARCHITECTURE\.md$'
assert_has '^package/docs/demo\.tape$'
assert_has '^package/examples/quickstart/README\.md$'
assert_has '^package/\.claude-plugin/plugin\.json$'
assert_has '^package/\.codex-plugin/plugin\.json$'
assert_not_has '^package/\.crew(/|$)'
assert_not_has '^package/test(/|$)'
assert_not_has '^package/\.moragent(/|$)'
assert_not_has '^package/node_modules(/|$)'
assert_not_has '^package/.*\.tgz$'

PREFIX="$TMP/p"
npm i -g --prefix "$PREFIX" "$TARBALL_PATH" >/dev/null

FAKE_BIN="$TMP/fake-bin"
mkdir -p "$FAKE_BIN"
if [ "${OS:-}" = "Windows_NT" ]; then
  cat > "$FAKE_BIN/codex.cmd" <<'EOF'
@echo off
if "%1"=="--version" (echo codex 0.0.0 & exit /b 0)
timeout /t 60 >nul
EOF
  cat > "$FAKE_BIN/claude.cmd" <<'EOF'
@echo off
if "%1"=="--version" (echo claude 0.0.0 & exit /b 0)
timeout /t 60 >nul
EOF
else
  cat > "$FAKE_BIN/codex" <<'EOF'
#!/bin/sh
[ "${1:-}" = "--version" ] && { echo "codex 0.0.0"; exit 0; }
sleep 60
EOF
  cat > "$FAKE_BIN/claude" <<'EOF'
#!/bin/sh
[ "${1:-}" = "--version" ] && { echo "claude 0.0.0"; exit 0; }
sleep 60
EOF
  chmod +x "$FAKE_BIN/codex" "$FAKE_BIN/claude"
fi
export PATH="$PREFIX/bin:$FAKE_BIN:$PATH"

APP="$TMP/app"
mkdir -p "$APP"
cd "$APP"

mora --version >/dev/null
mora init --yes --preset trio >/dev/null
test -f .claude/settings.json
node -e "const s=require('./.claude/settings.json'); if (!JSON.stringify(s).includes('memory capture --from claude')) process.exit(1)"
test ! -f .codex/config.toml
set +e
mora doctor --json > doctor.json
DOCTOR_CODE=$?
set -e
node -e "JSON.parse(require('fs').readFileSync('doctor.json', 'utf8'))"
echo "doctor exit code: $DOCTOR_CODE"
mora spec new x >/dev/null
mora memory add "a" --body b >/dev/null
mora board >/dev/null
mora help >/dev/null
mora resend --help >/dev/null
mora sync --hooks --dry-run >/dev/null
mora up --dry-run --json > up-dry.json
node -e "const r=JSON.parse(require('fs').readFileSync('up-dry.json','utf8')); if (JSON.stringify(r).includes('.moragent/runs/bin')) process.exit(1);"
test ! -e .moragent/runs/bin/mora
mora up --mux headless backend >/dev/null
.moragent/runs/bin/mora --version | grep -qx "$VERSION"

cd "$ROOT"
npx --yes "./$TARBALL" --version >/dev/null
NPX_APP="$TMP/npx-app"
mkdir -p "$NPX_APP"
cp "$TARBALL_PATH" "$NPX_APP/$TARBALL"
cd "$NPX_APP"
npx --yes "./$TARBALL" init --yes >/dev/null

echo "pack smoke ok: $TARBALL"
