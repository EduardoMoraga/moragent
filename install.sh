#!/bin/sh
set -eu

is_tty=0
[ -t 1 ] && is_tty=1
color() { if [ "$is_tty" -eq 1 ]; then printf '\033[%sm%s\033[0m' "$1" "$2"; else printf '%s' "$2"; fi; }
info() { printf '%s %s\n' "$(color 36 '›')" "$1"; }
warn() { printf '%s %s\n' "$(color 33 '!')" "$1"; }
fail() { printf '%s %s\n' "$(color 31 '✗')" "$1" >&2; exit 1; }

need_node() {
  cat <<'MSG'
Node.js >= 18 es requerido / is required.
macOS: brew install node
Ubuntu/Debian: use https://nodejs.org or NodeSource
Fedora: sudo dnf install nodejs npm
Arch: sudo pacman -S nodejs npm
MSG
}

if ! command -v node >/dev/null 2>&1; then need_node; exit 1; fi
major=$(node -p "process.versions.node.split('.')[0]")
[ "$major" -ge 18 ] || { need_node; exit 1; }
command -v npm >/dev/null 2>&1 || fail "npm no está disponible / npm is not available"

# Install a selected Git branch directly (for previews); otherwise use npm when
# published, falling back to the default Git branch when the registry is unavailable.
branch=${MORAGENT_BRANCH:-master}
case "$branch" in
  ''|/*|*/|*//*|*..*|*[!A-Za-z0-9._/-]*) fail "MORAGENT_BRANCH no es una rama válida / is not a valid branch name" ;;
esac
pkg="moragent"
source_kind="npm"
repo_url="https://github.com/EduardoMoraga/moragent.git"
tarball_url="https://github.com/EduardoMoraga/moragent/archive/refs/heads/${branch}.tar.gz"
if [ "$branch" != "master" ] || [ "${MORAGENT_FROM_GIT:-0}" = "1" ] || ! npm view moragent version >/dev/null 2>&1; then
  pkg="$tarball_url"
  source_kind="github-tarball"
fi

resolve_revision() {
  node - "$repo_url" "$branch" <<'NODE'
const https = require('node:https');
const [repoUrl, branch] = process.argv.slice(2);
const match = repoUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/);
if (!match) process.exit(1);
const path = `/repos/${match[1]}/${match[2]}/commits/${encodeURIComponent(branch)}`;
const req = https.request({ hostname: 'api.github.com', path, headers: { 'User-Agent': 'moragent-install' } }, (res) => {
  let body = '';
  res.setEncoding('utf8');
  res.on('data', (chunk) => { body += chunk; });
  res.on('end', () => {
    try {
      const json = JSON.parse(body);
      if (res.statusCode !== 200 || !/^[0-9a-f]{40}$/i.test(json.sha)) process.exit(1);
      console.log(json.sha);
    } catch { process.exit(1); }
  });
});
req.on('error', () => process.exit(1));
req.end();
NODE
}

write_metadata() {
  [ "$source_kind" = "github-tarball" ] || return 0
  revision="$1"
  prefix="$2"
  package_root="$(npm root -g --prefix "$prefix")/moragent"
  node - "$package_root" "$repo_url" "$branch" "$tarball_url" "$revision" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [root, repoUrl, branch, tarballUrl, revision] = process.argv.slice(2);
fs.writeFileSync(path.join(root, '.moragent-install.json'), JSON.stringify({
  schemaVersion: 1,
  installedAt: new Date().toISOString(),
  revision,
  source: { type: 'github-tarball', repoUrl, branch, ref: `refs/heads/${branch}`, tarballUrl },
}, null, 2) + '\n');
NODE
}

revision=""
if [ "$source_kind" = "github-tarball" ]; then
  revision="$(resolve_revision)" || fail "No pude resolver la revisión de ${branch} / Could not resolve ${branch} revision"
  tarball_url="https://github.com/EduardoMoraga/moragent/archive/${revision}.tar.gz"
  pkg="$tarball_url"
fi

info "Instalando MORAGENT desde ${branch} (${revision:-npm}) / Installing MORAGENT from ${branch} (${revision:-npm})"
installed_prefix="$(npm prefix -g)"
installed_mora="$installed_prefix/bin/mora"
if npm i -g "$pkg"; then
  :
else
  warn "Falló instalación global (permisos). Reintentando en ~/.local / Global install failed, retrying in ~/.local"
  mkdir -p "$HOME/.local"
  npm i -g --prefix "$HOME/.local" "$pkg"
  installed_prefix="$HOME/.local"
  installed_mora="$HOME/.local/bin/mora"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) : ;;
    *) warn "Agrega a PATH: export PATH=\"$HOME/.local/bin:$PATH\"" ;;
  esac
fi
write_metadata "$revision" "$installed_prefix"

if [ -x "$installed_mora" ]; then
  info "Versión instalada / Installed version: $("$installed_mora" --version)"
  info "Ejecutando doctor / Running doctor"
  "$installed_mora" doctor || true
else
  fail "No encontré el ejecutable instalado / Installed executable not found: $installed_mora"
fi

printf '\n%s\n' "Siguiente paso / Next step: cd tu-proyecto && mora"
