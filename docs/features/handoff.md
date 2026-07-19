# handoff — 세션·컨텍스트·에이전트 경계 너머로 "같은 작업을 이어받을 최소 컨텍스트"를 넘기는 pull-기반 인계 장치

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준 커밋 `c2d2e16` (2026-07-19), 브랜치 `main`.

## 1. 이 기능이 실현하려는 설계 의도 (개념)

핸드오프는 **끝나지 않은 작업의 의도·상태를 다음 세션/에이전트/작업자에게 넘기는 인계 산출물**이다. 컨텍스트는 유한한 예산이며(길수록 성능이 떨어지고, 쌓인 서사가 판단을 편향시킨다) 세션은 언젠가 끊긴다 — 핸드오프는 그 경계에서 "재발견을 강요하지 않도록" 원 의도와 현재 상태를 축자로 담아 운반한다. 이는 charter §4-9(위임으로 컨텍스트를 지킨다: "긴 세션은 요청 경계에서 handoff로 reset")와 §4-12(시드와 핸드오프는 의도의 상태로 담는다: 확정된 의도를 그대로 보존해 운반, 재도출·드리프트·조용한 축소 금지)의 실행체다.

핵심 설계 결정 두 가지:

- **Pull(명시 소비)만, push(자동 주입) 금지.** 어떤 훅도 핸드오프 본문을 다음 세션 컨텍스트에 자동으로 밀어넣지 않는다. 재개하는 쪽이 `list`로 발견하고 `consume`로 본문을 로드해야만 컨텍스트에 들어온다. 근거: 자동 주입은 무관한 세션에 옛 컨텍스트를 영구 오염시킨다(handoff-store.ts:26-32 frontmatter round-trip + "본문은 명시적 consume 으로만 로드"; handoff.ts:32-38 "no hook auto-injects").
- **두 scope, 두 tier.** scope는 `work_item`(작업 항목에 묶임)과 `session`(작업 항목 없는 세션)으로 갈리고(schemas/handoff.ts:16-34), 저장 tier는 LOCAL(gitignored 개인)과 REMOTE(작업 브랜치에 커밋되어 checkout 수신자에게 도달)로 갈린다(handoff-store.ts:23-32).

DITTO 4축 중 **오케스트레이션 축의 세션-연속(continuity) 기반 장치**에 속한다. 코드를 바꾸지 않고 자율 실행(autopilot)이 세션 경계를 넘어 같은 작업을 이어가게 하는 상태 전달 계층이며, 지식(knowledge) 축의 durable 기록과는 다르다 — 핸드오프는 "이 작업을 이어받을 일시적 컨텍스트"이지 영속 지식이 아니다.

## 2. 코드 위치와 진입점

| 경로 | 역할 |
| --- | --- |
| `src/cli/commands/handoff.ts` | `ditto handoff` 진입점. `write`/`list`/`consume`/`show` 서브커맨드. 세션-scope 생산 + 명시-pull 발견/소비. `HandoffStore` 위 얇은 껍데기. |
| `src/cli/commands/work.ts:1763-1930` | `ditto work handoff <id>` — work_item-scope 생산자(보존됨). `--show`(읽기), `--remote`(커밋), `--base/--head`(diff 범위). |
| `src/core/handoff-store.ts` | 핸드오프 빌더(`buildHandoff`/`buildSessionHandoff`) + 직렬화/파싱 + `HandoffStore`(write/list/consume/sweep/remote). 단일 독립 store. |
| `src/core/work-item-handoff.ts` | `writeWorkItemHandoff` — work_item 핸드오프의 오케스트레이션(changed_files 수집, completion contract 생성, 상태 전이, 링크). |
| `src/schemas/handoff.ts` | zod 스키마(SoT, ADR-0002). `handoffScope` discriminated union + `handoff` 객체 + 레거시 preprocess. |
| `src/hooks/pre-compact.ts` | PreCompact 훅 — compaction 직전 활성 work item의 핸드오프를 LOCAL에 자동 **저장**(주입 아님). |

### `ditto handoff` 서브커맨드

| 서브커맨드 | 인자 | 하는 일 |
| --- | --- | --- |
| `write` | `--intent --from --state --next`(모두 필수), `--session`(생략 시 생성), `--autopilot`, `--remote`, `--output` | session-scope 핸드오프를 LOCAL에 쓴다. `--remote`면 작업 브랜치에 커밋. |
| `list` | `--output` | LOCAL + REMOTE 대기 핸드오프 발견 + 파싱 실패 파일 표면화. |
| `consume <id>` | `id`(positional), `--output` | id를 조회해 본문 로드 + per-recipient 소비 마커 기록. 파일 이동/삭제 안 함. |
| `show <id>` | `id`(positional), `--output` | 활성 핸드오프 읽기 전용 조회(마커 안 남김). |

### `ditto work handoff` 인자

`--base`/`--head`(changed_files diff 범위), `--declared-by`(판정 역할), `--show`(기존 핸드오프 읽기), `--remote`(브랜치 커밋), `--output`. (work.ts:1768-1809)

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

### 저장 위치와 스키마

- **LOCAL(gitignored):** `.ditto/local/handoff/` — work_item은 `<wi>.md`, session은 `session__<sid>.md`. `.ditto/local/`은 `.ditto/.gitignore:4 local/`로 무시됨(확인: `git check-ignore`). 소비 마커는 `.ditto/local/handoff/consumed/<recipient>/<markerId>.json`, 아카이브는 `.ditto/local/handoff/archive/`.
- **REMOTE(git-tracked):** `.ditto/handoff/<stem>.md` — `<stem>`은 `<wi>__<author>` 또는 `session__<sid>__<author>`. 개인 구획 밖이라 커밋 가능(ADR-20260714 근거: gitignored 경로면 `git add`가 silent no-op).
- **파일 형식:** 1줄 JSON frontmatter(기계 복원용) + `---` fence + 사람용 markdown 본문. `serialize`(handoff-store.ts:295-297) / `parseHandoffFile`(300-310)로 round-trip.
- **스키마:** `handoff`(schemas/handoff.ts:135-149) — `scope`(union), `original_intent`, `current_state`, `next_first_check`(필수), 나머지는 `.default([])`로 additive-optional.

### work_item 핸드오프 흐름 (`ditto work handoff` / PreCompact)

```
work item + options
  → collectChangedFiles(base...HEAD diff ∪ --changed 선언)   [work-item-handoff.ts:148]
  → git status를 GUARD로만 사용(extraTrackedDirt fail-closed)
  → buildCompletion(그래프 있으면 그래프 AC verdict 사용)      [218]
  → completion.json 기록 (.ditto/local/work-items/<wi>/)
  → buildHandoff(changed_files, failedOrUnverified, openThreads) [handoff-store.ts:94]
  → pass면 writeArchived(active 소음 0), 비-pass면 write(active) [453-456]
  → sweepStaleActive (7일 초과 active를 archive로 이동)         [463]
  → work item 상태 전이(pass→close(done), partial→update)      [470-502]
```

### session 핸드오프 흐름 (`ditto handoff write`)

```
--intent/--from/--state/--next  (필수 검증, 없으면 exit 65)
  → buildSessionHandoff(scope={kind:session, session_id})     [handoff-store.ts:148]
  → --remote면 store.writeRemote(브랜치 검증 + 스크럽 + 커밋, NO push)
  →         else store.write(.ditto/local/handoff/session__<sid>.md)
```

### 소비 흐름 (`ditto handoff list` → `consume`)

```
list: listActiveDetailed(LOCAL) + listRemote(REMOTE, per-recipient 마커로 필터)
      + 양 tier 파싱 실패 표면화                               [handoff.ts:244-282]
consume <id>: listRemote에서 stem 조회 → 있으면 consumeRemote, 없으면 consumeFor
      → 본문 로드 + consumed 마커 기록 (파일은 그대로 둠)      [handoff.ts:318-352]
```

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

### 명시-pull, auto-inject 금지 (charter §4-9)

핸드오프 본문은 오직 `consume`/`show`로만 컨텍스트에 들어온다. `list`가 유일한 발견 채널이며, 어떤 훅도 본문을 주입하지 않는다(handoff.ts:32-38). PreCompact 훅조차 **저장만** 하고 주입하지 않는다(pre-compact.ts:49). 이유: 자동 주입은 무관한 후속 세션에 옛 서사를 prior로 심어 판단을 편향시킨다(§4-9 context rot·자기 확신). `--show`는 "제거된 auto-injection의 대체 — 재개 세션이 on-demand로 옛 컨텍스트를 pull"이라고 명시(work.ts:1819-1822).

### soft-consume: 마커만 남기고 파일은 안 지운다

`consume`는 본문을 로드하고 per-recipient 소비 마커(`consumed/<recipient>/<markerId>.json`)만 기록하며 파일을 이동/삭제하지 않는다(handoff-store.ts:721-734, consume 서브커맨드 설명 handoff.ts:289-290). 이유: 재개 실패 시 핸드오프를 잃지 않기 위함(ac-7). 하드 정리는 오직 age-sweep(7일). 마커는 gitignored이고 age-sweep 대상 밖(top-level `.md`만 sweep)이라, checkout으로 mtime이 리셋돼도 소비된 remote 핸드오프가 재부상하지 않는다(handoff-store.ts:776-783).

### REMOTE tier = 작업 브랜치에 커밋 (ADR-20260714)

원격 핸드오프는 `.ditto/handoff/`(git-tracked)에 per-scope+author 분리 파일로 커밋된다. 근거(ADR-20260714):
- **same-branch 연속:** 핸드오프는 broadcast가 아니라 "이 브랜치를 이어받는 사람에게" 넘기는 targeted 연속. 브랜치를 checkout하면 함께 오는 유일한 전송 매체가 git-tracked 파일이다. gitignored 로컬 파일은 브랜치를 안 따라온다.
- **단일 공유 `HANDOFF.md` 기각:** 동시 다중 작성자가 서로 덮어써 분리·귀속·무손실이 깨진다. per-scope+author-slug 분리(handoff-store.ts:555)로 무충돌.
- **정리는 per-recipient 로컬 마커 전용, git-delete/commit/push 금지**(charter §4-8, commit/push는 사용자-게이트 비가역). `consumeRemote`는 커밋 파일을 건드리지 않고 로컬 마커만 남긴다(handoff-store.ts:784-795).
- **커밋 본문 fail-closed 스크럽:** git 히스토리는 비가역이라 토큰이 영구 남으므로 `scrubHandoffForCommit`으로 스크럽 후 재파싱 실패면 커밋 거부(handoff-store.ts:331-339).
- 이 ADR은 ADR-20260706의 "handoff = 전부 gitignored 개인 tier, 불변" **분류 한 줄만** 좁게 supersede한다.

### blocked 핸드오프 = 결정을 넘긴다 (막다른 길 금지)

`blocked: true`인 핸드오프는 `user_decision_block`이 비어 있으면 빌드 거부(`BlockedHandoffMissingDecisionError`, handoff-store.ts:71-92). 이유: 진행불가/방향전환 핸드오프가 "죽은 끝"만 남기면 절차 결정을 사용자에게 떠넘기는 것 — 구체적 선택지 + 에이전트의 현재 해석을 강제해 "결정할 것"을 넘기게 한다. `blocked`는 빌드-타임 입력일 뿐 영속 필드가 아니라(handoff-store.ts:50-57), 스키마는 statusless로 유지되어 옛 on-disk 핸드오프가 소급 거부되지 않는다.

### critical_decisions / irreversible_risks = 인라인 보존 (재호출 불가 tier)

재도출 불가능한 결정·위험은 rationale/why_irreversible을 **인라인**으로 담는다(포인터 아님, schemas/handoff.ts:53-78). charter §4-11(권위는 코드에 있다: drift할 문서 경로 대신 원문 내용을 직접 담는다)과 정합.

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

### `buildHandoff` / `buildSessionHandoff` (handoff-store.ts:94-169)

입력 → `handoffSchema.parse`로 검증된 `Handoff` 산출. work_item scope는 `original_intent`를 `workItem.source_request`에서 파생(94-121), session scope는 caller가 직접 전달(148-169). `buildHandoff`는 `guardBlockedHandoffDecision`을 먼저 호출해 blocked 무결성 강제. **효과:** 빈/무효 필드는 zod가 거부하고 CLI에서 exit 65 usage error로 표면화(handoff.ts:177-182).

### `collectChangedFiles` (work-item-handoff.ts:148-216)

입력 → `base...HEAD` 커밋 diff ∪ 명시 `declared` 선언. **작성자의 숨은 결정:** 워킹트리 `git status` 스캔은 **소스가 아니라 GUARD**다(wi_260719ayc). 공유 트리에서 외래 미커밋 dirt를 이 작업 변경과 구분 못 하므로, tracked working-tree 편집이 (커밋 diff ∪ 선언 ∪ baseline) 밖이면 `extraTrackedDirt`로 fail-closed시키되 `files`에 절대 fold하지 않는다(주석 84-98). `git diff`가 non-zero면 `diffErrored`로 표면화해 "변경 없음"으로 오판하지 않게 함(fail-closed). **이 코드 때문에** partial under-commit(커밋 A + 미커밋-미선언 tracked B)이 pass로 닫히지 못한다.

### `writeWorkItemHandoff` (work-item-handoff.ts:281-504)

입력(repoRoot, store, workId, options) → completion.json + 핸드오프 본문 + work item 상태 전이. 핵심 순서 의존성·가드:
- base ref 우선순위: `--base` 명시 > `started_at_sha` > `origin/main` > `origin/master` > `main` > `master`(290-304). 사용자 명시 ref는 silent fallback 안 함.
- **self-artifact union**(366-370): 핸드오프가 만드는 completion.json/work-item.json은 collect 직후 생성되어 첫 handoff의 git diff에 안 잡히므로 명시적으로 union. 단 핸드오프 본문 자체는 소비되면 archive로 이동하므로 changed_files에 안 넣는다(stale 경로 방지).
- **그래프 우선 AC verdict**(389-408): autopilot 그래프가 있으면 `deriveAcVerdicts`로 per-AC verdict를 그래프에서 파생 — `ditto autopilot complete`와 **같은 소스**를 써서 re-handoff가 그래프 기반 pass를 stale work-item-AC partial로 덮어쓰지 못하게 함(gate↔score 일치).
- **pass 시 terminal은 `store.close`로만**(470-489): 직접 `status:'done'` write 대신 단일 R1 chokepoint를 거쳐 first-terminal-wins·silent-overwrite 가드를 통과. 이미 done이면 close 생략(멱등 re-handoff).

### `HandoffStore.writeRemote` (handoff-store.ts:549-607)

입력(Handoff) → 브랜치 커밋(NO push). 순서: author-slug/scope-key charset 검증(assertSafeKey — `-` 시작·경로구분자·`..`·NUL 거부, git 옵션 주입 방어) → 타깃 브랜치 검증(detached/mismatch면 `HandoffRemoteWriteError` throw) → gitignored 경로면 거부(git add silent no-op 방지) → fail-closed 스크럽 → `git add`/`commit`. `runGit`(428-450)은 `.git/index.lock` 잠금 시에만 재시도해 동시 생산자 직렬화. **효과:** 잘못된 브랜치에 착지하거나 silent-fail로 미전달되는 경로를 전부 표면화한다(한 방 쓰기라 GC 재시도 없음).

### `listActiveDetailed` / `listRemote` (handoff-store.ts:628-660, 741-774)

디렉터리 top-level `.md`만 순회(archive/·consumed/ 서브디렉터리·비-.md 스킵). 파싱 실패는 `failures`로 수집해 **표면화**(ac-3, silent drop 금지). `listRemote`는 per-recipient 소비 마커가 있는 파일을 제외. **효과:** `list`가 유일 발견 채널이라 파싱 실패한 세션 핸드오프도 조용히 사라지지 않는다.

### `sweepStaleActive` (handoff-store.ts:850-893)

7일 초과 active 파일을 archive로 **이동(삭제 아님)**. **content-blind**(WS-HND-T1): staleness를 파싱한 `created_at`이 아니라 filesystem mtime으로 판단 — malformed/비-WI 파일도 age로 은퇴시킨다(과거 버그: 파싱 실패가 sweep을 면제시켜 무한 재주입). valid면 scope-키 아카이브명, malformed면 자기 basename stem으로 아카이브(무손실). fail-open(rename 실패는 다음 턴으로).

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위: 위 6개 파일 + ADR-20260714 + 관련 스키마. 정적 읽기만 수행(테스트 미실행 — 이 문서는 읽기 전용 조사).

- **pull-only 불변식:** 코드상 auto-inject 경로 없음. PreCompact는 `write`만 호출(pre-compact.ts:49). `list`/`consume`/`show`/`--show`가 유일 로드 경로. **일치.**
- **soft-consume:** `consumeFor`/`consumeRemote` 모두 파일 이동/삭제 없이 마커만 기록. **일치.**
- **REMOTE never-push:** `writeRemote`에 push 호출 없음. `add`/`commit`/`rev-parse`만. **일치.**
- **갭 — `ditto work handoff`는 `--changed`(declaredChanged)를 배선하지 않는다.** `writeWorkItemHandoff`는 `declaredChanged` 옵션을 받지만(work-item-handoff.ts:41,318), work handoff CLI run()은 `base/head/declaredBy`만 전달(work.ts:1852-1856). `--changed` 명시 선언 경로는 `ditto work done`에만 배선됨(work.ts:2246+, grep 확인). 따라서 `ditto work handoff`로 핸드오프를 만들 때 커밋 안 된 변경은 `--changed`로 선언할 수단이 없고, `extraTrackedDirt`/"changed_files not recorded"로 fail-closed되어 `failed_or_unverified`에 기록될 수 있다. 이것이 의도된 제약인지 미배선 갭인지는 **미확인**(코드 주석은 done 경로만 언급).
- **session 핸드오프의 sweep 상호작용 미확인:** `sweepStaleActive`는 `writeWorkItemHandoff`에서만 호출(work-item-handoff.ts:463). `ditto handoff write`(session)는 sweep을 트리거하지 않는다 — session 핸드오프의 7일 초과 정리가 언제 일어나는지는 다른 호출자에 의존. **미확인**(session-only 워크플로에서 sweep 트리거 부재 가능성).

## 7. 잠재 위험·부작용·재설계 시 고려점

- **REMOTE tier 브랜치 churn:** per-scope+author 분리 파일을 작업 브랜치에 커밋하므로 머지 충돌·히스토리 오염 부담이 커질 수 있다. ADR-20260714 change_condition에 "churn이 부담되면 커밋 경계 재검토(요약만 커밋·본문 외부 링크)"로 이미 표시됨.
- **소비 마커의 recipient 정체성 = git identity(`user.email`→`user.name`, 없으면 `anon`).** 동일 머신에서 여러 사람이 같은 git identity를 쓰면 한 사람의 소비가 다른 사람의 것으로 기록될 수 있다(handoff-store.ts:211-222, 797-801). 다중 사용자 환경에서 recipient 격리가 약함.
- **content-blind sweep은 mtime 의존.** git checkout/clone이 mtime을 리셋하면 오래된 핸드오프가 "새것"으로 보여 sweep을 늦게 만들거나, 반대로 갓 만든 파일이 이른 mtime이면 조기 은퇴할 수 있다. REMOTE tier는 sweep 밖이라 무관하나 LOCAL은 영향받음.
- **재설계 시 반드시 보존할 불변식:** ① auto-inject 금지(pull-only) — 이걸 깨면 §4-9 context rot 재발. ② soft-consume(파일 안 지움) + age-sweep이 유일 하드 정리 — 재개 실패 시 손실 방지. ③ REMOTE는 gitignored 밖 + never-push + fail-closed 스크럽 — 하나라도 어기면 silent-fail 또는 비밀 영구 유출. ④ changed_files 워킹트리는 소스 아닌 GUARD(외래 dirt 오염 차단, wi_260719ayc). ⑤ blocked→user_decision_block 강제.
- **재고 가능한 결정:** REMOTE 전송 매체(현재 git-tracked 파일). ADR-20260714 change_condition에 "GitHub 이슈 코멘트/Projects나 외부 메시지 버스로 이전 시 재검토"로 명시 — 그 경우 스크럽·per-recipient 마커 제약도 새 매체 기준 재정의.
- **scope kind는 딱 둘(work_item·session)로 잠금**(schemas/handoff.ts:15 "no speculative scope kinds"). 새 scope(예: org·cross-repo) 추가는 discriminated union 확장 + 라우팅/아카이브 키(`archiveKeyForScope`, `scopeKey`)·remote stem 규칙 동시 변경 필요.
