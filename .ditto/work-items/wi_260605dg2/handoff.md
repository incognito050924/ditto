# Handoff — ACG 후속 스레드 (2026-06-05 세션, B·D만 남음)

> **SUPERSEDED → `wi_260605aw1/handoff.md`** (B 트랙 완료, 후속은 거기로). 이 문서는 이력 보존용.

> 최신 thread 핸드오프. 이전(`wi_260605mm1/handoff.md`)을 대체. 기준 **main = 186a45c(세션 시작) → 8bac3e6(현재)**.
> 이번 세션은 ACG 잔여 빌드 항목을 거의 다 닫았다. **남은 건 B(설계 선행)·D(결정)뿐** — 둘 다 코드보다 결정이 먼저다.

## 0. 새 PC/세션 셋업
```bash
git pull                 # main 8bac3e6 이상
bun install
bun run build && bun link
bun test                 # green (1123 pass / 3 skip / 0 fail)
```
- **CodeQL 로컬 설치 필요**(repo에 없음). 단위테스트는 fixture/합성이라 없어도 통과; 실 분석·boxwood probe만 codeql 필요(`~/.local/bin/codeql`, osx64 번들).
- bare `ditto`는 dist → 소스 변경 시 `bun run build`(또는 `bun run dev <cmd>`).
- `.ditto/cache/`(codeql DB)·`evidence/`는 gitignore. boxwood는 read-only(DB는 /tmp).

## 1. 이번 세션에 끝낸 것 (전부 main push, 각 work item에 completion.json)
순서대로:
- **wi_260605cr1 — cross_repo unresolved emitter**: 단일모듈 CodeQL DB에서 형제모듈(JAR) 타입 의존이 `fromSource()`에서 빠져 침묵 손실되던 것을 `ImpactGraph.unresolved{kind:cross_repo}`로 기록. `relations.ts` UNRESOLVED_QUERY_{JAVA,PY,JS}, `codeql-analyzer.ts` matchesInternalGlob. stop.ts `impactForcesContinuation`이 이미 소비(완료게이트 차단). 실 boxwood automation-engine으로 실증(domain.** 9패키지, Spring 무시).
- **wi_260605cr2 — internal_packages 선언 + JVM 가드**: `internal_packages`를 타입드 `{type:'glob'|'path',value}`로 진화(glob=cross_repo 분류, path=로컬 JAR 위치). `ditto architecture internal-packages` 선언 명령. JVM(java/kotlin) impact/boundary 가드 — 로컬 JAR 존재+선언 누락→block(CLI exit65/훅 exit2), 미선언·JAR없음→warn. CLI 내장(`internal-packages.ts` runInternalPackagesGuard) + PreToolUse 훅(parseJvmCodeqlCommand) **양쪽**.
- **ADR-0007 (knowledge)**: cross_repo 처리 정책(명시 선언 + fail-loud 가드). glossary에 cross_repo·internal_packages 승격, CLAUDE.md `ditto:knowledge` projection(drift 0).
- **wi_260605sg1 — 단계6 semantic 게이트(소비)**: `stop.ts` semanticForcesContinuation — `semantic_safe='no'`(비의도) 또는 `'unverified'`면 완료 차단(intended_breaking=true·`'yes'`는 통과). `semantic-compatibility.json` ledger(absent no-op, malformed fail-closed). **생산자는 미구현(=B)**.
- **wi_260605ad1 — Assurance drift 뷰**: `drift.ts` computeDrift — work-item을 가로지른 AssuranceSnapshot 시계열을 function별 추세(rising/falling/flat/insufficient)+누적 new_violations로. `ditto fitness drift`.
- **wi_260605ex1 — executed 모드 실행 엔진**: `executed-provider.ts` — `execution` 정책(timeout_s/retries/flake_policy) 적용해 spec 직접 실행. `ditto fitness run --execute` opt-in(비용 큰 모드라 자동 stop 트리거 아님). decideExecutedOutcome 순수 flake 판정.
- **wi_260605cmm — Change Map Mermaid 렌더러**: `render.ts` renderMermaid(50-change-map §3, 텍스트 정본에서 파생). `ditto change-map --output mermaid`.
- **wi_260605dg2 — drift 소비처(게이트)**: `drift.ts` assessDrift — rising 추세+누적 신규위반≥임계→concerning. `ditto fitness drift --gate [--min-new-violations N]` → exit 1(CI가 SLOP 가속에 빌드 실패).

## 2. ★ 다음 세션 — ACG 잔여 작업 (우선순위순)
순수 빌드 항목(A=Mermaid, C2=drift 게이트 포함)은 다 닫혔다. 남은 둘은 **결정이 먼저**다.

### B. semantic verdict 생산 파이프라인 (OBJ-43) — 설계 선행
- **현재**: 게이트(sg1)는 `semantic-compatibility.json`을 소비할 준비 완료. **생산자가 0** — 아무 명령도 그 파일을 안 씀 → 게이트가 불활성(에이전트 수동 작성해야 발동). `impact-graph.json`은 `ditto impact`가 쓰지만 semantic은 생산 명령 없음.
- **왜 어려운가**: 의미 호환성은 도메인 판정(`User|null→User`는 타입OK·의미깨짐)이라 **정적 도출 불가** — CodeQL이 의미를 못 봄. 본질적으로 (a) diff에서 시그니처 변경 탐지(준-결정론) + (b) 의미 호환성 **LLM/에이전트 판정** + (c) characterization test 생성/연결. **연결 규칙(어느 acceptance·무엇이 트리거) 미정**.
- **권장 착수**: `/ditto:dialectic`로 설계부터(생산 트리거·LLM 판정 신뢰성·injected-verdict 재사용 여부). 인프라 재사용: `acgReproducibility`(llm_judged 재현성), `injected-provider`(에이전트 verdict 주입) 패턴.
- **수용기준 골격**: diff(시그니처 변경)→SemanticCompatibility 산출→`semantic-compatibility.json` 기록→sg1 게이트가 자동 발동. 정적부(시그니처 변경 탐지)는 단위, LLM 판정부는 재현성 고정.

### D. 호스트-추상 기계 도입 — 결정(아마 보류)
- **빌드 아니라 결정**. 설계가 "2nd 바인딩 전까지 만들지 않는다"(v0-plan §1, Charter §4-3)로 보류 규정. **2nd 바인딩(Java/Kotlin/Python + boxwood 실증)은 이번 스레드로 사실상 완료** → 이제 판단 가능.
- **쟁점**: 00-framework가 현재 **provider-슬롯 구조(analyzer 주입)를 이미 "stack-agnostic의 기계적 정의"**라 부름 → 추가 추상이 정말 필요한지 자체가 쟁점. 권장: **결정하되 아마 보류**(조기 추상화 = 헌장이 경고하는 바로 그것). 결정을 ADR로 남기면 충분.

### 잔여 소소 (옵션)
- **executed 자동 stop 트리거**: 현재 `--execute` opt-in만; `stop.ts` maybeRunFitness는 command/injected만 씀 → executed fitness는 자동으로 안 돎(의도된 비용 회피). "stop에서 플래그로 executed 자동 실행"은 가능한 후속.
- **어휘 enum 승격**(`risk_reason_code`, `hidden_effect`/`temporal_coupling`): 설계상 "2nd 바인딩에서 반복성 확인 후"로 명시 보류. 미미.
- **C1(주기 스케줄러)**: **안 한다.** DITTO는 데몬 아니라 CLI/hook(ADR-0001) → 스케줄은 CI cron 몫(예: `0 0 * * 1 ditto fitness drift --gate`). periodic 트리거 자체는 fitness run이 이미 지원.

## 3. gotcha (이번 세션)
- **stop.ts 게이트 패턴**: 새 ACG 게이트 = 순수 `*ForcesContinuation(artifact)→string[]` + readArtifact ledger(absent no-op·malformed fail-closed) + reasons 집계. impact/assurance/review/semantic 전부 동형. ledger는 `.ditto/work-items/<wi>/<name>.json`.
- **drift 시계열 단위**: 스냅샷은 work-item당 1개(maybeRunFitness가 매 Stop 덮어씀) → 시계열의 점=work item(변경 가로지른 추세만, 한 변경 내 이력 아님). 의도된 한계(§8).
- **executed 출력 계약**: deterministic과 동일(stdout 라인=위반, exit code 무시·timeout/spawn만 errored). 테스트 러너가 exit로만 신호하면 pass로 보일 수 있음 — spec은 위반을 stdout으로 방출해야.
- **internal_packages 가드 '누락' 정의**: glob 미선언 OR 로컬 JAR이 path 엔트리로 안 덮임. JAR unzip해 패키지 단위 커버리지까진 안 봄(비용 회피).
- **globToRegExp 재사용**(boundary.ts): `^…$` 앵커, `**`=any, `*`=non-slash. 패키지 글로브(점 구분)·경로 글로브 둘 다 매칭.
- (이월) work item id=`wi_`+8자↑영숫자. completion `evidence.kind`∈command/file/artifact/url/note. acceptance verdict∈pass/partial/fail/**unverified**(pending 아님). final_verdict=pass면 in-scope unverified 금지. CLAUDE.md managed/knowledge 블록 손편집 금지(큐레이터+브리지만).

## 4. 검증 상태 (fresh)
- 전체 `bun test`: **1123 pass / 3 skip / 0 fail**. `bun run lint`(biome) clean. `bun run build` clean. repo-self-validation 10 pass.
- 실 boxwood automation-engine CodeQL probe(cr1/cr2): cross_repo 분류·가드 block/ok 실증.
- 트리 clean. 이 핸드오프 커밋 후 main = (이 커밋).

## 5. forbidden scope creep (다음 세션이 피할 것)
- B를 설계 없이 바로 LLM 호출 코드로 착수 금지(OBJ-43 연결 규칙 먼저).
- D를 "이제 됐으니" 호스트-추상 기계 빌드로 직행 금지(결정 먼저, 보류가 기본값).
- C1(in-repo 스케줄러/데몬) 만들기 금지.
- 이미 닫힌 work item(cr1~dg2) 재작업 금지 — 재개 대상 아님.
