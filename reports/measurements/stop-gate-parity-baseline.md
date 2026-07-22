# Stop-gate 완료판정 — rebuild vs 옛 src 경로 parity·지연 baseline

> **목적**: rebuild `evaluateStopGate` 경로와 옛 src `assembleCompletionFromGraph`
> 경로의 판정 일치/불일치와 지연을 동형 fixture 쌍으로 나란히 측정한 baseline.
> **소비자**: 순효능 증거 감사(rebuild→완전 대체 로드맵)의 **비차단 방증** — 어떤
> flip/재진입 결정도 게이트하지 않음.
> **수명**: 단수명(지표 정의는 보존, 수치는 재산출 — 산출 명령 아래 명시).
> **산출 명령**: `bun run scripts/measure-stop-gate/run.ts`

측정 시점: 2026-07-22T12:34:35.878Z · 커밋 `6c6cf97c4799eb52ed147b8b68f5b6fd3fda01aa` ·
harness self-check 전부 ok(`pair_consistency`, `stats_rules`, control 3종),
`git_porcelain_unchanged: true`(워킹트리 비변경 자가검증), exit 0.

## 1. 지표 정의

- **시계**: `Bun.nanoseconds()` monotonic. `Date.now()` 금지(1ms 해상도로 sub-µs
  코어 측정 불가).
- **배치 반복**: 클래스당 N=30 샘플, 샘플 1개 = K=20 내부 실행의 평균
  (`inner_reps_per_sample`), 측정 전 warmup 5배치 + cold 첫 샘플은 별도 기록(집계
  제외). 훅 1사이클은 subprocess라 K=1, N=30(실러너는 N=3), warmup 2.
- **중앙값**: 정렬 후 홀수 N → 가운데 값, 짝수 N → 가운데 2값의 평균.
- **p95**: nearest-rank — 정렬 후 index `ceil(0.95·N)-1`.
- **러너 비용 분리**: 훅 1사이클을 스텁 러너(고정 exit 0)와 실러너로 각각 측정하고
  두 **중앙값의 차분**을 러너 비용으로 보고(`runner_cost_ns_median_diff`).
- **유효 N**: 판정·통계에 실제 반영된 실행 수. 코어는 클래스·경로별 720
  실행(36배치×20; warmup·cold 포함 전수 실행이 판정 유효성 검사를 통과한 수),
  훅은 timed 샘플 중 invalid 아닌 수(`valid_n`; invalid_runs는 이번 실행 0건).
- **exit 3-버킷**(훅 1사이클): `allow` = raw exit 0 · `block` = raw exit 2 ·
  `error` = 그 외 exit·null exit·signal·outer timeout. raw exit와 signal을 그대로
  기록하며 `?? 1` 류 접기(fold) 없음.
- **판정 규칙**: rebuild `allow` = `evaluateStopGate().exitCode === 0`,
  src `allow` = 조립된 completion의 `final_verdict === "pass"`.

지연 절대치는 환경 종속이다: darwin(arm64) · bun 1.3.14 · warm 파일시스템
캐시에서의 값이며, 다른 OS/bun 버전/콜드 캐시에서는 절대치가 달라진다. 비교는
같은 실행 내 두 경로의 상대 관계로만 읽는다.

## 2. 순수 코어 지연 (단위 ns, 클래스·경로별 유효 N=720)

경로: `rebuild` = `evaluateStopGate`(rebuild/hook/stop-gate.ts) ·
`src-assemble` = `assembleCompletionFromGraph`(프로덕션 shape: derive+build+floor
projection) · `src-bare` = deriveAcVerdicts+buildCompletion 맨몸 쌍.

| 클래스 | 경로 | median | p95 | min | max | mean |
|---|---|---:|---:|---:|---:|---:|
| all-green | rebuild | 285.425 | 912.5 | 179.2 | 2085.45 | 379.52 |
| all-green | src-assemble | 11546.875 | 19381.25 | 9947.9 | 19929.15 | 13053.75 |
| all-green | src-bare | 9095.825 | 12968.75 | 5933.3 | 96760.4 | 11952.92 |
| no-evidence-pass | rebuild | 238.55 | 527.1 | 216.7 | 614.6 | 271.95 |
| no-evidence-pass | src-assemble | 8854.175 | 11277.05 | 7193.75 | 12620.8 | 9193.47 |
| no-evidence-pass | src-bare | 5770.825 | 6814.6 | 5297.95 | 7360.4 | 5930.55 |
| red-tests | rebuild | 154.175 | 354.15 | 135.4 | 368.75 | 179.8 |
| red-tests | src-assemble | 9448.95 | 77012.5 | 8204.2 | 171158.3 | 18801.53 |
| red-tests | src-bare | 20269.8 | 185954.2 | 5525 | 507989.6 | 39514.09 |
| pending-residual | rebuild | 89.6 | 162.5 | 87.5 | 322.9 | 104.31 |
| pending-residual | src-assemble | 8195.8 | 33627.05 | 7100 | 103802.1 | 13630.97 |
| pending-residual | src-bare | 5948.925 | 7439.6 | 5381.25 | 7477.05 | 6002.36 |
| evidence-empty-string | rebuild | 104.2 | 122.9 | 102.05 | 237.5 | 113.33 |
| evidence-empty-string | src-assemble | 5847.925 | 6977.1 | 5218.75 | 71189.55 | 8112.91 |
| evidence-empty-string | src-bare | 4828.1 | 5714.6 | 4591.7 | 6150 | 4925.49 |
| evidence-whitespace | rebuild | 121.85 | 320.85 | 108.3 | 358.3 | 133.75 |
| evidence-whitespace | src-assemble | 5536.475 | 6704.15 | 5241.7 | 7554.15 | 5673.82 |
| evidence-whitespace | src-bare | 5323.95 | 12695.85 | 4660.4 | 59300 | 7449.65 |
| empty-degenerate | rebuild | 68.75 | 150 | 52.05 | 958.3 | 100.77 |
| empty-degenerate | src-assemble | 5060.4 | 6672.9 | 4720.8 | 6827.05 | 5236.39 |
| empty-degenerate | src-bare | 5065.625 | 5822.9 | 4612.5 | 5860.45 | 5116.25 |

읽기: rebuild 코어는 전 클래스 median 68.75–285.425ns, src-assemble은
5060.4–11546.875ns — 두 자릿수 배율 차이지만 절대치는 어느 쪽도 µs~수십µs
수준으로 훅 1사이클(§3, 수십 ms)에 비해 무시 가능하다. 이 차이는 우열 증거가
아니라 표현 구조 차이(큐 스캔 vs 그래프 폴드+floor projection)의 반영이다.

## 3. 훅 1사이클 (subprocess)

### rebuild stop-hook (실 프로세스 사이클)

| 시리즈 | N(유효) | median (ns) | p95 (ns) | ≈ms (median) | 버킷 분포(전 실행) |
|---|---:|---:|---:|---:|---|
| 스텁 러너 · allow 경로 | 30 | 33945187.5 | 35345417 | 33.9 | allow 33 / block 0 / error 0 |
| 스텁 러너 · block 경로 | 30 | 37835938 | 39383291 | 37.8 | allow 0 / block 33 / error 0 |
| 실러너 · allow 경로 | 3 | 360945125 | 361966750 | 360.9 | allow 5 / block 0 / error 0 |

- **러너 비용 분리(중앙값 차분)**: 326999937.5ns ≈ 327.0ms — 실러너 사이클의
  약 91%가 테스트 러너 비용이고 게이트 자체는 스텁 기준 ~34ms(bun 프로세스 기동
  포함)다.
- 버킷 분포의 실행 수(33, 5)는 warmup·cold 실행 포함 전수이고, 통계 유효 N은
  timed 샘플 수(30, 3)다. invalid_runs 0건.
- 자식 프로세스 env는 sanitize되며 `VEHICLE_WORKSPACE`(1회용 tmpdir)·
  `VEHICLE_TEST_CMD`(결정적 스텁/실러너 명령) 2키만 명시 주입된다.

### src 프록시 (SRC_PROXY_LIMITATION — 하한)

| 시리즈 | 유효 N | median (ns) | p95 (ns) |
|---|---:|---:|---:|
| src 프록시(스키마 파스 + 순수 판정 코어) | 720 | 26073.975 | 32931.25 |

**하한임을 명시**: 옛 src `stopHandler`는 라이브 부수효과(ledger 기록·fitness
자동실행)가 있어 프로세스로 실행하지 않았다. 이 수치는 work-item·autopilot JSON
ledger의 스키마 파스 + 순수 판정 코어(assembleCompletionFromGraph)만 포함하며
프로세스 spawn·세션 포인터/스토어 읽기·fitness·ledger write-back을 제외한
**하한(lower bound)**이다. rebuild 훅 사이클(~34ms)과 직접 비교 불가.

## 4. 판정 일치/오판 표 — 7클래스 × 두 경로

| 클래스 | rebuild | src | match | 예상 발산 | 구조 원인 분류 |
|---|---|---|---|---|---|
| all-green | allow (exit 0, reasons 0) | allow (final_verdict pass) | ✅ | — | — |
| no-evidence-pass | block (overclaim 1) | block (unverified→blocked) | ✅ | — | — |
| red-tests | block (testExitCode 1) | block (barrier failed, in-scope unverified 1) | ✅ | — | — |
| pending-residual | block (pending 1) | block (non-terminal node 1) | ✅ | — | — |
| evidence-empty-string | **block** (overclaim: trim) | **allow** (pass) | ❌ | ✅ | trim vs length>0 (아래) |
| evidence-whitespace | **block** (overclaim: trim) | **allow** (pass) | ❌ | ✅ | trim vs length>0 (아래) |
| empty-degenerate | **allow** (vacuous: item 0·AC 0) | **block** (unaddressed AC→unverified) | ❌ | ✅ | AC min(1) 인코딩 비대칭 (아래) |

`expectation_deviations: []` — 7클래스 전부 fixture 선언 기대와 실측 일치.
기본 4클래스는 두 경로 판정 완전 일치, 경계 3클래스의 발산은 전부 사전 예상된
구조 원인이다:

- **trim vs length>0** (evidence-empty-string · evidence-whitespace):
  rebuild는 `ref !== null && ref.trim().length > 0`로 빈문자열/공백-only
  evidence_ref를 무증거로 거부한다(`rebuild/state/queue-state.ts:85-95`,
  `hasEvidence` + `acsClaimingPassWithoutEvidence`). 옛 src는
  `node.evidence_refs.length > 0`로 **배열 원소 수만** 세어 내용이 빈 엔트리도
  증거로 인정한다(`src/core/autopilot-complete.ts:81-82`, `hasClosingEvidence`).
  같은 상태에 rebuild=block, src=allow.
- **AC min(1) 인코딩 비대칭** (empty-degenerate): src work-item 스키마가
  `acceptance_criteria: z.array(acceptanceCriterion).min(1)`
  (`src/schemas/work-item.ts:262`)로 AC=0을 표현 불가하게 바닥친다. rebuild의
  item 0·AC 0(공허 allow)에 대응하는 src 최근접 표현은 nodes=[] + 최소 1-AC
  (미어드레스 AC→unverified→block)뿐이다. 이 쌍은 설계상 퇴화(degenerate-by-design)
  이며 발산은 런타임 오판이 아니라 **인코딩 아티팩트**다(harness
  `asymmetry_note` 그대로).

**stop_hook_active — 설계 분기 라벨(회귀 아님, match 집계 제외)**:

| 항목 | rebuild | src |
|---|---|---|
| `stop_hook_active=true` 동작 | 계속 차단, `repeatBlock` 플래그만 표기 (`rebuild/hook/stop-gate.ts:57`; 전 클래스 `exit_unchanged: true` 실측) | 즉시 exit 0 반환 (`src/hooks/stop.ts:714`) |

두 경로가 의도적으로 다른 정책을 택한 지점이므로 일치/오판 표에 넣지 않고 설계
분기로 별도 기록한다.

## 5. 결함 후보 기록 (수정 아님)

- **옛 src 경로의 내용-빈 evidence 관대함**: §4의 trim vs length>0 그대로 —
  `src/core/autopilot-complete.ts:81-82`가 evidence 엔트리의 **개수**만 검사해
  빈문자열/공백-only 엔트리를 증거로 인정한다. rebuild
  `rebuild/state/queue-state.ts:85-95`는 trim으로 거부(fail-closed). 무증거 pass를
  fail-closed로 막는다는 공통 계약 관점에서 src 쪽이 관대(느슨)한 쪽이다.
  **은퇴 예정 코드이므로 수정하지 않고 감사 증거로만 기록한다.**

## 6. 재현 절차

1. 실행 명령(기본값이 이 보고서의 설정과 동일):
   ```
   bun run scripts/measure-stop-gate/run.ts --out <결과.json>
   ```
   옵션: `--n <int>`(코어 샘플, 기본 30·바닥 30 강제) · `--inner <int>`(내부 반복,
   기본 20) · `--hook-n <int>`(훅 샘플, 기본 30) · `--real-n <int>`(실러너 샘플,
   기본 3) · `--skip-real`(실러너 생략) · `--self-check`(타이밍 없이 검증만).
   이번 실행 설정: core_samples 30 · core_inner_reps 20 · core_warmup_batches 5 ·
   hook_samples 30 · real_runner_samples 3.
2. exit 0 및 결과 JSON의 `self_check.git_porcelain_unchanged: true` 확인(하네스가
   워킹트리·실 `.ditto/local` 비접촉을 자가 강제 — 위반 시 abnormal exit).
3. fixture 7클래스(동형 쌍, `scripts/measure-stop-gate/fixtures.ts`):
   - `all-green` — 정상 green: 큐 소진·AC pass+실증거·테스트 green / 전 노드
     pass+명령 증거·barrier green
   - `no-evidence-pass` — 과잉주장: AC pass인데 evidence_ref null / pass 노드의
     evidence_refs 0개
   - `red-tests` — 스위트 red: 러너 exit 1 + 그 외 green / settled-tree 테스트
     barrier 노드 failed
   - `pending-residual` — 미완 잔여: exit null 큐 항목 1 / non-terminal(pending)
     어드레싱 노드 1
   - `evidence-empty-string` — 경계: evidence_ref가 `""` (trim vs length 분기)
   - `evidence-whitespace` — 경계: evidence_ref가 공백-only
   - `empty-degenerate` — 경계: 빈 상태 퇴화 쌍(AC min(1) 인코딩 비대칭)
4. 측정 시점 커밋: `6c6cf97c4799eb52ed147b8b68f5b6fd3fda01aa`
5. 측정 대상 4파일 sha256(결과 JSON 스탬프 그대로):
   - `rebuild/hook/stop-gate.ts` — `eff05136dbbe3baeece17b3593d9cfedefc8bc0b0dd704d85bde43f8b6165fa9`
   - `rebuild/hook/stop-hook.ts` — `26498a1db105b6cda1926aed62ddc450a95ec504468f3fd7062a196f2430a003`
   - `src/core/autopilot-complete.ts` — `a08658779b2c1dd0e8cd76c25dc84420cee639b4018aad68407c83eb630d8275`
   - `src/hooks/stop.ts` — `abf02479bddf04c2405d66b442e76602a5ff140cdfd5f188512c3f07e2d8f1dc`
6. 요구 바이너리: bun 1.3.14(측정 시점; `Bun.nanoseconds`·spawnSync 사용) ·
   `sh`(POSIX 셸 — 스텁/실러너 명령 실행) · `git`(porcelain 자가검증; 측정 시점
   2.50.1). OS: darwin arm64 — 지연 절대치는 이 환경에 종속(§1).

## 7. 결론 — 공통 계약 경계에 스코프된 동등

**이 측정이 지지하는 동등은 공통 계약(per-criterion 상태+증거유무→이진 판정,
무증거 pass fail-closed) 경계 내 동등이며, 비대응 기능의 parity 증거가 아니다.**
그 경계 안에서: 기본 4클래스(정상 green·무증거 pass·suite red·미완 잔여)는 두
경로가 완전히 같은 방향으로 판정했고, 경계 3클래스의 발산은 전부 구조
원인(trim vs length>0 — src 쪽이 느슨, §5 결함 후보; AC min(1) 인코딩 비대칭 —
런타임 오판 아님)으로 분류되어 예상 외 발산은 0건이다
(`expectation_deviations: []`).

경계 밖 비대응 기능 — 이 baseline이 아무것도 말하지 않는 영역:

- **옛 src 전용**: per-AC oracle 판정 · fix-backed supersession ·
  barrier/phantom-red/frozen 3중 floor · ~12 ledger 게이트 캐스케이드
- **rebuild 전용**: codex 외부권위(`decideCompletionAuthority`) · oracle
  hash-freeze · intent-lock · `<FOUNDATION-COMPLETE/>` 토큰 검출
