import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConvergenceStore, buildConvergence } from '~/core/convergence-store';
import { convergenceGate } from '~/core/gates';
import type { DecisionLedgerEntry } from '~/schemas/convergence';

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-conv-'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const findingActed: DecisionLedgerEntry = {
  id: 'OBJ-1',
  round: 1,
  objection: 'empty-input boundary fails',
  kind: 'finding',
  criterion_id: 'ac-2',
  severity: 'high',
  admissible: true,
  status: 'acted',
  confidence: 'high',
  backed_by: [{ kind: 'command', command: 'bun test', summary: '1 failed then fixed' }],
  reason: 'criterion-linked admissible; acted',
  supersedes: null,
};
const findingDeferred: DecisionLedgerEntry = {
  ...findingActed,
  id: 'OBJ-2',
  status: 'deferred',
  reason: 'admissible but still open',
};

const input = (overrides: Record<string, unknown> = {}) => ({
  workItemId: 'wi_convbuild',
  targetRef: 'AC-set',
  roundCap: 3,
  roundsRun: 2,
  versions: [
    { version: 1, score: 0.7, evidence_refs: [] },
    { version: 2, score: 0.92, evidence_refs: [] },
  ],
  ledger: [findingActed],
  completionGateVerdict: 'pass' as const,
  ...overrides,
});

describe('buildConvergence (deterministic ratchet)', () => {
  test('completion pass + no open admissible => converged, gate passes', () => {
    const c = buildConvergence(input());
    expect(c.selected_version).toBe(2); // argmax(0.7, 0.92)
    expect(c.open_admissible_count).toBe(0);
    expect(c.gate.converged).toBe(true);
    expect(c.exit.reason).toBe('converged');
    expect(c.exit.next_handoff_path).toBeNull();
    expect(convergenceGate(c).pass).toBe(true);
  });

  test('an open admissible objection at the cap => not converged, but gate closes (ledger_only floor)', () => {
    const c = buildConvergence(input({ ledger: [findingActed, findingDeferred], roundsRun: 3 }));
    expect(c.open_admissible_count).toBe(1);
    expect(c.gate.converged).toBe(false);
    expect(c.exit.reason).toBe('cap_reached');
    expect(c.exit.next_handoff_path).not.toBeNull();
    // Liveness fix (wi_260719agy): cap_reached is a valid ledger_only closure — the
    // convergence gate must NOT re-force a round on it (that would livelock). The open
    // objection is carried by the handoff / completion gate, not spun forever here.
    expect(convergenceGate(c).pass).toBe(true);
  });

  test('an open admissible objection with budget remaining (blocked) => gate still fails', () => {
    // roundsRun (1) < roundCap (3): budget remains, so this is a genuine block, NOT the
    // ledger_only floor — the gate must still force another round.
    const c = buildConvergence(input({ ledger: [findingActed, findingDeferred], roundsRun: 1 }));
    expect(c.exit.reason).toBe('blocked');
    expect(convergenceGate(c).pass).toBe(false);
  });

  test('selected_version is argmax even when the last version scores lower', () => {
    const c = buildConvergence(
      input({
        versions: [
          { version: 1, score: 0.95, evidence_refs: [] },
          { version: 2, score: 0.6, evidence_refs: [] },
        ],
      }),
    );
    expect(c.selected_version).toBe(1);
  });

  test('completion not pass => not converged even with no open admissible', () => {
    // roundsRun (2) < roundCap (3) ⇒ exit.reason='blocked' (budget remains), so the
    // gate still fails — non-convergence with budget left is a genuine block.
    const c = buildConvergence(input({ completionGateVerdict: 'partial', roundsRun: 2 }));
    expect(c.gate.converged).toBe(false);
    expect(c.exit.reason).toBe('blocked');
    expect(convergenceGate(c).pass).toBe(false);
  });
});

describe('ConvergenceStore append-only ratchet', () => {
  test('appending an open admissible objection flips converged false and persists', async () => {
    const store = new ConvergenceStore(repo);
    await store.write(buildConvergence(input()));
    expect((await store.get('wi_convbuild')).gate.converged).toBe(true);

    const after = await store.appendLedgerEntry('wi_convbuild', findingDeferred);
    expect(after.decision_ledger).toHaveLength(2);
    expect(after.open_admissible_count).toBe(1);
    expect(after.gate.converged).toBe(false);
    // persisted
    expect((await store.get('wi_convbuild')).gate.converged).toBe(false);
  });
});
