# HANDOFF — 다른 PC 이어받기 (2026-06-23, C-6 세션)

호스트 메모리(`~/.claude/.../memory/`)와 work-items(`.ditto/local/`, gitignored)는 **git으로 전파되지 않는다.** 다른 PC에 필요한 비전파 컨텍스트를 여기 싣는다. 코드·테스트·git이 권위(헌장 §4-11) — 이 문서는 "어디서 이어받나 + 안 넘어가는 것"이지 사실의 원본이 아니다.

## 0. 전파 상태 (먼저 읽기)

- **이어받을 위치**: repo `main` = `2d9a694`. **origin/main에 push 완료**(0커밋 차이). 다른 PC는 `git pull`만.
- **안 넘어가는 것**: ① work-item `.json`(`.ditto/local/work-items/`, gitignored — 다른 PC는 자기 로컬 상태) ② 호스트 메모리 ③ `.ditto/local/runs/`·`coverage-feedback.jsonl`. 아래 §5 "재빌드 & setup" 먼저.
- **넘어가는 것**: 소스·테스트·`.ditto/knowledge`(ADR)·이 문서. (`bin/ditto`·`dist/plugin`은 pre-commit 훅이 재빌드·스테이징.)

## 1. 이번 세션 (2026-06-23) — push된 2커밋

| 커밋 | work item | 내용 |
|---|---|---|
| `0c7eb53` | wi_26062257r | **C-6 variant↔host spawn 불변식 doctor 가드**: `ditto doctor variants`(detect, `--advisory`) + `--fix`(orphan 변종을 `.ditto/agents`→`.claude/agents` 멱등 복사; 프로젝트 로컬·되돌림 가능·no-clobber). 검출은 기존 순수 `findOrphanVariants` 재사용. **+ coverage outcome ledger `residual` kind**(far-field escape 아닌 일반 후속·잔여위험 기록, `recurrenceCounts` 등 far-field 비용 집계에선 제외). |
| `2d9a694` | wi_26062257r ac-4 | **ADR-0023 철회·재검토 조건에 far-field 자동화 보류 정식 기록**(새 sweep 없이 §3 기존 데이터로). 비용 재측정은 wi_26062227h로 분리(재검토 트리거). |

- wi_26062257r **done**(final_verdict=pass, 4 AC 증거 닫힘). 전체 `DITTO_SKIP_HOOKS=1 bun test` **2747 pass / 0 fail**, lint·adr-guard green.

## 2. ★ 다음 착수 후보 — wi_26062227h (draft, 본격 미착수)

"far-field 비용 구조 측정·재설계". 이번 세션 대화에서 사용자가 짚은 §3 자동화 보류의 **빈틈을 측정**하는 트랙. 둘 다 §3/ADR-0023 자동화 보류를 데이터로 다시 열 카드:

- **(a) far-field ON vs OFF 증분 비용** — pre-mortem 점검 노드가 `root` 1개 → `root`+19카테고리 = 20개로 fan-out 전체를 **~20배**로 부풀린다(추정, **직접 측정 안 됨**). 비용 모델=`coverage-manager.ts:458-464`(per-node × 3-role+judges, multiplicative; tier는 depth만 줄이고 breadth=19는 hard invariant로 불변).
- **(b) 분할 19회 vs 통합 1회** — 19개를 카테고리별 독립 fan-out 대신 한 에이전트가 전부 체크하면 싸진다. 분할 이유=편향 차단(fresh·독립)+refute-by-default anti-SLOP(ADR-0023 §40). 단 "통합이 실제로 품질 해친다"는 **측정 안 된 설계 의도(추론)**이고 ADR에 기각 기록도 없음.
- ADR-0023 철회조건(`line 60-72`)에 재검토 트리거로 기록됨. intent.json 미작성(draft) — deep-interview/계획부터.

## 3. 다른 열린 work item (정리 대상)

- **wi_260621i0w** (draft) — variant 라우팅(`d43a624`)·warm-start 정렬(`47388f2`) 둘 다 코드 landed 완료. **abandon 대상**.
- **wi_260622z7d** (draft) — `be30a17` 커밋됨, 직접수정 트랩이라 done 불가. **abandon/삭제 가능**.

## 4. 미완 (원 요청 wi_26062257r `source_request` 잔여)

- 사소항목 정리: archive(terminal work item)·스테일 브랜치·`.gitignore`. C-6과 분리해 follow-up으로 남김(intent `out_of_scope`).

## 5. 다른 PC 세션 시작 — 재빌드 & setup

```
git pull 했어. ditto 바이너리 재빌드하고 setup 다시 실행해서 글로벌 설치본·.claude/agents variant 링크·allowlist를 최신 코드에 동기화해줘.
- bun install (변동 없으면 no-op)
- bun run build:bin && bun run build:plugin && bun run build:codex-plugin
- ditto setup (인터랙티브 — variant agent-link 포함. --yes는 agent-link 건너뜀)
검증: ditto doctor 전 축 drift 0. 새 ditto doctor variants로 변종↔호스트 spawn 불변식도 확인(orphan 0이면 ok). surface drift 뜨면 surfaces:gen 재생성. PreToolUse 훅이 정상 명령 false-positive 차단 시 DITTO_SKIP_HOOKS=1 prefix.
```

## 6. 비전파 GOTCHA (이번 세션)

- **C-6 가드는 claude-code 호스트 한정** — `--host` 플래그 없음(variant는 claude-code Task로 spawn). 다른 호스트 추가 시 확장 필요.
- **coverage `residual` kind**: ledger에 기록되나 `recurrenceCounts`/`propose` 등 far-field 비용 판정에선 제외(`isFarFieldEscape`=depth|breadth만). `coverage residual` CLI 명령 신설.
- **autopilot generated_nodes file_scope 누락**: generated_nodes를 `record-result` payload로 promote할 때 `file_scope`를 안 실으면 노드 `variant_candidates`=0 → owner 폴백. 이번 세션은 그래서 구현 노드를 cli-implementer/generalist로 **수동 지정**했다. planner는 file_scope를 산출했으나 promote 스키마(`{id,kind,purpose,depends_on,acceptance_refs}`)로 옮기며 누락 — 변종 라우팅 살리려면 record-result payload에 file_scope 포함해야.
- **record-result evidence_refs는 객체 배열**(`{kind,command/path,summary}`), 문자열 아님(common.ts:76 evidenceRef). design 노드는 plan_brief 없이 generated_nodes만 실으면 coverage sweep 없이 닫힌다(작은 작업).
- (기존 유효 GOTCHA: intent.json 직접작성 시 work-item AC mirror 필수 — id-set 불일치 시 intent-drift FAIL; coverage intensity 첫 seed만 영속.)

## 7. 핵심 파일

- `src/cli/commands/doctor.ts:559` — `variantsCommand`(detect + `--fix`), `findOrphanVariants` 호출.
- `src/core/doctor-fix.ts:108-152` — `register-variant` FixKind, `.ditto/agents`→`.claude/agents` 복사(skip-existing).
- `src/core/agent-variants.ts:174` — `findOrphanVariants`(순수 set-difference).
- `src/schemas/coverage.ts:169,179` — `residual` kind, `isFarFieldEscape`.
- `src/core/coverage-feedback.ts:147,165` — `recurrenceCounts` 제외, `recordResidual`.
- `src/cli/commands/coverage.ts` — `coverage residual` 명령.
- `.ditto/knowledge/adr/ADR-0023-*.md:60-72` — far-field 자동화 보류 기록.
- `src/core/coverage-manager.ts:458-464` — far-field 비용 모델(wi_26062227h 출처).
