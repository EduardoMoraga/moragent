$ErrorActionPreference = 'Stop'

function Info($m) { Write-Host "› $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "! $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "✗ $m" -ForegroundColor Red; exit 1 }

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "Node.js >= 18 es requerido / is required."
  Write-Host "Windows: winget install OpenJS.NodeJS.LTS  (o descarga desde https://nodejs.org)"
  exit 1
}
$major = [int](& node -p "process.versions.node.split('.')[0]")
if ($major -lt 18) { Fail "Node.js >= 18 requerido. Instala LTS desde https://nodejs.org" }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail "npm no está disponible / npm is not available" }

# Install a selected Git branch directly (for previews); otherwise use npm when
# published, falling back to the default Git branch when the registry is unavailable.
$branch = if ($env:MORAGENT_BRANCH) { $env:MORAGENT_BRANCH } else { "master" }
if ($branch -notmatch '^[A-Za-z0-9._/-]+$' -or $branch.StartsWith('/') -or $branch.EndsWith('/') -or $branch.Contains('..') -or $branch.Contains('//')) {
  Fail "MORAGENT_BRANCH no es una rama válida / is not a valid branch name"
}
$pkg = "moragent"
npm view moragent version *> $null
if ($branch -ne "master" -or $env:MORAGENT_FROM_GIT -eq "1" -or $LASTEXITCODE -ne 0) { $pkg = "https://github.com/EduardoMoraga/moragent/archive/refs/heads/$branch.tar.gz" }

Info "Instalando MORAGENT desde $branch / Installing MORAGENT from $branch"
# npm is a native command: failures set $LASTEXITCODE instead of throwing.
npm i -g $pkg
if ($LASTEXITCODE -ne 0) {
  Warn "Falló instalación global. Reintentando en $HOME\.local / Global install failed, retrying in $HOME\.local"
  $prefix = Join-Path $HOME ".local"
  New-Item -ItemType Directory -Force -Path $prefix | Out-Null
  npm i -g --prefix $prefix $pkg
  if ($LASTEXITCODE -ne 0) { Fail "npm install falló / npm install failed" }
  # On Windows npm puts global shims directly in the prefix, not in prefix\bin.
  if (($env:Path -split ';') -notcontains $prefix) { Warn "Agrega a PATH / Add to PATH: $prefix" }
}

if (Get-Command mora -ErrorAction SilentlyContinue) {
  Info "Ejecutando doctor / Running doctor"
  mora doctor
  if ($LASTEXITCODE -ne 0) { Warn "doctor reportó advertencias; la instalación del CLI continuó." }
} else {
  Warn "mora aún no está en PATH. Abre una nueva terminal o ajusta PATH."
}

Write-Host "`nSiguiente paso / Next step: cd tu-proyecto && mora"
