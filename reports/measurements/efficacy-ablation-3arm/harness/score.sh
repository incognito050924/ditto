#!/usr/bin/env bash
# Scorer — machine result scoring, blind-view generation, sha-chain verification.
#
#   score.sh verify-chain [--session <dir>] [--frozen-commit <sha>]
#       bundle disk == manifest.sha256; with --frozen-commit also
#       manifest == committed blob (git show <commit>:<path>); with --session
#       also injected copies == manifest (prompt / flags / oracle)
#       => the full "injected == frozen == committed blob" chain
#
#   score.sh score --session <dir>
#       order matters: (1) tamper check FIRST (pre-existing test surface
#       unmodified vs the recorded clone head), (2) full pre-existing suite
#       (regression), (3) digest-verify the oracle FROM THE FROZEN BUNDLE and
#       re-inject it (sessions cannot forge the sealed test), (4) run it:
#       pytest exit 0=green · 1=red · 2/5=error · else error.
#       Writes <session>/score.json; success predicate =
#       oracle green ∧ full suite pass ∧ tamper clean.
#
#   score.sh blind --session <dir>
#       copies transcript/diff into <session>/blind/ with arm labels, attempt
#       ids and sandbox/run paths stripped, then machine-scans for RESIDUAL
#       arm-identifying signals (engine byproduct patterns). exit 0 = clean,
#       4 = residual signals listed in blind/residual-signals.txt (the frozen
#       bundle rules decide the handling; the scanner only reports honestly).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
source "$HERE/config.sh"

CMD="${1:-}"
shift || true
SESSION="" FROZEN_COMMIT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --session) SESSION="$2"; shift 2 ;;
    --frozen-commit) FROZEN_COMMIT="$2"; shift 2 ;;
    -h|--help) sed -n '2,26p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "error: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

BUNDLE="${ABLATION_BUNDLE_DIR%/}"
MANIFEST_FILE="$BUNDLE/manifest.sha256"

verify_chain() {
  [[ -f "$MANIFEST_FILE" ]] || { echo "error: $MANIFEST_FILE missing" >&2; return 1; }
  # leg 1: disk == frozen manifest
  if ! (cd "$BUNDLE" && shasum -a 256 -c manifest.sha256 >/dev/null 2>&1); then
    echo "verify-chain FAIL: bundle files on disk do not match manifest.sha256" >&2
    (cd "$BUNDLE" && shasum -a 256 -c manifest.sha256 2>&1 | grep -v ': OK$' >&2) || true
    return 1
  fi
  echo "verify-chain: disk == manifest OK ($(grep -c . "$MANIFEST_FILE") files)"
  # leg 2: manifest == committed blob at the frozen commit
  if [[ -n "$FROZEN_COMMIT" ]]; then
    local prefix line sha rel got
    prefix="$(git -C "$BUNDLE" rev-parse --show-prefix 2>/dev/null)" || {
      echo "verify-chain FAIL: bundle dir is not inside a git repo" >&2
      return 1
    }
    while IFS= read -r line; do
      [[ -n "$line" ]] || continue
      sha="${line%% *}"
      rel="${line##* }"
      got="$(git -C "$BUNDLE" show "${FROZEN_COMMIT}:${prefix}${rel}" 2>/dev/null | shasum -a 256 | awk '{print $1}')"
      if [[ "$got" != "$sha" ]]; then
        echo "verify-chain FAIL: '$rel' committed blob at $FROZEN_COMMIT != frozen manifest sha" >&2
        return 1
      fi
    done < "$MANIFEST_FILE"
    echo "verify-chain: manifest == committed blobs @ $FROZEN_COMMIT OK"
  fi
  # leg 3: injected copies == frozen manifest
  if [[ -n "$SESSION" ]]; then
    local pairs=(
      "injected-prompt.md:$ABLATION_PROMPT_RELPATH"
      "injected-claude-flags.txt:$ABLATION_FLAGS_RELPATH"
    )
    local oracle_rel
    oracle_rel="$(oracle_relpath 2>/dev/null || true)"
    [[ -n "$oracle_rel" ]] && pairs+=("injected-oracle.py:$oracle_rel")
    local name rel want got
    for p in "${pairs[@]}"; do
      name="${p%%:*}"
      rel="${p#*:}"
      [[ -f "$SESSION/$name" ]] || continue
      want="$(ablation_manifest_sha "$rel")" || return 1
      got="$(ablation_sha256 "$SESSION/$name")"
      if [[ "$want" != "$got" ]]; then
        echo "verify-chain FAIL: $SESSION/$name != frozen '$rel'" >&2
        return 1
      fi
      echo "verify-chain: injected $name == frozen $rel OK"
    done
  fi
  echo "verify-chain OK"
}

# The single oracle test file inside bundle/oracle/ (contract: exactly one .py).
oracle_relpath() {
  local f
  f="$(find "$BUNDLE/oracle" -maxdepth 1 -name '*.py' 2>/dev/null | head -1)"
  [[ -n "$f" ]] || { echo "error: no oracle .py in $BUNDLE/oracle/" >&2; return 1; }
  echo "oracle/$(basename "$f")"
}

do_score() {
  [[ -n "$SESSION" && -d "$SESSION" ]] || { echo "error: --session <dir> required" >&2; return 2; }
  local meta="$SESSION/session-meta.json"
  [[ -f "$meta" ]] || { echo "error: $meta missing" >&2; return 2; }
  local sandbox clone head
  sandbox="$(ablation_json_field "$meta" sandbox)"
  head="$(ablation_json_field "$meta" clone_head)"
  clone="$sandbox/work/palimpsest"
  [[ -d "$clone/.git" ]] || { echo "error: clone $clone missing" >&2; return 2; }

  # (1) tamper check FIRST — pre-existing test surface unmodified
  local tampered untracked_tests
  # shellcheck disable=SC2086
  tampered="$(git -C "$clone" diff --name-only "$head" -- $ABLATION_TEST_PATHS 2>/dev/null || true)"
  # shellcheck disable=SC2086
  untracked_tests="$(git -C "$clone" status --porcelain -- $ABLATION_TEST_PATHS 2>/dev/null | grep '^??' || true)"
  local tamper_state=clean
  [[ -n "$tampered" ]] && tamper_state=tampered

  # (2) full pre-existing suite (before oracle injection)
  local full_rc=0
  (cd "$clone" && $ABLATION_PYTEST_CMD) > "$SESSION/full-suite.out" 2>&1 || full_rc=$?

  # (3) digest-verify + re-inject the oracle from the frozen bundle
  local oracle_rel oracle_dest
  oracle_rel="$(oracle_relpath)" || return 1
  ablation_verify_bundle_file "$oracle_rel" >/dev/null || return 1
  oracle_dest="$(cat "$BUNDLE/oracle/DEST" 2>/dev/null || echo "tests/test_ablation_oracle.py")"
  if git -C "$clone" ls-files --error-unmatch "$oracle_dest" >/dev/null 2>&1; then
    echo "error: oracle DEST '$oracle_dest' is a tracked file in the clone — refusing to overwrite" >&2
    return 1
  fi
  mkdir -p "$clone/$(dirname "$oracle_dest")"
  cp "$BUNDLE/$oracle_rel" "$clone/$oracle_dest"
  cp "$BUNDLE/$oracle_rel" "$SESSION/injected-oracle.py"

  # (4) oracle run — exit-code 3-way mapping (2/5 = collection/usage error)
  local oracle_rc=0 oracle_state
  (cd "$clone" && $ABLATION_PYTEST_CMD "$oracle_dest") > "$SESSION/oracle.out" 2>&1 || oracle_rc=$?
  case "$oracle_rc" in
    0) oracle_state=green ;;
    1) oracle_state=red ;;
    2|5) oracle_state=error ;;
    *) oracle_state=error ;;
  esac

  local success=false
  [[ "$oracle_state" == green && $full_rc -eq 0 && "$tamper_state" == clean ]] && success=true

  M_ORACLE="$oracle_state" M_ORACLE_RC="$oracle_rc" M_FULL_RC="$full_rc" \
  M_TAMPER="$tamper_state" M_TAMPERED="$tampered" M_UNTRACKED="$untracked_tests" \
  M_SUCCESS="$success" \
  bun -e 'const e=process.env;console.log(JSON.stringify({schema:"ablation-score/1",oracle:e.M_ORACLE,oracle_exit:Number(e.M_ORACLE_RC),full_suite_exit:Number(e.M_FULL_RC),full_suite:Number(e.M_FULL_RC)===0?"pass":"fail",tamper:e.M_TAMPER,tampered_files:(e.M_TAMPERED||"").split("\n").filter(Boolean),untracked_test_files:(e.M_UNTRACKED||"").split("\n").filter(Boolean),predicate_success:e.M_SUCCESS==="true",scored_at:new Date().toISOString()},null,2))' \
    > "$SESSION/score.json"
  echo "score: oracle=$oracle_state full_suite_rc=$full_rc tamper=$tamper_state predicate_success=$success"
}

do_blind() {
  [[ -n "$SESSION" && -d "$SESSION" ]] || { echo "error: --session <dir> required" >&2; return 2; }
  local meta="$SESSION/session-meta.json"
  local sandbox=""
  [[ -f "$meta" ]] && sandbox="$(ablation_json_field "$meta" sandbox)"
  local B="$SESSION/blind"
  rm -rf "$B"
  mkdir -p "$B"
  local f
  for f in transcript.jsonl diff.patch; do
    [[ -f "$SESSION/$f" ]] || continue
    BL_IN="$SESSION/$f" BL_OUT="$B/$f" BL_SB="$sandbox" BL_RUNS="${ABLATION_RUNS_DIR%/}" \
    bun -e 'const fs=require("fs");const e=process.env;let t=fs.readFileSync(e.BL_IN,"utf8");for(const p of [e.BL_SB,e.BL_RUNS].filter(Boolean))t=t.split(p).join("<STRIPPED_PATH>");t=t.replace(/\barm[-_ ]?(A|B0|B1)\b/gi,"ARM_X").replace(/attempt[-_]?\d+/gi,"ATTEMPT_N");fs.writeFileSync(e.BL_OUT,t)'
  done
  # residual arm-identifying signal scan (engine byproducts). Reported, not
  # hidden — the frozen rules decide invalidation/re-strip.
  local patterns=("ditto" "autopilot" "PreToolUse" "PostToolUse" "work[-_ ]?item" "deep-interview" "charter" "CLAUDE\.md" "AGENTS\.md" "DITTO_")
  local total=0 c p
  : > "$B/residual-signals.txt"
  for p in "${patterns[@]}"; do
    c="$(cat "$B"/transcript.jsonl "$B"/diff.patch 2>/dev/null | grep -Eic "$p" || true)"
    c="${c:-0}"
    if [[ "$c" -gt 0 ]]; then
      echo "$p $c" >> "$B/residual-signals.txt"
      total=$((total + c))
    fi
  done
  if [[ $total -gt 0 ]]; then
    echo "blind: RESIDUAL arm signals ($total matching lines) — see $B/residual-signals.txt"
    return 4
  fi
  echo "blind: clean (no residual arm signals)"
}

case "$CMD" in
  verify-chain) verify_chain ;;
  score) do_score ;;
  blind) do_blind ;;
  *) echo "usage: score.sh verify-chain|score|blind [--session <dir>] [--frozen-commit <sha>]" >&2; exit 2 ;;
esac
