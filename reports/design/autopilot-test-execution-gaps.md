# autopilot 테스트 실행 결함 — 진단 및 개선 시드

- **작성**: 2026-07-08 · dogfood 세션(wi_260707phi autopilot 콘솔 관찰에서 출발)
- **추적**: wi_260708yx5
- **성격**: 설계·진단 리포트 (권위 아님). 저장소의 권위는 코드다(§4-11) — 아래 근거는 **작성 시점의 코드 스냅샷**이며, 착수 전 각 file:line을 다시 확인할 것.
- **소비자**: 이 결함들을 고칠 향후 heavy work item(오케스트레이션 개선 + TDD 빈 부분 보강). 그 WI의 deep-interview/pre-mortem 입력으로 바로 쓰도록 구성했다.
- **폐기 조건**: 향후 개선 WI가 land되어 §5 방향이 코드·recipe·planner에 흡수되면 이 문서는 그 WI 회고로 대체하고 폐기한다.

---

## 1. 배경 — 어떻게 드러났나

다른 dogfood 세션의 autopilot(work item `wi_260707phi`)이 도는 중, `core-taxonomy-writeback` implementer 노드의 작업 콘솔(`console.txt`)을 관찰하다 발견했다. 이 노드는 **하나의 autopilot 실행 안에서 병렬로 뜬 여러 implementer 노드 중 하나**였고, 형제 노드와 **같은 work-item worktree 하나를 공유**하고 있었다.

관찰의 방아쇠: implementer가 자기 red-green 확인은 focused 테스트로 했지만(`console.txt` L96·L112), 마지막에 **전체 테스트 스위트(4000+개)를 실행**했고(L116·L124), 그 결과가 깨끗하지 않았다(L124: `4168 pass / 11 fail`, "내 카운트 11이 명시된 5와 다르다").

---

## 2. 통합 근본 원인 (한 문장)

> **ditto는 자기가 통제하는 것(파일·코드 워크스페이스)은 격리하지만, 밖으로 새는 것(테스트가 읽는 범위·테스트가 일으키는 DB side-effect)은 격리하지도, 선언하게 하지도 않는다.**

이 한 뿌리가 스레드 내내 **같은 모양의 비대칭**으로 세 번 나타났다:

| 통제 대상(격리됨) | 새는 것(격리 안 됨) | 결함 |
|---|---|---|
| 쓰기 = `file_scope`로 노드별 격리 | 테스트 실행(읽기) = 트리 전체를 봄 | P1·P2 |
| 코드 워크스페이스 = per-WI worktree로 격리 | 테스트의 DB side-effect = 공유 외부 인프라로 감 | P6 |
| 노드↔AC 매핑 = 커버리지 완전성 보장 | 노드가 자기 scope 안에서 **독립 테스트 가능한가**는 미보장 | P4 |

개선은 이 대칭을 채우는 하나의 줄기다.

---

## 3. 결함 목록

각 항목: **[확정]**(이 세션에 코드/콘솔에서 직접 읽음) 또는 **[추론]**(근거에 기반한 해석, 미실증) 라벨 + 증상 + 근거 + 영향 + 개선 방향.

### P1 — implementer 노드가 전체 테스트 스위트를 실행한다
- **[확정]** 노드가 자기 red-green은 focused 테스트로 확인(`console.txt` L96 "run the taxonomy test to confirm RED", L112 GREEN)한 뒤, **전체 스위트를 실행**했다(L116 "Now run the full test suite", L124 `Suite: 4168 pass / 11 fail`).
- **[확정]** 이 지시는 dispatch 보일러플레이트가 아니라 **노드 task 텍스트에 저작된 것**이다 — `console.txt` L18 "Run `bun test` full suite … prove independence if your count differs". `grep "full suite"|"prove independence" src/` = 0건.
- **[추론]** `11 ≠ 5` 불일치는 **전체 스위트 결과가 깨끗한 baseline이 아니었다는 증거**다. 후보 원인 둘 다 미실증: (a) 형제 노드가 같은 트리에서 `coverage-discovery/feedback.ts`를 동시 편집(`console.txt` L3), (b) 노드가 `DITTO_AUTOPILOT_BYPASS=1`을 켠 채 스위트를 돌려 lease-gate 테스트를 교란(노드 스스로 L128 근처에서 지적). 어느 쪽이든 병렬 맥락의 전체-스위트 실행은 무효 신호.
- **영향**: 병렬 노드마다 3.5분짜리 스위트를 반복(관찰 세션에서 timeout→재실행→clean 재실행 ≥3회) → 낭비 + 신뢰 불가 판정.
- **부차 관찰**: 이 노드는 테스트 184줄을 한 번에 쓰고(L90) 구현 109줄을 한 번에(L106) 붙였다 — 반복형 수직 슬라이스가 아니라 test-first 일괄. 다만 사용자 교정대로 **핵심 결함은 슬라이싱이 아니라 테스트 실행 범위**다(P4에서 다룸).
- **개선 방향**: implementer의 테스트 실행을 **자기 `file_scope`의 테스트로 한정**. 전체/교차 범위 실행 금지.

### P2 — 격리 비대칭: 쓰기는 file_scope로 격리되나 테스트 실행은 트리 전체를 읽는다
- **[확정]** 병렬 wave는 **`file_scope`가 서로 disjoint한 노드만** admit한다 — file-overlap 게이트(`src/core/autopilot-loop.ts:813-822`, 실행 중 mutating 노드의 claim을 seed로 넣는 cross-call guard는 :805-812). 그래서 `console.txt`의 두 implementer가 같이 떴다(taxonomy vs discovery/feedback, 쓰기 범위 비겹침).
- **[확정]** worktree는 **per-WI 하나**다 — `createWorktreeForWorkItem`(`src/core/worktree.ts:308-316`) → `.ditto/local/worktrees/<wi>`. 형제 노드가 같은 트리를 공유한다(공유 `.git` → `console.txt` L3의 `index.lock` 경합).
- **핵심**: 파일 겹침 게이트가 보장하는 건 **쓰기 격리**뿐. `bun test`(전체 스위트)는 `file_scope`와 무관하게 **공유 트리 전체를 읽어** 형제의 미완성 편집까지 포함한다. wave가 admit된 근거(범위 비겹침)를 **테스트 실행이 조용히 깬다.**
- **개선 방향**: disjoint-scope 불변식을 **테스트 실행에도 대칭 적용** — 실행 범위를 노드 `file_scope`로 제한(P1). 교차 범위 실행은 P3의 배리어로.

### P3 — tester 배리어와 fix-loop가 없다 (테스트가 implementer/verifier에 접혀 있다)
- **[확정]** 노드 kind→owner에 `test` kind도 `tester` owner도 없다 — `src/core/autopilot-graph.ts:8-28`(`implement→implementer, review→reviewer, verify→verifier, fix→implementer`), `src/schemas/autopilot.ts:14-38`(kinds)·:41-64(owners) 전수. 테스트 실행이 implementer(red-first)와 verifier(AC 독립검증)에 접혀 있다.
- **[확정]** 병렬 노드의 "배리어"는 전용 역할이 아니라 그래프 의존성(verify가 implement에 depends_on)으로만 표현된다. fix-loop 재료는 존재(`fix` kind, `reopen` 전이 passed→pending — autopilot-graph.ts:60-64)하나 **"모든 implementer 수렴 → 범위 테스트 1회 → red면 fan-out 수정 → 재배리어"** 구조로 조직돼 있지 않다.
- **영향**: 안정된 트리에서 통합 테스트를 한 번 돌리는 단일 권위 게이트가 없다. 각 노드가 움직이는 트리 위에서 각자 판정(P1).
- **개선 방향**: implement wave 수렴 뒤 **join 배리어**(tester/verify 재사용)가 범위 테스트를 안정 트리에서 1회 실행 → red면 implementer로 fan-out → 재배리어. 여기가 **권위 있는 목표 강제 지점**.

### P4 — planner의 분해 기준이 파일 소유권뿐이다 (독립 테스트 가능성 미고려)
- **[확정]** planner는 노드↔AC를 매핑(`agents/planner.md` L18)하고 각 노드의 `file_scope`를 채운다(L24: "그 노드가 **건드릴** 파일 globs — dispatch가 이걸로 변형 라우팅, file-overlap 게이트가 이걸로 직렬화"). 즉 `file_scope`는 **쓰기 격리 + 변형 라우팅**용.
- **[확정]** planner의 완전성 자기점검은 **AC-surface 커버리지**다(L25: "criterion이 이름댄 파일/표면이 전부 어떤 노드의 file_scope에 들어가야 verify가 부분만 찾지 않는다"). **쓰기 커버리지**지, 테스트 가능성 분해가 아니다.
- **[확정]** 각 노드의 AC가 **자기 scope 안에서 독립 red-green 가능한가**, unit AC냐 integration AC냐 — 이 고려는 **일반적으로 없다**. 유일한 좁은 예외는 existence-vs-wiring AC 분리(L38: 런타임 배선 AC는 단위테스트로 discharge 불가 → 별도 verify 노드)뿐.
- **함의**: 파일-절단이 마침 행동-절단과 일치할 때만 노드별 red-green이 유효하다(`console.txt`의 taxonomy 노드는 우연히 일치). 어긋나면 노드별 테스트는 불가능하거나 mock 떡칠 → 거짓 확신.
- **개선 방향(TDD 빈 부분)**: 노드별 red-green은 **planner가 "이 노드 AC는 scope-local하다"를 인증할 때만** 신뢰. 그 인증을 planner의 새 고려로 추가하거나(테스트 단위 기준 분해), 노드별 테스트를 선택적 보조로 강등하고 권위는 P3 배리어에 둔다.

### P5 — 테스트 러너가 하드코딩/저작-텍스트 의존이다 (stack-agnostic 아님)
- **[확정]** 프로젝트별 설정 테스트 명령은 코드 전체에서 `recipe.push_gate.test_command` **하나뿐**(`src/schemas/recipe.ts:52-57`)이며, **push 게이트 전용**(push 시점 소비). autopilot dispatch/loop에는 테스트 명령 추상화가 없다.
- **[확정]** `console.txt`의 `bun test`는 노드 task에 저작된 문자열(P1). ditto-on-ditto라 우연히 bun이 맞았을 뿐.
- **영향**: ditto가 사용자 프로젝트(pytest/gradle/maven/vitest…)를 몰 때 무엇을 어떻게 돌릴지 배선이 없다.
- **개선 방향**: **discover→record**. 에이전트가 command를 발견·제안(테스트를 짤 수 있으니 프레임워크는 알 수 있다) → `recipe`(멀티레포면 `recipe.repos[]`, recipe.ts:59-76)에 기록(결정적·감사가능) → 사용자는 추론 불가한 부분만 비준. 강등: recipe 없으면 추론, 있으면 권위. 선례: recipe override-전용(recipe.ts:8-9), `src/schemas/language-ledger.ts`(proposed_by). **방법론(배리어·fix-loop·red-first)은 ditto 소유지 프로젝트 config가 아님** — command/environment만 프로젝트 seam.

### P6 — 테스트 실행의 비가역성·DB 안전이 미고려다
- **[확정 구조]** ditto는 테스트 실행을 read-only 증거로 다룬다 — verifier는 "Read-only except running verification"으로, **"돌리는 건 안전하다"를 암묵 전제**한다(`src/core/autopilot-dispatch.ts`의 verifier 도구셋 :92, review-owner 판정 :129). 이 전제는 백엔드가 실 DB를 치는 순간 깨진다.
- **[추론 위험]** 백엔드 통합 테스트가 실 DB에 write/delete를 하면 autopilot의 fix-loop 반복 실행이 **실 데이터를 반복 오염**시킬 수 있다(미실증 — §4 boxwood의 datasource 설정에서 추정).
- **함의**: 테스트 실행이 비가역 mutation이 되면 ditto 자기 위험 축(§4-8: non-local ∨ **irreversible** ∨ unaudited)에 걸리는 대상이지 자유 증거가 아니다.
- **개선 방향**: 테스트 실행의 **안전 posture를 선언**(추론 불가). 안전-by-construction(Testcontainers/embedded/mock) 선호, 없으면 **정직히 blocked 강등**(가짜 green도 파괴적 green도 금지), shared-infra 명령은 승인 게이트. **테스트 종류로 분할** — mock/unit은 노드(P2), DB 통합은 배리어(P3, 안전 env 확립 지점). 강제는 **보편이 아니라 비가역 위험 탐지 지점에서만 fail-closed**. 그릇은 스킬보다 **선언(recipe 필드)이 기본**, 절차가 진짜 절차적일 때만 스킬로 승격.

---

## 4. boxwood-workspace 실증

`~/dev/project/boxwood-workspace`(JVM 중심 폴리글랏 멀티레포)로 각 결함이 실제로 어떻게 나타나는지 조사한 결과. 모두 이 세션에 직접 읽음 **[확정]**(단 portal-backend 파괴성은 미실행 **[추론]**).

| sub-repo | stack | 발견되는 테스트 명령 | 환경/안전 |
|---|---|---|---|
| frontend | Node+turbo | `turbo run test` → 패키지별 `vitest run` | vitest 자족 / playwright는 브라우저 필요 |
| portal-backend | gradle | `./gradlew test` | **test 프로파일이 원격 실 MariaDB(`ecoletree.com:4406`)를 가리킴** + `testRuntimeOnly h2` 혼재 |
| automation-engine / external-client | maven | `./mvnw test` | 배포용 compose 존재(테스트 env 아님) |
| boxwood-packages | maven | `./mvnw test` | `tools-hub-mock-server` compose(모킹) |
| boxwood-knowledge | (없음) | 테스트 없음(문서 레포) | — |

- **P5 실증**: command는 repo별로 빌드파일에서 추론 가능 → `recipe.repos[]`에 1:1로 기록 가능. 단 `.ditto`에 recipe 없음(현재 `.ditto/local/config.json`은 deep_interview/tech_spec만).
- **P6 실증(핵심)**: `portal-backend/src/test/resources/application-test.yml`의 test 프로파일이 **원격 실 MariaDB**를 datasource로 선언(주석은 "실제 DB 대신"이라 적혀 있으나 URL은 실 호스트 — 주석이 거짓). `./gradlew test` 통과 여부가 그 원격 DB 도달성·계정·스키마에 달렸고, write 하는 테스트가 있으면 **fix-loop가 실 데이터를 반복 오염**. `docker/docker-compose.yml`은 **앱 이미지 배포용**이라 순진하게 `docker-compose up` 하면 오히려 틀림.
- **discover 1차 자료 부재**: `WORKSPACE_SETUP.md`·`CLAUDE.md`·`AGENTS.md` 전부 테스트/DB/실행 명령 언급 0건(grep) — 사람이 선언해둔 방법조차 없다.
- **곁다리 보안(별개 이슈)**: `application-test.yml`에 원격 DB **평문 자격증명**이 커밋돼 있다. "테스트 환경 = 시크릿 든 실제 외부 인프라"의 산 증거이자, 추론이 아니라 선언이 필요한 이유. 별도 조치 가치.

---

## 5. 개선 방향 (향후 WI 시드)

### 5-A. 오케스트레이션
1. **테스트 실행을 file_scope에 대칭 격리**(P1·P2): implementer는 자기 범위 테스트만. 전체/교차 스위트 금지 — dispatch 규율(RED_FIRST_DIRECTIVE 인접, `autopilot-dispatch.ts:173-177`)에 범위 가드 추가로 저작-텍스트가 전체 스위트를 시켜도 무력화.
2. **join 배리어 + fix-loop 도입**(P3): wave 수렴 뒤 범위 테스트 1회 → red면 fan-out 수정 → 재배리어. 새 `test` kind로 뺄지 `verify` 재사용할지는 §6.
3. **러너 discover→record**(P5): recipe(멀티레포는 `repos[]`)에 per-repo test command. 없으면 추론, 있으면 권위.
4. **비가역 안전 fail-closed**(P6): 테스트 실행 안전 posture 선언; 안전 확립 불가 시 blocked 강등; shared-infra는 승인 게이트.

### 5-B. TDD 빈 부분
1. **노드 red-green의 유효 조건 성문화**(P4): 노드별 red-green은 그 노드 AC가 scope-local일 때만 유효 → planner가 인증하거나, 미인증이면 배리어를 권위로.
2. **red-first 적용 경계 재검토**: 현재 red-first는 implementer+dynamic_test oracle에서만 발화(`autopilot-dispatch.ts:186-194`). 배리어 도입 시 "노드 red-green(선택) vs 배리어 통합 테스트(권위)"의 역할 재정의 필요.
3. **unit/integration AC 구분 도입**(P4·P6): mock/unit AC(노드에서 안전 검증)와 integration AC(배리어에서 안전 env로)를 분리 — existence-vs-wiring 분리(planner.md L38)의 일반화.

---

## 6. 열린 결정 (사용자 소유 — deep-interview에서 확정)

에이전트가 판단할 수 없는, 가치·도메인·비가역 트레이드오프 결정:

1. **배리어의 그릇**: 새 `test` kind/owner를 신설할지, 기존 `verify`를 재사용할지.
2. **노드별 테스트 존치 여부**: 선택적 국소 보조로 남길지, 없애고 배리어를 유일 게이트로 할지(복잡도 vs 조기 phantom-green 검출).
3. **병렬 격리 방식**: 현행 "공유 worktree + disjoint file_scope"를 유지하되 테스트 실행만 대칭 격리할지, per-node worktree로 갈지(비용 큼).
4. **러너 선언 그릇**: recipe 필드로 충분한지, 절차적 프로젝트는 스킬로 승격할지 — 그 승격 트리거.
5. **비가역 fail-closed 트리거**: 무엇을 "비가역/shared-infra 테스트"로 탐지할지(프로파일의 non-embedded datasource? 네트워크 write? 선언?).
6. **안전 posture 선언 위치·형식**: per-repo recipe 필드의 최소 모양.

---

## 7. 근거 인덱스 (착수 전 재확인)

**코드**
- `src/core/autopilot-graph.ts:8-28` — KIND_TO_OWNER(테스트 kind/owner 부재), :60-64 reopen 전이
- `src/schemas/autopilot.ts:14-38, 41-64` — node kind·owner enum
- `src/core/autopilot-loop.ts:805-822` — file-overlap 게이트(병렬 wave = disjoint file_scope)
- `src/core/worktree.ts:308-316` — createWorktreeForWorkItem(per-WI 공유 worktree)
- `src/core/autopilot-dispatch.ts:92, 129, 173-177, 186-194` — verifier 도구셋·review 판정·RED_FIRST_DIRECTIVE·isRedFirstImplement
- `agents/planner.md` L18·L24·L25·L38 — 분해 기준(file_scope=쓰기 격리/라우팅), AC-surface 커버리지, existence-vs-wiring
- `src/schemas/recipe.ts:8-9, 52-57, 59-76` — override-전용, push_gate.test_command(유일 seam), repos[]
- `src/schemas/language-ledger.ts` — discover→record 선례
- `grep "full suite"|"prove independence" src/` = 0건 — 전체-스위트 지시는 저작-텍스트

**콘솔** (`console.txt`, wi_260707phi core-taxonomy-writeback)
- L1 노드 헤더(you own ONLY·TDD·Worktree cwd) · L3 병렬 형제·index.lock · L18 "run bun test full suite" · L90 테스트 184줄 일괄 · L96 focused RED · L106 구현 109줄 일괄 · L112 focused GREEN · L116 전체 스위트 실행 · L124 `4168 pass / 11 fail`·"11≠5" · L128 근처 bypass-env 교란 지적 · L130-131 clean 재실행 3m31s

**boxwood-workspace** (이 세션 직접 조사)
- 멀티레포 구성 · frontend `turbo run test`→vitest · portal-backend `application-test.yml`→원격 MariaDB+`testRuntimeOnly h2` · maven repos `./mvnw test` · recipe 부재 · setup/agents/claude 문서에 테스트 지시 0건

---

## 8. 부록 — TDD 모범사례 및 프레임워크별 방법론 (학습용)

> **성격 주의(§4-11)**: 이 절은 **업계 일반 모범사례**로, §1~7의 진단(코드 근거)과 성격이 다르다. 프레임워크 공식 문서·통용 관행에 기반하며, 버전 의존 항목은 버전을 명시했으니 도입 전 공식 문서로 재확인할 것. ditto 코드의 사실 주장이 아니라 **학습 참조**다.

### 8-1. TDD 코어 (프레임워크 무관)

- **Red → Green → Refactor** (Kent Beck): ① 실패하는 작은 테스트 하나(RED, 도달할 목표 고정) → ② 통과시키는 **최소** 구현(GREEN, 그 이상 금지) → ③ GREEN 유지하며 정리(REFACTOR) → 반복. 핵심은 "테스트가 목표의 명세이고, 구현은 그 목표를 채우는 것"이라는 순서.
- **테스트 피라미드** (Mike Cohn): 아래로 갈수록 많고 빠르고 싸다.
  - **단위(unit)** — 다수·밀리초·외부 의존 없음(목/스텁). red-green 루프의 주력.
  - **통합(integration)** — 소수·DB·HTTP·메시지 등 실제 협력자와. 느리고 환경 필요.
  - **E2E** — 극소수·전체 스택·브라우저. 가장 느리고 비쌈.
  - *역피라미드(E2E 위주)는 안티패턴* — 느리고 불안정(flaky)하다.
- **FIRST 원칙**: **F**ast, **I**solated(서로·순서 독립), **R**epeatable(결정적), **S**elf-validating(pass/fail 자동), **T**imely(코드와 함께/먼저).
- **Test double 분류** (Meszaros/Fowler): **dummy**(자리만) · **stub**(정해진 값 반환) · **spy**(호출 기록) · **mock**(기대 검증) · **fake**(간이 실동작 구현, 예: 인메모리 DB). 복잡한 협력자는 **mock보다 fake**가 깨지기 덜 하다.
- **구조**: AAA(Arrange-Act-Assert) 또는 Given-When-Then. 테스트당 개념 하나, 이름은 행동 서술("재고 없으면 주문 거절").
- **행동을 테스트하라, 구현이 아니라**: 내부 호출 순서까지 목킹하면 리팩터가 테스트를 깬다(과잉 목킹). 학파 구분 — **classicist/Detroit**(가능하면 실제 객체·fake, 상태 검증) vs **mockist/London**(협력자 목킹, 상호작용 검증). 단위는 mockist, 경계 넘으면 classicist가 흔한 절충.
- **하지 말 것**: 프레임워크·서드파티 코드 테스트, 공유 가변 상태, 시간/랜덤/네트워크 비결정성.

> **ditto 매핑**: 피라미드의 **단위=노드 red-green(P4가 요구하는 scope-local)**, **통합/E2E=배리어(P3)**. 즉 "무엇을 노드에서, 무엇을 배리어에서"는 피라미드가 이미 답을 준다.

### 8-2. Node.js / TypeScript

- **러너**: `vitest`(Vite 네이티브, 빠른 watch·ESM 친화) · `jest`(성숙·생태계 큼) · `node:test`(Node 20+ 내장, `node:assert`) · `mocha`+`chai`(고전). TDD 루프는 **watch 모드**(`vitest`/`jest --watch`)로 저장 즉시 red-green.
- **목킹**: `vi.fn()`/`vi.mock()` (vitest), `jest.fn()`/`jest.mock()`. 모듈 경계 목킹 가능.
- **API 통합**: `supertest`로 Express/Koa 앱에 실제 HTTP 없이 요청·검증.
- **DB**: 충실도 필요하면 **Testcontainers for Node**(`@testcontainers/postgresql` 등 일회용 실 DB), 빠름 우선이면 인메모리(`pg-mem`, `mongodb-memory-server`, `better-sqlite3`).
- **프론트 컴포넌트**: **Testing Library**(`@testing-library/{react,svelte,vue}`) + `vitest`(jsdom/happy-dom). "사용자가 보는 것"으로 검증, 구현 세부 회피.
- **E2E**: Playwright(권장) / Cypress. *(boxwood frontend는 vitest 단위 + playwright e2e devDep 조합 — 피라미드 정석)*
- **커버리지**: `c8`/istanbul (`vitest --coverage`).

```ts
// order.test.ts — red-green 루프는 `vitest --watch`
import { it, expect, vi } from 'vitest'
import { placeOrder } from './order'

it('재고가 없으면 주문을 거절한다', () => {
  const repo = { findStock: vi.fn().mockReturnValue(0) }        // stub
  expect(() => placeOrder(repo, 'sku-1')).toThrow('out of stock')
  expect(repo.findStock).toHaveBeenCalledWith('sku-1')          // 상호작용(선택)
})
```
```ts
// API 통합 — supertest (실제 포트 없이 앱에 요청)
import request from 'supertest'; import { app } from './app'
it('POST /orders → 201', async () => {
  const res = await request(app).post('/orders').send({ sku: 'sku-1' })
  expect(res.status).toBe(201)
})
```

### 8-3. Java + Spring Framework

핵심 통찰: **Spring은 "테스트 슬라이스"로 피라미드를 프레임워크 차원에서 지원한다.** 전체 컨텍스트를 띄우지 말고 필요한 층만.

- **토대**: JUnit 5(Jupiter, `@Test`/`@Nested`/`@ParameterizedTest`) + **AssertJ**(`assertThat(...)` 유창한 단언) + **Mockito**.
- **순수 단위** (Spring 컨텍스트 없음 — 가장 빠름, red-green 루프 주력):
```java
@ExtendWith(MockitoExtension.class)
class OrderServiceTest {
  @Mock OrderRepository repo;
  @InjectMocks OrderService service;
  @Test void 재고_없으면_예외() {
    given(repo.findStock("sku-1")).willReturn(0);
    assertThatThrownBy(() -> service.place("sku-1")).isInstanceOf(OutOfStockException.class);
    then(repo).should(never()).save(any());
  }
}
```
- **웹 슬라이스** `@WebMvcTest` (컨트롤러·직렬화·검증만, 서비스는 목):
```java
@WebMvcTest(OrderController.class)
class OrderControllerTest {
  @Autowired MockMvc mvc;
  @MockitoBean OrderService service;   // Spring Boot 3.4+/Framework 6.2+; 이전엔 @MockBean
  @Test void 빈_바디는_400() throws Exception {
    mvc.perform(post("/orders").contentType(APPLICATION_JSON).content("{}"))
       .andExpect(status().isBadRequest());
  }
}
```
- **영속 슬라이스** `@DataJpaTest` (리포지토리만; **기본이 인메모리 임베디드 DB로 교체 + 테스트마다 자동 롤백**):
```java
@DataJpaTest                          // 안전: 임베디드 DB, @Transactional 자동 rollback
class OrderRepositoryTest { @Autowired OrderRepository repo; /* … */ }
```
- **실 DB 충실도가 필요한 통합** — **Testcontainers**(일회용 실 DB 컨테이너, 프로덕션과 같은 엔진):
```java
@DataJpaTest
@AutoConfigureTestDatabase(replace = Replace.NONE)   // 임베디드 교체 끔
@Testcontainers
class OrderRepositoryIT {
  @Container @ServiceConnection                        // Spring Boot 3.1+: 연결정보 자동 주입
  static MariaDBContainer<?> db = new MariaDBContainer<>("mariadb:11");
  @Autowired OrderRepository repo;
}
```
- **풀 통합** `@SpringBootTest(webEnvironment = RANDOM_PORT)` + `WebTestClient`/`TestRestTemplate`(실 포트) 또는 `MockMvc`(서블릿 모의).
- **DB 안전 3종 세트** (P6와 직결):
  1. **`@Transactional` 롤백** — Spring 테스트 컨텍스트에서 `@Transactional` 테스트는 **끝나면 기본 롤백**(공유 DB에서도 데이터 안 남김; 커밋하려면 `@Commit`).
  2. **`@ActiveProfiles("test")`** — 테스트 전용 프로파일로 datasource 분리.
  3. **임베디드(H2) vs Testcontainers** — H2는 빠르나 SQL 방언 차이로 위양성/위음성; Testcontainers는 실 엔진이라 충실하나 Docker 필요. 선택은 트레이드오프.

> **boxwood portal-backend 교정 예시(학습 포인트)**: 지금은 `application-test.yml`의 test 프로파일이 **원격 실 MariaDB**를 물어 fix-loop가 실데이터를 위협한다(P6). 정석은 — 단위/슬라이스는 `@DataJpaTest`(임베디드) + Mockito, 통합은 **Testcontainers `@ServiceConnection`으로 일회용 MariaDB**, 전 구간 `@Transactional` 롤백 + `@ActiveProfiles("test")`. 그러면 실 인프라 없이 안전하게 반복 실행 가능 = **safe-by-construction**.

### 8-4. 두 생태계 공통 안전 원칙 → ditto 연결

| 원칙 | Node.js | Java/Spring | ditto 결함 연결 |
|---|---|---|---|
| 피라미드로 층 분리 | vitest 단위 / supertest 통합 / Playwright E2E | Mockito 단위 / 슬라이스 / `@SpringBootTest` | P3 노드-vs-배리어 분할 |
| 외부 상태 격리 | Testcontainers·인메모리 | Testcontainers·임베디드·`@Transactional` 롤백 | P6 안전-by-construction |
| 환경은 선언·재현 | `.env.test`·compose | `@ActiveProfiles`·프로파일 datasource | P5 discover→record, P6 선언 |
| 빠른 red-green 루프 | watch 모드 | 순수 단위(no context) | P4 노드 red-green 유효 조건 |

**한 줄 요약(학습)**: 안전하고 빠른 TDD의 열쇠는 **"무엇을 단위로 격리해 목/fake로 빠르게 돌리고, 무엇을 일회용·롤백되는 실 자원으로 통합 검증할지"의 분할**이다. Spring 슬라이스와 Testcontainers, Node의 vitest+supertest+Testcontainers가 그 분할을 프레임워크로 제공한다 — ditto가 P3(배리어)·P6(안전 선언)에서 채워야 할 바로 그 구조다.
