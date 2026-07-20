#!/bin/sh
# codex-crosscheck.sh — the AUTHORITATIVE maker≠checker gate (calling-session-owned, real shell).
#
# WHY THIS EXISTS: the in-workflow codex-opponent agent cannot PROVE it shelled out to codex, so its
# JSON is advisory. This script calls `codex exec` DIRECTLY (a different provider = maker≠checker) on
# the actual build diff/evidence, and gates on its exit + parsed verdict. Absent/unauthenticated codex
# → nonzero exit → fail-closed to unverified. Completion is never asserted without this passing.
#
# Usage:  sh codex-crosscheck.sh <scratch-tree> [evidence-summary-file]
# Exit 0 = codex CONCURS the build is genuinely complete (drained, wired, evidence-backed).
# Exit 1 = codex DISSENTS or is UNVERIFIED (something undecided/unwired).
# Exit 3 = codex unavailable/unauthenticated → fail-closed.
set -eu

TREE="${1:?usage: codex-crosscheck.sh <scratch-tree> [evidence-summary-file]}"
SUMMARY="${2:-}"

if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI absent — maker≠checker cannot be satisfied → fail-closed (unverified)." >&2
  exit 3
fi
if ! codex --version >/dev/null 2>&1; then
  echo "codex present but not invokable (auth/network) → fail-closed (unverified)." >&2
  exit 3
fi

# Assemble the adversarial context: the isolated build diff + optional evidence summary.
DIFF=$( cd "$TREE" && git --no-pager diff --stat HEAD 2>/dev/null || echo "(no diff)" )
EVID=""
[ -n "$SUMMARY" ] && [ -f "$SUMMARY" ] && EVID=$(cat "$SUMMARY")

PROMPT=$(cat <<EOF
You are an ADVERSARIAL cross-checker for a maker≠checker gate. A different agent built the redesigned
ditto foundation inside an isolated tree. Judge ONLY from the evidence below — do not assume good faith.

Answer with EXACTLY one token on the FIRST line: CONCUR, DISSENT, or UNVERIFIED. Then one line of grounds.
- CONCUR: the current-intent build is genuinely drained to fixpoint — every slice wired to a live path,
  evidence-backed, no orphan, no in-scope residual laundered out.
- DISSENT: anything is undecided, unwired, or an in-scope residual was deferred as new-scope.
- UNVERIFIED: you cannot adjudicate from what is shown.

Build diff (stat):
$DIFF

Evidence summary:
$EVID
EOF
)

# codex exec runs non-interactively and prints the model output to stdout.
RESP=$( codex exec "$PROMPT" 2>/dev/null ) || { echo "codex exec failed → fail-closed." >&2; exit 3; }
FIRST=$(printf '%s\n' "$RESP" | grep -Eom1 'CONCUR|DISSENT|UNVERIFIED' || echo "UNVERIFIED")

echo "codex verdict: $FIRST"
printf '%s\n' "$RESP" | head -6
case "$FIRST" in
  CONCUR) echo "codex-crosscheck PASS — external authority concurs."; exit 0 ;;
  DISSENT) echo "codex-crosscheck FAIL — external authority dissents." >&2; exit 1 ;;
  *) echo "codex-crosscheck FAIL — unverified (fail-closed)." >&2; exit 1 ;;
esac
