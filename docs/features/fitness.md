# fitness — ACG 적합성 함수(fitness function)를 여러 provider로 평가해 AssuranceSnapshot을 산출하고 SLOP 추세(drift)를 게이트하는 커맨드

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준 커밋: `c2d2e16`, 날짜: 2026-07-19.

## 1. 이 기능이 실현하려는 설계 의도 (개념)

이 커맨드는 **아키텍처 적합성 함수(fitness function)** — "코드베이스가 시간이 지나도 지켜야 할 속성을, 변경마다·주기적으로 평가되는 실행 가능한 술어(predicate)로 박제한 것" — 를 실제로 돌리는 실행기다. 스키마 주석이 그 정의를 직접 못 박는다: "A property the codebase must keep over time, as an executable predicate evaluated per-change + periodically. AssuranceSnapshot is the time series of these evaluations."(`src/schemas/acg-fitness-function.ts:6-10`)

풀려는 문제는 두 층위다.

- **단발 검증**: 한 변경(work item)이 지켜야 할 속성을 깨뜨렸는가 → `fitness run`이 FitnessFunction들을 평가해 `AssuranceSnapshot`(평가 결과의 시계열 단위)을 만들고, 차단(block) 위반이 있으면 비정상 종료한다.
- **누적 추세(drift)**: 한 변경씩 보면 게이트를 통과해도 변경을 가로질러 위반이 서서히 누증하면 "감당 불가"가 된다. `fitness drift`가 work item들을 가로질러 스냅샷을 집계해 function_id별 SLOP 기울기(rising/falling/flat)를 드러내고, CI 게이트로 승격할 수 있다(`src/acg/fitness/drift.ts:2-8`).

DITTO 4축 기준으로는 **지식/거버넌스 축의 "정합성"** 계열이다 — 코드가 선언된 아키텍처 속성과 계속 정합한지를 지속적으로 집행한다(추론: 4축 canonical 정의는 ADR-0010 소관이며 이 파일에 4축 라벨이 명시돼 있지는 않다). 근거가 되는 설계 결정은 ADR-0004(적합성 함수 비용 정책)이고, 이 코드는 그 정책 §Q4를 "실행 가능하게 만든 것"이라고 스스로 밝힌다(`src/acg/fitness/fitness-runner.ts:8-9`).

핵심 불변식 하나가 이 기능 전체를 관통한다: **ditto는 LLM이나 테스트를 직접 호출하지 않는다.** 이 절대 불변식 때문에 provider 추상화가 존재한다(§4).

## 2. 코드 위치와 진입점

핵심 파일:

- `src/cli/commands/fitness.ts` — CLI 진입. `run`/`drift` 두 서브커맨드, provider 선택, 스냅샷 저장.
- `src/core/fitness-function-store.ts` — work item별 FitnessFunction 집합을 per-entity JSON으로 read/write(ADR-0005).
- `src/acg/fitness/fitness-runner.ts` — 순수 코어: 스케줄링(어떤 함수를 이번에 돌릴지) + delta(신규 위반 계산) + 스냅샷 조립. provider 인터페이스 정의.
- `src/acg/fitness/command-provider.ts` — deterministic 모드 provider. `codeql-sarif:` 소스 또는 임의 shell 명령.
- `src/acg/fitness/codeql-provider.ts` — CodeQL SARIF → 정규화된 위반 식별자 투영(deterministic의 한 소스).
- `src/acg/fitness/executed-provider.ts` — executed 모드(테스트/e2e) 직접 실행 + flake/timeout/retry 정책. `--execute`용 라우터(`executingProvider`) 포함.
- `src/acg/fitness/injected-provider.ts` — 에이전트 주입형 verdict 파일 소비(llm_judged/executed) + deterministic과 섞어 라우팅하는 `compositeProvider`.
- `src/acg/fitness/drift.ts` — AssuranceSnapshot 시계열 집계 + rising 게이트 판정 + 로더.
- `src/schemas/acg-fitness-function.ts` / `acg-fitness-verdict.ts` / `acg-assurance-snapshot.ts` — 세 계약(술어/주입판정/평가이력)의 zod 스키마(SoT, ADR-0002).

서브커맨드·인자(`src/cli/commands/fitness.ts:29-170`):

| 서브 | 인자 | 의미 |
|---|---|---|
| `run` | `--work-item` (필수) | 대상 work item id (`change_ref`) |
| | `--from <path>` | fitness-function JSON(또는 배열) 경로. 생략 시 store에서 로드 |
| | `--trigger per_change\|periodic` | 트리거(기본 per_change) |
| | `--period daily\|weekly\|on_release` | periodic일 때 매칭 주기 |
| | `--risk low\|medium\|high` | executed risk_tiered 스케줄링용 위험도 |
| | `--risk-known` (bool, 기본 false) | 위험도가 ImpactGraph에서 확정됐는가. false면 fail-closed escalate |
| | `--verdicts <path>` | 에이전트 산출 `acg.fitness-verdict.v1` 파일. llm_judged/executed를 injected로 라우팅 |
| | `--execute` (bool, 기본 false) | executed 모드를 직접 실행(비용 큼, opt-in, ADR-0004 Q4) |
| | `--output human\|json` | 출력 형식 |
| `drift` | `--gate` (bool) | rising 추세면 비정상 종료(CI 게이트) |
| | `--min-new-violations <N>` | 게이트 임계(기본 0=모든 rising) |
| | `--output human\|json` | 출력 형식 |

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

### `fitness run`

```
FitnessFunction[]                         (─── 상류: ditto change-contract가 ICL 컴파일 결과를 store에 write)
  ├─ --from <path>  또는
  └─ FitnessFunctionStore.read(wi)  ← .ditto/local/work-items/<wi>/fitness-functions.json
        │
        ▼
  FitnessContext {trigger, period, changeRef=wi, risk, riskKnown, producedAt}
        │
        ▼
  provider 선택 (아래 규칙)
        │
        ▼  runFitness(functions, ctx, provider)  ── src/acg/fitness/fitness-runner.ts:172
  각 fn: scheduleDecision → (run?) provider.evaluate → assessDelta → SnapshotResult
        │
        ▼
  AcgAssuranceSnapshot  (zod parse 검증)
        │
        ▼  write
  .ditto/local/work-items/<wi>/assurance-snapshot.json
        │
        ▼  outcome==fail 개수 > 0 → process.exit(RUNTIME_ERROR_EXIT)
```

provider 선택(`src/cli/commands/fitness.ts:116-120`):

- `--execute` → `executingProvider(repoRoot, verdictsPath)` (모드별 직접 실행: deterministic→command, executed→executed, llm_judged→injected 또는 skip)
- `--verdicts`만 → `compositeProvider(repoRoot, verdictsPath)` (deterministic은 명령 실행, 나머지는 주입 verdict 소비)
- 둘 다 없음 → `commandProvider(repoRoot)` (deterministic 전용, 나머지 모드는 skip)

읽고 쓰는 상태 파일:

- 입력: `.ditto/local/work-items/<wi>/fitness-functions.json` (`AcgFitnessFunction[]`)
- 입력(선택): verdict 파일 경로(`AcgFitnessVerdictFile`) — deterministic 소스면 `codeql-sarif:` 경로가 가리키는 SARIF, 또는 임의 shell 명령의 stdout
- 출력: `.ditto/local/work-items/<wi>/assurance-snapshot.json` (`AcgAssuranceSnapshot`)

### `fitness drift`

```
loadAssuranceSnapshots(repoRoot)     ── WorkItemStore.list() → 각 wi의 assurance-snapshot.json 로드(부재/malformed는 skip)
        │
        ▼  computeDrift  ── src/acg/fitness/drift.ts:84
  function_id별 DriftSeries (points 시계열, first/last_violations, direction, cumulative_new_violations)
        │
        ▼  --gate 이면 assessDrift(report, minNew)
  concerning = rising 이면서 cumulative_new_violations ≥ minNew
        │
        ▼  concerning.length>0 → process.exit(RUNTIME_ERROR_EXIT)
```

### 자동 트리거 경로 (stop 훅)

CLI 외에 stop 훅이 같은 러너를 공유한다(`src/hooks/stop.ts:537 maybeRunFitness`). store에 fitness function이 있으면, git 기반 입력 지문(`fitnessInputFingerprint`)이 직전과 같고 스냅샷이 이미 있으면 재실행을 건너뛰고(비용 절약), 다르면 `runFitness`를 돌려 스냅샷을 갱신한다. 여기서 provider는 verdict 파일 존재 여부로 `compositeProvider`/`commandProvider`를 고르고, `riskKnown:false`로 fail-closed다(`src/hooks/stop.ts:560-569`). 실패한 fitness 결과는 `assuranceSnapshotForcesContinuation`(`src/hooks/stop.ts:338`)가 "차단 위반 N건"으로 continuation 사유를 만든다.

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

### 4-1. provider 추상화 — 왜 존재하는가

절대 불변식: **ditto는 LLM/테스트를 직접 호출하지 않는다**(`src/schemas/acg-fitness-verdict.ts:6-8`). 그런데 fitness function의 evaluator.mode는 세 종류다: `deterministic`(싼 커스텀 가드/쿼리), `llm_judged`(모델 판정), `executed`(테스트/e2e 실행)(`src/schemas/acg-fitness-function.ts:82`). 러너 자신은 스케줄링·delta·스냅샷 조립만 하는 순수부이고, **evaluator 실행(CodeQL 쿼리/shell 명령/e2e)은 주입된 provider의 몫**이라고 명시한다(`src/acg/fitness/fitness-runner.ts:21-22, 45-51`). 이 분리가 provider 추상화의 이유다:

- 결정적으로 돌릴 수 있는 것(deterministic)은 ditto가 직접 실행해도 불변식을 안 깬다 → `commandProvider`.
- 모델 판정(llm_judged)이나 비용 큰 실행(executed)은 에이전트가 밖에서 평가해 `acg.fitness-verdict.v1` 파일로 주입 → `injectedProvider`가 소비.
- 러너는 provider가 뭔지 모른 채 `EvaluatorProvider.evaluate`만 호출 → 같은 스케줄링·delta 로직을 모드와 무관하게 재사용.

### 4-2. 비용 정책 (ADR-0004 Q4)

ADR-0004는 CodeQL 실측 비용(캐시 후 단일쿼리 ~3.9s, cold 추출 13.8~34s, 전체 스위트 34s~1분)을 근거로 mode별 차등 스케줄을 못 박았다(`ADR-0004:27-35`). 이 정책이 `scheduleDecision`으로 실행 가능해졌다(§5-2). 핵심:

- deterministic/llm_judged는 `cadence.per_change` 허용.
- executed는 `per_change` 전수 금지, `risk_tiered`/`sampled`/`periodic`으로 제한. 그래서 CLI의 `--execute`는 opt-in이고 자동(stop) 트리거는 executed를 직접 안 돌린다(`src/acg/fitness/executed-provider.ts:11-12`).

### 4-3. fail-closed escalation (load-bearing 불변식)

ADR-0004의 "안전 불변식": ImpactGraph/boundary 입력이 부재하거나 `journey_unknown`이면 **high-risk로 escalate하고 절대 sample down 금지**(`ADR-0004:37`). 코드에서 `riskKnown=false`(ImpactGraph 없음)면 risk_tiered/sampled executed 함수를 건너뛰지 않고 **run으로 승격**한다(`src/acg/fitness/fitness-runner.ts:136-140`). CLI 기본값이 `--risk-known=false`인 것도 같은 fail-closed 방향이다.

### 4-4. relocation-aware delta (신규 위반 vs 기존 부채)

`baseline.delta_only`면 "baseline snapshot에 없던 신규 위반"만 차단하고 기존 부채는 추적만 한다(`src/schemas/acg-fitness-function.ts:53-70`, ADR-0004의 delta_only). 순진한 집합 차(current − baseline)는 메서드 이동/추출로 enclosing/path가 바뀐 **기존** 위반을 신규로 오인해 정당한 tidy를 막는다. 그래서 위반 식별자에서 **raw line을 일부러 뺀다**(`rule@path#site`)(§5-1), 그리고 rule 단위로 "사라진 baseline 위반"과 "나타난 current 위반"을 1:1 매칭해 이동은 신규에서 제외한다(§5-3). ADR-0004의 "violation_identity recipe가 생기기 전까지 조건부 유효, 안정 식별자 부재 시 위반을 은닉하지 말고 보고"(fail-closed)와 정합한다(`ADR-0004:39`).

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

### 5-1. `normalizeViolationIdentity` — 이동 불변 식별자

`src/acg/fitness/fitness-runner.ts:58-62`:
```ts
const site = v.enclosing ?? v.symbol ?? '<top>';
const path = v.path ?? '<nopath>';
return `${v.rule}@${path}#${site}`;
```
효과: raw line을 배제해 코드 이동이 새 위반으로 안 세진다. 대가: CodeQL finding은 enclosing symbol이 없어 site가 `<top>`으로 붕괴 → 같은 rule·같은 파일의 여러 finding이 한 식별자로 뭉친다. 이는 **보수적(신규 위반 과소집계)** 방향이라 v0에서 수용한다고 명시(`src/acg/fitness/codeql-provider.ts:10-17`).

### 5-2. `scheduleDecision` — ADR-0004 비용 정책의 코드화

`src/acg/fitness/fitness-runner.ts:119-147`. periodic 트리거는 cadence.periodic 매칭만 실행. per_change는 `cadence.per_change=false`면 skip. executed는 selection별로 갈린다:
- `periodic` → defer(안 돌림)
- `per_change`(명시) → run
- `risk_tiered`/`sampled` → `!ctx.riskKnown`이면 escalate run(fail-closed), riskKnown이고 `risk=high`면 run, 아니면 defer.
deterministic/llm_judged per_change는 항상 run. 이 함수가 "어떤 함수가 이번에 돈다"를 결정하고, 안 도는 함수는 스냅샷에 `outcome:'skip'`으로 기록(`src/acg/fitness/fitness-runner.ts:180-182`).

### 5-3. `relocationAwareNewIds` / `assessDelta` — 차단 대상 계산

`src/acg/fitness/fitness-runner.ts:90-111`: rule별로 사라진 baseline 위반 개수를 예산으로 두고, current의 미매칭 위반이 그 예산을 소진하면 "이동"으로 신규에서 제외, 예산 없으면 진짜 신규. 주석: "COUNT (what gates) is exact" — 순서는 보존하되 게이트하는 건 개수다.

`assessDelta`(`:156-165`): `deltaOnly`면 신규만, 아니면 current 전부를 blocking 대상으로 삼고, `on_violation==='block' && blockingIds.length>0`일 때만 `fail`. 즉 `warn`/`track` 함수는 위반이 있어도 절대 `fail`로 착지하지 않는다(그래서 stop 훅이 fail만 continuation으로 본다).

### 5-4. `runFitness` — 조립 + 스키마 검증

`src/acg/fitness/fitness-runner.ts:172-210`: 각 fn을 scheduleDecision→(run이면)provider.evaluate→(skipped면 skip)→assessDelta로 접어 results를 만들고, 반환 직전 `acgAssuranceSnapshot.parse(...)`로 검증한다(스키마 위반이면 예외 → CLI가 RUNTIME_ERROR로 처리). `produced_by:'agent'` 고정.

### 5-5. provider 3종의 fail-closed 규약

- `commandProvider`(`command-provider.ts:19-52`): deterministic이 아니면 skip+reason. `codeql-sarif:` 스펙이면 SARIF 파일이 **없을 때 fabricated pass가 아니라 skip**(`:33-39`) — "run ditto codeql review first". 그 외 스펙은 `sh -c`로 실행, stdout 비어있지 않은 각 라인 = 위반 식별자.
- `injectedProvider`(`injected-provider.ts:19-80`): verdict 파일 부재/파싱실패/스키마거부 → **모든 fn skip**(`:50-56`). 해당 fn verdict 없음 → skip. executed인데 `evidence_ref` 없음 → skip(`:68-72`). verdict=pass면 빈 위반, fail이면 `violation_ids`(없으면 `fn.id`) 반환. 스키마 단계에서 llm_judged가 reproducibility 없으면 파일 전체 파싱 실패 → 전 fn skip(증거 없는 pass 금지).
- `executedProvider`(`executed-provider.ts:136-168`): mode!=executed면 skip. `execution` 정책의 `1+retries`회 실행 후 `decideExecutedOutcome`으로 접는다.

### 5-6. `decideExecutedOutcome` — flake 정책(순수)

`src/acg/fitness/executed-provider.ts:49-78`: 모든 attempt가 errored(timeout/spawn)면 skip(fail-closed). non-errored가 전부 같은 위반셋이면 안정 → 그 셋. 불일치(flaky)면: `quarantine`=skip(차단 안 함), `retry`=위반 최소 attempt 채택, `fail`(기본)=모든 attempt 위반의 **합집합**(엄격). `requires_clean_build=true`면 non-zero exit를 빌드 실패로 보아 errored 처리해 빈/부분 추출을 clean으로 오판하지 않음(`:113-119`).

### 5-7. drift 집계·게이트

`computeDrift`(`drift.ts:84-138`): function_id별로 점을 `at` 오름차순 정렬, violations가 정의된 첫·끝 점 비교로 direction 판정(정의된 점 2개 미만이면 `insufficient`). `cumulative_new_violations`는 점들의 new_violations 합. 함수는 rising>flat>insufficient>falling 순으로 정렬(`DIRECTION_RANK`). `assessDrift`(`:57-69`): rising이면서 cumulative_new_violations ≥ minNew인 것만 concerning. 주석: "한 변경 내 신규위반은 이미 fitness run이 게이팅하므로, 여기선 변경을 가로지른 추세만 본다"(`drift.ts:54-55`).

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위(위 파일들 + change-contract/stop 훅 배선 + ADR-0004)에서:

- provider 추상화와 fail-closed 규약은 세 provider 모두 일관되게 구현돼 있다(skip+reason, fabricated pass 없음). 스키마(llm_judged reproducibility 필수, executed evidence_ref)와 provider 게이트가 서로를 받친다.
- ADR-0004 Q4의 mode별 스케줄·fail-closed escalation은 `scheduleDecision`에 그대로 반영됐다.
- **CLI에서 llm_judged를 직접 돌리는 경로는 없다**(의도된 것). `commandProvider`는 non-deterministic을 skip하고, `executingProvider`도 llm_judged는 verdict 없으면 skip(`executed-provider.ts:183-189`). 즉 `--execute`만 주고 `--verdicts`를 안 주면 llm_judged는 평가되지 않고 skip으로 남는다 — 불변식대로다.
- **미확인/갭**: `codeqlFindingToViolation`(codeql-provider.ts:22)은 CodeQL finding에 enclosing symbol을 안 채워 §5-1의 `<top>` 붕괴가 실제로 일어난다. 이는 코드 주석이 자인한 v0 한계(신규 위반 과소집계)이지 버그는 아니지만, delta_only의 정밀도를 실질적으로 낮춘다.
- **미확인**: ADR-0004는 risk tiering base를 `ChangeContract.risk_default`로 두라 했으나(`ADR-0004:37`), 이 러너의 `FitnessContext.risk`는 CLI `--risk`/stop 훅(항상 unknown)에서만 온다. ChangeContract.risk_default를 자동으로 읽어 risk를 채우는 배선은 확인 범위에서 보이지 않았다 — 현재는 사람이 `--risk`로 주거나 fail-closed escalate에 의존한다(추론).

## 7. 잠재 위험·부작용·재설계 시 고려점

- **재설계 시 보존해야 할 불변식**:
  1. ditto가 LLM/테스트를 직접 호출하지 않음 → provider 경계(deterministic만 직접 실행, 나머지는 주입 verdict). 이걸 무너뜨리면 verdict 스키마의 재현성 게이트가 무의미해진다.
  2. fail-closed 도처: risk unknown→escalate, SARIF/verdict 부재→skip(pass 아님), executed 전부 errored→skip, clean build 미증명→errored. 증거 없는 pass 금지가 이 기능의 신뢰 근거다.
  3. delta의 count가 게이트한다(순서 아님). relocation-aware 매칭을 바꾸면 정당한 tidy를 신규 위반으로 오판할 위험.

- **약점 / 확장 시 깨질 지점**:
  - `<top>` 붕괴(§5-1, §6): 같은 rule·파일의 다중 위반이 1개로 뭉쳐 신규 위반을 놓칠 수 있다. enclosing symbol을 CodeQL finding에 채우는 강화가 필요.
  - `commandProvider`/`executedProvider`가 임의 `sh -c spec`를 repoRoot에서 실행한다(`command-provider.ts:43`, `executed-provider.ts:91`). fitness-function.json이나 `--from`이 신뢰되지 않으면 임의 명령 실행이다 — 입력 출처(change-contract 컴파일 vs 외부 파일) 신뢰 경계를 재설계 시 명시할 것.
  - drift의 `direction`은 first vs last 두 점만 비교한다(`drift.ts:107-116`). 중간이 튀어도 끝이 같으면 flat으로 보여 톱니형 추세를 놓칠 수 있다(회귀 아님, 설계 단순화).

- **동시성/정합성/drift**:
  - stop 훅의 `maybeRunFitness`와 CLI `fitness run`이 같은 `assurance-snapshot.json`을 쓴다. 동시에 돌면 마지막 쓰기가 이긴다(파일 락 없음). 지문 스킵은 stop 훅에만 있어 CLI는 항상 재계산·덮어쓴다.
  - `loadAssuranceSnapshots`는 malformed/부재 스냅샷을 조용히 skip한다(`drift.ts:157-159`). 이는 의도된 것("빠진 점은 침묵 손실이 아니라 그 변경이 fitness를 안 돌린 것")이지만, 스냅샷이 손상되면 drift 추세가 조용히 짧아진다.
