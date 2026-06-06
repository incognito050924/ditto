/**
 * ADR 집행 가드 (wi_260606e7k).
 *
 * ADR 은 그동안 문서로만 존재했고 자동 집행이 없어, ADR-0006(CodeQL 단일,
 * 언어 컴파일러 직접분석 금지)이 명시돼 있었음에도 TS AST 분석기(ts-analyzer.ts)가
 * 먼저 들어왔다가 뒤늦게 제거된 이력이 있다. 이 가드는 **grep 가능한** ADR 위반을
 * 자동으로 잡아 pre-commit·CI 에서 차단한다.
 *
 * 한계(의도적): 모든 ADR 을 자동화하지 않는다. ADR-0002(schema SoT)·ADR-0004(적합성
 * 비용)처럼 의미적·문맥적 결정은 grep 으로 강제할 수 없으므로 이 가드의 범위 밖이다.
 * 여기에는 텍스트 패턴으로 명확히 위반을 판정할 수 있는 규칙만 둔다 — 단순 grep 으로
 * 될 일을 프레임워크로 만들지 않는다(헌장 4-3).
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface ForbiddenPattern {
  pattern: RegExp;
  reason: string;
}

export interface AdrRule {
  adr: string;
  description: string;
  /** Repo-relative files or directories. A directory is scanned recursively for `.ts`. */
  targets: string[];
  forbidden: ForbiddenPattern[];
}

export interface AdrViolation {
  adr: string;
  file: string;
  line: number;
  text: string;
  reason: string;
}

export const ADR_RULES: AdrRule[] = [
  {
    adr: 'ADR-0006',
    description: '구조/관계 추출은 CodeQL 단일 — 언어 컴파일러(TS) 직접 분석/AST 금지',
    targets: ['src'],
    forbidden: [
      {
        pattern: /from\s+['"]typescript['"]/,
        reason: 'typescript 컴파일러 API 직접 import (D2: TsAnalyzer류 재발 통로) — CodeQL로',
      },
      {
        pattern: /require\(['"]typescript['"]\)/,
        reason: 'typescript 컴파일러 API 직접 require — CodeQL로',
      },
      { pattern: /from\s+['"]ts-morph['"]/, reason: 'TS AST 래퍼(ts-morph) 직접 사용 — CodeQL로' },
      {
        pattern: /from\s+['"]@typescript-eslint\/parser['"]/,
        reason: 'TS AST 파서 직접 사용 — CodeQL로',
      },
      { pattern: /from\s+['"]@babel\/parser['"]/, reason: '언어 AST 파서 직접 사용 — CodeQL로' },
    ],
  },
  {
    adr: 'ADR-0001',
    description: 'Stop 훅 성능계약 — Stop 훅(hot-path)에서 CodeQL 모듈 직접 import 금지',
    targets: ['src/hooks/stop.ts'],
    forbidden: [
      {
        pattern: /from\s+['"][^'"]*\/codeql/,
        reason:
          'Stop 훅에서 CodeQL 모듈 import (ADR-0001 성능계약 위반 — CodeQL은 Stop hot-path 밖)',
      },
    ],
  },
];

/** Scan a single file's text against one rule's forbidden patterns. Pure — unit-testable. */
export function scanText(
  text: string,
  forbidden: ForbiddenPattern[],
): Array<{ line: number; text: string; reason: string }> {
  const out: Array<{ line: number; text: string; reason: string }> = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    for (const f of forbidden) {
      if (f.pattern.test(line)) out.push({ line: i + 1, text: line.trim(), reason: f.reason });
    }
  }
  return out;
}

/** Recursively collect repo-relative `.ts` files under a directory. */
async function walkTs(repoRoot: string, base: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(join(repoRoot, base), { withFileTypes: true });
  for (const e of entries) {
    const rel = join(base, e.name);
    if (e.isDirectory()) out.push(...(await walkTs(repoRoot, rel)));
    else if (e.name.endsWith('.ts')) out.push(rel);
  }
  return out;
}

/** Resolve a rule target (file or directory) to a list of repo-relative `.ts` files. */
async function filesForTarget(repoRoot: string, target: string): Promise<string[]> {
  const s = await stat(join(repoRoot, target)).catch(() => null);
  if (!s) return [];
  return s.isDirectory() ? walkTs(repoRoot, target) : [target];
}

/** Count the distinct repo-relative `.ts` files the given rules would scan. */
export async function countScannedFiles(
  repoRoot: string,
  rules: AdrRule[] = ADR_RULES,
): Promise<number> {
  const seen = new Set<string>();
  for (const rule of rules) {
    for (const target of rule.targets) {
      for (const rel of await filesForTarget(repoRoot, target)) seen.add(rel);
    }
  }
  return seen.size;
}

/** Scan the whole repo against all rules. Returns every violation found. */
export async function scanAdrViolations(
  repoRoot: string,
  rules: AdrRule[] = ADR_RULES,
): Promise<AdrViolation[]> {
  const violations: AdrViolation[] = [];
  for (const rule of rules) {
    const seen = new Set<string>();
    for (const target of rule.targets) {
      for (const rel of await filesForTarget(repoRoot, target)) {
        if (seen.has(rel)) continue;
        seen.add(rel);
        const text = await Bun.file(join(repoRoot, rel)).text();
        for (const hit of scanText(text, rule.forbidden)) {
          violations.push({
            adr: rule.adr,
            file: rel,
            line: hit.line,
            text: hit.text,
            reason: hit.reason,
          });
        }
      }
    }
  }
  return violations;
}

if (import.meta.main) {
  const violations = await scanAdrViolations(process.cwd());
  const scanned = await countScannedFiles(process.cwd());
  if (violations.length > 0) {
    console.error(`✗ ADR 위반 ${violations.length}건 — 커밋/CI 차단:\n`);
    for (const v of violations) {
      console.error(`  [${v.adr}] ${v.file}:${v.line}  ${v.text}`);
      console.error(`          ↳ ${v.reason}\n`);
    }
    process.exit(1);
  }
  console.log(
    `✓ ADR 가드 통과 — ${ADR_RULES.length}개 규칙(${ADR_RULES.map((r) => r.adr).join(', ')}), 위반 0, ${scanned}개 .ts 스캔`,
  );
}
