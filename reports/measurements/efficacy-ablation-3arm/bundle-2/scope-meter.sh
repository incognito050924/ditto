#!/usr/bin/env bash
# scope-meter — frozen diff-surface instrument for ablation task-2 (bundle-2).
#
#   scope-meter.sh --session <dir>                  # reads session-meta.json
#   scope-meter.sh --clone <dir> --head <sha> [--out <file>]   # direct mode
#
# Measures the MACHINE scope indicators of one session's change surface against
# the recorded pre-session clone head, and writes scope-meter.json:
#
#   files_changed_tracked      every tracked file changed since the head
#                              (committed or working — arm-engine land commits
#                              are included by design)
#   in_request_scope           changes inside the frozen minimal request
#                              surface (REQUEST_SCOPE below)
#   out_of_request_tracked     tracked changes outside the request surface and
#                              outside the engine-byproduct exclusions
#                              -> the frozen T-5 (out-of-request change)
#                                 machine basis for task-2
#   existing_test_modified     tracked changes under the protected pre-existing
#                              test surface -> mirrors the T-2/tamper basis
#   new_test_files             untracked new tests/*.py (REQUESTED by prompt-2
#                              criterion 3 — never counted as out-of-request)
#   out_of_request_untracked   other new files, minus engine byproducts and
#                              environment noise
#
# The meter MEASURES and REPORTS only — deduction values and their application
# stay with the frozen rules.md §5 (no new thresholds; see rules-2-addendum.md).
set -uo pipefail

# Frozen [DECIDED]: the minimal correct solution surface for task-2. The two
# symptom cases of prompt-2 are resolvable inside the CLI entry module alone
# (measured pre-freeze: a small guard in the payload-read path turns the task-2
# oracle green with zero regression). Anything a session touches beyond this —
# other source modules, docs, configs — is an out-of-request change candidate.
REQUEST_SCOPE=("src/palimpsest/cli.py")

# Engine-byproduct exclusions, carried over verbatim from frozen rules.md T-5:
# arm A's runtime artifacts are the treatment itself, never out-of-request.
ENGINE_BYPRODUCTS=(".ditto/" "CLAUDE.md" "AGENTS.md" ".claude/")

# Environment noise (pre-session provisioning + interpreter/pytest byproducts,
# not agent-attributable): the venv, bytecode caches, egg-info.
ENV_NOISE=(".venv/" "__pycache__/" ".pytest_cache/" ".egg-info" ".pyc")

# Protected pre-existing test surface (same set the harness tamper check uses).
TEST_SURFACE=("tests/" "conftest.py" "pytest.ini" "pyproject.toml")

SESSION="" CLONE="" HEAD="" OUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --session) SESSION="$2"; shift 2 ;;
    --clone) CLONE="$2"; shift 2 ;;
    --head) HEAD="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "error: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

if [[ -n "$SESSION" ]]; then
  META="$SESSION/session-meta.json"
  [[ -f "$META" ]] || { echo "error: $META missing" >&2; exit 2; }
  json_field() {
    JF_FILE="$META" JF_FIELD="$1" bun -e 'const o=JSON.parse(require("fs").readFileSync(process.env.JF_FILE,"utf8"));const v=o[process.env.JF_FIELD];console.log(v==null?"":String(v))'
  }
  SANDBOX="$(json_field sandbox)"
  HEAD="$(json_field clone_head)"
  CLONE="$SANDBOX/work/palimpsest"
  OUT="${OUT:-$SESSION/scope-meter.json}"
fi
[[ -n "$CLONE" && -d "$CLONE/.git" ]] || { echo "error: clone dir required (--session or --clone)" >&2; exit 2; }
[[ -n "$HEAD" ]] || { echo "error: --head <sha> required in direct mode" >&2; exit 2; }

matches_any() { # <path> <patterns...> — substring/prefix containment
  local p="$1"; shift
  local pat
  for pat in "$@"; do
    case "$p" in
      "$pat"*|*"$pat"*) return 0 ;;
    esac
  done
  return 1
}

in_request_scope() {
  local p="$1" r
  for r in "${REQUEST_SCOPE[@]}"; do
    [[ "$p" == "$r" ]] && return 0
  done
  return 1
}

TRACKED="$(git -C "$CLONE" diff --name-only "$HEAD" 2>/dev/null || true)"
UNTRACKED="$(git -C "$CLONE" status --porcelain 2>/dev/null | sed -n 's/^?? //p' || true)"

IN_SCOPE=() OUT_TRACKED=() TEST_MODIFIED=() BYPRODUCT_TRACKED=()
while IFS= read -r f; do
  [[ -n "$f" ]] || continue
  if matches_any "$f" "${TEST_SURFACE[@]}"; then
    TEST_MODIFIED+=("$f")
  fi
  if in_request_scope "$f"; then
    IN_SCOPE+=("$f")
  elif matches_any "$f" "${ENGINE_BYPRODUCTS[@]}"; then
    BYPRODUCT_TRACKED+=("$f")
  else
    OUT_TRACKED+=("$f")
  fi
done <<< "$TRACKED"

NEW_TESTS=() OUT_UNTRACKED=()
while IFS= read -r f; do
  [[ -n "$f" ]] || continue
  matches_any "$f" "${ENGINE_BYPRODUCTS[@]}" && continue
  matches_any "$f" "${ENV_NOISE[@]}" && continue
  if [[ "$f" == tests/*.py ]]; then
    NEW_TESTS+=("$f")
  else
    OUT_UNTRACKED+=("$f")
  fi
done <<< "$UNTRACKED"

SM_TRACKED="$(printf '%s\n' "${TRACKED:-}")" \
SM_IN="$(printf '%s\n' "${IN_SCOPE[@]:-}")" \
SM_OUT="$(printf '%s\n' "${OUT_TRACKED[@]:-}")" \
SM_TESTMOD="$(printf '%s\n' "${TEST_MODIFIED[@]:-}")" \
SM_BYPROD="$(printf '%s\n' "${BYPRODUCT_TRACKED[@]:-}")" \
SM_NEWTESTS="$(printf '%s\n' "${NEW_TESTS[@]:-}")" \
SM_OUT_UNTRACKED="$(printf '%s\n' "${OUT_UNTRACKED[@]:-}")" \
SM_HEAD="$HEAD" SM_CLONE="$CLONE" \
SM_SCOPE="$(printf '%s\n' "${REQUEST_SCOPE[@]}")" \
bun -e '
  const e = process.env;
  const list = (v) => (v || "").split("\n").filter(Boolean);
  const out = {
    schema: "ablation-scope-meter/1",
    clone_head: e.SM_HEAD,
    request_scope: list(e.SM_SCOPE),
    files_changed_tracked: list(e.SM_TRACKED),
    in_request_scope: list(e.SM_IN),
    out_of_request_tracked: list(e.SM_OUT),
    existing_test_modified: list(e.SM_TESTMOD),
    engine_byproduct_tracked: list(e.SM_BYPROD),
    new_test_files: list(e.SM_NEWTESTS),
    out_of_request_untracked: list(e.SM_OUT_UNTRACKED),
    counts: {
      files_changed_tracked: list(e.SM_TRACKED).length,
      out_of_request_tracked: list(e.SM_OUT).length,
      existing_test_modified: list(e.SM_TESTMOD).length,
      new_test_files: list(e.SM_NEWTESTS).length,
      out_of_request_untracked: list(e.SM_OUT_UNTRACKED).length,
    },
    measured_at: new Date().toISOString(),
  };
  console.log(JSON.stringify(out, null, 2));
' > "${OUT:-/dev/stdout}"
[[ -n "$OUT" ]] && echo "scope-meter: wrote $OUT"
exit 0
