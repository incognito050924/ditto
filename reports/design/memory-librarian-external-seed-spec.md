# 조직·cross-repo 메모리 — 신규 standalone 프로젝트 시드 스펙

- 목적: 별도 standalone 프로젝트(조직·다중 저장소 장기기억·지식 시스템)의 **전략 방향만 못 박는다.** 구현·상세 설계가 아니라 잠긴 결정 + 구체화 위임의 캡처다.
- 소비자: 신규 프로젝트를 시작할 사람/에이전트(신규 프로젝트의 deep-interview 시작점) + ditto memory seam 전환을 추진할 사람.
- 수명: 신규 프로젝트가 자체 deep-interview/설계 문서를 만들 때까지의 **씨앗**. 신규 프로젝트가 자기 결정 기록을 갖게 되면 이 문서는 그 출처(provenance)로만 남는다.
- 갱신조건: 잠긴 결정(아래 `잠긴결정`)이 신규 프로젝트 진행 중 흔들릴 때만. 그 경우 ADR-0021의 철회/재검토 조건과 함께 다시 연다. 구체화 항목(`구체화위임`)이 신규에서 풀리는 것은 이 문서의 갱신 사유가 **아니다**(거기로 위임됐으므로).

> 이 시드는 wi_260618o97 deep-interview(6문 수렴, user_confirmation 확정)와 ADR-0021의 산출물이다. ADR-0021이 ditto repo 측 전략 결정 기록이라면, 이 문서는 그 결정을 **신규 프로젝트 입장에서** 다시 정리한 출발선이다. 둘은 같은 방향을 가리키며, 충돌하면 ADR-0021이 권위다.

---

## 비전

조직·cross-repo(다중 저장소) 장기기억·지식 시스템. memory-system.md의 핵심 은유 그대로:

> **방대한 양의 장서와 자료를 소장한 도서관**이되, 단순 아카이브가 아니라 그 안에서 원하는 자료를 **delivery**하고, **사실관계를 확인**하고, **결정에 도움이 되는 답**을 주는 **큐레이터(curator)**가 있는 시스템.

은유의 무게중심은 **사서(librarian)가 아니라 큐레이터(curator)**다. 단순 보관·전달(사서 기능)을 포함하되, 그 위에 **소장 자료를 활용해 새 가치를 합성**한다 — 흩어진 자료를 엮어 결정 계보·여정 구조를 구성하고(조합형), 근거에 결박된 답을 합성한다(생성형). 사서는 큐레이터의 한 기능이다.

목적(memory-system.md "목적"·"목표"에서):
- **LLM/에이전트 할루시네이션 최소화** — LLM은 사실관계·근거 없이 그럴듯한 결과를 만든다. 근거 있는 지식 베이스로 grounding 해 신뢰성을 높인다.
- **점진적 컨텍스트 획득** — 장기기억을 한 번에 로드하지 않고 필요한 시점에 필요한 부분만 점진적으로 가져온다. **토큰·context rot(컨텍스트가 길어질수록 성능이 비균일하게 저하되는 현상) 회피**가 1급 제약이다.
- **의사결정·의도 투명화** — 코드베이스는 단순 산출물이 아니라 요건·기획·설계·구현을 반복하며 쌓인 의사결정·의도·고민의 집적이다. 이것이 한 사람·소수에게만 있으면 다른 누군가는 그 의도와 충돌하는 작업을 한다. 모든 의도·의사결정·모호성을 투명하게 드러낸다.

## 아키텍처 방향

- **git = SoT(source of truth, 원본의 단일 출처)**: 원본·provenance(출처 이력)·머지를 git per-repo로 보존한다. gbrain이 RDB로 원본을 보존하는 것과 동일한 결.
- **서버 측 그래프 DB = rebuildable 투영(projection)**: 조직 cross-repo 관계 질의용. 원본이 아니라 git source 위에서 재구축 가능한 read-model이다. 기억·컨텍스트는 "어떤 사실이 이 작업과 어떤 관계인가"가 본질이므로(coding 자체가 엔티티/함수/데이터 간 흐름·관계 설계) 관계 표현이 용이한 그래프를 쓴다.
- **벡터는 보완**: 단독으로는 불충분("단상일 뿐 의미 없음" — q001). 그래프 투영을 보완하는 역할로만 둔다.
- 이 방향은 gbrain과 같은 모델(git/원본 source + DB projection)이며, ditto 측에서는 ADR-0005 D1 예외(파생 rebuildable read-model)·ADR-0013 D1("그래프는 projection일 뿐")과 **align**이다(SoT 교체가 아님).

## 통합형태

신규 프로젝트는 standalone이고, ditto에 두 가지 표면 중 하나로 노출된다:

- **MCP 서버** — ditto가 MCP 클라이언트로 호출, 또는
- **ditto-pluggable 표면** — commands/skills를 제공하고 ditto가 그 표면(commands/skills)을 호출.

ditto는 어느 쪽이든 **소비자**다. ditto에서 memory가 동작하던 **seam(층위)** 을 신규 표면 호출로 갈아끼운다 → **seam 대체**. ditto memory 기능을 신규로 이식·복제하는 것이 아니라, ditto의 memory 호출 지점을 신규 표면으로 바꾸는 것이다.

> MCP vs pluggable 최종 택일은 이 시드에서 결정하지 **않는다**(`out_of_scope`). 신규 프로젝트가 정한다.

## 잠긴결정

wi_260618o97 deep-interview에서 사용자 확정된 5개(①~⑤)와 2026-06-18 후속 대화에서 확정된 1개(⑥). 신규 프로젝트는 이것을 **재론의(re-litigate)하지 않는다** — 전제로 삼는다.

1. **별도 standalone 프로젝트.** ditto 내부가 아니라 분리된 프로젝트로 추진한다(d-housing). 서버형·cross-repo 시스템은 ditto의 무서버·git-native·단일 repo 기층(ADR-0005/0011/0013)과 맞지 않고, ditto 4축 스코프 비대를 피한다.
2. **git=SoT + 그래프 투영(벡터 보완).** 원본은 git, 그래프 DB는 재구축 가능한 투영, 벡터는 보완(d-paradigm, q001/q003).
3. **조직·cross-repo 스코프.** 1차 소비자 범위는 조직·다중 저장소 횡단(d-scope, q002). gbrain company-brain 급.
4. **seam 대체(기능 이식 아님).** 흡수의 의미는 ditto에서 memory 동작 지점/층위를 신규 표면 호출로 대체하는 것이다(d-relationship, q005/q006).
5. **신규가 장기적으로 ditto memory를 흡수·대체, ditto는 소비자.** 전환은 fail-closed — 신규 능력 실증 → seam 연결 → 현 동작 deprecate 순서. 신규 표면이 ditto seam에 연결되기 전까지 현 ditto memory 동작을 유지한다(ADR-0021 D4, seam 연속성).
6. **큐레이터 이원 능력 — 조합형 + 생성형(2026-06-18 후속 확정).** 신규는 단순 검색·전달을 넘어 (a) 자료를 엮어 구조(결정 계보·여정)를 구성하는 **조합형**과 (b) 근거에 결박된 답을 합성하는 **생성형(synthesis)** 을 **둘 다 1급 능력**으로 가진다. 단 생성형 출력은 반드시 **출처 + 모르는 것(gap) 명시 + confidence 계급으로 사실과 분리**한다 — 합성이 검증 안 된 추론을 사실(EXTRACTED)로 굳히면 안 된다(세탁 방지, 비전의 할루시네이션 최소화 목적과 직결). GBrain의 "검색이 아니라 출처 붙은 답을 합성하되 gap을 명시"(`reports/research/gbrain-code-level-research.md`) 모델을 차용한다. 이는 신규가 standalone이라 ditto memory의 advisory 자세(ADR-0013)에 구속되지 않기에 가능하다(시드 비목표 §: 신규는 자체 최적 설계).

## 구체화위임

다음은 **전부 신규 프로젝트 자체 deep-interview**로 위임한다. 이 시드는 이것들을 결정하지 않는다.

- **MVP 범위** — 개인부터 시작 vs 조직부터 시작.
- **스키마** — 엔티티·관계 모델, 기억의 단위, provenance 표현.
- **캡처/검색 메커니즘** — 무엇을 어떻게 수집하고 어떻게 점진적으로 회상하는가.
- **그래프 DB 선택** — Memgraph vs Neo4j.
- **통합 형태 택일** — MCP vs pluggable.
- **벡터/RAG 설계** — 보완 벡터·RAG의 구체 구성.

## out_of_scope

- 위 `구체화위임`의 모든 항목(MVP·스키마·메커니즘·Memgraph vs Neo4j·MCP vs pluggable·벡터/RAG).
- 신규 시스템의 **실제 구현**.

이 시드는 **방향만 못 박는다.** 그 외는 신규 프로젝트로 위임한다.

## 비목표

- **기존 ditto memory 기능의 온전한 이식 / feature parity는 목표가 아니다.** 흡수는 seam 대체이지 기능 보존이 아니다(잠긴결정 ④, ADR-0021 D2).
- ditto의 거버넌스 프리미티브 — **정합성 2축 freshness, 확신도 계급(EXTRACTED/INFERRED/AMBIGUOUS), provenance, propose/approve, ADR-0020(결정-모순 가드레일)** — 는 신규가 **참고로 차용할 수 있으나 의무는 아니다.** 신규는 자체 최적 설계를 가진다.

## 참고 자료

- `memory-system.md` — 사용자의 원본 비전 노트(도서관/사서 은유, 목적·목표·고려사항).
- `reports/research/agent-memory-systems-comparative.md` — GBrain·claude-mem·ditto memory 3종 비교 연구(차용할 개념의 맥락).
- `.ditto/knowledge/adr/ADR-0021-memory-seam-external-project.md` — 이 시드의 권위 결정 기록(ditto repo 측). 충돌 시 ADR-0021 우선.
- 출처(deep-interview): `.ditto/local/work-items/wi_260618o97/intent.json`, `.../interview-state.json`.
