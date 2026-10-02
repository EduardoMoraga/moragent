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
$sourceKind = "npm"
$repoUrl = "https://github.com/EduardoMoraga/moragent.git"
$tarballUrl = "https://github.com/EduardoMoraga/moragent/archive/refs/heads/$branch.tar.gz"
npm view moragent version *> $null
if ($branch -ne "master" -or $env:MORAGENT_FROM_GIT -eq "1" -or $LASTEXITCODE -ne 0) {
  $pkg = $tarballUrl
  $sourceKind = "github-tarball"
}

$revision = ""
if ($sourceKind -eq "github-tarball") {
  try {
    $commit = Invoke-RestMethod -Headers @{ 'User-Agent' = 'moragent-install' } -Uri "https://api.github.com/repos/EduardoMoraga/moragent/commits/$([uri]::EscapeDataString($branch))"
    if ($commit.sha -notmatch '^[0-9a-f]{40}$') { Fail "No pude resolver la revisión de $branch / Could not resolve $branch revision" }
    $revision = $commit.sha
    $tarballUrl = "https://github.com/EduardoMoraga/moragent/archive/$revision.tar.gz"
    $pkg = $tarballUrl
  } catch { Fail "No pude resolver la revisión de $branch / Could not resolve $branch revision" }
}

function Write-InstallMetadata($prefix) {
  if ($sourceKind -ne "github-tarball") { return }
  $npmRoot = (& npm root -g --prefix $prefix | Select-Object -Last 1).Trim()
  $packageRoot = Join-Path $npmRoot 'moragent'
  $metadata = [ordered]@{
    schemaVersion = 1
    installedAt = (Get-Date).ToUniversalTime().ToString('o')
    revision = $revision
    source = [ordered]@{
      type = 'github-tarball'
      repoUrl = $repoUrl
      branch = $branch
      ref = "refs/heads/$branch"
      tarballUrl = $tarballUrl
    }
  } | ConvertTo-Json -Depth 4
  $metadataPath = Join-Path $packageRoot '.moragent-install.json'
  [System.IO.File]::WriteAllText($metadataPath, "$metadata`n", [System.Text.UTF8Encoding]::new($false))
}

$sourceLabel = if ($revision) { "$branch ($revision)" } else { "npm" }
Info "Instalando MORAGENT desde $sourceLabel / Installing MORAGENT from $sourceLabel"
$installedPrefix = (& npm prefix -g | Select-Object -Last 1).Trim()
$installedMora = Join-Path $installedPrefix 'mora.cmd'
# npm is a native command: failures set $LASTEXITCODE instead of throwing.
npm i -g $pkg
if ($LASTEXITCODE -ne 0) {
  Warn "Falló instalación global. Reintentando en $HOME\.local / Global install failed, retrying in $HOME\.local"
  $prefix = Join-Path $HOME ".local"
  New-Item -ItemType Directory -Force -Path $prefix | Out-Null
  npm i -g --prefix $prefix $pkg
  if ($LASTEXITCODE -ne 0) { Fail "npm install falló / npm install failed" }
  $installedPrefix = $prefix
  $installedMora = Join-Path $prefix 'mora.cmd'
  # On Windows npm puts global shims directly in the prefix, not in prefix\bin.
  if (($env:Path -split ';') -notcontains $prefix) { Warn "Agrega a PATH / Add to PATH: $prefix" }
}
Write-InstallMetadata $installedPrefix

if (Test-Path $installedMora) {
  Info "Versión instalada / Installed version: $(& $installedMora --version)"
  Info "Ejecutando doctor / Running doctor"
  & $installedMora doctor
  if ($LASTEXITCODE -ne 0) { Warn "doctor reportó advertencias; la instalación del CLI continuó." }
} else {
  Fail "No encontré el ejecutable instalado / Installed executable not found: $installedMora"
}

Write-Host "`nSiguiente paso / Next step: cd tu-proyecto && mora"
