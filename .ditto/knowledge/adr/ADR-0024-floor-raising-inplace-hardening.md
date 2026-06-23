# ADR-0024: 기획~구현 품질 floor — design 노드 제자리 경화 (AC↔oracle 수렴·회고 측정·의사결정 투명성)

- 상태: accepted (increment 1 착지 — AC↔oracle 코어가 코드로 착륙·검증됨; 나머지 결정은 후속 increment)
- 결정 일자: 2026-06-23 (proposed) · 2026-06-23 accepted 승격 (increment 1 wi_260623uap 착지)
- 결정자: hskim, claude (claude-opus-4-8)
- 관련: ADR-0023 (fused design 노드·far-field detect/propose/manual·비용/중복 거부 — 이 ADR은 그와 **정합(alignment)**, supersede 아님), ADR-0020 (결정-모순 가드레일·fail-closed — 투명성 원칙과 정합), ADR-0018 (옵셔널 도구 강등 — 정적 검증법 분석기 부재 시), ADR-0013 (완료 계약). 코드(권위, increment 1 착지 후 실제 닻): `src/schemas/work-item.ts`(`acOracle` — verification_method{dynamic_test|static_scan|soft_judgment} × maps_to × direction forward|backward, forward는 코드-포인터 maps_to 거부; `acceptanceCriterion.oracle` additive-optional), `src/core/autopilot-loop.ts`(design-close 경로가 recordResultPayload.ac_oracles를 work-item AC에 기록), `src/core/coverage-manager.ts`(`producePlanGate` 결정론 presence-CHECK만·순수 유지; `validateAcOracle`·`assertOracleFrozen`·`oraclesEqual` — 적대 검증+forward-AC frozen, design-close write 직전 배선), `src/core/autopilot-dispatch.ts`(`buildDelegationPacket` — AC 문장+oracle을 context.acceptance로 운반), `src/core/autopilot-complete.ts`(`deriveAcVerdicts`/`nodeVerdictFor` — AC↔oracle **닫힘 판정**), `src/core/gates.ts`(`oracleSatisfaction` — presence-gated·fail-closed·static_scan은 재스캔 evidenceRef 필요), `src/hooks/stop.ts:83`(`dialecticForcesContinuation` — **dialectic-OBJECTION 게이트**; ac-4 clause 2로 admissible objection의 file:line/path 닻 디스크 실재 검사 추가). 측정 재료(후속 increment): `src/core/coverage-feedback.ts`·`src/core/intent-quality-doctor.ts`·`src/core/completion-coverage-doctor.ts`. intent floor 공허(후속): `src/core/interview-driver.ts:70,271`. 설계 상세(drift 주의·비권위): `reports/design/floor-raising-blueprint.md`. 심의: dialectic round-1 (verdict=revise).

### 착지 (landed) — increment 1 (wi_260623uap)
- 착지한 것: **결정 1·2·3 + 적대 변환기 + forward-AC frozen oracle** = AC↔oracle 코어. 전 스위트 2802 pass/0 fail (fresh verifier+reviewer).
- 후속 increment로 남은 것: **결정 4(회고 측정), 5(plan 미리보기 뷰), 6(루프 규율), 7(의사결정 투명성 전면화)**. 결정 7은 부분 내재화됨 — oracle-unmet 블록이 이미 사유(reasons)를 발화한다.
- **앵커 정정**: 원안(아래 결정 1·6 등)이 `stop.ts:88`을 "현 oracle 게이트"로 불렀으나 잘못이다 — `stop.ts`의 `dialecticForcesContinuation`은 **dialectic-objection 허용성 게이트**이고 AC oracle을 닫지 않는다. AC-oracle **닫힘 판정**은 `deriveAcVerdicts`/`nodeVerdictFor`(autopilot-complete.ts) + `oracleSatisfaction`(gates.ts)에 산다. stop.ts가 받은 것은 backward-finding objection 닻 실재 검사(ac-4 clause 2)뿐이다. 이 오라벨은 plan 단계 pre-mortem이 드러냈다.

## 컨텍스트

목적: 사용자의 기획/설계 역량과 무관하게 ditto를 거치면 **autopilot 최종 산출물의 품질 floor가 일관되게** 오르게 한다. 조사(4 researcher, main 코드)로 확인한 현황:

- floor는 2층. **breadth/구조 층**(far-field 19 카테고리 무조건 주입·vague-AC bootstrap 차단·coverage sweep 필수)은 실재하고 기획자 실력과 무관. **depth/validity 층**은 honor-system — neutrality·`admissibleBranchesAdded`·oracle 전부 에이전트 자기보고이고 `dialecticForcesContinuation`(stop.ts:83, dialectic-objection 게이트)은 objection 문자열의 *존재+severity*만 검사했다(닻 실재·판별 미검증), anti-SLOP refute 게이트 미착륙(ADR-0023:40). (increment 1이 backward-finding objection 닻 실재 검사를 추가 = ac-4 clause 2.)
- 의도 손실: 위임 packet이 AC **id만** 운반(`autopilot-dispatch.ts:110-111`) — 구현자는 AC 문장·oracle을 못 받는다.
- intent floor 공허: deep-interview `dimensions:[]` 시드(`interview-driver.ts:70`) — critical 0개면 "모든 critical 해결" 게이트가 공허; readiness는 LLM 자기보고(`:271`).
- 출력 floor 측정 부재: 끝에서 산출물 품질을 재는 단일 지표 없음(재료만 흩어짐).

dialectic(round-1, Codex 교차모델 Opponent) verdict=**revise**: 진단은 main에서 검증돼 살아남았으나, "4단계 라이프사이클 *분리*" 프레임은 기각(O1 critical: plan을 autopilot 밖으로 빼면 `design` 노드의 유일 증거 기록을 우회하거나 ADR-0023이 거부한 중복 sweep을 재생성).

## 결정

floor를 **단계 분리가 아니라 `design` 노드 *제자리(in-place)* 경화**로 올린다. (서사 순서 의도→계획→구현→회고→정리는 유지, 코드 단계 구분은 불변.)

1. **AC↔oracle 수렴.** 완료 통화를 "LLM이 됐다고 말함"에서 **"AC가 재평가 가능한 oracle로 닫힘"**으로 바꾼다. ①매치=`design` 노드 design-close 경로가 `recordResultPayload.ac_oracles`를 work-item AC에 기록(LLM-배정), `producePlanGate`는 결정론 presence-CHECK만 추가(순수 유지 — producePlanGate 안에서 LLM 배정 아님); ②전달=packet 농축(AC 문장+oracle, `buildDelegationPacket` → context.acceptance); ③판정=`deriveAcVerdicts`/`nodeVerdictFor`(autopilot-complete.ts) + `oracleSatisfaction`(gates.ts) — **completionGate 아님, stop.ts 아님**; presence-gated·fail-closed, static_scan은 기록된 재스캔 evidenceRef 필요(분석기 부재→unverified, ADR-0018). 분리하지 않음(ADR-0023:44-46 정합).

2. **oracle 모델 — 재평가 가능성이 강도.** oracle = *기계가 재평가 가능한* 의도된 행동/속성의 진술. 두 축: **대상**(`maps_to`: AC/file:line/intent/doc) × **검증법** 3부류 — **hard·동적**(테스트=실행) / **hard·정적**(분석·스캔=재스캔; `file:line` 앵커) / **soft·판단**(review/user-decision). forward AC(구현 후 평가)는 hard 우선·코드-포인터 금지(변경에 부서짐); backward finding(현재 코드 증거)만 `file:line` 유효. **`file:line` ≠ soft**(정적 부류 앵커). finding의 raise(현재)와 resolution(detector 재실행/회귀 테스트)은 시점·oracle이 다르다.

3. **변환기 적대 검증 + oracle frozen.** AC→oracle 변환기를 적대 검증한다(가짜/tautological oracle 주입 → 불일치 거부) = anti-SLOP의 이 WI 버전. 구현자는 oracle(테스트·정적 규칙)을 *수정 못 함* — 수정하면 tautology가 부활한다.

4. **회고 측정 — 두 지표 분리.** ①산출물 floor(completion-coverage 비율·`isUnitOnlyClosure`·escape ledger) + ②과정 건강도(`intent-quality` post_cost). 섞지 않는다(과정 쌈 ≠ 결과 좋음). **지표 자체도 anti-SLOP**: 재평가 가능·근거 있는 데이터만 카운트, 근거 불명확하면 *넣지 않는다*(슬롯이 곧 유도 편향). ③회고 서술(남은 이슈·미해소 사유·계획 변경)은 기존 기록(`unverified`/`residual`·`close_reason`·intent-drift·evidence)의 **투영**만 — 근거 없는 자유 reflection 생성 금지(`ditto:retrospective` 재사용). → 메모리 흡수(**cross-WI** 피드백; WI 내부 피드백은 범위 밖, O9).

5. **plan 미리보기 뷰.** 구현 전 AC↔oracle 매핑을 사용자가 보고 승인(뷰일 뿐, 증거는 design 노드가 기록 — ADR-0023 비위반).

6. **루프 규율.** 수렴 통화 = oracle 충족(LLM-verdict 아님) + 예산 cap(`cap ≠ converged`) + wrong-fixpoint 처리(oracle 닫혔는데 변환기 불일치 → 재open; 동일 oracle K회 실패 → blocked).

7. **의사결정 투명성(횡단).** 게이트 판정·oracle 배정·far-field skip/route·루프 종료를 *확인 OR 문서 OR 계약* 중 최소 하나에 기록. 조용한 결정 금지(charter §4-10 일반화).

강도: **raise + measure** — spec-fidelity 연결을 올리고 측정한다. "보장(반례 0)"은 주장하지 않는다.

## 기각된 대안 (dialectic)

- **4단계 라이프사이클 분리** — design 노드의 유일 증거 기록 우회 / ADR-0023 중복 sweep (O1 critical, O11).
- **executable-test 유일 수렴 화폐** — floor를 *테스트 가능한 것*으로 축소(O4); 정적·soft 부류 누락.
- **"자동 > 리뷰" 일반 원칙** — 일부 게이트는 의도적으로 사용자 결정에 양보(`stop.ts:613-620`, O7).
- **"보장(반례 0)"** — 게이트는 연결+증거 *존재*를 증명할 뿐 깊이 보장 못 함(O3, O12).
- **WI 내부 intent⇄output 피드백** — 범위확장·후기 발견 비용 재도입(O9); cross-WI 회고만.
- **코드-포인터(file:line/symbol/content) oracle을 forward AC에** — 변경에 드리프트(raise≠resolution; symbol/content도 rename·중복·공백에 깨짐).
- **구조 건강 delta를 산출물 floor의 sub-축으로** — 기각: floor 지표에 그 슬롯을 두면 *존재 자체가 유도 편향*(에이전트가 없는 개선을 만들어내는 SLOP·불필요 리팩터, §4-4; far-field confabulation과 같은 메커니즘). 코드 건강은 standalone `ditto fitness`/ACG·Tidy First(ADR-0017)에서 독립 측정·소비(중복 구축 = wi_260615lj6), per-WI floor와 섞지 않는다.

## 적용 범위·미착지 (정직)

- **이 ADR = 설계 결정**(구현 0). 코드 변경은 후속 WI들. 청사진(`reports/design/floor-raising-blueprint.md`)이 섹션별 상세·file:line 부착 지점을 담는다.
- 경계(상류 의존, 명시): **AC 관측성 게이트**(= tech-spec; `tech-spec.ts:204-235`는 형태만 검사, 관측성 미검증), **과정 측정 인프라**(= wi_260608acp), **far-field 자동 sweep 비용 재측정**(= wi_26062227h), **정적 검증법 분석기 부재 강등**(ADR-0018).

## 철회·재검토 조건

- AC↔oracle 경화가 비용으로 실효 못 하면 → 검증법 범위(강도)를 조절하되 **"AC는 재평가 가능 oracle로 닫힌다"** 원칙 자체는 불변.
- soft rung이 과다해지면(대부분 AC가 user-decision으로 닫힘) → AC 관측성/검증법 배정을 재점검(약한 floor 신호).
- 구현 후 회고 측정 ①②가 "약한 기획자 분산 축소"를 못 보이면 → 모델 재검토.
