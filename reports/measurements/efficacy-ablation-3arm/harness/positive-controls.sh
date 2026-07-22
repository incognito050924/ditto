#!/usr/bin/env bash
# Positive controls — prove the sandbox boundaries actually BLOCK, not merely
# that we configured them. Each control deliberately attempts to cross a
# boundary and passes only when the crossing fails.
#
#   positive-controls.sh --sandbox <dir>
#
#   PC1  git push from the clone fails AND the clone has zero remotes
#   PC2  gh is unauthenticated inside the sandbox (or unreachable)
#   PC3  egress: (a) proxied curl to a non-allowlisted host fails,
#        (b) proxy-bypassing curl (--noproxy '*') fails too (sandbox-exec
#        enforcement; in proxy-env degrade mode this leaks and fails closed
#        unless ABLATION_ALLOW_DEGRADED_NET=1), (c) the denial is in the
#        proxy's append-only log
#   PC4  child-process env: hook-kill vars (DITTO_SKIP_HOOKS,
#        DITTO_AUTOPILOT_BYPASS) and credential vars are ABSENT even when
#        deliberately poisoned into the caller's env; HOME is the isolated one
#   PC5  the REAL global ~/.claude snapshot (key-file mtime+sha, plugin list)
#        is unchanged since provision
#
# Exit 0 only when every control passes. Output is teed to
# <sandbox>/logs/positive-controls.out.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
source "$HERE/config.sh"

SANDBOX=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sandbox) SANDBOX="$2"; shift 2 ;;
    -h|--help) sed -n '2,24p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "error: unknown arg '$1'" >&2; exit 2 ;;
  esac
done
[[ -n "$SANDBOX" && -d "$SANDBOX" ]] || { echo "error: --sandbox <dir> required" >&2; exit 2; }
SANDBOX="$(cd "$SANDBOX" && pwd)" # normalize (double-slash paths break string compares)
CLONE="$SANDBOX/work/palimpsest"
RUN="$SANDBOX/run-in-sandbox.sh"
[[ -x "$RUN" ]] || { echo "error: $RUN missing — not a provisioned sandbox" >&2; exit 2; }
NET_MODE="$(ablation_json_field "$SANDBOX/provision-manifest.json" net_mode)"

OUT="$SANDBOX/logs/positive-controls.out"
: > "$OUT"
say() { echo "$@" | tee -a "$OUT"; }
FAILS=0
pc() { # <id> <0=pass else fail> <desc>
  if [[ "$2" == 0 ]]; then say "PC$1 PASS — $3"; else say "PC$1 FAIL — $3"; FAILS=$((FAILS + 1)); fi
}

# ── PC1: push blocked
push_rc=0
(cd "$CLONE" && "$RUN" git push) >>"$OUT" 2>&1 || push_rc=$?
remotes="$(git -C "$CLONE" remote)"
if [[ $push_rc -ne 0 && -z "$remotes" ]]; then
  pc 1 0 "git push fails (rc=$push_rc) and the clone has zero remotes"
else
  pc 1 1 "git push rc=$push_rc, remotes='[$remotes]' — push path not closed"
fi

# ── PC2: gh unauthenticated
if "$RUN" sh -c 'command -v gh' >/dev/null 2>&1; then
  gh_rc=0
  "$RUN" gh auth status >>"$OUT" 2>&1 || gh_rc=$?
  if [[ $gh_rc -ne 0 ]]; then
    pc 2 0 "gh present but unauthenticated inside the sandbox (rc=$gh_rc)"
  else
    pc 2 1 "gh auth status SUCCEEDED inside the sandbox — credential leak"
  fi
else
  pc 2 0 "gh not reachable on the sandbox PATH"
fi

# ── PC3: egress
PROXY_LOG="$SANDBOX/logs/egress-control.jsonl"
PROXY_OUT="$SANDBOX/logs/egress-control-proxy.out"
rm -f "$PROXY_LOG" "$PROXY_OUT"
bun "$HERE/egress-proxy.ts" --port "$ABLATION_PROXY_PORT" --allow "$ABLATION_EGRESS_ALLOWLIST" --log "$PROXY_LOG" > "$PROXY_OUT" 2>&1 &
PROXY_PID=$!
trap 'kill "$PROXY_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  grep -q '^READY' "$PROXY_OUT" 2>/dev/null && break
  sleep 0.1
done

a_rc=0
"$RUN" curl -sS --max-time 8 https://example.com -o /dev/null >>"$OUT" 2>&1 || a_rc=$?
if [[ $a_rc -ne 0 ]]; then
  pc 3 0 "(a) proxied egress to non-allowlisted host denied (curl rc=$a_rc)"
else
  pc 3 1 "(a) proxied curl to example.com SUCCEEDED — allowlist not enforced"
fi

b_rc=0
"$RUN" curl -sS --noproxy '*' --max-time 8 https://example.com -o /dev/null >>"$OUT" 2>&1 || b_rc=$?
if [[ "$NET_MODE" == "sandbox-exec" ]]; then
  if [[ $b_rc -ne 0 ]]; then
    pc 3 0 "(b) proxy-bypassing egress denied by sandbox-exec (curl rc=$b_rc)"
  else
    pc 3 1 "(b) proxy-bypassing curl SUCCEEDED — sandbox-exec layer not effective"
  fi
else
  if [[ $b_rc -ne 0 ]]; then
    pc 3 0 "(b) proxy-bypassing egress failed even in proxy-env mode (rc=$b_rc)"
  elif [[ "$ABLATION_ALLOW_DEGRADED_NET" == "1" ]]; then
    say "PC3 DEGRADED — (b) direct egress NOT blocked in proxy-env mode (accepted by ABLATION_ALLOW_DEGRADED_NET=1; recorded)"
  else
    pc 3 1 "(b) direct egress leaks in proxy-env mode (fail-closed; set ABLATION_ALLOW_DEGRADED_NET=1 only with the degrade documented)"
  fi
fi

if grep '"host":"example.com"' "$PROXY_LOG" 2>/dev/null | grep -q '"allowed":false'; then
  pc 3 0 "(c) denial recorded in the proxy egress log"
else
  pc 3 1 "(c) no denial entry for example.com in the proxy egress log"
fi
kill "$PROXY_PID" 2>/dev/null || true
trap - EXIT

# ── PC4: env sanitization (deliberately poison, then assert absence inside)
envout="$(DITTO_SKIP_HOOKS=1 DITTO_AUTOPILOT_BYPASS=1 GH_TOKEN=poison ANTHROPIC_API_KEY=poison \
  "$RUN" sh -c 'env' 2>>"$OUT")"
env_bad=0
for v in DITTO_SKIP_HOOKS DITTO_AUTOPILOT_BYPASS GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN \
  ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY \
  GOOGLE_APPLICATION_CREDENTIALS SSH_AUTH_SOCK; do
  if echo "$envout" | grep -q "^$v="; then
    say "  leaked into sandbox env: $v"
    env_bad=1
  fi
done
echo "$envout" | grep -q "^HOME=$SANDBOX/home$" || env_bad=1
pc 4 "$env_bad" "sandbox child env: hook-kill + credential vars absent, HOME isolated"

# ── PC5: global ~/.claude invariance
ablation_global_snapshot > "$SANDBOX/logs/global-snapshot-after.txt"
if diff "$SANDBOX/global-snapshot.txt" "$SANDBOX/logs/global-snapshot-after.txt" >>"$OUT" 2>&1; then
  pc 5 0 "global claude dir unchanged since provision (mtime+sha snapshot identical)"
else
  pc 5 1 "global claude dir CHANGED since provision — isolation breached (diff in $OUT)"
fi

say "positive-controls: failures=$FAILS"
[[ $FAILS -eq 0 ]]
