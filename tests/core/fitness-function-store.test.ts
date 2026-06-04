import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FitnessFunctionStore } from '~/core/fitness-function-store';
import { type AcgFitnessFunction, acgFitnessFunction } from '~/schemas/acg-fitness-function';

function sample(id: string): AcgFitnessFunction {
  return acgFitnessFunction.parse({
    schema_version: '0.1.0',
    kind: 'acg.fitness-function.v1',
    work_item_id: 'wi_fitstore001',
    produced_by: 'agent',
    produced_at: '2026-06-05T00:00:00Z',
    id,
    statement: 'always passes',
    fitness_kind: 'architectural',
    evaluator: { mode: 'deterministic', spec: 'true' },
    cadence: { per_change: true, periodic: 'none' },
    on_violation: 'warn',
  });
}

describe('FitnessFunctionStore', () => {
  test('write→read 왕복, 부재 null, 빈 배열 저장', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ditto-ff-'));
    try {
      const store = new FitnessFunctionStore(dir);
      expect(await store.read('wi_ffabsent1')).toBeNull();

      const fns = [sample('ff-a'), sample('ff-b')];
      await store.write('wi_fitstore001', fns);
      const back = await store.read('wi_fitstore001');
      expect(back?.map((f) => f.id)).toEqual(['ff-a', 'ff-b']);

      await store.write('wi_fitempty01', []);
      expect(await store.read('wi_fitempty01')).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
