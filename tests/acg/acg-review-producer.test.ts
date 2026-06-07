import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcgReviewStore } from '~/core/acg-review-store';
import { acgReviewForcesContinuation } from '~/hooks/stop';
import { acgReviewGraph } from '~/schemas/acg-review-graph';
import type { ReviewerOutput } from '~/schemas/reviewer-output';

const cliEntry = join(process.cwd(), 'src/cli/index.ts');
const WI = 'wi_prod0001';

let dir: string;

function git(args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
}

function spawnDitto(args: string[]): { stdout: string; stderr: string; exitCode: number | null } {
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
    findings: [
      { severity: 'high', file: 'src/payment/charge.ts', reason: 'no idempotency key' },
      { severity: 'low', file: 'src/util/log.ts', reason: 'noisy log' },
    ],
    unverified: [{ item: 'concurrency under load', reason: 'no load test' }],
    recommended_next_action: 'add an idempotency key',
    ...overrides,
  }) as ReviewerOutput;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-acgprod-'));
  git(['init']);
  await mkdir(join(dir, '.ditto', 'local', 'work-items', WI), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('AcgReviewStore', () => {
  test('write → get round trip, exists reflects presence', async () => {
    const store = new AcgReviewStore(dir);
    expect(await store.exists(WI)).toBe(false);
    const graph = acgReviewGraph.parse({
      kind: 'acg.review-graph.v1',
      files: [{ path: 'a.ts', risk: 'high', risk_reason: 'r', unresolved: false }],
      human_review_set: ['a.ts'],
    });
    await store.write(WI, graph);
    expect(await store.exists(WI)).toBe(true);
    expect(await store.get(WI)).toEqual(graph);
  });

  test('writes to .ditto/local/work-items/<wi>/acg-review.json', async () => {
    const store = new AcgReviewStore(dir);
    await store.write(
      WI,
      acgReviewGraph.parse({ kind: 'acg.review-graph.v1', files: [], human_review_set: [] }),
    );
    const onDisk = await readFile(
      join(dir, '.ditto', 'local', 'work-items', WI, 'acg-review.json'),
      'utf8',
    );
    expect(JSON.parse(onDisk).kind).toBe('acg.review-graph.v1');
  });
});

describe('ditto acg-review CLI (producer)', () => {
  test('projects a reviewer-output into a stop-readable ledger', async () => {
    const from = join(dir, 'reviewer-output.json');
    await writeFile(from, JSON.stringify(reviewerOutputFixture()), 'utf8');

    const res = spawnDitto(['acg-review', '--from', from, '--work-item', WI, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    // 2 findings + 1 unverified = 3 files; one high-risk finding has no evidence.
    expect(payload.files).toBe(3);
    expect(payload.high_risk_without_evidence).toBe(1);

    // The on-disk ledger is acg.review-graph.v1 valid AND trips the real Stop gate.
    const onDisk = JSON.parse(
      await readFile(join(dir, '.ditto', 'local', 'work-items', WI, 'acg-review.json'), 'utf8'),
    );
    const ledger = acgReviewGraph.parse(onDisk);
    const reasons = acgReviewForcesContinuation(ledger);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('src/payment/charge.ts');
  });

  test('work_item_id defaults to the reviewer-output field when --work-item omitted', async () => {
    const from = join(dir, 'reviewer-output.json');
    await writeFile(from, JSON.stringify(reviewerOutputFixture()), 'utf8');
    const res = spawnDitto(['acg-review', '--from', from, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout).work_item_id).toBe(WI);
  });

  test('deterministic: same reviewer-output → byte-identical ledger', async () => {
    const from = join(dir, 'reviewer-output.json');
    await writeFile(from, JSON.stringify(reviewerOutputFixture()), 'utf8');
    const ledgerPath = join(dir, '.ditto', 'local', 'work-items', WI, 'acg-review.json');

    spawnDitto(['acg-review', '--from', from, '--work-item', WI]);
    const first = await readFile(ledgerPath, 'utf8');
    spawnDitto(['acg-review', '--from', from, '--work-item', WI]);
    const second = await readFile(ledgerPath, 'utf8');
    expect(second).toBe(first);
  });

  test('fail-closed: missing reviewer-output → non-zero exit, no ledger written', async () => {
    const res = spawnDitto(['acg-review', '--from', join(dir, 'nope.json'), '--work-item', WI]);
    expect(res.exitCode).not.toBe(0);
    expect(await new AcgReviewStore(dir).exists(WI)).toBe(false);
  });

  test('fail-closed: invalid reviewer-output JSON → non-zero exit, no ledger written', async () => {
    const from = join(dir, 'bad.json');
    await writeFile(from, '{ not a valid reviewer output', 'utf8');
    const res = spawnDitto(['acg-review', '--from', from, '--work-item', WI]);
    expect(res.exitCode).not.toBe(0);
    expect(await new AcgReviewStore(dir).exists(WI)).toBe(false);
  });

  test('all-low-risk review produces a ledger that does NOT block', async () => {
    const from = join(dir, 'reviewer-output.json');
    await writeFile(
      from,
      JSON.stringify(
        reviewerOutputFixture({
          findings: [{ severity: 'low', file: 'src/util/log.ts', reason: 'noisy log' }],
          unverified: [],
        }),
      ),
      'utf8',
    );
    const res = spawnDitto(['acg-review', '--from', from, '--work-item', WI, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout).high_risk_without_evidence).toBe(0);
    const ledger = acgReviewGraph.parse(
      JSON.parse(
        await readFile(join(dir, '.ditto', 'local', 'work-items', WI, 'acg-review.json'), 'utf8'),
      ),
    );
    expect(acgReviewForcesContinuation(ledger)).toHaveLength(0);
  });
});
