---
title: "DITTO 기능 4축 재평가·재설계 (정정판) — 목적 기둥 기준"
kind: design
last_updated: 2026-06-06 KST
status: draft
scope: "DITTO의 canonical 기능 4축(의도 동기화 / 자율 실행 / E2E / 지식 베이스)을 1차 주제로 재평가하고, 이전 판이 substrate(Hooks/Skills/Agents/State)를 4축으로 오인한 것을 정정한다. substrate 분석은 '배달 기층' 섹션으로 격하·보존한다."
inputs:
  - .ditto/knowledge/adr/ADR-0010-ditto-functional-four-axes.md   # 기능 4축 canonical 정의
  - reports/design/ditto-claude-code-harness-design.md            # 기층 4축(substrate) 출처 §4.1
  - reports/design/ditto-install-distribution-record.md           # 축2 boxwood autopilot 실증 1차 자료
  - reports/harnesses/oh-my-claudecode.md                         # 기층 4축의 OMC 뿌리
---

# DITTO 기능 4축 재평가·재설계 (정정판)

> **정정 고지.** 이 문서의 이전 판은 4축을 **Hooks/Skills/Agents/State**(구현 substrate)로 잡았으나, 그것은 DITTO의 목적 기둥이 아니라 그 아래 **배달 기층**이다. 본 정정판은 사용자가 정의한 **기능 4축(목적 기둥)을 canonical 1차 주제**로 삼고, substrate 분석은 §3 "배달 기층"으로 격하·보존한다. canonical 정의는 `ADR-0010`. **충돌 시 이 정정판이 우선한다.**

## 0. 두 층위 모델 (이 문서의 뼈대)

- **기능 4축**(§1~§2) = DITTO가 사용자를 위해 **무엇을 하는가**. 목적 기둥. canonical. 완전 순차 파이프라인 1→2→3→4.
- **기층 4축**(§3, Hooks/Skills/Agents/State) = 그 기능 4축을 타겟에서 **살아있게 배달하는** 구현 substrate. OMC 하네스 차용(`ditto-claude-code-harness-design.md §4.1`).
- **매핑**: 각 기능 축은 (Skill+Agent)로 노출되고, (CLI+State)로 동작하고, (Hook)으로 트리거된다.

## 1. 기능 4축 — 정의 / 구현체 / 실증 / 경계 / gap

### 축1 — 사용자 의도 파악 및 동기화

- **정의**: 사용자 요청을 모든 방향·관점의 변증론적·경계 질문을 반복해 사용자 스스로도 인지 못한/놓친 부분까지 드러내고, 사용자 이해 수준과 완전히 일치할 때까지 인터뷰해 산출물을 작성한다.
- **현재 구현체**: `deep-interview` skill + 의도/readiness 산출물(work item intent, readiness 게이트). agent: deep-interview 계열.
- **실증 커버리지**: **입증.** 이 work item에서 진짜 deep-interview를 돌려 readiness **0.88 READY** + 사용자 확인 2차로 finalize했다. **threshold 0 우회 없이** 입증.
- **경계 (c)**: 축1 종료 = 시스템 readiness 게이트(1차) + 사용자 확인(2차). **둘 다** 필요.
- **재설계 제안 (gap)**: readiness 게이트의 점수 산출과 "사용자 확인 2차"가 한 흐름으로 묶여 있는지 표면화 필요. 현재 게이트 통과 후 사용자 확인이 별도 휴먼 스텝이라, 두 조건의 AND를 코드/스킬에서 명시하는 점검이 약하다(미구현 제안).

### 축2 — 자율 실행 오케스트레이션

- **정의**: 사용자 의도를 스스로 구체화해 실제 코드베이스를 만들어 나간다(의도 왜곡 없이, 대규모·장시간이라도 본래 목적을 잃지 않고 끝까지).
- **현재 구현체**: `autopilot` skill + `ditto autopilot …` CLI 루프(plan/select/spawn/record-result/complete) + owner subagent(implementer/reviewer 등) Task spawn + 증거-게이트 완료 계약.
- **실증 커버리지**: **입증.** boxwood 실타겟에서 autopilot e2e를 완주해 `final_verdict: pass`를 기록했다(`ditto-install-distribution-record.md §2.6`). 또한 **이 work item 자체가 self-host autopilot으로 진짜 subagent 위임을 입증**한다(이 구현 노드 N2가 그 위임의 산물).
- **경계 (d)**: 파이프라인 순차성. 축2는 축1 산출(확정된 의도)을 입력으로 받아 실행하고, 축3로 넘긴다.
- **재설계 제안 (gap)**: "장시간·대규모에서 본래 목적을 잃지 않음"은 wave 병렬·context isolation으로 부분 보장되나, **의도 drift 검출 자체를 축2 내부 점검으로 박는** 표면은 아직 reviewer 노드의 회귀 검출에 의존한다(의도-수준 drift는 코드-수준 회귀와 다름 — 별도 점검 제안, 미구현).

### 축3 — E2E 테스트

- **정의**: 사용자 의도대로, 최초 계획대로 구현됐는지 확인한다.
- **현재 구현체**: `e2e` skill (진짜 브라우저 E2E).
- **실증 커버리지**: **입증(런타임).** self-host에서 `ditto e2e run`으로 실제 브라우저 저니를 돌렸다 — 캐시된 Chromium이 실제 launch되어 `https://example.com`을 내비게이션하고 `journey.png`(실제 렌더 스크린샷)·`trace.zip`·`console.log`·`network.log`를 캡처했다(`.ditto/runs/e2e_axis3_demo/`). 결과는 `fail`이지만 이는 **`blocked`(브라우저 미launch)가 아니라** 러너가 자유텍스트 어설션을 자동 평가하지 않아 `satisfied:false`로 떨어진 것 — **축3 런타임(브라우저 launch + 아티팩트 캡처)은 입증됐고, 어설션 자동평가 부재가 별도 gap으로 드러났다.**
- **경계 (a)**: 축3 = 진짜 브라우저 E2E only. 웹 UI 없는 프로젝트(라이브러리·CLI·도메인 모델)는 축3 N/A이고, 다른 축(특히 축2 reviewer·축1 의도 정합)이 그 검증 책임을 커버한다.
- **재설계 제안 (gap)**: ① 축3 N/A 판정을 **자동 분기**로 박을 표면 필요("이 타겟에 웹 UI가 있는가"를 프로젝트 프로파일에서 읽어 축3 enable/skip, skip 시 어느 축이 커버하는지 기록). ② **어설션 자동평가 부재**(이번 실증에서 드러남): 러너가 NL 어설션을 실제 페이지 상태와 대조하지 않아 result가 부당하게 fail로 떨어진다 — 어설션을 selector/text-presence 같은 검사 가능한 술어로 받거나, 평가 불가 어설션을 `unverified`로 분리(미구현 제안).

### 축4 — 지식 베이스

- **정의**: 매 변경마다 추가·변경된 코드베이스·컨텍스트를 문서화해 단편적 사고에서 프로젝트 메모리를 획득, 진짜 지능으로 재탄생한다.
- **현재 구현체**: `knowledge-update` skill + `.ditto/knowledge/`(CONTEXT.md / glossary.json / adr/) + CLAUDE.md projection + knowledgeRecord(State).
- **실증 커버리지**: **입증.** `ditto bridge knowledge`를 실행해 이 work item이 만든 durable 변경(ADR-0010 + glossary "DITTO 기능 4축" term)을 **CLAUDE.md 지식 블록으로 projection**했다 — CLAUDE.md의 Glossary terms에 "DITTO 기능 4축", Architecture decisions에 "ADR-0010 · accepted · DITTO 기능 4축 정식화"가 박혔다(sha256 갱신). **CLAUDE.md는 매 세션 로드되므로, 단편적 산출물이 영속적 프로젝트 메모리로 전환됐다 = 축4 정의("단편적 사고 → 프로젝트 메모리")의 실현.**
- **경계 (b)**: 축4 = 가치 있는 durable 변경만(에이전트 판단: ADR감 결정·용어·반복 패턴). **매 변경 자동 강제가 아니다.**
- **재설계 제안 (gap)**: "가치 있는 durable 변경" 판정 기준이 에이전트 휴리스틱에 머문다. ADR감/용어/반복 패턴 세 트리거를 점검 표면으로 명시해 under-recording(놓침)과 over-recording(노이즈)을 둘 다 줄이는 게이트 제안(미구현).

## 2. 실증 커버리지 표 (이 세션 사실 — 정직)

| 기능 축 | 구현체 | 이 세션 실증 | 판정 |
|---|---|---|---|
| 축1 의도 동기화 | deep-interview skill + readiness 게이트 | 진짜 deep-interview 실행, readiness 0.88 READY + 사용자 확인 2차로 finalize (threshold 0 우회 없음) | **입증** |
| 축2 자율 실행 | autopilot skill + CLI 루프 + owner subagent + 증거-게이트 완료 | boxwood autopilot e2e 완주 `final_verdict: pass`(install-distribution-record §2.6); 이 work item 자체가 self-host autopilot subagent 위임 | **입증** |
| 축3 E2E | e2e skill (브라우저 E2E only) | `ditto e2e run` → 캐시 Chromium 실제 launch, example.com 내비게이션, journey.png/trace.zip/console/network 캡처(`.ditto/runs/e2e_axis3_demo/`). result=fail(blocked 아님)=런타임 작동, 어설션 자동평가 부재가 gap | **입증(런타임)** |
| 축4 지식 베이스 | knowledge-update skill + .ditto/knowledge + CLAUDE.md projection | `ditto bridge knowledge` → ADR-0010 + glossary term "DITTO 기능 4축"이 CLAUDE.md(매 세션 로드 메모리)에 projection됨 | **입증** |

> 정직 고지: 4축을 **완전 순차(1→2→3→4)로 우회 없이** 전부 실제 실행했다. 축3은 런타임(브라우저 launch+캡처)이 입증됐고 어설션 자동평가 부재가 gap으로 드러났다.

## 2-1. 축2를 진짜로 돌려서 드러난 false-green (이번 실증의 핵심 발견)

축2(autopilot)를 self-host에서 진짜 subagent 위임으로 돌리던 중 **완료 게이트의 충실도 갭**이 드러났다:

- N3 verifier(진짜 subagent)는 ac-3을 **PARTIAL**로 판정했다(축1·2 입증, 축3·4 당시 pending). 그러나 `autopilot complete`는 ac-3을 **pass**로 마감했다(evidence 4).
- 원인: 완료 게이트는 **"AC를 다루는 노드가 pass + 증거 보유 → AC pass"**로 매핑한다. verifier가 per-AC로 내린 `partial` 판정은 `record-result`의 **노드 단위 outcome=pass**에 흡수되어 게이트까지 전달되지 않는다.
- 함의: **node-pass + evidence-present ≠ AC-substantively-met.** verifier가 "부분 통과"를 말해도 노드가 pass면 AC가 pass로 over-close된다. DITTO 제1원칙(증거 없는 완료 선언 금지)을 정면으로 약화시키는 false-green이다.
- **재설계 제안(미구현)**: verifier 노드의 산출을 노드 outcome이 아니라 **per-AC verdict 배열**로 받아 완료 게이트가 직접 소비하게 한다. 그러면 verifier의 `partial`이 AC verdict에 그대로 반영되고, 노드 pass가 AC를 over-close하지 못한다. (이 갭은 self-host 도그푸딩으로 축2를 진짜 돌렸기에 드러났다 — 정적 분석으론 안 보였다.)

## 3. 배달 기층 (delivery substrate) — Hooks/Skills/Agents/State

> 이 섹션은 이전 판이 "4축"으로 다뤘던 내용을 **기능 4축을 떠받치는 substrate**로 격하·보존한 것이다. 여기의 분석·invariant는 여전히 유효하다 — 다만 **목적 기둥(§1)이 아니라 그 아래 레이어**다.

기층 4축은 `ditto-claude-code-harness-design.md §4.1`에서 **oh-my-claudecode(OMC) 하네스를 분석해 차용**한 설계-시점 결정이다(참조 코드베이스 분석 산물이지, DITTO를 실타겟에 돌린 실증 산물이 아니었다). 아래는 boxwood 실증(`ditto-install-distribution-record.md` §2, §6)이 각 substrate 축에 대해 드러낸 사실과, substrate를 살아있게 하기 위해 필요한 배포 계약이다.

### 3.1 Hooks (기능 축의 트리거)
- **사실**: 훅이 타겟에서 동작하려면 `node_modules`/`bun` 없는 **self-contained 바이너리**여야 했다(inc1). 플러그인 복사 경로가 런타임을 보장하지 않기 때문.
- **사실**: PreToolUse scope-out이 **세션의 repoRoot를 기준으로** "repo 밖 쓰기"를 차단한다. boxwood를 관리 타겟으로 두고 ditto-루트 세션에서 spawn한 subagent가 boxwood에 쓰자 **즉시 차단됐다**(inc6 한계).
- **함의**: Hooks는 ① 바이너리 실재(배포 의존) ② 세션이 타겟에 루트되어 있다는 전제 위에서만 일관적이다.

### 3.2 Skills (기능 축의 노출면)
- **사실**: 스킬들이 **bare `ditto …`를 호출**한다(autopilot SKILL은 `ditto autopilot …` 7회). 훅만 `${CLAUDE_PLUGIN_ROOT}/bin/ditto` 절대경로를 쓴다.
- **사실**: 그래서 inc3에서 바이너리를 `~/.local/bin/ditto`로 **PATH 배치**해야 했다.
- **함의**: Skills는 플러그인 등록만으로 충족되지 않는다. **스킬이 부르는 CLI의 PATH 배치**라는 배포 계약에 의존한다. (deep-interview / autopilot / e2e / knowledge-update 스킬이 각각 기능 축1~4를 노출한다 — ADR-0010 D3 매핑.)

### 3.3 Agents (기능 축의 실행 owner)
- **사실**: 13개 agent가 플러그인 등록으로 노출되고, autopilot이 `ditto:<owner>`를 Task로 spawn한다(self-host `ed075a1`에서 기실증).
- **사실**: boxwood 실증에서는 cross-repo spawn이 scope-out 훅에 막혀, 각 노드 owner 역할을 main agent가 대행하고 **CLI 루프·게이트·완료 계약을 실증**했다(N1 plan, N2 파일생성+file 증거, N3 독립검증, complete=`final_verdict: pass`).
- **함의**: Agents는 ① CLI PATH ② State 존재 ③ 세션 루팅에 의존한다. subagent는 결국 `ditto record-result` 등 CLI를 호출하고 `.ditto/`에 쓰기 때문.

### 3.4 State (기능 축의 메모리·기록면)
- **사실**: `.ditto/`가 State다. 타겟에서 lazy init만으로는 `findRepoRoot` 결정성과 필수 시드(`surfaces.json` 없으면 surface-inventory가 loud-fail)가 보장되지 않아 **명시적 `ditto init` scaffold가 필요**했다(inc2).
- **사실**: State는 **per-target**이다(타겟마다 별도 `.ditto/`). 반면 `surfaces.json`은 설치된 플러그인 자신의 표면 카탈로그라 **State가 아니라 self-host 전용 산출물**임이 드러났다(타겟 시드 시 전부 missing_file 드리프트).
- **사실**: 증거-게이트 completion이 State에 기록된다(boxwood `completion.json`: ac-1 verdict=pass, 증거 3개). **기능 축4(지식 베이스)의 durable 메모리도 이 State 위에 산다**(`.ditto/knowledge/`).
- **함의**: State는 "명시적 init으로 부트스트랩되는 per-target 디렉토리"로 좁혀진다. 플러그인 자기 표면(surfaces)은 State에서 분리한다.

### 3.5 횡단축 Distribution + session-rooting invariant (보존)

> 이전 판의 핵심 보강 두 가지를 기층 섹션 안에 보존한다. 둘 다 **기능 4축을 타겟에서 살아있게 하기 위한 substrate-레벨 계약**이다.

**(A) 횡단 축 Distribution.** 기층 4축은 "런타임 위에서 어떻게 동작하는가"를 다루지만 "어떻게 타겟에 올라가 살아있게 되는가"(배포)를 다루지 않는다. 각 기층 축은 충족해야 할 **배포 계약(deployment contract)**을 갖는다:

| 기층 축 | 배포 계약 (Distribution이 보장) |
|---|---|
| Hooks | self-contained 바이너리 빌드 + `hooks.json` 등록 + `${CLAUDE_PLUGIN_ROOT}/bin/ditto` 실재 |
| Skills | 플러그인 등록 + **CLI를 PATH에 배치** |
| Agents | 플러그인 등록 + CLI PATH + 타겟 State 존재 |
| State | **명시적 `ditto init`** 으로 per-target scaffold |

`scripts/install-plugin.mjs`의 5단계(register/build/place/init/allowlist)가 이 계약의 구현체다. install `status`의 5플래그(plugin_enabled/binary_built/binary_on_path/target_initialized/allowlisted)가 점검 표면이다.

**(B) Session-rooting invariant.** **"DITTO의 기층 4축은 Claude Code 세션이 타겟 레포에 루트되어 있을 때만 일관되게 동작한다."**
- 한 세션이 *다른* 레포를 관리하는 cross-repo 운용은 **비지원 모드**다. boxwood 실증이 정확히 이 경계를 드러냈다(scope-out 차단, subagent 미동작).
- 운영 함의: 타겟을 autopilot으로 돌리려면 **그 타겟에 루트된 세션을 띄운다**.
- 이 invariant는 PreToolUse scope-out의 설계 의도(repo 경계 보호)와 정합적이다 — 버그가 아니라 경계다.

**(C) 기타 substrate-레벨 제안.** surfaces↔State 분리(§3.4에서 코드 적용 완료). doctor를 "축별 배포 계약 점검기"로 정렬 — **구현됨(4e)**: `ditto doctor distribution`이 install `status` 5플래그(binary_built/binary_on_path/plugin_enabled/hooks_registered/target_initialized + allowlisted)를 런타임 시점에서 재점검해 (A) 표의 4 기층축(Hooks/Skills/Agents/State) 배포 계약 충족 여부로 매핑한다(`src/core/distribution-doctor.ts`).

## 4. 무엇이 바뀌고 무엇이 그대로인가

- **정정**: "4축"의 1차 의미를 **기능 4축(목적 기둥)**으로 바로잡았다. 이전 판이 substrate를 4축으로 오인했음을 §0에서 명시.
- **격하·보존**: Hooks/Skills/Agents/State + Distribution 횡단축 + session-rooting invariant는 §3 "배달 기층"으로 보존 — 삭제하지 않음.
- **정직**: 실증 커버리지는 축1·축2 입증, 축3·축4 pending(증거 미수집)으로 표기. 증거 없이 pass 단정 금지.
- **gap 제안**: §1 각 축의 재설계 제안은 전부 **제안(미구현)**이며 사용자 합의 후 진행.

## 5. 다음 행동

1. 축3 단계에서 self-host e2e 실행 증거를 수집해 §2 표의 축3 판정을 갱신한다.
2. 축4 단계에서 CLAUDE.md projection + knowledgeRecord 증거를 수집해 §2 표의 축4 판정을 갱신한다.
3. §1 각 축의 gap 제안과 §3.5(C) doctor 정렬은 사용자 우선순위 판단 후 별도 work item으로 박는다.

> canonical 정의·경계는 `ADR-0010`에 박혀 있다. 본 문서는 그 위에서의 재평가·재설계 **제안(draft)**이며, 본문 개정·신규 구현은 사용자 합의 후 진행한다.
