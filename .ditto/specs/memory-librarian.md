# Memory 큐레이터 (Curator) — 테크스펙

> **소비자**: DITTO(design → implement → verify) + 사람(증분 리뷰).
> **소스**: 2026-06-17~18 대화 (wi_260617aaf). gbrain 비교 연구(`reports/research/gbrain-code-level-research.md`, `ditto-memory-vs-gbrain.md`)에서 출발해 ditto memory의 원래 의도("도서관과 사서")를 재정식화.
> **수명**: §3·§5·§6·§7·§10 = 장수명(빌드 후 ADR 승격) · §8·§11 = 단수명(빌드 후 폐기).
> **모드**: stepwise · **리뷰 커버리지**: finalize 산출물에 섹션별 reviewed/skipped 기록.
>
> **상태 (2026-06-18 후속 갱신)**: §1~§13 전 섹션 초안 작성 완료 — 큐레이터 이원 모델(조합형 advisory + 생성형 INFERRED 한정) 반영. §6 ac-2 소비강제(consult+cite-or-abstain) 승격·§7 Pre-mortem #2(측정 실현성·cite-or-abstain 검증성·다리 recall·생성형 역설) 누적 완료. **review는 여전히 pending**(사용자 증분 리뷰 전) — 이 모드는 사용자 리뷰를 전제하므로 `ditto tech-spec finalize`(intent.json 컴파일)는 사용자 리뷰 후. work item `wi_260617aaf`·tech-spec-state·handoff는 `.ditto/local/`(gitignore, ADR-0012)라 **다른 PC엔 없다** — 그 경우 `ditto work start`로 동일 의도 재등록 후 `ditto tech-spec start --doc .ditto/specs/memory-librarian.md`로 이 문서를 가리켜 재개한다(이 문서가 source of truth). 배경 연구: `reports/research/ditto-memory-vs-gbrain.md`, 사용자 원본 메모: `memory-system.md`.

---

## 1. 기능

- **이름**: Memory 큐레이터 (Curator) — 결정·여정·발견 컨텍스트 포착·연결·재주입 (wi_260617aaf). "사서"(보관·전달=조합형)는 큐레이터의 한 기능이며, 그 위에 자료를 활용한 가치 합성(생성형)을 더한다. **단 ditto 내부에서는 생성형을 INFERRED 채널로 한정**해 advisory 자세(ADR-0013)를 유지한다 — 시스템이 직접 합성한 결론은 EXTRACTED로 올리지 않는다(아래 §2·§4-4).
- **층위**: `ditto memory` 서브시스템 (지식 축). 소비 표면 = autopilot 위임 경계(push) + CLI 질의(pull). ADR-0013/0015가 정한 기존 메모리 기층 위에 올린다.

## 2. 요약

호스트 에이전트(Claude Code·Codex)와 ditto 내부 에이전트는 **코드(의사결정의 결정체)만 보고 그 뒤의 결정 과정·제약·개발 중 발견을 보지 못한 채 자신 있게 계획·구현한다** — 이미 기각된 대안 재제안, 안 보이는 불변식 위반, 의도된 선택의 오인이 그 결과다(환각). 이 스펙은 ditto memory를 **큐레이터**로 만든다: 개발 중 생기는 컨텍스트(코드를 지배하는 결정 계보·사용자 여정·데이터 의존 발견)를 **증거에 결박해 포착**하고, **코드·결정·여정에 연결**하고, **커밋에 스탬프해 신선도를 추적**하고, **결정 경계에서 envelope(출처·신선도·확신도) 박아 push**한다. 추측은 INFERRED/AMBIGUOUS로 격리해 사실로 굳히지 않는다(세탁 방지). 성공은 *좋은 답*이 아니라 *측정된 환각 감소*(재제안율·불변식 위반율)로 판정한다.

큐레이터의 두 능력을 confidence 계급으로 가른다: **조합형**(자료를 엮어 결정 계보·여정 구조를 구성)은 결정적 산출이라 기본 advisory로 그대로 제공하고, **생성형**(시스템이 직접 결론·답을 합성)은 ditto 내부에서 **INFERRED 채널로 한정**한다 — 합성 결론은 EXTRACTED(사실)로 승격하지 않고 출처·확신도 envelope를 달아 보조 추론으로만 내보내며, 최종 결론 합성은 host LLM 몫으로 남긴다. 이로써 큐레이터의 가치 합성을 들이되 advisory 자세와 환각 차단 목적을 깨지 않는다. (생성형을 1급으로 올리는 변형은 별도 standalone 프로젝트 — `reports/design/memory-librarian-external-seed-spec.md` 잠긴결정 ⑥ — 의 몫이다.)

## 3. 배경 [장]

ditto는 이미 작업단위·의도계약·완료계약·큐레이션 지식(ADR/glossary)·결정적 코드분석(impact/codeql)을 갖췄고, 메모리 서브시스템(in-process 그래프·2-tier 저장·propose/approve·2축 freshness)도 v0로 존재한다. 그런데 "도서관과 사서"의 **사서 능력**이 빠져 있다. 코드로 확인한 구체적 빈틈:

1. **그래프가 "두 섬"으로 끊겨 있다 — 코드↔결정 다리 미배선.** `Symbol`/`Artifact` 노드 + `CALLS/IMPORTS/RELATED_TO`(ACG 흡수, `src/core/memory-ir.ts`)는 코드 섬을, `Decision` 노드 + `RATIONALE_FOR`(`src/core/memory-project.ts:101`)는 결정 섬을 이룬다. 그러나 `RATIONALE_FOR`는 **`Source(결정을 정당화하는 문서) → Decision`**을 잇지(`memory-project.ts:56`), **`코드 Symbol → 그 코드를 지배하는 Decision`이 아니다.** 그래서 계획 에이전트가 건드릴 파일에서 그래프를 타도 그 코드를 만든 ADR에 도달하지 못한다.
2. **다리는 데이터엔 이미 있으나 배선만 안 됐다.** ADR 머리말 `관련:` 줄이 지배 코드를 이미 인용한다(예: ADR-0015 → `src/core/memory-project.ts`·`memory-warmstart.ts`; ADR-0013 → `src/core/ditto-paths.ts`). `src/core/memory-bootstrap.ts`는 ADR을 gist만 뽑아 decision 이벤트로 적재하고(`:235`) 이 `관련` 참조를 파싱해 코드 엣지로 만들지 않는다. → 결정적(임베딩·합성 없이) 배선 가능.
3. **일회성 산출물이 그래프로 누적되지 않는다.** 설계 §1-4 자인 — impact/codeql/semantic 분석은 "한 번 쓰고 버려지는 일회성 산출물"이라, "이 함수가 어느 결정에 묶였나" 같은 질의를 싸게 못 한다.
4. **개발 중 발견(3층 컨텍스트)이 증발한다.** 사용자 스토리·여정·"데이터가 X 상태면 깨짐" 같은 결합은 코드에도 ADR에도 없고 작업 세션에서 *생겨나며*, 발견 순간이 가장 신선하고 즉시 부식한다. ditto에 원자료 포착 뼈대는 있으나(`retrospective` 에이전트·completion contract·evidence record·e2e journey·decisions 로그) 이들이 **연결·freshness 스탬프·질의가능 노드로 굳어 다음 계획에 재주입되는 뒷절반이 비어 있다.**
5. **freshness의 진짜 쓰임.** ADR-0015의 `source_revisions.git_commit`·`code_drift`/`code_dirty`는 "저장 사실의 staleness"를 넘어 **"이 발견이 잡힌 커밋 기준으로 아직 live한가"**를 답하는 기계다 — 3층 포착의 부식 추적에 그대로 쓰인다.

> 근거: `memory-project.ts:56,101`, `memory-ir.ts`(코드/결정 섬), `memory-bootstrap.ts:235`, 설계 `reports/design/memory-graph-plugin-design.md` §1, ADR-0013(D1~D4)·ADR-0015(D1~D3). 비교 맥락은 `reports/research/ditto-memory-vs-gbrain.md`.

## 4. 목표

1. **코드↔결정 다리**: 코드 Symbol/Artifact에서 그것을 지배하는 Decision(ADR)으로 가는 결정적 엣지를 그래프에 배선한다. ADR의 `관련` 참조를 출처로 삼는다.
2. **결정 계보 push**: 계획·결정 경계에서, 건드릴 코드를 시드로 — 적용 ADR·**기각된 대안**·**불변식**·supersedes 체인을 envelope(출처·신선도·확신도) 동반해 에이전트에게 주입한다. 시드가 손에 있어 임베딩 없이 동작한다.
3. **개발 중 발견의 증거결박 포착**: 작업 세션에서 생긴 발견(여정·데이터의존 케이스·암묵 결합)을 *증거에 묶일 때만* 포착해, 관련 코드·결정·여정에 연결하고 커밋에 스탬프한다.
4. **세탁 방지**: 에이전트 자기보고 추측은 INFERRED/AMBIGUOUS로 격리하고 사실(EXTRACTED)로 승격하지 않는다. 읽기는 항상 envelope를 실어 소비자가 calibrate/abstain 하게 한다.
5. **측정 가능한 환각 감소**: "환각이 줄었다"를 잴 수 있는 지표 — 기각된 대안 재제안율·불변식 위반율(계획을 ADR의 "기각된 대안"·불변식과 대조) — 로 정의하고 baseline 대비 개선을 보인다.

## 5. 비목표 (변경 경계) [장]

- **생성형(synthesis)을 1급 능력으로 올리지 않는다.** ditto 내부 큐레이터의 생성형은 INFERRED 채널 한정 보조 추론이다 — 시스템이 합성한 결론을 EXTRACTED(사실)로 승격하거나 host LLM의 최종 결론을 대체하지 않는다. 생성형 1급화는 별도 standalone 프로젝트의 몫(ADR-0021 D5, `reports/design/memory-librarian-external-seed-spec.md` ⑥).
- **임베딩·벡터 검색을 도입하지 않는다.** 코드↔결정 매칭은 ADR `관련:` 줄의 결정적 파싱 + 경로 정규화로 한다(ADR-0013 D1, 벡터 기각).
- **개발 중 발견을 자동 전수 캡처하지 않는다.** 포착은 evidence-id에 결박된 명시 propose만 — 자기보고 자동 수집(claude-mem식 관찰자)은 세탁·보안표면 때문에 비목표(§7).
- **새 그래프 런타임/서버를 도입하지 않는다.** 인프로세스 그래프·2-tier 저장·propose/approve를 그대로 쓴다(ADR-0013).
- **ADR `관련:` 형식을 바꾸거나 ADR을 일괄 리라이트하지 않는다.** 현재 형식(쉼표 구분 경로 목록, 조사 결과 매우 일관)을 파싱 대상으로 받는다. 누락은 fallback으로 다룬다(§7).
- **measure-before-expand 게이트를 건너뛰지 않는다.** push 지점 확장·발견포착 자동화는 hit율·환각감소 측정 후 결정한다(ADR-0013 D4).

## 6. 완료 조건 (Acceptance Criteria)

| id | 완료 조건 (관찰가능 술어) | evidence |
|---|---|---|
| ac-1 | 코드 Symbol/Artifact 노드에서 그것을 지배하는 Decision(ADR)으로 가는 `RATIONALE_FOR` 엣지가 그래프에 존재한다. `ditto memory query symbol:<path>#<name>`가 지배 ADR을 depth≤2로 반환한다. ADR `관련:`이 인용한 경로는 EXTRACTED, 본문 멘션 fallback은 INFERRED로 라벨되고 커버리지(인용/fallback/미발견)가 응답에 드러난다. | `ditto memory build` 후 query 출력(지배 ADR + confidence_kind + 커버리지) |
| ac-2 | **소비 강제(consult + cite-or-abstain).** 계획·결정 경계에서 에이전트 위임 패킷에 지배 Decision(+기각된 대안·불변식)이 포함되고, 에이전트 출력이 사용한 결정을 cite하거나 "관련 결정 없음"을 abstain으로 명시한다 — 주입만으로는 미충족. | warm-start 패킷에 Decision 동반(로그) + 에이전트 출력의 cite/abstain 표식 |
| ac-3 | evidence record가 `ditto memory propose-finding --evidence-id <id>`로 MemoryEvent(confidence_kind=INFERRED, source=evidence-id)로 변환되어 propose→approve→query로 회수된다. | propose→approve→query 왕복 출력 |
| ac-4 | **세탁 방지.** 에이전트 자기보고 발견은 EXTRACTED로 저장되지 않는다 — proposeEvent가 INFERRED/AMBIGUOUS로 강등하거나 거부한다. | EXTRACTED 자기보고 propose 시도 → 거부/강등 출력 |
| ac-5 | 기각된 대안 재제안율·불변식 위반율을 baseline 대비 측정하는 정의와 산출 경로가 존재한다(계획 텍스트를 지배 ADR "기각된 대안"·불변식과 대조). | 측정 정의 문서 + 1회 산출 |
| ac-6 | 생성형(synthesis) 합성 출력은 confidence_kind=INFERRED + 출처 envelope를 달고 나오며 EXTRACTED로 승격되지 않는다(§2 INFERRED 한정). | 생성형 출력 샘플의 confidence_kind·source |

## 7. 위험 / Pre-mortem

> Pre-mortem #1(배경·목표 직후, 2026-06-18) + #2(비목표/AC 증분, 2026-06-18 후속) 누적. #3(finalize 전 deep-interview 수렴)은 의도 모호 시에만.

| 위험 | 처리 | 플래그 |
|---|---|---|
| **전제 약점**: 기억이 있어도 에이전트가 주입 컨텍스트를 무시하거나 push가 강제되지 않으면 환각 감소 0. 저장 기능이 아니라 *접지 계약(consult + cite-or-abstain)을 결정경계에 강제*해야 성립. | AC 승격 후보(§6) — "주입"만이 아니라 "소비 강제"를 관찰가능 술어로. 다음 증분에서 §6에 박기. | — |
| **측정 실현성**: "재제안율·불변식 위반율"은 ADR이 "기각된 대안"·"철회조건"을 파싱가능하게 일관 기재해야 잴 수 있음. 형식 들쭉날쭉하면 측정 흔들림 → measure-before-expand 재보류 위험. | unknown(잔류). 다음 증분에서 ADR 형식 샘플 조사 후 측정 정의 확정. | — |
| **코드↔결정 다리 recall**: ADR `관련:`이 지배 코드를 항상 인용하진 않음(일부 design doc·다른 ADR만). 누락 시 "지배 결정 없음" 거짓 음성 = 환각 차단 목적의 최악 실패 모드. | 부분 커버리지 명시 + fallback 설계(예: ADR 본문 경로 멘션도 스캔). 다음 증분에서 §8/§6에 반영. | — |
| **세탁(laundering)**: 개발 중 자기보고 발견을 사실로 저장하면 미검증 추측이 영속 기억으로 굳어 다음 세션 오염. | 비목표/AC로 — 증거결박 포착만 허용, 자기보고는 INFERRED/AMBIGUOUS 격리(§4-4). propose/approve·confidence 계급 약화 금지. | — |
| **측정 실현성 (#2)**: 재제안율·불변식 위반율은 ADR이 "기각된 대안"·불변식을 파싱가능하게 일관 기재해야 잴 수 있다. 조사 결과 `관련:` 줄 형식은 매우 일관(쉼표 구분 경로)하나, "기각된 대안"·불변식 섹션의 구조화 정도는 ADR마다 다를 수 있다. | ac-5를 "측정 정의 + 1회 산출"로 한정. 형식 비일관 드러나면 measure-before-expand 재보류(ADR-0013 D4). | unknown(잔류) |
| **cite-or-abstain 검증 가능성 (#2)**: ac-2의 소비는 에이전트 자기보고라, 실제 consult 없이 cite 표식만 다는 것을 구분하기 어렵다. | 1차는 패킷 동반(주입) + 표식 존재까지만 관찰. 진짜 소비는 재제안율(ac-5)로 간접 검증 — 두 AC를 교차한다. | unknown(잔류) |
| **다리 recall 거짓음성 (#2 재확인)**: ADR `관련:`이 지배 코드를 인용하지 않은 경우 "지배 결정 없음" 거짓음성 = 환각 차단 목적의 최악 실패. | ADR 본문 경로 멘션 fallback 스캔(INFERRED), 커버리지(인용/fallback/미발견)를 query 응답에 명시. ac-1에 부분 커버리지 술어 반영(완료). | — |
| **생성형 환각 역설 (#2)**: 환각을 막으려 들인 생성형(synthesis)이 근거 없이 합성하면 그 자체가 환각원이 된다. | INFERRED 한정 + 출처·gap 동반 강제(ac-6). 합성은 그래프 근거에 결박될 때만. EXTRACTED 승격 경로 차단(ac-4). | — |

## 8. 계획 (Plan) [단]

measure-before-expand(ADR-0013 D4)에 따라 가치가 결정적이고 큰 증분부터. 각 증분은 전체 테스트 GREEN 유지.

1. **증분 1 — 코드↔결정 다리 배선** [목표1, ac-1]. `src/core/memory-bootstrap.ts` `ingestAdrs`(:207-253)에 ADR 머리말 `관련:` 줄 파싱 추가(regex), 경로를 `normalizePath`(`memory-ir.ts:73-75` 규칙, 확장자 제거)로 정규화. `src/core/memory-project.ts`에서 정규화 경로를 Symbol id(`symbol:<path>#<name>`)·Artifact id(`artifact:<path>`)와 매칭해 Symbol/Artifact→Decision `RATIONALE_FOR` 엣지 생성. 머리말 인용=EXTRACTED, 본문 멘션 fallback·매칭 실패=INFERRED/AMBIGUOUS. 검증: 샘플 ADR(0013/0015) build 후 `ditto memory query`가 지배 ADR + 커버리지 반환.
2. **증분 2 — 결정 계보 push + cite-or-abstain** [목표2, ac-2]. `src/core/memory-warmstart.ts`가 건드릴 코드 Symbol을 시드로 지배 Decision + 기각된 대안 + 불변식 + supersedes 체인을 envelope(출처·신선도·확신도) 동반 주입. 위임 계약에 "사용한 결정 cite 또는 관련없음 abstain" 술어 추가. 검증: 패킷에 Decision 포함(로그) + 에이전트 출력 표식.
3. **증분 3 — 발견 증거결박 포착** [목표3, ac-3]. `ditto memory propose-finding --evidence-id <id>` CLI 추가: `evidence-store.readIndex` → evidence record → MemoryEvent(confidence_kind=INFERRED, source=evidence-id) 변환 → `proposeEvent`(`memory-project.ts:360-386`). 검증: propose→approve→query 왕복.
4. **증분 4 — 세탁 방지 강제** [목표4, ac-4·ac-6]. `proposeEvent`에서 자기보고 출처는 confidence_kind 기본 INFERRED 강제, EXTRACTED 요청 시 거부/강등(스키마 superRefine은 `memory-graph-ir.ts:98-125`에 이미 존재 — 호출처 강제만 추가). 생성형 출력도 동일 경로로 INFERRED 라벨. 검증: EXTRACTED 자기보고 propose → 거부.
5. **증분 5 — 측정 + 게이트** [목표5, ac-5]. 재제안율·불변식 위반율 정의(계획 텍스트를 지배 ADR "기각된 대안"·불변식과 대조), `pull-usage.jsonl`(`memory-query.ts:70-92`) 확장 수집. measure-before-expand 게이트 데이터원. 검증: 측정 정의 + 1회 산출.

freshness 재활용: evidence/completion 발견에 source `git_commit` 스탬프(`memory-project.ts:258` 경로) 부여, `code_drift` 검출(`detectAxis2`, `memory-project.ts:520~`) 재사용해 부식 추적.

## 9. 영향도 · 의존성

- **기존 ADR 의존**: ADR-0013(propose/approve·measure-before-expand·인프로세스 그래프), ADR-0015(freshness 2축·`git_commit` 스탬프 재활용), ADR-0020(결정충돌 가드 — 지배 ADR 검색이 같은 ADR 색인을 소비).
- **수정 코드**: `memory-bootstrap.ts`(ADR `관련:` 파싱), `memory-project.ts`(엣지 생성·propose 정책), `memory-graph-ir.ts` 스키마(confidence 정책 주석), `evidence-store.ts`/`completion-store.ts`(`git_commit` 메타), `memory-query.ts`/`memory-warmstart.ts`(push·측정), 신규 CLI `propose-finding`.
- **fail-open 유지**: 모든 추가는 선택적(optional 필드). `DITTO_MEMORY=off`로 전 기능 비활성, 다리·발견 부재 시 기존 경로(grep·warm-start 1지점) 보존(ADR-0013).
- **호스트 중립**: 생성형 합성은 host LLM 위임(ADR-0001, ditto가 provider를 직접 호출하지 않음). ditto는 결정적 파싱·그래프·envelope만 담당한다.

## 10. 기각된 대안 [장]

- **임베딩/벡터로 코드↔결정 매칭**: 비결정·비쌈, ADR-0013 D1·벡터 기각. `관련:` 형식이 매우 일관(조사 확인)해 결정적 파싱으로 충분 → 증분 1.
- **ADR 본문을 매번 LLM 요약해 다리 구성**: 비결정·토큰비용. gist(기존) + `관련:` 결정적 파싱으로 대체.
- **발견 자동 전수 캡처(claude-mem식 관찰자)**: 세탁·무인증 보안표면. evidence-id 결박 명시 propose로 한정(§5, ac-4).
- **생성형 1급화(GBrain식 합성 답)**: advisory 자세 이탈, 환각원 위험. ditto 내부는 INFERRED 한정, 1급화는 신규 standalone(ADR-0021 D5).
- **다리를 별도 그래프 DB(Neo4j)에 적재**: 무서버 기층 위반(ADR-0013 D1). 인프로세스 그래프 유지.

## 11. 마일스톤 [단]

- **M1 — 코드↔결정 다리** (증분 1): 가장 결정적·고가치. 단독으로 "이 코드를 지배하는 ADR" 질의 가능.
- **M2 — 계보 push + cite-or-abstain** (증분 2): M1 그래프를 결정 경계에서 소비 강제.
- **measure-before-expand 게이트**: M1/M2의 hit율·재제안율 측정(증분 5 일부) 후 M3 진행 여부 판정(ADR-0013 D4).
- **M3 — 발견 포착 + 세탁 방지** (증분 3·4): 게이트 통과 시. evidence→INFERRED 메모리화.
- **M4 — 측정 정착** (증분 5): baseline 대비 환각 감소 산출.

## 12. 인터뷰 기록

<deep-interview 내부 호출 시에만>

## 13. 빌드 후 처리

- §8 계획·§11 마일스톤: 빌드 후 폐기(단수명).
- §3 배경·§5 비목표·§6 AC·§7 위험·§10 기각대안: ADR로 승격 — ADR-0013 보강 또는 신규 ADR("코드↔결정 다리 + 발견 포착, 생성형 INFERRED 한정"). 큐레이터 자세 결정(조합형 advisory / 생성형 INFERRED 한정)을 못 박는다.
- 명칭 충돌(미해결 질문): skill/agent 이름은 기존 `memory-graph` 유지, 문서 표기만 "memory 큐레이터"로 확정.

---

## 미해결 질문

<결정 시점에 박아 남긴다>

- **명칭 충돌: "큐레이터(Curator)".** ditto에는 이미 `agents/knowledge-curator.md`가 있다 — durable knowledge(ADR/glossary) 큐레이션 전담, `.ditto/knowledge/` docs-write-only. 본 스펙의 "Memory 큐레이터"는 메모리 그래프(코드·결정·여정·발견) 전체를 가리켜 범위가 다르다. ditto 내부 문서·코드에서 둘을 혼동하지 않도록 메모리 쪽은 `memory curator` 또는 `ditto memory`로 한정 표기할지(예: skill/agent 이름은 기존 `memory-graph` 유지) 빌드 시점에 확정한다.
