import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Handoff } from '~/schemas/handoff';
import { HandoffRefStore } from './handoff-ref-store';
import { buildSessionHandoff, countHandoffRounds } from './handoff-store';

/**
 * WHY THIS TEST EXISTS (wi_260722g7h ac-rewire, coverage-sweep constraint):
 * `handoff_rounds` (autopilot-loop `computePostCost` + the intent-quality doctor
 * row, both summed into `post_cost`) used to read the OLD file store's ACTIVE
 * count. Under the hidden-ref handoff model, consume = an immediate deletion commit on
 * `refs/ditto/handoffs`, so any "currently pending" data source structurally
 * converges to 0 the moment a handoff is picked up — the continuation-churn metric
 * would silently die while looking wired. The sweep constraint therefore
 * REDEFINES the metric as a PERSISTENT record read from the ref's history.
 *
 * AC assertions pinned here:
 *  - a written-then-CONSUMED handoff still counts as 1 round (the non-zero-
 *    convergence clause — this is the assertion that fails against a
 *    pending-count implementation);
 *  - re-issue after consume accumulates (2 rounds), matching "rounds = handoffs
 *    issued", not "handoffs pending";
 *  - scope-locality edges: an unrelated work item counts 0, session-scoped
 *    handoffs never count toward a work item, and a repo with an unborn ref
 *    (or no git repo at all) degrades fail-open to 0.
 * All against a throwaway local git fixture — no network, no real origin.
 */

const fixtures: string[] = [];

afterEach(async () => {
  while (fixtures.length > 0) {
    const dir = fixtures.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function git(dir: string, args: string[]): { exitCode: number; stdout: string } {
  const proc = Bun.spawnSync(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  return { exitCode: proc.exitCode, stdout: proc.stdout?.toString() ?? '' };
}

/** A throwaway git repo with one commit on `main` and a configured identity. */
async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ditto-handoff-rounds-'));
  fixtures.push(dir);
  expect(git(dir, ['init', '-b', 'main']).exitCode).toBe(0);
  expect(git(dir, ['config', 'user.email', 'fixture@example.invalid']).exitCode).toBe(0);
  expect(git(dir, ['config', 'user.name', 'Fixture']).exitCode).toBe(0);
  await Bun.write(join(dir, 'README.md'), 'fixture\n');
  expect(git(dir, ['add', 'README.md']).exitCode).toBe(0);
  expect(git(dir, ['commit', '-m', 'init']).exitCode).toBe(0);
  return dir;
}

const WI = 'wi_roundsfixture1';

/** A work_item-scoped handoff for WI (a full WorkItem is not needed — swap the scope). */
function workItemHandoff(workItemId: string, createdAt: string): Handoff {
  return {
    ...buildSessionHandoff({
      sessionId: 'ignored',
      originalIntent: 'count rounds persistently',
      fromContext: 'unit-test session',
      currentState: 'mid-flight',
      nextFirstCheck: 'the rounds counter',
      now: new Date(createdAt),
    }),
    scope: { kind: 'work_item', work_item_id: workItemId },
  };
}

describe('countHandoffRounds (persistent handoff_rounds source)', () => {
  test('a consumed handoff still counts as a round — the count must NOT converge to 0 on consume', async () => {
    const repo = await makeRepo();
    const store = new HandoffRefStore(repo);
    const res = store.write(workItemHandoff(WI, '2026-01-02T03:04:05.000Z'), { author: 'alice' });

    // Pending: 1 round.
    expect(countHandoffRounds(repo, WI)).toBe(1);

    // Consume = deletion commit; the ROUND persists (this is the AC assertion).
    expect(store.consume(res.stem).status).toBe('consumed');
    expect(countHandoffRounds(repo, WI)).toBe(1);
  });

  test('re-issuing after consume accumulates rounds (write→consume→write→consume = 2)', async () => {
    const repo = await makeRepo();
    const store = new HandoffRefStore(repo);
    const first = store.write(workItemHandoff(WI, '2026-01-02T03:04:05.000Z'), { author: 'alice' });
    expect(store.consume(first.stem).status).toBe('consumed');
    const second = store.write(workItemHandoff(WI, '2026-01-03T03:04:05.000Z'), {
      author: 'alice',
    });
    expect(store.consume(second.stem).status).toBe('consumed');

    expect(countHandoffRounds(repo, WI)).toBe(2);
  });

  test('scope-local: unrelated work items and session-scoped handoffs count 0', async () => {
    const repo = await makeRepo();
    const store = new HandoffRefStore(repo);
    store.write(workItemHandoff(WI, '2026-01-02T03:04:05.000Z'), { author: 'alice' });
    store.write(
      buildSessionHandoff({
        sessionId: 'sess-other',
        originalIntent: 'unrelated session handoff',
        fromContext: 'unit-test session',
        currentState: 'mid-flight',
        nextFirstCheck: 'nothing',
        now: new Date('2026-01-02T03:04:05.000Z'),
      }),
      { author: 'alice' },
    );

    expect(countHandoffRounds(repo, 'wi_othernoop0001')).toBe(0);
    expect(countHandoffRounds(repo, WI)).toBe(1);
  });

  test('fail-open 0-state: unborn ref and a non-repo directory both count 0, never throw', async () => {
    const repo = await makeRepo(); // no handoff ever written → unborn ref
    expect(countHandoffRounds(repo, WI)).toBe(0);

    const notARepo = await mkdtemp(join(tmpdir(), 'ditto-handoff-norepo-'));
    fixtures.push(notARepo);
    expect(countHandoffRounds(notARepo, WI)).toBe(0);
  });
});
