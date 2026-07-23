import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IntentArtifact } from '../schemas/intent-artifact';
import {
  IntentAlreadyLockedError,
  IntentBindingMismatchError,
  lockIntent,
} from './intent';
import { createWorkItem, loadWorkItem, setCriteria } from './store';

function artifact(workItemId: string): IntentArtifact {
  return {
    work_item_id: workItemId,
    root_goal: '완료 게이트를 A3 위에 세운다',
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
    risks: [{ statement: '레이어 우회 가능성', severity: 'medium' }],
  };
}

async function freshRepoWithItem(id: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ditto-intent-'));
  await createWorkItem(root, { id, title: 'intent 대상' });
  return root;
}

describe('lockIntent — 의도 산출물이 A3 record에 결박된다', () => {
  test('lands root_goal, criteria+oracles, risks, and the frozen id-set in record.json', async () => {
    const root = await freshRepoWithItem('wi_i1');
    await lockIntent(root, 'wi_i1', artifact('wi_i1'));

    const raw = JSON.parse(
      await readFile(
        join(root, '.ditto', 'work-items', 'wi_i1', 'record.json'),
        'utf8',
      ),
    ) as {
      goal: string;
      acceptance_criteria: Array<{ id: string; oracle?: { statement: string } }>;
      risks: Array<{ statement: string }>;
      intent_lock: { criteria: string[] };
    };
    expect(raw.goal).toBe('완료 게이트를 A3 위에 세운다');
    expect(raw.acceptance_criteria[0]?.oracle?.statement).toBe(
      'bun test rebuild/ exit 0',
    );
    expect(raw.risks).toHaveLength(1);
    expect(raw.intent_lock.criteria).toEqual(['ac1']);
  });

  test('refuses an artifact bound to a different work item (one intent = one unit)', async () => {
    const root = await freshRepoWithItem('wi_i2');
    await expect(
      lockIntent(root, 'wi_i2', artifact('wi_other')),
    ).rejects.toThrow(IntentBindingMismatchError);
  });

  test('refuses re-locking an already-locked record', async () => {
    const root = await freshRepoWithItem('wi_i3');
    await lockIntent(root, 'wi_i3', artifact('wi_i3'));
    await expect(
      lockIntent(root, 'wi_i3', artifact('wi_i3')),
    ).rejects.toThrow(IntentAlreadyLockedError);
  });
});

describe('intent lock enforcement — 잠긴 AC 집합은 축소 불가, 추가만 허용', () => {
  test('setCriteria dropping a locked id is inadmissible', async () => {
    const root = await freshRepoWithItem('wi_i4');
    await lockIntent(root, 'wi_i4', artifact('wi_i4'));
    await expect(
      setCriteria(root, 'wi_i4', [{ id: 'ac_new', statement: '다른 기준' }]),
    ).rejects.toThrow(/intent-lock/i);
  });

  test('additions are allowed and locked criteria keep their oracles', async () => {
    const root = await freshRepoWithItem('wi_i5');
    await lockIntent(root, 'wi_i5', artifact('wi_i5'));
    await setCriteria(root, 'wi_i5', [
      { id: 'ac1', statement: '테스트 green' },
      { id: 'ac2', statement: '발견된 추가 범위' },
    ]);
    const { record } = await loadWorkItem(root, 'wi_i5');
    expect(record.acceptance_criteria.map((c) => c.id)).toEqual([
      'ac1',
      'ac2',
    ]);
    // 잠긴 ac1의 oracle이 재설정 후에도 보존된다 (AC↔oracle 수렴 유지)
    expect(record.acceptance_criteria[0]?.oracle?.criterion_id).toBe('ac1');
    // 잠금 집합은 원래 의도 그대로다 (추가는 잠금을 넓히지 않는다)
    expect(record.intent_lock?.criteria).toEqual(['ac1']);
  });
});
