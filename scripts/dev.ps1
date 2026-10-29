<#
.SYNOPSIS
  Run the CrewBrief stack locally on Windows (the PowerShell equivalent of `make dev`).

.DESCRIPTION
  Starts the four Python services and the web app, each in its own window so you can read
  its logs. Press Enter in this window to stop everything.

  First run: builds the local hazard search index and installs the web app's npm packages
  if they are missing. Assumes the Python dependencies are installed in .venv:
      py -3.12 -m venv .venv
      .venv\Scripts\pip install -e ".[dev]"

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
#>
$ErrorActionPreference = "Stop"

# Run from the repo root so `packages.*` / `services.*` import and `.env` is found.
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$python = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) {
    Write-Host "No .venv found. Create it first:" -ForegroundColor Red
    Write-Host '  py -3.12 -m venv .venv'
    Write-Host '  .venv\Scripts\pip install -e ".[dev]"'
    exit 1
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "npm not found. Install Node.js 20 or newer from https://nodejs.org" -ForegroundColor Red
    exit 1
}

# One-time setup: local search index and web app packages.
if (-not (Test-Path (Join-Path $root "var\search\index.json"))) {
    Write-Host "==> Building the local hazard search index" -ForegroundColor Cyan
    & $python -m knowledge.ingest --source ./knowledge/sources --index hazards
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
$portal = Join-Path $root "apps\review-portal"
if (-not (Test-Path (Join-Path $portal "node_modules"))) {
    Write-Host "==> Installing web app packages (first run only)" -ForegroundColor Cyan
    npm --prefix $portal install
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$services = @(
    @{ Name = "form-api";     Port = 8001; Command = "& '$python' -m services.form_api" },
    @{ Name = "gateway";      Port = 8000; Command = "& '$python' -m services.gateway" },
    @{ Name = "orchestrator"; Port = 8002; Command = "& '$python' -m services.orchestrator" },
    @{ Name = "roles";        Port = 8003; Command = "& '$python' -m services.roles" },
    @{ Name = "web app";      Port = 3000; Command = "npm --prefix '$portal' run dev" }
)

$started = @()
foreach ($svc in $services) {
    $title = "CrewBrief $($svc.Name) :$($svc.Port)"
    $script = "`$Host.UI.RawUI.WindowTitle = '$title'; Set-Location '$root'; $($svc.Command)"
    $proc = Start-Process powershell -PassThru -ArgumentList @("-NoExit", "-NoProfile", "-Command", $script)
    $started += $proc
    Write-Host ("  started {0,-13} http://localhost:{1}" -f $svc.Name, $svc.Port)
}

Write-Host ""
Write-Host "CrewBrief is starting. Open http://localhost:3000 in Chrome or Edge in a few seconds." -ForegroundColor Green
Write-Host "Press Enter here to stop everything."
[void](Read-Host)

foreach ($proc in $started) {
    # /T also stops child processes (uvicorn workers, node), /F forces it.
    taskkill /PID $proc.Id /T /F 2>$null | Out-Null
}
Write-Host "Stopped."
