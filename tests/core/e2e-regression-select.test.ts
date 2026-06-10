import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchesComponentPattern, selectImpactedJourneys } from '~/core/e2e/regression-select';

/**
 * wi_260610p9h ac-7 — 영향 추림: journey front-matter `surfaces`의 component:
 * 항목(경로|glob)과 변경 diff 경로를 교차해 영향받는 여정을 산출한다.
 * page:/api: 표면은 사람·에이전트 판단용 메타데이터 — 기계 교차 대상이 아니다.
 */

let repoRoot: string;
let journeysDir: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'ditto-regsel-'));
  journeysDir = join(repoRoot, 'e2e', 'journeys');
  await mkdir(journeysDir, { recursive: true });
  await mkdir(join(repoRoot, 'e2e', 'generated'), { recursive: true });
});
afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

function journeyDoc(id: string, name: string, surfaces: string[]): string {
  return [
    '---',
    'ditto_journey: v1',
    `id: ${id}`,
    `name: ${name}`,
    `description: ${name} 보호`,
    'surfaces:',
    ...surfaces.map((s) => `  - "${s}"`),
    '---',
    '',
    '1. [s1] 무언가 한다',
    '',
  ].join('\n');
}

describe('matchesComponentPattern (minimal * / ** matcher)', () => {
  test('exact path and directory containment without glob chars', () => {
    expect(matchesComponentPattern('src/auth/login.ts', 'src/auth/login.ts')).toBe(true);
    expect(matchesComponentPattern('src/auth', 'src/auth/login.ts')).toBe(true);
    expect(matchesComponentPattern('src/auth', 'src/authz/login.ts')).toBe(false);
  });

  test('* stays within one segment; ** crosses segments', () => {
    expect(matchesComponentPattern('src/auth/*.ts', 'src/auth/login.ts')).toBe(true);
    expect(matchesComponentPattern('src/auth/*.ts', 'src/auth/deep/login.ts')).toBe(false);
    expect(matchesComponentPattern('src/auth/**', 'src/auth/deep/login.ts')).toBe(true);
    expect(matchesComponentPattern('src/**/login.ts', 'src/a/b/login.ts')).toBe(true);
    expect(matchesComponentPattern('src/**/login.ts', 'src/login.ts')).toBe(true);
  });
});

describe('selectImpactedJourneys (ac-7 추림)', () => {
  test('component: surface × changed path 교차 → 여정 선택 + matched_surfaces', async () => {
    await Bun.write(
      join(journeysDir, 'login.journey.md'),
      journeyDoc('jrn-login', '로그인 여정', ['page:/login', 'component:src/auth/**']),
    );
    await Bun.write(
      join(journeysDir, 'billing.journey.md'),
      journeyDoc('jrn-billing', '결제 여정', ['component:src/billing/**']),
    );
    await Bun.write(join(repoRoot, 'e2e', 'generated', 'login.spec.ts'), '// @ditto-generated\n');

    const selection = await selectImpactedJourneys(journeysDir, [
      'src/auth/session.ts',
      'docs/readme.md',
    ]);
    expect(selection.journeys).toHaveLength(1);
    const j = selection.journeys[0];
    expect(j?.id).toBe('jrn-login');
    expect(j?.name).toBe('로그인 여정');
    expect(j?.description).toBe('로그인 여정 보호');
    expect(j?.journey_file).toBe('e2e/journeys/login.journey.md');
    expect(j?.generated_spec).toBe('e2e/generated/login.spec.ts');
    expect(j?.matched_surfaces).toEqual(['component:src/auth/**']);
    expect(j?.missing_generated).toBe(false);
    expect(selection.unmatched_changed_paths).toEqual(['docs/readme.md']);
  });

  test('page:/api: 표면만 가진 여정은 기계 교차되지 않는다', async () => {
    await Bun.write(
      join(journeysDir, 'browse.journey.md'),
      journeyDoc('jrn-browse', '탐색 여정', ['page:/browse', 'api:GET /api/items']),
    );
    const selection = await selectImpactedJourneys(journeysDir, ['src/browse/page.tsx']);
    expect(selection.journeys).toHaveLength(0);
    expect(selection.unmatched_changed_paths).toEqual(['src/browse/page.tsx']);
  });

  test('generated spec 부재 → missing_generated=true (깨진 파생물 침묵 금지)', async () => {
    await Bun.write(
      join(journeysDir, 'orphan.journey.md'),
      journeyDoc('jrn-orphan', '고아 여정', ['component:src/orphan/*']),
    );
    const selection = await selectImpactedJourneys(journeysDir, ['src/orphan/x.ts']);
    expect(selection.journeys).toHaveLength(1);
    expect(selection.journeys[0]?.missing_generated).toBe(true);
  });

  test('파싱 불가 journey는 침묵 누락되지 않고 invalid_journeys로 드러난다', async () => {
    await Bun.write(join(journeysDir, 'broken.journey.md'), 'no front matter here\n');
    const selection = await selectImpactedJourneys(journeysDir, ['src/x.ts']);
    expect(selection.invalid_journeys).toHaveLength(1);
    expect(selection.invalid_journeys[0]?.file).toBe('e2e/journeys/broken.journey.md');
  });

  test('journeys 디렉터리 부재 → 빈 선택', async () => {
    const selection = await selectImpactedJourneys(join(repoRoot, 'e2e', 'nope'), ['src/x.ts']);
    expect(selection.journeys).toHaveLength(0);
    expect(selection.unmatched_changed_paths).toEqual(['src/x.ts']);
  });
});
