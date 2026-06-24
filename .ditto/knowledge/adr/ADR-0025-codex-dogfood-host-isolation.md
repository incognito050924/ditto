# ADR-0025: Codex dogfood 수정은 Claude Code 표면과 분리한다

- 상태: accepted
- 결정 일자: 2026-06-23
- 결정자: hskim, codex
- 관련: ADR-0016 (dual-host 구조와 Codex 공식 발견 경로), ADR-0022 (자기호스팅 dogfood 진입과 격리), ADR-0012 (제품/개인 런타임 3계층 격리). 코드(권위): `scripts/dogfood.mjs`, `scripts/build-codex-plugin.mjs`, `scripts/build-plugin.mjs`, `src/core/setup.ts`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`.

## 컨텍스트

DITTO는 Claude Code와 Codex 두 호스트를 지원한다. 두 호스트는 공통 코어를 공유하지만 로드 방식이 다르다.

- Claude Code dogfood는 `claude --plugin-dir <repoRoot>`로 repo를 직접 로드한다.
- Codex dogfood는 `--plugin-dir` 등가물이 없어 격리 `CODEX_HOME`에 local marketplace를 등록하고 `ditto@ditto-local`을 설치한다.

이번 결함은 `bun run dogfood --host codex`에서 self-host `ditto setup`이 no-op 되면서 Codex가 읽을 `$REPO/.agents/plugins/marketplace.json` 또는 dogfood 전용 marketplace를 얻지 못해 `plugin ditto was not found`로 실패한 것이다.

이 문제를 고치면서 Claude Code의 설치·dogfood·배포 표면이 같이 바뀌면 dual-host 분리가 약해진다. Codex만의 설치 결함을 Claude Code 경로에 섞으면, 이미 동작하는 Claude Code dogfood까지 회귀시킬 수 있다.

## 결정

Codex dogfood 설치 실패 수정은 **Codex host 경로에만** 둔다. Claude Code host 표면은 비목표 회귀 영역으로 본다.

1. **Codex-only 수정 경계.** 기본 수정 대상은 `scripts/dogfood.mjs`의 `host === 'codex'` 분기, `scripts/build-codex-plugin.mjs`, `src/core/setup.ts`의 Codex host 분기 중 하나다. Claude Code 분기(`host === 'claude' | 'claude-code'`), `scripts/build-plugin.mjs`, `.claude-plugin/*`는 수정하지 않는다.

2. **self-host dogfood는 repo 관리가 아니라 격리 staging이다.** self-host에서 Codex marketplace가 필요하면 repo 루트에 Claude Code용 marketplace를 끼워 맞추지 않는다. Codex 전용 marketplace는 `.ditto/local/` 아래 같은 개인 런타임 구획이나 Codex setup이 소유한 `.agents/plugins/marketplace.json` 경로 중 하나를 사용한다. 선택한 경로는 Codex branch에서만 소비한다.

3. **shared 파일을 건드릴 때는 host gate가 필수다.** 공통 코드(`src/core/setup.ts` 등)를 수정해야 하면 host 입력으로 Codex만 분기하고, 기본값과 Claude Code 동작은 유지한다. shared hook source인 `hooks/hooks.json`은 계속 Claude source로 둔다. Codex-specific `--host codex` 주입은 기존처럼 Codex build artifact에만 적용한다.

4. **검증은 Codex 성공 + Claude 비회귀를 같이 닫는다.** Codex 수정 완료 주장은 `bun run dogfood --host codex --no-launch`가 `codex plugin add ditto@ditto-local`까지 통과해야 한다. 동시에 Claude Code 비회귀는 최소한 `bun run build:plugin` 또는 `bun run dogfood --host claude --print`처럼 Claude branch를 실행하는 fresh command로 확인한다. 둘 중 하나라도 미검증이면 완료 응답에 미검증으로 남긴다.

5. **문서와 안내도 host별로 분리한다.** Codex dogfood 안내를 고칠 때 Claude Code marketplace/install 문구를 재해석하지 않는다. 문서 변경이 필요하면 `DEVELOPMENT.md`의 host별 dogfood 설명에 Codex-only 보충으로 남긴다.

핵심은 Codex 결함을 "공통 plugin 설치 문제"로 풀지 않는 것이다. 이 결함은 Codex의 stateful marketplace 진입 문제이며, Claude Code의 stateless `--plugin-dir` 경로와 분리해 다룬다.

## 기각된 대안

- **`.claude-plugin/marketplace.json`을 Codex가 읽게 맞추기:** Claude Code marketplace 메타데이터를 Codex dogfood workaround로 쓰게 된다. host별 표면 분리(ADR-0016 D3/D5)를 흐리고 Claude Code install 의미를 바꿀 수 있어 기각.
- **self-host no-op을 모든 host에서 제거:** `ditto setup`의 "repo는 자기 자신의 관리 대상이 아니다" 원칙을 깨고, repo 루트에 project setup 산출물을 남길 수 있다. Codex dogfood에는 staging만 필요하므로 전체 제거는 과하다.
- **Claude와 Codex dogfood를 단일 marketplace 경로로 통합:** Claude Code는 이미 `--plugin-dir`로 source 직접 로드가 가능하다. Codex의 stateful 제약을 Claude Code 경로에 전파하는 통합은 불필요한 결합이다.

## 철회 · 재검토 조건

- Claude Code가 Codex와 같은 stateful marketplace-only 모델로 바뀌거나, Codex가 `--plugin-dir` 등가의 stateless 로드 경로를 제공하면 dogfood 진입 분리를 재검토한다.
- Codex 공식 marketplace 발견 경로가 ADR-0016 D5와 달라지면, Codex 경로만 실측 기준으로 갱신하고 이 ADR의 "Claude Code 비회귀" 원칙은 유지한다.
- 실제 수정에서 Claude Code 파일을 바꾸지 않고는 Codex dogfood를 고칠 수 없다는 코드 근거가 나오면, 그때는 영향 범위와 Claude 비회귀 검증을 ADR amendment로 남긴다.
