# Far-field 날조율 before/after 측정 로그 (wi_260706n4w ac-5, n9)

> **목적**: ac-5 evidence — 재설계 전(옛 taxonomy) vs 후(2-mode oracle + 라벨러)
> 날조율 대조의 **측정 로그**. 무엇이 지금 측정됐고(실증) 무엇이 라이브 실행
> 대기인지(잔여)를 구분해 기록한다. **가짜 수치 없음** — 분모 0인 rate는 `null`
> (미측정)로만 존재한다.
> **측정 시점**: 2026-07-07, HEAD `cfc65f6` working tree.
> **라벨러 계약**: `reports/coverage/labeler-contract.md`.
> **상관 함수**: `correlateFabrication` (`src/core/coverage-oracle.ts`, 결정적 —
> 유닛테스트 `tests/core/coverage-oracle.test.ts`).

## 1. BEFORE — 측정됨 (결정적, 실데이터)

대상: **wi_260706n4w 자신의 plan-stage far-field sweep** —
`.ditto/local/runs/wi_260706n4w/coverage.json` +
`relevance-provenance.json`. 이 sweep은 재설계 **전** taxonomy
(disposition 라우팅 없음, oracle 없음)로 실제 수행된 원장이다.

부록 A 스크립트 산출(verbatim 발췌):

| 측정 항목 | 값 |
|---|---|
| seeded 카테고리 | 23 |
| resolved (swept & closed) | 17 |
| skipped out_of_scope (relevance gate, reason+residual 완비) | 6 |
| `disposition` 필드 보유 노드 | **0** (전-재설계 taxonomy 증거) |
| `oracle-provenance.json` 사이드카 | **없음** |
| oracle verdicts / labeler labels | **0 / 0** |
| 신-floor cross-walk: resolved 17 중 code-verify 라우팅분 | **16** (auditing, data-integrity, boundary-edge, concurrency-ordering, external-env, failure-recovery, resource-exhaustion, compat-version, injection, secret-exposure, cross-feature, observability, deployment-rollout, reuse-build-vs-buy, input-validation, configuration) |
| 〃 user-intent 라우팅분 | 0 |
| 〃 routed-out (charter self-check 이관) | 1 (minimal-increment) |
| 위험 티어(injection·secret-exposure)인데 decidable claim 0으로 resolved | **2건 둘 다** |
| `correlateFabrication([], [])` rates | oracle `null` / labeler `null` / agreement `null` |

### BEFORE 판독

- **BEFORE 날조율은 숫자가 아니라 "측정 불가"다** — 그리고 그 측정 불가성
  자체가 baseline 소견이다. 신-floor 기준으로 code-verify에 해당하는 16개
  카테고리가 **기계 검증 가능한 claim 0개**로 "resolved" 처리됐다. 이 close들의
  근거 중 무엇이 날조였더라도 검출 장치가 없었다(oracle 없음, 사이드카 없음,
  라벨 모집단 없음).
- 위험 티어 2개(injection, secret-exposure)도 decidable claim 없이 resolved —
  fail-closed 집행이 원리적으로 불가능한 상태였다.
- rate `null`은 `correlateFabrication`의 null-not-zero 계약(분모 0 = 미측정,
  0% 아님)이 실데이터에서 그대로 동작함을 보인다.

## 2. AFTER — 흡수 종결 (far-field 고유 측정 미실행, wi_260707dxg abandon 2026-07-12)

**처분**: far-field 고유 AFTER 날조율 측정은 **수행하지 않고 흡수 종결한다.** 후속
work item `wi_260707dxg`(이 측정의 담당)는 abandon되었다. 근거 두 가지:

1. **인접 표면에서 이미 실증됨.** 재설계가 pre-mortem 날조를 억제하는지의 실증은
   `wi_260710h8o`가 **deep-interview pre-mortem opponent**를 ≥3개 실제 run에서
   계측해 **real / already-mitigated / spurious 판별 분포**를 산출하며 이미
   달성했다(그 WI record ac-2 pass). far-field oracle+labeler로 같은 anti-fabrication
   질문을 중복 측정할 유인이 사라졌다.
2. **far-field 자동 emission은 실사용에서 inert.** 재설계 landing 이후 디스크의
   모든 coverage run에서 `oracle_claims` 발화 = 0, `oracle-provenance.json`
   사이드카 = 0 (2026-07-12 실측). emission 단계는 autopilot에 배선돼 있으나
   (`skills/autopilot/SKILL.md` step 3, `oracle_claims?` 옵션 필드) Manager가 한
   번도 채우지 않았다. 강제로 발화시켜 뽑은 숫자는 (a) 오가닉 행동이 아니고
   (b) 관측이 주의를 claim에 쏠리게 해 날조를 낮추는 방향으로 편향되며
   (c) BEFORE(측정 불가)와 애초에 비교 불가라, 측정 비용 대비 신뢰가 낮다.

아래 5단계 절차는 **폐기가 아니라 보존**한다 — 훗날 far-field 고유 숫자가 정말
필요해지면(예: h8o가 못 보는 code-verify 라우팅 모집단을 굳이 특성화해야 할 때)
이 절차로 재현할 수 있다. 지금은 실행하지 않는다.

AFTER 수치는 **실행 산물**이다: 실제 dogfood work item의 sweep을 재설계 후
파이프라인으로 돌리고, fresh 라벨러 세션이 채점해야 나온다. 유닛테스트로
생성할 수 없고, 여기서 지어내지 않는다. 남은 절차:

1. **AFTER sweep**: 재설계 후 taxonomy로 실제 dogfood WI의 far-field sweep을
   실행 (autopilot `coverage-next` → 라운드가 `oracle_claims`를 emit → verdict가
   `.ditto/local/runs/<wi>/oracle-provenance.json`에 영속 — n5 배선).
2. **라벨링**: `reports/coverage/labeler-contract.md`대로 fresh verdict-blind
   세션이 raw claim 사영을 받아 `labeler_labels[]`를 채움.
3. **상관**: `correlateFabrication(sidecar.oracle_verdicts, sidecar.labeler_labels)`
   실행, 산출을 이 로그의 AFTER 절로 append.
4. **대조 해석**: BEFORE(측정 불가·검출 장치 부재) vs AFTER(oracle_fabrication_rate ·
   labeler_fabrication_rate · decidable_agreement_rate). 모집단 주의(§3) 필수.
5. (선택, 더 강한 대조) 같은 WI를 옛 taxonomy로 한 번 더 돌려 claim-수준
   BEFORE 집합을 만들고 동일 라벨러로 채점 — 옛 경로는 claim을 사이드카에
   남기지 않으므로 이 변형은 별도 수집 장치가 필요하다. 기본 대조는 1–4로 충분.

## 3. 해석 주의 — 관측 모집단 blind spot (필수)

self-declared `category_id`가 라우팅을 결정하므로, user-intent를 선언한 claim은
oracle을 우회하고 사이드카에 기록되지 않는다. **모든 AFTER 수치의 모집단 =
code-verify로 라우팅된 claim뿐.** 스스로 라우팅을 벗어난 claim의 날조는 이
하네스로 관측 불가하다. 상세: 라벨러 계약 §6.

## 4. 하네스 준비 상태 (무엇이 준비됐나)

| 구성요소 | 상태 | 위치 |
|---|---|---|
| 사이드카 스키마 (`oracleProvenance`: verdicts + labels + tally) | landed (n2) | `src/schemas/coverage.ts` |
| 2-mode 결정적 oracle (ENFORCE) | landed (n4) | `src/core/coverage-oracle.ts` |
| 루프 배선 + 사이드카 영속 (labeler 배열 보존) | landed (n5) | `src/core/coverage-loop.ts` |
| 결정적 상관 함수 (CORRELATE, 날조율 계산) | **landed (n9, 이 노드)** | `src/core/coverage-oracle.ts` `correlateFabrication` |
| 라벨러 계약 (JUDGE, verdict-blind) | **landed (n9, 이 노드)** | `reports/coverage/labeler-contract.md` |
| BEFORE baseline 측정 | **측정됨 (§1)** | 이 로그 |
| AFTER 수치 | **흡수 종결 — 미실행 (§2, wi_260707dxg abandon)** | h8o 계측 · far-field emission inert |

## 부록 A — BEFORE 계산 재현 (결정적)

repo 루트에서 아래 스크립트를 `bun <파일>`로 실행하면 §1 표가 재산출된다
(2026-07-07 실행 산출을 §1에 전기했다):

```ts
import { existsSync, readFileSync } from 'node:fs';
import { correlateFabrication } from '~/core/coverage-oracle';
import { FAR_FIELD_ROUTED_OUT, FAR_FIELD_TAXONOMY_FLOOR } from '~/core/coverage-taxonomy';
import { coverageMap, oracleProvenance } from '~/schemas/coverage';

const runDir = '.ditto/local/runs/wi_260706n4w';
const map = coverageMap.parse(JSON.parse(readFileSync(`${runDir}/coverage.json`, 'utf8')));
const cats = map.nodes.filter((n) => n.id.startsWith('cov-cat-'));
const resolved = cats.filter((n) => n.state === 'resolved');
const skipped = cats.filter((n) => n.state === 'out_of_scope' || n.state === 'user_owned');

const sidecarPath = `${runDir}/oracle-provenance.json`;
const sidecar = existsSync(sidecarPath)
  ? oracleProvenance.parse(JSON.parse(readFileSync(sidecarPath, 'utf8')))
  : { oracle_verdicts: [], labeler_labels: [] };

const floorById = new Map(FAR_FIELD_TAXONOMY_FLOOR.map((c) => [c.id, c.disposition]));
const routedOut = new Set(FAR_FIELD_ROUTED_OUT.map((c) => c.id));
const walk = { code: [] as string[], user: [] as string[], out: [] as string[] };
for (const n of resolved) {
  const bare = n.id.slice('cov-cat-'.length);
  if (routedOut.has(bare)) walk.out.push(bare);
  else if (floorById.get(bare) === 'user-intent') walk.user.push(bare);
  else walk.code.push(bare);
}
console.log({
  seeded: cats.length,
  resolved: resolved.length,
  skipped: skipped.length,
  withDisposition: cats.filter((n) => n.disposition !== undefined).length,
  sidecarExists: existsSync(sidecarPath),
  crosswalk: walk,
  correlation: correlateFabrication(sidecar.oracle_verdicts, sidecar.labeler_labels),
});
```
