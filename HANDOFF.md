# HANDOFF — 다른 PC 이어받기 (2026-06-24, AC↔oracle 증분 1 구현 세션)

호스트 메모리·work-items(`.ditto/local/`, gitignored)는 git으로 전파되지 않는다. 코드·테스트·git이 권위(헌장 §4-11). 이 문서는 "어디서 이어받나 + 안 넘어가는 것".

## 0. 전파 상태 (먼저 읽기)

- 이 작업은 **브랜치 `wi_260623uap-ac-oracle`** 에 커밋·push됨. 다른 PC: `git fetch && git checkout wi_260623uap-ac-oracle` (또는 pull).
  - `c379043` feat(autopilot): AC↔oracle 수렴 core (증분 1)
  - `a1f2863` docs(adr): far-field 용어 정정 (먼-들판→간접 영향 분야)
  - + `.claude/settings.json`(dev 광범위 권한 + 파괴/force-push deny) + 이 `HANDOFF.md`
- 빌드: `bun run build:bin` 후 **`./bin/ditto`** 사용 (PATH 설치본 `~/.bun/bin/ditto`는 stale 가능).
- **안 넘어가는 것**(`.ditto/local`, gitignored): wi_260623uap의 intent/autopilot/completion/coverage/reviewer JSON — 이 PC 로컬. WI는 done이라 재현 불요(요지는 §1).

## 1. 이번 세션 — wi_260623uap **DONE** (구현 증분 1, autopilot 도그푸딩)

ADR-0024 floor-raising의 **AC↔oracle 수렴 core** 구현. 완료 통화를 "LLM이 됐다고 함" → **"AC가 재평가 가능한 oracle로 닫힘"**으로 이전. 강도=raise+measure(보장 아님).

착륙한 6 seam (코드=권위):
- **oracle 데이터 모델**: `src/schemas/work-item.ts` `acOracle` (verification_method{dynamic_test/static_scan/soft_judgment} × maps_to × direction{forward/backward}; forward+raw 코드포인터 거부), `acceptanceCriterion.oracle` additive-optional(intent AC는 extend로 상속).
- **① 배정(match)**: `src/core/autopilot-loop.ts` design-close가 `ac_oracles`를 work-item AC에 기록; `src/core/coverage-manager.ts` `producePlanGate` presence-check만(순수 유지, LLM 배정 아님).
- **② 전달(deliver)**: `src/core/autopilot-dispatch.ts` `buildDelegationPacket` → `context.acceptance`(AC 문장+oracle), additive(acceptance_refs 유지).
- **③ 판정(judge)**: `src/core/autopilot-complete.ts` `deriveAcVerdicts`/`nodeVerdictFor` + `src/core/gates.ts` `oracleSatisfaction` — **NOT completionGate, NOT stop.ts** — presence-gated·fail-closed·static=기록된 재스캔 evidenceRef(분석기 부재→unverified, ADR-0018).
- **적대검증+frozen**: `src/core/coverage-manager.ts` `validateAcOracle`(가짜/tautological 거부) + `assertOracleFrozen`/`oraclesEqual`(forward-AC frozen) — write 전 검증.
- **ac-4 clause 2**: `src/hooks/stop.ts` `dialecticForcesContinuation` — backward-finding maps_to 앵커 실재(file:line/path on disk) 검사.

검증: 전체 `bun test` **2802 pass / 9 skip / 0 fail**; fresh verifier+reviewer 독립 검증; reviewer가 ac-4 clause 2 갭 발견 → find→fix→reverify(N10→N12→N13)로 종결; 변경 소스 타입 무회귀. **ADR-0024 proposed→accepted**, glossary oracle 항목·CLAUDE.md projection 갱신.

## 2. 다음 착수 후보 (후속 WI, 전부 미착수)

- **ADR-0024 결정 4~7** (후속 증분): ④회고 측정(산출물 floor + 과정 건강도 *분리*; 서술=기존 기록 *투영*만; 지표 자체도 anti-SLOP; 구조 건강은 floor에 안 넣음) ⑤plan 미리보기 뷰 ⑥루프 규율(예산 cap≠converged + wrong-fixpoint) ⑦의사결정 투명성 전면화(7은 oracle-unmet reason 방출로 부분 내재됨).
- **far-field(간접 영향 분야) 후속**: **wi_26062227h**(비용 재측정 + 라우팅 기준 재설계 — "카테고리"가 아니라 "답의 출처·시점", 자동화 보류) · **§8-5 memory seam**(라이브 entanglement, 보류·R1 위험·사용자 결정 대기).
- **N10 저위험 finding**: `src/core/work-item-handoff.ts:256` `deriveAcVerdicts`가 oracle 없이 호출(잠재 gate↔score 갭; 그 경로의 `buildCompletion` 호출이 이미 기존 stale) — 그 파일 다음에 만질 때.
- **설계 청사진 흡수**: `reports/design/floor-raising-blueprint.md`는 구현에 흡수됐으니 cleanup(폐기) 대상(ADR-0024 명시, charter §4-11).
- **상류 의존(별도 WI)**: AC 관측성 게이트=tech-spec(`tech-spec.ts:204-235` 형태만 검사), 과정측정=**wi_260608acp**, fitness/구조건강=**wi_260615lj6**.

## 3. GOTCHA

- dogfood CLI는 `./bin/ditto`(working-tree). 설치본(`~/.bun/bin/ditto`)은 stale일 수 있음(이번에 3주/215파일 stale였음 → coverage 카테고리 seeding 누락 직전까지 감). src 변경 후 `bun run build:bin` 재빌드.
- `.ditto/local` gitignored — work-item 런타임 상태는 cross-PC 미전파(이 WI는 done이라 무관).
- 정상 ditto CLI 호출은 `DITTO_SKIP_HOOKS=1` prefix(세션 PreToolUse 훅 회피). 훅이 repo 밖 쓰기(`/tmp`·scratchpad) 차단 → 임시파일은 repo 안에.
- 코드가 권위 — 이 문서/메모리가 코드와 어긋나면 코드 우선.
