# DITTO install orchestrator (Windows 11 / PowerShell 5+).
#
# Usage:
#   .\scripts\install.ps1                              # install into the CURRENT directory
#   .\scripts\install.ps1 install -Target <dir>        # install into a specific project
#   .\scripts\install.ps1 uninstall [-Target <dir>]
#   .\scripts\install.ps1 status   [-Target <dir>]
#
# Beyond plugin registration this bundles the JS launcher (bin\ditto, run by
# `bun`, plus the Windows shim bin\ditto.cmd) and delegates the project steps —
# .ditto\ scaffold, `ditto …` allowlist in .claude\settings.json, and tool
# provisioning (CodeQL/Playwright/LSP, graceful) — to `ditto setup`. On Windows
# nothing is symlinked; add bin\ to PATH so `ditto` resolves via ditto.cmd. The
# launcher runs the bundle with `bun`, so bun >=1.3 must be on PATH. Pass
# -NoBuild to skip the bundle rebuild, -NoTools to skip tool provisioning.
#
# Env:
#   DITTO_HOME   absolute path to the ditto repo (auto-detected if unset)

param(
  [ValidateSet('install', 'uninstall', 'status')]
  [string]$Mode = 'install',
  [string]$Target,
  [switch]$NoBuild,
  [switch]$NoTools
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
if ($NoTools) { $extra += '--no-tools' }
& $runner[0] @($runner[1..($runner.Length - 1)]) $installer $Mode @extra
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($Mode -eq 'install') {
  @"

────────────────────────────────────────────────────────────────────
Optional per-session wrapper (skips persistent settings):

  # Add to PowerShell profile: $PROFILE
  `$env:DITTO_HOME = '$repoRoot'
  function ditto-claude {
    Push-Location `$env:DITTO_HOME
    bun run build:plugin
    claude --plugin-dir "`$env:DITTO_HOME\dist\plugin" `$args
    Pop-Location
  }

Then ``ditto-claude`` rebuilds dist\plugin from current source and launches
Claude Code with DITTO loaded for that session only — each launch carries your
latest changes. The plugin-dir is the assembled product surface (dist\plugin),
not the repo root.
────────────────────────────────────────────────────────────────────
"@ | Write-Host
}
