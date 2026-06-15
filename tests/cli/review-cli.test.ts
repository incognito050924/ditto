import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acgReviewForcesContinuation } from '~/hooks/stop';
import { acgReviewGraph } from '~/schemas/acg-review-graph';
import type { ReviewerOutput } from '~/schemas/reviewer-output';

// WU-5 (80-plan §9, ac-11/12/13). `ditto review --scope <unit>` is the UNIT-scoped
// consistency/security audit sibling of `ditto acg-review`. It SHARES the WU-4 scope
// resolver, decomposes the standing-code unit file set into batches that BOTH the
// reviewer and security-reviewer roles cover, and aggregates the role outputs into ONE
// unit acg-review.json ledger the existing Stop gate reads.
//
// The reviewer/security-reviewer LLM passes are autopilot-dispatched owners (a CLI
// cannot spawn them); these tests exercise the DETERMINISTIC seam — scoping, batching,
// aggregation, ledger — that those roles feed.

const cliEntry = join(process.cwd(), 'src/cli/index.ts');
const WI = 'wi_review01';
let dir: string;

const git = (args: string[]) =>
  Bun.spawnSync(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });

function ditto(args: string[]): { stdout: string; stderr: string; exitCode: number | null } {
  const proc = Bun.spawnSync(['bun', cliEntry, ...args], { cwd: dir, env: { ...process.env } });
  return {
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
    exitCode: proc.exitCode,
  };
}

const reviewerOutputFixture = (overrides: Partial<ReviewerOutput> = {}): ReviewerOutput =>
  ({
    schema_version: '0.1.0',
    id: 'rv_abcd1234',
    work_item_id: WI,
    kind: 'code-reviewer',
    reviewer: 'reviewer-profile',
    different_provider_than_generator: false,
    started_at: '2026-06-04T00:00:00Z',
    verdict: 'partial',
    evidence: [],
    findings: [],
    unverified: [],
    recommended_next_action: 'fix it',
    ...overrides,
  }) as ReviewerOutput;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-review-'));
  // ditto repo-root marker (findRepoRoot prefers .ditto) so resolveRepoRootForCreate
  // lands on this fixture, not the surrounding workspace.
  await mkdir(join(dir, '.ditto', 'local', 'work-items', WI), { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@t.t']);
  git(['config', 'user.name', 't']);
  await mkdir(join(dir, 'src', 'core'), { recursive: true });
  await mkdir(join(dir, 'src', 'controller'), { recursive: true });
  await writeFile(join(dir, 'src', 'core', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(dir, 'src', 'core', 'b.ts'), 'export const b = 2;\n');
  await writeFile(join(dir, 'src', 'controller', 'user.ts'), 'export const d = 4;\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ditto review --scope (WU-5)', () => {
  test('ac-11: --scope component:core resolves to the core file set + plan covers both roles', () => {
    const r = ditto(['review', '--scope', 'component:core', '--output', 'json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.unit).toBe('component:core');
    expect((out.files as string[]).sort()).toEqual(['src/core/a.ts', 'src/core/b.ts'].sort());
    // BOTH reviewer roles operate over the unit file set.
    expect(out.roles).toEqual(['code-reviewer', 'security-reviewer']);
    for (const b of out.batches) {
      expect(b.roles).toEqual(['code-reviewer', 'security-reviewer']);
    }
  });

  test('ac-11: --scope api resolves to the controllers/routes file set', () => {
    const r = ditto(['review', '--scope', 'api', '--output', 'json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.files).toEqual(['src/controller/user.ts']);
  });

  test('ac-13: a large unit (more files than one batch) reports batch progress + 0 silent drops', () => {
    const r = ditto(['review', '--scope', 'all', '--batch-size', '2', '--output', 'json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    // 3 src files, batch 2 → 2 batches.
    expect(out.resolvedCount).toBe(3);
    expect(out.batches.length).toBe(2);
    expect(out.progress).toBe('2/2 batches');
    // every file accounted: reviewed + dropped == resolved.
    expect(out.reviewedCount + (out.dropped as string[]).length).toBe(out.resolvedCount);
    expect(out.dropped).toEqual([]);
  });

  test('ac-13: a file cap drops overflow but LOGS each dropped file (no silent truncation)', () => {
    const r = ditto([
      'review',
      '--scope',
      'all',
      '--batch-size',
      '2',
      '--file-limit',
      '2',
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.resolvedCount).toBe(3);
    expect(out.reviewedCount).toBe(2);
    expect((out.dropped as string[]).length).toBe(1); // 1 over the cap, LOGGED
    expect(out.reviewedCount + (out.dropped as string[]).length).toBe(out.resolvedCount);
  });

  test('ac-12: --from role outputs aggregate into EXACTLY ONE unit ledger; high-risk-no-evidence blocks Stop', async () => {
    const codeFrom = join(dir, 'code-review.json');
    const secFrom = join(dir, 'sec-review.json');
    await writeFile(
      codeFrom,
      JSON.stringify(
        reviewerOutputFixture({
          kind: 'code-reviewer',
          findings: [{ severity: 'medium', file: 'src/core/b.ts', reason: 'unguarded null' }],
        }),
      ),
      'utf8',
    );
    await writeFile(
      secFrom,
      JSON.stringify(
        reviewerOutputFixture({
          kind: 'security-reviewer',
          findings: [{ severity: 'high', file: 'src/core/a.ts', reason: 'missing tenant check' }],
        }),
      ),
      'utf8',
    );

    const r = ditto([
      'review',
      '--scope',
      'component:core',
      '--from',
      `${codeFrom},${secFrom}`,
      '--work-item',
      WI,
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(0);

    // EXACTLY ONE ledger written.
    const ledgerPath = join(dir, '.ditto', 'local', 'work-items', WI, 'acg-review.json');
    const onDisk = JSON.parse(await readFile(ledgerPath, 'utf8'));
    const ledger = acgReviewGraph.parse(onDisk);

    // The high-risk security finding without evidence trips the REAL Stop gate function.
    const reasons = acgReviewForcesContinuation(ledger);
    expect(reasons.length).toBe(1);
    expect(reasons[0]).toContain('src/core/a.ts');
  });

  test('ac-12: a high-risk finding WITH evidence does NOT block', async () => {
    const secFrom = join(dir, 'sec-review.json');
    await writeFile(
      secFrom,
      JSON.stringify(
        reviewerOutputFixture({
          kind: 'security-reviewer',
          findings: [{ severity: 'high', file: 'src/core/a.ts', reason: 'tenant check' }],
        }),
      ),
      'utf8',
    );
    const r = ditto([
      'review',
      '--scope',
      'component:core',
      '--from',
      secFrom,
      '--work-item',
      WI,
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(0);

    // Attach evidence to the high-risk file, re-validate, and confirm the gate clears.
    const ledgerPath = join(dir, '.ditto', 'local', 'work-items', WI, 'acg-review.json');
    const onDisk = JSON.parse(await readFile(ledgerPath, 'utf8'));
    const withEvidence = acgReviewGraph.parse({
      ...onDisk,
      files: onDisk.files.map((f: { path?: string }) =>
        f.path === 'src/core/a.ts'
          ? { ...f, evidence: { kind: 'test', ref: 'tests/auth.test.ts' } }
          : f,
      ),
    });
    expect(acgReviewForcesContinuation(withEvidence)).toHaveLength(0);
  });
});
