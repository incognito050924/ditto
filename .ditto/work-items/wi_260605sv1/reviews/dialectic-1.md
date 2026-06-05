# Dialectic-1 — wi_260605sv1 · OBJ-43 semantic verdict 생산 파이프라인 설계

- **mode**: design · **verdict**: **revise** · max_rounds 1
- **target**: sg1이 소비 준비를 마친 `semantic-compatibility.json`의 생산자 설계
- **Opponent**: Codex (codex-plugin-cc:codex-rescue), fallback 없음

## 쟁점 5개 합의 결론

| # | 쟁점 | 결론 |
|---|---|---|
| 1 | 정적부 별도명령 vs impact 흡수 | **별도명령 유지.** 단 MVP `detect`는 `--file --symbol --before --after` 명시입력 seed만. diff 자동추출은 분리(O7) |
| 2 | LLM 판정 파일주입 vs CLI 직접호출 | **파일주입 확정** (불변식 acg-fitness-verdict.ts:6-8). 단 reproducibility 집행은 schema 책임 |
| 3 | 트리거 signature 강제 vs 좁힘 | **좁힘** — 'exported signature shape changes only' 명시(O8). 수용기준에 'signature 변경 시 seed 존재'를 완료 전 필수 절차로 박음(O2) |
| 4 | characterization 이 work item vs 분리 | **분리.** 단 이 work item에선 무근거 `semantic_safe=yes` 차단(O4·O6 봉합) |
| 5 | 수용기준 골격 | required_edits로 확정 |

## 초안 전제를 깬 결정적 증거
- **O5 (reproducibility 미집행)**: `acgFitnessVerdictReproducibility`(acg-fitness-verdict.ts:15-42)는 `model_version` 필수+superRefine로 실제 집행하나, `acgSemanticCompatibility`(acg-semantic-compatibility.ts:31-35)엔 reproducibility 필드 **자체가 없음** → Producer의 "fitness 동형" 주장이 오히려 "스키마 변경 없음" 전제를 반증.
- **O3 (데드락)**: `semanticForcesContinuation`은 verdict만(stop.ts:239-248), `verify`(verify.ts:103-123)·`autopilot`(autopilot-complete.ts:20-50)은 AC verdict만 갱신 → unverified seed를 해소하는 경로가 없어 stop loop 영구 차단. "stop 0줄" + resolver 부재면 정상 흐름이 막힘.
- **O1 (단일 change)**: `change`가 단일 객체(line 13)+stop이 파일 1개만 읽음 → 다중 시그니처 변경 시 배열=malformed exit2 또는 overwrite=false pass.
- **O4 (old_meaning)**: `min(1)` 필수라 빈 값=malformed, non-empty TODO=통과 → sentinel 규약 필요.

## Admissibility (admissible 7건 전부 해소, reject 0)
O1(critical)·O2~O7(high) admissible → accept. O8·O9(medium) 비차단·기록. Opponent 반론이 모두 파일 직접확인 근거였고 재확인 결과 전부 사실.

## required_edits (구현 진입 시)
1. `acg-semantic-compatibility.ts:31-35` — verdict에 `reproducibility: acgFitnessVerdictReproducibility.optional()` + superRefine(yes/no∧agent → model_version 필수). **재사용, 신규 추상 아님** (O5)
2. `acg-semantic-compatibility.ts:14` — old_meaning sentinel + superRefine(unverified만 sentinel, yes/no는 실제 의미) (O4)
3. `ditto semantic detect` 신규 — 명시입력 unverified seed, **다중 pair fail-closed 거부**, cli/index.ts 등록 (O1·O2)
4. `ditto semantic verdict` resolver 신규 — agent 판정 주입해 seed 해소 (O3 데드락)
5. 수용기준 (a)CLI 등록·출력 (b)다중변경 malformed/단일 fail-closed (c)sentinel superRefine (d)reproducibility required (e)seed→block→주입→clear e2e (f)deadlock 회귀
6. 설계 현상태 drift 정정 — 'schema+stop consumer 존재, producer/resolver 미구현' (O9)

## MVP 경계
**포함**: 스키마 최소변경 2개(reproducibility, old_meaning sentinel) + `detect`/`verdict` 2명령 + 다중변경 fail-closed + 절차 게이트 수용기준.
**분리 후속(사용자 승인 후 생성)**: `wi-semantic-diff-extractor`(O7 diff→signature 자동추출) / `wi-semantic-characterization`(O6 yes 수용조건) / `wi-semantic-autowiring`(O2 자동배선·O8 behavior).

## 남은 열린 질문 (사용자 가치 판단)
1. resolver를 별도 `semantic verdict` 명령 vs 기존 `verify` 흡수 — verify 책임 경계 = 사용자 판단.
2. MVP에서 `semantic_safe=yes`를 금지(unverified/no만)할지 reproducible verdict 동반 시 허용할지.
