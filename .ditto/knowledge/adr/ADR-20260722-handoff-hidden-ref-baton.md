# ADR-20260722-handoff-hidden-ref-baton: 핸드오프 = 사용자-발의 1:1 소멸성 바통 — 단일 저장소 refs/ditto/handoffs 숨은 ref + first-consumer-wins CAS + refs/ditto/* 한정 push 상시허가

- 상태: accepted
- 결정 일자: 2026-07-22
- 결정자: hskim, claude (claude-opus-4-8)
- 관련: ADR-20260714-handoff-remote-committed-tier (**전체 SUPERSEDE** — "원격 핸드오프 = 작업 브랜치 커밋" 모델을 이 ADR이 대체한다. 그 상태 라인이 이 ADR을 가리킨다), ADR-20260706-work-item-record-run-split (**"handoff = 개인/gitignored tier" 분류 한 줄만 좁게 부분 supersede** — ADR-20260714가 가졌던 좁은 supersede를 이 ADR이 승계한다. Record/Run 2-tier 분할·per-event 불변 로그·terminal-first-wins는 전부 불변), ADR-0012 (disclosure — supersede 아님: D1 개인-tier 목록에서 `handoff/` 디렉터리가 사라진다. 핸드오프는 더 이상 워킹트리 파일이 아니므로 3계층 격리 골격·D2 gitignore 집행은 그대로 두고 목록만 한 항목 준다), ADR-0005 (D3 히스토리-재작성 금지와의 경계 — 본문 disclose 참조, ADR-0020 요건), 헌장 §4-8 (push = user-gated 비가역 — 아래 상시허가가 그 명시 허가의 durable 기록이다). 촉발 WI: wi_260722g7h (deep-interview에서 사용자 결정, 2026-07-22).

## 컨텍스트

ADR-20260714는 원격 핸드오프를 작업 브랜치에 git-tracked 파일로 커밋하는 모델을 세웠다. 실사용 검토(wi_260722g7h deep-interview)에서 이 모델의 비용이 드러났다: 브랜치 churn(핸드오프 커밋이 코드 히스토리에 섞임), push 노출(핸드오프가 코드 push에 편승), 브랜치-스코핑(브랜치를 이어받지 않는 수신자는 도달 불가), 그리고 두 저장소(로컬 gitignored + 원격 커밋)의 병존이 만드는 누적 — 사용자는 이 누적 자체를 거부했다. 또한 PreCompact 훅의 자동 핸드오프 저장에 대해 사용자가 의미 차원의 판정을 내렸다: **"핸드오프는 항상 사용자가 직접 의사를 밝혀야 하는 작업 … 자동 저장도 제거해"** — 자동 생산된 핸드오프는 정의상 핸드오프가 아니다. 이 요구들은 ADR-20260714 모델 전체를 stale로 만든다(ADR-0020이 요구하는, 추론 시점에 드러나야 할 결정-충돌).

## 결정

핸드오프를 **사용자-발의 1:1 소멸성 바통(baton)**으로 재정의하고, 저장·전송·소비를 다음과 같이 고정한다:

1. **사용자-발의 전용.** 핸드오프 작성은 사용자가 직접 의사를 밝힌 때만 일어난다. **PreCompact 자동 저장은 제거한다** — 자동 생산된 핸드오프는 정의상 핸드오프가 아니다.
2. **단일 저장소 = 숨은 ref `refs/ditto/handoffs`.** 같은 repo의 hidden ref 하나가 유일한 저장소다. 브랜치 없음, 워킹트리 파일 없음. 두 저장소(로컬 파일 + 원격 커밋) 병존은 폐기한다.
3. **쓰기 = 바통 커밋, 소비 = 읽기 + 삭제 커밋.** 핸드오프 작성은 그 ref에 바통 커밋을 쌓는 것이고, 소비는 읽은 뒤 삭제 커밋을 쌓는 것이다. 동시 소비 경쟁은 **first-consumer-wins**로 푼다 — CAS(compare-and-swap ref 갱신)로 첫 소비자만 성공하고 나머지는 실패한다.
4. **채점·완료와 무결합.** 핸드오프는 scoring/completion과 어떤 결합도 없다 — 상태 전이·채점은 오직 `work done`의 소관이다.
5. **list/archive/sweep/per-recipient 마커 제거.** 바통은 1:1 소멸성이므로 목록화·보관·청소·수신자별 소비 마커가 존재 이유를 잃는다. 전부 제거한다.
6. **보존 = max(7일, 50커밋)의 ref 히스토리.** push 시점에 이 한도로 truncation한다. **truncation은 ref tip의 tree를 절대 건드리지 않는다** — 잘리는 것은 뒤쪽 히스토리뿐이다.

## Push 상시허가 (§4-8 durable standing grant — 사용자 부여, 2026-07-22)

헌장 §4-8은 push를 user-gated 비가역으로 규정한다. wi_260722g7h deep-interview에서 사용자가 전체 설계 요약 위에 **"맞아 그대로 진행해"**로 다음의 **상시허가**를 부여했고, 이 ADR이 그 durable 기록이다:

- **범위: `refs/ditto/*`만, 대상: origin만, 건별 확인 없음.** 정확히 다음 세 행위만 커버한다: **① 바통 push ② 삭제-기록 push ③ 보존한도 truncation force-push.**
- **force는 `--force-with-lease` 한정**이며, **`refs/ditto/` prefix 격리 헬퍼 전용**으로만 실행된다 — 이 두 조건을 벗어난 force는 허가 밖이다.
- **코드 브랜치·태그는 절대 커버되지 않는다.** 어떤 해석으로도 이 허가를 코드 push의 근거로 쓸 수 없다.
- **PreCompact 시점 push 허가는 무효(VOID)다.** 그 생산자(PreCompact 자동 저장) 자체가 제거되었으므로, 과거 그 경로에 딸려 있던 push 허가는 소멸한다.

### 원격 대상 평가 (명시 결정)

`refs/ditto/*`의 auto-push 원격 대상 선택지를 평가했다: **(a) 현 origin(public repo, isPrivate:false)** vs (b) private repo/별도 remote 한정. **사용자 결정은 (a) — 현 origin 유지**다("맞아 그대로 진행해"가 origin을 명시한 설계 요약 위의 승인). 이에 따라 **자유텍스트 세션 맥락의 잔여 노출(public remote에 오름)은 사용자가 수용한 결정**으로 명기한다. 스크럽이 1차 방어선이나 완전하지 않다(아래 잔여 위험).

### 보안 잔여 위험 수용과 회수 절차

- **(a) blacklist-기반 스크럽의 잔여 위험 수용.** 토큰 스크럽은 blacklist 정규식 기반이므로, **정규식이 못 잡는 형태의 비밀은 origin에 오를 수 있다.** 이 잔여 위험은 위 원격 대상 결정과 함께 수용된 것으로 기록한다.
- **본문 최소화 제약(ADR-20260714:27 "요약+포인터")은 폐기한다.** 바통은 rich 자유텍스트 세션 맥락을 담는다 — 요약+포인터 최소화는 승계하지 않는다. 그 귀결로: **미검출·규칙-갱신-이전 토큰의 원격 노출은 tip-tree 불변식(truncation이 tip tree를 안 건드림) 때문에 보존기간과 무관하게 무기한**일 수 있다. 이것이 이 폐기의 명시된 잔여 위험이다.
- **(b) 유출 시 회수 절차:** ① 해당 ref 삭제 push(원격 ref 제거) ② 노출 토큰 즉시 회전 ③ 원격에 남은 보존 사본(GitHub 내부 보관)은 GitHub support 경유로 제거 요청.

## ADR-0005 D3와의 경계 (ADR-0020 disclose)

ADR-0005 D3의 '히스토리 재작성 금지'(ADR-0005:40)와 기각 대안 'git history rewrite = 감사 체인 파괴'(ADR-0005:56)의 대상은 **브랜치 위 durable 계약 산출물 체인**이며, `refs/ditto/handoffs`는 **소멸성 바통 채널로 그 범위 밖**이므로 보존한도 truncation force-push는 결정-모순이 아니다.

## 근거 (rationale)

- **핸드오프의 의미가 저장 모델을 결정한다.** 핸드오프는 사용자가 넘기기로 한 바통이지, 시스템이 쌓는 기록이 아니다. 자동 생산·목록·보관·청소는 전부 "기록" 모델의 부속이고, 바통 모델에서는 존재 이유가 없다 — 사용자가 거부한 누적이 정확히 그 부속들이다.
- **숨은 ref는 세 비용을 동시에 없앤다.** 코드 히스토리 churn 없음(브랜치 밖), 코드 push 편승 없음(별도 ref·별도 push), 브랜치-스코핑 없음(어느 브랜치에서든 fetch 가능). 그러면서 git이 이미 제공하는 전송(fetch/push)·원자성(CAS ref 갱신)·무결성(커밋 해시)을 그대로 쓴다 — 새 인프라 0.
- **first-consumer-wins CAS는 1:1 의미의 집행이다.** 바통은 한 명이 받는다. CAS 실패가 곧 "다른 소비자가 먼저 받았다"는 정직한 신호다.
- **상시허가를 ADR로 남기는 이유.** §4-8의 push 게이트는 명시 허가를 요구한다. 건별 확인 없는 auto-push가 성립하려면 그 허가가 세션 기억이 아니라 durable 기록에 있어야 한다 — 이 ADR이 그 기록이며, 범위(refs/ditto/*·origin·①②③)와 조건(force-with-lease·prefix 격리 헬퍼)을 함께 고정해 허가의 확대 해석을 차단한다.

## 기각된 대안 (rejected alternatives)

- **작업 브랜치 커밋(ADR-20260714 모델) 유지.** 기각 — 브랜치 churn + push 노출 + 브랜치-스코핑. 핸드오프가 코드 히스토리와 push에 얽히고, 브랜치를 이어받지 않는 수신자에게 도달하지 못한다.
- **1-slot 로컬 파일.** 기각 — 동시 세션에서 서로를 덮어써 유실된다(concurrent-session loss). ADR-20260714가 단일 `HANDOFF.md`를 기각한 것과 같은 결함의 재현이다.
- **2-tier 저장소(로컬 + 원격) 유지.** 기각 — 사용자가 거부한 누적이 바로 이 병존에서 나온다. 단일 저장소가 바통 의미와 정합한다.

## 변경 조건 (change_condition)

- **git-ref 전송이 다른 매체로 교체되면**(예: 외부 메시지 버스·GitHub API) → 숨은 ref 저장·CAS 소비·push 상시허가 전부를 새 매체 기준으로 재검토한다. 상시허가는 매체에 결박되어 있으므로 자동 승계되지 않는다.
- **multi-consumer 핸드오프가 실제로 필요해지면** → 1:1 바통·first-consumer-wins·삭제-소비 모델을 재검토한다(broadcast는 다른 결정이다).
- **팀 채택이 auto-push의 org-policy opt-out을 요구하면** → 상시허가의 범위·기본값을 org 정책 계층에서 재평가한다.
- **public origin의 잔여 노출 수용이 철회되면**(비밀 유출 사고 등) → 원격 대상을 private repo/별도 remote로 재평가하고, 스크럽을 blacklist에서 더 강한 방식으로 격상 검토한다.

## Supersede 배선

- **ADR-20260714-handoff-remote-committed-tier — 전체 supersede.** "원격 = 작업 브랜치 커밋, 로컬 = gitignored" 2-tier 모델, per-recipient 소비 마커, 본문 최소화(요약+포인터) 제약이 모두 내려간다. 그 상태 라인은 `superseded by ADR-20260722-handoff-hidden-ref-baton`으로 표시한다.
- **ADR-20260706-work-item-record-run-split — handoff-tier 분류 한 줄만 좁게 부분 supersede.** ADR-20260714가 가졌던 그 좁은 supersede를 이 ADR이 승계한다(핸드오프는 이제 개인 gitignored 파일도, 브랜치 커밋 파일도 아닌 숨은 ref 바통). ADR-20260706의 Record/Run 2-tier 분할·per-event 불변 로그·terminal-first-wins·하이브리드 모델은 **전부 불변**이며 ADR-20260706은 `accepted`로 남는다 — ADR-20260706이 ADR-0012 D1을 좁게 supersede하며 ADR-0012를 뒤집지 않은 선례를 따른다.
- **ADR-0012 — disclosure만(supersede 아님).** D1 개인-tier 목록의 `handoff/` 디렉터리 항목이 실체를 잃는다(핸드오프는 워킹트리 파일이 아니게 됨). 3계층 격리 골격·D2·D3는 불변이다.
