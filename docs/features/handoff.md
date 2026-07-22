# handoff — 사용자-발의 1:1 소멸성 바통: 숨은 ref 위의 "같은 작업을 이어받을 최소 컨텍스트" 전달 장치

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준 커밋 `5f94ffe` (2026-07-23), 브랜치 `rebuild/foundation`. 이 문서는 wi_260722g7h의 바통 재설계(ADR-20260722-handoff-hidden-ref-baton) 이후의 코드를 기술하며, 이전 2-tier 파일 스토어 문서를 전면 대체한다.

## 1. 이 기능이 실현하려는 설계 의도 (개념)

핸드오프는 **사용자-발의 1:1 소멸성 바통(baton)**이다: 압축된 컨텍스트 + 목적지(다음이 확인할 첫 항목) + 현재 상태를 담아, 같은 작업을 이어받을 다음 세션/에이전트/PC에게 넘기는 인계 산출물. charter §4-9(요청 경계에서 handoff로 reset)와 §4-12(확정된 의도를 그대로 보존해 운반)의 실행체라는 점은 불변이지만, 저장·전송·소비 모델은 ADR-20260722가 전면 재정의했다:

- **사용자-발의 전용.** 핸드오프 작성은 사용자가 직접 의사를 밝힌 때만 일어난다. PreCompact 자동 저장은 제거됐고(`src/hooks/pre-compact.ts:12-14` 의도적 no-op), 비-pass 종료도 핸드오프를 자동 발행하지 않는다 — 자동 생산된 핸드오프는 정의상 핸드오프가 아니다(ADR-20260722 결정 1).
- **단일 저장소 = 숨은 ref `refs/ditto/handoffs`.** 바통은 그 ref 위의 커밋이다. 워킹트리 파일 없음, 브랜치 커밋 없음, `git branch`에 안 보임(`src/core/handoff-ref-store.ts:12-18`). 로컬 gitignored 파일 + 브랜치 커밋 파일의 2-tier 병존은 폐기됐다.
- **소비 = 삭제.** consume은 본문을 딱 한 번 돌려주고 삭제 커밋을 쌓는다. 동시 소비는 first-consumer-wins CAS로 한 명만 이긴다(`handoff-ref-store.ts:198-239`). 목록화(inbox)·보관(archive)·청소(sweep)·수신자별 소비 마커는 바통 모델에서 존재 이유를 잃어 전부 제거됐다(ADR-20260722 결정 5).
- **채점·완료와 무결합.** 상태 전이·채점은 오직 `ditto work done`의 소관이다(ADR-20260722 결정 4). `ditto work`에는 더 이상 핸드오프 서브커맨드가 없다.
- **refs/ditto/* 한정 auto push/fetch.** write/consume이 origin과 자동 동기화한다. §4-8의 push user-gate는 ADR-20260722의 **상시허가**(refs/ditto/*만·origin만·바통 push/삭제 push/보존 truncation push 3행위만)가 durable 기록으로 충족한다.

## 2. 코드 위치와 진입점

| 경로 | 역할 |
| --- | --- |
| `src/cli/commands/handoff.ts` | `ditto handoff` 진입점. `write`/`consume`/`show` 3개 서브커맨드(순수 그룹, `:574-578`). **`list` 서브커맨드는 없다** — consume/show의 다중-대기 명확화 출력이 발견 표면이다(`:45-49`). |
| `src/core/handoff-ref-store.ts` | 숨은 ref 스토어. git plumbing(hash-object/mktree/commit-tree/update-ref)으로 바통 커밋을 쌓고(write), CAS로 삭제 커밋을 쌓는다(consume). 원격 접촉 없음(로컬 전용, `:27-29`). |
| `src/core/handoff-ref-sync.ts` | refs/ditto/* 한정 auto push/fetch 계층. 스크럽 게이트, 오프라인 강등, 보존한도 truncation, purge 회수 경로. CLI에서만 호출 — 훅/autopilot tick에서는 절대 호출 안 됨(`:12-15`). |
| `src/core/handoff-store.ts` | (잔존 헬퍼 소스) 바통 직렬화·파싱(`parseHandoffFile`)·렌더(`renderHandoff`)·scope 키·author slug·커밋 전 스크럽(`scrubHandoffForCommit`)을 ref 스토어가 재사용한다(`handoff-ref-store.ts:1-9` import). |
| `src/schemas/handoff.ts` | zod 스키마(SoT, ADR-0002). scope discriminated union(work_item·session) + 바통 필드. |
| `src/hooks/pre-compact.ts` | **의도적 no-op**(`:12-14`) — compaction은 더 이상 핸드오프를 생산하지 않는다. 훅 바인딩만 관측용으로 유지. |

### `ditto handoff` 서브커맨드 (handoff.ts)

| 서브커맨드 | 인자 | 하는 일 |
| --- | --- | --- |
| `write` | 필수: `--intent --from --state --next`(누락 시 exit 65, `:297-310`). scope: `--work-item` 또는 `--session`(생략 시 생성, `:52-56`). rich 반복 플래그: `--decision`(`:239`) `--critical "decision::rationale"`(`:244`) `--risk "risk::why"`(`:250`) `--open`(`:255`) `--forbid`(`:260`) `--evidence`(`:265`) `--changed`(`:270`). 기타: `--autopilot`(`:234`) `--push-public`(`:275`) `--output` | 바통을 숨은 ref에 커밋(`HandoffRefStore.write`, `:323`)하고 auto-sync(`:329`). |
| `consume [id]` | `id` positional 선택(`:482-485`), `--push-public`, `--output` | id 없으면 대기 1건 자동 해석; 여러 건이면 대기 목록 출력 + exit 65(프롬프트 아님, `:378-401`); 0건이면 "No pending handoff batons." 본문은 삭제 커밋 CAS 성공 후에만 반환(first-consumer-wins). CAS 패자는 `not_found`와 **구별되는** `already_consumed` 거절(`:438-450`). 삭제 커밋을 본문 출력 **전에** push해 온라인 소비를 원격에 확정(`:451-455`). |
| `show [id]` | `id` positional 선택, `--output` | ref tip의 읽기 전용 조회 — 삭제 없음, 마커 없음, sync 없음(`:549-563`). id 해석은 consume과 동일. |

모든 서브커맨드는 끝에서 pending-unpushed 경고를 재표면화한다(`warnPendingUnpushed`, `:145-152`) — 미push 바통 상태가 조용히 스크롤아웃되지 않게.

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

### write 흐름

```
--intent/--from/--state/--next (필수 검증, 누락 → exit 65)          [handoff.ts:297-310]
  → buildBatonFromFlags: rich 플래그 → 스키마 필드 매핑 + zod 검증   [:155-195]
  → HandoffRefStore.write:
      키 가드(tree-entry 주입 방어 assertSafeRefTreeName)            [handoff-ref-store.ts:108-116]
      → fail-closed 토큰 스크럽 (첫 git object 생성 전 — object DB는 비가역) [:175-176]
      → hash-object → mktree → commit-tree → update-ref CAS(패배 시 tip 재독 후 재구축, 한도 3회) [:178-195]
  → runAutoSync('write'): gh repo view로 visibility 해석(불명 → 'unknown') → syncHandoffRef [handoff.ts:92-138]
  → warnPendingUnpushed                                              [:345]
```

### consume 흐름

```
[id 없음] store.list()로 대기 집합 → 1건 자동 해석 / 여러 건 목록+exit 65 / 0건 종료 [handoff.ts:378-401]
  → HandoffRefStore.consume(stem):
      tip tree에서 entry 탐색; 부재 시 ref 히스토리로 구분:
        한때 존재 → already_consumed (멱등 거절) / 애초 없음 → not_found  [handoff-ref-store.ts:209-219, everTouched :349-351]
      → 본문 파싱 + 스키마 재검증 → 삭제 커밋 → update-ref CAS
      → CAS 성공 후에만 body 반환 (first-consumer-wins)               [:220-233]
  → runAutoSync('consume'): 삭제 커밋 push를 본문 출력 전에 시도       [handoff.ts:451-455]
  → 본문 출력 → warnPendingUnpushed
```

### sync 흐름 (`syncHandoffRef`, handoff-ref-sync.ts:753-925)

```
visibility 게이트 (fail-closed: 'private' 증명 or --push-public 옵트인만 통과, 'unknown'=public 취급) [:819-832]
  → fetch-first (원격 바통 흡수 + lease 기준 sha 관측)                 [:834-848]
  → applyReconcile: tree-수준 재병합 (커밋-그래프 merge 아님)          [:458-505]
  → push 루프 (한도 SYNC_MAX_RETRIES=3):
      매 시도 전 스크럽 스캔 (detect-and-refuse)                      [:862-864]
      → push; non-ff면 재fetch+재병합+재시도, 그 외 실패는 클래스 보존 강등 [:866-913]
  → 보존한도 truncation (push 시점, 원격이 보유한 tip에서만)           [:921-923]
```

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

### 숨은 ref = 세 비용의 동시 제거 (ADR-20260722)

이전 모델(작업 브랜치 커밋)의 비용 — 코드 히스토리 churn, 코드 push 편승, 브랜치-스코핑(브랜치를 이어받지 않으면 도달 불가) — 을 `refs/heads` 밖의 ref 하나가 동시에 없앤다. git이 이미 제공하는 전송(fetch/push)·원자성(update-ref CAS)·무결성(커밋 해시)을 그대로 쓰므로 새 인프라가 0이다. ref는 per-repo라 linked worktree 전체가 같은 바통을 공유한다(`handoff-ref-store.ts:16-18`).

### first-consumer-wins CAS = 1:1 의미의 집행 — 단, 정직한 경계

바통은 한 명이 받는다. 그 보장의 실제 수준(코드가 집행하는 그대로):

- **단일 repo(그 repo의 모든 worktree) 안에서는 원자적.** `update-ref <ref> <new> <expected-old>` CAS로 첫 소비자만 성공하고, 패자는 재독 후 entry 부재를 발견해 `already_consumed`로 멱등 거절된다(`handoff-ref-store.ts:20-23, 205-239`).
- **cross-PC는 online-first-push-wins.** 온라인 소비는 삭제 커밋을 본문 출력 전에 push해 원격에 확정한다(`handoff.ts:451-455`, `handoff-ref-sync.ts:46-48`). **오프라인 창에서는 중복 전달이 가능하다**: 오프라인 소비는 로컬 성공 + "원격 바통이 아직 존재하므로 다른 PC가 소비할 수 있다(re-consume window open)"는 경고를 낸다(`handoff-ref-sync.ts:258-261`). 보장은 **at-most-duplicated, never lost** — 무손실이지만 오프라인 창을 가로질러 엄밀한 1:1은 아니며, 그 사실이 경고로 노출된다. 이중소비의 수렴은 tree-수준 재병합에서 삭제(CAS 승자) 쪽으로 정리된다(`:44-45, 458-488`).

### 자동 sync와 push 상시허가 (§4-8 경계)

push는 user-gated 비가역인데 write/consume이 건별 확인 없이 push한다 — 이것이 성립하는 근거는 ADR-20260722의 **durable 상시허가**다: 범위는 refs/ditto/*만·대상은 origin만·행위는 ① 바통 push ② 삭제 push ③ 보존 truncation push 3개만. 코드는 이 경계를 fail-closed로 집행한다: `assertDittoPushRefspec`이 **모든** push/fetch 서브프로세스 직전에 실행되어 원격 측이 refs/ditto/* 밖이면 throw(`handoff-ref-sync.ts:183-197`), force는 `--force-with-lease` + `refs/ditto/handoffs` 하드코딩 헬퍼(`forcePushTruncated`, `:645-664`)에만 존재한다(모듈 내 plain force 0 — 테스트가 소스를 grep).

### visibility 게이트 fail-closed (`--push-public` 옵트인)

커스텀 ref는 repo를 읽을 수 있는 누구나 ls-remote로 보고 fetch할 수 있고, 이미 push된 히스토리는 회수 불가 — 그래서 repo visibility가 곧 바통 가독 범위다. auto-push는 'private'이 **증명**될 때만 허용되고, 'unknown'은 public처럼 거절된다(`handoff-ref-sync.ts:63-67, 819-832`). visibility는 CLI가 `gh repo view`로 해석하며 gh 부재/비GitHub remote는 'unknown'으로 강등된다(`handoff.ts:87-108`). `--push-public`이 명시 옵트인이다(`:275-280`).

### 스크럽 2중 fail-closed

① 스토어가 첫 git object 생성 **전에** 본문을 토큰 스크럽한다(object DB는 비가역, `handoff-ref-store.ts:31-34, 175-176`). ② push 게이트는 전송될 모든 blob을 TOKEN_PATTERNS + 고엔트로피 휴리스틱으로 스캔해 **detect-and-refuse**한다 — scrub-and-proceed가 아니라 거부이며, 스캔 실패도 fail-closed다(`handoff-ref-sync.ts:22-28, 507-549, 789-810`). 단 blacklist 기반이므로 못 잡는 형태의 비밀은 origin에 오를 수 있다 — 이 잔여 위험은 ADR-20260722에서 사용자가 수용을 명기했고, 회수 절차(purge)가 그 보완이다.

### 오프라인 = 로컬 성공 + 시끄러운 경고 + 다음 커맨드 재시도

로컬 작업은 항상 성공한다. push/fetch 실패는 클래스를 **보존**한 채(offline / 영속 auth의 구별된 자격증명 경고 / non-ff / other) 경고 + jsonl 로그(`.ditto/local/logs/handoff-sync.jsonl`)로 강등되고 다음 handoff 커맨드에서 재시도된다(`handoff-ref-sync.ts:29-36, 242-272`). 로컬 북키핑 ref(`refs/ditto/sync/handoffs-pushed`, push 안 됨)와 대조해 **모든** handoff 커맨드 끝에서 pending-unpushed 경고를 반복 재표면화한다(`:558-573`, `handoff.ts:145-152`) — 일회성 콘솔 경고는 스크롤아웃되기 때문.

### 보존 = max(7일, 50커밋) + tip-tree 불변식

push 시점에 ref 히스토리를 max(7일, 50커밋)로 truncation한다(`handoff-ref-sync.ts:89-91, 581-599`). 잘리는 것은 뒤쪽 히스토리뿐 — 재구축 체인은 커밋별 tree·identity·날짜를 보존하고, **tip tree가 바뀌면 assert로 push 자체가 불가**하므로 대기 중인 바통은 항상 생존한다(`:607-635`). push는 fetch로 관측한 원격 sha에 lease-고정된 조건부 force뿐이고, 로컬 ref는 원격 수락 **후에만** 플립된다(`:674-742`).

### 미검출 토큰 회수 경로 (purge)

이미 sync된 비밀의 회수: 유출 바통을 먼저 consume/재작성한 뒤 `purgeHandoffHistory`(`handoff-ref-sync.ts:934-1010`)가 로컬 히스토리 전체를 현재 tip tree를 담은 단일 root 커밋으로 재작성하고 lease-push한다 — 유출 blob이 원격 히스토리에서 unreachable해진다(원격 GC 대상). 새 root 자체도 스크럽 게이트를 통과해야 하므로 더러운 tree는 purge-push될 수 없다. 현재 CLI 표면은 없고 core 함수만 존재한다(호출자 없음 — 수동 회수 절차용).

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

### `assertSafeRefTreeName` (handoff-ref-store.ts:100-116)

session_id는 charset 잠금이 없는 자유텍스트인데 mktree의 라인 포맷은 `<mode> <type> <sha>\t<name>\n`이다 — 개행/탭이 들어가면 tree-entry 주입이 된다. 기존 파일 스토어의 assertSafeKey는 개행·탭을 안 막았으므로 별도 가드를 둔다: 빈 값, 선행 `-`(옵션 주입), 경로구분자, `..`, NUL, 개행, 탭 거부. **효과:** mktree/commit-tree에 도달하기 전에 주입이 차단된다(입력은 `-z` NUL-종결로만 전달, `:330-334`).

### `classifyUpdateRefFailure` (handoff-ref-store.ts:119-135)

update-ref 실패를 3분류: cas_loss(expected-old 불일치 — tip 재독 후 재구축으로 회복), lock_contention(`<ref>.lock` 경합 — 백오프 후 같은 update-ref 재시도, 한도 5회), error(즉시 표면화). 기존 runGit의 index.lock 정규식은 ref lock을 안 덮으므로 별도 분류다. **효과:** 동시 생산자/소비자가 서로를 깨뜨리지 않고 직렬화되며, 진짜 오류는 조용히 재시도되지 않는다.

### `computeReconcileTarget` (handoff-ref-sync.ts:445-488)

분기된(truncation 후 unrelated일 수도 있는) 로컬/원격 tip의 **tree-수준** 재병합. entry별로: 양쪽 동일 blob → 유지; 양쪽 다른 blob → 상대 blob을 히스토리에 가진 쪽이 supersede(동률이면 원격 CAS 승자); 로컬에만 → 원격 히스토리가 그 blob을 봤으면 드롭(원격 소비 승리), 아니면 재적용(미전송 write 생존); 원격에만 → 대칭. 결과 커밋의 **유일한 부모는 원격 tip** — 로컬 커밋은 내용으로만 재생되고 링크로 재도입되지 않으므로, truncation으로 잘린 히스토리가 되살아나지 않는다. **효과:** "at-most-duplicated, never lost" — 삭제는 CAS 승자로 수렴하고, 못 본 바통은 절대 유실되지 않는다.

### `resolvePendingStem` (handoff.ts:372-401)

id 없는 consume/show의 공유 해석기: 대기 1건 → 그 stem, 0건 → 메시지 후 정상 종료(exit 0), 여러 건 → 대기 집합 출력 + exit 65. 파싱 불가 entry는 드롭되지 않고 표면화된다(`:384-386`). **효과:** "재개하면 consume 한 번"이라는 단일 플로우가 성립하고, 다중-대기의 명확화 출력이 별도 목록 커맨드 없이 발견 표면을 겸한다(프롬프트로 멈추지 않음 — exit 65).

### `runRetention` (handoff-ref-sync.ts:674-742)

truncation은 push 거부에 의존하지 않는다(force는 거부되지 않으므로): 원격이 보유한 것으로 **관측된** tip에서만 실행하고, lease 거부(non-ff)면 재fetch+재병합+재계산(한도 내), 그 외 실패는 로그+경고로 **연기**(sync 자체를 죽이지 않음). 로컬 ref 플립은 원격 수락 후에만. **효과:** 경쟁 writer가 있어도 반-truncation 상태가 관측되지 않는다.

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위: `src/cli/commands/handoff.ts`, `src/core/handoff-ref-store.ts`, `src/core/handoff-ref-sync.ts`, `src/hooks/pre-compact.ts`, ADR-20260722. 정적 읽기 기반(이 문서는 코드 설명).

- **사용자-발의 전용:** CLI write만이 바통 생산 경로. PreCompact는 no-op(`pre-compact.ts:12-14`), `ditto work`의 서브커맨드 목록(`work.ts:3376-3393`)에 핸드오프 없음. **일치.**
- **consume=삭제, first-consumer-wins:** 본문은 CAS 성공 후에만 반환(`handoff-ref-store.ts:229`), 패자는 `already_consumed`. **일치.**
- **refs/ditto/* 밖 push 불가:** 모든 push/fetch 직전 `assertDittoPushRefspec`, force는 하드코딩 헬퍼만. **일치.**
- **훅의 원격 접촉 없음:** sync 모듈 호출자는 handoff CLI뿐(모듈 주석 `:12-15` + import 확인). **일치.**
- **잔존 갭 — 구 파일 스토어(`handoff-store.ts`)의 `HandoffStore` 클래스가 아직 존재하고 일부 훅·core가 참조한다.** ref 스토어는 그 파일의 순수 헬퍼(직렬화·스크럽·slug)만 재사용한다(`handoff-ref-store.ts:1-9`). 구 스토어 본체와 잔여 참조의 제거는 wi_260722g7h의 별도 정리 범위다 — 이 문서 기준 시점에는 과도기 잔존.

## 7. 잠재 위험·부작용·재설계 시 고려점

- **public origin 잔여 노출(수용된 위험):** 바통은 rich 자유텍스트이고 스크럽은 blacklist 기반 — 못 잡는 비밀이 origin에 오를 수 있으며, tip-tree 불변식 때문에 tip에 남은 바통 내용은 보존기간과 무관하게 노출이 지속될 수 있다. ADR-20260722가 이 수용과 회수 절차(ref 삭제 push → 토큰 회전 → GitHub support)를 명기. 철회 조건: 유출 사고 시 원격 대상을 private/별도 remote로 재평가.
- **오프라인 창의 중복 전달:** 위 §4 — 무손실이지만 엄밀 1:1이 아니다. multi-consumer가 실제로 필요해지면 1:1 바통 모델 자체의 재검토가 ADR change_condition에 걸려 있다.
- **재설계 시 반드시 보존할 불변식:** ① 사용자-발의 전용(자동 생산 경로 재도입 금지 — 훅 auto-write는 §4-9 위반 이전에 ADR-20260722 결정 1 위반). ② 본문 반환은 삭제 CAS 성공 뒤에만(이걸 깨면 1:1이 조용히 broadcast가 된다). ③ refspec 가드 + force의 lease/prefix 격리(상시허가의 확대 해석 차단). ④ 스크럽 detect-and-refuse(스크럽-후-진행으로 바꾸면 게이트가 아니라 변환이 된다). ⑤ truncation tip-tree 불변식(깨면 대기 바통 유실). ⑥ 오프라인 로컬-성공 + 클래스 보존 경고(실패 클래스를 한 버킷으로 뭉개면 auth 문제가 영원히 "다음에 재시도"로 위장된다).
- **git-ref 전송 매체 교체 시:** 숨은 ref 저장·CAS 소비·push 상시허가 전부 재검토(상시허가는 매체에 결박 — 자동 승계 없음, ADR-20260722 change_condition).
