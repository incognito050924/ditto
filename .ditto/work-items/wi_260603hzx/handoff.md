> **⚠️ 대체됨(2026-06-04):** 최신 thread 핸드오프는 `.ditto/work-items/wi_260604ql9/handoff.md`. 새 PC 셋업·남은 일·CodeQL 로컬설치는 거기를 먼저 읽을 것. 아래는 배경 참고용.

# Handoff — ACG 거버넌스 구현 (다른 PC에서 이어받기)

> 이 핸드오프는 repo에 커밋되어 git으로 따라간다(로컬 메모리 `~/.claude/.../project_acg_governance.md`는 이 PC에만 있으니 다른 PC엔 없다). 새 PC에서 `git pull` 후 이 파일부터 읽으면 된다.

## 0. 새 PC 셋업 (먼저)
```bash
git pull                       # main 최신
bun install                    # deps
bun run build && bun link      # ditto CLI를 ~/.bun/bin/ditto로 전역 설치
which ditto                    # → ~/.bun/bin/ditto (macOS면 /usr/bin/ditto와 충돌, ~/.bun/bin이 PATH 앞이어야 이김)
bun test                       # green 확인 (989 pass / 1 skip / 0 fail)
```
- **CLI 호출 주의**: skills/agents 본문은 bare `ditto …`를 부른다 → 위 `bun link` 필수. 개발 중 단발은 `bun run dev <args>`가 항상 최신.
- **ditto 소스 변경 시** 전역 `ditto`는 dist 컴파일본을 가리키므로 `bun run build` 재실행해야 반영.
- pre-commit 게이트는 biome만(tsc 아님). 기존 tsc strict 에러 다수 존재(무관). 커밋은 코드(behavioral)/`.ditto`(chore) 분리, main 직접 push가 관행.

## 1. 한 줄
ACG(Agentic Change Governance) DITTO 바인딩: v0(WU-1~6) + ReviewGraph producer + CodeQL 연결 + Q3/Q4 설계결정(ADR-0004) + fast-follow FF-1~4(impact/fitness/boundary/architecture) + alias 수정까지 **전부 main에 push 완료**. 이제 "결정"이 아니라 4개 CLI 게이트로 **실제 동작**한다.

## 2. 무엇이 됐나 (전부 main push 완료)
- **v0 WU-1~6**: 스키마 9종 + conformance + ICL 컴파일러 + ReviewGraph/JourneyRun 어댑터 + 완료게이트 배선(Stop 훅 `acgReviewForcesContinuation`: acg-review.json의 high+evidence부재면 완료 차단).
- **ReviewGraph producer**: `ditto acg-review --from <reviewer-output.json>` → acg-review.json. reviewer/security-reviewer agent가 호출하도록 배선.
- **CodeQL 연결**: `ditto codeql review` (doctor先행→runner→어셈블러→acg-review.json). 자율 stop-루프 자동실행은 범위 밖(advisory-first 보류).
- **Q3/Q4 결정 = ADR-0004** (`.ditto/knowledge/adr/ADR-0004-q3-q4-architecture-fitness.md`) + 00-framework §9 갱신. 3역 dialectic(verdict=revise), ledger는 `.ditto/work-items/wi_260603f1e/reviews/dialectic-1.json`.
- **fast-follow 4 CLI** (각 deps 주입형 코어 + 실제 분석기 + 테스트):
  - `ditto impact --file <f> --symbol <s>` — 단계3, TS 컴파일러 심볼해석 + default-deny journey.
  - `ditto fitness run --from <ff.json>` — 단계8, mode별 스케줄(risk 미상→escalate fail-closed) + delta_only → AssuranceSnapshot.
  - `ditto boundary check --spec <arch.json> --file <f>` — 단계6, forbidden_dependencies/layers 위반 → acg-review.json에 high-risk 투영(기존 Stop 게이트 재사용).
  - `ditto architecture propose` — Q3 비권위 후보(produced_by=agent, forbidden_dependencies 자동 박제 금지).
- **alias 수정**(이 work item): TsEdgeAnalyzer가 tsconfig `~/*→src/*` 해석 → src-form boundary 규칙이 `~/` import를 잡음(false-clean 수정).

진실원: `reports/design/agentic-governance/v0-implementation-plan.md`, `ADR-0004`. 설계 스펙 00~50은 dialectic-5까지 lock(본문 규칙·스키마 바꾸지 말 것; §9 열린질문 닫기는 허용).

## 3. 남은 일 (우선순위는 사용자 결정 — 아직 미착수)
1. **게이트의 완료게이트 정식 배선**: boundary는 acg-review 재사용으로 됐으나, **impact/fitness 결과를 완료 게이트에 배선**(예: AssuranceSnapshot fail / ImpactGraph 미해소를 Stop이 읽게)은 미배선.
2. **path-alias 잔여**: alias 해석은 boundary/architecture에 적용됐으나 FF-4 architecture가 실 ditto에서 surface 검출하는지 재확인 권장(이번 수정으로 개선됐을 것).
3. **CodeQL을 fitness deterministic provider로**: SARIF findings → normalizeViolationIdentity → fitness runner. 현재 fitness는 command provider만.
4. **executed/llm_judged provider**: 현재 fail-closed skip.
5. **ArchitectureSpec YAML 입력**(현재 JSON만; YAML lib 없음), layers→경로 path-glob 정식화.
6. **CodeQL 자율루프 advisory-first**(계획서 WI-4, 무한루프 위험).
7. **boxwood 2번째 바인딩** — 스펙 저장소독립성 검증(가장 큰 구조적 수확).
8. **PreToolUse forbidden_scope 집행 / Change Map 렌더러** — v0 OUT.

## 4. 코드 위치 (새 PC에서 빠른 오리엔테이션)
- ACG 스키마: `src/schemas/acg-*.ts` (Zod SoT, `bun run schemas:export`로 JSON 생성).
- producer/어댑터: `src/acg/` (review/journey/icl/impact/fitness/boundary/architecture), `src/core/acg-review-store.ts`, `src/core/codeql/`.
- 완료게이트: `src/hooks/stop.ts` (`acgReviewForcesContinuation`).
- CLI: `src/cli/commands/` (acg-review·codeql·impact·fitness·boundary·architecture), 등록은 `src/cli/index.ts`.

## 5. gotcha
- work item id = `wi_` + 8자 이상 영숫자(언더스코어·짧은 이름 금지). `ditto work start`는 멀티워드/특수문자 positional을 잘라먹으니 work-item.json 직접 편집이 안전.
- status=partial work item은 `re_entry`(command 또는 fresh_evidence_needed) 필수 — 빠지면 repo self-validation 테스트 깨짐. `.ditto` 커밋 후 `bun test` 꼭.
- completion.json의 evidenceRef.kind는 command/file/artifact/url/note (ACG의 test/build/log 아님).
- CLAUDE.md의 DITTO Knowledge 블록은 sha-managed projection — 손편집 금지, knowledge.json 고친 뒤 `bun run dev bridge knowledge`로 재생성.
- TS 분석기는 `typescript` devDep의 컴파일러 API(createSourceFile/createProgram/checker) 사용.

## 6. 이 work item(wi_260603hzx) 상태
alias 수정 완료(final_verdict=pass, ac-1~3). 코드 커밋 + 이 핸드오프 커밋 후 push됨. 재개 대상 아님.
