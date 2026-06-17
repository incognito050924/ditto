# Memory 사서 (Librarian) — 테크스펙

> **소비자**: DITTO(design → implement → verify) + 사람(증분 리뷰).
> **소스**: 2026-06-17~18 대화 (wi_260617aaf). gbrain 비교 연구(`reports/research/gbrain-code-level-research.md`, `ditto-memory-vs-gbrain.md`)에서 출발해 ditto memory의 원래 의도("도서관과 사서")를 재정식화.
> **수명**: §3·§5·§6·§7·§10 = 장수명(빌드 후 ADR 승격) · §8·§11 = 단수명(빌드 후 폐기).
> **모드**: stepwise · **리뷰 커버리지**: finalize 산출물에 섹션별 reviewed/skipped 기록.
>
> **재개 상태 (2026-06-18 일시중지, 다른 PC 포함)**: §1~§4·§7(Pre-mortem #1) 작성·전부 `review=pending`(미확정). §5 비목표·§6 AC·§8 계획·§9 영향도·§10 기각된 대안·§11 마일스톤·§13 미작성. work item `wi_260617aaf`·tech-spec-state·handoff는 `.ditto/local/`(gitignore, ADR-0012)라 **다른 PC엔 없다** — 그 경우 `ditto work start`로 동일 의도 재등록 후 `ditto tech-spec start --doc .ditto/specs/memory-librarian.md`로 이 문서를 가리켜 재개한다(이 문서가 source of truth). **재개 순서**: ① §1~§4·§7 사용자 리뷰 → ② §6에 "주입이 아니라 *소비 강제*(consult + cite-or-abstain)" AC 승격(§7 의심점 1) → ③ §5/§6 증분마다 Pre-mortem #2(ADR `관련` recall 거짓음성·측정 실현성·세탁 방지) → ④ 의도 모호 시 deep-interview 내부 호출(§12) → `tech-spec finalize`. 배경 연구: `reports/research/ditto-memory-vs-gbrain.md`, 사용자 원본 메모: `memory-system.md`.

---

## 1. 기능

- **이름**: Memory 사서 (Librarian) — 결정·여정·발견 컨텍스트 포착·연결·재주입 (wi_260617aaf)
- **층위**: `ditto memory` 서브시스템 (지식 축). 소비 표면 = autopilot 위임 경계(push) + CLI 질의(pull). ADR-0013/0015가 정한 기존 메모리 기층 위에 올린다.

## 2. 요약

호스트 에이전트(Claude Code·Codex)와 ditto 내부 에이전트는 **코드(의사결정의 결정체)만 보고 그 뒤의 결정 과정·제약·개발 중 발견을 보지 못한 채 자신 있게 계획·구현한다** — 이미 기각된 대안 재제안, 안 보이는 불변식 위반, 의도된 선택의 오인이 그 결과다(환각). 이 스펙은 ditto memory를 **사서**로 만든다: 개발 중 생기는 컨텍스트(코드를 지배하는 결정 계보·사용자 여정·데이터 의존 발견)를 **증거에 결박해 포착**하고, **코드·결정·여정에 연결**하고, **커밋에 스탬프해 신선도를 추적**하고, **결정 경계에서 envelope(출처·신선도·확신도) 박아 push**한다. 추측은 INFERRED/AMBIGUOUS로 격리해 사실로 굳히지 않는다(세탁 방지). 성공은 *좋은 답*이 아니라 *측정된 환각 감소*(재제안율·불변식 위반율)로 판정한다.

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
5. **측정 가능한 환각 감소**: "환각이 줄었다"를 잴 수 있는 지표 — 기각된 대안 재제안율·불변식 위반율(계획을 ADR의 "기각된 대안"·"철회조건"과 대조) — 로 정의하고 baseline 대비 개선을 보인다.

## 5. 비목표 (변경 경계) [장]

<다음 증분에서 작성>

## 6. 완료 조건 (Acceptance Criteria)

| id | 완료 조건 (관찰가능 술어) | evidence |
|---|---|---|
| <다음 증분에서 작성> | | |

## 7. 위험 / Pre-mortem

> Pre-mortem #1(배경·목표 직후, 2026-06-18) 누적. #2(비목표/AC 증분마다)·#3(finalize 전 deep-interview 수렴)은 다음 세션에서.

| 위험 | 처리 | 플래그 |
|---|---|---|
| **전제 약점**: 기억이 있어도 에이전트가 주입 컨텍스트를 무시하거나 push가 강제되지 않으면 환각 감소 0. 저장 기능이 아니라 *접지 계약(consult + cite-or-abstain)을 결정경계에 강제*해야 성립. | AC 승격 후보(§6) — "주입"만이 아니라 "소비 강제"를 관찰가능 술어로. 다음 증분에서 §6에 박기. | — |
| **측정 실현성**: "재제안율·불변식 위반율"은 ADR이 "기각된 대안"·"철회조건"을 파싱가능하게 일관 기재해야 잴 수 있음. 형식 들쭉날쭉하면 측정 흔들림 → measure-before-expand 재보류 위험. | unknown(잔류). 다음 증분에서 ADR 형식 샘플 조사 후 측정 정의 확정. | — |
| **코드↔결정 다리 recall**: ADR `관련:`이 지배 코드를 항상 인용하진 않음(일부 design doc·다른 ADR만). 누락 시 "지배 결정 없음" 거짓 음성 = 환각 차단 목적의 최악 실패 모드. | 부분 커버리지 명시 + fallback 설계(예: ADR 본문 경로 멘션도 스캔). 다음 증분에서 §8/§6에 반영. | — |
| **세탁(laundering)**: 개발 중 자기보고 발견을 사실로 저장하면 미검증 추측이 영속 기억으로 굳어 다음 세션 오염. | 비목표/AC로 — 증거결박 포착만 허용, 자기보고는 INFERRED/AMBIGUOUS 격리(§4-4). propose/approve·confidence 계급 약화 금지. | — |

## 8. 계획 (Plan) [단]

<다음 증분에서 작성>

## 9. 영향도 · 의존성

<다음 증분에서 작성>

## 10. 기각된 대안 [장]

<다음 증분에서 작성>

## 11. 마일스톤 [단]

<다음 증분에서 작성>

## 12. 인터뷰 기록

<deep-interview 내부 호출 시에만>

## 13. 빌드 후 처리

<다음 증분에서 작성>

---

## 미해결 질문

<결정 시점에 박아 남긴다>
