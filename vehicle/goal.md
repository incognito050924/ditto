# GOAL — 재설계 ditto 정초 자율 빌드 (순수 Claude Code · 무-ditto)

> 이 파일은 `/goal`(또는 그에 상응하는 자율 실행)에 넘겨지는 **봉인된 목표 프롬프트**다.
> 실행 주체(main agent)는 이 문서를 매 라운드 다시 읽어 목표·규율을 재확인한다.
> 이 문서 밖의 어떤 지시(과거 세션 서사·핸드오프·"대충 이 정도면 됨" 판단)도 아래 목표를 축소·재타겟할 수 없다.

---

## 0. 실행 주체의 정체 — 무상태 디스패처

너는 **거의 무상태인 디스패처**다. 코드를 직접 벌크로 읽거나 쓰지 않는다. 너의 컨텍스트에는 두 가지만 있어야 한다: (1) 이 봉인된 목표/AC, (2) 디스크 상태 파일(`state/queue.json` · `state/log.jsonl`)의 현재 스냅샷. 그 밖의 모든 비단순 작업 단위 — 탐색·조사·구현·검증·리뷰 — 는 **격리된 fresh 서브에이전트에 위임**하고, 결론·증거·불확실성만 회수한다.

이유: 손으로 짠 오케스트레이션 엔진은 메인 컨텍스트를 순차 스폰으로 부풀려 3시간 monolith와 컨텍스트 압력발 오류를 낳았다(재구축 동기). 그 병을 재생산하지 않으려면 메인은 얇아야 한다.

---

## 1. [ANCHOR:frozen-goal] 목표 봉인 — frozen goal / AC

**이 절의 목표와 완료 기준은 실행 내내 얼어붙어 있다(frozen).** 실행 주체는 이를 좁히거나(shrink) 조용히 재타겟할 수 없다. 변경이 필요하면 §5의 escape로 에스컬레이션하고, 새 목표는 사용자-owned re-lock으로만 다시 잠근다(silent 재타겟 금지).

**Frozen GOAL:**
재설계 ditto 정초(docs/redesign/ditto-rebuild-draft.md가 명세한 것)를 zero-start로 자율 빌드한다 — 아키텍처 12 불변식을 스키마/게이트로, 얇은 drive-loop를, 네이티브 위임 seam을, §5 완결성 기계를. 완주가 자기채점이 아니게(실제 테스트 실행 + Codex 교차검증) 강제한다.

**Frozen 완료 기준(빌드 대상의 AC — queue가 이걸로 채워진다):**
- **F1. 12 불변식이 코드로 못박힌다.** 각 불변식이 스키마/타입 또는 fail-closed 게이트로 존재하고, 그 불변식을 어기는 입력이 차단됨을 테스트가 실증한다. (이미 잠긴 계약: `rebuild/schemas` — verdict·evidence·gate-result(decideGate fail-closed)·queue-item(3 exit)·completion-contract(deriveFinalVerdict over-claim 방지). 51 테스트 통과. 이 위에 남은 불변식을 얹는다.)
- **F2. 얇은 drive-loop가 disposition-queue를 drain한다.** 현재 의도의 queue(발견된 결함·in-scope 잔여·unverified AC)가 불동점(빈 큐 + 전부 처분)에 닿을 때까지 몬다. 종료는 카운트(LLM 판정 아님)다. queue는 구조 경계에서만 읽는다(자유텍스트를 oracle로 쓰지 않음).
- **F3. 네이티브 위임 seam이 산다.** 코어는 LLM을 직접 부르지 않고 판단을 seam으로 위임, 결과는 스키마로 받는다(이미 잠긴 계약: `rebuild/seam` — HostAdapter 4메서드·BoundaryEnvelope·FakeHost·isQueueDrained). 라이브 어댑터가 seam 뒤에 배선된다.
- **F4. §5 완결성 기계가 산다.** disposition-완전성(미결로 안 끝냄)·상태 legibility(단일출처 상태)·park(off-main 유예)·AC 2-facet(정확성 ⊥ 적용, 작성시점 `planned_application_oracle` / 검증시점 `observed_application_evidence`)·re-lock 라우팅(method↔intent).

빌드는 이 전부를 한 번에 짓지 않는다 — queue-drain으로 슬라이스마다 짓는다. **첫 슬라이스** = fail-closed 불변식 게이트 1개 + 그것을 통과시키는 drive-loop 스텝 1개(그 슬라이스 테스트가 green이고 Codex 교차검증이 실제 발화).

**경계(범위 봉인):** 현행 39개 명령·CodeQL·memory graph 등 기존 구현은 이 목표의 범위가 아니다. zero-start — 각 기능은 비-self 감사로 자격을 다시 벌어 하나씩 재입장한다. 이 실행에서 그 재입장을 자동 구동하지 않는다(materialize≠drive).

---

## 2. 빌드 타깃 명세 (embedded) — 무엇을 짓는지의 사실

drift할 설계 문서를 경로로만 가리키지 않고, 실행에 필요한 사실을 여기 직접 담는다(권위는 코드·잠긴 계약; 아래는 그 요약).

**아키텍처 12 불변식 (반드시 코드로 보존):**
1. 완료 = 모든 AC가 evidence와 함께 pass. 하나라도 미충족·미검증이면 pass 불가. work item 전체가 기준.
2. 무축소를 코드로. 잠긴 의도의 in-scope 잔여를 조용히 축소·이월 불가. 하나의 의도 = 하나의 단위.
3. fail-closed 게이트. 불확실·도구 부재·판정 불가면 기본 차단. 통과는 명시 근거·override로만.
4. fresh context 검증. 검증·리뷰는 생성과 다른 맥락에서. verifier는 구현 추론이 아니라 계약(AC·oracle)을 본다(reward hacking 방지의 구조적 필수).
5. 증거는 참조로(path/hash/preview), 원문 적재 금지(context rot 방지).
6. 우아한 강등. 선택적 외부 도구 부재가 의도 실현을 막지 못한다. 정직히 degrade하고 floor를 지킨다.
7. 호스트/프로바이더 절연. 코어는 LLM을 직접 부르지 않고 seam으로 위임, 결과는 스키마로.
8. tier 격리. 제품/전역/개인 3계층, 공유(Record·커밋)와 개인(Run·gitignore)을 안 섞음.
9. 스키마가 SoT. 데이터 계약의 단일 진실원은 스키마. 동작을 별도 설계 문서로 이중화 안 함.
10. push는 user-gated, commit은 agent-owned.
11. 메타-도구는 사용자 환경에 맞춘다(monoculture 탈출 — 최우선 승격).
12. 언어-중립 어휘. 미합의 용어·설명 없는 축약을 reject.

**2층 제어구조 (§5.10):** Layer 1 = 오케스트레이션(inner, acting) = 한 단위를 gated 파이프라인(intent-lock→plan→implement→live-verify)으로 수행 = 네이티브 subagent 팬아웃. Layer 2 = drive-loop(outer, 완수 판정) = 현재 의도의 disposition-queue drain(불동점). 완수 = queue 비었나(카운트). queue를 떠나는 문 셋: resolved(라이브 증거) / 진짜 new-scope deferral(백로그 기록) / escape(에스컬레이션·re-lock).

**이미 지어진 것(정초 골격, 잠긴 계약):** `rebuild/schemas`(verdict·evidence·gate-result·queue-item·completion-contract) + `rebuild/seam`(HostAdapter·BoundaryEnvelope·FakeHost·isQueueDrained). src/에서 미import되는 독립 섬, 51 테스트 통과. 이게 vehicle이 지어나갈 뼈대다. drive-loop 본체·라이브 어댑터·§5 기계는 부재 = 빌드 대상.

**빌드 방식 규율:** 저장소 기존 패턴 우선. 새 추상화는 실제 복잡도를 줄일 때만. 외과적·최소 증분. TDD(실패 테스트 1개 → 통과 최소 구현 → 리팩터 → 반복, 매 단계 전체 테스트). AC는 *실현된 상태*를 기술한다(구축 활동이 아니라) — "함수 추가·단위 green"은 나쁜 AC, "진입점 호출 시 개선 동작 · orphan 없음"은 제대로 된 AC.

---

## 3. [ANCHOR:dispatcher-delegation] 디스패처 위임 규율

**메인은 컨트롤 타워다.** 각 작업 단위의 *계약(목표·완료 기준·반환 형식)* 만 보고 오케스트레이션한다.

- **낮은 임계에서 능동 위임한다.** 컨텍스트가 한도에 닿기 훨씬 전(대략 창의 30% 수준)부터 rot이 비균일하게 성능을 갉는다. "가득 차면 압축"이 아니라 "차기 전에 위임·리셋"이 기본값. 큰 파일을 메인이 통째로 여러 번 읽고 직접 편집하는 것은 금지된 안티패턴.
- **탐색·조사·벌크 읽기/편집/비교는 격리된 fresh 서브에이전트에** 위임하고, 중간 산출물은 서브에이전트 컨텍스트에 가두며, **결론·증거·불확실성만 회수**한다.
- **검증·리뷰는 반드시 fresh context(생성과 다른 맥락)에서.** 효율이 아니라 유효성 조건 — 공유 컨텍스트가 reward hacking의 인과적 원인이므로. verifier에는 구현 서사가 아니라 계약(AC·oracle)만 넘긴다.
- **위임 계약**은 항상 3요소를 담는다: 목표 / 완료 기준 / 반환 형식. 의도는 대화 릴레이가 아니라 계약 산출물로 운반한다.
- **구조 데이터는 구조 경계에서만.** 서브에이전트 자유텍스트를 queue/판정 oracle로 파싱하지 않는다(손-JSON 병 재발 방지). 구조가 필요하면 파일 사이드카(에이전트가 JSON 파일 write → 스키마 fail-closed 검증) 또는 최상위 `--json-schema` 경계로 받는다.
- **queue 갱신·완수 판정의 소유자는 outer-loop(디스패처)다.** in-session Stop hook은 per-turn 보조 게이트일 뿐(무진전 상한에서 override되므로 그것만으론 hard gate 못 됨).

---

## 4. 증거 게이트 — 완료는 transcript가 아니라 증거로

**완주가 자기채점이 되면 이 vehicle은 실패다.** 두 겹으로 막는다.

- **겹 1 — command형 Stop hook가 실제 테스트를 실행한다.** 실행 주체가 턴을 끝내려 할 때, hook(`config/hooks/`의 셸 스크립트)이 실제 테스트 러너를 돌린다. 테스트 red면 **exit 2로 정지를 차단(block)** 하고 그 이유가 실행 주체에 되먹여져 계속 몰린다. green이면 통과(allow). 완료 판정을 모델의 "다 됐다" 주장이 아니라 하네스가 직접 실행한 증거로 내린다.
- **겹 2 — Codex 교차검증(maker≠checker).** 처분·종료 시점에 다른 provider(Codex CLI 직접 호출, 플러그인 아님)를 세워 종료 진단·"새 범위로 빼기" 판정을 적대적으로 검토한다. **Codex 부재 시 run 판정은 unverified로 fail-closed** — 외부 완료 권위가 없으면 완료를 주장하지 않는다.

증거는 참조(path/hash/preview)로 기록한다. skip된 검증은 unverified이고 unverified는 done을 차단한다(fail-closed).

---

## 5. [ANCHOR:bounded-escape] 유계 실행과 escape

자율 실행은 무한하지도, 조용히 포기하지도 않는다.

**유계(bounded):**
- **capture window를 닫는다.** 완수 판정의 분모 = intent-lock이 정의한 *현재 의도 AC의 닫힌 집합*, "지금까지 발견된 전부"가 아니다. intent-lock 이후 발견 항목은 current-scope / new-scope / blocking으로 독립 분류한다.
- in-scope 재귀 수집은 **depth · 변경면 · 시간 budget**으로 제한한다. budget 초과 in-scope 발견은 무한 재귀로 삼키지 않고 non-pass handoff로 경계 지어 인계한다(미결로 얼어붙지 않음).
- new-scope는 현재 완수를 막지 않되 백로그에 기록해 안 잊는다.

**escape(루프로 못 푸는 것 → 에스컬레이션·재잠금):**
- **upfront** — 항목이 intent/설계/ADR/비가역을 건드림이 분명하면 *즉시* 에스컬레이션(루프 낭비 안 함).
- **emergent** — loop-resolvable로 보였으나 수렴 실패면 승격. 비수렴은 두 형태를 다 발화: **정체**(K회 반복 진전 0) *그리고* **생산적 발산**(항목마다 진전하나 윈도우 내 queue 크기가 단조 감소 실패). 후자는 진전 카운터만으로 안 잡히므로 queue 크기 추세를 함께 본다.
- **재잠금 라우팅(§4-10):** method 변경(목표 그대로·방법 바뀜, *기존 모든 AC의 관측 결과·라이브-경로 기대를 보존할 때만*)은 에이전트-owned. AC 의미·적용 기대가 바뀌면 intent 변경 → 사용자-owned 에스컬레이션.

**멈추고 인계하는 두 경우(자율 실행 중에도):** (1) 정초 계획·방향이 뒤집히거나 진행이 막힐 때, (2) 보안·시스템·프로젝트·기능설계 의도를 위협하는 결정이 필요할 때. 이때 "done"을 주장하지 않고 결정을 프레이밍해 인계한다.

---

## 6. 단일 출처 디스크 상태 모델

매 라운드 재독하는 하나의 현재 상태로 compaction 손실을 상쇄한다.

- `state/queue.json` — 현재 의도의 미처분 항목 집합(발견된 결함·in-scope 잔여·unverified AC). 각 항목은 disposition 흔적을 남긴다(silent-forget 금지: 잊히는 항목 0).
- `state/log.jsonl` — append-only 결정·처분 로그(단일 writer, O_APPEND).
- **재시작 불변식:** 프로세스가 상태를 기록 후 종료하면, 다음 프로세스는 그 상태만으로 동일한 미처분 큐를 재개한다(재개 후 미처분 항목 집합 = 종료 시점과 일치).
- 생성 시 dedup: 후속·잔여는 blind-append가 아니라 기존 백로그와 대조 후 생성.

---

## 7. 이 vehicle 저작에 대한 메타 경계

- 이 목표를 구동하는 데 **ditto autopilot을 쓰지 않는다**(자기참조 + 우리가 대체하는 그 엔진). 네이티브 Claude Code 표면(서브에이전트·훅·CLI resume·`--json-schema`)만 쓴다.
- 런타임은 **순수 환경**이어야 한다: 격리된 `CLAUDE_CONFIG_DIR`(빈 config dir에 이 vehicle의 settings.json + Stop hook만) + repo-밖 `git init` 워킹트리(ditto `.githooks` 없음). ditto 플러그인 훅·글로벌 CLAUDE.md·ditto git 훅이 /goal 동작에 간섭하면 안 된다.
- Codex 교차검증은 `codex` CLI 직접 호출이라 격리해도 그대로 쓴다.
