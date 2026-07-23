# 옛 src 능력영역 분류표 — 확정 (2026-07-23 사용자 일괄 리뷰 완료)

- 작성: 2026-07-23, wi_260723czc n2-classification-table (implementer 노드) — 추천(proposed) 상태로 저작
- **확정: 2026-07-23T11:43Z, n4-user-batch-review** — 무플래그 9행 일괄 확정 + flagged **15행**(아래 정정 참조) 전건 개별 확정. 행별 확정 기록은 §사용자 확정 기록. 사용자 flip 3건: A5·A17·A21 (drop 추천 → keep 확정).
- 입력 정본: `.ditto/local/work-items/wi_260723czc/evidence/n1-inventory.md`(전수 표 24행) + `intent.json`(분류 원칙) + `.ditto/knowledge/adr/` 본문(2클래스 (b) 후보 행 관련 ADR 전건 + 반대 방향 ADR-0009·ADR-0021 필독 완료)
- **정정(n4)**: 저작 시점 flagged 요약이 14행이었으나 A16 행 자체에 (b) 플래그와 확정 질문이 있어 **flagged는 15행**이다 — n4에서 A16도 개별 확정을 받았다(요약 누락의 정정이지 새 플래그 아님).

## 판정 어휘·원칙 (intent 확정 사항의 적용)

- **keep** = 능력의 계약·동작을 rebuild 체계에 재진입시킨다(구현 형태는 재진입 시 결정, 검증된 계약은 보존).
- **drop** = 재진입하지 않고 옛 src와 함께 은퇴한다. **가역** — 각 행에 철회조건 명시.
- **redesign** = 재진입하되 형태를 재설계한다. **판정 전부 flip 전 완료 의무**를 지므로, 애매한 행은 redesign으로 도피하지 않고 drop+철회조건으로 뒀다.
- **기본값 drop** — keep·redesign 쪽이 입증 책임을 진다.
- 4항 증거: ①결함 포착(+사용자 프로젝트 일반화 논증 필수) ②반복 사용('매일 쓴다' 단독 불충분) ③ADR 전제(자동 keep 아님 — 본문 개별 확인 시 승격 신호) ④사용자 체감(직접 표명만 — 저장소 발굴 불가이므로 현 시점 전 행 **missing**, 리뷰 왕복에서 채움).
- 증거 상태: **validated**(이 노드가 저장소 핀을 직접 열어/실행해 확인) / **candidate**(키워드 카운트·auto-memory 등 미검증 — n1의 '추정'은 전부 여기서 출발) / **missing**. **keep/redesign 추천 근거에는 validated만 산입** — candidate뿐인 행을 keep으로 추천한 경우 순효능 논증에 그 사실을 명시.
- **#66 keep 판정(`reports/measurements/efficacy-ablation-3arm.md` — 존재 validated)은 번들 한정** — 어떤 행의 개별 구제 증거로도 인용하지 않았다(선행 게이트로만 유효).
- 플래그: **(a)** 실사용 실적 있는 기능의 drop 추천 **(b)** 기존 ADR과 충돌하는 판정. flagged 행에는 사용자 개별 확정 질문 요지 1줄 부기.

## 요약 표 (24행 전수 — 행 ID는 n1 전수 표와 동일)

| # | 영역 (core 수) | 확정 판정 | 플래그 | status |
|---|---|---|---|---|
| A1 | autopilot 오케스트레이션 (17) | drop (분할: 구동 코어는 rebuild 등가로 대체 완료) + **행동 계약 ADR 5건 rebuild 인수 의무 지정** | (a)+(b) | **confirmed** |
| A2 | 완료게이트·증거·검증 (5) | keep (분할: 방어가치 입증 게이트만, untargeted 9종은 입증 전 제외) | (a 부분) | **confirmed** |
| A3 | work item 생애주기·handoff (9) | keep (분할: 저장 계약 코어) | — (충돌 keep으로 해소) | **confirmed** |
| A4 | deep-interview·의도 (6) | redesign | (b) | **confirmed** |
| A5 | coverage·pre-mortem (8) | **keep — 사용자 flip(추천 drop 기각), 옛 구현 그대로 재진입**(소비처 재배선 전 잠시 고아 상태 감수 — 사용자 선택) | (a)+(b) | **confirmed** |
| A6 | prism 기획·spec (9) | drop + 철회조건 | (a) | **confirmed** |
| A6b | dialectic (core 0 — 표면 전용) | keep | — | **confirmed** |
| A7 | memory (11) | keep (분할: 코어 계약, 확장 게이트 제외) | — (ADR-0021 방향 부기) | **confirmed** |
| A8 | knowledge 투영 (2) | keep | — | **confirmed** |
| A9 | e2e (23) | drop + 철회조건 | (a)+(b) | **confirmed** |
| A10 | journey 저작 (7) | drop (A9 연동) | (a) | **confirmed** |
| A11 | github 연계 (8) | keep (분할: SoT 계약 코어) | — | **confirmed** |
| A12 | doctor·드리프트 진단 (10) | drop (분할: mode-doctor 배너만 keep) | (a) | **confirmed** |
| A13 | worktree·workspace (2) | drop + 철회조건 | (a) | **confirmed** |
| A14 | cleanup 정리 (3) | drop + 철회조건 | (a) | **confirmed** |
| A15 | charter·config·recipe (10) | keep (분할: 공용 기반만, charter·recipe 제외) | (b 부기) | **confirmed** |
| A16 | setup·provision·init·teardown (10) | redesign (최소 진입만; CodeQL 설치분은 A17 연동 철회조건) | (b) | **confirmed** |
| A17 | semantic·lsp·codeql (11) | **keep — 사용자 flip(추천 drop 기각), A21 keep과의 의존 정합** | (a) | **confirmed** |
| A18 | host seam (6) | drop (분할: adapter 계약은 rebuild 등가; Codex측은 **재진입 백로그 등재 — 폐기 아님**) | (a)+(b) | **confirmed** |
| A19 | push-gate 배포게이트 (2) | keep | — | **confirmed** |
| A20 | 회고·측정 (2) | drop + **측정 계약 인수처 = rebuild net-efficacy 지정** | (a)+(b) | **confirmed** |
| A21 | ACG 변경 거버넌스 (core 3 + src/acg 37) | **keep — 사용자 flip(추천 drop 기각)** | (a) | **confirmed** |
| A22 | 공용 기반 유틸 (3) | keep (파생적 — keep 집합의 전제) | — | **confirmed** |
| hooks | hooks 집행 표면 (src/hooks 10) | keep (분할: 안전 게이트·배너 운반만) | — (충돌 keep으로 해소) | **confirmed** |

**확정 분포**: **keep 13 · redesign 2 · drop 9** (행 24 — 추천 대비 flip 3: A5·A17·A21 drop→keep). **flagged 행 15** (A1·A2·A4·A5·A6·A9·A10·A12·A13·A14·A16·A17·A18·A20·A21 — A16은 저작 시점 요약 누락 정정).

## 귀속 불변식 합계 (이 노드가 재계산 — 2026-07-23)

- src/core 파일: `find src/core -type f | wc -l` = **167** (재실행 exit 0). 행별 core 수 합: 17+5+9+6+8+9+0+11+2+23+7+8+10+2+3+10+10+11+6+2+2+3+3 = **167** — **미귀속 0, 중복 0** (n1 귀속 스크립트 `assigned: 167 dup: [] unassigned: []`와 일치).
- CLI 커맨드: `ls src/cli/commands/*.ts | wc -l` = **39** — n1 귀속 내역 39/39, 누락 0.
- skills: `ls skills | wc -l` = **18** / agents: `ls agents | wc -l` = **21** — 전수 귀속 유지.
- 병합 행 없음 — n1의 안정 행 ID 24행(A1~A22 + dialectic·hooks)을 그대로 유지했다.

---

## 행별 상세

### A1 — autopilot 오케스트레이션 (core 17) · 추천 **drop** (분할) · status=proposed · 플래그 (a)+(b)

- **분할 내역**: ① 구동 능력 코어(bounded 루프·큐·stop 게이트) = rebuild 등가가 이미 존재(`rebuild/drive/loop.ts`·`rebuild/state/queue-state.ts` — n1 fresh 재확인) → 재진입 대상 아님(옛 구현 drop). ② 확장(그래프·wave 병렬 dispatch·converge·tidy 스플라이스·worktree-drive) = drop + 철회조건.
- **증거**: ② Run tier `autopilot.json` 54건 실재(직접 카운트 — **validated**, 단 로컬 전용·이식성 낮음) — 사실상 전 wi가 이 루프로 구동됨. ③ ADR-20260627·20260710·20260714-defect-carveout·20260628-append·20260628-decisive-class·20260628-delegation·20260708 본문 전건 확인(**validated**) — 전부 오케스트레이션의 **행동 계약**(materialize≠drive·종료 완전성·결함 클래스 체인구동·envelope 무손실 채널·barrier tier)을 규정. ① 미발굴(**missing** — 루프 자체가 결함을 잡은 기록은 게이트(A2) 소관). ④ missing.
- **순효능 논증**: 옛 그래프·병렬 wave 모델은 rebuild가 의도적으로 대체한 대상(zero-start의 출발점)이다. 재진입 비용(17파일 + dispatch·converge·병렬 mutator 위생 — auto-memory에 병렬 mutator 상호 clobber 등 결함 이력)이 크고, rebuild bounded 루프가 후계로 실증 중(비사소 실증 게이트가 ac-4에서 검증 예정). 확장 재진입은 bounded 루프의 부족이 실증된 뒤가 싸다.
- **철회조건**: rebuild 루프가 비사소 실증에서 다중 노드 병렬·역할 분리 없이 완주 불가로 실증되면 확장 재진입 재개.
- **(b) ADR 충돌 판정**: 위 행동 계약 ADR 5건은 "옛 코드의 존재"가 아니라 "오케스트레이션의 행동"을 규정 — 옛 구현 drop 자체는 **method**(rebuild 루프가 같은 계약을 자기 방식으로 인수하면 정합·에이전트 정렬 가능). 단 계약의 실질(예: 종료 완전성 게이트·no-auto-pick)을 rebuild가 인수하지 않으면 **intent** 충돌로 승격.
- **확정 질문**: 옛 오케스트레이션 행동 계약(ADR-20260627/20260710/20260714 등)을 rebuild 루프의 인수 의무로 지정할지, 계약별 재평가로 갈지?

### A2 — 완료게이트·증거·검증 (core 5) · 추천 **keep** (분할) · status=proposed · 플래그 (a 부분)

- **분할 내역**: keep 코어 계약 = 방어가치 입증 게이트(catch-rate caught 실증분) + ADR 집행 게이트(decision-conflict[ADR-0020 D1]·pass-close 잔여[ADR-20260710 D1]·oracle 충족[ADR-0024]·barrier 판별[ADR-20260708]). 제외 = untargeted 게이트 9종(방어가치 미입증 — 개별 입증 없이는 재진입하지 않음, drop).
- **증거**: ① `.ditto/local/work-items/wi_2607189u3/audit-findings.md` 직접 열람(**validated**, Run tier — 이식성 낮음 부기): 게이트 16종을 dialectic 심사 × seeded-defect catch-rate 실측으로 교차, caught=방어가치 입증 게이트 존재·제거 후보 0 판정 기록 실재. 일반화 논증: seeded-defect를 실제 FAIL시키는 완료 정직성 게이트는 사용자 프로젝트의 거짓 완료 차단에 그대로 일반화된다(프로젝트 특이 로직 아님). ③ ADR-0020(D1 라우팅 게이트=`decisionConflictGate` 코드 명시)·ADR-20260710(D1이 gates.ts:323 배선 명시)·ADR-0024·ADR-20260708 본문 확인(**validated**). rebuild 부분 등가(`rebuild/verify/*`·stop-gate) 존재 — n1 재확인. ② 전 wi 완료 경로가 통과(candidate — 개별 record 본문 미확인). ④ missing.
- **순효능 논증**: 완료를 증거로만 말하게 하는 게이트는 제품의 제1지향(완료 정직성)의 집행체다. 재진입 비용이 작고(5파일 중 계약만), catch 실증이 있는 부분만 keep하므로 유지비가 입증 범위에 비례한다.
- **(a) 부분 플래그**: untargeted 9종 drop은 "실사용 중(모든 완료 경로에서 발화) 기능의 drop"에 해당.
- **확정 질문**: untargeted 게이트 9종(방어가치 미측정)을 입증 전 재진입 제외로 확정해도 되는지?

### A3 — work item 생애주기·handoff (core 9) · 추천 **keep** (분할) · status=proposed · 플래그 없음

- **분할 내역**: keep 코어 계약 = Record/Run 2-tier 저장(record.json+events 불변 로그·terminal-first-wins)·handoff 계약(로컬 gitignored + 원격 브랜치 커밋). 제외 = 부속 편의 명령(run-with 등)은 재진입 시 개별 재평가.
- **증거**: ② 구조 실측(**validated**, 직접 카운트): 커밋된 Record 132건, handoff_path 보유 24건, github_issue 연결 35건 — 전부 이 저장 계층 위에 산다. 이 분류표 자체가 Record tier에 저작되고 있다. ③ ADR-20260706·ADR-20260714-handoff-remote 본문 확인(**validated**) — Record tier와 원격 핸드오프 커밋이 결정의 대상 그 자체. ADR-0005(per-entity·무충돌 머지)·ADR-20260626-lightweight-path(경량 경로 계약) 본문 확인(**validated**). ① changed_files 오염 근원수정 등 이력은 auto-memory(**candidate**). ④ missing.
- **순효능 논증**: 공유 백로그·완료 판정·팀 가시성(ADR-20260706 Q1)이 전부 이 계층에 결박된다. drop하면 커밋된 132건 프로젝트 메모리가 좌초하고 ADR-20260706과 intent 충돌한다. keep으로 충돌이 해소되며, per-entity 파일 계약이라 재진입 비용은 스키마·리듀서 수준으로 bounded.
- **ADR 충돌 부기**: drop이었다면 ADR-20260706·20260714(intent — 결정 대상 소멸) — keep 추천으로 해소.

### A4 — deep-interview·의도 (core 6) · 추천 **redesign** · status=proposed · 플래그 (b)

- **증거**: ③ ADR-0024(design 노드 경화 — AC↔oracle 수렴이 의도 산출물의 하류 계약) 본문 확인(**validated**), ADR-20260710(하나의 의도=하나의 단위) 본문 확인(**validated**). ② "interview" 53 wi·"deep-interview" 38 wi(**candidate** — 언급≠사용), risks 필드 비어있지 않은 record 7건 직접 재계산(132−125[빈 배열]=7, **validated**) — declared risk 영속화 경로가 실사용됨. ① declared-risk 미영속 결함 수정 이력(wi_260710y87)은 auto-memory(**candidate** — Run tier 재핀 미수행). ④ missing.
- **순효능 논증**: rebuild에는 intent-lock(잠금)만 있고 의도 형성 표면이 없다 — 무거운 경로는 intent 없이는 출발 자체가 불가하므로 이 능력의 공백은 제품 축1의 공백이다. 단 옛 인터뷰 드라이버는 누적 레이어(질문게이트·dissent·branch-walking·single-fire 등)가 두꺼워 그대로 이식하면 재진입 비용이 효익을 지배한다 → rebuild intent-lock 계약 위 재설계가 순효능 우위. redesign 의무(flip 전 완료)는 "루프 구동에 의도 산출이 선행 필수"라는 구조적 이유로 정당(도피 아님). keep-측 산입 증거는 validated ③(ADR 2건)과 validated ② 구조 신호(risks 7건)이며, ①은 candidate임을 명시한다.
- **(b) ADR 충돌 판정**: ADR-0024·20260710 — **method**(재설계가 AC↔oracle 수렴·의도 단위 불변식을 보존하면 정합; 에이전트 정렬 가능). 충돌 아님을 조건부로 확인.
- **확정 질문**: 의도 형성 표면을 flip 전 필수(redesign)로 볼지, 수동 intent 저작 degrade로 충분해 drop+철회조건으로 내릴지?

### A5 — coverage·pre-mortem (core 8) · 추천 **drop + 철회조건** · status=proposed · 플래그 (a)+(b)

- **증거**: ① ADR-20260630 본문 §주의사항이 "pre-mortem 12-category sweep" 산출 4건(status_map 스키마↔주석 모순·mergeRecipes whole-field replace 등)을 기록(**validated** — 스윕이 실결함 후보를 구현 전 포착한 저장소 핀). 형제-블록 파괴 위험 발견 귀속은 auto-memory(**candidate**). 일반화 논증: 계획 단계 위험 스윕은 사용자 프로젝트에 일반화되나, 아래 비용이 같은 강도로 일반화된다. ③ ADR-0023·ADR-20260625 본문 확인(**validated**) — 이 능력의 종료·관련성 계약 자체를 규정. ② "coverage" 60 wi·"pre-mortem" 38 wi(**candidate**). ④ missing.
- **순효능 논증**: **비용이 효익을 지배한다는 실측이 ADR 본문에 있다** — 카테고리당 ~35.25k 토큰, 소변경 1건당 외삽 ~670k(Opponent-only)~2–3M 토큰(ADR-0023 §far-field 자동화 보류, false-negative 표본 2건 0). ADR-20260625가 관련성 게이트로 비용을 깎았지만 통증의 1차 원인(비용)은 본문에 남아 있다. 검증된 포착(validated ①)이 있음에도, 8파일+taxonomy+관련성 기계의 재진입·유지 비용과 실행 토큰 비용이 순효능을 부정한다 → keep 불성립, 기본값 drop.
- **철회조건**: 하류 게이트(verify/review)가 미커버 카테고리의 실패를 반복 검출하면 재개(ADR-0023 자체 철회조건과 정렬). 재진입 시 관련성 게이트·정당화-close 계약은 재사용.
- **(b) ADR 충돌 판정**: ADR-0023·20260625는 이 능력 자체를 규정 — drop은 결정 대상의 소멸 = **intent** 충돌(사용자만 해소 가능). 완화 논거: 두 ADR의 철회조건("비용 때문에 기능 OFF를 유발하면")이 본 판정 방향을 이미 예비하고 있음.
- **확정 질문**: 실측 비용(~670k~2-3M 토큰/소변경)에도 pre-mortem 스윕을 rebuild 재진입 필수로 볼지, drop 후 하류-검출 시 재개로 갈지?

### A6 — prism 기획·spec (core 9) · 추천 **drop + 철회조건** · status=proposed · 플래그 (a)

- **증거**: ① opponent seam이 ADR-0018 위반(무검증 upsert)을 구현 전 흡수한 이력 — auto-memory(**candidate**, 저장소 핀 미확보). ② "prism" 38 wi(**candidate**). ③ 직접 전제 ADR 없음(ADR-0024 인접일 뿐). ④ missing.
- **순효능 논증**: keep-측 validated 증거 0. tech-spec 후계 표면이나 rebuild의 계획 단계는 자체 orchestration-prompt 방향 — 9파일 재진입 비용을 정당화할 입증이 없다. 기본값 drop.
- **철회조건**: rebuild 루프의 계획 단계에서 spec 진화·중립 컴파일(spec-doc) 요구가 실증되면 spec-doc 계약부터 재진입.
- **확정 질문**: prism 사용 이력(38 wi 후보)을 근거로 개별 구제할 부분(spec-doc 컴파일러)이 있는지?

### A6b — dialectic (core 0 — 표면 전용) · 추천 **keep** · status=proposed · 플래그 없음

- **증거**: ① ADR 본문들이 dialectic이 결정을 실질 변경한 기록을 담음(**validated** — 직접 열람): ADR-20260627("dialectic이 이 전제를 코드로 반증했다" — 초안 기각), ADR-0017(dialectic-8·9 정정 5건 반영), ADR-0013(라운드2 verdict=revise가 옵션 A 재범위 유발), ADR-0024(round-1 verdict=revise가 4단계 분리 프레임 기각). 일반화 논증: 적대 심의는 코드베이스 특이 로직이 아니라 결정 품질 일반 장치 — 사용자 프로젝트의 설계 결정에 그대로 일반화. ② "dialectic" 15 wi(**candidate**). ③ 직접 전제 ADR 없음. ④ missing.
- **순효능 논증**: core 모듈 0(schemas/dialectic.ts + 스킬·에이전트 표면만) — 재진입 비용이 표 최저 수준. validated ①(결정을 뒤집은 포착 4건)이 낮은 비용을 크게 상회 → keep 성립.
- **분할 내역**: 해당 없음(core 0).

### A7 — memory (core 11) · 추천 **keep** (분할) · status=proposed · 플래그 없음 (ADR-0021 방향 부기)

- **분할 내역**: keep 코어 계약 = SoT 저장(events/sources per-entity)·query/projection·`DITTO_MEMORY=off` 마스터 스위치(ADR-0013 D4 롤백 불변식). 제외 = §5-2~5-5 push 확대·curator 자동 트리거 등 게이트 뒤 확장(ADR-0013이 이미 미배선 게이트로 못박음 — 재진입하지 않음).
- **증거**: ② 라이브 사용 구조 실측(**validated**, 직접 카운트): `.ditto/memory/events` 144건·`sources` 60건 실재. ③ ADR-0013(D1~D4)·ADR-0015(정합성 2축) 본문 확인(**validated**). **반대 방향 ADR-0021 본문 필독 완료(계약 5 이행)**: D2 "흡수=seam 대체, feature parity 비목표"는 축소 신호이나, **D4 seam 연속성 — "신규 표면이 실제 연결되기 전까지 현 ditto memory 동작을 유지한다, 신규 실증 전 폐지 금지"** — 가 현 시점 drop을 명시적으로 금지한다(외부 프로젝트는 미실증·미연결). ① 미발굴(**missing**). ④ missing.
- **순효능 논증**: keep 산입 근거는 validated ②(라이브 데이터 144+60)와 validated ③(ADR-0013/0015 개별 확인 + ADR-0021 D4의 폐지 금지 게이트). drop은 ADR-0021 D4와 intent 충돌(메모리 공백·비가역 손실)이다. 장기적으로는 외부 프로젝트가 seam을 대체하므로 이 keep은 **전환조건부(transitional)** — 확장 없이 코어만 유지해 재진입 비용을 bounded로 묶는다.
- **ADR 충돌 부기**: drop이었다면 ADR-0013/0015(intent) + ADR-0021 D4(intent — seam 연속성 위반). keep(코어 한정)으로 전부 해소. ADR-0021의 축소 방향은 "확장 게이트 재진입 금지"로 반영했다.

### A8 — knowledge 투영 (core 2) · 추천 **keep** · status=proposed · 플래그 없음

- **증거**: ② CLAUDE.md의 "DITTO Knowledge (projected)" 블록이 현재 라이브 산출물(**validated** — 현 세션 CLAUDE.md에서 직접 확인)·`.ditto/knowledge/adr/` 44파일 실재(**validated** — 직접 ls). ③ ADR-20260624(adr-new/adr-check CLI가 식별자 정책의 집행 표면) 본문 확인(**validated**), ADR-0020(memory query가 adrGist 서빙 — knowledge가 상류) 본문 확인(**validated**). ① 미발굴(missing). ④ missing.
- **순효능 논증**: 결정 메모리(ADR·glossary)의 저작·투영·정합 검사는 ADR-0020 가드레일 전체의 상류이고, 이 work item의 ac-3(분류 원칙 ADR)도 이 표면으로 산출된다. core 2파일 — 비용 최저 수준, validated 증거 다수 → keep 성립.

### A9 — e2e (core 23) · 추천 **drop + 철회조건** · status=proposed · 플래그 (a)+(b)

- **증거**: ③ ADR-0014(D1 에이전트 단독 저작 금지·게이트 3종·D4 featureFixAllowed)·ADR-20260702(공식 generator 주 경로·e2e-scripter 강등 fallback) 본문 확인(**validated**) — 능력의 계약을 상세 규정. ② "e2e" 23 wi(**candidate**). ① 미발굴(missing — e2e가 실회귀를 잡은 저장소 핀 없음). ④ missing.
- **순효능 논증**: core 23파일 — 단일 영역 최대 + Playwright·브라우저·MCP 의존. keep-측 validated 증거는 ③뿐이고 ①(결함 포착 실적)이 missing이다. ditto 자기 저장소(CLI 제품)에는 브라우저 E2E 소비처가 없어 도그푸딩으로 입증 불가·사용자 웹 프로젝트에서만 가치가 발현되는데 그 실증이 아직 없다 → 재진입·유지 비용(표 최대)이 미실증 효익을 지배, keep 불성립.
- **철회조건**: 사용자 웹 프로젝트에서 E2E 수요가 직접 표명되면(④ 충족) ADR-0014/20260702 계약 그대로 재진입(계약은 ADR에 보존되어 있어 재진입 비용의 설계분은 선불됨).
- **(b) ADR 충돌 판정**: ADR-0014·20260702는 이 능력 자체를 규정하고, ADR-0010은 E2E를 기능 4축의 축3으로 정식화 — drop은 **intent** 충돌(제품 정의 차원, 사용자만 해소 가능).
- **확정 질문**: 기능 4축의 축3(E2E)을 rebuild 세대에서 보류(drop+철회)해도 되는지 — 제품 정의 차원의 결정?

### A10 — journey 저작 (core 7) · 추천 **drop** (A9 연동) · status=proposed · 플래그 (a)

- **증거**: ③ ADR-0014(Journey DSL이 e2e의 입력 계약) 본문 확인(**validated**). ② "journey" 11 wi(**candidate**). ①④ missing.
- **순효능 논증**: 유일 소비처가 A9(e2e)다. A9 drop이면 무소비 표면 — 독립 keep 근거 없음.
- **철회조건**: A9 재진입 시 함께 재진입(Journey DSL은 ADR-0014 D1의 입력 계약이므로 분리 불가).
- **(b 아님 — 부기)**: ADR-0014 간접 전제 — A9와 동일 충돌 표면에 흡수(**method**, A9 판정에 종속).
- **확정 질문**: A9 판정에 연동 확정(별도 질문 불요 — A9 질문으로 갈음)?

### A11 — github 연계 (core 8) · 추천 **keep** (분할) · status=proposed · 플래그 없음

- **분할 내역**: keep 코어 계약 = SoT 3층 read/write(백로그 read·이슈↔work item 연동·완료 단방향 미러)·`owner/repo#n` 좌표. 부속(claim 보드 이동·occupancy 등 보드 조작 편의)은 재진입 시 개별 재평가.
- **증거**: ② 구조 실측(**validated**, 직접 카운트): record 132건 중 github_issue 연결 **35건** — 표 전체에서 가장 강한 구조적 사용 신호. 이 에픽(#64~#69)과 이 work item의 ac-4(per-feature 이슈 생성)가 이 능력 위에서 실행된다. ③ ADR-20260628-github-backlog-sot(D3 SoT 3층·D4 좌표 일원화)·ADR-20260630(recipe seed) 본문 확인(**validated**). ① 라이브 dogfood 결함 3건 수정 이력은 auto-memory(**candidate**). ④ missing.
- **순효능 논증**: 백로그 SoT가 GitHub으로 결정된 이상(ADR-20260628), 이 계층 없이는 백로그 읽기·완료 미러 자체가 불가 — drop은 그 결정과 intent 충돌. gh CLI 위임 구조라 유지비가 낮고(인증·버전 외부화), keep 산입 근거가 전부 validated(② 구조 신호 + ③ 본문 확인) → keep 성립.

### A12 — doctor·드리프트 진단 (core 10) · 추천 **drop** (분할) · status=proposed · 플래그 (a)

- **분할 내역**: keep = mode-doctor(SessionStart 배너 — 워킹트리 vs stale 설치본 판별)만. drop = 나머지(doctor distribution·instructions·release·mode CLI 등).
- **증거**: ③ ADR-0022 본문 확인(**validated**) — 결정 3이 "안전망 — SessionStart 배너(mode-doctor)"를 명시적 결정 항목으로 규정, 컨텍스트에 stale 설치본 사고 실례 기록. ADR-0018·ADR-0011(D1 doctor 점검 표면 언급 + 알려진 한계 #7) 본문 확인(**validated**). ② "doctor" 17 wi(**candidate**). ①④ missing.
- **순효능 논증**: mode-doctor는 ADR-0022가 결정으로 못박은 안전망이고 실사고에서 출발 — keep(validated ③). 나머지 doctor들은 옛 표면(hooks/bin/설치 상태) 점검기라 flip 후 점검 대상 자체가 바뀜 — 재진입 없이 rebuild 표면용으로 필요 시 재작성이 싸다.
- **철회조건**: rebuild 표면 배포 시 배포계약 점검(ADR-0011 D1 매핑)이 필요해지면 해당 doctor만 재진입.
- **(a) 플래그 사유**: doctor는 세션마다 발화 중(실사용) — 대부분 drop.
- **확정 질문**: mode-doctor 배너만 남기고 나머지 진단 표면을 flip과 함께 은퇴시켜도 되는지?

### A13 — worktree·workspace (core 2) · 추천 **drop + 철회조건** · status=proposed · 플래그 (a)

- **증거**: ③ ADR-20260626-worktree(ephemeral worktree·rootingRoot 경계 clarify)·ADR-20260715(land-to-origin) 본문 확인(**validated**) — 둘 다 "사용할 때의 행동"을 규율하는 clarify형이지 존재 의무를 부과하지 않음. ② record worktrees 필드 실사용 4/132(n1 실측 — **candidate**, 이 노드는 non-empty 건수 재확인 미수행). ①④ missing.
- **순효능 논증**: 사용 빈도가 낮고(4/132 후보) auto-memory에 worktree 관련 결함 이력이 반복(공유트리 병합 위생·repoRoot 오결정 3건) — 유지비 대비 효익 열위. core 2파일이라 재진입 자체는 싸므로 drop의 가역성이 높다.
- **철회조건**: 병렬 feature 개발 요구가 재부상하면 ADR-20260626/20260715 계약대로 재진입.
- **ADR 충돌 부기**: 두 worktree ADR은 존재를 강제하지 않음 → drop **비충돌**(method 정합 — 재진입 시 그 계약을 따르면 됨).
- **확정 질문**: worktree 병렬 개발 지원을 rebuild 세대에서 보류해도 되는지?

### A14 — cleanup 정리 (core 3) · 추천 **drop + 철회조건** · status=proposed · 플래그 (a)

- **증거**: ③ ADR-0017 본문 확인(**validated**) — 상태 줄에 "**결정 채택이며 구현은 미착수** — WU-1~은 별도 착수 허가 대상이고 coverage/property provider 배선이 선결조건"이라고 명시. ② "cleanup" 11 wi·"tidy" 10 wi(**candidate** — tidy 서브체인 사용분은 A1 소속). ①④ missing.
- **순효능 논증**: ADR-0017의 정리 워크플로 자체가 미착수라, 이 행의 core 3파일(cleanup·classify)은 그 결정의 부분 표면일 뿐이다. keep-측 validated 실적 없음 → 기본값 drop.
- **철회조건**: 재진입 시 ADR-0017 계약(behavior lock 사다리·D8 커밋 정책)을 그대로 따른다. ADR-0017의 선결조건(provider 배선)이 충족되는 시점이 자연 재개점.
- **ADR 충돌 부기**: ADR-0017 — 구현 미착수 명시로 drop은 **비충돌에 가까움**(method — 결정은 보존되고 구현 착수만 미룸).
- **확정 질문**: ADR-0017 정리 워크플로의 착수 자체를 rebuild 이후로 미루는 것으로 확정?

### A15 — charter·config·recipe (core 10) · 추천 **keep** (분할) · status=proposed · 플래그 (b 부기)

- **분할 내역**: keep = 공용 기반(ditto-paths·ditto-config — 3계층 경로 규약[ADR-0012]의 실행체, 전 영역이 소비). 제외(drop) = charter 주입(rebuild orchestration-prompt가 등가 후계)·recipe 로더(A16 재진입 시 함께 재평가).
- **증거**: ② 전 영역 소비(keep 대상인 A2·A3·A7·A8·A11 전부가 경로 헬퍼를 경유 — ADR-0012 D1 "약 30곳 단일 헬퍼 경유" 본문 확인, **validated**). ③ ADR-0012 본문 확인(**validated**), ADR-20260713-directive-fidelity·ADR-0003 본문 확인(**validated**). ①④ missing.
- **순효능 논증**: keep 집합이 존재하는 한 경로·설정 기반은 그 전제다(경로가 곧 정책 — ADR-0012). charter 주입은 rebuild가 자체 프롬프트 표면을 가지므로 옛 구현 재진입이 불필요.
- **(b) 부기**: ADR-20260713 — charter 문자열을 rebuild 프롬프트로 대체·리라이트할 때 **operative-cue 충실도 게이트가 적용 의무**(method — 대체 작업의 게이트 조건이지 drop 금지가 아님). ADR-0003(smol-toml) — codex 설정용: A18 후행 트랙 연동, 비충돌.

### A16 — setup·provision·init·teardown (core 10) · 추천 **redesign** (최소 진입만) · status=proposed · 플래그 (b)

- **분할 내역**: redesign 대상 = 결정적 진입·init scaffold·표면 등록(설치 경로 최소분). drop = wizard 5파일·teardown·provision 부속(LSP·CodeQL 설치 — A17 drop 연동)·skill/agent-creator 메타 표면.
- **증거**: ③ ADR-0011(D1 — 기층 4축 각각의 배포 계약 표+구현체 명시)·ADR-0012(D3 배포조립)·ADR-0022(결정 2 결정적 진입·결정 5 게이트 배포)·ADR-0018 본문 확인(**validated**). ② "setup" 14 wi(**candidate**). ①④ missing.
- **순효능 논증**: 배포 계약(ADR-0011 D1)은 "각 기층축이 타겟에서 살아있으려면 충족해야 할 계약"을 결정으로 못박았다 — 설치 경로가 전무하면 flip 후 제품이 dev-only가 되어 ADR-0022 게이트 배포·ADR-20260713-dogfood-not-purpose(가치는 사용자 프로젝트에서 발현)와 충돌한다. 따라서 최소 진입의 재구축은 구조적 필수(redesign 의무가 도피가 아님). 옛 10파일 전체 이식은 비용 열위 — 최소분만.
- **(b) ADR 충돌 판정**: 완전 drop이면 ADR-0011 D1·ADR-0022와 **intent** 충돌 → redesign(최소 진입)으로 회피. redesign은 **method**(재설계가 배포 계약을 준수하면 정합).
- **확정 질문**: flip 전 의무로 "결정적 진입+scaffold 최소분"만 두고 wizard·provision 부속은 drop하는 절단선에 동의하는지?

### A17 — semantic·lsp·codeql (core 11) · 추천 **drop + 철회조건** · status=proposed · 플래그 (a)

- **증거**: ③ ADR-0006 본문 확인(**validated**) — 단 이 결정은 "정적 추출을 한다면 엔진은 CodeQL 단일"이라는 **엔진 선택** 결정이지 정적 분석의 존재 의무가 아님. **반대 방향 ADR-0009 본문 필독 완료(계약 5 이행)**: ACG 잔여 4건 "구현 안 함" 종결 + "ACG governance 표면은 닫힌 것으로 본다" — 이 영역의 확장을 닫는 방향 신호. ADR-0004(deferred 정책)·ADR-0017(D3/D4 CodeQL 사용 전제 — 해당 워크플로 미착수) 본문 확인(**validated**). ② "codeql" 10 wi·"lsp" 3 wi(**candidate**). ① CodeQL 동등성 실증(ADR-0006 검증 절 14/14·25/25)은 도입 시점 검증이지 운용 중 결함 포착 아님. ④ missing.
- **순효능 논증**: 소비처가 A21(ACG)·A14(정리)·semantic-nudge인데 셋 다 drop 추천 — 소비처 소멸. DB 빌드 비용(캐시미스 13.8s~3분, ADR-0006 실측)과 다언어 쿼리 유지 부담이 미소비 상태의 효익을 지배.
- **철회조건**: rebuild 게이트가 결정론적 구조 사실(호출부 전수 등)을 증거로 다시 요구하면, ADR-0006 계약(CodeQL 단일·2차 엔진 금지)대로 재진입.
- **ADR 충돌 부기**: ADR-0006 — **비충돌**(엔진 선택 결정 보존, 존재 의무 아님). ADR-0009 — 종결 방향과 **정렬**.
- **확정 질문**: 정적 분석 능력 전체(runner·doctor 포함)를 소비처 부활 시점까지 은퇴시켜도 되는지?

### A18 — host seam (core 6) · 추천 **drop** (분할) · status=proposed · 플래그 (a)+(b)

- **분할 내역**: ① adapter 계약 = rebuild 등가 존재(`rebuild/seam/host-adapter.ts`·live/fake-host — n1 재확인) → 재진입 불필요. ② Codex측 어댑터·capabilities 카탈로그 = drop + 후행 트랙 재진입. ③ spawn 경로 = drop(아래 ① 참조).
- **증거**: ③ ADR-0016(D1~D6 dual-host 구조)·ADR-0025(Codex 격리)·ADR-0008(추가 추상 보류)·ADR-0011(session-rooting) 본문 확인(**validated**). ① headless claude spawn의 제품 내 금지 = 사용자 명시 거부 — auto-memory(**candidate**, ④급 신호이나 직접 표명 재확인은 리뷰 왕복에서). ② 전역 소비(candidate). ④ missing(위 항목이 왕복에서 ④로 승격될 수 있음).
- **순효능 논증**: intent.json out_of_scope가 "Codex parity 구현(Claude Code 우선, Codex는 후행 트랙)"을 이미 명시 — Codex측 drop은 사용자 승인된 연기이지 새 결정이 아니다. adapter 계약은 rebuild가 이미 소유.
- **(b) ADR 충돌 판정**: ADR-0016(dual-host는 제품 구조 결정) — **연기는 비충돌**(intent.json이 후행 트랙을 명시해 사용자 결정 존재), **영구 폐기면 intent 충돌**. ADR-0025는 Codex 작업 재개 시의 격리 규율로 보존.
- **확정 질문**: Codex 트랙의 "후행"이 재진입 백로그 등재(시점 미정)를 의미하는지, 이번 세대 범위 밖(폐기 아님)임을 재확인?

### A19 — push-gate 배포게이트 (core 2) · 추천 **keep** · status=proposed · 플래그 없음

- **증거**: ③ ADR-20260708 본문 확인(**validated**) — D3가 push-gate를 "push 시점 전체 스위트, fail-closed" 소관 표면으로 명시하고 D4가 barrier(degrade-PROCEED)와의 처분 비대칭을 가역성 축으로 정당화. ADR-0022(게이트 배포) 본문 확인(**validated**). 스키마 실재 직접 확인(**validated**): `src/schemas/recipe.ts`의 `push_gate`·`barrier_test_command` 구별 서술, `src/core/push-gate.ts`+`push-gate-cache.ts` 2파일. ② "push-gate" 14 wi·매 push 실행은 auto-memory(**candidate**). ①④ missing.
- **순효능 논증**: push는 비가역 경계(헌장 §4-8)이고 그 앞의 fail-closed 게이트는 낮은 비용(core 2파일)으로 비가역 실수를 막는다. keep 산입 근거는 validated ③(두 ADR 본문 + 스키마·코드 실재) — 비용 최저·비가역 보호로 순효능 성립.

### A20 — 회고·측정 (core 2) · 추천 **drop** · status=proposed · 플래그 (a)+(b)

- **증거**: ③ ADR-0024 결정 4(회고 측정 2지표 분리) 본문 확인 + `src/core/retro-measure.ts` 헤더 주석("ADR-0024 결정4") 직접 열람(**validated**). ② `memevt_retro_*` 이벤트 44건 직접 카운트(**validated** — 실사용 중), 소비자 `autopilot-loop.ts`·`autopilot-dispatch.ts` grep 재확인(**validated**). ①④ missing.
- **순효능 논증**: 옛 구현은 옛 autopilot 루프에 결합(소비자 2곳 모두 A1 drop 대상)이고, rebuild에는 측정 방향의 후계(`rebuild/state/net-efficacy.ts`·ac-2facet·legibility — n1 재확인)가 이미 있다. 실사용(validated ②)에도 불구하고 결합 대상이 은퇴하므로 옛 구현 재진입은 성립하지 않는다.
- **철회조건**: rebuild 루프에 회고 seam이 생기면 ADR-0024 결정 4의 계약(2지표 분리·anti-SLOP omit)대로 재실현.
- **(b) ADR 충돌 판정**: ADR-0024 결정 4 — **method**(rebuild net-efficacy가 측정 계약을 인수하면 정합; 측정 자체를 포기하면 intent로 승격).
- **확정 질문**: 회고 측정 계약의 인수처를 rebuild net-efficacy 상태로 지정하는 데 동의하는지?

### A21 — ACG 변경 거버넌스 (core 3 + src/acg 37, 인접 표면) · 추천 **drop + 철회조건** · status=proposed · 플래그 (a)

- **증거**: **반대 방향 ADR-0009 본문 필독 완료(계약 5 이행)**: micro-item 4건 전부 "구현 안 함" + "ACG governance 표면은 닫힌 것으로 본다" — 이 영역의 종결 선언(**validated**). ③ ADR-0004(Q3 deferred·Q4 비용 정책)·ADR-0017(정리를 ACG 위에 — 단 워크플로 미착수) 본문 확인(**validated**). ② "refactor" 18 wi(**candidate**)·백로그 감사가 #9(ACG 개선)를 '소멸'로 분류(`reports/backlog-audit-2026-07-21.md` 실재 직접 확인 — 참고 신호, 판정 아님). ①④ missing. auto-memory에 "ACG ① full-bar PARKED(기술달성·가치미달 보류)" 이력(**candidate**).
- **순효능 논증**: ADR-0009가 표면을 닫았고, ADR-0004의 소비처(단계6 boundary 게이트)는 v0 범위 밖 deferred이며, ADR-0017 워크플로는 미착수 — 살아있는 소비처가 없다. core 3 + acg 37파일의 유지·재진입 비용이 효익을 압도.
- **철회조건**: ADR-0009의 D1~D4 철회조건 개별 발동, 또는 정리 워크플로(A14) 재진입이 fitness 게이트를 선결로 요구하는 시점.
- **ADR 충돌 부기**: ADR-0009 — **정렬**(종결 방향). ADR-0017 — **method**(미착수 결정 보존).
- **확정 질문**: ACG 표면(인접 src/acg 37 포함)의 flip 동반 은퇴를 확정하는지?

### A22 — 공용 기반 유틸 (core 3: fs·git·source-extensions) · 추천 **keep** (파생적) · status=proposed · 플래그 없음

- **증거**: ② 전 영역 소비(n1 귀속 실측 — **validated** 수준의 구조 신호이나 개별 소비처 전수는 재확인 안 함: candidate 부기). ①③④ 해당 없음/missing.
- **순효능 논증**: 독립 판정이 아니라 keep 집합(A2·A3·A7·A8·A11·A15·A19)의 전제 기반으로서의 파생 keep. keep 집합이 공집합이 되면 함께 drop. rebuild가 자체 최소 유틸을 가지므로 재진입 시 중복분은 rebuild 쪽으로 수렴.

### hooks — hooks 집행 표면 (src/hooks 10, 인접 표면) · 추천 **keep** (분할) · status=proposed · 플래그 없음

- **분할 내역**: keep = ① pre-tool-use 안전 게이트(scope-out·secret·apply_patch 경로 게이트) ② post-tool-use(편집 증거 — ADR-0016 D2가 같은 게이트의 적용을 요구) ③ session-start(A12 keep분 mode-doctor 배너의 운반 경로) ④ Stop = rebuild 등가 존재(`rebuild/hook/stop-hook.ts`)로 옛것 재진입 불필요. drop = pre-compact·user-prompt-submit(charter 주입 — A15에서 charter drop과 연동, rebuild 프롬프트로 이관)·semantic-nudge(A17 drop 연동).
- **증거**: ① ADR-0011 본문 확인(**validated**): boxwood inc6에서 PreToolUse scope-out이 repo 밖 쓰기를 실제 차단한 기록 — "버그가 아니라 경계"로 결정화. 일반화 논증: repo 경계·비밀 차단은 사용자 프로젝트에서 그대로 발화하는 안전 불변식(프로젝트 특이 아님). ③ ADR-0011 D2(session-rooting을 훅이 집행)·ADR-0016 D2(apply_patch 게이트) 본문 확인(**validated**). ② 매 도구 호출 발화(candidate). ④ missing.
- **순효능 논증**: scope-out·secret 게이트를 drop하면 ADR-0011 D2 불변식의 집행점이 사라진다(intent 충돌) — keep으로 해소. 안전 게이트는 발화 비용이 낮고 차단 실적의 validated 핀(inc6)이 있다.
- **ADR 충돌 부기**: drop이었다면 ADR-0011 D2(intent — 불변식 집행점 소멸)·ADR-0016 D2(method). keep(분할)으로 해소. user-prompt-submit drop은 ADR-20260713의 게이트 대상 문자열이 rebuild 프롬프트로 이관됨을 전제(**method** — A15 부기와 동일).

---

## 사용자 확정 기록 (n4-user-batch-review, 2026-07-23T11:43Z)

확정 방식: 세션 내 구조화 질문(AskUserQuestion) 4묶음 + 의존 불일치 해소 1묶음 + 누락 플래그(A16) 1건 — flagged 15행 전건 개별 응답 + 무플래그 9행 일괄 확정. 아래 "응답"은 사용자가 선택한 답의 축자 라벨. confirmed_by=사용자(세션 대화).

**행 단위 확정 시점 (묶음 매핑 — n6 검증 지적 보강)**: 묶음은 엄격 순차(1→6)로 진행됐고, 실측 앵커는 전 묶음 완료 직후 `date -u` = **2026-07-23T11:43:06Z**(하한: dialectic Opponent 완료 10:42:46Z 이후 분류표·ADR 저작 완료 뒤 회부). 묶음별 벽시계 시각은 계측되지 않았다 — 행별 시점은 "묶음 서수 + 경계 창"으로 특정된다(정직한 정밀도 한계 명시).

| 묶음 | 행 | 시점 특정 |
|---|---|---|
| 1 | A9 · A5 · A1 · A4 | 창 시작 ~ 묶음2 이전 |
| 2 | A2 · A6 · A10 · A12 | 묶음1 이후 ~ 묶음3 이전 |
| 3 | A13 · A14 · A17(1차 응답) · A18 | 묶음2 이후 ~ 묶음4 이전 |
| 4 | A20 · A21 | 묶음3 이후 ~ 묶음5 이전 |
| 5 | A17(flip 최종) · A5(keep 형태) · 무플래그 9행 일괄 | 묶음4 이후 ~ 묶음6 이전 |
| 6 | A16 | 묶음5 이후 ~ **11:43:06Z(실측)** 이전 |

### flagged 행 개별 확정 (15건 전건)

| 행 | 플래그 사유 | 최종 판정 | 사용자 응답 (축자) |
|---|---|---|---|
| A9 | (a)실사용+(b)ADR intent 충돌(기능 4축 축3) | drop+철회 | "drop+철회 확정" |
| A5 | (a)실사용+(b)ADR intent 충돌(규정 ADR 대상 소멸) | **keep (flip)** | "keep" — 추천(drop) 기각, 실측 비용 고지 후에도 keep 선택 = 사용자 직접 표명(증거 ④ validated) |
| A1 | (a)실사용+(b)행동 계약 ADR 5건 | drop+계약 인수 의무 | "인수 의무 지정" — ADR 5건(materialize≠drive·종료 완전성·결함 클래스 체인구동·envelope 무손실·barrier tier)을 rebuild 루프 인수 의무로 |
| A4 | (b)ADR method 조건부 | redesign | "redesign 확정" — flip 전 완료 의무 수용 |
| A2 | (a 부분)untargeted 9종 drop | keep(입증분만) | "입증분만 keep 확정" |
| A6 | (a)실사용 후보 | drop+철회 | "전체 drop+철회 확정" — spec-doc 부분 구제 불선택 |
| A10 | (a)실사용 후보 | drop(A9 연동) | "A9 연동 drop 확정" |
| A12 | (a)실사용(세션마다 발화) | drop(배너만 keep) | "배너만 keep 확정" |
| A13 | (a)실사용 후보 | drop+철회 | "drop+철회 확정" |
| A14 | (a)실사용 후보 | drop+철회 | "drop+철회 확정" |
| A17 | (a)실사용 후보 | **keep (flip)** | 1차 "drop+철회 확정" → 의존 불일치(A21 keep) 고지 후 **"A17도 keep으로 flip"** — 최종 keep |
| A18 | (a)+(b)dual-host 구조 ADR | drop(분할)+Codex 백로그 등재 | "백로그 등재 확정" — 폐기 아님 재확인 |
| A20 | (a)실사용+(b)측정 계약 ADR | drop+인수처 지정 | "인수처 지정+drop 확정" — 인수처=rebuild net-efficacy |
| A21 | (a)실사용 후보 | **keep (flip)** | "keep" — 추천(drop, 종결 ADR 정렬) 기각 = 사용자 직접 표명(증거 ④ validated) |
| A16 | (b)배포 계약 ADR | redesign(최소 진입) | "redesign(최소 진입) 확정" — 저작 시점 flagged 요약 누락을 n4가 발견·정정 후 개별 확정 |

### 의존 불일치 해소 (n4 왕복 중 발견·확정)

1. **A17↔A21**: A21 keep(flip)으로 A17 drop의 전제("소비처 전부 drop")가 깨짐을 고지 → 사용자 "A17도 keep으로 flip". 결과: A17·A21 모두 keep, 의존 정합.
2. **A5↔A1**: A5 keep(flip)의 소비처(계획 단계 스윕)가 A1 drop 대상(옛 루프) 안임을 고지 → 사용자 "옛 구현 그대로 재진입" 선택(추천이었던 '계약-keep+rebuild 재배선' 기각). 결과: A5는 옛 구현 그대로 재진입하되 소비처 재배선 전 잠시 고아 상태 감수(사용자 인지·수용).

### 무플래그 9행 일괄 확정

A3·A6b·A7·A8·A11·A15·A19·A22·hooks — "9행 일괄 확정" (이의 0건). 각 행 추천 그대로 확정.

### flip이 재진입 규모에 미치는 영향 (기록)

flip 3건(A5 keep 8파일·A17 keep 11파일·A21 keep core 3+acg 37)으로 재진입 대상이 추천 대비 +59파일. redesign 2행(A4·A16)의 flip-전-완료 의무는 변동 없음.

## 잔여 불확실성 (리뷰 왕복 입력)

1. **④ 사용자 체감은 전 행 missing이었음** — n4 왕복에서 A5·A17·A21의 keep 선택이 사용자 직접 표명(④ validated)으로 채워짐. 나머지 행은 여전히 missing(확정 판정에는 영향 없음).
2. **candidate로 남은 주요 항목(승격 실패)**: 키워드 wi 카운트 전부(언급≠사용 미분리) · A6 opponent seam ADR-0018 위반 흡수(저장소 핀 미발굴) · A11 라이브 dogfood 결함 3건(auto-memory) · A13 worktrees 실사용 4건(non-empty 재확인 미수행) · A18 headless spawn 사용자 거부(직접 표명 재확인 필요) · A4 declared-risk 결함 수정 서사(Run tier 재핀 미수행).
3. **Run tier validated 핀의 이식성** — A1(autopilot.json 54)·A2(wi_2607189u3 audit-findings.md)는 로컬 전용(gitignored)이라 다른 머신에서 재현 불가. 커밋 증거가 필요하면 리뷰 왕복에서 발췌 승격 필요.
4. **redesign 2행(A4·A16)의 flip 전 완료 의무** — keep 집합 크기와 함께 flip 게이트(#69) 부담을 정하므로, 사용자 확정 시 의무 수용 여부를 명시적으로 받을 것.

---

## per-feature 이슈 manifest (n5)

n5-issue-creation, 2026-07-23. 확정 keep 13 + redesign 2 = 15행 전건 + A18 Codex 후행 트랙 1건 = **이슈 16건**. label `rebuild-reentry`, milestone `M-chain (실증 사슬 최우선)`(#1)·`M-topo (의존 위상정렬)`(#2). **materialize만 — 어떤 이슈도 착수·구동하지 않음.**

### preflight baseline (생성 전 0건 증거)

`gh issue list --repo incognito050924/ditto --label rebuild-reentry --state all --json number,createdAt` (label 생성 직후·이슈 생성 전, exit 0):

```
[]
```

### 행ID ↔ 이슈번호 ↔ milestone (생성 createdAt 전수)

| 행 | 판정 | 이슈 | milestone | createdAt (UTC) |
|---|---|---|---|---|
| A2 | keep(입증분만) | #78 | M-chain | 2026-07-23T11:52:40Z |
| A3 | keep(분할) | #79 | M-chain | 2026-07-23T11:52:42Z |
| A4 | redesign (flip 전 완료 의무) | #80 | M-chain | 2026-07-23T11:52:44Z |
| A5 | keep(flip·옛 구현 그대로) | #81 | M-topo | 2026-07-23T11:52:45Z |
| A6b | keep | #82 | M-topo | 2026-07-23T11:52:47Z |
| A7 | keep(코어 한정) | #83 | M-topo | 2026-07-23T11:52:49Z |
| A8 | keep | #84 | M-topo | 2026-07-23T11:52:51Z |
| A11 | keep(SoT 코어) | #85 | M-topo | 2026-07-23T11:52:53Z |
| A15 | keep(공용 기반만) | #86 | M-chain | 2026-07-23T11:53:03Z |
| A16 | redesign (flip 전 완료 의무) | #87 | M-topo | 2026-07-23T11:53:05Z |
| A17 | keep(flip) | #88 | M-topo | 2026-07-23T11:53:07Z |
| A19 | keep | #89 | M-topo | 2026-07-23T11:53:09Z |
| A21 | keep(flip) | #90 | M-topo | 2026-07-23T11:53:11Z |
| A22 | keep(파생) | #91 | M-chain | 2026-07-23T11:53:13Z |
| hooks | keep(분할) | #92 | M-topo | 2026-07-23T11:53:14Z |
| A18(Codex측) | 후행 백로그(폐기 아님·시점 미정) | #93 | — (chain/topo 밖) | 2026-07-23T11:53:16Z |

### 사슬 도출 근거 (ADR-20260723 §D6·D7 — "없으면 비사소 실증 완주(계획→구현→검증→완료, rebuild 구동 루프) 불가능한가")

**사슬 구성원 5행 → M-chain**:

- **A3**: 완주의 상태(계획~완료 record·판정)가 이 저장 계층에 결박 — 없으면 완료를 기록·판정할 표면이 없다.
- **A2**: '검증→완료' 단계를 증거로 판정하는 집행체 — 없으면 완료가 증거 없는 주장이 되어 D6 완주 불성립(rebuild 부분 등가 위에 keep 계약이 완료 판별 담당).
- **A4**: 비사소 작업은 무거운 경로이고 무거운 경로는 intent 산출 없이 출발 불가(본 분류표 순효능 논증 축자) — 계획 단계 선행 필수.
- **A15**: 사슬 구성원(A2·A3)이 경로·설정 헬퍼를 실행 경로상 경유 — 파생 사슬.
- **A22**: 사슬 구성원이 fs·git 유틸을 실행 경로상 소비 — 파생 사슬.

**비사슬 10행 → M-topo** ("없어도 완주 가능한 이유"):

- **A5**: 계획 스윕은 advisory — 소비처 재배선 전 고아 상태 감수(사용자 수용) 자체가 실행 경로 밖 방증.
- **A6b**: 결정 품질 장치(표면 전용) — 없어도 완주 가능.
- **A7**: memory query는 컨텍스트 보강 — 없어도 완주 가능.
- **A8**: 결정 기록·투영 표면 — 완주 실행 경로 필수 아님.
- **A11**: 완주는 work item 단위로 성립 — GitHub read/미러 없이도(수동 등록 경로) 가능.
- **A16**: 완주는 dev 트리에서 가능 — 결정적 진입은 flip 조건이지 실증 실행 경로 아님(flip-전-완료 의무는 D5로 별도 구속).
- **A17**: 정적 분석은 증거 보강·A21 소비용 — 없어도 완주 가능.
- **A19**: D6 완주 정의(계획→구현→검증→완료)에 push 미포함 — push는 완주 뒤 별도 비가역 경계.
- **A21**: 소비처 게이트(ADR-0004 단계6) deferred — 완주에 불필요.
- **hooks**: 안전 불변식 집행이지 완주 실행 경로 아님(Stop은 rebuild 등가 보유).

**위상정렬 의존 요지(이슈 본문 ④에 기재)**: A22·A15=기반층(선행 없음, 병렬) → A3 → A2·A4·A11; A8 → A7; **A17↔A21 상호 의존(재진입 동반)**; A16↔A17(CodeQL 설치분 연동 — A17 flip으로 재평가 필요); hooks↔A12 keep분(mode-doctor 배너 운반)·semantic-nudge 처분은 A17 flip으로 재확인 필요. redesign 2건(#80·#87)은 flip(#69) 전 완료 의무 명기.

### manifest 수집 (생성 직후 전수, exit 0)

`gh issue list --repo incognito050924/ditto --label rebuild-reentry --state all --limit 50 --json number,title,createdAt,milestone` → 16건: #78~#93 (createdAt은 위 표에 전수 기재, milestone 배정 M-chain 5·M-topo 10·null 1[#93]).
