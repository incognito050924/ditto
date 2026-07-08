# prism 수렴-품질 개선을 위한 철학적/인식론적 접근 — 연구 보고서

**성격**: 조사 보고서 (연구 산출물). 권위는 코드(`src/core/prism/*`)와 아래 인용 출처.
**대상 문제**: [`reports/design/prism-convergence-quality-gaps.md`](../design/prism-convergence-quality-gaps.md) 의 prism 3갭.
**방법**: deep-research 하네스(5각 병렬 검색 → 22소스 fetch → 87클레임 추출 → 상위 25클레임 3표 적대적 검증 → 22 confirmed/3 refuted 합성). WI `wi_260708qcn`.
**작성**: 2026-07-08.

---

## 0. 한 줄 결론

**어느 한 방법도 단독 승자가 아니다 — 상보적 소(小)-portfolio를 쓴다.** 변증법은 *조기-종결*의 최선-증거 지렛대지만 **비싼 full Dialectical Inquiry가 아니라 싼 비판(Devil's Advocacy)**이 증거-비례. Argumentation 이론이 진단과 수정을 동시에 준다: **structural resolution ≠ soundness**, 그래서 얕게 닫은 노드는 `resolved`가 아니라 **`unevaluated`**로 찍혀야 한다. Bayesian **Value-of-Information/optimal stopping**이 prism이 없는 *원리적 종결 기준*을 준다("한 질문 더"가 닫기보다 값질 때만 계속). 사회 인식론이 *앵커 드리프트*를 **집합적 조기수렴(groupthink)**으로 진단하고 **독립 관점 보존**을 처방한다.
**그리고 결정적으로 — prism은 이미 `dialectic` 스킬(Producer/Opponent/Synthesizer)과 Codex opponent를 가진다. 신규 구축이 아니라 배선이 빠진 것뿐이다.**

---

## 1. 문제 재확인 — 수렴-품질 가드의 비대칭

prism은 **과잉-사고(divergence)를 결정적으로 막지만**(`detectDivergence` engine.ts:281 + cap engine.ts/coverage-manager) **과소-사고(premature convergence)엔 무방비**다. 3갭: ①조기-종결 ②앵커 드리프트 ③완전성 미검. 이 보고서는 각 갭에 어떤 철학적 개념을 어디에 배선할지 답한다.

---

## 2. Q1 — 변증법적 방법: 도입하면 나아지나? (부분적으로, 단 싼 쪽)

**결론: 구조화된 비판/강제 반대입장이 무구조 합의를 이긴다는 건 실험으로 확립됐다. 그러나 "완전한 antithesis(counter-plan)"가 "비판만"보다 낫다는 증거는 없다 — 특히 요구사항 정련 같은 ill-structured 과제에서.**

- Schweiger, Sandberg & Ragan (1986, *AMJ* 29:51-71) 통제 실험: Dialectical Inquiry(DI)와 Devil's Advocacy(DA) **둘 다** 합의(consensus)보다 **결정 품질·가정 품질** 모두 높음. DI는 *가정 표면화*에서 DA를 추가로 앞섬(완전 반대입장이 더 깊은 가정을 드러냄). [3-0 검증] <https://journals.aom.org/doi/10.5465/255859>
- 그러나 비용 구조가 다르다: DI는 **완전한 대안(counter-plan) 명세**를 요구하고, DA는 **비판만** 한다. Cosier(1981, *AMR* 6:643-648)는 가정-표면화 이득은 counter-plan 없이 DA만으로 얻을 수 있다고 논증. Schwenk 1990 메타분석(*OBHDP* 47): DA는 기준선을 이겼으나 **DI의 우월은 ill-structured 과제에서 입증 안 됨.** Schweiger & Finger(1984, *SMJ* 5:335-350): DI-vs-DA 비교는 equivocal, 제시-순서 편향에 교란됨. [3-0] <https://journals.aom.org/doi/10.5465/amr.1981.4285716> · <https://sms.onlinelibrary.wiley.com/doi/abs/10.1002/smj.4250050404>
- Churchman의 inquiring systems(특히 Hegelian/dialectical inquirer)와 Mitroff & Emshoff(1979)의 dialectical methodology는 "messy/ill-structured 문제에서 conflict·가정 표면화·가정 도전이 건전한 문제 처리의 *구성적* 메커니즘"이라는 이론적 토대를 준다.
- **정직**: "완전 antithesis가 더 많은 가정을 드러낸다"는 단일-연구(Schweiger 1986) 결과. "DA가 전문가 기준선을 일반적으로 이긴다"는 메타분석 주장은 **검증에서 기각(1-2)**. 요구사항 정련은 ill-structured 과제 — 바로 DI의 추가 비용이 미입증인 영역.

→ **prism 적용**: critical/net-new 노드 close 게이트에 **강제 비판 1회**. full counter-plan 아님. → 갭①. (§7 매핑)

---

## 3. Q2 — 인식론의 문제-구조화: 정의·확장에 적합한가? (그렇다, 그리고 진단·수정을 함께 준다)

**결론: 인식론은 서술적이기만 한 게 아니다 — 문제를 *정의하고* 해를 *탐색*하는 형식적 문제-구조화 방법으로 operationalize돼 있고, 그중 argumentation 이론이 prism의 조기-종결을 정확히 진단하고 고친다.**

- **IBIS**(Issue-Based Information System, Kunz & Rittel 1970): Issue(질문)→Position(답)→Argument(지지/반박) 그래프 — **prism 이슈맵이 닮은 바로 그 구조.** "wicked problems"(Rittel & Webber)의 반-구조화 방법. [secondary] <https://en.wikipedia.org/wiki/Issue-based_information_system> · <https://en.wikipedia.org/wiki/Wicked_problem>
- **핵심 발견 — Toulmin/Verheij의 3값 상태**: Verheij(2005, *Argumentation* 19:347-371)는 Toulmin 도식이 *구조*는 명세하나 *타당성(validity)의 유비물이 없다*고 지적 — **구조적 완결 ≠ 건전성**, prism 진단과 정확히 일치(이슈맵이 구조적으론 'resolved'여도 수렴-품질 가드가 없다). 그의 dialectical 해석은 모든 진술에 3상태를 부여: **justified**(실제 정당화 이유 있음)·**defeated**(반박 이유 있음)·**unevaluated**(둘 다 없음). Dung의 abstract argumentation의 in/out/**undecided**가 직접 유비. [3-0] <https://link.springer.com/article/10.1007/s10503-005-4421-z>
- Soft Systems Methodology(Checkland)도 문제-구조화 계열이나 prism엔 argumentation이 더 직접적.
- **정직**: "강제 rebuttal이 justified를 not-justified로 뒤집는다"는 *메커니즘* 주장은 **기각(1-2)**. 그래서 권고는 "rebuttal이 기계적으로 판정을 뒤집는다"가 아니라 **3상태 게이트**(정당화 이유 없이 닫힌 노드 = unevaluated).

→ **prism 적용**: 노드 상태에 **`unevaluated` 3값** 추가 + close에 **justifying-reason 필드** 요구(필드 유무 = 결정적, 이유의 진짜 정당성 판정 = 모델). → 갭①. (§7)

---

## 4. Q3 — 베이즈주의 인식론: 원리적 종결 기준 (그렇다 — VoI/optimal stopping)

**결론: "한 질문 더가 값진가?"에 원리적 답이 있다 — 기대 정보이득 대 비용. prism이 없는 종결/완전성 기준을 정확히 준다. 단, 노드별 불확실성·비용의 정량화가 선결.**

- Lindley(1956, *Annals of Math. Statistics* 27:986-1005): **기대 정보이득**(prior→posterior 엔트로피 감소 기대)을 지식-획득 실험의 설계 기준으로 정식화. 추가 질문이 얼마나 값진지의 정량 근거. [3-0] (권위 원본은 Project Euclid; 인덱스 <https://scispace.com/papers/on-a-measure-of-the-information-provided-by-an-experiment-4y5d2cgeca>)
- Cheng & Huan(2025, arXiv 2509.21734, *Optimal Stopping for Sequential Bayesian Experimental Design*): 추가 탐구는 비용 대비 정보가치가 체감 → **언제 멈추나가 좋은 설계에 내재.** 최적 규칙 = 즉시 종결 보상이 기대 계속가치 이상일 때 정지. [3-0] <https://arxiv.org/abs/2509.21734>
- 결정-분석 계열 Howard의 EVPI(Information Value Theory)도 "언제 더 캐는 게 무가치한가"의 정준 답.

→ **prism 적용**: (a) **종결 기준** — 한 질문 더의 기대이득 < 닫기 가치일 때만 종결(`criticalTermination` engine.ts:142). (b) **조기-종결 플래그** — 잔여 사후 불확실성 높은 노드는 닫기 불가. **모델-보조**(불확실성/비용 추정 필요, prism은 현재 확률 미보유) → 우선은 **결정적 프록시**(증거추가 0/이유 미달이면 닫기 차단). → 갭③(+①). (§7)

---

## 5. Q4 — 사회 인식론: 앵커 드리프트를 집합적 조기수렴으로 진단 (독립 관점 보존)

**결론: 앵커/프레임 lock-in은 개별적으로 훌륭한 탐구자들이 *합쳐졌기에* 조기수렴하는 현상 — groupthink. 처방은 독립·반대 관점의 보존.**

- Mayo-Wilson, Zollman & Danks(2011, *Philosophy of Science* 78:653-677): 개인 합리성과 집단 합리성 기준은 **논리적으로 독립** — 합리적 개인들이 비합리적 집단을 이룰 수 있다. 동반 형식 결과(2013, *Int. J. Game Theory* 42:695-723): 고립 성능과 집단 성능은 본질적으로 무관하고, **groupthink = 혼자면 최적으로 수렴하나 합쳐지면 틀린 결론에 조기수렴하는 전략.** [3-0] <https://www.cambridge.org/core/journals/philosophy-of-science/article/abs/independence-thesis-when-individual-and-social-epistemology-diverge/41FC5025B24630A79E355EA2082836AD> · <https://www.researchgate.net/publication/257337996_Wisdom_of_the_Crowds_vs_Groupthink_Learning_in_Groups_and_in_Isolation>
- Solomon(2006, *Southern J. Philosophy* 44 Suppl.:28-42): **독립 판단의 집계가 합의-토론이나 단일 전문가보다 나을 수 있다**; 반대의견의 가치는 그것이 촉발하는 토론이 아니라 **합의 형성에서 소실되는 고유 데이터**에 있다 — 앵커 드리프트(하이재킹된 sub-분석이 원 의도의 '데이터'를 조용히 버림)와 직결. 독립판단→정보공유→재-독립집계 프로토콜(Navajas et al. 2018, *Nature Human Behaviour*)이 설계 패턴. [3-0] <https://link.springer.com/chapter/10.1007/978-981-97-9222-1_9>
- 조건: Condorcet Jury Theorem — 집단 정확도 이득의 하중 조건은 **독립성**.
- **정직**: "타인 판단 공개가 정확도를 떨어뜨린다"는 *메커니즘* 주장은 **기각(1-2)**. 처방은 그 해악 입증이 아니라 **긍정적 독립-집계 증거**에 선다. 군중 결과는 대-N이라 user+agent(N=2) 전이는 개념적 유비.

→ **prism 적용**: sub-분석 후 **원 의도에서 독립 재도출** — 결정적 판(원 의도 재대면 체크포인트) + 모델 판(**Codex opponent** 재사용, 원 의도에서 2차 관점 재도출). → 갭②. (§7)

---

## 6. Q5 — 변증법 vs 인식론 + 그 외 접근 (상보적; Popper·pragmatism·double-loop)

**둘 중 하나가 아니다 — 다른 갭을 친다.** 변증법=조기종결(비판 게이트), 인식론(argumentation)=조기종결 진단·상태모델(unevaluated), 베이즈=완전성/종결 기준, 사회인식론=앵커드리프트. 추가로:

- **Popper 반증주의** — "확증이 아니라 반박을 구하라"의 close 게이트로 operationalize. Huang et al.(2025, arXiv 2502.09858 / ICML, "POPPER"): LLM 에이전트가 가설의 측정가능 함의에 대한 **반증 실험을 설계·실행**(Type-I 오류 순차 통제) — "seek refutation" 자동화의 작동 사례. [3-0, medium confidence — 단일 논문] <https://arxiv.org/abs/2502.09858>
- **Peirce/Dewey pragmatism·abduction** — 탐구를 doubt→settled belief로, 가설 생성(abduction)의 논리. prism 이슈맵의 "질문이 답을 낳고 답이 새 질문을 여는" 연쇄와 정합(이번 실증에서 관측됨). <https://plato.stanford.edu/entries/dewey/>
- **Argyris & Schön double-loop learning + ladder of inference** — single-loop(주어진 프레임 내 수정) vs double-loop(프레임 자체 재검). 앵커 드리프트는 정확히 프레임을 못 되짚는 single-loop 고착. <https://infed.org/dir/welcome/chris-argyris-theories-of-action-double-loop-learning-and-organizational-learning/>

---

## 7. prism 적용 매핑 — 갭 ↔ 개념 ↔ 코드 지점

| 갭 | 도입 개념 (출처) | 유형 | prism 코드 지점 |
|---|---|---|---|
| **① 조기-종결** | **3값 상태 justified/defeated/`unevaluated`** (Verheij 2005; Dung) — 정당화 이유 없이 닫힌 노드 = `unevaluated` | 결정적(상태·필드 유무) + 모델(이유의 진짜 정당성) | `src/schemas/prism.ts` 상태 enum 확장 + `closePrismNode`(engine.ts:90): `resolved`엔 justifying-reason 필드 필수 |
| **① 조기-종결** | **"refutation attempted" 게이트** (Popper; POPPER 2025; DA) — 닫기 전 최강 반박 시도·생존 | 결정적 shell(필드 요구) + 모델(반박 생성) | `closePrismNode`: critical 노드에 refutation-attempted 요구; 모델판 = 기존 **`dialectic-opponent` 에이전트 재사용** |
| **① 조기-종결** | **devil's-advocate 비판(≠ counter-plan)** (Schweiger 1986; Cosier 1981) — full DI는 과비용, 비판만으로 증거-비례 | 모델-보조(싼 쪽) | close 게이트 1회 비판 패스 = 기존 **`dialectic` 스킬 경량화 배선**(신규 아님) |
| **② 앵커 드리프트** | **독립 관점 재도출 + dissent 보존** (Solomon 2006; Mayo-Wilson 2011; groupthink 형식화) | 결정적(원의도 재대면) + 모델(2차 독립관점) | 인터뷰 루프 — `detectDivergence`(engine.ts:281)의 *형제* under-think 가드: sub-분석 후 "원 의도 복귀" 체크포인트; 모델판 = **Codex opponent 재사용**(far-field가 이미 씀) |
| **③ 완전성** | **원-의도 span 매핑 종결 체크** — 해소 노드를 원 의도 조각에 역매핑, 미커버 = 미해소 노드 seed | 결정적(매핑 유무) + 모델(의미 커버) | `criticalTermination`(engine.ts:142): 종결술어에 원의도 커버리지 추가 |
| **③ 완전성** | **VoI/EIG 종결 기준** (Lindley 1956; Cheng & Huan 2025) — 한 질문 더 기대이득 < 닫기 가치일 때만 종결 | 모델-보조(불확실성·비용 추정) | `criticalTermination` + close; prism 확률 미보유 → 결정적 프록시(증거추가 0=차단) 먼저 |

---

## 8. 우선순위 권고 (최소증분: 결정적 먼저 → 모델-보조는 shell이 발동할 때만)

**A. 결정적 (모델 호출 0, 먼저):**
1. **완전성 종결 체크(갭③)** — 해소 노드를 원 의도 span에 역매핑, 미커버 조각을 미해소 노드로 seed. `criticalTermination`에 추가.
2. **조기-종결 shell(갭①)** — critical 노드 close에 **justifying-reason 필드 + refutation-attempted 필드** 요구, 둘 중 빠지면 `unevaluated`(닫힘 아님). + 트리비얼 프록시(증거추가 0이면 차단). `closePrismNode` + `schemas/prism.ts`. *기존 residual_risk 게이트와 동형 — 대칭 완성.*
3. **앵커 드리프트 체크포인트(갭②)** — sub-분석 후 원 의도 원문 재대면(§ 이번 실증에서 착수-알림 retract가 이미 유사 UX 보유).

**B. 모델-보조 (A의 shell이 발동한 노드에서만 — 비용 국소화):**
4. **devil's-advocate 비판 + Popper 반박**(갭①) — close 전 1회, 기존 `dialectic`/`dialectic-opponent` 재사용.
5. **독립 2차 관점**(갭②) — 원 의도에서 재도출, 기존 **Codex opponent** 재사용.
6. **VoI 판정**(갭③) — "한 질문 더 vs 닫기" 모델 추정, 노드 불확실성 정량화 후.

**핵심 minimal-increment 관측**: 4·5는 **신규 구축이 아니라 기존 ditto 자산(`dialectic` 스킬·`dialectic-opponent`·Codex opponent) 배선**이다. far-field가 이미 이 opponent 패턴을 refute에 쓴다 — 같은 자산을 prism close/termination 게이트에 연결하면 된다.

---

## 9. 정직한 한계 (검증에서 드러난 것)

**검증 통계**: 25 클레임 → 22 confirmed / 3 refuted / 0 unverified.

**기각된 클레임(투명성)**:
- "DA가 전문가 기준선을 일반적으로 이긴다"는 메타분석 주장 — **기각(1-2)**. 그래서 §2는 "비판이 합의를 이긴다"(확립)에만 기대고 이 일반 주장엔 안 기댄다.
- "강제 rebuttal이 justified↔not-justified를 기계적으로 뒤집는다" — **기각(1-2)**. §3 권고는 verdict-flip이 아니라 3상태 게이트.
- "타인 판단 공개가 정확도를 떨어뜨린다" — **기각(1-2)**. §5 처방은 이 해악이 아니라 긍정적 독립-집계 증거에 선다.

**전이 갭**: VoI·wisdom-of-crowds는 domain-general이나 user+agent(N=2) 전이는 개념적 유비(대-N 통계의 N=2 판본 없음). VoI 정지규칙은 노드별 불확실성·비용 정량화 후에만 작동 — prism은 현재 미보유. → **설계 패턴이지 plug-in 공식 아님.**

**단일-소스 메커니즘**: `unevaluated` 3값(Verheij 2005)과 자동 반증(POPPER/ICML 2025)은 각각 한 편에 크게 기댐 — 단, 밑바탕 원리(Toulmin/Dung; Popper)는 분야-표준.

**소스 접근**: AMJ·Solomon·ScienceDirect 일부 paywall/403 → 해당 클레임은 corroborated abstract + 독립 인덱스 기반(verbatim 아님). Lindley 원본은 Annals of Math. Statistics(Project Euclid)가 권위, 본문 URL은 인덱스.

**미해결 질문**: (1) 싼 DA 게이트가 prism의 'hard/net-new critical'에서 full 변증법만큼 잡나 — prism-특정 A/B 필요. (2) prism이 노드별 잔여 불확실성을 싸게 정량화 가능한가(결정적 프록시 vs LLM 크레던스). (3) N=2에서 앵커 드리프트를 막는 최소 '독립 관점'은(2차 에이전트 vs Codex opponent vs 원의도 재도출). (4) 완전성 '특징지음 vs 전달함' 구분이 결정적 체크로 되나 모델 판단 필수인가.

---

## 10. 출처

| # | 출처 | 등급 | 각 |
|---|---|---|---|
| 1 | Schweiger, Sandberg & Ragan 1986, AMJ 29 — <https://journals.aom.org/doi/10.5465/255859> | primary | 변증법 |
| 2 | Schwenk 1990 메타분석, OBHDP 47 — <https://www.sciencedirect.com/science/article/abs/pii/074959789090051A> | primary | 변증법 |
| 3 | Cosier 1981, AMR 6 — <https://journals.aom.org/doi/10.5465/amr.1981.4285716> | primary | 변증법 |
| 4 | Schweiger & Finger 1984, SMJ 5 — <https://sms.onlinelibrary.wiley.com/doi/abs/10.1002/smj.4250050404> | primary | 변증법 |
| 5 | Mitroff & Emshoff 1979, AMR — <https://journals.aom.org/doi/10.5465/amr.1979.4289165> | secondary | 변증법 |
| 6 | Lunenburg 2012, IJSAID (DA & DI 리뷰) — nationalforum.com PDF | secondary | 변증법 |
| 7 | Verheij 2005, Argumentation 19 (Toulmin 3값) — <https://link.springer.com/article/10.1007/s10503-005-4421-z> | primary | argumentation |
| 8 | IBIS — <https://en.wikipedia.org/wiki/Issue-based_information_system> | secondary | 문제구조화 |
| 9 | Wicked problem (Rittel & Webber) — <https://en.wikipedia.org/wiki/Wicked_problem> | secondary | 문제구조화 |
| 10 | Lindley 1956, Annals Math. Stat. 27 (EIG) — <https://scispace.com/papers/on-a-measure-of-the-information-provided-by-an-experiment-4y5d2cgeca> | primary | 베이즈 |
| 11 | Cheng & Huan 2025, arXiv 2509.21734 (optimal stopping) — <https://arxiv.org/abs/2509.21734> | primary | 베이즈 |
| 12 | Solomon 2006, S.J.Philosophy 44 (dissent) — <https://www.researchgate.net/publication/227910928> | primary | 사회인식론 |
| 13 | Mayo-Wilson, Zollman & Danks 2011, Phil.Sci 78 (independence thesis) — <https://www.cambridge.org/core/journals/philosophy-of-science/article/abs/independence-thesis-when-individual-and-social-epistemology-diverge/41FC5025B24630A79E355EA2082836AD> | primary | 사회인식론 |
| 14 | Mayo-Wilson et al. 2013, IJGT 42 (groupthink 형식화) — <https://www.researchgate.net/publication/257337996> | primary | 사회인식론 |
| 15 | Jorm 2025, Palgrave ch.9 (독립판단 프로토콜) — <https://link.springer.com/chapter/10.1007/978-981-97-9222-1_9> | primary | 사회인식론 |
| 16 | Stanford Encyclopedia — Social Epistemology — <https://plato.stanford.edu/entries/epistemology-social/> | secondary | 사회인식론 |
| 17 | 사회적 앵커링 증폭, J.Socio-Economics 55 (2015) — <https://ideas.repec.org/a/eee/soceco/v55y2015icp29-39.html> | primary | 사회인식론 |
| 18 | Huang et al. 2025, arXiv 2502.09858 / ICML (POPPER) — <https://arxiv.org/abs/2502.09858> | primary | 반증 |
| 19 | Argyris double-loop learning — <https://infed.org/dir/welcome/chris-argyris-theories-of-action-double-loop-learning-and-organizational-learning/> | secondary | double-loop |
| 20 | Stanford Encyclopedia — Dewey (pragmatism/inquiry) — <https://plato.stanford.edu/entries/dewey/> | primary | pragmatism |

*(합성 후 7 findings, 22 confirmed 클레임. deep-research 원 산출: `.ditto/` 세션 워크플로 저널; 요약은 이 문서에 직접 담음 — drift 방지.)*
