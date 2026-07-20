#!/bin/sh
# evidence-runner.sh — THE deterministic completion gate (calling-session-owned, real shell).
#
# WHY THIS EXISTS: a Workflow harness has no shell, so the in-workflow verifier test-counts are
# LLM self-reports (advisory). This script RE-RUNS each per-slice test_command OUTSIDE model control
# and derives resolved/blocked from the real exit code + real pass/fail counts. This is the honest
# analog of Track A's OS-level Stop hook — the piece that makes completion NOT self-scored.
# It is intentionally the ONLY thing allowed to upgrade the workflow's 'provisional-drained' → 'pass'.
#
# Usage:  sh evidence-runner.sh <scratch-tree> <slices-manifest.tsv>
#   manifest lines: <slice_id><TAB><test_command>   (produced by the calling session from the
#                                                     workflow's frozen intent-lock slices)
# Exit 0  = every slice's REAL run passed (pass>0, fail==0, exit 0) → deterministic go for pass.
# Exit 1  = at least one slice failed/absent → fail-closed (completion NOT allowed).
# Exit 2  = a manifest command is the whole-island form (gate-defeating) → refuse.
set -eu

TREE="${1:?usage: evidence-runner.sh <scratch-tree> <slices-manifest.tsv>}"
MANIFEST="${2:?usage: evidence-runner.sh <scratch-tree> <slices-manifest.tsv>}"
[ -d "$TREE" ] || { echo "no scratch tree: $TREE" >&2; exit 1; }
[ -f "$MANIFEST" ] || { echo "no manifest: $MANIFEST" >&2; exit 1; }

overall=0
count=0
while IFS='	' read -r sid cmd; do
  [ -z "${sid:-}" ] && continue
  case "$sid" in \#*) continue ;; esac   # allow comment lines
  count=$((count + 1))

  # Reject the gate-defeating whole-island command: it is already 51-green, so it would pass
  # regardless of the slice (opponent finding #4.1). A per-slice command must name a test file.
  norm=$(printf '%s' "$cmd" | tr -s ' ')
  case "$norm" in
    "bun test rebuild"|"bun test rebuild/"|"bun test rebuild/ ")
      echo "REFUSE  $sid  whole-island command '$cmd' cannot gate a slice (targets the 51-green suite)"; exit 2 ;;
  esac
  case "$cmd" in
    *.test.ts*|*.test.tsx*|*.spec.ts*) : ;;
    *) echo "REFUSE  $sid  command '$cmd' names no per-slice test file"; exit 2 ;;
  esac

  out=$( cd "$TREE" && sh -c "$cmd" 2>&1 ) && code=0 || code=$?
  # bun test prints e.g. " 3 pass" and " 0 fail"; parse the counts deterministically.
  passn=$(printf '%s\n' "$out" | grep -Eo '[0-9]+ pass' | head -1 | grep -Eo '[0-9]+' || echo 0)
  failn=$(printf '%s\n' "$out" | grep -Eo '[0-9]+ fail' | head -1 | grep -Eo '[0-9]+' || echo 0)
  passn=${passn:-0}; failn=${failn:-0}

  if [ "$code" -eq 0 ] && [ "$failn" -eq 0 ] && [ "$passn" -gt 0 ]; then
    echo "PASS    $sid  ($passn pass, $failn fail)  cmd=$cmd"
  else
    echo "FAIL    $sid  (exit=$code, $passn pass, $failn fail)  cmd=$cmd"
    overall=1
  fi
done < "$MANIFEST"

if [ "$count" -eq 0 ]; then
  echo "evidence-runner: empty manifest — nothing verified → fail-closed." >&2
  exit 1
fi
if [ "$overall" -ne 0 ]; then
  echo "evidence-runner FAIL — at least one slice not deterministically green (completion blocked)." >&2
  exit 1
fi
echo "evidence-runner PASS — all $count slices deterministically green (real exec, outside model control)."
