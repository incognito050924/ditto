# ADR-20260626-worktree-subrepo-scope-clarify: per-feature ephemeral worktree · workspace rootingRoot 하위 sub-repo 쓰기 (ADR-0022·ADR-0011 clarify — supersede 아님)

- 상태: accepted
- 결정 일자: 2026-06-26
- 결정자: hskim, claude (claude-opus-4-8)
- 관련: ADR-0022 (자기호스팅 도그푸딩·배포 생애주기 — D1 "단일 repo, worktree 비상주"의 worktree 기각을 **clarify**), ADR-0011 (Distribution 횡단 배포계약·session-rooting invariant — D2 "scope-out=세션 repoRoot 밖 쓰기 차단"의 rootingRoot 경계를 **clarify**), ADR-0020 (결정-모순 가드레일 — 본 충돌의 classify×route×disclose 경로). 코드(권위): `src/hooks/pre-tool-use.ts`(scope-out 쓰기 가드 — rootingRoot 경계), `scripts/dogfood.mjs`(host별 워킹트리 로드). 구현 WI: wi_260625k0w.

## 컨텍스트

본 work item(wi_260625k0w)이 두 작업 방식을 도입하면서, 그것이 기존 두 ADR의 기각·경계를 뒤집는 것처럼 보일 소지가 생겼다. ADR-0020(결정-모순 가드레일)에 따라 충돌을 분류·해소·명문화한다. 결론은 **둘 다 supersede가 아니라 직교 확장 + 경계 명확화**다.

1. **per-feature ephemeral worktree.** 한 PC에서 여러 feature를 병렬 개발할 때, feature마다 단기(ephemeral) `git worktree`를 만들고 worktree별로 dogfood 빌드를 격리한다. ADR-0022 D1은 worktree를 기각하면서 "기각된 대안 — git worktree: `.git`을 공유해 격리가 clone보다 약하다"고 적었으므로, 표면적으로는 본 work item이 그 기각 메커니즘을 재도입하는 것으로 읽힐 수 있다.

2. **workspace rootingRoot 하위 sub-repo 쓰기.** 세션을 개별 repo가 아니라 상위 **워크스페이스 rootingRoot**에 루트하면, 그 하위 저장소(sub-repo)에 쓰기가 일어난다. ADR-0011 D2의 session-rooting invariant("scope-out이 세션 repoRoot 밖 쓰기를 차단 — 버그가 아니라 경계", cross-repo subagent 위임 비지원)와 충돌하는 것처럼 읽힐 수 있다.

충돌 분류(ADR-0020): (1)은 애초 intent-level로 보였으나 **사용자 사전결정으로 직교 확장임이 해소**됐다. (2)는 method-level 명확화(정렬) — invariant 재설계가 아니라 rootingRoot 경계의 해석을 박는 것이다.

## 결정

### D1 — ADR-0022의 worktree 기각은 '격리-상주 도그푸딩' 목적에 한정된다 (ephemeral worktree는 직교 축, clarify)

ADR-0022 D1이 worktree를 기각한 것은 **stable/dev를 격리하기 위해 worktree를 상주(resident dogfood) 환경으로 두는** 용법에 한정된다. 그 맥락에서 worktree는 "`.git` 공유로 clone보다 격리가 약한, 별도 상태를 둘 곳"이라 견고함 기준에서 탈락했다.

본 work item의 **per-feature ephemeral worktree**는 목적·수명이 다른 **직교 축**이다:

- **목적**: stable↔dev 격리가 아니라, 한 PC에서 여러 feature의 **동시 개발** + worktree별 dogfood 빌드 격리.
- **수명**: 상주가 아니라 ephemeral — feature 작업 동안만 존재하고 끝나면 제거한다.
- **격리 대상**: 도그푸딩 = 자기개발이라 ADR-0022가 말한 "격리할 별도 상태"는 여전히 없다. 여기서 격리하는 것은 feature 간 워킹트리·빌드 산출물 충돌이지, stable/dev 상태가 아니다.

따라서 이는 ADR-0022가 기각한 메커니즘의 재도입이 아니라, **다른 문제(병렬 feature 개발)를 푸는 다른 적용**이다. ADR-0022 D1의 "단일 repo dev+dogfood, worktree 비상주" 결정은 그대로 유효하다 — ephemeral worktree는 상주 환경이 아니므로 그 결정의 부정이 아니다. **supersede 아님.**

### D2 — workspace rootingRoot 하위 sub-repo 쓰기는 in-scope다 (ADR-0011 session-rooting invariant의 rootingRoot 경계 clarify)

ADR-0011 D2의 scope-out 차단 경계는 **세션 rootingRoot 밖 쓰기**다. 세션을 상위 **워크스페이스 rootingRoot**에 루트하면, 그 하위 저장소(sub-repo)에 대한 쓰기는 **rootingRoot 내부**이므로 cross-repo가 아니라 **in-scope**다.

- ADR-0011이 막은 cross-repo(boxwood inc6)는 **rootingRoot 밖 타 repo**에 spawn된 subagent의 쓰기였다. sub-repo 쓰기는 그와 달리 rootingRoot **안**에 있다.
- 이는 invariant 재설계가 아니라 **"세션 repoRoot"가 곧 rootingRoot이고, scope-out은 rootingRoot 경계 기준으로 판정한다**는 해석의 명확화다. rootingRoot를 워크스페이스에 두면 그 하위 sub-repo는 경계 안.
- scope-out의 보호 의도(repo 경계 보호)는 불변이다 — **rootingRoot 밖은 여전히 차단**한다. 바뀌는 것은 "경계의 위치를 워크스페이스 rootingRoot로 둘 수 있다"는 명문이지, "밖도 허용"이 아니다.

따라서 ADR-0011 D2의 invariant(rootingRoot 밖 쓰기 차단 = 버그 아닌 경계, cross-repo 원격 오케스트레이션 비지원)는 그대로 유효하다. **supersede 아님.**

## 대안 (기각)

- **ADR-0022 D1을 supersede(worktree 비상주 결정 철회)** — 본 work item은 상주 worktree를 도입하지 않으므로 D1을 뒤집을 이유가 없다. ephemeral worktree는 직교 축이라 clarify로 충분하다. 기각.
- **ADR-0011 D2를 supersede(session-rooting invariant 재개정)** — sub-repo 쓰기는 rootingRoot 안이라 invariant가 막는 대상이 아니다. invariant를 고치는 게 아니라 경계 위치를 명문화하면 된다. 기각.
- **명문화 없이 진행** — ADR-0022 worktree 기각·ADR-0011 scope-out 차단을 누군가 추론 시점에 만나면(ADR-0020 §query) 본 work item의 worktree·sub-repo 쓰기를 "ADR 위반"으로 오판할 수 있다(ADR-0011이 inc6에서 겪은 "경계를 버그로 오해"의 거울상). clarify ADR로 경계를 박는다. 기각.

## 근거 (rationale)

두 기존 ADR의 기각·경계는 **특정 목적 맥락**에서 내려진 것이다 — ADR-0022는 stable/dev 격리-상주, ADR-0011은 rootingRoot 밖 타 repo 원격 오케스트레이션. 본 work item이 쓰는 worktree·sub-repo는 그 목적 맥락 밖의 직교 적용이라, 같은 어휘("worktree", "repo 밖 쓰기")를 공유할 뿐 같은 결정 대상이 아니다. 어휘 충돌을 supersede로 처리하면 멀쩡한 결정(상주 worktree 비채택·cross-repo 비지원)을 불필요하게 흔든다. clarify는 결정을 보존하면서 적용 경계만 또렷이 한다 — ADR-0011 D3가 ADR-0007과 "cross-repo" 어휘 층위를 구분한 것과 같은 패턴이다.

## 변경 조건 (change_condition)

- ephemeral worktree가 사실상 **상주**(작업 종료 후에도 장기 존속)로 변질되면 → ADR-0022 D1의 worktree 기각 맥락에 다시 들어오므로 격리 강도·동기화 부담을 재평가한다.
- sub-repo 쓰기 요구가 rootingRoot **밖** 타 repo로 확장되면(워크스페이스 경계를 넘는 원격 오케스트레이션) → 그것은 본 clarify가 아니라 ADR-0011 D2 invariant의 변경 조건(cross-repo 세션 운용이 제품 요구가 됨)에 해당하므로 ADR-0011을 재개방한다.
- 워크스페이스 rootingRoot 레이아웃이 `pre-tool-use.ts` scope-out의 rootingRoot 판정 결정성을 깨면(예: 중첩 `.git`로 rootingRoot 모호) → scope-out 경계 판정 로직을 재검토한다.
