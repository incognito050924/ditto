# ditto:tech-spec · 스펙 공동작성 사용자 표면 — 기획문서

> **소비자**: DITTO(design → implement → verify) + 사람(증분 리뷰). 이 문서 자체가 제안하는 12섹션 산출물 형식의 워크드 예시다.
> **소스**: `USER_PATTERN.md` §"DITTO 의 새로운 사용자 표면 기능 제안" + 2026-06-10 설계 논의.
> **수명**: §3·§5·§6·§7·§10 = 장수명(빌드 후 ADR 승격) · §8·§11 = 단수명(빌드 후 폐기).
> **work item**: `wi_260610z2z`
> **검토 이력**: dialectic-1 (2026-06-10, verdict=revise → required_edits 5건 반영 완료. Opponent=codex/gpt-5-codex. 기록: `.ditto/local/work-items/wi_260610z2z/reviews/dialectic-1.{json,md}`)

---

## 1. 기능

- **이름**: `ditto:tech-spec` (사용자 호출 스킬)
- **층위**: `deep-interview`와 같은 사용자 표면 층위. 대체재가 아니라 보완재.

## 2. 요약

PATTERN 1(문서 선행 작성형) 사용자가 혼자 작성하던 에이전트용 브리핑 문서를, **에이전트가 ACG·메모리·코드베이스 조사를 바탕으로 공동 작성**하는 표면. 사용자는 하려는 일·문제·컨설팅 질문을 던지고, 에이전트가 답하면서 규격화된 테크스펙 문서를 쌓아 올린다. 작성 리듬은 매개변수로 고른다 — **증분 모드**(기본: 섹션마다 작성→리뷰→반영 반복, 인지 비용 최소화) 또는 **일괄 모드**(전체 초안을 한 번에, 시간 비용 최소화). 이 문서가 **유일한 원본(source)**이며, `intent.json`은 finalize 시점에 문서로부터 컴파일되는 산출물이다. 의도 수준 모호성을 만나면 `deep-interview`를 내부 호출하고, 인터뷰 과정·결과를 문서에 기록해 사용자에게 투명하게 공개한다.

```
/ditto:tech-spec 시작 — 작성 모드 선택: 증분(기본) | 일괄
  → 컨설팅 (사용자 질문 ↔ 에이전트가 ACG·메모리·코드로 자답)
  → [증분 모드] 섹션 단위 작성 (요약 → 배경 → 목표 → 비목표 → AC → 위험 → …)
       · 에이전트 작성 → 사용자 리뷰·피드백 → 반영 (필요 시 반복) → 다음 섹션
  → [일괄 모드] 전체 초안을 한 번에 작성 → 통합 리뷰 1회 (사용자가 생략 가능)
  → 두 모드 공통
       · 비목표·AC 작성 시 pre-mortem 수행 → §위험에 누적
       · 의도 모호성 감지 → deep-interview 내부 호출 (기존 진입 조건 그대로)
            → 인터뷰 과정·결과를 문서 "인터뷰 기록" 섹션에 기록
  → finalize (tech-spec 전용 명령 — IntentStore·bootstrapAutopilot 모듈 재사용)
       · 인터뷰가 발생했으면 그 readiness 게이트 통과가 선행 조건 (우회 없음)
       · 사용자 의도 확인(2차 게이트)은 인터뷰 발생 여부·모드와 무관하게 필수
       → 문서에서 intent.json 컴파일 + source_digest 스탬프
       → autopilot 부트스트랩
```

## 3. 배경 [장수명]

### 3-1. 팀 사용 패턴 조사에서 드러난 공백 (`USER_PATTERN.md`)

- **PATTERN 1**(사람이 문서 작성 → 에이전트 구현): 의도 적중률은 가장 높지만 — 사람 피로 극심, 작성자 역량에 품질 좌우, 사람 컨텍스트 편향으로 에이전트가 편향 출발, 사람이 놓친 부분은 채워지지 않음, 테스트·DoD 부재.
- PATTERN 1~3 공통: 검증·리뷰 체계 부재, 의도 캡처가 사람 역량 의존, 세션 위생 개념 부재.

### 3-2. deep-interview만으로 부족한 이유

1. **산출물이 인간 친화적이지 않다.** 산출물은 `interview-state.json`·`intent.json`·`autopilot.json` 전부 스키마 검증 JSON이고, 사용자에겐 짧은 요약 블록만 노출된다(`skills/deep-interview/SKILL.md:127-144`). 사람이 읽고 교정·합의할 수 있는 문서 형태가 없다.
2. **코드베이스 이해를 사용자에게 투영하는 표면이 없다.** ACG·메모리로 에이전트의 코드베이스 이해는 가능해졌지만, 그것을 사람 언어로 합성해 문서에 채워 주는 표면이 없어 사용자가 여전히 코드베이스·프로젝트 컨텍스트를 직접 파악해야 한다. (`/ditto:memory-graph`는 그래프 질의 표면이지 문서 합성 표면이 아니다.)
3. **일괄 산출은 사람의 리뷰를 무력화한다.** 에이전트가 한 번에 많은 양을 쓰면 사용자의 인지 비용이 급증하고 리뷰 품질이 떨어진다(인간의 집중력 한계). 산출물은 단계적으로 공개하거나 증분으로 쌓아야 올바른 사용자 리뷰가 가능하다.

### 3-3. 선례

GSD(`open-gsd/gsd-core`)는 `spec-phase`(소크라테스식 스펙 정제)·`discuss-phase`를 별도 표면으로 두었다(`reports/harnesses/get-shit-done.md`). 단 GSD에는 "사람이 소비하는 문서 = 이해 동기화 매체"라는 각도가 없다 — 이 부분이 tech-spec의 차별점이다.

## 4. 목표

1. **작성 비용 절감**: PATTERN 1 사용자가 혼자 쓰던 브리핑 문서를 에이전트가 공동 작성한다 (시간·노력·피로 감소).
2. **구체적 범위·스펙 정의**: 변경 경계(비목표)·완료 조건(AC)·위험이 명시된 규격 문서를 만든다 — deep-interview의 목적(의도 발굴)이 다루지 않는 영역.
3. **이해 동기화**: 문서가 사람과 에이전트가 같은 이해 위에 서는 매체가 된다. 인터뷰 과정·결과 공개로 사용자가 ditto의 의도 파악 수준을 투명하게 본다. 단 이 주장은 리뷰가 수행된 섹션에 한해 성립한다 — finalize 산출물의 섹션별 리뷰 커버리지 기록(§8)이 그 경계를 증거로 남긴다.
4. **맹점 보완**: 작성 과정 곳곳의 pre-mortem으로 **사용자가 놓치고 있는 지점**을 에이전트가 발굴해 문서에 채운다 — PATTERN 1의 "사람이 놓친 부분은 채워지지 않는다" 단점의 직접 해소.
5. **무손실 실행 연결**: 합의된 문서가 intent.json으로 컴파일되어 autopilot 실행 계약으로 끊김 없이 이어진다.
6. **규격화**: 문서 내용을 일정 수준으로 관리하고, 패턴화된 구조로 사용자의 이해 비용을 낮춘다.
7. **리뷰 비용 선택권**: 작성·리뷰 리듬을 사용자가 모드 매개변수로 고른다 — 증분(기본, 인지 비용 최소화) / 일괄(시간 비용 최소화, 리뷰가 많이 필요 없거나 생략하고 싶을 때). 타자(에이전트)가 쓴 글의 리뷰는 "왜 이런 내용인가·정확한 판단인가"를 매번 따져야 해서 본인 글보다 피곤하다 — 그 비용을 시스템이 일방적으로 정하지 않는다.

## 5. 비목표 (변경 경계) [장수명]

- **deep-interview 대체·변형 아님.** 목적(정확한 의도 파악 + 숨겨진 의도 발굴)·계약·게이트·질문 예산·finalize 동작 전부 무변경(zero diff)이다. `source_digest`는 deep-interview가 아니라 intent.json 공유 스키마의 optional 필드로 추가(additive)되며, 쓰는 주체는 tech-spec 전용 finalize다.
- **intent.json 손편집·양방향 동기화 없음.** 문서 → intent.json 단방향 컴파일만 존재한다. 동기화 작업 자체가 설계상 없다.
- **리뷰 게이트의 완전 제거 없음.** 일괄 모드에서 문서 리뷰는 통합 1회로 줄이거나 사용자가 생략할 수 있으나, finalize의 사용자 의도 확인(deep-interview 2차 게이트)은 모드와 무관하게 생략 불가다. 또한 일괄 모드를 기본값으로 두지 않는다 — 기본은 증분, 일괄은 명시적 선택.
- **사용자 표면 대량 확장 아님.** 사용자 호출 표면은 스킬 1개 + 문서 템플릿 1개로 캡핑한다 — GSD식 다명령 표면(67 commands)을 따라가지 않는다. 단 내부 메커니즘의 총 범위는 그보다 크며 이를 숨기지 않는다: record-section CLI 상태기계, 전용 finalize 컴파일러, digest 검사 게이트, hook 보조 게이트(§8). 공수·마일스톤 판단은 이 총 범위 기준으로 한다(dialectic-1 obj-2).
- **특정 제품 고유 내용 포함 금지.** 초기 BOXWOOD 예시에서 온 제품 고유 내용(`apps/process-assets`, PA-번호, Confluence 섹션 대응)은 템플릿 일반화 시 제거한다.
- **작은 가역적 요청에 강제 안 함.** deep-interview와 같은 원칙(작은 요청을 무거운 워크플로로 승격하지 않는다)을 따른다.

## 6. 완료 조건 (Acceptance Criteria)

> 관찰 가능한 술어 + evidence 종류(`test|diff|doc|browser|log`). 구현 work item에서 AC당 design→implement→verify로 전개한다.

| id | 완료 조건 (관찰가능 술어) | evidence |
|---|---|---|
| ac-1 | `/ditto:tech-spec` 호출 시 일반화된 규격 템플릿 기반 문서가 생성되고, BOXWOOD 고유 용어가 템플릿에 존재하지 않는다 | test |
| ac-2 | 증분 모드(기본)에서 문서는 섹션 단위로 작성되며, 각 섹션은 사용자 리뷰·피드백(필요 시 수정 반복)을 거쳐 확인된 뒤에만 다음 섹션으로 진행한다 | log |
| ac-3 | 비목표·AC 섹션 작성 증분마다 pre-mortem("출시 3일 뒤 깨진다면 원인은?")이 수행되고, 그 결과가 문서 위험 섹션에 누적 기록된다 | log |
| ac-4 | 의도 수준 모호성이 deep-interview 진입 조건을 충족하면 deep-interview가 내부 호출되고, 인터뷰 과정·결과가 문서 "인터뷰 기록" 섹션에 기록된다 | log |
| ac-5 | finalize 시 intent.json이 문서로부터 컴파일되어 `acceptance_criteria`가 문서 AC 섹션과 1:1 대응하고 `source_digest`(원본 문서 해시)가 포함되며, 필수 섹션 누락·중복 AC id 시 컴파일이 거부된다 | test |
| ac-6 | finalize 이후 digest 범위에 포함된 섹션이 수정되면 불일치가 감지되어 autopilot 실행이 차단되고 재-finalize가 요구된다 | test |
| ac-7 | deep-interview의 기존 계약 테스트가 변경 없이 전부 통과한다 (불변 보장) | test |
| ac-8 | 일괄 모드를 매개변수로 명시 선택하면 전체 초안이 한 번에 작성되고 통합 리뷰 1회가 제안된다. 이때도 pre-mortem(ac-3)과 finalize 의도 확인은 동일하게 수행된다 | log |
| ac-9 | 코드베이스·프로젝트 사실을 담는 섹션(배경·영향도 등)의 기록 명령은 근거 조회 증거(memory query의 projection_id 또는 ACG 산출물 경로)가 스키마 필수이며, 증거 없이 호출하면 거부된다 | test |
| ac-10 | 모호성이 감지되지 않은(인터뷰 미발생) 요청에서도 finalize가 성립하며 deep-interview 진입 조건을 위반하지 않는다(강제 진입 없음). 인터뷰가 발생한 경우 그 readiness 게이트 통과 없이는 finalize가 거부된다 | test |

## 7. 위험 / Pre-mortem

> "출시 후 3일 만에 깨진다면 원인은?" → 처리.

| 위험 | 처리 | 플래그 |
|---|---|---|
| 스펙 질문("어느 테이블? 어떤 필드?")을 사용자에게 묻기 시작 → QuestionGate 규율 붕괴 | 스펙 질문은 코드·문서로 자답하고, 사용자에게는 **증분 리뷰**(확인)만 요청한다는 규칙을 스킬 계약에 명시 → ac-2 | — |
| digest가 과민(오타 수정에도 autopilot 차단) → 사용자가 검사를 우회하기 시작 | digest 범위·정규화 설계를 §8 힌트로, 동작은 ac-6으로 고정 | — |
| pre-mortem이 형식적 1회 수행으로 퇴화 → 맹점 보완 목표 미달 | 증분 트리거(비목표·AC 작성 시마다)를 계약화 → ac-3 | — |
| 인터뷰 기록 섹션이 비대해져 문서의 인간 친화성을 해침 | 기록은 요약 + 원본 링크(interview-state.json) 구조로 → §8 힌트 | — |
| 템플릿이 무거워 PATTERN 2 성향 사용자가 외면 | 작은 요청 비강제(§5) + 진입 조건을 스킬 description에 명시 | — |
| 일괄 모드가 사실상의 기본처럼 쓰여 리뷰가 형해화 | 기본값=증분 고정, 일괄은 명시 매개변수로만(§5) + finalize 의도 확인은 모드 무관 불변 | — |
| **비가역성**: 신규 표면 + additive 스키마 필드만. 데이터 손실·기존 계약 파괴 없음 | — | irreversible=false |

## 8. 계획 (Plan) [단수명]

> ⚠ **비구속(non-binding) 설계 힌트.** 구현 시 참고만 하며 더 나은 설계로 대체할 수 있다. 권위 있는 계약이 아니다.

- **스킬**: `skills/tech-spec/SKILL.md`. 흐름은 §2 다이어그램. 분업은 deep-interview와 동형 — 스킬(프롬프트)=절차·판단(soft), CLI=상태기계·스키마·게이트(hard).
- **에이전트 위임**: 컨설팅·조사(코드 탐색, memory/ACG 질의, 벌크 분석)는 subagent에 격리하고 결론·증거만 받는다(헌장 §4-9). 기존 `ditto:researcher` 계약 재사용 우선 — 전용 에이전트는 도구 권한·반환 계약이 실제로 달라질 때만 신설. 증분 작성·리뷰 루프는 사용자와의 합의 맥락을 공유하므로 메인 세션에 남긴다(분할 금지).
- **모드 매개변수 모양**: `/ditto:tech-spec --mode=stepwise|oneshot` (가칭, 기본 `stepwise`). 모드는 작성·리뷰 리듬만 바꾼다 — pre-mortem·deep-interview 진입 조건·finalize 게이트는 모드 불변. 일괄 초안 후 특정 섹션만 증분 리듬으로 재수정하는 혼합 사용도 허용(수정 요청 단위로 모드 적용).
- **ACG/Memory 사용 강제(ac-9) 메커니즘**: 호스트에는 스킬 자동 발동(푸시)이 없으므로 **fail-closed 게이트(풀)**로 뒤집는다 — "발동을 강제"가 아니라 "발동 증거 없이는 진행 불가". 2층: (1) 1차는 deep-interview와 동형의 CLI 상태기계 — `ditto tech-spec record-section`(가칭)의 스키마 필수 필드로 근거 증거(memory query 응답의 projection_id/freshness, ACG 산출물 경로)를 요구하고 누락 시 거부. (2) 보조로 기존 훅 인프라(`ditto hook pre-tool-use|stop`) — 스펙 문서 Write 시 해당 work item의 근거 조회(memory usage 계측 ∨ ACG 산출물 존재)가 전무하면 차단(ac-9의 허용 집합과 동일 신호 — dialectic-1 obj-9 정합화). 판정 신호는 신규 구현 없이 기존 `ditto memory usage`(work item별 opportunity/attempt/hit/actionable + pull-query count, ac-12 계측) 재사용. memory 응답이 freshness를 들고 오므로 stale 프로젝션 거부도 같은 게이트에서 가능.
- **강제의 정직한 한계**: 게이트가 보장하는 것은 "조회했다"까지다. "결과를 반영했다"는 record-section에 조회 결과 인용 필드를 두어 구조적 압력은 만들되, 최종적으로는 증분 리뷰(사용자)와 finalize 게이트가 잡는다.
- **템플릿**: 이 문서의 12섹션 구조를 일반화(제품 고유 내용 제거) + **"인터뷰 기록"** 섹션 추가. WHY/HOW 수명 라벨 유지.
- **SoT 모델**: manifest/lockfile 유추 — 문서 = 사람·에이전트가 편집하는 원본, intent.json = finalize만 쓰는 컴파일 산출물(현재도 finalize가 유일한 writer, `skills/deep-interview/SKILL.md:120`). 기존 memory projection 패턴(propose→approve→재투영)과 동형.
- **pre-mortem 내장 위치**: (a) 초안 작성 시 1회 — 배경·목표 초안 직후 "이 이해가 틀렸다면 어디서?", (b) 비목표·AC 증분마다 — 결과를 위험 섹션에 누적, (c) deep-interview의 finalize 전 pre-mortem은 그대로 — 문서 위험 섹션이 누적 입력이 되므로 중복이 아니라 수렴.
- **digest**: 해시 범위 = **컴파일 입력 섹션(요약·목표·비목표·AC·위험)** — 확정(2026-06-10, M3 착수 전). digest의 목적(ac-6)은 intent.json↔문서 정합 신선도이므로 보호 대상은 intent가 파생되는 섹션 자체다. 초안의 장수명 안(배경·기각 대안 포함)은 컴파일 입력이 아닌 섹션을 포함하면서 컴파일 입력인 요약·목표를 놓쳐 대체했다. 배경·계획·마일스톤·인터뷰 기록 수정은 재-finalize 불요(과민 차단 → 우회 위험 완화, §7).
- **finalize**: `ditto tech-spec finalize`(가칭) 전용 명령. deep-interview finalize는 인터뷰 상태 부재·score 미달 시 `not_ready`로 fail-closed라(`src/core/interview-driver.ts:318-328`, `src/core/gates.ts:54-71`) 무모호 요청에서 재사용이 성립하지 않는다(dialectic-1 obj-1). 대신 내부 모듈(IntentStore, bootstrapAutopilot)을 직접 재사용해 writer 단일성은 모듈 수준에서 유지한다. 게이트: 인터뷰가 발생했으면 그 readiness 통과 선행(우회 금지) ∧ 사용자 의도 확인(2차) 필수. autopilot 실행 전 digest 검사는 doctor 또는 자체 게이트.
- **문서→intent 컴파일 계약**: 섹션→필드 매핑은 이 항목의 계약을 따른다(요약·목표→`goal`/`in_scope`, 비목표→`out_of_scope`, AC 표→`acceptance_criteria`, 위험→`risk`/`unknowns`). 필수 섹션 누락·중복 AC id·스키마 불일치는 컴파일 거부(fail-closed) + 결함 위치를 사용자에게 보고. 사용자가 markdown을 편집한 뒤의 재-finalize도 동일 검증 경로를 탄다 — 우회 컴파일 경로 없음.
- **리뷰 커버리지 기록**: finalize 산출물에 섹션별 리뷰 상태(reviewed/skipped)를 기록한다. '이해 동기화·합의된 원본' 주장은 리뷰가 수행된 섹션에 한해 성립하며, 생략을 합의로 위장하지 않는다(일괄 모드 리뷰 생략 허용 자체는 사용자 결정으로 불변).
- **문서 저장 위치**: `.ditto/specs/<slug>.md` — 확정(2026-06-10, M1). 근거는 미해결 질문 1 참조.

## 9. 영향도 · 의존성

- **deep-interview**: 변경 없음(zero diff, ac-7로 보장). `source_digest`는 intent.json 공유 스키마의 optional 필드로 추가(additive)되며 tech-spec finalize만 쓴다.
- **autopilot**: 실행 전 digest 검사 게이트 추가 (ac-6).
- **knowledge-update**: 빌드 후 WHY→ADR 승격 경로 재사용 (신규 없음).
- **ACG / memory-graph**: 컨설팅·조사 단계의 소비자 (변경 없음). ac-9 게이트의 판정 신호로 기존 `ditto memory usage` 계측(ac-12)을 읽기 전용 재사용.

## 10. 기각된 대안 [장수명]

- **deep-interview에 병합 (표면 하나 + 산출물·질문 확장)** → 기각. 근거 셋: (1) 진입 조건 모순 — deep-interview는 "모호성 없으면 진입 금지"인데 스펙 문서는 의도가 명확할 때도 필요, (2) 대화 방향이 반대 — 인터뷰는 에이전트가 묻고 사용자가 답함 / 스펙 작성은 에이전트가 초안 쓰고 사용자가 확인함, (3) readiness 게이트·질문 예산(cap=8)이 모호성 수렴용으로 튜닝되어 스펙 완성도 측정에 부적합. 병합하면 본래 목적(의도 발굴)이 희석된다.
- **문서·intent.json 대등 이중 SoT** → 기각. 양방향 동기화 비용이 구조적으로 발생. 단방향 컴파일 + digest 신선도 검사로 대체.
- **순차 파이프라인 (tech-spec 산출물 → deep-interview 후행 실행)** → 기각(초기 제안에서 정제됨). 모호성은 문서 작성 *중에* 발견되므로 그 시점에 인터뷰가 끼어드는 합성이 자연스럽다. intent.json writer 단일성은 finalize 명령이 아니라 코드 모듈(IntentStore) 수준에서 유지한다.
- **deep-interview finalize 1차 게이트 분기(readiness ∨ 문서 리뷰 증거)** → 기각(2026-06-10, dialectic-1 edit-1의 선택지 (a)). deep-interview 게이트의 의미 변경은 §5의 불변조건(목적·계약·게이트 무변경 — 사용자 명시 요구) 위반. 전용 finalize(선택지 (b))가 모듈 재사용으로 동등 효과를 내면서 불변조건을 지킨다.
- **이름 `brief`** → 기각(사용자 결정). 현황 파악 뉘앙스가 강해 "스펙을 결정한다"는 기능 목적과 불일치. `tech-spec`은 기존 논의의 용어("테크스펙")와 일관.
- **원샷(일괄) 작성 전면 금지 (이 문서 초안 v1의 비목표)** → 기각(사용자 결정, 2026-06-10). 리뷰가 많이 필요 없거나 생략하고 싶은 상황에서 시간 비용을 줄일 합리적 경로가 필요하고, 금지하면 사용자가 표면 밖에서 우회한다. 일괄을 명시적 opt-in 모드로 양립시키되, 기본값=증분과 finalize 의도 확인 불변으로 리뷰 형해화를 막는다(§5·§7).

## 11. 마일스톤 [단수명]

| 단계 | 산출물 |
|---|---|
| M1 | 일반화 템플릿 + 스킬 표면 (모드 분기 + 증분 작성 루프 + pre-mortem 내장) — ac-1/2/3/8 |
| M2 | deep-interview 합성 호출 + 인터뷰 기록 섹션 — ac-4/7 |
| M3 | finalize 컴파일 + source_digest + autopilot 게이트 — ac-5/6 |

## 12. 빌드 후 처리

- **ADR 승격(잔존)**: §3·§5·§6·§7·§10 → "tech-spec 표면: 문서=source / intent.json=컴파일, deep-interview는 합성(불변), pre-mortem 증분 내장" 결정을 ADR 1장으로 (`ditto:knowledge-update`).
- **폐기**: §8 계획·§11 마일스톤 → 코드가 SoT가 되면 archived.
- **링크**: `wi_260610z2z` ↔ 이 문서 ↔ 생성 ADR 상호 링크.

---

## 미해결 질문

1. ~~**스펙 문서 저장 위치**~~ — **확정(2026-06-10, M1): `.ditto/specs/<slug>.md`, ADR-0012 tier ②(프로젝트 전역, git 추적).** 근거: ① 문서 목적(사람·팀 합의 매체)이 tier ② 정의("git으로 팀과 공유해야 하는 결정 메모리")에 부합, ② D1 선례(`.ditto/` 직속 knowledge/·agents/·architecture-spec.json)와 동일 패턴, ③ D2의 `.ditto/.gitignore`가 `local/`만 무시하므로 specs/는 추가 변경 없이 자동 추적, ④ D3 배포 조립(dist/plugin)에 스펙 인스턴스가 안 들어가고 템플릿만 제품 표면(skills/tech-spec/)으로 배포되어 층이 분리. 기각: `.ditto/local`(커밋 안 되어 합의 매체 불성립), repo 가시 디렉터리(ditto 관리 경로 규약 위반 + 사용자 repo 루트 오염).
2. ~~**digest 해시 범위**~~ — **확정(2026-06-10, M3 착수 전): 컴파일 입력 섹션(요약·목표·비목표·AC·위험)만 해시.** 근거는 §8 digest 항목 참조. ac-6의 술어("digest 범위에 포함된 섹션")는 범위 중립이라 문구 변경 불요 — §8 힌트와 이 항목만 동기 갱신(dialectic-1 obj-4 이행).
3. **경량 모드 필요 여부** — 12섹션이 부담스러운 중간 크기 작업용 축약 템플릿을 둘 것인가, 아니면 §5의 비강제 원칙으로 충분한가.
