/**
 * LSP 언어 감지 — 소스 트리 확장자로 "어떤 LSP 서버가 필요한가"를 추론한다.
 *
 * CodeQL 분류(codeql/doctor.ts LANG_BY_EXT)와 **다른 taxonomy**를 쓴다. 이유:
 *  - CodeQL은 kt/kts를 'java'로 뭉개지만, LSP는 Kotlin(kotlin-language-server)과
 *    Java(jdtls)가 서버가 다르므로 분리한다.
 *  - CodeQL이 버리는 언어(php·scala·dart·lua·r 등)도 LSP 서버가 있으므로 포함한다.
 *  - 반대로 ts/js 뭉갬은 LSP에서도 유효(typescript-language-server가 둘 다 처리)하나,
 *    프로젝트 정체성을 위해 language id는 분리해 둔다(서버 공유는 provisioner 등록의 책임).
 *
 * 여기서 emit 하는 language id 집합(LSP_LANGUAGES)은 **공유 계약**이다:
 *   감지기 출력 == registry.lsp Map 키 == 언어별 provisioner 등록 키 (resolveServer).
 * 세 소비자가 같은 taxonomy를 쓰므로, 키를 바꿀 땐 셋을 함께 바꾼다.
 */
import { countExtensions } from '~/core/source-extensions';

/** 확장자(점 제외, 소문자) → LSP language id. */
const LSP_LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  pyi: 'python',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  java: 'java',
  kt: 'kotlin', // ← CodeQL은 'java'로 뭉갬; LSP는 분리(kotlin-language-server)
  kts: 'kotlin',
  cs: 'csharp',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  php: 'php', // ↓ CodeQL 미지원이지만 LSP 서버 있음
  scala: 'scala',
  sc: 'scala',
  dart: 'dart',
  lua: 'lua',
  r: 'r',
};

/** 감지 가능한 LSP language id 집합 — registry.lsp 키 계약. */
export const LSP_LANGUAGES: ReadonlySet<string> = new Set(Object.values(LSP_LANG_BY_EXT));

export interface DetectedLspLanguage {
  language: string;
  files: number;
}

/**
 * 확장자 카운트를 language별 파일 수로 분류한다(순수 함수 — fs 없이 테스트 가능).
 * 알 수 없는 확장자(.md·.json 등)는 무시. 파일 수 내림차순 정렬.
 */
export function classifyLspExtensions(extCounts: Record<string, number>): DetectedLspLanguage[] {
  const byLang = new Map<string, number>();
  for (const [ext, count] of Object.entries(extCounts)) {
    const lang = LSP_LANG_BY_EXT[ext];
    if (lang) byLang.set(lang, (byLang.get(lang) ?? 0) + count);
  }
  return [...byLang.entries()]
    .map(([language, files]) => ({ language, files }))
    .sort((a, b) => b.files - a.files);
}

/** 소스 루트를 순회해 감지된 LSP 언어를 파일 수 내림차순으로 반환한다. */
export async function detectLspLanguages(sourceRoot: string): Promise<DetectedLspLanguage[]> {
  return classifyLspExtensions(await countExtensions(sourceRoot));
}
