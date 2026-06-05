# Handoff — ACG 트랙 종결 (2026-06-05 세션 종료, 다른 PC 인계용)

> 기준 main = 이 핸드오프를 담은 커밋(아래 §0에서 `git pull` 후 HEAD 확인).
> 이번 세션은 핸드오프 `wi_260605aw1`의 남은 ACG 후속(A/B/C)을 전부 닫고, **ACG governance
> 표면 자체를 종결**했다. 결론부터: **ACG에 남은 작업 없음**(floating 백로그 0).

## 0. 셋업 / 현재 상태
```bash
git pull                 # 이 세션 커밋들(cd26c30 A → 826e88e B후속 → a63d653 마무리)
bun install
bun run build && bun link
bun test                 # 1184 pass / 9 skip / 0 fail
```
- **CodeQL 로컬 필요**(semantic/signature e2e). `~/.local/bin/codeql`(2.25.5). 단위는 CodeQL 없이 통과; e2e는 `CODEQL_E2E=1 CODEQL_BIN=~/.local/bin/codeql bun test <file>`로만(기본 skip).
- **다른 PC 주의**: signature/relations e2e는 java=build-mode none, **kotlin은 kotlinc 필요**(probe만), python·js는 빌드 불필요. CodeQL 미설치면 e2e 9 skip 그대로(단위는 다 돔).
- bare `ditto`는 dist → 소스 변경 시 `bun run build`.

## 1. 이번 세션에 닫은 것 (전부 main, 각 work-item.json done)
- **wi_260605ml1 (A)** — 다언어 signature 바인딩. `SIGNATURE_QUERIES`에 java/kotlin/python 등록(`signature-codeql.ts`). Java `getParameterType`/`getReturnType`(제네릭 보존), kotlin=java 쿼리 재사용, **python은 동적타이핑이라 파라미터 이름+arity**(타입 advisory 제외). 미바인딩 fail-loud 유지. probe 3언어 실DB + 단위 13 + 실 CodeQL e2e 4 pass. ADR-0006 정합. 커밋 `cd26c30`.
- **wi_260605ch1 (B)** — characterization 게이트. 스키마 superRefine: `produced_by=agent ∧ yes → characterization.exists ∧ test_ref`. judge model은 판정, test가 witness. resolver/CLI `--characterization-test`(증거 인용, 생성 아님). 커밋 `5148a19`.
- **wi_260605ur1 (B 후속)** — user yes를 reproducibility에서도 면제. reproducibility 규칙을 `agent ∧ yes`로 좁힘 → 대칭: **agent yes = 둘 다 요구 / user yes = 둘 다 면제**(intended_breaking 인간-오버라이드 선례). 커밋 `826e88e`.
- **wi_260605dh1 (C)** — 호스트-추상 기계 **보류** 결정. provider 슬롯이 이미 stack-agnostic·load-bearing(A가 코어 변경 0으로 가산된 게 실증). **ADR-0008** + 철회조건. 코드 변경 0. 커밋 `26d8ef9`.
- **wi_260605acg (마무리)** — ACG governance 표면 종결. 커밋 `a63d653`. 상세 §2.

## 2. ACG 완성 상태 (왜 "남은 작업 없음"인가)
권위 진실원 = `reports/design/agentic-governance/v0-implementation-plan.md`. 그 **§2.2 "OUT(미구현)" 항목이 이번 세션 대조에서 전부 IN으로 확인**됨(문서가 stale였음, 이번에 정정):
- executed mode 실행 → `src/acg/fitness/executed-provider.ts` ✓
- assurance drift → `src/acg/fitness/drift.ts` ✓
- semantic 게이트 → A/B/C + sv1/de1/aw1 ✓
- forbidden_scope 집행 → path/glob/layer/surface 즉시 + **symbol은 저장시점 CodeQL 해소**(`src/acg/scope/symbol-expand.ts`, hot-path는 `resolve.ts`가 symbol 스킵) ✓
- Mermaid 렌더러 → `src/acg/change-map/render.ts` ✓

남은 micro-item 4건은 **ADR-0009**에 "구현 안 함 + 철회조건"으로 명시 종결:
- `semantic-scan-status.json`(복잡성>효과) · nudge opt-out(실 신호 은폐 위험) · executed 자동-stop(CodeQL 비용, opt-in 유지) · 어휘 enum 승격(표본 1, 조기추상화).
- **철회조건 트리거 시에만 재개**(2nd 바인딩, executed 비용 해소 등). 그 전까지 ACG는 닫힌 것으로 본다.

## 3. 다른 PC에서 "이어서" 할 게 ACG라면 → 없다. 다른 트랙이라면:
- **autopilot/오케스트레이션 트랙**이 열린 백로그다(ACG 아님). `.ditto/work-items/`의 2026-06-02/03 draft 다수: planner 콘텐츠 승격, owner 제작([VERIFY] kind), cleanup 배선, dialectic id, forward 재확장 등. 진실원은 `reports/design/contracts/autopilot-contract.md`.
- 이 트랙으로 가려면 그 contract와 draft work item들을 먼저 스코핑할 것(이번 세션은 손대지 않음).

## 4. gotcha / 연속성
- **연속성 = memory + git + work-items**. 메모리: `ditto-primary-lifecycle`(위임계약·세 기둥), `ditto-mental-model`, `dogfooding-increment-thread`.
- **ADR load-bearing**: 0001(런타임·Stop 성능계약, 훅에 CodeQL 금지) · 0002(schema는 Zod 정본 → `bun run schemas:export`, 손편집 금지) · 0006(결정론 추출은 CodeQL 단일, 언어 컴파일러 직접분석 금지) · 0008(호스트추상 보류) · 0009(ACG micro-item 종결).
- **semantic 명령 4개**: `scan`(수동 단일 seed, blocking) · `observe`(자동 관측, 비-게이트, fingerprint skip) · `detect`(명시 seed) · `verdict`(resolver, `--characterization-test`·`--model-version`).
- **semantic_safe=yes 증거**: agent → reproducibility(model_version) + characterization(test_ref) 둘 다 / user → 둘 다 면제. CLI는 seed가 produced_by=agent라 항상 둘 다 요구.
- work item id = `wi_`+8자↑. verdict ∈ pass/partial/fail/unverified. 비종단 status(partial/unverified/blocked)는 re_entry 필요. final pass면 in-scope unverified 금지.

## 5. forbidden scope creep
- ADR-0009 철회조건 미충족인데 micro-item 4건 손대지 말 것(명시 종결됨).
- 닫힌 work item(ml1/ch1/ur1/dh1/acg/sv1/de1/aw1/244/s5r) 재작업 금지.
- Stop 훅에 CodeQL 금지(ADR-0001). PreToolUse hot-path에 CodeQL 금지(symbol은 저장시점만).
- 다언어 signature를 언어 컴파일러로 직행 금지(CodeQL 쿼리만, ADR-0006).
