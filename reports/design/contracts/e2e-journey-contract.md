---
kind: design-detail
last_updated: 2026-06-01 KST
owns: "§10 E2E 테스트 설계의 'how' (E2EJourneyContract 구조 · playwright-e2e agent 책임 · /ditto:e2e skill 절차 · 브라우저 artifact capture · autopilot e2e 노드 통합)"
sources:
  - reports/design/ditto-claude-code-harness-design.md   # §0 v0 범위, §6 line 145 E2EJourneyContract, §10 E2E 설계(post-v0/M5), §7.4 playwright-e2e
status: design-locked (schema 등록 완료, runtime post-v0/M5)
---

# E2EJourneyContract — per-contract 상세 설계 (브라우저 사용자 여정 검증)

> **이 문서의 위치.** 메인 설계문서 §10("E2E 테스트 설계 (post-v0)")과 §6(line 145 "E2EJourneyContract: 웹 서비스의 사용자 여정 검증")의 *how*를 소유한다. per-contract 상세 문서의 다섯 번째 사례다(선행: deep-interview, autopilot, dialectic, knowledge).

## 0. v0 상태 — design-locked, runtime은 M5

설계서 §0(line 33), §10(line 1047 "이 절은 post-v0(M5) E2E 설계다"), line 195("E2E는 post-v0 milestone에서 first-class로 올린다"), line 830("E2E는 placeholder도 post-v0라 v0 skeleton에 두지 않는다")이 E2E를 **post-v0(M5)**로 명시한다. 따라서:

- **이번에 박는 것(v0-safe)**: `E2EJourneyContract` schema(`src/schemas/e2e-journey.ts`, 등록 완료) + 본 상세 설계문서.
- **M5으로 보존하는 것**: `agents/playwright-e2e.md` 본문, `/ditto:e2e` skill, 실제 Playwright/Chromium 실행과 artifact capture.
- `tests/conformance/m1.conformance.test.ts` **M1.5b가 `agents/playwright-e2e.md`의 v0 부재를 단언**하므로, 본 design-lock은 그 invariant를 깨지 않는다(agent 파일 미생성).

## 1. 목적과 경계

### 1.1 한 문장
웹 서비스의 **실제 브라우저 사용자 여정**을 Playwright/Chromium으로 수행해, code-level test가 못 잡는 통합/렌더/상호작용 실패를 evidence(screenshot·trace·console·network)와 함께 검증한다.

### 1.2 인접 계약과의 경계 (무엇이 E2E가 *아닌가*)

| 인접 | 경계 |
|---|---|
| code-level test (M3 commands.jsonl) | 단위/통합 테스트는 `command` evidence. E2E는 실제 브라우저 여정 — 별도다(설계서 §10 "code-level test와 별도"). |
| CompletionContract / Verifier | E2E는 한 acceptance를 *닫는* evidence의 한 종류일 뿐, 완료 판정 자체가 아니다. verdict는 CompletionContract가 종합한다(설계서 line 579). |
| MCP | **E2E executor는 MCP가 아니다**(§10). 브라우저 검증은 직접 Playwright/Chromium command + artifact capture. MCP는 외부 테스트 관리 metadata bridge 후보로만 둔다(사용자 여정 검증을 MCP에 위임하지 않음). |
| EvidenceRecord (M3, ④) | E2E artifacts는 EvidenceRecord와 동형 원칙(raw는 `.ditto/runs/` gitignore, 참조는 path+sha256). E2EJourneyContract는 그 여정-특화 상위 구조. |

## 2. 계약 구조 (`e2eJourney`, 설계서 §10 JSON 정합)

```jsonc
{
  "schema_version": "0.1.0",
  "journey": "login flow",                 // 사용자 여정 이름
  "url": "http://localhost:3000/login",    // 테스트 대상(dev server 또는 기존 URL)
  "steps": [                               // 사용자 스토리 수행 단계
    { "action": "fill email", "target": "#email", "expectation": "value set" },
    { "action": "click submit", "target": "button[type=submit]" }
  ],
  "assertions": [                          // 여정 결과에 대한 단언(검사 가능한 술어)
    { "description": "#dashboard visible", "satisfied": true, "checkable": true }
  ],
  "result": "pass|fail|unverified|blocked",
  "artifacts": {                           // 캡처물(§10) — path(+sha256) 참조, raw는 .ditto/runs
    "screenshots": [ { "path": ".ditto/runs/run_e2e0001/login.png", "sha256": "…" } ],
    "trace": { "path": ".ditto/runs/run_e2e0001/trace.zip" },
    "console": null,
    "network": null
  },
  "reproduction": null                     // result=fail 이면 필수(재현 절차)
}
```

단언은 **검사 가능한 술어**로 받는다(러너가 페이지와 대조): `<selector> contains <text>` · `<selector> visible` · `<selector> hidden` · 단독 CSS selector(존재 확인). 자유텍스트 NL은 selector가 아니라 러너가 기계적으로 평가 불가 → `checkable=false`로 분리되어 `result=unverified`가 된다(부당한 `fail`이 아니라 정직한 "평가 못 함"). 재설계 #2(축3 어설션 자동평가).

cross-field(schema 강제):
- `result=fail` ⇒ `reproduction` 필수(설계서 §10 "실패 시 재현 절차와 artifact path 기록").
- `result=pass` ⇒ 모든 `assertions[]`가 `checkable=true ∧ satisfied=true`(미검사·불만족 단언이 있으면서 pass는 모순; claim ≠ proof).
- `result=unverified` ⇒ 검사 가능한 단언 중 불만족(=실패)은 없고, `checkable=false`(NL) 단언이 1개 이상.
- `checkable=false`인 단언은 `satisfied=true`일 수 없다(검사 안 한 것을 만족이라 주장 불가).
- `result=blocked`(여정을 못 돌림 — dev server 부재 등)은 reproduction 없이 허용.

artifact 정책([DECIDED], ④ EvidenceRecord와 동형): screenshot·trace·console·network는 **path + 선택적 sha256**만 박고 raw는 `.ditto/runs/<id>/` 안에 둔다(gitignore). 다른 clone/세션에서 raw가 없으면 `artifact_available=false`인 EvidenceRecord로 감싸 판정한다(④ 연계).

## 3. playwright-e2e agent 책임 (M5 runtime 설계)

`agents/playwright-e2e.md`(M5 생성 예정). 권한: `browser/test execution`(설계서 line 915). 책임(§10):
- dev server 실행 또는 기존 URL 확인.
- Playwright/Chromium으로 사용자 스토리(steps) 수행.
- screenshot·trace·console error·network failure 수집 → `.ditto/runs/<id>/`.
- accessibility-critical interaction 확인.
- 실패 시 재현 절차(`reproduction`)와 artifact path 기록.
- 출력은 `e2eJourney` 계약으로 검증; raw 출력이 아니라 요약 + path로 렌더(④ §6.7 원칙).

## 4. /ditto:e2e skill 절차 (M5 runtime 설계)

`/ditto:e2e`(M5): playwright-e2e를 spawn해 한 journey를 수행하고 `reviews/`/run 디렉터리에 `e2eJourney` 산출물을 작성한다. autopilot의 `nodeKind=e2e` 노드 owner는 이미 `playwright-e2e`로 매핑되어 있다(`autopilot-graph.ts` `KIND_TO_OWNER`, nodeOwner enum). high-impact 웹 변경(사용자 여정에 영향)에서 autopilot이 e2e 노드를 권장한다.

브라우저 실행은 직접 Playwright/Chromium command다(MCP 아님, §10). v0의 host-adapter spawn 인프라(`src/core/hosts/spawn.ts`)를 재사용하되, browser 실행은 별도 thin 층(Codex bridge가 dialectic에서 별도였던 것과 동형) — 실제 capture glue는 M5.

## 5. autopilot·evidence 통합

- `e2e` 노드는 design/implement 후 high-impact 웹 변경의 verify 단계로 들어간다(autopilot-contract §2.2 kind→owner).
- 산출 `e2eJourney`는 acceptance를 닫는 evidence로 CompletionContract `acceptance[].evidence_records`에 EvidenceRecord(④)로 참조될 수 있다(artifact_available로 portability 표시).
- Stop hook 통합은 M5 범위 — 현재는 dialectic ledger만 cross-check(③).

## 6. 적합성 (현재 / M5)

- **현재(v0, design-lock)**: schema parse(passing/blocked)/cross-field reject(fail 무 reproduction, pass+불만족 단언)/artifact path 참조 + barrel/registry/sidecar-registration 등록 + M1.5b(playwright-e2e agent 부재) 유지. → `tests/schemas/e2e-journey.test.ts`.
- **M5(runtime)**: dev server 기동/URL 확인, 실제 Playwright 여정 수행, artifact capture(screenshot/trace/console/network)와 `.ditto/runs` 배치, `nodeKind=e2e` 노드 spawn 흐름, 실패 재현 절차 기록.
