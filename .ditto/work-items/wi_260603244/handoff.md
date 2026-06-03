# Handoff — ACG v0 (WU-5/6 이어받기)

> 이 파일은 `ditto work handoff` 자동본을 **수정**한 것이다. 자동본은 work-item.json 미러를 읽어 `partial`/`unverified`로 표기했으나, 실제 `completion.json`은 **final_verdict=pass (ac-1~4 pass, evidence-gated)**다. 아래가 정확한 상태다.

## 1. 한 줄
ACG v0 DITTO 바인딩에서 **WU-1~4 완료(커밋됨)**. 남은 일은 **WU-5 + WU-6 (공유 런타임 슬라이스)** — 새 work item으로, autopilot 승인 게이트 거쳐 구동.

## 2. 무엇이 끝났나 (커밋 완료)
- **WU-1** 스키마 9종 (`src/schemas/acg-*.ts`, Zod SoT) — 커밋 `c31ca03`
- **WU-2** conformance 테스트 (`tests/schemas/acg-conformance.test.ts`) — 커밋 `5c0103a`
- **WU-3** ICL→ChangeContract 컴파일러 (`src/acg/icl/`) — 커밋 `5c0103a`
- **WU-4** acg_review 어댑터 (`src/acg/review/acg-review-adapter.ts`) — 커밋 `5c0103a`
- work item `wi_260603244` (WU-2~4): completion final_verdict=**pass**, 전체 918 pass/0 fail, biome clean, 공유 런타임 미변경. work-item 기록 커밋 `2d502f9`.
- 설계 문서군 재구조화 + dialectic-4/5 + v0 플랜 — 커밋 `7ff250a`. 스키마 export 동기화 `18633f3`.

## 3. 남은 일 (이번 핸드오프의 대상)
**진실원: `reports/design/agentic-governance/v0-implementation-plan.md` (WU-5/6의 target·acceptance·evidence + 결정 D4/D5).**

- **WU-5**: JourneyRun ↔ e2eJourney 어댑터 + `src/schemas/e2e-journey.ts`에 `journey_id`/`work_item_id` **옵셔널** 필드 추가.
  - acceptance: result(pass/fail/blocked)→outcome(blocked→skipped) 매핑, 신규 필드 옵셔널이라 기존 e2e 소비처 회귀 0.
- **WU-6**: 완료게이트 배선 — ReviewGraph ledger(`.ditto/runs/<wi>/`) + `src/hooks/stop.ts`가 그 ledger를 읽어 미해소 high-risk 시 continuation 강제 + `src/schemas/completion-contract.ts`에 옵셔널 거버넌스 슬롯.
  - acceptance: 미해소 high-risk ledger → Stop continuation 강제, ledger 부재 → 기존 동작 그대로(no-op), CompletionContract 슬롯 옵셔널.

## 4. 반드시 지킬 제약 (pre-mortem)
- **공유 런타임 변경 = risk.non_local=true** → deep-interview finalize 시 이 플래그 세우면 autopilot **승인 게이트 pending** → 구동 전 **사용자 승인 필수**(이게 이 슬라이스를 분리한 이유).
- e2eJourney 신규 필드 **전부 옵셔널** (기존 소비처 안 깨지게).
- Stop 훅: ReviewGraph ledger **부재 시 no-op**(기존 completion/convergence/autopilot/dialectic ledger 독해 그대로).
- CompletionContract 거버넌스 슬롯 **옵셔널**(부재 시 현행 완료 흐름 불변).
- 각 공유자산(e2e-journey.ts·stop.ts·completion-contract.ts) 변경에 **회귀 0 테스트** 필수.

## 5. 첫 번째로 확인할 것
`src/hooks/stop.ts`가 현재 어떤 ledger를 어떻게 읽는지(`stop.ts:184-195` 부근) — WU-6 배선의 진입점. 그다음 `src/schemas/completion-contract.ts:30-81`에 슬롯 추가 형태 확인.

## 6. gotcha / 환경
1. **autopilot 시드 중복**: bootstrap이 N1/N2/N3(design→implement→verify)를 만드는데 planner 생성 노드와 겹친다. N2/N3는 prune 명령이 없어 **superseded-pass(evidence 없이)**로 정리. evidence-gated complete가 AC를 WU verify 증거로만 닫으므로 무해.
2. **tsc는 게이트 아님**: pre-commit은 biome만. 기존 tsc strict 에러 다수 존재(converge_rounds·run-with 등) — WU-5/6과 무관, 건드리지 말 것. 내 신규 파일만 타입 클린 확인하면 됨.
3. **커밋 분리**: 코드(feat/structural)와 `.ditto` 런타임 상태(chore)는 **분리 커밋**(CLAUDE.md §9). main 직접 push가 이 repo 관행.
4. **D3 유지**: `reviewer-output.ts` 불변, acg_review는 별도 확장객체(WU-4에서 이미 적용).
5. **ICL note**: EBNF대로 `# "quoted"` 요구(산문 `#` 미지원) — WU-5/6과 무관하나 참고.

## 7. 진행 방식 (택1)
- **deep-interview + autopilot** (이번 세션 패턴): 새 work item 생성(`ditto work start`) → `ditto deep-interview start/record-turn/check-readiness/finalize`(risk.non_local=true) → 승인 게이트에서 사용자 확인 → `ditto autopilot next-node`/`record-result`/`complete` 루프. 기술결정([DECIDED] D4/D5)은 재질문 금지, 공유런타임 위험만 게이트로.
- **또는 v0-plan 기반 직접 구현**: WU-5→WU-6 순차, 각 acceptance를 회귀0 테스트로 닫고 분리 커밋.

## 8. 금지 (scope creep)
- 단계3/6/8 게이트·provider(impact·boundary·fitness runner), PreToolUse scope 집행, Change Map 렌더러, boxwood 2번째 바인딩 — **전부 v0 범위 밖**(Q3/Q4 의존). WU-5/6만.
- 스펙 문서(00~50)는 dialectic-5까지 lock — 구현이 스펙을 바꿔야 하면 그건 신호이니 멈추고 확인.

## 9. resume
- 메모리 `project_acg_governance.md`가 이 상태를 자동 적재함.
- 완료된 WU-2~4 work item: `wi_260603244` (재개 대상 아님, pass로 닫힘).
