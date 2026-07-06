/**
 * Committed base run-artifact 가드 (wi_2607069bk, WS0-T0 §3.1/§10-R2).
 *
 * work item Record 는 처음으로 committed·shared tier 로 올라간다: committed base 는
 * `.ditto/work-items/<id>/` 이고 `record.json`(가변 저작 파일) + `events/<seq>.<actor>.<eid>.json`
 * (per-event immutable) 만 담아야 한다. Run/개인 산출물(evidence/·autopilot.json·intent.json·
 * completion.json·work-item.json …)은 개인 tier `.ditto/local/work-items/<id>/` 에만 살고
 * committed base 로 leak 하면 안 된다.
 *
 * 물리 리네임(29-site) 대신 이 정적 lint 가 미래-생산자 가드다(§10-R2). belt-ignore 는
 * 철회됐다(Finding B-F4: belt 가 leak-test oracle 을 눈멀게 함) — 대신 이 lint 가 committed
 * base 밑에 record.json·events/*.json 외 무엇이든 있으면 fail-closed 로 차단한다.
 *
 * check-test-isolation.ts / check-npx-distribution.ts 의 구조(스캔 → 위반 수집 → file 출력 →
 * exit code)를 따른다.
 *
 * 한계(의도적, 헌장 4-3): 정적 파일-존재 검사다. 파일 *내용* 은 보지 않는다 —
 * record.json 이 유효 스키마인지·events 파일명이 규약(`<seq>.<actor>.<eid>.json`)인지는
 * 코어 store/reducer 와 스키마 파싱이 담당한다. 이 가드는 committed tier 에 어떤 파일
 * *종류* 가 존재하느냐만 본다.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface BaseViolation {
  /** committed base 기준 repo-relative POSIX 경로. */
  path: string;
  reason: string;
}

/** committed base 밑 각 `<id>/` 에서 허용되는 이름. */
const ALLOWED_TOP = new Set(['record.json', 'events']);

/**
 * 한 work item 디렉터리(`.ditto/work-items/<id>/`)의 내용을 검사한다. 순수(FS listing 주입).
 *  - 허용: `record.json`(파일), `events/`(디렉터리, 안에 `*.json` 파일만).
 *  - 위반: 그 외 파일/디렉터리, events/ 밑 non-.json, events/ 밑 하위 디렉터리.
 */
export function scanWorkItemDir(
  id: string,
  entries: { name: string; isDir: boolean }[],
  eventsEntries: { name: string; isDir: boolean }[] | null,
): BaseViolation[] {
  const out: BaseViolation[] = [];
  for (const e of entries) {
    if (!ALLOWED_TOP.has(e.name)) {
      out.push({
        path: `.ditto/work-items/${id}/${e.name}`,
        reason: `committed base 에 Run/개인 산출물 leak — record.json·events/ 만 허용(개인 산출물은 .ditto/local/work-items/${id}/ 로)`,
      });
      continue;
    }
    if (e.name === 'record.json' && e.isDir) {
      out.push({
        path: `.ditto/work-items/${id}/record.json`,
        reason: 'record.json 은 파일이어야 한다(디렉터리 발견)',
      });
    }
    if (e.name === 'events' && !e.isDir) {
      out.push({
        path: `.ditto/work-items/${id}/events`,
        reason: 'events 는 디렉터리여야 한다(파일 발견)',
      });
    }
  }
  for (const e of eventsEntries ?? []) {
    if (e.isDir) {
      out.push({
        path: `.ditto/work-items/${id}/events/${e.name}`,
        reason: 'events/ 밑에는 per-event *.json 파일만 허용(하위 디렉터리 발견)',
      });
    } else if (!e.name.endsWith('.json')) {
      out.push({
        path: `.ditto/work-items/${id}/events/${e.name}`,
        reason: 'events/ 밑에는 per-event *.json 파일만 허용',
      });
    }
  }
  return out;
}

async function readDirSafe(path: string): Promise<{ name: string; isDir: boolean }[] | null> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    return null;
  }
}

/**
 * 실 repo 의 committed base `.ditto/work-items/` 를 스캔한다. base 부재(아직 Record 없음)는
 * 위반 아님(빈 배열). 각 `<id>/` 를 scanWorkItemDir 로 검사한다.
 */
export async function checkCommittedBase(repoRoot: string): Promise<BaseViolation[]> {
  const baseDir = join(repoRoot, '.ditto', 'work-items');
  const ids = await readDirSafe(baseDir);
  if (ids === null) return []; // base 없음 = 위반 없음
  const out: BaseViolation[] = [];
  for (const id of ids) {
    if (!id.isDir) {
      out.push({
        path: `.ditto/work-items/${id.name}`,
        reason: 'committed base 직하는 <id>/ 디렉터리만 허용(파일 발견)',
      });
      continue;
    }
    const entries = await readDirSafe(join(baseDir, id.name));
    if (entries === null) continue;
    const hasEvents = entries.some((e) => e.name === 'events' && e.isDir);
    const eventsEntries = hasEvents ? await readDirSafe(join(baseDir, id.name, 'events')) : null;
    out.push(...scanWorkItemDir(id.name, entries, eventsEntries));
  }
  return out;
}

if (import.meta.main) {
  const repoRoot = process.cwd();
  const violations = await checkCommittedBase(repoRoot);
  if (violations.length > 0) {
    console.error(
      `✗ committed base run-artifact 가드 위반 ${violations.length}건 — 커밋/CI 차단:\n`,
    );
    for (const v of violations) {
      console.error(`  ${v.path}`);
      console.error(`     ↳ ${v.reason}`);
    }
    process.exit(1);
  }
  console.log(
    '✓ committed base 가드 통과 — .ditto/work-items/<id>/ 밑 record.json·events/*.json 외 leak 0',
  );
}
