/**
 * wizard "분석/언어 도구" 단계 — 추론 기본 + 다중선택 보정.
 *
 * 흐름: 소스 트리에서 LSP 언어 추론 → registry의 도구(codeql/playwright) + 감지된 언어의
 * LSP provisioner를 후보로 모음 → 이미 있는 건 표시만, 없는 건 다중선택(추론된 항목 미리
 * 체크)으로 제시 → 선택된 것만 설치(opt-in). 설치는 provisioner.install()에 위임하므로
 * fail-soft(실패해도 manual 안내, throw 없음).
 *
 * LSP provisioner 본체는 타 세션(B)이 registry.lsp에 등록한다. 등록 전 감지된 언어는
 * "서버 미등록"으로 보고만 하고 설치 후보에서 빠진다 — graceful no-op.
 */
import type { InstallResult } from '~/core/codeql/install';
import type { Provisioner, ProvisionerRegistry } from '~/core/provision/provisioner';
import { type Choice, multiSelect } from './prompt';
import type { PromptIO } from './prompt';

export interface ProvisionCandidate {
  id: string;
  label: string;
  /** resolveExisting()이 경로를 돌려줬는가(이미 설치됨). */
  present: boolean;
  /** 다중선택에서 미리 체크할지(없으면 추천 = true). */
  recommended: boolean;
  install: () => Promise<InstallResult>;
  manual: () => string[];
}

/** registry + 감지된 언어로 설치 후보를 만든다(순수: io·설치 없음, resolveExisting probe만). */
export async function planProvisioning(
  registry: ProvisionerRegistry,
  detectedLanguages: string[],
): Promise<ProvisionCandidate[]> {
  const provisioners: Provisioner[] = [
    ...registry.tools.values(),
    ...detectedLanguages
      .map((lang) => registry.lsp.get(lang))
      .filter((p): p is Provisioner => p !== undefined),
  ];
  const out: ProvisionCandidate[] = [];
  for (const p of provisioners) {
    const present = (await p.resolveExisting()) !== null;
    out.push({
      id: p.id,
      label: p.label,
      present,
      recommended: !present, // 이미 있으면 추천 안 함, 없으면 추천(미리 체크)
      install: p.install,
      manual: p.manual,
    });
  }
  return out;
}

export type ProvisionAction = 'installed' | 'already-present' | 'failed' | 'skipped';

export interface ProvisionOutcome {
  id: string;
  action: ProvisionAction;
  message: string;
  manual?: string[];
}

export interface ProvisionSummary {
  outcomes: ProvisionOutcome[];
  /** 감지됐지만 registry.lsp에 provisioner가 없는 언어(서버 미등록). */
  unservicedLanguages: string[];
}

export interface ProvisionStepDeps {
  /** 소스 루트 → 감지된 LSP 언어(파일 수 내림차순). 주입해 fs 없이 테스트. */
  detect: (sourceRoot: string) => Promise<{ language: string; files: number }[]>;
}

/**
 * 도구 설치 단계를 대화형으로 실행한다. 비TTY면 multiSelect가 추천 항목을 그대로 쓰므로
 * (사람 개입 없이) 추론된 빠진 도구를 설치한다.
 */
export async function runProvisionStep(
  io: PromptIO,
  registry: ProvisionerRegistry,
  sourceRoot: string,
  deps: ProvisionStepDeps,
): Promise<ProvisionSummary> {
  const detected = await deps.detect(sourceRoot);
  const languages = detected.map((d) => d.language);
  const unservicedLanguages = languages.filter((lang) => !registry.lsp.has(lang));

  const plan = await planProvisioning(registry, languages);
  const present = plan.filter((c) => c.present);
  const absent = plan.filter((c) => !c.present);

  const outcomes: ProvisionOutcome[] = present.map((c) => ({
    id: c.id,
    action: 'already-present' as const,
    message: `${c.label}: 이미 설치됨`,
  }));

  if (absent.length === 0) {
    return { outcomes, unservicedLanguages };
  }

  const choices: Choice[] = absent.map((c) => ({
    label: c.label,
    value: c.id,
    checked: c.recommended,
  }));
  const picked = new Set(await multiSelect(io, '분석/언어 도구 — 설치할 항목', choices));

  for (const c of absent) {
    if (!picked.has(c.id)) {
      outcomes.push({
        id: c.id,
        action: 'skipped',
        message: `${c.label}: 건너뜀(필요 시 기능 degrade)`,
      });
      continue;
    }
    const result = await c.install();
    const action: ProvisionAction =
      result.status === 'installed'
        ? 'installed'
        : result.status === 'already-present'
          ? 'already-present'
          : 'failed';
    outcomes.push({
      id: c.id,
      action,
      message: `${c.label}: ${result.message}`,
      ...(result.manual ? { manual: result.manual } : {}),
    });
  }

  return { outcomes, unservicedLanguages };
}
