/**
 * 외부 도구 프로비저너 추상 (CodeQL · Playwright · 언어별 LSP 서버 공통).
 *
 * ditto가 설치할 수 있는 모든 무거운 외부 도구를 하나의 계약 뒤로 통일한다. 그래야
 * wizard(`ditto setup`), `doctor … --install`, 설치 부트스트랩이 **같은 로직**을 호출하고,
 * 지금처럼 `scripts/install-plugin.mjs` ↔ `src/core/codeql/install.ts`로 설치 로직이
 * 두 군데 손동기화되는 일(install.ts 주석의 "둘을 바꿀 땐 같이 바꿀 것")이 사라진다.
 *
 * 철학(codeql/install.ts + e2e/browser.ts에서 그대로 가져옴):
 *  - opt-in only: 분석/autopilot 흐름 *도중* 몰래 설치하지 않는다.
 *  - fail-soft: install()은 throw 대신 {status:'failed', manual:[복붙 명령]}을 돌려준다.
 *  - shared probe: resolveExisting()이 소비자가 의존하는 **유일한 접점**이다.
 *    (LSP 표면은 오직 resolveServer(language) 하나에만 의존 — provisioning 없이
 *     서버를 PATH에 수동 설치해도 같은 probe가 잡는다.)
 */
import type { InstallResult, InstallStatus } from '~/core/codeql/install';
import {
  type InstallDeps,
  defaultInstallDeps,
  installCodeqlCli,
  manualInstructions,
} from '~/core/codeql/install';
import { lspProvisioners } from '~/core/provision/lsp-servers';
import { playwrightProvisioner } from '~/core/provision/playwright';

// 일반 결과 타입은 codeql/install.ts가 정본(현 위치)이며 여기서 재노출한다. 통일 후
// 이 타입들을 provision/으로 끌어올리는 건 별도 구조적 정리(Tidy First) 단계로 둔다.
export type { InstallResult, InstallStatus };

/** 한 도구가 설치되기 전에 갖춰져 있어야 하는 전제(예: tsserver는 node, gopls는 go). */
export interface Prereq {
  /** 전제 도구 이름. 예: 'node', 'go', 'jdk17'. */
  name: string;
  /** 존재 확인용 probe 명령. 예: ['node', '--version']. */
  probe: string[];
  /** 이 전제가 왜 필요한지(설치 안내에 노출). */
  reason: string;
}

/**
 * 프로비저너 한 개. 인스턴스는 자신의 deps를 이미 닫아 들고 있으므로(팩토리가 주입),
 * install()/resolveExisting()은 인자를 받지 않는다 — codeql의 `installCodeqlCli(deps)` +
 * `defaultInstallDeps` 패턴을 그대로 일반화한 것이다.
 */
export interface Provisioner {
  /** 안정 식별자: 'codeql' | 'playwright' | `lsp:${language}`. */
  id: string;
  /** wizard/doctor 출력용 사람 라벨. */
  label: string;
  /** 이미 있으면 resolved 경로, 없으면 null. **공유 probe 계약**. */
  resolveExisting: () => Promise<string | null>;
  /** opt-in 설치. fail-soft: 예상 실패는 status:'failed' + manual로, throw 하지 않는다. */
  install: () => Promise<InstallResult>;
  /** 자동 설치 불가/거부 시 복붙용 수동 명령. */
  manual: () => string[];
  /** 먼저 갖춰져야 하는 전제들(없으면 빈 배열). */
  prereqs: () => Prereq[];
}

/**
 * 프로비저너 레지스트리. 단일 인스턴스 도구(codeql/playwright)는 `tools`에, 언어별 LSP
 * 서버는 `lsp`에 (language-ledger의 언어 id 기준) 담는다. wizard는 대상 repo가 실제 쓰는
 * 언어로 `lsp`를 필터링해 빠진 서버만 설치한다.
 */
export interface ProvisionerRegistry {
  /** 단일 인스턴스 도구, id 기준. */
  tools: Map<string, Provisioner>;
  /** 언어별 LSP 서버, language 기준. (증분 3에서 채워짐) */
  lsp: Map<string, Provisioner>;
}

/**
 * LSP 표면(다른 세션)의 유일 의존 계약: 한 언어의 LSP 서버 경로를 resolve, 없으면 null.
 * 이 시그니처는 불변 계약으로 고정한다 — 소비자는 이 함수에만 결합한다.
 */
export async function resolveServer(
  registry: ProvisionerRegistry,
  language: string,
): Promise<string | null> {
  const server = registry.lsp.get(language);
  return server ? server.resolveExisting() : null;
}

/**
 * CodeQL 어댑터: 기존 `installCodeqlCli` + `defaultInstallDeps`를 Provisioner 모양으로 감싼다.
 * codeql/install.ts는 손대지 않는다(기존 단위테스트 GREEN 유지) — 통일은 이 어댑터 위에서.
 */
export function codeqlProvisioner(deps: InstallDeps = defaultInstallDeps): Provisioner {
  return {
    id: 'codeql',
    label: 'CodeQL CLI',
    resolveExisting: deps.resolveExisting,
    install: () => installCodeqlCli(deps),
    manual: () => manualInstructions(deps.platform()),
    // curl/unzip/tar는 install() 내부에서 다루므로 별도 전제로 노출하지 않는다.
    prereqs: () => [],
  };
}

/** 기본 레지스트리(실제 deps): codeql·playwright + 언어별 LSP 서버. */
export function defaultRegistry(): ProvisionerRegistry {
  return {
    tools: new Map<string, Provisioner>([
      ['codeql', codeqlProvisioner()],
      ['playwright', playwrightProvisioner()],
    ]),
    lsp: lspProvisioners(),
  };
}
