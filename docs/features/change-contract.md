# change-contract — ICL(.icl) 소스를 ChangeContract로 컴파일해 저장하고 forbidden_scope 집행의 입력을 만든다

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준 커밋: `c2d2e16` (2026-07-19).

## 1. 이 기능이 실현하려는 설계 의도 (개념)

`ditto change-contract`는 **변경을 하기 전에 "무엇을 어떻게 바꾸겠다"를 계약(ChangeContract)으로 박제**하고, 그 계약을 집행 가능한 상태 파일로 저장하는 커맨드다.

핵심 개념은 **Design by Contract를 코드 변경 자체에 적용**하는 것이다. 스키마 주석이 이를 명시한다: "ACG ChangeContract — Design by Contract applied to a change. The variable-time projection of IntentContract; a thin work-item sidecar." (`src/schemas/acg-change-contract.ts:5-6`). 즉 계약은 work item 하나에 붙는 얇은 사이드카이며, 의도(IntentContract)의 시변(時變) 투영이다.

계약이 담는 것은 두 종류의 frame condition(변경 프레임)이다:
- `allowed_scope` — 여기에 있는 path/symbol만 수정 허용 (`acg-change-contract.ts:37-40`)
- `forbidden_scope` — 반드시 건드리지 않아야 하는 것. 비어 있으면 안 됨 — "empty forbid = unbounded change"(무제한 변경) (`acg-change-contract.ts:41-44`)

이 커맨드의 존재 이유는 커맨드 자신의 주석에 있다: 계약 저장은 **"ICL 생성 → 계약 저장 → PreToolUse 집행"의 전 사슬이 돌게 하는 생성 경로**다 (`src/cli/commands/change-contract.ts:22-25`). 계약 파일이 없으면 매 도구 호출을 검사하는 PreToolUse 훅이 읽을 진실원이 없어 집행이 성립하지 않는다.

DITTO 4축 분류상 이 기능은 **거버넌스(ACG, Agentic Change Governance)** 축에 속한다. ACG는 "모든 코드베이스용 변경 거버넌스"를 목표로 하는 계층이고(`src/schemas/acg-common.ts:4-5`, ADR-0004 컨텍스트), change-contract는 그 거버넌스가 **변경 시점(change-time)에 집행 가능한 계약**을 만드는 진입점이다. 오케스트레이션(autopilot)이 아니라, 오케스트레이션이 하는 변경을 프레임으로 가두는 가드레일 쪽이다.

## 2. 코드 위치와 진입점

| 경로 | 역할 |
|---|---|
| `src/cli/commands/change-contract.ts` | CLI 진입점. `.icl` 읽기 → 컴파일 → symbol 확장 → 두 store에 저장 → 요약 출력 |
| `src/acg/icl/compile.ts` | ICL 컴파일러. AST → `{ changeContract, fitnessFunctions }` 변환 + Zod 검증 |
| `src/acg/icl/index.ts` | ICL 컴파일러 public entry (`compileIcl`, 타입 재수출) |
| `src/acg/scope/symbol-expand.ts` | forbidden_scope의 `symbol` kind를 선언 파일 path로 펴기(저장 시점 1회 CodeQL) |
| `src/core/change-contract-store.ts` | `ChangeContractStore` — 계약을 per-entity 파일로 read/write |
| `src/core/fitness-function-store.ts` | `FitnessFunctionStore` — 컴파일 부산물인 fitness function 저장 |
| `src/schemas/acg-change-contract.ts` | 계약 스키마(zod, SoT). scope/invariant/acceptance 모양 정의 |
| `src/schemas/acg-common.ts` | ACG 공통 스키마 조각(envelope, evidence_kind 등) |
| `src/acg/scope/resolve.ts` | scopeRef → 경로 매칭 해소 (집행 시 사용) |
| `src/hooks/pre-tool-use.ts` | 소비처. 계약을 읽어 편집을 차단하는 forbidden_scope/whitelist 집행 |

서브커맨드는 없다. 단일 커맨드에 인자만 받는다.

| 인자 | 타입 | 필수 | 의미 |
|---|---|---|---|
| `--work-item` | string | 예 | Work item id. 저장 경로와 계약의 `work_item_id`를 결정 (`change-contract.ts:34`) |
| `--file` | string | 예 | `.icl` 소스 파일 경로 (`change-contract.ts:35`) |
| `--judge-model` | string | 아니오 | `llm_judged` fitness의 `judge_model_version`. 기본 `unspecified` (`change-contract.ts:36-39, 65`) |
| `--output` | string | 아니오 | 출력 형식 `human`\|`json`. 기본 `human` (`change-contract.ts:40`) |

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

```
.icl 소스 파일 (--file)
   │  readFile (change-contract.ts:54)
   ▼
compileIcl(source, env)            [src/acg/icl/compile.ts:151]
   │  parse → static-check → map → Zod safeParse
   ▼
{ changeContract, fitnessFunctions, warnings? }
   │  실패 시 errors[] 출력 후 exit RUNTIME_ERROR (change-contract.ts:68-80)
   ▼
expandForbiddenSymbols(contract, ctx)   [src/acg/scope/symbol-expand.ts:34]
   │  forbidden_scope의 symbol kind → 선언 파일 path (CodeQL, 1회)
   ▼
ChangeContractStore.write(wi, expanded.contract)  [change-contract.ts:93]
   │            └→ .ditto/local/work-items/<wi>/change-contract.json
FitnessFunctionStore.write(wi, fitnessFunctions)  [change-contract.ts:95]
   │            └→ (fitness function 파일; `ditto fitness run`이 읽음)
   ▼
요약 출력 (human 문자열 또는 json)  [change-contract.ts:97-119]

────────── 별도 시점(런타임): 매 도구 호출 ──────────
PreToolUse 훅  [src/hooks/pre-tool-use.ts:557]
   ChangeContractStore.read(wi)  →  계약대로 편집 차단(forbidden/whitelist)
```

읽고 쓰는 상태 파일:
- **쓰기**: `.ditto/local/work-items/<wi>/change-contract.json` — 스키마 `acgChangeContract` (`change-contract-store.ts:20-22, 34-37`). 경로는 `localDir(repoRoot, 'work-items', workItemId)` 기반이며 개인 tier(`.ditto/local`)에 저장된다.
- **쓰기**: fitness function 파일 (`FitnessFunctionStore`, `change-contract.ts:95`) — `ditto fitness run`이 읽는 결정적 사슬용.
- **읽기(집행 시)**: 위 change-contract.json을 PreToolUse가 다시 읽는다 (`pre-tool-use.ts:557`).

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

### 4-1. Zod 스키마가 SoT — 컴파일러는 손으로 JSON을 만들지 않는다

컴파일러는 후보 객체를 만든 뒤 반드시 Zod로 검증하고, 검증 실패는 `IclError{kind:'schema'}`가 된다 (`compile.ts:8-9, 184-197`). 이것은 ADR-0002(Schema의 source of truth)의 직접 적용이며, 별도 손으로 쓴 JSON Schema를 두지 않는 결정이다("D2 — Zod is the source of truth; no hand-authored JSON Schema", `compile.ts:6-7`).

### 4-2. forbidden_scope는 비어 있을 수 없다 (min 1)

스키마가 `forbidden_scope`에 `.min(1)`을 걸고 이유를 명시한다: "empty forbid = unbounded change" (`acg-change-contract.ts:41-44`). 무엇을 보호할지 없는 계약은 사실상 무제한 변경 허가서이므로, 계약이라는 개념 자체가 성립하려면 최소 하나의 금지 대상이 있어야 한다는 불변식이다.

### 4-3. blacklist가 기본, whitelist는 opt-in

`scope_mode` enum이 두 집행 모드를 가른다 (`acg-change-contract.ts:45-52`):
- `blacklist`(기본, 기존 동작): forbidden_scope에 든 편집만 막는다.
- `whitelist`(cleanup profile): 편집이 반드시 allowed_scope 안에 있어야 하고, 그 밖은 전부 막는다.

whitelist를 opt-in으로 둔 이유가 스키마에 적혀 있다: "Opt-in so existing contracts are unchanged"(기존 계약을 건드리지 않기 위해) (`acg-change-contract.ts:51`). 정리(tidy/deslop) 작업은 diff 안으로만 변경을 가둬야 안전하므로 whitelist를 쓴다(ADR-0017 정리 절차와 연결).

### 4-4. risk_default ≥ medium이면 decision_ref 필수 (stage-2 gate)

계약은 `risk_default`(low|medium|high)를 담고, medium 이상이면 `superRefine`으로 `decision_ref`(ADR/decision id)를 강제한다 (`acg-change-contract.ts:55-70`). 되돌리기 어려운 위험이 있는 변경은 근거가 되는 결정 기록에 앵커되어야 한다는 게이트다.

ADR-0004는 이 `risk_default`가 **fitness 함수 비용 정책의 안전 불변식(load-bearing) base**임을 명시한다: risk tiering의 base는 계산 점수가 아니라 수동 enum인 `ChangeContract.risk_default`이고, ImpactGraph/boundary 입력이 부재하거나 미상이면 high-risk로 escalate(fail-closed)한다 (ADR-0004 §Q4, `acg-change-contract.ts:52` 인용). 즉 change-contract가 저장하는 risk_default는 fitness(적합성) 실행 스케줄이 얼마나 자주/전수로 돌지를 결정하는 입력이다.

### 4-5. symbol 확장을 저장 시점 1회로 미룬 이유 (비용 경계)

PreToolUse는 매 도구 호출마다 돌아 CodeQL DB 빌드(~9초)를 감당할 수 없다. 그래서 `symbol` kind 해소는 계약 저장 시점(이 커맨드) 1회로 옮긴다 (`symbol-expand.ts:2-8`, `resolve.ts:6-8`). 이 분업이 change-contract 커맨드가 CodeQL을 호출하는 이유다.

### 4-6. change-contract ↔ impact / fitness / boundary 관계

- **fitness(적합성 함수)**: ICL 하나가 ChangeContract와 FitnessFunction[]을 동시에 산출한다(§4 fan-out의 target B, `compile.ts:4-6`). change-contract 커맨드는 둘 다 저장한다 (`change-contract.ts:93-95`). 계약의 `invariants[].promotable`는 "codebase-wide property → FitnessFunction promotion candidate"로, 계약의 불변식이 fitness 함수로 승격될 후보임을 표시한다 (`acg-change-contract.ts:20-23`).
- **impact(ImpactGraph)**: ADR-0004에 따르면 ImpactGraph는 스키마만 있고 생산기가 없다. 그래서 risk tiering은 ImpactGraph가 아니라 change-contract의 `risk_default`를 base로 쓰고, ImpactGraph가 부재/미상이면 fail-closed escalate한다 (ADR-0004 §Q4, 철회 조건). 즉 현재 change-contract가 impact의 부재를 메우는 안전 base 역할을 한다.
- **boundary(경계 게이트/ArchitectureSpec)**: `layer`/`public_surface` kind scopeRef는 ArchitectureSpec 없이 해소 불가하므로 집행 시 매칭하지 않는다(fail-open) (`resolve.ts:9-11, 42-48`). ADR-0004 §Q3은 boundary 게이트가 v0 범위 밖(deferred)이라고 명시한다. change-contract는 이 kind들을 계약에 담을 수는 있으나, 집행은 ArchitectureSpec이 있을 때만 발효된다.

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

### 5-1. `run` 핸들러 (`change-contract.ts:42-120`)

- **입력 검증**: `parseOutputFormat` 실패 → USAGE_ERROR exit (`:45-50`). `.icl` 파일 읽기 실패 → USAGE_ERROR exit (`:52-59`). 두 실패를 usage 오류로 분류해 컴파일 오류(runtime)와 구분한다.
- **컴파일**: `compileIcl(source, env)` 호출. env에 `produced_by:'agent'`와 현재 시각을 박는다 (`:61-66`). 계약은 항상 agent 산출로 기록된다(이 CLI 경로에서는).
- **컴파일 실패 처리**: `result.ok`가 false면 json이면 errors 배열, human이면 kind별로 한 줄씩 출력하고 RUNTIME_ERROR exit (`:68-80`). parse 오류는 line 번호를 붙인다.
- **symbol 확장**: `expandForbiddenSymbols`에 `language:'javascript'`, `sourceRoot=<repo>/src`, CodeQL 캐시 디렉터리를 넘긴다 (`:86-92`). 언어가 `'javascript'`로 하드코딩된 점에 주의(§6 참조).
- **저장**: 확장된 계약을 `ChangeContractStore.write`, fitness 함수를 `FitnessFunctionStore.write` (`:93-95`). 순서상 계약이 먼저.
- **요약**: forbidden/allowed/fitness 개수, 해소/미해소 symbol, warning 수를 모아 출력 (`:97-119`). human 출력은 저장 경로를 그대로 찍어 사용자가 결과 파일을 알 수 있게 한다.

숨은 결정: 커맨드 주석이 "fitnessFunctions는 개수만 보고하고 저장하지 않는다(별도 store는 후속)"라고 적혀 있으나 (`change-contract.ts:25`), 실제 코드는 `FitnessFunctionStore.write`로 **저장한다** (`:94-95`). 주석이 코드보다 오래됐다 — §6에서 지목.

### 5-2. `compileIcl` (`compile.ts:151-209`)

입력 `.icl` 소스 → 출력 `CompileResult`. 3단계:
1. **parse**: tokenize+parse. 첫 malformed 토큰에서 단일 오류(D6) (`:152-168`).
2. **static-check**: emit 전에 규칙 1~4 검사. static error가 있으면 emit하지 않고 반환 (`:170-182`).
3. **map → emit → Zod 검증**: `buildChangeContract`/`buildFitness`로 후보 객체를 만들고 각각 `safeParse` (`:184-197`). 하나라도 실패하면 전체 실패.

`buildChangeContract` (`:127-149`)가 AST의 `intent`를 계약 필드로 매핑한다: `allow→allowed_scope`, `forbid→forbidden_scope`(각각 `mapScopeRef`), `invariants.promote→promotable`, `acceptance.evidence→evidence_kind`, `meta.decision→decision_ref`, `meta.risk→risk_default`(기본 low). `mapScopeRef`는 IclScopeKind를 스키마 kind로 옮기고(`surface→public_surface`), `as "alias"`와 `# note`를 하나의 `note`로 무손실 병합한다 (`:58-71`).

### 5-3. `expandForbiddenSymbols` (`symbol-expand.ts:34-78`)

- **조기 반환**: forbidden_scope에 symbol kind가 하나도 없으면 CodeQL을 부르지 않고 원본 반환 (`:38-40`). 비용 0 최적화.
- **symbol → 선언 파일**: `resolveSymbolDeclFiles`로 선언 파일들을 찾아 각각 `{kind:'path', ref, note:'resolved from symbol X'}`로 편다 (`:51-74`). 동명이인이면 모두 편다 — 주석: "과보호가 안전"(forbidden은 보호이므로) (`symbol-expand.ts:5-7`).
- **경로 정규화**: CodeQL의 상대 경로는 source-root 기준이므로 repo 기준으로 환산한다. PreToolUse가 repo-relative로 매칭하기 때문 (`:63-65`). 이 환산이 없으면 집행 시 경로가 어긋난다.
- **미해소 처리**: 선언을 못 찾으면 원본 symbol ref를 유지하고 `unresolved`에 이름을 담는다 (`:66-70`). 이유: forbidden min 1 불변과 추적성 보존. 단 symbol은 집행 시 매칭되지 않으므로(§5-4) **미해소 symbol은 실질 집행되지 않는다**.

### 5-4. 집행 소비처 `checkForbiddenScope` (`pre-tool-use.ts:546-589`)

- session_id → work item id(`SessionPointerStore`) → 계약(`ChangeContractStore.read`)을 얻는다. 셋 중 하나라도 없으면 undefined 반환 = 집행 안 함 (`:551-558`).
- **whitelist 모드**: `scope_mode==='whitelist'` && allowed_scope 비어있지 않으면, 편집 경로가 allowed_scope에 매칭 안 되면 차단 (`:568-576`).
- **blacklist 모드(기본)**: forbidden_scope가 비어있으면 통과(하지만 스키마가 min 1이라 정상 계약에선 안 일어남), 매칭되는 forbidden ref가 있으면 차단 (`:580-587`).
- `scopeRefMatches`(`resolve.ts:30-52`)가 실제 매칭: path(정확/디렉터리 접두), glob(정규식), layer/public_surface(archSpec 필요), symbol(매칭 안 함).

인과: change-contract가 symbol을 저장 시점에 path로 펴 두기 때문에, 매 호출 도는 이 훅이 CodeQL 없이 path 매칭만으로 symbol 보호를 집행할 수 있다.

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위: change-contract 커맨드와 그 직접 의존(compile, symbol-expand, store, schema, resolve, pre-tool-use 집행 블록).

- **커맨드 주석 vs 코드 불일치 (문서 drift)**: 주석은 "fitnessFunctions는 개수만 보고하고 저장하지 않는다(별도 store는 후속)"라고 하지만 (`change-contract.ts:25`), 코드는 `FitnessFunctionStore.write`로 실제 저장한다 (`change-contract.ts:94-95`). 주석이 코드보다 낡았다. 동작 자체는 fitness 저장이 정상 경로다.
- **집행 fail-open 일관**: 계약 부재/스키마 위반 시 store.read는 null을 반환하고(`change-contract-store.ts:24-31`) 훅은 집행하지 않는다(`pre-tool-use.ts:558`). "false block보다 미집행"이라는 설계 의도(`resolve.ts:9-11`)와 일치.
- **미해소 symbol의 집행 갭**: symbol을 못 펴면 원본 symbol ref가 남고(`symbol-expand.ts:66-70`), symbol kind는 집행 시 매칭되지 않는다(`resolve.ts:49-50`). 즉 미해소 symbol은 계약에 기록은 되나 실제로 보호되지 않는다. 이건 의도된 트레이드오프(추적성 보존)지만, 사용자 관점에선 "forbidden에 적었는데 안 막힘"이 될 수 있는 갭이다. human 출력이 `unresolved symbols [...]`로 경고하는 것으로 부분 완화 (`change-contract.ts:109-112`).
- **layer/public_surface의 조건부 집행**: archSpec이 없으면 이 kind는 매칭 안 됨(`resolve.ts:42-48`). ADR-0004 §Q3에 따라 boundary 게이트가 deferred라 ArchitectureSpec 생산 경로가 v0 범위 밖 — 확인 범위에서 archSpec 로딩은 `loadArchSpec`(`pre-tool-use.ts:565`)으로 시도되나, 스펙이 없으면 이 두 kind는 집행되지 않는다. 의도(deferred)와 일치하나 계약에 담아도 발효 안 될 수 있음.

## 7. 잠재 위험·부작용·재설계 시 고려점

- **언어 하드코딩**: symbol 확장이 `language:'javascript'`, `sourceRoot=<repo>/src`로 고정 (`change-contract.ts:88-90`). DITTO는 임의 사용자 언어/환경에 맞춰야 한다는 원칙(메타-도구 프로젝트 적합)에 비추면, JS/TS가 아닌 프로젝트에서 symbol kind forbidden_scope는 해소되지 않는다. 재설계 시 언어/소스루트를 프로젝트 설정에서 끌어와야 한다. (미확인: 이 하드코딩이 dogfood 편의인지 계약된 제약인지는 커맨드 코드만으로 단정 불가.)
- **개인 tier 저장의 공유 문제**: 계약이 `.ditto/local/work-items/<wi>/`(개인 tier, `change-contract-store.ts:16-22`)에 저장된다. 집행이 세션-로컬이라면 문제없으나, work item이 여러 세션/worktree에 걸치면 계약 가시성이 문제가 될 수 있다. pre-tool-use가 worktree-aware relativization을 하는 것(`pre-tool-use.ts:560-564`)은 이 위험을 이미 인지한 흔적.
- **드리프트 위험 — 코드 이동/리네임**: symbol을 저장 시점 1회 path로 펴 두므로(`symbol-expand.ts`), 저장 이후 그 symbol이 다른 파일로 이동/분할되면 펼쳐 둔 path가 낡아 실제 심볼을 더는 못 막는다. path 스냅샷과 실제 심볼 위치의 drift. 재설계 시 재해소 트리거(파일 변경 감지)나 집행 시점 경량 재확인이 필요할 수 있다.
- **재설계 시 보존해야 할 불변식**:
  1. `forbidden_scope.min(1)` — empty = unbounded change (`acg-change-contract.ts:41-44`).
  2. `risk_default ≥ medium → decision_ref 필수` stage-2 gate (`acg-change-contract.ts:62-70`), 그리고 risk_default가 fitness cost tiering의 fail-closed base라는 ADR-0004 안전 불변식.
  3. Zod가 SoT — 손으로 만든 계약 객체는 반드시 검증 통과해야 저장 (`compile.ts:184-197`, ADR-0002).
  4. 집행은 fail-open(못 해소하면 차단 대신 통과), 단 whitelist는 fail 시 차단 — 두 모드의 방향 차이를 보존.
- **재고 가능한 결정**: symbol→path 확장을 저장 시점 1회로 고정한 것은 CodeQL 비용 때문이다(`symbol-expand.ts:2-8`). 증분 심볼 해소나 캐시 무효화 전략이 생기면 이 1회 스냅샷을 재검토할 수 있다(ADR-0004 철회 조건과 같은 방향의 여지).
