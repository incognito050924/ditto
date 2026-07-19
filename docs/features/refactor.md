# refactor — 사용자가 지정한 아키텍처 단위의 standing 코드를 동작 보존으로 정리하고, full-bar 충족 시에만 격리 브랜치 자동커밋을 게이팅하는 unit-scoped tidy 표면

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준 커밋: `c2d2e16`, 날짜: 2026-07-19.

> 주의(조사 범위 정정): 이 작업의 스코프 힌트는 `src/core/autopilot-tidy.ts`(autopilot tidy 서브체인)·`gates.ts`(G7)·`agents/refactorer.md`를 가리켰으나, 실제 `ditto refactor` 커맨드는 그 경로를 **쓰지 않는다**. 진입 파일 `src/cli/commands/refactor.ts:1-14`가 import하는 것은 ACG 계열 모듈(`~/acg/scope/unit-resolve`, `~/acg/tidy/unit-refactor`)이다. autopilot tidy 서브체인은 change-scoped(변경 범위) 정리이고, `ditto refactor`는 unit-scoped(단위 범위) standing-code 정리로 **별개의 사용자 표면**이다(ADR-0017 D7). 아래 문서는 실제 코드가 하는 일을 기준으로 쓴다.

## 1. 이 기능이 실현하려는 설계 의도 (개념)

`ditto refactor --scope <unit>`은 사용자가 아키텍처 **단위**(전체 / 컴포넌트 / 계층 / REST API / glob)를 지목하면, 그 단위에 속하는 **기존(standing) 코드**를 동작 보존(behavior-preserving) 방식으로 정리하려는 표면이다. 기준선(baseline)은 merge-base diff가 아니라 `HEAD`다(`src/cli/commands/refactor.ts:18-22`, `src/acg/tidy/unit-refactor.ts:4-6`).

autopilot의 정리는 "방금 구현한 변경 범위(change-scoped)"를 대상으로 하지만, 이 사용자 표면의 목적은 **이미 쌓여 있는 부채 제거**이므로 대상이 "변경분"이 아니라 "단위 전체의 서 있는 코드"이고, 적합성 게이트도 델타 추세가 아니라 **절대 부채 감소**다(ADR-0017 D7; `src/acg/tidy/unit-refactor.ts:4-6`).

DITTO 4축 기준으로는 의도/오케스트레이션/E2E/지식 어디에도 직접 속하지 않고 **거버넌스(ACG — Agentic Change Governance)** 계열이다. ADR-0017이 "정리(Tidy/deslop) 절차를 ACG 게이트 위에 정립한다"고 결정했고, 이 커맨드는 그 D7이 규정한 사용자 표면 2개 중 하나(WU-4 `ditto refactor`)다(형제는 WU-5 `ditto review`; ADR-0017 D7, `src/acg/scope/unit-resolve.ts:4-6`).

핵심 설계 긴장: standing 코드에서 동작 보존을 **증명**하려면 coverage/property provider가 배선돼 있어야 하는데, 이 저장소에는 provider가 배선돼 있지 않다("provider 0건"). 그래서 커맨드는 full-bar 자동커밋을 실행하는 게 아니라, provider 부재를 **가장 먼저** 판정해 모든 단위를 diff-only로 강등하고, bar 미달분을 **좁은 잔여 질문**으로만 표면화한다(§4.4 "검증 연극" 회피 — 대량 diff를 사람이 승인하는 게이트를 거부; `src/cli/commands/refactor.ts:24-29`, ADR-0017 D8).

## 2. 코드 위치와 진입점

| 경로 | 역할 |
|---|---|
| `src/cli/commands/refactor.ts` | CLI 진입점. `--scope` 파싱 → 파일 열거 → 단위 해석 → 정리 결정 → 출력. **측정·보고 전용(mutation·commit 없음)** |
| `src/acg/scope/unit-resolve.ts` | 단위 문자열(`all|component:<name>|layer:<name>|api|<glob>`)을 standing 파일 집합으로 해석하는 **공유 resolver**(`refactor`와 `review`가 공용) |
| `src/acg/tidy/unit-refactor.ts` | 단위의 절대 부채 측정(`assessUnitDebt`)과 정리 결정(`decideUnitTidy`) — provider-presence-first 게이팅 |
| `src/acg/tidy/behavior-lock.ts` | L1 동작 잠금(`assessBehaviorLock`) — provider 부재 시 diff-only로 fail-open. `decideUnitTidy`가 이 정책을 미러링(직접 호출은 아님, 아래 §5·§6 참고) |
| `src/acg/tidy/tidy-commit.ts` | `commitTidyStructural` — 격리 브랜치에 stage/commit(절대 push 안 함). **CLI refactor는 이걸 호출하지 않음** |
| `src/schemas/acg-architecture-spec.ts` | `layer:<name>` 해석에 필요한 ArchitectureSpec의 zod 스키마(SoT, ADR-0002) |
| `src/cli/index.ts:31,87` | 커맨드 등록(`refactor: refactorCommand`) |

### CLI 인자

| 인자 | 타입 | 필수 | 기본값 | 의미 |
|---|---|---|---|---|
| `--scope` | string | 예 | 없음 | 아키텍처 단위: `all` \| `component:<name>` \| `layer:<name>` \| `api` \| `<glob>` (`src/cli/commands/refactor.ts:64-69`) |
| `--output` | string | 아니오 | `human` | 출력 형식 `human|json` (`src/cli/commands/refactor.ts:70`) |

서브커맨드는 없다(단일 커맨드).

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

```
--scope <unit>
  │  parseUnitScope            (unit-resolve.ts:34)  → UnitScope
  │  parseOutputFormat         (refactor.ts:75)      → human|json
  ▼
repoRoot = resolveRepoRootForCreate()              (refactor.ts:90)
  │
  ▼
trackedSrcFiles(repoRoot)                          (refactor.ts:32-46)
  │   git ls-files -- src  →  .ts/.tsx/.cts/.mts 만, .test./.spec. 제외
  ▼
archSpec = loadArchSpec(repoRoot)                  (refactor.ts:49-56)
  │   .ditto/architecture-spec.json 있으면 로드, 없으면 undefined
  ▼
resolved = resolveUnitScope(unit, files, archSpec) (unit-resolve.ts:72-78)  → string[]
  ▼
decision = decideUnitTidy({                        (refactor.ts:100-107)
     baselineGreen: true,        // 하드코딩
     debt: {before:N, after:N},  // 동일값(변형 없음)
     behaviorGreen: true,        // 하드코딩
     coverageProviderPresent: false  // 하드코딩(provider 0건)
  })
  ▼
출력(refactor.ts:109-122):
  json  → {unit, files, autoCommit, barMet, residualQuestions}
  human → "refactor <unit>: N file(s), autoCommit=…, barMet=…" + residual 줄들
```

- **입력**: `--scope` 문자열과 저장소의 `HEAD` 시점 tracked 소스 파일 목록. 외부 상태 파일로 읽는 것은 선택적으로 `.ditto/architecture-spec.json`(있을 때만; `src/cli/commands/refactor.ts:50`) 하나뿐이다.
- **변환**: 파일 집합을 단위로 필터링(`resolveUnitScope`) → 순수 함수 `decideUnitTidy`로 결정 산출.
- **저장/출력**: **디스크에 아무것도 쓰지 않는다.** stdout으로 결정만 출력한다. 격리 브랜치 커밋도, ledger 파일도 이 경로에서는 생성되지 않는다(`src/cli/commands/refactor.ts:96-122`에 write 계열 호출 없음; commit 함수 `commitTidyStructural`는 미호출 — §6에서 상술).

읽는 상태 파일과 스키마: `.ditto/architecture-spec.json` ↔ `acgArchitectureSpec`(`src/schemas/acg-architecture-spec.ts:42-`). `layers`는 `record(name → {can_call})` 모양이다(`src/schemas/acg-architecture-spec.ts:45-48`).

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

### 4-1. Unit-scoped standing 코드 (baseline = HEAD)
autopilot의 change-scoped 정리와 대비되는 개념. 사용자 표면의 목적이 "기존 부채 제거"이므로 대상은 변경분이 아니라 단위의 서 있는 코드 전체이고, 적합성 게이트는 델타가 아니라 **절대 부채 감소**다(`src/acg/tidy/unit-refactor.ts:1-6`, ADR-0017 D7). 트레이드오프: standing 코드는 커버리지가 낮아(ADR-0017 D7이 인용한 boxwood 2.7%) L1 게이트가 대부분을 막는다 — 그래서 대량 characterization 비용 또는 대량 skip이 발생한다. ADR-0017 D7은 이 때문에 unit-scoped를 change-scoped 코어 이후의 후속 WU로 격리하고 첫 단계를 "한 컴포넌트 dogfood로 비용·skip율 측정"으로 시퀀싱했다.

### 4-2. Provider-presence-FIRST 강등 (N8 measure-first)
`decideUnitTidy`는 per-unit 커버리지를 따지기 **전에** coverage provider 존재 여부를 먼저 본다. provider가 없으면 단위별 커버리지와 무관하게 **모두 diff-only로 강등**한다(`src/acg/tidy/unit-refactor.ts:76-114`). 이유: provider 없는 bar는 동작 보존을 목격할 수 없고, 그 위에서 자동커밋하면 §4.4가 배격한 "검증 연극"(사람이 대량 diff 앞부분만 보고 승인하는 가짜 확신)을 재생산하기 때문이다(ADR-0017 D8; `src/acg/tidy/unit-refactor.ts:76-81`).

### 4-3. 좁은 잔여 질문(narrow residual question), 대량 diff 금지
bar 미달분은 사람에게 대량 diff 승인을 요구하지 않고 좁게 프레이밍된 잔여 질문만 올린다(`src/acg/tidy/unit-refactor.ts:72-73, 102-113`). 근거: 로컬 커밋은 가역적(`git reset/revert`)이라 push 금지 하에서 비가역 위험이 낮고, 대량 diff 사람 승인 게이트는 검증 연극이다(ADR-0017 D8).

### 4-4. Tidy First — 구조/동작 분리, push 절대 금지
full-bar 충족 시의 커밋은 structural 커밋으로 격리 브랜치에 만들고 절대 push하지 않는다(ADR-0017 D8; `src/acg/tidy/tidy-commit.ts:3-4, 77`). 이는 사용자 전역 규칙(구조적·동작적 변경 불혼합)과 일치한다.

### 4-5. 공유 resolver (refactor ↔ review 정합)
`resolveUnitScope`는 `refactor`(WU-4)와 `review`(WU-5)가 **같은** 단위 정의에 합의하도록 공유된다(`src/acg/scope/unit-resolve.ts:4-6`). 기존 경로 관례를 재사용한다: `layer:` → `pathToLayer`(스펙 필요, 없으면 아무것도 매치 안 함 — 보수적), `component:` → `layerOf`(top-level `src/<name>/` 디렉터리), `api` → controllers/routes 계층, `<glob>` → `globToRegExp`(`src/acg/scope/unit-resolve.ts:8-17, 51-66`).

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

### `trackedSrcFiles` (`src/cli/commands/refactor.ts:32-46`)
- 입력: repoRoot. `git ls-files -- src`를 실행.
- 하는 일: 출력에서 `\.[cm]?tsx?$`만 남기고 `\.(test|spec)\.`는 제외(`refactor.ts:45`).
- 효과: 단위 해석의 **입력 파일 집합**이 결정적(git 인덱스 기준)이고 테스트 파일이 제외된다. `HEAD`(git ls-files는 인덱스/tracked 기준)의 standing 코드만 대상이 된다. 실패 시 throw(`refactor.ts:38-40`).

### `loadArchSpec` (`src/cli/commands/refactor.ts:49-56`)
- `.ditto/architecture-spec.json`을 zod로 로드, 실패/부재면 `undefined` 반환(catch로 삼킴).
- 숨은 결정: 스펙이 없으면 `layer:<name>`은 **아무것도** 해석하지 못한다(보수적 — "거짓 단위가 빈 것보다 나쁘다", `src/acg/scope/unit-resolve.ts:12-13, 59-60`). 다른 단위 종류는 스펙 없어도 정상 동작.

### `parseUnitScope` (`src/acg/scope/unit-resolve.ts:34-49`)
- `all`/`api`/`layer:`/`component:` 접두 매칭, 나머지는 전부 `glob`으로 폴백(`unit-resolve.ts:48`).
- 가드: `layer:`/`component:` 뒤 이름이 비면 throw(`unit-resolve.ts:40, 45`). CLI는 이 throw를 잡아 `USAGE_ERROR_EXIT`로 종료(`refactor.ts:82-88`).
- 순서 의존성: `all`/`api` 정확 매칭 → 접두 매칭 → glob 폴백. 즉 잘못 친 단위명은 에러가 아니라 glob으로 해석돼 대개 0개 매치가 된다(미확인 위험, §7).

### `resolveUnitScope` / `fileInUnit` (`src/acg/scope/unit-resolve.ts:51-78`)
- 순수 함수. `files.filter(fileInUnit)`.
- `api`: 경로 세그먼트에 `controller|controllers|route|routes` 중 하나가 있으면 매치(`unit-resolve.ts:30-31, 56-58`).
- `layer`: 스펙 있고 `pathToLayer(path, spec.layers) === name`일 때만(`unit-resolve.ts:59-61`).
- `component`: `layerOf(path) === name`, 즉 top-level `src/<name>/` 디렉터리(`unit-resolve.ts:62-63`).
- `glob`: `globToRegExp(glob).test(path)`(`unit-resolve.ts:64-65`).

### `assessUnitDebt` (`src/acg/tidy/unit-refactor.ts:35-43`)
- 입력: before/after 위반 **식별자** 배열. 출력: 고유 개수 before/after, `decreased = after < before`, `removed`(감소분, 증가면 0).
- 숨은 결정: `Set`으로 중복 제거해 **distinct identity** 기준으로 센다. 부채 증가는 removal 크레딧을 못 받는다(`unit-refactor.ts:42`). **주의**: CLI는 이 함수를 호출하지 않는다 — CLI는 `decideUnitTidy`에 `debt:{before:N, after:N}`(동일값)을 직접 넘긴다(`refactor.ts:104`). 즉 `assessUnitDebt`는 실제 refactor가 도는 (아직 미배선) 경로용이다.

### `decideUnitTidy` (`src/acg/tidy/unit-refactor.ts:82-168`) — 핵심 게이트
순서대로 fail-closed:
1. `!baselineGreen` → `autoCommit:'none'`, 잔여질문 "baseline red — tidy cannot start (G-R1)"(`unit-refactor.ts:86-99`).
2. `!coverageProviderPresent` → **모두** `autoCommit:'diff-only'`, `barMet:false`, 잔여질문 "no coverage provider wired(provider 0건) … diff-only … not auto-committed(§4.4)"(`unit-refactor.ts:101-114`). ← **CLI가 실제로 도달하는 분기**.
3. provider 있음 + `unitCovered!==true` → `'none'` "characterization 먼저 생성 후 재시도"(`unit-refactor.ts:116-129`).
4. `!behaviorGreen` → `'none'` "behavior preservation NOT green(L1/L2) — revert basis"(`unit-refactor.ts:130-142`).
5. `!debtDecreased` → `'none'` "절대 부채 감소 안 함(before→after) — tidy improvement 아님"(`unit-refactor.ts:144-158`).
6. 전부 통과 → `autoCommit:'full'`, `barMet:true`, 잔여질문 없음(`unit-refactor.ts:160-167`).

인과: provider가 하드코딩 `false`(`refactor.ts:106`)이므로 실코드는 **항상 분기 (2)에서 멈춘다** — full/none 경로(3~6)는 CLI에서 현재 도달 불가.

### `commitTidyStructural` (`src/acg/tidy/tidy-commit.ts:39-`)
- 격리 브랜치 checkout(-b) → 정확히 `files`만 stage → 커밋. push는 하지 않음(`tidy-commit.ts:39-77`).
- **CLI refactor는 이 함수를 import·호출하지 않는다**(`refactor.ts` 어디에도 없음). 자동커밋은 설계상 존재하지만 현재 이 진입점에 배선돼 있지 않다(§6).

### CLI `run` 본문 (`src/cli/commands/refactor.ts:72-127`)
- 출력 형식/단위 파싱 에러 → `USAGE_ERROR_EXIT`(`refactor.ts:78, 86`).
- 본 로직 예외 → `RUNTIME_ERROR_EXIT`(`refactor.ts:124-125`).
- `json`이면 `{unit, files, autoCommit, barMet, residualQuestions}`, `human`이면 요약 한 줄 + residual 줄들(`refactor.ts:109-122`).

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위: `src/cli/commands/refactor.ts`, `src/acg/scope/unit-resolve.ts`, `src/acg/tidy/unit-refactor.ts`, `src/acg/tidy/behavior-lock.ts`, `src/acg/tidy/tidy-commit.ts`, `src/schemas/acg-architecture-spec.ts`, ADR-0017. 실행 확인은 안 함(정적 독해).

일치하는 부분:
- 단위 해석·provider-presence-first 강등·좁은 잔여 질문·baseline red 차단은 ADR-0017 D7/D8과 일치한다(§4·§5 인용).

의도와 실제 동작의 **갭**(코드에 근거):
1. **커맨드는 정리를 실행하지 않는다 — 측정·보고만 한다.** 커맨드 헤더 주석은 "the §4.4 bar gates an isolated-branch auto-commit"이라고 말하지만(`refactor.ts:20-22`), `run` 본문은 파일을 열거해 결정만 출력할 뿐 어떤 파일도 수정/커밋하지 않는다. 주석 자신도 이를 인정한다: "the actual refactor happens during the actual refactor; here … the unit degrades to diff-only — we report the resolved unit + the gated decision. before/after debt are equal (no mutation performed by this entrypoint)"(`refactor.ts:96-99`). 즉 **실제 리팩터링 수행 주체가 이 진입점에 아직 배선돼 있지 않다**. `commitTidyStructural`은 존재하지만 미호출.
2. **결정 입력이 전부 하드코딩된 상수다.** `baselineGreen:true`, `debt.before==debt.after`, `behaviorGreen:true`, `coverageProviderPresent:false`(`refactor.ts:104-106`). 실제 baseline 테스트 실행이나 부채 측정을 하지 않으므로, 출력의 `autoCommit=diff-only`는 항상 분기 (2) 하나로 고정된다. `debtDecreased`는 항상 `false`(before==after)다.
3. **`assessUnitDebt`·`assessBehaviorLock`·`decideUnitTidy`의 3~6 분기는 CLI 관점에서 현재 죽은 경로다**(provider 하드코딩 false로 도달 불가). 이들은 provider가 배선될 때를 위한 것으로 보인다(추론 — 주석 `refactor.ts:26-28`이 "stays gated behind a wired+firing coverage provider"라고 명시). `decideUnitTidy`는 `assessBehaviorLock`을 직접 호출하지 않고 같은 정책을 **미러링**한다(두 함수의 분기·문구가 평행; `behavior-lock.ts:56-88` ↔ `unit-refactor.ts:82-168`) — 중복 로직으로 drift 위험(§7).

이 갭은 ADR-0017이 명시한 시퀀싱(provider 배선이 선결조건, unit-scoped는 후속 WU)과 정합적이다. 즉 "미완"이 아니라 "설계상 provider 배선 전까지 measure-only로 강등"이 의도다(ADR-0017 D5·D8). 다만 커맨드 설명 문자열(`refactor.ts:61-62`)과 헤더 주석은 자동커밋을 하는 것처럼 읽혀 오해 소지가 있다(미확인 위험, §7).

테스트: `tests/acg/unit-resolve.test.ts`, `tests/acg/unit-refactor.test.ts`, `tests/acg/unit-refactor-ac9.test.ts`, `tests/acg/unit-refactor-commit.test.ts`가 존재한다. CLI 커맨드 자체를 end-to-end로 도는 테스트는 이 조사 범위에서 확인하지 못했다(미확인).

## 7. 잠재 위험·부작용·재설계 시 고려점

- **측정-보고와 실행의 분리가 표면 문서와 어긋남.** 커맨드 description(`refactor.ts:61-62`)·헤더 주석(`refactor.ts:16-22`)은 자동커밋을 암시하나 실제로는 아무것도 커밋하지 않는다. 재설계 시 (a) 실제 refactor/commit 배선을 이 진입점에 붙이거나, (b) 문서/description을 "measure-and-report(provider 미배선)"로 정직하게 낮춰야 한다.
- **하드코딩된 결정 입력.** `baselineGreen`/`behaviorGreen`/`debt`/`coverageProviderPresent`가 상수라, 출력이 사실상 항상 동일한 diff-only 판정이다. provider 배선 시 이 상수들을 실측값으로 교체하는 것이 자연스러운 다음 단계로 보인다(추론).
- **`decideUnitTidy` ↔ `assessBehaviorLock` 로직 중복.** 두 함수가 같은 provider-presence-first 정책을 각자 구현한다. 한쪽만 바뀌면 drift한다. 재설계 시 단일 소스로 합치는 것을 고려. (반드시 보존할 불변식: provider 부재 → diff-only, baseline red → none, 대량 diff 자동커밋 금지.)
- **glob 폴백의 조용한 오해석.** 오타난 단위명(예: `componnt:acg`)은 에러가 아니라 glob으로 해석돼 0개 매치가 된다(`unit-resolve.ts:48`). 사용자는 "매치 0" 결과를 "정리할 게 없다"로 오독할 수 있다(미확인 — 실행으로 확인 안 함). 재설계 시 알려진 접두 오타에 대한 경고를 고려.
- **`layer:` 스펙 부재 시 무음 0매치.** `.ditto/architecture-spec.json`이 없으면 `layer:`는 조용히 아무것도 해석하지 않는다(`unit-resolve.ts:59-60`, `refactor.ts:52-55`). 보수적이지만 사용자에겐 "빈 결과"로만 보인다.
- **동시성/정합성.** 이 진입점은 상태를 쓰지 않으므로(§3) 현재는 동시성 위험이 낮다. 그러나 향후 `commitTidyStructural`(격리 브랜치 checkout — 워킹트리 전역 상태 변경; `tidy-commit.ts:44-46`)을 배선하면, 다른 세션·autopilot과 브랜치/워킹트리 경합이 생긴다. push 금지는 유지해야 할 불변식(ADR-0017 D8).
- **재설계 시 보존해야 할 불변식**: ① unit-scoped baseline=HEAD·절대 부채 게이트(change-scoped 델타와 구분), ② provider-presence-first 강등(증명 없는 자동커밋 금지 = 검증 연극 회피), ③ bar 미달분은 좁은 잔여 질문만(대량 diff 승인 게이트 금지), ④ 격리 브랜치·push 금지, ⑤ 공유 resolver로 `refactor`/`review` 단위 정의 일치. **재고 가능한 결정**: 결정 입력 하드코딩, `decideUnitTidy`/`assessBehaviorLock` 이원화, description 문구.
