#!/usr/bin/env bash
# 3-arm ablation harness — central config. Every value is env-overridable; no
# personal paths are hardcoded. Sourced by every harness script.
#
# Exit-code convention across the harness:
#   0 ok · 1 check/mechanical failure · 2 usage/config error · 3 attempt-cap
#   refused · 4 residual arm-signal found (blind scoring)

ABLATION_HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Clone source (the real palimpsest checkout). REQUIRED at provision time —
# deliberately no default (personal path, never hardcoded). Read-only: the
# harness only ever clones FROM it, never writes into it.
: "${ABLATION_PALIMPSEST_SRC:=}"

# Frozen pre-registration bundle (authored+committed by the bundle node; see
# README "Bundle contract").
: "${ABLATION_BUNDLE_DIR:=${ABLATION_HARNESS_DIR%/}/../bundle}"

# Per-session artifacts + append-only ledger (runtime output, not authored files).
: "${ABLATION_RUNS_DIR:=${ABLATION_HARNESS_DIR%/}/../runs}"

# Disposable sandboxes — MUST live outside any .git/.ditto ancestry (ditto's
# findRepoRoot walks upward from cwd; provision asserts containment).
: "${ABLATION_SANDBOX_ROOT:=${TMPDIR:-/tmp}/ditto-ablation-sandboxes}"

: "${ABLATION_MAX_ATTEMPTS:=15}"        # total-attempt cap (valid+invalid)
: "${ABLATION_SESSION_TIMEOUT_MIN:=45}" # wall-clock cap per session
: "${ABLATION_SESSION_TIMEOUT_SECONDS:=}" # test override; wins over MIN when set
: "${ABLATION_PROXY_PORT:=18790}"

# Minimal endpoints the claude CLI needs (subscription OAuth + API). Every
# grant/deny is logged by egress-proxy.ts; the pilot tunes this from the
# denied log. Suffix match: an entry also covers its subdomains.
: "${ABLATION_EGRESS_ALLOWLIST:=api.anthropic.com,claude.ai,console.anthropic.com,statsig.anthropic.com,sentry.io}"

: "${ABLATION_CLAUDE_BIN:=claude}"
: "${ABLATION_PYTEST_CMD:=python3 -m pytest}"
# Pre-existing test surface protected by the no-tamper predicate (clone-relative).
: "${ABLATION_TEST_PATHS:=tests conftest.py pytest.ini pyproject.toml}"

# Network mode:
#   sandbox-exec  deny all outbound remote IP at the kernel-sandbox layer,
#                 loopback only, + loopback allowlist proxy  (default)
#   proxy-env     proxy env vars only (honest degrade — cooperating processes
#                 only; positive controls fail-closed unless explicitly allowed)
: "${ABLATION_NET_MODE:=sandbox-exec}"
: "${ABLATION_ALLOW_DEGRADED_NET:=0}"   # 1 = accept proxy-env degrade (recorded)

: "${ABLATION_ARM_A_SETUP_ARGS:=}"      # extra args for `ditto setup` (arm A)
: "${ABLATION_CHARTER_RELPATH:=charter/CLAUDE.md}"  # bundle-relative
: "${ABLATION_ARM_A_BIN_RELPATH:=arm-a/ditto}"      # bundle-relative
: "${ABLATION_PROMPT_RELPATH:=prompts/task.md}"     # bundle-relative
: "${ABLATION_FLAGS_RELPATH:=claude-flags.txt}"     # bundle-relative, optional

ABLATION_LEDGER_FILE="${ABLATION_LEDGER_FILE:-${ABLATION_RUNS_DIR%/}/ledger.jsonl}"

# SBPL profile, measured working on macOS 26.5 (self-check S2 re-verifies on
# every run): denies ALL outbound remote-IP traffic, allows loopback only.
# Combined with the loopback allowlist proxy this blocks payload egress even
# for processes that ignore proxy env vars. Known limits (README): DNS queries
# still leave via the mDNSResponder daemon (outside the sandbox); sandbox-exec
# is Apple-deprecated (still functional — re-measured by self-check).
ABLATION_SBPL='(version 1)(allow default)(deny network-outbound (remote ip))(allow network-outbound (remote ip "localhost:*"))'

ablation_require_src() {
  if [[ -z "$ABLATION_PALIMPSEST_SRC" ]]; then
    echo "error: ABLATION_PALIMPSEST_SRC is not set (path to the checkout to clone)" >&2
    return 2
  fi
  if [[ ! -d "$ABLATION_PALIMPSEST_SRC/.git" ]]; then
    echo "error: ABLATION_PALIMPSEST_SRC=$ABLATION_PALIMPSEST_SRC is not a git checkout" >&2
    return 2
  fi
}

ablation_sha256() { shasum -a 256 "$1" | awk '{print $1}'; }

# Expected sha for a bundle-relative path, from the frozen manifest.
ablation_manifest_sha() {
  local rel="$1" line
  line="$(grep -E "^[0-9a-f]{64} [ *]?${rel}\$" "${ABLATION_BUNDLE_DIR%/}/manifest.sha256" | head -1 || true)"
  [[ -n "$line" ]] || { echo "error: '$rel' not listed in bundle manifest" >&2; return 1; }
  echo "${line%% *}"
}

# Verify a bundle file on disk against the manifest; prints the sha on success.
ablation_verify_bundle_file() {
  local rel="$1" want got
  want="$(ablation_manifest_sha "$rel")" || return 1
  got="$(ablation_sha256 "${ABLATION_BUNDLE_DIR%/}/$rel")" || return 1
  if [[ "$want" != "$got" ]]; then
    echo "error: bundle file '$rel' digest mismatch (frozen=$want disk=$got)" >&2
    return 1
  fi
  echo "$got"
}

# Read one top-level field from a JSON file (empty string when null/absent).
ablation_json_field() {
  JF_FILE="$1" JF_FIELD="$2" bun -e 'const o=JSON.parse(require("fs").readFileSync(process.env.JF_FILE,"utf8"));const v=o[process.env.JF_FIELD];console.log(v==null?"":String(v))'
}

# Snapshot of the REAL global claude dir (key files: mtime+sha, plugin listing).
# Read-only; used by positive control 5 (global invariance).
ablation_global_snapshot() {
  local g="${CLAUDE_CONFIG_DIR:-$HOME/.claude}" f
  echo "# global-claude-dir: $g"
  for f in settings.json settings.local.json CLAUDE.md config.json; do
    if [[ -f "$g/$f" ]]; then
      echo "$f mtime=$(stat -f %m "$g/$f") sha256=$(ablation_sha256 "$g/$f")"
    else
      echo "$f ABSENT"
    fi
  done
  if [[ -d "$g/plugins" ]]; then
    (cd "$g/plugins" && ls -1 | sed 's/^/plugins\//')
  fi
}
