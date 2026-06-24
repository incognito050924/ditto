---
title: "다중 work item 묶음 처리 설계 (batch orchestration)"
kind: design
last_updated: 2026-06-25 KST
status: draft
authority: |
  비권위 설계 메모(헌장 §4-11). 코드와 자동 동기화되지 않으므로 사실의 SoT가 아니다.
  동작·계약의 권위는 코드(src/core/autopilot-*.ts, src/schemas/autopilot.ts)와
  reports/design/contracts/autopilot-contract.md에 있다. 이 문서는 단일 WI 계약 위에
  "여러 WI를 한 세션에서 순차 자율 처리"하는 상위 패턴의 설계 의도를 남긴다.
  여기 적힌 동작 주장이 코드와 어긋나면 코드가 옳다.
inputs:
  - reports/design/contracts/autopilot-contract.md       # 단일 WI 그래프·드라이버 루프·게이트 (권위)
  - src/core/autopilot-loop.ts                            # next-node / record-result / dispatch
  - src/core/coverage-loop.ts, coverage-manager.ts       # far-field pre-mortem sweep
  - src/core/gates.ts                                     # intentDriftGate / interfaceBaselineDriftGate
  - .ditto/local/experiments/bulk-dogfood-260625.json    # 본 설계의 실증 근거 (3 WI 일괄 처리)
evidence_base: |
  2026-06-25 bulk-dogfood 실증: wi_260623rl4 · wi_260622z7d · wi_260621i0w 3건을
  /goal 자율 루프 + ditto autopilot으로 사용자 개입 0회로 순차 처리. 측정치는
  .ditto/local/experiments/bulk-dogfood-260625.json. 아래 설계 제약은 전부 그 실증에서
  도출됐다(추측 아님). 단, 3건이 모두 verify-heavy였다는 선택 효과는 §6에 명시.
---

# 다중 work item 묶음 처리 설계

## 1. 목표 / 비목표

### 목표
- 한 세션에서 **여러 개의 사전 정의된 work item**을 사용자 개입 없이 순차 자율 처리하고, 각 WI를 `done` + `final_verdict=pass`까지 끌고 간다.
- 단일 WI autopilot 계약(autopilot-contract.md)을 **재사용**한다. batch는 그 위의 얇은 상위 루프이지, autopilot의 대체가 아니다.
- WI 묶음 처리의 비용(특히 far-field sweep)을 변경 크기에 비례하게 만든다.
- 묶음 처리 중 발생하는 마찰을 **드라이버의 코드근거 자가교정**으로 해소하고, 사용자 멈춤은 정말 사용자만 답할 수 있는 것에만 쓴다.

### 비목표
- WI 간 **병렬** 실행 (현재 설계는 순차. 병렬은 §7 미해결).
- 단일 WI 내부 그래프/게이트 재설계 (그건 autopilot-contract.md 소관).
- 자동 WI 발굴/생성 (묶음은 **사전 정의·AC 잠금된** WI 집합을 전제. 발굴은 별개 문제).
- intent 자체의 자율 변경 (intent는 batch 진입 전 잠금).

## 2. 현재 상태 (2026-06-25 실증 기준)

batch 처리는 **아직 코드에 전용 기능이 없다**. 이번엔 main agent가 드라이버가 되어 수동으로 구동했다:

```
/goal (3 WI + 측정 + 멈춤 조건)  ─ Stop 훅이 조건 충족까지 정지 차단
  └─ for each WI (순차):
       autopilot skill 진입 (단일 WI 계약)
         next-node → (design) planner spawn
                   → coverage sweep (coverage-next/round) dry까지
                   → record-result(design, plan_brief)
         next-node → (implement|verify) owner spawn → record-result
         next-node → (retrospective) → record-result
         next-node → done → complete → `ditto work done <wi>`
       다음 WI로 전이 (드라이버가 work status 확인 후 next-node)
```

전이는 자동이 아니라 **드라이버 판단**으로 일어났다. 측정치는 WI 종료마다 experiments json의 per_wi에 append.

## 3. 아키텍처

### 3.1 드라이버 모델 — 단일 순차 드라이버
- 드라이버는 **main agent 하나**다. 단일 WI 계약(D3: 드라이버는 subagent가 될 수 없다 — subagent가 stage subagent를 spawn 못 함)이 batch에도 그대로 적용된다.
- WI들은 **순차**로 처리한다. 한 WI가 종단(done/blocked)에 도달해야 다음 WI의 `next-node`를 호출한다.
- `root_goal`은 WI마다 독립. batch의 "묶음 목표"(/goal 조건)는 WI들의 root_goal을 **합치지 않는다** — 각 WI 계약은 격리 유지(intent conservation을 WI별로 보존).

### 3.2 WI 간 전이 게이트
한 WI를 닫고 다음으로 넘어가기 전 드라이버가 확인하는 것:
1. completion `final_verdict=pass` (또는 blocked/abandon이면 그 사유 기록 후 다음으로 — 묶음 전체를 멈추지 않음)
2. `ditto work done <wi>` 호출로 status=done 전이 (**completion.json 생성만으로는 done 아님** — §5.4)
3. WI 측정치를 per_wi에 append
4. 다음 WI의 `next-node` 호출

전이는 사용자에게 묻지 않는다(절차 결정, 헌장 §4-8). 한 WI가 사용자-소유 결정에 막히면 그 WI만 보류하고 **나머지는 계속**하거나, /goal 조건이 "막히면 멈춤"이면 멈추고 묻는다.

### 3.3 비용 모델 — sweep breadth가 지배 변수
이번 실증의 가장 큰 발견(§4-1). far-field coverage sweep은 WI당 19카테고리를 seed하고, 비용이 **변경 크기와 무관**하게 고정된다. batch에서는 이 고정비가 WI 수만큼 곱해진다.
- 문자 그대로의 프로토콜(카테고리마다 fresh sweep angles + 3-role dialectic + judges)은 WI당 ~19×N 에이전트 → batch에서 비현실적.
- 실증에서 쓴 우회: **WI당 fresh Opponent 1개가 19렌즈를 refute-by-default로 일괄 평가**. 품질 저하 없이(oracle-linked 위험만 통과) 비용을 ~1/N로 줄임.

## 4. 이번 도그푸딩이 못박은 설계 제약

각 항목은 experiments json의 per_wi/bulk에 증거가 있다.

### 4-1. [필수] sweep breadth를 변경 크기로 스케일하라
- 증거: +10줄 README(rl4), zero-code(z7d, i0w) 셋 다 19카테고리 전량 sweep. intensity tier는 per-node angles와 K만 줄이고 breadth는 안 줄임(coverage-manager.ts tier 로직).
- 제약: batch 드라이버는, 또는 향후 coverage 엔진은, breadth를 stakes/diff-size로 스케일해야 한다. 단 **§4-2의 비대칭을 죽이지 말 것**.
- 연계: wi_26062227h(③약함 카테고리 deep-interview 이관)의 직접 입력. 이번 3건이 그 재설계의 3 데이터 포인트.

### 4-2. [주의] sweep 가치는 희소하지만 0이 아니다 — 비대칭 보존
- 증거: 57개 카테고리-평가(3 WI × 19) 중 rl4의 2건만 진짜 위험(external-env: 실측이 published 경로만 검증·로컬 미커밋 입증 안 됨 / deployment-rollout: 최상단 false-green)을 잡음. 그 2건이 실제 false-green을 막음.
- 제약: breadth를 자르는 재설계는 "거의 0이지만 가끔 큰 한 방" 구조를 인지해야 한다. 약한 카테고리를 일괄 제거하되, 드물게 진짜를 잡는 경로(external-env류)는 deep-interview/유저확인으로 살릴 것.

### 4-3. [필수] verify-only WI는 change_surface=[]
- 증거: z7d completion이 `interfaceBaselineDriftGate`(gates.ts:769)에 'unconsented shrink'로 1회 차단. plan_brief의 change_surface에 read 대상 파일을 넣었는데 verify-only라 changed_files=[]가 되어 baseline vs current 불일치.
- 제약: 무변경(verify-only) 계획은 change_surface를 비운다. read 대상을 change_surface로 선언 금지. 향후: verify-only 계획에서 change_surface 자동 비움/경고.
- 일반화: brief regime·drift gate·variant 라우팅이 모두 "mutation하는 plan"을 전제한다. **이미 랜딩된 동작을 확인만 하는 WI**는 mutation-shaped 게이트에 헛발화한다 — batch에 verify-only가 섞이면 드라이버가 이를 예상하고 자가교정해야 한다.

### 4-4. [필수] AC는 observable property를 명시하고 proof vehicle을 박지 말 것
- 증거: i0w ac-1b가 "이 work item의 **구현 노드 dispatch 시** variant_candidates>0 관찰"을 요구. 그러나 verify-only라 implement 노드가 없고, .ditto/agents엔 implementer-role variant만 있어 verifier dispatch는 항상 []. → literal 충족 불가.
- 해소: production 함수(selectVariantCandidates/buildDelegationPacket)를 implementer+src/core 노드로 직접 호출(mock 금지) + 한계 disclosure.
- 제약: AC 작성 시 관측 *대상 property*만 서술. 산출 노드 종류를 박으면 그 노드가 없는 WI에서 충족 불가가 된다.

### 4-5. [권장] batch 진입 전 per-WI ROI 게이트
- 증거: z7d의 실제 작업은 `bun test` 2파일. 거기에 planner→19-cat sweep→design record→verify→retro→complete→done ceremony가 붙어 고정비가 amortize 안 됨.
- 제약: 사소 verify 작업은 full autopilot ceremony 가치가 낮다. batch 진입 시 WI별로 "이건 경량 경로(테스트 실행+증거)로 닫을지 vs full autopilot"을 거르는 게이트가 있으면 좋다. (단 §4-2 때문에 sweep 완전 생략은 위험 — 경량 sweep은 유지.)

### 4-6. [확인됨] anti-fabrication·fail-closed 규율은 작동한다
- planner가 ac-1b 충족용 no-op implement 노드 생성을 거부(i0w). drift gate의 false-block은 짜증나지만 fail-closed(닫지 말아야 할 때 보수적으로 막음)라 방향은 옳다. batch 설계는 이 규율을 약화시키지 말 것.

### 4-7. [확인됨] close-path: completion ≠ done
- 3건 모두 `ditto work done <wi>` 명시 호출 필요. batch 전이 게이트(§3.2)에 필수 단계로 포함.

## 5. 처리 흐름 (정본 절차)

```
batch_goal = {WI 집합(사전 정의·AC 잠금), 측정 기록처, 멈춤 조건}
for wi in WI 집합 (순차):
  1. autopilot next-node
  2. design 노드면:
     - planner spawn → generated_nodes
     - coverage sweep: fresh Opponent 1개로 breadth 일괄 평가 (§3.3)
       → coverage-next/round dry까지
     - record-result(design, plan_brief)
         · verify-only면 change_surface=[]  (§4-3)
  3. implement/verify/retro 노드: owner spawn → 증거 → record-result
     - 헌장: subagent "성공" 보고는 증거 아님 → 드라이버가 diff/재실행으로 재확인
  4. done → complete → intent-drift 확인 → `ditto work done <wi>`  (§4-7)
  5. per_wi에 측정치 append (turns·interventions·gotchas·verdict)
  6. 사용자-소유 결정에 막히면: 그 WI 보류/보고, 멈춤 조건 따름
다음 WI로
종료: bulk 요약(전이 성공/stall/lessons) 기록
```

## 6. 한계 / 선택 효과 (정직)
- **검증된 자율성은 좁다.** 이번 3 WI는 전부 사전 AC잠금 + verify-heavy로 판명. 즉 입증된 건 **오케스트레이션 자율성**이지 **구현 자율성**이 아니다. autopilot의 진짜 어려운 실패모드(find→fix→reverify, wrong-approach switch, cap 소진, impl↔verify 데드락)는 빌드할 게 없어 한 번도 안 터졌다.
- 따라서 §3~5의 흐름은 "이미 끝난/검증 위주 작업의 묶음 자율 처리"까지 입증됐다. **구현 중심 WI 묶음**에서의 전이·복구·비용은 미검증 — 다음 실증 대상.

## 7. 미해결 질문
- WI 간 **병렬** 처리: file_scope 비충돌 WI들을 동시에 돌릴 수 있나? 드라이버 단일성(D3)과 충돌하지 않게 하려면?
- breadth 스케일을 **드라이버가** 하나(우회), **coverage 엔진이** 하나(코드)? wi_26062227h와의 경계.
- verify-only WI를 autopilot 모델의 1등 시민으로 만들 가치가 있나, 아니면 경량 경로(§4-5)로 분리하나?
- batch 멈춤 정책: 한 WI가 blocked면 나머지 계속 vs 전체 정지 — /goal 조건으로 표현 vs 기본값?
- 이 설계를 **언제 코드/스킬로 승격**하나? (현재 비권위 메모. 승격 시 이 문서는 §4-11대로 코드·SKILL에 흡수하고 폐기 대상.)
