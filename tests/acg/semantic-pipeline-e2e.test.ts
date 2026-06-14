import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySemanticVerdict, buildSemanticSeed } from '~/acg/semantic/semantic-produce';
import { writeJson } from '~/core/fs';
import { SessionPointerStore } from '~/core/session-pointer';
import { WorkItemStore } from '~/core/work-item-store';
import { stopHandler } from '~/hooks/stop';
import {
  type AcgSemanticCompatibility,
  acgSemanticCompatibility,
} from '~/schemas/acg-semantic-compatibility';

// OBJ-43 (wi_260605sv1) — full producer↔consumer chain proving dialectic-1 O3:
// the static seed forces continuation, and ONLY the resolver clears it. verify/
// autopilot touch acceptance verdicts, not the semantic ledger, so without the
// resolver the seed is a permanent deadlock — this test is its regression.

let repo: string;
let wiId: string;
const SESSION = 'sess-sem-e2e';

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-sem-e2e-'));
  const created = await new WorkItemStore(repo).create({
    title: 'sem',
    source_request: 'change getUser signature',
    goal: 'drop the null return',
    acceptance_criteria: [
      { id: 'ac-1', statement: 'returns user', verdict: 'unverified', evidence: [] },
    ],
  });
  wiId = created.id;
  await new SessionPointerStore(repo).set(SESSION, wiId);
  // completion claims pass on every acceptance criterion — so the ONLY thing that
  // can still force continuation is the semantic gate.
  await writeFile(
    join(repo, '.ditto', 'local', 'work-items', wiId, 'completion.json'),
    JSON.stringify({
      schema_version: '0.1.0',
      work_item_id: wiId,
      declared_by: 'main',
      declared_at: '2026-06-05T00:00:00.000Z',
      summary: 'done',
      changed_files: [],
      verifications: [{ command: 'bun test', exit_code: 0 }],
      unverified: [],
      remaining_risks: [],
      final_verdict: 'pass',
      acceptance: [{ criterion_id: 'ac-1', verdict: 'pass' }],
    }),
  );
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const semPath = () =>
  join(repo, '.ditto', 'local', 'work-items', wiId, 'semantic-compatibility.json');
const run = () => stopHandler({ raw: { session_id: SESSION }, repoRoot: repo, env: {} });
const writeSemantic = (sem: AcgSemanticCompatibility) =>
  writeJson(semPath(), acgSemanticCompatibility, sem);

const PAIR = {
  before: 'getUser(id: string): User | null',
  after: 'getUser(id: string): User',
};
const PAIR2 = {
  before: 'listUsers(): User[] | null',
  after: 'listUsers(): User[]',
};
const seedInput = {
  workItemId: '',
  changes: [PAIR],
  producedAt: '2026-06-05T00:00:00Z',
};

describe('semantic pipeline e2e — seed → block → resolve → clear', () => {
  test('unverified seed forces continuation even with a passing completion (O3)', async () => {
    await writeSemantic(buildSemanticSeed({ ...seedInput, workItemId: wiId }));
    const out = await run();
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('semantic: meaning compatibility unverified');
  });

  test('resolver verdict (declared intended break) clears the gate (exit 0)', async () => {
    const seed = buildSemanticSeed({ ...seedInput, workItemId: wiId });
    await writeSemantic(seed);
    expect((await run()).exitCode).toBe(2);

    // The agent's meaning judgment, injected via the resolver path.
    const resolved = applySemanticVerdict(seed, {
      semanticSafe: 'no',
      intendedBreaking: true,
      oldMeaning: 'null = 사용자 미존재',
      compatibility: 'breaking',
    });
    await writeSemantic(resolved);
    expect((await run()).exitCode).toBe(0);
  });

  test('resolver verdict (verified-safe yes, reproducible) clears the gate (exit 0)', async () => {
    const seed = buildSemanticSeed({ ...seedInput, workItemId: wiId });
    await writeSemantic(seed);
    expect((await run()).exitCode).toBe(2);

    const resolved = applySemanticVerdict(seed, {
      semanticSafe: 'yes',
      oldMeaning: 'null 은 부재이나 호출부가 의존하지 않음',
      compatibility: 'additive',
      modelVersion: 'claude-opus-4-8',
      characterizationTestRef: 'tests/user.test.ts::getUser absence not relied upon',
    });
    await writeSemantic(resolved);
    expect((await run()).exitCode).toBe(0);
  });

  // G4 (wi_260614gd9) — two breaking pairs both block; resolving one alone does
  // NOT clear the gate; resolving both clears it.
  test('two breaking pairs both gate; clearing only one still blocks; both clears', async () => {
    const seed = buildSemanticSeed({ ...seedInput, workItemId: wiId, changes: [PAIR, PAIR2] });
    await writeSemantic(seed);
    const blocked = await run();
    expect(blocked.exitCode).toBe(2);
    // Both pairs surfaced as reasons.
    expect(blocked.stderr).toContain(
      'getUser(id: string): User | null → getUser(id: string): User',
    );
    expect(blocked.stderr).toContain('listUsers(): User[] | null → listUsers(): User[]');

    // Resolve only PAIR → PAIR2 still blocks.
    const partial = applySemanticVerdict(seed, {
      semanticSafe: 'no',
      intendedBreaking: true,
      oldMeaning: 'null = 미존재',
      target: PAIR,
    });
    await writeSemantic(partial);
    expect((await run()).exitCode).toBe(2);

    // Resolve PAIR2 too → clears.
    const full = applySemanticVerdict(partial, {
      semanticSafe: 'no',
      intendedBreaking: true,
      oldMeaning: 'null = 빈 목록 아님',
      target: PAIR2,
    });
    await writeSemantic(full);
    expect((await run()).exitCode).toBe(0);
  });
});
