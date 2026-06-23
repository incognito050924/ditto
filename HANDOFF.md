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

"far-field pre-mortem 재설계". 이번 세션 대화가 비용 질문에서 출발해 far-field의 **근본 신뢰성**까지 파고들어 도달한 결론. (자세한 추론 사슬은 호스트 메모리 `project_premortem_redesign` — 이 PC 로컬, git 미전파.)

**신뢰성 문제(대화로 확인)**: LLM pre-mortem은 leading-question + 작화(confabulation)로 *없는* 위험을 지어낸다("A의 관계 실패는?" → A에 관계가 없어도 생성). DITTO의 anti-SLOP(refute-by-default·oracle 결박)은 **코드가 아니라 LLM 규율**이다 — `coverage-loop`/`coverage-manager.ts:141`은 LLM이 보고한 `admissibleBranchesAdded` 숫자를 받을 뿐, oracle(`file:line`) 실재를 코드가 검증하지 않는다. dialectic도 skill-driven(LLM 수행). 즉 환각 거르기를 또 LLM에 맡긴다.

**카테고리 3분류(코드 결박 가능성)**:
- **① 강함**(코드로 환각 결정적 기각): `cross-feature`·`compat-version`·`boundary-edge`·`input-validation`·`security-privacy`(시크릿). → LLM 발산 + **코드 oracle 검증**.
- **② 부분**(구조 grep·동작 재현 비용): `authentication`·`authorization`·`data-integrity`·`resource-abuse`(N+1)·`configuration`·`reuse`. → LLM + 결정적 도구 보강.
- **③ 약함**(코드로 환각 못 거름 + 환각 다수): `external-env`·`deployment-rollout`·`concurrency-ordering`·`observability`·`auditing`·`minimal-increment`. 검증 약한데 진짜 사고도 잦은 역설. `minimal-increment`는 pre-mortem 아닌 코드리뷰 영역(카테고리 오류).

**사용자 결정(1차)**: ③ 약함 그룹을 far-field 자동 sweep에서 제외하고 deep-interview 사용자 확인으로 이관. 효과: 비용↓·신뢰성↑·본질 회복.

**정교화(후속 자기검토 — 1차가 거칠었음)**: ③를 *통째로* deep-interview에 넣는 건 과하다. 진짜 분류 기준은 카테고리(①②③)가 아니라 **"누가·언제 답하나"**다. 같은 카테고리도 갈린다(예: `authorization` = "어떤 인가 모델?"은 의도→deep-interview, "코드가 그 모델 지키나?"는 코드 검증):
- **코드가, 언제든** → 자동 검증/정적도구: ①② 대부분 + `concurrency` 등 정적탐지 가능분. (QuestionGate: ①②를 deep-interview에서 물으면 **안 됨** — 코드가 답하고, 사용자도 답하려면 코드 봐야 함.)
- **사용자가, 의도 단계** → **deep-interview**: ③ **요구사항형**(감사 필요?·인가 모델?·호환성 보장 수준?) + ② 일부. ← ③ 이관의 핵심은 *이것만*.
- **실제 동작이, 구현 후** → **검증·리뷰 단계**: boundary/race 재현, `external-env` 실패 = ③ **구현위험형**. deep-interview엔 사용자도 못 답함(구현 미정).

**남은 설계 작업**: ③를 요구사항형 vs 구현위험형으로 재분할(deep-interview 시딩은 요구사항형만); ②③ 경계 정밀 분류; ① 카테고리에 oracle 결정적 검증(`file:line` 실재를 grep/AST로) 부착; deep-interview 질문 시딩 경로(question-generator/gate); 비용(분할 vs 통합·ON/OFF 증분 ~20배 추정, `coverage-manager.ts:458-464` 모델)은 ① 축소 후 재측정. intent.json 미작성 — deep-interview/계획부터.

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
