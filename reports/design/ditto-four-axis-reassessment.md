---
title: "DITTO 4축 재평가·재설계 — boxwood 실증 기반"
kind: design
last_updated: 2026-06-06 KST
status: draft
scope: "Hooks/Skills/Agents/State 4축을 최초 실타겟(boxwood) 설치·autopilot 실증 결과에 비추어 재평가하고, 빠진 축(Distribution)과 공통 전제(session-rooting)를 명문화하는 재설계 제안"
inputs:
  - reports/design/ditto-claude-code-harness-design.md   # 원래 4축 출처 §4.1
  - reports/design/ditto-install-distribution-record.md  # 실증 1차 자료
  - reports/harnesses/oh-my-claudecode.md                # 4축의 OMC 뿌리
---

# DITTO 4축 재평가·재설계 — boxwood 실증 기반

> **이 문서의 성격.** 설계 제안이다. **사실(실증으로 확인됨)과 제안(아직 합의·구현 안 됨)을 문장 단위로 구분**한다. 사실은 `ditto-install-distribution-record.md`의 1차 자료에 묶고, 제안은 "제안"으로 명시한다. 원래 4축을 반증하지 않는다 — 보강한다.

## 0. 결론 (세 줄)

1. **원래 4축(Hooks/Skills/Agents/State)은 실증에서 살아남았다.** boxwood에서 훅이 발화했고, 스킬·에이전트가 노출됐고, 상태가 증거-게이트로 기록됐다. 4축 자체는 유효하다.
2. **그러나 4축은 "런타임 축"일 뿐, "어떻게 타겟에 올라가는가"(배포)를 한 글자도 다루지 않았다.** 설치 스크립트 작업 전체(inc 1~6)가 정확히 이 빈칸을 메운 것이며, 이는 **빠진 횡단 축 = Distribution**을 가리킨다.
3. **4축 전부가 암묵적으로 "세션이 타겟 레포에 루트되어 있다"를 전제**한다. boxwood cross-repo 실증이 이 전제를 깨자 Hooks·Agents가 즉시 오작동했다. → **session-rooting을 1급 invariant로 명문화**해야 한다.

## 1. 원래 4축의 출처와 그 자리에서 보이지 않던 것

원래 4축은 `ditto-claude-code-harness-design.md §4.1`에서 **oh-my-claudecode(OMC) 하네스를 분석해 차용**한 것이다("Hooks/Skills/Agents/State 4축 — DITTO도 같은 축으로 시작한다"). 즉 **참조 코드베이스 분석에서 나온 설계-시점 결정이고, DITTO 자신을 실타겟에 돌려 본 실증에서 나온 게 아니다.**

그 분석 시점에는 모든 검증이 self-host(ditto 레포 = 플러그인 = 타겟)였기 때문에, 다음이 구조적으로 보이지 않았다:

- self-host에서는 바이너리·스킬·에이전트·상태가 **이미 한 디렉토리에 다 있다**. 그래서 "어떻게 타겟에 올린다"는 질문이 발생하지 않는다.
- self-host에서는 세션의 repoRoot = 플러그인 = 타겟이 항상 같다. 그래서 "세션이 어디에 루트되는가"가 변수로 드러나지 않는다.

boxwood 실증은 이 두 불가시성을 동시에 깨뜨렸다.

## 2. 실증이 각 축에 대해 드러낸 사실 (1차 자료)

> 출처: `ditto-install-distribution-record.md` §2(inc 1~6), §6(한계).

### 2.1 Hooks 축
- **사실**: 훅이 타겟에서 동작하려면 `node_modules`/`bun` 없는 **self-contained 바이너리**여야 했다(inc1). 플러그인 복사 경로가 런타임을 보장하지 않기 때문.
- **사실**: PreToolUse scope-out이 **세션의 repoRoot를 기준으로** "repo 밖 쓰기"를 차단한다. boxwood를 관리 타겟으로 두고 ditto-루트 세션에서 spawn한 subagent가 boxwood에 쓰자 **즉시 차단됐다**(inc6 한계).
- **함의**: Hooks 축은 ① 바이너리 실재(배포 의존) ② 세션이 타겟에 루트되어 있다는 전제, 둘 위에서만 일관적이다.

### 2.2 Skills 축
- **사실**: 스킬들이 **bare `ditto …`를 호출**한다(autopilot SKILL은 `ditto autopilot …` 7회). 훅만 `${CLAUDE_PLUGIN_ROOT}/bin/ditto` 절대경로를 쓴다.
- **사실**: 그래서 inc3에서 바이너리를 `~/.local/bin/ditto`로 **PATH 배치**해야 했다. 안 하면 스킬이 부르는 CLI가 타겟에서 해석되지 않는다(`which -a ditto` 첫 항목이 우리 심링크임을 실증).
- **함의**: Skills 축은 플러그인 등록만으로 충족되지 않는다. **스킬이 부르는 CLI의 PATH 배치**라는 배포 계약에 의존한다.

### 2.3 Agents 축
- **사실**: 13개 agent가 플러그인 등록으로 노출되고, autopilot이 `ditto:<owner>`를 Task로 spawn한다(self-host `ed075a1`에서 기실증).
- **사실**: boxwood 실증에서는 cross-repo spawn이 scope-out 훅에 막혀, 각 노드 owner 역할을 main agent가 대행하고 **CLI 루프·게이트·완료 계약을 실증**했다(N1 plan, N2 파일생성+file 증거, N3 독립검증, complete=`final_verdict: pass`).
- **함의**: Agents 축은 ① CLI PATH ② State 존재 ③ 세션 루팅, 셋에 의존한다. subagent는 결국 `ditto record-result` 등 CLI를 호출하고 `.ditto/`에 쓰기 때문.

### 2.4 State 축
- **사실**: `.ditto/`가 State다. 타겟에서 lazy init만으로는 `findRepoRoot` 결정성과 필수 시드(`surfaces.json`이 없으면 surface-inventory가 loud-fail)가 보장되지 않아, **명시적 `ditto init` scaffold가 필요**했다(inc2).
- **사실**: State는 **per-target**이다(타겟마다 별도 `.ditto/`). 반면 `surfaces.json`은 설치된 플러그인 자신의 표면 카탈로그라 **State 축이 아니라 self-host 전용 산출물**임이 드러났다(타겟 시드 시 전부 missing_file 드리프트).
- **사실**: 증거-게이트 completion이 State에 기록된다(boxwood `completion.json`: ac-1 verdict=pass, 증거 3개).
- **함의**: State 축은 "명시적 init으로 부트스트랩되는 per-target 디렉토리"로 좁혀진다. 플러그인 자기 표면(surfaces)은 State에서 분리해야 한다.

## 3. 재평가 — 점수와 빈칸

| 축 | 실증에서 유효? | 드러난 의존성 (원래 설계엔 부재) |
|---|---|---|
| Hooks | ✅ 발화 확인 | self-contained 바이너리 실재 + **session-rooting** |
| Skills | ✅ 노출 확인 | **CLI PATH 배치** |
| Agents | ✅ (self-host) / ⚠ (cross-repo 차단) | CLI PATH + State + **session-rooting** |
| State | ✅ 증거-게이트 기록 | **명시적 init** + per-target + surfaces 분리 |

**공통 결론 2가지:**
- 모든 축이 **배포 계약**(바이너리/PATH/init)에 의존하는데, 원래 4축 설계엔 그 계약이 없었다 → §4-A.
- 모든 축이 **session-rooting**을 암묵 전제하는데, 그게 명문화되지 않아 cross-repo에서 조용히 깨졌다 → §4-B.

## 4. 재설계 제안

> 전부 **제안**이다. 4축을 바꾸지 않고 **보강**한다.

### 4-A. (제안) 횡단 축 추가 — Distribution
원래 4축은 "런타임 위에서 어떻게 동작하는가"를 다룬다. 여기에 **"어떻게 타겟에 올라가 살아있게 되는가"를 다루는 횡단 축 Distribution**을 1급으로 추가한다. 각 런타임 축은 충족해야 할 **배포 계약(deployment contract)**을 갖는다:

| 런타임 축 | 배포 계약 (Distribution이 보장) |
|---|---|
| Hooks | self-contained 바이너리 빌드 + `hooks.json` 등록 + `${CLAUDE_PLUGIN_ROOT}/bin/ditto` 실재 |
| Skills | 플러그인 등록 + **CLI를 PATH에 배치** |
| Agents | 플러그인 등록 + CLI PATH + 타겟 State 존재 |
| State | **명시적 `ditto init`** 으로 per-target scaffold |

`scripts/install-plugin.mjs`의 5단계(register/build/place/init/allowlist)가 이미 이 계약의 **구현체**다. 즉 Distribution 축은 신규 발명이 아니라 **이번 작업이 만든 것을 설계 어휘로 승격**하는 것이다. `ditto doctor`/install `status`의 5플래그(plugin_enabled/binary_built/binary_on_path/target_initialized/allowlisted)가 이 축의 **점검 표면**이다.

### 4-B. (제안) Session-rooting을 1급 invariant로
명문화: **"DITTO의 4축은 Claude Code 세션이 타겟 레포에 루트되어 있을 때만 일관되게 동작한다."**
- 한 세션이 *다른* 레포를 관리하는 cross-repo 운용은 **비지원 모드**로 선언한다. boxwood 실증이 정확히 이 경계를 드러냈다(scope-out 차단, subagent 미동작).
- 운영 함의: 타겟을 autopilot으로 돌리려면 **그 타겟에 루트된 세션을 띄운다**(`claude --plugin-dir` 또는 글로벌 등록 후 타겟 디렉토리에서 세션 시작). install의 PATH 배치·allowlist는 바로 이 "타겟-루트 세션"을 위한 준비다.
- 이 invariant는 PreToolUse scope-out의 설계 의도(repo 경계 보호)와 **정합적**이다 — 버그가 아니라 경계다.

### 4-C. (제안) State 축에서 surfaces 분리
`surfaces.json`(플러그인 자기 표면 카탈로그)을 State 축에서 빼고 **Distribution 축의 산출물**로 재배치한다. 타겟의 State는 work-item/intent/autopilot/completion/knowledge만 갖는다. (inc2에서 이미 이 분리를 코드로 적용 — init이 surfaces.json을 시드하지 않음.)

### 4-D. (제안) doctor를 "축별 배포 계약 점검기"로 정렬
현재 `doctor`(permission/surface/capability/mcp)에 더해, **4축 각각의 배포 계약 충족**을 점검하는 뷰를 둔다(install `status`의 5플래그를 doctor로 승격). "이 타겟에서 어느 축이 살아있고 어느 축이 죽었는가"를 한 번에 본다.

## 5. 무엇이 바뀌고 무엇이 그대로인가

- **그대로**: Hooks/Skills/Agents/State 4축 명명과 역할. 실증이 반증하지 않음.
- **추가**: 횡단 축 Distribution + 축별 배포 계약(§4-A) — 이미 install 스크립트로 구현됨, 설계 승격만 필요.
- **명문화**: session-rooting invariant(§4-B), surfaces↔State 분리(§4-C).
- **정렬**: doctor를 축별 점검기로(§4-D) — 제안, 미구현.

## 6. 다음 행동 (이 문서를 받는 사람에게)

1. `ditto-claude-code-harness-design.md §4.1`에 Distribution 축 + session-rooting invariant를 반영할지 결정(설계 본문 개정 = 별도 합의 필요).
2. 채택 시 ADR로 박는다(예: "ADR — DITTO 4축에 Distribution 횡단 축 추가, session-rooting을 비목표 경계로 명문화").
3. doctor 축별 점검기(§4-D)는 install `status` 코드를 재사용하므로 저비용. 우선순위 판단은 사용자 몫.

> 본 재설계는 **제안**이며, 4축 본문(설계 문서) 개정과 ADR 등록은 사용자 합의 후 진행한다. 근거는 전부 `ditto-install-distribution-record.md`의 실증에 있다.
