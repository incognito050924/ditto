import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { z } from 'zod';
import { type E2eFailureVerdict, e2eFailureVerdict } from '~/schemas/e2e-failure-verdict';
import { flakyHistoryEntry, journeyFrontMatter } from '~/schemas/journey-dsl';
import { localDir } from '../ditto-paths';
import { atomicWriteText, ensureDir } from '../fs';
import { parseYaml } from '../hosts/shared';
import { splitFrontMatter } from './journey-dsl';

/**
 * E2E 실패 판정 원장 + 기능 코드 수정 잠금 게이트 (wi_260610p9h ac-12, spec §8).
 *
 * The ledger (`.ditto/local/work-items/<wi>/e2e-verdicts.jsonl`, append-only —
 * same pattern as autopilot-decisions.jsonl) records USER verdicts on e2e
 * failures. `featureFixAllowed` is the lock: a feature-code fix motivated by an
 * e2e failure is allowed ONLY when a user-confirmed '기능' verdict exists for
 * that journey+case. The schema makes unconfirmed records unrepresentable.
 */

export type FlakyHistoryEntry = z.infer<typeof flakyHistoryEntry>;

export function verdictsPath(repoRoot: string, workItemId: string): string {
  return join(localDir(repoRoot, 'work-items', workItemId), 'e2e-verdicts.jsonl');
}

/** Append one user-confirmed verdict (schema-validated, append-only). */
export async function appendFailureVerdict(
  repoRoot: string,
  workItemId: string,
  verdict: E2eFailureVerdict,
): Promise<E2eFailureVerdict> {
  const parsed = e2eFailureVerdict.parse(verdict);
  await ensureDir(localDir(repoRoot, 'work-items', workItemId));
  const path = verdictsPath(repoRoot, workItemId);
  const file = Bun.file(path);
  const existing = (await file.exists()) ? await file.text() : '';
  const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
  await atomicWriteText(path, `${prefix}${JSON.stringify(parsed)}\n`);
  return parsed;
}

export async function readFailureVerdicts(
  repoRoot: string,
  workItemId: string,
): Promise<E2eFailureVerdict[]> {
  const file = Bun.file(verdictsPath(repoRoot, workItemId));
  if (!(await file.exists())) return [];
  const text = await file.text();
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => e2eFailureVerdict.parse(JSON.parse(line)));
}

export interface FeatureFixGate {
  allowed: boolean;
  reason: string;
}

/**
 * ac-12 게이트: 해당 journey+case의 **최신** 사용자 확정(confirmed_by_user=true)
 * 판정이 '기능'일 때만 기능 코드 수정이 허용된다. 과거에 '기능' 판정이 있었어도
 * 이후 재판정(스크립트/환경/flaky)이 오면 잠금이 되돌아온다.
 */
export async function featureFixAllowed(
  repoRoot: string,
  workItemId: string,
  journeyId: string,
  caseName: string,
): Promise<FeatureFixGate> {
  const verdicts = (await readFailureVerdicts(repoRoot, workItemId)).filter(
    (v) => v.journey_id === journeyId && v.case_name === caseName,
  );
  if (verdicts.length === 0) {
    return {
      allowed: false,
      reason: `${journeyId} · ${caseName}에 대한 사용자 판정이 없다 — 실패 원인 분류(기능/스크립트/환경/flaky) 판정 전에는 기능 코드를 수정할 수 없다`,
    };
  }
  const latest = verdicts[verdicts.length - 1] as E2eFailureVerdict;
  if (latest.classification === '기능') {
    return {
      allowed: true,
      reason: `사용자가 기능 결함으로 판정 (${latest.decided_at}): ${latest.basis}`,
    };
  }
  return {
    allowed: false,
    reason: `최근 판정이 '${latest.classification}' — 기능 코드 수정은 허용되지 않는다`,
  };
}

/**
 * flaky 판정 시 journey front-matter `flaky_history`에 {date,case,note}를
 * 추가한다. 본문(body)은 한 바이트도 바꾸지 않는다 — front-matter만 YAML
 * 왕복(parseYaml ↔ stringify)하고, 결과가 journey 스키마를 통과할 때만 쓴다.
 */
export async function appendFlakyHistory(
  journeyFilePath: string,
  entry: FlakyHistoryEntry,
): Promise<void> {
  const text = await readFile(journeyFilePath, 'utf8');
  const split = splitFrontMatter(text);
  if (!split) {
    throw new Error(`${journeyFilePath}: no leading ---…--- front-matter block`);
  }
  const raw = parseYaml(split.frontMatter);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${journeyFilePath}: front-matter is not a YAML mapping`);
  }
  const record = raw as Record<string, unknown>;
  const history = Array.isArray(record.flaky_history) ? record.flaky_history : [];
  record.flaky_history = [...history, flakyHistoryEntry.parse(entry)];
  const valid = journeyFrontMatter.safeParse(record);
  if (!valid.success) {
    throw new Error(
      `${journeyFilePath}: flaky_history update would break front-matter: ${valid.error.message}`,
    );
  }
  await atomicWriteText(journeyFilePath, `---\n${stringifyYaml(record)}---\n${split.body}`);
}
