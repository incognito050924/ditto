# deep-interview — 착수 전 의도 모호성을 소크라테스식 질문 + pre-mortem으로 해소해 검증가능한 intent로 잠그는 상태기계

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준 커밋: `c2d2e16` (2026-07-19). 확인 범위는 아래 §2의 파일 목록이며, 오케스트레이션 루프(SKILL) 부분은 `skills/deep-interview/SKILL.md`를 서브에이전트가 읽어 요약한 것으로 라인 인용을 함께 표시한다.

---

## 1. 이 기능이 실현하려는 설계 의도 (개념)

### 무엇을 푸는가
코드 변경에 착수하기 전, 요청의 **의도가 모호하면** 그 모호성을 구조적으로 해소해 **검증 가능한 intent(acceptance criteria 포함)**로 잠근다. 잠긴 intent는 그대로 `intent.json`이 되고 곧바로 autopilot 노드 그래프로 부트스트랩된다(interview-driver.ts:44-55, :833-848). 즉 deep-interview는 "무엇을 만들 것인가"를 확정하는 **의도 축(축1)의 종료 게이트**다.

이 커맨드가 존재하는 이유는 DITTO 프로젝트 CLAUDE.md의 기본 루프(의도 파악 → 성공 기준 정리)를 사람이 대충 넘기지 못하도록 **기계로 강제**하는 데 있다. skill 설명(SKILL.md의 트리거)에 따르면 acceptance criteria를 쓸 수 없거나, 요청이 제품/도메인 의미에 의존하거나, 실질적으로 다른 구현이 둘 이상이거나, pre-mortem이 되돌리기 어려운 위험을 드러낼 때 쓴다.

### 4축 중 위치
DITTO 기능 4축(의도 / 오케스트레이션 / E2E / 지식) 중 **의도 축(intent)**에 속한다. 근거: finalize가 `intent.json`을 쓰고 work item의 acceptance_criteria를 미러링한 뒤 `bootstrapAutopilot`을 호출해 오케스트레이션 축으로 넘긴다(interview-driver.ts:723-848). 자기 스스로 코드를 바꾸지 않고, "무엇을 할지"만 확정한다.

### 두 개의 겹친 게이트 개념
- **1차(시스템 준비) 게이트**: readiness — 핵심 dimension이 모두 resolved이고 모호성 하한을 적용한 준비도 점수가 임계값 이상 (gates.ts:95-112).
- **2차(사용자 확인) 게이트**: 사용자가 자기 말로 확정. 둘의 AND여야 finalize가 아티팩트를 쓴다 (interview-driver.ts:732-741, interview-state.ts:363-387).

이 이중 게이트가 이 기능의 골격이다: 기계가 "준비됐다"고 판단해도 사용자 확인이 없으면 잠기지 않는다.

---

## 2. 코드 위치와 진입점

| 파일 | 역할 |
|---|---|
| `src/cli/commands/deep-interview.ts` | CLI 진입점. 16개 서브커맨드를 `citty`로 정의, JSON 페이로드 검증 후 driver 호출 |
| `src/core/interview-driver.ts` | 상태기계 본체. start/record-turn/readiness/finalize + branch-walking·dissent·premortem·semantic critic reducer |
| `src/core/interview-store.ts` | `interview-state.json`의 스키마검증 원자적 read/write (단일 소유 경로) |
| `src/core/interview-dissent.ts` | intent-layer 반론자(opponent) seam: 브리프 생성 + engage + 스티키 병합(mergeDissent) |
| `src/core/question-context.ts` | 표시계약 게이트(순수 검증기): user_explanation/recommended_answer 존재, 내부 식별자 누출 탐지, 표시정규화, single-fire, branch 연속성 정렬 |
| `src/core/question-round.ts` | 질문 라운드 점수의 durable sink(`question-rounds.jsonl`) + prism용 표시계약 검증 |
| `src/core/opponent-router.ts` | opponent 후보 순서 결정(순수 정책) — 실제 호출은 host 위임 |
| `src/schemas/interview-state.ts` | `interview-state.json`의 zod 스키마(SoT, ADR-0002) |
| `src/schemas/question-round.ts` | 질문 라운드/점수 스키마 |
| `src/schemas/question-gate.ts` | pre-ask 게이트 + self-answer attempt 스키마 |
| `skills/deep-interview/SKILL.md` | 오케스트레이션 루프. CLI seam들을 순서대로 구동하는 에이전트 절차 |

### 서브커맨드
(모두 `--work-item <wi_*>` 필수, `--output human|json`. 인용: deep-interview.ts의 각 defineCommand)

| 서브커맨드 | 하는 일 | 추가 인자 |
|---|---|---|
| `start` | `interview-state.json` 초기화, user-intent 카테고리를 dimension으로 seed | `--threshold`(0.7) `--question-cap`(8) `--generators`(1) |
| `record-turn` | 한 턴 기록(dimension upsert + question + optional answer). 표시계약 하드게이트가 여기서 발동 | `--json`(recordTurnPayload) |
| `check-question` | 질문 후보를 표시계약에 대해 검증(묻기 전). 실패시 non-zero exit | `--json`(candidate) |
| `select-single` | gate 선정 후보를 결정적 top-1(info_gain)로 축소 | `--json`(배열) |
| `branch-order` | 미해결 작업을 연속성 순서로 + 열린 critical 분기 반환(순수 read) | — |
| `check-readiness` | readiness 게이트 평가(상태 미변경) | — |
| `project-coverage` | dimension을 공유 coverage 트리에 투영, coverage.json + intent-dialog.md 작성 | — |
| `premortem` | pre-mortem 항목 기록 + §5 승격 규칙 강제 | `--json`(items) |
| `dissent-briefs` | critical dimension별 반론 브리프 방출(모델 호출 없음) | — |
| `dissent-record` | host가 낸 intent-dissent 판정을 기록(외래 id fail-closed) | `--json` `--briefed` |
| `premortem-refute-record` | high-blast 항목에 반박 판정 기록 | `--json` |
| `semantic-targets` | A1 성취-vs-특성화 비평 대상 (fragment,dimension) 쌍 방출 | — |
| `semantic-record` | A1 의미비평 판정 기록(advisory, 비차단) | `--json` |
| `acknowledge-dissent` | critical dimension의 dissent를 사용자 재확인 → finalize 통과 | `--dimension` |
| `finalize` | intent.json 작성 + AC 미러 + autopilot 부트스트랩 | `--json`(finalizePayload) |
| `finalize-from-doc` | 확정된 prism/설계문서를 digest 바인딩해 intent로 컴파일(finalize 경유) | `--doc` `--statement` |

---

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

### 상태 파일
- `.ditto/local/work-items/<wi>/interview-state.json` — 인터뷰 사이드카(단일 SoT). 스키마: `interviewState`(interview-state.ts:389-426). InterviewStore가 유일 writer(interview-store.ts:12-36).
- `.ditto/local/work-items/<wi>/intent.json` — finalize 산출물. IntentStore가 씀(interview-driver.ts:785).
- `.ditto/local/work-items/<wi>/autopilot.json` — finalize가 부트스트랩한 노드 그래프.
- `.ditto/local/work-items/<wi>/question-rounds.jsonl` — 라운드 점수 trail(측정용, `ditto doctor intent-quality`가 읽음). question-round.ts:93-108.
- `.ditto/local/runs/<wi>/coverage.json`, `intent-dialog.md` — project-coverage 산출물.

모든 write는 store를 통해 원자적 + 스키마검증(interview-store.ts:31-35).

### 전체 흐름
```
start ──► (record-turn)* ──► check-readiness ──► finalize ──► intent.json + autopilot.json
             │                     ▲                 │
   표시계약 하드게이트          readiness 게이트     (1차 readiness ∧ 2차 user_confirmation
   (validateQuestionContext)   (critical resolved   ∧ dissent 미차단) 모두 만족해야 write
                               ∧ 준비도≥임계)
```
SKILL이 구동하는 라운드 내부(SKILL.md:61-116):
```
self-answer 게이트(code/docs/web + ditto memory query ADR)
   └► 살아남은 dimension만 →
N개 question-generator 병렬 fan-out (fresh context, transcript 없음)
   └► question-gate fan-in 점수화 {selected, dry, all_scored}
        └► select-single (top-1)
             └► check-question (표시계약)
                  └► critical이면 context-reviewer 세션-블라인드 검토(cap 2회 재생성)
                       └► 제시(교정형 recommended_answer) → record-turn
                            └► 드라이버가 branch judgment (답이 종속결정 열었나)
                                 └► branch-order (연속성 순서 + anti-starvation)
```
그 뒤 premortem → project-coverage → dissent seam → finalize.

### 입력→변환→저장 요지
- `record-turn`은 `recordTurnPayload`(interview-driver.ts:143-222)를 받아 dimension을 upsert하고, 질문을 `q001`식 단조 id로 append하며(:469), answer가 있으면 resolved_by/assumptions를 갱신한다. 저장 전에 표시계약 게이트를 통과해야 한다(:406-428).
- readiness gate와 dry-axis(§5 참조)를 매 턴 재계산해 `exit.reason`을 suggest한다(:563-602).
- `finalize`는 페이로드의 AC를 `intent.json`과 work item 양쪽에 쓰고, `payload.risk`를 declared_risk로 영속화한 뒤 `bootstrapAutopilot`을 같은 호출 안에서 부른다(:798-848).

---

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

### (1) 반편향: blind(transcript-free) 질문 생성기
가장 핵심적인 설계 결정. 질문 생성기(question-generator)는 **매 라운드 fresh context로 스폰**되고 인터뷰 transcript·드라이버의 추측·다른 생성기의 후보를 받지 않는다(agents/question-generator.md:9,16-17; SKILL.md:73-77). 이유는 두 가지 실패모드를 분리해 막기 위함이다(charter §4-9, SKILL.md:63):
- **편향**: 누적된 인터뷰 서사가 prior로 작동해 판단을 자기 서사 쪽으로 끈다.
- **context rot**: transcript가 길수록 품질이 비균일하게 떨어진다.

"반편향 메커니즘은 무엇을 **withhold(빼는가)**"라는 것(SKILL.md:77)이 핵심 — 드라이버는 최소 packet(고정 사실·결정, 프로젝트 상태, 대상 dimension)만 넘긴다.

### (2) 드라이버만이 답-따라 가지치기(branch-walking)의 출처
생성기가 transcript-blind이므로, **답을 참조하는 grounded 후속 질문은 오직 드라이버에서만** 나올 수 있다(SKILL.md:108, interview-driver.ts:194-199 주석). branch_edges/branch_judgment는 append-only question에 기록되고(interview-state.ts:233-270), 참조 그래프는 디스크에서 매번 재구성된다(interview-driver.ts:238-241). seam(더 열 종속결정 없음)에 도달하면 momentum을 타지 말고 **blind 전면 재조사**한다(SKILL.md:112) — 매몰 방지.

이 설계는 "grounded 후속으로 깊이"와 "blind 생성으로 무편향"을 양립시킨다. 트레이드오프: 드라이버(맥락 보유)와 생성기(무맥락)의 역할을 엄격히 분리해야 유지된다.

### (3) 적대적 압력: intent-dissent opponent (반론자)
deep-interview는 원래 적대적 압력이 0이었다 — 유일한 비평자는 "질문이 이해가능한가"를 보는 comprehensibility 리뷰어뿐, "의도가 틀렸는가"를 보지 않았다(interview-dissent.ts:18-22). 그래서 prism의 opponent 패턴을 intent 계층으로 이식해, critical dimension에 대해 **원 의도를 독립적으로 재도출**하는 반론자를 붙였다. **anti-inflation 불변식**: 반론자는 "같은 의도의 더 정확한 버전"만 돌려주고 범위를 키우면 안 된다(interview-dissent.ts:43-47, agents/intent-dissent-opponent.md:35). engaged high-impact 미확인 dissent는 finalize를 `blocked_by_dissent`로 막는다.

관련 ADR: 이 프로젝트에 branch-walking/deep-interview 전용 ADR은 없음(서브에이전트 확인). 반론자 seam은 **ADR-0001**(모델 호출은 host 위임)과 **ADR-0018**(선택적 외부도구 우아한 강등)을 근거로 한다: 코어는 opponent 후보만 순수 결정(opponent-router.ts), 실제 호출은 없으면 `host_absent`로 강등한다.

### (4) 세션-블라인드 표시계약
critical 질문은 세션을 전혀 공유하지 않는 리뷰어(context-reviewer)가 "사용자 표면만으로 결정 가능한가"를 판정한다. "당신의 가치는 맥락의 부재 그 자체"(agents/context-reviewer.md:11) — 게이트로 넣지 않고 별도 에이전트로 둔 이유는, 세션 근거가 있는 게이트는 그것이 잡아야 할 지식의 저주를 스스로 재현하기 때문(:14). 파일을 열거나 용어를 찾아봐야 이해되면 그 자체가 reject 신호(:25).

이와 별개로 `validateQuestionContext`(question-context.ts:200-243)는 **구조적 존재**를 하드체크한다: `user_explanation`(왜 묻는지·무엇을 정하는지)과 `recommended_answer`가 비면 reject. 품질은 LLM 게이트 몫, 존재는 코드 몫(deep-interview.ts:579-583).

### (5) 교정형(anti-anchoring) 추천 답
추천 답은 "이걸 고르세요"가 아니라 "틀리면 바로잡아 주세요" 극성으로 제시한다(SKILL.md:102, charter §4-12 anti-anchoring). 의도가 아직 형성 중인 산출물에 내 결론이 편향을 심지 않게 한다.

### (6) single-fire: 라운드당 최대 1문항
gate가 여러 개를 선정해도 `selectSingleFire`가 info_gain 최고 top-1로 결정적 축소(question-context.ts:327-340). info_gain은 3값 enum이라 tie가 흔하므로 tiebreak은 **안정 입력순서**(strict `>`). 이 제한은 deep-interview 경로 전용 — 공유 scoredQuestion 스키마에는 넣지 않아 prism은 다중선택 유지(:322-324).

### (7) 모호성 하한 (deterministic floor)
LLM이 자기보고한 준비도는 결정적 하한을 못 넘는다(gates.ts:104-105): `capped = min(score, 1 - floor)`, floor는 열린 critical 수·assumption 비율로 산출(gates.ts:76-91). 자기보고 점수만으로 게이트를 통과하는 치팅을 막는다.

### (8) pre-mortem §5 승격 규칙 (fail-closed)
irreversible이거나 blast_radius≥high인 항목은 반드시 ac | out_of_scope | user_owned_decision 중 하나로 승격돼야 한다. `promoted_to:'none'`으로 남으면 `unpromoted`로 반환되어 CLI가 non-zero exit로 막는다(interview-driver.ts:1163-1203, deep-interview.ts:547-557). 관련: **ADR-20260625**(premortem-relevance-gate)는 far-field 폭을 "관련 카테고리 전수"로 정의하고 skip은 코드로 강제되는 4중 안전(보수적 기본·증거바인딩·기본 반박·감사)을 요구 — pre-mortem을 "연극"으로 만들지 않는다는 결정.

---

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

### startInterview (interview-driver.ts:89-139)
입력: workItemId + threshold/questionCap/generators + seedUserIntentDimensions.
하는 일: `seedUserIntentDimensions`가 true면 far-field taxonomy에서 disposition=`user-intent` 카테고리를 non-critical·`unknown` dimension으로 seed(:98-109). CLI가 이 플래그를 켠다(deep-interview.ts:167).
효과: 사용자-의도 렌즈가 인터뷰 dimension이 되어 사용자가 intent 단계에서 답한다. **fail-open(:82-84 주석)**: 답 안 해도 readiness를 막지 않고 open cov-dim 노드로 투영돼 plan 단계 sweep에 남는다. `generators`는 InterviewState에 영속되지 않는 SKILL-loop 레버라 written state와 함께 반환만 한다(:134-138).

### recordTurn (interview-driver.ts:371-604) — 가장 밀도 높은 함수
1. **표시계약 하드게이트(:392-428)**: glossary opaque-vocab을 union한 뒤 user-reaching 표면(text + user_explanation)만 검증. 위반이나 미설명 식별자 누출이면 **무엇이 걸렸는지 이름을 담아 throw**(bare "rejected" 아님). 범위: answer.text·dimension.notes는 내부어휘 정당하므로 제외(:384-387).
2. **표시 정규화(:397-405)**: `normalizePresentedText`로 깨진문자/제어문자/타이포 정규화. 검증하는 형태와 **저장하는 형태가 같도록** 정규화를 한 번만 하고 둘 다에 쓴다(:393-396) — validate-one-form/persist-another 갭 차단.
3. **건전성 불변식(:430-441)**: 에이전트 추측(assumption, delegated≠true)이 critical dimension을 `resolved`로 닫지 못하게 `partial`로 강등. 안 그러면 게이트가 추측과 사용자 답을 구분 못 함.
4. **question append(:467-520)**: `q001`식 단조 id, branch_edges/branch_judgment/novelty/marginal_gain을 append-only로 기록. append-only 배치가 mid-interview stale을 구조적으로 막는다(:494-498 주석).
5. **dry-axis 3종 OR 종료신호(:563-602)**: value-dry(marginal_gain < DRY_FLOOR=0.12), angle-dry(novelty가 K=2 라운드 소진), value-exhausted(branch seam + seam-dry K). **cap이 먼저 검사돼 항상 이긴다**(:587-590) — cap은 무조건 수치 상한(autonomy-liveness fail-closed). dry axis는 `diminishing_returns`로 suggest만 하고 finalize 게이트는 안 건드림(:591-599).

### guardBranchEdges (interview-driver.ts:260-292)
입력: edges + knownIds. 하는 일: self-edge·dangling endpoint·cycle을 만드는 edge를 DROP(순수·TOTAL, throw 안 함). 효과: zod는 shape만 보므로 참조무결성(target∈known ids, 비순환)은 여기서 강제. **fail-open**: 문제 edge는 버려 edge가 줄 뿐 조기종료를 강제하지 않음(:257-259 주석).

### isValueExhausted / isBranchSeam (interview-driver.ts:303-335, question-context.ts:393-404)
seam은 (1) 판정 기록됨 (2) opened===false (3) 미해결 종속분기 없음 을 모두 만족할 때만 true. 어느 하나라도 애매하면 false → cap backstop으로 낙하. **under-detection이 조기종료를 유발하면 안 되므로 fail-open이 load-bearing**(question-context.ts:378-383).

### interviewReadinessGate (gates.ts:95-112)
열린 critical dimension이 있거나 하한적용 준비도가 임계 미만이면 reasons를 담아 blocked. 이게 1차 게이트.

### finalizeInterview (interview-driver.ts:723-848)
순서 의존적: readiness(:736) → user_confirmation.confirmed(:739) → critical high-impact 미확인 dissent(:753-766) 순으로 fail-closed. 셋 다 통과해야 intent.json write. dissent 블록은 **영속된 snapshot을 읽지, 비결정적 opponent를 재호출하지 않는다**(:743-752) — resume/retry/CI에서 안정. host_absent는 engaged dissent가 없어 fresh 인터뷰를 막지 않음(ADR-0018). declared_risk를 여기서 영속(:798-809)하지 않으면 loop가 빈 risk로 재계산해 고위험 계획을 auto-waive함(:790-797 주석, 메모리 wi_260710y87와 일치).

### projectInterviewDimensions (interview-driver.ts:958-1143)
dimension을 공유 coverage 엔진으로 투영(재구현 아님, `nextCoverageNode`/`recordCoverageRound` 재사용). critical dimension만 반론자 구동(cost localization). engaged면 neutrality를 'accept'로 clamp하고 실제 블록은 finalize로 미룸 — dissent가 공유 축에 'blocked'를 흘려 coverage를 livelock시키지 않게(:1009-1021 주석). host_absent면 정직하게 out_of_scope deferral close(neutrality 미주장). intent-dialog.md는 매 투영마다 렌더(엔진 종료와 무관)해 사용자가 얇은/열린 scope를 게이트 닫기 전에 교정할 수 있게 함(:1107-1112).

### record-back reducer 3종 (dissent/premortem-refute/semantic)
모두 동형: JSON.parse→zod safeParse→외래 id/index fail-closed(아무것도 안 씀)→whitespace text는 host_absent 강등→단일 write. dissent(:893-934)는 mergeDissent로 스티키. premortem-refute(:1222-1263)는 §17 localization으로 blast≥high 아닌 index를 거부. semantic(:1368-1408)은 별도 advisory 필드(semantic_status/critique)에 써서 finalize 비차단.

### CLI 계층 (deep-interview.ts)
각 서브커맨드는 parseOutputFormat→JSON.parse(USAGE_ERROR)→zod safeParse→driver 호출→human/json 출력의 동일 골격. bare CLI의 opponent seam은 `isAvailable:()=>false`, `delegate:async()=>null`로 항상 host_absent 강등(:468-478) — 실제 host 위임은 SKILL이 배선. finalize는 in_progress 엣지에서 GitHub claim을 1회 발사(:396-408, idempotent).

---

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위(§2 파일 목록 + SKILL 요약) 안에서 다음을 확인했다:

- **1차∧2차 AND 게이트**: finalize가 readiness·user_confirmation·dissent를 순차 fail-closed로 검사(interview-driver.ts:736-766). 스키마의 `userConfirmation.superRefine`이 confirmed=true인데 statement 비면 거부(interview-state.ts:378-386) — "bare boolean이 아닌 증거"라는 의도와 일치.
- **cap이 dry보다 우선**: `if (capReached) ... else if (dry...)` 배타 분기로 cap이 항상 이김(:587-599). 의도(autonomy-liveness backstop)와 일치.
- **표시계약 검증형=저장형**: 정규화를 한 번 하고 검증·저장에 같은 값 사용(:397-428, :484-489). 의도(갭 차단)와 일치.
- **fail-open branch/dry vs fail-closed 멤버십**: guardBranchEdges·isValueExhausted는 fail-open, record-back의 외래 id는 fail-closed. 의도적 비대칭이며 각 주석이 이유를 명시.

**갭/미확인 지점**:
- (미확인, 동작아님) branch-walking·single-fire의 참조 무결성/종료 로직은 **순수 함수 단위**로 존재하나, 이들이 실제로 "무편향+깊이"를 산출하는지는 **SKILL 드라이버가 규율을 지킬 때만** 성립한다. CLI는 seam(branch-order/select-single/check-question)만 제공하고 강제하지 못한다 — ADR-20260628-delegation-enforcement-boundary("행동 강제는 불가, codified-artifact까지")와 정합. 즉 "생성기에 transcript를 안 준다"는 코드가 아니라 SKILL 절차로만 보장된다(미검증 지점).
- (미확인) `dry_floor`·`DEFAULT_DRY_K=2`·`question_cap=8`·`OPTION_DESCRIPTION_BUDGET=160`은 코드 주석이 실측 근거 부족을 인정한 **보수적 기본값**(question-context.ts:342-353, interview-driver.ts:62-67). 값 자체의 최적성은 미검증.
- (죽은 경로 아님) 이 문서는 정적 코드 읽기이며 테스트를 실행하지 않았다. 실행 검증은 하지 않음(미검증).

---

## 7. 잠재 위험·부작용·재설계 시 고려점

### 약점 / 깨지기 쉬운 지점
1. **CLI-SKILL 분리의 취약성**: 반편향(blind 생성기)·context-rot 회피의 핵심 가치는 CLI가 아니라 SKILL 절차에 산다. 드라이버가 packet에 transcript를 흘리면 코드는 막지 못한다. 재설계 시 이 계약을 더 강하게 codify할 수 있는지가 관건(현재는 delegation-enforcement-boundary ADR상 codified-artifact가 한계).
2. **동시성/정합성**: InterviewStore는 full-replace write(interview-store.ts:32-35). 같은 wi에 동시 세션이 붙으면 last-write-wins로 턴이 유실될 수 있다(락 없음). project-coverage는 interview-state를 다시 읽어 dissent를 fold하므로(:1093-1103) 인터뷰 write와 인터리브되면 위험. 재설계 시 단일-writer 가정을 명시적으로 보장해야 함.
3. **비결정적 opponent의 snapshot 의존**: finalize 블록이 영속 snapshot을 읽는 설계는 안정성을 주지만, snapshot이 stale하면(예: 의도가 바뀐 뒤 재투영 안 함) 낡은 dissent로 막거나 놓칠 수 있다. mergeDissent 스티키성이 acknowledged 전까지 carry-forward하지만, 의도 자체가 바뀐 경우의 무효화 경로는 확인 안 됨(미확인).
4. **fail-open의 양날**: branch/dry axis가 under-detection시 조기종료를 안 하는 대신 cap(8)까지 계속 물을 수 있다 — 사용자 피로. cap이 유일한 무조건 backstop이므로 cap 값이 UX를 좌우.

### 재설계 시 반드시 보존해야 할 불변식
- **1차 readiness ∧ 2차 user_confirmation ∧ dissent-미차단**의 AND, statement 증거 요구(claim≠proof).
- **cap이 dry/value-exhaustion보다 우선**(autonomy-liveness).
- **critical dimension을 에이전트 추측이 resolved로 닫지 못함**(interview-driver.ts:430-441).
- **§5 승격 fail-closed**(irreversible/high-blast는 반드시 배정).
- **record-back의 외래 id/index fail-closed**(orphan 기록 금지) + **모호성 하한이 자기보고 점수를 cap**.
- **모델 호출 없음(ADR-0001) + 없으면 host_absent 강등(ADR-0018)** — 도구 부재가 의도 실현을 막지 않음.

### 재고할 수 있는 결정
- 보수적 상수들(dry_floor 0.12, K=2, cap 8, 160바이트)은 실측 없이 정해졌으므로 사용 데이터로 튜닝 대상.
- single-fire(라운드당 1문항)는 deep-interview 전용 선택 — 배치 질문이 사용자에게 더 나은 UX인지 재검토 여지.
- generators 기본 1(직렬등가)은 경량성 우선 선택. 무편향 강화를 위해 기본 fan-out을 올릴지.
