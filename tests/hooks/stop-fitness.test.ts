import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FitnessFunctionStore } from '~/core/fitness-function-store';
import { maybeRunFitness } from '~/hooks/stop';
import { type AcgFitnessFunction, acgFitnessFunction } from '~/schemas/acg-fitness-function';

function fn(spec: string): AcgFitnessFunction {
  return acgFitnessFunction.parse({
    schema_version: '0.1.0',
    kind: 'acg.fitness-function.v1',
    work_item_id: 'wi_stopfit0001',
    produced_by: 'agent',
    produced_at: '2026-06-05T00:00:00Z',
    id: 'ff-stop',
    statement: 'no violations on stop',
    fitness_kind: 'architectural',
    evaluator: { mode: 'deterministic', spec },
    cadence: { per_change: true, periodic: 'none' },
    on_violation: 'block',
  });
}

async function outcome(dir: string): Promise<string | undefined> {
  const raw = JSON.parse(await readFile(join(dir, 'assurance-snapshot.json'), 'utf8'));
  return raw.results?.[0]?.outcome;
}

describe('maybeRunFitness — stop 자동 트리거', () => {
  test('위반 없는 cmd → snapshot pass', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ditto-stopfit-'));
    try {
      await new FitnessFunctionStore(dir).write('wi_stopfit0001', [fn('true')]);
      await maybeRunFitness(
        dir,
        'wi_stopfit0001',
        join(dir, '.ditto', 'work-items', 'wi_stopfit0001'),
      );
      expect(await outcome(join(dir, '.ditto', 'work-items', 'wi_stopfit0001'))).toBe('pass');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('위반 출력 cmd(on_violation=block) → snapshot fail', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ditto-stopfit-'));
    try {
      const wdir = join(dir, '.ditto', 'work-items', 'wi_stopfit0001');
      await new FitnessFunctionStore(dir).write('wi_stopfit0001', [fn('echo violation-1')]);
      await maybeRunFitness(dir, 'wi_stopfit0001', wdir);
      expect(await outcome(wdir)).toBe('fail');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('fitness 미정의 → snapshot을 쓰지 않음(fail-open, 기존 동작)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ditto-stopfit-'));
    try {
      const wdir = join(dir, '.ditto', 'work-items', 'wi_nofit000001');
      await maybeRunFitness(dir, 'wi_nofit000001', wdir);
      const exists = await Bun.file(join(wdir, 'assurance-snapshot.json')).exists();
      expect(exists).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
