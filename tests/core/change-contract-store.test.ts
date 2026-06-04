import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChangeContractStore } from '~/core/change-contract-store';
import { type AcgChangeContract, acgChangeContract } from '~/schemas/acg-change-contract';

function sample(workItemId: string): AcgChangeContract {
  return acgChangeContract.parse({
    schema_version: '0.1.0',
    kind: 'acg.change-contract.v1',
    work_item_id: workItemId,
    produced_by: 'agent',
    produced_at: '2026-06-05T00:00:00Z',
    purpose: 'forbidden_scope 집행 테스트',
    allowed_scope: [{ kind: 'glob', ref: 'src/acg/scope/**' }],
    forbidden_scope: [{ kind: 'path', ref: 'src/core/locked.ts' }],
    invariants: [],
    acceptance: [{ criterion: 'green', evidence_kind: 'test' }],
    risk_default: 'low',
    decision_ref: null,
  });
}

describe('ChangeContractStore', () => {
  test('write→read 왕복, 부재는 null', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ditto-cc-'));
    try {
      const store = new ChangeContractStore(dir);
      expect(await store.read('wi_ccabsent1')).toBeNull();

      const contract = sample('wi_ccstore001');
      await store.write('wi_ccstore001', contract);
      const back = await store.read('wi_ccstore001');
      expect(back?.forbidden_scope).toEqual(contract.forbidden_scope);
      expect(back?.purpose).toBe('forbidden_scope 집행 테스트');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
