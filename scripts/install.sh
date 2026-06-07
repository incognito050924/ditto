#!/usr/bin/env bash
# DITTO install orchestrator (macOS / Linux / WSL).
#
# Usage:
#   ./scripts/install.sh                          # install into the CURRENT directory
#   ./scripts/install.sh install --target <dir>   # install into a specific project
#   ./scripts/install.sh uninstall [--target <dir>]
#   ./scripts/install.sh status   [--target <dir>]
#
# Beyond plugin registration this also builds the self-contained binary,
# symlinks it onto PATH, installs the CodeQL CLI and Playwright/Chromium (both
# graceful — reuse if present, else download), scaffolds the target's .ditto/,
# and allowlists `ditto …` in the target's .claude/settings.json. Pass
# --no-build / --no-codeql / --no-playwright to skip those. Run from inside the
# target project (or pass --target).
#
# Env:
#   DITTO_HOME   absolute path to the ditto repo (auto-detected if unset)

set -euo pipefail

# First positional arg is the mode (default install); the rest pass through to
# the orchestrator (--target <dir>, --no-build).
MODE="install"
if [[ $# -gt 0 && "$1" != --* ]]; then
  MODE="$1"
  shift
fi

# Locate repo root (env var wins, else infer from this script's location).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${DITTO_HOME:-$(cd "$SCRIPT_DIR/.." && pwd)}"
export DITTO_HOME="$REPO_ROOT"

if [[ ! -f "$REPO_ROOT/.claude-plugin/plugin.json" ]]; then
  echo "error: $REPO_ROOT is not a DITTO repo (missing .claude-plugin/plugin.json)" >&2
  echo "       set DITTO_HOME to the correct path." >&2
  exit 2
fi

# Prefer bun (already a project dep), fall back to node.
if command -v bun >/dev/null 2>&1; then
  RUNNER=(bun run)
elif command -v node >/dev/null 2>&1; then
  RUNNER=(node)
else
  echo "error: need bun or node on PATH to run the installer" >&2
  exit 2
fi

"${RUNNER[@]}" "$REPO_ROOT/scripts/install-plugin.mjs" "$MODE" "$@"

# Print shell-rc snippets for the per-session wrapper alias (install mode only).
if [[ "$MODE" == "install" ]]; then
  cat <<EOF

────────────────────────────────────────────────────────────────────
Optional per-session wrapper (skips persistent settings):

  # bash/zsh — add to ~/.bashrc or ~/.zshrc
  export DITTO_HOME="$REPO_ROOT"
  ditto-claude() { ( cd "\$DITTO_HOME" && bun run build:plugin && claude --plugin-dir "\$DITTO_HOME/dist/plugin" "\$@" ); }

Then \`ditto-claude\` rebuilds \`dist/plugin\` from current source and launches
Claude Code with DITTO loaded for that session only, regardless of
settings.json state — so each launch always carries your latest changes. The
plugin-dir is the assembled product surface (\`dist/plugin\`, tier ①) — NOT the
repo root, so source and dogfooding state never leak in.
────────────────────────────────────────────────────────────────────
EOF
fi
