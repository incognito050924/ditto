import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createWorkItem,
  finalizeWorkItem,
  loadWorkItem,
  recordVerdict,
  setCriteria,
  transitionWorkItem,
} from './store';

async function freshRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ditto-author-'));
}

const passEvidence = [
  { kind: 'test' as const, path: 'rebuild/x.test.ts', summary: 'green' },
];

describe('record store — per-criterion verdicts', () => {
  test('recordVerdict appends an event and the view folds it', async () => {
    const root = await freshRepo();
    await createWorkItem(root, { id: 'wi_v', title: 'v' });
    await setCriteria(root, 'wi_v', [{ id: 'ac1', statement: '기준 1' }]);
    await recordVerdict(root, 'wi_v', {
      criterion_id: 'ac1',
      verdict: 'pass',
      evidence: passEvidence,
      actor: 'me',
    });
    const loaded = await loadWorkItem(root, 'wi_v');
    expect(loaded.view.acceptance_criteria[0]?.verdict).toBe('pass');
    expect(loaded.record.acceptance_criteria[0]?.verdict).toBe('unverified');
    expect(loaded.events.filter((e) => e.kind === 'verdict')).toHaveLength(1);
  });

  test('recordVerdict refuses an unknown criterion', async () => {
    const root = await freshRepo();
    await createWorkItem(root, { id: 'wi_u', title: 'u' });
    await expect(
      recordVerdict(root, 'wi_u', {
        criterion_id: 'ghost',
        verdict: 'pass',
        evidence: passEvidence,
        actor: 'me',
      }),
    ).rejects.toThrow(/ghost/);
  });
});

describe('record store — criteria provenance lock (goalpost may not move)', () => {
  test('before any verdict, setCriteria replaces the placeholder set freely', async () => {
    const root = await freshRepo();
    await createWorkItem(root, { id: 'wi_c', title: 'c' });
    await setCriteria(root, 'wi_c', [{ id: 'tmp', statement: 'placeholder' }]);
    await setCriteria(root, 'wi_c', [
      { id: 'ac1', statement: '진짜 기준 1' },
      { id: 'ac2', statement: '진짜 기준 2' },
    ]);
    const loaded = await loadWorkItem(root, 'wi_c');
    expect(loaded.record.acceptance_criteria.map((c) => c.id)).toEqual([
      'ac1',
      'ac2',
    ]);
    expect(
      loaded.record.acceptance_criteria.some((c) => c.superseded),
    ).toBe(false);
  });

  test('after the first verdict, dropped criteria are marked superseded — never erased', async () => {
    const root = await freshRepo();
    await createWorkItem(root, { id: 'wi_l', title: 'l' });
    await setCriteria(root, 'wi_l', [
      { id: 'ac1', statement: '기준 1' },
      { id: 'ac2', statement: '기준 2' },
    ]);
    await recordVerdict(root, 'wi_l', {
      criterion_id: 'ac1',
      verdict: 'fail',
      evidence: [],
      actor: 'me',
    });

    // ac2를 빼고 ac3을 넣으려는 시도 — ac2는 superseded로 남아야 한다
    await setCriteria(root, 'wi_l', [
      { id: 'ac1', statement: '기준 1' },
      { id: 'ac3', statement: '기준 3' },
    ]);
    const loaded = await loadWorkItem(root, 'wi_l');
    const byId = new Map(
      loaded.record.acceptance_criteria.map((c) => [c.id, c]),
    );
    expect([...byId.keys()].sort()).toEqual(['ac1', 'ac2', 'ac3']);
    expect(byId.get('ac2')?.superseded).toBe(true);
    expect(byId.get('ac1')?.superseded).toBeUndefined();
    expect(byId.get('ac3')?.superseded).toBeUndefined();
  });
});

describe('record store — finalize batches details into record.json at close', () => {
  test('finalize(done) folds event verdicts into the persisted record.json', async () => {
    const root = await freshRepo();
    await createWorkItem(root, { id: 'wi_f', title: 'f' });
    await setCriteria(root, 'wi_f', [{ id: 'ac1', statement: '기준' }]);
    await transitionWorkItem(root, 'wi_f', { to: 'in_progress', actor: 'me' });
    await recordVerdict(root, 'wi_f', {
      criterion_id: 'ac1',
      verdict: 'pass',
      evidence: passEvidence,
      actor: 'me',
    });
    await finalizeWorkItem(root, 'wi_f', { status: 'done', actor: 'me' });

    // 디스크의 record.json 원본을 직접 확인 (view가 아니라)
    const raw = JSON.parse(
      await readFile(
        join(root, '.ditto', 'work-items', 'wi_f', 'record.json'),
        'utf8',
      ),
    ) as {
      status: string;
      closed_at: string | null;
      acceptance_criteria: Array<{ verdict: string; evidence: unknown[] }>;
    };
    expect(raw.status).toBe('done');
    expect(raw.closed_at).not.toBeNull();
    expect(raw.acceptance_criteria[0]?.verdict).toBe('pass');
    expect(raw.acceptance_criteria[0]?.evidence).toHaveLength(1);
  });

  test('finalize(partial) requires a re_entry contract and persists it', async () => {
    const root = await freshRepo();
    await createWorkItem(root, { id: 'wi_p', title: 'p' });
    await transitionWorkItem(root, 'wi_p', { to: 'in_progress', actor: 'me' });

    await expect(
      finalizeWorkItem(root, 'wi_p', { status: 'partial', actor: 'me' }),
    ).rejects.toThrow();

    await finalizeWorkItem(root, 'wi_p', {
      status: 'partial',
      actor: 'me',
      re_entry: { command: 'bun test rebuild/' },
    });
    const loaded = await loadWorkItem(root, 'wi_p');
    expect(loaded.record.status).toBe('partial');
    expect(loaded.record.re_entry?.command).toBe('bun test rebuild/');
    expect(loaded.view.status).toBe('partial');
  });

  test('finalize on a terminal item is refused (reopen first)', async () => {
    const root = await freshRepo();
    await createWorkItem(root, { id: 'wi_ff', title: 'ff' });
    await finalizeWorkItem(root, 'wi_ff', { status: 'abandoned', actor: 'me' });
    await expect(
      finalizeWorkItem(root, 'wi_ff', { status: 'done', actor: 'me' }),
    ).rejects.toThrow(/reopen/i);
  });
});
