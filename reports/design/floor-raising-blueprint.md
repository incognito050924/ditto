# Blueprint — 기획~구현 품질 floor 제자리 경화

- Work item: wi_260623dfa
- Status: **DRAFT (increment 1, 리뷰 대기)**
- 강도: **raise + measure** (보장 아님 — spec-fidelity 연결을 올리고 측정)
- 산출 경계: 이 청사진 + ADR(ADR-0024). 구현은 후속 WI.
- 권위: 코드(소스·테스트·스키마) + ADR. 이 문서는 설계 합의용 — 구현에 흡수되면 정리(cleanup) 대상.

> 이 문서는 dialectic(verdict=revise, `reviews/dialectic-1.md`)으로 한 번 적대 검증된 방향을 설계로 옮긴 것이다. 5단계 라이프사이클(§2: 의도→계획→구현→회고→정리)을 *별도 단계로 분리하지 않고* 기존 `design` 노드 제자리에서 경화한다.

---

## 0. 목적

사용자의 기획/설계 역량과 무관하게, ditto 파이프라인을 거치면 **autopilot 최종 산출물의 품질 하한(floor)이 일관되게 올라가도록** 한다. 약한 기획자의 얇은 입력도 사슬을 통과해 결과의 바닥을 받쳐야 한다.

---

## 1. 진단 — 검증된 현황 (two-layer floor)

ditto의 floor는 2층이다 (4 researcher가 main에서 file:line으로 확인):

- **breadth·구조 층 = 실재, 기획자 실력 무관** ✅ — far-field 19 카테고리 무조건 주입(`src/core/coverage-taxonomy.ts`), vague-AC는 bootstrap에서 차단, design 노드 닫기 전 coverage sweep 필수.
- **depth·validity 층 = honor-system, 코드 미강제** ✗ — neutrality·`admissibleBranchesAdded`·oracle 전부 에이전트 자기보고. `src/hooks/stop.ts:88`은 oracle 문자열 `maps_to`가 *비어있지 않은지* + severity만 검사(실재·실행성 미검증). anti-SLOP refute 게이트 미착륙(ADR-0023:40).
- **의도 손실 지점** — 위임 packet이 AC **id만** 운반(`src/core/autopilot-dispatch.ts:110-111`: `done_when = "acceptance criteria satisfied with evidence: " + ids`). 구현자는 AC 문장·oracle·pre-mortem brief를 못 받는다.
- **intent floor 공허** — deep-interview가 `dimensions: []`로 시드(`src/core/interview-driver.ts:70`) → "모든 critical 해결" 게이트가 critical 0개면 공허하게 참. readiness는 LLM 자기보고(`:271`).
- **출력 측정 부재** — 최종 산출물 floor를 끝에서 재는 단일 지표 없음. 재료만 흩어짐(`completion-coverage-doctor.ts`, `intent-quality-doctor.ts`, coverage escape ledger).

→ 약한 기획자는 정확히 depth/validity 층과 intent floor 공허에서 샌다. 해법은 **이 honor-system 지점들을 제자리에서 실행 가능한 oracle로 경화 + 출력/과정 측정 + 의사결정 투명성**이다.

---

## 2. 라이프사이클 (ac-1) — 5단계, 분리 없음, plan 미리보기 뷰

순서·단계 구분은 **그대로**. 새 단계를 만들지 않는다.

```
의도 (deep-interview / tech-spec)  →  intent.json
   │
계획 = autopilot 의 design 노드 (기존, 제자리 경화)   ← plan 미리보기 뷰 노출
   │
구현 (autopilot: implement → verify → review)  [루프]
   │
회고 (측정 ①산출물 floor + ②과정 건강도 → 메모리)
   │
정리 (close · git/worktree · 산출물 메모리 흡수 · drift 문서 폐기)
```

**핵심 결정 (dialectic O1, critical)**: "계획"을 autopilot 밖 별도 단계로 분리하지 **않는다**. `design` 노드(`src/core/autopilot-loop.ts:944-985`, `producePlanGate`)가 plan 단계 증거(`approval_gate.change_surface`·`plan_brief`·`coverage.json`)를 기록하는 **유일한 지점**이기 때문이다. 분리하면 이 기록을 우회하거나 ADR-0023:44-46이 비용·중복으로 거부한 별도 sweep을 재생성한다.

**plan 미리보기 뷰 (사용자 표면)**: 구현 시작 전, design 노드가 산출한 **AC↔oracle 매핑 + 계획**을 사용자가 보고 승인하는 체크포인트. 뷰일 뿐 새 코드 단계가 아니며, 증거는 여전히 design 노드가 기록(ADR-0023 비위반).

---

## 3. AC ↔ 허용 oracle 수렴 모델 (ac-2)

floor의 수렴 기준을 **"LLM이 됐다고 말함" → "AC가 허용 oracle에 연결됨"**으로 바꾼다.

### 3.0 oracle 정의 (glossary 등재됨)
**oracle = 어떤 주장·AC가 참인지 판정하는 것 — "이게 됐는지 *무엇으로* 판정하나"의 판정 기준.** 두 축으로 구성된다:
- **대상**(무엇에 닻을 내리나) — `maps_to`: AC id / file:line / intent / doc. (ditto 기존 필드, `src/schemas/dialectic.ts:77`)
- **검증법**(어떻게 판정하나) — §3.1의 3부류(동적 테스트 / 정적 분석 / soft 판단) 중 하나.

이 개념은 **dialectic 전용이 아니라 횡단**이다 — dialectic objection·far-field anti-SLOP(`skills/autopilot/SKILL.md:37`)·reviewer/security 발견(`agents/reviewer.md:29`)·CodeQL(`src/core/codeql/sarif-adapter.ts:74` `oracleOf`)·completion-contract(`src/schemas/completion-contract.ts:86`) 전반에서 "oracle 없는 주장은 taste지 finding이 아니다"로 쓰인다. 이 설계는 같은 메커니즘을 **AC에도 일반화**한다.

**알려진 갭(이 설계가 메우는 것)**: 현재 `stop.ts:88`은 oracle *문자열의 존재+severity*만 검사한다 — 그 닻이 실재하는지·실제로 참/거짓을 가르는지(=검증법)는 미확인. 지금 oracle은 "어디에 닻 내렸다"는 **이름표**일 뿐이고, 이 설계가 그 비어 있는 **검증법** 자리를 채운다.

**두 세계 — forward(AC 수렴) vs backward(finding).** 같은 oracle 개념이 두 시점에 쓰이고, 그게 검증법 선택을 가른다:
- **forward — AC 완수조건** ("이 *변경이* 충족하나"): 구현 *후* 최종 상태에 평가 → **재실행 가능한 검증법(동적/정적)**. 코드-위치를 *가리키지* 않는다 — 미래/변경 중 코드라 부서지므로.
- **backward — finding/objection** ("*지금* 기존 코드 여기가 문제다"): *현재* 상태에 평가(매치=평가 동일 시점) → `file:line`/`maps_to` 앵커가 유효. dialectic objection·reviewer·CodeQL의 자리.
- **finding의 raise vs resolution은 다른 시점·다른 oracle**: raise는 현재 코드 증거(file:line). **resolution**(fix 후 "사라졌나")은 *얼린 file:line 재확인*이 아니라 **detector 재실행(정적) 또는 회귀 테스트(동적)** — finding도 *해소 검증*에선 forward 검증법을 상속한다.

### 3.1 검증법 — 재실행 가능성이 강도를 가른다
oracle의 강도는 RED 테스트냐 아니냐가 아니라 **"재실행 가능한 평가자가 있나"**로 갈린다(dialectic O4: 실행 테스트로만 보면 floor가 *테스트 가능한 것*으로 축소). 그래서 검증법은 3부류다:

| 부류 | 검증법 | 재평가 | 무엇을 판정 | 예 |
|---|---|---|---|---|
| **hard · 동적** | 테스트 (RED test) | **실행** | 런타임 행동 | "로그인하면 대시보드가 보인다" → Playwright 테스트 |
| **hard · 정적** | 정적 분석/스캔 (CodeQL·grep·AST; *file:line 앵커*) | **재스캔** | 코드 구조/속성 | "하드코딩 시크릿 없음"·taint 없음·dead code 없음 → 스캐너 재실행 |
| **soft · 판단** | review / user-decision | 사람 | 순수 판단 | "이 화면이면 됐다"·UX 느낌 (`stop.ts:624-627` 의도적 양보 — goal-wording judgment를 human/LLM에 위임) |

(보조: **escape-feedback** — 하류 실패가 거꾸로 "안 됐었다"를 판정. AC 수렴 oracle이 아니라 *놓친 것*을 잡는 회고 루프(§5).)

**원칙**:
- **변경을 드라이브하는 AC → hard(동적 또는 정적).** 둘 다 최종 상태에 *재평가*(테스트는 실행, 정적은 재스캔)라 **position-독립** — 얼린 코드-포인터(raw `file:line`/symbol/content)는 변경에 부서지므로 forward AC oracle로 금지(§3.0 raise/resolution).
- **soft = *순수 판단*만.** "테스트 불가 = soft"가 아니라 **"재실행 평가자 없음 = soft"**. 대부분 AC는 동적 *또는 정적*으로 hard하게 잡힌다(직관: 대부분 코드는 테스트/스캔 가능). soft는 약한 리뷰어가 고무도장 찍어 새므로(§1 역설) *최소화*.
- **`file:line` ≠ soft.** 그것은 *정적 부류의 앵커*다 — 강도는 앵커 형태가 아니라 "재실행 평가자(테스트/스캐너)가 있나"로 갈린다. file:line + 정적 속성 → 재스캔(hard); file:line + 순수 판단("이름이 나쁘다") → 재리뷰(soft).
- 각 AC는 최소 1개 검증법에 연결돼야 design 노드를 닫을 수 있다.

### 3.2 메커니즘 부착 지점 (①매치 ②전달 ③판정)
AC↔oracle은 코드의 한 곳이 아니라 **세 지점**에 붙는다 — ①에서 *매치*하고, ②에서 *전달*하고, ③에서 그걸로 *판정*한다. (이전 초안의 "농축 지점"은 ②만 가리켜 오해를 줬다.)

| 단계 | 무엇을 하나 | 어디서 (file:line) |
|---|---|---|
| **① 매치 (등록)** | 각 AC에 검증법(oracle)을 배정 → plan 미리보기로 노출 | `design` 노드 (`src/core/autopilot-loop.ts:944-985`, 기존 plan-stage 기록기) |
| **② 전달** | 그 oracle을 구현자 packet에 실음 | `buildDelegationPacket` (`src/core/autopilot-dispatch.ts:108-144`) |
| **③ 판정** | 완료를 "AC마다 oracle 충족"으로 가름 | `gates.ts` completion 계열 |

**① 매치** — `design` 노드는 이미 plan 단계의 *유일한 증거 기록기*다(dialectic O1: 그래서 여기서 하고, 밖으로 분리하지 않는다). 모든 AC를 들고 plan을 만들 때 **각 AC에 검증법(§3.1: 동적/정적/soft 중 하나)을 배정**하고, 그 AC↔oracle 지도를 plan 미리보기 뷰로 사용자에게 보인다. (현재는 coverage sweep·plan_brief만 만들고 AC별 oracle 등록은 안 함 — 이게 메우려는 갭.)

**② 전달** — *packet*은 autopilot이 한 노드를 서브에이전트에게 위임할 때 넘기는 **격리된 지시 묶음**이다(glossary "context packet": goal·acceptance·files·output contract로 구성). 지금 이 packet은 AC를 **id 문자열만** 담는다 (`done_when = "...satisfied with evidence: ac-1, ac-2"`, `autopilot-dispatch.ts:110-111`) → 구현자는 `"ac-2"`만 받고 AC 문장·oracle은 못 받는다(= 의도 손실). **전달 = packet에 AC 문장 텍스트 + 연결된 oracle을 추가**해, 구현자가 *"무엇을 · 무엇으로 판정되는지"*를 함께 받게 한다.

**③ 판정** — 완료 게이트가 지금의 구조적 *증거-유무*(`src/core/gates.ts` completion 계열)를 **"AC마다 배정된 oracle이 충족됨"**으로 강화한다. *id가 닫혔다*가 아니라 *그 AC의 검증법이 통과*해야 닫힌다.

---

## 4. AC→oracle 변환기 적대 검증 (ac-3)

RED-test-as-currency는 honor-system을 *변환기*로 옮길 뿐이다(dialectic O2; Producer도 자인). 그래서 변환기 자체를 적대적으로 검증한다 = anti-SLOP(ADR-0023:40)의 이 WI 버전.

- **불일치 검출 (forward AC oracle)**: 배정된 검증법이 AC를 실제로 판별하는지 — 가짜/tautological oracle(코드만 있으면 늘 참인 테스트, AC와 무관한 정적 규칙)을 주입했을 때 변환기가 **불일치로 거부**해야 한다.
- **oracle frozen**: forward AC의 oracle(테스트·정적 규칙)은 *얼린다* — 구현자가 통과시키려고 *oracle을 수정*하면 tautology가 부활한다(§4의 그것). 구현은 코드만 바꾸고 oracle은 못 건드린다.
- **실재 검사 (backward finding 전용)**: `maps_to`가 file:line인 *발견*은 그 닻이 *지금* 존재하는지 검사(현재 `stop.ts:88`은 미검사). forward AC엔 적용 안 됨 — 거긴 위 "불일치 검출"이 본다. (raw line이 아니라 정적 재스캔으로 재평가; 변경 후 위치는 §3.0대로 부서짐.)
- **refute-by-default**: 위험/oracle은 독립 검증을 통과해야 유효로 카운트(dialectic Opponent 재사용 가능).

---

## 5. 회고 측정 (ac-4) — 두 지표, 분리 유지

회고 = 측정 위에서 반성하고 메모리에 흡수하는 단계. **두 지표를 분리**해 둔다(섞으면 "과정이 쌌다 ⇒ 결과가 좋다"는 오류).

### ① 산출물 floor 지표 — "결과가 좋은가"
- AC가 허용 oracle로 닫힌 비율 + unit-only-closure 패널티 + escape 미발생 — 끝에서 재는 floor 숫자. 재료: `src/core/completion-coverage-doctor.ts`(증거-종결 비율·`isUnitOnlyClosure` = 런타임 증거 없이 단위테스트로만 종결), coverage escape ledger(`src/core/coverage-feedback.ts`). (advisory인 `isUnitOnlyClosure`를 지표로 승격.)
- **메타 원칙 — 지표 자체도 anti-SLOP**: floor 지표는 *재평가 가능·근거 있는 데이터*만 카운트한다. 근거 불명확한 수치는 floor를 올리는 게 아니라 노이즈를 주입하므로 **넣지 않는다** (oracle의 "근거 없으면 taste"를 측정에도).
- **구조 건강("코드가 더 나아졌나")은 floor sub-축에 넣지 않는다 (의도적).** floor 지표에 그 칸을 두면 *슬롯 존재 자체가 유도 편향* — 에이전트가 없는 개선을 만들어내거나(SLOP) 불필요한 리팩터를 부른다(charter §4-4; far-field confabulation과 같은 메커니즘). 코드 건강은 별도 standalone 채널(`ditto fitness`/ACG · Tidy First ADR-0017)에서 *독립적으로* 측정·소비하고, 이 per-WI floor와 섞지 않는다(중복 구축 금지 = wi_260615lj6).

### ② 과정 건강도 지표 — "거기 도달한 경로가 건강했나"
- 재료: `src/core/intent-quality-doctor.ts`의 `post_cost = drift + rework + retry-switch + handoff` + coverage 비용·라운드·루프 반복 수.
- 정의: 그 과정 비용/분산. **약한 기획자 효과가 먼저 보이는 창** — 결과가 버텨도 과정에서 rework/drift가 폭증한다.
- 경계: 기존 `intent-quality`는 tech-spec 가치 신호를 `post_cost`에 *접지 않고* additive로 둔다 — 이 분리를 유지. 인프라 중복 구축 금지(= **wi_260608acp** 영역, 흡수/조율만).

### ③ 회고 서술 — 근거 있는 기록의 *투영*만 (생성 아님)
①②(숫자) 외에 회고는 다음을 **기존 기록에서 투영**해 남긴다 — **자유 생성 아님, 근거 없으면 제외**:
- 검증 후 **남은 이슈** ← `unverified` AC · coverage `residual` · 미해소 acg-review finding
- **왜 미해소** ← `close_reason` / residual 정당화 (정당화-close 게이트, ADR-0023 — 이미 강제)
- 구현 중 **계획 변경 + 이유** ← intent-drift 이벤트 · 결정 로그 · 노드 supersession

재사용: `ditto:retrospective`(decisions log·evidence에서 도출). **"무엇을 배웠나" 같은 근거 없는 자유 reflection 슬롯은 만들지 않는다** — 슬롯이 곧 SLOP 생성(bias-by-mention). 회고는 *기록을 모으는 것*이지 *서술을 짜내는 것*이 아니다.

### 메모리 흡수 (cross-WI 피드백)
회고가 ①②③을 메모리에 흘려보낸다 → "이 WI 결과 → 다음 WI의 더 나은 의도". 이는 **cross-WI** 피드백(안전·기존 허용)이며 dialectic이 경계한 *WI 내부* intent⇄output 피드백(범위확장)이 아니다(O9).

---

## 6. 루프 규율 (ac-5) — 예산 한도 + wrong-fixpoint

ralph식 "모든 기준 충족까지 반복"은 종료 규율 없이는 자멸한다(dialectic O5: ~35k tok/카테고리, 소변경 2-3M; ADR-0023:56 "비싸서 끄면 floor 0").

- **수렴 통화는 oracle 충족(실행 가능)** — LLM의 `verdict: pass`가 아니라 oracle이 닫혔는지로 루프를 종료. (LLM-verdict 종료는 환각을 루프 안에 들임.)
- **예산 한도**: 루프마다 토큰/라운드 cap. cap 도달 = `cap ≠ converged`(ADR-0023 기존 불변) → 멈추고 escalate, 성공 아님.
- **wrong-fixpoint 처리**: oracle이 닫혔는데도 변환기 적대 검증(§4)이 불일치를 내면 "그럴듯한 가짜 수렴"으로 보고 재open. 동일 oracle 반복 실패 K회 → blocked로 사용자 결정 요청.

---

## 7. 의사결정 투명성 (ac-6) — 횡단 원칙

> **모든 의사결정은 투명해야 한다 — 사용자 확인 OR 문서 OR 계약에 기록. 조용한 결정 금지.**
> (볼 수 없는 결정은 검토할 수 없으니 floor가 샌다. charter §4-10의 일반화.)

적용 지점 매트릭스:

| 결정 | 어디에 남나 |
|---|---|
| 게이트 판정(readiness·완료·완료증거) | 계약(intent.json·completion contract) + 회고 측정 |
| AC↔oracle 배정 | 문서(plan 미리보기 뷰) + 사용자 승인 |
| far-field 카테고리 skip/route | 계약(coverage ledger의 close_reason, 기존 fail-closed) + 문서(plan-dialog) |
| 루프 종료/예산-cap | 계약(coverage/completion) + 회고 |
| ADR 충돌(예: ADR-0023) | 문서(ADR) + 출력 공개(charter §4-10) |

원칙: 어떤 결정도 셋(확인/문서/계약) 중 최소 하나에 흔적을 남기지 않고 통과하지 못한다.

---

## 8. 경계 & 의존 (out-of-scope / unknowns)

**oracle 원칙 (이번 설계 심화로 정착 — §3 전반에 적용)**
- oracle = *기계가 재평가 가능한* 의도된 행동/속성의 진술. 자연어 설명·얼린 코드-위치는 그 자체로 oracle이 아니다("누가 판정?"이 남으면 honor-system).
- **forward AC** = 동적 테스트(행동) 또는 정적 분석(구조). **backward finding** = `file:line`/`maps_to` 앵커(현재 코드 증거). 둘은 *시점이 다르다*(raise=현재, AC=구현 후).
- 강도는 "재실행 평가자 유무"로 갈린다 — 동적/정적 = hard, 순수 판단 = soft. **`file:line`은 soft가 아니라 정적 부류의 앵커.**
- 코드-포인터(file:line/symbol/content)는 *변경되는 대상*의 forward oracle로 부적합(raise≠resolution 드리프트). finding 해소는 detector 재실행/회귀 테스트로.

**Out of scope**
- 코드 구현(후속 WI). plan을 autopilot 밖 단계로 분리(O1 기각). "executable-test 유일 화폐 / 자동>리뷰 일반원칙 / 보장(반례 0)" 주장. WI 내부 intent⇄output 피드백.
- far-field 자동 sweep 비용 재측정 = **wi_26062227h**.
- AC 관측성 게이트 구현(상류 의존, `tech-spec.ts:204-235`는 형태만 검사) — 명시적 경계.
- 과정측정 인프라 중복 구축 = **wi_260608acp** 영역.
- ACG fitness/구조 건강 = **wi_260615lj6** 영역 — 별도 standalone 채널, **floor sub-축으로 안 넣음**(§5 ①: 슬롯=유도 편향).

**Unknowns (설계 중 해소)**
- AC 관측성 게이트의 소유 WI/시점.
- 과정 건강도 측정 ↔ wi_260608acp 경계/흡수 방식.
- plan 미리보기 뷰 구체 UX(어디서 멈추고 무엇을 보여주나).
- 정적 검증법이 의존하는 분석기(CodeQL 등) 부재 시 강등 경로(ADR-0018 옵셔널 도구 불변식).

---

## 9. dialectic 결론 (→ ADR-0024에 정식 기록)

- verdict = **revise**. 진단(depth/validity honor-system + 의도 손실)은 main에서 검증돼 살아남음. 4단계 *분리* 프레임은 기각.
- 살아남은 admissible 반론: O1(분리 금지·critical), O2(변환기 honor-system), O3(spec-fidelity 과대주장), O4(테스트가 floor 축소), O5(루프 비용/자멸), O6(게이트는 소비자 — 산출물 생산이 핵심), O9(내부 피드백 범위확장), O12(출력 지표 부재).
- 기각된 주장(진단 아님): "4단계", "자동>리뷰 일반원칙", "일방향 폭포수".
- → ADR-0024가 ADR-0023 관계(제자리 강화·far-field manual·분리 거부 근거)와 위 결론을 기록.
