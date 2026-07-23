import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { lockIntent } from '../record/intent';
import {
  createWorkItem,
  loadWorkItem,
  recordVerdict,
  transitionWorkItem,
} from '../record/store';
import type { IntentArtifact } from '../schemas/intent-artifact';
import { closeWorkItemWithGates } from './close';

function artifact(id: string, withRisk: boolean): IntentArtifact {
  return {
    work_item_id: id,
    root_goal: '의도→검증→완료 사슬 실증',
    criteria: [
      {
        id: 'ac1',
        statement: '테스트 green',
        oracle: {
          criterion_id: 'ac1',
          statement: 'bun test rebuild/ exit 0',
          verification_method: 'dynamic_test',
          direction: 'forward',
          maps_to: { kind: 'ac', ref: 'ac1' },
        },
      },
    ],
    risks: withRisk
      ? [{ statement: '되돌리기 어려운 경로', severity: 'high' }]
      : [],
  };
}

async function lockedItem(id: string, withRisk: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ditto-ic-'));
  await createWorkItem(root, { id, title: 'chain' });
  await lockIntent(root, id, artifact(id, withRisk));
  await transitionWorkItem(root, id, { to: 'in_progress', actor: 'me' });
  await recordVerdict(root, id, {
    criterion_id: 'ac1',
    verdict: 'pass',
    evidence: [
      { kind: 'test', path: 'rebuild/x.test.ts', summary: 'green exit 0' },
    ],
    actor: 'me',
  });
  return root;
}

const greenBarrier = { command: 'bun test rebuild/', exitCode: 0 };
const reEntry = { command: '위험 처분 후 재시도' };

describe('intent→close 사슬 — record에 결박된 oracle과 risk가 완료 판정을 구동한다', () => {
  test('close reads oracles from the record (no external oracle input needed)', async () => {
    const root = await lockedItem('wi_chain', false);
    const outcome = await closeWorkItemWithGates(root, 'wi_chain', {
      actor: 'me',
      mode: 'autopilot',
      barrier: greenBarrier,
    });
    expect(outcome.final_status).toBe('done');
    expect(outcome.gates.oracles['ac1']?.decision).toBe('pass');
  });

  test('declared risk from the intent survives to the completion gate: open risk blocks pass', async () => {
    const root = await lockedItem('wi_chainr', true);
    const blocked = await closeWorkItemWithGates(root, 'wi_chainr', {
      actor: 'me',
      mode: 'autopilot',
      barrier: greenBarrier,
      re_entry: reEntry,
    });
    expect(blocked.final_status).toBe('unverified');
    expect(blocked.gates.residual.blockers.open_risks).toEqual([
      '되돌리기 어려운 경로',
    ]);
  });

  test('a disposed risk no longer blocks (accepted/mitigated is a valid disposition)', async () => {
    const root = await lockedItem('wi_chaind', true);
    // 위험을 처분(accepted)으로 갱신 — record 저작 필드 갱신 경로
    const { record } = await loadWorkItem(root, 'wi_chaind');
    const { writeJson } = await import('../util/fs');
    const { workItemRecord } = await import('../schemas/work-item-record');
    await writeJson(
      join(root, '.ditto', 'work-items', 'wi_chaind', 'record.json'),
      workItemRecord,
      {
        ...record,
        risks: [{ ...record.risks[0]!, disposition: 'accepted' as const }],
      },
    );
    const outcome = await closeWorkItemWithGates(root, 'wi_chaind', {
      actor: 'me',
      mode: 'autopilot',
      barrier: greenBarrier,
    });
    expect(outcome.final_status).toBe('done');
  });
});
