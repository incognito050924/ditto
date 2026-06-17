/**
 * wizard "프로젝트 agent 연결" 단계 — 발견된 `.claude/agents`를 ditto owner role에 매핑.
 *
 * 흐름: claude-code 호스트의 surface inventory에서 agent를 모아(이름+description)
 * 각 agent의 추천 role을 산출(recommendVariantRole) → TTY면 다중선택으로 승인한 것만
 * `.ditto/agents/<name>.md`로 등록(opt-in, 기본 미체크), 비TTY면 아무것도 쓰지 않고
 * 발견·추천만 보고한다. 쓰기는 멱등(이미 있는 파일은 건너뜀, 사용자 편집 보존).
 *
 * loadAgents·writeVariants를 주입해 실제 fs/TTY 없이 단위테스트한다 — provision-step과
 * 같은 주입 패턴.
 */
import type { AgentVariant } from '~/core/agent-variants';
import { recommendVariantRole } from '~/core/agent-variants';
import { nodeOwner } from '~/schemas/autopilot';
import { type Choice, type Option, multiSelect, select } from './prompt';
import type { PromptIO } from './prompt';

// role override 선택지 = autopilot owner role 정본(nodeOwner)에서 pseudo-owner를 뺀 것.
// driver/main-session은 subagent로 spawn되지 않아 variant role로 쓸 수 없으므로 제외한다.
const PSEUDO_OWNERS = new Set(['driver', 'main-session']);
const ROLE_OPTIONS: Option[] = nodeOwner.options
  .filter((role) => !PSEUDO_OWNERS.has(role))
  .map((role) => ({ label: role, value: role }));

/** 발견된 프로젝트 agent (이름 + frontmatter description). */
export interface DiscoveredAgent {
  name: string;
  description: string;
}

export interface AgentLinkStepDeps {
  /** 프로젝트 `.claude/agents`에서 agent를 발견(claude-code 호스트, agent only). */
  loadAgents: () => Promise<DiscoveredAgent[]>;
  /** 승인된 variant를 멱등 등록. */
  writeVariants: (variants: AgentVariant[]) => Promise<{ written: string[]; skipped: string[] }>;
}

export interface AgentLinkSummary {
  /** 발견된 agent + 추천 role(ac-1). */
  discovered: Array<DiscoveredAgent & { role: string }>;
  /** 실제 새로 쓰인 variant 이름. */
  written: string[];
  /** 이미 있어 건너뛴 variant 이름. */
  skipped: string[];
}

export async function runAgentLinkStep(
  io: PromptIO,
  deps: AgentLinkStepDeps,
): Promise<AgentLinkSummary> {
  const agents = await deps.loadAgents();
  const discovered = agents.map((a) => ({
    ...a,
    role: recommendVariantRole(a.name, a.description),
  }));

  if (discovered.length === 0) return { discovered, written: [], skipped: [] };

  const choices: Choice[] = discovered.map((a) => ({
    label: `${a.name} → ${a.role}${a.description ? ` (${a.description})` : ''}`,
    value: a.name,
    checked: false, // opt-in: 승인한 것만 등록
  }));
  const picked = new Set(await multiSelect(io, '프로젝트 agent를 ditto role에 연결', choices));

  // 승인된 agent마다 role을 고른다 — 추천 role이 기본값, 사용자가 다른 owner role로 override 가능.
  // 비TTY/Enter면 select가 기본값(추천 role)을 그대로 돌려준다(기존 동작 보존).
  const approved: AgentVariant[] = [];
  for (const a of discovered) {
    if (!picked.has(a.name)) continue;
    const role = await select(io, `'${a.name}' role 선택 (추천: ${a.role})`, ROLE_OPTIONS, a.role);
    approved.push({ name: a.name, role, description: a.description, match: [] });
  }

  if (approved.length === 0) return { discovered, written: [], skipped: [] };

  const result = await deps.writeVariants(approved);
  return { discovered, written: result.written, skipped: result.skipped };
}
