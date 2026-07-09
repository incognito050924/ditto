# HANDOFF — wi_2607095fz: E2E CI-evidence push-gate

> 원격(cross-PC) 인수인계. **비권위** — 아래 "다음 후보"는 새 PC에서 grep/test로 **fresh 재확인** 후 진행할 것(§4-11: 코드가 권위). `.ditto/local/`(WI 런타임 레코드·run 산출물·coverage.json·completion)은 gitignore라 **이 PC를 떠나지 않는다**; 새 PC엔 없다. 커밋되어 따라오는 것은 `.ditto/work-items/wi_2607095fz/`(record.json + events)와 `.ditto/knowledge/`(ADR)뿐.

## 전파 상태 (먼저 볼 것)
- **브랜치**: `wi_2607095fz-e2e-gate` (main 미머지). 새 PC: `git fetch && git checkout wi_2607095fz-e2e-gate`.
- **히스토리 rewrite 없음** — 평범한 `git pull`/`fetch`로 충분(reset 불필요).
- 빌드: `bun run build:bin` → `./bin/ditto` (커밋된 `bin/ditto` 번들도 이 커밋에 포함, 재빌드로 동기 가능).

## 이번 세션에 랜딩 (pushed)
- **f02c358** `feat(push-gate): E2E CI-evidence 검증 표면` — 32파일(bin/ditto 재빌드 포함). WI DONE, final_verdict=pass, 6/6 AC fresh, 전체 스위트 4456/0.
- (이 문서 커밋 + retro 메모리 이벤트 커밋이 뒤따름)

## 무엇이 들어갔나 (코드)
- `src/schemas/recipe.ts` `recipeE2eGate` (대상 브랜치 + evidence source), `src/schemas/journey-dsl.ts` `journeyGate{exclude,exclude_reason}` (최상위 `.strict` 완화·중첩 유지).
- `src/core/e2e/evidence-source.ts` (`EvidenceSource` seam · `githubChecksSource` · 역전 fail-closed 폴라리티), `src/core/e2e/e2e-gate.ts` (`verifyE2eEvidence` disposition), `src/core/git-tree.ts` (`computeTreeState` 추출).
- `src/core/push-gate.ts` (`parsePushedRefs`·`resolveE2eGate`), `src/cli/commands/push-gate.ts` (execPushGate 배선, e2e를 green-cache 前 평가), `src/core/setup.ts`·`src/cli/commands/setup.ts` (e2e_gate-only도 pre-push 훅 설치).
- ADR: `.ditto/knowledge/adr/ADR-20260709-e2e-evidence-gate-anti-forgery.md`.

## 핵심 불변식 (되돌리면 보안 구멍 재발 — ADR-20260709)
- 증거 = **라이브 서버-권위 gh check-runs read**(위조불가). **커밋 파일이 ALLOW를 주면 안 됨**(누구나 forge 가능). 커밋되는 건 정책(제외 목록)뿐.
- **pushed 커밋-sha 키잉**(HEAD/tree 아님). **sha-보존 병합 전제**: squash/--no-ff는 새 sha→BLOCK, `DITTO_SKIP_HOOKS` 탈출.
- fail-closed **폴라리티 역전**: gh-client는 fail-open, 이 게이트는 not-green·malformed·CI-query실패 전부→BLOCK.
- 'absent'는 config-presence로 분기: e2e_gate 미설정→degrade-pass, 설정-무증거→BLOCK. 0-journeys→PASS(사용자 결정), unparseable journey→BLOCK.

## 다음 후보 (코드 용어, fresh 재확인 필수)
1. **review → main FF-merge**(sha-보존, 게이트 자체 전제와 동일). `git log --oneline main..wi_2607095fz-e2e-gate`.
2. **유일 미검증 잔여 라이브 실증**: 실 GitHub repo(check-runs 발행)에서 `recipe.e2e_gate` 설정 + journey 저작 + 보호브랜치 push로 게이트가 라이브 gh 증거를 읽어 통과/차단하는지 단발 확인. 하네스에선 `src/core/e2e/evidence-source.ts`의 `githubChecksSource`를 fake `GhExec`로만 검증했다(가짜 live-green 안 만듦).
3. **wi_260629skv**("push 전 테스트통과 강제 게이트 기획")와 겹침 — 흡수/정리 판단.
4. (선택) `tests/core/e2e/evidence-source.test.ts` tsc `noUncheckedIndexedAccess` 나이트 8건 정리(비게이트).

## Gotchas
- push는 ditto 자체 push_gate(`recipe.yaml` `protected_branches: ["*"]`) 발동 → pre-push가 `bun test`(~240s) 실행. `DITTO_SKIP_HOOKS=1 git push …`로 우회 가능(권장 안 함).
- `.githooks` pre-commit이 `bin/ditto` 재빌드+스테이징 + 가드 3종(test-isolation·npx-distribution·committed-base) 실행.
- **새 e2e_gate는 ditto 자기 repo에선 OFF**(recipe.yaml에 e2e_gate 없음→unconfigured degrade). 자기 push를 안 막는다.
- **stale-TS-server 진단** 반복(새 파일 재읽기 前 module-not-found/export-missing) — **bun test가 게이트**, 격리 tsc/grep로 반증.
