#!/usr/bin/env bash
# Provision ONE disposable, isolated sandbox for a single ablation attempt.
#
#   provision-sandbox.sh --arm B0|B1|A --attempt <id> [--with-auth] [--src <path>]
#
# What it builds (all under $ABLATION_SANDBOX_ROOT/attempt-<id>-<arm>/):
#   home/            isolated $HOME (global ~/.claude is never touched)
#   claude-config/   isolated $CLAUDE_CONFIG_DIR
#   work/palimpsest  fresh clone: --no-hardlinks, origin removed (post-verified)
#   bin/             arm A: the frozen old-product `ditto` executable
#   run-in-sandbox.sh  whitelist-env (env -i) wrapper; under
#                    ABLATION_NET_MODE=sandbox-exec it also applies the SBPL
#                    profile (outbound remote-IP denied, loopback only)
#   provision-manifest.json  arm, clone head, digests, removals — the record
#                    positive controls and run-session pre-flights check against
#   global-snapshot.txt  read-only snapshot of the REAL ~/.claude for the
#                    invariance control (PC5)
#
# Arm preparation (post-conditions fail-closed):
#   B0  no instruction files anywhere in the clone root / isolated dirs
#   B1  bundle charter (digest-verified against the frozen manifest) injected
#       as clone/CLAUDE.md
#   A   frozen bin/ditto (digest-verified) installed into the sandbox and
#       `ditto setup` run against the clone inside the sanitized env; hook
#       registration must land in the ISOLATED config, never the global one
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
source "$HERE/config.sh"

usage() {
  sed -n '2,10p' "${BASH_SOURCE[0]}"
}

ARM="" ATTEMPT="" WITH_AUTH=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --arm) ARM="$2"; shift 2 ;;
    --attempt) ATTEMPT="$2"; shift 2 ;;
    --with-auth) WITH_AUTH=1; shift ;;
    --src) ABLATION_PALIMPSEST_SRC="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown arg '$1'" >&2; usage; exit 2 ;;
  esac
done

[[ "$ARM" =~ ^(B0|B1|A)$ ]] || { echo "error: --arm must be B0|B1|A" >&2; exit 2; }
[[ "$ATTEMPT" =~ ^[0-9]+$ ]] || { echo "error: --attempt must be an integer" >&2; exit 2; }
ablation_require_src

mkdir -p "$ABLATION_SANDBOX_ROOT"
SBROOT="$(cd "$ABLATION_SANDBOX_ROOT" && pwd)"

# ── containment: no .git/.ditto in any ancestor of the sandbox root.
# ditto findRepoRoot walks upward from cwd; an ancestor repo would leak the
# real workspace into the session.
d="$SBROOT"
while :; do
  if [[ -e "$d/.git" || -e "$d/.ditto" ]]; then
    echo "error: sandbox-root ancestry has $d/.git|.ditto — set ABLATION_SANDBOX_ROOT outside any repo" >&2
    exit 2
  fi
  [[ "$d" == "/" ]] && break
  d="$(dirname "$d")"
done

SANDBOX="$SBROOT/attempt-${ATTEMPT}-${ARM}"
if [[ -e "$SANDBOX" ]]; then
  echo "error: $SANDBOX already exists — sandboxes are single-use (new attempt id per trial)" >&2
  exit 2
fi
mkdir -p "$SANDBOX"/{home,claude-config,work,bin,logs,tmp}

# ── global snapshot (read-only) for positive control 5
ablation_global_snapshot > "$SANDBOX/global-snapshot.txt"

# ── clone: --no-hardlinks + origin removed
CLONE="$SANDBOX/work/palimpsest"
git clone --no-hardlinks -- "$ABLATION_PALIMPSEST_SRC" "$CLONE" > "$SANDBOX/logs/clone.log" 2>&1
git -C "$CLONE" remote remove origin
if [[ -n "$(git -C "$CLONE" remote)" ]]; then
  echo "error: clone still has remotes after origin removal" >&2
  exit 1
fi
# hardlink post-condition: object files must not share inodes with the source
OBJ="$(find "$CLONE/.git/objects" -type f 2>/dev/null | head -1 || true)"
if [[ -n "$OBJ" && "$(stat -f %l "$OBJ")" != "1" ]]; then
  echo "error: clone shares hardlinked git objects with the source repo" >&2
  exit 1
fi

# neutral in-clone git identity — arm-symmetric (all arms can commit; arm A's
# engine needs land commits) without leaking the user's identity
git -C "$CLONE" config user.name "ablation-session"
git -C "$CLONE" config user.email "ablation@localhost"

# ── instruction-file baseline, symmetric across arms: pre-existing agent
# instruction surfaces are removed from the clone so B0 is genuinely
# instruction-free and B1/A start from the same floor. Tracked removals are
# committed as a pre-session baseline so session diffs stay clean.
REMOVED=()
for f in CLAUDE.md AGENTS.md .claude .ditto .claude-plugin recipe.yaml; do
  if [[ -e "$CLONE/$f" ]]; then
    rm -rf "${CLONE:?}/$f"
    REMOVED+=("$f")
  fi
done
# instruction-derived backup remnants: *.ditto_bak in the clone root can be a
# full charter snapshot (CLAUDE.md.ditto_bak) — left in place it would break
# B0's "no instructions" floor. Removed symmetrically across all arms.
for f in "$CLONE"/*.ditto_bak; do
  [[ -e "$f" ]] || continue
  rm -f "$f"
  REMOVED+=("$(basename "$f")")
done
if [[ -n "$(git -C "$CLONE" status --porcelain)" ]]; then
  git -C "$CLONE" add -A
  git -C "$CLONE" -c user.name=harness -c user.email=harness@localhost \
    commit -q -m "harness: instruction-file baseline (removed: ${REMOVED[*]:-none})"
fi
CLONE_HEAD="$(git -C "$CLONE" rev-parse HEAD)"

# ── sanitized PATH: system dirs + the dirs of the few tools sessions need.
# Whitelist construction (not blocklist): everything else simply is not there.
SAN_PATH="/usr/bin:/bin:/usr/sbin:/sbin"
add_tool_dir() {
  local p dirp
  p="$(command -v "$1" 2>/dev/null || true)"
  [[ -n "$p" ]] || return 0
  dirp="$(cd "$(dirname "$p")" && pwd)"
  case ":$SAN_PATH:" in
    *":$dirp:"*) ;;
    *) SAN_PATH="$dirp:$SAN_PATH" ;;
  esac
}
for t in bun git curl gh "$ABLATION_CLAUDE_BIN"; do add_tool_dir "$t"; done
SAN_PATH="$SANDBOX/bin:$SAN_PATH" # arm A's ditto; empty dir for B arms (symmetric)

# ── env-sanitized wrapper. env -i guarantees ambient credentials and
# hook-kill vars (DITTO_SKIP_HOOKS, DITTO_AUTOPILOT_BYPASS, GH_TOKEN,
# ANTHROPIC_*) can NOT be inherited — only the whitelist below exists inside.
PROXY_URL="http://127.0.0.1:${ABLATION_PROXY_PORT}"
cat > "$SANDBOX/run-in-sandbox.sh" <<EOF
#!/usr/bin/env bash
# generated by provision-sandbox.sh — whitelist-env exec into this sandbox
set -euo pipefail
ENVV=(
  HOME="$SANDBOX/home"
  CLAUDE_CONFIG_DIR="$SANDBOX/claude-config"
  PATH="$SAN_PATH"
  TMPDIR="$SANDBOX/tmp"
  TERM="\${TERM:-xterm-256color}"
  LANG="en_US.UTF-8"
  HTTP_PROXY="$PROXY_URL"
  HTTPS_PROXY="$PROXY_URL"
  http_proxy="$PROXY_URL"
  https_proxy="$PROXY_URL"
  ALL_PROXY="$PROXY_URL"
  NO_PROXY="localhost,127.0.0.1"
  no_proxy="localhost,127.0.0.1"
)
if [[ "$ABLATION_NET_MODE" == "sandbox-exec" ]]; then
  exec /usr/bin/env -i "\${ENVV[@]}" /usr/bin/sandbox-exec -p '$ABLATION_SBPL' "\$@"
else
  exec /usr/bin/env -i "\${ENVV[@]}" "\$@"
fi
EOF
chmod +x "$SANDBOX/run-in-sandbox.sh"

# ── credentials (single deliberate exception, opt-in): headless claude needs
# auth. --with-auth copies ONLY the credential file into the isolated config —
# no instructions, no settings, no memory. On macOS credentials may instead
# live in the Keychain, which HOME isolation cannot fence off (README limit).
AUTH_NOTE="none"
if (( WITH_AUTH )); then
  GDIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  if [[ -f "$GDIR/.credentials.json" ]]; then
    cp "$GDIR/.credentials.json" "$SANDBOX/claude-config/.credentials.json"
    chmod 600 "$SANDBOX/claude-config/.credentials.json"
    AUTH_NOTE="copied .credentials.json (auth only — no instructions/config)"
  else
    AUTH_NOTE="no credential file; macOS Keychain likely holds auth (reachable despite HOME isolation — documented limit)"
  fi
fi

# ── arm preparation + post-conditions (fail-closed)
CHARTER_SHA=""
ARM_A_SHA=""
case "$ARM" in
  B0)
    for f in CLAUDE.md AGENTS.md .claude recipe.yaml; do
      if [[ -e "$CLONE/$f" || -e "$SANDBOX/home/$f" || -e "$SANDBOX/claude-config/$f" ]]; then
        echo "error: B0 post-condition failed — instruction surface '$f' present" >&2
        exit 1
      fi
    done
    if compgen -G "$CLONE/*.ditto_bak" > /dev/null; then
      echo "error: B0 post-condition failed — instruction-derived remnant *.ditto_bak present in clone root" >&2
      exit 1
    fi
    ;;
  B1)
    CHARTER_SHA="$(ablation_verify_bundle_file "$ABLATION_CHARTER_RELPATH")"
    cp "${ABLATION_BUNDLE_DIR%/}/$ABLATION_CHARTER_RELPATH" "$CLONE/CLAUDE.md"
    if [[ "$(ablation_sha256 "$CLONE/CLAUDE.md")" != "$CHARTER_SHA" ]]; then
      echo "error: B1 post-condition failed — injected charter digest != frozen bundle digest" >&2
      exit 1
    fi
    ;;
  A)
    ARM_A_SHA="$(ablation_verify_bundle_file "$ABLATION_ARM_A_BIN_RELPATH")"
    cp "${ABLATION_BUNDLE_DIR%/}/$ABLATION_ARM_A_BIN_RELPATH" "$SANDBOX/bin/ditto"
    chmod +x "$SANDBOX/bin/ditto"
    # install inside the sanitized env: all writes land in the ISOLATED
    # HOME/CLAUDE_CONFIG_DIR — the global ~/.claude stays untouched (PC5 proves it)
    # shellcheck disable=SC2086
    if ! (cd "$CLONE" && "$SANDBOX/run-in-sandbox.sh" "$SANDBOX/bin/ditto" setup --dir "$CLONE" --yes $ABLATION_ARM_A_SETUP_ARGS) \
      > "$SANDBOX/logs/arm-a-setup.log" 2>&1; then
      echo "error: arm A setup failed (see $SANDBOX/logs/arm-a-setup.log)" >&2
      exit 1
    fi
    if ! grep -rq "ditto" "$SANDBOX/claude-config" 2>/dev/null \
      && ! grep -rq "ditto" "$CLONE/.claude" 2>/dev/null; then
      echo "error: arm A post-condition failed — no ditto hook registration in isolated config or clone/.claude" >&2
      exit 1
    fi
    if [[ ! -d "$CLONE/.ditto" ]]; then
      echo "error: arm A post-condition failed — clone has no .ditto scaffold" >&2
      exit 1
    fi
    ;;
esac

# ── manifest
M_ARM="$ARM" M_ATTEMPT="$ATTEMPT" M_SANDBOX="$SANDBOX" M_SRC="$ABLATION_PALIMPSEST_SRC" \
M_CLONE_HEAD="$CLONE_HEAD" M_REMOVED="${REMOVED[*]:-}" M_CHARTER_SHA="$CHARTER_SHA" \
M_ARM_A_SHA="$ARM_A_SHA" M_AUTH="$AUTH_NOTE" M_NET="$ABLATION_NET_MODE" \
bun -e 'const e=process.env;console.log(JSON.stringify({schema:"ablation-provision-manifest/1",arm:e.M_ARM,attempt:Number(e.M_ATTEMPT),sandbox:e.M_SANDBOX,clone_src:e.M_SRC,clone_head:e.M_CLONE_HEAD,instruction_files_removed:(e.M_REMOVED||"").split(" ").filter(Boolean),charter_sha256:e.M_CHARTER_SHA||null,arm_a_bin_sha256:e.M_ARM_A_SHA||null,auth:e.M_AUTH,net_mode:e.M_NET,provisioned_at:new Date().toISOString()},null,2))' \
  > "$SANDBOX/provision-manifest.json"

echo "$SANDBOX"
