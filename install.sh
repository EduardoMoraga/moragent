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
if [ "$branch" != "master" ] || [ "${MORAGENT_FROM_GIT:-0}" = "1" ] || ! npm view moragent version >/dev/null 2>&1; then
  pkg="https://github.com/EduardoMoraga/moragent/archive/refs/heads/${branch}.tar.gz"
fi

info "Instalando MORAGENT desde ${branch} / Installing MORAGENT from ${branch}"
installed_mora="$(npm prefix -g)/bin/mora"
if npm i -g "$pkg"; then
  :
else
  warn "Falló instalación global (permisos). Reintentando en ~/.local / Global install failed, retrying in ~/.local"
  mkdir -p "$HOME/.local"
  npm i -g --prefix "$HOME/.local" "$pkg"
  installed_mora="$HOME/.local/bin/mora"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) : ;;
    *) warn "Agrega a PATH: export PATH=\"$HOME/.local/bin:$PATH\"" ;;
  esac
fi

if [ -x "$installed_mora" ]; then
  info "Versión instalada / Installed version: $("$installed_mora" --version)"
  info "Ejecutando doctor / Running doctor"
  "$installed_mora" doctor || true
else
  fail "No encontré el ejecutable instalado / Installed executable not found: $installed_mora"
fi

printf '\n%s\n' "Siguiente paso / Next step: cd tu-proyecto && mora"
