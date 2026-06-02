# Goal: ditto 자기평가 보고서 잔여 항목 일괄 처리

> 새 Claude Code 세션에 아래 본문을 그대로 붙여넣어 goal로 사용한다.
> Source of truth: `reports/ditto-vs-claude-code-evaluation-2026-06-02.md` (§4 회귀목록, §5 우선순위 표).
> 이미 닫힌 항목: §5 #1~#6 (커밋 완료). 이 goal은 **잔여만** 다룬다. 각 항목은 보고서에 file:line 근거가 있다 — 라인은 변했을 수 있으니 grep으로 현재 위치를 재확인하고 진행할 것.

---

## 0. 운영 원칙 (이 goal 전체에 적용)
- **charter 준수**(`CLAUDE.md`): 의도 보존·외과적 변경·증거 기반 완료. 모호하면 조용히 가정하지 말고 표면화.
- **항목 = 작업 단위**: A1~A4 각각을 독립 work item + completion contract로 다룬다. 한 세션에서 순차 진행하되 항목 간 스코프를 섞지 않는다. 의도를 조용히 축소/확대 금지.
- **Tidy First**: 구조적 변경과 동작적 변경을 **별도 커밋**, 구조적 먼저. 커밋 메시지에 `(구조적)`/`(동작적)` 라벨 + 보고서 항목 번호(예: `§5 #7`).
- **TDD**: 실패 테스트(red) → 최소 구현(green) → 리팩터. 매 항목 후 `DITTO_SKIP_HOOKS=1 bun test`(기준 703 pass·0 fail)·`bun run lint`·관련 시 `bun build --compile` 그린 확인. 훅이 정상 명령을 막으면 `DITTO_SKIP_HOOKS=1` prefix.
- **schema는 source of truth**(ADR-0002): schema 변경이 필요하면 zod 먼저, 그다음 소비처.
- **커밋 제외**: 사용자 병행 CodeQL 작업 파일은 절대 `git add` 금지 — `.gitignore`, `bun.lockb`, `reports/harnesses/codeql-research-ko.md`, 미추적 `.ditto/reports/`. `git add`는 변경 파일을 **명시적 경로로** 지정(`git add -A` 금지).
- **보고서 갱신**: 항목 완료 시 §4/§5 해당 행을 해소 표시(취소선 + 날짜 + 한 줄 근거)로 갱신.

## 1. 착수 전 사용자 결정 (제품 표면/가치 — 에이전트 단독 결정 금지)
세션 시작 시 아래 3건을 `AskUserQuestion` 한 번으로 먼저 확인하고, 답에 따라 해당 항목을 진행하거나 명시적으로 보류한다. (이전 #6도 wire-vs-delete를 사용자에게 확인했음 — 같은 기준.)

- **D1 (§5 #9 잔여)** — `skills/plan/SKILL.md`·`skills/dialectic-review/SKILL.md`를 **삭제**할지 **유지**할지. plan은 `bootstrapAutopilot`이 실제 그래프를 만들고, dialectic-review는 `--mode review` 얇은 alias다. 사용자에게 보이는 명령(surface) 제거라 가치 판단.
- **D2 (§4 #10)** — charter advisory 주입(행동 헌장 텍스트의 영구 주입)을 "G1/G2가 CC 네이티브와 중복 + 강제력 0 + 토큰 비용" 이유로 **축소/제거**할지. 프로젝트 정체성 변경이라 신중.
- **D3 (§4 #9)** — session pointer 부재 시 게이트·증거·handoff가 통째 no-op(fail-open)되고 표면화 안 되는 동작을 **경고/exit로 표면화**할지, 현행 유지할지.

## 2. 자율 진행 항목 (결정 불필요 · 증거로 완료)
난이도 낮음 → 높음 순.

### A1 — §5 #7 빈 autopilot.json 종료 게이트 우회 (난이도 낮음)
- 근거: `src/hooks/stop.ts` — approval pending yield(`approval_gate.status === 'pending'` 부근, 보고서 :129/:179), NON_TERMINAL strong-block은 ledger 전부 absent일 때만 발동(:208~218).
- 문제: 빈/pending autopilot.json 하나로 verify 없이 exit 0 가능.
- 수정 방향(보고서): approval=pending yield에 **'mutating 노드 실재 ∧ root_goal 미충족'** 조건을 추가. 단 `pending = 사용자 승인 대기`는 의도된 yield일 수 있으니(우회 ≠ 정당한 yield) 둘을 구분.
- done_when: 미충족 root_goal + 빈 노드로 stop 시 **차단(exit 2)**되는 테스트 red→green; 정당한 pending(승인 대기) yield는 여전히 통과.

### A2 — §5 #8 dialectic verbatim-echo (난이도 중간)
- 근거: `src/hooks/stop.ts` `dialecticForcesContinuation`(:25~43) — objection 해소를 `claim` 문자열 **verbatim**으로 매칭(:31~32).
- 문제: synthesizer가 paraphrase하면 미해결로 읽혀 false-continuation.
- 수정 방향: objection에 **안정 id** 부여, synthesizer가 id로 해소 매칭(paraphrase 허용). `src/schemas/dialectic.ts` 변경 동반 → zod 먼저.
- done_when: paraphrase된 해소가 id 매칭으로 통과하는 테스트 추가 + 기존 verbatim 동작 회귀 테스트 유지.

### A3 — §4 #11 자기선언 boolean 검증가능화 (난이도 중간)
- 근거: `RiskAxes.non_local`, `reviewer-output.ts:47 different_provider_than_generator`, `language-ledger.ts:17 agreed_with_user`, `convergence.ts:41 admissible` — schema가 boolean만 받아 근거 검증 불가.
- 수정 방향: 각 boolean에 **검증 가능한 근거**(evidence_ref/rationale 등)를 동반시키거나 산출 시점에 결정론 도출. 단일 사용 추상화·과설계 금지, 최소 변경.
- done_when: 각 boolean이 빈 근거로 `true`일 때 거부되는 schema 테스트(superRefine) red→green.

### A4 — §5 #10 owner skeleton 본문 (난이도 중간~높음, 대규모)
- 근거: `agents/implementer.md`·`planner.md`·`researcher.md`가 'v0 skeleton' 수준(reviewer/verifier 대비 미완).
- 수정 방향: reviewer/verifier 수준으로 본문 작성(역할·입출력·MUST/MUST NOT·증거 규칙). 대규모이므로 owner별로 분리 진행(각각 work item).
- done_when: 세 agent 정의가 reviewer/verifier와 동등한 구조를 갖추고, autopilot dispatch 스모크(packet → spawn)가 통과.

## 3. 이 goal 전체 완료 기준
- 자율 항목 A1·A2·A3·A4 전부 fresh evidence로 닫힘(테스트/빌드/diff).
- 결정 항목 D1~D3는 사용자 답변에 따라 처리 또는 명시적 보류(보류 시 보고서에 사유 기록).
- 최종: `bun test`·`bun run lint`·`bun build --compile` 전부 그린, 보고서 §4/§5 backlog 갱신, 각 항목 별도 커밋(구조적/동작적 분리, CodeQL 파일 제외).
- 미완 항목이 있으면 최종 응답에 명시(계획 조용히 축소 금지).
