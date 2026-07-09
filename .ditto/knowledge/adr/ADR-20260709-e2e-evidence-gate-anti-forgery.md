# ADR-20260709-e2e-evidence-gate-anti-forgery: E2E CI-증거 push-gate의 위조불가 경계 — allow-신호는 서버-권위 라이브 read(커밋 산출물 아님)·fail-closed 극성·sha-보존 워크플로 전제

- 상태: accepted
- 결정 일자: 2026-07-09
- 결정자: hskim, claude (claude-opus-4-8)
- 관련: ADR-0018(선택적 도구 우아한 강등 — 이 게이트의 fail-closed는 그 D3 evidence-gated completion의 **push 변형**: 부재는 GATE를 막지 INTENT를 막지 않는다, `DITTO_SKIP_HOOKS`가 의도 실현), ADR-20260708-autopilot-test-tier-boundary(D3가 통합/E2E를 "push-gate·CI·`ditto e2e`" 소관으로 지목 — 이 ADR이 그 **CI-증거 E2E push 표면**을 성문화; D4의 push=fail-closed / barrier=degrade 가역성 비대칭을 이 표면이 상속), ADR-0016(dual-host 포터빌리티 — `EvidenceSource` seam이 host-agnostic), ADR-0014·ADR-20260702(E2E DSL·journey 자산·에이전트 변환 — journey가 게이트 멤버십의 단위), ADR-20260626-work-lifecycle-lightweight-path(push-readiness pull-only — push는 사용자의 비가역 배포 결정). 코드(권위): `src/schemas/recipe.ts`(`recipeE2eGate`·`recipeE2eEvidence`), `src/schemas/journey-dsl.ts`(`journeyGate`), `src/core/e2e/evidence-source.ts`(위조불가·극성반전 KEYSTONE 주석), `src/core/e2e/e2e-gate.ts`(disposition), `src/cli/commands/push-gate.ts`(배선·precedence). 구현 WI: wi_2607095fz(final_verdict=pass, 6/6 AC, suite 4445/0).

## 컨텍스트

push-gate(wi_260629i9c)는 로컬 `test_command`을 push 시점에 돌린다. 그러나 브라우저 E2E는 매 push마다 로컬에서 돌리기엔 무겁고 실브라우저·실인프라를 요구한다. ADR-20260708 D3는 통합/E2E를 barrier 범위 밖으로 두고 "push-gate·CI·`ditto e2e`" 소관으로 명시했다 — 그 공백을 메우는 push 표면이 필요했다: push 시점에 "이 커밋의 E2E가 CI에서 통과했는가"를 확인하는 게이트.

이 게이트의 **전부는 위조 저항**이다. "E2E가 CI에서 통과했다"는 증거를 *무엇으로 삼느냐*가 게이트의 유효성을 결정한다. 증거가 커밋된 파일이라면, 커밋할 수 있는 개발자 누구나 `{tree, journey, pass:true}`를 날조해 게이트를 완전 우회할 수 있다. 즉 allow-신호의 출처(provenance)를 잘못 고르면 게이트는 보안적으로 무의미해진다.

이 ADR은 e2e_gate 기능의 *필드·게이트 메커니즘*(코드-SoT: recipe.ts·journey-dsl.ts·e2e-gate.ts)을 다시 쓰지 않는다. 대신 되돌리면 조용히 보안 구멍을 재도입하는 **되돌리기 어려운 경계 결정들**을 기각한 대안·철회 조건과 함께 못박는다.

## 결정

### D1 — allow-신호 = 정확한 pushed 커밋 sha의 CI check-run을 서버에서 라이브로 읽은 것 (커밋 산출물은 ALLOW를 못 준다)

게이트를 통과시키는 유일한 권위 신호는 **GitHub에 사는 라이브 서버-사이드 read**다(`gh api repos/{repo}/commits/{sha}/check-runs`). 개발자 디스크의 어떤 파일도 ALLOW를 부여하지 않는다 — 로컬 파일은 개발자가 쓸 수 있으므로 위조 가능하다. provenance는 `.ditto/local/runs`와 구조적으로 분리되어 있다(evidence-source 모듈은 run 산출물을 절대 읽지 않는다).

**커밋된 산출물은 POLICY 전용이다**: 어떤 journey를 게이트에서 제외하는지(`gate.exclude`)만 커밋에 담고, 그것이 허용되는 이유는 policy 완화가 git-visible diff이기 때문이다(리뷰 가능·감사 가능). "이 커밋이 통과했다"는 allow-신호는 절대 커밋에 담기지 않는다. 이 **policy(커밋 가능) vs allow-신호(서버-권위)** 비대칭이 D1의 핵심이다.

### D2 — 식별자는 pushed 커밋 sha (HEAD·tree-hash 아님) + sha-보존 통합 워크플로 전제 (사용자-확인)

CI check-run은 **sha-주소**다(tree-lookup API 없음). 게이트는 pre-push stdin(`parsePushedRefs`)에서 각 ref의 정확한 로컬 sha를 읽어 그 sha의 증거를 조회한다 — `git push HEAD:release`·다중 ref push가 올바르게 동작한다.

이 결정의 필연적 귀결: 게이트는 **CI가 정확히 그 pushed sha에 대해 이미 돌았을 것**을 요구한다 → **sha-보존 통합 워크플로**(fast-forward 병합 또는 GitHub merge-queue)가 전제다. squash·`--no-ff` 병합은 CI 안 돈 새 sha를 만들어 게이트가 BLOCK한다(정확한 동작; `DITTO_SKIP_HOOKS`로 탈출). 이 전제는 **사용자가 확인한 워크플로 제약**이다.

### D3 — fail-closed 극성: gh-client의 fail-OPEN에서 반전, classify만 재사용하고 seam을 변형하지 않는다

`src/core/gh-client.ts`는 **fail-OPEN**이다 — 모든 실패가 degrade-and-proceed(issue/project 호출자용). 이 게이트는 그 모듈의 `GhExec`·`classifyGhFailure`를 실패 **CLASSIFY에만** 재사용하되, 모든 `{ok:false}`(auth·timeout·rate-limit·perm·absent·malformed·unparseable·nonzero)를 **BLOCK**으로 매핑한다. gh-client는 변형하지 않는다(다른 호출자는 여전히 fail-open이 필요).

**malformed 증거 → BLOCK.** corrupt/unparseable payload는 `{ok:false, reason:'unparseable'}`가 된다 — green-tree 캐시의 corrupt→empty(`readGreenCache`)와 **정반대**다. 캐시는 "empty"가 fail-safe(게이트 재실행)지만, 증거는 "empty/게이트 없음"이 fail-OPEN(pass로 읽힘)이므로 malformed 증거는 절대 "게이트 없음→pass"로 읽혀선 안 되고 반드시 BLOCK한다. 부분적으로만 형태를 갖춘 check-run 원소도 조용히 drop하지 않고 `unparseable`로 처리한다 — `failure` check가 false pass로 사라질 수 없게.

이는 **ADR-0018 D3 evidence-gated completion의 push 변형**이다: 부재는 GATE를 막지 INTENT를 막지 않는다(`DITTO_SKIP_HOOKS`가 의도 실현 — 기존 push-gate fail-closed 선례와 동일). 또한 ADR-20260708 D4(같은 `unrunnable` 신호를 push=BLOCK / barrier=degrade로 갈라 라우팅)의 push 계보다.

### D4 — 'absent'는 CONFIG-존재로 disambiguate (증거-존재가 아니라)

- `e2e_gate` 미설정 → **degrade-PASS**(bootstrap: 게이트를 아직 안 켠 repo는 영향 없음).
- 설정됐으나 증거 없음 → **BLOCK**.
- 0-mandatory-journey → **degrade-PASS**(사용자 결정: 원래 설계의 'suspicious→BLOCK'을 override).
- malformed journey(non-excluded) → **BLOCK**(malformed ≠ absent — mandatory 집합에서 조용히 빠지지 않는다).

즉 "게이트가 켜졌는가"는 **config**로 판정하고, "통과했는가"는 **라이브 증거**로 판정한다 — 둘을 절대 섞지 않는다. 게이트 ON 여부를 journey/증거 존재에서 추론하지 않는 것이 fail-open 구멍과 bootstrap 차단을 동시에 피하는 조건이다.

### D5 — E2E는 work-item과 분리된 프로젝트-계층 자산

게이트 멤버십의 단위는 커밋된 journey 파일(`e2e/journeys/*.journey.md`, e2e-author가 저작) + recipe `e2e_gate` 설정이다 — 어떤 단일 work item이 소유하지 않는다. journey는 git-tracked repo 자산이라 저자 self-service로 `gate.exclude`(+필수 `exclude_reason`)를 front-matter에 직접 단다(out-of-band config 없음). 멤버십은 **blocklist**다: journey는 exclude 안 하면 mandatory. ADR-0014의 저작 모델(사람 선언·에이전트 변환·게이트 검증)과 정합.

## 근거 (rationale)

- **위조불가가 게이트의 전부다.** E2E-통과 증거가 로컬 파일이면 게이트는 보안적으로 무의미하다(커밋 가능자 누구나 날조). allow-신호는 반드시 서버-권위여야 하고, 그것만이 "통과했다"를 개발자가 거짓말할 수 없게 만든다. policy(어떤 journey 제외)를 커밋에 두는 것은 안전하다 — 완화가 diff로 보이기 때문. 이 policy/allow-신호 비대칭이 D1의 논리다.
- **sha-주소 식별이 tree-hash보다 옳다.** check-run은 sha로만 조회된다(tree-lookup API 없음). tree-hash 식별은 API가 없어 불가능할 뿐 아니라, 다중 ref·release push의 정확성도 sha가 보장한다.
- **극성 반전은 tier 위험 비대칭을 따른다.** gh-client의 fail-open은 issue/project 조회(가역·비차단)에 옳지만, push는 비가역이라 검증 공백을 막아야 한다. 같은 seam, 다른 처분 — ADR-0018 D3의 push 변형이자 ADR-20260708 D4의 계보. seam을 변형하지 않고 classify만 재사용하는 것은 §4-11 중복/drift 회피다(gh-client 호출자는 여전히 fail-open).
- **config-존재 disambiguation은 bootstrap을 막지 않으면서 위장 우회를 막는다.** 미설정 repo가 BLOCK되면 게이트 도입 자체가 불가능하고, 설정된 repo가 증거 부재에 PASS하면 fail-open 구멍이 된다. config가 유일한 "게이트 ON" 신호여야 두 실패 모드를 동시에 피한다.

## 대안 (기각)

- **(a) 커밋된 구조화 증거 파일 `{tree, journey, pass:true}`** — 커밋 가능자 누구나 위조 가능 → 게이트 완전 우회. 기각(→D1). 서명된 비위조 attestation이 나오기 전엔 재검토 안 함.
- **(b) HEAD·tree-hash 식별** — check-run은 sha-주소라 tree-lookup API가 없고, 다중 ref push에서 부정확. 기각(→D2).
- **(c) gh-client를 fail-closed로 바꿔 공유** — 다른 호출자(issue/project)는 fail-open이 옳으므로 공유 모듈 변형은 회귀. classify만 재사용하고 극성은 이 게이트에서 반전. 기각(→D3).
- **(d) malformed 증거를 empty로(=게이트 없음→pass) 취급** — fail-OPEN 구멍(`failure` check가 사라짐). 기각(→D3, malformed→BLOCK).
- **(e) 0-mandatory-journey를 suspicious→BLOCK** — 원래 설계였으나 사용자가 degrade-PASS로 override(설정만 하고 아직 journey 없는 repo를 막지 않기 위함). unparseable journey BLOCK은 이와 별개로 유지. 기각(→D4).

## 정직한 잔여 (honest residual — 과잉주장 금지)

- 게이트의 안전은 **CI가 정확히 pushed sha에 대해 이미 돌았다는 sha-보존 워크플로에 의존**한다. squash/`--no-ff`로 protected 브랜치에 병합하는 팀은 이 게이트를 그대로 쓸 수 없다(매 병합이 CI 안 돈 새 sha를 만들어 BLOCK; `DITTO_SKIP_HOOKS`로 탈출). 이는 구조로 강제되지 않는 워크플로 제약이다.
- `check_name_template`로 journey→CI check 이름을 매핑하는데, journey id와 CI job 이름의 규약 일치는 저자·CI 설정의 책임이고 스키마가 강제하지 않는다. 잘못 매핑되면 `missing`→BLOCK(fail-closed, 안전한 방향)이지만 마찰이 될 수 있다.
- 서버-라이브 read는 네트워크·GitHub 가용성에 의존한다 — 그 부재는 D3에 따라 BLOCK(fail-closed)이고 `DITTO_SKIP_HOOKS`가 유일 탈출. 오프라인 개발자의 protected-branch push는 **의도적으로** 막힌다.
- 라이브 서버 read 자체의 e2e 실증(실제 GitHub check-runs 왕복)은 CI/실환경 대기 항목일 수 있다 — 이 ADR은 결정 기록이지 라이브 검증 증거가 아니다(검증은 wi_2607095fz의 완료 계약 소관).

## 변경 조건 (change_condition)

- **서명된 비위조 커밋 attestation**(예: in-toto/sigstore 서명 증거)이 실용화되면 → D1의 "커밋 산출물은 ALLOW를 못 준다"를 재검토(서명은 위조불가라 로컬 증거도 권위가 될 수 있음).
- squash-merge 워크플로를 쓰는 팀이 실사용에서 이 게이트를 원하면 → D2의 sha-주소 식별을 유지한 채 "merge된 PR의 head sha 증거를 protected sha에 연결"하는 별도 매핑을 재검토(단, allow-신호의 서버-권위성은 불변).
- gh-client의 fail-open 정책이 바뀌면 → D3의 극성반전 진술(classify 재사용·seam 불변)을 재확인.
- github-checks 외 CI(GitLab 등)를 지원하면 → `EvidenceSource` seam(ADR-0016 포터빌리티)에 새 구현을 더하되 D1(서버-권위)·D3(fail-closed) 불변식이 그 구현에도 적용되는지 확인.
