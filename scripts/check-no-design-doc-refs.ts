/**
 * 설계·계약 문서 인용 가드 (charter §4-11, wi_2607138pr).
 *
 * charter §4-11("권위는 코드에 있다")은 이미 있었지만 소스 주석을 콕 집지 않아,
 * 코드가 drift 가능한 설계·계약 문서를 경로·문서명·섹션으로 인용하는 일이 반복됐다
 * (예: `20-contracts §3`, `설계서 §6`, `e2e-journey-contract §3/§4`). 이 문서들은
 * 코드와 함께 동기화되지 않아 삭제·개정 시 dead 참조가 된다. 이 가드는 **grep 가능한**
 * 인용을 자동으로 잡아 CI에서 차단한다 — prose 규칙(advisory)을 기계 집행으로 바꾼다.
 *
 * 대상: `src/` 의 `.ts` (동작 코드). 스킬·에이전트 산출물은 build projection이 관리하고
 * charter §4-11의 별도 항목이 다룬다 — 여기서는 코드 표면만 집행한다.
 *
 * 한계(의도적): 문서 이름/경로/섹션 인용처럼 텍스트로 명확히 판정되는 것만 잡는다.
 * "이 사실이 정말 코드에 있나" 같은 의미 판정은 grep 범위 밖이다 — 단순 grep 으로 될 일을
 * 프레임워크로 만들지 않는다(charter §4-3).
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface ForbiddenPattern {
  pattern: RegExp;
  reason: string;
}

/** A legitimate, non-citation use that must NOT be flagged. */
export interface AllowRule {
  /** Repo-relative file the exception applies to. */
  file: string;
  /** The hit line is allowed only if it contains this marker substring. */
  contains: string;
  reason: string;
}

/**
 * Citations to drift-prone DESIGN / PLAN / CONTRACT documents (under `reports/`).
 * Tokens are STATIC on purpose: the docs are being retired, so the list cannot be
 * derived from the filesystem — it must survive the docs' deletion.
 */
export const FORBIDDEN: ForbiddenPattern[] = [
  {
    pattern: /reports\/(design|harnesses|research|measurements|reviews)/,
    reason:
      'reports/ 하위 설계·보고·연구 문서를 경로로 인용 — 사실은 주석에 직접 담고 코드·ADR을 가리켜라',
  },
  {
    pattern:
      /\b(00-framework|10-methodology|20-contracts|30-intent-change-dsl|40-refactoring-criteria|50-change-map|60-practice-ingestion-map|70-effect-visible|80-acg-cleanup-deslop-plan|80-plan)\b/,
    reason: 'agentic-governance 설계 스펙(번호 문서)을 인용 — drift-prone, 주요 참조 금지',
  },
  {
    pattern: /\b(v0-implementation-plan|v0-plan)\b/,
    reason: 'v0 구현 계획 문서를 인용 — drift-prone, 주요 참조 금지',
  },
  { pattern: /\bplan §/, reason: '계획 문서 섹션(plan §…)을 인용 — drift-prone, 주요 참조 금지' },
  { pattern: /설계서/, reason: '통합 설계 문서(설계서)를 인용 — drift-prone, 주요 참조 금지' },
  {
    pattern:
      /\b(autopilot-contract|convergence-contract|deep-interview-contract|dialectic-deliberation-contract|e2e-journey-contract|host-adapter-contract|knowledge-contract|premortem-coverage-contract|run-with-contract|verify-contract)\b/,
    reason:
      'reports/design/contracts/ 계약 문서를 인용 — 계약은 스키마·코드가 SoT, 문서를 가리키지 마라',
  },
];

/**
 * Legitimate non-citation uses. Each is a functional token, not a doc pointer.
 * Keep this list SHORT and justified — every entry is a hole in the gate.
 */
export const ALLOW: AllowRule[] = [
  {
    file: 'src/core/cleanup-store.ts',
    contains: 'PROTECTED_DIR_PREFIXES',
    reason: 'classify/cleanup가 보호하는 디렉터리 경로 상수 — 문서 인용이 아니라 동작 값',
  },
];

export interface DocRefViolation {
  file: string;
  line: number;
  text: string;
  reason: string;
}

/** Scan one file's text; drop anything an ALLOW rule pardons. Pure — unit-testable. */
export function scanText(file: string, text: string): DocRefViolation[] {
  const out: DocRefViolation[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    for (const f of FORBIDDEN) {
      if (!f.pattern.test(line)) continue;
      const pardoned = ALLOW.some((a) => a.file === file && line.includes(a.contains));
      if (pardoned) continue;
      out.push({ file, line: i + 1, text: line.trim(), reason: f.reason });
      break; // one violation per line is enough to fail it
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

/** Scan `src/` against all forbidden patterns. Returns every surviving violation. */
export async function scanDocRefViolations(repoRoot: string): Promise<DocRefViolation[]> {
  const target = 'src';
  if (!(await stat(join(repoRoot, target)).catch(() => null))) return [];
  const violations: DocRefViolation[] = [];
  for (const rel of await walkTs(repoRoot, target)) {
    const text = await Bun.file(join(repoRoot, rel)).text();
    violations.push(...scanText(rel, text));
  }
  return violations;
}

if (import.meta.main) {
  const violations = await scanDocRefViolations(process.cwd());
  if (violations.length > 0) {
    console.error(`✗ 설계·계약 문서 인용 ${violations.length}건 — 커밋/CI 차단 (charter §4-11):\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  ${v.text}`);
      console.error(`          ↳ ${v.reason}\n`);
    }
    console.error(
      '고치는 법: 인용을 지우고 사실은 주석에 직접 담아라. 출처가 필요하면 코드·테스트·스키마·ADR을 가리켜라.',
    );
    process.exit(1);
  }
  console.log('✓ 설계·계약 문서 인용 가드 통과 — src/ 위반 0 (charter §4-11)');
}
