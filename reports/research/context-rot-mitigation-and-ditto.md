# Context rot 완화 기법과 DITTO 적용 — 연구보고서

- **작성일**: 2026-06-27
- **질문**: context rot(긴 컨텍스트에서의 성능 저하)을 막기 위해 컨텍스트 윈도우를 compaction(요약/압축)하는 것이 실제로 도움이 되는가? 다른 연구된 기법은 무엇이며, DITTO에 어떻게 적용하면 좋은가?
- **방법**: deep-research 워크플로 — 5개 검색 각도 fan-out → 20개 소스 fetch → 88개 주장 추출 → 25개 적대적 검증(2/3 반박이면 기각) → 종합. 24/25 확인, 1 기각.
- **이 문서의 성격**: 외부 연구 조사 보고서(일회성). DITTO 동작의 권위는 코드·헌장이며(헌장 §4-11), 아래 적용 절은 **제안**이지 결정이 아니다. 채택 시 ADR/코드로 흡수하고 이 문서는 폐기 대상.

---

## 0. 한 줄 결론

> compaction은 **도움이 되지만 그 자체로는 부족하다.** "긴 컨텍스트를 잘 요약하는 법"이 아니라 **"무엇을 컨텍스트에 두지 않을 것인가"**가 본질이다. compaction은 도구 중 하나일 뿐이고, 병목에 맞춰 clearing·offloading(외부 메모리)·sub-agent 격리·retrieval과 **조합**해야 한다. DITTO의 헌장 §4-9(위임)·handoff·memory graph·knowledge projection은 이미 이 방향과 정렬돼 있고, 연구는 그 설계를 **사후적으로 정당화**한다.

---

## 1. Context rot은 실재하는가 — 그렇다 (확신: 높음)

**현상.** 입력 컨텍스트 토큰 수가 늘수록 LLM의 정확도는 **비균일하게** 떨어진다. 단순한 작업에서도 그렇다. Chroma가 18개 frontier 모델(GPT-4.1, Claude 4, Gemini 2.5, Qwen3)을 통제 실험으로 측정한 결과: *"models do not use their context uniformly; instead, their performance grows increasingly unreliable as input length grows"* — 그리고 *"even on simple tasks."*
출처: [Chroma, Context Rot (2025)](https://www.trychroma.com/research/context-rot)

Anthropic은 이를 *"context rot"*으로 명명한다: *"as the number of tokens in the context window increases, the model's ability to accurately recall information from that context decreases."*
출처: [Anthropic, Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

> **핵심 함의**: 컨텍스트는 무료로 확장되는 자원이 아니라 **한계 효용이 체감하는 유한 자원**이다. 한도(예: 200K·1M)에 도달하기 한참 전부터, 점진적으로 저하가 시작된다. 이것은 "넘치면 터지는" 이진 실패가 아니다.

**메커니즘 (확신: 높음).** 주로 구조적이다.
- transformer는 n개 토큰에 대해 n² 쌍 관계를 만든다. *"As its context length increases, a model's ability to capture these pairwise relationships gets stretched thin"* — 유한한 **attention 예산**이 얇게 펴진다.
- 모델은 *"training data distributions where shorter sequences are typically more common"*에서 attention 패턴을 학습한다. 긴 시퀀스는 분포상 드물다.
출처: Anthropic(위 동일).

**Lost-in-the-middle / 위치 편향 (확신: 높음).** 입력의 **처음과 끝**에 있는 정보는 잘 쓰지만, **중간**에 있으면 활용도가 크게 떨어진다(U자 곡선). 명시적으로 long-context로 설계된 모델에서도 지속된다 — 즉 **윈도우를 늘린다고 그 전부를 쓴다는 보장이 없다.**
- Liu et al. (TACL 2023): *"performance is often highest when relevant information occurs at the beginning or end ... and significantly degrades when models must access relevant information in the middle ... even for explicitly long-context models."* — [arXiv:2307.03172](https://arxiv.org/abs/2307.03172)
- 위치 편향 스케일링: GPT-3.5-Turbo NaturalQuestions multi-doc QA에서 중간 vs 양끝 격차 **최대 22점**. — [arXiv:2406.02536](https://arxiv.org/html/2406.02536v2)
- 이 편향은 **내용 중요도와 무관한 위치 인공물(positional artifact)**이다. inference 시점 위치 편향 보정(calibration)만으로 RAG 정확도 **최대 15pp** 회복 — 내용이 아니라 위치 때문임을 입증. — [arXiv:2406.16008, "Found in the Middle"](https://arxiv.org/abs/2406.16008)

**검증에서 기각된 과장 1건**: "이 U자 attention 편향이 lost-in-the-middle의 **유일한** 메커니즘 원인"이라는 더 강한 주장은 0-3으로 기각됐다. 위치 편향은 **기여하는** 원인이지 단일 원인으로 입증되진 않았다.

> **DITTO 함의**: 헌장 §4-9가 전제하는 *"context rot — 한도 도달 전부터, 비균일하게"*와 *"쌓인 맥락이 prior로 작동"*은 외부 연구로 뒷받침된다. 특히 **중간 위치 저하**는, 긴 autopilot 로그나 긴 핸드오프 중간에 묻힌 결정·제약이 신뢰성 있게 회수되지 않을 수 있음을 뜻한다. → **중요한 것은 양끝(시스템 프롬프트 근처 / 최근)에 두거나, 아예 외부로 빼서 필요할 때 회수**해야 한다.

---

## 2. Compaction은 도움이 되는가 — 그렇다, 그러나 손실이 따른다 (확신: 높음)

**효과.** compaction은 거의 찬 윈도우를 **고충실도 요약**으로 압축해 새 윈도우로 재시작한다. Anthropic cookbook 측정: 토큰 피크 **335K→169K**, 고수준 사실 probe **3/3 보존**, 성능 저하 최소.
출처: [Anthropic cookbook, context engineering tools](https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools)

**손실 트레이드오프 (확신: 높음).** 같은 probe에서 **고수준 3/3 보존 vs 난해한 세부 0/3 보존**. 작업 중심 사실(핵심 수치·정체성)은 살지만, 부록 표의 한 셀·이질성 통계 같은 **축자(verbatim) 세부·obscure 사실은 사라진다.** 게다가 요약 모델을 돌리므로 **inference 비용**이 든다.
- 독립 비평(morphllm): compaction은 *"a treatment, not a prevention"* — 트리거 **이전에** 저지른 오류는 되돌리지 못한다.

**compaction ≠ tool-result clearing.**
- **clearing**: 도구 결과를 통째로 버린다. 내용은 재호출(re-fetch) 전까지 사라지지만 **무손실**(다시 가져올 수 있으므로)이고 기계적 편집이라 싸다.
- **compaction**: 실질을 압축 형태로 **유지**하지만 축자 세부를 잃고, 요약 비용이 든다.

**압축 품질이 크게 좌우한다 (확신: 높음).** 순진한(무지침) 요약은 정확도를 심하게 깎는다 — OfficeBench 관찰 압축에서 **76.84%→55.79% (~21점 하락)**. 반면 지침 최적화 압축(Acon)은 피크 토큰을 **26–54% 줄이면서** 작업 성능을 대체로 보존, 일부 과제에선 무압축 baseline을 넘기기까지. AppWorld 히스토리: 무압축 56.0% / FIFO 45.8% / LLMLingua 39.3% / 순진한 prompting 43.5% / **Acon 56.5%**.
출처: [Acon, arXiv:2510.00615 (2025-10, 비-peer-reviewed preprint)](https://arxiv.org/html/2510.00615v1)
*주의*: preprint이며 수치는 특정 method·benchmark에 한정, 보편 보장 아님.

> **DITTO 함의**:
> 1. **"무엇을 버릴지"가 art다.** DITTO가 handoff/요약을 만들 때, 재호출 가능한 것(파일 내용, 코드, 테스트 출력)은 **clearing/포인터**로, 재호출 불가능한 것(결정 이유, 의도, 합의)은 **compaction/외부화**로 다뤄야 한다. handoff는 이미 *"minimal context for another session"* 계약이라 정렬돼 있다.
> 2. **순진한 요약 금지.** "대충 줄여라"는 ~21점을 깎는다. handoff·context packet·completion contract처럼 **무엇을 보존해야 하는지 지침이 박힌 구조화된 압축**이 DITTO의 강점이다 — 이 연구가 그 설계를 정당화한다.
> 3. compaction은 **치료지 예방이 아니다.** 트리거 전 오류는 못 고친다 → DITTO의 fresh-context 검증(§4-9)이 보완한다: 자기 맥락 안에서 요약·검증하지 말고 **새 컨텍스트에서** 검증.

---

## 3. Compaction 외의 검증된 기법들

연구가 확인한 대안들. **단일 해법이 아니라 병목별 조합**이 핵심.

### 3-1. Context offloading / 외부 메모리 외부화 (확신: 높음)
정보를 윈도우 **밖** 영속 저장소로 빼서 세션을 넘어 살아남게 한다. Anthropic long-running-agents 블로그: **compaction만으로는 부족**하다 — *"even with compaction, which doesn't always pass perfectly clear instructions to the next agent."* 처방:
- `claude-progress.txt` — 에이전트가 한 일의 로그
- 구조화 JSON — end-to-end 기능 목록 + `passes` 필드(pass/fail 상태)
- 초기 git commit — 되돌아가 작동 상태로 복구
출처: [Anthropic, Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

### 3-2. Focused/retrieved context > full window (확신: 높음)
관련성 필터링된 **최소 프롬프트(~300 토큰)**가 같은 작업에서 **전체 긴 입력(~113K 토큰)**을 유의하게 능가(Chroma LongMemEval, 모든 모델). *"what matters more is how that information is presented."* → 윈도우를 최대로 채우지 말고 **engineer**하라. (단, 여기 "focused"는 oracle 관련성 필터링 = retrieval/offloading이지 손실 요약이 아님.)
출처: [Chroma](https://www.trychroma.com/research/context-rot)

### 3-3. Sub-agent context 격리 (확신: 중간)
상세 탐색 컨텍스트를 sub-agent의 **깨끗한 윈도우** 안에 격리하고, lead agent는 **종합만** 한다. *"The detailed search context remains isolated within sub-agents, while the lead agent focuses on synthesizing."*
출처: [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
*확신 중간인 이유*: 2-1 표결. 반례(arXiv 2604.02460): multi-agent 이득은 **추가 test-time compute로 교란**될 수 있고, **동일 토큰 예산**에선 단일 에이전트가 맞먹거나 능가할 수 있음 → "우월"은 과제·compute 의존적이지 보편이 아니다. 비판은 격리 논변을 **뒤집지 않고 한정**한다.

### 3-4. Attention sink (StreamingLLM) — 아키텍처 완화 (확신: 높음, 단 범위 한정)
표준 window attention은 초기 토큰이 KV 캐시에서 밀려나면 붕괴(Llama-2-13B perplexity 5158.07). 초기 **attention-sink 토큰 4개 + 최근 윈도우**를 유지하면 5.40으로 회복, fine-tuning 없이 **~4M 토큰**까지 안정.
출처: [StreamingLLM, arXiv:2309.17453 (ICLR 2024)](https://arxiv.org/html/2309.17453v3)
**범위 주의**: 이것은 **스트리밍 생성을 안정화**할 뿐, 사용 가능한 컨텍스트 창을 늘리거나 장거리 기억을 추가하지 **않는다.** DITTO 같은 애플리케이션 레이어에선 직접 통제 불가(모델 내부) — 배경 지식으로만 의미. lost-in-the-middle을 "고친다"기보다 붕괴를 막는 것.

---

## 4. 종합 — 병목에 기법을 맞춰라 (확신: 높음)

Anthropic cookbook의 멘탈 모델 (확인됨):

| 병목 | 기법 | 성격 |
|---|---|---|
| 재호출 가능한 도구 출력이 부풀림 | **clearing** | 싸고 무손실, 기계적 |
| 재호출 불가능한 대화·추론이 부풀림 | **compaction** | 압축 보존, 축자 손실 + inference 비용 |
| 세션을 넘는 영속이 필요 | **external memory(offloading)** | 윈도우 밖으로 이동, 세션 생존 |
| 상세 탐색이 메인을 오염 | **sub-agent 격리** | 깨끗한 윈도우에 격리, 결론만 반환 |
| 관련 정보만 필요 | **retrieval/focused** | 최대 채움 대신 선별 |

> *"start with the one that matches the bottleneck you're actually observing."* — 한 가지를 만능으로 쓰지 말고 **관측된 병목**에서 시작.

---

## 5. DITTO 적용 제안

DITTO는 이미 이 연구와 같은 방향에 서 있다. 헌장 §4-9가 *"context rot — 한도 도달 전부터, 비균일하게"*와 *"쌓인 맥락이 prior로 작동(자기 확신)"*을 명시하고, 이 둘을 다른 해법으로 구분한다. 아래는 연구 발견을 DITTO 기제에 매핑한 것 — **이미 정렬된 것 / 강화할 여지 / 새 제안**으로 나눈다.

### 5-A. 이미 정렬됨 (연구가 사후 정당화)
| 연구 발견 | DITTO 기제 | 근거 |
|---|---|---|
| sub-agent 격리, 결론만 반환 | autopilot owner subagent, §4-9 위임 | "중간 산출물은 subagent 컨텍스트에 격리, 반환은 결론·증거·불확실성만" |
| fresh context에서 검증 | §4-9 *"검증과 리뷰는 fresh context에서"*, reviewer/verifier 분리 | compaction이 "치료지 예방 아님"을 보완 — 트리거 전 오류는 새 맥락이 잡음 |
| external memory로 세션 넘기기 | handoff(`--local`/`--remote`), memory graph | compaction "만으로 부족" → 영속 산출물로 인계 |
| 위임 계약(목표·완료기준·반환형식) | completion contract, context packet | "의도는 대화 릴레이가 아니라 계약 산출물로 운반" |
| 권위는 코드, drift 문서 회피 | §4-11, knowledge projection | 요약본이 아니라 **재호출 가능한 SoT**(코드·테스트·ADR)를 가리킴 |

### 5-B. 강화할 여지 (코드/지침 점검 권장)
1. **handoff = 구조화 압축이지 순진한 요약이 아님을 보장.** 순진 요약은 ~21점을 깎는다(§2). handoff/요약 생성 프롬프트가 *"무엇을 보존하고 무엇을 버릴지"* 지침을 명시하는지 점검. 특히 **재호출 불가능한 것**(결정 이유·의도·기각된 대안·제약)은 보존 우선순위 최상, **재호출 가능한 것**(파일 내용·테스트 출력 전문)은 **포인터로 대체**(clearing 성격).
2. **clearing vs compaction 구분을 명시적으로.** 현재 DITTO 핸드오프/로그가 재호출 가능한 도구 출력을 **전문으로** 담고 있다면, 그건 compaction이 아니라 clearing 대상 — `file:line`·명령·아티팩트 경로로 포인터화하면 무손실로 줄어든다. (메모리 규칙도 *"drift할 문서를 경로로 가리키지 말고 원문 담되, 출처는 코드를 가리킨다"*와 정합 — 단 여기서 "원문 담기"는 결정/사실에, "포인터"는 재현 가능 산출물에 적용.)
3. **중요 정보의 위치.** lost-in-the-middle(§1) 때문에, 긴 autopilot 로그·핸드오프의 **중간**에 묻힌 제약·결정은 회수 신뢰성이 낮다. 핵심 제약(ADR 충돌, 비가역 위험, 미해결 질문)은 **문서 처음/끝** 또는 **별도 구조화 필드**로 끌어올려야 한다. handoff 템플릿이 이미 그런 구조(§ 헤더)를 갖는지 점검.
4. **memory graph = offloading의 정석.** 윈도우 밖 영속·provenance·freshness 그래프는 연구가 권하는 external memory의 강한 형태다. grep/explore 전에 그래프를 먼저 조회(`ditto memory-graph`)하는 것은 "full window 덤프 대신 focused/retrieved"(§3-2)와 정확히 일치 — 이 습관을 헌장/스킬에서 더 적극 권고할 여지.

### 5-C. 새로 고려할 것 (선택)
1. **"focused > full" 측정을 도그푸딩에 도입.** Chroma처럼 *관련성 필터링 컨텍스트가 full 덤프보다 낫다*는 가설을, DITTO researcher/reviewer가 **전체 파일 덤프 대신 grep+memory-graph 선별**을 했을 때의 결과 품질로 측정(메모리의 `measurements/` 패턴 활용).
2. **long-running agent 3종 세트와의 정합 점검.** Anthropic이 권한 (a)progress 로그 (b)`passes` 필드 구조화 상태 (c)초기 commit/revert는 DITTO에 각각 (a)autopilot decisions 로그 (b)work-item.json acceptance verdict (c)land-commit + git revert로 **이미 존재**한다. 단 (b)의 pass/fail이 신뢰성 있게 전파되는지는 별개 점검 대상 — 메모리에 기록된 *completion→work-item AC verdict 미러 갭(wi_260627273)*이 **유사 구조의 사례**다. (주의: 이 미러 갭은 **결정적 데이터 배선 결함**이지, LLM 요약이 지시 충실도를 잃는 context-rot 현상 자체가 아니다 — 둘을 등가로 보면 안 된다. 연구 권고는 "pass/fail 같은 핵심 상태를 윈도우 밖 구조화 산출물로 외부화하라"는 *방향*이고, 그 방향과 **정합하는 점검 대상**으로 이 갭을 든 것이다.)

---

## 6. 미해결 질문 (연구가 답하지 못한 것)
1. **동일 토큰 예산** 정규화 시 sub-agent 격리가 실제로 단일 잘 관리된 컨텍스트를 언제 이기나? 어떤 과제군에서 이득이 사라지나? (§3-3 2-1 표결의 근원)
2. Acon류 지침 최적화 압축의 26–54% 이득이 테스트 밖 benchmark·모델로 일반화되나? retrieval/offloading과 동일 long-horizon 과제에서 head-to-head는?
3. compaction·clearing·retrieval·external memory를 **한 long-running 에이전트 안에서** 어떻게 조합(순서·트리거·무엇을 영속/요약/버릴지)? 임계값에 대한 실증 지침이 있나?
4. attention-sink/위치 보정(StreamingLLM, Found-in-the-Middle)이 **에이전트 과제 정확도**(중간 위치 정보)를 실제로 개선하나, 아니면 스트리밍 perplexity만 안정화하나?

---

## 7. 검증 메타데이터 / 한계
- **검증 강도**: 25개 핵심 주장 적대적 3표결(2/3 반박이면 기각), 24 확인 1 기각.
- **출처 편향 주의**:
  - Chroma는 vector-DB 벤더로 **retrieval 동기 이해상충** — 단 연구는 투명·재현 가능.
  - Anthropic compaction 손실 수치(3/3 vs 0/3)는 튜토리얼 내 **n=1 예시 probe**, *"usually"*로 정직하게 한정됨.
  - "Anthropic 권장"은 Anthropic 자사 블로그가 1차 출처 — *"무엇을 권하는가"*엔 적절하나 독립 평가는 아님.
- **시간 민감성**: 빠르게 변하는 분야. Acon(2025-10)은 비-peer-reviewed preprint.
- **프레이밍 뉘앙스**: Chroma는 단조 감소를, U자(양끝 회복)는 Liu et al. 셋업에서 관측 — 위치 편향 자체는 강건하나 곡선 모양은 셋업 의존.

---

## 출처 (1차 우선)
1. [Chroma — Context Rot (2025)](https://www.trychroma.com/research/context-rot) — primary
2. [Liu et al. — Lost in the Middle, TACL 2023, arXiv:2307.03172](https://arxiv.org/abs/2307.03172) — primary
3. [Found in the Middle, ACL Findings 2024, arXiv:2406.16008](https://arxiv.org/abs/2406.16008) — primary
4. [위치 편향 스케일링, arXiv:2406.02536](https://arxiv.org/html/2406.02536v2) — primary
5. [StreamingLLM, ICLR 2024, arXiv:2309.17453](https://arxiv.org/html/2309.17453v3) — primary
6. [Acon — 압축 최적화, arXiv:2510.00615 (2025-10)](https://arxiv.org/html/2510.00615v1) — primary(preprint)
7. [Anthropic — Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) — primary
8. [Anthropic — Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) — primary
9. [Anthropic cookbook — context engineering tools](https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools) — primary
10. (blog/secondary) morphllm, langchain, arize, aipatternbook — 보조 정황
