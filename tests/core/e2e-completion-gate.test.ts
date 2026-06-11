import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkE2eCompletionGate } from '~/core/e2e/completion-gate';
import { regressionGatePath } from '~/core/e2e/regression-gate';

/**
 * dialectic-1 O-4/O-18 — 완료측 결정론 체크. `autopilot complete`가 e2e 의무
 * 두 가지를 기계로 확인한다: ① 웹 표면 변경이면 제안 결정(e2e_accept|decline)
 * 레코드가 있어야 한다, ② 변경과 교차하는 여정이 있으면 regression-gate
 * 레코드가 존재하고 pass여야 하며 현재 changed_files를 커버해야 한다. 게이트
 * 호출을 에이전트 기억에 맡기지 않는 것이 목적이다.
 */

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'ditto-e2egate-'));
});
afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

const journeyDoc = `---
ditto_journey: v1
id: jrn-home
name: 홈 여정
description: 홈 화면 보호
surfaces:
  - "component:src/pages/**"
---

1. [s1] 방문: /
`;

async function seedJourney() {
  await mkdir(join(repoRoot, 'e2e', 'journeys'), { recursive: true });
  await mkdir(join(repoRoot, 'e2e', 'generated'), { recursive: true });
  await Bun.write(join(repoRoot, 'e2e', 'journeys', 'home.journey.md'), journeyDoc);
  await Bun.write(
    join(repoRoot, 'e2e', 'generated', 'home.spec.ts'),
    '// @ditto-generated\ntest("jrn-home · 기본", () => {});\n',
  );
}

async function seedRegressionRecord(result: string, changedPaths: string[], workItemId = 'wi_g') {
  const path = regressionGatePath(repoRoot, workItemId);
  await mkdir(join(path, '..'), { recursive: true });
  await Bun.write(
    path,
    JSON.stringify({
      work_item: workItemId,
      run_id: 'rg-1',
      changed_paths: changedPaths,
      selected: [],
      auto_selected: [],
      journey_results: [],
      invalid_journeys: [],
      result,
      failures: [],
      reason: 'seeded',
      recorded_at: new Date().toISOString(),
    }),
  );
}

describe('checkE2eCompletionGate', () => {
  test('웹 표면 없음 + 교차 여정 없음 → 위반 없음', async () => {
    const v = await checkE2eCompletionGate(repoRoot, {
      workItemId: 'wi_g',
      changedFiles: ['docs/readme.md'],
      decisions: [],
    });
    expect(v).toEqual([]);
  });

  test('웹 표면 변경 + 제안 결정 부재 → proposal_missing (O-18)', async () => {
    const v = await checkE2eCompletionGate(repoRoot, {
      workItemId: 'wi_g',
      changedFiles: ['src/pages/Home.tsx'],
      decisions: [],
    });
    expect(v.map((x) => x.code)).toContain('proposal_missing');
  });

  test('웹 표면 변경 + decline 결정 → proposal 위반 없음 (거절도 결정이다)', async () => {
    const v = await checkE2eCompletionGate(repoRoot, {
      workItemId: 'wi_g',
      changedFiles: ['src/pages/Home.tsx'],
      decisions: [{ decision: 'e2e_decline' }],
    });
    expect(v.filter((x) => x.code === 'proposal_missing')).toEqual([]);
  });

  test('교차 여정 존재 + regression 레코드 부재 → regression_missing (O-4)', async () => {
    await seedJourney();
    const v = await checkE2eCompletionGate(repoRoot, {
      workItemId: 'wi_g',
      changedFiles: ['src/pages/Home.tsx'],
      decisions: [{ decision: 'e2e_decline' }],
    });
    expect(v.map((x) => x.code)).toContain('regression_missing');
  });

  test('regression 레코드 pass + 현재 diff 커버 → 위반 없음', async () => {
    await seedJourney();
    await seedRegressionRecord('pass', ['src/pages/Home.tsx']);
    const v = await checkE2eCompletionGate(repoRoot, {
      workItemId: 'wi_g',
      changedFiles: ['src/pages/Home.tsx'],
      decisions: [{ decision: 'e2e_accept' }],
    });
    expect(v).toEqual([]);
  });

  test('regression 레코드가 non-pass → regression_non_pass', async () => {
    await seedJourney();
    await seedRegressionRecord('fail', ['src/pages/Home.tsx']);
    const v = await checkE2eCompletionGate(repoRoot, {
      workItemId: 'wi_g',
      changedFiles: ['src/pages/Home.tsx'],
      decisions: [{ decision: 'e2e_accept' }],
    });
    expect(v.map((x) => x.code)).toContain('regression_non_pass');
  });

  test('regression 레코드가 현재 diff를 커버하지 않으면 stale → regression_missing', async () => {
    await seedJourney();
    await seedRegressionRecord('pass', ['src/pages/Other.tsx']);
    const v = await checkE2eCompletionGate(repoRoot, {
      workItemId: 'wi_g',
      changedFiles: ['src/pages/Home.tsx'],
      decisions: [{ decision: 'e2e_accept' }],
    });
    expect(v.map((x) => x.code)).toContain('regression_missing');
  });

  test('파싱 불가 여정만 있어도 regression 레코드를 요구한다 (영향 추림 불가 = 미검증)', async () => {
    await mkdir(join(repoRoot, 'e2e', 'journeys'), { recursive: true });
    await Bun.write(join(repoRoot, 'e2e', 'journeys', 'broken.journey.md'), 'no front matter\n');
    const v = await checkE2eCompletionGate(repoRoot, {
      workItemId: 'wi_g',
      changedFiles: ['docs/readme.md'],
      decisions: [],
    });
    expect(v.map((x) => x.code)).toContain('regression_missing');
  });
});
