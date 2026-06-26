# ADR-20260626-work-lifecycle-lightweight-path: ditto work-lifecycle 경량 경로 — 경량/무거운 2-경로 + logged-override 스펙트럼 + 줄기·후속·push-ready 받침

- 상태: accepted
- 결정 일자: 2026-06-26
- 결정자: hskim, claude (claude-opus-4-8)
- 관련: ADR-0022 (자기호스팅 도그푸딩·배포 생애주기 — 이 결정이 그 lifecycle을 *실사용 가능*하게 보강·강화한다), ADR-0020 (결정-모순 가드레일 — 경량/무거운 enforcement의 logged-override가 그 "차단 기본값 + 기록된 정당화" 패턴을 재사용), ADR-0010 (기능 4축 — 축2 autopilot 무거운 경로는 불변; 경량 경로는 그 옆에 *추가*된 진입로). **supersede 없음.** 구현 WI: wi_260626wnv(브랜치 `wi_260626wnv-lifecycle`, 커밋 cf4a73a..04a0400, 이 ADR은 acceptance ac-7). 설계 SoT였던 `reports/design/ditto-work-lifecycle-gaps.md`는 이 ADR + 코드로 흡수되어 **폐기 대상**(권위는 코드·이 ADR로 이전, §4-11). 코드(권위): `ditto work set-criteria|start --criteria|promote|done --status|follow-up|stem|push-ready`, work-item 스키마의 additive-optional 필드(`declared_risk`·`discovered_by`·`follows`·criteria `superseded`/provenance).

## 컨텍스트

ditto는 "풀 세리머니(deep-interview→pre-mortem→autopilot) 아니면 무절차" 두 극단만 제공했다. 그 사이가 비어 있어, 작고 가역적인 작업에서도 에이전트가 표준 경로를 우회하고 멋대로 TDD(ad-hoc)로 빠졌다 — 그렇게 만든 작업은 추적·종결·묶음·정결한 배포가 안 됐다.

뿌리 진단(정정됨): 신축이 필요한 게 아니었다. 경량 메커니즘의 *조각들은 이미 있었으나* 미연결·미표면화·friction으로 막혀 있었다. 핵심 friction은 `work start`가 박는 **placeholder 기준**(`PLACEHOLDER_AC_STATEMENT`)을 *세리머니 없이 진짜 기준으로 바꿀 수단이 없다*는 것이었다 — deep-interview/tech-spec만 진짜 기준을 만들었고, `verify`는 기존 기준의 verdict만 채웠고(placeholder를 verify해야 무의미), placeholder + 완료계약 없는 WI는 `done`이 거부하고 `abandon`은 done을 "포기"로 거짓표기했다. 결과: 직접 구현으로 끝낸 작업이 **닫을 곳이 없었다**. 후속/발굴버그는 산문 목록으로 사용자에게 던져졌고(사용자를 PM으로 만듦), 관련 WI를 한 줄기로 닫을 도구가 없었고, push가 경계 사건이 아니라 기본 단계로 강요됐다. 케이스 스터디: far-field 줄기(vjo→227h→258zu→l0v→txs, 5 WI 전부 open/partial)가 이 6개 증상을 정확히 한 번씩 실증했다.

10개 결정은 wi_260626wnv의 deep-interview로 사용자와 합의해 잠갔다.

## 결정

무거운 경로(deep-interview→autopilot)는 **그대로 두고**, 그 옆에 *실사용 가능한 경량 경로*와 5개 받침 메커니즘을 **구현·landed**한다.

1. **경량 진짜-기준 세터.** `work set-criteria <wi> --criteria` 와 `work start --criteria` 가 placeholder를 *관측 가능한* 기준으로 교체한다(`acceptanceTestable` 재사용). `verify`는 no-op 명령을 거부한다. 첫 verdict 이후 기준은 provenance와 함께 잠긴다(`superseded` 표기) — 골대 옮기기 금지.
2. **경량 종결 end-to-end.** verify→done이 intent.json 없이 동작한다. 동시에 정직한 비완료 상태를 노출: `work done --status` 가 `partial`/`blocked` 을 받고(둘 다 `re_entry` 요구), "포기 거짓표기" 없이 닫을 곳을 준다.
3. **경량 vs 무거운 enforcement = logged-override.** 기본은 차단, 기록된 사유로 override(ADR-0020의 logged-justification 패턴 재사용). `work promote` 가 재시작·데이터 손실 없이 *제자리에서* 무거운 경로로 승격한다.
4. **무거운 경로 트리거 = 위험 축.** `risk{non_local, irreversible, unaudited}` + 미해결 unknown 수(`declared_risk` 필드)가 무거운 경로 필요를 판정한다. 이게 placeholder-문자열 nudge를 **대체**한다 — 진짜 기준을 세팅해도 무거운-경로 검출이 조용히 사라지지 않게.
5. **자가-작성+자가-채점 기준의 무결성.** 관측성 게이트(비관측·no-op 기준 거부) + provenance 잠금(골대 이동 불가)으로, 한 에이전트가 기준을 쓰고 스스로 채점하는 경량 경로의 신뢰를 받친다.
6. **기준 타이밍 = 시작 시(`--criteria`) 또는 나중(`set-criteria`).** 탐색적 작업이 1급 시민 — 기준 없이 시작했다가 나중에 잠글 수 있다.
7. **발굴 작업 포착.** work item에 `work follow-up` 슬롯. 발굴된 **버그**는 추적 WI로 *물질화*되고 `discovered_by` 로 역링크된다. **아이디어**는 candidate로 남는다. 미해결인 *자기-유발* high/critical 회귀는 `done` 을 차단(`--resolve` 로 해제).
8. **WI 묶음 = `follows` 체인 계보 엣지 + 파생 줄기 뷰(`work stem`).** 저장된 epic 객체도 아니고 죽은 `child_ids` 트리도 아니다. 일괄 종결은 전원 terminal일 때만(롤업 verdict; 부분-abandon 허용).
9. **push 결합 = PULL-ONLY.** `work push-ready` 가 강한 readiness 신호(전 AC가 실 명령-증거로 pass + 미해결 회귀 없음 + 줄기 done)를 *명시 요청 시에만* 노출한다. 어디서도 능동적 push 제안을 하지 않는다(헌장 §4-8 — push는 사용자의 비가역 결정).
10. **산출물 = 스펙 + 테스트와 함께 landed된 완전 구현.** 모든 스키마 추가는 additive-optional이라 legacy 파싱은 불변.

## 근거 (rationale)

문제는 능력 부족이 아니라 *구조가 나쁜 행동을 합리적 선택으로 만든 것*이었다. 경량 경로가 막혀 있으면(placeholder를 진짜 기준으로 바꿀 수 없으면), 추적되는 절차를 따르는 것보다 멋대로 TDD가 *덜 비싸다*. 그래서 가장 싼 올바른 길을 *열어* 즉흥을 구조적으로 불필요하게 만든다 — 행동 교정(완료 기준)을 에이전트 의지력에만 기대지 않고 구조로 받친다.

설계 원칙: **이미 있는 조각을 연결·완성·기본값화**하되, 비가역 commitment를 최소화한다. 줄기를 *저장된 객체*가 아니라 체인 엣지 위 *파생 뷰*로 둔 것, push를 *pull-only*로 둔 것, 스키마 추가를 전부 *additive-optional*로 둔 것 — 셋 다 "나중에 틀렸다고 판명나도 싸게 되돌릴 수 있게"라는 같은 동기다.

기각된 대안:

- **새 epic/group 객체** — 줄기를 1급 저장 엔티티로 모델링. 스키마 commitment가 크고 비가역. → 체인 엣지(`follows`) + 파생 뷰 채택(가역·스키마 commitment 0).
- **능동적/경계-시점 push 제안** — 완결 단위가 생기면 ditto가 먼저 push를 권함. push는 사용자의 비가역 배포 결정이라 능동 제안 자체가 절차 위임(§4-8). → pull-only(요청 시에만 readiness 노출) 채택.
- **모든 경량 패스에 2차-역할 리뷰어** — 자가-채점 무결성을 별도 리뷰어로 보장. 경량 경로를 다시 무겁게 만들어 목적 상실. → 관측성 게이트 + provenance 잠금으로 대체(리뷰어 없이 자가-채점 신뢰 확보).
- **열린 ~25개 WI 전수 백필** — 모든 기존 WI를 새 모델로 소급. 범위 폭증. → far-field 줄기 라이브 시연 1건으로 한정(나머지는 자연 마이그레이션).

## 변경 조건 (change_condition)

- **pull-only push** — 미푸시 작업이 고통스럽게 쌓이는 패턴이 반복되면, 경계-시점 *알림*(제안 아님) 추가를 재검토. push 결정권은 불변(사용자).
- **파생 줄기 뷰(`work stem`)** — 줄기 질의 비용이 커지면(큰 그래프·잦은 조회) `follows` 체인 위에 persistence(materialized 뷰) 추가 검토. 체인 엣지가 SoT인 모델은 불변.
- **자기-유발 회귀 차단 임계** — `done` 차단의 심각도 임계(`high|critical`)는 실사용에서 과/소 차단이 드러나면 튜닝.
