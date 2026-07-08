# autopilot 테스트-티어 배리어 — 후속 전방위 조사

- **작성**: 2026-07-09 · wi_260708ds9(배리어) 배포 후 4-각도 병렬 조사 종합
- **추적**: wi_260708ds9 (배리어 본체) + 아래 §8 백로그 항목
- **성격**: 조사 리포트 (권위 아님). 저장소 권위는 코드다(§4-11) — 아래 file:line은 **2026-07-09 스냅샷**이며 착수 전 재확인할 것.
- **소비자**: 아래 결함/고려사항을 다룰 후속 WI들. 각 백로그 항목이 이 리포트의 해당 절을 참조한다.
- **폐기 조건**: P0·P1 결함이 land되고 §3 통합-경계 결정이 코드/ADR에 반영되면, 이 리포트는 그 WI들의 회고로 대체하고 폐기한다.

---

## 0. 결론 요약

`#1(배리어 명령 구조적 안전)`을 파고들라는 요청에서 시작해 배리어+테스트를 4각도(강제옵션·shipped감사·통합갭·systemic)로 조사했다. 핵심:

- **#1 자체는 수용이 옳다** — ADR-20260708 §변경조건이 이미 "실제 incident 전까지 구조적 강제 보류"로 결정했고(§4), 강제 옵션은 전부 불가능/비이식/과잉(§4 매트릭스). 값싼 guidance fix 2개만 하면 된다.
- 그러나 조사가 **#1보다 심각한 실질 결함 2개**와 **1개 설계 고려사항**, **1개 독립 보안 flag**를 찾았다:
  - **P0** worktree × 배리어 cwd = stale-green (latent 실질 결함, false-green 클래스) — §1
  - **P1** 배리어가 현재 DORMANT (ditto·boxwood 둘 다 명령 미선언 → 매 완료 degrade) — §2
  - **통합 "다른 곳"이 비어있음** + 단위-only 배리어는 통합-only 깨짐에 silent + push-gate 비대칭 — §3
  - **boxwood 보안**(평문 크리덴셜, ditto 밖) — §6

근거는 직접 코드/디스크 읽기(메모리 그래프는 code_drift 플래그라 미신뢰).

---

## 1. P0 — worktree × 배리어 cwd = stale-green 실질 결함 (2 에이전트 수렴)

**증상**: 배리어가 편집 안 된 코드를 테스트해 **stale-green**(이 WI가 없애려던 바로 그 false-green) 또는 헛-RED.

**메커니즘**:
- `nextNode(repoRoot,…)`의 `repoRoot`는 `resolveRepoRootForCreate → findRepoRoot`인데, 이건 worktree 세션을 **소유 워크스페이스 `<ws>`(main 체크아웃)로 재-루팅**한다 (`src/core/fs.ts:62-63` `parseWorktreePath`).
- 배리어 cwd = `dir==='' ? <ws> : join(<ws>, dir)` (`src/core/autopilot-loop.ts:783-787`), `planBarrierRuns(recipe, changed_files, repoRoot=<ws>)` (`:1222`).
- 그런데 WI 편집은 **worktree** `<ws>/.ditto/local/worktrees/<wi>/`에 있다 (`src/hooks/pre-tool-use.ts:636-643` leaseScopeRelPath).
- → 배리어는 main 체크아웃(WI의 미커밋 편집 없음)에서 스위트를 돌린다. main이 green이면 변경 코드가 테스트 안 된 채 **stale-green**.

**왜 latent**: 지금은 어떤 프로젝트도 `barrier_test_command`를 선언 안 해(§2) 배리어가 degrade → 명령 없으면 안 돎. worktree도 autopilot 루프가 자동 생성 안 함(명시 CLI만). **하지만 ditto repo가 지금 worktree를 활성 사용 중**(2개 존재) → ditto recipe에 배리어 명령 넣는 순간 live.

**왜 리뷰가 못 잡음**: 배리어 unit 테스트는 cwd를 직접 주입한다. worktree 재-루팅은 systemic/adjacent라 배리어 자체 코드 리뷰의 사각.

**수정 방향**(착수 시 재확인): 배리어 cwd resolution이 worktree-aware가 되어야 한다 — 세션이 worktree에 있으면 배리어는 그 worktree(그리고 그 아래 sub-repo)를 cwd로 써야 편집된 코드를 테스트한다. `findRepoRoot`의 재-루팅과 배리어 cwd의 관계를 재검토.

**근거**: `src/core/fs.ts:62-63`, `src/core/autopilot-loop.ts:783-787,1222`, `src/hooks/pre-tool-use.ts:636-643`. **[VERIFY]** 정적 trace지 라이브 worktree 배리어 실행으로 재현 안 함(현재 명령 미선언이라 관측 불가).

---

## 2. P1 — 배리어가 현재 DORMANT (3 에이전트 수렴)

`resolveBarrierCommand` (`src/core/autopilot-loop.ts:725-733`)는 `recipe.barrier_test_command` / `repos[].barrier_test_command`만 읽고 **push_gate로 fallback 안 함**. ditto `recipe.yaml`은 `push_gate.test_command:"bun test"`만 있고 `barrier_test_command` 없음. boxwood는 `recipe.yaml` 자체가 없음.

→ `seedTestBarrier`는 무조건 배리어 노드를 심지만(`src/core/autopilot-bootstrap.ts:87-106`), 명령이 undefined → `missing` → degrade(proceed-unverified) → **매 코드-WI 완료가 final_verdict≠pass로 self-degrade**. 배리어는 명령 선언 전까진 **no-op**.

- 이 세션 WI들이 완료된 건 grandfather(기능 前 bootstrap된 그래프는 test 노드 0개 → AC-only fall-through) 덕분.
- ditto는 1줄(`barrier_test_command: "bun test"`)로 켤 수 있으나 — **P0가 먼저 고쳐져야** 한다(안 그러면 worktree stale-green 활성화). **P1은 P0에 결합**.
- retro가 이걸 "benign self-degrade"로 과소평가했음 — 실제론 만성 false-unverified로 신호를 침식.

**근거**: `autopilot-loop.ts:725-733`, `autopilot-bootstrap.ts:87-106`, `recipe.yaml`, boxwood에 recipe 없음.

---

## 3. 통합 테스트 "다른 곳"이 비어있음 (설계 고려사항)

재프레이밍(ADR-20260708 D3)은 "단위=배리어, 통합=push-gate/CI/ditto:e2e"로 선언했으나:

- **boxwood에선 셋 다 백엔드 통합을 안 돌림**: push-gate 비활성(recipe·hook 없음)·백엔드 CI는 docker build(`portal-backend/.github/workflows/deploy.yml`)·packages CI는 `-DskipTests`(`boxwood-packages/.github/workflows/ci.yml:24`)·frontend CI는 lint+build·e2e는 브라우저만. 통합은 수동 `./gradlew test`뿐 → 실 공유 MariaDB.
- 즉 위험을 push-gate로 **옮긴** 게 아니라 자동 통합 검증이 **부재**. WI가 회귀를 만든 건 아니고, ADR change_condition 2가 이미 이 잔여를 명시.
- **단위-only 배리어는 통합-only 노드간 깨짐(JPA/SQL 방언/트랜잭션/HTTP 배선)엔 구조상 silent.** 완화: 완료가 per-AC oracle **AND** 배리어라, 통합 AC에 통합-요구 oracle을 붙이면 정직히 unverified로 floor(`autopilot-complete.ts:381-403`). **false-green은 통합 행동을 단위-dischargeable oracle에 매핑할 때만** — 이건 진단 **P4**(노드 red-green 유효조건/oracle tiering)의 몫인데 이 WI가 **미해결**로 남김.
- **push-gate 비대칭**(ADR 미분석): `push_gate.test_command`(`recipe.ts:52-57`)는 side-effect-free caveat도 **없이** 같은 무강제 free-form인데 통합을 돌리도록 기대됨. 배리어보다 노출은 낮지만(push 시점 1회·human) 안전은 배리어보다도 약함(guidance조차 없음).

**설계 고려사항**(사용자 결정 필요): 통합 검증 표면(push-gate 안전화 or 별도 integration 러너 or oracle tiering 강제)을 실제로 배선할지. 배선 안 하면 "통합은 다른 곳"은 실질적으로 "통합은 아무 데서도 자동으론 안 됨". deep-interview 급 결정.

**근거**: ADR-20260708:28-36,67, `recipe.ts:52-57`, boxwood CI 파일들, `autopilot-complete.ts:381-403`, 진단 P4(`reports/design/autopilot-test-execution-gaps.md`).

---

## 4. #1 배리어 명령 구조적 안전 — 수용 + guidance fix 2개

**현 상태**: 배리어가 free-form `barrier_test_command`(`z.string().min(1)`)를 무검사 실행(`test-runner.ts:49-84`, sandbox·network isolation 없음). safe-by-construction은 `.describe()` 주석 prose일 뿐(`recipe.ts:60-67`).

**강제 옵션 매트릭스**(전부 불가/비이식/과잉):
| 옵션 | 판정 |
|---|---|
| (a) 명령 문자열 정적 탐지 | 불가 — `./gradlew test`는 DB 접근을 안 드러냄(boxwood 실증: 실 DB는 `application-test.yml`에). FN 높음, 스택별 drift |
| (b) opt-in 선언 + pre-run 게이트 | 대부분 과잉 — "명령을 비워두면 degrade"(fail-safe 기본값)보다 marginal 가치 낮음. approval은 no-live-wait이라 pre-run만 |
| (c) 런타임 datasource/network 탐지 | 비이식(macOS 클린 격리 없음) → ADR-0016 충돌 |
| (d) sandbox(Testcontainers 등) | 프로젝트 테스트코드 책임, ditto 권한 밖 |
| (e) guidance 강화 | **채택** — fail-safe 기본값(명령 부재→degrade)이 이미 있어, 위험은 적극적 오설정을 요구 |

**ADR-0020**: ADR-20260708 §변경조건이 "구조적 강제는 실제 incident 시 재검토"로 **이미 결정** → 지금 machinery 만들면 method 충돌. no-live-wait(§4-10)로 approval은 pre-run만 가능. ADR-0018로 강제는 block 아니라 degrade여야.

**값싼 fix 2개 (채택)**:
1. **seed purpose 문서 모순**: `autopilot-bootstrap.ts:98`이 배리어를 "Run the **full test suite**"라 서술 — 단위-서브셋 caveat와 정면 모순. "unit/mock subset"으로. ~1줄.
2. **recipe caveat에 fail-safe 탈출구**: `recipe.ts:60-67`에 "안전 단위 서브셋을 못 만들면 이 필드를 **비워둬라**(배리어가 degrade → tests-unverified, 통합/full 스위트를 안 돌림). push_gate.test_command를 여기 복사하지 마라." 추가. (자명한 도입 명령 `turbo run test`·`./gradlew test`가 정확히 위험한 것들이라, 이 탈출구 명시가 최선의 오설정 예방.)

**근거**: `test-runner.ts:49-84`, `recipe.ts:60-78`, `autopilot-bootstrap.ts:98`, ADR-20260708 잔여/변경조건, 진단 P6/§4/§8.

---

## 5. 기타 잔여 (safe 방향, 낮은 우선순위)

- **멀티-repo root-drag degrade** (`autopilot-loop.ts:754-769`): 혼합 변경이 어느 `repos[].dir`에도 안 속하는 파일(root package.json·docker-compose·docs·lockfile)을 root('')로 귀속 → root 명령 없으면 sub-repo 전부 green이어도 **배리어 전체 degrade**. root 파일 변경 거의 불가피 → 멀티-repo 만성 degrade. safe(false-green 아님)지만 값 침식. 수정: root가 명령 없고 ≥1 sub-repo가 있으면 root run을 not-applicable로 skip.
- **late-fix stale-green** (가설, `autopilot-converge.ts:166-205`): 배리어 terminal 후 forward-splice된 fix가 배리어를 **재오픈 안 함**. 표준 제너레이터 노드순서(배리어 seed 마지막·wave 제외·mutatingInFlight 홀드)로 완화되나 invariant 아님 — custom generateNodes면 열림. 내구적 fix: forward fix splice 시 terminal 배리어를 pending으로 재오픈.
- **barrierRanGreen 약한 술어** (`autopilot-complete.ts:381-383`): `.some(command)`는 executor의 all-passed invariant보다 약함. 오늘은 안전(executor가 all-green에만 evidence 부착)하나 주석/assert로 묶을 가치.

---

## 6. ⚠ 독립 보안 flag — boxwood (ditto 밖, 고치지 않음)

`~/dev/project/boxwood-workspace/portal-backend/src/test/resources/application-test.yml`:
- test 프로파일이 **실 원격 MariaDB**(`jdbc:mariadb://ecoletree.com:4406/…`)를 가리키고 **평문 커밋된 크리덴셜**(`rsdbmst`/`surzest001`) — prod(`application-persistence.yml`)는 같은 호스트/DB/유저를 Jasypt `ENC(…)`로 암호화. 즉 prod가 암호화하는 걸 테스트가 평문 유출(surzest001 ≈ 복호화된 prod 비번으로 추정 **[VERIFY]** — 복호화 안 함).
- 추가 평문: security user 비번(`et#170817`), JWT secret/signing-key.
- Flyway가 공유 스키마에 migrate, 70 테스트 클래스 중 통합 다수가 `@ActiveProfiles("test")`, 단일 test task(단위+통합 분리 불가), Testcontainers/@Transactional/embedded 전무.

**어느 ADR도 안 다룸.** ditto 백로그 아님(다른 repo). 권장(사용자 판단): 크리덴셜 rotate + Jasypt/env 이전 + 통합 테스트를 ephemeral/isolated DB로. **배리어와의 접점**: 사용자가 portal-backend에 `barrier_test_command: ./gradlew test`(자명한 명령)를 선언하면 배리어가 매 완료마다 이 공유 DB를 침 = #1 잔여의 구체적 실체.

---

## 7. 근거 인덱스 · 불확실성

**코드**(2026-07-09 스냅샷): `src/core/autopilot-loop.ts`(배리어 715-971·resolve 725-733·cwd 783-787·retry 887-925·planBarrierRuns 1222), `src/core/fs.ts:62-63`(worktree 재-루팅), `src/hooks/pre-tool-use.ts:636-643`(worktree 편집 위치), `src/core/autopilot-complete.ts:381-403`(barrierRanGreen·floor), `src/core/autopilot-bootstrap.ts:87-106,98,215`(seed·purpose·caps), `src/core/test-runner.ts:49-84`(spawn·no sandbox), `src/schemas/recipe.ts:52-78`(push_gate vs barrier caveat), `src/cli/commands/push-gate.ts:114-155`, `recipe.yaml`(배리어 명령 없음), `.github/workflows/ci.yml`(lint+adr만).
**ADR/문서**: ADR-20260708(잔여·변경조건), ADR-0018 D4, ADR-0016, ADR-20260627(no-live-wait), 진단 `reports/design/autopilot-test-execution-gaps.md`(P4·P6·§4·§8).
**boxwood**: `portal-backend/src/test/resources/application-test.yml`, `application-persistence.yml`, `build.gradle`, CI 파일들.

**불확실성**: P0 stale-green은 정적 trace(라이브 미재현). 통합 파괴성(write) 미열거(진단 P6도 [추론]). boxwood 평문=prod 복호값 추정(미복호). Maven sub-repo 통합 테스트 인프라 미전수.

---

## 8. 백로그 매핑

| 리포트 절 | 백로그 항목 | kind | 우선 |
|---|---|---|---|
| §1 P0 worktree cwd stale-green | 실질 결함 WI | bug | 높음 |
| §2 P1 배리어 dormancy(ditto 명령 선언, P0 후) | idea | 중 |
| §4 #1 guidance fix 2개(seed purpose·caveat escape) | idea | 중(값쌈) |
| §3 통합-경계 배선 결정(oracle tiering/push-gate 안전화) | idea(deep-interview급) | 중 |
| §5 멀티-repo root-drag degrade | idea | 낮 |
| §6 boxwood 보안 | ditto 백로그 아님 — 사용자 flag | — |
