import { readFile, readdir, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  type E2eLifecycleAction,
  type E2eLifecycleDecision,
  e2eLifecycleDecision,
} from '~/schemas/e2e-lifecycle';
import { localDir } from '../ditto-paths';
import { atomicWriteText } from '../fs';
import { type StaleVerdict, detectStale, isDittoGenerated } from './journey-digest';
import { parseJourneyDoc } from './journey-dsl';

/**
 * DSL 파생 테스트 수명주기 집행 (wi_260610p9h ac-8 집행 절반).
 *
 * Guards, in order, BEFORE any mutation:
 *  ① user confirmation present (`confirmedByUser` — the CLI flag IS the
 *    confirmation; agents must not set it on their own judgment),
 *  ② the journey's generated spec and helpers carry `@ditto-generated`
 *    (manual/human-authored files are refused — this pipeline never touches
 *    them),
 * then:
 *  - delete: remove journey + derived spec; a shared block helper survives
 *    when ANY other journey's `uses_blocks` still references it,
 *  - update: NO regeneration here — return the `detectStale` verdict (the DSL
 *    edit already marks the spec stale mechanically) and record the decision;
 *    the scripter owns the actual regeneration.
 * Every accepted action lands in an append-only ledger (AutopilotStore
 * appendDecision pattern), work-item-scoped or repo-global.
 */

export interface LifecycleRequest {
  action: E2eLifecycleAction;
  /** Repo-relative (or absolute) path of the .journey.md file. */
  journeyFile: string;
  confirmedByUser: boolean;
  reason?: string;
  /** When present the decision lands under the work item; else repo-global. */
  workItemId?: string;
}

export type LifecycleResult =
  | { ok: false; refusal: string }
  | {
      ok: true;
      action: E2eLifecycleAction;
      journey_id: string;
      deleted_files: string[];
      preserved_helpers: string[];
      stale?: StaleVerdict;
      ledger_path: string;
    };

export function lifecycleLedgerPath(repoRoot: string, workItemId?: string): string {
  return workItemId === undefined
    ? localDir(repoRoot, 'e2e-lifecycle.jsonl')
    : join(localDir(repoRoot, 'work-items', workItemId), 'e2e-lifecycle.jsonl');
}

async function appendDecision(path: string, decision: E2eLifecycleDecision): Promise<void> {
  const parsed = e2eLifecycleDecision.parse(decision);
  const file = Bun.file(path);
  const existing = (await file.exists()) ? await file.text() : '';
  const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
  await atomicWriteText(path, `${prefix}${JSON.stringify(parsed)}\n`);
}

const toPosix = (p: string): string => p.split(sep).join('/');

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export async function runLifecycleAction(
  repoRoot: string,
  req: LifecycleRequest,
): Promise<LifecycleResult> {
  if (!req.confirmedByUser) {
    return {
      ok: false,
      refusal:
        '갱신·삭제는 사용자 확인을 거쳐야 한다 — --confirmed-by-user 없이 거부 (에이전트 단독 결정 금지)',
    };
  }
  const journeyAbs = resolve(repoRoot, req.journeyFile);
  // O-19: this command unlinks files — a path resolving outside the repo root
  // (`../…` or an absolute path elsewhere) is out of its mandate, refuse.
  const repoRel = relative(resolve(repoRoot), journeyAbs);
  if (repoRel.startsWith('..') || isAbsolute(repoRel)) {
    return {
      ok: false,
      refusal: `journey 경로가 저장소 밖을 가리킨다(${req.journeyFile}) — 수명주기 집행은 저장소 안의 파생 테스트에만 적용된다`,
    };
  }
  const journeyName = basename(journeyAbs);
  if (!journeyName.endsWith('.journey.md')) {
    return { ok: false, refusal: `journey 파일이 아니다(*.journey.md 아님): ${req.journeyFile}` };
  }
  const journeyText = await readOrNull(journeyAbs);
  if (journeyText === null) {
    return { ok: false, refusal: `journey 파일을 읽을 수 없다: ${req.journeyFile}` };
  }
  const parsed = parseJourneyDoc(journeyText);
  if (!parsed.ok) {
    return { ok: false, refusal: `journey DSL 파싱 실패: ${parsed.error}` };
  }

  const slug = journeyName.slice(0, -'.journey.md'.length);
  const generatedDir = resolve(dirname(journeyAbs), '..', 'generated');
  const specAbs = join(generatedDir, `${slug}.spec.ts`);
  const rel = (abs: string): string => toPosix(relative(repoRoot, abs));

  // Guard ②: derived artifacts only. Missing spec → provenance unprovable → refuse.
  const specText = await readOrNull(specAbs);
  if (specText === null) {
    return {
      ok: false,
      refusal: `generated spec 부재(${rel(specAbs)}) — DSL 파생물임을 확인할 수 없어 거부한다`,
    };
  }
  if (!isDittoGenerated(specText)) {
    return {
      ok: false,
      refusal: `${rel(specAbs)}는 @ditto-generated 마커가 없는 수동 파일 — 수명주기 집행은 DSL 파생 테스트에만 적용된다`,
    };
  }
  const supportDir = join(generatedDir, 'support');
  const helperOf = (blockId: string): string => join(supportDir, `${blockId}.block.ts`);
  for (const blockId of parsed.frontMatter.uses_blocks) {
    const helperText = await readOrNull(helperOf(blockId));
    if (helperText !== null && !isDittoGenerated(helperText)) {
      return {
        ok: false,
        refusal: `${rel(helperOf(blockId))}는 @ditto-generated 마커가 없는 수동 파일 — 거부한다`,
      };
    }
  }

  const journeyId = parsed.frontMatter.id;
  const ledgerPath = lifecycleLedgerPath(repoRoot, req.workItemId);
  const decided_at = new Date().toISOString();
  const base = {
    journey_id: journeyId,
    journey_file: rel(journeyAbs),
    confirmed_by_user: true as const,
    ...(req.reason !== undefined ? { reason: req.reason } : {}),
    decided_at,
  };

  if (req.action === 'update') {
    const stale = await detectStale(journeyAbs, specAbs, rel(journeyAbs));
    await appendDecision(ledgerPath, {
      action: 'update',
      ...base,
      deleted_files: [],
      preserved_helpers: [],
    });
    return {
      ok: true,
      action: 'update',
      journey_id: journeyId,
      deleted_files: [],
      preserved_helpers: [],
      stale,
      ledger_path: ledgerPath,
    };
  }

  // Guard ③ (delete only): the spec header must identify THIS journey —
  // @ditto-journey must equal the journey id (or, absent that tag,
  // @ditto-source must point at this .journey.md). A slug collision must not
  // cascade-delete another journey's derivative.
  const headerJourney = /^\s*(?:\/\/|\*)?\s*@ditto-journey\s+(\S+)\s*$/m.exec(specText)?.[1];
  const headerSource = /^\s*(?:\/\/|\*)?\s*@ditto-source\s+(\S+)\s*$/m.exec(specText)?.[1];
  const specIdentifiesJourney =
    headerJourney !== undefined ? headerJourney === journeyId : headerSource === rel(journeyAbs);
  if (!specIdentifiesJourney) {
    return {
      ok: false,
      refusal: `${rel(specAbs)} 헤더가 이 journey를 가리키지 않는다 (@ditto-journey ${headerJourney ?? '없음'} / @ditto-source ${headerSource ?? '없음'} ≠ ${journeyId} · ${rel(journeyAbs)}) — 삭제 거부`,
    };
  }

  // delete: collect block ids still referenced by OTHER journeys.
  const journeysDir = dirname(journeyAbs);
  const referencedElsewhere = new Set<string>();
  for (const name of (await readdir(journeysDir)).filter((n) => n.endsWith('.journey.md'))) {
    const otherAbs = join(journeysDir, name);
    if (otherAbs === journeyAbs) continue;
    const other = await readOrNull(otherAbs);
    if (other === null) continue;
    const otherParsed = parseJourneyDoc(other);
    if (!otherParsed.ok) {
      // O-8: unparsable ≠ "references nothing". A broken journey is still a
      // DSL-derived asset; when its raw text shows any trace of a block id,
      // conservatively preserve that helper (mirror of regression-select's
      // invalid-journey escalation — invalid never silently widens a delete).
      for (const b of parsed.frontMatter.uses_blocks) {
        if (other.includes(b)) referencedElsewhere.add(b);
      }
      continue;
    }
    for (const b of otherParsed.frontMatter.uses_blocks) referencedElsewhere.add(b);
  }

  // Unlink order: derivatives first (spec → helpers), the source journey LAST —
  // a mid-failure must never leave derivatives behind with their DSL source gone.
  const deleted: string[] = [];
  const preserved: string[] = [];
  await unlink(specAbs);
  deleted.push(rel(specAbs));
  for (const blockId of parsed.frontMatter.uses_blocks) {
    const helperAbs = helperOf(blockId);
    if ((await readOrNull(helperAbs)) === null) continue;
    if (referencedElsewhere.has(blockId)) {
      preserved.push(rel(helperAbs));
    } else {
      await unlink(helperAbs);
      deleted.push(rel(helperAbs));
    }
  }
  await unlink(journeyAbs);
  deleted.push(rel(journeyAbs));

  await appendDecision(ledgerPath, {
    action: 'delete',
    ...base,
    deleted_files: deleted,
    preserved_helpers: preserved,
  });
  return {
    ok: true,
    action: 'delete',
    journey_id: journeyId,
    deleted_files: deleted,
    preserved_helpers: preserved,
    ledger_path: ledgerPath,
  };
}
