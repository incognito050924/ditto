#!/bin/sh
# preflight.sh — run BEFORE the drive loop. Fail-closed if the maker≠checker authority
# or the toolchain is unavailable, so a multi-hour run does not end in a structural
# "unverified" surprise (opponent finding #3: fail-closed trap must be detected up front).
#
# Usage:  sh preflight.sh <scratch-tree>
# Exit 0 = ready to drive. Nonzero = do NOT start (reason on stderr).
set -eu
TREE="${1:?usage: preflight.sh <scratch-tree>}"

fail=0
need() { # $1 cmd, $2 label
  if command -v "$1" >/dev/null 2>&1; then echo "PASS  $2 present"; else echo "FAIL  $2 missing ($1)"; fail=1; fi
}

need bun "bun (test runner)"
need git "git (scratch VCS)"

# Codex = the external completion authority. Absent → maker≠checker cannot be satisfied →
# the run can never mint pass. Detect NOW, not hours later.
if command -v codex >/dev/null 2>&1; then
  echo "PASS  codex CLI present"
  # A cheap liveness probe; a nonzero here means present-but-unusable (auth/network).
  if codex --version >/dev/null 2>&1; then
    echo "PASS  codex invokable"
  else
    echo "FAIL  codex present but not invokable (auth/network?) — cross-check would fail-closed"; fail=1
  fi
else
  echo "FAIL  codex CLI absent — maker≠checker cannot be satisfied; run would be structurally unverified"; fail=1
fi

# Scratch tree must be isolated (no ditto interference surface).
if [ -d "$TREE" ]; then
  echo "PASS  scratch tree exists: $TREE"
  for bad in .claude .mcp.json CLAUDE.md .githooks; do
    if [ -e "$TREE/$bad" ]; then echo "FAIL  interference surface present: $TREE/$bad"; fail=1; fi
  done
else
  echo "FAIL  scratch tree missing: $TREE (run bootstrap-scratch-tree.sh first)"; fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "preflight FAIL — do not start the drive (fail-closed)." >&2
  exit 1
fi
echo "preflight PASS — ready to drive."
