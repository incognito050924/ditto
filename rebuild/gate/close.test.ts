import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AcOracle } from '../schemas/oracle';
import {
  createWorkItem,
  loadWorkItem,
  recordVerdict,
  setCriteria,
  transitionWorkItem,
} from '../record/store';
import { closeWorkItemWithGates, MissingReEntryError } from './close';

async function repoWithPassingItem(id: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ditto-close-'));
  await createWorkItem(root, { id, title: 'close 대상' });
  await setCriteria(root, id, [{ id: 'ac1', statement: '테스트 green' }]);
  await transitionWorkItem(root, id, { to: 'in_progress', actor: 'me' });
  await recordVerdict(root, id, {
    criterion_id: 'ac1',
    verdict: 'pass',
    evidence: [
      { kind: 'test', path: 'rebuild/x.test.ts', summary: '전체 green exit 0' },
    ],
    actor: 'me',
  });
  return root;
}

const oracles: AcOracle[] = [
  {
    criterion_id: 'ac1',
    statement: 'bun test가 exit 0',
    verification_method: 'dynamic_test',
    direction: 'forward',
    maps_to: { kind: 'ac', ref: 'ac1' },
  },
];

const greenBarrier = { command: 'bun test rebuild/', exitCode: 0 };
const reEntry = { command: 'bun test rebuild/ 재실행 후 재시도' };

describe('closeWorkItemWithGates — 완료 = per-AC oracle AND barrier AND 잔여 0 AND 충돌 무차단', () => {
  test('happy path lands done and batches the pass into record.json', async () => {
    const root = await repoWithPassingItem('wi_ok');
    const outcome = await closeWorkItemWithGates(root, 'wi_ok', {
      actor: 'me',
      mode: 'autopilot',
      oracles,
      barrier: greenBarrier,
    });
    expect(outcome.final_status).toBe('done');
    expect((await loadWorkItem(root, 'wi_ok')).record.status).toBe('done');
  });

  test('barrier failed can never land done — honest partial landing with re_entry', async () => {
    const root = await repoWithPassingItem('wi_red');
    const outcome = await closeWorkItemWithGates(root, 'wi_red', {
      actor: 'me',
      mode: 'autopilot',
      oracles,
      barrier: { command: 'bun test rebuild/', exitCode: 1 },
      re_entry: reEntry,
    });
    expect(outcome.final_status).toBe('partial');
    expect(outcome.gates.barrier.outcome).toBe('failed');
    expect((await loadWorkItem(root, 'wi_red')).record.re_entry).toBeDefined();
  });

  test('non-pass landing without a re_entry contract is refused loudly', async () => {
    const root = await repoWithPassingItem('wi_nore');
    await expect(
      closeWorkItemWithGates(root, 'wi_nore', {
        actor: 'me',
        mode: 'autopilot',
        oracles,
        barrier: { command: 'bun test rebuild/', exitCode: 1 },
      }),
    ).rejects.toThrow(MissingReEntryError);
  });

  test('barrier unrunnable degrades to unverified and still lands (proceed, no fabricated green)', async () => {
    const root = await repoWithPassingItem('wi_unrun');
    const outcome = await closeWorkItemWithGates(root, 'wi_unrun', {
      actor: 'me',
      mode: 'autopilot',
      oracles,
      barrier: { command: 'bun test rebuild/', exitCode: 127 },
      re_entry: reEntry,
    });
    expect(outcome.final_status).toBe('unverified');
    expect(outcome.gates.barrier.outcome).toBe('unrunnable');
  });

  test('an intent-level decision conflict lands blocked (fail-closed, no live wait)', async () => {
    const root = await repoWithPassingItem('wi_conf');
    const outcome = await closeWorkItemWithGates(root, 'wi_conf', {
      actor: 'me',
      mode: 'autopilot',
      oracles,
      barrier: greenBarrier,
      conflicts: [
        {
          adr: 'ADR-0021',
          kind: 'forbid',
          level: 'intent',
          basis: '요청 목적이 ADR-0021이 금지한 표면을 요구',
        },
      ],
      re_entry: reEntry,
    });
    expect(outcome.final_status).toBe('blocked');
    expect(outcome.gates.conflicts.decision).toBe('block');
  });

  test('a method-level conflict does not block but its align disposition is disclosed', async () => {
    const root = await repoWithPassingItem('wi_meth');
    const outcome = await closeWorkItemWithGates(root, 'wi_meth', {
      actor: 'me',
      mode: 'autopilot',
      oracles,
      barrier: greenBarrier,
      conflicts: [
        {
          adr: 'ADR-0006',
          kind: 'require',
          level: 'method',
          basis: 'ADR-0006이 CodeQL 단일 엔진을 요구 — 그대로 따름',
        },
      ],
    });
    expect(outcome.final_status).toBe('done');
    expect(outcome.gates.conflicts.routed[0]?.disposition).toBe('align');
    expect(outcome.gates.conflicts.routed[0]?.basis).toContain('ADR-0006');
  });

  test('residual unverified AC blocks pass even with a green barrier', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ditto-close-'));
    await createWorkItem(root, { id: 'wi_resid', title: 'r' });
    await setCriteria(root, 'wi_resid', [
      { id: 'ac1', statement: 'a' },
      { id: 'ac2', statement: 'b' },
    ]);
    await transitionWorkItem(root, 'wi_resid', {
      to: 'in_progress',
      actor: 'me',
    });
    await recordVerdict(root, 'wi_resid', {
      criterion_id: 'ac1',
      verdict: 'pass',
      evidence: [{ kind: 'test', path: 'x.test.ts', summary: 'green' }],
      actor: 'me',
    });
    // ac2는 unverified로 남음
    const outcome = await closeWorkItemWithGates(root, 'wi_resid', {
      actor: 'me',
      mode: 'autopilot',
      oracles: [
        ...oracles,
        {
          criterion_id: 'ac2',
          statement: 'b도 검증',
          verification_method: 'dynamic_test',
          direction: 'forward',
          maps_to: { kind: 'ac', ref: 'ac2' },
        },
      ],
      barrier: greenBarrier,
      re_entry: reEntry,
    });
    expect(outcome.final_status).toBe('unverified');
    expect(outcome.gates.residual.blockers.unverified).toEqual(['ac2']);
  });

  test('open declared risk blocks pass-close until disposed', async () => {
    const root = await repoWithPassingItem('wi_risk');
    const outcome = await closeWorkItemWithGates(root, 'wi_risk', {
      actor: 'me',
      mode: 'autopilot',
      oracles,
      barrier: greenBarrier,
      open_risks: ['마이그레이션 롤백 미검증'],
      re_entry: reEntry,
    });
    expect(outcome.final_status).toBe('unverified');
    expect(outcome.gates.residual.blockers.open_risks).toHaveLength(1);
  });

  test('an AC whose oracle is missing cannot close pass (presence-gated)', async () => {
    const root = await repoWithPassingItem('wi_noora');
    const outcome = await closeWorkItemWithGates(root, 'wi_noora', {
      actor: 'me',
      mode: 'autopilot',
      oracles: [], // oracle 없음 — LLM 주장만으로는 완료 불가
      barrier: greenBarrier,
      re_entry: reEntry,
    });
    expect(outcome.final_status).toBe('unverified');
  });
});
