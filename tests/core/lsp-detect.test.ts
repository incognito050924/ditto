import { describe, expect, test } from 'bun:test';
import {
  LSP_LANGUAGES,
  classifyLspExtensions,
  detectLspLanguages,
} from '~/core/provision/lsp-detect';

describe('classifyLspExtensions', () => {
  test('Kotlin을 Java와 분리한다(CodeQL taxonomy와의 핵심 차이)', () => {
    const langs = classifyLspExtensions({ kt: 3, kts: 1, java: 5 });
    const byId = new Map(langs.map((l) => [l.language, l.files]));
    expect(byId.get('kotlin')).toBe(4); // kt + kts
    expect(byId.get('java')).toBe(5);
    expect(byId.has('kotlin')).toBe(true);
  });

  test('CodeQL이 버리는 언어도 감지(php·dart·lua)', () => {
    const langs = classifyLspExtensions({ php: 2, dart: 4, lua: 1 });
    const ids = langs.map((l) => l.language);
    expect(ids).toContain('php');
    expect(ids).toContain('dart');
    expect(ids).toContain('lua');
  });

  test('ts/tsx와 js/jsx를 각각 typescript/javascript로', () => {
    const langs = classifyLspExtensions({ ts: 10, tsx: 2, js: 3, jsx: 1 });
    const byId = new Map(langs.map((l) => [l.language, l.files]));
    expect(byId.get('typescript')).toBe(12);
    expect(byId.get('javascript')).toBe(4);
  });

  test('파일 수 내림차순 정렬', () => {
    const langs = classifyLspExtensions({ py: 2, ts: 50, go: 10 });
    expect(langs.map((l) => l.language)).toEqual(['typescript', 'go', 'python']);
  });

  test('알 수 없는 확장자는 무시', () => {
    const langs = classifyLspExtensions({ md: 100, json: 50, py: 1 });
    expect(langs).toEqual([{ language: 'python', files: 1 }]);
  });

  test('빈 입력은 빈 배열', () => {
    expect(classifyLspExtensions({})).toEqual([]);
  });
});

describe('LSP_LANGUAGES 계약', () => {
  test('kotlin·java가 모두 별개 키로 존재(분리 보장)', () => {
    expect(LSP_LANGUAGES.has('kotlin')).toBe(true);
    expect(LSP_LANGUAGES.has('java')).toBe(true);
  });

  test('classify 출력은 항상 계약 집합의 부분집합', () => {
    const langs = classifyLspExtensions({ ts: 1, kt: 1, php: 1, go: 1, xyz: 9 });
    for (const l of langs) expect(LSP_LANGUAGES.has(l.language)).toBe(true);
  });
});

describe('detectLspLanguages (실제 트리 순회)', () => {
  test('읽을 수 없는 경로는 빈 배열(순회기가 조용히 건너뜀)', async () => {
    const result = await detectLspLanguages('/nonexistent/path/xyz123');
    expect(result).toEqual([]);
  });

  test('이 저장소 src를 순회하면 typescript가 잡힌다', async () => {
    const result = await detectLspLanguages('src');
    const ts = result.find((l) => l.language === 'typescript');
    expect(ts).toBeDefined();
    expect(ts?.files).toBeGreaterThan(0);
  });
});
