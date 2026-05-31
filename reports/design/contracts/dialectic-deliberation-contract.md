---
title: "DITTO Dialectic Deliberation Contract (상세 설계)"
kind: design-detail
last_updated: 2026-05-26 KST
status: draft
parent: reports/design/ditto-claude-code-harness-design.md
owns: "§6.6 Dialectic Deliberation Contract의 'how' (3역 분리 메커니즘 · mode별 해석 · 모델 라우팅 · Codex Opponent bridge · 라운드 정책 · admissibility 연결 · dialectic-<n> 스키마)"
inputs:
  - reports/design/ditto-claude-code-harness-design.md  # §0 제1원칙·멘탈모델, §3.3 권위·run-with 격하, §6.6 Dialectic, §6.9 Convergence(admissibility), §7.4 dialectic-* agent, §11 원칙 10
  - reports/harnesses/hannes.md                          # §3.2 Codex-as-Opponent (mi-scope-fix close 후 codex+critic 적대 리뷰 BLOCKER 2건 → 재작업)
  - reports/harnesses/oh-my-codex.md                     # $ralplan Planner/Architect/Critic consensus · pre-execution gate
  - reports/harnesses/oh-my-openagent.md                 # Oracle read-only advisor · 구현 후 적대적 검토 · 멀티모델 정반합
  - reports/harnesses/superpowers.md                     # fresh subagent + 스펙 우선 리뷰
  - reports/harnesses/mattpocock-skills.md               # 문서 근거 우선 grill 계열
  - src/schemas/common.ts                                # 재사용 스키마 (authoritative): reviewId, providerName, verdict, severity, evidenceRef, schemaVersion
---

# DITTO Dialectic Deliberation Contract (상세 설계)

> **이 문서의 위치.** 이것은 메인 설계문서(`ditto-claude-code-harness-design.md`)의 §6.6을 대체하지 않고 **확장**한다. 메인은 "무엇(what)" — 목적, 3역 구조의 책임, 불변규칙 — 만 두고 "어떻게(how)"는 열어둔다. 이 문서가 그 how — Producer/Opponent/Synthesizer 3역 분리 메커니즘, mode별 해석, 모델 라우팅(특히 Codex 우선 Opponent와 그 bridge), 라운드 정책, §6.9 admissibility와의 연결, `dialectic-<n>.json/md` 스키마 — 를 소유한다. per-contract 상세 문서의 **세 번째 사례**다(선행: [`deep-interview-contract.md`](deep-interview-contract.md), [`autopilot-contract.md`](autopilot-contract.md)).

## 0. 권위 규칙 (메인 ↔ 상세 ↔ 스키마)

`ditto-application` 산출물은 세 층위로 나뉘고, 충돌 시 우선순위가 정해져 있다(메인 §3.3).

| 층위 | 소유 대상 | 충돌 시 |
|---|---|---|
| 실제 스키마 (`src/schemas/*.ts`, `schemas/*.json`) | 필드명, enum, validation | **최우선.** 본 문서 예시 JSON과 다르면 스키마가 이긴다. |
| 메인 설계문서 §6.6 | "what" — 3역의 목적·책임, 단일 skill 원칙, 불변규칙 | "what"이 충돌하면 메인이 이긴다. 본 문서는 메인과 모순되면 안 된다. |
| 본 상세문서 | "how" — 분리 메커니즘, mode 해석, 라우팅·fallback, bridge, 라운드 정책, 사이드카 구조 | "how"의 단일 출처. 메인은 여기로 링크만 한다. |

규칙: 본 문서의 예시 스키마는 **구현 전 반드시** 기존 Zod/JSON 스키마와 맞춘다. `dialectic-<n>.json`은 additive review artifact이며 `work-item.json` status나 `completion-contract`(§6.8)를 대체하지 않는다(메인 §3.3 매핑 표 "dialectic deliberation: 없음 → additive review artifact"). 본 문서가 §8.4에서 기록하는 **스키마 정합 flag**(severity·verdict 어휘 충돌)는 "how"/스키마 정합이므로 본 문서 권한 안에서 reconciliation note로 처리한다.

## 1. 목적과 경계

### 1.1 한 문장 정의

Dialectic Deliberation은 **결정·검토·제안·문서·답변 같은 high-impact 산출물에서, 한 모델 한 context의 자기 확신을 깨기 위해 Producer(최선 주장)·Opponent(근거 있는 공격)·Synthesizer(근거 기반 합성)를 서로 다른 context/모델로 분리 실행해, 더 강한 합의안 또는 명시적 보류 판단을 만드는 작성 품질 검증 계약**이다.

핵심 가설(실측 근거 있음): **동일 모델 계열 단일 context는 공통 맹점을 공유한다.** HANNES `mi-scope-fix`는 Stage 4 critic이 전부 Claude opus 동일 계열이라(`hannes.md` §3.2) 작업을 close한 *뒤에야* codex+critic 적대 리뷰에서 BLOCKER 2건이 드러나 `mi-scope-redesign`으로 재작업했다(`hannes.md` §3.2). 그 가장 비싼 lesson을 DITTO는 설계에 내장한다 — Opponent를 **Codex 우선**으로 라우팅(§3).

### 1.2 인접 계약과의 경계 (무엇이 Dialectic이 *아닌가*)

| 계약 | 다루는 것 | Dialectic과의 차이 |
|---|---|---|
| §6.3 Deep Interview | intent 층위 모호성 축소 (인터뷰어의 *내부* 소크라테스 자세) | Dialectic은 **plan/decision/document/answer 층위**를 별도 Opponent 에이전트로 적대 검증한다. omx `deep-interview`(의도수집) → `ralplan`(전방위 적대 분석)의 분리와 동형(`oh-my-codex.md:145,146`). intent도 안 정해진 상태에서 plan을 공격하면 strawman이 된다(deep-interview §1.2). |
| §6.5 Autopilot | 그래프 진행 드라이버 | Dialectic은 high-impact 노드(`review`·plan·architecture)에서 드라이버가 *호출*하는 검증 단계다(autopilot §2.2 review owner = "dialectic 3역"). 드라이버는 content를 안 만들고, Dialectic의 3역이 만든다. |
| §6.8 Completion / §6.7 Evidence / §6.10 E2E | **코드 동작** 검증, 완료 판정 | Dialectic은 **작성 품질** 검증이다(메인 §6.6 규칙: "이 계약은 작성 품질 검증용"). 코드가 실제로 도는지는 Dialectic이 보증하지 않는다 — Evidence/Verifier/E2E를 추가로 통과해야 한다(§7). |
| §6.9 Convergence | 반복 정련의 treadmill·조기수렴 차단, admissibility gate | Dialectic 라운드는 ConvergenceGate의 admissibility·ratchet·decision ledger 규율 *아래에서* 돈다(§6). Dialectic은 한 라운드의 3역 구조를, Convergence는 라운드 간 정련 품질을 맡는다. `cap-reached ≠ converged`를 공유. |
| `run with`(§3.3) | 격하된 provider 실행 기록 (smoke/debug/manual capture) | Codex Opponent **bridge**는 이 격하된 경로를 **재사용하지 않는** 별도 v0 설계 항목이다(§3.4, 메인 §6.6 마지막 bullet). |

## 2. 3역 분리 메커니즘 (서로 다른 context/agent)

메인 §6.6 규칙("Producer, Opponent, Synthesizer는 서로 다른 context/agent로 실행")과 §7.4("생성자, 반대자, 합의자는 같은 agent/context가 겸임하지 않는다")를 how로 구체화한다.

### 2.1 왜 분리인가

같은 context가 초안을 쓰고 곧바로 자기 초안을 비판하면, 이미 커밋한 가정을 방어하는 *확증* 자세로 미끄러진다. 분리의 목적은 두 가지다 — (a) **context 분리**: Opponent는 Producer의 사고 과정·합리화를 받지 않고 산출물만 본다. (b) **모델 분리**: Opponent를 다른 provider(Codex)로 두어 동일 계열 맹점을 깬다(§1.1).

### 2.2 3역 host (§7.4 agent 매핑)

| 역할 | 담당 agent(§7.4) | 권한 | 받는 것 / 안 받는 것 |
|---|---|---|---|
| Producer | `dialectic-producer` | read-only or docs write | 받음: intent_refs, acceptance_refs, target_artifact, evidence_refs. |
| Opponent | `dialectic-opponent` | read-only | 받음: Producer 출력(position·proposal·evidence·assumptions·known_limits) + 원 산출물 + acceptance_refs. **안 받음**: Producer의 사적 추론 로그, "이미 검토했다"는 안심 신호. Codex 우선(§3). |
| Synthesizer | `dialectic-synthesizer` | docs write allowed | 받음: Producer 출력 **전체** + Opponent 출력 **전체** + acceptance_refs + decision ledger(§6). |

분리 강제 규칙:

- **Producer→Opponent 전달 최소화.** Opponent는 검증 대상(산출물·proposal·evidence)만 받고, Producer가 *왜 그렇게 생각했는지*는 받지 않는다. 합리화에 동조하지 않게 한다(superpowers의 "fresh subagent + 스펙 우선 리뷰" 차용, `superpowers.md:305`).
- **Synthesizer는 중간값 기계가 아니다**(메인 §6.6 규칙). 양쪽 *전체*를 받아 evidence 기준으로 채택/기각한다. Opponent 의견을 자동 채택하지 않는다.
- 세 역할은 같은 turn 안에서도 **별도 spawn**이다. main agent가 한 프롬프트로 3역을 흉내내면 분리가 무효다.

## 3. 모델 라우팅

### 3.1 역할별 기본 라우팅 (메인 §6.6 "모델 라우팅")

| 역할 | 기본 | 고위험 시 | fallback |
|---|---|---|---|
| Producer | current-host 또는 claude-sonnet | claude-opus (전략 문서·고위험 결정) | — |
| Opponent | **codex (우선)** | codex | claude-opus → claude-sonnet (Codex 불가 시) |
| Synthesizer | claude-opus 또는 claude-sonnet | claude-opus | — |

목적: Opponent의 provider를 일부러 바꿔 "같은 Claude 계열 context/스타일의 공통 맹점"을 깬다(메인 §6.6). 이는 취향이 아니라 HANNES 실측 사례(§1.1)에서 온 기본값이다.

### 3.2 Codex 불가 시 fallback

Codex CLI, 인증, 네트워크, 비용, runtime 상태 때문에 Codex를 못 쓰면 Opponent는 **claude-opus → claude-sonnet** 순으로 fallback한다(메인 §6.6). fallback은 침묵하지 않는다 — artifact에 fallback 발생과 사유를 남긴다(§3.5). 동일 계열 Opus라도 분리된 context로 돌면 단일 context보다는 낫지만, 모델 다양성 이득은 줄어든다는 점을 verdict 신뢰도에 반영한다.

### 3.3 disagreement ≠ truth

멀티 모델 disagreement는 곧바로 진실이 아니다(메인 §6.6). disagreement는 **다음 둘 중 하나의 trigger**다:

- **추가 evidence 수집**: 어느 쪽이 맞는지 코드/문서/테스트로 확인 가능하면 Synthesizer가 evidence를 요구하고, 그 evidence가 채택 근거가 된다.
- **명시적 tradeoff 기록**: evidence로 결판나지 않으면(취향·전략 판단) Synthesizer는 한쪽으로 강제 수렴하지 않고 tradeoff를 `remaining_open_questions` 또는 결정 근거로 명시 기록한다.

`oh-my-openagent.md`의 Oracle은 architecture/self-review/hard debugging용 expensive read-only advisor로 기록돼 있다(`oh-my-openagent.md:134`) — Opponent도 같은 "비싼 read-only advisor" 성격이며, 그 출력을 자동 진실로 받지 않는다.

### 3.4 Codex Opponent 호출 = Codex plugin for Claude Code (codex-plugin-cc) 위임

Opponent의 Codex 실행은 **ditto가 raw CLI를 직접 조립·spawn하지 않는다.** Codex는 Claude Code용 **Codex 플러그인(codex-plugin-cc)** 을 통해 호출한다 — 이 플러그인은 로컬 Codex CLI/app-server에 위임하고 사용자의 기존 auth/config/MCP를 그대로 쓰는, Claude Code native 통합이다. 핵심 규칙:

- **계층 분리**: 라우팅 *판단*(codex 우선 → claude-opus → claude-sonnet, fallback 사유)은 ditto의 `OpponentModelRouter`(`src/core/opponent-router.ts`, 메인 §11 core interface)가 결정론으로 맡는다. 실제 *호출*은 dialectic skill 절차에서 **main agent가 codex-plugin-cc 표면으로 수행**한다 — task형 Opponent는 `codex:rescue` 위임, review형은 플러그인의 adversarial-review. 결과 *기록*은 schema(`opponent.run`)에 남긴다. (메인 §11 원칙 10: 판단/실행/기록 층위 분리.)
- ditto core에 별도 Codex 호출 glue(CLI 조립·IO·companion spawn)를 두지 않는다 — 그건 codex-plugin-cc의 책임이고, 내부 스크립트(예: `codex-companion.mjs`)를 ditto가 직접 부르지 않는다(버전 경로·lifecycle 우회 회피). 격하된 `run with`(§3.3)도 답습하지 않는다.
- 산출은 `dialectic-<n>.json`의 `opponent.run`에 provider/model/command/timestamp·fallback을 남겨 evidence로 추적된다(§3.5, §5.3).

> v0 범위 주의: codex-plugin-cc는 **있으면 우선** 경로다. main agent가 세션에 codex 플러그인이 있는지 보고(메인 §0 "v0: opponent/reviewer lane for dialectic checks when available"), 없거나 미인증이면 §3.2 fallback(claude-opus → claude-sonnet)이 정상 경로다. Codex 불가 자체는 실패가 아니다.

### 3.5 provider run 기록 (정직성)

Opponent가 Codex로 실행된 경우 artifact에 provider, model, command, timestamp, 실패/fallback 여부를 남긴다(메인 §6.6). 기존 `providerName` enum(`codex|claude-code|opencode|openagent|other`, `common.ts:33-35`)과 `runId`(`run_…`, `common.ts:16-19`)를 재사용한다 — 새 provider enum을 만들지 않는다.

## 4. mode별 해석 (각 mode에서 3역이 무엇을 하는가)

단일 skill `/ditto:dialectic --mode <mode>`(§5)의 `--mode`만 다를 뿐 3역 구조·산출물 schema는 동일하다(메인 §6.6 단일 skill 원칙). mode는 **3역의 작업 대상과 산출 형태**를 결정할 뿐이다.

| Mode | Producer | Opponent | Synthesizer | 비고 |
|---|---|---|---|---|
| `create` | 새 초안 작성 | 누락/약점 공격 | 최종 초안 작성 | Producer가 0→1 생성. |
| `review` | 기존 산출물의 **strongest defensible interpretation** | 결함/위험/검증 공백 공격 | accept/revise/reject 판단 | Producer가 최선 해석을 먼저 만들어 Opponent의 strawman을 방지(메인 §6.6 규칙). |
| `decision` | 선호 결정 + 근거 | 대안과 실패 가능성 | 결정 + tradeoff + 조건 정리 | disagreement→tradeoff 기록(§3.3)이 가장 자주 발동. |
| `proposal` | 제안서 작성 | 반대 논리 + 채택 장애물 | 사용자 제출용 제안 생성 | 사용자-facing 산출. |
| `document` | 문서 구조/초안 | 독자 관점 혼란 + 빠진 근거 | 최종 문서 개정안 | 독자 oracle. |
| `final-answer` | 답변 초안 | 과장/추측/근거 부족 공격 | 사용자에게 낼 최종 답변 | final answer 전 high-impact recommendation 검증(메인 §6.6 사용 시점). |

mode 집합은 v0 고정이다. 새 mode 추가는 본 문서 개정으로만 한다(drift 방지 — deep-interview §4.1·autopilot §2.2와 동형). alias(`/ditto:dialectic-review` 등)는 `--mode`만 박은 얇은 wrapper이지 새 mode가 아니다.

## 5. 산출물과 스키마

### 5.1 파일 (메인 §6.6 경로 유지)

```text
.ditto/work-items/<id>/reviews/dialectic-<n>.json   # 기계 판독용 3역 결과 + 최종 synthesis (본 문서 소유)
.ditto/work-items/<id>/reviews/dialectic-<n>.md      # 사람이 읽는 토론 로그 + 최종안
```

`<n>`은 work item 내 dialectic 회차다. `dialectic-<n>.json`은 additive review artifact이며 work item status/`completion.json`을 대체하지 않는다(§0). store는 메인 §11 `DialecticReviewStore`다.

### 5.2 입력 스키마 (메인 §6.6 입력 기준)

```json
{
  "schema_version": "0.1.0",
  "review_id": "rv_example1234",
  "mode": "create|review|decision|proposal|document|final-answer",
  "target_artifact": "path or inline brief",
  "question": "무엇을 합의해야 하는가",
  "intent_refs": ["intent.json"],
  "acceptance_refs": ["AC-1"],
  "evidence_refs": [],
  "constraints": {
    "scope_guard": [],
    "non_goals": [],
    "review_budget": "small|standard|thorough",
    "max_rounds": 1
  },
  "model_policy": {
    "producer": "current-host|claude-sonnet|claude-opus",
    "opponent_preferred": "codex",
    "opponent_fallback": ["claude-opus", "claude-sonnet"],
    "synthesizer": "claude-opus|claude-sonnet"
  }
}
```

재사용: `schema_version`(`0.1.0`, `common.ts:76-78`), `review_id`(`rv_…`, `common.ts:21-27`), `evidence_refs`의 각 항목은 `evidenceRef`(`common.ts:62-74`)를 그대로 쓴다. 신설: `mode`, `constraints`, `model_policy` enum/필드만.

### 5.3 Producer / Opponent / Synthesizer 출력 (메인 §6.6 JSON 기준)

Producer:

```json
{
  "position": "초안 또는 기존 산출물을 지지하는 최선의 주장",
  "proposal": "구체적 제안/수정안",
  "evidence": [],
  "assumptions": [],
  "known_limits": []
}
```

Opponent (각 objection은 acceptance criterion·파일/라인·문서 근거·사용자 의도 중 하나와 연결 — 메인 §6.6 규칙, §6 admissibility):

```json
{
  "run": {
    "provider": "codex|claude-code",
    "model": "...",
    "command": "...",
    "timestamp": "2026-05-26T00:00:00.000Z",
    "fallback_from": "codex",
    "fallback_reason": "auth|network|cost|runtime|none"
  },
  "objections": [
    {
      "severity": "critical|major|minor",
      "claim": "무엇이 문제인가",
      "evidence": [],
      "maps_to": "AC-3 | file:line | intent | doc",
      "failure_mode": "실패하면 어떤 일이 생기는가",
      "required_fix": "합의 전에 필요한 최소 수정"
    }
  ],
  "missing_alternatives": [],
  "scope_creep_risks": [],
  "verification_gaps": []
}
```

Synthesizer:

```json
{
  "verdict": "accept|revise|reject|blocked",
  "synthesis": "합의된 최종안",
  "accepted_objections": [],
  "rejected_objections": [
    { "objection": "반대 의견", "reason": "왜 채택하지 않는가 (raise만큼의 근거)", "evidence": [] }
  ],
  "required_edits": [],
  "remaining_open_questions": [],
  "evidence_refs": []
}
```

> **Reconciliation note (스키마 정합 flag).** 두 어휘 충돌을 발견했다. 본 문서는 구조만 박고, **구현 전 §8.4 결정에 따라 스키마와 정합한다**(스키마 최우선, §0):
> 1. **severity**: 메인 §6.6 Opponent는 `critical|major|minor`. `common.ts:45-47`의 `severity`는 `info|low|medium|high|critical`. 두 enum이 다르다.
> 2. **verdict**: 메인 §6.6 Synthesizer는 `accept|revise|reject|blocked`. `common.ts:37-39`의 `verdict`는 `pass|partial|fail|unverified`(acceptance/완료 판정용).

### 5.4 evidence·run 연결 (메인 §6.7·§3.3)

- 모든 objection·proposal·rejection은 `evidenceRef`(`common.ts:62-74`)로 근거에 묶인다(메인 §6.6: 반론은 파일/라인·문서·의도·AC 중 하나와 연결). 백킹 없는 주장은 `finding`이 아니라 `hypothesis`로 라벨링하고 행동하지 않는다(§6.9 정직 라벨).
- Codex Opponent run은 `opponent.run`에 §3.4 bridge가 남긴 provider/model/command/timestamp/fallback을 둔다. raw CLI 출력이 아니라 요약/exit 신호로 렌더링한다(메인 §6.7).

## 6. §6.9 Convergence admissibility와의 연결

Dialectic 라운드는 §6.9 ConvergenceGate의 규율 아래에서 돈다. **반론이 *행동*(수정/기각)을 트리거할 자격**은 다음을 모두 충족할 때만 생긴다(메인 §6.9 admissibility gate):

- (a) **oracle**: 구체적 반례를 인스턴스화하거나, 위반하는 acceptance criterion에 매핑된다(Opponent 출력 `maps_to`). criteria가 바닥이다 — AC에 매핑되는 반론은 절대 inadmissible로 선언할 수 없다(메인 §6.9 묵살 불가 원칙).
- (b) **memory(신규성)**: decision ledger에 없던 신규 반론이다. 이미 기각된 지점을 새 근거 없이 재제기하면 자동 각하된다(메인 §6.9 ratchet → A→B→A 진동 차단).
- (c) **severity**: critical/major일 때만 admissible(메인 §6.9). minor·취향은 행동을 강제하지 못한다.

대칭 원칙: 반론을 *기각*하는 데도 raise만큼의 이유+근거가 든다(메인 §6.9). 그래서 Synthesizer의 `rejected_objections`는 `reason`+`evidence`를 비울 수 없다(§5.3).

**작성 품질 검증이지 코드 동작 검증이 아니다.** admissibility는 "이 반론이 산출물 *문서/결정*의 품질에 대해 행동을 요구하는가"를 판정한다. 코드가 실제로 도는지는 §6.7 Evidence / Verifier / §6.10 E2E가 fresh evidence로 별도 판정한다(메인 §6.6 마지막 규칙). Dialectic의 `accept`는 "작성이 견고하다"는 뜻이지 "코드가 통과했다"가 아니다.

## 7. 라운드 정책 (소규모 1회 기본 · 무한 debate 금지)

- **기본 max_rounds = 1**(메인 §6.6 입력 default, §6.6 규칙 "한 번의 소규모 토론을 기본"). `review_budget`(`small|standard|thorough`)로 조정하되 무한 debate를 만들지 않는다.
- 라운드 1에 두 게이트(모든 AC 증거로 닫힘 + admissible 열린 반론 0개)가 참이면 라운드 1에 멈춘다(메인 §6.9 수렴 정의).
- **critical objection이 남으면 `accept` 불가**(메인 §6.6 규칙). 남은 critical은 `revise`(required_fix 반영) 또는 `blocked`(user-owned/external)로 닫는다.
- **cap_reached ≠ converged.** max_rounds 도달 시 두 게이트를 못 채우면 그건 done이 아니라 non-pass다. 최종 verdict(`partial|fail|unverified`)와 work item status는 §6.8 CompletionContract가 결정하고 §6.10 handoff한다(메인 §6.9, autopilot §4.3과 동형).
- ratchet(메인 §6.9): 산출물은 "마지막 버전"이 아니라 "최고 점수 버전"으로 한다. 라운드를 더 돌아 degradation이 일어나지 않게 decision ledger가 채택/기각을 구속한다.

`oh-my-codex.md`의 `$ralplan`은 Planner/Architect/Critic을 순차 돌려 consensus plan을 만들되 pre-execution/concrete-signal gate로 무모한 실행 진입을 막는다(`oh-my-codex.md:146`). DITTO는 이 "검토 루프 + gate" 패턴을 단일 소규모 라운드 + 두 게이트로 경량화한다.

## 8. 불변 규칙 요약 (체크리스트)

- [ ] Producer/Opponent/Synthesizer는 서로 다른 context/agent로 **별도 spawn**한다(겸임 금지).
- [ ] Opponent는 Producer의 사적 추론을 받지 않고 산출물·proposal·evidence만 받는다.
- [ ] Opponent는 Codex 우선, 불가 시 claude-opus → claude-sonnet fallback(침묵 금지, 사유 기록).
- [ ] Codex Opponent는 별도 bridge로 호출한다 — 격하된 `run with`(§3.3) 재사용 금지.
- [ ] disagreement는 진실이 아니라 추가 evidence 또는 tradeoff 기록의 trigger다.
- [ ] 모든 objection·rejection은 evidenceRef로 근거에 묶인다. 백킹 없으면 `hypothesis`, 행동 금지.
- [ ] AC에 매핑되는 반론은 inadmissible로 선언할 수 없다(criteria가 바닥).
- [ ] 반론 기각에도 raise만큼의 이유+근거가 든다(대칭 원칙).
- [ ] 기본 1라운드. 무한 debate 금지. critical objection 남으면 `accept` 불가.
- [ ] cap_reached ≠ converged. non-pass는 §6.8이 verdict 결정 + handoff.
- [ ] canonical skill은 `/ditto:dialectic` 하나. 나머지는 `--mode` alias.
- [ ] 작성 품질 검증이다. 코드 동작은 Evidence/Verifier/E2E가 별도 판정한다.

## 9. 참조 하네스 매핑 (무엇을 어디서 차용했는가)

| 차용 요소 | 출처 | 본 설계 반영 |
|---|---|---|
| Codex 우선 Opponent (동일계열 맹점 차단) | HANNES `mi-scope-fix` — close 후 codex+critic 적대 리뷰로 BLOCKER 2건, `mi-scope-redesign` 재작업 (`hannes.md` §3.2) | §1.1, §3.1 기본 라우팅 (가장 비싼 lesson → 기본 정책) |
| Planner/Architect/Critic consensus + pre-execution gate | omx `$ralplan` (`oh-my-codex.md:146`) | §7 라운드 + 두 게이트 경량화 |
| 의도수집과 전방위 적대 분석의 분리 | omx `deep-interview` → `ralplan` (`oh-my-codex.md:145,146`) | §1.2 Deep Interview(intent) vs Dialectic(plan) |
| 비싼 read-only advisor 성격의 적대 검토 | Sisyphus Oracle (`oh-my-openagent.md:134`), 구현 후 적대적 검토 (`oh-my-openagent.md:220,221`) | §2.2 Opponent host, §3.3 출력 자동신뢰 금지 |
| fresh subagent + 스펙 우선 리뷰 | superpowers (`superpowers.md:305`) | §2.2 Producer→Opponent 전달 최소화 |
| 문서 근거 우선 검토 | mattpocock grill 계열 (`mattpocock-skills.md`) | §5.4 evidenceRef 결속, §6 oracle |

## 10. 구현 참조

> 본 계약의 가장 가까운 선행 *실측*은 HANNES `mi-scope-fix`의 post-close 적대 리뷰다. 직접 분석: [`reports/harnesses/hannes.md`](../../harnesses/hannes.md) §3.2(원본 `registry.json`의 `verdict_post_close_amendment`를 정적으로 읽음). HANNES Stage 4 critic은 `.claude/agents/critic.md`에서 `model: opus` 동일 계열로 기록돼 있다(`hannes.md` §3.2). 아래는 본 계약 구현 시 직접 참조할 매핑이다.

| 본 계약 요소 | 레퍼런스 | 근거 |
|---|---|---|
| §3.1 Opponent = Codex 우선 라우팅 | HANNES `mi-scope-fix` "PARTIAL — adversarial review (codex + critic) post-close 에서 두 BLOCKER 발견" → `mi-scope-redesign` | `hannes.md` §3.2 |
| §1.1 동일계열 맹점 가설의 실측 acceptance 근거 | "모델 다양성이 동일계열 맹점을 잡는다" 실측 사례로 인용 가능 | `hannes.md` §6 (acceptance 근거 항목) |
| §7 consensus + pre-execution gate | omx `$ralplan` Planner/Architect/Critic + concrete signal gate | `oh-my-codex.md:146` (보고서가 `skills/ralplan/SKILL.md:8-156`을 인용) |
| §3.4 bridge가 `run with` 재사용 안 함 | `run with`는 smoke/debug/manual capture로 격하, native session/hook 우회로 primary 금지 | 메인 §3.3 "run with 처리" |
| §11 router/glue/schema 층위 분리 | 판단(LLM)과 결정론(코드) 층위 비혼합; HANNES가 판단을 hook에 누출시킨 mutation cycle 답습 금지 | 메인 §11 원칙 10 (`hannes.md` §5) |

DITTO 적용 시 주의: §8.4(=§5.3 reconciliation note)의 severity·verdict 어휘 충돌은 구현 전 스키마와 정합한다(스키마 최우선, §0). Opponent의 `critical|major|minor`와 Synthesizer의 `accept|revise|reject|blocked`를 신규 dialectic-전용 enum으로 둘지, `common.ts`의 기존 `severity`/`verdict`에 매핑할지는 dialectic 스키마 신설 시 결정한다. dialectic 전용 스키마(`src/schemas/dialectic-*.ts`)는 아직 **없으며**, 신설은 additive다(메인 §3.3 매핑: "dialectic deliberation: 없음").
