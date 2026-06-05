import { isAbsolute, resolve } from 'node:path';
import { type AcgFitnessVerdictEntry, acgFitnessVerdictFile } from '~/schemas/acg-fitness-verdict';
import { commandProvider } from './command-provider';
import type { EvaluatorProvider } from './fitness-runner';

/**
 * 에이전트 주입형 evaluator provider. ditto는 LLM/테스트를 직접 호출하지 않으므로
 * llm_judged/executed mode의 fitness function은 에이전트가 미리 산출한 verdict 파일
 * (acg.fitness-verdict.v1)을 소비한다.
 *
 * fail-closed가 최우선(command-provider와 동형):
 *  - verdict 파일이 없거나 파싱 불가 → 모든 fn skip+reason (fabricated pass 금지).
 *  - 해당 fn에 매칭되는 verdict가 없음 → skip+reason.
 *  - llm_judged인데 evidence(reproducibility) 미충족 → 스키마 단계에서 거부되어 파일
 *    전체가 파싱 실패하므로 skip; executed인데 evidence_ref 누락 → skip+reason.
 *  - verdict=fail → violation_ids(없으면 function_id) 를 위반 식별자로 반환.
 *  - verdict=pass → 위반 없음(빈 배열).
 */
export function injectedProvider(verdictsPath: string, repoRoot: string): EvaluatorProvider {
  const resolved = isAbsolute(verdictsPath) ? verdictsPath : resolve(repoRoot, verdictsPath);

  // 파일 1회 로드(지연 캐시). 미존재/파싱 실패는 null → 전 fn skip(fail-closed).
  let loaded: Map<string, AcgFitnessVerdictEntry> | null | undefined;
  async function load(): Promise<Map<string, AcgFitnessVerdictEntry> | null> {
    if (loaded !== undefined) return loaded;
    const file = Bun.file(resolved);
    if (!(await file.exists())) {
      loaded = null;
      return loaded;
    }
    let parsed: ReturnType<typeof acgFitnessVerdictFile.safeParse>;
    try {
      parsed = acgFitnessVerdictFile.safeParse(JSON.parse(await file.text()));
    } catch {
      loaded = null;
      return loaded;
    }
    if (!parsed.success) {
      // 스키마 거부(예: llm_judged reproducibility 누락) → fail-closed.
      loaded = null;
      return loaded;
    }
    loaded = new Map(parsed.data.verdicts.map((v) => [v.function_id, v]));
    return loaded;
  }

  return {
    evaluate: async (fn) => {
      const map = await load();
      if (map === null) {
        return {
          skipped: {
            reason: `fitness-verdict source missing/invalid: ${resolved} (agent must produce a valid acg.fitness-verdict.v1 first)`,
          },
          violationIds: [],
        };
      }
      const entry = map.get(fn.id);
      if (!entry) {
        return {
          skipped: {
            reason: `no injected verdict for ${fn.id} (fail-closed: not a fabricated pass)`,
          },
          violationIds: [],
        };
      }
      // executed mode는 재현 출처(evidence_ref)가 있어야 신뢰 → 없으면 skip(fail-closed).
      if (entry.mode === 'executed' && !entry.evidence_ref) {
        return {
          skipped: { reason: `executed verdict for ${fn.id} lacks evidence_ref (fail-closed)` },
          violationIds: [],
        };
      }
      if (entry.verdict === 'pass') return { violationIds: [] };
      const violationIds =
        entry.violation_ids && entry.violation_ids.length > 0 ? entry.violation_ids : [fn.id];
      return { violationIds };
    },
  };
}

/**
 * 모드별 합성 라우팅 provider: deterministic → commandProvider, llm_judged/executed →
 * injectedProvider(verdict 파일 소비). 한 work item에 deterministic과 주입형 fitness가
 * 섞여 있어도 각 fn을 알맞은 provider로 보낸다. scheduling/delta/deterministic 동작은
 * 그대로 둔 채 라우팅만 추가한다.
 */
export function compositeProvider(repoRoot: string, verdictsPath: string): EvaluatorProvider {
  const deterministic = commandProvider(repoRoot);
  const injected = injectedProvider(verdictsPath, repoRoot);
  return {
    evaluate: async (fn, ctx) =>
      fn.evaluator.mode === 'deterministic'
        ? deterministic.evaluate(fn, ctx)
        : injected.evaluate(fn, ctx),
  };
}
