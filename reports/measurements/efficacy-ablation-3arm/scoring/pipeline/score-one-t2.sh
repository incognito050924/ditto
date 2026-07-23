#!/usr/bin/env bash
# N9-scoring pipeline — one session. Reproduces the session-end clone state in a
# fresh scratch clone (guardrail: sandboxes & runs/ stay read-only; oracle
# re-injection happens only in the scratch clone), then runs the FROZEN scorer
# (score.sh blind + score.sh score) with the frozen pytest cmd from rules.json.
set -uo pipefail
A="$1"  # e.g. 4-A
ROOT=/Users/incognito/dev/projects/ditto/reports/measurements/efficacy-ablation-3arm
HARNESS=$ROOT/harness
RUNS=$ROOT/runs
SCORING=$ROOT/scoring
SB=/var/folders/p2/1g3xmv1j7jx0n7x3y1mtc2y80000gn/T/ditto-ablation-sandboxes
SCRATCH_BASE=/private/tmp/claude-501/-Users-incognito-dev-projects-ditto/52ab06d8-8c29-4b40-8122-ec97744da29e/scratchpad/scoring-scratch
PYTEST_CMD="$(R=$ROOT bun -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.R+"/bundle/rules.json","utf8")).regression.pytest_cmd)')"

session=$RUNS/attempt-$A
sdir=$SCORING/task2-sessions/attempt-$A
sbclone=$SB/attempt-$A/work/palimpsest
scratch=$SCRATCH_BASE/t2-attempt-$A
log(){ echo "[$(date -u +%H:%M:%S)] $*"; }

mkdir -p "$sdir"
# 1. copy sealed artifacts (runs/ read-only; copies live under scoring/)
for f in session-meta.json diff.patch git-status.txt transcript.jsonl egress.jsonl feeder-log.md; do
  [[ -f "$session/$f" ]] && cp "$session/$f" "$sdir/$f"
done

# 2. blind view + residual scan FIRST (meta still carries the original sandbox path)
blind_exit=0
(cd "$HARNESS" && ABLATION_BUNDLE_DIR="$ROOT/bundle-2" ABLATION_PROMPT_RELPATH=prompt-2.md ./score.sh blind --session "$sdir") > "$sdir/blind-scan.out" 2>&1 || blind_exit=$?
echo "$blind_exit" > "$sdir/blind-exit.txt"
log "$A blind exit=$blind_exit"

# 3. scratch clone reproduction (sandbox is only ever READ)
rm -rf "$scratch"; mkdir -p "$scratch/work"
git clone --no-hardlinks -q "$sbclone" "$scratch/work/palimpsest"
clone="$scratch/work/palimpsest"
git -C "$clone" remote remove origin 2>/dev/null || true

clone_head="$(F="$sdir/session-meta.json" bun -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.F,"utf8")).clone_head)')"
end_head="$(git -C "$sbclone" rev-parse HEAD)"
git -C "$clone" checkout -q "$end_head"
# fixture pin (I-5): parent of the instruction-baseline commit == frozen fixture sha
pre_base="$(git -C "$clone" rev-parse "$clone_head^")"
[[ "$pre_base" == "20435ccdbfe4a5a70e198aaeec5d608fa9f490da" ]] || { log "$A FIXTURE PIN FAIL: $pre_base"; exit 1; }
# end-head authenticity: either == sealed clone_head, or the commit sha appears in the SEALED transcript
if [[ "$end_head" != "$clone_head" ]]; then
  short="${end_head:0:7}"
  if grep -aq "$short" "$session/transcript.jsonl"; then
    log "$A end_head $short != clone_head but found in sealed transcript (in-session commit) OK"
    echo "end_head=$end_head verified_via=sealed-transcript" > "$sdir/end-head-verification.txt"
  else
    log "$A END-HEAD NOT IN SEALED TRANSCRIPT — cannot authenticate"; exit 1
  fi
else
  echo "end_head=$end_head verified_via=sealed-clone-head" > "$sdir/end-head-verification.txt"
fi

# 4. re-apply sealed unstaged diff
if [[ -s "$sdir/diff.patch" ]]; then
  git -C "$clone" apply "$sdir/diff.patch" || { log "$A DIFF APPLY FAIL"; exit 1; }
fi

# 5. copy untracked NEW TEST files listed in the sealed git-status.txt (the task
#    mandates a new test file; it is collected by the regression suite, so the
#    reproduced tree needs it). Other untracked entries (.claude/ .ditto/
#    CLAUDE.md instruction/engine surfaces) do not affect pytest and stay out.
grep '^??' "$sdir/git-status.txt" | sed 's/^?? //' | while IFS= read -r p; do
  case "$p" in
    tests/*)
      mkdir -p "$clone/$(dirname "$p")"
      cp "$sbclone/$p" "$clone/$p"
      log "$A copied untracked test $p"
      ;;
  esac
done
# authenticity (advisory): fraction of the copied test's lines present in the sealed transcript
grep '^??' "$sdir/git-status.txt" | sed 's/^?? //' | while IFS= read -r p; do
  case "$p" in
    tests/*)
      TF="$clone/$p" TR="$session/transcript.jsonl" bun -e '
        const fs=require("fs");
        const lines=fs.readFileSync(process.env.TF,"utf8").split("\n").map(s=>s.trim()).filter(s=>s.length>20);
        const tr=fs.readFileSync(process.env.TR,"utf8");
        let hit=0; for(const l of lines){ const esc=JSON.stringify(l).slice(1,-1); if(tr.includes(esc)||tr.includes(l)) hit++; }
        console.log(`untracked-test-authenticity ${process.env.TF.split("/").pop()}: ${hit}/${lines.length} lines found in sealed transcript`);
      ' >> "$sdir/untracked-authenticity.txt"
      ;;
  esac
done

# 6. fresh venv (editable install must point at THIS scratch clone)
( cd "$clone" && python3 -m venv .venv && ./.venv/bin/pip -q install -e . pytest ) > "$sdir/venv-setup.out" 2>&1 \
  || { log "$A VENV/PIP FAIL"; cat "$sdir/venv-setup.out" | tail -5; exit 1; }
( cd "$clone" && ./.venv/bin/pip freeze ) > "$sdir/scratch-pip-freeze.txt" 2>&1

# 7. redirect meta sandbox -> scratch (mechanical; original preserved in runs/)
F="$sdir/session-meta.json" NS="$scratch" bun -e '
  const fs=require("fs"); const o=JSON.parse(fs.readFileSync(process.env.F,"utf8"));
  o.sandbox_original=o.sandbox; o.sandbox=process.env.NS;
  fs.writeFileSync(process.env.F, JSON.stringify(o,null,2));'

# 8. FROZEN scorer with the FROZEN pytest cmd
score_exit=0
(cd "$HARNESS" && ABLATION_BUNDLE_DIR="$ROOT/bundle-2" ABLATION_PROMPT_RELPATH=prompt-2.md ABLATION_PYTEST_CMD="$PYTEST_CMD" ./score.sh score --session "$sdir") > "$sdir/score-run.out" 2>&1 || score_exit=$?
log "$A score exit=$score_exit: $(tail -1 "$sdir/score-run.out")"

# ── task-2 additions: bundle-2 scope-meter (frozen) + committed name-status
"$ROOT/bundle-2/scope-meter.sh" --clone "$clone" --head "$clone_head" --out "$sdir/scope-meter.json" || log "$A SCOPE-METER FAIL"
if [[ "$end_head" != "$clone_head" ]]; then
  git -C "$clone" diff --name-status "$clone_head" "$end_head" > "$sdir/committed-name-status.txt"
  git -C "$clone" diff --name-status "$clone_head" "$end_head" -- tests conftest.py pytest.ini pyproject.toml > "$sdir/committed-test-name-status.txt"
fi
exit 0
