---
title: "Global (product) / Local (dogfooding) / Research asset boundary"
kind: governance-boundary
last_updated: 2026-06-07 KST (3계층 격리 실현 — wi_2606071zj)
status: source-of-truth
owns: "이 저장소의 자산을 'ditto 제품(전역)' vs '이 레포 dogfooding(로컬)' vs '연구(research)'로 분류하는 단일 기준 + 영역별 인벤토리 + 3패턴 + 고위험 후속항목"
---

# 전역(제품) / 로컬(dogfooding) / 연구 자산 경계

> **이 문서의 목적.** "무엇이 ditto **제품**(다른 사용자에게 그대로 배포되는 엔진)이고, 무엇이 **이 레포의 dogfooding 런타임 산물**인가"의 **단일 진실원**이다. 빌드·배포 정리 맥락에서 둘이 뭉뚱그려져 구분이 안 되던 문제를 분류 기준으로 고정한다. 분류만 한다 — 파일 이동·삭제 같은 비가역/제품결정 작업은 §4 후속항목으로 *기록만* 하고 수행하지 않는다.

## 1. 분류 기준

| 분류 | 정의 | 판별 질문 |
|---|---|---|
| **GLOBAL** | ditto 제품/엔진. 모든 사용자에게 공통이고 제품과 함께 배포된다. 코드·스키마·계약·플러그인 로드 표면. | "ditto를 다른 저장소에 설치해도 이게 필요한가? 이게 없으면 엔진이 동작이 달라지나?" → 예 |
| **LOCAL** | 이 레포의 dogfooding 런타임 출력. 우리가 ditto로 우리 자신을 돌린 흔적. work item·run·handoff·이 레포의 ADR 내용. | "이건 *이 저장소를 운영한 결과*인가? 다른 사용자가 설치할 때 빈 상태로 시작하나?" → 예 |
| **RESEARCH** | 조사/탐구/스펙 검토 노트. 설계의 입력이지만 런타임도 배포물도 아니다. | "이건 결정을 *뒷받침한 조사*이지, 실행되거나 배포되는 자산은 아닌가?" → 예 |

경계 케이스 원칙: **구조(structure)와 내용(content)을 분리해서 본다.** 한 경로의 *디렉터리 형태·파일 스키마*는 엔진 계약(GLOBAL)인데 그 안에 든 *값*은 이 레포의 증거(LOCAL)인 경우가 흔하다(§3 패턴 A).

## 2. 영역별 인벤토리

| 영역 | 분류 | 근거 / 비고 |
|---|---|---|
| `src/` (코드), `src/schemas/` | GLOBAL | 엔진 그 자체. 스키마는 source of truth(ADR-0002). |
| `.claude-plugin/plugin.json`, `hooks/`, `agents/`, `skills/`, `commands/` | GLOBAL (배포 표면) | 플러그인 로드 표면 — 설치 시 그대로 다른 사용자 환경에 배포된다. 여기 박힌 dogfooding 흔적(wi_*·절대경로)은 누출(패턴 C). |
| `reports/design/contracts/` | GLOBAL | 엔진 계약의 "how". skill·src가 런타임에 인용한다(예: autopilot SKILL이 contract §를 가리킴). 이번에 승격된 3계약(host-adapter / run-with / verify)도 여기 peer. |
| `reports/design/ditto-claude-code-harness-design.md`, `*-implementation-plan.md` | GLOBAL | 메인 설계·계획 — 제품 "what". |
| `.ditto/knowledge/` (구조: `adr/`, `glossary.json`, `CONTEXT.md`) | **A (구조=GLOBAL / 내용=LOCAL)** | 디렉터리·파일 형태와 projection 동작은 엔진 계약(다른 저장소도 같은 구조로 지식을 둔다). 내용(이 레포의 ADR 본문·용어·컨텍스트)은 이 레포의 증거 = LOCAL. |
| `.ditto/local/work-items/` | LOCAL (대량 런타임 흔적, 개인구획) | 이 레포를 ditto로 운영한 work item 추적. 다른 사용자는 빈 상태로 시작. wi_2606071zj에서 `.ditto/local/`로 이전(개인별 gitignore). 단, 여기 *갇혀 있던* 실행계층 계약 3개는 GLOBAL 자산이었고(패턴 B) → S1에서 `reports/design/contracts/`로 승격됨. |
| `.ditto/local/runs/`, `.ditto/local/worktrees/`, `.ditto/local/cache/`, `.ditto/local/logs/`, `.ditto/local/sessions/`, `.ditto/local/surfaces.json` | LOCAL (개인구획, gitignore) | run artifact·worktree·analyzer cache·logs·session pointer·surface catalog. 개발자별 런타임 출력, 배포 안 됨. |
| `.ditto/local/handoff/` | LOCAL (개인구획) | 세션 전환 문맥. 이 레포 운영 중 생긴 런타임 상태. |
| `reports/harnesses/*` | RESEARCH | 외부 하네스(HANNES·Sisyphus·OMC 등) 정적 분석 — 설계 입력 조사. |
| `reports/design/agentic-governance/*` (스펙·reviews) | RESEARCH | ACG 거버넌스 스펙·검토 노트. 설계 탐구물. (단 그 안 `reviews/*`는 LOCAL 성격 — §4 후속 이동 후보.) |
| `reports/codeql/` | RESEARCH | CodeQL 통합 조사·계획. |
| `reports/design/ditto-install-distribution-record.md`, `ditto-v0-conformance-matrix.md` | LOCAL (위치는 reports/) | 이 레포 운영 기록 — 본질은 LOCAL 런타임 흔적인데 reports/에 산다(§4 후속 이동 후보, 비가역이라 이번 scope 제외). |
| `docs/` (root docs: `agent-variants.md`, `DEVELOPMENT.md` 등) | GLOBAL | 제품 사용자 문서. dogfooding 흔적(절대경로)은 누출(패턴 C). |
| `README.md`, `CLAUDE.md`/`AGENTS.md` | GLOBAL (CLAUDE.md는 A) | 행동 헌장은 구조=GLOBAL이나 일부 내용은 이 레포 컨텍스트(LOCAL) — projection 산물. |

## 3. 세 가지 패턴

### A — 구조는 전역 / 내용은 로컬
디렉터리 형태·파일 스키마·projection 동작은 엔진 계약(GLOBAL)인데 그 안의 값은 이 레포의 증거(LOCAL)다. 대표: `.ditto/knowledge/` — adr/glossary/CONTEXT의 *경로와 형식*은 모든 ditto 설치가 공유하는 엔진 계약이지만, 거기 든 ADR 본문·용어 정의는 이 레포가 쌓은 것이다. **혼동 위험**: 구조를 LOCAL로 오해해 빼면 엔진이 깨지고, 내용을 GLOBAL로 오해해 배포하면 남의 저장소에 우리 ADR이 섞인다.

### B — 전역 자산이 로컬 위치에 갇힘
GLOBAL이어야 할 자산이 LOCAL 런타임 흔적 안에 묻혀 소실 위험에 놓인 경우. 대표(이번에 **해소**, S1): 실행계층 엔진 계약 3개(host-adapter spawn+failure taxonomy / `ditto run with` CLI 표면 / `--verify` 의미론)가 `.ditto/work-items/<id>/design/` 노트에만 있었다 → `reports/design/contracts/`의 durable peer로 승격. 원본 노트는 비파괴 보존.

### C — 로컬 누출이 전역 배포물에 박힘
LOCAL dogfooding 흔적이 GLOBAL 배포 표면/제품 문서에 새어든 경우. 대표(이번에 **해소**, S2): `skills/*/SKILL.md` 본문의 `wi_*` 식별자, `DEVELOPMENT.md`의 하드코딩 절대경로(`/Users/incognito/...`). 기능 불변·의미 보존하면서 제거 — 배포되는 플러그인 표면에 이 레포의 work item id나 특정 머신 경로가 남지 않게.

## 3-bis. 실현된 3계층 격리 (wi_2606071zj, ADR-0012)

위 GLOBAL/LOCAL/RESEARCH 분류는 이제 **경로**로 집행된다. 분류가 곧 디렉터리 구획이다.

| 계층 | 위치 | git | 설명 |
|---|---|---|---|
| **① 제품 (배포 단위)** | `dist/plugin/` (조립물) | gitignore(`dist/`) | `build:plugin`이 제품 표면만 조립: `.claude-plugin/plugin.json` + `hooks/` + `agents/`(루트) + `skills/`(+`commands/`) + 컴파일된 `bin/`. `marketplace.json` source = `./dist/plugin`. `src`·`tests`·`schemas`·`.ditto`·`reports` 미포함. |
| **② 프로젝트 전역 (git 공유)** | `.ditto/knowledge/`, `.ditto/architecture-spec.json`, `.ditto/agents/` | tracked | 팀·다른 PC와 공유하는 거버넌스. `.ditto/.gitignore`가 `local/`만 ignore하고 `knowledge/`·`agents/`는 추적. |
| **③ 개인별 (gitignore)** | `.ditto/local/` (work-items·runs·sessions·cache·logs·worktrees·handoff·surfaces.json) | gitignored | 개발자·머신마다 다른 런타임 트레일. 모든 store가 `src/core/ditto-paths.ts`의 `localDir()` 단일 헬퍼를 경유. |

경계는 코드 한 곳(`ditto-paths.ts`)과 두 `.gitignore`(루트 + `.ditto/.gitignore`)에 모인다.

## 4. Scope에서 제외한 고위험 / 제품결정 후속항목 (기록만, 수행 안 함)

아래는 의도적으로 *이번에 하지 않는다*. 비가역이거나 제품 방향 결정이 필요해 사용자 판단·별도 work item이 적절하다.

1. **패턴 A — ADR 본문 evidence 분리.** `.ditto/knowledge/adr/*`의 GLOBAL 구조와 LOCAL 내용(이 레포 증거)을 본문 수준에서 분리하는 수술. 지식 손실 위험이 커 별도 검토 필요.
2. **`convergence-contract.md` 배선 또는 폐기.** `reports/design/contracts/convergence-contract.md`는 현재 orphan이다 — skill·src 어디서도 인용하지 않음(`grep -rln convergence-contract skills/ src/` = 0). wire(인용 배선) 할지 retire(폐기) 할지는 제품 결정.
3. **reports/의 LOCAL 파일 이동.** `ditto-install-distribution-record.md`, `ditto-v0-conformance-matrix.md`, `agentic-governance/reviews/*`는 본질이 LOCAL 런타임 흔적인데 `reports/`에 산다. `.ditto` 런타임 추적으로 옮기는 건 링크·인용 깨짐 위험이 있어 별도 작업.
4. ~~**배포 메커니즘 재작성.**~~ **해소(wi_2606071zj, ADR-0012):** `scripts/build-plugin.mjs`(`build:plugin`)가 `dist/plugin`에 제품 표면만 조립하고 `marketplace.json` source가 이를 가리킨다. install-plugin register/build/place도 `dist/plugin`에서 해석.
5. **`.ditto/local/work-items/` 런타임 흔적 정리.** work-items는 wi_2606071zj에서 `.ditto/local/`로 *이전*만 했다(개인구획·gitignore). 대량 LOCAL 추적의 아카이빙/정리 정책(ADR-0005는 수동 명령 아카이빙)은 여전히 별도(이동≠정리).
