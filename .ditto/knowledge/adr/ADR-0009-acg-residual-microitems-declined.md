# ADR-0009: ACG 잔여 micro-item 명시 종결 — 4건 "구현 안 함" + 철회조건

- 상태: accepted (결정 = 구현 안 함. ACG governance 표면을 닫기 위한 종결 기록)
- 결정 일자: 2026-06-05
- 결정자: hskim, claude (claude-opus-4-8)
- 관련: ADR-0008(호스트-추상 보류), `reports/design/agentic-governance/v0-implementation-plan.md` §2.2, 핸드오프 wi_260605aw1 §2 소소, wi_260605acg

## 컨텍스트

ACG v0 governance 표면은 2026-06-05 기준 기능적으로 완성됐다(§2.2의 OUT 항목이 전부 IN으로 이동, 코드 대조). 남은 것은 semantic 트랙 핸드오프가 "소소(옵션)"로 이월해 온 micro-item 4건뿐이다. "계속 보류로 띄워두지 않는다"는 방침에 따라, 각 건을 **구현 또는 명시적 비-구현**으로 종결한다.

판단 기준(사용자 지시): 작아도 유의미한 효과가 있으면 구현하되, 공연히 복잡성을 높이거나 위험을 내포하면 **과감히 명시적으로 구현하지 않는다**. 4건 모두 후자에 해당해 비-구현으로 종결한다.

## 결정

### D1 — `semantic-scan-status.json`(observe 실패 durable 가시화, OBJ-7): 구현 안 함

효과는 "observe 실패 후 Stop nudge가 'observe 실행'을 반복하지 않게" 하는 cosmetic 마찰 감소뿐이다. 비용은 새 스키마 + 영속 artifact + observe 쓰기 + nudge 읽기 배선 — **복잡성 > 효과**. observe 실패는 지금도 foreground 명령에서 즉시 노출된다(침묵 실패 아님).

- 철회조건: observe가 자동 발동(비-foreground)이 되어 실패가 사용자에게 안 보이게 되면, durable 상태가 필요해진다.

### D2 — nudge opt-out(의미무관 work item 침묵): 구현 안 함

opt-out 레버는 거버넌스 nudge를 끄는 수단이라, 실제 exported-signature 변경 신호를 **은폐할 위험**을 내포한다. nudge는 본래 보수적(CodeQL 없이 git diff만 보므로 시그니처 변경 여부를 모름)이라 과알림이 설계상 안전 측이다. opt-out은 그 안전 측을 사용자 손에 깨게 한다.

- 철회조건: 과알림이 실측으로 과해 사용자 작업을 방해한다는 근거가 모이면, opt-out보다 "변경 파일이 exported를 안 건드림"을 정적으로 입증하는 정밀화를 먼저 검토.

### D3 — `executed` fitness 자동-stop 트리거: 구현 안 함 (opt-in 유지)

`executed`-mode provider는 구현됐다(`executed-provider.ts`). 미구현인 것은 Stop 시점 **자동 발동**이다. executed 실행은 CodeQL DB를 빌드/실행해 비싸므로(매 Stop마다 부과) `--execute` opt-in으로 둔 것이 의도된 비용 결정이다. 자동화는 그 비용을 기본값으로 만든다.

- 철회조건: executed 실행 비용이 무시 가능해지거나(캐시·증분), 자동 발동이 실제로 필요한 워크플로가 생기면.

### D4 — 어휘 enum 승격(`risk_reason_code` 등 free-string → enum): 구현 안 함

현재 표본은 첫 바인딩(이 저장소) 1개뿐이다. 값 집합을 지금 enum으로 굳히면 두 번째 바인딩에서 빗나갈 가능성이 크다 — 조기 추상화(Charter §4-3).

- 철회조건: 두 번째 바인딩에서 같은 값 집합이 반복 관측되면 enum으로 승격.

## 대안 (기각)

- **4건을 "백로그"로 계속 이월**: "보류로 띄워두지 않는다" 방침과 충돌. 종결(구현 또는 명시 비-구현)이 백로그를 비운다. 기각.
- **유의미성이 낮아도 일괄 구현**: D1~D4는 각각 복잡성·위험·비용·조기성을 내포 — MINIMUM VIABLE 위반. 기각.

## 변경 조건 (이 ADR을 다시 열 때)

각 결정의 철회조건(D1~D4) 중 하나라도 충족되면 해당 건만 재개한다. 그 전까지 ACG governance 표면은 닫힌 것으로 본다.
