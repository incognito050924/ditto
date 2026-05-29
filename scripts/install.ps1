# DITTO plugin install (Windows 11 / PowerShell 5+).
#
# Usage:
#   .\scripts\install.ps1                 # install (uses $env:DITTO_HOME or script location)
#   .\scripts\install.ps1 uninstall       # remove from %USERPROFILE%\.claude\settings.json
#   .\scripts\install.ps1 status          # show current state as JSON
#
# Env:
#   DITTO_HOME   absolute path to the ditto repo (auto-detected if unset)

param(
  [ValidateSet('install', 'uninstall', 'status')]
  [string]$Mode = 'install'
)

$ErrorActionPreference = 'Stop'

# Locate repo root (env wins, else infer from script location).
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = if ($env:DITTO_HOME) { $env:DITTO_HOME } else { Resolve-Path (Join-Path $scriptDir '..') | Select-Object -ExpandProperty Path }
$env:DITTO_HOME = $repoRoot

if (-not (Test-Path (Join-Path $repoRoot '.claude-plugin\plugin.json'))) {
  Write-Error "error: $repoRoot is not a DITTO repo (missing .claude-plugin\plugin.json). Set `$env:DITTO_HOME to the correct path."
  exit 2
}

# Prefer bun, fall back to node.
$runner = $null
if (Get-Command bun -ErrorAction SilentlyContinue) {
  $runner = @('bun', 'run')
} elseif (Get-Command node -ErrorAction SilentlyContinue) {
  $runner = @('node')
} else {
  Write-Error "error: need bun or node on PATH to run the installer"
  exit 2
}

$installer = Join-Path $repoRoot 'scripts\install-plugin.mjs'
& $runner[0] @($runner[1..($runner.Length - 1)]) $installer $Mode
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($Mode -eq 'install') {
  @"

────────────────────────────────────────────────────────────────────
Optional per-session wrapper (skips persistent settings):

  # Add to PowerShell profile: $PROFILE
  `$env:DITTO_HOME = '$repoRoot'
  function ditto-claude { claude --plugin-dir `$env:DITTO_HOME `$args }

Then ``ditto-claude`` launches Claude Code with DITTO loaded for that
session only, regardless of settings.json state.
────────────────────────────────────────────────────────────────────
"@ | Write-Host
}
