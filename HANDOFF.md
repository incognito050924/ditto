# HANDOFF — far-field 신뢰성 재설계 (wi_260706n4w) 원격 인수인계

> **cross-PC 핸드오프.** `.ditto/local/`은 gitignored라 git으로 안 옴 → **상태 번들 `HANDOFF-wi_260706n4w-state.tar.gz`를 반드시 먼저 풀어라.** 안 풀면 autopilot 재개 불가(deep-interview+plan sweep+연구 전부 재실행하게 됨 = 유실). 이 문서는 코드 권위 기준(§4-11)이나, 번들 안의 `intent.json`·`autopilot.json`·`oracle-design-decisions.md`가 실제 권위다.
> **작성**: 2026-07-07 · 이전 WS3 핸드오프(완료·랜딩됨) 교체. ⚠ prism(wi_260705lc8) parked — 재개 금지, 변동 없음.

## 0. 전파 상태 — 먼저 이대로 (순서 중요)

```bash
# 1) 최신 main 받기 (이 핸드오프 커밋 + 미푸시였던 코드 2커밋 포함)
git fetch origin && git checkout main && git pull --ff-only origin main

# 2) 상태 번들 복원 (.ditto/local 은 gitignored — 이게 유일한 전파 수단)
tar xzf HANDOFF-wi_260706n4w-state.tar.gz     # → .ditto/local/{work-items,runs}/wi_260706n4w/ 복원
ls .ditto/local/work-items/wi_260706n4w/autopilot.json   # 존재 확인

# 3) bin 재빌드 (dogfood: 엔진 변경 반영 필수)
bun install && bun run build:bin

# 4) 복원 확인 — 이게 나와야 정상
DITTO_SKIP_HOOKS=1 bun bin/ditto work status wi_260706n4w   # status: in_progress, 7 AC
```

**복원되는 상태**(번들): `.ditto/local/work-items/wi_260706n4w/`(intent.json=7 AC+2 unknown, autopilot.json=10노드 그래프+plan_brief, oracle-design-decisions.md=구현계약, planner-output.json, work-item.json, decision-conflict.json, interview-state.json) + `.ditto/local/runs/wi_260706n4w/`(coverage.json=sweep 원장 17 resolved·6 skip, relevance-provenance.json) + 로컬 세션 핸드오프 노트.
**안 오는 것**: 사용자 `~/.claude` 메모리(있으면 배경 참고, 없어도 이 문서+번들로 충분). wi_26062227h의 run 상태(불필요 — §4 요약).
**히스토리 재작성 없음** — 평범한 `pull --ff-only`.

## 1. 한 줄 상태
**wi_260706n4w — 설계·연구 완료, 구현 대기.** autopilot `orch_2607072xc`: **passed = N1(design)·n1-research-oracle-design**. **pending 8 = n2-schema → n3-taxonomy → n4-oracle-core → n5-wiring → n6-deepinterview-seed → n7-review → n8-verify → n9-measure.** 코드 변경 아직 0. **approval_gate=pending**(plan_brief 기반 brief-gate가 켜져 첫 mutating 노드 n2를 게이트).

## 2. 재개 절차 (autopilot 루프 — 실행은 이미 승인됨)
```bash
DITTO_SKIP_HOOKS=1 bun bin/ditto autopilot next-node --workItem wi_260706n4w --output json
```
- 첫 호출은 **`present_plan`(approval pending)** 반환 예상 → plan_brief(§5) 검토 후 승인:
  `DITTO_SKIP_HOOKS=1 bun bin/ditto autopilot approve --workItem wi_260706n4w`
- 이후 표준 loop: `next-node`→owner subagent spawn→`record-result`(mutating은 `changed_files` 필수)→반복. **n2→n6 순차 의존**, n7 review→n8 verify→n9 measure.
- **각 implement 노드 packet에 반드시 실어라**: 번들의 `oracle-design-decisions.md`(구현 계약) + plan_brief 제약(§5). 재결정 금지.
- 종료: `ditto autopilot complete --workItem wi_260706n4w` → 7 AC evidence-gated. ac-5(측정)는 log로 close(실 dogfood before/after 수치는 실행 산물).

## 3. 의도 (권위 = 번들 intent.json)
far-field pre-mortem을 "누가·언제 답하나"로 라우팅하되 **신뢰성 핵심을 2모드 oracle(존재+부재 결정적 검증)에 둔다.** A(라우팅 재분할)+B(2모드 oracle,위험-티어)+C(요구사항형 deep-interview 이관)를 한 heavy wi로. **왜 이렇게 됐나**: deep-interview 6-generator fan-out이 원 전제 결함 2개 발견 — ① file:line 존재확인 oracle은 far-field의 가장 값진 "부재 위험"(검증/롤백/감사로그 없음, 가리킬 위치 없음)을 역선택하고 날조는 통과 → "진짜vs날조" 아닌 "존재vs부재"만 가름; ② A·C는 코드-집행 아님(환각 표면 이동일 뿐), B만 코드-집행. **4 결정**: oracle=존재+부재 2모드 / 범위=A+B+C 한 wi / 강도=위험-티어 차등(injection·secret hard-reject, 나머지 advisory, 도구부재→advisory로 ADR-0018 화해) / 지표=dogfood before/after 날조율+oracle과 분리된 독립 라벨러.

**7 AC**(번들 intent.json 원문): ac-1 2모드 oracle presence+absence 결정성+티어 / ac-2 정적 disposition 필드+facet 분할+tier-② override / ac-3 라우팅된 카테고리 ledger 잔류(no silent narrowing) / ac-4 요구사항형 deep-interview seed+skip경로 fail-open / ac-5 dogfood before/after+독립 라벨러(evidence=log) / ac-6 additive-only(prism·interview-driver 무파급)+전체 suite green / ac-7 도구부재→advisory(ADR-0018).

## 4. 이 wi가 딛고 선 것 — wi_26062227h (done, 이번 세션 push됨)
far-field 비용 측정 + relevance provenance 계측. commits **`c69b0e1`(structural)·`ca796bc`(behavioral)** = raw judgment/refute + cost tally를 seed에 영속(`schemas/coverage.ts`·`coverage-loop.ts`·`coverage-store.ts`·`coverage-relevance.ts`·`autopilot.ts`). 측정 결과: far-field가 실제 43% skip·light는 이미 batch → **비용 전제 약화**(그래서 이 재설계는 비용 아닌 신뢰성 축). 이 2커밋이 origin/main에 있으니 다른 PC는 pull로 받음.

## 5. plan_brief — coverage sweep이 찾은 구현 제약 (권위 = 번들 autopilot.json approval_gate.plan_brief)
plan-stage pre-mortem이 17 카테고리 sweep→24개 oracle-anchored 제약 발견. **구현 시 반드시 준수:**
- **injection(신뢰불가 LLM claim이 grep 실행 입력)**: argv 배열 + `grep -F`(fixed-string) + `--` 종결자 + 경로 containment(절대/`..` 거부). 모범 `src/core/cleanup-scan.ts:158,188-189`. **절대 `sh -c`/문자열보간 금지**.
- **absence-mode exit 3분기**: `git grep` exit 1=absent / 0=refuted / ≥2=advisory(error를 'absent'로 coerce 금지). ⚠ **`cleanup-scan.ts:163`이 바로 그 coercion 안티패턴** — exec 안전성만 모방, exit 처리는 분기.
- **enforceClose 배선**: oracle은 **conditional·fail-open** close 신호(balance/priority/temporal 패턴, `coverage-loop.ts:389/396/403`), neutrality(:376)처럼 무조건 필수면 intent-stage 결정적 dimension close(`interview-driver.ts:562`) 전부 깨짐.
- **재사용**: 기존 AcOracle 머신(`coverage-manager.ts:616-671` isReEvaluableAnchor·validateAcOracle·oraclesEqual·assertOracleFrozen) 확장, 병렬 citation 층 reinvent 금지. **grep-only, AST 금지**(ADR-0006 단일엔진 — citation-existence는 textual presence라 ACG 밖).
- **compat/additive**: 새 영속 노드 필드는 `.optional()`(기존 coverage.json strict-parse 깨짐 방지); nextCoverageNode/FarFieldCategory/완전성 술어 breaking 금지(prism·`interview-driver.ts:520` minimal caller 무파급).
- **minimal-increment 제거 4함정**(ac-3/ac-6): (a) orphan xref `coverage-taxonomy.ts:113` 수정, (b) charter엔 실행 self-check 없음→수신 게이트(autopilot-tidy 등)가 실제 집행해야, (c) 제거된 카테고리는 cov-cat 노드 안 생겨 ledger 조용히 23→22 narrowing(disposition·이유 기록 필요), (d) count 테스트 갱신 `tests/core/coverage-taxonomy.test.ts:24,62,72-78`+`tests/integration/coverage-category-seeding.test.ts:47,65`+prose `coverage-taxonomy.ts:29`.
- **요구사항형 seed**: closeable `cov-dim-*` 노드(cov-cat-* 아님 — `interview-driver.ts:513-519` permanently-open 함정), intent 단계 `seedCategories` 미설정 유지, deep-interview 없는 경로 fail-open.
- **advisory verdict 영속**: `relevance-provenance.json` 사이드카 선례(`coverage-loop.ts:216-233`).

## 6. n1-research 계약 (권위 = 번들 oracle-design-decisions.md) — 요지
- absence claim shape: `{pattern: 단일 ANCHOR_TOKEN(/^[^\s]+$/) 고정문자열+길이상한, scope_path: contained, mode:'absence'}` → 기존 AcOracle triple(static_scan+backward+maps_to)에 pattern+mode만 additive. executor `runAbsenceCheck` = `git grep -F -e <pat> -- <path>`.
- fallback: token+contained-path 둘 다면 hard-verdict, 아니면 advisory. tier 강도는 그 위에.
- 라벨러(ac-5): oracle verdict-blind 별개 fresh-context 에이전트(또는 사람). 순환차단 = (1)입력=raw claim+코드베이스 (2)fresh context (3)날조율은 결정적 코드가 {oracle kept/rejected}↔{labeler real/fabricated} 두 독립집합 상관. **oracle=ENFORCE, labeler=JUDGE, 제3결정적단계=CORRELATE.** raw 배열 별도 영속(relevanceProvenance 미러). residual: 완전한 LLM 판단독립은 코드강제 불가(사람/다른모델이 강한 옵션).

## 7. Gotcha
- 빌드 `bun run build:bin`→`bin/ditto`. 커밋 한국어 괄호 훅 오탐→`DITTO_SKIP_HOOKS=1 git commit -F file`. pre-commit biome→`bun run lint:fix`. push는 pre-push가 full suite 재실행(2분+).
- 전체 suite `bun test src tests`(~150s, 3982 pass 기준). tsc는 게이트 아님(453 기존 에러, test partial-payload=zod `.default()` 의존). surface-catalog 5~6건은 gitignored `.ditto/local/surfaces*.json` 부재로 환경-fail(신규 회귀 아님).
- coverage sweep은 정식 fan-out이 17카테고리×full≈170 서브에이전트(이 wi가 고치려는 "비싼 pre-mortem" 그 자체) — 이미 light로 dry까지 돌려놨으니 **재실행 불필요**(coverage.json 존재하면 record-result가 그걸 씀).
- 시스템 헤더 active pointer가 stale일 수 있음 — 실작업은 wi_260706n4w.
- **번들 정리**: 다른 PC서 tar 풀고 나면 `git rm HANDOFF-wi_260706n4w-state.tar.gz`(+원하면 HANDOFF.md)로 커밋 정리. `.ditto/local` 복원분은 gitignored라 추적 안 됨.

## 8. 금지 (scope creep)
7 AC·10노드 밖 기능 추가 금지. oracle 내부 LLM 판단 재유입 금지(absence는 결정적 grep만). breaking change 금지(additive-only). minimal-increment 제거 시 §5 4함정 전부 처리. push는 완결 경계+사용자 명시 허가로만.
