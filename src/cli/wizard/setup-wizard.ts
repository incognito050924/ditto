import type { MemorySeparateMode, MemorySeparateResult } from '~/core/provision/memory-separate';
/**
 * `ditto setup` 대화형 wizard 오케스트레이터.
 *
 * 확정된 질문을 순서대로 묻고 효과를 실행한다(비TTY면 전부 기본값 — 무정지 자율 진행):
 *   1. Host        claude-code(기본) / codex / both → setup()
 *   2. 분석/언어도구  추론(detect) → 다중선택 → provisioner 설치(runProvisionStep)
 *   3. memory 저장   포함(기본, no-op) / 분리 → gitignore-독립(기본) | submodule(opt-in)
 *
 * allowlist·scaffold·host 블록은 setup()가, 도구 설치는 provisioner가, memory 분리는
 * separateMemoryRepo가 각각 담당한다 — wizard는 질문→위임만 한다. 모든 의존을 주입해
 * stdin/fs/네트워크 없이 테스트한다.
 */
import type { SetupHost, SetupResult } from '~/core/setup';
import type { AgentLinkSummary } from './agent-link-step';
import { type PromptIO, confirm, select } from './prompt';
import type { ProvisionSummary } from './provision-step';

export interface SetupWizardDeps {
  /** 프로젝트 루트(설치 대상). */
  projectRoot: string;
  /** 도구 감지 source root(보통 <projectRoot>/src). */
  sourceRoot: string;
  /** host로 호스트 블록·scaffold·allowlist 설치. */
  setup: (host: SetupHost) => Promise<SetupResult>;
  /** 도구 provisioning 단계(io를 다시 받아 다중선택). */
  runProvision: (io: PromptIO) => Promise<ProvisionSummary>;
  /** memory 분리(분리를 택했을 때만 호출). */
  separateMemory: (mode: MemorySeparateMode) => Promise<MemorySeparateResult>;
  /** 프로젝트 agent 발견 → ditto role 연결(io를 다시 받아 다중선택). */
  runAgentLink: (io: PromptIO) => Promise<AgentLinkSummary>;
}

export interface SetupWizardResult {
  host: SetupHost;
  setup: SetupResult;
  provision: ProvisionSummary;
  memory: { mode: MemorySeparateMode | 'in-project'; result: MemorySeparateResult | null };
  agents: AgentLinkSummary;
}

const HOST_OPTIONS = [
  { label: 'Claude Code', value: 'claude-code' },
  { label: 'Codex', value: 'codex' },
  { label: '둘 다(both)', value: 'both' },
];

const MEMORY_OPTIONS = [
  { label: 'gitignore-독립 (단순, 부모 git에서 제외)', value: 'gitignore' },
  { label: 'submodule (팀 재현 — 원격 선행, 수동 안내)', value: 'submodule' },
];

export async function runSetupWizard(
  io: PromptIO,
  deps: SetupWizardDeps,
): Promise<SetupWizardResult> {
  // 1. Host
  const host = (await select(io, 'Host 선택', HOST_OPTIONS, 'claude-code')) as SetupHost;
  const setupResult = await deps.setup(host);

  // 2. 분석/언어 도구
  const provision = await deps.runProvision(io);

  // 3. 프로젝트 agent 연결(발견 → 추천 role → 승인한 것만 등록)
  const agents = await deps.runAgentLink(io);

  // 4. memory 저장
  let memory: SetupWizardResult['memory'] = { mode: 'in-project', result: null };
  const separate = await confirm(io, 'memory를 별도 git 저장소로 분리할까?', false);
  if (separate) {
    const mode = (await select(
      io,
      'memory 분리 방식',
      MEMORY_OPTIONS,
      'gitignore',
    )) as MemorySeparateMode;
    memory = { mode, result: await deps.separateMemory(mode) };
  }

  return { host, setup: setupResult, provision, memory, agents };
}
