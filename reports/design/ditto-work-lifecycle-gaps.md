# ditto work-lifecycle 결함 분석 + 에이전트 완료 기준 (개선 과제)

> **목적**: ditto가 "풀 세리머니(deep-interview→autopilot) 아니면 무절차" 둘만 제공해 에이전트가 즉흥(ad-hoc)으로 빠지고, 그 즉흥 작업이 추적·종결·묶음·정결한 배포가 안 되는 구조 결함을 정리한다. **소비자**: 다음 세션/다른 PC가 이 개선을 *표준 프로세스로* 착수할 때. **상태**: 분석 + 권장 착수 순서. **미구현** — 코드 변경 0. **삭제 조건**: 아래 6개 결함이 ditto 표준 lifecycle로 흡수되면 폐기(SoT는 그때의 코드·ADR).
>
> 권위 주의(§4-11): 아래 file:line은 2026-06-26 기준 실측. 착수 세션은 다시 코드로 확인할 것 — 이 문서는 배경·과제 정의이지 코드 SoT가 아니다.

---

## 1. 에이전트 완료 기준 (행동 헌장 보강 — 이게 결함의 "왜"를 만든다)

ditto 구조 결함이 에이전트에게 나쁜 행동을 *합리적 선택*으로 만든다. 그래서 기준을 먼저 박는다 (memory: `completion-not-residual-handoff`):

1. **시킨 작업은 돌아가고·테스트되고·landed까지 민다.** "기계적 부분 작성"에서 멈추고 보고하지 않는다.
2. **검증 가능하면 지금 검증한다.** "별도·라이브"로 미루는 건 *정말 지금 내가 못 할 때만*, 그때도 메뉴가 아니라 "이 한 가지를 왜 못 하는지"를 댄다.
3. **새로 나온 범위/버그는 현 의도 안에서 해결하거나, 기본 행동까지 정한 소유된 후속으로 패키징한다.** 사용자를 PM 만들지 않는다.

**왜 이게 헌장 §4-5/§4-6만으론 안 됐나**: "정직하게 미검증 표시"를 *완료의 회피·방패*로 쓸 수 있다. 검증할 수 있는데도 멈추고 그 일을 사용자 결정으로 변환하는 것 — 이게 최악 UX다. 단, 이 행동 교정은 아래 구조 결함이 남아 있으면 *에이전트 의지력에만* 기대게 된다. 구조가 받쳐야 한다.

---

## 2. 6개 lifecycle 결함 (코드 결박 — 있음 vs 없음/불완전)

핵심: 사용자가 "없다"고 본 것들 중 상당수가 **부분적으로 존재하나 미연결·미사용·friction으로 막혀 있다.** 그래서 과제는 "맨바닥 신축"보다 **연결·완성·표면화·기본값화**에 가깝다.

### 결함 1 — 표준 우회 (deep-interview→autopilot 무시, 멋대로 TDD) · **EXISTS-ADVISORY**
- deep-interview는 *권고지 강제 아님*(`src/core/charter.ts` DEEP_INTERVIEW_DIRECTIVE = "Recommended; may be skipped if small or reversible"). `autopilot bootstrap`만 intent.json을 강제(`src/cli/commands/autopilot.ts` bootstrap 게이트)지, `work start` 경계엔 게이트가 없다.
- **이미 경량 경로가 있다**: `work start` → `ditto verify <wi> --criterion ac -- <cmd>` → `ditto work done`(완료계약을 WI의 AC verdict에서 *합성*, intent.json/graph 불필요 — `src/cli/commands/work.ts:350-355`).
- **진짜 결함**: 그 경량 경로가 (a) 에이전트에게 안 보이고(기본값/안내 부재), (b) 아래 결함2 때문에 *쓸 수가 없다*.

### 결함 2 — 경량 작업용 절차 · **EXISTS-PARTIAL (그러나 진입 막힘)**
- 세 경로 존재: verify(최경량) · tech-spec(중간, `src/cli/commands/tech-spec.ts`) · deep-interview(최중). 
- **진짜 결함**: `work start`가 **placeholder 기준**(`PLACEHOLDER_AC_STATEMENT = "TBD — derive observable criteria during interview/planning"`)을 박는데, **그 placeholder를 의미있는 기준으로 바꾸는 경량 수단이 없다** — deep-interview/tech-spec만 진짜 기준을 만든다. verify는 *기존 기준의 verdict*만 채운다(placeholder "TBD"를 verify해봐야 무의미). → 경량 경로의 입구(진짜 기준 세팅)가 막혀 있다.
- **과제 모양**: `work start --criteria "<ac1>;<ac2>"` 또는 `work set-criteria` 같은 *세리머니 없는 진짜-기준 세터*. 이게 verify→done 경량 경로를 *실제로 사용 가능*하게 만든다.

### 결함 3 — WI 정리/종결 · **EXISTS-COMPLETE (그러나 placeholder엔 안 맞음)**
- 세 종결: `work done`(완료계약 필요 또는 진짜-기준 verdict에서 합성, `work.ts:326-416`) · `work abandon`(증거 불요·"포기", `:284-324`) · `work archive`(terminal만 이동, `:418-477`).
- **진짜 결함**: placeholder 기준 + 완료계약 없는 WI는 `done` 거부(`work.ts:361-366` — "lock real criteria via deep-interview, or abandon")이고 `abandon`은 done을 "포기"로 *거짓표기*. → **직접 구현으로 끝낸 작업이 닫을 곳이 없다.** 이건 결함2(진짜 기준 경량 세팅)가 풀리면 자동 해소(verify→done이 열림). 추가로: done-but-unclosed 위생 정리(예: 25개 open 일괄 점검)도 없다.

### 결함 4 — WI 묶음/epic/의존 · **PARTIAL (스키마만, 도구 없음)**
- `parent_id`·`child_ids` 필드는 스키마에 *존재*(`src/schemas/work-item.ts:115-116`). 그러나 epic/depends_on/group/tags 없고, **여러 WI를 한 단위로 보거나 처리하는 도구가 없다**(parent_id는 주로 coverage 트리에 쓰임, cross-WI 실행 아님).
- **과제 모양**: 기존 parent_id/child_ids 위에 "관련 WI를 한 줄기로 조회·처리·종결" 도구. far-field 줄기(vjo→227h→258zu→l0v→txs)를 한 단위로 닫을 수 있게.

### 결함 5 — 후속/backlog · **EXISTS-MINIMAL (포착되나 실행 안 됨)**
- `follow_up_candidates: string[]`가 intent.json에 *존재*(`src/schemas/intent.ts:43-46` — "Out-of-scope improvement ideas captured but not acted on"). deep-interview finalize가 채움.
- **진짜 결함**: 그게 **정적**이다 — follow-up을 추적 WI로 *물질화*하는 명령도, backlog 조회/처리 루프도, "이 WI가 버그를 깠다"를 연결하는 수단도 없다. → 에이전트가 후속을 *산문 목록*으로 사용자에게 던진다(최악 UX의 한 형태).
- **과제 모양**: follow-up/발굴버그 → 추적 WI(parent 링크) 물질화 명령 + "backlog 처리" 절차. 결함3·4와 맞물림.

### 결함 6 — 푸시 ↔ 완료 결합 · **MISSING**
- push/deploy/release를 WI 완료에 묶는 로직 *전무*(grep 0건). 완료는 추적되나 push-readiness와 분리.
- **진짜 결함**: "이 단위가 자기완결 → push-ready"라는 게이트가 없어, 에이전트가 push를 *경계 사건*이 아니라 *기본 단계*로 강요한다. push는 사용자의 배포 결정 — *완결된 단위가 생겼을 때만* 그 경계에서 요청해야 한다.
- **과제 모양**: 완료된 자기완결 단위 ↔ push-제안 결합. 미완결 의도엔 push 제안 자체를 안 함.

---

## 3. 뿌리 진단 (정정됨)

ditto는 **이상적 무거운 경로(deep-interview→autopilot→complete)는 모델링**했고, **경량 메커니즘의 조각들(verify 경로·parent/child·follow_up_candidates)도 갖췄으나, 그것들이 미연결·미표면화·friction(placeholder 기준)으로 막혀 있다.** 결과: 에이전트가 경량 경로를 못 보고/못 쓰고 즉흥으로 가며, 그 작업이 추적·종결·묶음·정결한 배포가 안 된다. **과제의 성격은 신축이 아니라 "이미 있는 조각을 연결·완성·기본값화"**다.

---

## 4. 권장 착수 순서 (뿌리부터)

1. **진짜-기준 경량 세터 + 경량 경로 기본값화 (결함 1·2·3)** — `work start`에 세리머니 없는 진짜-기준 세팅을 주면 verify→done 경량 경로가 *열리고*, placeholder WI 종결 막힘이 풀린다. 동시에 "작고 가역이면 경량, 비가역/큰값이면 표준"의 *스펙트럼 결정 규칙*을 안내·강제. → 결함 1·2·3 동시 해소. **여기가 뿌리.**
2. **후속 물질화 + backlog 루프 (결함 5)** — 발굴(버그·후속)을 추적 WI로 물질화(parent 링크) + 처리 절차. → "산문 목록 던지기" 종식.
3. **WI 묶음/배치 도구 (결함 4)** — parent_id/child_ids 위 줄기 조회·일괄 종결.
4. **push ↔ 완료 결합 (결함 6)** — 자기완결 단위에만 push 제안.

---

## 5. 미해결 질문 (착수 세션이 deep-interview로 풀 것)

- **경량 진짜-기준 UX**: `work start --criteria`? 인라인 편집? 1-질문 elicitation? (deep-interview의 축약 vs 별개)
- **스펙트럼 결정 규칙**: 언제 무거운 경로(deep-interview)가 *필수*이고 언제 경량이 충분한가 — 누가/무엇이 판정하나(에이전트 자율 vs 게이트)?
- **후속 물질화 정책**: follow-up을 자동 WI화 vs 승격까지 candidate 유지? 발굴버그는 즉시 WI vs backlog?
- **묶음 모델**: 기존 parent_id/child_ids 재사용 vs 새 epic 개념? 줄기 종결의 의미(전부 done이어야? 부분?)
- **push 결합**: "자기완결 단위"를 무엇이 판정하나(완료계약 verdict=pass? AC 전부 closed?)?

---

## 6. 케이스 스터디 — far-field 줄기 (2026-06-22~26, 이 결함들의 실증)

vjo(재설계)→227h(비용 트리거)→258zu(설계)→l0v(구현)→txs(버그) = **5 WI, 전부 open/partial/draft**. 한 세션에서 슬라이스 1-6 + 측정 + 버그2 + 라이브검증을 **멋대로 TDD**로 처리(결함1). WI들은 placeholder 기준이라 **종결 불가**(결함3). 측정이 깐 버그2를 **산문 목록으로 던짐**(결함5) 후 사용자가 시켜서야 고침. **푸시를 반복 강요**(결함6, 완결 전에). 5개 WI를 **한 줄기로 닫을 방법 없음**(결함4). — 각 증상이 정확히 한 결함에 대응한다. (far-field 작업 자체는 main b8d8163에 landed·검증 완료; 이 문서는 그 *과정의 구조 결함*을 분리한 것.)
