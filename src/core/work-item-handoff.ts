import { join } from 'node:path';
import { type CompletionContract, completionContract } from '~/schemas/completion-contract';
import type { WorkItem } from '~/schemas/work-item';
import { atomicWriteText, writeJson } from './fs';
import type { WorkItemStore } from './work-item-store';

export interface HandoffResult {
  completion: CompletionContract;
  completionPath: string;
  handoffPath: string;
}

function buildCompletion(item: WorkItem, declaredAt: string): CompletionContract {
  const acceptance = item.acceptance_criteria.map((ac) => ({
    criterion_id: ac.id,
    verdict: ac.verdict,
    evidence: ac.evidence,
  }));
  const allPass = acceptance.every((a) => a.verdict === 'pass');
  const final = allPass ? ('pass' as const) : ('partial' as const);
  const handoffPath = `.ditto/work-items/${item.id}/handoff.md`;
  const base = {
    schema_version: '0.1.0' as const,
    work_item_id: item.id,
    declared_by: item.owner_profile,
    declared_at: declaredAt,
    summary: allPass
      ? `${item.title} — 모든 acceptance criterion이 pass로 기록되었다.`
      : `${item.title} — 일부 acceptance criterion이 비-pass 상태로 partial 핸드오프된다.`,
    changed_files: item.changed_files,
    acceptance,
    verifications: [],
    unverified: [],
    remaining_risks: item.risks.map((r) => r.description),
    final_verdict: final,
    next_handoff_path: handoffPath,
  };
  // completionContract.parse는 default/superRefine을 적용한 output을 반환
  return completionContract.parse(base);
}

function renderHandoffMarkdown(item: WorkItem, completion: CompletionContract): string {
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
  lines.push('## 다음 fresh evidence');
  if (item.re_entry?.fresh_evidence_needed && item.re_entry.fresh_evidence_needed.length > 0) {
    for (const e of item.re_entry.fresh_evidence_needed) {
      lines.push(`- ${e}`);
    }
  } else {
    lines.push('- (없음)');
  }
  lines.push('');
  lines.push('## 다음 명령');
  if (item.re_entry?.command) {
    lines.push(`\`${item.re_entry.command}\``);
  } else {
    lines.push('- (없음)');
  }
  lines.push('');
  return lines.join('\n');
}

export async function writeWorkItemHandoff(
  repoRoot: string,
  store: WorkItemStore,
  workId: string,
  now: Date = new Date(),
): Promise<HandoffResult> {
  const item = await store.get(workId);
  const completion = buildCompletion(item, now.toISOString());
  const completionPath = join(repoRoot, '.ditto', 'work-items', workId, 'completion.json');
  await writeJson(completionPath, completionContract, completion);
  const handoffPath = join(repoRoot, '.ditto', 'work-items', workId, 'handoff.md');
  await atomicWriteText(handoffPath, renderHandoffMarkdown(item, completion));
  await store.update(workId, (cur) => ({
    ...cur,
    handoff_path: `.ditto/work-items/${cur.id}/handoff.md`,
    status: completion.final_verdict === 'pass' ? 'done' : 'partial',
    ...(completion.final_verdict === 'pass'
      ? {}
      : {
          re_entry: cur.re_entry ?? {
            command: `ditto work resume ${cur.id}`,
            fresh_evidence_needed: ['미pass acceptance에 대한 검증 결과'],
          },
        }),
  }));
  return { completion, completionPath, handoffPath };
}
