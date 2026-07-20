#!/bin/sh
# bootstrap-scratch-tree.sh — pure-env FS isolation for a Track B build.
#
# WHY: the build agents inherit this session's user-scope config (global CLAUDE.md,
# charter, ditto plugin) — that cannot be isolated in-session (see README "순수환경 결정").
# What CAN be isolated is the PROJECT-scope FS/VCS surface: build in a repo-OUTSIDE
# `git init` working tree with no `.claude/`, no `.mcp.json`, no `CLAUDE.md`, and no
# ditto `.githooks` (core.hooksPath is repo-local, so a tree outside the repo never fires it).
#
# Usage:  sh bootstrap-scratch-tree.sh <scratch-parent-dir> <path-to-ditto-repo-root>
# Prints the created scratch tree path on stdout (last line). Fail-closed on any misstep.
set -eu

PARENT="${1:?usage: bootstrap-scratch-tree.sh <scratch-parent-dir> <ditto-repo-root>}"
REPO="${2:?usage: bootstrap-scratch-tree.sh <scratch-parent-dir> <ditto-repo-root>}"

# Refuse a scratch parent INSIDE the ditto repo — that would re-expose project .claude/ + .githooks.
case "$(cd "$PARENT" 2>/dev/null && pwd -P || echo "")" in
  "$(cd "$REPO" && pwd -P)"|"$(cd "$REPO" && pwd -P)"/*)
    echo "REFUSED: scratch parent is inside the ditto repo — pick a repo-OUTSIDE dir (project-scope isolation)." >&2
    exit 3 ;;
esac

TREE="$PARENT/vehicle-b-build"
rm -rf "$TREE"
mkdir -p "$TREE"

# Seed only the LOCKED contracts (the from-contracts starting point). No ditto surface travels.
mkdir -p "$TREE/rebuild"
cp -R "$REPO/rebuild/schemas" "$TREE/rebuild/schemas"
cp -R "$REPO/rebuild/seam" "$TREE/rebuild/seam"
# Minimal toolchain manifests so `bun test` resolves zod the same way.
[ -f "$REPO/package.json" ] && cp "$REPO/package.json" "$TREE/package.json"
[ -f "$REPO/bun.lockb" ] && cp "$REPO/bun.lockb" "$TREE/bun.lockb"
[ -f "$REPO/tsconfig.json" ] && cp "$REPO/tsconfig.json" "$TREE/tsconfig.json"

# Provision deps so `bun test` resolves zod in the isolated tree. A repo-outside tree cannot
# borrow the repo's node_modules by symlink (bun resolves from the real path), so install for real.
# Prefer the frozen lockfile; fall back to a plain install. Network may be required the first time.
( cd "$TREE" && ( bun install --frozen-lockfile >/dev/null 2>&1 || bun install >/dev/null 2>&1 ) ) || {
  echo "ISOLATION FAIL: could not provision deps in scratch tree (bun install failed — network/cache?)" >&2
  exit 6
}

# Isolated VCS so implementers can commit WITHOUT firing ditto's core.hooksPath=.githooks.
( cd "$TREE" && git init -q && git config core.hooksPath "" && printf 'node_modules/\n' > .gitignore && git add -A && git -c user.email=b@vehicle -c user.name=vehicle-b commit -q -m "seed: locked rebuild/ contracts" )

# Assert isolation: none of the ditto interference surfaces are present in the tree.
for bad in .claude .mcp.json CLAUDE.md .githooks; do
  if [ -e "$TREE/$bad" ]; then echo "ISOLATION FAIL: $bad present in scratch tree" >&2; exit 4; fi
done

# Assert the seeded contracts are green before any build starts (baseline).
if ( cd "$TREE" && bun test rebuild/ >/dev/null 2>&1 ); then
  echo "baseline: rebuild/ green in isolated tree" >&2
else
  echo "ISOLATION FAIL: seeded contracts not green in scratch tree (install/toolchain?)" >&2
  exit 5
fi

echo "$TREE"
