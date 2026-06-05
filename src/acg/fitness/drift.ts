/**
 * Assurance drift — AssuranceSnapshot 시계열을 SLOP 추세로 투영(단계8, 10-methodology §8).
 *
 * FitnessFunction이 술어라면 AssuranceSnapshot은 그 평가 이력이고, drift는 그 위에서 파생된다
 * (스키마 주석). 한 변경(work item)이 만든 SLOP은 개별로는 게이트를 통과해도, 변경을 가로질러
 * 누적되면 "서서히 감당 불가"가 된다 — 단발 검증으로는 안 보이는 그 기울기를 function_id별
 * 시계열로 드러낸다. 순수부(집계)는 단위 테스트로, 로더(work-item 디렉터리 스캔)는 deps IO다.
 */
import { join } from 'node:path';
import { readJson } from '~/core/fs';
import { WorkItemStore } from '~/core/work-item-store';
import { type AcgAssuranceSnapshot, acgAssuranceSnapshot } from '~/schemas/acg-assurance-snapshot';

export interface DriftPoint {
  at: string;
  change_ref: string | null;
  outcome: 'pass' | 'fail' | 'skip';
  /** 위반 총량(표시·추세용). 스냅샷에 없으면 null. */
  violations: number | null;
  /** baseline에 없던 신규 위반(변경별 추가분). 없으면 0. */
  new_violations: number;
}

/** rising=위반 누증(주의), falling=개선, flat=불변, insufficient=추세 판단 불가(violations 점 <2). */
export type DriftDirection = 'rising' | 'falling' | 'flat' | 'insufficient';

export interface DriftSeries {
  function_id: string;
  points: DriftPoint[];
  first_violations: number | null;
  last_violations: number | null;
  direction: DriftDirection;
  /** 변경을 가로질러 더해진 신규 위반의 합(SLOP 증식 총량). */
  cumulative_new_violations: number;
  fail_count: number;
}

export interface DriftReport {
  snapshots: number;
  functions: DriftSeries[];
}

export interface DriftAssessment {
  /** rising 추세이면서 누적 신규위반이 임계 이상인 function들(SLOP 가속). */
  concerning: DriftSeries[];
  min_new_violations: number;
  reasons: string[];
}

/**
 * drift 리포트를 게이트 판정으로 접는다(순수). rising 추세이면서 변경을 가로지른 누적 신규위반
 * (cumulative_new_violations)이 임계 이상인 function이 '주의'다 — CI가 SLOP 가속에 빌드를
 * 실패시킬 근거(단계8을 정보 뷰에서 게이트로 승격). minNewViolations로 사소한 상승의 노이즈를
 * 거른다(기본 0 = 모든 rising). 한 변경 내 신규위반은 이미 fitness run이 게이팅하므로, 여기선
 * '변경을 가로지른 추세'만 본다.
 */
export function assessDrift(report: DriftReport, minNewViolations = 0): DriftAssessment {
  const concerning = report.functions.filter(
    (f) => f.direction === 'rising' && f.cumulative_new_violations >= minNewViolations,
  );
  return {
    concerning,
    min_new_violations: minNewViolations,
    reasons: concerning.map(
      (f) =>
        `drift: ${f.function_id} rising (violations ${f.first_violations}→${f.last_violations}, +${f.cumulative_new_violations} new across changes)`,
    ),
  };
}

/** 주의 우선순위: rising > flat > insufficient > falling, 동순위는 누적 신규위반 내림차순. */
const DIRECTION_RANK: Record<DriftDirection, number> = {
  rising: 0,
  flat: 1,
  insufficient: 2,
  falling: 3,
};

/**
 * AssuranceSnapshot들을 function_id별 시계열로 집계한다(순수). 점은 `at` 오름차순 정렬,
 * direction은 violations가 정의된 첫·끝 점의 비교(정의된 점 2개 미만이면 insufficient).
 * 함수는 주의 순(rising 먼저)으로 정렬해 돌려준다.
 */
export function computeDrift(snapshots: AcgAssuranceSnapshot[]): DriftReport {
  const byFn = new Map<string, DriftPoint[]>();
  for (const snap of snapshots) {
    for (const r of snap.results) {
      const point: DriftPoint = {
        at: snap.at,
        change_ref: snap.change_ref ?? null,
        outcome: r.outcome,
        violations: r.violations ?? null,
        new_violations: r.new_violations ?? 0,
      };
      const list = byFn.get(r.function_id);
      if (list) list.push(point);
      else byFn.set(r.function_id, [point]);
    }
  }

  const functions: DriftSeries[] = [];
  for (const [function_id, rawPoints] of byFn) {
    const points = [...rawPoints].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const withViolations = points.filter((p) => p.violations !== null);
    const first_violations = withViolations[0]?.violations ?? null;
    const last_violations = withViolations[withViolations.length - 1]?.violations ?? null;
    let direction: DriftDirection;
    if (withViolations.length < 2 || first_violations === null || last_violations === null) {
      direction = 'insufficient';
    } else if (last_violations > first_violations) {
      direction = 'rising';
    } else if (last_violations < first_violations) {
      direction = 'falling';
    } else {
      direction = 'flat';
    }
    functions.push({
      function_id,
      points,
      first_violations,
      last_violations,
      direction,
      cumulative_new_violations: points.reduce((s, p) => s + p.new_violations, 0),
      fail_count: points.filter((p) => p.outcome === 'fail').length,
    });
  }

  functions.sort((a, b) => {
    const r = DIRECTION_RANK[a.direction] - DIRECTION_RANK[b.direction];
    if (r !== 0) return r;
    if (a.cumulative_new_violations !== b.cumulative_new_violations) {
      return b.cumulative_new_violations - a.cumulative_new_violations;
    }
    return a.function_id < b.function_id ? -1 : a.function_id > b.function_id ? 1 : 0;
  });

  return { snapshots: snapshots.length, functions };
}

/**
 * work-item을 가로지른 AssuranceSnapshot 시계열을 로드한다(impure). 각 work item의
 * `.ditto/work-items/<id>/assurance-snapshot.json`을 읽되, 부재·malformed는 건너뛴다
 * (drift는 있는 점들로만 추세를 본다 — 빠진 점은 침묵 손실이 아니라 그 변경이 fitness를
 * 안 돌린 것).
 */
export async function loadAssuranceSnapshots(repoRoot: string): Promise<AcgAssuranceSnapshot[]> {
  const items = await new WorkItemStore(repoRoot).list();
  const out: AcgAssuranceSnapshot[] = [];
  for (const it of items) {
    try {
      out.push(
        await readJson(
          join(repoRoot, '.ditto', 'work-items', it.id, 'assurance-snapshot.json'),
          acgAssuranceSnapshot,
        ),
      );
    } catch {
      // absent or malformed → skip
    }
  }
  return out;
}
