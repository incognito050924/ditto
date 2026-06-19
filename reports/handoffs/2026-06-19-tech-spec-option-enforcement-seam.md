# HANDOFF — tech-spec 질문 옵션 enforcement seam (2026-06-19)

새 세션에서 이어서 구현. 핸드오프는 work item 없이 — 새 세션이 `ditto work start`로 등록 후 진행.

## 1. 무엇을 / 왜 (한 문단)

tech-spec 질문 옵션(강도·생성기수·프리셋·hard-cap·effort·게이트모드)은 **해석·검증·영속까지는 코드로 완성**됐지만(테스트됨), **그 값을 읽어 실제 §6-6 워크플로 동작을 바꾸는 코드 경로가 없다.** 소비는 전적으로 SKILL §6-6 prose(에이전트가 `tech-spec-state.json`의 `question_config`를 직접 읽고 obey). 특히 **hard-cap은 아무 코드도 라운드를 세지 않아** 에이전트가 안 따르면 미적용. 목표: 강제 가능한 부분(개수·임계·cap·gate-mode를 매 라운드 명시 하달 + **cap은 CLI가 카운트 강제**)을 코드로 끌어올린다.

## 2. 확정 사실 (근거)

- `grep question_config src/`(테스트 제외): **쓰기만 존재** — `src/core/tech-spec.ts:307`(start persist), `src/cli/commands/tech-spec.ts:201`(`readQuestionConfigDefaults`는 start에서만 호출), `src/schemas/tech-spec-state.ts`(스키마). **읽어서 동작 바꾸는 코드 0건.** record-round도 config 안 읽고 `--json` payload의 generator_count만 씀.
- 구조적 한계: §6-6 fan-out spawn은 메인 에이전트만 가능(CLI 밖 — autopilot 계약 `reports/design/contracts/autopilot-contract.md:139,151`). **완전 코드 강제는 불가.** 강제 가능한 건 "값 하달 + cap 카운트"까지.

## 3. 제안 설계 (확정 아님 — 새 세션이 다듬기)

라운드 루프를 CLI-매개로: 드라이버가 매 라운드 `ditto tech-spec next-round --work-item <wi>` 호출 →
- `question_config` 읽어 `{generators, threshold, granularity, generator_effort, gate_mode, cap_reached: bool}` 반환.
- 라운드 카운트를 CLI가 추적(round trail = 기존 `tech-spec-rounds.jsonl`, 또는 tech-spec-state에 round counter) → `max_rounds`/누적 selected `max_questions` 도달 시 `cap_reached:true`로 **강제 종료 신호**.
- record-round가 이미 라운드를 영속하므로, next-round가 그 카운트를 읽어 cap 판정하면 자연스러움.
- spawn 자체는 여전히 에이전트 행위(강제 불가) — next-round는 "이번 라운드에 N개 띄우고 threshold 써라 / cap 도달이니 멈춰라"를 *하달*만.
- SKILL §6-6를 "매 라운드 next-round 호출해 그 값을 따르라"로 경화(soft→semi-mechanical).

## 4. 현재 상태 / 산출물

- **커밋(브랜치 `claude/deep-interview-skill-gaps-g5liop`, origin보다 9 ahead — 미푸시)**:
  - `d90e449` feat: 옵션 9개 + 축약 + 프리셋 (resolver `src/core/tech-spec-options.ts`, CLI, `tech-spec-state.question_config`)
  - `3eb815f` feat: 개인 스코프 config 기본값(`.ditto/local/config.json`, `src/core/ditto-config.ts` fail-open 리더, resolver 2-arg)
  - `a61bb9b` docs: doc-cleanup 스펙(무관)
- **dogfood**: `.ditto/local/config.json` = `{tech_spec:{question:{performance:exhaustive}}}` (gitignore·개인, 미커밋). 무인자 start → 100/4/high 확인됨.
- 테스트 기준선: `bun test` **2435 pass / 0 fail / 9 skip**.

## 5. 핵심 파일

- `src/core/tech-spec-options.ts` — 순수 resolver(`resolveQuestionConfig(cliRaw, configRaw?)`, PRESETS, `intensityToSubLevers`, `CURRENT_SELECTION_BAR=0.6`).
- `src/schemas/tech-spec-state.ts` — `question_config` 스키마(여기에 round counter 추가 후보).
- `src/cli/commands/tech-spec.ts` — start verb(여기에 `next-round` 추가).
- `src/core/tech-spec.ts` — `recordRound`/`startTechSpec` 코어.
- `src/schemas/tech-spec-round.ts` — 라운드 record(`dry⟺selected-empty` 불변식 건드리지 말 것).
- `skills/tech-spec/SKILL.md` §"Question generation workflow"(line 67~93) — soft prose, 경화 대상.
- `agents/question-generator.md`, `agents/question-gate.md`.

## 6. 제약 / 주의

- **deep-interview zero-diff 유지**(계약 테스트가 가드).
- per-user config는 `.ditto/local/config.json`(tier ③ gitignore). 우선순위 명시 CLI > config > 빌트인. 모든 기본값 = 현재 동작 보존(생성기 3→2만 의도 변경).
- resolver 순수성 유지(파일 IO 넣지 말 것 — 리더는 별도 `ditto-config.ts`).
- **새 세션이라 ditto:question-generator/question-gate가 이제 로드됨** — wi_260619gr1에서 막혔던 실 에이전트 도그푸딩도 이 세션에선 가능(원하면 enforcement seam 후 실런으로 행동 검증).
- 새 세션이 다른 머신이면 **브랜치 푸시 선행 필요**(현재 9 ahead 미푸시). 같은 머신이면 불필요.

## 7. 다음 세션 첫 행동

1. `git switch claude/deep-interview-skill-gaps-g5liop` 확인, `bun test`로 기준선(2435) 확인.
2. `ditto work start "tech-spec 옵션 enforcement seam ..." --request "enforcement seam 구현"`.
3. §3 설계를 deep-interview/tech-spec로 다듬어 확정(특히 next-round 인터페이스·cap 카운트 위치) → 구현 → 검증.
