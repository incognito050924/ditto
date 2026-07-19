# coverage — far-field pre-mortem 커버리지 택소노미 관리 + 이탈(escape) 피드백 루프

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준 커밋 `c2d2e16`, 작성일 2026-07-19.

---

## 1. 이 기능이 실현하려는 설계 의도 (개념)

`ditto coverage`는 **far-field pre-mortem 커버리지 엔진의 "택소노미"와 "학습 루프"를 관리하는 사용자 표면**이다. 엔진 본체(각 카테고리를 sweep하고 종료를 판정하는 부분)는 이 커맨드가 아니라 plan-stage의 autopilot 루프(`coverage-loop.ts`)가 돌린다. 이 커맨드는 그 엔진이 소비하는 **카테고리 집합(택소노미)을 프로젝트별로 조정**하고, 엔진이 놓친 실패(이탈, escape)를 **되먹여 택소노미를 키우는 loop의 CLI 진입점**이다.

풀려는 문제:

- pre-mortem sweep의 판정자(judge)가 "우연히 떠올린 위험"만 보면, 시딩된 적 없는 간접 영향 분야(far-field — 기능적으로 먼 feature·환경·인증·타 도메인 결합)를 영영 안 보고도 종료할 수 있다(false-green). 이를 막으려고 코드에 **항상 켜지는 카테고리 floor**(probing-question lens의 목록)를 두고, 종료를 "모든 카테고리가 명시적으로 다뤄짐"으로 재정의했다(ADR-0023).
- 그런데 floor는 코드 기본값(built-in)이라 프로젝트마다 딱 맞지 않는다. 어떤 프로젝트는 인가 모델이 다르고, 어떤 도메인은 규제가 없다. 그래서 코드를 안 고치고 **git-tracked tier-② 설정(`.ditto/coverage-taxonomy.json`)으로 카테고리를 켜고·끄고·추가·리라우트**할 수 있게 했고, 그 조작을 `coverage list/add/disable/reroute`가 담당한다.
- floor가 놓친 도메인은 두 방향으로 메운다. 사전 방향은 `coverage discover`(코드베이스를 스캔해 빠진 카테고리를 발굴), 사후 방향은 `coverage feedback/residual/propose/suggest`(실제 이탈을 기록·집계해 증강 후보를 제시).

DITTO 4축(의도/오케스트레이션/E2E/지식) 중 이 기능은 **오케스트레이션 축의 품질 게이트**에 속한다 — autopilot plan-stage의 pre-mortem sweep이 무엇을 봐야 하는지(택소노미)와 무엇을 놓쳤는지(피드백)를 관리하기 때문이다. (추론: 4축은 CLAUDE.md 투영 기준. 이 문서 확인 범위에서 별도 축 태깅 코드는 없음 — 미확인.)

---

## 2. 코드 위치와 진입점

진입: `src/cli/index.ts:14,68` — `coverageCommand`를 최상위 `coverage`로 등록.

| 파일 | 역할 |
|---|---|
| `src/cli/commands/coverage.ts` | 9개 서브커맨드 정의(citty). 얇은 표면: 검증·core 호출·렌더링만. |
| `src/schemas/coverage.ts` | zod 스키마 SoT(ADR-0002) — coverageNode/Map, disposition, taxonomyConfig, feedback ledger row, oracle claim/verdict. |
| `src/core/coverage-taxonomy.ts` | 카테고리 floor(23개)·`resolveTaxonomy`(floor∪tier-② 병합)·`loadFarFieldTaxonomy`(I/O)·`applyTaxonomyMutation`(write-back)·`farFieldCoverageNodes`(노드 시딩). |
| `src/core/coverage-discovery.ts` | `admitDiscoveredCategories` — 발굴 후보의 결정적 게이트(evidence-bound + gap-only). |
| `src/core/coverage-feedback.ts` | `CoverageFeedbackLedger`(append-only jsonl)·`attributeCoverageEscape`(구조적 귀속 GUARD)·`suggestCoverageFeedback`·`recurrenceCounts`·`recordResidual`. |
| `src/core/coverage-store.ts` | `CoverageStore` — 작업항목별 `coverage.json`/provenance 사이드카 read/write(스키마 검증+atomic). |
| `agents/coverage-discovery.md` | 코드 스캔으로 빠진 카테고리를 근거와 함께 제안하는 host 위임 서브에이전트(제안만, 결정은 게이트). |
| `agents/relevance-judge.md` | 변경마다 관련 카테고리를 이진 판정하는 서브에이전트(skip 제안만, 결정은 게이트+refute). |

서브커맨드(`coverage.ts:902-912`):

| 서브커맨드 | 그룹 | 하는 일 | 상태 변경 |
|---|---|---|---|
| `feedback --wi --category --evidence` | 사후 루프 | 이탈을 depth/breadth로 귀속하고 ledger에 1행 기록 | 쓰기(수락 시) |
| `residual --wi --category --evidence` | 사후 루프 | far-field 아닌 잔여-위험 행을 같은 ledger에 기록 | 쓰기 |
| `propose [--wi]` | 사후 루프 | ledger를 읽어 카테고리별 증강 후보(lens+evidence+fault+재발수) 출력 | 읽기 전용 |
| `suggest --wi [--node]` | 사후 루프 | verify 실패가 커버리지 miss일 수 있을 때 `feedback` 템플릿 제시 | 읽기 전용 |
| `list` | 택소노미 | effective 택소노미 출력(floor/added/rerouted/disabled 표시) | 읽기 전용 |
| `add --id --lens [--disposition]` | 택소노미 | 프로젝트 카테고리를 tier-② override에 추가 | 쓰기 |
| `disable --id --reason` | 택소노미 | floor 카테고리를 이 프로젝트에서 끔(사유 필수) | 쓰기 |
| `reroute --id --disposition` | 택소노미 | 카테고리의 disposition 라우트 변경 | 쓰기 |
| `discover [--file] [--confirm]` | 택소노미 | host 생산 후보를 게이트, `--confirm` 시 admit을 추가 | 읽기 전용(기본)/쓰기(`--confirm`) |

모든 서브커맨드는 `--output human|json`을 받고, exit code 규약은 usage error=65(`USAGE_ERROR_EXIT`), runtime error=1(`RUNTIME_ERROR_EXIT`)이다(`coverage.ts` 전반).

---

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

읽고 쓰는 상태 파일 두 축:

1. **택소노미 override** — `.ditto/coverage-taxonomy.json` (git-tracked, 팀 공유 tier-②). 스키마 `coverageTaxonomyConfig`(`coverage.ts:431-492`). `dittoDir(repoRoot)` 하위(`coverage-taxonomy.ts:283,401`).
2. **피드백 ledger** — `.ditto/local/coverage-feedback.jsonl` (per-developer, append-only, cross-work-item). 스키마 `coverageFeedbackEntry`(`coverage.ts:537-545`). `localDir(...)` 하위(`coverage-feedback.ts:50`).
3. (읽기만) **작업항목 coverage map** — `.ditto/local/runs/<wi>/coverage.json`. `suggest`/`feedback`이 귀속 근거로 읽음(`coverage-store.ts:25,54`).

택소노미 관리 흐름 (`add`/`disable`/`reroute`/`discover --confirm`):

```
CLI args
  → loadEffectiveTaxonomy(repoRoot)            # floor ∪ 현재 override (fail-open)
  → taxonomyUniverse 검사 (중복/미지 id 거부)
  → applyTaxonomyMutation(repoRoot, mutation)  # RAW config read → 순수 mutate → zod 검증 → atomic write
  → .ditto/coverage-taxonomy.json 갱신
```

`list` 흐름:

```
loadEffectiveTaxonomy → floor와 대조해 floor/added/rerouted/disabled 분류 → 출력만
```

발굴 흐름 (`discover`):

```
--file 또는 stdin의 후보 JSON
  → parseDiscoveryCandidates (shape 검증, 없는 필드 거부)
  → loadEffectiveTaxonomy
  → admitDiscoveredCategories(candidates, effective)   # 결정적 게이트
      · 근거 없음 → drop:no_evidence
      · 이미 커버됨 → drop:reconfirms_covered
      · 그 외 → admit
  → --confirm 있으면 admit마다 applyTaxonomyMutation(add)
  → admitted/dropped/added 출력
```

사후 루프 흐름 (`feedback`):

```
--wi/--category/--evidence
  → coverageFeedback zod 검증
  → attributeCoverageEscape(store, input)      # coverage.json을 읽고 구조적으로 판정
      · floor 카테고리 & 노드 resolved → accept depth
      · floor 아님 & map에도 없음 → accept breadth
      · routed-out / still-open / 일반 버그 → reject (아무것도 기록 안 함, exit 1)
  → 수락 시 CoverageFeedbackLedger.append(row, now)   # jsonl 1행
```

`residual`은 위 GUARD를 **건너뛰고** 곧장 `fault_kind:'residual'`로 같은 ledger에 append(`coverage-feedback.ts:166-180`). `propose`는 ledger를 읽어 far-field 이탈(depth/breadth)만 필터·그룹핑해 후보로 출력(`coverage.ts:273-324`), `suggest`는 coverage.json의 dry-closed(resolved) floor 카테고리마다 복붙 템플릿을 만든다(`coverage-feedback.ts:118-138`).

---

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

### 4-1. Probing-question lens로서의 카테고리 (명사가 아니라 질문)

각 카테고리는 바른 명사("보안")가 아니라 **sweep이 답해야 하는 질문**이다(`coverage-taxonomy.ts:26,64`의 lens). 이유: judge에게 "인증"이라는 단어를 던지면 무엇을 확인해야 하는지 모호하지만, "이 기능에 도달하는 인증 경로별로 인증이 일관·정확한가?"는 답할 수 있는 대상이 된다. 이 lens들이 sweep judge의 `cross_cutting_constraints`로 주입돼(`coverage-loop.ts:356`) 판정자가 매번 먼 도메인 전체를 본다(ADR-0023 결정 3).

### 4-2. 카테고리-완전 종료 + 정당화-close (false-green 차단)

floor 카테고리는 coverage **노드**로 시딩되고(`farFieldCoverageNodes`, `coverage-taxonomy.ts:443`), 종료는 "모든 노드가 닫힘"을 요구하므로 **미sweep 카테고리가 열려 있으면 novelty-dry만으로 종료 불가**하다(ADR-0023 결정 1). skip은 조용히 못 하고 `out_of_scope` 노드에 `close_reason`+`residual_risk`를 남겨야 한다(ADR-0023 결정 2). 트레이드오프: 신규 종료 기계장치를 만들지 않고 기존 노드트리를 per-category ledger로 재사용(얕은 추상화 회피, ADR-0023 기각된 대안 2).

### 4-3. 이진 관련성 게이트 (폭=관련 카테고리 전수)

ADR-0023의 "폭=항상 전수·불변"은 **ADR-20260625-premortem-relevance-gate**가 부분 supersede했다. 전 카테고리를 유료로 dismiss하는 비용이 1차 통증이라, 폭을 "관련 카테고리 전수"로 바꿨다 — 관련=끝까지 sweep, 무관=skip, 얕은 중간 없음. skip은 **4중 안전장치**(보수적 기본값·근거 결박·적대 refute·감사+하류 catch)를 통과해야만 가능하고, 그 집행은 에이전트 재량이 아니라 코드(`assembleRelevanceVerdicts`·`farFieldCoverageNodes`)에 있다(ADR-20260625 결정). `coverage.ts`의 관리 커맨드는 이 게이트를 직접 돌리진 않지만, 게이트가 소비하는 **택소노미의 SoT를 편집**하므로 여기에 속한다.

### 4-4. Disposition 라우팅 (누가·언제 답하나)

각 카테고리는 `code-verify`(현재 코드 대비 oracle 판정) / `user-intent`(deep-interview로 라우팅) / `runtime-post-impl`(변경 후 런타임 관찰) 중 하나로 라우팅된다(`coverage.ts:23-38`). floor는 dual-personality 카테고리를 facet-split한다(예: authorization=강제/code-verify + authorization-model=모델/user-intent). floor 카테고리는 runtime-post-impl이 없다 — 그 라우트는 tier-② 추가/override용으로만 존재(`coverage-taxonomy.ts:55-56`). `reroute`가 바꾸는 값이 바로 이 축이다.

### 4-5. Tier-② 설정을 bare `disabled: string[]`로 유지 (하위호환)

`disabled_reasons`를 `disabled`에 union-widen하지 않고 **형제 map**으로 둔 이유가 스키마 주석에 명시돼 있다(`coverage.ts:437-447`): union-widen하면 옛 ditto의 `disabled: string[]` 스키마가 전체 config safeParse에 실패해 **모든 override를 fail-open으로 날린다**. bare id[]를 유지하면 옛 스키마는 id만 읽고 reason은 무시한다. `.passthrough()`(`coverage.ts:475`)도 같은 목적 — 모르는 키를 read-mutate-write 왕복에서 보존.

### 4-6. Discover는 evidence-bound + gap-only, 그리고 PROJECT-scoped

`admitDiscoveredCategories`는 후보를 두 규칙으로만 거른다: 근거(file:line 또는 의존성 참조) 없으면 drop, 이미 커버된 도메인이면 drop(`coverage-discovery.ts:126-157`). "이게 정말 새 도메인인가"의 의미 판단은 host 에이전트 몫이고 코드는 구조적 floor만 집행(ADR-0001 — ditto는 provider 직접 호출 안 함). 중요한 설계 선택: 이 게이트는 **작업항목 coverage.json을 안 읽는다**(project-scoped). WI-scoped `attributeCoverageEscape`를 재사용하면 "이 WI 맵에 안 시딩됨"으로 진짜 gap을 blanket-reject하기 때문(`coverage-discovery.ts:23-31`).

---

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

### `resolveTaxonomy` (coverage-taxonomy.ts:246-270)

입력: floor + tier-② config. 하는 일: `disabled` id 제거, `added` 추가, 충돌 id는 lens override. **disposition은 부분 override**(lens override와 달리 whole-object 교체가 아님) — added 엔트리가 disposition을 안 적으면 floor의 것을 상속(`:262`). 효과: lens를 갈아끼워도 라우팅 결정이 조용히 사라지지 않음. 우선순위: `added.disposition > config.dispositions[id] > floor.disposition > 없음(=default)`.

### `loadFarFieldTaxonomy` (coverage-taxonomy.ts:279-296) + `warnMalformedTaxonomy`

파일 부재 또는 malformed → **floor로 fail-open**하되 `onMalformed` 콜백으로 경고(`coverage.ts:438`의 `loadEffectiveTaxonomy`가 배선). 숨은 의도: malformed config가 조용히 built-in으로 복귀하면 "아무것도 안 한 것처럼" 보이는 zero-signal fail-open — 그걸 막으려 read 측이 경고를 낸다(`coverage-taxonomy.ts:298-310`).

### `applyTaxonomyMutation` (coverage-taxonomy.ts:397-408) — fail-CLOSED write

`readRawTaxonomyConfig`(RAW object로 읽어 unknown key 보존) → `mutateRawConfig`(순수, idempotent 상향 upsert) → `coverageTaxonomyConfig.safeParse` → **성공해야만** `atomicWriteText`. 효과: malformed 후보는 throw되고 이전 유효 config는 손대지 않음. read는 fail-open(경고+floor), write는 fail-closed(throw) — 비대칭이 의도적이다(읽을 땐 floor로라도 계속, 쓸 땐 나쁜 걸 절대 안 남김). `readRawTaxonomyConfig`도 손상된 기존 파일이면 조용히 clobber하지 않고 throw(`:339-355`).

### `taxonomyUniverse` 가드 (coverage.ts:448-453)

floor id ∪ effective id. `add`는 이 집합에 **이미 있는** id를 거부(중복 id는 두 coverage 노드를 같은 id로 시딩해 first-match 조회를 깨뜨림, sweep #6), `disable`/`reroute`는 이 집합에 **없는** id를 거부(오타 id를 조용한 no-op으로 두지 않음, sweep #4). floor id는 상수에서 오므로 **disabled된 floor id도 여전히 known**으로 취급(`:449-451`) — 껐다가 다시 켤 수 있음.

### `attributeCoverageEscape` (coverage-feedback.ts:223-269) — gate ↔ score 일치

작업항목 coverage.json 하나를 읽고 accept 여부와 `fault_kind`를 **같은 상태에서** 도출:
- floor 카테고리 & 노드 `resolved`(dry-close됐는데 깨짐) → `depth`(under-probed).
- floor도 아니고 map에도 없음 → `breadth`(floor가 시딩 안 한 도메인).
- routed-out 카테고리 → reject(수신 게이트 이탈이지 missing lens 아님 — breadth로 받으면 라우팅이 제거한 lens를 재추가 제안하는 셈, `:253-259`).
- still-open floor 노드 / 일반 버그 → reject, 아무것도 기록 안 함.

효과: 게이트(수락?)와 점수(fault_kind)가 한 map+floor 쌍에서 나오므로 재판단으로 갈라지지 않음. CLI(`coverage.ts:104-111`)는 수락됐는데 fault_kind가 없으면 방어적으로 기록 거부.

### `CoverageFeedbackLedger.append` (coverage-feedback.ts:59-70)

`recorded_at`을 **호출자가 주입**(`coverage.ts:120`의 `new Date().toISOString()`) — 클록을 core 밖에 둬 결정성 유지 + `Date.now()`를 막는 샌드박스에서도 기록 가능. read-existing→append-one→atomic full rewrite(동시 writer는 v0에서 유예, `:44`). `readAll`은 파싱 실패 시 file:line 컨텍스트와 함께 throw(fail-closed — 손상된 ledger는 조용히 skip 안 함, `:82-88`).

### `suggestCoverageFeedback` (coverage-feedback.ts:118-138)

coverage.json의 `resolved`인 floor 카테고리 노드만 골라 `depth` 템플릿 생성. `attributeCoverageEscape`가 accept하는 shape(resolved floor→depth)만 미러링해 **suggest와 실제 feedback accept가 갈라지지 않게** 함(gate↔score, `:112-116`). still-open/skipped는 dry-closed 이탈이 아니라 제외.

### `admitDiscoveredCategories` (coverage-discovery.ts:126-157)

`citesCode`(`:101-105`)가 evidence를 공백 분리해 각 토큰을 `codePointerMapsTo`(file:line 문법 재사용) 또는 `DEPENDENCY_REF_RE`(scoped 패키지)로 shape-test — prose 속 인용도 통과, 순수 산문은 탈락. `covered` 집합 = effective id ∪ routed-out id(`:130-133`). 후보마다 **evidence 없음 먼저(outer)**, 다음 gap 검사. 모든 후보에 verdict를 하나씩 반환(admit이든 drop이든) — drop도 machine reason과 함께 감사 가능.

---

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위: `coverage.ts`(9 서브커맨드) + import한 core 4개 모듈 + 스키마 + ADR-0023/ADR-20260625. 엔진 본체(`coverage-loop.ts`/`coverage-manager.ts`/`coverage-relevance.ts`/`coverage-oracle.ts`)는 seam(`loadFarFieldTaxonomy`/`farFieldLenses`/`farFieldCoverageNodes` 소비, `coverage-loop.ts:297,310,356`)만 확인.

일치하는 것:

- 택소노미 편집(add/disable/reroute) → `applyTaxonomyMutation` 하나의 write path → fail-closed·atomic·idempotent(주석·코드 일관, `coverage-taxonomy.ts:390-408`).
- gate↔score 일치가 두 곳(`attributeCoverageEscape` 수락shape ↔ `suggestCoverageFeedback` 미러, `feedback` CLI가 fault_kind 없으면 거부)에서 방어적으로 유지됨.
- discover가 project-scoped라 진짜 gap을 blanket-reject하지 않음(주석 의도대로, `coverage-discovery.ts:23-31,146-154`).

갭·미확인:

- **카테고리 수 drift(문서 vs 코드):** `FAR_FIELD_TAXONOMY_FLOOR` 배열은 23개(`coverage-taxonomy.ts:61-177`, 주석도 "23 floor categories" `:40`). 그러나 ADR-0023 §far-field 자동화 보류의 비용 모델은 "19-카테고리 floor"로 외삽하고 라이브 e2e도 "19 카테고리 시딩"이라 기록(ADR-0023 §46~48,68). ADR 수치가 오래된 것으로 보임 — **코드가 권위(23)**, ADR 비용 외삽은 stale. (권위=코드, 정합성 미확인.)
- **동시 writer:** ledger(`coverage-feedback.ts:44`)와 tier-② config write는 동시 writer를 유예(v0). 동시 세션이 같은 ledger/config에 쓰면 last-write 손실 가능 — 코드가 명시적으로 인정(미해결).
- **discover 입력의 host 위임:** `agents/coverage-discovery.md`가 후보를 생산하지만 CLI는 `--file`/stdin JSON만 소비한다. 에이전트↔CLI를 잇는 자동 배선(skill 노드)은 이 문서 확인 범위 밖 — 미확인.
- **엔진 본체 정합:** `coverage list`가 출력하는 effective 택소노미가 실제 plan-stage sweep이 시딩하는 것과 같은 `loadFarFieldTaxonomy` 결과인지는 seam 공유(`coverage-loop.ts:297`)로 코드상 성립하나, 라이브 실행으로는 미검증.

---

## 7. 잠재 위험·부작용·재설계 시 고려점

**재설계 시 반드시 보존해야 할 불변식:**

1. **false-green 차단 3층 — 카테고리-완전 종료 + 정당화-close + 이진 관련성 게이트.** ADR-0023이 막은 "미시딩 도메인 silent miss"와 ADR-20260625의 4중 skip 안전장치는 서로 물려 있다. 폭을 줄이는 어떤 재설계든 skip이 근거+적대검증+기록을 거치는 감사가능 skip이어야 하고, 그 집행은 코드에 있어야 한다(에이전트 재량 금지, ADR-20260625 결정).
2. **read fail-open / write fail-closed 비대칭.** malformed config가 읽을 땐 floor로 계속되되 경고를 내고, 쓸 땐 절대 안 남는다. 둘 중 하나만 바꾸면 조용한 데이터 손실(config clobber) 또는 zero-signal 복귀가 재도입된다.
3. **gate↔score 단일 상태.** `attributeCoverageEscape`가 수락과 fault_kind를 같은 map에서 뽑는 구조·`suggest`의 미러링·CLI의 fault_kind-없으면-거부. 이 셋이 갈라지면 suggest가 제안한 걸 feedback이 거부하는 모순이 생긴다.
4. **routed-out 카테고리의 특별 취급.** floor를 떠난 카테고리(`FAR_FIELD_ROUTED_OUT`, `coverage-taxonomy.ts:207-217`)는 breadth 이탈로 받으면 안 된다 — 라우팅이 제거한 lens를 재추가 제안하게 된다. discover의 `covered` 집합과 `attributeCoverageEscape`가 둘 다 이걸 반영(`coverage-discovery.ts:132`, `coverage-feedback.ts:253`).

**약점·확장 시 깨질 지점:**

- **동시성.** ledger jsonl과 tier-② config write가 last-write-wins. 멀티세션·워크트리 병렬(이 저장소가 실제로 하는 방식)에서 config override나 이탈 기록이 유실될 수 있다. 재설계 시 파일 락 또는 per-writer 병합이 필요.
- **카테고리 수 drift.** floor는 코드가 SoT지만 ADR·설계 문서가 옛 수치(19)를 들고 있다. 새 카테고리를 추가할 때 비용 외삽·문서를 함께 갱신하지 않으면 계속 어긋난다(§6 참조).
- **discover의 semantic-gap 판단은 host 몫.** 코드 게이트는 구조(근거·중복)만 본다. 에이전트가 이미 있는 도메인을 다른 이름으로 제안하면(id는 다르나 의미 중복) gap-only 게이트가 못 잡아 review noise가 된다.
- **residual vs far-field 경계.** `residual`은 GUARD를 우회해 같은 ledger에 들어가고 far-field 통계에서만 제외된다(`isFarFieldEscape`, `coverage.ts:520-535`). 이 enum이 커지면 `isFarFieldEscape`와 `recurrenceCounts`·`propose` 필터를 동기화하지 않으면 잔여 행이 far-field 비용에 새어든다(주석이 "keep in sync" 명시, `coverage.ts:519`).

**재고할 수 있는 결정:**

- ledger가 tier-③(`.ditto/local`, per-developer)라 팀 간 이탈 학습이 공유되지 않는다. 조직 차원 집계를 원하면 저장 tier를 재고(단, ADR-0021은 cross-repo 메모리를 별도 standalone 프로젝트로 이관하는 방향이므로 그 seam과 정합해야 함).
- discover의 `--confirm` 자동 추가는 admit 전부를 무비판 add한다. 대량 후보에서 사람이 개별 검토 없이 확정하면 택소노미 비대화 위험 — 개별 승인 UX를 고려할 수 있다.
