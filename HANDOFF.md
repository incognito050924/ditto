# HANDOFF (원격·cross-PC) — 다른 PC에서 git으로 이어받기 (2026-06-25)

이 문서는 **원격/cross-PC** 핸드오프다(commit → push → 다른 PC pull). 같은 머신의 로컬 새 세션은 이 문서가 아니라 `.ditto/local/`(work-items·memory) + `.ditto/local/handoff/`를 쓴다.

호스트 메모리(`~/.claude` auto-memory의 `[[링크]]`)·work-items(`.ditto/local/`, gitignored)는 **이 문서를 읽는 다른 PC엔 없다** — 본문이 가리키는 로컬 참조는 fresh clone에서 코드·테스트·ADR에서 재유도해야 한다. 코드·테스트·git·커밋된 ADR이 권위(§4-11). **다음 작업 = far-field pre-mortem 재설계(§3).** 그 전에 §2(폐기된 후보)를 다시 살리지 말 것.

## 0. 전파 상태 (먼저 읽기)

- **HEAD `c43ea4d`** (knowledge.json decisions[] 폐기). **origin/main 대비 미푸시 2개** = `c43ea4d`(decisions[]) + 이 핸드오프 커밋. push는 이 repo에서 **배포 경로**라 사용자 지시 대기 중(임의 push 안 함).
- 과거 main force-rewrite(codex 두 커밋 분리 → `codex/dogfood-surface`, origin) 그대로. 기존 clone은 `git fetch && git reset --hard origin/main` 후 `c43ea4d` 재적용 필요(단순 pull 금지).
- 빌드/호출: `bun run build:bin` → **`./bin/ditto`**. 정상 CLI는 `DITTO_SKIP_HOOKS=1` prefix. 커밋 훅=`core.hooksPath=.githooks`(pre-commit: bin 재빌드+자동 스테이징·biome lint·adr-guard·check-test-isolation; post-commit: dist/plugin 재조립). 커밋 전 `bun run lint:fix` 권장.
- 깨끗 clone 첫 `bun test` 전: `bun run surfaces:gen`.

## 1. 이번 세션 landed

- **`c43ea4d` knowledge.json decisions[] 인덱스 폐기 (동작적, wi_2606247cx DONE).** decisions[]는 런타임 orphan(소비자 0 — 투영·memory 수집·`ditto memory query`·ADR-0020 가드레일 전부 `adr/*.md` 또는 이벤트 `adrGist`를 읽음. 유일 소비처 adr-check check 3은 자기참조: 25개 중 6개만 색인된 부분 drift). 변경: `knowledge-record` 스키마 `decisions`/`knowledgeDecision`/`adrStatus`/superRefine 제거 + schema json 재생성, adr-check check 3(+`adrCheckIndexSchema`/`unindexedCount`) 제거(형식·유니크성 2검사만 유지), knowledge.json 데이터·curator/knowledge-update 지침·glossary stale `decisions.md` 참조 제거, **ADR-20260624 amendment**(check 3 조항 철회), `ADR_ID_FULL_RE` 커버리지를 `tests/schemas/adr-id.test.ts`로 이전. 구조화 결정그래프(rationale·supersedes 계보)는 외부 palimpsest(ADR-0021 D5 "결정 계보")가 담는다. 2934 pass/0 fail, adr-check ok, biome clean. dialectic-1 verdict(존치)를 더 근본 조사+사용자 가치판단으로 뒤집어 폐기(INTENT 충돌 §4-10).
- **wi_260624nde DONE** (테스트 격리 가드+reviewer/verifier 렌즈). 코드는 이전 세션 `1cf158b`(v0.2.0 배포됨), 이번 세션엔 WI 레코드만 evidence-gate로 종결.
- **palimpsest 요건 추출 문서** `reports/design/palimpsest-decision-graph-requirements.md` 작성(**untracked, 커밋 제외**) — decisions[] 폐기에서 나온 결정-그래프 요건을 외부 palimpsest 프로젝트로 넘기는 입력. ditto repo엔 안 남기고 palimpsest로 이관 예정.

## 2. 폐기된 follow-ups — **다시 살리지 말 것**

이전 핸드오프가 "부차 follow-up" 후보로 적어둔 둘 다 fresh 검사로 **가치 없음(또는 net-negative)** 확인. 후보 라벨이 오해였다.

- **surface-inventory `length===40` 동적화 = 폐기.** 그 매직넘버는 brittleness 버그가 아니라 **의도된 tripwire**다. `surfaces.json`은 gitignored·`surfaces:gen` 재생성이라, Test B(`:30` scan-match `mismatch_count===0`)는 declared↔scan이 같이 늘어 **인벤토리 증가를 절대 안 알린다**. Test A(`:22` `toBe(40)`)만이 "플러그인 표면(스킬·에이전트·훅=capability/보안 표면) 수가 변했다"를 강제 acknowledge시킨다. → 동적화=자기비교 vacuous, 제거=게이트 상실 net-negative. 진짜 문제(카탈로그 부재 시 false-fail)는 `1929e1a` skipIf로 **이미 해결**됨.
- **check-test-isolation read-의존 정적 검출 = 폐기** (wi_260624nde ac-4에 근거 기록). 실 repo 읽기는 ditto에서 보통 **정당**(self-host) — 테스트 ~21곳이 실 repo/.ditto를 읽고 그중 15+가 정당(build-stamp·agent-variants·agent-projection·repo-self-validation·capability·init-scaffold…). write는 거의 항상 잘못=고신호라 가드가 되지만, read는 정당 다수=저신호 → 켜면 allowlist 15~21로 폭증+새 self-host 테스트마다 마찰. 게다가 "이 읽기가 fragile 의존이냐 정당 self-host냐"는 semantic 판단이라 **이미 reviewer/verifier 렌즈(`agents/reviewer.md:28` "writing to **or reading** the live repo `.ditto/`")가 담당**한다. static grep은 그 판단을 못 한다. 환경의존 false-fail의 실해법은 per-test skipIf(1929e1a 방식)지 가드가 아니다. 메모리 [[test-isolation-guard]]에도 폐기로 명시.

## 3. 다음 작업 — far-field pre-mortem 재설계 (wi_260622vjo, partial)

**사용자가 새 세션에서 설계부터 진행할 작업.** 코드 변경 아님 — 설계 먼저(deep-interview/dialectic). 착수 전 아래 문제를 코드로 fresh 확인(핸드오프 본문은 권위 아님 — §1b 규율).

- **문제(핸드오프·메모리 claim)**: pre-mortem의 far-field(간접 영향 분야) coverage가 ~19-lens sweep을 **무조건 전량 실행** → zero-code/저위험 work item에서도 순수 overhead. bulk 도그푸딩 실험에서 zero-code WI 3건 모두 전량 실행 재확인. 현재 driver가 batched-Opponent 1개로 우회 중(미봉책).
- **방향 힌트**(설계에서 검증·확정): ③ 약함 카테고리 → deep-interview로 이관, ① 강함 카테고리 → 결정적 oracle 검증. lens를 무조건이 아니라 work item 성격(코드 변경 유무·위험)에 따라 게이트.
- **컨텍스트 위치**: wi_260622vjo(이 PC, partial — 직전 increment 다수 done, 잔여=재설계). 설계 메모 `.ditto/specs/premortem-far-field-coverage.md`(untracked·배경용·권위 아님). 메모리 [[premortem-far-field-redesign]](직전 상태), [[coverage-sweep-batched-verification]](bulk 검증 비용절감 패턴). 관련 ADR-0023(pre-mortem coverage 종료 재정의).
- pre-mortem far-field 로직 위치는 grep으로 먼저 찾을 것(`src/core/*premortem*` 글로브는 매치 0이었음 — deep-interview/coverage 쪽일 가능성).

## 4. GOTCHA

- **`schemas:export`는 전체 json 재생성** — 내 스키마 json만 남기고 나머지는 `git checkout HEAD --`로 외과적 복원(이번 세션 실측: knowledge-record 외 12개 무관 재생성됨).
- **커밋 훅 = `.githooks`**: pre-commit이 bin 재빌드+스테이징. 무관 src 변경이 있으면 bin 번들로 새어듦 → 분리 커밋은 `git add <내것>` 후 신중. format 위반 시 `bun run lint:fix`.
- **close-path**: `ditto work done`은 completion final_verdict=pass 요구(evidence gate). placeholder AC면 거부 → 실 AC 잠그고 `ditto verify <wi> --criterion <ac> -- <cmd>`(0종료=pass)로 증거 기록 후 done. `.ditto/local`은 PC 간 전파 안 되니 WI 상태는 같은 PC에서만 의미.
- **parallel WI clobber**: 파일 쓰는 WI를 tree-cleanup WI와 병렬 금지(격리 worktree 또는 순차).
- **dogfood CLI는 `./bin/ditto`**(working-tree). PATH의 설치본은 stale 가능 — src 변경 후 `bun run build:bin`.
