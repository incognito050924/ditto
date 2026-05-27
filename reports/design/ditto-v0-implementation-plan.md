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
  - reports/design/contracts/one-shot-orchestration-contract.md   # orchestrator 드라이버 how
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

- **범위 = v0 = Milestone 0~2**(설계서 §12). M0=계약·스키마·fixture, M1=plugin skeleton + UserPromptSubmit/Stop 최소 동작, M2=one-shot orchestration skeleton. post-v0(M3–M6)는 §5에 한 줄 개요만 — 아직 검증 안 된 단계를 상세히 박지 않는다(MVP 공리).
- 각 build unit은 네 항목으로 기술한다: **동작**(control-flow), **대상 계약/스키마**, **acceptance**(검증 기준), **참고**(하네스/자료).
- 본 계획은 DITTO를 짓는 순서지, 사용자 작업을 한 단계씩 끊겠다는 뜻이 아니다(설계서 §12 주석).

## 1. 횡단 구현 결정 (모든 build unit에 적용)

연구로 확정된 사실 + 설계 원칙을 한곳에 모은다. 개별 unit은 이 결정을 전제한다.

| # | 결정 | 근거 |
|---|---|---|
| D1 | **스택 = Bun + TypeScript + Zod + Biome.** 스키마는 `src/schemas/*.ts`(Zod), JSON export는 `zod-to-json-schema`(`scripts/export-schemas.ts`), 테스트는 `bun test`, lint는 biome. | `package.json` 실측. 설계서 §11 원칙 11(TS/JS 통일). 연구 gap #4(러너 미정) 해소. |
| D2 | **3층 분리**(설계서 §11 원칙 10): **schema**(Zod = 바 정의) / **glue**(얇은 결정론 코드 = 라우팅·IO·검증) / **judgment**(skill·agent 프롬프트 = 맥락 판단). 판단을 hook 키워드·임계치로 굳히지 않는다. | HANNES (B)형 누출 반면교사(`hannes.md` §5). |
| D3 | **orchestrator = main agent가 `orchestrate` skill 실행(결정+spawn 인라인) + Stop hook 루프 + 1-레벨 fan-out.** subagent는 subagent를 spawn 못 하므로 spawn 루프는 main에만 살 수 있다 → main이 직접 결정하고 stage subagent를 Task로 spawn, Stop hook이 조기 종료를 막아 루프 유지. **주류 일치**: OMOA Sisyphus=primary, OMC Ralph+persistent Stop, OMX `$ralph`/`$autopilot` 모두 orchestrator=main+Stop hook. 결정 로직을 별도 결정자 subagent로 떼는 분리(HANNES harness 패턴)는 **v0 후 결정 context 오염 증거 시 `context: fork`로 추출하는 future refinement**(one-shot §3.5) — v0엔 과잉. | claude-code-guide(중첩 spawn 불가) + 하네스 4종 조사(주류=orchestrator on main). |
| D4 | **hook fail-open = 기본 — 단 *인프라 오류*에만.** exit 0 = 이의 없음(stdout JSON 파싱), exit 2 = block(stderr=Claude 피드백), 기타 = 비블로킹 오류. hook 시작에 kill-switch(`DITTO_SKIP_HOOKS`) 확인, try/catch로 오류는 로그만. **두 층위 구분(§8-4)**: hook 자체의 크래시/예외만 fail-open(exit 0)이고, 게이트가 정상 실행돼 미충족을 *판정*하면 exit 2(fail-closed). 정책 미정의 게이트(§8-4 safe-default 등)도 fail-closed가 기본 — fail-open은 "코드가 죽었을 때"지 "게이트가 막을 때"가 아니다. | claude-code-guide(exit code 규약) + OMC fail-open(`oh-my-claudecode.md:55,144-146,213`). |
| D5 | **결정론 1차 / LLM 2차.** 게이트(완료·수렴·모호성)는 정규식·상수·산술 검사를 1차로 통과시키고 LLM 자기보고는 2차로 제한. | ouroboros `deterministic_floor`(`ouroboros.md:27-34`), LLM 비용 경고(`ouroboros.md:141`). |
| D6 | **버전 가용성 → doctor.** 일부 hook 이벤트·기능은 최신 Claude Code에만 존재(예: hook `if` 필드 v2.1.85+, fork subagent v2.1.117+). doctor가 런타임에 이벤트 가용성·`claude plugin validate`를 확인하고 미지원이면 graceful degrade. | claude-code-guide(버전 표). |
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

- **동작**: 6개 사이드카 스키마 신설(전부 additive, work-item status 대체 안 함): `intent`(in_scope/out_of_scope/acceptance_criteria/question_policy), `question-gate`(self_answer_attempts/decision), `interview-state`(dimensions[]·readiness·exit, deep-interview 상세 §6.2), `orchestration`(nodes[]·approval_gate·caps·stop_conditions, one-shot 상세 §8.2), `dialectic`(input/producer/opponent/synthesizer 출력, dialectic 상세), `convergence`(버전 점수·decision ledger·정직 라벨, convergence 상세). `schema_version`·`work_item_id`·`evidenceRef` 재사용.
- **대상 계약/스키마**: §6.1/6.2/6.3/6.5/6.6/6.9 + 4개 상세문서. 신규 `src/schemas/{intent,question-gate,interview-state,orchestration,dialectic,convergence}.ts`.
- **acceptance**: `bun test`로 각 스키마 parse/refine 통과. `zod-to-json-schema` export 성공. **3개 정합 flag 해소**(서브에이전트 발견): ① dialectic Opponent severity `critical|major|minor` ↔ `common.ts` severity `info|low|medium|high|critical` 매핑(critical|major→critical|high) ② dialectic Synthesizer verdict `accept|revise|reject|blocked`는 completion verdict와 별도 enum 신설 ③ convergence `kind`(finding|hypothesis|taste)·`status`(acted|deferred|dismissed) 신규 enum.
- **참고**: 4개 계약 상세문서의 §스키마 절. ouroboros provenance 타입(source×status, `ouroboros.md:60-68`)을 interview-state·convergence 라벨에 반영.

### M0.3 — fixture 세트

- **동작**: 게이트가 판정할 입력 fixture를 만든다 — (a) ready/blocked interview-state 각각, (b) vague AC / observable AC, (c) pass/partial/unverified completion, (d) converged/treadmill/early-converge convergence, (e) 예시 work item + dialectic artifact. pass 케이스와 fail 케이스를 쌍으로.
- **대상 계약/스키마**: 위 신규 스키마 전부.
- **acceptance**: `tests/fixtures/` 아래 각 스키마별 valid+invalid fixture. `bun test`에서 valid는 parse 성공, invalid는 실패.
- **참고**: deep-interview 상세 §6.2 예시 JSON, ouroboros 등급 케이스(`ouroboros.md:72-76`).

### M0.4 — 결정론 게이트 + fixture 판정 (verifier가 판정)

- **동작(control-flow)**: 게이트 함수들을 순수 TS로 구현 — `deterministicFloor(ledger)`(열린 필수 섹션·CONFLICTING·assumption 비율 산술 → ambiguity 하한), `acceptanceTestable(ac)`(VAGUE_TERMS 상수 + observable 정규식), `completionGate(completion)`(final_verdict=pass ⇒ 모든 AC pass), `convergenceGate(convergence)`(두 게이트 교집합 + admissibility), `highRiskAssumption(assumption)`(non-local ∨ irreversible ∨ unaudited 중 하나라도 참이면 high-risk → M2.3 approval gate 자동 트리거 신호 반환; 셋 다 거짓이면 safe). 각 게이트는 fixture를 입력받아 PASS/FAIL + 사유 반환. LLM 호출 없음(D5).
- **대상 계약/스키마**: §6.8 Completion, §6.9 Convergence, deep-interview §4.2 게이트.
- **acceptance**: M0.3 fixture에 게이트 적용 → 기대 판정과 일치(`bun test`). "verifier가 fixture를 판정"(설계서 §12 M0 완료기준) = 이 게이트 테스트가 그린.
- **참고**: ouroboros `deterministic_floor`·등급 게이트·검증가능성 기계 판정(`ouroboros.md:27-34,72-81,116`) — 정규식·상수 거의 그대로 차용. high-risk assumption 차단(`ouroboros.md:78`).

---

## 3. Milestone 1 — Claude Code plugin skeleton

목표: `claude --plugin-dir`로 실제 로드되는 플러그인 + UserPromptSubmit/Stop 최소 동작.

### M1.1 — plugin.json + 레이아웃 + doctor

- **동작**: `.claude-plugin/plugin.json`(name=`ditto`, description, version) 작성. 루트에 `hooks/`·`skills/`·`agents/`·`commands/`. doctor 커맨드가 hook 이벤트 가용성·`claude plugin validate`·plugin root 스캔을 런타임 확인(D6).
- **대상 계약/스키마**: 설계서 §7.1 layout. `surface-catalog.ts`(이미 존재 — inventory 타입).
- **acceptance**: `claude --plugin-dir ./` 로드 성공, `claude plugin validate` 통과. skill/command가 `/ditto:<name>`으로 노출.
- **참고**: claude-code-guide(plugin.json 필드·`--plugin-dir`·validate·네임스페이싱).

### M1.2 — hooks.json manifest + fail-open glue

- **동작**: `hooks/hooks.json`에 UserPromptSubmit·Stop·PreCompact·PostToolUse 등록(matcher). **등록 ≠ 실동작**: v0에서 *실동작*은 UserPromptSubmit(M1.3)·Stop(M1.4) 둘뿐이고, PreCompact·PostToolUse는 **manifest 등록 + no-op stub**만(exit 0 즉시 반환) — 실로직은 post-v0(PostToolUse=M3 evidence 수집, PreCompact=M4 handoff; D8). stub을 v0에 두는 이유는 manifest 표면을 고정해 M3/M4가 등록 변경 없이 본문만 채우게 하기 위함. 각 hook은 `.mjs`로 plugin-root 경유 실행(D7). 공통 wrapper: kill-switch 확인 → try/catch → 오류 시 로그만 + exit 0(D4).
- **대상 계약/스키마**: 설계서 §7.2 hook 표(v0 표면 4개).
- **acceptance**: hook 오류 주입 시 세션 안 깨짐(fail-open) 테스트. hook이 `$CLAUDE_PROJECT_DIR`로 `.ditto/` 접근.
- **참고**: claude-code-guide(hooks.json·exit code) + OMC fail-open·Node hook(`oh-my-claudecode.md:55,136-146`).

### M1.3 — UserPromptSubmit hook 최소 동작

- **동작(control-flow)**: 프롬프트 제출 → hook이 (1) active work item 로드 or 생성(glue), (2) 입력을 분류(실행 의도/질문/deep-interview 필요성 — **advisory, 키워드 표 아님**: 판단은 skill로 위임, hook은 신호만), (3) `additionalContext`로 **charter projection(prime directive + 활성 규칙)** + active work item·pending handoff 요약 주입(D8). block 안 함(advisory).
- **대상 계약/스키마**: §6.1 Intent, §6.2 QuestionGate(advisory 진입). `work-item.ts`, 신규 `intent.ts`.
- **acceptance**: 빈 상태에서 work item 생성됨. 기존 work item 있으면 context 주입됨. 분류는 로그로 남고 차단 없음.
- **참고**: claude-code-guide(UserPromptSubmit `additionalContext`). OMC keyword-detector sanitizer·help/reference 억제(`oh-my-claudecode.md:152-154`) — **단 자동 실행 spawn 금지**(`:148-149`), 분류는 advisory로만(D2).

### M1.4 — Stop hook 최소 동작 (완료/수렴 게이트)

- **동작(control-flow)**: Claude 응답 완료 → Stop hook이 (1) `stop_hook_active==true`면 즉시 exit 0(8회 무한루프 가드), (2) active work item의 `completion.json`/`convergence.json` 읽어 M0.4 게이트 적용, (3) 미충족(예: final_verdict=pass인데 unverified AC 존재, 또는 admissible 열린 반론 존재)이면 **exit 2 + stderr에 "무엇이 남았는지"** → Claude 계속 강제, (4) 예외 목록(context-limit·explicit cancel·user abort·rate limit·auth error)은 즉시 통과.
- **대상 계약/스키마**: §6.8 Completion, §6.9 Convergence. `completion-contract.ts`, 신규 `convergence.ts`.
- **acceptance**: 미검증 완료 fixture → Stop이 continue 강제(exit 2). 완료 fixture → 통과(exit 0). 예외 사유 → 즉시 통과. `stop_hook_active` 가드 동작.
- **참고**: claude-code-guide(Stop exit 2 = 계속, `stop_hook_active` 최대 8회). OMC persistent-mode 예외 목록(`oh-my-claudecode.md:160-162,236-238`) — **예외 목록을 먼저 설계**. 단일 primary authority(`:164-166`)로 시작.

### M1.5 — skill skeleton 4종 + alias

- **동작**: `skills/{deep-interview,verify,handoff,dialectic}/SKILL.md` + `dialectic-review`(= `/ditto:dialectic --mode review` alias). frontmatter(name/description/argument-hint) + 본문은 절차·출력 계약. command wrapper는 thin shim(본문 on-demand 로드 = progressive disclosure). `/ditto:plan`은 비노출(orchestration 내부 호출).
- **대상 계약/스키마**: 설계서 §7.3 skill 표. deep-interview·dialectic 상세문서가 본문 근거.
- **acceptance**: 각 skill이 `/ditto:<name>`으로 호출됨. dialectic-review가 dialectic --mode review로 라우팅.
- **참고**: claude-code-guide(SKILL.md frontmatter·네임스페이싱). OMC progressive disclosure·thin shim(`oh-my-claudecode.md:67-68,180-182`), deepagents(`deepagents.md:76-77`). interview 프롬프트 계약은 ouroboros socratic-interviewer(`ouroboros.md:84-93`).

### M1.6 — surface inventory 테스트

- **동작**: plugin root(`skills/`·`commands/`·`agents/`·`hooks/hooks.json`·`.claude-plugin/plugin.json`)를 스캔해 실제 파일 ↔ 문서 인벤토리 일치를 CI로 검증. 현 어댑터가 repo `.claude/`·home `~/.claude/`만 보면 plugin root 스캔 추가.
- **대상 계약/스키마**: `surface-catalog.ts`(기존).
- **acceptance**: `bun test`에서 인벤토리 drift 감지. 누락/잉여 surface 시 fail.
- **참고**: OMC 문서 drift(skill count 31/38/39 불일치, `oh-my-claudecode.md:201`) 반면교사 — inventory를 코드 생성 + CI 비교(`:219,223-226`).

---

## 4. Milestone 2 — one-shot orchestration skeleton

목표: 승인 통과한 단일 요청에서 plan→implement→verify가 사용자 개입 없이 이어진다.

### M2.1 — orchestration.json 스키마 + OrchestrationStore (glue)

- **동작**: `orchestration.json` Zod 스키마(nodes[]·approval_gate·caps·continue_policy·stop_conditions, one-shot §8.2) + `OrchestrationStore`(읽기/노드 상태 갱신 — 그래프 mutation의 유일 경로, glue). `orchestration-decisions.jsonl` append-only 결정 로그.
- **대상 계약/스키마**: §6.5, one-shot 상세 §8. 신규 `orchestration.ts`.
- **acceptance**: store를 통해서만 노드 상태 변경. 직접 파일 덮어쓰기 차단(인터페이스로). fixture graph parse 통과.
- **참고**: one-shot 상세 §8.2(nodes canonical), 설계서 §11 OrchestrationStore.

### M2.2 — orchestrate skill (main agent 구동) + ReAct 루프

- **동작(control-flow)**: main agent가 `orchestrate` skill을 따라 ReAct 루프 구동(D3 — 전용 subagent 아님). `LOOP`: (1) `orchestration.json` re-read(컨텍스트 누적 최소화), (2) ready 노드 선택(pending ∧ depends_on passed), (3) kind→owner 매핑 + 6-section packet 구성(Context Isolation §3.3), (4) owner stage subagent를 Task로 직접 spawn(1-레벨), (5) evidence 수집·노드 상태 갱신(OrchestrationStore 경유), (6) 실패면 §4 분류 → retry/switch/escalate, (7) stop_conditions 평가. 루프 지속은 **Stop hook**이 조기 종료를 막아 보장(M1.4). orchestrate skill은 content 생성 안 함 — stage subagent에 위임.
- **대상 계약/스키마**: one-shot §2.2(kind→owner)·§3.2(루프)·§3.4(호스팅=main role). `skills/orchestrate/SKILL.md`(신규).
- **acceptance**: fixture graph에서 ready 노드 선택→spawn→상태 갱신→다음 노드 루프 동작. 내부 checkpoint만으로 final answer 안 나감. orchestrate skill이 content 직접 생성 안 함(위임).
- **참고**: 주류 일치 — Sisyphus primary orchestrator(`oh-my-openagent.md:130`), OMC Ralph + persistent Stop(`oh-my-claudecode.md:25,160-166`), HANNES Autopilot Loop(`hannes.md` §1). 결정 격리 필요 시 (b) 추출은 one-shot §3.5.

### M2.3 — plan approval gate

- **동작(control-flow)**: 큰 mutation 노드 진입 전 approval_gate 확인 — "큰"의 판정은 `highRiskAssumption`(M0.4)의 3축으로 닫는다: **non-local**(repo-wide·외부 호출), **irreversible**(migration·삭제·배포), **unaudited**(보안 경계·미검증 가정) 중 하나라도 참이면 gate 자동 트리거. `pending`이면 draft work item + plan artifact만 남기고 mutation 중단, 사용자에게 plan 제시. `approved`/`not_required` 후엔 checkpoint마다 재승인 안 함.
- **대상 계약/스키마**: §5.4, one-shot 상세 §5.
- **acceptance**: pending gate에서 mutation 노드 미실행. 승인 후 무중단 진행.
- **참고**: superpowers brainstorming 승인 게이트(`superpowers.md:23,53`), GSD plan-checker read-only 검증(`get-shit-done.md:46,83,139`).

### M2.4 — 노드 dispatch + 실패 분류

- **동작(control-flow)**: dispatch = 6-section packet(TASK/EXPECTED OUTCOME/REQUIRED TOOLS/MUST DO/MUST NOT DO/CONTEXT) + post-delegation verification. 노드 failed 시 분류 → `{failure_class: fixable|wrong_approach|blocked_external|user_decision_needed, decision: retry|switch_approach|escalate|continue}`. retry/switch는 자동(cap 내), escalate/user-decision만 사용자(§6.2). cap 도달 = non-pass(≠converged).
- **대상 계약/스키마**: one-shot 상세 §3.2·§4. `orchestration-decisions.jsonl`.
- **acceptance**: fixable fixture → retry, wrong_approach → switch, cap 초과 → non-pass+handoff. 결정이 로그에 기록.
- **참고**: Sisyphus/Atlas 6-section(`oh-my-openagent.md:131,155`), HANNES failure_classification(`hannes.md` §1), GSD post-wave 실패 게이트(`get-shit-done.md:84`).

### M2.5 — checkpoint 자동 continuation + handoff

- **동작(control-flow)**: 노드 passed → 다음 ready 노드로 자동 진행(개입 없음). 내부 checkpoint 완료를 final answer로 보내지 않음. context pressure 시 `/handoff`로 같은 orchestration_id 유지하며 이어받음(scope 축소 아님). stateless 노드(단일 결과 반환, 부모 상태 누수 방지).
- **대상 계약/스키마**: §5.2/§6.10, one-shot 상세 §6.
- **acceptance**: plan→implement→verify가 개입 없이 연결. 내부 checkpoint만으로 final answer 안 나감. handoff 후 재진입 가능.
- **참고**: stateless subagent(`deepagents.md:64-66`), handoff 구조(`oh-my-openagent.md:100,247`, `oh-my-claudecode.md:354-358`), GSD resume gate(`get-shit-done.md:84`).

---

## 5. post-v0 개요 (M3–M6 — 상세는 해당 milestone에서)

- **M3 Evidence·verifier 런타임**: PostToolUse evidence 수집, verifier output contract, completion.json 생성, convergence gate 런타임(admissibility·ratchet·decision ledger). v0의 계약/스키마/게이트(M0)에 *런타임 살*을 붙임.
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
| plan-verify·approval gate·wave/overlap | `get-shit-done.md`, `superpowers.md` | GSD wave gate는 다중 노드 전제(one-shot 단일 노드면 과함) |
| stateless subagent·context offloading | `deepagents.md` | 부모 상태 누수 방지 제외 키 |
| failure classification·Autopilot·Context Isolation | `hannes.md`(HANNES harness) | 전신 하네스 — 가장 가까운 선행 구현 |

## 7. 빌드 순서·의존

`[§8-N]`는 그 노드 진입 전 닫아야 하는 선결 결정(§8의 미해결 항목을 빌드 엣지로 승격).

```text
                              ┌─[§8-2 락 전략]
M0.1 → M0.2 ─────────────────┘ → M0.3 → M0.4   (스키마·fixture·게이트가 먼저; 코드 없이 검증 가능)
  └─ M0.4(게이트) 가 M1.4 Stop hook의 호출 대상
                                      ┌─[§8-6 turn 경계]
M1.1 → M1.2 → {M1.3, M1.4 ───────────┘, M1.5} → M1.6   (plugin 골격 → hook glue → 동작 → inventory)
       ┌─[§8-2 락]   ┌─[§8-6 turn 경계]   ┌─[§8-1 승인 채널]      ┌─[§8-3 재진입 경계]
M2.1 ──┘ → M2.2 ─────┘ → {M2.3 ──────────┘, M2.4} → M2.5 ────────┘   (store → 드라이버 → gate·dispatch → continuation)
```

- M0이 M1·M2의 토대(스키마·게이트). M1 Stop hook(M1.4)은 M0.4 게이트를 호출한다.
- M2 orchestrator(M2.2)는 M1 plugin·skill·subagent 골격 위에서 돈다.
- **선결 게이트**: 그래프의 `[§8-N]` 엣지가 통과하지 않으면 해당 노드 착수 금지 — 이게 계획/실행 불일치를 막는 메커니즘. §8 본문이 처리 시점을 글로 적었다면, 위 그래프는 그것을 *엣지*로 고정한다. (단, §8-4·§8-5는 특정 노드의 선결이 아니라 *구현 중 교차검증* 항목 → 그래프 밖, §8 하단 별도 분류.)
- 설계서 §15 "다음 구현 후보" 6개 = M0.2~M0.4 + M1.1~M1.5의 첫 슬라이스에 대응.

## 8. 미해결 / 추가 조사 필요

연구가 다 못 닫은 지점. 두 부류로 나뉜다 — **(A) 노드 선결**(특정 노드 진입 전 닫아야 함 → §7 빌드 그래프에 `[§8-N]` 엣지로 승격: 항목 1·2·3·6) / **(B) 구현 중 교차검증**(특정 노드의 선결이 아니라 구현하며 검증·정책화: 항목 4·5).

1. **plan approval gate의 사용자 승인 채널** — hook/skill이 사용자 입력을 블로킹 대기하는 정확한 메커니즘(PreToolUse 권한 프롬프트 활용 여부). M2.3 착수 전 Claude Code 확인.
2. **상태 파일 동시성/락** — `orchestration.json`·`interview-state.json`의 단일 writer 강제·crash recovery. M2.1·M0.2에서 락 전략 결정(GSD 단일 writer 언급은 디테일 없음).
3. **one-shot continuation 재진입 경계** — 같은 세션 내인지 새 세션(handoff 재로드)인지, 상태 복원 절차. M2.5 설계 시 확정.
4. **safe-default 정책 미명세** — ouroboros `finalize_safe_defaultable_gaps`가 "local·reversible·audited" 정책에 의존하나 미정의. 차용 전 정책 명시, 그 전엔 fail-closed.
5. **이중 게이트 단일 출처 리스크** — convergence 핵심(backend∧ledger·deterministic_floor)이 ouroboros 단독 출처. M0.4 구현 시 교차 검증 권장.
6. **오케스트레이션 루프의 turn 경계** — main이 노드 사이를 한 응답 안에서 이어가는지 vs Stop hook continuation으로 재진입하는지(주류 OMC는 Stop hook continuation). M1.4/M2.2 착수 전 Claude Code Stop-continuation 동작 확인. [결정 로직을 결정자 subagent로 분리(b)하는 건 v0 후 결정 context 오염 증거 시 `context: fork` future refinement — one-shot §3.5.]
