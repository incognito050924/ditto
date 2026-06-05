import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateInternalPackages,
  isJvmLanguage,
  parseJvmCodeqlCommand,
  scanLocalJars,
  withInternalPackages,
} from '~/acg/internal-packages';
import { type AcgInternalPackage, acgArchitectureSpec } from '~/schemas/acg-architecture-spec';

const glob = (value: string): AcgInternalPackage => ({ type: 'glob', value });
const path = (value: string): AcgInternalPackage => ({ type: 'path', value });

describe('isJvmLanguage', () => {
  test('java/kotlin만 JVM', () => {
    expect(isJvmLanguage('java')).toBe(true);
    expect(isJvmLanguage('kotlin')).toBe(true);
    expect(isJvmLanguage('javascript')).toBe(false);
    expect(isJvmLanguage('python')).toBe(false);
  });
});

describe('evaluateInternalPackages — 차단/경고/통과 정책', () => {
  test('비JVM은 항상 ok(가드 미적용)', () => {
    expect(
      evaluateInternalPackages({ language: 'python', entries: [], localJars: ['libs/x.jar'] })
        .decision,
    ).toBe('ok');
    expect(
      evaluateInternalPackages({ language: 'javascript', entries: [], localJars: [] }).decision,
    ).toBe('ok');
  });

  test('로컬 JAR 있고 glob 미선언 → block', () => {
    const r = evaluateInternalPackages({
      language: 'java',
      entries: [],
      localJars: ['libs/domain.jar'],
    });
    expect(r.decision).toBe('block');
    expect(r.reason).toContain('no glob entry');
  });

  test('로컬 JAR 있고 path로 안 덮인 JAR 있으면(glob 있어도) → block', () => {
    const r = evaluateInternalPackages({
      language: 'kotlin',
      entries: [glob('kr.co.ecoletree.boxwood.domain.**'), path('libs/domain-*.jar')],
      localJars: ['libs/domain-2.2.51.jar', 'libs/other.jar'], // other.jar 미커버
    });
    expect(r.decision).toBe('block');
    expect(r.reason).toContain('libs/other.jar');
  });

  test('로컬 JAR 모두 커버 + glob 선언 → ok', () => {
    const r = evaluateInternalPackages({
      language: 'java',
      entries: [glob('kr.co.ecoletree.boxwood.domain.**'), path('libs/*.jar')],
      localJars: ['libs/domain-2.2.51.jar', 'libs/other.jar'],
    });
    expect(r.decision).toBe('ok');
  });

  test('JVM·glob 미선언·로컬 JAR 없음 → warn', () => {
    const r = evaluateInternalPackages({ language: 'java', entries: [], localJars: [] });
    expect(r.decision).toBe('warn');
    expect(r.reason).toContain('inactive');
  });

  test('JVM·glob 선언·로컬 JAR 없음 → ok', () => {
    const r = evaluateInternalPackages({
      language: 'java',
      entries: [glob('com.x.**')],
      localJars: [],
    });
    expect(r.decision).toBe('ok');
  });
});

describe('withInternalPackages — 선언 코어(set 의미)', () => {
  const at = '2026-06-05T06:30:00.000Z';
  const entries: AcgInternalPackage[] = [
    { type: 'glob', value: 'com.x.**' },
    { type: 'path', value: 'libs/*.jar' },
  ];

  test('기존 스펙 없으면 produced_by=user 최소 스펙 + internal_packages', () => {
    const spec = withInternalPackages(undefined, entries, at);
    expect(acgArchitectureSpec.parse(spec)).toMatchObject({
      produced_by: 'user',
      internal_packages: entries,
    });
  });

  test('기존 스펙 있으면 다른 필드 보존하고 internal_packages만 교체', () => {
    const existing = acgArchitectureSpec.parse({
      schema_version: '0.1.0',
      kind: 'acg.architecture-spec.v1',
      produced_by: 'user',
      produced_at: at,
      public_surfaces: ['controller/**'],
      internal_packages: [{ type: 'glob', value: 'old.**' }],
    });
    const next = withInternalPackages(existing, entries, at);
    expect(next.public_surfaces).toEqual(['controller/**']); // 보존
    expect(next.internal_packages).toEqual(entries); // 교체
  });
});

describe('parseJvmCodeqlCommand — 훅 게이트(ditto impact|boundary --language java|kotlin)', () => {
  test('JVM CodeQL 호출 식별 + --source-root 파싱', () => {
    expect(
      parseJvmCodeqlCommand('ditto impact --work-item w --file F --symbol s --language java'),
    ).toEqual({});
    expect(
      parseJvmCodeqlCommand(
        '/abs/dist/ditto boundary check --spec s --file F --language=kotlin --source-root /x/ae',
      ),
    ).toEqual({ sourceRoot: '/x/ae' });
  });
  test('비JVM·비ditto·관계없는 명령은 undefined', () => {
    expect(parseJvmCodeqlCommand('ditto impact --language javascript')).toBeUndefined();
    expect(parseJvmCodeqlCommand('ditto impact --language python')).toBeUndefined();
    expect(parseJvmCodeqlCommand('mvn -o compile')).toBeUndefined();
    expect(parseJvmCodeqlCommand('ditto change-map --language java')).toBeUndefined(); // impact/boundary 아님
  });
});

describe('scanLocalJars — source-root 상대 JAR 스캔, 빌드 산출물 제외', () => {
  test('libs/의 jar는 잡고, target/·node_modules의 jar는 건너뛴다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ditto-jarscan-'));
    try {
      await mkdir(join(dir, 'libs'), { recursive: true });
      await mkdir(join(dir, 'target'), { recursive: true });
      await mkdir(join(dir, 'node_modules', 'p'), { recursive: true });
      await writeFile(join(dir, 'libs', 'domain.jar'), '');
      await writeFile(join(dir, 'libs', 'rbac.jar'), '');
      await writeFile(join(dir, 'target', 'app.jar'), ''); // 빌드 산출물 — 제외
      await writeFile(join(dir, 'node_modules', 'p', 'dep.jar'), ''); // 의존 — 제외
      const jars = await scanLocalJars(dir);
      expect(jars).toEqual(['libs/domain.jar', 'libs/rbac.jar']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
