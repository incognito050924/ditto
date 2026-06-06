import { readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { z } from 'zod';
import type { evidenceRef } from '~/schemas/common';
import { type Handoff, handoff as handoffSchema } from '~/schemas/handoff';
import type { WorkItem } from '~/schemas/work-item';
import { atomicWriteText, ensureDir } from './fs';
import { WorkItemStore } from './work-item-store';

type EvidenceRef = z.infer<typeof evidenceRef>;

/**
 * Handoff artifact builder + store (M4.1, wi_260605wf3 통일).
 *
 * 단일 독립 store. 이전엔 두 갈래가 따로 존재했다 — pre-compact 훅의 json
 * (`HandoffStore`) 과 `ditto work handoff` 의 md (`writeWorkItemHandoff`). 둘 다
 * `.ditto/work-items/<wi>/` 에 종속이었다. 이제 둘 다 이 store 로 모이고, 위치는
 * work-item 밖의 `.ditto/handoff/` 다.
 *
 *  - active:  `.ditto/handoff/<wi>.md`           — 다음 세션이 자동으로 읽고(소비) archive 로 옮김
 *  - archive: `.ditto/handoff/archive/<wi>__<ts>.md` — 소비됨 / 픽업 불필요한 완료 handoff
 *
 * 형식 = 1줄 JSON frontmatter(기계 복원용) + 사람용 markdown 본문. frontmatter 로
 * round-trip(write→read 동일 객체)이 보장되고, 본문은 UserPromptSubmit 이 컨텍스트로
 * 주입한다. Evidence 는 본문에 inline 으로 렌더되며 raw artifact 는 절대 옮기지 않는다.
 */
export interface HandoffBuildInput {
  workItem: WorkItem;
  fromContext: string;
  currentState: string;
  nextFirstCheck: string;
  autopilotId?: string;
  toOwner?: string;
  decisionsMade?: string[];
  evidenceRefs?: EvidenceRef[];
  failedOrUnverified?: string[];
  openThreads?: string[];
  forbiddenScopeCreep?: string[];
  artifactAvailable?: boolean;
  changedFiles?: string[];
  now?: Date;
}

export function buildHandoff(input: HandoffBuildInput): Handoff {
  return handoffSchema.parse({
    schema_version: '0.1.0',
    work_item_id: input.workItem.id,
    ...(input.autopilotId ? { autopilot_id: input.autopilotId } : {}),
    from_context: input.fromContext,
    ...(input.toOwner ? { to_owner: input.toOwner } : {}),
    original_intent: input.workItem.source_request,
    current_state: input.currentState,
    decisions_made: input.decisionsMade ?? [],
    changed_files: input.changedFiles ?? input.workItem.changed_files,
    evidence_refs: input.evidenceRefs ?? [],
    failed_or_unverified: input.failedOrUnverified ?? [],
    open_threads: input.openThreads ?? [],
    next_first_check: input.nextFirstCheck,
    forbidden_scope_creep: input.forbiddenScopeCreep ?? [],
    artifact_available: input.artifactAvailable ?? true,
    created_at: (input.now ?? new Date()).toISOString(),
  });
}

/** Render a Handoff to its human-readable markdown body (the part injected next session). */
export function renderHandoff(h: Handoff): string {
  const lines: string[] = [];
  lines.push(`# Handoff: ${h.work_item_id}`);
  if (h.autopilot_id) lines.push(`autopilot: ${h.autopilot_id}`);
  lines.push('', `from: ${h.from_context}`, '');
  lines.push('## 원래 의도');
  lines.push(h.original_intent, '');
  lines.push('## 현재 상태');
  lines.push(h.current_state, '');
  if (h.decisions_made.length > 0) {
    lines.push('## 내려진 결정');
    for (const d of h.decisions_made) lines.push(`- ${d}`);
    lines.push('');
  }
  if (h.changed_files.length > 0) {
    lines.push('## 변경 파일');
    for (const f of h.changed_files) lines.push(`- ${f}`);
    lines.push('');
  }
  if (h.evidence_refs.length > 0) {
    lines.push('## 증거 (inline)');
    for (const e of h.evidence_refs) lines.push(`- ${JSON.stringify(e)}`);
    lines.push('');
  }
  if (h.failed_or_unverified.length > 0) {
    lines.push('## 실패 / 미검증');
    for (const u of h.failed_or_unverified) lines.push(`- ${u}`);
    lines.push('');
  }
  if (h.open_threads.length > 0) {
    lines.push('## 열린 스레드');
    for (const t of h.open_threads) lines.push(`- ${t}`);
    lines.push('');
  }
  lines.push('## 다음 agent 가 가장 먼저 볼 것');
  lines.push(h.next_first_check, '');
  if (h.forbidden_scope_creep.length > 0) {
    lines.push('## 금지: scope creep');
    for (const s of h.forbidden_scope_creep) lines.push(`- ${s}`);
    lines.push('');
  }
  if (!h.artifact_available) {
    lines.push('⚠ raw artifacts 가 이 클론/세션에 없다 — 인라인 요약만 신뢰할 것.', '');
  }
  return lines.join('\n').trimEnd();
}

function serialize(h: Handoff): string {
  return `---\n${JSON.stringify(h)}\n---\n\n${renderHandoff(h)}\n`;
}

/** Parse a serialized handoff file back into its Handoff + human body. */
export function parseHandoffFile(text: string): { handoff: Handoff; body: string } {
  if (!text.startsWith('---\n')) {
    throw new Error('handoff file: missing leading frontmatter fence');
  }
  const rest = text.slice(4);
  const end = rest.indexOf('\n---');
  if (end === -1) throw new Error('handoff file: unterminated frontmatter');
  const handoff = handoffSchema.parse(JSON.parse(rest.slice(0, end)));
  const body = rest.slice(end + 4).replace(/^\n+/, '');
  return { handoff, body };
}

export interface ActiveHandoff {
  handoff: Handoff;
  body: string;
  path: string;
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

export class HandoffStore {
  constructor(public readonly repoRoot: string) {}

  private dir(): string {
    return join(this.repoRoot, '.ditto', 'handoff');
  }
  private activePath(workItemId: string): string {
    return join(this.dir(), `${workItemId}.md`);
  }
  private activeRel(workItemId: string): string {
    return `.ditto/handoff/${workItemId}.md`;
  }
  private archiveRel(workItemId: string, ts: string): string {
    return `.ditto/handoff/archive/${workItemId}__${ts}.md`;
  }

  private async link(workItemId: string, rel: string): Promise<void> {
    const items = new WorkItemStore(this.repoRoot);
    if (await items.exists(workItemId)) {
      await items.update(workItemId, (current) => ({ ...current, handoff_path: rel }));
    }
  }

  /**
   * Write an ACTIVE handoff (compaction / explicit `ditto work handoff` on a
   * non-pass item). The next session auto-reads it and archives it (consume).
   * Returns the repo-relative path it was written to.
   */
  async write(h: Handoff): Promise<string> {
    await atomicWriteText(this.activePath(h.work_item_id), serialize(h));
    const rel = this.activeRel(h.work_item_id);
    await this.link(h.work_item_id, rel);
    return rel;
  }

  /**
   * Write straight to ARCHIVE — a completed (pass) handoff that needs no pickup,
   * so it never appears as active noise. Returns the repo-relative path.
   */
  async writeArchived(h: Handoff, now: Date = new Date()): Promise<string> {
    const rel = this.archiveRel(h.work_item_id, stamp(now));
    await atomicWriteText(join(this.repoRoot, rel), serialize(h));
    await this.link(h.work_item_id, rel);
    return rel;
  }

  /** Every active handoff currently waiting to be picked up (oldest first). */
  async listActive(): Promise<ActiveHandoff[]> {
    let names: string[];
    try {
      names = await readdir(this.dir());
    } catch {
      return []; // no handoff dir yet
    }
    const out: ActiveHandoff[] = [];
    for (const name of names) {
      if (!name.endsWith('.md')) continue; // skip the archive/ subdir and stray files
      const path = join(this.dir(), name);
      try {
        const { handoff, body } = parseHandoffFile(await Bun.file(path).text());
        out.push({ handoff, body, path });
      } catch {
        // malformed active handoff → skip, never break the reader (fail-open)
      }
    }
    return out.sort((a, b) => a.handoff.created_at.localeCompare(b.handoff.created_at));
  }

  /**
   * Move every active handoff into archive and return what was consumed. Called
   * by UserPromptSubmit after injecting the bodies — so a handoff is picked up
   * exactly once and `active` never accumulates.
   */
  async consume(now: Date = new Date()): Promise<ActiveHandoff[]> {
    const active = await this.listActive();
    if (active.length === 0) return [];
    await ensureDir(join(this.dir(), 'archive'));
    for (const a of active) {
      const dest = join(this.repoRoot, this.archiveRel(a.handoff.work_item_id, stamp(now)));
      try {
        await rename(a.path, dest);
      } catch {
        // best-effort: a failed move just leaves it active for the next turn
      }
    }
    return active;
  }

  /** Whether an active handoff exists for this work item. */
  async exists(workItemId: string): Promise<boolean> {
    return Bun.file(this.activePath(workItemId)).exists();
  }

  /** Read the active handoff for this work item (throws if none). */
  async get(workItemId: string): Promise<Handoff> {
    return parseHandoffFile(await Bun.file(this.activePath(workItemId)).text()).handoff;
  }
}
