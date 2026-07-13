import type { AcgChangeContract } from '~/schemas/acg-change-contract';
import type { AcgAffectedNode, AcgImpactGraph } from '~/schemas/acg-impact-graph';
import type { AcgReviewFile, AcgReviewGraph } from '~/schemas/acg-review-graph';

/**
 * Change Map 텍스트 렌더러.
 *
 * read-only producer: ChangeContract(필수)·ImpactGraph(선택)·ReviewGraph(선택)을
 * §2.1b EBNF의 단일 change_node 텍스트로 그린다. 토큰은 스키마 enum과 정확히 일치한다.
 * 텍스트가 정본이고, Mermaid 다이어그램(§3)은 같은 입력에서 파생한다(renderMermaid).
 */

const RISK_BADGE = {
  low: '🟢[low]',
  medium: '🟡[medium]',
  high: '🔴[high]',
} as const;

type Risk = keyof typeof RISK_BADGE;

const RISK_ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

/**
 * 위험 뱃지: ReviewGraph가 있으면 분류된 파일들의 최고위험을 따르고
 * (§1 위험 색은 ReviewGraph 출처), 없으면 ChangeContract.risk_default로 폴백한다.
 */
function resolveRisk(contract: AcgChangeContract, review?: AcgReviewGraph): Risk {
  if (review && review.files.length > 0) {
    return review.files.reduce<Risk>(
      (worst, f) => (RISK_ORDER[f.risk] > RISK_ORDER[worst] ? f.risk : worst),
      'low',
    );
  }
  return contract.risk_default;
}

/** 영향/파일을 매칭하기 위한 ref(journey는 journey_id, 그 외 path)을 뽑는다. */
function nodeRef(node: AcgAffectedNode): string {
  return node.journey_id ?? node.path ?? '';
}

function reviewRef(file: AcgReviewFile): string {
  return file.journey_id ?? file.path ?? '';
}

/**
 * 증거 뱃지(☑ 닫힘 / ☐ 열림 / ⚠ 미검증): ReviewGraph.files[]의 evidence·unresolved
 * 기반(§1). 같은 ref의 파일이 unresolved면 ⚠, evidence가 있으면 ☑, 그 외/ReviewGraph
 * 없으면 ☐.
 */
function evidenceBadge(ref: string, review?: AcgReviewGraph): '☑' | '☐' | '⚠' {
  const file = review?.files.find((f) => reviewRef(f) === ref);
  if (!file) return '☐';
  if (file.unresolved) return '⚠';
  return file.evidence ? '☑' : '☐';
}

/**
 * --output json 요약: change_id·risk·영향수·unresolved수·미해소 accept수.
 * 미해소 accept은 §2.1에서 모든 accept이 ☐(열림)이므로 acceptance 전체 개수다.
 */
export function summarize(
  contract: AcgChangeContract,
  impact?: AcgImpactGraph,
  review?: AcgReviewGraph,
): {
  change_id: string;
  risk: Risk;
  impact: number;
  unresolved: number;
  open_accept: number;
} {
  return {
    change_id: contract.work_item_id,
    risk: resolveRisk(contract, review),
    impact: impact?.affected_nodes.length ?? 0,
    unresolved: impact?.unresolved.length ?? 0,
    open_accept: contract.acceptance.length,
  };
}

export function render(
  contract: AcgChangeContract,
  impact?: AcgImpactGraph,
  review?: AcgReviewGraph,
): string {
  const lines: string[] = [];

  lines.push(
    `◆ ${contract.work_item_id} ${RISK_BADGE[resolveRisk(contract, review)]} "${contract.purpose}"`,
  );
  lines.push(`  decision: ${contract.decision_ref ?? '—'}`);

  lines.push('  scope:');
  lines.push(`    allow ─ ${contract.allowed_scope.map((s) => s.ref).join(', ')}`);
  lines.push(`    forbid ✕ ${contract.forbidden_scope.map((s) => s.ref).join('  ✕ ')}`);

  if (impact && (impact.affected_nodes.length > 0 || impact.unresolved.length > 0)) {
    lines.push('  impact:');
    for (const node of impact.affected_nodes) {
      const ref = nodeRef(node);
      lines.push(`    → ${node.kind} ${ref} ${evidenceBadge(ref, review)}`);
    }
    for (const u of impact.unresolved) {
      lines.push(`    ⚠ unresolved: ${u.kind} ${u.path} — ${u.reason}`);
    }
  }

  lines.push('  accept:');
  for (const a of contract.acceptance) {
    lines.push(`    ☐ "${a.criterion}" (${a.evidence_kind})`);
  }

  return `${lines.join('\n')}\n`;
}

/** Mermaid 라벨 안전 처리: 따옴표는 작은따옴표로, 개행은 `<br/>`로(라벨 깨짐 방지). */
function label(text: string): string {
  return text.replaceAll('"', "'").replaceAll('\n', ' ');
}

/** 변경노드 외 노드 ID는 인덱스 기반(ref에 경로·점·슬래시가 섞여도 Mermaid id 안전). */
function nodeId(prefix: string, index: number): string {
  return `${prefix}${index}`;
}

const RISK_CLASSDEF: Record<Risk, string> = {
  low: 'classDef low fill:#dcfce7,stroke:#16a34a;',
  medium: 'classDef medium fill:#fef9c3,stroke:#ca8a04;',
  high: 'classDef high fill:#fee2e2,stroke:#dc2626;',
};

/**
 * Change Map Mermaid 렌더러 (파생). render()와 같은 입력에서:
 *   ◆ 변경 노드 = 위험색 중심 노드,
 *   → impact(affected) = 실선 + `<kind> <증거뱃지>` 라벨,
 *   ✕ forbid(forbidden_scope) = 점선(red) + forbid 스타일,
 *   ⚠ unresolved = 점선(grey) + unresolved 스타일.
 * 텍스트 정본과 불일치하면 텍스트가 이긴다(§3 주). 순수.
 */
export function renderMermaid(
  contract: AcgChangeContract,
  impact?: AcgImpactGraph,
  review?: AcgReviewGraph,
): string {
  const risk = resolveRisk(contract, review);
  const lines: string[] = ['graph LR'];
  lines.push(`  C["◆ ${label(contract.work_item_id)}<br/>${risk}"]:::${risk}`);

  contract.forbidden_scope.forEach((s, i) => {
    const id = nodeId('F', i);
    lines.push(`  C -.->|✕ forbid| ${id}["${label(s.ref)}"]:::forbid`);
  });

  if (impact) {
    impact.affected_nodes.forEach((node, i) => {
      const ref = nodeRef(node);
      const id = nodeId('A', i);
      lines.push(`  C -->|${node.kind} ${evidenceBadge(ref, review)}| ${id}["${label(ref)}"]`);
    });
    impact.unresolved.forEach((u, i) => {
      const id = nodeId('U', i);
      lines.push(`  C -.->|⚠ unresolved| ${id}["${label(`${u.kind}: ${u.path}`)}"]:::unresolved`);
    });
  }

  lines.push('');
  lines.push(`  ${RISK_CLASSDEF[risk]}`);
  lines.push('  classDef forbid fill:#fee2e2,stroke:#dc2626,stroke-dasharray:4;');
  lines.push('  classDef unresolved fill:#f3f4f6,stroke:#6b7280,stroke-dasharray:2;');

  return `\`\`\`mermaid\n${lines.join('\n')}\n\`\`\`\n`;
}
