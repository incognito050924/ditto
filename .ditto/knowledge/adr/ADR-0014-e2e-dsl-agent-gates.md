# ADR-0014: E2E 테스트 작성 — 사용자 DSL 선언 + 에이전트 변환 + 게이트 검증

- 상태: accepted
- 결정 일자: 2026-06-11
- 결정자: hskim, claude
- 관련: `.ditto/specs/browser-e2e-authoring.md` §3·§5·§6·§7·§10 (장수명 섹션), 구현 커밋 beec156, `skills/e2e-author/DSL-GUIDE.md`

## 컨텍스트

웹 서비스 실브라우저 E2E 테스트 작성 기능(wi_260610p9h). 2026-06-11 tech-spec 세션에서 stepwise 리뷰로 합의된 사용자 결정 4건을 종합해 기록한다. 산출물은 영속 Playwright 파일이고, 입력은 사용자가 선언하는 Journey DSL이다.

## 결정

**E2E 테스트 작성은 사용자 DSL 선언 + 에이전트 변환 + 게이트 검증으로 한다.**

### D1 — 에이전트 단독 자율 테스트 작성 금지

에이전트는 UI/UX·기획 맥락을 못 담아 무의미 테스트가 된다(기능 존재 이유). 의도(여정)는 사람이 Journey DSL로 선언하고, Playwright 구현은 에이전트(e2e-scripter)가 작성한다.

### D2 — 결정론적 DSL→Playwright 변환기 비개발

기계가 하는 것은 front-matter 파싱·step id 추출·digest·게이트 검사뿐이다. 정합성은 게이트 3종으로 보장한다:

1. 생성 직후 1회 실브라우저 실행
2. DSL step↔`@step` 마커 집합 검사
3. DSL digest 임베드·stale 감지

### D3 — 회귀는 전체 실행이 아닌 영향 추림

front-matter surfaces × 변경 diff 교차로 영향을 추린다. 추려진 목록 안에서는 회피 불가.

### D4 — E2E 실패 시 기능 코드 수정 잠금 (featureFixAllowed)

사용자 판정(기능/스크립트/환경/flaky) 전에는 기능 코드 수정을 잠근다 — 잘못된 스크립트에 맞춘 기능 과적합 차단.

> **정련 (2026-07-02, wi_2607026qs) — ADR-20260702-e2e-official-test-agents.** D1/D2의 *변환 메커니즘*을 정련한다(결정 본체 D1~D4는 supersede 아님). D1의 "변환 에이전트"는 이제 공식 Playwright `playwright-test-generator`(실브라우저 구동)가 **주** 변환기이고, 자체 `e2e-scripter`는 무브라우저 강등 fallback으로 내려간다. D2의 결정론 조각은 DSL→plan.md 어댑터 + `@step`/digest post-pass로 구체화되나 — 사람 DSL 재직렬화 + 추적성 주입만 하고 selector 해석·의미 합성은 안 한다(D2 정신 보존). 게이트 3종(1회 실브라우저·`@step` 마커 집합·digest/stale)과 D4(featureFixAllowed = healer selector/wait 전용, 기댓값 재작성·auto-skip 금지)는 불변.

## 근거

사용자 결정 4건의 종합(2026-06-11 tech-spec 세션, stepwise 리뷰로 합의): 산출물=영속 Playwright 파일, 입력=사용자 DSL, 변환기 개발 부담 과대 → 에이전트 변환+게이트, 전체 실행은 느림·flaky로 비현실적.

## 대안 (기각)

기각 대안 6건은 스펙 §10 참조 (`.ditto/specs/browser-e2e-authoring.md` §10).

## 철회/재검토 조건

- DSL 표현력 한계(선언적 구문으로 못 푸는 여정)가 실사용에서 반복 확인되면 → 스펙 §5-10 경계(범용 문법화 금지) 재논의.
- 추림 미탐이 실회귀를 놓치는 사례가 확인되면 → 추림 규칙 재설계.
