/**
 * internal_packages JVM 가드 — 형제모듈(JAR) cross_repo 손실을 fail-loud로 막는다.
 *
 * 단일모듈 CodeQL DB로 JVM(java/kotlin)을 분석하면 형제모듈 JAR 타입 의존이 fromSource에서
 * 빠져 ImpactGraph에서 조용히 사라진다(wi_260605cr1). cross_repo로 기록하려면 어떤 패키지가
 * 형제모듈인지(glob)·로컬 JAR이 어디 있는지(path)를 ArchitectureSpec.internal_packages에
 * 선언해야 한다. 이 모듈은 "선언이 충분한가"를 판정해(순수) CLI·훅이 같은 정책으로 차단/경고한다.
 *
 * 정책(사용자 합의): 로컬 JAR이 있는데 선언에 누락이 있으면 차단, 그 외 미선언은 경고.
 */
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { globToRegExp } from '~/acg/boundary/boundary';
import type { CodeqlLanguage } from '~/core/codeql/runner';
import { readArchitectureSpec } from '~/core/fs';
import {
  type AcgArchitectureSpec,
  type AcgInternalPackage,
  acgArchitectureSpec,
} from '~/schemas/acg-architecture-spec';

/** cross_repo가 의미 있는(형제 JAR을 정적으로 못 보는) 컴파일 언어. */
const JVM_LANGUAGES: ReadonlySet<CodeqlLanguage> = new Set(['java', 'kotlin']);

export function isJvmLanguage(language: CodeqlLanguage): boolean {
  return JVM_LANGUAGES.has(language);
}

export type GuardDecision = 'ok' | 'warn' | 'block';

export interface GuardResult {
  decision: GuardDecision;
  reason: string;
}

/**
 * internal_packages 가드 판정(순수).
 *   - 비JVM → ok(형제 JAR 개념 없음).
 *   - 로컬 JAR 존재 && 누락(glob 미선언 OR path로 안 덮인 JAR) → block.
 *   - glob 미선언(로컬 JAR 없음) → warn(cross_repo 기록 비활성; 형제 의존 있으면 선언 권고).
 *   - glob 선언 + 로컬 JAR 모두 커버 → ok.
 * localJars는 source-root 상대 경로, path 엔트리도 source-root 상대 글로브로 매칭한다.
 */
export function evaluateInternalPackages(input: {
  language: CodeqlLanguage;
  entries: AcgInternalPackage[];
  localJars: string[];
}): GuardResult {
  if (!isJvmLanguage(input.language)) {
    return {
      decision: 'ok',
      reason: 'non-JVM language — sibling-JAR cross_repo guard not applicable',
    };
  }
  const hasGlobs = input.entries.some((e) => e.type === 'glob');
  const pathEntries = input.entries.filter((e) => e.type === 'path');
  const uncovered = input.localJars.filter(
    (jar) => !pathEntries.some((p) => globToRegExp(p.value).test(jar)),
  );

  if (input.localJars.length > 0 && (!hasGlobs || uncovered.length > 0)) {
    const why = !hasGlobs
      ? 'no glob entry declares which sibling packages to record as cross_repo'
      : `local JAR(s) not covered by any path entry: ${uncovered.join(', ')}`;
    return {
      decision: 'block',
      reason: `${input.localJars.length} local JAR(s) present but internal_packages has a gap (${why}). Sibling-module impact would be silently dropped. Declare it with 'ditto architecture internal-packages --glob <pkg.**> --path <libs/*.jar>'.`,
    };
  }
  if (!hasGlobs) {
    return {
      decision: 'warn',
      reason:
        'JVM analysis without internal_packages glob entries — cross_repo recording is inactive. ' +
        'Declare it if this module has sibling-module (JAR) dependencies.',
    };
  }
  return { decision: 'ok', reason: 'internal_packages glob declared; local JARs covered' };
}

/**
 * internal_packages를 선언한 ArchitectureSpec을 만든다(순수, set 의미). 기존 스펙이 있으면
 * 나머지 필드를 보존하고 internal_packages만 교체하며, 없으면 produced_by=user의 최소 스펙을
 * 만든다. 선언 명령(`ditto architecture internal-packages`)의 코어.
 */
export function withInternalPackages(
  existing: AcgArchitectureSpec | undefined,
  entries: AcgInternalPackage[],
  producedAt: string,
): AcgArchitectureSpec {
  const base =
    existing ??
    acgArchitectureSpec.parse({
      schema_version: '0.1.0',
      kind: 'acg.architecture-spec.v1',
      produced_by: 'user',
      produced_at: producedAt,
    });
  return { ...base, internal_packages: entries };
}

/** 잡음 디렉터리(빌드 산출물·VCS·의존)는 JAR 스캔에서 제외 — 선언 대상은 형제모듈 libs JAR다. */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.ditto',
  'target',
  'build',
  'dist',
  '.gradle',
  'out',
]);

/**
 * source root 아래 로컬 JAR(*.jar)을 source-root 상대 경로로 스캔(impure, 깊이 바운드).
 * 빌드 산출물 디렉터리는 건너뛴다(target/build의 JAR은 형제모듈 선언 대상이 아니다).
 */
export async function scanLocalJars(root: string, maxDepth = 6): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(full, depth + 1);
      } else if (e.isFile() && e.name.endsWith('.jar')) {
        out.push(relative(root, full));
      }
    }
  }
  await walk(root, 0);
  return out.sort();
}

/**
 * internal_packages를 로드한다(CLI 공용). specArg가 주어지면 그 경로(못 읽으면 throw → 호출부
 * 에러 처리), 없으면 기본 `.ditto/architecture-spec.json`을 optional 로드(부재면 빈 목록).
 */
export async function loadInternalPackages(
  repoRoot: string,
  specArg?: string,
): Promise<AcgInternalPackage[]> {
  if (specArg) {
    return (await readArchitectureSpec(specArg, acgArchitectureSpec)).internal_packages;
  }
  try {
    const spec = await readArchitectureSpec(
      join(repoRoot, '.ditto', 'architecture-spec.json'),
      acgArchitectureSpec,
    );
    return spec.internal_packages;
  } catch {
    return [];
  }
}

/**
 * CLI·훅 공용 가드 실행: source-root의 로컬 JAR을 스캔하고 판정한다. 비JVM은 스캔 없이 ok.
 */
export async function runInternalPackagesGuard(input: {
  language: CodeqlLanguage;
  entries: AcgInternalPackage[];
  sourceRoot: string;
}): Promise<GuardResult> {
  if (!isJvmLanguage(input.language)) {
    return {
      decision: 'ok',
      reason: 'non-JVM language — sibling-JAR cross_repo guard not applicable',
    };
  }
  const localJars = await scanLocalJars(input.sourceRoot);
  return evaluateInternalPackages({ language: input.language, entries: input.entries, localJars });
}

/**
 * Bash 명령이 JVM CodeQL(`ditto … impact|boundary … --language java|kotlin`) 호출인지 식별한다
 * (순수, 훅 게이트용). 맞으면 {sourceRoot?}(--source-root 파싱) 반환, 아니면 undefined.
 * 한계: `ditto` 리터럴 + `impact|boundary` + `--language java|kotlin` 텍스트 매칭(별칭/변형은
 * CLI 내장 가드가 받친다).
 */
export function parseJvmCodeqlCommand(cmd: string): { sourceRoot?: string } | undefined {
  if (!/\bditto\b/.test(cmd) || !/\b(impact|boundary)\b/.test(cmd)) return undefined;
  const lang = cmd.match(/--language[=\s]+(\w+)/);
  if (!lang || (lang[1] !== 'java' && lang[1] !== 'kotlin')) return undefined;
  const sr = cmd.match(/--source-root[=\s]+(\S+)/);
  return sr ? { sourceRoot: sr[1] } : {};
}
