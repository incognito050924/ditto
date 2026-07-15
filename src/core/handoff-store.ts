import { readdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { z } from 'zod';
import type { evidenceRef } from '~/schemas/common';
import { type Handoff, type HandoffScope, handoff as handoffSchema } from '~/schemas/handoff';
import type { WorkItem } from '~/schemas/work-item';
import { dittoDir, localDir } from './ditto-paths';
import { atomicWriteText, ensureDir } from './fs';
import { scrubTokens } from './github-redaction';
import { WorkItemStore } from './work-item-store';

type EvidenceRef = z.infer<typeof evidenceRef>;

/**
 * Handoff artifact builder + store (M4.1, wi_260605wf3 통일; scope union wi_260714xpw).
 *
 * 단일 독립 store. 이전엔 두 갈래가 따로 존재했다 — pre-compact 훅의 json
 * (`HandoffStore`) 과 `ditto work handoff` 의 md (`writeWorkItemHandoff`). 둘 다
 * `.ditto/local/work-items/<wi>/` 에 종속이었다. 이제 둘 다 이 store 로 모이고, 위치는
 * work-item 밖이다.
 *
 * 두 계층(tier):
 *  - LOCAL (gitignored, `.ditto/local/handoff/`): 개인 런타임. work_item 은
 *    `<wi>.md`, session 은 `session__<sid>.md`. age-sweep 이 유일한 hard 정리.
 *  - REMOTE (committed, `.ditto/handoff/`): 작업 브랜치에 커밋되어 fetch/checkout
 *    수신자에게 함께 전달된다. 파일명은 scope-key + author-slug 라 동시 작성자가 서로
 *    다른 파일로 분리된다(공유 단일 파일 없음). 절대 auto-push 하지 않는다.
 *
 * 형식 = 1줄 JSON frontmatter(기계 복원용) + 사람용 markdown 본문. frontmatter 로
 * round-trip(write→read 동일 객체)이 보장되고, 본문은 명시적 consume 으로만 로드된다
 * (어떤 훅도 본문을 컨텍스트에 자동 주입하지 않는다). Evidence 는 본문에 inline 으로
 * 렌더되며 raw artifact 는 절대 옮기지 않는다.
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
  // wi_2607148yg (ac-4/ac-9): marks this as a fail / condition-(b) BLOCKED handoff
  // — a direction-reversal / 진행불가 or a 보안·시스템·프로젝트·기능설계-의도 decision
  // that autopilot must NOT auto-drive. This is the blocked-handoff DISCRIMINATOR:
  // when true, `userDecisionBlock` MUST be non-empty (guardBlockedHandoffDecision),
  // so a blocked handoff hands off a decision to MAKE, not just a dead end. It is a
  // build-time input, NOT a persisted field — the handoff schema stays statusless so
  // a legacy on-disk handoff (which never runs through buildHandoff) is never
  // retro-rejected. Absent/false ⇒ a normal pass/partial handoff, no requirement.
  blocked?: boolean;
  // The concrete decision(s) the user must make: each option set + the agent's
  // CURRENT interpretation/lean. Rendered as a distinct block by renderHandoff.
  userDecisionBlock?: { decision: string; options: string[]; agent_interpretation: string }[];
  now?: Date;
}

/**
 * Thrown when a BLOCKED (fail / condition-(b)) handoff is built without a
 * user_decision_block. A blocked handoff whose only content is a dead end pushes
 * the procedural decision back on the user with nothing to act on; the guard
 * forces the concrete options + the agent's current interpretation to be present.
 */
export class BlockedHandoffMissingDecisionError extends Error {
  constructor() {
    super(
      'blocked (fail / condition-(b)) handoff requires a non-empty user_decision_block — surface the concrete options + the agent current interpretation, not just a dead end',
    );
    this.name = 'BlockedHandoffMissingDecisionError';
  }
}

/**
 * ac-9 required-WHEN-blocked guard. Mirrors the conditional-require precedent
 * (completion-contract `non_pass_status` → the gate): the persisted schema keeps
 * `user_decision_block` additive/optional (`.default([])`) so a legacy on-disk
 * handoff parses unchanged, and the "required when blocked" check lives here at
 * BUILD time keyed on the `blocked` discriminator — it therefore rejects only a
 * NEW blocked handoff and never retro-rejects a handoff that predates the field.
 */
function guardBlockedHandoffDecision(input: HandoffBuildInput): void {
  if (input.blocked && (input.userDecisionBlock?.length ?? 0) === 0) {
    throw new BlockedHandoffMissingDecisionError();
  }
}

export function buildHandoff(input: HandoffBuildInput): Handoff {
  guardBlockedHandoffDecision(input);
  return handoffSchema.parse({
    schema_version: '0.1.0',
    // work_item scope: the historical shape, now nested under the discriminated
    // union. Callers keep passing `{workItem}` — the scope is derived here so the
    // signature is unchanged (pre-compact.ts, work-item-handoff.ts stay callable).
    scope: { kind: 'work_item', work_item_id: input.workItem.id },
    ...(input.autopilotId ? { autopilot_id: input.autopilotId } : {}),
    from_context: input.fromContext,
    ...(input.toOwner ? { to_owner: input.toOwner } : {}),
    original_intent: input.workItem.source_request,
    current_state: input.currentState,
    decisions_made: input.decisionsMade ?? [],
    // ac-6: re-fetch-impossible substance preserved INLINE (tier rule).
    critical_decisions: input.criticalDecisions ?? [],
    irreversible_risks: input.irreversibleRisks ?? [],
    user_decision_block: input.userDecisionBlock ?? [],
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

/**
 * A SESSION-scoped handoff (not tied to any work item) — the additive new entry
 * for `ditto handoff` with no work item. Its required key is `session_id`; there
 * is no `original_intent` from a work item, so the caller states it directly.
 */
export interface SessionHandoffBuildInput {
  sessionId: string;
  originalIntent: string;
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

export function buildSessionHandoff(input: SessionHandoffBuildInput): Handoff {
  return handoffSchema.parse({
    schema_version: '0.1.0',
    scope: { kind: 'session', session_id: input.sessionId },
    ...(input.autopilotId ? { autopilot_id: input.autopilotId } : {}),
    from_context: input.fromContext,
    ...(input.toOwner ? { to_owner: input.toOwner } : {}),
    original_intent: input.originalIntent,
    current_state: input.currentState,
    decisions_made: input.decisionsMade ?? [],
    critical_decisions: input.criticalDecisions ?? [],
    irreversible_risks: input.irreversibleRisks ?? [],
    changed_files: input.changedFiles ?? [],
    evidence_refs: input.evidenceRefs ?? [],
    failed_or_unverified: input.failedOrUnverified ?? [],
    open_threads: input.openThreads ?? [],
    next_first_check: input.nextFirstCheck,
    forbidden_scope_creep: input.forbiddenScopeCreep ?? [],
    artifact_available: input.artifactAvailable ?? true,
    created_at: (input.now ?? new Date()).toISOString(),
  });
}

/** The routing/archive key for a scope — its work_item_id or session_id. */
export function scopeKey(scope: HandoffScope): string {
  return scope.kind === 'work_item' ? scope.work_item_id : scope.session_id;
}

/**
 * Reject a key component BEFORE it reaches an fs path or a git argument. The old
 * store leaned entirely on `work_item_id` being regex-locked (common.ts); the new
 * scope keys (session_id) and the author-slug have no such guard yet reach
 * `join(dir, …)` and (for remote) `git add <path>`. Reject empty, a leading `-`
 * (git option injection), a path separator, `..`, or a NUL byte.
 */
function assertSafeKey(value: string, label: string): void {
  if (value.length === 0) throw new Error(`handoff ${label} must not be empty`);
  if (value.startsWith('-')) throw new Error(`handoff ${label} must not start with '-': ${value}`);
  if (/[\\/]/.test(value))
    throw new Error(`handoff ${label} must not contain a path separator: ${value}`);
  if (value.includes('..')) throw new Error(`handoff ${label} must not contain '..': ${value}`);
  if ([...value].some((c) => c.charCodeAt(0) === 0))
    throw new Error(`handoff ${label} must not contain a NUL byte`);
}

/**
 * A filesystem/git-safe author slug: lowercased, non-`[a-z0-9]` runs collapsed to a
 * single `-`, leading/trailing `-` trimmed. Derived from a git identity so two
 * concurrent authors on the SAME scope land in separate files (ac-1). Pure.
 */
export function slugifyAuthor(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The author-slug for handoff routing, derived from git identity
 * (`user.email` → `user.name`). Empty / absent identity falls back to the defined
 * non-empty slug `anon` — NEVER an empty key that would collide two authors into
 * one file. Best-effort: a non-repo / missing git just yields the fallback.
 */
export function gitAuthorSlug(repoRoot: string): string {
  const read = (key: string): string => {
    const r = Bun.spawnSync(['git', 'config', '--get', key], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return r.exitCode === 0 ? (r.stdout?.toString() ?? '').trim() : '';
  };
  const slug = slugifyAuthor(read('user.email') || read('user.name'));
  return slug.length > 0 ? slug : 'anon';
}

/** Render a Handoff to its human-readable markdown body (the part injected next session). */
export function renderHandoff(h: Handoff): string {
  const lines: string[] = [];
  lines.push(`# Handoff: ${scopeKey(h.scope)}`);
  if (h.autopilot_id) lines.push(`autopilot: ${h.autopilot_id}`);
  lines.push('', `from: ${h.from_context}`, '');
  lines.push('## 원래 의도');
  lines.push(h.original_intent, '');
  lines.push('## 현재 상태');
  lines.push(h.current_state, '');
  // ac-9: a fail / condition-(b) blocked handoff surfaces the decision the USER
  // must make as a distinct block — concrete options + the agent's current lean —
  // placed high so it is not mistaken for a resume pointer. Empty on a normal
  // pass/partial handoff (the section is then skipped).
  if (h.user_decision_block.length > 0) {
    lines.push('## 사용자 결정 필요 (blocked handoff)');
    for (const d of h.user_decision_block) {
      lines.push(`- 결정: ${d.decision}`);
      for (const o of d.options) lines.push(`  - 선택지: ${o}`);
      lines.push(`  - agent 현재 해석: ${d.agent_interpretation}`);
    }
    lines.push('');
  }
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

/** Recursively token-scrub every string in a JSON value (defense-in-depth). */
function scrubDeep(value: unknown): unknown {
  if (typeof value === 'string') return scrubTokens(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrubDeep(v)]),
    );
  }
  return value;
}

/**
 * Harden a handoff body for a COMMITTED (git-history, irreversible) remote write:
 * token-scrub every free-text field (reuses `github-redaction`'s scrub). The routing
 * keys (`scope`), `schema_version` and `created_at` pass through verbatim. Re-parse is
 * FAIL-CLOSED: if scrubbing broke a required field (e.g. a secret-laden URL that no
 * longer validates), the write throws instead of committing an unscrubbed body. Pure.
 */
export function scrubHandoffForCommit(h: Handoff): Handoff {
  const { scope, schema_version, created_at, ...rest } = h;
  return handoffSchema.parse({
    scope,
    schema_version,
    created_at,
    ...(scrubDeep(rest) as Record<string, unknown>),
  });
}

export interface ActiveHandoff {
  handoff: Handoff;
  body: string;
  path: string;
}

/** A committed remote handoff waiting to be picked up (per-recipient list). */
export interface RemoteHandoff {
  handoff: Handoff;
  body: string;
  /** repo-relative committed path (`.ditto/handoff/<stem>.md`). */
  path: string;
  /** filename stem — the identity used for this recipient's consumed-marker. */
  stem: string;
}

/** A handoff file that was present but failed to parse — surfaced, never silently dropped. */
export interface HandoffParseFailure {
  /** absolute path of the unparsable file */
  path: string;
  /** scope inferred from the FILENAME (the body did not parse) */
  scope: 'work_item' | 'session' | 'unknown';
  error: string;
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

/** Result of committing a remote handoff (produce = local commit only, NO push). */
export interface RemoteWriteResult {
  /** repo-relative committed path */
  rel: string;
  /** branch the handoff was committed to (verified, never a wrong-branch land) */
  branch: string;
  /** the commit sha it landed in */
  commit: string;
  /** author-slug used in the filename */
  author: string;
  /** filename stem (identity for the recipient's consumed-marker) */
  stem: string;
}

export interface RemoteWriteOptions {
  /** explicit author-slug (else derived from git identity) */
  author?: string;
  /** if set, the current branch MUST equal this — else refuse to commit */
  expectedBranch?: string;
  now?: Date;
}

/** A committed-remote write refused/failed — SURFACED (never a silent fail-open no-op). */
export class HandoffRemoteWriteError extends Error {
  constructor(
    public readonly code:
      | 'detached'
      | 'branch_mismatch'
      | 'gitignored'
      | 'add_failed'
      | 'commit_failed',
    message: string,
  ) {
    super(message);
    this.name = 'HandoffRemoteWriteError';
  }
}

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run git, retrying ONLY on a locked index so two concurrent producers serialize
 * instead of failing (`.git/index.lock`). A non-lock failure returns immediately.
 */
function runGit(repoRoot: string, args: string[]): GitResult {
  const maxAttempts = 5;
  let last: GitResult = { exitCode: 1, stdout: '', stderr: '' };
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const proc = Bun.spawnSync(['git', ...args], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    last = {
      exitCode: proc.exitCode,
      stdout: proc.stdout?.toString() ?? '',
      stderr: proc.stderr?.toString() ?? '',
    };
    if (last.exitCode === 0) return last;
    if (/index\.lock/.test(last.stderr) && attempt < maxAttempts - 1) {
      Bun.sleepSync(20 * (attempt + 1));
      continue;
    }
    return last;
  }
  return last;
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

// Work-item branch naming convention (mirrors worktree.ts WORK_ITEM_BRANCH_PREFIX,
// which is not exported): DITTO creates a work item's branch as `ditto/<wi>`.
const WORK_ITEM_BRANCH_PREFIX = 'ditto/';

/** Active handoffs older than this are swept into archive (move-not-delete). */
const STALE_ACTIVE_RETENTION_DAYS = 7;
const STALE_ACTIVE_RETENTION_MS = STALE_ACTIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export class HandoffStore {
  constructor(public readonly repoRoot: string) {}

  private dir(): string {
    return localDir(this.repoRoot, 'handoff');
  }
  /** The COMMITTED (git-tracked, NOT gitignored) remote handoff dir. */
  private remoteDir(): string {
    return join(dittoDir(this.repoRoot), 'handoff');
  }
  private activePath(workItemId: string): string {
    return join(this.dir(), `${workItemId}.md`);
  }
  private activeRel(workItemId: string): string {
    return `.ditto/local/handoff/${workItemId}.md`;
  }
  /** The archive filename stem for a scope — session must NOT collapse to `undefined`. */
  private archiveKeyForScope(scope: HandoffScope): string {
    return scope.kind === 'work_item' ? scope.work_item_id : `session__${scope.session_id}`;
  }
  private archiveRelForScope(scope: HandoffScope, ts: string): string {
    return `.ditto/local/handoff/archive/${this.archiveKeyForScope(scope)}__${ts}.md`;
  }
  /**
   * Archive destination for a file we can't parse into a scope: derive the name from
   * the file's own basename stem so nothing is lost and the `stamp(now)` suffix keeps
   * it collision-free (WS-HND-T1).
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
   * Write an ACTIVE LOCAL handoff (compaction / explicit `ditto work handoff` /
   * `ditto handoff`). work_item scope keeps the historical `<wi>.md` key (back-compat
   * + auto-link); session scope routes to `session__<sid>.md` with NO work-item link.
   * Returns the repo-relative path it was written to.
   */
  async write(h: Handoff): Promise<string> {
    if (h.scope.kind === 'work_item') {
      const id = h.scope.work_item_id;
      await atomicWriteText(this.activePath(id), serialize(h));
      const rel = this.activeRel(id);
      await this.link(id, rel);
      return rel;
    }
    assertSafeKey(h.scope.session_id, 'session_id');
    const name = `session__${h.scope.session_id}.md`;
    await atomicWriteText(join(this.dir(), name), serialize(h));
    return `.ditto/local/handoff/${name}`;
  }

  /**
   * Write straight to ARCHIVE — a completed (pass) handoff that needs no pickup,
   * so it never appears as active noise. Returns the repo-relative path.
   */
  async writeArchived(h: Handoff, now: Date = new Date()): Promise<string> {
    const rel = this.archiveRelForScope(h.scope, stamp(now));
    await atomicWriteText(join(this.repoRoot, rel), serialize(h));
    if (h.scope.kind === 'work_item') await this.link(h.scope.work_item_id, rel);
    return rel;
  }

  /**
   * Commit a REMOTE handoff to the work's branch so a fetch/checkout recipient gets
   * the body + pointer (ac-4). Produce = local commit ONLY — cross-machine delivery
   * is a separate user-gated push (charter §4-8); this NEVER pushes.
   *
   *  - Routes by scope-key + author-slug so two concurrent authors DON'T share a file
   *    (ac-1). Keys are charset-validated before any fs/git touch.
   *  - Verifies the target branch: work_item commits ONLY to `ditto/<wi>` (or an
   *    explicit `expectedBranch`); a mismatch / detached HEAD is REFUSED, not landed
   *    on the wrong branch.
   *  - Body is token-scrubbed fail-closed (git history is irreversible).
   *  - Serializes on a locked index (retry) and SURFACES a failed commit (a one-shot
   *    remote write has no GC retry, so a swallowed failure = permanent non-delivery).
   */
  async writeRemote(h: Handoff, opts: RemoteWriteOptions = {}): Promise<RemoteWriteResult> {
    const author =
      opts.author !== undefined ? slugifyAuthor(opts.author) : gitAuthorSlug(this.repoRoot);
    assertSafeKey(author, 'author-slug');
    const key = scopeKey(h.scope);
    assertSafeKey(key, h.scope.kind === 'work_item' ? 'work_item_id' : 'session_id');
    const stem = h.scope.kind === 'work_item' ? `${key}__${author}` : `session__${key}__${author}`;
    const rel = `.ditto/handoff/${stem}.md`;

    // Target branch: don't commit to whatever happens to be checked out.
    const expected =
      opts.expectedBranch ??
      (h.scope.kind === 'work_item' ? `${WORK_ITEM_BRANCH_PREFIX}${key}` : undefined);
    const current = this.currentBranch();
    if (current === null) {
      throw new HandoffRemoteWriteError(
        'detached',
        'HEAD is detached — refusing to commit a remote handoff to an orphan commit',
      );
    }
    if (expected !== undefined && current !== expected) {
      throw new HandoffRemoteWriteError(
        'branch_mismatch',
        `refusing remote handoff: on branch '${current}', expected '${expected}'`,
      );
    }

    // A gitignored path makes `git add` a silent no-op → nothing commits. Surface it.
    if (this.isGitIgnored(rel)) {
      throw new HandoffRemoteWriteError(
        'gitignored',
        `committed handoff path ${rel} is gitignored — git add would be a silent no-op`,
      );
    }

    // Fail-closed scrub BEFORE anything is written to disk.
    const committed = scrubHandoffForCommit(h);
    await atomicWriteText(join(this.repoRoot, rel), serialize(committed));

    const add = runGit(this.repoRoot, ['add', '--', rel]);
    if (add.exitCode !== 0) {
      throw new HandoffRemoteWriteError('add_failed', `git add failed: ${add.stderr.trim()}`);
    }
    const commit = runGit(this.repoRoot, [
      'commit',
      '-m',
      `chore(handoff): ${stem} (remote handoff, no-push)`,
      '--',
      rel,
    ]);
    if (commit.exitCode !== 0 && !/nothing to commit/i.test(`${commit.stdout}${commit.stderr}`)) {
      throw new HandoffRemoteWriteError(
        'commit_failed',
        `git commit failed: ${(commit.stderr || commit.stdout).trim()}`,
      );
    }
    const sha = runGit(this.repoRoot, ['rev-parse', 'HEAD']).stdout.trim();
    return { rel, branch: current, commit: sha, author, stem };
  }

  /** Current branch name, or null when detached / not a repo. */
  private currentBranch(): string | null {
    const r = runGit(this.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (r.exitCode !== 0) return null;
    const name = r.stdout.trim();
    return name === '' || name === 'HEAD' ? null : name;
  }

  /** True when `rel` is gitignored in this repo (`check-ignore -q` exits 0 = ignored). */
  private isGitIgnored(rel: string): boolean {
    return runGit(this.repoRoot, ['check-ignore', '-q', '--', rel]).exitCode === 0;
  }

  /**
   * Every active LOCAL handoff waiting to be picked up, PLUS the set of files that
   * were present but failed to parse. `list` is the sole sanctioned discovery
   * channel (no auto-inject), so a session handoff that fails to parse must be
   * SURFACED (ac-3 "fail-open drop 아님") — never a bare silent skip.
   */
  async listActiveDetailed(): Promise<{
    active: ActiveHandoff[];
    failures: HandoffParseFailure[];
  }> {
    let names: string[];
    try {
      names = await readdir(this.dir());
    } catch {
      return { active: [], failures: [] }; // no handoff dir yet
    }
    const active: ActiveHandoff[] = [];
    const failures: HandoffParseFailure[] = [];
    for (const name of names) {
      if (!name.endsWith('.md')) continue; // skip archive/ + consumed/ subdirs and stray files
      const path = join(this.dir(), name);
      try {
        const { handoff, body } = parseHandoffFile(await Bun.file(path).text());
        active.push({ handoff, body, path });
      } catch (err) {
        failures.push({
          path,
          scope: name.startsWith('session__')
            ? 'session'
            : /^wi_[a-z0-9]+\.md$/.test(name)
              ? 'work_item'
              : 'unknown',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    active.sort((a, b) => a.handoff.created_at.localeCompare(b.handoff.created_at));
    return { active, failures };
  }

  /** Every active LOCAL handoff currently waiting to be picked up (oldest first). */
  async listActive(): Promise<ActiveHandoff[]> {
    return (await this.listActiveDetailed()).active;
  }

  /**
   * SOFT consume of every active LOCAL handoff: return the bodies + record a
   * per-recipient consumed-marker. The hard cleanup (move/delete) is SEPARATE — the
   * age-sweep is the sole local hard path — so a failed resume never loses a handoff
   * (ac-7). Never moves or deletes here.
   */
  async consume(recipient?: string, now: Date = new Date()): Promise<ActiveHandoff[]> {
    const active = await this.listActive();
    if (active.length === 0) return [];
    const who = this.recipient(recipient);
    for (const a of active) {
      await this.writeConsumedMarker(who, this.localMarkerId(a.handoff.scope), {
        source: 'local',
        ref: a.path,
        consumed_at: now.toISOString(),
      });
    }
    return active;
  }

  /**
   * The active LOCAL handoff for this work item (body + path), or null when none /
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
   * SOFT consume of JUST this work item's active LOCAL handoff: return it (body) +
   * record a per-recipient consumed-marker, WITHOUT moving/deleting the file. A
   * failed resume therefore never loses the handoff (ac-7); the age-sweep is the sole
   * hard cleanup. Returns null when there is no active handoff.
   */
  async consumeFor(
    workItemId: string,
    recipient?: string,
    now: Date = new Date(),
  ): Promise<ActiveHandoff | null> {
    const active = await this.getActive(workItemId);
    if (active === null) return null;
    await this.writeConsumedMarker(this.recipient(recipient), `local-${workItemId}`, {
      source: 'local',
      ref: active.path,
      consumed_at: now.toISOString(),
    });
    return active;
  }

  /**
   * Every committed REMOTE handoff still waiting for THIS recipient (a per-recipient
   * consumed-marker excludes the ones this recipient already consumed). Unparsable
   * files are surfaced, not silently dropped.
   */
  async listRemote(
    recipient?: string,
  ): Promise<{ handoffs: RemoteHandoff[]; failures: HandoffParseFailure[] }> {
    const who = this.recipient(recipient);
    const dir = this.remoteDir();
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return { handoffs: [], failures: [] };
    }
    const handoffs: RemoteHandoff[] = [];
    const failures: HandoffParseFailure[] = [];
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const stem = name.replace(/\.md$/, '');
      const rel = `.ditto/handoff/${name}`;
      let parsed: { handoff: Handoff; body: string };
      try {
        parsed = parseHandoffFile(await Bun.file(join(dir, name)).text());
      } catch (err) {
        failures.push({
          path: join(dir, name),
          scope: stem.startsWith('session__') ? 'session' : 'work_item',
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      if (await this.hasConsumedMarker(who, `remote-${stem}`)) continue;
      handoffs.push({ handoff: parsed.handoff, body: parsed.body, path: rel, stem });
    }
    handoffs.sort((a, b) => a.handoff.created_at.localeCompare(b.handoff.created_at));
    return { handoffs, failures };
  }

  /**
   * SOFT consume of a committed REMOTE handoff: return the body + write a
   * per-recipient LOCAL marker (ac-8). NEVER git-delete / commit / push — the
   * committed file stays in history; only THIS recipient's future `listRemote`
   * excludes it. The marker lives under `.ditto/local/handoff/consumed/` (gitignored,
   * and outside the mtime age-sweep set) so a checkout-reset mtime can't re-surface a
   * consumed remote handoff.
   */
  async consumeRemote(
    remote: RemoteHandoff,
    recipient?: string,
    now: Date = new Date(),
  ): Promise<RemoteHandoff> {
    await this.writeConsumedMarker(this.recipient(recipient), `remote-${remote.stem}`, {
      source: 'remote',
      ref: remote.path,
      consumed_at: now.toISOString(),
    });
    return remote;
  }

  private recipient(recipient?: string): string {
    const who = recipient !== undefined ? slugifyAuthor(recipient) : gitAuthorSlug(this.repoRoot);
    assertSafeKey(who, 'recipient');
    return who;
  }

  private localMarkerId(scope: HandoffScope): string {
    return scope.kind === 'work_item'
      ? `local-${scope.work_item_id}`
      : `local-session__${scope.session_id}`;
  }

  private consumedMarkerPath(recipient: string, markerId: string): string {
    assertSafeKey(recipient, 'recipient');
    assertSafeKey(markerId, 'marker id');
    // A subdir under the handoff dir: readdir in the sweep/list only touches
    // top-level `.md`, so markers are never listed nor swept.
    return join(this.dir(), 'consumed', recipient, `${markerId}.json`);
  }

  /** Whether `recipient` already consumed the handoff identified by `markerId`. */
  async hasConsumedMarker(recipient: string, markerId: string): Promise<boolean> {
    return Bun.file(this.consumedMarkerPath(recipient, markerId)).exists();
  }

  /** Record that `recipient` consumed `markerId`; returns the marker's absolute path. */
  async writeConsumedMarker(
    recipient: string,
    markerId: string,
    meta: Record<string, unknown>,
  ): Promise<string> {
    const path = this.consumedMarkerPath(recipient, markerId);
    await atomicWriteText(
      path,
      `${JSON.stringify({ marker_id: markerId, recipient, ...meta }, null, 2)}\n`,
    );
    return path;
  }

  /**
   * Sweep stale active LOCAL handoffs into archive (MOVE, never delete). An active
   * file older than STALE_ACTIVE_RETENTION_DAYS that no session ever picked up
   * would otherwise re-inject into an unrelated session's context forever;
   * moving it into archive/ (which listActive excludes) stops that injection
   * while preserving the artifact.
   *
   * CONTENT-BLIND (WS-HND-T1): the sweep iterates the active-dir `.md` files
   * directly and decides staleness by the filesystem mtime — NOT the parsed
   * created_at. A malformed / non-WI hand-authored file (which listActive surfaces
   * as a failure) therefore still retires by age; a valid handoff keeps the
   * scope-derived `<key>__<ts>` archive scheme, a malformed one is archived under its
   * own basename stem so nothing is lost. Best-effort, fail-open like consume():
   * a failed stat/rename just leaves the file active for a later turn — never
   * throws. Returns what was swept.
   *
   * The COMMITTED remote handoffs (`.ditto/handoff/`) and the consumed-markers
   * (`.ditto/local/handoff/consumed/`) are OUTSIDE this sweep set on purpose: it only
   * reads top-level `.md` under `.ditto/local/handoff/`.
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
      if (!name.endsWith('.md')) continue; // skip archive/ + consumed/ subdirs and stray files
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
        ? this.archiveRelForScope(handoff.scope, stamp(now))
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

  /** Whether an active LOCAL handoff exists for this work item. */
  async exists(workItemId: string): Promise<boolean> {
    return Bun.file(this.activePath(workItemId)).exists();
  }

  /** Read the active LOCAL handoff for this work item (throws if none). */
  async get(workItemId: string): Promise<Handoff> {
    return parseHandoffFile(await Bun.file(this.activePath(workItemId)).text()).handoff;
  }
}
