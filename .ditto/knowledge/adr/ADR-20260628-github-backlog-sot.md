# ADR-20260628-github-backlog-sot: GitHub 연계 SoT 3층 + repo 좌표 일원화 — 백로그=GitHub read, 완료=ditto write

- 상태: accepted
- 결정 일자: 2026-06-28
- 결정자: hskim, claude (claude-opus-4-8)
- 관련: wi_260628sx5(tech-spec) → wi_260628d79(구현, done, commit fa96e60). spec=`.ditto/specs/github-backlog-integration.md`(§3 배경·§10 기각된 대안). 코드(권위): `src/schemas/work-item.ts`(github_issue 필드), `src/core/gh-client.ts`, `src/cli/commands/github.ts`. 정합: ADR-0011(session-rooting), ADR-0018(우아한 강등), ADR-0012(개인 config tier), 헌장 §4-11(ADR 코드 곁 SoT). **supersede 없음**(신규 연계 표면).

## 컨텍스트

ditto work item을 GitHub의 백로그/이슈와 연계하려면, "어떤 시스템이 무엇의 source of truth(SoT, 진실의 원천)인가"를 먼저 못박아야 한다. GitHub Projects v2 보드, GitHub Issue, ditto work item이 같은 일을 가리킬 때 우선순위·상태·완료 판정의 권위가 흩어지면 양방향 동기화 지옥과 완료 판정 오염(GitHub 상태가 ditto 완료를 끌어옴)이 생긴다.

또한 백로그는 본질적으로 org/user 레벨에서 여러 repo를 가로지르는데, 실행(코드 변경)은 각 이슈가 속한 repo의 rooting된 세션에서만 일어난다(ADR-0011). 이 비대칭을 좌표 체계로 어떻게 일원화할지 결정해야 했다.

## 결정

**D3 — SoT 3층(three-layer source of truth).** 역할을 층으로 분리한다:

- **GitHub Projects v2 보드 = 백로그 SoT** — 우선순위·상태. ditto는 읽기(read-only).
- **GitHub Issue = 작업 항목** — title·body·계층. ditto는 읽기.
- **ditto work item = 실행/완료 SoT** — 증거 게이트로만 완료 판정. ditto가 쓰기(write).

비대칭이 핵심이다: **완료축은 ditto write SoT, 우선순위축은 GitHub read-only.** 정의·우선순위·상태는 GitHub이 SoT로 ditto가 읽어오고, 완료는 ditto가 evidence로만 판정한다. GitHub 이슈/보드 상태를 ditto 완료 판정으로 끌어오지 않는다. GitHub status는 ditto→GitHub 단방향 미러(완료 시 decisive 게시)일 뿐이다.

**D4 — repo 좌표 일원화.** 백로그(Project)는 org/user 레벨이라 cross-repo를 자연 포함하고, 실행은 각 이슈의 repo에서 일어난다(per-repo rooting, ADR-0011). self/cross 분기 없이 모든 항목을 `"owner/repo#n"` 좌표로 일원화한다. 즉 **백로그=cross-repo(링크·표시), 실행=per-repo(코드 변경은 rooting된 세션에서)**.

## 근거 (rationale)

- **백로그의 본질은 개별 Issue가 아니라 보드다.** 우선순위·상태·cross-repo 집계는 Projects v2 보드의 1급 개념이지 Issue 속성이 아니다. 그래서 백로그 SoT를 Issues가 아니라 보드에 둔다(3층 분리).
- **완료를 GitHub에 결박하면 증거 게이트가 무너진다.** ditto의 prime directive는 완료를 evidence로만 말하는 것(헌장 §4-5)이다. GitHub 이슈 close 상태를 완료 신호로 받으면 검증되지 않은 완료가 새어든다. 그래서 완료축은 ditto가 단독 write SoT로 쥐고, GitHub 방향으로는 단방향 미러만 한다.
- **실행과 백로그를 분리해야 rooting이 깨지지 않는다.** 코드 변경은 ADR-0011의 session-rooting 불변식을 따라 해당 repo 세션에서만 한다. 백로그는 표시·링크만 cross-repo로 다루므로, `owner/repo#n` 단일 좌표로 self/cross 분기를 없애도 실행 경계는 그대로 보존된다.
- **gh CLI 위임이 설치·인증·버전 부담을 외부화한다.** octokit/SDK 직접 의존 대신 gh CLI에 위임하면 인증·API 버전 추적을 GitHub 공식 도구가 맡고, 도구 부재 시 우아한 강등(ADR-0018)으로 의도 실현이 막히지 않는다.

## 기각된 대안

- **Issues = 백로그 SoT** — 기각. 백로그 본질(우선순위·상태·cross-repo 집계)은 개별 Issue가 아니라 Projects v2 보드에 있다 → 3층 채택.
- **자동 양방향 동기화(데몬·webhook·polling)** — 기각. prime directive·증거 게이트와 충돌하고 운영 복잡도가 크다. v1은 수동 링크 + decisive 단방향 직접 게시만 예외로 둔다.
- **cross-repo 실행까지 ditto 대행** — 기각. 실행은 rooting된 repo 세션에서만(ADR-0011). 백로그(표시)와 실행(코드 변경)을 분리한다.
- **octokit/SDK 직접 의존** — 기각. gh CLI가 설치·인증·버전을 위임받는다.

## 변경 조건 (change_condition)

이 결정은 다음 중 하나가 발생하면 재검토한다: 팀이 백로그를 Projects v2가 아닌 다른 SoT(예: 외부 PM 도구)로 옮기거나, ditto 완료 판정을 GitHub 상태에 결박해야 할 제품 요구가 생기거나, cross-repo 실행 자동 대행이 요구될 때.
