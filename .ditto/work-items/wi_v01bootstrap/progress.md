# Progress: wi_v01bootstrap

## 현재 상태
`done` — 4개 acceptance 모두 pass. 코드 동작과 검증 명령 결과로 확인.

## 진행 로그
- 11:30 plan에서 다음 작업 "schemas 위치 결정 + work item/run/completion/self-check/reviewer/language contract fixture"가 v0.1 진입 조건임을 확인.
- 11:35 구현 언어 결정: TypeScript + Bun + citty + Biome + zod + bun:test + 단일 패키지. 근거는 [[ADR-0001-runtime-stack]].
- 11:50 `package.json`, `tsconfig.json`, `biome.json`, `.gitignore` 설치. `bun install` 성공.
- 12:00 zod schema 6개 작성 (`src/schemas/`). cross-field 룰은 `superRefine`으로 표현.
- 12:10 `scripts/export-schemas.ts`로 JSONSchema 6개 export 확인. 근거는 [[ADR-0002-schema-source-of-truth]].
- 12:15 password-strength golden fixture 작성. work-item/run/completion/review/glossary/language-ledger 모두 포함.
- 12:20 `tests/schemas/fixture-validation.test.ts` 작성. 6개 부합 테스트 + 5개 reject 테스트. 11 pass.
- 12:25 citty 기반 CLI 5개 명령 골격 작성. `--help`, `--output`, exit 64 동작 확인.
- 12:30 Biome auto-fix로 포맷 통일. tsc/biome/bun test 모두 통과.

## 누락된 절차 회고
- plan-check 없이 execute로 직행. 사용자가 "계획 문서 없냐"고 지적해 이를 회고하고 wi_v01implement부터 사전 plan/dod/rollback/context-packet을 두기로 합의.
- 그래서 본 work item 자체도 *회고형 기록*으로 만들어진다.

## 다음 fresh evidence
없음. 본 work item은 done 상태로 마감. 다음 작업은 [[wi_v01implement]].

## 후행 review 반영 (2026-05-24 13:10)
사용자 review에서 4개 finding 제기.
- Finding 2: completion contract에 `unverified[].out_of_scope` 필드 추가, final_verdict=pass는 in-scope unverified 0건 강제. 본 work item의 unverified 2건은 의도된 범위 밖이므로 out_of_scope=true로 표시해 schema 통과.
- Finding 3: work item schema에 `status in {partial, unverified, blocked}` 시 `re_entry.command` 또는 `re_entry.fresh_evidence_needed` 강제 superRefine 추가.
- Finding 4: 본 work item의 work-item.json/completion.json에 lint 16 files, bun test 24 pass(fixture 16 + self-validation 5 + source repo identity 3)로 fresh evidence 갱신. source repo identity describe는 Finding 1 처리 과정에서 추가되어 합계가 21→24로 늘었다.
- Finding 1: 후속 task #12에서 self-validation 테스트의 REPO_ROOT를 env로 받게 변경하고 dod.md를 그에 맞게 수정.
