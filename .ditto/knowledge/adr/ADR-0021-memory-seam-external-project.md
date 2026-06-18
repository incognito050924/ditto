# ADR-0021: 조직·cross-repo 메모리를 별도 standalone 프로젝트로 — ditto memory seam 대체 (흡수=feature parity 아님)

- 상태: accepted
- 결정 일자: 2026-06-18
- 결정자: hskim, claude (claude-opus-4-8)
- 관련: ADR-0005 (런타임 산출물 저장 — 파생 read-model 철회조건이 그래프 투영을 허용), ADR-0011 (Distribution 축·session-rooting invariant — cross-repo는 ditto 범위 밖), ADR-0013 (메모리 서브시스템 — D1 "Neo4j는 projection일 뿐"·무서버 모델), `.ditto/local/work-items/wi_260618o97/intent.json`, `.ditto/local/work-items/wi_260618o97/interview-state.json` (d-paradigm/d-scope/d-housing/d-relationship)

## 컨텍스트

조직·다중 저장소 횡단(cross-repo) 장기기억·지식 시스템을 어디에 담을지 deep-interview로 합의했다(wi_260618o97, 6문 수렴, user_confirmation 확정). 1차 소비자 범위가 "조직·cross-repo"로 결정되면서 서버 그래프 DB가 강하게 정당화됐고, 이는 ditto의 무서버·git-per-repo·단일 repo 기층(ADR-0005/0011/0013 D1)과 정면으로 충돌한다. 동시에 사용자는 이 기능이 ditto 안에 담기엔 너무 크다고 판단했다(d-housing).

벡터 DB 단독은 불충분하고("단상일 뿐 의미 없음"), gbrain이 RDB로 원본을 보존하듯 원본 저장소가 필요하되 관계 표현이 용이한 그래프를 투영으로 쓰는 방향이 합의됐다(d-paradigm, q001/q003). 흡수의 의미는 q006에서 정정·확정됐다 — 기능 온전 이식이 아니라 ditto에서 memory가 동작하는 지점/층위(seam) 대체다.

본 ADR은 이 전략 결정을 ditto repo에 못 박는다. 구체 설계는 신규 프로젝트로 위임한다(시드 스펙은 별도 산출물 ac-2).

## 결정

### D1 — memory seam을 별도 standalone 프로젝트로 대체한다

- ditto에서 memory가 동작하는 **seam(층위)을 별도 메모리 프로젝트로 대체**(`seam 대체`)한다. 신규 시스템은 standalone이고, **MCP** 서버 또는 **ditto-pluggable**(`pluggable`) 표면(commands/skills)을 제공한다. ditto는 그 표면을 호출하는 **소비자**가 된다.
- 신규를 MCP로 만들어 ditto가 클라이언트로 쓰거나, pluggable로 ditto가 신규 표면(commands/skills)을 호출한다. MCP vs pluggable 최종 택일은 신규 프로젝트로 위임한다(out_of_scope).
- 별도 프로젝트로 분리하는 이유: 서버형·cross-repo 시스템 자체가 ditto의 무서버·git-native·단일 repo ADR(0005/0011/0013)과 맞지 않고, ditto 4축 스코프 비대를 피한다(d-housing). ditto 거버넌스 프리미티브(정합성 2축 freshness·confidence·provenance·propose/approve·ADR-0020)는 신규가 참고로 차용할 수 있으나 의무는 아니다.

### D2 — 흡수 = seam 대체이지 기능 이식이 아니다 (비목표: feature parity)

- 흡수의 의미는 **ditto에서 memory 동작 지점/층위를 신규 표면 호출로 대체**하는 것이다. 기존 ditto memory 기능의 온전한 보존·이식이 아니다.
- **비목표**(`비목표`): ditto memory 기능의 신규로의 이식/보존. 신규는 feature parity 의무가 없고 자체 설계를 가진다(ditto의 freshness·확신도·provenance 같은 좋은 개념은 참고 가능).

### D3 — 아키텍처 방향: git=SoT + 그래프 투영 (ADR-0005/0013과 align, supersede 아님)

- **git=SoT**(`git=SoT`): 원본·provenance·머지를 git per-repo로 보존한다(gbrain의 RDB 원본 저장과 동일 모델). 벡터는 단독으로 불충분하나 보완으로 둘 수 있다.
- 서버 측 **그래프 투영**(`그래프 투영`): 조직 cross-repo 질의용 rebuildable projection. 이 in-ditto "그래프=투영" 위치는 ADR-0005 D1 예외(파생 rebuildable read-model)와 ADR-0013 D1("Neo4j는 projection일 뿐, SoT/런타임 아님")이 **이미 허용**한다 → supersede가 아니라 **align**이다.
- 서버형·cross-repo 시스템 자체는 별도 외부 프로젝트로 격리되므로 ditto의 무서버 ADR 밖에 있다. ditto repo의 무서버·단일 repo 기층 ADR은 본 결정으로 바뀌지 않는다.

### D4 — seam 연속성: 전환조건 충족 전 현 동작 유지

- **전환조건**(`전환조건`): 신규 표면이 ditto seam에 **실제 연결되기 전까지** 현 ditto memory 동작을 유지한다(seam 연속성). 신규가 능력을 실증하기 전에는 현 memory를 폐지하지 않는다.
- 장기적으로 신규가 ditto memory를 흡수·대체하고 ditto는 소비자가 된다. 그 전이는 fail-closed로 — 신규 능력 실증 → seam 연결 → 현 동작 deprecate 순서를 지킨다.

## 근거

- **D1**: cross-repo·서버 그래프는 ADR-0005/0011/0013을 깨므로 ditto 안에 둘 수 없다. 별도 프로젝트는 ditto 4축 스코프를 보호하고, 신규는 ditto 거버넌스 프리미티브를 자유롭게 차용한다. MCP/pluggable 둘 다 ditto를 호출 소비자로 만드는 표면이라 택일은 구현 단계로 미룬다.
- **D2**: 흡수를 기능 이식으로 보면 신규가 ditto memory의 설계 부채까지 떠안는다. seam 대체로 한정하면 신규는 자체 최적 설계를 가지고, ditto는 호출 지점만 갈아끼운다 — 결합도 최소.
- **D3**: git=SoT + 그래프 투영은 q001/q003에서 사용자가 직접 고른 방향이고, ADR-0005 D1 예외·ADR-0013 D1과 이미 정합한다. SoT 교체가 아니라 파생 투영이므로 기존 ADR supersede가 불필요하다(d-paradigm note).
- **D4**: 신규가 실증 전 현 동작을 폐지하면 메모리 공백이 생긴다. seam 연속성은 능력 실증을 폐지의 선행 게이트로 둬 비가역 손실을 막는다.

## 대안 (기각)

- **ditto 내부에 cross-repo 그래프 서버를 둔다**: ADR-0005 무서버·ADR-0011 session-rooting·ADR-0013 D1을 깬다. 별도 프로젝트로 격리(D1).
- **그래프 DB를 SoT로 승격**: ADR-0005/0013 D1을 supersede해야 하고 git 머지·provenance를 잃는다. git=SoT + 그래프 투영으로 align(D3).
- **흡수=ditto memory 기능 온전 이식**: 신규가 부채를 떠안고 feature parity가 족쇄가 된다. seam 대체로 한정(D2).
- **벡터 DB 단독**: 사용자 판단 "단상일 뿐 의미 없음" — 원본 보존·관계 표현 불가. git 원본 + 그래프 투영, 벡터는 보완(D3).
- **신규 실증 전 현 ditto memory 즉시 폐지**: 메모리 공백·비가역. seam 연속성 게이트(D4).

## out_of_scope (신규 프로젝트로 위임)

다음은 본 ADR에서 결정하지 **않는다**. 신규 프로젝트의 자체 deep-interview/시드 스펙으로 위임한다.

- 신규 시스템 **실제 구현**
- 그래프 DB 선택 — **Memgraph vs Neo4j**
- 통합 형태 최종 택일 — **MCP vs pluggable**
- **MVP** 상세 스코프(개인부터 vs 조직부터)
- 캡처/검색 **메커니즘** 설계
- 벡터/**RAG** 설계
- ditto memory 기능의 신규로의 이식/보존 (위 D2 — 명시적 비목표)

## 철회/재검토 조건

- 신규 프로젝트의 deep-interview에서 통합 형태(MCP vs pluggable)나 SoT 모델이 본 방향과 어긋나는 결론이 나오면 → 본 ADR D1/D3을 재검토하고 필요 시 supersede ADR을 연다.
- 그래프 투영이 ADR-0005 D1 예외(rebuildable read-model)의 경계를 넘어 SoT 역할을 요구하게 되면 → ADR-0005/0013 supersede 여부를 그 시점에 판정(현재는 align).
- seam 연속성(D4)이 깨져 신규 실증 전 현 memory가 폐지되는 경로가 생기면 → 전환조건 게이트를 재집행 대상으로.
- 신규 프로젝트가 무산되거나 cross-repo 요구가 철회되면 → ditto 내부 memory(ADR-0013)만으로 충분한지 재평가하고 본 결정을 보류 처리.
