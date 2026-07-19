# classify — 워크스페이스 문서의 권위 상실을 검출해 가역 버킷으로 스테이징하는 문서 위생 분류기

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준 커밋 `c2d2e16` (2026-07-19). 핵심 소스(`src/cli/commands/classify.ts`, `src/core/cleanup-scan.ts`)는 `59fb3d8` (2026-06-20)에 마지막 수정.

## 1. 이 기능이 실현하려는 설계 의도 (개념)

문제: 설계·보고·스크래치 문서는 코드와 함께 동기화되지 않으므로 시간이 지나면 코드와 어긋난다(drift). 헌장 §4-11은 "권위는 코드에 있다 — 코드와 분리돼 동기화되지 않는 설계·기획 문서는 배경 이해용일 뿐 권위가 아니다"라고 못박는다. classify는 이 원칙을 **집행 가능한 절차**로 만든다: 권위를 잃은 문서(고아·stale·코드모순)를 검출해서 정리 후보로 격리한다.

핵심 개념은 세 가지다.

- **권위 상실(lost-authority) 검출.** 세 가지 신호 — 고아(orphan, 어디서도 참조되지 않음), stale(자기 코드보다 오래됨), 코드모순(contradiction, 현재 코드와 배치됨) — 로 문서의 권위 이탈을 판정한다.
- **삭제가 아니라 MOVE.** 어떤 문서도 파괴하지 않는다. 후보는 run 폴더 하위의 action 버킷으로 **이동**되고 언제든 원위치로 복원 가능하다(가역성).
- **결정적 탐색 ⊥ 판단적 disposition.** 탐색과 두 신호(orphan/stale)는 결정적으로 코드가 계산하지만, per-doc 최종 결정(어느 버킷 + 코드모순 신호)은 문서 1개당 fresh 서브에이전트 1개가 내린다. 앞선 아홉 문서를 읽으며 쌓인 서사에 오염되지 않도록 각 문서를 독립적으로 판단시키는 anti-bias 격리다(헌장 §4-9).

DITTO 4축 중 **지식(knowledge)** 축의 위생 도구이자, 거버넌스 성격을 겸한다. 근거: 이 커맨드는 문서-코드 정합성(축2: 코드↔SoT drift)을 다룬다.

주의(추론): 프롬프트가 힌트로 준 ADR-0017은 **코드 리팩토링/tidy** 절차(동작 보존 정리)를 다루며 이름의 "cleanup"이 겹칠 뿐, classify가 다루는 **문서 권위 정리**와는 대상이 다르다. classify의 직접 권위 근거는 헌장 §4-11과 ADR-0001(런타임이 LLM을 직접 호출하지 않음)이다. ADR-0017은 인접 배경일 뿐 이 기능의 결정 근거가 아니다 — 이는 추론이다.

## 2. 코드 위치와 진입점

| 경로 | 역할 |
|------|------|
| `src/cli/commands/classify.ts` | CLI 진입점. 4개 서브커맨드 정의, 인자 파싱/검증, auto-cleanup fail-closed 가드 |
| `src/core/cleanup-scan.ts` | `scan` 코어. 문서 워킹 + 결정적 신호(orphan/stale) 계산 + owning-repo 해석 |
| `src/core/cleanup-store.ts` | run 폴더 생성, 보호집합 판정, 문서 스테이징(move-then-record), 복원 |
| `src/core/cleanup-archive.ts` | run 폴더의 종결 처리(archive=zip 후 제거 / delete=영구삭제) + per-sub-repo 커밋 |
| `src/schemas/cleanup-index.ts` | zod 스키마(SoT, ADR-0002): action·basis·params·entry·index |
| `skills/classify/SKILL.md` | 드라이버 절차. per-doc 서브에이전트 fan-out을 오케스트레이션 |

서브커맨드(정의: `classify.ts:441-447`):

| 서브커맨드 | 하는 일 | 주요 인자 |
|-----------|---------|----------|
| `scan` | 후보 문서 + 결정적 신호 발견 | `--scope`, `--tracked`, `--categories`, `--aggressiveness`, `--concurrency`, `--auto-cleanup`, `--output` |
| `create-run` | run 폴더 + 4개 action 하위폴더 + params 스냅샷 생성 | `--params`(cleanupRunParams JSON), `--output` |
| `stage` | 이미 결정된 문서 1개를 버킷으로 이동 | `--run-id`, `--path`, `--action`, `--basis`(≥1 신호), `--summary`, `--aggressiveness`, `--agent`, `--auto`, `--output` |
| `status` | run의 index(메타 + per-doc entries) 조회 | `--run-id`, `--output` |

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

```
[scan]  워크스페이스 문서 트리
         → walkDocs (SKIP_DIRS 제외, DOC_EXTS만)
         → per-doc: 보호집합 제외 / tracked 필터 / scope 필터
         → orphan(git grep) + stale(mtime vs git log) 신호 계산
         → findOwningRepo로 owning sub-repo 해석
         → {candidates[], excluded_protected[]} + params 스냅샷  (stdout, 저장 안 함)

[create-run]  params JSON
         → CleanupStore.createRun
         → .ditto/local/cleanup/cleanup-<YYYYMMDD-HHMMSS>/{delete-candidate,quarantine,absorb-then-discard,unclassified}/
         → index.json (entries: [])                              (디스크에 씀)

[per-doc 서브에이전트]  (SKILL 드라이버가 fan-out, CLI 밖)
         후보 1개 → fresh 에이전트 → {action, summary, basis[]}

[stage]  결정 1개
         → CleanupStore.stageDoc: 보호집합/빈 basis 거부 → rename(문서 이동) → index.json에 entry append (1:1)
         → (--auto면 archive 버킷만 허용, delete/unclassified 거부)

[status] run-id → index.json 읽어서 출력
```

읽고 쓰는 상태:

- **run 폴더**: `.ditto/local/cleanup/<run-id>/` — 개발자 개인 tier(`localDir`, `ditto-paths.ts:24-26`). git 공유 대상 아님.
- **index.json**: run 폴더 안. 스키마 `cleanupIndex`(`cleanup-index.ts:81-96`) — `run_id`, `created_at`, `workspace_root`, `params`, `entries[]`.
- run_id 형식: `cleanup-<YYYYMMDD-HHMMSS>` + 선택적 충돌 접미사(`cleanup-index.ts:86-89`, 정규식 강제).

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

### 4-1. Thin CLI + per-doc fresh 서브에이전트 (ADR-0001 + 헌장 §4-9)

ditto(TypeScript)는 LLM을 직접 호출하지 않는다(ADR-0001). 그래서 작업이 둘로 갈린다: CLI는 **결정적 기계**(탐색·신호·이동)만 하고, **판단**(어느 버킷 + contradiction 신호)은 스킬 드라이버가 fan-out하는 서브에이전트가 한다(`classify.ts:26-34`, `cleanup-scan.ts:1-11`).

문서 1개당 **fresh 서브에이전트 1개**를 쓰는 이유: cross-doc 편향 방지. 한 에이전트가 여러 문서를 순차로 보면 앞 문서를 읽으며 만든 서사가 prior로 작동해 뒤 문서 판단을 오염시킨다(헌장 §4-9 context rot / 자기 확신). 각 에이전트에게 자기 문서 + 기준 + 보호집합 + 고정 사실(owning_repo, 이 문서의 결정적 신호)만 주고 다른 후보의 경로·내용·결정은 주지 않는다(SKILL.md ac-8).

트레이드오프: contradiction 신호는 결정적으로 못 구한다(코드와 문서를 읽고 판단해야 함) → 이 신호만 에이전트가 추가(`cleanup-scan.ts:8-10`; basis 스키마의 kind enum은 `orphan|stale|contradiction`, `cleanup-index.ts:24-31`).

### 4-2. 삭제 아닌 MOVE = 가역성 불변식

모든 스테이징은 `rename`(move)이고 `index.json`에 1:1 기록된다(`cleanup-store.ts:170,187-189`). 분류 중 어떤 것도 파괴되지 않고 `restore`로 원위치 복원 가능(`cleanup-store.ts:197-208`). 실제 삭제는 별도 `cleanup` 커맨드에서 사람이 명시 confirm할 때만(`cleanup-archive.ts:108-136`).

### 4-3. auto 경로는 구조적으로 archive-only (ac-6, fail-closed)

`--auto` 경로는 삭제가 **구조적으로 불가능**하다. `AUTO_ARCHIVE_ACTIONS`는 `quarantine`·`absorb-then-discard` 둘뿐이고(`classify.ts:44`), `stage --auto`는 파일을 건드리기 전에 `autoChainArchiveAction`으로 `delete-candidate`·`unclassified`를 거부한다(`classify.ts:359-369`). run 레벨 체인도 `runAutoCleanupChain`→`autoChainArchive`→`archiveRun`으로만 배선돼 delete에 도달할 코드 경로가 없다(`classify.ts:80-84`, `cleanup-archive.ts:277-279`). 채택 이유: 자동/autopilot이 사람 승인 없이 비가역 삭제하는 것을 원천 차단.

### 4-4. 보호집합 불가침 (ac-4)

`isProtectedPath`(`cleanup-store.ts:37-45`)가 store 계층에서 하드 거부한다 — 어떤 caller나 aggressiveness도 우회 못 함. 보호 대상: basename `CLAUDE.md`/`AGENTS.md`/`README*`, 그리고 prefix `.ditto/knowledge`·`reports/design`·`reports/contracts`(`cleanup-store.ts:24-31`). 살아있는 지침(ADR·knowledge)과 진입 문서는 권위이므로 정리 대상에서 뺀다.

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

### scanCandidates (`cleanup-scan.ts:175-230`)

입력: repoRoot + ScanOptions(trackedFilter, scopeGlob/scopeCommits, aggressiveness). 하는 일: `walkDocs`로 문서 확장자(`.md/.mdx/.txt/.rst/.adoc`, `cleanup-scan.ts:32`)만 수집하되 `SKIP_DIRS`(node_modules·.git·**.ditto**·dist 등, `cleanup-scan.ts:19-29`)는 안 걸음. per-doc으로:

1. **보호집합 제외** → `excluded_protected`로 분리(`cleanup-scan.ts:192-195`).
2. **tracked 필터**: `git ls-files` 집합과 대조(`cleanup-scan.ts:104-117,199-200`).
3. **scope 필터**: glob(gitignore-form) 또는 commit 리스트가 건드린 문서로 한정(`cleanup-scan.ts:203-205`).
4. **owning repo**: `findOwningRepo`로 가장 가까운 `.git` 보유 조상 디렉터리 해석(`memory-scan.ts:82-94`).
5. **신호 계산**(아래).

산출: `{candidates[], excluded_protected[]}`. 저장하지 않고 stdout(JSON/human)으로만 반환 — scan은 부수효과가 없다.

### orphan 신호 — hasInboundReference (`cleanup-scan.ts:149-169`)

문서 basename을 `git grep -F -l -I`로 트리 전체에서 fixed-string 검색, 자기 자신을 뺀 히트가 있으면 참조됨. 히트 0이면 orphan.

숨은 결정: `proc.exitCode !== 0`이면 `return false`(`cleanup-scan.ts:163`) → **git grep 매치 없음(exit 1)과 git 오류를 구분하지 않고 둘 다 "참조 없음"으로 처리**. 즉 오류 시 orphan 쪽으로 기운다(신호 과다생성 방향). 정규 동작에서는 basename만 보므로 **substring 오탐 가능**: 흔한 파일명(예: `notes.md`)이 다른 파일에 문자열로 등장하면 "참조됨"으로 오판한다 — 이는 신호를 **과소** 생성하는 방향의 부정확성이다.

### stale 신호 (`cleanup-scan.ts:215-224`)

문서의 파일시스템 mtime(`stat().mtimeMs`)이 그 문서 **자기 경로**를 건드린 가장 최근 커밋 시각(`git log -1 --format=%ct`, `cleanup-scan.ts:138-147`)보다 오래면 stale. "히스토리는 계속 움직였는데 문서 파일은 그대로"인 drift 후보를 잡으려는 의도.

숨은 취약점: **mtime은 git이 보존하지 않는다.** fresh clone·checkout·rebase는 모든 파일 mtime을 현재 시각으로 재설정하므로, 그런 워크스페이스에서는 `docMtimeMs`가 항상 커밋 시각보다 최신 → stale이 하나도 안 잡힌다. 이 신호의 신뢰성은 워크스페이스가 얼마나 오래 in-place로 유지됐는지에 달려 있다(§6 참조).

### CleanupStore.stageDoc (`cleanup-store.ts:152-191`)

입력: runId + {absPath, action, summary, basis, aggressiveness, agent?}. 순서가 중요하다 — **move-then-record**:

1. repoRoot 밖 경로 거부(`..`/절대경로, `cleanup-store.ts:155-157`).
2. 보호집합 거부(ac-4, `:159`) → 빈 basis 거부(ac-5, `:161`). **둘 다 파일 이동 전에** 검사.
3. `rename`으로 문서를 버킷 폴더로 이동(`:170`).
4. entry 구성 후 index를 **읽어서 push하고 즉시 다시 씀**(`:187-189`).

효과: rename이 먼저, 기록이 즉시 뒤따르므로 crash가 나도 디스크 index는 실제로 이동된 것만 반영한다(메모리에 배치 보류 없음, ac-2). 트레이드오프: entry마다 index.json read-modify-write → 동시 다중 writer에 대한 락은 없다(§7).

### createRun 충돌 가드 (`cleanup-store.ts:104-137`)

`mkdir(recursive:false)`를 원자적 claim으로 써서, 같은 초에 시작한 동시 run이 폴더를 공유하지 않도록 `EEXIST`면 `-<n>` 접미사로 재시도(`:114-123`).

### auto 가드 (`classify.ts:67-72, 359-369`)

`autoChainArchiveAction`은 action이 archive 버킷이 아니면 `AutoCleanupDeleteRefusedError`를 던진다. `stage`는 `--auto`일 때 이 가드를 **파일 접근 전에** 통과시킨다(`:361-368`). 효과: auto 경로는 delete/unclassified를 스테이징조차 못 함.

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위: 위 5개 파일 + 스키마 + SKILL + 테스트 파일 존재 확인(`tests/cli/classify-cli.test.ts`, `tests/core/cleanup-store.test.ts`, `tests/schemas/cleanup-index.test.ts` — ac-1~7 참조 존재). 테스트를 직접 실행하지는 않음(미검증).

- **thin CLI/no-LLM 의도**: 일치. CLI 어디에도 provider 호출 없음. 판단은 SKILL 드라이버로 위임(`classify.ts:30-34`).
- **가역성(move-not-delete)**: 일치. `stageDoc`은 rename만, delete는 별도 커맨드 + confirm 게이트(`cleanup-archive.ts:131-132`).
- **auto archive-only fail-closed**: 일치. 버킷 리스트·stage 가드·run 체인 세 지점 모두 delete 경로 부재(`classify.ts:44,80-84,359-369`).
- **보호집합/빈 basis 거부가 store 계층**: 일치. CLI가 아니라 `stageDoc` 안에서 거부하므로 caller 우회 불가(`cleanup-store.ts:159-161`).

**갭/불일치:**

1. **stale 신호가 mtime에 의존(`cleanup-scan.ts:217`)** — 의도는 "코드 drift 검출"이지만 mtime은 git이 보존하지 않아, 최근 clone/checkout된 워크스페이스에서는 stale이 구조적으로 안 잡힌다. 의도(drift 검출)와 메커니즘(mtime 비교)이 특정 환경에서 어긋난다. 이는 확인된 코드 사실이며, 결과 미검출은 추론이다.
2. **orphan 신호의 basename substring 오탐(`cleanup-scan.ts:154-168`)** — 참조 판정을 basename fixed-string grep으로만 하므로, 흔한 파일명은 우연 문자열 매치로 "참조됨" 오판 가능. 결정적이지만 정밀하지 않다. 단, 신호 부재는 에이전트 판단으로 보완되므로 치명적이진 않다.
3. **`concurrency`는 광고성 메타데이터일 뿐** — CLI/코어는 병렬화하지 않는다. params에 저장만 되고(`cleanup-index.ts:44`) 실제 fan-out은 스킬 드라이버 몫(`cleanup-scan.ts:48` "Advisory"). 의도대로지만, CLI만 보면 오해 소지가 있다.

확인 범위에서 그 외 로직 불일치·죽은 경로는 발견하지 못함.

## 7. 잠재 위험·부작용·재설계 시 고려점

- **stale 신뢰성(최우선 재고 대상).** mtime 기반은 CI·fresh checkout에서 무력하다. 재설계 시 문서의 "마지막 내용 변경 커밋 시각"(`git log -1 --format=%ct -- <doc>`)과 "그 문서가 서술하는 코드의 최근 변경 시각"을 **둘 다 git 시각으로** 비교하는 편이 환경 독립적이다. 현재는 문서 쪽만 mtime, 코드 쪽은 문서 자기 경로의 커밋이라 "문서 vs 관련 코드"가 아니라 "문서 파일 vs 문서 커밋"을 본다 — 관련 코드와의 drift를 직접 재지 않는다.
- **orphan 정밀도.** basename grep은 rename·경로 이동·상대경로 참조를 놓치거나 substring 오탐한다. 재설계 시 전체 상대경로 매칭 또는 memory-graph의 인바운드 엣지 재사용을 고려.
- **git grep 오류 fail-toward-orphan(`cleanup-scan.ts:163`).** git이 없거나 repo가 아니면 모든 문서가 orphan으로 표시돼 대량 오탐. 재설계 시 "매치 없음(exit 1)"과 "실행 오류(exit ≥2)"를 구분해야 한다.
- **동시성 정합.** index.json은 per-entry read-modify-write(`cleanup-store.ts:187-189`)이고 파일 락이 없다. 같은 run에 여러 stage가 진짜 동시에 쓰면 lost update 가능. run 폴더 생성은 `mkdir` 원자 claim으로 보호되지만(`:114-123`) index append는 아니다. 스킬 드라이버가 stage를 직렬 호출한다는 전제에 의존 — 재설계 시 이 전제를 명시하거나 append-only 로그로 바꿀 것.

**재설계 시 반드시 보존해야 할 불변식:**

1. **삭제 아닌 MOVE + 1:1 index 기록**(가역성). 어떤 경로도 분류 중 파괴 금지.
2. **auto 경로 archive-only fail-closed**(ac-6). delete는 사람 confirm 게이트 뒤에서만.
3. **보호집합 불가침을 store 계층에서 강제**(ac-4) — CLI가 아니라 이동 직전 지점에서.
4. **빈 basis 거부**(ac-5) — 근거 없는 분류 금지.
5. **per-doc fresh 서브에이전트 격리**(ac-8) — cross-doc 편향 방지.

**재고 가능한 결정:** stale의 mtime 의존, orphan의 basename-only 매칭, concurrency 메타데이터의 실제 미사용.
