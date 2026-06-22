# HANDOFF — 다른 PC 이어받기 (2026-06-23)

호스트 메모리(`~/.claude/.../memory/`)와 work-items(`.ditto/local/`, gitignored)는 **git으로 전파되지 않는다.** 다른 PC에 필요한 비전파 컨텍스트를 여기 싣는다. 코드·테스트·git이 권위다(헌장 §4-11) — 이 문서는 "어디서 이어받나 + 안 넘어가는 것"이지 사실의 원본이 아니다.

## 0. 전파 상태 (먼저 읽기)

- **이어받을 위치**: repo `main`. **이번 세션 4커밋은 origin/main에 push 완료** (`origin/main = d43a624`, 0커밋 차이). 다른 PC는 `git pull`만 하면 된다.
- **안 넘어가는 것**: ① work-item `.json`(`.ditto/local/work-items/` gitignored — 다른 PC는 자기 로컬 상태) ② 호스트 메모리 ③ `.ditto/local/runs/`(coverage·feedback 런타임 산출). 아래 §5 "재빌드 & setup" 먼저 돌릴 것.
- **넘어가는 것**: 소스·테스트·`bin/ditto`·`agents/planner.md`·ADR·이 문서.

## 1. 이번 세션 (2026-06-22~23) — push된 4커밋

| 커밋 | work item | 내용 |
|---|---|---|
| `08f3d9b` | wi_26062240y | dogfood `--skip-permissions` opt-in 플래그 + `.claude/settings.json` 권한 포스처 관대화(allow Bash/Read/Edit…, deny sudo/mkfs/force-push). **프로젝트 권한 포스처 변경**이니 다른 PC도 이 settings를 받는다. |
| `be30a17` | wi_260622z7d | far-field coverage 버그 2건: ①intensity 진입 override를 coverage.json에 영속(K-scale 휘발 수정) ②`farFieldCoverageReport.complete`를 전체 노드 기준으로(파생 노드 무시 수정). |
| `d225209` | wi_260622qre | **ac-11b far-field outcome 루프**: `ditto coverage feedback`(구조적 가드로 dry-closed=depth/미시딩=breadth 귀속, 일반버그 거부) + append-only cross-wi ledger(`.ditto/local/coverage-feedback.jsonl`) + `ditto coverage propose`. 검출+제안+재발 측정 토대까지(자동 집계/분류/반영은 out_of_scope). |
| `d43a624` | wi_260622kb4 | **autopilot 도구 마찰 수정 + outcome 데이터 수집**: 아래 §2 상세. |

- 전체 `DITTO_SKIP_HOOKS=1 bun test` **2754 pass / 0 fail**. lint·adr-guard green.

## 2. `d43a624` 상세 (autopilot 도구 + outcome 데이터)

ac-11b 도그푸딩에서 발견한 도구 마찰 2건 수정 + 그 과정을 outcome 자동화 방향 데이터 수집 표본으로.

- **ac-1 variant 라우팅 오매칭** — **진짜 원인은 match 부재가 아니었다.** match는 이미 올바름(`.ditto/agents/*.md`, da8a7e6). 실제 원인 = **planner가 generated_nodes에 per-node `file_scope`를 안 채워** 노드가 `changed_files`(혼합)로 폴백 → 변종 매칭 무력화(autopilot-loop.ts:196 `scopeOf`). 수정: (a) `agents/planner.md`에 file_scope 산출 지시(근본 — `nodeProposal.file_scope`·`proposalsToNodes` 인프라는 da8a7e6에 이미 있었음), (b) `selectVariantCandidates`에 `scopeDeclared` opts — 미선언 노드는 scoped 변종 배제·generalist/hint만(방어).
- **ac-2 per-AC evidence** — `ac_verdict` 항목에 optional `evidence_refs` + `guardAcClosingEvidence`가 top-level OR per-AC 인정 **+ `deriveAcVerdicts`(complete)도 per-AC evidence를 AC 닫기 증거로 인정.** ⚠ **이 마지막이 도그푸딩이 즉시 노출한 갭**: 게이트만 배선하면 complete가 못 닫아 per-AC evidence 기능이 반쪽 → complete까지 배선해야 완성.
- **ac-3** `ditto coverage suggest` — verify 실패 + coverage 미시딩/dry-close 감지 시 feedback 템플릿 제안(제안만, 자동기록 없음).
- **ac-4 outcome 데이터** (▼ §3).

## 3. ★ outcome 루프 자동화 방향 — 수집된 결정 데이터 (다음 결정 입력)

ac-11b에서 "false-negative 빈도 모름 → 측정부터"(Q1)로 보류한 자동화 결정의 **실측 데이터**를 d43a624 ac-4에서 모았다:

- **비용 (light tier, 가장 싼)**: far-field sweep Opponent-only 평균 **35.25k 토큰/카테고리**(authentication 25.2k + reuse 45.3k 실측). 19 카테고리 전수 외삽 ≈ **670k(Opponent만) ~ 2-3M(full 3-role dialectic+judges)** 토큰. 작은 도구 수정 1건에.
- **false-negative**: **0건** (두 표본 모두 위험 0, verify 전부 pass와 일치).
- **결론(권고)**: 작은 작업의 자동 far-field sweep은 **비현실적**(수백k~수M 토큰)이고 false-negative는 **희소**. → ac-11b의 검출+제안+**수동(on-demand)** 설계가 정당. **자동 집계·임계 트리거·자동 sweep은 비용 대비 가치 낮음** — 도입 보류 권고. 단 단일 개발자 dogfooding 규모 데이터(표본 2)라, 더 큰 표본이 필요하면 `ditto coverage suggest`로 자연 수집(앞으로 verify fail마다).

## 4. 남은 작업 / 열린 work item

- **wi_260621i0w** (draft) — "variant 라우팅 실제 동작 검증 + warm-start cap 가치순 정렬". **앞부분(variant 라우팅)은 이번 d43a624가 근본 해결** — 그 검증은 닫힌 셈. **남은 건 warm-start cap-crowding 가치순 정렬**(memory-warmstart.ts:222, RELATED_NODE_CAP=8 사전순 컷 → artifact 노드가 중요 노드 밀어냄). 이것만 분리해 진행하거나 work item 갱신.
- **wi_26062257r** (draft) — C-6 variant spawn 불변식 가드 + 사소 항목. 이전 핸드오프 잔여. 이번 variant 작업과 인접 — 정리/재개 판단.
- **wi_260622z7d** (draft, 커밋 `be30a17`됨) — 직접수정 completion 트랩이라 done 못 닫음(autopilot 밖). 커밋 이력이 추적 대신. 삭제 가능.
- **ac-2 follow-up**: `deriveAcVerdicts` 보강은 했으나, completion-store/doctor 등 다른 per-AC evidence 소비처가 더 있는지 미점검(이번 범위는 complete close만).
- **planner file_scope 효과**: `agents/planner.md` 지시는 **다음 세션 planner부터** 적용(세션 시작에 freeze). 다음 autopilot 작업에서 planner가 실제로 노드별 file_scope를 채우는지 확인하면 ac-1 (a) 근본수정이 실전 검증됨(이번 세션 노드들은 이미 폴백+방어로 안전).

## 5. 다른 PC 세션 시작 — 복붙용 프롬프트

### 5-1. 재빌드 & setup
```
git pull 했어. ditto 바이너리 재빌드하고 setup 다시 실행해서 글로벌 설치본·.claude/agents variant 링크·allowlist를 최신 코드에 동기화해줘.
- bun install (변동 없으면 no-op)
- bun run build:bin && bun run build:plugin && bun run build:codex-plugin
- ditto setup (인터랙티브 — variant agent-link 포함. --yes는 agent-link 건너뜀)
검증: ditto doctor 전 축 drift 0. surface drift 뜨면 surfaces:gen 재생성(catalog stale일 수 있음). PreToolUse 훅이 정상 명령 false-positive 차단 시 DITTO_SKIP_HOOKS=1 prefix.
```
참고: 이번 세션에서 `ditto setup`은 **self-host 가드로 skip**됨(타겟이 ditto repo 자신 — dogfood는 `--plugin-dir`로 로드). `ditto mode`는 글로벌 설치본 STALE를 권하나 dogfood 세션엔 무관(`bun run dogfood`로 워킹트리 로드).

### 5-2. deep-interview 전역 설정 (gitignored, 각 PC에서 생성)
`.ditto/local/config.json` — 이 PC와 동일하게:
```json
{ "deep_interview": { "threshold": 0.85, "generators": 6 },
  "tech_spec": { "question": { "performance": "exhaustive" } } }
```
스키마: src/schemas/ditto-config.ts. 우선순위 CLI flag > config > code default. 파일 없으면 코드 기본값(threshold 0.7/cap 8/generators 1).

## 6. 비전파 운영 GOTCHA (memory → 여기 복제)

- **work item AC mirror**: `work start`는 ac-1 TBD placeholder만 만든다. deep-interview `finalize`를 **안 거치고** intent.json을 직접 작성하면 work-item.json의 acceptance_criteria가 mirror 안 됨 → autopilot complete 전 `intent-drift`가 "AC id missing (scope shrink)"로 **FAIL**. 해결: work-item.json의 acceptance_criteria를 intent.json과 일치시킨다(id-set 보존). 이번 wi_260622kb4에서 발생·수정함.
- **passed 노드 재기록 불가**: record-result는 passed 노드를 "not running"으로 거부. 증거 보강하려면 노드가 running일 때 해야. (complete가 못 읽는 증거는 노드 재기록 말고 complete 로직을 고치는 게 정석 — 이번 ac-2 보강.)
- **completion 증거 위치**: `autopilot complete`(deriveAcVerdicts)는 노드의 evidence를 모은다. 이번 수정 후 **top-level node.evidence_refs OR ac_verdict 항목의 evidence_refs** 둘 다 인정. record-result 시 둘 중 하나에 증거를 실어야 AC가 pass close된다.
- **coverage intensity 영속**: `coverage-next --coverageIntensity`는 **첫 seed에만** coverage.json에 영속(be30a17). 이후 호출은 그 tier 유지(명시 override는 그 호출만 재정의). zsh에서 테스트 시 `"$@"`로 넘겨야 단어분리 안 됨(unquoted `$flag`는 파싱 실패).
- **far-field sweep 비용**: light여도 floor 19 전수. 작은 작업엔 design 노드 생략하면 sweep 자체가 안 돌아 비용 0(planner 판단). 데이터 수집하려면 design 노드를 의도적으로 넣고 `--coverageIntensity light`로 진입. 전수는 비싸니(§3) 샘플+외삽이 실용적.

## 7. 핵심 파일

- `src/core/agent-variants.ts` — `selectVariantCandidates(catalog, owner, fileScope, hint?, {scopeDeclared})`. catalog=`.ditto/agents/*.md`(loadVariantCatalog), match glob.
- `src/core/autopilot-loop.ts` — `scopeOf`(:196 file_scope ?? changed_files), variant 호출부 2곳(scopeDeclared 전달), record-result 게이트.
- `src/core/autopilot-complete.ts` — `deriveAcVerdicts`·`nodeVerdictFor`·`perAcEvidence`/`hasClosingEvidence` 헬퍼(per-AC evidence 인정).
- `src/core/autopilot-dispatch.ts` — `guardAcClosingEvidence`(top-level OR per-AC).
- `src/core/coverage-feedback.ts` — `CoverageFeedbackLedger`·`attributeCoverageEscape`·`suggestCoverageFeedback`·`recurrenceCounts`.
- `src/cli/commands/coverage.ts` — `ditto coverage feedback|propose|suggest`.
- `agents/planner.md` — file_scope 산출 지시(line 24 부근).
- `.ditto/knowledge/adr/ADR-0023-*.md` — far-field coverage 결정(철회조건 §3이 ac-11b outcome 루프의 출처).
