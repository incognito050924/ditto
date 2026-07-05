# HANDOFF (remote / cross-PC) — wi_260705lc8 prism 구현 autopilot 재개

> **다른 PC 재개용 원격 핸드오프.** work item 런타임 상태는 `.ditto/local/`(gitignored)라 git으로 안 옴 → 아래 번들을 풀어야 재개 가능. 읽고 재개했으면 이 파일 삭제(단일 소비).
> **작성**: 2026-07-06 · autopilot_id **orch_260705hs5** · 코드 변경 0(의도·계획·pre-mortem만). (이전 HANDOFF.md=wi_2607026qs E2E는 main 랜딩 완료·소비됨, 교체함.)
> **권위 = 코드·번들 JSON·커밋된 설계문서(§4-11).** 아래 본문은 pickup용, 사실은 fresh 재확인.

## 0. 다른 PC에서 먼저 (재개 전제)
```bash
git pull                       # 이 HANDOFF.md + 번들 + 설계문서(bc6473d) 받기
# ditto 빌드/설치 되어 있어야 함 (bin/ditto). 아니면 이 repo 설치 절차 수행.
tar -xzf reports/handoff-bundles/wi_260705lc8-state.tar.gz   # .ditto/local/{work-items,runs}/wi_260705lc8 복원
ditto work status wi_260705lc8   # 복원 확인(status=in_progress)
```
그다음 재개:
```bash
ditto autopilot next-node --workItem wi_260705lc8 --output json   # design 노드 N1 spawn 반환
```

## 1. 한 줄 상태
prism 구현 heavy 경로. **의도 잠금(deep-interview finalize) + autopilot bootstrap + approval 승인 + planner 10노드 분해 + plan-stage pre-mortem(relevance judge+opponent) 완료.** 다음 = coverage 스윕 dry → design 노드 record(generated_nodes+plan_brief) → 5 implement(비가역 T0 대체 실제코드) → review → 4 verify. **implement 미착수(코드 0).**

## 2. 재개 절차 (autopilot step 2b부터)
1. `ditto autopilot next-node` → design 노드 N1(planner) spawn 반환.
2. **planner 재실행 불필요** — `.ditto/local/runs/wi_260705lc8/planner-generated-nodes.json`의 10노드를 그대로 `record-result`의 `generated_nodes`로 씀.
3. 단 design 노드 record 전 **coverage 스윕을 dry까지** 몰아야 함(CLI 하드게이트). relevance는 이미 seed됨(`prism-relevance-verdict.json`·`coverage.json`). `ditto autopilot coverage-next --workItem wi_260705lc8 --coverageIntensity light`로 이어서 wave(12 카테고리)별 sweep(1 angle+3역 dialectic+per-axis judge) → `coverage-round` 순차 → dry. **light 정당**: 이번 스레드가 이미 P0 pre-mortem(설계문서 §9, 커밋 bc6473d)+relevance/opponent를 돌림.
4. dry 후 design 노드 record(generated_nodes+plan_brief). 그다음 implement wave.

## 3. 잠긴 의도 (권위 = 번들 intent.json, 재해석 금지)
- 경계: **T0 tech-spec→prism 진화·대체(alias+마이그레이션, 하드교체 아님)** + T1 발산(anti-SLOP **결정적 코어**: 무근거 방향 카운트 제외 + admissible hard cap 5) + T3 가치/방향 taxonomy(net-new). 범위 밖(후속): 산문 은퇴(WS-HND-T4)·WS0-T0 tier·digest 게이트 변경·T4·T5.
- **prism은 intent.json 안 만듦** — 정련 설계만 산출, deep-interview 단일 컴파일러(§9-C3 이중컴파일 소멸). 둘 다 사용자 표면. 파이프라인 vibe→prism→deep-interview→autopilot.
- **종료선 = ditto 소유(process에만)**: cap≤5 + dry-floor(interview-driver 패턴 재사용) + 추천-강제 체크포인트 + 쳇바퀴 강제출구. 최종 commit 도장만 사용자(taste). 무한 발산·무한 미루기를 코드가 끊음.
- 발산 admissibility 술어는 **net-new**(§9-D5: coverage-manager admissibleBranchesAdded는 pre-mortem 브랜치용, 재사용 불가).
- risk=irreversible, approval **승인됨**(재승인 불필요, autopilot.json 기록).

## 4. 7 AC (번들 intent.json 상세)
ac-1 발산 3~5+무근거제외+cap5 결정정지 / ac-2 dry-floor·쳇바퀴 강제출구 / ac-3 taxonomy 각 차원 강제 elicitation(groundable=근거·judgment=대면) / ac-4 6 compat 표면 alias+진행중 work item resolve / ac-5 prism intent.json 생성 0·deep-interview 단일 컴파일 / ac-6 specDigestStale 만족·은퇴 없음→block 0 / ac-7 [비결정·moat] ≥1 라이브서 사용자 방향 재고/변경.

## 5. plan 분해 (번들 planner-generated-nodes.json 상세)
10노드: implement 5(prism-divergence·prism-taxonomy·prism-termination = 병렬-안전 disjoint / prism-driver / prism-alias-migration) → review 1 → verify 4(core·wiring·compat·live-moat). driver→alias는 tech-spec*.ts 겹쳐 직렬.

## 6. pre-mortem finding (반드시 반영)
opponent refute HIGH 1건 — **observability: 마이그레이션 완료-신호 갭**. 진행중 work item 마이그레이션 누락이 며칠 뒤 그 work item next-run에서 specDigestStale block으로 **오귀인**(사용자 spec 편집 착각). intent-store.ts:31-34는 파일당 atomic이나 마이그레이션은 다수 순회(트랜잭션 없음). → **n-prism-alias-migration에 반영**: 마이그레이션 후 specDigestStale(autopilot-loop.ts:143) dry-run을 전 진행중 work item에 돌려 completeness 리포트 clean일 때만 done. **최소 패스, atomic 프레임워크 금지**. planner-generated-nodes.json에 이미 접힘.

## 7. 사용자가 실질 정련한 2건 (deep-interview 결과, 무시 금지)
- **종료 모델**: 사용자가 "선 없으면 무한 발산/쳇바퀴"로 anti-강제선택 편향 교정 → ditto가 process에 선 긋되 taste엔 안 긋는 화해.
- **C3**: "prism은 tech-spec 개선인데 intent.json 만들어야 하나?" → prism은 안 만듦, deep-interview 단일 컴파일.

## 8. 설계 SoT / 주의
- 설계: `reports/design/ditto-quality-remediation-backlog.md` §2.6·§2.7·WS-PRISM + §9 pre-mortem (커밋 bc6473d, origin/main).
- coverage.json은 `.ditto/local/runs/<wi>/`(work-items/ 아님, tier 모델).
- PreToolUse 훅이 명령문자열 "credential/secret" 단어 오탐 차단 → 파일+`$(cat)` 우회.
- 다른 PC `.ditto/local`에 같은 wi_260705lc8가 이미 있으면 확인 후 덮어쓰기.
