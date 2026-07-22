#!/usr/bin/env bash
# Local self-check — proves every mechanism that is verifiable WITHOUT external
# cost (no real claude session, no real palimpsest clone, no network egress):
#
#   S1  syntax: bash -n on every .sh, bun build on every .ts
#   S2  SBPL live re-measurement: loopback allowed, external remote-IP denied
#   S3  egress proxy: allowlisted loopback passes, non-allowlisted host gets
#       403, both decisions land in the append-only log
#   S4  ledger: monotonic ids, cap refusal (exit 3), adjudication rules,
#       tamper-evident chain (verify fails after byte-flip)
#   S5  sha chain: verify-chain passes on a fixture bundle (disk == manifest ==
#       committed blob), fails after tampering
#   S6  provision B0 on a local stand-in repo: origin removed, --no-hardlinks
#       effective, instruction files absent, env whitelist strips poisoned
#       hook-kill vars
#   S7  provision B1: injected CLAUDE.md digest == frozen charter digest
#   S8  positive controls end-to-end on the B0 sandbox (all 5 must pass)
#   S9  blind scoring: arm labels stripped; residual engine signals detected
#       (exit 4) on a poisoned fixture, clean fixture passes
#   S10 run-session watchdog: overrunning stub session killed, TRUNCATED
#       marker, ledger appended
#   S11 run-session completion: quick stub session -> COMPLETE marker, diff
#       captured, session digest + ledger appended; conditional score run
#       (oracle red / full-suite pass / tamper clean) when pytest is available
#
# NOT covered (real-cost, pilot-owned): real claude headless behavior, proxy
# compliance of the claude CLI, real palimpsest clone, arm A `ditto setup`
# inside the sandbox, subscription auth inside the isolated config dir.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SC_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ablation-selfcheck.XXXXXX")"
SC_ROOT="$(cd "$SC_ROOT" && pwd)" # normalize (TMPDIR may carry a trailing slash)
FAILS=0
ok()   { echo "ok   - $1"; }
fail() { echo "FAIL - $1"; FAILS=$((FAILS + 1)); }
check() { # <desc> <command...> — expect success
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$desc"; else fail "$desc"; fi
}
check_rc() { # <desc> <expected_rc> <command...>
  local desc="$1" want="$2"; shift 2
  local rc=0
  "$@" >/dev/null 2>&1 || rc=$?
  if [[ "$rc" == "$want" ]]; then ok "$desc (rc=$rc)"; else fail "$desc (want rc=$want got rc=$rc)"; fi
}

echo "== ablation harness self-check =="
echo "scratch: $SC_ROOT"

# ── S1 syntax
for f in config.sh provision-sandbox.sh positive-controls.sh run-session.sh score.sh self-check.sh; do
  check "S1 bash -n $f" bash -n "$HERE/$f"
done
check "S1 bun build ledger.ts + egress-proxy.ts" \
  bun build "$HERE/ledger.ts" "$HERE/egress-proxy.ts" --target bun --outdir "$SC_ROOT/build"

# shellcheck source=config.sh
source "$HERE/config.sh"

# ── S2 SBPL live re-measurement
SRV_PORT=$((21000 + RANDOM % 5000))
bun -e "Bun.serve({port:$SRV_PORT,fetch(){return new Response(\"ok\")}});setTimeout(()=>process.exit(0),20000)" &
SRV_PID=$!
sleep 1
check "S2 sandbox-exec allows loopback" \
  /usr/bin/sandbox-exec -p "$ABLATION_SBPL" curl -fsS --max-time 3 "http://127.0.0.1:$SRV_PORT/" -o /dev/null
check_rc "S2 sandbox-exec denies external remote-IP egress" 7 \
  /usr/bin/sandbox-exec -p "$ABLATION_SBPL" curl -sS --max-time 5 https://example.com -o /dev/null
kill "$SRV_PID" 2>/dev/null || true

# ── S3 egress proxy
PPORT=$((26000 + RANDOM % 5000))
SRV2_PORT=$((SRV_PORT + 1))
PLOG="$SC_ROOT/proxy.jsonl"
bun "$HERE/egress-proxy.ts" --port "$PPORT" --allow "127.0.0.1,localhost" --log "$PLOG" > "$SC_ROOT/proxy.out" 2>&1 &
PROXY_PID=$!
bun -e "Bun.serve({port:$SRV2_PORT,fetch(){return new Response(\"ok\")}});setTimeout(()=>process.exit(0),20000)" &
SRV_PID=$!
for _ in $(seq 1 50); do grep -q '^READY' "$SC_ROOT/proxy.out" 2>/dev/null && break; sleep 0.1; done
sleep 0.5
check "S3 proxy passes allowlisted loopback" \
  curl -fsS --max-time 5 -x "http://127.0.0.1:$PPORT" "http://127.0.0.1:$SRV2_PORT/" -o /dev/null
check_rc "S3 proxy denies non-allowlisted host (403 -> curl 22)" 22 \
  curl -fsS --max-time 5 -x "http://127.0.0.1:$PPORT" "http://blocked.invalid/" -o /dev/null
check "S3 allow decision logged" grep -q '"allowed":true' "$PLOG"
check "S3 deny decision logged" grep -q '"allowed":false' "$PLOG"
kill "$PROXY_PID" "$SRV_PID" 2>/dev/null || true

# ── S4 ledger
LFILE="$SC_ROOT/ledger-test.jsonl"
L() { ABLATION_LEDGER_FILE="$LFILE" bun "$HERE/ledger.ts" "$@"; }
[[ "$(L next-id)" == "1" ]] && ok "S4 next-id starts at 1" || fail "S4 next-id starts at 1"
check "S4 append session 1" L append --event session --attempt 1 --arm B0 --status completed
check_rc "S4 non-monotonic re-append refused" 3 L append --event session --attempt 1 --arm B0 --status completed
check "S4 append session 2" L append --event session --attempt 2 --arm B1 --status truncated
check_rc "S4 invalid adjudication without reason refused" 2 L append --event adjudication --attempt 2 --status invalid
check "S4 invalid adjudication with reason" L append --event adjudication --attempt 2 --status invalid --reason "truncated fixture"
check "S4 verify chain intact" L verify
check_rc "S4 next-id refused at cap (exit 3)" 3 env ABLATION_LEDGER_FILE="$LFILE" bun "$HERE/ledger.ts" next-id --max 2
check_rc "S4 append refused at cap (exit 3)" 3 env ABLATION_LEDGER_FILE="$LFILE" bun "$HERE/ledger.ts" append --event session --attempt 3 --arm A --status completed --max 2
sed -i '' '1s/completed/complet3d/' "$LFILE"
check_rc "S4 tampered ledger fails verify" 1 L verify

# ── fixture bundle (a git repo of its own -> frozen-commit leg testable)
BUNDLE="$SC_ROOT/bundle"
mkdir -p "$BUNDLE/charter" "$BUNDLE/prompts" "$BUNDLE/oracle"
printf '# Charter (self-check fixture)\nBe careful.\n' > "$BUNDLE/charter/CLAUDE.md"
printf 'Fix the bug described by the failing behavior.\n' > "$BUNDLE/prompts/task.md"
printf 'def test_oracle():\n    assert False, "fixture red oracle"\n' > "$BUNDLE/oracle/test_oracle.py"
printf 'tests/test_ablation_oracle.py' > "$BUNDLE/oracle/DEST"
(cd "$BUNDLE" && shasum -a 256 charter/CLAUDE.md prompts/task.md oracle/test_oracle.py oracle/DEST > manifest.sha256)
git -C "$BUNDLE" init -q
git -C "$BUNDLE" add -A
git -C "$BUNDLE" -c user.name=sc -c user.email=sc@localhost commit -qm "fixture bundle"
FROZEN="$(git -C "$BUNDLE" rev-parse HEAD)"

# ── S5 sha chain
SC() { env ABLATION_BUNDLE_DIR="$BUNDLE" "$HERE/score.sh" "$@"; }
check "S5 verify-chain (disk == manifest == committed blob)" SC verify-chain --frozen-commit "$FROZEN"
printf 'tamper' >> "$BUNDLE/charter/CLAUDE.md"
check_rc "S5 verify-chain fails on tampered bundle" 1 SC verify-chain --frozen-commit "$FROZEN"
git -C "$BUNDLE" checkout -q -- charter/CLAUDE.md
check "S5 verify-chain recovers after restore" SC verify-chain --frozen-commit "$FROZEN"

# ── stand-in source repo (NOT the real palimpsest — no cost, mechanics only)
STANDIN="$SC_ROOT/standin"
mkdir -p "$STANDIN/tests" "$STANDIN/src"
printf 'project instructions that must vanish in B0\n' > "$STANDIN/CLAUDE.md"
printf 'charter backup remnant that must vanish (instruction-derived)\n' > "$STANDIN/CLAUDE.md.ditto_bak"
printf 'ditto recipe remnant that must vanish\n' > "$STANDIN/recipe.yaml"
printf 'def test_ok():\n    assert True\n' > "$STANDIN/tests/test_ok.py"
printf 'x = 1\n' > "$STANDIN/src/mod.py"
git -C "$STANDIN" init -q
git -C "$STANDIN" add -A
git -C "$STANDIN" -c user.name=sc -c user.email=sc@localhost commit -qm "stand-in"

# stub claude binaries (handle --version; slow one overruns the watchdog)
mkdir -p "$SC_ROOT/stub-bin"
cat > "$SC_ROOT/stub-bin/claude-slow" <<'EOF'
#!/bin/bash
if [ "${1:-}" = "--version" ]; then echo "stub-claude 0.0"; exit 0; fi
echo '{"type":"fixture","msg":"slow session start"}'
sleep 300
EOF
cat > "$SC_ROOT/stub-bin/claude-fast" <<'EOF'
#!/bin/bash
if [ "${1:-}" = "--version" ]; then echo "stub-claude 0.0"; exit 0; fi
echo '{"type":"fixture","msg":"fast session"}'
echo 'x = 2' > src/mod.py
exit 0
EOF
chmod +x "$SC_ROOT/stub-bin/claude-slow" "$SC_ROOT/stub-bin/claude-fast"

SB_ENV=(
  env
  "ABLATION_PALIMPSEST_SRC=$STANDIN"
  "ABLATION_SANDBOX_ROOT=$SC_ROOT/sandboxes"
  "ABLATION_RUNS_DIR=$SC_ROOT/runs"
  "ABLATION_BUNDLE_DIR=$BUNDLE"
  "ABLATION_PROXY_PORT=$((27000 + RANDOM % 5000))"
  "ABLATION_CLAUDE_BIN=$SC_ROOT/stub-bin/claude-fast"
)

# ── S6 provision B0
SB0="$SC_ROOT/sandboxes/attempt-1-B0"
check "S6 provision arm B0" "${SB_ENV[@]}" "$HERE/provision-sandbox.sh" --arm B0 --attempt 1
[[ -z "$(git -C "$SB0/work/palimpsest" remote 2>/dev/null)" ]] && ok "S6 origin removed" || fail "S6 origin removed"
[[ ! -e "$SB0/work/palimpsest/CLAUDE.md" ]] && ok "S6 instruction file absent in B0 clone" || fail "S6 instruction file absent in B0 clone"
if compgen -G "$SB0/work/palimpsest/*.ditto_bak" >/dev/null || [[ -e "$SB0/work/palimpsest/recipe.yaml" ]]; then
  fail "S6 instruction-derived remnants (*.ditto_bak, recipe.yaml) removed from B0 clone"
else
  ok "S6 instruction-derived remnants (*.ditto_bak, recipe.yaml) removed from B0 clone"
fi
OBJ="$(find "$SB0/work/palimpsest/.git/objects" -type f 2>/dev/null | head -1)"
[[ -n "$OBJ" && "$(stat -f %l "$OBJ")" == "1" ]] && ok "S6 --no-hardlinks effective (link count 1)" || fail "S6 --no-hardlinks effective"
if DITTO_SKIP_HOOKS=1 GH_TOKEN=poison "$SB0/run-in-sandbox.sh" sh -c 'env' 2>/dev/null | grep -Eq '^(DITTO_SKIP_HOOKS|GH_TOKEN)='; then
  fail "S6 env whitelist strips poisoned vars"
else
  ok "S6 env whitelist strips poisoned vars"
fi

# ── S7 provision B1 (charter digest)
SB1="$SC_ROOT/sandboxes/attempt-2-B1"
check "S7 provision arm B1" "${SB_ENV[@]}" "$HERE/provision-sandbox.sh" --arm B1 --attempt 2
W="$(shasum -a 256 "$BUNDLE/charter/CLAUDE.md" | awk '{print $1}')"
G="$(shasum -a 256 "$SB1/work/palimpsest/CLAUDE.md" 2>/dev/null | awk '{print $1}')"
[[ -n "$G" && "$W" == "$G" ]] && ok "S7 injected CLAUDE.md == frozen charter digest" || fail "S7 injected CLAUDE.md == frozen charter digest"

# ── S8 positive controls on the B0 sandbox
check "S8 positive-controls all pass" "${SB_ENV[@]}" "$HERE/positive-controls.sh" --sandbox "$SB0"

# ── S9 blind scoring on a fabricated session
FAKESESS="$SC_ROOT/fake-session"
mkdir -p "$FAKESESS"
printf '{"schema":"ablation-session-meta/1","sandbox":"%s"}\n' "$SB0" > "$FAKESESS/session-meta.json"
printf 'arm-A attempt-3 ran ditto autopilot with PreToolUse hooks in %s\n' "$SB0" > "$FAKESESS/transcript.jsonl"
check_rc "S9 residual engine signals detected (exit 4)" 4 "${SB_ENV[@]}" "$HERE/score.sh" blind --session "$FAKESESS"
if grep -Eq 'arm-A|attempt-3' "$FAKESESS/blind/transcript.jsonl"; then
  fail "S9 arm labels stripped from blind view"
else
  ok "S9 arm labels stripped from blind view"
fi
printf 'plain refactoring narrative, nothing identifying\n' > "$FAKESESS/transcript.jsonl"
check "S9 clean fixture passes blind scan" "${SB_ENV[@]}" "$HERE/score.sh" blind --session "$FAKESESS"

# ── S10 run-session watchdog (overrunning stub -> truncated)
check_rc "S10 overrunning session truncated (runner exits 1)" 1 \
  "${SB_ENV[@]}" "ABLATION_CLAUDE_BIN=$SC_ROOT/stub-bin/claude-slow" "ABLATION_SESSION_TIMEOUT_SECONDS=6" \
  "$HERE/run-session.sh" --sandbox "$SB0" --skip-controls
S10DIR="$SC_ROOT/runs/attempt-1-B0"
[[ -f "$S10DIR/TRUNCATED" ]] && ok "S10 TRUNCATED marker written" || fail "S10 TRUNCATED marker written"
grep -q 'slow session start' "$S10DIR/transcript.jsonl" 2>/dev/null && ok "S10 transcript persisted incrementally" || fail "S10 transcript persisted incrementally"

# ── S11 run-session completion + ledger + conditional score
check "S11 quick session completes" \
  "${SB_ENV[@]}" "$HERE/run-session.sh" --sandbox "$SB1" --skip-controls
S11DIR="$SC_ROOT/runs/attempt-2-B1"
[[ -f "$S11DIR/COMPLETE" ]] && ok "S11 COMPLETE marker written" || fail "S11 COMPLETE marker written"
[[ -s "$S11DIR/diff.patch" ]] && ok "S11 session diff captured" || fail "S11 session diff captured"
[[ -s "$S11DIR/session-digest.txt" ]] && ok "S11 session digest computed" || fail "S11 session digest computed"
check "S11 ledger chain verifies (2 session events)" \
  env "ABLATION_LEDGER_FILE=$SC_ROOT/runs/ledger.jsonl" bun "$HERE/ledger.ts" verify
if python3 -c 'import pytest' 2>/dev/null; then
  check "S11 score.sh runs" "${SB_ENV[@]}" "$HERE/score.sh" score --session "$S11DIR"
  SCORE="$S11DIR/score.json"
  grep -q '"oracle": "red"' "$SCORE" && ok "S11 red oracle mapped (pytest exit 1 -> red)" || fail "S11 red oracle mapped"
  grep -q '"full_suite": "pass"' "$SCORE" && ok "S11 full pre-existing suite pass recorded" || fail "S11 full suite pass recorded"
  grep -q '"tamper": "clean"' "$SCORE" && ok "S11 tamper check clean" || fail "S11 tamper check clean"
  grep -q '"predicate_success": false' "$SCORE" && ok "S11 predicate false while oracle red" || fail "S11 predicate false while oracle red"
else
  echo "skip - S11 score run (pytest not importable on host python3 — mechanism unverified here, pilot covers)"
fi

echo
echo "== summary: failures=$FAILS scratch=$SC_ROOT =="
if [[ $FAILS -eq 0 ]]; then
  rm -rf "$SC_ROOT"
  echo "self-check PASS (scratch removed)"
else
  echo "self-check FAIL (scratch kept for inspection)"
fi
[[ $FAILS -eq 0 ]]
