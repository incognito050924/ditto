import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLifecycleAction } from '~/core/e2e/lifecycle';

/**
 * wi_260610p9h ac-8 집행 절반 — DSL 파생 테스트의 갱신·삭제는 사용자 확인을
 * 거쳐서만 수행된다. 가드: ① @ditto-generated 파생물에만 적용(수동 파일 거부)
 * ② confirmed-by-user 없으면 거부 ③ delete 시 다른 여정이 참조하는 공유 helper
 * 보존. update는 stale 마킹(detectStale 재사용)이지 재생성이 아니다.
 */

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'ditto-lifecycle-'));
  await mkdir(join(repoRoot, 'e2e', 'journeys'), { recursive: true });
  await mkdir(join(repoRoot, 'e2e', 'generated', 'support'), { recursive: true });
});
afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

function journeyDoc(id: string, name: string, blocks: string[] = []): string {
  return [
    '---',
    'ditto_journey: v2',
    `id: ${id}`,
    `name: ${name}`,
    `description: ${name} 보호`,
    'surfaces:',
    '  - "page:/x"',
    `implementation_intent: ${name} 흐름을 검증한다`,
    ...(blocks.length > 0 ? ['uses_blocks:', ...blocks.map((b) => `  - ${b}`)] : []),
    '---',
    '',
    '1. [s1] 무언가 한다',
    '',
  ].join('\n');
}

const GENERATED =
  '/**\n * @ditto-generated\n * @ditto-source e2e/journeys/login.journey.md\n * @ditto-journey jrn-login\n */\n';

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('runLifecycleAction (ac-8 가드)', () => {
  test('confirmed-by-user 없으면 거부', async () => {
    const res = await runLifecycleAction(repoRoot, {
      action: 'delete',
      journeyFile: 'e2e/journeys/login.journey.md',
      confirmedByUser: false,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.refusal).toContain('사용자 확인');
  });

  test('수동 파일(@ditto-generated 마커 없음)은 거부', async () => {
    await Bun.write(
      join(repoRoot, 'e2e', 'journeys', 'login.journey.md'),
      journeyDoc('jrn-login', '로그인'),
    );
    await Bun.write(
      join(repoRoot, 'e2e', 'generated', 'login.spec.ts'),
      '// human-authored spec\n',
    );
    const res = await runLifecycleAction(repoRoot, {
      action: 'delete',
      journeyFile: 'e2e/journeys/login.journey.md',
      confirmedByUser: true,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.refusal).toContain('수동');
    expect(await exists(join(repoRoot, 'e2e', 'generated', 'login.spec.ts'))).toBe(true);
  });

  test('정상 삭제: journey+spec 삭제, 미참조 generated helper도 삭제, 결정 기록', async () => {
    await Bun.write(
      join(repoRoot, 'e2e', 'journeys', 'login.journey.md'),
      journeyDoc('jrn-login', '로그인', ['fill-login']),
    );
    await Bun.write(join(repoRoot, 'e2e', 'generated', 'login.spec.ts'), GENERATED);
    await Bun.write(
      join(repoRoot, 'e2e', 'generated', 'support', 'fill-login.block.ts'),
      GENERATED,
    );
    const res = await runLifecycleAction(repoRoot, {
      action: 'delete',
      journeyFile: 'e2e/journeys/login.journey.md',
      confirmedByUser: true,
      reason: '로그인 흐름 제거됨',
      workItemId: 'wi_lc1',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.deleted_files).toContain('e2e/journeys/login.journey.md');
    expect(res.deleted_files).toContain('e2e/generated/login.spec.ts');
    expect(res.deleted_files).toContain('e2e/generated/support/fill-login.block.ts');
    expect(await exists(join(repoRoot, 'e2e', 'journeys', 'login.journey.md'))).toBe(false);
    expect(await exists(join(repoRoot, 'e2e', 'generated', 'login.spec.ts'))).toBe(false);
    const ledger = await readFile(
      join(repoRoot, '.ditto', 'local', 'work-items', 'wi_lc1', 'e2e-lifecycle.jsonl'),
      'utf8',
    );
    const line = JSON.parse(ledger.trim());
    expect(line.action).toBe('delete');
    expect(line.confirmed_by_user).toBe(true);
    expect(line.journey_id).toBe('jrn-login');
  });

  test('spec 헤더의 @ditto-journey가 다른 여정을 가리키면 delete 거부 (잘못된 파생물 연쇄 삭제 방지)', async () => {
    await Bun.write(
      join(repoRoot, 'e2e', 'journeys', 'login.journey.md'),
      journeyDoc('jrn-login', '로그인'),
    );
    await Bun.write(
      join(repoRoot, 'e2e', 'generated', 'login.spec.ts'),
      '/**\n * @ditto-generated\n * @ditto-source e2e/journeys/other.journey.md\n * @ditto-journey jrn-other\n */\n',
    );
    const res = await runLifecycleAction(repoRoot, {
      action: 'delete',
      journeyFile: 'e2e/journeys/login.journey.md',
      confirmedByUser: true,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.refusal).toContain('jrn-other');
    // 아무것도 삭제되지 않는다
    expect(await exists(join(repoRoot, 'e2e', 'journeys', 'login.journey.md'))).toBe(true);
    expect(await exists(join(repoRoot, 'e2e', 'generated', 'login.spec.ts'))).toBe(true);
  });

  test('delete는 spec 먼저, journey 마지막에 unlink한다 (중간 실패 시 원본 DSL 보존)', async () => {
    await Bun.write(
      join(repoRoot, 'e2e', 'journeys', 'login.journey.md'),
      journeyDoc('jrn-login', '로그인', ['fill-login']),
    );
    await Bun.write(join(repoRoot, 'e2e', 'generated', 'login.spec.ts'), GENERATED);
    await Bun.write(
      join(repoRoot, 'e2e', 'generated', 'support', 'fill-login.block.ts'),
      GENERATED,
    );
    const res = await runLifecycleAction(repoRoot, {
      action: 'delete',
      journeyFile: 'e2e/journeys/login.journey.md',
      confirmedByUser: true,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 순서가 곧 회귀 가드: 파생물(spec→helper) 먼저, 원본 journey가 마지막
    expect(res.deleted_files).toEqual([
      'e2e/generated/login.spec.ts',
      'e2e/generated/support/fill-login.block.ts',
      'e2e/journeys/login.journey.md',
    ]);
  });

  test('공유 helper는 다른 여정이 참조하면 보존', async () => {
    await Bun.write(
      join(repoRoot, 'e2e', 'journeys', 'login.journey.md'),
      journeyDoc('jrn-login', '로그인', ['shared-step']),
    );
    await Bun.write(
      join(repoRoot, 'e2e', 'journeys', 'billing.journey.md'),
      journeyDoc('jrn-billing', '결제', ['shared-step']),
    );
    await Bun.write(join(repoRoot, 'e2e', 'generated', 'login.spec.ts'), GENERATED);
    await Bun.write(
      join(repoRoot, 'e2e', 'generated', 'support', 'shared-step.block.ts'),
      GENERATED,
    );
    const res = await runLifecycleAction(repoRoot, {
      action: 'delete',
      journeyFile: 'e2e/journeys/login.journey.md',
      confirmedByUser: true,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.preserved_helpers).toEqual(['e2e/generated/support/shared-step.block.ts']);
    expect(
      await exists(join(repoRoot, 'e2e', 'generated', 'support', 'shared-step.block.ts')),
    ).toBe(true);
  });

  test('파싱 불가한 다른 여정이 참조 흔적을 가지면 공유 helper 보존 (O-8)', async () => {
    await Bun.write(
      join(repoRoot, 'e2e', 'journeys', 'login.journey.md'),
      journeyDoc('jrn-login', '로그인', ['shared-step']),
    );
    // front-matter가 깨진 여정 — 그러나 본문에 shared-step 참조 흔적이 있다.
    await Bun.write(
      join(repoRoot, 'e2e', 'journeys', 'broken.journey.md'),
      '깨진 front matter\n1. [s1] 블록: shared-step ()\n',
    );
    await Bun.write(join(repoRoot, 'e2e', 'generated', 'login.spec.ts'), GENERATED);
    await Bun.write(
      join(repoRoot, 'e2e', 'generated', 'support', 'shared-step.block.ts'),
      GENERATED,
    );
    const res = await runLifecycleAction(repoRoot, {
      action: 'delete',
      journeyFile: 'e2e/journeys/login.journey.md',
      confirmedByUser: true,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 파싱 불가 = 참조 안 함이 아니다 — 보수적으로 보존한다.
    expect(res.preserved_helpers).toEqual(['e2e/generated/support/shared-step.block.ts']);
    expect(
      await exists(join(repoRoot, 'e2e', 'generated', 'support', 'shared-step.block.ts')),
    ).toBe(true);
  });

  test('저장소 밖 journey 경로는 거부 (O-19: repo 경계)', async () => {
    const res = await runLifecycleAction(repoRoot, {
      action: 'delete',
      journeyFile: '../outside/evil.journey.md',
      confirmedByUser: true,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.refusal).toContain('저장소');
  });

  test('update: 아무것도 지우지 않고 stale 판정 + 결정 기록(워크아이템 없이도 동작)', async () => {
    await Bun.write(
      join(repoRoot, 'e2e', 'journeys', 'login.journey.md'),
      journeyDoc('jrn-login', '로그인'),
    );
    await Bun.write(join(repoRoot, 'e2e', 'generated', 'login.spec.ts'), GENERATED);
    const res = await runLifecycleAction(repoRoot, {
      action: 'update',
      journeyFile: 'e2e/journeys/login.journey.md',
      confirmedByUser: true,
      reason: '단계 추가 필요',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.action).toBe('update');
    expect(res.stale?.stale).toBe(true); // GENERATED 헤더에 digest 없음 → 갱신 필요로 판정
    expect(res.deleted_files).toEqual([]);
    expect(await exists(join(repoRoot, 'e2e', 'journeys', 'login.journey.md'))).toBe(true);
    const ledger = await readFile(join(repoRoot, '.ditto', 'local', 'e2e-lifecycle.jsonl'), 'utf8');
    expect(JSON.parse(ledger.trim()).action).toBe('update');
  });
});
