# ADR-0011: Distribution 횡단 배포계약 축 + session-rooting invariant (cross-repo subagent 위임 비지원)

- 상태: accepted (결정 = Distribution을 기층 4축에 직교하는 횡단 배포계약 층으로 정본화하고, session-rooting 경계를 명문화한다. 통상 ADR과 같이 아래 "변경 조건"으로 재개방 가능 — 비가역 아님)
- 결정 일자: 2026-06-06
- 결정자: hskim, claude (claude-opus-4-8)
- 관련: `reports/design/ditto-four-axis-reassessment.md` §3.5(A)(B)(C), `reports/design/ditto-claude-code-harness-design.md` §4.3(본 결정의 정본 반영), `reports/design/ditto-install-distribution-record.md` §2·§6(boxwood 1차 실증), `scripts/install-plugin.mjs`(배포계약 구현체), `src/core/distribution-doctor.ts`·`ditto doctor distribution`(점검 표면, 4e), `src/hooks/pre-tool-use.ts`(scope-out 경계), ADR-0010(기능/기층 두 층위), ADR-0007(다른 층위의 cross_repo — 아래 D3), ADR-0008(host-abstraction 보류)

## 컨텍스트

기층 4축(Hooks/Skills/Agents/State, ADR-0010 D3)은 "런타임 **위에서 어떻게 동작하는가**"를 다루지만 "어떻게 타겟에 **올라가 살아있게 되는가**"(배포)는 다루지 않았다. boxwood 실타겟 실증(`ditto-install-distribution-record.md`)이 두 사실을 드러냈다.

1. **각 기층 축은 충족해야 할 배포 계약(deployment contract)을 갖는다.** 플러그인 등록만으로는 부족했다 — 훅은 self-contained 바이너리여야 동작했고(inc1), 스킬은 bare `ditto …`를 부르므로 CLI가 PATH에 있어야 했으며(inc3), State는 lazy init만으론 `findRepoRoot` 결정성·필수 시드가 보장되지 않아 명시적 `ditto init`이 필요했다(inc2).
2. **cross-repo 세션 운용은 비동작이었다.** ditto-루트 세션에서 boxwood(다른 레포)를 관리 타겟으로 두고 subagent를 spawn해 boxwood에 쓰자 PreToolUse scope-out이 "repo 밖 쓰기"로 **즉시 차단**했다(inc6). 이는 scope-out의 설계 의도(repo 경계 보호)와 정합적인 동작이었지, 버그가 아니었다.

이 둘은 그동안 canonical 설계(`harness-design.md`)에 명문이 없어 "제안(draft)" 상태로 재평가 문서에만 있었다.

## 결정

### D1 — Distribution을 기층 4축에 직교하는 **횡단 배포계약 축**으로 정식화한다

Distribution은 기층 4축(Hooks/Skills/Agents/State)의 **5번째 멤버가 아니라**, 그 넷 각각에 **직교로 걸리는 횡단 관심사**다 — 네 축 모두 타겟에서 살아있으려면 각자의 배포 계약을 충족해야 한다. (ADR-0010이 정리한 기능 4축/기층 4축 두 층위에 "축"을 하나 더 끼우는 게 아니라, 기층 4축 위의 배포계약 행렬을 명명한다.)

| 기층 축 | 배포 계약 (Distribution이 보장) |
|---|---|
| Hooks | self-contained 바이너리 빌드 + `hooks.json` 등록 + `${CLAUDE_PLUGIN_ROOT}/bin/ditto` 실재 |
| Skills | 플러그인 등록 + **CLI를 PATH에 배치** |
| Agents | 플러그인 등록 + CLI PATH + 타겟 State 존재 |
| State | **명시적 `ditto init`** 으로 per-target scaffold |

`scripts/install-plugin.mjs`의 단계(register/build/place/init/allowlist)가 이 계약의 **구현체**다. install `status`(`install-plugin.mjs` doStatus)가 방출하는 플래그는 정확히 `plugin_enabled / binary_built / binary_on_path / codeql / playwright / target_initialized / allowlisted`다. `ditto doctor distribution`(`src/core/distribution-doctor.ts`, 재설계 4e)이 런타임 시점에서 배포계약 충족 여부를 4 기층축으로 매핑하는 **점검 표면**이며, `hooks_registered`(`<repoRoot>/hooks/hooks.json` 존재)는 install status가 아니라 **doctor가 추가로 점검**하는 항목이다. `allowlisted`는 status·doctor 둘 다 **수집·보고**하지만 doctor의 어느 기층축 게이트(`AXIS_CONTRACTS.requires`)에도 들어가지 않는 보고용 항목이다.

> **알려진 한계(#7)**: 현재 `ditto doctor distribution`은 plugin-root(`bin/ditto`, `hooks/hooks.json`)와 target-root(`.ditto`, 프로젝트 `.claude/settings.json`)를 **같은 `repoRoot` 하나로** 점검한다(`distribution-doctor.ts`). 따라서 self-host/병치(co-located) 레이아웃에서만 점검 표면이 정확하고, D2의 session-rooting 하에서 **타겟-루트 세션으로 doctor를 돌리면 plugin-root 아티팩트가 missing으로 오판**될 수 있다. plugin-root/target-root 분리는 4e 후속 과제다.

### D2 — session-rooting invariant (cross-repo 세션 운용 비지원)을 명시 경계로 둔다

> **DITTO의 cross-repo subagent 쓰기는 세션 repoRoot 밖이면 PreToolUse scope-out에 차단되고, 충실한(subagent 위임) autopilot 자동 루프는 타겟 레포에 루트된 세션을 요구한다.**

- 범위를 정확히 한다: PreToolUse scope-out이 차단하는 것은 **세션 repoRoot 밖 쓰기**다(`pre-tool-use.ts` — 읽기·CLI 호출은 scope-out 대상이 아니다). boxwood inc6이 드러낸 것도 cross-repo로 spawn된 **subagent의 쓰기**가 막힌 것이고, **main agent가 노드 owner를 대행하면 cross-repo에서도 autopilot이 완주**했다(`install-distribution-record.md` §2.6·§6 line 110). 따라서 "cross-repo는 전부 비동작"이 아니라, **충실한 subagent 위임 루프**가 타겟-루트를 요구한다.
- **운영 함의**: 타겟을 (subagent 위임까지 충실하게) autopilot으로 돌리려면 **그 타겟에 루트된 세션을 띄운다**. 다른 레포에서의 원격 subagent 오케스트레이션은 비지원 모드다.
- 이 경계는 PreToolUse scope-out의 설계 의도(repo 경계 보호)와 정합적이다 — 차단은 **버그가 아니라 경계**다.

### D3 — ADR-0007과의 층위 구분 (cross-repo 어휘 충돌 방지)

"cross-repo"가 두 ADR에서 다른 층위를 가리키므로 명시 구분한다.

- **ADR-0007 cross_repo** = **정적분석(CodeQL ImpactGraph) 레벨**. 단일모듈 DB에서 형제 JVM 모듈 JAR 타입 참조가 침묵 손실되는 문제를, `internal_packages` glob 명시 선언으로 분류하는 정책. 분석 대상 코드 *내부의* 모듈 간 참조에 관한 것.
- **본 ADR(0011)의 cross-repo** = **런타임 기층 세션 루팅 레벨**. DITTO 하네스(훅/스킬/에이전트/State)가 *세션이 루트되지 않은 다른 레포*를 관리하려 할 때의 비지원 경계. 분석 대상이 아니라 *DITTO 자신의 실행 위치*에 관한 것.

둘은 다른 층위라 충돌하지 않는다 — 같은 `src/hooks/pre-tool-use.ts` 안에서도 이미 별도 분기다: 본 ADR(0011)이 기대는 **scope-out 쓰기 가드**와 ADR-0007이 기대는 **JVM cross_repo 가드**는 서로 다른 분기로 동작한다. ADR-0007이 "분석할 코드의 형제모듈을 어떻게 볼까"라면, ADR-0011은 "DITTO를 어디에 루트해서 돌릴까"다.

## 대안 (기각)

- **host-abstraction으로 cross-repo 세션 운용 지원**: session-rooting 경계 자체는 **본 ADR(0011)의 결정**이다(ADR-0008이 정한 것이 아니다). 다만 cross-repo 원격 오케스트레이션을 지원하려면 scope-out 경계 재설계에 더해 호스트-추상 기계가 필요해질 텐데, 그 추상 기계는 ADR-0008이 "provider 슬롯이 이미 stack-agnostic"이라 **보류**로 둔 바 있다(관련 입력이지 결정 근거는 아님). 현재 요구가 아니므로 cross-repo 지원은 기각, ADR-0008 보류는 유지.
- **Distribution을 기층 4축 *안에* 흡수**(예: State의 일부로): 배포(어떻게 올라가나)는 런타임 동작(올라간 뒤 어떻게 도나)과 다른 관심사이고, 네 축 모두에 걸린다. 한 축에 욱여넣으면 나머지 세 축의 배포계약이 가려진다. 횡단축 분리가 맞다. 기각.
- **session-rooting을 경계로 잠그지 않고 "알려진 한계"로만 둠**: 명문이 없으면 cross-repo 운용을 누군가 다시 시도해 scope-out 차단을 버그로 오해한다(실제 inc6에서 발생). invariant로 잠가 "버그가 아니라 경계"임을 박는다. 기각.

## 변경 조건 (이 ADR을 다시 열 때)

- cross-repo 세션 운용이 제품 요구가 되면(예: 한 세션에서 모노레포 외부 타겟을 원격 오케스트레이션) — scope-out 경계 재설계 + 본 invariant(D2) 재개정 + ADR-0008(host-abstraction 보류) 동반 재검토.
- 기층 substrate가 새 하네스로 교체되면(ADR-0010 D3 변경 조건과 연동) D1 배포계약 표를 갱신한다.
- 배포 단계가 install-plugin.mjs에서 다른 메커니즘(예: 패키지 매니저 배포)으로 바뀌면 D1의 "구현체" 문장과 doctor 매핑을 갱신한다.
