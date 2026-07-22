# ADR-20260714-handoff-remote-committed-tier: 원격 핸드오프는 작업 브랜치에 커밋(git-tracked), 로컬 핸드오프는 gitignored 유지 — ADR-20260706 handoff-tier 분류만 좁게 supersede

- 상태: superseded by ADR-20260722-handoff-hidden-ref-baton
- 결정 일자: 2026-07-14
- 결정자: hskim, claude (claude-opus-4-8)
- 관련: ADR-20260706-work-item-record-run-split (**"handoff = 개인/gitignored tier, 불변" 분류만 좁게 부분 supersede** — 그 Record/Run 분할·per-event 불변 로그·terminal-first-wins 결정은 전부 불변). ADR-0012 (3계층 격리 골격·D2 gitignore 집행 — 불변; 커밋 원격 핸드오프 경로는 개인 구획 `.ditto/local/` **밖**에 살아야 D2 집행과 모순 없이 git-tracked가 된다). 헌장 §4-8 (commit/push는 사용자-게이트 비가역 — 커밋된 원격 핸드오프 정리는 이 경계를 넘지 않는다). 코드(권위): `skills/handoff/SKILL.md`(현재 원격 핸드오프 = 루트 단일 HANDOFF.md 덮어쓰기 수동 절차), `src/core/handoff-store.ts`(로컬 store WI-키 라우팅·현재 원격 코드 0), `src/schemas/handoff.ts`(handoff 스키마 SoT). 촉발 WI: wi_260714xpw (handoff 재설계, ac-4).

## 컨텍스트

ADR-20260706은 work-item 상태를 Record(커밋·공유)와 Run(개인·gitignored)로 쪼개면서, ADR-0012의 개인-tier 분류 목록 중 runs·sessions·cache·logs·worktrees와 **함께 handoff를 "개인 tier, 불변"으로 재확인**했다. 즉 핸드오프는 전부 gitignored 로컬 자산이라는 것이 현재 기록된 결정이다.

그러나 핸드오프의 실제 의미는 **same-branch targeted 연속**이다 — 작업 도중의 컨텍스트를 그 작업의 브랜치를 이어받는 다음 세션·작업자에게 넘긴다. 현재 원격 핸드오프는 코드가 아니라 저장소 루트 단일 `HANDOFF.md`를 매번 덮어쓰는 수동 절차라, 여러 명이 동시에 작업하면 그 하나의 공유 파일에서 서로를 덮어쓴다(분리·귀속·무손실 실패). 원격 핸드오프가 이어받는 사람에게 브랜치와 함께 도달하려면 **그 본문·포인터가 작업 브랜치에 git-tracked로 커밋**되어야 한다. 이 요구는 ADR-20260706의 "handoff = gitignored 개인 tier, 불변" 분류를 **stale**로 만든다 — ADR-0020 가드레일이 요구하는, 추론 시점에 드러나야 할 결정-충돌이다.

## 결정

핸드오프 tier를 아티팩트 도달 범위로 가른다:

- **원격 핸드오프 = 작업 브랜치에 커밋(git-tracked·공유).** 원격 핸드오프의 본문·포인터는 그 작업의 브랜치에 per-scope 분리 파일로 커밋된다. 그 브랜치를 fetch/checkout하는 수신자가 커밋된 파일로 본문·포인터를 함께 얻는다(same-branch 연속). 단일 공유 `HANDOFF.md` 덮어쓰기를 대체하므로 동시 다중 작성자가 서로를 덮어쓰지 않는다.
- **로컬 핸드오프 = gitignored 개인 유지(불변).** 로컬 핸드오프의 저장 키·충돌 모델·gitignored 분류는 그대로 둔다.

이 결정은 ADR-20260706의 **handoff-tier 분류("전부 개인/gitignored, 불변")만** 좁게 supersede한다. ADR-20260706의 Record/Run 2-tier 분할, per-event 불변 로그, terminal-first-wins, 하이브리드 저작-필드/이벤트 모델은 **전부 불변**이다. 여기서 바뀌는 것은 오직 "원격 핸드오프도 개인 tier에 갇혀 있다"는 한 줄뿐이다.

설계에서 상속하는 제약(이 ADR이 산문이 아니라 durable 결정이 되게 하는 받침):

- **커밋 경로는 gitignored `.ditto/local/` 구획 밖에 있어야 한다.** gitignored 경로에 쓰면 `git add`가 조용히 no-op이 되어(집행 성공처럼 보이나 아무것도 커밋되지 않음) 도달이 silent-fail한다. 커밋 대상 핸드오프는 tracked 경로에 산다.
- **커밋된 원격 핸드오프의 정리는 per-recipient 로컬 마커 전용 — git-delete·commit·push 금지(헌장 §4-8).** 이어받은 사람이 자기 로컬에 소비 마커만 남긴다. 공유 히스토리에서 지우거나(팀 전체 삭제) auto-commit/push하지 않는다. 히스토리 일괄 제거는 명시·범위 밖.
- **커밋 본문은 스크럽·최소화(요약+포인터) 한다.** git 히스토리는 비가역이라 비밀(토큰·gotcha)이 영구 남는다. 본문은 요약+포인터 지향, 기존 github-redaction 토큰 스크럽 재사용, 비밀 금지.

## 근거 (rationale)

- **same-branch 연속은 핸드오프가 브랜치와 함께 이동할 것을 요구한다.** 핸드오프는 broadcast(무관한 동료에게 뿌리기)가 아니라 "이 브랜치를 이어받는 사람에게" 넘기는 targeted 연속이다. 브랜치를 체크아웃하면 함께 오는 유일한 전송 매체는 그 브랜치에 커밋된 git-tracked 파일이다. gitignored 로컬 파일은 브랜치를 따라오지 않으므로 원격 도달을 못 한다.
- **단일 공유 gitignored `HANDOFF.md`는 동시 다중 작성자 원격 핸드오프를 감당할 수 없다.** 매번 덮어쓰는 하나의 파일은 두 작성자를 분리·귀속·무손실로 담을 수 없다. DITTO는 이미 git-tracked·`open(wx)` 배타·ts-비정렬 무충돌 multi-writer 채널(ADR-20260706 Record tier)을 갖고 있고, 원격 핸드오프를 per-scope 분리 파일로 그 브랜치에 커밋하면 같은 무충돌 성질을 얻는다.
- **좁은 supersede인 이유.** 바뀌는 사실은 "원격 핸드오프의 도달 범위"뿐이다. Record/Run 분할은 work-item 상태에 대한 결정이고 그대로 유효하다. 넓게 뒤집으면 멀쩡한 결정을 재검토 대상으로 오염시킨다.
- **기각된 대안 — 단일 공유 `HANDOFF.md` 유지(현행).** 기각. 동시 작성자가 서로를 덮어쓰고(무손실 실패), 귀속이 불가능하며, 애초에 gitignored라 원격 도달도 못 한다 — ac-4가 요구하는 fetch/checkout 수신을 성립시키지 못한다.
- **기각된 대안 — 핸드오프를 GitHub(이슈 코멘트/Projects)로 이전.** 기각(범위 밖). 전송 매체를 git-tracked 파일에서 GitHub API로 바꾸는 별개의 큰 결정이며, same-branch 연속이라는 의미와도 어긋난다.

## 변경 조건 (change_condition)

- **핸드오프 전송이 git-tracked 파일에서 벗어나면**(예: GitHub 이슈 코멘트/Projects, 또는 외부 메시지 버스로 이전) → "원격 = 브랜치 커밋" 결정은 그 전송 모델로 재검토한다. 그 경우 스크럽·per-recipient 마커 정리 제약도 새 매체 기준으로 다시 정의한다.
- **커밋된 원격 핸드오프의 브랜치 churn이 실사용에서 머지 충돌·히스토리 오염 부담이 되면** → 커밋 경계를 재검토(예: 요약만 커밋·본문은 외부 링크). ADR-20260706 Record tier와 동일한 재검토 표면을 공유한다.
- **원격 도달 요구(same-branch 커밋 전송)가 철회되면**(로컬 개인 핸드오프로 충분) → handoff를 옛 ADR-20260706 분류(전부 gitignored 개인 tier)로 되돌릴 수 있다.

## ADR-20260706과의 관계 (좁은 부분 supersede)

이 ADR은 ADR-20260706의 **"handoff = 개인/gitignored tier, 불변" 분류 한 줄만** supersede한다. ADR-20260706의 나머지 — Record/Run 2-tier 분할, per-event 불변 로그, terminal-first-wins, 하이브리드 모델, R7 required-version 바닥 — 는 전부 불변이며 ADR-20260706은 `accepted`로 남는다(ADR-0012 D1을 좁게 부분 supersede한 ADR-20260706 자신이 ADR-0012를 superseded로 뒤집지 않은 것과 같은 선례). 바뀌는 것은 오직 원격 핸드오프가 개인 tier를 벗어나 작업 브랜치에 커밋된다는 점이다.
