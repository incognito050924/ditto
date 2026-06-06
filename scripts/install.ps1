# DITTO install orchestrator (Windows 11 / PowerShell 5+).
#
# Usage:
#   .\scripts\install.ps1                              # install into the CURRENT directory
#   .\scripts\install.ps1 install -Target <dir>        # install into a specific project
#   .\scripts\install.ps1 uninstall [-Target <dir>]
#   .\scripts\install.ps1 status   [-Target <dir>]
#
# Beyond plugin registration this also builds the self-contained binary
# (bin\ditto.exe), installs the CodeQL CLI and Playwright/Chromium (graceful),
# scaffolds the target's .ditto\, and allowlists `ditto …` in the target's
# .claude\settings.json. On Windows the binaries are NOT symlinked; add bin\
# (and the CodeQL dir) to PATH so they resolve. Pass -NoBuild / -NoCodeql /
# -NoPlaywright to skip those steps.
#
# Env:
#   DITTO_HOME   absolute path to the ditto repo (auto-detected if unset)

param(
  [ValidateSet('install', 'uninstall', 'status')]
  [string]$Mode = 'install',
  [string]$Target,
  [switch]$NoBuild,
  [switch]$NoCodeql,
  [switch]$NoPlaywright
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
$extra = @()
if ($Target) { $extra += @('--target', $Target) }
if ($NoBuild) { $extra += '--no-build' }
if ($NoCodeql) { $extra += '--no-codeql' }
if ($NoPlaywright) { $extra += '--no-playwright' }
& $runner[0] @($runner[1..($runner.Length - 1)]) $installer $Mode @extra
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
