import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import type { declarerRole } from '~/schemas/common';
import { type CompletionContract, completionContract } from '~/schemas/completion-contract';
import type { WorkItem } from '~/schemas/work-item';

type DeclarerRole = z.infer<typeof declarerRole>;
import { deriveAcVerdicts } from './autopilot-complete';
import { AutopilotStore } from './autopilot-store';
import { containScopePath } from './coverage-oracle';
import { localDir } from './ditto-paths';
import { writeJson } from './fs';
import { HandoffStore, buildHandoff } from './handoff-store';
import type { WorkItemStore } from './work-item-store';

export interface HandoffResult {
  completion: CompletionContract;
  completionPath: string;
  handoffPath: string;
  collectedChangedFiles: string[];
  baseUsed: string | null;
}

export interface HandoffOptions {
  base?: string;
  head?: string;
  /**
   * Agent role that declares this completion. `declared_by` records *who judged*,
   * not the execution profile. The `ditto work handoff` path is driven by the main
   * agent, so the default is 'main'; a verifier-owned closure can override.
   */
  declaredBy?: DeclarerRole;
  /**
   * Explicit, PRE-SANITIZED (see `sanitizeDeclaredPaths`) repo-relative paths the
   * caller declares as changed by this work — an additional `changed_files` SOURCE,
   * symmetric with the autopilot owner-report. The whole-working-tree scan was
   * removed as a source (wi_260719ayc), so uncommitted work that is not in the
   * committed `base...HEAD` diff must be declared here to be recorded.
   */
  declaredChanged?: readonly string[];
}

export class InvalidBaseRefError extends Error {
  constructor(public readonly ref: string) {
    super(`--base "${ref}" is not a valid git ref in this repository`);
    this.name = 'InvalidBaseRefError';
  }
}

export class InvalidHeadRefError extends Error {
  constructor(public readonly ref: string) {
    super(`--head "${ref}" is not a valid git ref in this repository`);
    this.name = 'InvalidHeadRefError';
  }
}

/**
 * Try a list of refs in order and return the first one git understands.
 * Returns null when none are valid.
 */
export function pickBaseRef(repoRoot: string, candidates: string[]): string | null {
  for (const ref of candidates) {
    const proc = Bun.spawnSync(['git', 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (proc.exitCode === 0) return ref;
  }
  return null;
}

export interface CollectedChanges {
  /**
   * The DETERMINISTIC changed_files set: the committed `base...HEAD` diff ∪ the
   * caller's explicit declaration. The whole-working-tree scan is NOT a source
   * (wi_260719ayc) — foreign/uncommitted dirt can never pollute this set.
   */
  files: string[];
  /**
   * The committed `git diff` exited non-zero — env breakage (shallow clone /
   * unresolvable merge-base), NOT a clean empty diff. The caller must fail-closed
   * on this rather than treat it as "no files changed" (wi_260719ayc ac-(c)).
   */
  diffErrored: boolean;
  /**
   * GUARD, not a source: *tracked* working-tree edits that fall OUTSIDE
   * (committed diff ∪ declared ∪ started_untracked_baseline). Their presence means
   * real uncommitted, undeclared work — the caller fail-closes on it so a partial
   * under-commit (committed A + uncommitted-undeclared tracked B) cannot close
   * pass. These paths are NEVER folded into `files` — that would re-pollute
   * changed_files, the exact bug this module fixes. Only meaningful for a live
   * HEAD (`head === null`); untracked (`??`) dirt is excluded (it is not a tracked
   * edit and is exactly what must not gate).
   */
  extraTrackedDirt: string[];
}

/**
 * Sanitize an untrusted list of declared repo-relative paths (the `--changed`
 * input) by REUSING `containScopePath` (rejects absolute / `..`-escaping /
 * repoRoot-escape / git pathspec-magic like `:(exclude)`), COMPOSED with: reject a
 * leading `-` (option-injection defense-in-depth — these paths reach `git add` as
 * positional args), reject empty/whitespace-only tokens, dedup, and SKIP paths that
 * do not exist under the repo (dropped, not hard-rejected — a bad token is a hard
 * reject the caller surfaces, a merely-missing path is silently ignored). One
 * sanitizer, not a 4th ad-hoc filter (wi_260719ayc ac-(C)).
 */
export function sanitizeDeclaredPaths(
  raw: readonly string[],
  repoRoot: string,
): { accepted: string[]; rejected: { path: string; reason: string }[] } {
  const accepted = new Set<string>();
  const rejected: { path: string; reason: string }[] = [];
  for (const token of raw) {
    const trimmed = token.trim();
    if (trimmed.length === 0) {
      rejected.push({ path: token, reason: 'empty/whitespace-only token' });
      continue;
    }
    if (trimmed.startsWith('-')) {
      rejected.push({ path: token, reason: 'leading `-` (option-injection) rejected' });
      continue;
    }
    const contained = containScopePath(trimmed, repoRoot);
    if (!contained.ok) {
      rejected.push({ path: token, reason: contained.detail });
      continue;
    }
    // Skip a declared path that does not exist under the repo (dropped silently —
    // e.g. a typo; a genuine deletion simply is not carried in changed_files).
    if (!existsSync(contained.abs)) continue;
    accepted.add(trimmed);
  }
  return { accepted: Array.from(accepted), rejected };
}

/**
 * Collect the DETERMINISTIC changed_files set from the committed `base...HEAD` diff
 * ∪ the caller's `declared` paths (already sanitized). The whole-working-tree
 * `git status` scan is NO LONGER a source (wi_260719ayc) — in a shared tree it made
 * foreign uncommitted dirt indistinguishable from this work's edits. The tree is
 * consulted only as a GUARD (`extraTrackedDirt`) to fail-closed on uncommitted,
 * undeclared tracked work. If `head` is an explicit ref, the working tree is not
 * consulted at all — the caller is asking about a frozen commit range.
 */
export function collectChangedFiles(
  repoRoot: string,
  base: string | null,
  head: string | null,
  // #36 (wi_260713u4k): the run's `started_untracked_baseline` — untracked (`??`) dirt
  // that predated this run. Still excluded (defensively) from the deterministic set and
  // from the guard, though with the scan removed nothing untracked reaches `files` anyway.
  baseline: readonly string[] = [],
  declared: readonly string[] = [],
): CollectedChanges {
  const excluded = new Set(baseline);
  const set = new Set<string>();
  let diffErrored = false;
  if (base !== null) {
    const headSpec = head ?? 'HEAD';
    const diff = Bun.spawnSync(
      ['git', 'diff', '--name-only', '--diff-filter=ACMR', `${base}...${headSpec}`],
      { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' },
    );
    if (diff.exitCode === 0) {
      const text = diff.stdout?.toString() ?? '';
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (t.length > 0) set.add(t);
      }
    } else {
      // (c) A non-zero `git diff` is env breakage (shallow clone / unresolvable
      // merge-base), NOT a clean empty diff — surface it so the caller fails closed
      // instead of silently reporting "no files changed".
      diffErrored = true;
    }
  }
  // Declared paths are an explicit SOURCE (symmetric with the autopilot owner-report).
  for (const p of declared) set.add(p);

  const files = Array.from(set).filter(
    (p) => !p.startsWith('/') && !p.includes('..') && !excluded.has(p),
  );

  // (b) Working tree as a GUARD, not a source. head이 명시되면 working tree status는
  // 의미 없음 (과거 commit 범위 정정 시나리오).
  const extraTrackedDirt: string[] = [];
  if (head === null) {
    const status = Bun.spawnSync(['git', 'status', '--porcelain'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (status.exitCode === 0) {
      const known = new Set(files);
      const text = status.stdout?.toString() ?? '';
      for (const line of text.split('\n')) {
        if (line.length === 0) continue;
        // `??` untracked / `!!` ignored: NOT a tracked edit → not mutation evidence.
        const code = line.slice(0, 2);
        if (code === '??' || code === '!!') continue;
        // porcelain line format: XY <path>  or  XY <orig> -> <new>
        const trimmed = line.replace(/^..\s*/, '').trim();
        if (trimmed.length === 0) continue;
        const arrow = trimmed.indexOf(' -> ');
        const path = arrow === -1 ? trimmed : trimmed.slice(arrow + 4);
        if (path.startsWith('/') || path.includes('..')) continue;
        if (known.has(path) || excluded.has(path)) continue;
        extraTrackedDirt.push(path);
      }
    }
  }
  return { files, diffErrored, extraTrackedDirt };
}

function buildCompletion(
  item: WorkItem,
  declaredAt: string,
  changedFiles: string[],
  declaredBy: DeclarerRole,
  unverifiedExtras: { item: string; reason: string; out_of_scope: boolean }[] = [],
  prior?: CompletionContract,
  graphAcceptance?: Array<{
    criterion_id: string;
    verdict: WorkItem['acceptance_criteria'][number]['verdict'];
    evidence: WorkItem['acceptance_criteria'][number]['evidence'];
    notes?: string;
  }>,
): CompletionContract {
  // When an autopilot graph exists for this work item, `ditto autopilot complete`
  // derives the per-AC verdicts from the graph (evidence-gated). The handoff path
  // must use that SAME source so a re-handoff cannot overwrite a good graph-based
  // completion with a stale work-item-AC `partial`. Fall back to the work-item AC
  // verdicts only when no graph exists.
  const acceptance =
    graphAcceptance ??
    item.acceptance_criteria.map((ac) => ({
      criterion_id: ac.id,
      verdict: ac.verdict,
      evidence: ac.evidence,
    }));
  const allPass = acceptance.every((a) => a.verdict === 'pass');
  const blockedByUnverified = unverifiedExtras.some((u) => !u.out_of_scope);
  const final = allPass && !blockedByUnverified ? ('pass' as const) : ('partial' as const);
  const handoffPath = `.ditto/local/handoff/${item.id}.md`;
  const builtSummary = allPass
    ? `${item.title} — 모든 acceptance criterion이 pass로 기록되었다.`
    : `${item.title} — 일부 acceptance criterion이 비-pass 상태로 partial 핸드오프된다.`;
  // Merge-preserve a prior completion's non-empty fields ONLY when the freshly
  // built value is empty/default — a re-handoff must not clobber verifications /
  // remaining_risks the verifier already recorded. Summary is preserved only
  // within the same verdict class (a verdict flip means the prior summary is
  // now stale).
  const verifications = prior && prior.verifications.length > 0 ? prior.verifications : [];
  const builtRisks = item.risks.map((r) => r.description);
  const remaining_risks =
    builtRisks.length === 0 && prior && prior.remaining_risks.length > 0
      ? prior.remaining_risks
      : builtRisks;
  const summary = prior && prior.final_verdict === final ? prior.summary : builtSummary;
  const base = {
    schema_version: '0.1.0' as const,
    work_item_id: item.id,
    declared_by: declaredBy,
    declared_at: declaredAt,
    summary,
    changed_files: changedFiles,
    acceptance,
    verifications,
    unverified: unverifiedExtras,
    remaining_risks,
    final_verdict: final,
    next_handoff_path: handoffPath,
  };
  // completionContract.parse는 default/superRefine을 적용한 output을 반환
  return completionContract.parse(base);
}

export async function writeWorkItemHandoff(
  repoRoot: string,
  store: WorkItemStore,
  workId: string,
  options: HandoffOptions = {},
  now: Date = new Date(),
): Promise<HandoffResult> {
  const item = await store.get(workId);
  let baseUsed: string | null;
  if (options.base !== undefined) {
    // 사용자가 명시적으로 지정한 ref는 silent fallback 대상이 아니다. 항상 1순위.
    const verified = pickBaseRef(repoRoot, [options.base]);
    if (verified === null) {
      throw new InvalidBaseRefError(options.base);
    }
    baseUsed = verified;
  } else {
    // 우선순위: started_at_sha > origin/main > origin/master > main > master.
    // work item이 자기 시작 시점 sha를 들고 있으면 외부 ref보다 결정적.
    const candidates: string[] = [];
    if (item.started_at_sha) candidates.push(item.started_at_sha);
    candidates.push('origin/main', 'origin/master', 'main', 'master');
    baseUsed = pickBaseRef(repoRoot, candidates);
  }
  let headUsed: string | null = null;
  if (options.head !== undefined) {
    const verifiedHead = pickBaseRef(repoRoot, [options.head]);
    if (verifiedHead === null) {
      throw new InvalidHeadRefError(options.head);
    }
    headUsed = verifiedHead;
  }
  const collectResult = collectChangedFiles(
    repoRoot,
    baseUsed,
    headUsed,
    item.started_untracked_baseline,
    options.declaredChanged ?? [],
  );
  const collected = collectResult.files;
  // "changed_files not recorded" 판정은 git이 실제로 본 변경(collected) 기준.
  // self-artifact union은 그 판정과 별개로 항상 일어남.
  const unverifiedExtras: { item: string; reason: string; out_of_scope: boolean }[] = [];
  // (c) A non-zero `git diff` is env breakage, not a clean empty diff — fail-closed
  // regardless of runs/evidence, with a reason that does NOT claim "returned no files".
  if (collectResult.diffErrored) {
    unverifiedExtras.push({
      item: 'changed_files not determinable',
      reason: `git diff against ${baseUsed} exited non-zero (shallow clone or unresolvable merge-base) — the committed change cannot be determined; fetch full history / pass a reachable --base, or declare paths with --changed`,
      out_of_scope: false,
    });
  }
  // (b) A tracked working-tree edit OUTSIDE (committed diff ∪ declared ∪ baseline) is
  // real uncommitted, undeclared work — fail-closed so a partial under-commit
  // (committed A + uncommitted-undeclared tracked B) cannot close pass. These paths are
  // NOT folded into changed_files (that would re-pollute).
  if (collectResult.extraTrackedDirt.length > 0) {
    unverifiedExtras.push({
      item: 'uncommitted tracked changes outside the recorded set',
      reason: `tracked working-tree edits are not in the committed diff or the declaration: ${collectResult.extraTrackedDirt.join(
        ', ',
      )} — commit them, or declare via --changed, so the completion records the real change`,
      out_of_scope: false,
    });
  }
  if (
    collected.length === 0 &&
    !collectResult.diffErrored &&
    (item.runs.length > 0 || item.acceptance_criteria.some((a) => a.evidence.length > 0))
  ) {
    unverifiedExtras.push({
      item: 'changed_files not recorded',
      reason:
        baseUsed === null
          ? 'no base ref (--base, origin/main, origin/master, main, master) usable and work item has runs/evidence; commit the change, declare paths with --changed, or pass --base'
          : `git diff against ${baseUsed} returned no files but work item has runs/evidence; commit the change or declare paths with --changed`,
      out_of_scope: false,
    });
  }
  // collected는 git이 본 변경. handoff 자체가 만드는 산출물
  // (completion.json, work-item.json)은 collect 직후 생성되므로 첫 handoff에서는
  // git diff/status에 잡히지 않는다. 마감 산출물이 자기 changed_files를 정확히
  // 보고하도록 명시적으로 union 추가. handoff 본문은 work-item 밖
  // (.ditto/local/handoff/)으로 옮겨졌고 소비되면 archive로 이동하므로 stale 경로가
  // 되지 않도록 changed_files union에 넣지 않는다.
  const selfArtifacts = [
    `.ditto/local/work-items/${workId}/completion.json`,
    `.ditto/local/work-items/${workId}/work-item.json`,
  ];
  const merged = Array.from(new Set([...collected, ...selfArtifacts])).sort();
  const completionPath = localDir(repoRoot, 'work-items', workId, 'completion.json');
  // Tolerant prior read: a malformed / absent prior must NOT block a fresh
  // handoff. It's only used to preserve verifier-recorded fields (verifications,
  // remaining_risks, summary) that the from-scratch build would otherwise drop.
  let prior: CompletionContract | undefined;
  const priorFile = Bun.file(completionPath);
  if (await priorFile.exists()) {
    try {
      const parsed = completionContract.safeParse(JSON.parse(await priorFile.text()));
      if (parsed.success) prior = parsed.data;
    } catch {
      prior = undefined;
    }
  }
  // If an autopilot graph exists for this work item, derive the per-AC verdicts
  // from the graph (same evidence-gated source as `ditto autopilot complete`) so
  // the two completion paths AGREE — handoff cannot clobber a graph-based pass
  // with a stale work-item-AC partial. No graph → keep work-item-AC behavior.
  let graphAcceptance: Parameters<typeof buildCompletion>[6] | undefined;
  const autopilotStore = new AutopilotStore(repoRoot);
  if (await autopilotStore.exists(workId)) {
    const graph = await autopilotStore.get(workId);
    const acIds = item.acceptance_criteria.map((c) => c.id);
    // Thread each AC's oracle (ADR-0024 §3) — the SAME source as `assembleCompletionFromGraph`
    // so the two completion paths AGREE on oracle-gated verdicts (no gate↔score gap).
    const oracles = new Map(item.acceptance_criteria.map((c) => [c.id, c.oracle]));
    // Thread each AC's own criterion state so a fresh evidence-backed `ditto verify`
    // pass recorded after the run supersedes a stale node verdict — parity with
    // `assembleCompletionFromGraph` (autopilot-complete.ts), which passes this 4th
    // arg. Without it the handoff resume doc shows a staler verdict than complete.
    const criteria = new Map(item.acceptance_criteria.map((c) => [c.id, c]));
    graphAcceptance = deriveAcVerdicts(graph, acIds, oracles, criteria).map((v) => ({
      criterion_id: v.criterion_id,
      verdict: v.verdict,
      evidence: v.evidence ?? [],
      ...(v.notes ? { notes: v.notes } : {}),
    }));
  }
  const completion = buildCompletion(
    item,
    now.toISOString(),
    merged,
    options.declaredBy ?? 'main',
    unverifiedExtras,
    prior,
    graphAcceptance,
  );
  const effectiveReEntry: WorkItem['re_entry'] =
    completion.final_verdict === 'pass'
      ? undefined
      : (item.re_entry ?? {
          // wi_260708xgo: point at a REAL command — the manual handoff read — not
          // the non-existent `ditto work resume`. (Session resume itself is by
          // naming the work item id in a prompt; this hint surfaces the context.)
          command: `ditto work handoff ${item.id} --show`,
          fresh_evidence_needed: ['미pass acceptance에 대한 검증 결과'],
        });
  await writeJson(completionPath, completionContract, completion);

  // handoff 본문 → 통일 독립 store(.ditto/local/handoff/). pass면 픽업 불필요 → archive
  // 직행(active 소음 0), 비-pass면 active(다음 세션이 자동으로 읽고 archive로 옮긴다).
  const failedOrUnverified = [
    ...completion.acceptance
      .filter((a) => a.verdict !== 'pass')
      .map((a) => `${a.criterion_id} [${a.verdict}]`),
    ...completion.unverified.map(
      (u) => `${u.item} — ${u.reason}${u.out_of_scope ? ' (out_of_scope)' : ''}`,
    ),
  ];
  const handoffArtifact = buildHandoff({
    workItem: item,
    fromContext: `ditto work handoff (declared_by=${options.declaredBy ?? 'main'})`,
    currentState: `final_verdict=${completion.final_verdict}; ${completion.summary}`,
    changedFiles: merged,
    failedOrUnverified,
    ...(effectiveReEntry?.command ? { openThreads: [effectiveReEntry.command] } : {}),
    nextFirstCheck:
      effectiveReEntry?.fresh_evidence_needed?.[0] ??
      'work item과 acceptance를 재확인하고 열린 노드를 재개한다.',
    now,
  });
  const hstore = new HandoffStore(repoRoot);
  const handoffRel =
    completion.final_verdict === 'pass'
      ? await hstore.writeArchived(handoffArtifact, now)
      : await hstore.write(handoffArtifact);
  const handoffPath = join(repoRoot, handoffRel);

  // stale active sweep (wi_2606289nt): on work-done, move any active handoff past
  // the retention limit into archive so it never re-injects into an unrelated
  // session. fail-open — a sweep error must not break work done.
  try {
    await hstore.sweepStaleActive(now);
  } catch {
    // observational; never blocks completion
  }

  // changed_files/status/re_entry 갱신. handoff_path는 위 store가 이미 링크했으므로
  // 여기서 건드리지 않는다(...rest로 보존).
  if (completion.final_verdict === 'pass') {
    // D1 terminal chokepoint (ac-5): route the terminal (done) transition through the
    // SINGLE R1 chokepoint (store.close) instead of a direct `status:'done'` write.
    // close() reduces-then-checks and THROWS if the WI already raced to a DIFFERENT
    // terminal (e.g. user `work abandon`) — the silent-overwrite guard the old direct
    // write bypassed. first-terminal-wins for the truly concurrent case is guaranteed
    // by reduceWorkItem (n2), not re-implemented here. An already-`done` WI is the
    // idempotent re-handoff case: close() would reject a same-terminal re-close, so
    // skip it and only refresh the non-status fields below.
    const current = await store.get(workId);
    if (current.status !== 'done') {
      await store.close(workId, 'done', now);
    }
    // Non-status fields only (changed_files) + drop any stale re_entry (pass 시점에는
    // resume 지시를 남기지 않는다). This update keeps status=done, so no status event is
    // emitted — close() alone owns the terminal transition.
    await store.update(workId, (cur) => {
      const { re_entry: _existingReEntry, ...rest } = cur;
      return { ...rest, changed_files: merged };
    });
  } else {
    // partial은 NON-terminal (re-entry 마커일 뿐 terminal 이벤트가 아니다) → 평범한
    // update; R1 관심사 없음. 더는 직접 terminal write로 경쟁하지 않는다.
    await store.update(workId, (cur) => {
      const { re_entry: _existingReEntry, ...rest } = cur;
      return {
        ...rest,
        changed_files: merged,
        status: 'partial' as const,
        re_entry: effectiveReEntry,
      };
    });
  }
  return { completion, completionPath, handoffPath, collectedChangedFiles: merged, baseUsed };
}
