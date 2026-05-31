# Plan — wi_v05_e2e_playwright (wi_26053198g) — E2EJourneyContract 상세 설계

## 핵심 결정 (권위 문서 ↔ 메모리)

사용자가 명시적으로 강조: "브라우저 E2E **상세 설계까지**". 설계서 §0/§10(line 1047)/line 195·830이 E2E를 **post-v0(M5)**로 못박고, M1.5b conformance가 `agents/playwright-e2e.md`의 v0 부재를 단언한다. 따라서 agent runtime은 M5로 보존하고 **E2EJourneyContract schema + per-contract 상세 설계문서**로 design-lock한다(헌장 §2: 도메인/저장소 규칙 > 메모리; 사용자 "상세 설계" 범위와도 정합).

## 전달물

- `src/schemas/e2e-journey.ts`: `e2eJourney`(설계서 §10 JSON 정합) + `e2eStep`/`e2eAssertion`/`e2eArtifacts`. cross-field: fail⇒reproduction, pass⇒모든 assertion 만족.
- 등록: barrel + export-schemas registry + sidecar-registration. JSON schema 생성.
- `reports/design/contracts/e2e-journey-contract.md`: 6개 절 상세 설계(경계·계약구조·playwright-e2e 책임·/ditto:e2e·autopilot/evidence 통합·적합성). runtime은 M5 명시.
- conformance: schema parse/reject + 회귀(M1.5b 포함) + matrix design-lock 행.

## [DECIDED]
- E2E artifact는 path+sha256 참조, raw는 `.ditto/runs/<id>/`(gitignore). ④ EvidenceRecord와 동형.
- executor는 직접 Playwright/Chromium(MCP 아님, §10).
- agent/skill/실제 capture는 M5 runtime. v0 agent 파일 미생성(M1.5b 보존).

## 범위 밖
- playwright-e2e agent 파일, /ditto:e2e skill, 실제 브라우저 실행/capture (M5).
- Playwright 의존성 추가 (M5).
