import { join } from 'node:path';
import { type CompletionContract, completionContract } from '~/schemas/completion-contract';
import type { WorkItem } from '~/schemas/work-item';
import { atomicWriteText, writeJson } from './fs';
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
}

/**
 * Try a list of refs in order and return the first one git understands.
 * Returns null when none are valid.
 */
function pickBaseRef(repoRoot: string, candidates: string[]): string | null {
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

/**
 * Collect changed files relative to `base` using `git diff --name-only base...HEAD`
 * and `git status --porcelain` (for uncommitted changes). Returns repo-relative
 * paths with duplicates removed.
 */
function collectChangedFiles(repoRoot: string, base: string | null): string[] {
  const set = new Set<string>();
  if (base !== null) {
    const diff = Bun.spawnSync(
      ['git', 'diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`],
      { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' },
    );
    if (diff.exitCode === 0) {
      const text = diff.stdout?.toString() ?? '';
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (t.length > 0) set.add(t);
      }
    }
  }
  const status = Bun.spawnSync(['git', 'status', '--porcelain'], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (status.exitCode === 0) {
    const text = status.stdout?.toString() ?? '';
    for (const line of text.split('\n')) {
      // porcelain line format: XY <path>  or  XY <orig> -> <new>
      const trimmed = line.replace(/^..\s*/, '').trim();
      if (trimmed.length === 0) continue;
      const arrow = trimmed.indexOf(' -> ');
      const path = arrow === -1 ? trimmed : trimmed.slice(arrow + 4);
      set.add(path);
    }
  }
  // Filter out paths that escape the repo or are absolute
  return Array.from(set).filter((p) => !p.startsWith('/') && !p.includes('..'));
}

function buildCompletion(
  item: WorkItem,
  declaredAt: string,
  changedFiles: string[],
  unverifiedExtras: { item: string; reason: string; out_of_scope: boolean }[] = [],
): CompletionContract {
  const acceptance = item.acceptance_criteria.map((ac) => ({
    criterion_id: ac.id,
    verdict: ac.verdict,
    evidence: ac.evidence,
  }));
  const allPass = acceptance.every((a) => a.verdict === 'pass');
  const blockedByUnverified = unverifiedExtras.some((u) => !u.out_of_scope);
  const final = allPass && !blockedByUnverified ? ('pass' as const) : ('partial' as const);
  const handoffPath = `.ditto/work-items/${item.id}/handoff.md`;
  const base = {
    schema_version: '0.1.0' as const,
    work_item_id: item.id,
    declared_by: item.owner_profile,
    declared_at: declaredAt,
    summary: allPass
      ? `${item.title} — 모든 acceptance criterion이 pass로 기록되었다.`
      : `${item.title} — 일부 acceptance criterion이 비-pass 상태로 partial 핸드오프된다.`,
    changed_files: changedFiles,
    acceptance,
    verifications: [],
    unverified: unverifiedExtras,
    remaining_risks: item.risks.map((r) => r.description),
    final_verdict: final,
    next_handoff_path: handoffPath,
  };
  // completionContract.parse는 default/superRefine을 적용한 output을 반환
  return completionContract.parse(base);
}

function renderHandoffMarkdown(
  item: WorkItem,
  completion: CompletionContract,
  effectiveReEntry: WorkItem['re_entry'],
): string {
  const lines: string[] = [];
  lines.push(`# Handoff: ${item.id}`);
  lines.push('');
  lines.push('## 최종 verdict');
  lines.push(completion.final_verdict);
  lines.push('');
  lines.push('## acceptance');
  for (const ac of completion.acceptance) {
    lines.push(`- ${ac.criterion_id} [${ac.verdict}]`);
  }
  lines.push('');
  lines.push('## 무엇이 끝났나');
  lines.push(completion.summary);
  lines.push('');
  if (completion.changed_files.length > 0) {
    lines.push('## 변경 파일');
    for (const f of completion.changed_files) {
      lines.push(`- ${f}`);
    }
    lines.push('');
  }
  if (completion.unverified.length > 0) {
    lines.push('## unverified');
    for (const u of completion.unverified) {
      lines.push(`- ${u.item} — ${u.reason}${u.out_of_scope ? ' (out_of_scope)' : ''}`);
    }
    lines.push('');
  }
  if (completion.remaining_risks.length > 0) {
    lines.push('## remaining risks');
    for (const r of completion.remaining_risks) {
      lines.push(`- ${r}`);
    }
    lines.push('');
  }
  // pass 상태에서는 resume 지시를 렌더링하지 않는다. 완료된 work item에
  // "다음 명령"이 남아 있으면 다음 agent가 상태를 잘못 판단할 수 있다.
  if (completion.final_verdict !== 'pass') {
    lines.push('## 다음 fresh evidence');
    if (
      effectiveReEntry?.fresh_evidence_needed &&
      effectiveReEntry.fresh_evidence_needed.length > 0
    ) {
      for (const e of effectiveReEntry.fresh_evidence_needed) {
        lines.push(`- ${e}`);
      }
    } else {
      lines.push('- (없음)');
    }
    lines.push('');
    lines.push('## 다음 명령');
    if (effectiveReEntry?.command) {
      lines.push(`\`${effectiveReEntry.command}\``);
    } else {
      lines.push('- (없음)');
    }
    lines.push('');
  }
  return lines.join('\n');
}

export async function writeWorkItemHandoff(
  repoRoot: string,
  store: WorkItemStore,
  workId: string,
  options: HandoffOptions = {},
  now: Date = new Date(),
): Promise<HandoffResult> {
  const item = await store.get(workId);
  const baseCandidates = options.base
    ? [options.base]
    : ['origin/main', 'origin/master', 'main', 'master'];
  const baseUsed = pickBaseRef(repoRoot, baseCandidates);
  const collected = collectChangedFiles(repoRoot, baseUsed);
  // 기존 item.changed_files와 git에서 수집한 파일의 합집합
  const merged = Array.from(new Set([...item.changed_files, ...collected]));
  const unverifiedExtras: { item: string; reason: string; out_of_scope: boolean }[] = [];
  if (
    merged.length === 0 &&
    (item.runs.length > 0 || item.acceptance_criteria.some((a) => a.evidence.length > 0))
  ) {
    unverifiedExtras.push({
      item: 'changed_files not recorded',
      reason:
        baseUsed === null
          ? 'no base ref (--base, origin/main, origin/master, main, master) usable and work item has runs/evidence; fill manually or pass --base'
          : `git diff against ${baseUsed} returned no files but work item has runs/evidence`,
      out_of_scope: false,
    });
  }
  const completion = buildCompletion(item, now.toISOString(), merged, unverifiedExtras);
  const effectiveReEntry: WorkItem['re_entry'] =
    completion.final_verdict === 'pass'
      ? undefined
      : (item.re_entry ?? {
          command: `ditto work resume ${item.id}`,
          fresh_evidence_needed: ['미pass acceptance에 대한 검증 결과'],
        });
  const completionPath = join(repoRoot, '.ditto', 'work-items', workId, 'completion.json');
  await writeJson(completionPath, completionContract, completion);
  const handoffPath = join(repoRoot, '.ditto', 'work-items', workId, 'handoff.md');
  await atomicWriteText(handoffPath, renderHandoffMarkdown(item, completion, effectiveReEntry));
  await store.update(workId, (cur) => {
    const { re_entry: _existingReEntry, ...rest } = cur;
    if (completion.final_verdict === 'pass') {
      // pass 시점에는 resume 지시를 남기지 않는다 (stale handoff 방지).
      return {
        ...rest,
        handoff_path: `.ditto/work-items/${cur.id}/handoff.md`,
        changed_files: merged,
        status: 'done' as const,
        closed_at: now.toISOString(),
      };
    }
    return {
      ...rest,
      handoff_path: `.ditto/work-items/${cur.id}/handoff.md`,
      changed_files: merged,
      status: 'partial' as const,
      re_entry: effectiveReEntry,
    };
  });
  return { completion, completionPath, handoffPath, collectedChangedFiles: merged, baseUsed };
}
