import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DecisionConflictCarrier } from '~/schemas/decision-conflict-carrier';
import { workItem as workItemSchema } from '~/schemas/work-item';
import { stopHandler as rebuiltStopHandler } from './rebuilt/stop';
import { evaluateStopGate } from './rebuilt/stop-gate';
import { stopHandler as legacyStopHandler } from './stop';

/**
 * Handler under test: the REBUILT handler by default (what the dispatch table
 * now routes), the legacy handler under DITTO_HOOKS_LEGACY=1 — the same env
 * flip `ditto hook` uses. Run BOTH paths to prove decision parity.
 */
const stopHandler = process.env.DITTO_HOOKS_LEGACY === '1' ? legacyStopHandler : rebuiltStopHandler;

/**
 * Stop hook CHARACTERIZATION tests — pin the handler's OUTER decision surface
 * before any hook rewiring (the prior hook test suite was deleted in commit
 * 6f298c8). Green against the CURRENT legacy handler.
 *
 * Scope: only the observable exit behavior of the handler is pinned —
 * stop_hook_active yield, missing-session yield, no-pointer/no-work-item
 * yield, malformed-ledger fail-closed, one completion-gate block, the
 * no-verification-path strong block, and one clean pass. The gate library
 * internals (src/core/gates.ts) are deliberately NOT re-tested here.
 *
 * Fixtures are real files in a temp repo laid out exactly where the stores
 * persist them (`.ditto/local/sessions/`, `.ditto/local/work-items/<wi>/`);
 * the handler is invoked in-process with a constructed HookInput.
 */

const WI = 'wi_stopparity01';
const SESSION = 'stop-parity-session';
const NOW = () => new Date().toISOString();

const roots: string[] = [];

function newRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'ditto-stop-parity-'));
  roots.push(root);
  return root;
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const wiDir = (root: string) => join(root, '.ditto', 'local', 'work-items', WI);

function writeSessionPointer(root: string): void {
  writeJsonFile(join(root, '.ditto', 'local', 'sessions', `${SESSION}.json`), {
    schema_version: '0.1.0',
    session_id: SESSION,
    work_item_id: WI,
    updated_at: NOW(),
  });
}

/** Legacy-mirror work item (record.json absent → the store reads this). */
function writeWorkItem(root: string, acceptanceIds: string[], status = 'in_progress'): void {
  writeJsonFile(join(wiDir(root), 'work-item.json'), {
    schema_version: '0.1.0',
    id: WI,
    title: 'stop characterization fixture',
    source_request: 'characterize the legacy stop hook',
    goal: 'pin the stop hook outer decision surface',
    acceptance_criteria: acceptanceIds.map((id) => ({
      id,
      statement: `criterion ${id}`,
    })),
    status,
    created_at: NOW(),
    updated_at: NOW(),
  });
}

/** A completion.json reporting the given ACs as pass, with a real verification. */
function writeCompletion(root: string, acceptanceIds: string[]): void {
  writeJsonFile(join(wiDir(root), 'completion.json'), {
    schema_version: '0.1.0',
    work_item_id: WI,
    declared_by: 'verifier',
    declared_at: NOW(),
    summary: 'stop characterization fixture completion',
    changed_files: [],
    acceptance: acceptanceIds.map((id) => ({ criterion_id: id, verdict: 'pass' })),
    verifications: [{ command: 'bun test fixture.test.ts', exit_code: 0 }],
    final_verdict: 'pass',
  });
}

function run(root: string, raw: unknown) {
  return stopHandler({ raw, repoRoot: root, env: {} });
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('Stop characterization — yield (exit 0) preconditions', () => {
  test('stop_hook_active=true yields immediately (8-iteration guard)', async () => {
    const out = await run(newRepo(), { stop_hook_active: true, session_id: SESSION });
    expect(out.exitCode).toBe(0);
  });

  test('missing session_id yields with a did-not-run notice', async () => {
    const out = await run(newRepo(), {});
    expect(out.exitCode).toBe(0);
    expect(out.stderr ?? '').toContain('session_id');
  });

  test('session with no pointer yields silently', async () => {
    const out = await run(newRepo(), { session_id: SESSION });
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toBeUndefined();
  });

  test('pointer to a non-loadable work item yields', async () => {
    const root = newRepo();
    writeSessionPointer(root); // pointer exists, but no work-item.json
    const out = await run(root, { session_id: SESSION });
    expect(out.exitCode).toBe(0);
  });
});

describe('Stop characterization — fail-closed on malformed ledgers (exit 2)', () => {
  test('malformed completion.json blocks and names the file', async () => {
    const root = newRepo();
    writeSessionPointer(root);
    writeWorkItem(root, ['ac-1']);
    mkdirSync(wiDir(root), { recursive: true });
    writeFileSync(join(wiDir(root), 'completion.json'), '{ this is not json');
    const out = await run(root, { session_id: SESSION });
    expect(out.exitCode).toBe(2);
    expect(out.stderr ?? '').toContain('completion.json');
    expect(out.stderr ?? '').toContain('malformed');
  });

  test('malformed autopilot.json blocks and names the file', async () => {
    const root = newRepo();
    writeSessionPointer(root);
    writeWorkItem(root, ['ac-1']);
    mkdirSync(wiDir(root), { recursive: true });
    writeFileSync(join(wiDir(root), 'autopilot.json'), '{"nodes": "nope"}');
    const out = await run(root, { session_id: SESSION });
    expect(out.exitCode).toBe(2);
    expect(out.stderr ?? '').toContain('autopilot.json');
  });
});

describe('Stop characterization — completion-gate verdicts through the ledgers', () => {
  test('completion missing an acceptance criterion blocks (exit 2)', async () => {
    const root = newRepo();
    writeSessionPointer(root);
    writeWorkItem(root, ['ac-1', 'ac-2']);
    writeCompletion(root, ['ac-1']); // ac-2 never reported
    const out = await run(root, { session_id: SESSION });
    expect(out.exitCode).toBe(2);
    expect(out.stderr ?? '').toContain('ac-2');
  });

  test('non-terminal work item with NO verification path strong-blocks (exit 2)', async () => {
    const root = newRepo();
    writeSessionPointer(root);
    writeWorkItem(root, ['ac-1']); // no completion / convergence / autopilot at all
    const out = await run(root, { session_id: SESSION });
    expect(out.exitCode).toBe(2);
    expect(out.stderr ?? '').toContain('no real verification path');
  });

  test('clean pass: full completion with executed verification yields (exit 0)', async () => {
    const root = newRepo();
    writeSessionPointer(root);
    writeWorkItem(root, ['ac-1']);
    writeCompletion(root, ['ac-1']);
    const out = await run(root, { session_id: SESSION });
    expect(out.exitCode).toBe(0);
  });
});

// ─── Decision-conflict RESOLUTION enforcement (wi_2607222uc n-impl-stop-resolution) ───
//
// WHY these tests exist (red-first, ac-1/ac-3/ac-4):
//  - ac-1: a carrier conflict that CARRIES a resolution record (superseded_by +
//    re-collation basis) and whose ADR is CONFIRMED superseded at the HEAD commit
//    is demoted from a blocking continuation to a NON-blocking advisory (stop
//    passes). Verification is positive-evidence-only: {file absent at HEAD,
//    status-line parse failure, successor-id mismatch, still-accepted} each KEEP
//    the block (fail-closed) with a branch-distinct message; an old carrier
//    without the resolution field parses and blocks exactly as before.
//  - ac-3: a terminal (done/abandoned) work item is never force-continued by the
//    decision-conflict gate, while the D2 disclosure advisory is still emitted.
//  - ac-4: an UNRESOLVED intent conflict still blocks under autopilot mode, and a
//    resolved conflict stays disclosed (conflict basis + resolution basis both
//    visible — no silent disappearance).
// Both handler paths (legacy stop.ts and rebuilt stop-gate.ts) are driven
// explicitly, independent of the DITTO_HOOKS_LEGACY env selection above.

const CONFLICT_BASIS = 'ADR가 금지한 접근을 이 작업의 목적이 요구함 (conflict basis fixture)';
const RESOLUTION_BASIS = '사용자와 재대조하여 해당 ADR을 supersede함 (resolution basis fixture)';
const OLD_ADR_ID = 'ADR-20260701-old-decision';
const NEW_ADR_ID = 'ADR-20260710-new-decision';

function gitIn(dir: string, args: string[]): void {
  const proc = Bun.spawnSync(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${proc.stderr?.toString()}`);
  }
}

/** A throwaway git repo (identity configured, one commit) rooted at the fixture dir. */
function initGitRepo(root: string): void {
  gitIn(root, ['init', '-b', 'main']);
  gitIn(root, ['config', 'user.email', 'fixture@example.invalid']);
  gitIn(root, ['config', 'user.name', 'Fixture']);
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  gitIn(root, ['add', 'README.md']);
  gitIn(root, ['commit', '-m', 'init']);
}

/** Write + COMMIT an ADR body under .ditto/knowledge/adr so it is readable at HEAD. */
function commitAdr(root: string, filename: string, statusLineValue: string | null): void {
  const rel = join('.ditto', 'knowledge', 'adr', filename);
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  const statusLine = statusLineValue === null ? '' : `- 상태: ${statusLineValue}\n`;
  writeFileSync(
    path,
    `# ${filename.replace(/\.md$/, '')}: fixture decision\n\n${statusLine}- 결정 일자: 2026-07-01\n\n본문 prose에 superseded 라는 단어가 있어도 상태줄만 읽어야 한다.\n`,
  );
  gitIn(root, ['add', rel]);
  gitIn(root, ['commit', '-m', `adr ${filename}`]);
}

interface ConflictFixture {
  adr_id: string;
  kind: 'forbid' | 'require' | 'prefer';
  level: 'intent' | 'method';
  basis: string;
  resolution?: { superseded_by: string; basis: string };
}

function intentConflict(resolution?: { superseded_by: string; basis: string }): ConflictFixture {
  return {
    adr_id: OLD_ADR_ID,
    kind: 'forbid',
    level: 'intent',
    basis: CONFLICT_BASIS,
    ...(resolution ? { resolution } : {}),
  };
}

function writeConflictCarrier(root: string, conflicts: ConflictFixture[]): void {
  writeJsonFile(join(wiDir(root), 'decision-conflict.json'), {
    schema_version: '0.1.0',
    mode: 'autopilot',
    conflicts,
  });
}

const HANDLERS = [
  ['rebuilt', rebuiltStopHandler],
  ['legacy', legacyStopHandler],
] as const;

for (const [name, handler] of HANDLERS) {
  const runWith = (root: string) =>
    handler({ raw: { session_id: SESSION }, repoRoot: root, env: {} });

  describe(`Stop — decision-conflict resolution enforcement (${name} handler)`, () => {
    test('ac-1 demotion: verified superseded-at-HEAD resolution demotes block → non-blocking advisory (exit 0, both bases visible)', async () => {
      const root = newRepo();
      initGitRepo(root);
      commitAdr(root, `${OLD_ADR_ID}.md`, `superseded by ${NEW_ADR_ID}`);
      writeSessionPointer(root);
      writeWorkItem(root, ['ac-1']);
      writeCompletion(root, ['ac-1']);
      writeConflictCarrier(root, [
        intentConflict({ superseded_by: NEW_ADR_ID, basis: RESOLUTION_BASIS }),
      ]);
      const out = await runWith(root);
      const stderr = out.stderr ?? '';
      expect(out.exitCode).toBe(0);
      // Non-blocking cue present; the blocking route marker must NOT appear.
      expect(stderr).toContain('비차단');
      expect(stderr).not.toContain('→ block');
      // No silent disappearance: conflict basis AND resolution basis both surface.
      expect(stderr).toContain(CONFLICT_BASIS);
      expect(stderr).toContain(RESOLUTION_BASIS);
    });

    test('ac-1 fail-closed: ADR file absent at HEAD keeps the block and names the branch', async () => {
      const root = newRepo();
      initGitRepo(root); // repo exists, but the claimed ADR was never committed
      writeSessionPointer(root);
      writeWorkItem(root, ['ac-1']);
      writeConflictCarrier(root, [
        intentConflict({ superseded_by: NEW_ADR_ID, basis: RESOLUTION_BASIS }),
      ]);
      const out = await runWith(root);
      const stderr = out.stderr ?? '';
      expect(out.exitCode).toBe(2);
      expect(stderr).toContain('ADR 파일 부재');
      expect(stderr).toContain('랜딩');
      // Exit actions are user decisions — never a carrier-removal suggestion.
      expect(stderr).not.toContain('제거');
      expect(stderr).not.toContain('삭제');
    });

    test('ac-1 fail-closed: status-line parse failure keeps the block and names the branch', async () => {
      const root = newRepo();
      initGitRepo(root);
      commitAdr(root, `${OLD_ADR_ID}.md`, null); // no status line at all
      writeSessionPointer(root);
      writeWorkItem(root, ['ac-1']);
      writeConflictCarrier(root, [
        intentConflict({ superseded_by: NEW_ADR_ID, basis: RESOLUTION_BASIS }),
      ]);
      const out = await runWith(root);
      const stderr = out.stderr ?? '';
      expect(out.exitCode).toBe(2);
      expect(stderr).toContain('상태줄 파싱 실패');
      expect(stderr).not.toContain('제거');
    });

    test('ac-1 fail-closed: successor-id mismatch keeps the block and names the branch', async () => {
      const root = newRepo();
      initGitRepo(root);
      commitAdr(root, `${OLD_ADR_ID}.md`, `superseded by ${NEW_ADR_ID}`);
      writeSessionPointer(root);
      writeWorkItem(root, ['ac-1']);
      writeConflictCarrier(root, [
        intentConflict({ superseded_by: 'ADR-20260711-other-decision', basis: RESOLUTION_BASIS }),
      ]);
      const out = await runWith(root);
      const stderr = out.stderr ?? '';
      expect(out.exitCode).toBe(2);
      expect(stderr).toContain('불일치');
      expect(stderr).toContain('해소 기록을 수정');
      expect(stderr).not.toContain('제거');
    });

    test('ac-1 fail-closed: still-accepted ADR (supersede not landed/flipped) keeps the block', async () => {
      const root = newRepo();
      initGitRepo(root);
      commitAdr(root, `${OLD_ADR_ID}.md`, 'accepted');
      writeSessionPointer(root);
      writeWorkItem(root, ['ac-1']);
      writeConflictCarrier(root, [
        intentConflict({ superseded_by: NEW_ADR_ID, basis: RESOLUTION_BASIS }),
      ]);
      const out = await runWith(root);
      const stderr = out.stderr ?? '';
      expect(out.exitCode).toBe(2);
      expect(stderr).toContain('아직 superseded');
      expect(stderr).toContain('fetch');
      expect(stderr).not.toContain('제거');
    });

    test('ac-1 compat: old carrier without a resolution field parses and blocks as before', async () => {
      const root = newRepo(); // no git repo needed — no resolution claim, no HEAD read
      writeSessionPointer(root);
      writeWorkItem(root, ['ac-1']);
      writeConflictCarrier(root, [intentConflict()]);
      const out = await runWith(root);
      const stderr = out.stderr ?? '';
      expect(out.exitCode).toBe(2);
      expect(stderr).toContain('의사결정 충돌');
      expect(stderr).toContain('→ block');
      expect(stderr).toContain(CONFLICT_BASIS);
    });

    test('ac-3 terminal work item: decision-conflict gate never forces continuation, D2 advisory still emitted', async () => {
      const root = newRepo();
      writeSessionPointer(root);
      writeWorkItem(root, ['ac-1'], 'done');
      writeConflictCarrier(root, [
        intentConflict(), // unresolved intent conflict — would block a non-terminal item
        {
          adr_id: NEW_ADR_ID,
          kind: 'require',
          level: 'method',
          basis: 'method conflict disclosure fixture',
        },
      ]);
      const out = await runWith(root);
      const stderr = out.stderr ?? '';
      expect(out.exitCode).toBe(0);
      // D2 transparency survives the terminal guard: the auto-aligned method
      // conflict disclosure is still emitted as an advisory…
      expect(stderr).toContain('공개됨');
      // …while no blocking continuation reason is forced on the closed item.
      expect(stderr).not.toContain('→ block');
    });

    test('ac-4: unresolved intent conflict still blocks; a resolved sibling stays disclosed', async () => {
      const root = newRepo();
      initGitRepo(root);
      commitAdr(root, `${OLD_ADR_ID}.md`, `superseded by ${NEW_ADR_ID}`);
      writeSessionPointer(root);
      writeWorkItem(root, ['ac-1']);
      writeConflictCarrier(root, [
        intentConflict({ superseded_by: NEW_ADR_ID, basis: RESOLUTION_BASIS }),
        {
          adr_id: 'ADR-20260705-still-live',
          kind: 'forbid',
          level: 'intent',
          basis: 'unresolved intent conflict fixture',
        },
      ]);
      const out = await runWith(root);
      const stderr = out.stderr ?? '';
      expect(out.exitCode).toBe(2);
      // The live conflict blocks…
      expect(stderr).toContain('ADR-20260705-still-live');
      expect(stderr).toContain('→ block');
      // …and the resolved one is NOT silently swallowed: both bases still visible.
      expect(stderr).toContain(CONFLICT_BASIS);
      expect(stderr).toContain(RESOLUTION_BASIS);
      expect(stderr).toContain('비차단');
    });

    test('pending plan (P2 surface): a verified-resolved intent conflict no longer yields for approval — routine punt continues', async () => {
      const root = newRepo();
      initGitRepo(root);
      commitAdr(root, `${OLD_ADR_ID}.md`, `superseded by ${NEW_ADR_ID}`);
      writeSessionPointer(root);
      writeWorkItem(root, ['ac-1']);
      writeJsonFile(join(wiDir(root), 'autopilot.json'), {
        schema_version: '0.1.0',
        autopilot_id: 'orch_stopparity01',
        work_item_id: WI,
        root_goal: 'pin the stop hook outer decision surface',
        approval_gate: { status: 'pending' },
        nodes: [
          {
            id: 'n1',
            kind: 'implement',
            owner: 'implementer',
            purpose: 'implement fixture',
            status: 'pending',
          },
        ],
        caps: { fix_per_node: 2, switch_per_node: 1 },
        continue_policy: {},
      });
      writeConflictCarrier(root, [
        intentConflict({ superseded_by: NEW_ADR_ID, basis: RESOLUTION_BASIS }),
      ]);
      const out = await runWith(root);
      const stderr = out.stderr ?? '';
      // Without a LIVE intent conflict there is nothing to yield for: the pending
      // plan is a routine procedure punt → force-continue (exit 2), not a stall.
      expect(out.exitCode).toBe(2);
      expect(stderr).toContain('절차 미루기');
    });

    test('pending plan (P2 pin): an UNRESOLVED intent conflict still yields for user approval (exit 0)', async () => {
      const root = newRepo();
      writeSessionPointer(root);
      writeWorkItem(root, ['ac-1']);
      writeJsonFile(join(wiDir(root), 'autopilot.json'), {
        schema_version: '0.1.0',
        autopilot_id: 'orch_stopparity01',
        work_item_id: WI,
        root_goal: 'pin the stop hook outer decision surface',
        approval_gate: { status: 'pending' },
        nodes: [
          {
            id: 'n1',
            kind: 'implement',
            owner: 'implementer',
            purpose: 'implement fixture',
            status: 'pending',
          },
        ],
        caps: { fix_per_node: 2, switch_per_node: 1 },
        continue_policy: {},
      });
      writeConflictCarrier(root, [intentConflict()]);
      const out = await runWith(root);
      expect(out.exitCode).toBe(0);
    });
  });
}

describe('Stop gate (pure) — a THROWING injected ADR reader still fail-closes', () => {
  test('reader throw is contained: block kept, verification failure surfaced (never fail-open)', () => {
    const wi = workItemSchema.parse({
      schema_version: '0.1.0',
      id: WI,
      title: 'stop characterization fixture',
      source_request: 'characterize the stop hook',
      goal: 'pin the stop hook outer decision surface',
      acceptance_criteria: [{ id: 'ac-1', statement: 'criterion ac-1' }],
      status: 'in_progress',
      created_at: NOW(),
      updated_at: NOW(),
    });
    const carrier: DecisionConflictCarrier = {
      schema_version: '0.1.0',
      mode: 'autopilot',
      conflicts: [
        {
          adr_id: OLD_ADR_ID,
          kind: 'forbid',
          level: 'intent',
          basis: CONFLICT_BASIS,
          resolution: { superseded_by: NEW_ADR_ID, basis: RESOLUTION_BASIS },
        },
      ],
    };
    const absent = { status: 'absent' } as const;
    const decision = evaluateStopGate({
      workItem: wi,
      ledgers: {
        completion: absent,
        conv: absent,
        pilot: absent,
        intent: absent,
        dialectics: { status: 'ok', items: [] },
        acgReview: absent,
        assurance: absent,
        impact: absent,
        semantic: absent,
        knowledge: absent,
        decisionConflicts: { status: 'ok', data: carrier },
        directionFork: absent,
      },
      repoRoot: newRepo(),
      uncommittedFiles: () => [],
      computeNudge: () => null,
      readAdrAtHead: () => {
        throw new Error('reader exploded');
      },
    });
    expect(decision.exitCode).toBe(2);
    expect(decision.stderr ?? '').toContain('해소 검증 실패');
  });
});
