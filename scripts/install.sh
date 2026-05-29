#!/usr/bin/env bash
# DITTO plugin install (macOS / Linux / WSL).
#
# Usage:
#   ./scripts/install.sh                  # install (uses DITTO_HOME or script location)
#   ./scripts/install.sh uninstall        # remove from ~/.claude/settings.json
#   ./scripts/install.sh status           # show current state as JSON
#
# Env:
#   DITTO_HOME   absolute path to the ditto repo (auto-detected if unset)

set -euo pipefail

MODE="${1:-install}"

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

"${RUNNER[@]}" "$REPO_ROOT/scripts/install-plugin.mjs" "$MODE"

# Print shell-rc snippets for the per-session wrapper alias (install mode only).
if [[ "$MODE" == "install" ]]; then
  cat <<EOF

────────────────────────────────────────────────────────────────────
Optional per-session wrapper (skips persistent settings):

  # bash/zsh — add to ~/.bashrc or ~/.zshrc
  export DITTO_HOME="$REPO_ROOT"
  alias ditto-claude='claude --plugin-dir "\$DITTO_HOME"'

Then \`ditto-claude\` launches Claude Code with DITTO loaded for that
session only, regardless of settings.json state.
────────────────────────────────────────────────────────────────────
EOF
fi
