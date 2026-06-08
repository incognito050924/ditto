/**
 * `doctor codeql` — WI-2: target repo의 CodeQL 적합성 사전판정(fail-closed).
 *
 * 모든 CodeQL 게이트의 전제. 분석 *전*에 (a) 언어 지원 (b) CLI 가용성 (c) build 재현성을
 * 판정해, **빈 분석이 '깨끗함'으로 오판되는 거짓 통과를 차단**한다(부록4: Kotlin을 build 없이
 * 추출하면 666 중 6클래스만 잡혀 alert 0 → 게이트가 통과시킴 = 최악).
 *
 * fail-closed 원칙: 컴파일 언어는 build가 입증(probe)되기 전까지 finding으로 막는다.
 * 정적 판정만으로 done_when ①(JS/TS exit 0) ②(Kotlin build 미입증 exit 1)
 * ③(PHP 미지원 exit 1)을 전부 커버한다 — probe는 build 입증용 추가 단계(opt-in).
 */
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type CodeqlLanguage, selectBuildMode } from './runner';

/** 파일 확장자 → CodeQL 언어. 목록에 없는 확장자는 미지원으로 분류된다. */
const LANG_BY_EXT: Record<string, CodeqlLanguage> = {
  ts: 'javascript',
  tsx: 'javascript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  java: 'java',
  kt: 'java',
  kts: 'java',
  cs: 'csharp',
  go: 'go',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  c: 'cpp',
  h: 'cpp',
  hpp: 'cpp',
  rs: 'rust',
  swift: 'swift',
};

/** CodeQL이 의미 분석을 *지원하지 않는* 대표 확장자(파일은 읽혀도 분석 불가). */
const KNOWN_UNSUPPORTED_EXT = new Set(['php', 'scala', 'clj', 'ex', 'exs', 'dart', 'lua', 'r']);

export type CodeqlDoctorFindingKind =
  | 'cli-unavailable'
  | 'no-source-detected'
  | 'language-unsupported'
  | 'compiled-language-build-unverified'
  | 'extraction-incomplete';

export interface CodeqlDoctorFinding {
  kind: CodeqlDoctorFindingKind;
  severity: 'high' | 'medium';
  message: string;
}

export interface DetectedLanguage {
  language: CodeqlLanguage;
  files: number;
}

export interface ClassifyInput {
  languages: DetectedLanguage[];
  unsupported: { ext: string; files: number }[];
  cliAvailable: boolean;
  /** probe로 build 재현·추출 완전성이 입증됐는가. 미입증이면 컴파일 언어는 막힌다. */
  buildVerified?: boolean;
}

/** 확장자 카운트를 언어/미지원으로 분류한다(순수). */
export function classifyExtensions(extCounts: Record<string, number>): {
  languages: DetectedLanguage[];
  unsupported: { ext: string; files: number }[];
} {
  const byLang = new Map<CodeqlLanguage, number>();
  const unsupported: { ext: string; files: number }[] = [];
  for (const [ext, count] of Object.entries(extCounts)) {
    const lang = LANG_BY_EXT[ext];
    if (lang) {
      byLang.set(lang, (byLang.get(lang) ?? 0) + count);
    } else if (KNOWN_UNSUPPORTED_EXT.has(ext)) {
      unsupported.push({ ext, files: count });
    }
    // 그 외 확장자(.md, .json 등)는 무시 — 소스 아님.
  }
  const languages = [...byLang.entries()]
    .map(([language, files]) => ({ language, files }))
    .sort((a, b) => b.files - a.files);
  return { languages, unsupported };
}

/** 분류 결과를 fail-closed findings로 판정한다(순수). */
export function classifyCodeqlTarget(input: ClassifyInput): CodeqlDoctorFinding[] {
  const findings: CodeqlDoctorFinding[] = [];

  if (!input.cliAvailable) {
    findings.push({
      kind: 'cli-unavailable',
      severity: 'high',
      message:
        'CodeQL CLI를 찾을 수 없다. 분석 불가 — `ditto doctor codeql --install`로 설치하거나 PATH에 직접 설치하라.',
    });
  }

  if (input.languages.length === 0) {
    const hint =
      input.unsupported.length > 0
        ? ` (미지원 소스만 감지: ${input.unsupported.map((u) => u.ext).join(', ')})`
        : '';
    findings.push({
      kind: input.unsupported.length > 0 ? 'language-unsupported' : 'no-source-detected',
      severity: 'high',
      message: `CodeQL 지원 언어 소스를 감지하지 못했다${hint}.`,
    });
    return findings;
  }

  if (input.unsupported.length > 0) {
    findings.push({
      kind: 'language-unsupported',
      severity: 'medium',
      message: `미지원 언어 소스가 섞여 있어 해당 부분은 분석되지 않는다: ${input.unsupported
        .map((u) => `${u.ext}(${u.files})`)
        .join(', ')}.`,
    });
  }

  // 컴파일 언어는 build가 입증되기 전까지 막는다(빈 추출 오판 방지).
  const compiled = input.languages.filter((l) => selectBuildMode(l.language) !== 'none');
  if (compiled.length > 0 && input.buildVerified !== true) {
    findings.push({
      kind: 'compiled-language-build-unverified',
      severity: 'high',
      message: `컴파일 언어(${compiled
        .map((l) => l.language)
        .join(
          ', ',
        )})는 clean build로 추출 완전성을 입증해야 한다. build 미입증 상태의 분석은 빈 추출을 '깨끗함'으로 오판할 수 있다(부록4). --probe로 입증하거나 buildCommand를 제공하라.`,
    });
  }

  return findings;
}

export interface CodeqlDoctorReport {
  source_root: string;
  detected_languages: DetectedLanguage[];
  unsupported: { ext: string; files: number }[];
  cli_available: boolean;
  build_verified: boolean;
  findings: CodeqlDoctorFinding[];
  finding_count: number;
}

export interface CodeqlDoctorDeps {
  /** sourceRoot 하위 소스 파일의 확장자별 카운트(node_modules/.git/dist 제외). */
  collectExtensions: (sourceRoot: string) => Promise<Record<string, number>>;
  /** codeql CLI가 실행 가능한가. */
  cliAvailable: () => Promise<boolean>;
}

/** target을 조사해 적합성 리포트를 만든다(실행부). */
export async function inspectCodeqlTarget(
  input: { sourceRoot: string; buildVerified?: boolean },
  deps: CodeqlDoctorDeps,
): Promise<CodeqlDoctorReport> {
  const extCounts = await deps.collectExtensions(input.sourceRoot);
  const { languages, unsupported } = classifyExtensions(extCounts);
  const cliAvailable = await deps.cliAvailable();
  const findings = classifyCodeqlTarget({
    languages,
    unsupported,
    cliAvailable,
    buildVerified: input.buildVerified,
  });
  return {
    source_root: input.sourceRoot,
    detected_languages: languages,
    unsupported,
    cli_available: cliAvailable,
    build_verified: input.buildVerified === true,
    findings,
    finding_count: findings.length,
  };
}

/** 분석·추출에서 제외할 디렉터리명(소스 아님 / 빌드 산출물). */
const EXCLUDED_DIR = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.ditto',
  'coverage',
  '.gradle',
  'target',
]);

async function walkExtensions(dir: string, counts: Record<string, number>): Promise<void> {
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // 읽을 수 없는 디렉터리는 건너뛴다.
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR.has(entry.name)) continue;
      await walkExtensions(join(dir, entry.name), counts);
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf('.');
      if (dot < 0) continue;
      const ext = entry.name.slice(dot + 1).toLowerCase();
      counts[ext] = (counts[ext] ?? 0) + 1;
    }
  }
}

/** 실제 파일시스템·CLI를 쓰는 기본 deps. */
export const defaultDoctorDeps: CodeqlDoctorDeps = {
  collectExtensions: async (sourceRoot) => {
    const counts: Record<string, number> = {};
    await walkExtensions(sourceRoot, counts);
    return counts;
  },
  cliAvailable: async () => {
    const bin = process.env.CODEQL_BIN;
    if (bin) return existsSync(bin);
    if (Bun.which('codeql')) return true;
    // gh extension 설치 흔적(번들은 첫 실행 시 받음).
    return existsSync(`${process.env.HOME}/.local/share/gh/extensions/gh-codeql`);
  },
};
