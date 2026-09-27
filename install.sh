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

pkg="moragent"
if [ "${MORAGENT_FROM_GIT:-0}" = "1" ]; then
  pkg="git+https://github.com/EduardoMoraga/moragent.git"
fi

info "Instalando MORAGENT / Installing MORAGENT"
if npm i -g "$pkg"; then
  :
else
  warn "Falló instalación global (permisos). Reintentando en ~/.local / Global install failed, retrying in ~/.local"
  mkdir -p "$HOME/.local"
  npm i -g --prefix "$HOME/.local" "$pkg"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) : ;;
    *) warn "Agrega a PATH: export PATH=\"$HOME/.local/bin:$PATH\"" ;;
  esac
fi

if command -v mora >/dev/null 2>&1; then
  info "Ejecutando doctor / Running doctor"
  mora doctor || true
else
  warn "mora aún no está en PATH. Abre una nueva terminal o ajusta PATH."
fi

printf '\n%s\n' "Siguiente paso / Next step: cd tu-proyecto && mora"
