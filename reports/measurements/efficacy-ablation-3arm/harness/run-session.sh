#!/usr/bin/env bash
# Run ONE headless claude session inside a provisioned sandbox.
#
#   run-session.sh --sandbox <dir> [--timeout-min N] [--skip-controls]
#
# Flow (each step fail-closed):
#   1. pre-flight: bundle-digest checks (prompt, arm identity) — the sha chain
#      "injected == frozen" leg is materialized by copying the exact consumed
#      bytes into the session dir (injected-prompt.md / injected-claude-flags.txt)
#   2. positive controls (hard precondition; skip only for local self-tests)
#   3. start the loopback allowlist egress proxy (per-session log)
#   4. launch `claude -p <frozen prompt>` through the sandbox wrapper with a
#      wall-clock watchdog (default 45 min); overrun -> kill + TRUNCATED marker
#   5. persist artifacts incrementally into $ABLATION_RUNS_DIR/attempt-<id>-<arm>/:
#      transcript.jsonl (streams as written), stderr.log, diff.patch,
#      git-status.txt, egress.jsonl, session-meta.json, COMPLETE|TRUNCATED
#      marker; arm A adds hooks-observed.jsonl + ditto-state/ + the digest of
#      the actually-executed bin/ditto
#   6. compute the session digest (post-session, pre-scoring) and append the
#      session event to the append-only ledger (cap + monotonicity enforced)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
source "$HERE/config.sh"

SANDBOX="" TIMEOUT_MIN="$ABLATION_SESSION_TIMEOUT_MIN" SKIP_CONTROLS=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sandbox) SANDBOX="$2"; shift 2 ;;
    --timeout-min) TIMEOUT_MIN="$2"; shift 2 ;;
    --skip-controls) SKIP_CONTROLS=1; shift ;;
    -h|--help) sed -n '2,22p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "error: unknown arg '$1'" >&2; exit 2 ;;
  esac
done
[[ -n "$SANDBOX" && -d "$SANDBOX" ]] || { echo "error: --sandbox <dir> required" >&2; exit 2; }

MANIFEST="$SANDBOX/provision-manifest.json"
[[ -f "$MANIFEST" ]] || { echo "error: $MANIFEST missing" >&2; exit 2; }
ARM="$(ablation_json_field "$MANIFEST" arm)"
ATTEMPT="$(ablation_json_field "$MANIFEST" attempt)"
CLONE_HEAD="$(ablation_json_field "$MANIFEST" clone_head)"
CLONE="$SANDBOX/work/palimpsest"
RUN="$SANDBOX/run-in-sandbox.sh"
[[ -x "$RUN" ]] || { echo "error: $RUN missing" >&2; exit 2; }

SESSION_DIR="${ABLATION_RUNS_DIR%/}/attempt-${ATTEMPT}-${ARM}"
if [[ -e "$SESSION_DIR/COMPLETE" || -e "$SESSION_DIR/TRUNCATED" ]]; then
  echo "error: session for attempt $ATTEMPT already ran ($SESSION_DIR) — truncated retries take a NEW attempt id" >&2
  exit 2
fi
mkdir -p "$SESSION_DIR"

# ── ledger guard BEFORE any cost: cap + monotonicity must admit this attempt
if ! ABLATION_LEDGER_FILE="$ABLATION_LEDGER_FILE" bun "$HERE/ledger.ts" check-append --attempt "$ATTEMPT"; then
  echo "error: ledger refuses attempt $ATTEMPT (cap or monotonicity) — aborting before session start" >&2
  exit 3
fi

# ── pre-flight: frozen-bundle digests + arm identity
PROMPT_SHA="$(ablation_verify_bundle_file "$ABLATION_PROMPT_RELPATH")" || exit 1
cp "${ABLATION_BUNDLE_DIR%/}/$ABLATION_PROMPT_RELPATH" "$SESSION_DIR/injected-prompt.md"

FLAGS_SHA=""
CLAUDE_FLAGS=()
if grep -Eq "^[0-9a-f]{64} [ *]?${ABLATION_FLAGS_RELPATH}\$" "${ABLATION_BUNDLE_DIR%/}/manifest.sha256" 2>/dev/null; then
  FLAGS_SHA="$(ablation_verify_bundle_file "$ABLATION_FLAGS_RELPATH")" || exit 1
  cp "${ABLATION_BUNDLE_DIR%/}/$ABLATION_FLAGS_RELPATH" "$SESSION_DIR/injected-claude-flags.txt"
  # arm-symmetric permission mode/flags, frozen in the bundle
  read -r -a CLAUDE_FLAGS <<< "$(cat "$SESSION_DIR/injected-claude-flags.txt")"
fi

case "$ARM" in
  B0)
    for f in CLAUDE.md AGENTS.md .claude; do
      [[ -e "$CLONE/$f" ]] && { echo "error: B0 pre-flight — instruction surface '$f' present" >&2; exit 1; }
    done
    ;;
  B1)
    WANT="$(ablation_json_field "$MANIFEST" charter_sha256)"
    GOT="$(ablation_sha256 "$CLONE/CLAUDE.md")"
    [[ -n "$WANT" && "$WANT" == "$GOT" ]] || { echo "error: B1 pre-flight — clone/CLAUDE.md digest != frozen charter digest" >&2; exit 1; }
    ;;
  A)
    WANT="$(ablation_json_field "$MANIFEST" arm_a_bin_sha256)"
    GOT="$(ablation_sha256 "$SANDBOX/bin/ditto")"
    [[ -n "$WANT" && "$WANT" == "$GOT" ]] || { echo "error: A pre-flight — sandbox bin/ditto digest != frozen bundle digest" >&2; exit 1; }
    ;;
esac

# ── positive controls (hard precondition)
if (( ! SKIP_CONTROLS )); then
  if ! "$HERE/positive-controls.sh" --sandbox "$SANDBOX"; then
    echo "error: positive controls failed — isolation precondition not met, refusing to run the session" >&2
    exit 1
  fi
fi

# ── stamps
TS_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
CLAUDE_VERSION="$("$ABLATION_CLAUDE_BIN" --version 2>/dev/null | head -1 || echo unknown)"

# ── egress proxy (per-session log)
PROXY_OUT="$SESSION_DIR/proxy.out"
bun "$HERE/egress-proxy.ts" --port "$ABLATION_PROXY_PORT" --allow "$ABLATION_EGRESS_ALLOWLIST" --log "$SESSION_DIR/egress.jsonl" > "$PROXY_OUT" 2>&1 &
PROXY_PID=$!
trap 'kill "$PROXY_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  grep -q '^READY' "$PROXY_OUT" 2>/dev/null && break
  sleep 0.1
done

# ── launch with wall-clock watchdog; transcript streams to disk incrementally
TIMEOUT_S="${ABLATION_SESSION_TIMEOUT_SECONDS:-$((TIMEOUT_MIN * 60))}"
START_EPOCH="$(date +%s)"
(
  cd "$CLONE" && exec "$RUN" "$ABLATION_CLAUDE_BIN" -p "$(cat "$SESSION_DIR/injected-prompt.md")" \
    --output-format stream-json --verbose "${CLAUDE_FLAGS[@]+"${CLAUDE_FLAGS[@]}"}"
) > "$SESSION_DIR/transcript.jsonl" 2> "$SESSION_DIR/stderr.log" &
SESSION_PID=$!

TRUNCATED=0
while kill -0 "$SESSION_PID" 2>/dev/null; do
  NOW="$(date +%s)"
  if (( NOW - START_EPOCH >= TIMEOUT_S )); then
    TRUNCATED=1
    kill -TERM "$SESSION_PID" 2>/dev/null || true
    pkill -TERM -P "$SESSION_PID" 2>/dev/null || true
    sleep 5
    kill -KILL "$SESSION_PID" 2>/dev/null || true
    pkill -KILL -P "$SESSION_PID" 2>/dev/null || true
    break
  fi
  sleep 2
done
EXIT_CODE=0
wait "$SESSION_PID" 2>/dev/null || EXIT_CODE=$?
TS_END="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
WALL_S=$(($(date +%s) - START_EPOCH))
kill "$PROXY_PID" 2>/dev/null || true
trap - EXIT

# ── post-collect
git -C "$CLONE" diff > "$SESSION_DIR/diff.patch" 2>/dev/null || true
git -C "$CLONE" status --porcelain > "$SESSION_DIR/git-status.txt" 2>/dev/null || true

ARM_A_BIN_SHA=""
if [[ "$ARM" == "A" ]]; then
  # engine-actually-ran evidence: hook events observed in the transcript
  # (installation alone is NOT evidence) + engine runtime state + the digest
  # of the executable that actually ran
  grep -E '"(hook|hook_event_name|PreToolUse|PostToolUse|Stop)"' "$SESSION_DIR/transcript.jsonl" \
    > "$SESSION_DIR/hooks-observed.jsonl" 2>/dev/null || true
  # Pilot calibration (attempt-4-A measured): claude stream-json emits NO
  # events for silently-allowing hooks, so the transcript grep above can be
  # legitimately empty even while the engine runs. Harvest hook-fire evidence
  # from the CLI's INTERNAL session record too (hook_additional_context /
  # hookEvent attachments), and preserve that record alongside the artifacts.
  for sf in "$SANDBOX/claude-config/projects"/*/*.jsonl; do
    [[ -f "$sf" ]] || continue
    cp "$sf" "$SESSION_DIR/claude-internal-session.jsonl"
    grep -a '"hook_additional_context"\|"hookEvent"\|"hookName"' "$sf" \
      >> "$SESSION_DIR/hooks-observed.jsonl" 2>/dev/null || true
    break
  done
  if [[ -d "$CLONE/.ditto" ]]; then
    cp -R "$CLONE/.ditto" "$SESSION_DIR/ditto-state" 2>/dev/null || true
  fi
  ARM_A_BIN_SHA="$(ablation_sha256 "$SANDBOX/bin/ditto")"
fi

# ── meta + completion marker
STATUS=$([[ $TRUNCATED -eq 1 ]] && echo truncated || echo completed)
M_ARM="$ARM" M_ATTEMPT="$ATTEMPT" M_SANDBOX="$SANDBOX" M_SESSION="$SESSION_DIR" \
M_TS_START="$TS_START" M_TS_END="$TS_END" M_WALL="$WALL_S" M_EXIT="$EXIT_CODE" \
M_TRUNC="$TRUNCATED" M_CLAUDE_V="$CLAUDE_VERSION" M_CLONE_HEAD="$CLONE_HEAD" \
M_PROMPT_SHA="$PROMPT_SHA" M_FLAGS_SHA="$FLAGS_SHA" M_ARM_A_SHA="$ARM_A_BIN_SHA" \
M_TIMEOUT_S="$TIMEOUT_S" \
bun -e 'const e=process.env;console.log(JSON.stringify({schema:"ablation-session-meta/1",arm:e.M_ARM,attempt:Number(e.M_ATTEMPT),sandbox:e.M_SANDBOX,session_dir:e.M_SESSION,ts_start:e.M_TS_START,ts_end:e.M_TS_END,wall_seconds:Number(e.M_WALL),exit_code:Number(e.M_EXIT),truncated:e.M_TRUNC==="1",claude_version:e.M_CLAUDE_V,clone_head:e.M_CLONE_HEAD,prompt_sha256:e.M_PROMPT_SHA,claude_flags_sha256:e.M_FLAGS_SHA||null,arm_a_bin_sha256:e.M_ARM_A_SHA||null,timeout_seconds:Number(e.M_TIMEOUT_S)},null,2))' \
  > "$SESSION_DIR/session-meta.json"
date -u +%Y-%m-%dT%H:%M:%SZ > "$SESSION_DIR/$([[ $TRUNCATED -eq 1 ]] && echo TRUNCATED || echo COMPLETE)"

# ── feeder log — the feeder is an information channel, never an approval
# channel; every injection must be recorded per session, and ZERO injections
# must be stated explicitly. The current runner is a single-shot `claude -p`
# with no interactive input channel, so injections are structurally 0; if an
# interactive channel is ever opened, the operator appends
# `(attempt, UTC time, question gist, frozen answer id)` lines here BEFORE the
# session digest below is computed (the log is part of the digest).
{
  echo "# feeder-log — attempt ${ATTEMPT} arm ${ARM}"
  echo ""
  echo "- runner: single-shot \`claude -p\` (no interactive feeder channel open)"
  echo "- injections: 0 (zero feeder injections during this session — stated explicitly)"
} > "$SESSION_DIR/feeder-log.md"

# ── session digest (post-session, pre-scoring) + ledger append
DIGEST="$(cd "$SESSION_DIR" && find . -type f ! -name session-digest.txt -print0 | sort -z \
  | xargs -0 shasum -a 256 | shasum -a 256 | awk '{print $1}')"
echo "$DIGEST" > "$SESSION_DIR/session-digest.txt"

ABLATION_LEDGER_FILE="$ABLATION_LEDGER_FILE" bun "$HERE/ledger.ts" append \
  --event session --attempt "$ATTEMPT" --arm "$ARM" --status "$STATUS" \
  --artifacts "$SESSION_DIR" --digest "$DIGEST"

echo "session attempt=$ATTEMPT arm=$ARM status=$STATUS wall=${WALL_S}s exit=$EXIT_CODE dir=$SESSION_DIR"
[[ "$STATUS" == "completed" ]]
