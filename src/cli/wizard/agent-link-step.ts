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
import { type Choice, multiSelect } from './prompt';
import type { PromptIO } from './prompt';

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

  const approved: AgentVariant[] = discovered
    .filter((a) => picked.has(a.name))
    .map((a) => ({ name: a.name, role: a.role, description: a.description, match: [] }));

  if (approved.length === 0) return { discovered, written: [], skipped: [] };

  const result = await deps.writeVariants(approved);
  return { discovered, written: result.written, skipped: result.skipped };
}
