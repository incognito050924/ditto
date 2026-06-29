# ADR-20260630-recipe-backlog-seed-model: recipe.backlog → 개인 github config bootstrap-once seed — ADR-20260628 정합 + out-of-scope

- 상태: accepted
- 결정 일자: 2026-06-30
- 결정자: hskim, claude (claude-opus-4-8)
- 관련: wi_260629vnt (ac-5). 코드(권위): `src/core/ditto-config.ts:158-192`(`seedGithubConfigIfAbsent`), `src/cli/commands/setup.ts`(`runRecipeSetup` 주입 dep seed + `RecipeSetupSummary.githubSeed` disclosure), `src/schemas/ditto-config.ts:54-75`(`dittoConfigGithub` 재사용). 정합: **ADR-20260628-github-backlog-sot**(D3 SoT 3층·D4 좌표 일원화), ADR-0012(3-tier 격리), ADR-0018(우아한 강등), ADR-0002(schema SoT). **supersede 없음** — ADR-20260628을 *보완(clarify)*하는 신규 setup-time seam(ADR-20260626-worktree-subrepo-scope-clarify 와 동일 패턴).

## 컨텍스트

ADR-20260628은 GitHub 연계의 SoT 층(보드=백로그 read·완료=ditto write)과 repo 좌표 일원화를 못박았지만, 팀이 공유하는 백로그 좌표(어느 Project 보드인가)를 개별 개발자 머신에 *어떻게 처음 깔아주는가*는 다루지 않았다. 개발자마다 `ditto github setup` 마법사를 손으로 돌리게 두면 팀 합의 좌표가 흩어진다. recipe(tier② 팀 공유 설정)에 백로그 좌표를 한 번 적어두고, 개발자의 개인 config(tier③ `.ditto/local/config.json`)에 setup 시점에 자동으로 seed하는 경로가 필요했다.

핵심 긴장: seed는 **팀 소스(recipe)를 개인 구획에 기록**하는 행위인데, (1) 이미 개인 설정을 손본 개발자의 값을 덮으면 안 되고, (2) seed 쓰기가 같은 파일의 형제 블록(`tech_spec`·`deep_interview`)을 파괴하면 안 되며, (3) seed 실패가 setup 전체를 막으면 안 된다.

## 결정

**recipe.backlog → 개인 github config의 bootstrap-once seed**를 `ditto setup` 경로에 둔다. seed 모델은 4개 불변식으로 정의된다(전부 코드 결박, 출처 `src/core/ditto-config.ts:158-192`):

- **bootstrap-once** — github 블록이 *증명 가능하게* 부재할 때만 채운다. 한 번 존재하면 다시 seed하지 않는다.
- **개인 우선(personal-wins)** — 개인 config에 github 블록이 이미 있으면(case c) 절대 덮지 않는다. recipe가 개인 설정을 override하지 않는다.
- **형제 보존(sibling-preserving)** — `writeGithubConfig`가 기존 `tech_spec`·`deep_interview` 블록을 보존하며 github만 합성한다. 그래서 seed 술어는 `readGithubConfig()===undefined`를 **쓰지 않는다**: 그 reader는 부재와 malformed를 혼동해, malformed 파일에 seed를 흘려보내면 형제 블록을 지운다.
- **malformed fail-closed** — 파일이 깨졌거나(JSON/스키마) 검증 실패면(case d) seed하지 않고 `onMalformed`로 경고만 한다. 증명 가능하게 유효한 파일만 write를 통과한다.

3-상태 술어(raw 파일 1회 파싱):
- (a) config.json 부재 → seed (reason 'absent')
- (b) 파일 있음 + parse·schema valid + github 필드 없음 → seed (reason 'absent')
- (c) 파일 있음 + github 필드 존재 → keep (reason 'existing', 개인 우선)
- (d) 파일 있음 + malformed/schema-invalid → no seed, fail-closed (reason 'malformed' + warn)

`runRecipeSetup`(setup.ts): recipe.backlog가 있으면 `deps.setup(host)` 뒤에 주입 dep로 seed를 돌리고, try/catch로 우아하게 강등하며, `RecipeSetupSummary.githubSeed`로 결과를 disclosure한다.

## 근거 (rationale)

- **D3 정합(SoT 방향 불변).** seed는 개인 config에 백로그 *좌표 블록을 기록*만 한다. 보드=read·완료=ditto write라는 방향성은 그대로다 — seed가 추가하는 것은 "어느 보드를 읽을지"의 주소일 뿐, read/write 권위를 바꾸지 않는다.
- **D4 정합(좌표 일원화).** 백로그는 org/user 레벨 단일 보드가 v1 모양이므로, 워크스페이스당 하나의 github 블록을 seed한다. sub-repo별 보드 분기를 만들지 않는다.
- **ADR-0012 정합(3-tier).** seed는 개인 구획(tier③ `.ditto/local`)에만 쓰고, 팀 recipe(tier②)는 **읽기만** 한다. 개인 우선 규칙이 tier 경계를 지킨다(팀 설정이 개인 설정을 덮지 않음).
- **ADR-0018 정합(우아한 강등).** seed 실패는 setup을 막지 않는다(try/catch + disclosure). 도구·설정 부재가 의도 실현을 막지 못한다.
- **ADR-0002 정합(schema SoT).** recipe.backlog의 SHAPE는 기존 `dittoConfigGithub` 스키마를 재사용한다 — 병렬 github-전용 config 파일/스키마를 만들지 않는다.

## Out-of-scope (명시적 비대상)

다음은 의도적으로 이 seam에 넣지 않았다(현재 계약상 불필요·과잉 — 헌장 §4-3):

- **sub-repo별 보드 seed** — D4로 워크스페이스당 단일 보드가 v1 모양. 다중 보드 좌표 분기 미지원.
- **우선순위/충돌 reconcile·doctor 머신** — recipe와 개인 config가 다를 때 자동 화해/진단하지 않는다(개인 우선으로 단순 종결). 충돌 reconcile은 현재 일어날 수 없는 시나리오용 방어다.
- **일반 마이그레이션 엔진** — 이미 존재하는 개인 github config를 새 recipe 값으로 자동 변환하지 않는다(bootstrap-once는 채움이지 이주가 아니다).
- **recipe.backlog 필드의 tier 분리** — backlog 필드를 팀/개인으로 쪼개지 않는다. whole-block seed.
- **recipe가 개인 config override** — 명시적으로 비대상. 개인 우선(case c keep).

## 주의사항 (pre-mortem 12-category sweep, 코드 SoT를 가리킴 — 코드 수정은 별도 follow-up)

여기서 코드를 고치지 않는다. 인지 항목으로만 기록한다(MUST NOT: 주석 수정·코드 변경은 후속 work item):

1. **status_map 주석↔스키마 긴장 (input-validation sweep).** `src/schemas/ditto-config.ts:61`은 `status_map: z.record(z.enum(['done','abandoned']), z.string().min(1))`인데, 같은 파일 `:50` 주석은 "The map MAY be partial or empty"라고 적혀 있다. z.record + enum-key의 exhaustiveness 동작에 따라 **두 키 모두 필수**일 수 있어 주석과 모순될 소지가 있다. 부분 status_map을 담은 recipe가 스키마-invalid가 되면, fail-open reader가 **전체 github 블록을 통째로 drop**하고 seed가 무산된다(case d로 분기). → 주석을 정정하거나, 부분 status_map recipe의 fail-open drop을 명문화하는 후속 필요. (검증 미실행: Zod 런타임 exhaustiveness는 본 큐레이션에서 실행 확인 안 함 — 코드 위치만 결박.)
2. **mergeRecipes whole-field replace.** `src/recipe/load.ts`의 `mergeRecipes`는 backlog를 sub-field 병합이 아니라 whole-field로 교체한다 — 개인 recipe.yaml의 backlog가 project backlog를 통째로 대체한다.
3. **auto_reflect seed가 reflection autonomy를 arm.** seed된 `auto_reflect`가 완료 시 보드 자동 미러(reflection autonomy)를 켠다 — seed 값이 런타임 자율성에 직접 영향.
4. **빈 status_map은 보드 inert.** 빈 status_map은 스키마 유효하나 보드 미러가 무동작(unmapped → skip + 안내, 우아한 강등).

## 변경 조건 (change_condition)

다음 중 하나가 발생하면 재검토한다: 워크스페이스당 복수 백로그 보드가 v1 요구로 올라오거나(D4 단일-보드 가정 깨짐), recipe→개인 config 자동 마이그레이션(이미 존재하는 값 이주)이 제품 요구가 되거나, recipe가 개인 설정을 override해야 하는 거버넌스 요구(개인 우선 뒤집기)가 생길 때.
