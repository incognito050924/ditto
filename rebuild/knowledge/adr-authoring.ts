import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { ADR_SLUG_RE } from '../schemas/adr-id';
import { atomicWriteText } from '../util/fs';
import { dittoDir } from '../util/paths';

/**
 * Creation half of the immutable-filename identifier policy: a new ADR's id is
 * `ADR-YYYYMMDD-<slug>` — the whole filename stem, minted once at creation,
 * never renumbered. The id is date+user-slug only (deterministic, NO random
 * suffix), so a same-day same-slug collision is surfaced as an error, not
 * silently re-rolled.
 */

/** Two-digit zero-padded helper. */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** YYYYMMDD in UTC — the id's date component never drifts with local timezones. */
function ymdCompact(now: Date): string {
  return `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}`;
}

/** YYYY-MM-DD in UTC for the human-readable "결정 일자" body line. */
function ymdDashed(now: Date): string {
  return `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`;
}

function adrSkeletonBody(id: string, dateDashed: string): string {
  return `# ${id}: <제목>

- 상태: proposed
- 결정 일자: ${dateDashed}
- 결정자: <작성자>

## 컨텍스트

<무엇이 결정을 강제했는가 — 현황·제약·관측된 문제. 큐레이터가 채운다.>

## 결정

<무엇으로 결정했는가. 큐레이터가 채운다.>

## 근거 (rationale)

<왜 이 결정인가 — 기각한 대안과 트레이드오프. 큐레이터가 채운다.>

## 변경 조건 (change_condition)

<어떤 사실이 관측되면 이 결정을 재검토/철회하는가. 큐레이터가 채운다.>
`;
}

async function fileExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Create a new ADR skeleton file `ADR-YYYYMMDD-<slug>.md` under
 * `.ditto/knowledge/adr/`. Fail-closed:
 *   - invalid slug → throw (never write — not even the directory).
 *   - target file already exists → throw (never overwrite; a same-day
 *     same-slug collision is a real conflict).
 * `now` is an injectable clock seam so the date is deterministic in tests.
 */
export async function createAdrSkeleton(opts: {
  repoRoot: string;
  slug: string;
  now?: Date;
}): Promise<{ id: string; path: string }> {
  const now = opts.now ?? new Date();
  if (!ADR_SLUG_RE.test(opts.slug)) {
    throw new Error(
      `invalid slug "${opts.slug}"; expected lowercase alphanumeric words joined by single hyphens (e.g. my-feature)`,
    );
  }
  const id = `ADR-${ymdCompact(now)}-${opts.slug}`;
  const path = join(dittoDir(opts.repoRoot), 'knowledge', 'adr', `${id}.md`);
  if (await fileExists(path)) {
    throw new Error(`refusing to overwrite existing ADR: ${path}`);
  }
  await atomicWriteText(path, adrSkeletonBody(id, ymdDashed(now)));
  return { id, path };
}
