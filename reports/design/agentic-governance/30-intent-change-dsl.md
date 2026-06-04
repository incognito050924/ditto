---
title: "ICL — Intent-Change Language"
kind: dsl
last_updated: 2026-06-04 KST
status: draft
scope: "사용자/agent의 변경 의도를 선언적으로 표현하고, 단일 출처에서 agent 제약·자동 게이트·사람용 변경지도를 일관 파생하는 DSL의 문법·의미론·컴파일 명세."
parent: 00-framework.md
---

# ICL — Intent-Change Language

> **이 문서의 위치.** ACG의 DSL 축. 사용자가 요구한 파이프라인 `사용자의 의도 > [DSL 해석기] > 코드 또는 그에 준하는 산출물`을 구체화한다. ICL은 코드를 생성하는 언어가 아니라 **변경의 의도와 경계를 선언**하는 언어다. 하나의 ICL 선언이 세 산출물로 컴파일된다 — agent 행동 제약, 자동 적합성 게이트, 사람용 변경 지도. 이 "단일 출처 → 세 타깃"이 ICL의 존재 이유다.

## 0. 왜 DSL인가 (그리고 왜 코드 생성 DSL이 아닌가)

agent에게 자연어로 "X만 바꾸고 Y는 건드리지 마"라고 말하면, 그 제약은 (1) 휘발되고, (2) 기계가 검사할 수 없고, (3) 사람과 agent가 같은 것을 봤는지 확인할 수 없다. ICL은 이 세 약점을 동시에 친다:

- **고정**: 의도가 파싱 가능한 산출물(`.icl`)로 남는다.
- **검사 가능**: 컴파일된 제약을 단계 6 게이트가 자동 검사한다.
- **공유**: 같은 선언에서 사람용 지도가 파생되므로, 사람과 agent가 같은 계약을 본다.

ICL은 **코드를 생성하지 않는다.** [00](00-framework.md) §2.1의 "변경의 1급화"를 언어 수준에서 실현한 것이다 — 코드가 아니라 *변경의 명세*가 1급 산출물이다. 이는 사용자 요청의 "코드 **또는 그에 준하는 산출물**"에서 후자를 택한 것이다: 코드 생성보다 변경 거버넌스 산출물 생성이 ACG의 가치와 직결되기 때문이다.

## 1. 표현력 경계 (열린질문 2의 답)

ICL로 모든 의도를 표현하려 하면 표현 비용이 가치를 넘어 아무도 안 쓴다([00](00-framework.md) §9). 그래서 경계를 명시한다:

| 의도의 종류 | ICL로 표현? | 이유 |
|---|---|---|
| 변경 범위(허용/금지) | **예** | 기계 검사의 핵심. 강제력이 가치를 만든다 |
| 불변식·acceptance | **예** | 게이트·적합성 함수로 직결 |
| 위험도·승격 여부 | **예** | 한 단어 선언으로 충분 |
| *어떻게* 구현할지 | 아니오 | agent의 판단 영역. ICL은 경계만, 구현은 자유 |
| 도메인 의미의 미묘함 | 자연어 `rationale` | 형식화 비용 > 가치. 자유 텍스트 필드로 흡수 |

원칙: **ICL은 경계를 선언하고, 구현은 선언하지 않는다.** 의도의 "무엇을 보호하나"는 형식으로, "어떻게 만드나"는 agent에게 맡긴다.

## 2. 문법 (EBNF)

```ebnf
(* ICL v1 — Intent-Change Language *)
program        = intent_block , { fitness_block } ;

intent_block   = "intent" , string , "{" ,
                   purpose ,
                   scope_section ,
                   [ invariant_section ] ,
                   acceptance_section ,
                   [ meta_section ] ,
                 "}" ;

purpose        = "purpose" , ":" , string ;

scope_section  = "allow" , "{" , { scope_ref } , "}" ,
                 "forbid" , "{" , scope_ref , { scope_ref } , "}" ;  (* forbid 최소 1개 *)

scope_ref      = scope_kind , string , [ "as" , string ] , [ note ] ;
scope_kind     = "path" | "glob" | "symbol" | "surface" | "layer" ;
note           = "#" , string ;

invariant_section = "invariant" , "{" , { invariant_decl } , "}" ;
invariant_decl    = string , [ "promote" ] ;   (* promote → FitnessFunction 승격 *)

acceptance_section = "accept" , "{" , accept_decl , { accept_decl } , "}" ;
accept_decl        = string , "by" , evidence_kind ;
evidence_kind      = "test" | "build" | "log" | "diff" | "screen" | "manual" | "e2e" ;  (* 20 §1과 일치 *)

meta_section   = "meta" , "{" , { meta_decl } , "}" ;
meta_decl      = ( "risk" , ":" , risk_level )
               | ( "decision" , ":" , string )
               | ( "rationale" , ":" , string ) ;   (* 자유 텍스트 — 도메인 의미 흡수 *)
risk_level     = "low" | "medium" | "high" ;

fitness_block  = "fitness" , string , "{" ,
                   "statement" , ":" , string ,
                   "kind" , ":" , fitness_kind ,
                   "check" , ":" , ( "cmd" string | "query" string | "judge" string ) ,
                   "when" , ":" , cadence ,
                   "on_violation" , ":" , violation_action ,
                 "}" ;
fitness_kind     = "architectural" | "dependency" | "semantic" | "coverage" | "consistency"
                 | "performance" | "duplication" | "complexity" | "user_journey" ;  (* 20 §6 kind와 일치 *)
cadence          = "per_change"
                 | "periodic" , "(" , frequency , ")"
                 | "both" , "(" , frequency , ")" ;   (* periodic/both는 빈도 필수 — schema 무손실 매핑 *)
frequency        = "daily" | "weekly" | "on_release" ;
violation_action = "block" | "warn" | "track" ;

string         = '"' , { character } , '"' ;
```

## 3. 의미론 (semantics)

각 구문이 [20-contracts.md](20-contracts.md)의 어느 필드로 매핑되는지가 의미론의 전부다. ICL은 ChangeContract의 **표면 문법**이고, 의미는 컴파일 결과로 정의된다.

| ICL 구문 | 매핑 | 의미 |
|---|---|---|
| `intent "..." { purpose: }` | `ChangeContract.purpose` | 달성할 결과 |
| `allow { ... }` | `allowed_scope` | 변경 사전조건. 이 밖을 건드리면 위반 |
| `forbid { ... }` (≥1) | `forbidden_scope` | 변경 불변. 비면 컴파일 에러 |
| `invariant { "..." promote }` | `invariants[promotable=true]` | 단계 8에서 적합성 함수 승격 |
| `accept { "..." by test }` | `acceptance` | 증거 종류와 함께 완료 기준 |
| `meta { risk: high }` | `risk_default` | 기본 위험도 |
| `meta { decision: }` | `decision_ref` | ADR 연결 |
| `meta { rationale: }` | (Change Map 주석) | 형식화하지 않는 도메인 맥락 |
| `fitness "..." { ... }` | `FitnessFunction` | 직접 적합성 함수 선언 |

**scope_ref 매핑** (OBJ-33 — ICL `scope_kind` → `ChangeContract.scopeRef.kind`):

| ICL `scope_kind` | → `scopeRef.kind` |
|---|---|
| `path` | `path` |
| `glob` | `glob` |
| `symbol` | `symbol` |
| `surface` | `public_surface` |
| `layer` | `layer` |

`scope_ref`의 `as "<별칭>"`은 `scopeRef`에 대응 필드가 없으므로 `scopeRef.note`로 싣는다(표시용 별칭이 유실되지 않게). `# <note>`도 같은 `scopeRef.note`로 합쳐진다.

**fitness check 매핑** (OBJ-34 — ICL `check` → `FitnessFunction.evaluator.mode`/`spec`):

| ICL `check` | → `evaluator.mode` | → `evaluator.spec` |
|---|---|---|
| `cmd "<명령>"` | `deterministic` | 명령 문자열 |
| `query "<쿼리>"` | `deterministic` | 쿼리(예: CodeQL `.ql`) |
| `judge "<프롬프트>"` | `llm_judged` | 판정 프롬프트 |

`evaluator.mode: executed`(e2e 등 실행 증거)는 **ICL로 선언하지 않는다** — 실행 정책(env·retries·selection)이 ICL 표현력 경계(§1) 밖이므로, executed fitness는 `FitnessFunction`을 직접 작성한다. `judge`로 컴파일되는 `llm_judged`는 `reproducibility` **object**(20 §6: model_version/prompt_hash/votes/tie_break/input_fixing)가 필요하며, ICL 해석기는 그 기본값(diff 고정·3회 다수결·fail_closed)을 채워 컴파일한다.

**정적 검사 규칙** (해석기가 컴파일 전 검증):
1. `forbid` 블록이 비어 있으면 에러(무제한 변경 방지).
2. `allow`와 `forbid`의 scope_ref가 겹치면 에러(모순).
3. `accept`가 비어 있으면 에러(완료 기준 없는 변경 금지).
4. `invariant ... promote`인데 대응 `fitness`가 없으면 경고(승격 의도가 함수로 구체화 안 됨 → 단계 8에서 생성 요구).

**cadence 컴파일 규칙** (OBJ-05 반영 — ICL `when`을 [20](20-contracts.md) §6 `FitnessFunction.cadence`로 무손실 매핑):

| ICL `when` | → schema `cadence` |
|---|---|
| `per_change` | `{ per_change: true, periodic: "none" }` |
| `periodic(weekly)` | `{ per_change: false, periodic: "weekly" }` |
| `both(on_release)` | `{ per_change: true, periodic: "on_release" }` |

`periodic`/`both`는 빈도 인자가 EBNF에서 필수이므로, schema의 `periodic` enum 값이 항상 결정된다 — 빈도 미지정으로 인한 컴파일 손실이 없다.

## 4. 컴파일 — 단일 출처에서 세 타깃

ICL 해석기는 하나의 `.icl`을 세 산출물로 컴파일한다. 이것이 ICL의 핵심 가치다.

```text
                          ┌──────────────────────────────┐
                          │  intent "..." { ... }  (.icl) │
                          └───────────────┬──────────────┘
                                          │  ICL 해석기
                 ┌────────────────────────┼────────────────────────┐
                 ▼                        ▼                        ▼
        (A) Agent 제약            (B) Fitness Gate           (C) Change Map
        allowed/forbidden을       검사 가능한 술어로          사람용 표기(50)로
        agent 컨텍스트에 주입.     컴파일 → 단계6에서 실행.    렌더 → exception만 노출.
        agent의 행동 경계.        지속 적합성 등록.           의사소통.
```

세 타깃이 **단일 출처에서 파생되므로 드리프트가 불가능하다** — agent가 보는 제약, 게이트가 검사하는 술어, 사람이 보는 지도가 항상 일치한다. 자연어 지시에서는 이 셋이 따로 놀았다.

> **정직한 단서(OBJ-06 반영).** 드리프트 부재의 진짜 조건은 "ICL을 쓴다"가 아니라 "**세 타깃을 단일 출처에서 자동 파생한다**"이다. ICL은 그 단일 출처를 *의도 레벨*로 끌어올린 가장 편한 형태일 뿐이다. ICL을 우회해 `ChangeContract`를 직접 작성해도, (A)(B)(C)를 그 ChangeContract 하나에서 파생하는 한 드리프트는 없다 — 이 경우 단일 출처가 ChangeContract로 한 단계 내려올 뿐이다. 드리프트가 생기는 유일한 경우는 세 타깃을 *각각 손으로 따로* 관리할 때이며, ACG는 (ICL 사용 여부와 무관하게) 그것을 금지한다. 즉 anti-drift는 ICL의 전유물이 아니라 "단일 출처 → 자동 파생" 규칙의 결과다.

### (A) Agent 제약

`allow`/`forbid`/`invariant`를 agent의 작업 컨텍스트에 주입할 제약 텍스트 + 기계 검사용 경로 매처로 변환. 단계 5에서 agent가 forbidden_scope를 건드리면 PreToolUse 훅(DITTO에 이미 존재) 수준에서 차단 가능.

### (B) Fitness Gate

`accept`와 `invariant`를 단계 6 게이트가 실행할 술어로 변환. `promote`된 불변식과 `fitness` 블록은 Assurance Graph에 등록되어 *이후 모든 변경*에서 평가된다.

### (C) Change Map

`purpose`/`scope`/`risk`/`rationale`을 [50-change-map.md](50-change-map.md)의 노드·경계·위험색으로 렌더. ImpactGraph가 채워지면 영향 엣지가 더해진다.

## 5. 완전한 예시 (boxwood)

### 입력 — `retry-policy.icl`

```icl
intent "automation-engine 외부 태스크 재시도를 지수 백오프로" {
  purpose: "고정 3회 재시도를 1s/2s/4s 지수 백오프로 변경한다"

  allow {
    glob "automation-engine/**/runtime/**"
    glob "automation-engine/**/test/**/RetryPolicy*" as "관련 테스트"
  }
  forbid {
    layer "kafka-adapter"                       # 메시지 계약 불변
    surface "external-client task contract"
    symbol "TenantContext"                      # 테넌트 격리 불변
  }

  invariant {
    "external-client가 받는 태스크 페이로드 형태는 동일하다"
    "재시도 중에도 tenant 격리가 유지된다" promote
  }

  accept {
    "재시도 간격이 1s,2s,4s 지수 백오프를 따른다" by test
    "기존 RetryPolicy 단위 테스트가 통과한다" by test
  }

  meta {
    risk: medium
    decision: "ADR-automation-0007"
    rationale: "automation-engine 커버리지 2.7%라 회귀 위험 높음 — characterization test 선행"
  }
}

fitness "tenant 격리 불변" {
  statement: "재시도 경로에서 TenantContext가 항상 전파된다"
  kind: semantic
  check: judge "재시도 핸들러 diff에서 TenantContext 전파가 누락되지 않았는가"
  when: per_change
  on_violation: warn
}
```

### 출력 (A) — Agent 제약 (발췌)

```text
[SCOPE] 수정 허용: automation-engine/**/runtime/**, .../test/**/RetryPolicy*
[FORBID] 수정 금지: kafka-adapter 레이어, external-client task contract(public), TenantContext 심볼
  → 이 경로 편집 시도 시 차단하고 사용자에게 의도 재확인
[INVARIANT] 변경 후 검증: 페이로드 형태 동일, tenant 격리 유지
```

### 출력 (B) — Fitness Gate (= [20](20-contracts.md) FitnessFunction)

```json
{
  "schema": "acg.fitness-function.v1",
  "id": "ff-retry-tenant-isolation",
  "statement": "재시도 경로에서 TenantContext가 항상 전파된다",
  "kind": "semantic",
  "evaluator": {
    "mode": "llm_judged",
    "spec": "재시도 핸들러 diff에서 TenantContext 전파 누락 여부 판정",
    "reproducibility": { "model_version": "claude-opus-4-8", "votes": 3, "tie_break": "fail_closed", "input_fixing": "변경 diff 전체" }
  },
  "cadence": { "per_change": true, "periodic": "none" },
  "on_violation": "warn",
  "source_change": "<work_item>"
}
```

### 출력 (C) — Change Map (요약, 전체 표기는 [50](50-change-map.md))

```text
◆ retry-policy [medium]  purpose: 재시도를 지수 백오프로
  allow ─ runtime/**, test/RetryPolicy*
  forbid ─ ✕ kafka-adapter  ✕ external-client contract  ✕ TenantContext
  accept ─ ☐ 백오프 간격(test)  ☐ 기존 테스트(test)
  ! rationale: 커버리지 2.7% → characterization 선행
```

## 6. 해석기의 형태 (구현은 범위 밖)

이 문서는 설계까지다([plan] DSL 깊이 = 문법·의미론·예시). 구현 시 참고:

- 해석기는 코드 생성기가 아니라 **변환기**다: `.icl` → 3개 JSON/텍스트 산출물.
- DITTO에서는 main agent가 ICL을 작성하고, 얇은 변환 단계(스킬 또는 작은 스크립트)가 세 타깃을 만든다. 거대 런타임 불필요.
- ICL을 안 쓰고 ChangeContract를 직접 써도 된다 — ICL은 사람이 의도를 빠르게 선언하기 위한 *편의 표면*이지 필수 경로가 아니다.

## 7. 다음 문서

- 컴파일 타깃 (A)(B)의 스키마 → [20-contracts.md](20-contracts.md)
- 컴파일 타깃 (C)의 전체 표기법 → [50-change-map.md](50-change-map.md)
- ICL이 강제하는 리팩토링·모듈 설계 경계 → [40-refactoring-criteria.md](40-refactoring-criteria.md)
