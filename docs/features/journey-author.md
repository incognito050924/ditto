# journey-author — 사용자 스토리·여정을 대화로 저작해 per-entity 파일 + 여정 DSL로 컴파일하는 커맨드

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준 커밋: `c2d2e16`, 작성일: 2026-07-19.

## 1. 이 기능이 실현하려는 설계 의도 (개념)

`ditto journey-author`는 사용자가 자기 프로덕트의 **사용자 스토리·여정(user story/journey)** 을 에이전트와의 대화로 저작하고, 그 결과를 두 가지 산출물로 컴파일하는 커맨드다.

- **per-entity 카탈로그 파일**: 여정 1개당 파일 1개(`jrn-*.json`), 스토리 1개당 파일 1개(`us-*.json`).
- **여정 DSL 파일**: `e2e/journeys/<slug>.journey.md` (DSL v2).

풀려는 문제는 "E2E 테스트의 *의도(WHAT/WHY)* 는 누가 소유하는가"이다. ADR-0014 D1은 **에이전트 단독 자율 테스트 작성을 금지**한다 — 에이전트는 UI/UX·기획 맥락을 담지 못해 무의미한 테스트를 만든다. 그래서 여정 의도는 사람이 선언하고, 코드 사실(surface·구현 여부 등)만 에이전트가 채운다. 이 커맨드는 그 "사람이 의도를 선언하는" 단계의 상태 기계(state machine)다.

두 진입점(entry point)이 하나의 커맨드로 통합돼 있다 (`src/cli/commands/journey-author.ts:31-34`, `journey-author.ts:70`):

- **① story→journey→E2E** (`--kind story`): 사용자 가치(스토리)를 먼저 확정하고 그것을 실현하는 여정들로 내려간다.
- **② journey→E2E** (`--kind journey`): 가치가 이미 고정돼 여정만 저작한다.

DSL을 실제 Playwright 스펙으로 변환·실행하는 일은 **범위 밖**이다. 그건 `e2e-author` 파이프라인(공식 Playwright test-generator)으로 인계된다 (ADR-0014, ADR-20260702-e2e-official-test-agents). 즉 이 커맨드의 종착점은 DSL 파일까지다.

DITTO 4축 중 **E2E(지식 축과 접점) 축**의 저작 표면에 속한다 — 근거: ADR-0014가 이 기능을 "E2E 테스트 작성" 기능으로 규정하고, 산출물이 `e2e/journeys/` DSL이다 (`ADR-0014-e2e-dsl-agent-gates.md:1`, `dsl.ts:23-45`).

## 2. 코드 위치와 진입점

핵심 파일:

| 경로 | 역할 |
| --- | --- |
| `src/cli/commands/journey-author.ts` | citty CLI 표면. 인자 파싱 + zod 검증 + core 호출 + 출력/exit code. 저작 로직 없음 (`journey-author.ts:23-34`). |
| `src/core/journey-authoring/session.ts` | 상태 기계 본체 — `startAuthoring`/`recordJourney`/`recordStory`/`finalizeAuthoring` + fail-closed 게이트 2종. |
| `src/core/journey-authoring/session-state.ts` | 워킹 버퍼 zod 스키마 (`journeyDraft`/`storyDraft`/`journeyAuthoringState`). |
| `src/core/journey-authoring/store.ts` | ADR-0005 per-entity 영속화 (`JourneyAuthoringStore`). |
| `src/core/journey-authoring/dsl.ts` | 여정 스펙 → DSL v2 마크다운 렌더 (`renderJourneyDsl`). |
| `src/core/journey-authoring/ids.ts` | slug → `jrn-`/`us-` id + DSL 파일명 결정적 파생. |
| `src/core/journey-authoring/decompose.ts` | 한 줄 의도 → 순서 있는 스텝 초안 제안(제안만, 쓰기 없음). |
| `src/core/journey-authoring/index.ts` | 배럴 export. |
| `src/schemas/acg-journey-spec.ts` | 여정 카탈로그 계약(`acgJourneySpec`) — 산출물 SoT. |
| `src/schemas/acg-story-spec.ts` | 스토리 카탈로그 계약(`acgStorySpec`). |
| `src/schemas/journey-dsl.ts` | DSL v2 front-matter 계약(`journeyFrontMatter`). |

서브커맨드 (`journey-author.ts:314-320`):

| 서브커맨드 | 필수 인자 | 하는 일 |
| --- | --- | --- |
| `start` | `--workItem`, `--kind (story\|journey)` | 워킹 버퍼 초기화. `--kind`로 두 진입점을 가른다 (`journey-author.ts:70-74`). |
| `record-journey` | `--workItem`, `--json` | 여정 초안 1개를 slug 기준으로 upsert (같은 slug면 제자리 갱신). |
| `record-story` | `--workItem`, `--json` | 스토리 초안 설정/덮어쓰기 (surface ① 전용). |
| `decompose` | `--intent` | 한 줄 의도를 순서 스텝으로 분해해 **제안**. 쓰기·자동확정 없음 (`journey-author.ts:205-239`). |
| `finalize` | `--workItem` | 버퍼를 per-entity 파일 + DSL로 컴파일. fail-closed. |

모든 서브커맨드는 `--output human|json`을 받는다 (기본 human).

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

```
start --kind        ┌───────────────────────────────────────────┐
record-journey ───► │  워킹 버퍼 (draft, pre-finalize)          │
record-story  ────► │  .ditto/local/work-items/<wi>/            │
(decompose = 제안만) │    journey-authoring-state.json           │
                    └───────────────────────────────────────────┘
                                    │ finalize
                                    ▼ (게이트 통과 후에만 write)
        ┌──────────────────────────┼───────────────────────────┐
        ▼                          ▼                           ▼
 per-entity 여정             per-entity 스토리            여정 DSL
 .ditto/local/journeys/     .ditto/local/stories/        e2e/journeys/
   <jrn-id>.json              <us-id>.json                 <slug>.journey.md
 (acgJourneySpec)           (acgStorySpec)               (journeyFrontMatter v2)
```

읽고 쓰는 상태 파일과 스키마:

- **워킹 버퍼**: `.ditto/local/work-items/<wi>/journey-authoring-state.json` — 스키마 `journeyAuthoringState` (`store.ts:79-81`, `session-state.ts:66-77`). 이건 pre-finalize 초안 버퍼이지 카탈로그가 아니다. tier ③(개발자별, gitignored) 경로다 (`ditto-paths.ts:10-13`, `store.ts:5` `localDir`).
- **여정 카탈로그**: `.ditto/local/journeys/<jrn-id>.json` — 스키마 `acgJourneySpec` (`store.ts:33-34`, `store.ts:41-49`).
- **스토리 카탈로그**: `.ditto/local/stories/<us-id>.json` — 스키마 `acgStorySpec` (`store.ts:37-38`, `store.ts:56-59`).
- **DSL 파일**: `e2e/journeys/<slug>.journey.md` — front-matter 스키마 `journeyFrontMatter` v2 (`session.ts:186`, `dsl.ts:31-44`). 이건 repo 루트(커밋 대상) 경로다.

핵심 인과: `record-*`는 초안을 버퍼에 쌓기만 하고, 실제 카탈로그·DSL 파일 쓰기는 오직 `finalize`에서만 일어난다. `finalize`는 모든 게이트를 **쓰기 전에** 통과시킨다 (`session.ts:22`, `session.ts:206`).

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

### 4-1. start → record → finalize 상태 기계

기획서/스펙 저작과 같은 "섹션을 조금씩 채우고 마지막에 컴파일" 형태다 (`session.ts:17-23`). 이유: 여정 하나를 한 번에 완성하기보다 대화하며 여러 초안을 쌓고(surface·steps·구현여부 채우기) 마지막에 일괄 검증·컴파일하는 편이 대화 저작에 맞는다. 초안 버퍼는 카탈로그(SoT)와 분리해, 미완성 상태가 카탈로그를 오염시키지 않는다 (`session-state.ts:6-13`).

### 4-2. 결정적 slug 기반 정체성 (random/timestamp 금지)

사용자가 kebab `slug`를 준다. 기계는 절대 random/timestamp id를 굴리지 않는다 (`ids.ts:1-9`). 같은 slug → 같은 `jrn-`/`us-` id → 같은 per-entity 파일 → 같은 DSL 파일명. 이것이 `finalize`를 **멱등(여러 번 실행해도 결과가 같음)** 하게 만드는 근거다 (`ids.ts:20-35`, ac-3).

### 4-3. per-entity 저장 (ADR-0005) — 공유 카탈로그 파일 없음

여정/스토리는 한 파일 = 한 엔티티다. `finalize`가 read-modify-write하는 단일 카탈로그 파일이 **없다** — 단일 파일은 worktree 병렬성 아래서 갱신을 잃는다 (ADR-0005 D1). `acgJourneySpec` "카탈로그"는 `loadAllJourneys`가 per-entity 파일을 reduce하는 **읽기 측 투영(projection)** 일 뿐, 쓰기 대상이 아니다 (`store.ts:9-21`, `store.ts:51-54`). 파일 락은 쓰지 않는다 (ADR-20260628가 기각).

### 4-4. finalize는 fail-closed — 모든 게이트가 쓰기 앞에 있다

충돌/참조 게이트가 **어떤 파일도 쓰기 전에** 전부 돈다 (`session.ts:22`, `session.ts:206` 주석 "all gates passed"). 이유: 부분 쓰기로 카탈로그가 반쯤 오염되는 것을 막는다. 게이트 2종은 §5에서 상술.

### 4-5. decompose는 제안만 (자동 물질화·자동 확정 금지)

`decompose`는 스텝 초안을 제안하지만 아무것도 쓰지 않고 자동 확정하지 않는다 (`decompose.ts:1-9`, `journey-author.ts:208-209`). 사용자가 WHAT을 소유한다는 e2e-author "No agent-invented journeys" 원칙의 집행이다. `DecomposeDraft.proposed: true`는 호출자가 이걸 확정 집합으로 오인하지 못하게 하는 구조적 표식이다 (`decompose.ts:16-22`).

### 4-6. DSL v2 — 리치 컨텍스트는 front-matter, body는 구조만

DSL v2(clean break)는 machine-validatable한 리치 컨텍스트(implementation_intent, constraints, edge/failure cases, auth/seed 등)를 front-matter로 올리고, 마크다운 body는 `N. [step_id] <intent>` 구조만 남긴다 — body 의미는 사람 저작으로 남는다(설계 경계, ADR-0014). Credential은 절대 리터럴이 아니라 env/secret 참조만 허용한다 (`journey-dsl.ts:4-17`, `journey-dsl.ts:40-46`).

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

### startAuthoring (`session.ts:50-61`)
입력: `{workItemId, kind}`. 하는 일: 빈 워킹 상태(`story:null, journeys:[], finalized:null`)를 버퍼 파일에 쓴다. 효과: 세션이 존재하게 되고 이후 `record-*`가 이 상태를 읽어 append한다.

### recordJourney (`session.ts:70-83`)
입력: `{workItemId, journey}`. 하는 일: `journeyDraft.parse(input.journey)`로 경계에서 파싱(스키마 default steps/implemented + surface 검증이 여기서 적용됨 — 전체 상태 쓰기 시점에 조용히가 아니라), slug로 findIndex해 없으면 append, 있으면 제자리 교체 (upsert). 숨은 결정: 파싱을 여기서 하는 이유가 주석에 명시 — default·검증을 boundary에 못박아 나중 write 시점의 침묵 검증을 피한다 (`session.ts:74-76`).

### recordStory (`session.ts:92-97`)
입력: `{workItemId, story}`. 하는 일: `storyDraft.parse` 후 `state.story`를 덮어쓴다. 스토리는 세션당 하나(surface ①).

### finalizeAuthoring (`session.ts:121-260`) — 핵심
1. **not_started 단락**: 세션 파일이 없으면 `{status:'not_started'}` 반환, 예외 아님 (`session.ts:126`). CLI가 이를 안내 메시지로 변환 (`journey-author.ts:263-268`).
2. **소유권 키 결정**: `ownerStoryId = state.story ? storyId(slug) : undefined` (`session.ts:130`). 스토리 세션이면 `us-…`, 여정-only면 `undefined`. 이 키가 충돌 게이트에서 "남의 파일인가" 판정 기준이 된다.
3. **여정 스펙 빌드** (`session.ts:133-163`): 각 초안 → `acgJourneySpec`. status는 `implemented ? 'awaiting_validation' : 'spec_first'` — 프로덕트 코드가 selector를 못 풀면 spec_first, 빌드됐지만 아직 E2E 미실행이면 awaiting_validation(validated는 나중 E2E run에서만) (`session.ts:142-143`, ac-6). DSL도 여기서 한 번 렌더해 두어(`session.ts:154-161`) 충돌 게이트가 기존 파일과 **바이트 단위** 비교를 하고 write가 그 결과를 재사용한다.
4. **gate 1 — 참조 여정 존재 (ac-8)** (`session.ts:167-174`): 스토리의 `reference_journey_ids` 중 이번에 만드는 것도 아니고 카탈로그에도 없는 id가 있으면 `JourneyReferenceNotFoundError`.
5. **gate 2 — id/slug 충돌 fail-closed (ac-4)** (`session.ts:177-204`): 두 갈래.
   - 기존 per-entity 파일의 `story_id`가 우리 `ownerStoryId`와 다르면 "남이 소유" 충돌.
   - DSL 파일이 이미 있으면: 파싱해 다른 `jrn-` id면 "slug 도둑맞음" 충돌; 같은 id인데 내용이 우리 결정적 렌더와 다르면 "손으로 저작된/우리 것 아닌 DSL"로 덮어쓰기 거부. **바이트 동일하면** 우리 이전 렌더 → 멱등, 충돌 아님 (`session.ts:190-201`, ac-3). 인과: 이 바이트 비교 때문에 재-finalize가 안전하고, 외부 저작 DSL을 조용히 날리지 않는다.
   - 충돌 1건이라도 있으면 전부 모아 `IdConflictError` (`session.ts:204`).
6. **writes** (`session.ts:207-214`): 게이트 통과 후에만 per-entity 여정 write + DSL `atomicWriteText`.
7. **ac-7 parent-edit supersede** (`session.ts:217-226`): 스토리 세션이면, 이 스토리가 소유하던 기존 여정 중 이번 finalize에 없는 것(= 부모 편집으로 빠진 자식)을 `status:'superseded'`로 표시. 인과: 스토리에서 여정을 뺐다는 편집이 카탈로그에 반영된다.
8. **스토리 파일 write** (`session.ts:229-249`): `journey_ids`는 새로 만든 것 + 새로 만든 것에 없는 reference들의 순서 병합.
9. **세션 마감**: `finalized:{at}` 스탬프 후 상태 재저장 (`session.ts:251`).

### renderJourneyDsl (`dsl.ts:23-45`)
입력: `{id,name,description,intent,surfaces,steps}`. 하는 일: front-matter를 `journeyFrontMatter.parse`로 검증하고 YAML로 직렬화, body는 `${i+1}. [step_id] intent`. 숨은 결정: `implementation_intent`는 저작 세션이 이미 가진 두 산문 필드에서 **파생** — `` `${description} — ${intent}` `` (`dsl.ts:37`). v2가 추가한 리치 필드(constraints/edge/failure/auth/seed)는 저작 초안에 없어 스키마 default(빈 배열/생략)로 떨어진다. 결정성: 같은 입력 → 바이트 동일 출력, 그래서 재-finalize가 같은 바이트로 덮어쓴다 (`dsl.ts:13-15`).

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위: `journey-authoring/` 7개 파일 + CLI 진입 + 3개 스키마의 정적 읽기. 테스트 실행이나 실제 `ditto journey-author` 구동은 하지 않음(미검증 — 아래 명시).

- **두 진입점이 한 커맨드**(ac-1): `--kind` 분기로 실현됨 (`journey-author.ts:70-74`, `session.ts:130`). 일치.
- **decompose 제안-only**(ac-5): 쓰기 경로 없음, `run`이 순수 함수 호출 + 출력뿐 (`journey-author.ts:219-238`). 일치.
- **finalize fail-closed**: 게이트가 모든 write 앞에 위치 (`session.ts:167-204` → `207`). 일치.
- **멱등**(ac-3): 결정적 id + 바이트 비교로 실현 (`ids.ts`, `session.ts:190-201`, `dsl.ts:13-15`). 정적 확인으로는 일치.
- **DSL→Playwright 범위 밖**: 이 코드에 Playwright 생성·실행 경로 없음. CLI 주석과 ADR이 e2e-author 인계를 명시 (`journey-author.ts:29`, ADR-20260702). 일치.

확인 범위에서 논리적 불일치는 발견하지 못함. 단, 아래는 동작으로 검증하지 않은 항목이다.

- **미검증**: `finalize`의 멱등성·게이트 거부 동작을 실제 실행/테스트로 확인하지 않았다. 테스트 파일 존재 여부·통과 여부는 이 조사 범위 밖.
- **미검증**: 워킹 버퍼가 tier ③(gitignored) 경로인데 DSL은 커밋 대상 경로다. 이 비대칭이 실사용에서 어떻게 쓰이는지(예: 초안은 개인, 산출물은 공유)는 코드로만 추론했고 실사용 확인은 못 함.

## 7. 잠재 위험·부작용·재설계 시 고려점

- **워킹 버퍼(개인, gitignored) vs 산출물(공유, 커밋)의 tier 비대칭**: 세션 상태는 `.ditto/local/`(개발자별)에 있고 (`store.ts:5`, `ditto-paths.ts:10-13`), per-entity 카탈로그도 `.ditto/local/journeys|stories/`(개인)인데 DSL만 `e2e/journeys/`(공유). 즉 카탈로그 파일 자체가 개인 tier라, 한 사람의 `finalize`가 만든 `jrn-*.json`을 다른 사람은 못 본다. 충돌 게이트가 보는 "기존 파일"은 로컬 것뿐이다. 재설계 시 카탈로그를 공유 tier로 올릴지 여부가 핵심 결정 지점 — 지금은 개인 tier라 cross-developer id 충돌을 잡지 못한다(코드로 확인한 사실이나, 이게 의도된 설계인지 갭인지는 미확인).
- **락 없는 병렬성**: ADR-0005/ADR-20260628에 따라 파일 락이 없다. per-entity atomic write가 개별 upsert의 원자성은 보장하지만(`store.ts:22-21`), `finalize`의 read(게이트)→write는 한 트랜잭션이 아니다. 같은 slug를 두 세션이 동시에 finalize하면 TOCTOU(검사-사용 시차)로 마지막 쓰기가 이긴다. 재설계 시 보존해야 할 불변식은 "단일 카탈로그 파일 금지"(ADR-0005 D1)이고, 재고 가능한 건 동시성 방어 수준이다.
- **바이트 단위 DSL 비교의 취약성**: 충돌 게이트가 기존 DSL과 우리 렌더를 `existingText !== dsl`로 비교한다 (`session.ts:192`). YAML 직렬화·개행이 조금만 달라져도 "손으로 저작됨"으로 오판해 거부한다. `renderJourneyDsl`이 digest 경로와 같은 YAML round-trip을 쓰는 이유가 이것이다 (`dsl.ts:9-12`). 재설계로 렌더러나 YAML 라이브러리를 바꾸면 기존 파일 전부가 충돌로 뜰 수 있다 — 이건 반드시 보존하거나 마이그레이션해야 할 결합점이다.
- **DSL v2 리치 필드가 저작에서 비어 있음**: constraints/edge_cases/failure_states/auth/seed가 저작 초안에 없어 항상 default(빈)로 나간다 (`dsl.ts:16-21`). 이 정보는 하류 e2e-author에서 채워야 한다. 재설계로 저작 단계에서 이것들을 받게 하려면 `journeyDraft` 스키마와 `renderJourneyDsl` 입력을 함께 넓혀야 한다.
- **decompose의 순진한 분해**: 한국어/영어 연결어 정규식(`그리고|그다음|then|and|,|→`)으로 자른다 (`decompose.ts:24-25`). 복문·중첩 의도는 잘못 쪼갠다. 다만 제안-only라 위험은 낮다(사용자가 확정). 재설계 시 이 분해를 더 똑똑하게 만들 유혹이 있으나, "제안만·사용자 확정"이라는 불변식(ADR-0014 D1)은 보존해야 한다.
