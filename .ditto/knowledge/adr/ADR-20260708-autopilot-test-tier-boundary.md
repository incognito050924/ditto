# ADR-20260708-autopilot-test-tier-boundary: autopilot 테스트 barrier = 유닛/목 tier 전용 — 완료 게이트로서 per-AC oracle과 AND, 통합/E2E는 범위 밖(push-gate·CI·e2e 소관)

- 상태: accepted
- 결정 일자: 2026-07-08
- 결정자: hskim, claude (claude-opus-4-8)
- 관련: ADR-0024 (기획~구현 품질 floor — 이 ADR은 그 "executable-test 유일 수렴 화폐" 기각과 **정합**: barrier는 per-AC oracle을 대체하지 않고 AND된다), ADR-0018 (선택적 외부도구 우아한 강등 — barrier 실행불가 시 degrade-to-unverified 경로가 그 D1/D2 불변식을 상속), ADR-0014 (E2E DSL·에이전트 변환·게이트) 및 ADR-20260702 (공식 Playwright test-agents — 실브라우저/실인프라 E2E는 이 두 ADR의 `ditto e2e` 표면 소관이지 barrier 소관이 아님), ADR-20260628-github-backlog-sot·ADR-20260626-work-lifecycle-lightweight-path (push-gate 계보 배경). 진단 근거(이 결정을 촉발): wi_260708yx5 = `reports/design/autopilot-test-execution-gaps.md`(boxwood portal-backend 실 MariaDB로 실증한 6대 결함 — 통제 대상만 격리하고 새는 것[테스트 읽기·DB 쓰기]은 미격리). 코드(권위): `src/schemas/recipe.ts`(`recipeBarrierTestCommand`·`barrier_test_command` — top-level + `repos[]` per-repo 대칭; 부재→런타임 DEGRADE, present-but-empty→`min(1)` 실패; 60-78행 CAVEAT가 side-effect-free 유닛 서브셋 강제 서술), `src/cli/commands/push-gate.ts`(`defaultRunTest`/`RunTest` — `passed|failed|unrunnable` 판별 결과 + push 시 fail-closed(126/127→unrunnable→block)). 구현 WI: wi_260708ds9.

## 컨텍스트

autopilot 루프는 완료 통화를 "AC가 재평가 가능한 oracle로 닫힘"으로 삼는다(ADR-0024 결정 1). 그 oracle 부류 중 **hard·동적**(테스트=실행)을 루프 안에서 자동 실행하려면 테스트 러너를 구동해야 한다. 문제는 *어떤 tier의 테스트를* 자동으로, 매 완료마다 돌릴 것인가다.

wi_260708yx5 진단(boxwood portal-backend 원격 실 MariaDB)은 통합/E2E 테스트를 autopilot 흐름에서 무분별 실행하면 생기는 실패 모드를 실증했다: 전체 스위트 병렬 실행·격리 비대칭·러너 하드코딩·공유 인프라(실 DB) 비가역 쓰기. 근본 원인은 ditto가 *통제 대상만* 격리하고 *새는 것*(테스트가 읽는 실 파일, 테스트가 쓰는 실 DB)은 격리하지 못한다는 점이다. 즉 autopilot barrier가 실 인프라를 건드리는 테스트를 매 완료 시점에 병렬로 돌리면, 공유 상태를 오염시키고 다른 노드/개발자에게 새어 나간다.

한편 저장소에는 이미 실 인프라·전체 스위트를 다루는 표면이 있다: **push-gate**(push 시점 전체 스위트, fail-closed), **CI**(원격 왕복 스모크·npx 배포 게이트), **`ditto e2e`/Playwright**(실브라우저 E2E, ADR-0014·ADR-20260702). barrier가 이들과 tier·처분을 뒤섞으면 중복 구축이자 §4-11 drift다.

## 결정

autopilot 테스트 **barrier의 tier 경계를 못박는다.**

### D1 — barrier는 유닛/목 tier 전용 (safe·fast·scope-local)

autopilot 완료 barrier는 **side-effect-free 유닛/목 서브셋**만 실행한다 — 실 DB 없음, 네트워크 없음, 공유 fixture 없음, 빠르고 스코프-로컬. barrier 명령은 recipe의 `barrier_test_command`(top-level + `repos[]` per-repo 대칭)로 선언한다. 이는 `push_gate.test_command`(push 시점 전체-스위트 가드)와 **명시적으로 구별되는 별도 필드**다.

### D2 — barrier는 per-AC oracle을 대체하지 않고 AND된다

barrier는 완료 게이트의 *한 요소*이지 완료 통화 그 자체가 아니다. 완료는 여전히 **per-AC oracle 충족 AND barrier 통과**로 판정된다(ADR-0024 결정 1의 AC↔oracle 수렴 위에 얹힘). barrier를 "실행 가능한 테스트 = 유일 수렴 화폐"로 승격하지 않는다 — 그것은 ADR-0024가 명시적으로 **기각한 대안**이다(floor를 테스트 가능한 것으로 축소, 정적·soft oracle 부류 누락). barrier가 green이어도 static_scan·soft oracle이 안 닫히면 AC는 안 닫힌다.

### D3 — 통합/E2E는 barrier 범위 밖 (기존 표면 소관, 이 WI는 통합 러너를 만들지 않는다)

실 공유 인프라를 건드리는 통합/E2E 테스트는 **barrier의 범위 밖**이다. 이들은 이미 존재하는 표면에 산다:

- **push-gate** — push 시점 전체 스위트(`push_gate.test_command`, fail-closed).
- **CI** — 원격 왕복·배포 게이트.
- **`ditto e2e` / Playwright** — 실브라우저 E2E(ADR-0014 D1/D2, ADR-20260702).

**이 WI(wi_260708ds9)는 통합 러너를 구현하지 않는다.** barrier는 유닛 tier 러너 하나이고, 통합/E2E의 실행·격리·비가역 안전은 각 소관 표면의 책임으로 남긴다(중복 구축 금지, §4-11).

### D4 — barrier 실행불가 = degrade-to-PROCEED (push-gate block의 정반대)

barrier 명령이 실행 불가일 때(recipe에 `barrier_test_command` 부재, 또는 러너가 spawn 안 됨 / 126·127 not-found) barrier는 **degrade-to-unverified하고 진행한다** — "tests unverified"를 정직하게 기록하고, 절대 "passed"로 날조하지 않으며, 흐름을 멈추지도 않는다(ADR-0018 D1/D2). 

이 처분은 **push-gate의 정반대**임을 명시한다: 같은 "실행 불가"(unrunnable) 신호를 놓고 **push-gate는 fail-closed로 BLOCK**(push는 비가역이므로 검증 못 하면 막는다, ADR-0018 D3 evidence-gated의 push 변형), **barrier는 degrade-PROCEED**(autopilot 자율성 불변식 — 도구 부재가 의도 실현을 인질로 잡지 않는다). 두 표면이 같은 판별 결과(`unrunnable`)를 서로 다른 방향으로 라우팅하는 것은 버그가 아니라 tier별 위험 비대칭(완료=가역 / push=비가역)의 의도된 반영이다.

## 근거 (rationale)

- **유닛 tier 전용이 barrier를 매 완료마다 안전하게 돌릴 수 있게 하는 유일한 조건이다.** barrier는 autopilot 루프의 모든 완료 시점에 발동한다 — 그 빈도에서 실 인프라를 건드리면 wi_260708yx5가 실증한 공유 상태 오염이 반복 사고가 된다. side-effect-free 유닛 서브셋만이 "매번 돌려도 안전"을 성립시킨다.
- **oracle을 대체하지 않고 AND하는 것은 ADR-0024 정합의 핵심이다.** barrier를 유일 수렴 화폐로 삼으면 floor가 테스트 가능한 것으로 축소되고 static_scan·soft 부류가 누락된다(ADR-0024 기각 대안 재현). barrier는 hard·동적 oracle의 *자동 실행 경로*일 뿐, 완료 통화가 아니다.
- **통합/E2E를 기존 표면에 남기는 것은 중복 구축·drift 회피다.** push-gate·CI·`ditto e2e`가 이미 실 인프라·전체 스위트·실브라우저를 각자의 격리·처분 규율로 다룬다. barrier가 그 tier를 흡수하면 이중 구현이고, 두 러너가 조용히 갈라지면 §4-11 drift다.
- **degrade-PROCEED vs block의 비대칭은 가역성 축을 따른다.** 완료는 가역(git revert 가능한 착지)이라 도구 부재를 진행으로 흡수해도 안전하지만, push는 비가역이라 검증 공백을 막아야 한다. 같은 신호, 다른 tier, 다른 처분.

## 정직한 잔여 (honest residual — 절대 과잉주장 금지)

**"safe-by-construction"은 guidance-guaranteed이지 construction-guaranteed가 아니다.** 이 경계의 안전은 구조로 강제되지 않고 *지침·주석·이 ADR로 안내*될 뿐이다:

- barrier 명령(`barrier_test_command`)은 **자유 형식 문자열**이다(스키마는 `min(1)`만 강제 — recipe.ts). 프로젝트가 이 필드를 통합 스위트나 실 DB를 건드리는 명령으로 가리키는 것을 스키마·게이트가 막지 못한다.
- 그리고 barrier는 **매 완료마다 발동**하므로, 잘못 가리킨 barrier는 wi_260708yx5 진단(boxwood 실 MariaDB)이 문서화한 바로 그 공유-인프라 실패를 autopilot 흐름 안에 재도입한다.

따라서 이 ADR은 **절대적 안전을 주장하지 않는다.** barrier tier 경계는 오분류를 *어렵게*(별도 필드·명시 CAVEAT·이 ADR) 만들 뿐 *불가능하게* 만들지 않는다. 구조적 강제(예: barrier 명령을 실 인프라 접근 없이 실행하도록 격리 샌드박스에서 구동, 또는 정적 검출로 infra-touching 패턴 거부)는 착지하지 않았다 — 남은 위험으로 명시한다.

## 후속 (follow-up)

- **push-gate를 공유 test-runner 헬퍼로 이관.** barrier는 실행 결과 판별(`passed|failed|unrunnable`, 126/127 not-found 구별)을 공유 discriminator로 추출/사용하지만, push-gate(`src/cli/commands/push-gate.ts` `defaultRunTest`)는 아직 자체 러너를 들고 있다. 두 표면이 같은 spawn·exit-code 판별 로직을 중복 보유하면 조용히 갈라질 수 있다 — 공유 헬퍼로 일원화하되, **처분(barrier=degrade-PROCEED / push-gate=fail-closed BLOCK)은 tier별로 갈린 채 유지**한다(로직 공유 ≠ 처분 통합).

## 변경 조건 (change_condition)

- 자유 형식 barrier 명령의 오분류(실 인프라 테스트를 barrier로 가리킴)가 실사용에서 실제 사고를 내면 → "정직한 잔여"의 구조적 강제(격리 샌드박스 실행 또는 infra-touching 정적 검출)를 barrier 발동 경로에 착지시키는 것을 재검토. guidance-guaranteed를 construction-guaranteed로 승격.
- barrier(유닛 tier)가 닫지 못하는 hard·동적 검증이 빈발해(대부분 AC가 통합 tier 실행을 유일 증거로 요구) 완료율을 실측으로 크게 떨어뜨리면 → barrier tier 경계 자체가 틀린 분류인지, 또는 통합 tier를 barrier와 별도의 격리된 자동 실행 경로로 들일지 재검토(단, push-gate·CI·`ditto e2e` 중복 구축은 여전히 금지).
- push-gate 공유 헬퍼 이관(후속) 이후, 두 표면의 처분 비대칭(degrade vs block)이 공유 로직 위에서 여전히 명확히 갈리는지 재확인.
- ADR-0024의 AC↔oracle 수렴 모델이 바뀌면 → barrier가 "AND되는 한 요소"라는 D2 위치를 재확인.
