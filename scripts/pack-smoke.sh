#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

rm -f moragent-*.tgz
TARBALL="$(npm pack --silent | tail -n 1)"
TARBALL_PATH="$ROOT/$TARBALL"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; rm -f "$TARBALL_PATH"' EXIT

assert_has() {
  local pattern="$1"
  if ! tar -tf "$TARBALL_PATH" | grep -Eq "$pattern"; then
    echo "Missing from tarball: $pattern" >&2
    exit 1
  fi
}

assert_not_has() {
  local pattern="$1"
  if tar -tf "$TARBALL_PATH" | grep -Eq "$pattern"; then
    echo "Unexpected tarball entry: $pattern" >&2
    tar -tf "$TARBALL_PATH" | grep -E "$pattern" >&2
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
export PATH="$PREFIX/bin:$PATH"

APP="$TMP/app"
mkdir -p "$APP"
cd "$APP"

mora --version >/dev/null
mora init --yes --preset trio >/dev/null
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

cd "$ROOT"
npx --yes "./$TARBALL" --version >/dev/null
NPX_APP="$TMP/npx-app"
mkdir -p "$NPX_APP"
cp "$TARBALL_PATH" "$NPX_APP/$TARBALL"
cd "$NPX_APP"
npx --yes "./$TARBALL" init --yes >/dev/null

echo "pack smoke ok: $TARBALL"
