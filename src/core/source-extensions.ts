/**
 * 소스 트리 확장자 카운트 — 디렉토리를 순회하며 파일 확장자별 개수를 센다.
 *
 * CodeQL 적합성 판정(codeql/doctor.ts)과 LSP 언어 감지(provision/lsp-detect.ts)가 공유한다.
 * 확장자→언어 매핑은 소비자마다 다르므로(분석 엔진 taxonomy vs LSP 서버 정체성) 여기엔 두지
 * 않는다 — 이 모듈은 "어떤 확장자가 몇 개"까지만 책임진다.
 */
import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** 순회에서 제외할 디렉토리(빌드 산출물·VCS·런타임 상태). */
export const EXCLUDED_DIR = new Set([
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

/** dir 하위를 재귀 순회하며 확장자(소문자, 점 제외)별 파일 수를 counts에 누적한다. */
export async function walkExtensions(dir: string, counts: Record<string, number>): Promise<void> {
  let entries: Dirent<string>[];
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

/** sourceRoot 아래 파일 확장자별 개수. 읽을 수 없는 디렉터리는 조용히 건너뛴다. */
export async function countExtensions(sourceRoot: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  await walkExtensions(sourceRoot, counts);
  return counts;
}
