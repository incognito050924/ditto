# HANDOFF — memory 라운드2 이슈 전체 처리 완료 (2026-06-10, wi_260610u8t)

이전 핸드오프(리뷰 후속 8건 검증)는 완료되어 대체됨. 현 상태 요약과 남은 것만 남긴다.

## 끝난 것 (전부 커밋·푸시됨, `2a408b1..` → origin/main)

`reports/reviews/memory-subsystem-review-round2.md`의 발견 전체를 wi_260610u8t로 처리. AC 10/10 pass(증거는 `ditto work status wi_260610u8t` + `.ditto/local/work-items/wi_260610u8t/`).

- **라운드1 후속 8건**(F1~F7+hook): 독립 검증(7 pass + F6 partial) 후 커밋(`67c357a`).
- **R1**: 본문검색(`query --text`/fallback)이 approved head + non-secret만 노출 — pending/rejected/secret 누출 차단(`e7f2253`).
- **R3**: supersede 효력을 승인 확정(effective) 이벤트로 한정 — pending 정정이 approved 사실을 철회 불가. 체인>2·사이클 테스트 포함(F9 일부 종결, `c55990f`).
- **R4**: hook 호스트메모리 허용을 현재 프로젝트 `<project>/memory/` 서브트리로 축소 — 교차 프로젝트 차단(`c91d7f4`). 런타임 A/B 실증 완료.
- **R7/R9/ac-10**: build chunk sensitivity 배선+rescan 보존, status `pending_count`, warm-start `hit_node_types` 분해, off-scope 테스트(`e8e91c6`).
- **R10/Tidy**: NUL 리터럴 제거, searchEventBodies를 query 모듈로 이동(`6e0f2cb`).
- **R5**: 빌드 drift 가드 — 빌더가 src sha256 스탬프 임베드, `ditto doctor distribution`의 `binary_fresh`가 비교(Hooks 축). stale 상태에서 DRIFT 검출 실증(`2ae49f5`).
- **문서**: ADR-0013 보강(위협모델·bootstrap 신뢰모델·잔여위험·측정 보류) + 설계서 §3-5 호스트 경계·§4-5 가시성 규칙(`6ac6e3d`). F8 glossary 5용어(`f960121`).
- **배포 반영**: push → `claude plugin marketplace update ditto-local` → uninstall→install. 설치본 스탬프 = repo 스탬프 일치 확인. **marketplace 소스가 GitHub라 push 없이는 반영 안 됨 + marketplace update 생략 시 stale 클론에서 옛 코드가 재설치됨(실측)** — 절차는 호스트 메모리 `ditto-global-plugin-refresh` 노트 갱신됨.

## 남은 것 (의도된 보류, ADR-0013 보강·재검토 조건에 기록)

1. **승인 게이트 적대적 차단** — 현 게이트는 honor-system(`--actor` 자기신고). §5-2~5-5 push 확대 work item을 열기 **전에** 승인 호출 경로 분리(예: hook이 agent 세션의 `memory approve` 게이트)를 선행 처리.
2. **bootstrap handoff-archive 신뢰 등급** — 세탁 경로(repo 쓰기+bootstrap)가 실측되면 분리.
3. **pull actionability 측정** — 미측정 명시 보류. hit율만으로 게이트가 흔들리면 먼저 확장.

## 주의 (이 작업 무관)

- **다른 세션의 미커밋 변경이 작업트리에 있음**: `scripts/build-plugin.mjs`(resources 배포 추가), `resources/managed/GLOBAL_{AGENTS,CLAUDE}.md`, `agentic-coding-masters-research.md` — 전역 컨텍스트 작업(별도 work item) 소속. 건드리지 말 것.
- `bun test` 전체의 **기지 1 fail** = `tests/schemas/repo-self-validation.test.ts`의 `wi_v01bootstrap and wi_v01implement exist` — 로컬 상태 결합 테스트 설계 결함(라운드1 리뷰 별도 항목, 미처리). 이것만 fail이면 정상.
- bun 1.3.14+ 필요(1.0.2는 메모리 테스트 가짜 실패).
