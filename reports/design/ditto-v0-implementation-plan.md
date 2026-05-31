---
title: "DITTO v0 구현 계획 (M0–M2)"
kind: plan
last_updated: 2026-05-27 KST
status: draft
parent: reports/design/ditto-claude-code-harness-design.md
scope: "v0 = Milestone 0~2. build unit별 런타임 동작(control-flow) · 구현 대상 계약/스키마 · acceptance · 참고자료. post-v0(M3–M6)는 §5 개요만."
inputs:
  - reports/design/ditto-claude-code-harness-design.md            # §12 Milestone, §6 계약, §7 plugin/hook/skill/subagent, §11 코드 품질 원칙
  - reports/design/contracts/deep-interview-contract.md           # interview 게이트 how
  - reports/design/contracts/autopilot-contract.md   # orchestrator 드라이버 how
  - reports/design/contracts/dialectic-deliberation-contract.md   # 3역 토의 how
  - reports/design/contracts/convergence-contract.md              # 수렴 게이트 how
  - reports/harnesses/oh-my-claudecode.md                         # hook/skill/Stop persistence/control-data plane (구현 패턴 1차)
  - reports/harnesses/oh-my-openagent.md                          # Sisyphus orchestrator · 6-section delegation
  - reports/harnesses/ouroboros.md                                # deterministic_floor · 이중 게이트 (M0/M1 게이트 1차)
  - reports/harnesses/get-shit-done.md, superpowers.md, deepagents.md  # plan-verify·approval gate·stateless subagent
  - Claude Code 공식 plugin/hook/skill/subagent 메커니즘 (claude-code-guide 조사, §1·§6)
  - src/schemas/*.ts (Zod, authoritative), package.json (Bun+TS+Zod+Biome 스택)
---

# DITTO v0 구현 계획 (M0–M2)

> **이 문서의 위치.** 설계 산출물의 세 번째 계층이다. **설계서**(what) → **계약 상세문서**(how-spec: 메커니즘·스키마) → **본 구현 계획**(plan: build unit별 런타임 동작·순서·acceptance·참고자료). 계약 상세문서는 스키마(정적 구조)에 기울어 런타임 control-flow가 약했다 — 본 문서가 그 동작(언제 무엇이 발화하고 무엇이 무엇을 호출하는지)을 채운다. 충돌 시 권위는 실제 스키마 > 설계서(what) > 계약 상세문서(how) > 본 계획(언제·어떤 순서로 짓나) 순이다.

## 0. 범위와 읽는 법

- **범위 = v0 = Milestone 0~2**(설계서 §12). M0=계약·스키마·fixture, M1=plugin skeleton + UserPromptSubmit/Stop 최소 동작, M2=autopilot skeleton. post-v0(M3–M6)는 §5에 한 줄 개요만 — 아직 검증 안 된 단계를 상세히 박지 않는다(MVP 공리).
- 각 build unit은 네 항목으로 기술한다: **동작**(control-flow), **대상 계약/스키마**, **acceptance**(검증 기준), **참고**(하네스/자료).
- 본 계획은 DITTO를 짓는 순서지, 사용자 작업을 한 단계씩 끊겠다는 뜻이 아니다(설계서 §12 주석).

## 1. 횡단 구현 결정 (모든 build unit에 적용)

연구로 확정된 사실 + 설계 원칙을 한곳에 모은다. 개별 unit은 이 결정을 전제한다.

| # | 결정 | 근거 |
|---|---|---|
| D1 | **스택 = Bun + TypeScript + Zod + Biome.** 스키마는 `src/schemas/*.ts`(Zod), JSON export는 `zod-to-json-schema`(`scripts/export-schemas.ts`), 테스트는 `bun test`, lint는 biome. | `package.json` 실측. 설계서 §11 원칙 11(TS/JS 통일). 연구 gap #4(러너 미정) 해소. |
| D2 | **3층 분리**(설계서 §11 원칙 10): **schema**(Zod = 바 정의) / **glue**(얇은 결정론 코드 = 라우팅·IO·검증) / **judgment**(skill·agent 프롬프트 = 맥락 판단). 판단을 hook 키워드·임계치로 굳히지 않는다. | HANNES (B)형 누출 반면교사(`hannes.md` §5). |
| D3 | **orchestrator = main agent가 `autopilot` skill 실행(결정+spawn 인라인) + Stop hook 루프 + 1-레벨 fan-out.** subagent는 subagent를 spawn 못 하므로 spawn 루프는 main에만 살 수 있다 → main이 직접 결정하고 stage subagent를 Task로 spawn, Stop hook이 조기 종료를 막아 루프 유지. **주류 일치**: OMOA Sisyphus=primary, OMC Ralph+persistent Stop, OMX `$ralph`/`$autopilot` 모두 orchestrator=main+Stop hook. 결정 로직을 별도 결정자 subagent로 떼는 분리(HANNES harness 패턴)는 **v0 후 결정 context 오염 증거 시 `context: fork`로 추출하는 future refinement**(autopilot §3.5) — v0엔 과잉. | claude-code-guide(중첩 spawn 불가) + 하네스 4종 조사(주류=orchestrator on main). |
| D4 | **hook fail-open = 기본 — 단 *인프라 오류*에만.** exit 0 = 이의 없음(stdout JSON 파싱), exit 2 = block(stderr=Claude 피드백), 기타 = 비블로킹 오류. hook 시작에 kill-switch(`DITTO_SKIP_HOOKS`) 확인, try/catch로 오류는 로그만. **두 층위 구분(§8-4)**: hook 자체의 크래시/예외만 fail-open(exit 0)이고, 게이트가 정상 실행돼 미충족을 *판정*하면 exit 2(fail-closed). 정책 미정의 게이트(§8-4 safe-default 등)도 fail-closed가 기본 — fail-open은 "코드가 죽었을 때"지 "게이트가 막을 때"가 아니다. | claude-code-guide(exit code 규약) + OMC fail-open(`oh-my-claudecode.md:55,144-146,213`). |
| D5 | **결정론 1차 / LLM 2차.** 게이트(완료·수렴·모호성)는 정규식·상수·산술 검사를 1차로 통과시키고 LLM 자기보고는 2차로 제한. | ouroboros `deterministic_floor`(`ouroboros.md:27-34`), LLM 비용 경고(`ouroboros.md:141`). |
| D6 | **버전 가용성 → doctor.** 일부 hook 이벤트·기능은 최신 Claude Code에만 존재(예: hook `if` 필드 v2.1.85+, fork subagent v2.1.117+). doctor가 런타임에 이벤트 가용성·`claude plugin validate .`를 확인하고 미지원이면 graceful degrade. **출처 시점성 주의**: 아래 버전 전제는 `claude-code-guide` 조사 시점 값이며 repo 내 고정 출처가 아니다 — 각 hook/plugin build unit 착수 직전 **공식 문서로 재고정**하고, 런타임 진실은 doctor의 실측 가용성을 1차로 삼는다(plan 숫자는 advisory). | claude-code-guide(버전 표, 시점값). |
| D7 | **hook 실행체 = Node `.mjs` + plugin-root 경유.** Bash hook 회피(cross-platform). 개발 중엔 TS를 bun으로 실행, 배포 패키지는 `.mjs` 번들 + `$CLAUDE_PROJECT_DIR`/`CLAUDE_PLUGIN_ROOT` 기준 경로. | OMC(`oh-my-claudecode.md:44,136-142`) + claude-code-guide. |
| D8 | **행동강령 주입 = CLAUDE.md 상주 + hook 재주입(projection).** orchestrator가 main에서 도므로 charter는 main의 CLAUDE.md(+`@`import)에 상주. drift 방어는 **hook 재주입** — UserPromptSubmit hook이 매 턴 charter *projection*(prime directive + 활성 규칙)을 `additionalContext`로 주입(M1.3), 압축 후엔 SessionStart(post-v0)가 복구. full charter는 CLAUDE.md/skill 본문에 두고 progressive disclosure(통째 주입 금지 — 토큰·노이즈). stage subagent엔 agent `.md`·`skills:` frontmatter·packet CONTEXT로 주입. **v0 범위**: UserPromptSubmit projection만(M1). SessionStart·PreCompact는 post-v0(M4). | 욕구: 행동강령 망각 방지. HANNES `@AGENTS.md`+`session_start.py`, OMC skill-injector hook 선례. |

---

## 2. Milestone 0 — 계약·스키마·fixture

목표: **플러그인 런타임(hook·skill·agent) 표면 없이도** 게이트가 fixture를 판정 가능하게 한다 — 게이트는 순수 함수(M0.4)로 짓되 플러그인 표면에 묶이지 않는다(그 표면은 M1에서 게이트를 *호출*만 한다). 계약을 "글"이 아니라 *검증 가능한 데이터*로.

### M0.1 — 기존 스키마 매핑 확정

- **동작**: 신규 사이드카가 재사용할 기존 Zod 타입을 고정한다. `work-item.ts`(authoritative state: source_request/goal/acceptance_criteria/status/re_entry/runs/handoff_path), `completion-contract.ts`(final_verdict=pass⇒모든 AC pass∧in-scope unverified 0의 superRefine), `evidence-log.ts`+`common.ts`(evidenceRef: kind=command|file|artifact|url|note). 신규 status enum·evidence pointer를 만들지 않는다.
- **대상 계약/스키마**: 설계서 §3.3 매핑표. `src/schemas/{work-item,completion-contract,evidence-log,common}.ts`.
- **acceptance**: 신규 사이드카 스키마가 위 타입만 import해 재사용함을 grep으로 확인. 중복 enum 0건.
- **참고**: 설계서 §3.3. OMC가 session-state migration으로 복잡해진 반면교사(`oh-my-claudecode.md:232-234` — schemaVersion 등 메타 필드 권장).

### M0.2 — 신규 사이드카 Zod 스키마

- **동작**: 7개 사이드카 스키마 신설(전부 additive, work-item status 대체 안 함): `intent`(in_scope/out_of_scope/acceptance_criteria/question_policy), `question-gate`(self_answer_attempts/decision), `interview-state`(dimensions[]·readiness·exit, deep-interview 상세 §6.2), `autopilot`(nodes[]·approval_gate·caps·stop_conditions, autopilot 상세 §8.2), `dialectic`(input/producer/opponent/synthesizer 출력, dialectic 상세), `convergence`(버전 점수·decision ledger·정직 라벨, convergence 상세), `handoff`(from/to 컨텍스트·open_threads·evidence_refs·next pointer, §6.10 — 설계서 §12 (a) v0 contract·M0 목표 line 1114; runtime은 M4지만 *schema*는 v0 contract라 M0에 둠. M2.5는 handoff artifact를 만들지 않고 handoff-required 신호와 schema compatibility만 남김). `schema_version`·`work_item_id`·`evidenceRef` 재사용.
- **대상 계약/스키마**: §6.1/6.2/6.3/6.5/6.6/6.9/6.10 + 4개 상세문서. 신규 `src/schemas/{intent,question-gate,interview-state,autopilot,dialectic,convergence,handoff}.ts`.
- **acceptance**: `bun test`로 각 스키마 parse/refine 통과. **export 등록 검증(거짓 양성 차단)**: `scripts/export-schemas.ts`의 export 목록과 `src/schemas/index.ts` barrel은 둘 다 *수동* 목록이라(`export-schemas.ts:17` 하드코딩) 신규 스키마를 빠뜨려도 `export` 명령은 성공한다 — 따라서 "export 성공"만으로는 불충분하다. 7개 신규 스키마가 **index.ts와 export 목록 양쪽에 모두 포함**됨을 단언하는 테스트를 둔다(누락 시 fail). 그 후 7개 `*.schema.json`이 실제로 생성됨을 확인. **3개 정합 flag 해소**(서브에이전트 발견): ① dialectic Opponent severity `critical|major|minor` ↔ `common.ts` severity `info|low|medium|high|critical` 매핑(critical|major→critical|high) ② dialectic Synthesizer verdict `accept|revise|reject|blocked`는 completion verdict와 별도 enum 신설 ③ convergence `kind`(finding|hypothesis|taste)·`status`(acted|deferred|dismissed) 신규 enum.
- **참고**: 4개 계약 상세문서의 §스키마 절. ouroboros provenance 타입(source×status, `ouroboros.md:60-68`)을 interview-state·convergence 라벨에 반영.

### M0.3 — fixture 세트

- **동작**: 게이트가 판정할 입력 fixture를 만든다 — (a) ready/blocked interview-state 각각, (b) vague AC / observable AC, (c) pass/partial/unverified completion, **(c') work item ↔ completion AC 불일치 3종: criterion 누락·잉여·중복(`completionGate(workItem, completion)`가 FAIL 내야 함, M0.4)**, (d) converged/treadmill/early-converge convergence, (e) 예시 work item + dialectic artifact, **(f) handoff valid/invalid(게이트 없는 parse fixture)**. pass 케이스와 fail 케이스를 쌍으로.
- **대상 계약/스키마**: 위 신규 스키마 전부.
- **acceptance**: `tests/fixtures/` 아래 각 스키마별 valid+invalid fixture. `bun test`에서 valid는 parse 성공, invalid는 실패.
- **참고**: deep-interview 상세 §6.2 예시 JSON, ouroboros 등급 케이스(`ouroboros.md:72-76`).

### M0.4 — 결정론 게이트 + fixture 판정 (verifier가 판정)

- **동작(control-flow)**: 게이트 함수들을 순수 TS로 구현 — `deterministicFloor(ledger)`(열린 필수 섹션·CONFLICTING·assumption 비율 산술 → ambiguity 하한), `acceptanceTestable(ac)`(VAGUE_TERMS 상수 + observable 정규식), `completionGate(workItem, completion)`(final_verdict=pass ⇒ 모든 acceptance verdict=pass **∧ `completion.acceptance[].criterion_id`가 unique(중복 0) ∧ 그 multiset이 `workItem.acceptance_criteria[].id`와 정확히 일치** — 누락·잉여·중복 모두 FAIL. *단순 Set 비교는 중복을 못 잡으므로* `ids.length === uniqueIds.size === workItemIds.size` 같은 count 검사 또는 multiset 비교로 판정), `convergenceGate(convergence)`(**이미 기록된 필드만 검증** — admissible 열린 반론 수==0, `selected_version`==argmax(score), decision ledger 정합/CompletionGate와의 교집합; **prose에서 admissibility를 *추론*하지 않는다**. admissibility *판정*은 runtime/LLM 층(M3, convergence 상세)의 책임이고 결과는 schema 필드에 박힌다 — M0 게이트는 그 기록 필드만 본다(D5 결정론 1차 / LLM 2차)), `highRiskAssumption(assumption)`(non-local ∨ irreversible ∨ unaudited 중 하나라도 참이면 high-risk → M2.1b/M2.2가 `approval_gate.status=pending`을 산출할 신호 반환; 셋 다 거짓이면 safe-defaultable). 각 게이트는 fixture를 입력받아 PASS/FAIL + 사유 반환. LLM 호출 없음(D5).
- **대상 계약/스키마**: §6.8 Completion, §6.9 Convergence, deep-interview §4.2 게이트.
- **acceptance**: M0.3 fixture에 게이트 적용 → 기대 판정과 일치(`bun test`). "verifier가 fixture를 판정"(설계서 §12 M0 완료기준) = 이 게이트 테스트가 그린.
- **참고**: ouroboros `deterministic_floor`·등급 게이트·검증가능성 기계 판정(`ouroboros.md:27-34,72-81,116`) — 정규식·상수 거의 그대로 차용. high-risk assumption 차단(`ouroboros.md:78`).
- **주의(AC 대조 책임)**: `completion-contract.ts` superRefine은 `completion.json` *내부* 정합(verdict=pass 항목·in-scope unverified 0)만 본다 — work item을 입력으로 받지 않아 criterion 누락을 못 잡는다. 따라서 "모든 AC가 닫혔는가"의 집합 대조는 **gate(glue)의 책임**이며 `completionGate`가 `workItem`을 함께 받아 수행한다(schema는 그대로 두고 gate가 cross-check). CLAUDE.md "gate ↔ score 일치"·"호출자 전수 확인"의 직접 적용.

---

## 3. Milestone 1 — Claude Code plugin skeleton

목표: `claude --plugin-dir`로 실제 로드되는 플러그인 + UserPromptSubmit/Stop 최소 동작.

### M1.1 — plugin.json + 레이아웃 + doctor

- **동작**: `.claude-plugin/plugin.json`(name=`ditto`, description, version) 작성. 루트에 `hooks/`·`skills/`·`agents/`·`commands/`. doctor 커맨드가 hook 이벤트 가용성·`claude plugin validate .`·plugin root 스캔을 런타임 확인(D6). **charter projection preflight(D8 전제)**: D8은 charter가 CLAUDE.md에 상주함을 전제하므로, doctor가 **CLAUDE.md charter projection 존재를 preflight 확인**한다(현 `doctor instructions --host claude-code`가 `projection_missing` drift를 보고) — 누락이면 M1 hook 착수 전 bridge sync/생성으로 닫는다(UserPromptSubmit projection이 빈 charter를 주입하는 것 방지).
  - **`commands/` 빈 디렉터리 주의**: M1.5 shadowing 정책상 v0엔 동명 command wrapper가 없어 `commands/`가 **빈 채로 남을 수 있다**. layout에 디렉터리는 두되, ① 빈 `commands/`로 `claude plugin validate .`가 깨지지 않는지 확인(깨지면 디렉터리 생성을 command 첫 추가 시점으로 미룸), ② surface inventory(M1.6)는 빈 `commands/`를 "command surface 0개"로 정상 처리하고 drift로 오판하지 않게 한다(F3 false-green 처리와 일관 — 부재 catalog는 fail이되 빈 *실제* 표면은 정상).
- **대상 계약/스키마**: 설계서 §7.1 layout. `surface-catalog.ts`(이미 존재 — inventory 타입).
- **acceptance**: `claude --plugin-dir ./` 로드 성공, `claude plugin validate .` 통과. skill/command가 `/ditto:<name>`으로 노출.
- **참고**: claude-code-guide(plugin.json 필드·`--plugin-dir`·validate·네임스페이싱).

### M1.2 — hooks.json manifest + fail-open glue

- **동작**: `hooks/hooks.json`에 UserPromptSubmit·Stop·PreCompact·PostToolUse 등록(matcher). **등록 ≠ 실동작**: v0에서 *실동작*은 UserPromptSubmit(M1.3)·Stop(M1.4) 둘뿐이고, PreCompact·PostToolUse는 **manifest 등록 + no-op stub**만(exit 0 즉시 반환) — 실로직은 post-v0(PostToolUse=M3 evidence 수집, PreCompact=M4 handoff; D8). stub을 v0에 두는 이유는 manifest 표면을 고정해 M3/M4가 등록 변경 없이 본문만 채우게 하기 위함. 각 hook은 `.mjs`로 plugin-root 경유 실행(D7). 공통 wrapper: kill-switch 확인 → try/catch → **오직 hook 자체의 크래시/예외만** 로그+exit 0(fail-open, D4). **주의(fail-open 경계)**: `completion.json`/`convergence.json`/`autopilot.json` **schema parse 실패는 "hook 크래시"가 아니라 "게이트 입력 위반"**이므로 wrapper가 삼켜 exit 0하면 안 된다 — 이건 게이트가 *판정*한 미충족(fail-closed, exit 2)이다(D4의 두 층위 구분). 즉 try/catch는 게이트 로직 *바깥*(IO·parse 단계의 예기치 못한 크래시)만 감싸고, malformed artifact는 게이트가 명시적으로 exit 2로 처리한다.
- **대상 계약/스키마**: 설계서 §7.2 hook 표(v0 표면 4개).
- **acceptance**: hook 오류 주입 시 세션 안 깨짐(fail-open) 테스트. hook이 `$CLAUDE_PROJECT_DIR`로 `.ditto/` 접근.
- **참고**: claude-code-guide(hooks.json·exit code) + OMC fail-open·Node hook(`oh-my-claudecode.md:55,136-146`).

### M1.3 — UserPromptSubmit hook 최소 동작

- **동작(control-flow)**: 프롬프트 제출 → hook이 (1) active work item 로드 or 생성(glue), (2) 입력을 분류(실행 의도/질문/deep-interview 필요성 — **advisory, 키워드 표 아님**: 판단은 skill로 위임, hook은 신호만), (3) `additionalContext`로 **charter projection(prime directive + 활성 규칙)** + active work item·pending handoff 요약 주입(D8). block 안 함(advisory).
- **active 판정 규칙(단일 active invariant — F3)**: "active work item"을 무엇으로 정하는지 고정한다. **`session_id → work_item_id` 포인터**(`.ditto/sessions/<session_id>.json` 또는 work-item 내 `active_session`)를 단일 출처로 두고, **세션당 active work item은 최대 1개**. 포인터가 없으면(신규 세션) 생성, 있으면 그 work item을 로드. **다중 active 후보(여러 draft/in_progress)·session resume 충돌 시 정책**: 임의로 하나 고르지 않고 — (기본) 포인터가 가리키는 것만 active, 포인터가 모호/유실이면 **ask**(어느 work item을 이어갈지 user-owned decision, §6.2) 또는 신규 생성. UserPromptSubmit과 Stop이 *같은* 포인터를 읽어 동일 work item을 물게 한다(둘이 다른 걸 물면 안 됨).
- **대상 계약/스키마**: §6.1 Intent, §6.2 QuestionGate(advisory 진입). `work-item.ts`, 신규 `intent.ts`. session→work_item 포인터(신규 glue 상태).
- **acceptance**: 빈 상태에서 work item 생성 + 포인터 set. 기존 포인터 있으면 그 work item 로드·context 주입. **다중 draft/in_progress fixture → 포인터가 가리키는 단 1개만 active(나머지 무시); 포인터 모호/유실 → ask 또는 신규(임의 선택 금지)**. Stop(M1.4)이 UserPromptSubmit과 같은 포인터로 같은 work item을 봄. 분류는 로그로 남고 차단 없음. **placeholder-only AC + execution 의도 prompt 교집합 → charter 에 `▶ Run /ditto:deep-interview now …` directive inject(§AC-1, wi_v04intent_autopilot_entry 2026-06-01)**; 두 조건 중 하나라도 불만족이면 미inject — 작은 요청의 heavy workflow 자동 승격 방지(§2 #3). **question 의도 + codebase-locatable surface(file/path/function/error/test/{.ts,.js,…}) 휴리스틱 통과 → `⚠ self-answer from code/docs/web first …` (QuestionGate) hint(§AC-5, wi_v04intent_autopilot_entry 2026-06-01)**; advisory only(exit 0).
- **참고**: claude-code-guide(UserPromptSubmit `additionalContext`). OMC keyword-detector sanitizer·help/reference 억제(`oh-my-claudecode.md:152-154`) — **단 자동 실행 spawn 금지**(`:148-149`), 분류는 advisory로만(D2).

### M1.4 — Stop hook 최소 동작 (완료/수렴 게이트)

- **동작(control-flow)**: Claude 응답 완료 → Stop hook이 (1) `stop_hook_active==true`면 즉시 exit 0(8회 무한루프 가드), (2) active work item의 `completion.json`/`convergence.json` 읽어 M0.4 게이트 적용, (3) 미충족(예: final_verdict=pass인데 unverified AC 존재, 또는 admissible 열린 반론 존재)이면 **exit 2 + stderr에 "무엇이 남았는지"** → Claude 계속 강제, (4) **Stop이 실제로 보는 사건만 분기**한다 — `stop_hook_active` 가드(위)와 정상 응답 완료뿐. **user interrupt는 Stop을 발화시키지 않으므로**(현 Claude Code 문서) 분기가 필요 없고, **API/rate-limit/auth/max-output 오류는 별도 `StopFailure` 이벤트**이며 그 stdout·exit code는 **무시**된다 — 따라서 이들을 Stop의 continuation 제어 분기로 쓰지 않고 `StopFailure`에서 **로깅/no-op**만 둔다(continuation 판정 불가). (출처: Claude Code hooks 문서 Stop·StopFailure 절.)
- **artifact 부재 분기(M2↔M3 순서 명시)**: `completion.json`/`convergence.json`은 **runtime 생성이 M3**이므로(§5) M1·M2 동안엔 보통 *없다*. 부재 시 동작은 두 갈래로 명세한다 — **(가) active autopilot이 없으면**(autopilot.json 부재 또는 모든 노드 종결): work item status로 분기한다(아래 strong-block 단서). **(나) active autopilot에 *지금 실행 가능한* 노드가 남아 있으면**(ready·running, 아래 예외 미해당): 완료 artifact가 없어도 "끝난 게 아니다" → **exit 2로 continuation 강제**. 즉 M2의 지속 실행은 *완료 artifact가 아니라 `autopilot.json` 노드 상태*를 1차 신호로 삼는다(완료/수렴 게이트 판정은 artifact가 생기는 M3 경로). 이 분기는 M1에서 stub로 두되(autopilot.json 없으면 (가)로 빠짐), 실 노드-상태 판정은 M2.2에서 채운다.
  - **(가) strong-block 단서 (wi_v04runtimewiring, 2026-05-31)**: 기존 plan은 (가)에서 무조건 exit 0이었다. v0 closure 후 outcome 매트릭스가 "verify 안 한 채 그냥 종료"를 갭으로 지적해 (가)를 work item status로 분기한다 — **(가-1) NON_TERMINAL(`draft`/`in_progress`/`blocked`/`partial`/`unverified`)이면 exit 2 + stderr로 차단**("completion.json을 쓰거나 work item을 done/abandoned로 전이해 stop하라"); **(가-2) terminal(`done`/`abandoned`)이면 exit 0**. 이로써 CompletionContract의 "끈질긴 완수" outcome이 autopilot 없는 일반 turn에서도 발화한다. 회피경로는 `ditto verify` 또는 `ditto work` status 전이.
  - **(나) continuation 예외 — 사용자/외부에 양보(즉시 exit 0)**: 노드가 남아 있어도 autopilot이 stop_condition에 걸렸으면 루프를 *멈춰* 사용자/plan이 표면화되게 한다(autopilot 상세 §6.1·§6.2). 곧 ① `approval_gate.status==pending`(M2.3이 plan을 제시할 차례 — Stop이 막으면 승인 요청 자체가 안 나간다), ② user-owned decision 대기(§6.2 QuestionGate), ③ external blocker, ④ safety boundary. 이 넷은 "ready 노드 존재" 여부와 무관하게 (가)처럼 exit 0. (M1.4의 기존 예외 (4)는 *인프라* 사유, 본 예외는 *정책* stop_condition — 둘을 구분해 설계.) pending approval의 mutation 노드는 애초에 "실행 가능"으로 치지 않는다(gate 미통과).
- **대상 계약/스키마**: §6.8 Completion, §6.9 Convergence, §6.5 Autopilot(노드 상태). `completion-contract.ts`, 신규 `convergence.ts`·`autopilot.ts`.
- **acceptance**: 미검증 완료 fixture → Stop이 continue 강제(exit 2). 완료 fixture → 통과(exit 0). **완료 artifact 부재 + autopilot.json에 ready 노드 → continue(exit 2); 부재 + active autopilot 없음 + NON_TERMINAL work item → continue(exit 2, §M1.4 strong-block 2026-05-31); 부재 + active autopilot 없음 + terminal(done/abandoned) → 통과(exit 0).** **approval_gate.status==pending fixture(+ 남은 노드) → 통과(exit 0, continuation 강제 안 함); user-owned decision/external/safety stop_condition fixture → 통과(exit 0).** `stop_hook_active` 가드 동작. **malformed completion/convergence/autopilot.json fixture → exit 2**(게이트 입력 위반은 fail-open 아님 — F2/D4). **rate-limit/auth/API 오류는 Stop acceptance에서 제외**(StopFailure 이벤트라 output 무시 — 로깅/no-op만 별도 확인).
- **참고**: claude-code-guide(Stop exit 2 = 계속, `stop_hook_active` 최대 8회). OMC persistent-mode 예외 목록(`oh-my-claudecode.md:160-162,236-238`) — **예외 목록을 먼저 설계**. 단일 primary authority(`:164-166`)로 시작.

### M1.5 — skill skeleton 6종 + alias

- **동작**: `skills/{deep-interview,plan,verify,handoff,dialectic,autopilot}/SKILL.md` + `dialectic-review`(= `/ditto:dialectic --mode review` alias) = 설계서 §7.1 layout의 **v0 skill 7 표면 전부**. frontmatter(name/description/argument-hint) + 본문은 절차·출력 계약. **`plan`·`autopilot`도 v0 skeleton으로 *생성*한다**(설계서 §12 Scope Authority: skeleton은 v0 / 런타임은 M2 — handoff와 동형). 둘 다 **비노출**(§9 노출 command 목록 제외, autopilot/내부가 호출). **비노출은 frontmatter로 강제한다 — `user-invocable: false`**(slash 메뉴 숨김 + 사용자 직접 호출 차단, **단 Claude/autopilot의 모델 호출은 허용** — `disable-model-invocation`은 쓰지 *않는다*, 내부 호출 경로가 막히기 때문). 노출 4종(deep-interview/verify/handoff/dialectic)은 이 필드 없음(기본=노출). 단 **`autopilot/SKILL.md`는 여기서 skeleton(frontmatter+절차 골격)만 — ReAct 루프 본문은 M2.2에서 채운다**(skeleton@M1.5 / 동작@M2.2). 이로써 M1.6 inventory가 v0 skill 7을 전부 검증할 수 있다(autopilot 누락으로 인한 false-fail 방지 — H1).
- **shadowing 정책(동명 skill ↔ command)**: Claude Code에서 custom command와 skill이 **같은 이름이면 skill이 우선**한다(공식 skills 문서). 따라서 v0는 skill과 동명의 `commands/<name>.md` wrapper를 **만들지 않는다** — 명령 표면(`/ditto:<name>`)은 **skill이 authoritative**. command는 skill로 표현 불가능한 별도 표면이 필요할 때만(다른 이름으로) 둔다. 이로써 죽은 shim·이중 정의를 원천 차단(M1.1 acceptance의 "/ditto:<name> 노출"도 skill 경유로 읽는다).
- **대상 계약/스키마**: 설계서 §7.3 skill 표. deep-interview·dialectic 상세문서가 본문 근거.
- **acceptance**: 노출 skill 4종이 `/ditto:<name>`으로 호출됨. dialectic-review가 dialectic --mode review로 라우팅. **비노출 `plan/SKILL.md`·`autopilot/SKILL.md` 두 파일 존재**(노출 호출 테스트는 없으나 둘 다 M1.6 surface inventory 대상 — 누락 시 drift fail; `autopilot`은 skeleton만, 루프 본문은 M2.2).
- **참고**: claude-code-guide(SKILL.md frontmatter·네임스페이싱). OMC progressive disclosure·thin shim(`oh-my-claudecode.md:67-68,180-182`), deepagents(`deepagents.md:76-77`). interview 프롬프트 계약은 ouroboros socratic-interviewer(`ouroboros.md:84-93`).

### M1.5b — agent skeleton (v0 8종)

- **동작**: v0 skeleton 에이전트를 만든다 — **설계서 §7.1 layout의 v0 agents/ 8종과 정합**: ① autopilot owner 5종(M2.2 spawn 대상) `agents/{researcher,planner,implementer,reviewer,verifier}.md`(autopilot 상세 §2.2 kind→owner), ② dialectic 3역 `agents/{dialectic-producer,dialectic-opponent,dialectic-synthesizer}.md`(dialectic 상세 §2.2 — `/ditto:dialectic` skill이 spawn하는 host). 각 `.md`는 frontmatter(name·description·allowed `tools`·필요 시 `skills:`) + 본문은 §6.4 delegation packet 수신 계약(받는 것: TASK·file_scope·done_when / 안 받는 것: 드라이버 가설)만. content 생성 로직은 v0에서 비우고 역할·권한 경계만 고정. **예외 — verifier.md 본문(wi_v04verifier_body_and_declared_by, 2026-06-01)**: M3 판정 주체 outcome과 함께 `agents/verifier.md` skeleton을 채움(acceptance_refs별 evidence kind 선택·실행 절차, verdict 부여, `declared_by='verifier'` 반환 규칙). 나머지 7종 본문은 여전히 v0 skeleton. **post-v0 agent**(architect·playwright-e2e·knowledge-curator)는 해당 milestone(M5/M6)에서(설계서 §7.1 post-v0 placeholder 블록).
- **대상 계약/스키마**: 설계서 §7.1 layout(v0 agents 8종)·§7.4 subagent 표, autopilot 상세 §2.2·§3.3(Context Isolation), dialectic 상세 §2.2(3역 host). 신규 `agents/*.md`.
- **acceptance**: 8개 agent가 `claude plugin validate .` 통과 + Task `subagent_type`으로 호출 가능. M2.2 spawn 대상(owner 5종)·dialectic 3역이 실제로 존재함을 surface inventory(M1.6)가 확인(설계서 §7.1과 1:1). orchestrator는 main role이라 agent 파일 없음(D3).
- **참고**: 설계서 §7.1·§7.4, autopilot §2.2, dialectic §2.2. Sisyphus/Atlas owner 분리(`oh-my-openagent.md`), HANNES stage→owner(`hannes.md` §1). **주의**: 이 unit이 없으면 M2.2 acceptance("ready 노드 selection→spawn")가 spawn 대상 부재로 실행 불가 — M2.2 선결. dialectic 3역도 같이 두어 parent §7.1 v0 skeleton과 어긋나지 않게 한다(구현자가 parent를 따라도 동일).

### M1.6 — surface inventory 테스트

- **동작**: plugin root(`skills/`·`commands/`·`agents/`·`hooks/hooks.json`·`.claude-plugin/plugin.json`)를 스캔해 실제 파일 ↔ 문서 인벤토리 일치를 CI로 검증. 현 어댑터가 repo `.claude/`·home `~/.claude/`만 보면 plugin root 스캔 추가.
- **선결(현 표현력 gap — 착수 전 닫기)**: 현재 타입·스키마·어댑터는 이 acceptance를 실행할 수 없다. ① `SurfaceKind`(`src/core/hosts/types.ts:57`)에 `hook`(필요 시 `plugin-manifest`) 추가 — 지금은 `skill|agent|command|plugin`뿐. ② **`src/schemas/surface-catalog.ts:6`의 `kind` enum도 동일하게 `hook` 추가** — 안 그러면 `.ditto/surfaces.json`에 `hook` 항목이 들어갈 때 `surfaceCatalog.safeParse`가 실패한다(①과 enum을 반드시 함께 확장). ③ Claude Code 어댑터(`src/core/hosts/claude-code.ts:185`)는 현재 repo `.claude/{agents,commands}`+home skills만 스캔하므로 **plugin-root scanner**(`hooks/hooks.json` 파싱 + `skills/`·`commands/`·`agents/` 디렉터리)와 **`.claude-plugin/plugin.json` discovery**를 추가. 이 셋이 닫혀야 drift 판정이 실제로 돈다.
- **대상 계약/스키마**: `src/schemas/surface-catalog.ts`(`kind` enum에 `hook` 추가), `src/core/hosts/types.ts`(`SurfaceKind` 확장), `src/core/hosts/claude-code.ts`(plugin-root 스캔).
- **false-green 차단(필수)**: `collectSurfaceInventory`는 expected catalog(`.ditto/surfaces.json`)가 **부재/빈 목록이면 mismatch 0으로 통과**한다(`src/core/surface-inventory.ts:39-41`) — 현재 repo엔 그 파일이 없어 지금 그대로면 항상 green(거짓). 따라서 M1.6은 ① **catalog 부재·빈 목록 자체를 fail로 판정**(통과 아님), ② **malformed catalog(파싱 실패)도 fail**로 판정 — 현재 `loadExpected`(`src/core/surface-inventory.ts:17`)는 parse 실패를 빈 목록으로 *조용히* 바꿔 false-green을 만든다 → 이 silent-swallow를 고쳐 parse 실패는 명시적 에러, ③ catalog의 **권위 출처를 명시**해야 한다.
- **catalog 권위 출처(F3)**: expected catalog는 **설계서 §7.1 layout + 본 계획의 선언 목록**(v0 skeleton: skill 7 + agent 8 + hooks/plugin.json)에서 산출해 **`.ditto/surfaces.json`으로 checked-in**한다 — 이것이 권위다. **실제 파일 스캔 결과에서 catalog를 자동 생성하면 안 된다**(같은 actual과 비교 → 항상 일치 → 누락·잉여를 못 잡는 tautology). 즉 비교는 *선언(checked-in catalog) vs 실제(스캔)* 두 독립 출처 사이에서만 의미가 있다. catalog 갱신은 surface를 의도적으로 추가/제거할 때 사람이 §7.1과 함께 바꾸는 명시 행위(리뷰 대상).
- **acceptance**: `bun test`에서 인벤토리 drift 감지. 누락/잉여 surface 시 fail. **`.ditto/surfaces.json` 부재·빈 목록 → fail**(통과 금지). **hook surface(`hooks.json`)와 `plugin.json`도 inventory에 포함**돼 drift 대상이 됨.
- **참고**: OMC 문서 drift(skill count 31/38/39 불일치, `oh-my-claudecode.md:201`) 반면교사 — inventory를 코드 생성 + CI 비교(`:219,223-226`).

---

## 4. Milestone 2 — autopilot skeleton

목표: 승인 통과한 단일 요청에서 plan→implement→verify가 사용자 개입 없이 이어진다.

### M2.1 — autopilot.json 스키마 + AutopilotStore (glue)

- **동작**: **autopilot 스키마는 M0.2에서 이미 신설**(`src/schemas/autopilot.ts`: nodes[]·approval_gate·caps·continue_policy·stop_conditions, autopilot §8.2)했으므로 M2.1은 그것을 **소비만** 한다(재정의 금지 — 스키마 소유권은 M0.2 단일). M2.1이 *신규로* 짓는 것은 glue뿐: `AutopilotStore`(읽기/노드 상태 갱신 — 그래프 mutation의 유일 경로) + `autopilot-decisions.jsonl` append-only 결정 로그.
- **대상 계약/스키마**: §6.5, autopilot 상세 §8. **소비**: `src/schemas/autopilot.ts`(M0.2). **신규**: `AutopilotStore`(glue).
- **acceptance**: store를 통해서만 노드 상태 변경. 직접 파일 덮어쓰기 차단(인터페이스로). M0.2 스키마로 fixture graph parse 통과(M2.1이 스키마를 다시 정의하지 않음).
- **참고**: autopilot 상세 §8.2(nodes canonical), 설계서 §11 AutopilotStore.

### M2.1b — autopilot 그래프 bootstrap (work item/intent → 초기 graph → 드라이버 진입)

- **동작(control-flow)**: M2.2 드라이버는 *기존* graph를 전제하므로 그 graph를 **만드는 경로**가 따로 필요하다(설계서 §12 M2 목표 "checkpoint graph 생성"). M1.3 UserPromptSubmit은 work item을 만들/로드만 하고 graph는 만들지 않는다 — 이 unit이 그 사이를 잇는다. bootstrap: intent ready(§6.3 통과) → `root_goal = intent.goal`, `intent.acceptance_criteria` + 작업 종류로 초기 `nodes[]` 산출(kind→owner 매핑, depends_on DAG; 최소 plan→implement→verify 체인) → **approval status 산출**(`highRiskAssumption` 3축으로 high-risk면 `approval_gate.status=pending`, safe-defaultable이면 `not_required`, 이미 승인된 입력이면 `approved`) → `AutopilotStore`로 `autopilot.json` 최초 기록(approval_gate.status·caps·stop_conditions 초기값 포함) → 드라이버(M2.2) 진입. 즉 high-risk 판정의 *생산자*는 graph bootstrap/driver이고, M2.3은 그 결과를 소비한다.
- **대상 계약/스키마**: §6.5, autopilot 상세 §1.2(intent가 입력, ready여야 graph 시작)·§2(노드/엣지)·§8.2. 소비: `intent.ts`·`autopilot.ts`(M0.2), `AutopilotStore`(M2.1).
- **acceptance**: ready intent fixture → 초기 `autopilot.json` 생성(root_goal·nodes·approval_gate 채워짐). high-risk fixture → `approval_gate.status=pending`, safe-defaultable fixture → `not_required`, 이미 승인된 입력 fixture → `approved`. 빈/모호 intent → graph 미생성(§6.3 interview로 회송). 생성된 graph가 M2.2 루프의 입력으로 동작. **`ditto deep-interview finalize` 가 ready 상태에서 같은 호출 안에 `bootstrapAutopilot` 을 자동 실행 → 한 명령으로 `intent.json` + `autopilot.json` 동시 생성(§AC-3, wi_v04intent_autopilot_entry 2026-06-01); 별도 `ditto autopilot bootstrap` CLI 도 idempotent 하게 제공.**
- **참고**: 설계서 §12 M2 "checkpoint graph 생성"·완료기준(`:1152,1159`). intent→graph 매핑은 autopilot §1.2·§2.2. **주의**: 이 unit이 없으면 M2.2가 입력 graph 부재로 돌지 못한다 — M2.2 선결.

### M2.2 — autopilot skill (main agent 구동) + ReAct 루프

- **동작(control-flow)**: main agent가 `autopilot` skill을 따라 ReAct 루프 구동(D3 — 전용 subagent 아님). `LOOP`: (1) `autopilot.json` re-read(컨텍스트 누적 최소화), (2) ready 노드 선택(pending ∧ depends_on passed), (3) kind→owner 매핑 + 6-section packet 구성(Context Isolation §3.3), (4) owner stage subagent를 Task로 직접 spawn(1-레벨), (5) evidence 수집·노드 상태 갱신(AutopilotStore 경유), (6) 실패면 §4 분류 → retry/switch/escalate, (7) stop_conditions 평가. 루프 지속은 **Stop hook**이 조기 종료를 막아 보장(M1.4) — 이때 **M1.4 Stop hook의 노드-상태 분기(나)를 여기서 실구현**한다: Stop hook이 `autopilot.json`을 읽어 *실행 가능한* 노드가 있으면 continuation(exit 2). **단 M1.4 (나) 예외 — approval pending·user-owned decision·external·safety stop_condition이면 exit 0으로 사용자/plan에 양보**(그래야 M2.3 plan 제시와 §6.2 질문이 실제로 표면화된다). 완료 artifact(completion/convergence.json)는 M3에서 생기므로 M2 단계의 continuation 신호는 *노드 상태*다. autopilot skill은 content 생성 안 함 — stage subagent에 위임.
- **대상 계약/스키마**: autopilot §2.2(kind→owner)·§3.2(루프)·§3.4(호스팅=main role). `skills/autopilot/SKILL.md`(**skeleton은 M1.5에서 생성됨 — M2.2는 ReAct 루프 본문만 채운다**). **선결**: ① spawn 대상 owner 에이전트는 M1.5b가 생성한 `agents/{researcher,planner,implementer,reviewer,verifier}.md`, ② 루프가 도는 초기 graph는 **M2.1b가 bootstrap한 `autopilot.json`**(드라이버는 graph를 만들지 않고 *소비*만 한다).
- **acceptance**: fixture graph에서 ready 노드 선택→spawn→상태 갱신→다음 노드 루프 동작. 내부 checkpoint만으로 final answer 안 나감. autopilot skill이 content 직접 생성 안 함(위임).
- **참고**: 주류 일치 — Sisyphus primary orchestrator(`oh-my-openagent.md:130`), OMC Ralph + persistent Stop(`oh-my-claudecode.md:25,160-166`), HANNES Autopilot Loop(`hannes.md` §1). 결정 격리 필요 시 (b) 추출은 autopilot §3.5.

### M2.3 — plan approval gate

- **동작(control-flow)**: 큰 mutation 노드 진입 전 `approval_gate.status`를 확인한다. **M2.3은 high-risk를 새로 판정하거나 status를 산출하지 않는다.** "큰"의 판정은 M0.4 `highRiskAssumption` 3축(**non-local** repo-wide·외부 호출, **irreversible** migration·삭제·배포, **unaudited** 보안 경계·미검증 가정)으로 닫고, 그 판정 결과는 M2.1b bootstrap/M2.2 driver가 `approval_gate.status=pending|not_required|approved`로 이미 기록한다. M2.3은 그 기록을 소비해 `pending`이면 draft work item + plan artifact만 남기고 mutation 중단, 사용자에게 plan 제시. `approved`/`not_required` 후엔 checkpoint마다 재승인 안 함.
- **v0 범위 한정(승인 채널 미해결 — §8-1)**: 사용자 입력을 **블로킹 대기**하는 승인 채널 메커니즘(PreToolUse 권한 프롬프트 활용 여부 등)은 §8-1 미해결 선결조건이다. v0 M2.3은 그 채널을 *구현하지 않고*, **이미 set된 `approval_gate.status`만 소비**한다 — status source는 M2.1b/M2.2의 `highRiskAssumption` 판정, `approved_spec`/`issue`/`prd`/`small_reversible_policy`, 또는 직전 turn의 명시 승인(autopilot 상세 §5.2). 따라서 v0 M2.3 = "현재 status를 읽어 `pending`이면 mutation 중단 + plan 제시, `approved`/`not_required`면 무중단 진행". 인터랙티브 블로킹 채널은 **post-v0 별도 build unit**(§8-1) — v0 빌드그래프에서 M2.3의 `[§8-1]` 의존 엣지는 제거했다(H2: v0 M2.3은 채널 없이 status만 소비하므로 §8-1을 선결로 두면 영원히 착수 불가였음).
- **대상 계약/스키마**: §5.4, autopilot 상세 §5.
- **acceptance**: M2.1b/M2.2가 만든 **`pending` fixture** → mutation 노드 미실행 + plan artifact 생성. **`approved`/`not_required` fixture** → 무중단 진행. M2.3 단독 테스트는 status 소비만 검증하고, high-risk→pending 산출은 M2.1b/M2.2 acceptance에서 검증한다. (블로킹 입력 대기 동작은 v0 acceptance에 포함하지 않음.)
- **참고**: superpowers brainstorming 승인 게이트(`superpowers.md:23,53`), GSD plan-checker read-only 검증(`get-shit-done.md:46,83,139`).

### M2.4 — 노드 dispatch + 실패 분류

- **동작(control-flow)**: dispatch = 6-section packet(TASK/EXPECTED OUTCOME/REQUIRED TOOLS/MUST DO/MUST NOT DO/CONTEXT) + post-delegation verification. 노드 failed 시 분류 → `{failure_class: fixable|wrong_approach|blocked_external|user_decision_needed, decision: retry|switch_approach|escalate|continue}`. retry/switch는 자동(cap 내), escalate/user-decision만 사용자(§6.2). cap 도달 = non-pass(≠converged).
- **대상 계약/스키마**: autopilot 상세 §3.2·§4. `autopilot-decisions.jsonl`.
- **acceptance**: fixable fixture → retry, wrong_approach → switch, cap 초과 → non-pass + `handoff_required`/`re_entry_required` 신호 기록(artifact 생성은 M4). 결정이 로그에 기록.
- **참고**: Sisyphus/Atlas 6-section(`oh-my-openagent.md:131,155`), HANNES failure_classification(`hannes.md` §1), GSD post-wave 실패 게이트(`get-shit-done.md:84`).

### M2.5 — checkpoint 자동 continuation + handoff 신호

- **동작(control-flow)**: 노드 passed → 다음 ready 노드로 자동 진행(개입 없음). 내부 checkpoint 완료를 final answer로 보내지 않음. context pressure나 cap 초과 시 v0는 `/handoff` runtime을 실행하지 않고 `handoff_required`/`re_entry_required` 신호와 같은 `autopilot_id`로 이어받아야 한다는 resume target만 남긴 뒤 continuation을 멈춘다(scope 축소 아님). 실제 `/ditto:handoff`, `PreCompact`, handoff artifact 생성·재로드는 parent Scope Authority대로 M4 runtime이다. stateless 노드(단일 결과 반환, 부모 상태 누수 방지).
- **대상 계약/스키마**: §5.2/§6.10, autopilot 상세 §6.
- **acceptance**: plan→implement→verify가 개입 없이 연결. 내부 checkpoint만으로 final answer 안 나감. context pressure/cap fixture는 `handoff_required`/`re_entry_required` 신호를 남기고 continuation을 멈춤. handoff artifact 생성·재진입 실행은 M2 acceptance에 포함하지 않음(M4).
- **참고**: stateless subagent(`deepagents.md:64-66`), handoff 구조(`oh-my-openagent.md:100,247`, `oh-my-claudecode.md:354-358`), GSD resume gate(`get-shit-done.md:84`).

---

## 5. post-v0 개요 (M3–M6 — 상세는 해당 milestone에서)

- **M3 Evidence·verifier 런타임**: PostToolUse evidence 수집, verifier output contract, completion.json 생성, convergence gate 런타임(admissibility·ratchet·decision ledger). v0의 계약/스키마/게이트(M0)에 *런타임 살*을 붙임. **wi_v04verifier_body_and_declared_by (2026-06-01)**: `CompletionContract.declared_by`를 자유 문자열에서 `declarerRole` enum(`main|planner|implementer|verifier|reviewer|researcher|synthesizer`)으로 좁혀 *판정 주체*(설계서 line 700)를 실행 프로파일(`profileName`)과 분리 — implementer가 verifier를 사칭하거나 실행 프로파일 문자열(`workspace-write`)을 declarer로 박는 것을 schema 단에서 reject. `ditto work handoff --declared-by`(default `main`)로 main이 자기 완료를 선언하는 path 명시. `declared_by`를 읽어 권한 결정하는 소비처 없음 → permission 무영향.
- **M4 Context rot 방지**: subagent-first delegation packet, PreCompact handoff, active work item context injection.
- **M5 Playwright E2E**: `/ditto:e2e`, `playwright-e2e` agent, browser artifact(MCP 아님, 직접 Playwright).
- **M6 Knowledge·PM**: `.ditto/knowledge` 승격, GitHub Issues/Projects bridge.

## 6. 참고자료 카탈로그 (무엇을 어디서)

| 영역 | 1차 출처 | 비고 |
|---|---|---|
| Claude Code plugin/hook/skill/subagent 메커니즘 | 공식 문서(claude-code-guide 조사) | exit code·additionalContext·Stop exit 2·subagent 중첩 spawn 불가·SKILL frontmatter — §1 D3/D4 근거 |
| hook 구현 패턴(fail-open·Node·keyword-detector·persistent Stop·control/data plane) | `oh-my-claudecode.md` | OMC 문서 drift는 반면교사(`:200-203`), 메커니즘만 차용 |
| orchestrator·delegation·fan-out | `oh-my-openagent.md`(Sisyphus/Atlas) | OpenCode 강결합(`:9,164` — 개념만, hook 코드 직접 차용 금지) |
| 결정론 게이트·이중 게이트·deterministic_floor | `ouroboros.md` | M0/M1 게이트의 코드 수준 단일 출처(단일 출처 리스크 인지) |
| plan-verify·approval gate·wave/overlap | `get-shit-done.md`, `superpowers.md` | GSD wave gate는 다중 노드 전제(autopilot 단일 노드면 과함) |
| stateless subagent·context offloading | `deepagents.md` | 부모 상태 누수 방지 제외 키 |
| failure classification·Autopilot·Context Isolation | `hannes.md`(HANNES harness) | 전신 하네스 — 가장 가까운 선행 구현 |

## 7. 빌드 순서·의존

`[§8-N]`는 그 노드 진입 전 닫아야 하는 선결 결정(§8의 미해결 항목을 빌드 엣지로 승격).

```text
                              ┌─[§8-2 락 전략]
M0.1 → M0.2 ─────────────────┘ → M0.3 → M0.4   (스키마·fixture·게이트가 먼저; 코드 없이 검증 가능)
  └─ M0.4(게이트) 가 M1.4 Stop hook의 호출 대상
                                      ┌─[§8-6 turn 경계]
M1.1 → M1.2 → {M1.3, M1.4 ───────────┘, M1.5, M1.5b} → M1.6   (plugin 골격 → hook glue → 동작 → skill·agent 골격 → inventory)
       ┌─[§8-2 락]          ┌─[§8-6 turn 경계]                 ┌─[§8-3 재진입 경계]
M2.1 ──┘ → M2.1b → M2.2 ────┘ → {M2.3, M2.4} → M2.5 ───────────┘   (store → graph bootstrap → 드라이버 → gate·dispatch → continuation)
  └─ M2.2 선결 = M1.5b agent skeleton(spawn 대상) + M2.1b 초기 graph(드라이버 입력)
  └─ M2.3(v0)은 [§8-1 승인 채널]에 의존하지 않는다 — M2.1b/M2.2가 산출한 approval_gate.status를 소비만 함(H2). [§8-1]은 post-v0(인터랙티브 채널) 선결로 격하.
```

- M0이 M1·M2의 토대(스키마·게이트). M1 Stop hook(M1.4)은 M0.4 게이트를 호출한다.
- M2 orchestrator(M2.2)는 M1 plugin·skill(M1.5)·subagent(M1.5b) 골격 위에서 돈다.
- **선결 게이트**: 그래프의 `[§8-N]` 엣지가 통과하지 않으면 해당 노드 착수 금지 — 이게 계획/실행 불일치를 막는 메커니즘. §8 본문이 처리 시점을 글로 적었다면, 위 그래프는 그것을 *엣지*로 고정한다. (단, §8-4·§8-5는 특정 노드의 선결이 아니라 *구현 중 교차검증* 항목 → 그래프 밖, §8 하단 별도 분류.)
- 설계서 §15 "다음 구현 후보" 6개 = M0.2~M0.4 + M1.1~M1.5의 첫 슬라이스에 대응.

## 8. 미해결 / 추가 조사 필요

연구가 다 못 닫은 지점. 두 부류로 나뉜다 — **(A) 노드 선결**(특정 노드 진입 전 닫아야 함 → §7 빌드 그래프에 `[§8-N]` 엣지로 승격: 항목 2·3·6) / **(B) 구현 중 교차검증**(특정 노드의 선결이 아니라 구현하며 검증·정책화: 항목 4·5). **항목 1(승인 채널)은 v0 M2.3 선결에서 제외**(H2) — post-v0.

1. **plan approval gate의 사용자 승인 채널 (post-v0 — v0 M2.3 선결 아님)** — hook/skill이 사용자 입력을 블로킹 대기하는 정확한 메커니즘(PreToolUse 권한 프롬프트 활용 여부). **v0 M2.1b/M2.2는 `highRiskAssumption`으로 `approval_gate.status`를 산출하고, M2.3은 이미 set된 status만 소비하므로 이 채널은 v0 노드 선결이 아니다**(§7에서 M2.3의 `[§8-1]` 엣지 제거 — H2). 인터랙티브 채널을 실제 구현하는 post-v0 시점에 Claude Code 확인.
2. **상태 파일 동시성/락** — `autopilot.json`·`interview-state.json`의 단일 writer 강제·crash recovery. M2.1·M0.2에서 락 전략 결정(GSD 단일 writer 언급은 디테일 없음).
3. **autopilot continuation 재진입 경계** — 같은 세션 내 continuation인지 새 세션 handoff 재로드인지의 복원 절차. v0 M2.5는 `handoff_required`/`re_entry_required` 신호까지만 남기고, 실제 handoff artifact 생성·재로드는 M4에서 확정.
4. **safe-default 정책 미명세 → M0.4 `highRiskAssumption`과 동일 정책으로 통일(해소).** ouroboros `finalize_safe_defaultable_gaps`의 "local·reversible·audited"는 M0.4 `highRiskAssumption`의 부정과 **정확히 같은 3축**이다: `safe = ¬(non-local ∨ irreversible ∨ unaudited) = local ∧ reversible ∧ audited`. 따라서 별도 정책을 새로 정의하지 않고 **`safeDefaultable(x) = ¬highRiskAssumption(x)`** 로 정의한다(둘은 한 술어의 양면 — high-risk가 *아니면* 곧 safe-defaultable). `highRiskAssumption(x)`가 참(=high-risk)이면 M2.1b/M2.2가 `approval_gate.status=pending`을 산출하고, 거짓이면 `not_required`로 산출할 수 있다. — *판정 위치*만 주의: 정책 술어는 M0.4 1곳, status 산출은 M2.1b/M2.2, status 소비는 M2.3.
5. **이중 게이트 단일 출처 리스크** — convergence 핵심(backend∧ledger·deterministic_floor)이 ouroboros 단독 출처. M0.4 구현 시 교차 검증 권장.
6. **autopilot 루프의 turn 경계** — main이 노드 사이를 한 응답 안에서 이어가는지 vs Stop hook continuation으로 재진입하는지(주류 OMC는 Stop hook continuation). M1.4/M2.2 착수 전 Claude Code Stop-continuation 동작 확인. [결정 로직을 결정자 subagent로 분리(b)하는 건 v0 후 결정 context 오염 증거 시 `context: fork` future refinement — autopilot §3.5.]
