/**
 * 테스트 격리 가드 (wi_260624nde).
 *
 * 테스트가 실 repo 의 공유·전역 상태에 **쓰면** false-pass/fail 을 낳는다: 한 테스트가
 * `.ditto/local`·`.ditto/runs`·`.ditto/knowledge` 같은 실 repo 산출물 디렉터리에 쓰면
 * 다른 테스트(또는 다음 실행)의 입력을 오염시켜, 코드와 무관하게 통과/실패가 갈린다.
 * 이 가드는 **grep 가능한** 위반 — write 계열 호출이 실-repo 앵커로 묶인 `.ditto/{local,
 * runs,knowledge}` 경로를 가리키는 경우 — 를 정적으로 잡아 pre-commit·CI 에서 차단한다.
 * adr-guard.ts 의 구조(스캔 → 위반 수집 → file:line 출력 → exit code)를 따른다.
 *
 * 한계(의도적, 헌장 4-3 — 한 줄 규칙을 프레임워크로 키우지 않는다):
 *  - **단일 라인** 휴리스틱이다. write 호출과 경로가 같은 줄에 있어야 잡는다. 경로를
 *    먼저 변수에 담고(`const p = join(REPO_ROOT, '.ditto', 'local', …)`) 다음 줄에서
 *    `writeFile(p, …)` 하면 못 잡는다 — 정적 데이터 흐름 분석은 범위 밖이다.
 *  - 실-repo 앵커는 토큰 매칭이다(`REPO_ROOT`/`repoRoot`/`process.cwd()`/`import.meta.dir`).
 *    tmpdir 기반 경로(`join(repo,…)`·`join(dir,…)`·`mkdtemp`·`tmpdir()`)는 위반이 아니다 —
 *    같은 줄에 실-repo 앵커 토큰이 없으면 통과한다.
 *  - **읽기**(readFile 등)는 위반이 아니다. 공유 상태를 오염시키는 것은 쓰기뿐이다.
 *
 * ALLOWLIST: 알려진 기존 케이스. self-host/e2e 정당(실 repo 를 분석 대상으로 삼는 게
 * 테스트의 본질) 또는 실 surfaces.json 읽기(후속 수정 대상)라 통과시킨다. 신규(allowlist
 * 밖) 위반만 차단한다 — 기존 위반 자체 수정은 이 작업 범위 밖(후속).
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface IsolationViolation {
  file: string;
  line: number;
  text: string;
  reason: string;
}

/**
 * 통과시키는 알려진 케이스 — 각 항목에 이유. repo-relative 경로(POSIX 슬래시).
 * 신규 위반은 여기 없으므로 차단된다.
 */
export const ALLOWLIST = new Set<string>([
  // 이 가드의 단위 테스트. 위반 패턴 문자열을 인메모리 fixture 로만 담는다(실 파일에
  // 안 씀). 단일-라인 텍스트 스캔이 그 fixture 문자열을 위반으로 오인하므로 면제한다.
  'tests/scripts/check-test-isolation.test.ts',
  // 실 .ditto/local/surfaces.json 을 읽어 카탈로그 drift 를 검출(읽기). 후속 수정 대상.
  'tests/core/surface-inventory.plugin.test.ts',
  // 실 surfaces.json 을 코드 재생성본과 비교(읽기). 후속 수정 대상.
  'tests/doctor/surface.test.ts',
  // self-host: 빌드 산출물 stamp 를 실 repo(process.cwd) 기준으로 계산(읽기/분석).
  'tests/core/build-stamp.test.ts',
  // self-host: 실 .claude/agents variant 카탈로그를 실 repo 기준으로 로드(읽기).
  'tests/core/agent-variants.test.ts',
  // self-host: 실 repo 의 agent projection 을 검사(읽기).
  'tests/core/agent-projection.test.ts',
  // self-host: 실 repo 의 .ditto 스키마 자기검증(읽기/검증).
  'tests/schemas/repo-self-validation.test.ts',
  // self-host: 실 repo(process.cwd) 의 executed-fitness 를 평가(읽기/분석).
  'tests/acg/fitness-executed.test.ts',
  // e2e: 실 repo(process.cwd) 에 CodeQL DB 를 빌드하는 정당한 e2e.
  'tests/core/codeql-e2e.test.ts',
]);

/** write 계열 호출(공유 상태를 오염시키는 쪽). 읽기는 제외. */
const WRITE_CALLS =
  /\b(writeFile|writeFileSync|mkdir|mkdirSync|cp|cpSync|appendFile|appendFileSync)\s*\(|Bun\.write\s*\(/;

/** 실-repo 앵커 토큰(tmpdir 가 아닌, 동작하는 repo 자체를 가리키는 것). */
const REAL_REPO_ANCHOR = /\bREPO_ROOT\b|\brepoRoot\b|\bprocess\.cwd\s*\(\)|\bimport\.meta\.dir\b/;

/**
 * 실 repo 의 보호 디렉터리. join 세그먼트형(`'.ditto', 'local'`)과 슬래시 리터럴형
 * (`'.ditto/local'`) 둘 다 잡는다.
 */
const PROTECTED = ['local', 'runs', 'knowledge'] as const;

function matchedProtectedDir(line: string): string | undefined {
  for (const dir of PROTECTED) {
    // 슬래시 리터럴: .ditto/local
    if (line.includes(`.ditto/${dir}`)) return `.ditto/${dir}`;
    // join 세그먼트형: '.ditto', 'local'  (따옴표/공백 허용)
    const seg = new RegExp(`['"]\\.ditto['"]\\s*,\\s*['"]${dir}['"]`);
    if (seg.test(line)) return `.ditto/${dir}`;
  }
  return undefined;
}

/**
 * 한 파일의 텍스트를 줄 단위로 스캔한다. 위반: 같은 줄에 (1) write 계열 호출,
 * (2) 실-repo 앵커 토큰, (3) 보호 `.ditto/{local,runs,knowledge}` 경로 가 모두 있는 경우.
 * 순수 — 단위 테스트 가능.
 */
export function scanText(text: string): Array<{ line: number; text: string; reason: string }> {
  const out: Array<{ line: number; text: string; reason: string }> = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!WRITE_CALLS.test(line)) continue;
    if (!REAL_REPO_ANCHOR.test(line)) continue;
    const protectedDir = matchedProtectedDir(line);
    if (!protectedDir) continue;
    out.push({
      line: i + 1,
      text: line.trim(),
      reason: `실 repo ${protectedDir} 에 쓰기(공유 상태 오염) — mkdtemp/격리 fixture 로 옮겨라`,
    });
  }
  return out;
}

/** 인메모리 파일 집합을 스캔한다. allowlist 항목은 건너뛴다. 순수. */
export function detectIsolationViolations(
  files: { path: string; content: string }[],
): IsolationViolation[] {
  const violations: IsolationViolation[] = [];
  for (const f of files) {
    if (ALLOWLIST.has(f.path)) continue;
    for (const hit of scanText(f.content)) {
      violations.push({ file: f.path, line: hit.line, text: hit.text, reason: hit.reason });
    }
  }
  return violations;
}

/** repo-relative `.ts` 파일을 tests/ 아래에서 재귀 수집(POSIX 슬래시). */
async function walkTs(repoRoot: string, base: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(join(repoRoot, base), { withFileTypes: true });
  for (const e of entries) {
    const rel = `${base}/${e.name}`;
    if (e.isDirectory()) out.push(...(await walkTs(repoRoot, rel)));
    else if (e.name.endsWith('.ts')) out.push(rel);
  }
  return out;
}

/** tests/ 전체 .ts 를 읽어 파일 집합으로 만든다. */
export async function loadTestFiles(
  repoRoot: string,
): Promise<{ path: string; content: string }[]> {
  const rels = await walkTs(repoRoot, 'tests');
  return Promise.all(
    rels.map(async (path) => ({ path, content: await Bun.file(join(repoRoot, path)).text() })),
  );
}

if (import.meta.main) {
  const repoRoot = process.cwd();
  const files = await loadTestFiles(repoRoot);
  const violations = detectIsolationViolations(files);
  if (violations.length > 0) {
    console.error(`✗ 테스트 격리 위반 ${violations.length}건 — 커밋/CI 차단:\n`);
    for (const v of violations) {
      console.error(`${v.file}:${v.line}\t${v.reason}`);
      console.error(`          ↳ ${v.text}`);
    }
    process.exit(1);
  }
  console.log(
    `✓ 테스트 격리 가드 통과 — 위반 0, ${files.length}개 tests/ .ts 스캔 (allowlist ${ALLOWLIST.size}건)`,
  );
}
