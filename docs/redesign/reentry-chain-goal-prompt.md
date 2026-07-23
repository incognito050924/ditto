# 재진입 사슬(A3→A2→A4) 자율 구동 런치 킷

> 결정(2026-07-23 조사): 구동 수단 = **/goal 주도 + ditto 자체 Stop gate(코드-소유 증거 게이트) + /loop 하트비트(선택)**. ultracode(Workflow)는 미사용 — 격리 환경이라 세션 CLI 상태를 공유하지 못하고 실행 중 사용자 입력이 불가하며, 사슬이 진짜 순차(A2·A4가 A3의 저장 계층 산출을 소비)라 팬아웃 이득이 없다. 근거 서베이: `reports/research/goal-loop-engineering-survey.md`.

## §0. 사전 준비 (사람이 실행)

1. 새 터미널에서 block cap을 올려 세션을 시작한다 — ditto Stop gate가 인터뷰 진행 중을 오판해 차단(#95)하더라도 기본 8회 안에 강제 정지되지 않도록:
   ```sh
   CLAUDE_CODE_STOP_HOOK_BLOCK_CAP=80 claude
   ```
2. 첫 메시지로 §1 프롬프트를 붙여넣는다.
3. `/goal`을 실행하고 §2 종료 조건을 붙여넣는다.
4. (선택) `/loop 30m 계속: 재진입 사슬 미션을 이어가라. 완료·중단 토큰이 이미 나왔으면 아무것도 하지 마라.` — 세션이 잘못 멈췄을 때의 하트비트. /goal과의 공존은 공식 문서에 미명시이므로 문제가 생기면 끈다.

## §1. Kickoff 프롬프트 (세션 첫 메시지)

```md
# 미션 (동결): 재진입 사슬 A3→A2→A4 자율 완주

목표를 재해석·확대·축소·분할하지 마라. 막히면 §멈춤으로 인계한다.

## 대상과 순서 (순차 — 사슬 팬아웃 금지)
1. **A3 저장 계층 (#79)** — 기존 work item **wi_260723hcb**(blocked) 재개. 신규 생성 금지.
2. **A2 (#78)** — A3 done 후: `ditto work start --issue incognito050924/ditto#78` (**--issue는 반드시 단독** — 버그 #94: 동반 플래그가 조용히 무시된다) → 사슬 배선은 별도로 `ditto work stem --follows wi_260723hcb`.
3. **A4 (#80)** — 같은 방식, follows는 A2의 work item.

각 항목은 무거운 경로로 완주한다: deep-interview(재개/신규) → finalize → autopilot → `ditto verify` → `ditto work done`. 명령 시그니처가 기억과 다르면 `--help`로 확인 후 호출한다 — 추측 호출 금지.

## A3 재개 절차 (디스크가 SoT)
- 먼저 `.ditto/work-items/wi_260723hcb/record.json`과 인터뷰 상태 파일을 읽어라. 인터뷰는 active, readiness 0.55/0.85, non-critical 2차원(authorization-model·regulatory) 미해결 상태다.
- **잠긴 결정 2건은 불변 — 재질문 금지**: ① 기존 134건 기록은 재작성 금지 읽기전용 유산 + 새 최소 스키마 + 두 세대 합산 백로그 뷰 + 옛 기록 reopen 명시 거부. ② 공존기간엔 옛 src가 유일 실기록자, rebuild는 fixture 계약 테스트로만 검증, 실기록 전환은 flip 게이트 단일 스위치(옛 바이너리 호환장치 불요).
- **미확정 3건은 기록된 추천값으로 자율 확정한다**(사용자 위임이 record.json의 re_entry에 영속 기록됨): 기록 반영 시점=경계 전이 즉시+세부 종료 일괄 / partial verdict=3값 축소+옛 기록 읽기 관용 / GitHub 필드=자리만 코어·동작 제외. 파생: drop 필드 9개는 새 스키마 제외+관용 읽기.
- 잔여 non-critical 차원은 위 결정과 정합인 보수적 답으로 자율 record-turn한다.
- **인터뷰→finalize는 한 호흡에 끝낸다**(중간에 턴을 끝내지 마라 — 버그 #95: Stop gate가 인터뷰 진행 중을 오판해 차단하고, 연속 차단이 쌓이면 강제 정지된다. finalize가 autopilot 아티팩트를 만들면 게이트가 정상 충족된다).

## 규율
- 메인 세션은 디스패처다: 구현·검증·리뷰는 autopilot이 내는 spawn 액션대로 fresh 서브에이전트에 위임하고, 메인은 결론·증거만 회수한다. 네가 만든 것을 네 컨텍스트에서 검증하지 마라.
- 완료는 디스크 증거로만: 각 work item은 record.json `status=="done"` + 전 acceptance_criteria `verdict=="pass"` + `bun test rebuild/` exit 0. 어떤 AC도 주장으로 닫지 마라. 테스트 비활성화·완화·삭제로 통과시키지 마라.
- **증거 브릿지(반드시)**: 각 work item을 닫은 직후 `ditto work status <wi> --output json` 출력(핵심 필드)을 transcript에 인용한다 — /goal 판정자는 transcript만 본다.
- 발견 버그: ditto 분류기가 "재현되는 실동작 버그"로 판정한 것만 같은 run에서 물질화+구동. 비-결함(아이디어·기술부채·잠복버그)은 물질화만 하고 구동하지 않는다.
- **push·merge 금지**(사람 게이트). 커밋은 승인된 단위의 꼬리로만, green일 때만.
- 외래 변경(.ditto/work-items/wi_260722kom 등 이 사슬 밖 dirt)은 건드리지 마라.

## 멈춤 (escape)
다음이면 즉시 blocker를 해당 record에 남기고 마지막 줄에 정확히 `<CHAIN-ESCAPE/>`:
- 잠긴 결정 2건과 충돌하는 방향 전환이 필요할 때
- 보안·시스템·프로젝트·기능설계 의도급 결정이 필요할 때
- 같은 실패가 3회 반복되거나 무진전일 때

## 완료
세 work item 모두 done + 전 AC pass + `bun test rebuild/` green을 **인용한 뒤에만** 마지막 줄에 정확히 `<CHAIN-COMPLETE/>`. 증거 없이 어느 토큰도 발화하지 마라.
```

## §2. /goal 종료 조건 (≤4,000자)

```
STOP은 아래 A(완료) 또는 B(중단) 중 하나가 transcript에 분명히 보일 때만.

A) 완료 — 다음이 모두 보인다:
  1. 세 work item(A3=wi_260723hcb, A2, A4) 각각에 대해 `ditto work status --output json` 출력 인용이 있고, status가 "done"이며 acceptance_criteria 전부가 verdict "pass"다.
  2. `bun test rebuild/` 실행 결과 "0 fail"(exit 0) 인용이 있다.
  3. 마지막 줄에 <CHAIN-COMPLETE/> 가 정확히 나타났다.
  자가주장("고쳤다"·"될 것이다")만 있고 JSON/실행 출력 인용이 없는 AC가 하나라도 보이면 A가 아니다.

B) 중단(escape) — blocker가 record에 기록됐다는 보고가 있고, 마지막 줄에 <CHAIN-ESCAPE/> 가 정확히 나타났다.

또는 총 80턴에 도달하면 STOP(중단으로 간주).

A도 B도 아니면 계속 진행하되, 무엇이 남았는지(미완 work item·미검증 AC·red 테스트)를 다음 턴 가이드로 남겨라. JSON 인용 없이 <CHAIN-COMPLETE/> 가 보이면 거짓 완료 — STOP 아님.
```

## §3. 남은 위험 (정직 표시)

- **/goal × /loop 공존 미문서화** — 공식 문서에 상호작용 명시 없음. 하트비트는 선택 항목으로 두고, 이상 동작 시 /loop만 끈다.
- **blocked→재개 정확한 전환 명령 미확인** — kickoff 프롬프트가 `--help` 확인 규율로 흡수.
- **finalize의 user_confirmation·dissent acknowledge는 설계상 "human half"** — 이번 run은 사용자의 빅뱅 위임(record.json re_entry에 영속 기록)이 근거다. 세션은 그 위임 근거를 확정 시점에 명시 인용해야 한다.
- **80턴 상한은 잠정치** — A3 단독이 아니라 사슬 3건 기준. 초과 시 escape로 떨어지며, 재개는 이 킷 재사용으로 가능(디스크가 SoT라 재진입 안전).
