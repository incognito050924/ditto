# 재진입 사슬(A3→A2→A4) 자율 구동 런치 킷

> 결정(2026-07-23 조사): 구동 수단 = **/goal 단일 명령 + ditto 자체 Stop gate(코드-소유 증거 게이트) + auto mode(무인 도구 승인) + /loop 하트비트(선택)**. ultracode(Workflow)는 미사용 — 격리 환경이라 세션 CLI 상태를 공유하지 못하고 실행 중 사용자 입력이 불가하며, 사슬이 진짜 순차(A2·A4가 A3의 저장 계층 산출을 소비)라 팬아웃 이득이 없다. 근거 서베이: `reports/research/goal-loop-engineering-survey.md`.
>
> 공식 문서 확정 사실(code.claude.com/docs/en/goal.md): `/goal <조건>`은 인자 하나로 등록되며(≤4,000자), **등록 즉시 조건 자체가 지시가 되어 턴이 시작된다** — 별도 kickoff 메시지가 필요 없다. 판정자(기본 Haiku)는 매 턴 대화만 읽고 도구를 실행하지 못하므로, 증거는 반드시 대화에 인용돼야 한다. /goal은 권한을 바꾸지 않으므로 무인 실행에는 auto mode를 짝지어야 한다.

## §0. 사용법 (사람 입력은 두 번뿐)

1. 터미널:
   ```sh
   CLAUDE_CODE_STOP_HOOK_BLOCK_CAP=80 claude --permission-mode auto
   ```
   - block cap 상향: ditto Stop gate가 인터뷰 진행 중을 오판 차단(#95)해도 기본 8회 안에 강제 정지되지 않도록.
   - auto mode가 거부되면 일반 `claude` 시작 후 Shift+Tab으로 auto 전환.
2. 아래 §1 블록 전체를 붙여넣는다 — 등록과 동시에 미션이 시작된다.
3. (선택) `/loop 30m 계속: 재진입 사슬 미션을 이어가라. <CHAIN-COMPLETE/> 또는 <CHAIN-ESCAPE/> 가 이미 나왔으면 아무것도 하지 마라.` — /goal과의 공존은 공식 미문서화, 이상 시 이것만 끈다.

진행 확인은 인자 없는 `/goal`, 수동 중단은 `/goal clear`, 세션이 끊기면 `claude --resume`으로 goal이 복원된다(턴 카운트 리셋).

## §1. /goal 전문 (2,466자 — 제한 4,000자)

```
/goal 미션: 재진입 사슬 A3→A2→A4 자율 완주. 이 goal 텍스트가 유일한 지시다 — 재해석·확대·축소·분할 금지, 막히면 [escape]로 인계한다.

[순서 — 순차, 사슬 팬아웃 금지]
1) A3 저장 계층(#79): 기존 work item wi_260723hcb(blocked) 재개 — 신규 생성 금지.
2) A2(#78): A3 done 후 `ditto work start --issue incognito050924/ditto#78` (--issue는 반드시 단독 — 버그 #94: 동반 플래그가 조용히 무시된다) → 사슬 배선은 별도로 `ditto work stem --follows wi_260723hcb`.
3) A4(#80): 같은 방식, follows는 A2의 work item.
각각 무거운 경로로 완주한다: deep-interview(재개/신규) → finalize → autopilot → ditto verify → ditto work done. 명령 시그니처가 불확실하면 --help로 확인 후 호출한다 — 추측 호출 금지.

[A3 재개 — 디스크가 SoT]
- 먼저 .ditto/work-items/wi_260723hcb/record.json과 인터뷰 상태 파일을 읽어라 (인터뷰 active, readiness 0.55/0.85, non-critical 2차원 잔여).
- 잠긴 결정 2건은 불변·재질문 금지: ① 기존 134건 기록=재작성 금지 읽기전용 유산 + 새 최소 스키마 + 두 세대 합산 백로그 뷰 + 옛 기록 reopen 거부. ② 공존기간=옛 src가 유일 실기록자, rebuild는 fixture 계약 테스트로만 검증, 실기록 전환은 flip 게이트 단일 스위치.
- 미확정 3건은 record.json re_entry에 기록된 추천값으로 자율 확정한다(사용자 위임이 영속 기록됨): 기록 반영=경계 전이 즉시+세부 종료 일괄 / partial verdict=3값 축소+옛 기록 읽기 관용 / GitHub 필드=자리만 코어·동작 제외. 파생: drop 필드 9개는 새 스키마 제외+관용 읽기.
- 잔여 non-critical 차원은 위 결정과 정합인 보수적 답으로 자율 record-turn한다.
- 인터뷰→finalize는 한 호흡에 끝낸다(중간 정지 금지 — 버그 #95: Stop gate가 인터뷰 진행 중을 오판 차단한다. finalize가 autopilot 아티팩트를 만들면 게이트가 정상 충족된다).

[규율]
- 메인 세션=디스패처: 구현·검증·리뷰는 autopilot이 내는 spawn 액션대로 fresh 서브에이전트에 위임하고 결론·증거만 회수한다. 네가 만든 것을 네 컨텍스트에서 검증하지 마라.
- 완료는 디스크 증거로만: 각 work item은 record.json status=="done" + 전 acceptance_criteria verdict=="pass" + bun test rebuild/ exit 0. 어떤 AC도 주장으로 닫지 마라. 테스트 비활성화·완화·삭제 금지.
- 증거 브릿지(필수): 각 work item을 닫은 직후 `ditto work status <wi> --output json` 핵심 필드를 응답에 인용하라 — 이 goal의 판정자는 대화만 볼 수 있다.
- 발견 버그는 ditto 분류기가 "재현되는 실동작 버그"로 판정한 것만 같은 run에서 물질화+구동한다. 비-결함(아이디어·기술부채·잠복버그)은 물질화만.
- push·merge 금지(사람 게이트). 커밋은 green일 때만, 승인된 단위의 꼬리로.
- 사슬 밖 외래 변경(.ditto/work-items/wi_260722kom 등)은 건드리지 마라.

[escape] 잠긴 결정과 충돌하는 방향 전환이 필요하거나 / 보안·시스템·프로젝트·기능설계 의도급 결정이 필요하거나 / 같은 실패 3회 반복·무진전이면: blocker를 해당 record에 남기고 마지막 줄에 정확히 <CHAIN-ESCAPE/> 를 출력한다.

[종료 판정 — 이 goal은 다음 중 하나가 대화에 분명히 보일 때만 달성된다]
A) 완료: 세 work item(A3=wi_260723hcb, A2, A4) 각각의 ditto work status --output json 인용에서 status가 "done"이고 acceptance_criteria 전부 verdict "pass"이며, bun test rebuild/ 실행 결과 "0 fail"(exit 0) 인용이 있고, 마지막 줄에 <CHAIN-COMPLETE/> 가 있다. 실행 출력 인용 없이 자가주장("고쳤다"·"될 것이다")만 있으면 미달성.
B) 중단: blocker가 record에 기록됐다는 보고와 함께 마지막 줄에 <CHAIN-ESCAPE/> 가 있다.
또는 80턴에 도달하면 중단으로 간주하고 종료한다. JSON 인용 없는 <CHAIN-COMPLETE/> 는 거짓 완료다 — 미달성으로 계속 진행시키고, 남은 것(미완 work item·미검증 AC·red 테스트)을 다음 턴 가이드로 남겨라.
```

## §2. 남은 위험 (정직 표시)

- **/goal × /loop 공존 미문서화** — 하트비트는 선택 항목으로 격리, 이상 동작 시 /loop만 끈다.
- **auto mode 분류기와 ditto 훅의 상호작용 미실측** — 분류기는 대화에 선언된 경계("push 금지")를 차단 신호로 읽으므로 방향은 안전하나, 훅 명령 승인 흐름은 첫 실전에서 관찰 필요.
- **blocked→재개 정확한 전환 명령 미확인** — /goal 전문의 `--help` 확인 규율로 흡수.
- **finalize의 user_confirmation·dissent acknowledge는 설계상 "human half"** — 이번 run은 사용자의 빅뱅 위임(record.json re_entry에 영속 기록)이 근거이며, 세션은 확정 시점에 그 근거를 명시 인용해야 한다.
- **80턴 상한은 잠정치**(사슬 3건 기준) — 도달 시 중단으로 착지하고, 디스크가 SoT라 이 킷 재사용으로 안전 재진입.
