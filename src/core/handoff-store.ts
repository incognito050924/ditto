import { readdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { z } from 'zod';
import type { evidenceRef } from '~/schemas/common';
import { type Handoff, handoff as handoffSchema } from '~/schemas/handoff';
import type { WorkItem } from '~/schemas/work-item';
import { localDir } from './ditto-paths';
import { atomicWriteText, ensureDir } from './fs';
import { WorkItemStore } from './work-item-store';

type EvidenceRef = z.infer<typeof evidenceRef>;

/**
 * Handoff artifact builder + store (M4.1, wi_260605wf3 통일).
 *
 * 단일 독립 store. 이전엔 두 갈래가 따로 존재했다 — pre-compact 훅의 json
 * (`HandoffStore`) 과 `ditto work handoff` 의 md (`writeWorkItemHandoff`). 둘 다
 * `.ditto/local/work-items/<wi>/` 에 종속이었다. 이제 둘 다 이 store 로 모이고, 위치는
 * work-item 밖의 `.ditto/local/handoff/` 다.
 *
 *  - active:  `.ditto/local/handoff/<wi>.md`           — 다음 세션이 자동으로 읽고(소비) archive 로 옮김
 *  - archive: `.ditto/local/handoff/archive/<wi>__<ts>.md` — 소비됨 / 픽업 불필요한 완료 handoff
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
  criticalDecisions?: { decision: string; rationale: string }[];
  irreversibleRisks?: { risk: string; why_irreversible: string }[];
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
    // ac-6: re-fetch-impossible substance preserved INLINE (tier rule).
    critical_decisions: input.criticalDecisions ?? [],
    irreversible_risks: input.irreversibleRisks ?? [],
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
  if (h.critical_decisions.length > 0) {
    lines.push('## 핵심 결정 (재호출 불가)');
    for (const d of h.critical_decisions) lines.push(`- ${d.decision} — ${d.rationale}`);
    lines.push('');
  }
  if (h.irreversible_risks.length > 0) {
    lines.push('## 비가역 위험');
    for (const r of h.irreversible_risks) lines.push(`- ${r.risk} — ${r.why_irreversible}`);
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

/**
 * One entry moved by the content-blind stale sweep. `handoff` is present only
 * when the file was schema-valid; a malformed / non-WI file is still swept by
 * age (mtime) but carries no parsed handoff (null).
 */
export interface SweptHandoff {
  /** the active path that was archived (no longer present in active/) */
  path: string;
  /** repo-relative archive destination the file was moved to */
  archivePath: string;
  /** parsed handoff when the file was valid; null for malformed / non-WI files */
  handoff: Handoff | null;
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

/** Active handoffs older than this are swept into archive (move-not-delete). */
const STALE_ACTIVE_RETENTION_DAYS = 7;
const STALE_ACTIVE_RETENTION_MS = STALE_ACTIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export class HandoffStore {
  constructor(public readonly repoRoot: string) {}

  private dir(): string {
    return localDir(this.repoRoot, 'handoff');
  }
  private activePath(workItemId: string): string {
    return join(this.dir(), `${workItemId}.md`);
  }
  private activeRel(workItemId: string): string {
    return `.ditto/local/handoff/${workItemId}.md`;
  }
  private archiveRel(workItemId: string, ts: string): string {
    return `.ditto/local/handoff/archive/${workItemId}__${ts}.md`;
  }
  /**
   * Archive destination for a file we can't parse into a work_item_id: derive
   * the name from the file's own basename stem so nothing is lost and the
   * `stamp(now)` suffix keeps it collision-free (WS-HND-T1).
   */
  private archiveRelFromBasename(name: string, ts: string): string {
    const stem = name.replace(/\.md$/, '');
    return `.ditto/local/handoff/archive/${stem}__${ts}.md`;
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

  /**
   * The active handoff for this work item (body + path), or null when none /
   * malformed. The scoped counterpart of listActive — used so a session picks up
   * ONLY its own work item's handoff (ac-1, wi_260626r3f).
   */
  async getActive(workItemId: string): Promise<ActiveHandoff | null> {
    const path = this.activePath(workItemId);
    try {
      const { handoff, body } = parseHandoffFile(await Bun.file(path).text());
      return { handoff, body, path };
    } catch {
      return null; // missing or malformed → nothing to pick up (fail-open)
    }
  }

  /**
   * The latest handoff for this work item for MANUAL reading (wi_260708xgo,
   * `ditto work handoff <id> --show`) — the active handoff if present, else the
   * most recent archived copy, else null. Read-only: unlike consumeFor it never
   * moves or deletes anything, so `--show` can be run repeatedly.
   */
  async readLatest(workItemId: string): Promise<ActiveHandoff | null> {
    const active = await this.getActive(workItemId);
    if (active) return active;
    const archiveDir = join(this.dir(), 'archive');
    let names: string[];
    try {
      names = await readdir(archiveDir);
    } catch {
      return null; // no archive dir → nothing
    }
    const prefix = `${workItemId}__`;
    // Archive names are `<wi>__<stamp>.md`; the stamp sorts lexically, so the
    // last entry is the most recent archived handoff.
    const latest = names
      .filter((n) => n.startsWith(prefix) && n.endsWith('.md'))
      .sort()
      .at(-1);
    if (!latest) return null;
    try {
      const { handoff, body } = parseHandoffFile(await Bun.file(join(archiveDir, latest)).text());
      return { handoff, body, path: `.ditto/local/handoff/archive/${latest}` };
    } catch {
      return null; // malformed archived file → nothing to show (fail-open)
    }
  }

  /**
   * Move JUST this work item's active handoff into archive and return it (or
   * null when there is none). The scoped counterpart of consume — a concurrent
   * worktree session sharing this .ditto/local must never archive a sibling's
   * handoff (ac-1, wi_260626r3f).
   */
  async consumeFor(workItemId: string, now: Date = new Date()): Promise<ActiveHandoff | null> {
    const active = await this.getActive(workItemId);
    if (active === null) return null;
    await ensureDir(join(this.dir(), 'archive'));
    const dest = join(this.repoRoot, this.archiveRel(workItemId, stamp(now)));
    try {
      await rename(active.path, dest);
    } catch {
      // best-effort: a failed move just leaves it active for the next turn
    }
    return active;
  }

  /**
   * Sweep stale active handoffs into archive (MOVE, never delete). An active
   * file older than STALE_ACTIVE_RETENTION_DAYS that no session ever picked up
   * would otherwise re-inject into an unrelated session's context forever;
   * moving it into archive/ (which listActive excludes) stops that injection
   * while preserving the artifact.
   *
   * CONTENT-BLIND (WS-HND-T1): the sweep iterates the active-dir `.md` files
   * directly and decides staleness by the filesystem mtime — NOT the parsed
   * created_at. A malformed / non-WI hand-authored file (which listActive skips,
   * fail-open) therefore still retires by age; a valid handoff keeps the
   * `<work_item_id>__<ts>` archive scheme, a malformed one is archived under its
   * own basename stem so nothing is lost. Best-effort, fail-open like consume():
   * a failed stat/rename just leaves the file active for a later turn — never
   * throws. Returns what was swept.
   */
  async sweepStaleActive(now: Date = new Date()): Promise<SweptHandoff[]> {
    const dir = this.dir();
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return []; // no handoff dir yet
    }
    const swept: SweptHandoff[] = [];
    let ensured = false;
    for (const name of names) {
      if (!name.endsWith('.md')) continue; // skip the archive/ subdir and stray files
      const path = join(dir, name);
      let mtimeMs: number;
      try {
        mtimeMs = (await stat(path)).mtimeMs;
      } catch {
        continue; // can't stat → skip (fail-open)
      }
      if (now.getTime() - mtimeMs <= STALE_ACTIVE_RETENTION_MS) continue; // within limit → stays active
      // Parse is best-effort: it only picks the archive name; a parse-failure
      // does NOT exempt the file from the age sweep (that was the old bug).
      let handoff: Handoff | null = null;
      try {
        handoff = parseHandoffFile(await Bun.file(path).text()).handoff;
      } catch {
        handoff = null;
      }
      const archivePath = handoff
        ? this.archiveRel(handoff.work_item_id, stamp(now))
        : this.archiveRelFromBasename(name, stamp(now));
      if (!ensured) {
        await ensureDir(join(dir, 'archive'));
        ensured = true;
      }
      try {
        await rename(path, join(this.repoRoot, archivePath));
        swept.push({ path, archivePath, handoff });
      } catch {
        // best-effort: a failed move just leaves it active for the next turn
      }
    }
    return swept;
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
