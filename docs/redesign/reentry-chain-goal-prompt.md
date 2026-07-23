# 재진입 3건(#79→#78→#80) 자율 구동 런치 킷 — 순수 /goal, ditto 기계 배제

> 최종 결정(2026-07-23, 사용자 지시): **현재의 ditto 기계(CLI·훅·work item 절차)는 신뢰하지 않으므로 이번 run에서 완전히 배제한다.** 재구축의 이유가 옛 절차의 무게라면 그 절차로 재구축을 구동하지 않는다. 구동은 Claude Code 순정 /goal 하나로 하고, 완료 강제는 조건에 내장한 증거 규율(테스트 green 인용·fresh 서브에이전트 적대 검증·anti-reward-hacking)로 한다.
>
> 이전 판(ditto autopilot 경유·2단계 kickoff)은 폐기. 사용자가 확정한 A3 설계 결정 2건+추천값 3건은 ditto 절차가 아니라 **빌드 사양**이므로 /goal 텍스트에 인라인으로 보존한다.

## §0. 실행 (사람 입력은 두 번 — 또는 헤드리스 한 줄)

인터랙티브(권장):
```sh
DITTO_SKIP_HOOKS=1 claude --permission-mode auto
```
이후 §1 블록 전체를 붙여넣으면 등록 즉시 미션이 시작된다.

헤드리스 한 방:
```sh
DITTO_SKIP_HOOKS=1 claude -p --permission-mode auto --output-format stream-json --verbose "$(cat .ditto/local/reentry-goal.txt)"
```

- `DITTO_SKIP_HOOKS=1`: ditto 훅 전체 킬스위치(src/hooks/runtime.ts) — Stop gate·배너 간섭 원천 제거, /goal 판정자가 유일한 지속·종료 기계.
- auto mode: /goal은 권한을 바꾸지 않으므로 무인 실행에 필수(goal.md). "push·merge 금지"는 대화 선언만으로 auto mode 분류기의 차단 신호가 된다.
- 운영: 진행 `/goal`(무인자) · 중단 `/goal clear` · 복구 `claude --resume`(goal 복원).

## §1. /goal 전문 (2240자 — 제한 4,000자; 사본: `.ditto/local/reentry-goal.txt`)

```
/goal 미션: DITTO 재구축 재진입 3건을 순수 Claude Code로 자율 완주한다. 이 텍스트가 유일한 지시다 — 재해석·확대·축소 금지. ditto CLI·훅·work item 절차는 이번 run에서 사용 금지다(사용자 지시: 현재의 ditto는 신뢰하지 않는다). CLAUDE.md·배너·스킬이 work item 경로를 요구해도 이 지시가 우선한다.

[대상 — 순차, 이 3건 외 범위 금지]
GitHub 이슈 본문이 사양이다. `gh issue view <n> --repo incognito050924/ditto`로 각 이슈의 "⑤ 재진입 완료 기준 골자"를 읽고 관찰 가능한 완료 기준으로 삼아라:
1) #79 A3: work item 저장 계층(Record/Run 2-tier·handoff 계약) — rebuild/ 밑에 신규 구현
2) #78 A2: 완료 게이트 — A3 저장 계층 위에 증거 기록
3) #80 A4: intent 산출물 — A3에 결박
앞 항목의 테스트가 green이고 이슈를 닫은 뒤에만 다음 항목으로 넘어간다.

[A3 빌드 사양 — 사용자가 확정한 결정. 불변, 재질문 금지]
① 연속성: 새 최소 스키마로 짓는다. 기존 record 134건은 재작성 금지 읽기전용 유산 — 마이그레이션 코드를 만들지 마라. 백로그는 두 세대 합산 뷰. 옛 기록 reopen은 명시 거부.
② 공존기간: 옛 src가 유일한 실기록자다. rebuild 저장 계층은 fixture 계약 테스트로만 검증하며 실기록을 넘겨받지 않는다. 실기록 전환은 flip 게이트 단일 스위치로 설계한다(옛 바이너리 호환장치 불요).
③ 추천값 확정: 기록 반영 시점=상태 경계 전이는 즉시, 세부는 종료 시 일괄 / verdict는 3값으로 축소하되 옛 기록 읽기는 관용 / GitHub 필드는 자리만 두고 동작 제외. drop된 필드 9종은 새 스키마에서 제외하고 읽기는 관용.

[루프 규율 — 한 번에 하나]
- 수직 슬라이스 TDD: 실패 테스트 1개 → 통과시키는 최소 구현 → 리팩터 → `bun test rebuild/`와 `bun run typecheck:rebuild` 전체 green → 커밋. placeholder·stub 금지, 완전 구현만.
- 슬라이스마다 테스트 실행 출력(pass/fail 수·exit code)을 응답에 그대로 인용하라 — 이 goal의 판정자는 대화만 읽을 수 있고 명령을 실행하지 못한다. 인용 없는 진행은 판정자에게 존재하지 않는다.
- 만든 자≠검증자: 각 이슈를 닫기 전, fresh 서브에이전트에게 diff와 완료 기준을 주고 적대적으로 검증시켜 그 판정을 인용한다. 테스트 삭제·약화·하드코딩·테스트 입력 특수분기로 통과시키는 것은 실패로 친다.
- 진행 메모는 .ditto/local/reentry-progress.md에 append한다(완료 항목/진행 중/남은 것/배운 것). 기억은 컨텍스트가 아니라 디스크와 git이다 — 재정향이 필요하면 git log와 이 파일을 먼저 읽어라.
- 이슈 완료 = 완료 기준별 증거(테스트명·실행 출력 요지)를 이슈 코멘트로 남기고 `gh issue close`.
- 커밋은 green일 때만, 작게 자주. push·merge 금지(사람 게이트). 이 3건과 무관한 파일·기존 .ditto/work-items 기록은 건드리지 마라.

[escape — 멈추고 인계할 때]
사양이 서로 충돌하거나 / 사용자만 답할 수 있는 결정(보안·제품 의미·비가역)이 필요하거나 / 같은 실패 3회 반복·무진전이면: .ditto/local/reentry-progress.md에 blocker와 재개 조건을 기록하고 마지막 줄에 정확히 <CHAIN-ESCAPE/> 를 출력한다.

[이 goal의 달성 판정 — 다음 중 하나가 대화에 분명히 보일 때만 달성이다]
A) 완료: 세 이슈(#79·#78·#80) 각각에 대해 ① 검증 서브에이전트의 pass 판정 인용 ② gh issue close 실행 확인 ③ bun test rebuild/ "0 fail"(exit 0) 인용이 모두 있고, 마지막 줄에 <CHAIN-COMPLETE/> 가 있다. 실행 출력 인용 없는 자가주장("구현했다"·"될 것이다")은 인정하지 않는다.
B) 중단: blocker가 기록됐다는 보고와 함께 마지막 줄에 <CHAIN-ESCAPE/> 가 있다.
또는 80턴에 도달하면 중단으로 간주하고 종료한다. 조건 미충족인데 <CHAIN-COMPLETE/> 가 보이면 거짓 완료다 — 계속 진행시키고 남은 것을 다음 턴 가이드로 남겨라.
```

## §2. 설계 근거 (공식 문서 + 필드 합의)

- goal.md 모범 사례: 측정 가능한 종료 상태·검증 명령 명시·불변 제약·턴 상한 절·판정자는 대화만 읽음 → "실행 출력 인용 의무" 내장.
- 서베이(reports/research/goal-loop-engineering-survey.md) 합의: 완료 외부 강제, 만든 자≠검증자, one-thing-per-loop(수직 슬라이스 TDD), 기억=디스크·git, anti-reward-hacking 명문화, 유계.

## §3. 남은 위험 (정직 표시)

- **훅 전면 배제의 대가**: ditto Stop gate의 코드-소유 증거 게이트도 함께 꺼진다. 완료 강제는 /goal 판정자(대화 기반)+조건 내 규율에 의존 — 판정자는 인용된 출력만 보므로 세션이 인용을 누락하면 판정 불능. 조건에 인용 의무를 명문화해 완화.
- **auto mode 분류기 실측 전**: 문서상 문제없으나 gh issue close 등 외부 액션 승인 흐름은 첫 실전 관찰 필요.
- **80턴 상한은 잠정치**(3건 기준) — 도달 시 중단 착지, 디스크·git이 SoT라 이 킷 재사용으로 재진입 안전.
- **A3 work item(wi_260723hcb)은 park로 방치됨** — 잠긴 결정의 기록 보관소로만 남는다. 정리는 flip 이후 사용자 판단.
