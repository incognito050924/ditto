/**
 * CodeQL runner — WI-1: reviewer lane에서 target repo를 CodeQL로 분석한다.
 *
 * 설계: **순수부**(build-mode 선택·명령 인자 구성·캐시 키)와 **실행부**(spawn·파일 IO)를
 * 분리한다. 순수부는 CodeQL CLI 없이 단위 테스트로 100% 검증되고, 실행부는 deps 주입이라
 * mock spawn으로 검증한다. 실제 CLI e2e는 CLI 설치 후 별도 스모크로 닫는다.
 *
 * 근거: 연구 부록2~4 실측.
 * - 컴파일 언어(Kotlin/Java 등)는 build-mode none이면 추출이 비어 "깨끗함"으로 오판된다
 *   (부록4: Kotlin none → 666 중 6클래스). → 컴파일 언어는 autobuild 기본.
 * - `LGTM_INDEX_FILTERS`는 JS autobuild를 깨뜨린다(부록4). → env에서 unset.
 * - DB 생성은 13.8초~3분(부록2~4) → commit-sha 캐시로 재실행 절감.
 */
import type { HostRunProcess } from '~/core/hosts/types';
import { type CodeqlFinding, parseSarif } from './sarif';

export type CodeqlLanguage =
  | 'javascript'
  | 'python'
  | 'ruby'
  | 'java'
  | 'kotlin'
  | 'csharp'
  | 'go'
  | 'cpp'
  | 'rust'
  | 'swift'
  | 'actions';

export type BuildMode = 'none' | 'autobuild' | 'manual';

/**
 * 우리 언어 라벨 → CodeQL 추출기 언어. Kotlin은 CodeQL의 'java'(java-kotlin) 추출기로
 * 분석된다(전용 추출기 없음). 그래서 라벨은 'kotlin'으로 두되 codeql `--language=`와
 * qlpack 의존은 'java'로 매핑한다. 라벨을 분리하는 이유: Kotlin은 buildless가 빈 추출을
 * 내므로(false-clean) NO_BUILD_LANGUAGES에서 빠져 반드시 빌드(autobuild/manual)되어야 한다.
 */
export function codeqlExtractorLanguage(language: CodeqlLanguage): CodeqlLanguage {
  return language === 'kotlin' ? 'java' : language;
}

/** 해석/소스 언어는 빌드 없이 추출된다. 컴파일 언어(java/kotlin 등)는 추출에 빌드가 필요. */
const NO_BUILD_LANGUAGES: ReadonlySet<CodeqlLanguage> = new Set([
  'javascript',
  'python',
  'ruby',
  'actions',
]);

/**
 * 언어별 기본 build mode를 고른다.
 * - 해석/소스 언어 → none (빌드 불필요).
 * - 컴파일 언어 → manual(빌드 명령 주어지면) / 아니면 autobuild.
 *   none은 컴파일 언어에서 빈 추출을 만들므로(부록4) 금지한다.
 */
export function selectBuildMode(language: CodeqlLanguage, buildCommand?: string): BuildMode {
  if (NO_BUILD_LANGUAGES.has(language)) return 'none';
  return buildCommand ? 'manual' : 'autobuild';
}

export interface CreateArgsInput {
  dbPath: string;
  language: CodeqlLanguage;
  sourceRoot: string;
  buildMode: BuildMode;
  /** buildMode='manual'일 때 실행할 빌드 명령. */
  buildCommand?: string;
}

/** `codeql database create ...` 인자를 구성한다(순수). */
export function buildCreateArgs(input: CreateArgsInput): string[] {
  const args = [
    'database',
    'create',
    input.dbPath,
    `--language=${codeqlExtractorLanguage(input.language)}`,
    `--source-root=${input.sourceRoot}`,
    '--overwrite',
  ];
  if (input.buildMode === 'manual') {
    if (!input.buildCommand) {
      throw new Error("buildMode 'manual' requires buildCommand");
    }
    args.push(`--command=${input.buildCommand}`);
  } else {
    args.push(`--build-mode=${input.buildMode}`);
  }
  return args;
}

export interface AnalyzeArgsInput {
  dbPath: string;
  /** 실행할 suite/query. 게이트용은 taint(path-problem) 우선(부록2/3). */
  suite: string;
  sarifOut: string;
  /** 병렬 스레드. 0 = 코어 수만큼(부록3). */
  threads?: number;
  /** pack 미설치 시 query pack을 자동 다운로드(표준 suite 스펙 사용 시 필요). */
  download?: boolean;
}

/** `codeql database analyze ...` 인자를 구성한다(순수). */
export function buildAnalyzeArgs(input: AnalyzeArgsInput): string[] {
  const args = [
    'database',
    'analyze',
    input.dbPath,
    input.suite,
    '--format=sarif-latest',
    `--output=${input.sarifOut}`,
    `--threads=${input.threads ?? 0}`,
  ];
  if (input.download) args.push('--download');
  return args;
}

/** commit-sha + 언어로 캐시 키를 만든다(순수). 같은 커밋·언어면 DB/SARIF 재사용. */
export function cacheKey(commitSha: string, language: CodeqlLanguage): string {
  const shortSha = commitSha.slice(0, 12);
  return `${shortSha}-${language}`;
}

/** runner 실행에 필요한 외부 의존(주입 → 테스트 시 mock). */
export interface CodeqlDeps {
  spawn: (input: {
    binary: string;
    args: string[];
    repoRoot: string;
    cwd: string;
    env: { set: Record<string, string>; unset: string[] };
  }) => HostRunProcess;
  readText: (path: string) => Promise<string>;
  fileExists: (path: string) => Promise<boolean>;
  /** 스트림을 끝까지 소비한다(파이프 블록 방지). 로그 텍스트 반환. */
  drain: (stream: ReadableStream<Uint8Array>) => Promise<string>;
}

export interface RunCodeqlInput {
  repoRoot: string;
  /** DB를 만들 대상 소스 루트(repoRoot 상대 또는 절대). */
  sourceRoot: string;
  language: CodeqlLanguage;
  commitSha: string;
  dbPath: string;
  sarifPath: string;
  suite: string;
  buildCommand?: string;
  threads?: number;
  /** codeql 실행 바이너리. 기본 'codeql'(PATH). gh extension 등 절대경로도 허용. */
  binary?: string;
  /** 표준 query pack 자동 다운로드(미설치 환경). */
  download?: boolean;
}

export interface RunCodeqlResult {
  findings: CodeqlFinding[];
  sarifPath: string;
  fromCache: boolean;
  buildMode: BuildMode;
}

const CODEQL_BINARY = 'codeql';

/** CodeQL 분석을 실행한다(실행부). cache hit이면 spawn 없이 SARIF만 읽는다. */
export async function runCodeqlAnalysis(
  input: RunCodeqlInput,
  deps: CodeqlDeps,
): Promise<RunCodeqlResult> {
  const buildMode = selectBuildMode(input.language, input.buildCommand);
  const binary = input.binary ?? CODEQL_BINARY;

  // 1. 캐시 — 같은 커밋·언어의 SARIF가 있으면 재사용(DB 생성 비용 회피).
  if (await deps.fileExists(input.sarifPath)) {
    const cached = await deps.readText(input.sarifPath);
    return {
      findings: parseSarif(cached),
      sarifPath: input.sarifPath,
      fromCache: true,
      buildMode,
    };
  }

  // LGTM_INDEX_FILTERS는 JS autobuild를 깨뜨린다(부록4) → 항상 unset.
  const env = { set: {}, unset: ['LGTM_INDEX_FILTERS'] };

  // 2. database create.
  const create = deps.spawn({
    binary,
    args: buildCreateArgs({
      dbPath: input.dbPath,
      language: input.language,
      sourceRoot: input.sourceRoot,
      buildMode,
      buildCommand: input.buildCommand,
    }),
    repoRoot: input.repoRoot,
    cwd: '.',
    env,
  });
  await deps.drain(create.stderr);
  await deps.drain(create.stdout);
  const createDone = await create.completion;
  if (createDone.exit_code !== 0) {
    throw new Error(
      `codeql database create failed (exit ${createDone.exit_code}${createDone.error ? `: ${createDone.error}` : ''})`,
    );
  }

  // 3. database analyze → SARIF.
  const analyze = deps.spawn({
    binary,
    args: buildAnalyzeArgs({
      dbPath: input.dbPath,
      suite: input.suite,
      sarifOut: input.sarifPath,
      threads: input.threads,
      download: input.download,
    }),
    repoRoot: input.repoRoot,
    cwd: '.',
    env,
  });
  await deps.drain(analyze.stderr);
  await deps.drain(analyze.stdout);
  const analyzeDone = await analyze.completion;
  if (analyzeDone.exit_code !== 0) {
    throw new Error(
      `codeql database analyze failed (exit ${analyzeDone.exit_code}${analyzeDone.error ? `: ${analyzeDone.error}` : ''})`,
    );
  }

  // 4. SARIF 파싱.
  const sarif = await deps.readText(input.sarifPath);
  return {
    findings: parseSarif(sarif),
    sarifPath: input.sarifPath,
    fromCache: false,
    buildMode,
  };
}
