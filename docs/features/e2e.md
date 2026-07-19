# e2e — 실브라우저 여정 실행 + 사용자 DSL 저작 파이프라인

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준 커밋: `c2d2e16` (2026-07-19). 진입 파일 `src/cli/commands/e2e.ts` 기준.

---

## 1. 이 기능이 실현하려는 설계 의도 (개념)

`ditto e2e`는 DITTO 4축 중 **E2E 축(실브라우저 사용자 여정 검증)**을 담당한다. 코드-레벨 테스트(축2 reviewer)와 구분되는, "브라우저에서 실제 사용자 여정이 도는가"를 증거로 남기는 축이다(`src/schemas/e2e-journey.ts:5-15`).

이 커맨드는 실은 두 개의 서로 다른 능력을 한 이름 아래 묶는다.

1. **일회성 여정 실행(`e2e run`)** — 하나의 직접-URL 여정을 Playwright/Chromium으로 몰아 스크린샷·trace·console·network를 캡처하고 `e2eJourney` 아티팩트 하나를 남긴다. 이 아티팩트로 acceptance criterion 하나를 증거로 닫을 수 있다.
2. **저작 파이프라인(`plan`→`init-agents`→`generate`→`conformance`/`mapping`→`verify-generated`, 그리고 `regression`·`failure-report`·`failure-verdict`·`fix-allowed`·`lifecycle`)** — 사람이 선언한 Journey DSL을 반복 실행 가능한 영속 Playwright spec으로 만들고, 그 spec이 DSL과 정합함을 게이트로 강제한다.

이 기능이 존재하는 이유는 ADR-0014의 핵심 결정에 있다: **에이전트 단독 자율 테스트 작성 금지**(D1). 에이전트는 UI/UX·기획 맥락을 담지 못해 무의미한 테스트를 만든다. 그래서 의도(여정)는 사람이 Journey DSL로 선언하고, Playwright 구현은 에이전트가 쓰되, ditto 자신은 selector 해석·assertion 합성을 **결정론적으로 하지 않는다**(D2). ditto가 하는 일은 파싱·투영·digest·게이트 검사뿐이다(`.ditto/knowledge/adr/ADR-0014-e2e-dsl-agent-gates.md`).

두 번째 큰 개념은 **정직한 강등**이다. 실브라우저·Playwright가 없으면 이 기능은 crash하지도, 자동 설치하지도, 통과를 조작하지도 않는다 — `blocked` 또는 `@ditto-unverified` fallback으로 강등한다(ADR-0018). 이 성질이 "브라우저 없는 CI/세션에서도 빌드·테스트 가능"을 지탱한다.

---

## 2. 코드 위치와 진입점

### 진입 파일
- `src/cli/commands/e2e.ts` — 14개 서브커맨드의 citty 배선. 대부분 얇은 래퍼이며 로직은 `src/core/e2e/*`에 있다.

### core 모듈 (경로 + 한 줄 역할)
| 파일 | 역할 |
| --- | --- |
| `browser.ts` | M5 실브라우저 런타임. `probePlaywright`(무설치 탐지)·`runJourney`(캡처 실행). |
| `plan-adapter.ts` | DSL v2 → 공식 Playwright plan.md 결정론 투영 + 추적성 sidecar map. |
| `generator.ts` | 공식 generator 사용가능 여부 probe(`probeGenerator`) + 라우팅(`runGenerator`). |
| `generator-fallback.ts` | 무브라우저 강등 scaffold(`@ditto-unverified`) 생성 + fallback 감지. |
| `spec-postpass.ts` | raw generator spec에 provenance 헤더 + `// @step` 마커 주입(`injectDittoMarkers`). |
| `conformance.ts` | DSL step ↔ `@step` 마커 집합 게이트(`checkStepConformance`). |
| `assertion-mapping.ts` | DSL `확인:` ↔ 실제 matcher 강도 분류 + 하드페일 게이트. |
| `journey-digest.ts` | canonical digest·provenance 헤더·`detectStale`(freshness). |
| `journey-dsl.ts` | `.journey.md`/`.block.md` 파서(front-matter zod + body 구조 추출). |
| `regression-select.ts` | diff × `component:` surface 교차로 영향 여정 추림. |
| `regression-gate.ts` | 추린 여정만 실행 + no-escape 기록. |
| `generated-verify.ts` | 표준 `npx playwright test` 1회 실행 + pass/fail/blocked 기록. |
| `failure-report.ts` | Playwright JSON 리포트 → DSL 어휘 실패 보고 + 재생 명령. |
| `failure-verdict.ts` | 사용자 실패 판정 원장 + `featureFixAllowed` 잠금. |
| `lifecycle.ts` | DSL 파생 테스트 update/delete 집행(사용자 확인 + 파생물 가드). |
| `applicability.ts` | 축3(브라우저 E2E) 적용 여부 판단(web UI 신호). |
| `init-agents.ts` | dual-host Playwright test-agent 설치·버전 게이트·MCP 병합. |
| `completion-gate.ts` | 완료측 결정론 backstop(제안 결정·회귀 기록 강제). |
| `authoring-guard.ts` | `withBrowserGuard` — 브라우저 부재 시 실행 대신 `blocked`. |
| `secret-redaction.ts` | secret 값 → `<env:VAR>` 치환 + fail-closed 누출 가드. |
| `web-surface.ts` | changed_files 중 웹 표면 변경 감지(completion-gate가 소비). |

### 관련 스키마 (SoT, ADR-0002)
- `src/schemas/e2e-journey.ts` — `e2eJourney`(실행 결과 아티팩트).
- `src/schemas/journey-dsl.ts` — `journeyFrontMatter`/`blockFrontMatter`(DSL v2 front-matter).
- `src/schemas/e2e-assertion-map.ts`, `e2e-failure-verdict.ts`, `e2e-regression-gate.ts`, `e2e-lifecycle.ts` — 각 게이트/원장 계약. (스키마 파일 자체는 미열람; core에서 import되는 타입으로 형상 확인.)

### 서브커맨드 표 (`src/cli/commands/e2e.ts:1391-1406`)
| 서브커맨드 | 핵심 인자 | 하는 일 | 실패 시 exit |
| --- | --- | --- | --- |
| `run` | `--runId --json` | 직접-URL 여정 1개 실행, journey.json 기록 | 런타임 오류만 non-zero |
| `applicable` | (없음) | 축3 적용/N-A 판단 | — |
| `plan` | `--journey [--out]` | DSL v2 → `specs/<slug>.plan.md` + sidecar | 파싱 실패 usage-exit |
| `generate` | `--journey [--host --from-raw --work-item]` | probe → 주 경로/강등, spec + assertion-map 작성 | fallback/unmatched/gate-fail non-zero |
| `mapping` | `--journey --generated [--work-item]` | assertion map 작성 | unmapped>0 하드페일 |
| `init-agents` | `--host [--loop --playwright-version --dry-run]` | test-agent 설치·버전 게이트 | refuse non-zero, degrade는 zero |
| `conformance` | `--journey --generated [--blocks-dir --support-dir]` | step 마커 + freshness 게이트 | 위반 non-zero |
| `verify-generated` | `--runId --files` | 생성 spec 1회 실행 기록 | non-pass non-zero |
| `failure-report` | `--runId` | DSL 어휘 실패 보고 | — |
| `failure-verdict` | `--work-item --journey --case --classification --basis` | 사용자 판정 원장 기록 (⚠ USER-ONLY) | — |
| `fix-allowed` | `--work-item --journey --case` | 기능 코드 수정 잠금 질의 | LOCKED면 non-zero |
| `digest` | `--journey` | canonical digest 출력 | — |
| `regression` | `--work-item --changed-files [--journeys --runId]` | 영향 여정 추림 + 실행 게이트 | non-pass non-zero |
| `lifecycle` | `--action --journey-file --confirmed-by-user [--reason --work-item]` | 파생 테스트 update/delete (⚠ USER-ONLY) | 거부 non-zero |

---

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

### 3-1. 저작 파이프라인 (주 흐름)

```
e2e/journeys/<slug>.journey.md   (사람이 쓴 DSL v2, front-matter + 구조적 body)
        │  blocks/<id>.block.md  (재사용 블록)
        ▼  ditto e2e plan
projectJourneyToPlan (plan-adapter.ts)
        ├─▶ specs/<slug>.plan.md            (공식 Playwright plan, @ditto-plan v1 헤더)
        └─▶ specs/<slug>.plan.map.json      (plan-step-N → DSL step id + 확인 채널 sidecar)
        ▼  ditto e2e generate
probeGenerator (generator.ts)
   usable?  ── 예 ──▶ driveOfficialGenerator(실브라우저/MCP, 런타임 seam)
        │                    ▼ raw spec
        │            injectDittoMarkers (spec-postpass.ts)  ← sidecar map으로 N→sN 이음
        │                    ▼
        │            e2e/generated/<slug>.spec.ts  (@ditto-generated + @step 마커)
        └── 아니오 ─▶ generateFallbackSpec (generator-fallback.ts)
                             ▼
                     e2e/generated/<slug>.spec.ts  (@ditto-unverified fallback scaffold)
        ▼  (generate가 이어서) buildAssertionMap
        └─▶ specs/<slug>.assertion-map.md  (+ --work-item이면 .ditto/local/work-items/<wi>/e2e-assertion-map.json)
        ▼  ditto e2e conformance / mapping   ← 게이트
        ▼  ditto e2e verify-generated --runId --files   ← 1회 실행
        └─▶ .ditto/local/runs/<runId>/generated-verify.json  (+ playwright-report.json)
```

### 3-2. 일회성 실행 (`e2e run`)

`--json {journey,url,steps,assertions}` → `runJourney`(browser.ts) → node 캡처 러너 spawn → `.ditto/local/runs/<runId>/`에 `journey.png`·`trace.zip`·`console.log`·`network.log`·`outcome.json` → 이들을 참조하는 `e2eJourney` 아티팩트를 스키마 검증 후 `journey.json`으로 저장(`e2e.ts:108-114`).

### 3-3. 실패·회귀·수명주기 흐름

- **회귀**: `--changed-files` × 각 여정 `component:` surface 교차(`regression-select.ts`) → 추린 subset만 `verifyGenerated` → `.ditto/local/work-items/<wi>/regression-gate.json`(선택 목록 + per-여정 결과 보존).
- **실패 판정**: `verify-generated`가 남긴 `playwright-report.json` → `failure-report`가 DSL 어휘로 렌더 → 사용자가 `failure-verdict`로 분류(기능/스크립트/환경/flaky)를 append-only 원장 `.ditto/local/work-items/<wi>/e2e-verdicts.jsonl`에 기록 → `fix-allowed`가 그 원장을 읽어 기능 코드 수정 잠금 판정.
- **수명주기**: `lifecycle update/delete`가 파생물 가드 통과 후 `.ditto/local/[work-items/<wi>/]e2e-lifecycle.jsonl`에 결정 기록.

### 상태 파일 위치 요약
| 경로 | 내용 | git |
| --- | --- | --- |
| `e2e/journeys/*.journey.md`, `blocks/*.block.md` | 사람이 쓴 DSL v2 (SoT) | tracked |
| `specs/<slug>.plan.md`, `.plan.map.json`, `.assertion-map.md` | 투영·sidecar·리뷰 doc | tracked |
| `e2e/generated/<slug>.spec.ts` | 생성 spec | tracked |
| `.ditto/local/runs/<runId>/*` | 실행 아티팩트·리포트·검증 기록 | gitignored |
| `.ditto/local/work-items/<wi>/*.jsonl`·`*.json` | 판정 원장·회귀 기록·assertion map | 개인 tier |
| `.ditto/local/e2e-agents.json` | 설치 스탬프(버전·loop·plan_format) | 개인 tier |

---

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

### 4-1. 사람 선언 + 에이전트 변환 + 기계 게이트 (ADR-0014 D1/D2)
ditto는 변환기를 만들지 않는다. `journey-dsl.ts:14-21`의 명시적 경계: 기계는 step id·`블록:` 호출·`## 케이스` 이름 등 **구조(id-레벨 사실)**만 추출하고 verb/object 같은 의미는 사람이 읽는다. 정합성은 결정론 변환이 아니라 게이트 3종으로 보장한다(생성 직후 1회 실행 · `@step` 마커 집합 · digest/stale).
- **트레이드오프**: 결정론 변환기를 안 만드는 대가로 "spec이 정말 DSL을 반영하는가"를 게이트로 뒤에서 강제해야 한다. 그래서 conformance·mapping·verify가 얇은 래퍼가 아니라 하드페일 게이트다.

### 4-2. 공식 generator 주 경로 + e2e-scripter 강등 (ADR-20260702)
ADR-0014 D2는 원래 자체 `e2e-scripter`가 실브라우저 없이 selector를 **추측(blind guess)**하게 했다 — DOM을 못 봐 취약했다. Playwright 공식 `playwright-test-generator`가 실브라우저(MCP)에서 selector를 **관측**하므로, 이를 주 변환기로 승격하고 e2e-scripter를 무브라우저 fallback으로 내렸다. 이건 supersede가 아니라 D1/D2 메커니즘 정련(D1/D2/D4 불변식 유지). `generator.ts:19-38`이 이 라우팅을 코드로 구현한다.
- **기각 대안**: e2e-scripter를 주 경로로 유지 → 관측형 공식 도구가 있는데 추측기를 주로 둘 이유 없음(ADR-20260702 기각 대안). 단 도구 부재 시 강등 fallback으로만 보존(ADR-0018).

### 4-3. 정직한 강등, 자동 설치 금지 (ADR-0018)
`browser.ts:31-36`의 HARD CONSTRAINT: 브라우저 없으면 `playwright install`을 절대 안 하고 `blocked`을 낸다. 모든 probe는 `bunx --no-install`(`browser.ts:140`)이다. 강등 spec은 `@ditto-unverified` 마커를 달아(`generator-fallback.ts:27-28`) 나중에 실검증 spec으로 오인되지 않는다.

### 4-4. 실패 시 기능 코드 잠금 (ADR-0014 D4 / featureFixAllowed)
잘못된 스크립트에 기능 코드를 과적합시키는 것을 막는다. 사용자가 '기능' 판정을 원장에 남기기 전엔 기능 코드 수정이 잠긴다(`failure-verdict.ts:67-93`). 스키마가 미확인 판정을 표현 불가능하게 만든다(`confirmed_by_user`).

### 4-5. digest 기반 freshness + provenance
`@ditto-source` + `@ditto-digest`로 "DSL이 마지막 생성 이후 바뀌었나"를 사람 기억 없이 기계적으로 판정한다(`journey-digest.ts:8-23`). canonical digest는 운영 메타데이터 `flaky_history`를 제외한다 — 그래야 flaky 판정이 매번 false-stale 재생성을 요구하지 않는다(O-2).

### 4-6. 회귀는 전체가 아닌 영향 추림 (ADR-0014 D3)
전체 스위트는 느리고 flaky해서 비현실적. `component:` surface × diff 교차로 subset만 실행(`regression-select.ts:177`). 단 추린 목록 안에서는 회피 불가 — 목록에 있는데 실행 안 됨은 pass가 아니다(`regression-gate.ts:120-138`).

---

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

### 5-1. `runJourney` — 무브라우저 fail-safe (browser.ts:227-358)
probe 실패 시 즉시 `blockedJourney`(`browser.ts:233-235`). 브라우저가 있어도 러너 spawn 실패·non-zero exit·`outcome.json` 부재·읽기 실패 — **모든 불확실 경로가 `blocked`로 착지**한다(`browser.ts:266-338`). 숨은 의도: "관측 안 된 pass를 조작하지 않는다"(주석 반복). NL로 기계 평가 불가한 assertion은 `checkable=false`가 되어 `unverified`로 착지, fabricated fail이 아니다(`browser.ts:340-346`). `runnerScriptPath()`는 지연 계산 — 모듈 로드 시 `import.meta.url`을 eager 평가하면 `bun build --compile` 바이너리에서 CLI 전체가 startup crash한다(`browser.ts:14-21`, 미묘한 결정).

### 5-2. `projectJourneyToPlan` — 재직렬화, 해석 없음 (plan-adapter.ts:183-367)
front-matter + 구조적 body를 공식 plan markdown으로 투영. 두 개의 병렬 채널을 만든다: `map`(plan-step-N → DSL step id, `plan-adapter.ts:246-250`)과 `assertions`(`확인:` step id 순서, Expected Results로 투영, `plan-adapter.ts:251-254`). 이 assertion 채널이 핵심 — Expected Results는 `// N.` 주석이 없어 planMap으로 이을 수 없기 때문에 별도 채널이 필요하다. `블록:` 스텝은 블록 body를 인라인 전개한다(`:258-264`). secret은 세 겹으로 처리: 값 치환(`redactForPlan`) → 최종 텍스트에 `assertNoPlaintextSecret` fail-closed 가드(`:364`). 인과: 이 가드 때문에 alias 실패로 값이 남으면 plan 작성 자체가 throw한다.

### 5-3. `runGenerator` — probe → 라우팅 (generator.ts:251-305)
`probeGenerator`가 4개 체크(browser AND playwright≥1.61 AND agents-installed AND mcp)를 AND로 묶는다(`generator.ts:210-211`). **하나라도 false면 강등**. 모든 seam이 injectable + rejection을 실패 체크로 흡수(`safe`, `generator.ts:165-171`) — probe는 절대 throw 안 한다. usable이면 `driveOfficialGenerator`(런타임 seam) → `injectDittoMarkers`. CLI는 이 live drive를 in-process로 못 해서 `--from-raw`로 raw spec을 받는다(`e2e.ts:1065-1071`); 없으면 usable 경로가 명시적으로 throw한다.

### 5-4. `injectDittoMarkers` — 텍스트 매칭 아닌 sidecar join (spec-postpass.ts:120-185)
generator의 `// N.` 주석 위에 `// @step <journeyId>/sN` 마커를 주입하되, **N→sN을 주석 텍스트가 아니라 sidecar map으로 해석**한다(`spec-postpass.ts:14-20`). 안정성 대책: generator prose는 drift해도 sidecar join은 안 한다. self-verify: 모든 DSL step id가 마커를 받았는지 재추출해 `unmatched` 반환(`:176-184`), 호출자가 non-zero exit(`e2e.ts:1075-1081`) — 비정합 spec을 절대 커밋 안 한다.

### 5-5. `checkStepConformance` — vacuous pass 거부 (conformance.ts:44-119)
step id가 0개면 마커 없는 spec이 공허하게 통과하므로 **빈 step 집합은 실패**(`conformance.ts:52-58`). 선언 drift도 잡는다: body의 `블록:` 호출이 `uses_blocks`에 없으면 실패(O-14, `:90-99`), 선언된 case가 생성 spec에 없으면 실패(O-13, `:101-108`). CLI 쪽은 여기에 freshness(`detectStale`)를 얹어 journey↔spec, block↔helper digest를 검사한다(`e2e.ts:237-251`).

### 5-6. `buildAssertionMap` + `assertionMapGate` — 강도 분류 (assertion-mapping.ts:209-346)
DSL `확인:` 형(contains/visible/hidden/present/url-contains)과 실제 emitted matcher를 결정론 비교해 exact/weaker/stronger/unmapped로 분류(`:145-187`). 핵심 게이트: **`unmapped_count > 0`은 하드페일**(assertion 하나가 떨어졌다는 뜻, `:335-346`). 분류 불가한 `확인:` 형(form=null)도 절대 조용히 버리지 않고 unmapped로 기록해 하드페일시킨다(`:230-234`) — vacuous pass 방지. weaker는 리뷰 플래그일 뿐 게이트는 통과.

### 5-7. `verifyGenerated` — exit 0 ≠ pass (generated-verify.ts:116-181)
게이트 정직성의 핵심(`:142-165`): exit 0이어도 (a) `@ditto-unverified` fallback이거나 (b) 전부 skip(0 passed)이면 `blocked`로 매핑한다. `passedCount`로 "verified"와 "clean exit but exercised nothing"을 구분(`:87-97`). `withBrowserGuard`로 브라우저 부재 시 러너를 아예 안 부르고 `blocked`(`authoring-guard.ts:21-31`).

### 5-8. `runRegressionGate` — no-escape (regression-gate.ts:86-194)
추린 목록의 per-여정 결과를 기록에 보존해 "selected-but-failed/blocked/not-run"이 기계 판독 가능 → "이번 수정 범위 아님"으로 닫을 수 없다(`:19-29`). 미묘한 결정들: generated spec 부재 여정은 `not_run`이고 그게 있으면 pass가 아니라 fail(`:136-138`); 실패를 여정에 못 매핑하면(unlocalized) 보수적으로 모든 실행 여정을 fail(`:150-156`); 파싱 불가 journey가 있으면 pass를 fail로 강등(`:163-166`).

### 5-9. `gatePlaywrightVersion` / `detectVersionSkew` (init-agents.ts:170-295)
버전 게이트: 부재/파싱불가 → degrade, codex가 <1.61 → refuse(하드 요구), claude가 <1.61 → warn과 함께 install(`:170-202`). plan-format skew는 설치된 agent가 stale이라는 뜻 → loud warn + degrade(`:283-295`). `scaffoldIfAbsent`·`writeBackupOnce`로 사용자 파일은 절대 덮지 않는다(`:249-259`).

### 5-10. `checkE2eCompletionGate` — 완료측 backstop (completion-gate.ts:38-106)
제안 트리거·회귀 게이트는 원래 지침일 뿐이라 SKILL 단계를 잊은 드라이버가 의무를 조용히 안 지킨 채 work item을 닫을 수 있었다. 이 모듈이 `ditto autopilot complete`가 completion contract 조립 전에 부르는 결정론 backstop이다(`:7-23`): 웹 표면 변경이 있으면 `e2e_accept`/`e2e_decline` 결정이 원장에 있어야 하고(decline도 만족 — 사용자가 결정하는 것이 의무), 교차 여정이 있으면 회귀 기록이 현재 changed_files를 커버하며 pass여야 한다.

---

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위: `src/cli/commands/e2e.ts` 전체 + `src/core/e2e/` 21개 모듈 정독 + 두 ADR + 핵심 스키마 2종. 실행 검증(테스트 실행)은 안 했다 — 정적 코드 독해 기준.

- **의도-동작 정합(확인됨)**: ADR-0014의 게이트 3종(1회 실행·`@step` 마커·digest/stale)과 D3(영향 추림)·D4(featureFixAllowed)가 각각 `verify-generated`·`conformance`+`spec-postpass`·`journey-digest`·`regression-*`·`failure-verdict`에 실제로 구현돼 있다. ADR-0018 정직한 강등도 `browser.ts`·`generator-fallback.ts`·`authoring-guard.ts`·`init-agents.ts` 전반에서 일관되게 지켜진다.

- **불일치 1 — ADR 파일 경로 drift (문서, 코드 아님)**: `ADR-20260702-e2e-official-test-agents.md`가 권위 코드로 가리키는 4개 경로가 실재하지 않는다 — `generated-postpass.ts`(실제 `spec-postpass.ts`), `generator-availability.ts`(실제 `generator.ts`의 `probeGenerator`), `heal-filter.ts`(부재), `init-agents-install.ts`(실제 `init-agents.ts`). 확인: 위 4개 경로 존재 검사 전부 ABSENT. 헌장 §4-11(drift 문서 앵커 금지) 관점의 정합성 흠결이며 **코드 동작 결함은 아니다**.

- **불일치 2 — D4 healer 경로가 이 커맨드에 없다**: ADR-20260702가 D4 보존 근거로 드는 `filterHealPatch`/`heal-filter.ts`/`resources/playwright-agents/healer.constrained.*`가 `src/core/e2e/`에 없다(`grep heal` → `init-agents.ts`의 문자열 참조뿐). 이 커맨드가 구현하는 D4는 `featureFixAllowed` 잠금까지이고, healer 기계 필터는 이 스코프 밖(에이전트 리소스)이거나 미구현이다 — 미확인. 재설계 시 D4의 두 반쪽(잠금 vs healer 필터)이 어디 사는지 확인 필요.

- **미검증**: 공식 generator live drive(`driveOfficialGenerator`)와 MCP 경로는 in-process 실행이 불가해 CLI 테스트가 probe→degrade만 검증한다(`generator.ts:96-107`, `e2e.ts:1063-1071` 주석). 실제 실브라우저 ac-3/ac-5 증거는 "N-demonstrate"가 담당한다고 코드가 명시하나, 그 실행은 이 정적 독해로 확인 못 했다.

---

## 7. 잠재 위험·부작용·재설계 시 고려점

### 재설계 시 반드시 보존해야 할 불변식
1. **결정론 합성 금지(D1/D2)**: ditto가 selector/assertion을 만들지 않는다. plan-adapter·spec-postpass는 재직렬화 + 추적성 주입만. 이 경계가 무너지면 "무의미 테스트" 문제가 되돌아온다.
2. **exit 0 ≠ pass**: `verifyGenerated`의 fallback/all-skipped → blocked 매핑(`generated-verify.ts:142-165`)과 `runJourney`의 모든-불확실-경로→blocked. 이 정직성이 없으면 완료 게이트가 가짜 green을 통과시킨다.
3. **하드페일 게이트**: conformance의 vacuous-pass 거부, mapping의 unmapped>0, regression의 no-escape. 전부 "조용히 통과"를 막는 장치다.
4. **secret 간접성 + fail-closed**: credential은 env/secret ref로만 DSL 진입, git-tracked 산출물에 값이 남으면 throw(`secret-redaction.ts:79-88`).
5. **자동 설치 금지**: 모든 probe `--no-install`, 부재는 degrade(ADR-0018).

### 약점·깨질 지점
- **글로벌 캐시 의존(browser.ts)**: `resolvePlaywrightCore`는 bun 설치 캐시를, `findCachedChromium`은 macOS `~/Library/Caches/ms-playwright`만 스캔한다(`browser.ts:96`). 다른 OS 캐시 경로·CI 레이아웃에서 실브라우저 경로가 조용히 unavailable→blocked로 착지할 수 있다. 이식성 재고 지점.
- **plan-format v1 하드코딩 결합**: `@ditto-plan v1`(plan-adapter)·`plan_format_version:'v1'`(init-agents)·probe의 skew 검사가 문자열 'v1'로 묶여 있다. 공식 generator API가 drift하면 세 곳을 동시 재정렬해야 한다(ADR-20260702 change_condition이 이를 명시).
- **글롭 매처 최소구현(regression-select.ts:30-56)**: `?`/`[...]`/`{a,b}`/`!` 미지원. `component:` surface가 이 문법을 쓰면 조용히 안 매칭 → 회귀 미탐. D3 추림 규칙 재설계 조건(ADR-0014)과 직결.
- **assertion 채널 순서 의존(spec-postpass.ts:163-168)**: `expect(...)` 라인을 `확인:` id 순서대로 소비한다. generator가 Expected를 다른 순서로 emit하면 마커가 어긋날 수 있다 — 다만 self-verify unmatched가 누락은 잡지만 오배치(잘못된 id 부착)는 못 잡는다. 재설계 시 주의.
- **동시성**: 원장(jsonl)은 append-only + atomic write지만 동일 work item에 동시 세션이 쓰면 인터리브 가능. `.ditto/local/runs/<runId>/`는 runId로 격리되나 `regression-gate.json`은 work item당 단일 파일이라 last-writer-wins.

### drift 위험
- ADR 파일-경로 인용이 이미 drift했다(§6 불일치 1). 재설계 시 ADR의 코드 앵커를 실경로로 갱신하거나 §4-11대로 경로 앵커를 제거할 것.
