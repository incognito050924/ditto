# ADR-20260706-work-item-record-run-split: work-item 상태를 Record(공유·커밋)와 Run(개인·폐기가능) 2-tier로 분할 — ADR-0012 D1 부분 supersede

- 상태: accepted
- 결정 일자: 2026-07-06
- 결정자: hskim, claude (claude-opus-4-8)
- 관련: ADR-0012 (제품/프로젝트전역/개인 3계층 격리 — **D1 "개인 런타임 = work-items 전부 `.ditto/local/`"만 부분 supersede**; D2 gitignore 집행·D3 `dist/plugin` 배포조립·3계층 격리 골격은 불변), ADR-20260628-append-decision-atomicity (per-event append-only single-writer 원자성 — 이 ADR의 이벤트 로그 모델이 그 change_condition (b) multi-writer 논거를 상속), ADR-0005 (런타임 산출물 저장 — archive는 move-not-delete). 코드(권위): `src/core/work-item-store.ts`(`reduceWorkItem`·`appendEvent`(`open(wx)`)·`isTerminalStatus`·`compareWorkItemEvents`·`archive` → `work-items-archive`), `src/core/ditto-paths.ts`(`committedWorkItemDir`·`localDir`·`dittoDir`), `src/schemas/work-item.ts`(`evidence_required`·`source_digest` tier 배치). 구현 WI: wi_2607069bk (WS0-T0).

## 컨텍스트

ADR-0012 D1은 개인 런타임 자산 전부(work-items·runs·sessions·cache·logs·worktrees·handoff)를 `.ditto/local/` 한 구획으로 물리 분리했다. 그 결정에서 **work-item은 통째로 "개인 트레일"로 분류**되어 gitignore되었다 — 즉 work item의 상태(status, AC verdict, github 멱등 키)가 개발자·머신마다 로컬에만 남고 팀과 공유되지 않았다.

그러나 사용자는 backlog §7에서 두 가지를 결정했다: **Q1 = 공유되는 커밋된 백로그를 원한다**(어느 PC·팀원이든 진행 중인 work item과 그 완료 상태를 본다), **Q2 = work item을 스키마 수준에서 분할**한다(전부-로컬도, 전부-커밋도 아닌 필드별 tier 분리). 이 요구는 ADR-0012 D1의 "work-item = 전부 개인 tier" 레코드를 **stale**로 만든다 — ADR-0020 가드레일이 요구하는, 추론 시점에 드러나야 할 결정-충돌이다.

## 결정

work-item 상태를 두 tier로 세분한다:

- **Record (커밋·공유·git-tracked)** — `.ditto/work-items/<id>/` = `record.json`(저작 필드: AC 멤버십·scope·`evidence_required`) + `events/`(전이당 불변 이벤트 파일). 프로젝트 메모리(status, AC verdict, github 멱등)는 **durable하게 커밋된 Record**에 산다. 팀·다른 PC가 이 Record를 pull해 진행 상태를 본다.
- **Run (개인·폐기가능·gitignored)** — `.ditto/local/work-items/<id>/` = reduced view 미러 + 실행 트레일(intent.json·runs·graph 등). Run은 언제든 삭제 가능하고, **삭제해도 Record는 살아남는다**(ac-2 capstone이 Run-delete 무손실을 실증).

**상태 전이 = per-event 불변 로그.** 전이는 `appendEvent`가 `open(wx)`(배타 생성, 불변, TOCTOU 없음)로 이벤트당 파일을 append하고, `reduceWorkItem`이 접는다: event_id로 dedupe → (seq, actor, event_id) 결정적 정렬(`ts`는 clock-skew-unsafe라 정렬 키 아님) → kind별 fold. status는 **terminal-first-wins**(done/abandoned는 배타적 — 경쟁하는 2번째 terminal은 R1 배타성으로 거부, 비-terminal reopen만 정당한 재진입), 나머지는 latest-wins. **하이브리드 모델**(pre-mortem Finding D): 저작 필드는 `record.json`, 전이는 `events/`.

**R7 required-version 바닥(공유-레포 팀 주의).** 이 WI가 처음으로 work-item Record를 커밋·공유로 만든다. 분할 이전을 예상하고 만든 **구버전 ditto 바이너리는 blind-but-safe** — `.ditto/local/`만 읽고 커밋된 Record base(`.ditto/work-items/`)를 무시한다(**조정 손실**이지 손상 아님). 공유-레포 팀원은 커밋된 Record tier를 이해하는 ditto 버전 이상이어야 커밋된(로컬에 없는) work item을 본다. 이건 이 supersede 결정과 같은 결정 표면이다.

## 근거 (rationale)

- Q1(공유 백로그)은 상태가 커밋되어야만 성립하고, Q2(스키마 수준 분할)는 "무엇이 durable하고 무엇이 폐기가능한가"를 필드 단위로 가른다 — Record/Run 2-tier가 정확히 그 축이다. 전부-커밋은 개인 실행 트레일(runs·session)까지 팀에 새게 하고, 전부-로컬(옛 D1)은 공유 백로그를 불가능하게 한다.
- per-event 불변 로그 + terminal-first-wins는 다중 표면(autopilot·work CLI·github fold)이 같은 Record를 쓸 때 조용한 상태 revive를 막는다. append-only single-writer가 충분하다는 논거는 ADR-20260628의 change_condition (b) multi-writer를 그대로 상속한다 — 파일 락 없이 `open(wx)` 배타 생성으로 원자성을 얻는다.
- 하이브리드(record.json 저작 필드 + events/ 전이)는 전부-이벤트-소싱(저작 필드까지 매번 재생)의 비용과 전부-가변-레코드(전이 감사 불가)의 위험 사이 절충이다(pre-mortem Finding D).
- Run 삭제 무손실은 개인 트레일을 언제든 청소해도 프로젝트 메모리가 살아남게 해, ADR-0005 durable/ephemeral 경계를 work-item 내부까지 밀어 넣는다.

## 변경 조건 (change_condition)

- 커밋된 work-item Record의 churn이 실사용에서 **머지 충돌 부담**이 되면(예: 동시 다수 개발자가 같은 Record를 자주 갱신) → Record tier의 커밋 경계를 재검토(status만 커밋·verdict는 Run 등으로 필드 재배치). per-event 불변 로그는 라인 단위 머지에 유리하나, 실측 부담이 이를 부정하면 재고.
- 공유-백로그 요구(Q1)가 철회되면(개인 백로그로 충분) → Record tier를 옛 ADR-0012 D1(전부-로컬)로 되돌릴 수 있다.
- R7 구버전-blind 조정 손실이 실사용에서 반복 사고를 내면 → 커밋된 Record base에 required-version 바닥을 명시 기입하고 구버전 바이너리가 loud-fail하도록 게이트.

## ADR-0012 D1과의 관계 (부분 supersede)

> **부분 supersede (2026-07-22, wi_260722g7h)** — 이 ADR의 "handoff = 개인/gitignored tier, 불변" 분류 **한 줄만** **ADR-20260722-handoff-hidden-ref-baton**이 supersede한다(ADR-20260714-handoff-remote-committed-tier가 가졌던 좁은 supersede를 승계 — 그 ADR 자체는 전체 superseded). 핸드오프는 이제 개인 gitignored 파일이 아니라 숨은 ref `refs/ditto/handoffs`의 소멸성 바통이다. 이 ADR의 Record/Run 2-tier 분할·per-event 불변 로그·terminal-first-wins·하이브리드 모델은 전부 불변.

이 ADR은 ADR-0012 **D1의 "work-items를 개인 tier로 전부 `.ditto/local/`에 둔다"는 부분만** supersede한다. ADR-0012의 나머지 — 3계층 격리 골격, D2(gitignore 3계층 집행), D3(`dist/plugin` 배포조립), 그리고 runs·sessions·cache·logs·worktrees·handoff가 개인 tier라는 분류 — 는 **전부 불변**이다. work-item만 Record(커밋)/Run(로컬)로 쪼개진다.
