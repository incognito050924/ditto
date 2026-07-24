import { describe, expect, test } from 'bun:test';

import { assembleRelevanceVerdicts } from './relevance';
import type { CategoryRelevanceVerdict, CoverageMap } from './schemas';
import { coverageMap } from './schemas';
import {
  CATEGORY_NODE_PREFIX,
  FAR_FIELD_TAXONOMY_FLOOR,
  type FarFieldCategory,
} from './taxonomy';
import {
  UnjustifiedCloseError,
  closeCoverageNode,
  farFieldCoverageNodes,
  farFieldCoverageReport,
  isCoverageTerminated,
  recordDryRound,
  seedCoverageMap,
} from './sweep';

const TAXONOMY: FarFieldCategory[] = [
  { id: 'authentication', lens: '인증 경로?' },
  { id: 'injection', lens: '인젝션 싱크?' },
  { id: 'regulatory', lens: '규제 의무?' },
];

function seed(verdicts: CategoryRelevanceVerdict[] = []): CoverageMap {
  return seedCoverageMap('결제 화면에 쿠폰 필드 추가', {
    taxonomy: TAXONOMY,
    verdicts,
  });
}

describe('farFieldCoverageNodes / seedCoverageMap — 카테고리를 노드로 시딩 (breadth ledger)', () => {
  test('seeds a root plus one node per category; the node set IS the sweep ledger', () => {
    const map = seed();
    // parseable by the schema (valid shape)
    expect(coverageMap.parse(map)).toEqual(map);
    expect(map.nodes).toHaveLength(1 + TAXONOMY.length);
    const root = map.nodes.find((n) => n.id === map.root_id);
    expect(root?.label).toBe('결제 화면에 쿠폰 필드 추가');
    expect(root?.children).toEqual(TAXONOMY.map((c) => `${CATEGORY_NODE_PREFIX}${c.id}`));
    // every category seeds OPEN by default (relevant → in scope)
    for (const c of TAXONOMY) {
      const node = map.nodes.find((n) => n.id === `${CATEGORY_NODE_PREFIX}${c.id}`);
      expect(node?.state).toBe('open');
      expect(node?.label).toBe(c.lens);
    }
  });

  test('the default taxonomy is the full floor when none is supplied', () => {
    const map = seedCoverageMap('무언가');
    expect(map.nodes).toHaveLength(1 + FAR_FIELD_TAXONOMY_FLOOR.length);
  });
});

describe('binary relevance gate at seed (ADR-20260625) — relevant → open, skip → auditable out_of_scope', () => {
  test('a well-formed, refute-survived skip pre-closes that category as an auditable out_of_scope node', () => {
    const verdicts = assembleRelevanceVerdicts(
      [
        {
          id: 'regulatory',
          relevant: false,
          reason: '규제 데이터 경로 없음',
          residual_risk: '규제 의무가 뒤늦게 걸리면 미검토',
        },
      ],
      [{ id: 'regulatory', refuted: false }],
    );
    const map = seed(verdicts);
    const skipped = map.nodes.find((n) => n.id === `${CATEGORY_NODE_PREFIX}regulatory`);
    expect(skipped?.state).toBe('out_of_scope');
    expect(skipped?.close_reason).toBe('규제 데이터 경로 없음');
    expect(skipped?.residual_risk).toBe('규제 의무가 뒤늦게 걸리면 미검토');
    // the other (relevant) categories stay open — binary: relevant is fully in scope
    expect(map.nodes.find((n) => n.id === `${CATEGORY_NODE_PREFIX}injection`)?.state).toBe('open');
    expect(map.nodes.find((n) => n.id === `${CATEGORY_NODE_PREFIX}authentication`)?.state).toBe(
      'open',
    );
  });

  test('a relevant verdict (or a would-be skip lacking justification/refute) seeds the category OPEN — conservative default', () => {
    // assembleRelevanceVerdicts already downgraded these to relevant:true
    const verdicts = assembleRelevanceVerdicts(
      [{ id: 'regulatory', relevant: false, reason: '경로 없음' }], // no residual_risk, no refute
      [],
    );
    const map = seed(verdicts);
    expect(map.nodes.find((n) => n.id === `${CATEGORY_NODE_PREFIX}regulatory`)?.state).toBe('open');
  });
});

describe('justification-close gate (ADR-0023 decision 2) — fail-closed', () => {
  test('a category skipped out_of_scope WITHOUT a reason is refused loudly', () => {
    const map = seed();
    expect(() =>
      closeCoverageNode(map, `${CATEGORY_NODE_PREFIX}injection`, 'out_of_scope', {
        residual_risk: '싱크가 뒤늦게 드러나면 미검토',
      }),
    ).toThrow(UnjustifiedCloseError);
  });

  test('a category skipped WITHOUT a residual_risk is refused loudly', () => {
    const map = seed();
    expect(() =>
      closeCoverageNode(map, `${CATEGORY_NODE_PREFIX}injection`, 'user_owned', {
        reason: '사용자 도메인 결정',
      }),
    ).toThrow(UnjustifiedCloseError);
  });

  test('a justified skip lands with both close_reason and residual_risk recorded (auditable)', () => {
    const map = closeCoverageNode(seed(), `${CATEGORY_NODE_PREFIX}injection`, 'out_of_scope', {
      reason: '신뢰 경계 입력 없음',
      residual_risk: '입력 경로가 추가되면 인젝션 미검토',
    });
    const node = map.nodes.find((n) => n.id === `${CATEGORY_NODE_PREFIX}injection`);
    expect(node?.state).toBe('out_of_scope');
    expect(node?.close_reason).toBe('신뢰 경계 입력 없음');
    expect(node?.residual_risk).toBe('입력 경로가 추가되면 인젝션 미검토');
  });

  test('a resolved close needs no justification — the sweep itself is the record', () => {
    const map = closeCoverageNode(seed(), `${CATEGORY_NODE_PREFIX}injection`, 'resolved');
    expect(map.nodes.find((n) => n.id === `${CATEGORY_NODE_PREFIX}injection`)?.state).toBe(
      'resolved',
    );
  });
});

describe('category-complete termination (ADR-0023 decision 1) — not merely novelty-dry', () => {
  test('novelty-dry alone does NOT terminate while a seeded category is still open', () => {
    const map = seed();
    // depth axis satisfied (K dry rounds), but categories un-swept
    expect(isCoverageTerminated(map, 2, 2)).toBe(false);
  });

  test('termination requires every seeded category swept-and-closed AND the dry depth reached', () => {
    let map = seed();
    for (const c of TAXONOMY) {
      map = closeCoverageNode(map, `${CATEGORY_NODE_PREFIX}${c.id}`, 'resolved');
    }
    // categories closed but the root subtree not yet settled
    expect(isCoverageTerminated(map, 2, 2)).toBe(false);
    map = closeCoverageNode(map, map.root_id, 'resolved');
    // breadth complete but depth not yet reached
    expect(isCoverageTerminated(map, 1, 2)).toBe(false);
    // both axes hold
    expect(isCoverageTerminated(map, 2, 2)).toBe(true);
  });

  test('a justified skip counts as covered for termination (covered OR justified-closed)', () => {
    let map = seed();
    map = closeCoverageNode(map, `${CATEGORY_NODE_PREFIX}authentication`, 'resolved');
    map = closeCoverageNode(map, `${CATEGORY_NODE_PREFIX}injection`, 'resolved');
    map = closeCoverageNode(map, `${CATEGORY_NODE_PREFIX}regulatory`, 'out_of_scope', {
      reason: '규제 경로 없음',
      residual_risk: '규제가 뒤늦게 걸리면 미검토',
    });
    map = closeCoverageNode(map, map.root_id, 'resolved');
    expect(isCoverageTerminated(map, 2, 2)).toBe(true);
  });
});

describe('recordDryRound — novelty (depth) axis', () => {
  test('an admissible new branch resets the counter; a dry round increments', () => {
    expect(recordDryRound(3, { admissibleBranchesAdded: 1 })).toBe(0);
    expect(recordDryRound(1, { admissibleBranchesAdded: 0 })).toBe(2);
  });
});

describe('farFieldCoverageReport — deterministic breadth audit', () => {
  test('reports seeded/resolved/open/skipped and whether breadth is complete', () => {
    let map = seed();
    map = closeCoverageNode(map, `${CATEGORY_NODE_PREFIX}authentication`, 'resolved');
    map = closeCoverageNode(map, `${CATEGORY_NODE_PREFIX}regulatory`, 'out_of_scope', {
      reason: '규제 경로 없음',
      residual_risk: '규제가 뒤늦게 걸리면 미검토',
    });
    const report = farFieldCoverageReport(map);
    expect(report.seeded).toBe(3);
    expect(report.resolved).toBe(1);
    expect(report.open).toBe(1); // injection still open
    expect(report.complete).toBe(false);
    expect(report.skipped).toEqual([
      {
        id: `${CATEGORY_NODE_PREFIX}regulatory`,
        state: 'out_of_scope',
        reason: '규제 경로 없음',
        residual_risk: '규제가 뒤늦게 걸리면 미검토',
      },
    ]);
  });

  test('complete is true only when every category is settled (covered or justified-closed)', () => {
    let map = seed();
    for (const c of TAXONOMY) {
      map = closeCoverageNode(map, `${CATEGORY_NODE_PREFIX}${c.id}`, 'resolved');
    }
    map = closeCoverageNode(map, map.root_id, 'resolved');
    const report = farFieldCoverageReport(map);
    expect(report.open).toBe(0);
    expect(report.complete).toBe(true);
  });
});
