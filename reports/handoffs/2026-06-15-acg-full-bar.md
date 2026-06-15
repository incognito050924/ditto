---
title: "Handoff — ACG ① CLI 단독 full-bar 프로젝트 (cross-PC 인수인계)"
kind: handoff
created: 2026-06-15 KST
updated: 2026-06-16 KST
author: hskim, claude
status: parked
branch: wi_260615t8o/l2-interception
archive_branch: archive/acg-full-bar-auto-commit
adr: [ADR-0018, ADR-0019]
work_items: [wi_260615t8o, wi_260615lj6, wi_260615dxx]
---

> **2026-06-16 — PARKED(보류).** ① 기술 목표는 달성·검증됐으나(§8), 가치 검토 결과 사용자
> 의도("믿고 맡기는 자동 정리·커밋")를 잘 못 섬긴다고 판단해 **main 미머지로 보류**하고 이
> 브랜치를 `archive/acg-full-bar-auto-commit`로 원격 보존한다. 나중에 완성하려 할 때의 권위
> 재개 문서는 **§9**다(반드시 §9부터 읽어라). main·autopilot은 손대지 않았다.
>
> **2026-06-15 — ① 달성.** §5 남은 작업 1~5 전부 완료. ① 목표(`ditto refactor --scope`가
> standing 코드에서 §4.4 full-bar 자동커밋 도달)가 실 git repo + 실 codeql e2e로 입증됨(§8).

# Handoff — ACG ① "CLI 단독 full-bar" (다른 PC에서 이어서)

> **왜 이 문서가 committed인가.** work-item 상태(`.ditto/local/work-items/*`)와 ditto handoff는
> `.ditto/local`(gitignore된 개인 구획, ADR-0012)이라 **push되지 않는다 → 다른 PC로 안 넘어간다.**
> 그래서 이 핸드오프는 `reports/handoffs/`에 committed로 두고, WI의 goal·ACs를 인라인으로 적어
> **이 문서 하나로 이어받을 수 있게** 한다. 코드·ADR·브랜치는 git으로 동기화된다.

## 0. 이어받기 (먼저 이것부터)

```bash
git fetch origin
git checkout wi_260615t8o/l2-interception   # tip — 아래 체인 전부 포함
bun install
bun run build                                # GOTCHA: dist/ditto stale 방지 (CLI 돌리기 전 필수)
bun test                                     # baseline green 확인 (현재 2182 pass / 0 fail 기준 + L2 코어 추가분)
```

`.ditto/local/work-items/`는 동기화되지 않으므로 새 PC엔 wi_260615t8o/wi_260615lj6 work-item 파일이
**없다.** 이 문서가 그 ACs·goal의 권위 사본이다. 트래킹이 필요하면 §3의 goal/ACs로 `ditto work start`로
재등록하라(필수는 아님 — 이 문서로 작업 가능).

## 1. 목표 (불변 — 범위 보존)

`ditto refactor --scope <unit>`가 **standing 코드에서 §4.4 full-bar 자동커밋**(격리 브랜치, push 0)에
도달하게 한다. 현재 refactor.ts는 5개 full-bar 입력 중 coverage만 실값이고 **baselineGreen·behaviorGreen·
debt(before/after)가 하드코딩/placeholder**라 CLI 단독으로 full-bar 도달 불가.

사용자 결정(2026-06-15, "①까지 전부"): L2 = **interception 프레임워크**(pure-only 아님), fitness =
**CodeQL 게이트(새 ADR)**. → ADR-0018 · ADR-0019 (둘 다 `proposed`).

## 2. 브랜치 체인 (전부 origin에 push됨, main 미머지)

```
main(23eb35b)
 └ wi_260615889/l1-coverage-provider (e67f2f4)  L1 CoverageProvider 실배선 (done)
   └ wi_260615q77/coverage-precision (e2f5fba)   coverage 스코프축소 + coveredRatio 임계값 (done)
     └ wi_260615t8o/l2-interception
         ├ a03f065  docs(adr): ADR-0018 + ADR-0019
         └ 148c9c1  feat: L2 effect-interception 코어  ← HEAD (여기서 이어서)
```

선행 두 WI(889·q77)는 **done**(completion final_verdict=pass)이나 main 미머지. 머지 전략은 사용자 판단.

## 3. Work items (goal + ACs — 인라인 권위 사본)

### wi_260615t8o — L2 effect-interception 프레임워크 (ADR-0018) · in_progress
goal: 미수정 standing 코드의 실 I/O를 런타임 가로채기(monkey-patch whitelist)로 record하여
OLD(HEAD-worktree)↔NEW(worktree) effect trace를 diff해 동작 보존을 증인하는 L2 provider. §4.4 full-bar의
behaviorGreen 출처.
- **ac-1 [DONE]** 하니스가 등록 채널(obj+method, 예 node:fs) 런타임 patch→(channel,args,순서) trace 기록→
  실행 후 항상 원복(전역 오염 없음). 증거: `tests/acg/effect-interception.test.ts` 9/9 (실 node:fs 포함).
- **ac-2 [PARTIAL]** OLD/NEW trace 캡처→diff→unrefuted/refuted. `compareTraces` 완료(순수 비교). **남음:**
  OLD=HEAD-worktree·NEW=worktree에서 같은 unit 함수를 자동 실행해 trace를 뽑는 **provider 통합**(현재는
  caller가 trace를 줘야 함).
- **ac-3 [REMAINING]** whitelist 밖 effect/비결정성(time·random·concurrency)→degraded(diff-only),
  false-refute도 hard-block도 아님(OBJ-02, 80-plan §4.3).
- **ac-4 [REMAINING]** 전체 스위트+lint+adr-guard green; ADR-0018 기록(기록은 done, 통합 검증 남음).

### wi_260615lj6 — ① full-bar 배선: CodeQL fitness + HEAD↔worktree debt + refactor 결선 (ADR-0019) · in_progress
goal: CodeQL metrics로 standing-code duplication/complexity 위반 산출 + HEAD↔worktree debt 측정 +
baselineGreen 실체크 + L2(t8o) 결합 → refactor.ts placeholder 3개 교체, barMet 시 commitTidyStructural.
- **ac-1 [REMAINING]** standing-code fitness 분석기: CodeQL metrics 쿼리→duplication/complexity 위반을
  `normalizeViolationIdentity` 형식(rule@path#site)으로. codeql 부재/실패/타임아웃→빈 결과+degraded(fail-open).
- **ac-2 [REMAINING]** HEAD↔worktree debt: `createWorktreeForRun`(src/core/worktree.ts)로 HEAD 격리
  워크트리에서 분석기→beforeIds, 워킹트리→afterIds, `assessUnitDebt`(src/acg/tidy/unit-refactor.ts)로 계산.
- **ac-3 [REMAINING]** refactor.ts: baselineGreen=스위트 green 실체크, behaviorGreen=L2 결과, debt=분석기
  HEAD↔worktree로 교체. barMet→`commitTidyStructural`(격리브랜치, push 0). dogfood: 커버·동작보존·위반감소
  단위가 CLI에서 full-bar 자동커밋 도달.
- **ac-4 [REMAINING]** fail-open(codeql/L2 불가→diff-only, hard-block 아님); 전체 스위트+lint+adr-guard green;
  ADR-0019 기록(done, 검증 남음).

## 4. 지금까지 한 것 (committed·pushed)

- **ADR-0018/0019** (`.ditto/knowledge/adr/`, proposed) + CLAUDE.md 투영 — 커밋 a03f065.
- **L2 interception 코어** `src/acg/tidy/effect-interception.ts` — 커밋 148c9c1:
  - `interceptEffects(channels, fn)`: whitelist patch→순서 trace→항상 원복(throw에도), 원본 실행 유지(투명).
  - `compareTraces(old, new)`: 동작 보존=동일 관측효과 → unrefuted / refuted+firstDivergence.
  - **적용 한계(ADR-0018 정직)**: patch 가능 객체 참조로 도달하는 effect만 관측. ESM `import{x}from`/
    frozen `import *`는 불가(read-only) — `require`된 모듈/주입 객체만. 미관측=degraded(false-refute 아님).
  - 테스트 `tests/acg/effect-interception.test.ts` 9/9.

## 5. 남은 작업 (순서·파일 포인터)

1. **L2 provider 통합 (t8o ac-2/ac-3)** — `effect-interception.ts`에 OLD/NEW를 워크트리에서 자동 실행해
   trace를 뽑는 진입점 추가 + `l2-differential.ts`(runL2Differential)와 결선. whitelist 채널 레지스트리
   정의(node:fs/child_process/fetch 등). 비결정성/미관측→degraded(ac-3). 동작 보존 verdict→behaviorGreen.
2. **CodeQL standing-code fitness 분석기 (lj6 ac-1)** — CodeQL metrics 쿼리(중복/복잡도) 작성·실행.
   재사용: `src/core/codeql/runner.ts`(runCodeqlAnalysis: db create→analyze sarif), `src/cli/commands/codeql.ts`,
   `src/acg/fitness/codeql-provider.ts`(sarifToViolationIds → rule@path#site). codeql CLI 로컬 가용(2.25.5).
   no-work-item standing 경로용 fitness 함수/쿼리 합성. 실패→fail-open.
3. **HEAD↔worktree debt (lj6 ac-2)** — `createWorktreeForRun`로 HEAD 떠서 (1)+(2) 돌려 beforeIds,
   워킹트리 afterIds → `assessUnitDebt`. `removeRunWorktree`로 정리.
4. **full-bar 결선 (lj6 ac-3/ac-4)** — `src/cli/commands/refactor.ts`의 하드코딩 교체:
   `baselineGreen:true`(→스위트 green 실체크), `behaviorGreen:true`(→L2), `debt:{before:resolved.length,
   after:resolved.length}`(→분석기 HEAD↔worktree). `decideUnitTidy` barMet→`commitTidyStructural`. dogfood.
5. **dialectic-review 권장** — 본격 빌드 전 ADR-0018/0019를 압박검증(프레임워크 비용/비결정성 false-refute
   리스크). proposed→구현 검증 후 accepted.

## 6. GOTCHA / 함정

- **`.ditto/local`은 push 안 됨** — work-item·completion·local handoff은 PC 간 동기화 안 된다. 이 문서가
  포터블 권위본. 새 PC에서 `ditto work`로 트래킹하려면 §3 goal/ACs로 재등록.
- **CLI 돌리기 전 `bun run build`** — `ditto`는 `dist/ditto`(stale 가능) 실행. autopilot/CLI 루프 전 필수.
- **CLAUDE.md knowledge 투영 sha** — ADR 추가/수정 후 `ditto bridge knowledge`로 동기화(손으로 블록 고치면
  sha drift). `--check`로 drift 확인.
- **ADR-0006 경계** — fitness/L2에 TS-AST(`from 'typescript'`/ts-morph) 금지(adr-guard가 차단). 구조분석은
  CodeQL. L2 interception은 런타임 계측이라 무관(ADR-0018 D2).
- **commitTidyStructural은 절대 push 안 함**(D8) — tidy 자동커밋은 격리 브랜치 local only. 이 불변식 보존.

## 7. 검증 명령

```bash
bun test                       # 전체 (현재 green)
bun test tests/acg/effect-interception.test.ts   # L2 코어 9/9
bun run lint && bun run adr:guard
# dogfood (full-bar 결선 후): time ./dist/ditto refactor --scope <covered unit> --output json
```

## 8. 완료 (2026-06-15 후속 세션 — ① 달성)

### dialectic-10 (착수 전 압박검증, verdict=revise)
ADR-0018/0019 본격 빌드 전 dialectic-review 실행(`reports/design/agentic-governance/reviews/dialectic-10.{json,md}`). 검증된 치명 결함 2건을 required_edits로 반영 후 착수:
- **OBJ-A(확정)**: 기성 CodeQL metrics 쿼리는 `@kind treemap`/`where none()`라 SARIF result 0 → ADR-0019 D1을 **커스텀 `@kind problem` 쿼리**(cyclomatic > N)로 재작성.
- **OBJ-B(확정)**: 빈 effect trace가 unrefuted=full로 false-pass → ADR-0018 **D5 신설**(effect-bearing unit의 OLD zero-trace=미관측→unverified/diff-only).
- OBJ-C(D4 코드의무화: codeql throw→refactor catch+타임박스→diff-only), OBJ-D(세 입력 atomic 교체).

### 커밋 (이 브랜치, origin 미푸시)
1. `24f4fd7` docs(adr): dialectic-10 revise 반영 — ADR-0018 D5 + ADR-0019 D1/D4 (구조적)
2. `f6c9272` feat: L2 standing-code worktree differential + interception preload (t8o ac-2/3)
3. `c51d0e3` feat: standing-code fitness analyzer — custom CodeQL complexity problem 쿼리 (lj6 ac-1)
4. `af488b2` feat: HEAD↔worktree 절대 debt 측정 measureUnitDebt (lj6 ac-2)
5. `0c39b1e` feat: refactor.ts full-bar 결선 — L2+debt 실배선 + commitTidyStructural (lj6 ac-3/4)

### 신규 모듈 / 파일
- `src/acg/tidy/l2-worktree-differential.ts` (+ `scripts/l2-effect-preload.ts`): OLD(HEAD 워크트리)·NEW(워킹트리)에서 unit 테스트를 `--preload` 인터셉션과 함께 실행→test outcome+effect trace(Bun.spawn*·child_process) 비교. D5/fail-open.
- `src/acg/fitness/standing-fitness.ts`: 커스텀 복잡도 problem 쿼리 + `rule@path#L<line>` 함수단위 식별자(assessUnitDebt가 set-size로 계산하므로 line 포함). 기본 임계 10(McCabe).
- `src/acg/tidy/unit-debt.ts`: `measureUnitDebt` HEAD↔worktree debt.
- `src/cli/commands/refactor.ts`: 세 placeholder 실배선 + barMet→commitTidyStructural(push 0).

### ac 상태
- **t8o**: ac-1 DONE, **ac-2 DONE**(provider 통합), **ac-3 DONE**(degraded/fail-open), ac-4 DONE(전체 green).
- **lj6**: **ac-1~ac-4 DONE**.

### 검증 (fresh evidence)
- 전체 `bun test`: **2214 pass / 11 skip / 1 fail**. 1 fail = `.ditto/local/work-items/wi_2606144ta/completion.json` 스키마(로컬 전용·gitignore·이 작업 무관·체크아웃 이전부터 존재).
- `bun run lint` clean, `bun run adr:guard` 통과(ADR-0006 TS-AST 금지 위반 0).
- **ac-3 / ① full-bar e2e**(`CODEQL_E2E=1 bun test tests/cli/refactor-cli.test.ts`): 실 git repo에서 HEAD=고복잡도 grade()(cyclomatic ~12), 워킹트리=동작보존 tidy(테이블 룩업, ~3). `ditto refactor --scope component:widget` CLI 단독으로 **barMet=true, autoCommit=full, debt 1→0, `ditto-tidy/component-widget` 격리 브랜치 commit, push 0** (28.6s 통과).
- OBJ-A e2e(`CODEQL_E2E=1 bun test tests/acg/standing-fitness.test.ts`): 실 codeql가 coverage-provider.ts에서 함수단위 violation 산출(8.4s).

### 남은 위험 / 다음에 볼 것
- **L2 적용 경계(잔존)**: ditto 자기 코드는 `node:fs` named import 우세라 대부분 L2 미관측→D5 degrade(diff-only). full-bar는 pure unit 또는 `Bun.spawn*`/injected-deps 경유 unit에서만 켜진다(안전쪽 — 잘못된 자동커밋은 구조적으로 불가). dogfood는 그래서 격리 fixture의 pure unit으로 입증.
- **preload 배포 경계**: `defaultL2WorktreeDeps`는 preload를 `<repoRoot>/scripts/l2-effect-preload.ts`로 해소 — ditto self-dogfood(repoRoot=ditto)는 OK이나, ditto를 *타 repo*에 적용하려면 preload를 ditto 설치 위치에서 해소하도록 후속 필요(cross-repo).
- **codeql 비용**: refactor 1회 = HEAD↔worktree DB 빌드 2회(+L2 테스트런). opt-in 표면이라 수용(ADR-0019 D2). withTimebox 기본 300s.
- **ADR-0018/0019 상태**: 여전히 `proposed`. 구현·e2e로 검증됐으니 `accepted` 승격 후보(별도 판단).
- **푸시/머지**: 5커밋 origin 미푸시, 선행 두 WI(889·q77) main 미머지 — 사용자 판단.

## 9. 보류(PARK) 결정 + 완성 재개 가이드 (2026-06-16 — 미래 완성용 권위 문서)

> 이 기능을 **나중에 완성하려는 사람**을 위한 문서다. §1~§8은 "어떻게 만들었나", 이 §9는
> "왜 보류했고, 완성하려면 무엇을 해야 하나"다. 재개 시 여기부터 읽어라.

### 9.1 결정: main 미머지 보류, 아카이브 브랜치로 원격 보존
- 기능은 기술적으로 동작·검증됐으나(§8 e2e), **사용자 의도("믿고 맡기는 자동 정리·커밋")를 잘
  못 섬긴다**고 판단해 보류. main에 머지하지 않고 브랜치 `archive/acg-full-bar-auto-commit`로
  origin에 보존한다. **삭제가 아니라 동결**이다.
- main·autopilot은 **전혀 손대지 않았다**(아래 9.3).

### 9.2 왜 보류했나 — 자동커밋이 거의 발화하지 않는다 (구조적)
완성 전에 이 한계를 이해해야 같은 벽에 다시 부딪히지 않는다.
1. **`ditto refactor`는 정리를 *측정*만 하고 *생성*하지 않는다.** full-bar가 발화하려면 누군가
   (에이전트/사람)가 **이미 동작보존 정리를 작업트리에 적용해 커밋 안 한 상태로** 남겨둬야 한다.
   즉 이 기능이 자동화하는 건 "정리"가 아니라 "이미 된 정리의 검증+커밋 한 번"이다. 의도("맡기면
   알아서 정리")와 어긋나는 핵심 지점.
2. **발화 조건이 곱(AND)으로 좁다**: covered≥80% ∧ 동작 관측가능(pure 또는 `Bun.spawn*` 경유;
   `node:fs` named import는 D5로 빠짐) ∧ 빚 실제 감소 ∧ baseline green. 실코드에서 이 교집합은 작다.
3. **이 희소성은 안전성의 대가**다. "절대 잘못 커밋 안 함"과 "자주 발화함"은 싸게 양립 안 된다.
   현재는 안전 쪽 극단(모든 오차가 '커밋 안 함' 방향) → 거의 안 켜짐.

### 9.3 autopilot 비결합 (완성 시 반드시 보존할 불변식)
- **사용자 최우선 제약: 작동 중인 autopilot 오케스트레이션/워크플로를 망치지 말 것.**
- 현재 이 기능은 autopilot과 **완전 분리**다(2026-06-16 코드 확인): main 대비 바뀐 파일에
  `src/core/autopilot*` 0개, autopilot이 신규 모듈(l2-worktree-differential·standing-fitness·
  unit-debt·effect-interception) import 0건, autopilot이 refactor/decideUnitTidy/commitTidyStructural
  호출 0건. `ditto refactor`는 독립 CLI 명령일 뿐이다.
- **함정**: 9.2-(1)을 풀려고 "refactorer/autopilot 파이프라인과 결선"하면 **바로 autopilot을
  건드리게 된다.** 완성하려면 이 결합을 autopilot 코어 수정 없이(예: 별도 어댑터/노드 추가, 기존
  드라이버 불변) 설계해야 한다. 이 불변식을 깨는 완성안은 사용자 의도 위반.

### 9.4 완성하려면 (필요 작업, 큰 것부터)
1. **정리 *생성* 주체와 결선** (가장 큰 공사) — refactorer 에이전트가 covered 단위에 동작보존
   정리를 만들어내고 → 이 게이트가 검증+커밋하는 루프. 단 9.3 불변식 준수(autopilot 코어 불변).
   완성해도 발화는 "covered ∧ 관측가능 ∧ 빚감소" **안전 부분집합 한정**임을 받아들여야 함.
2. **빚 축 확장 (가)** — *미착수, 승인됐다가 보류됨* (wi_260615dxx). 복잡도 단독 → +모듈크기(순수
   LOC>250) +in-file dead code(CodeQL unused-local/private/도달불가). 전부 CodeQL/단순 메트릭,
   ADR-0006 안(ast-grep/TS-AST 금지). `standing-fitness.ts`에 violation 출처만 추가하면 됨
   (measureUnitDebt는 카운트만 늘어남). duplication은 CodeQL 기성 쿼리가 결과 0이라 보류 — 넣으려면
   "CodeQL 열위" 실측 후 ast-grep ADR 별도(ADR-0017 철회조건).
3. **L2 적용 범위 확장** — 동작 관측을 `node:fs` 등 named import까지 넓혀야 발화율이 오름. 단
   false-green 위험과 맞바꿔야 함(D5 안전성과 트레이드오프). 신중히.
4. **preload cross-repo 해소** — 타 repo 적용 시 preload를 ditto 설치 위치에서 해소(§8 참조).

### 9.5 절대 하지 말 것 (이 대화에서 확정된 경계)
- **deep-module·remove-ai-slops(slop) 류를 자동커밋 빚 카운터에 넣지 말 것.** 이들은 LLM 판단이라
  before/after 카운트가 비결정적 → 자동커밋 게이트의 안전 전제를 깬다. ACG 자신도 deep-module을
  메트릭이 아닌 dialectic "Deep Module Gate"로 둔다. 이 기준들이 필요하면 자동커밋이 아니라
  **advisory 리뷰 출력**으로 붙여라(자동커밋 축과 분리).

### 9.6 보류해도 살아있는 재사용 자산
자동커밋을 안 살리더라도 아래는 "코드 건강 측정/리포트"로 독립 재사용 가능(브랜치에서 떼올 수 있음):
- `src/acg/fitness/standing-fitness.ts` — CodeQL 커스텀 복잡도 problem 쿼리 → 함수단위 violation.
- `src/acg/tidy/unit-debt.ts` — HEAD↔worktree 절대 debt 측정.

### 9.7 재개 체크리스트
1. `git fetch origin && git checkout archive/acg-full-bar-auto-commit`
2. `bun install && bun run build && bun test` (baseline 확인; 1 fail은 §8의 로컬 데이터 무관건)
3. §9.2 한계와 §9.3 autopilot 불변식을 먼저 납득. 의도가 여전히 "자동커밋"이면 9.4-(1)이 핵심,
   "리뷰 보조"로 바뀌었으면 9.5대로 advisory로 재설계(자동커밋 축 폐기).
4. 본격 빌드 전 ADR-0018/0019 + 새 결선안을 dialectic-review로 재압박(§8 dialectic-10 선례).
