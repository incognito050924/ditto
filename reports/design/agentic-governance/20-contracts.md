---
title: "ACG Contracts — Schema Specification"
kind: schema
last_updated: 2026-06-04 KST
status: draft
scope: "ACG 스펙 계층의 9개 산출물 스키마를 JSON Schema + 필드 정의 + 예시로 명세하고, 각 산출물의 DITTO 바인딩(실현체) 매핑을 §0에 둔다. boxwood를 두 번째 바인딩 소재로 인용한다."
parent: 00-framework.md
---

# ACG Contracts — Schema Specification

> **이 문서의 위치.** [10-methodology.md](10-methodology.md)의 각 단계가 만드는 산출물을 형식 스키마로 고정한다. 목적은 두 가지다: (1) agent가 만든 산출물을 기계가 검증할 수 있게 하고, (2) reviewer/verifier가 같은 구조를 다시 검사할 수 있게 한다.
>
> **스펙 계층임을 명시한다.** 이 문서의 9개 스키마는 [00](00-framework.md)의 stack-agnostic 노트(스펙/바인딩 분리)가 말하는 **스펙 계층**이다 — 각 산출물이 실어야 할 *정보*를 정의하지, 특정 저장소의 wire format을 정의하지 않는다. `$id`의 `acg.<name>.v1`은 추상 스펙 식별자이며, 실제 저장된 파일은 그 저장소의 바인딩이 정한 형식을 따른다. **DITTO 바인딩**(첫 번째 바인딩)에서 각 스펙 산출물이 어떤 DITTO 스키마로 실현되고 필드/머리표(envelope)/evidence 종류가 어떻게 매핑되는지는 아래 §0의 *DITTO 바인딩 표*가 가진다. boxwood 바인딩은 같은 정보를 boxwood 자산으로 다르게 실현한다.

## 0. 스키마 목록과 DITTO 바인딩

스펙 산출물 9종과, 각각이 **DITTO 바인딩**에서 실현되는 방식이다. "실현 방식": **확장**=DITTO 기존 스키마에 필드 추가, **투영**=기존 계약의 변경 시점 부분 뷰, **신설**=DITTO에 대응물이 없어 새 스키마.

| 스키마 | 단계 | DITTO 실현 방식 | DITTO 실현체 |
|---|---|---|---|
| `ChangeContract` | 2 | **투영(얇게)** | `IntentContract`의 변경 시점 투영 (work item sidecar) |
| `ImpactGraph` | 3 | **신설** | (DITTO에 대응물 없음) |
| `ArchitectureSpec` | 3 | **신설(저장소당 1회)** | `.ditto/knowledge`에 보관 |
| `SemanticCompatibility` | 6 | **신설** | reviewer/verifier가 소비 |
| `ReviewGraph` | 7 | **확장** | `reviewer-output` 스키마 확장 (§0.2 바인딩 표) |
| `FitnessFunction` | 8 | **신설** | (DITTO·boxwood 모두 없음) |
| `AssuranceSnapshot` | 8(지속) | **신설** | Assurance Graph의 시계열 단위 |
| `JourneySpec` | 0(저장소 카탈로그) | **신설** | 사용자 여정의 1급 명세. ImpactGraph·ReviewGraph·FitnessFunction이 `journey_id`로 참조 |
| `JourneyRun` | 6 | **확장** | DITTO `e2eJourney`(`e2e` 스킬 산출물)로 실현 (§0.2 바인딩 표) |

### 0.1 공통 envelope — 스펙이 요구하는 정보 (필드명 아님)

스펙 계층은 모든 산출물이 **다음 정보를 실어야 한다**고만 요구한다. *칸 이름*은 바인딩이 정한다 — 같은 정보를 어느 이름으로 싣는가는 저장소 약속의 문제이지 스펙의 문제가 아니다(OBJ-35).

| 스펙이 요구하는 정보 | 의미 |
|---|---|
| 산출물 종류 | 어떤 스키마인지 |
| 소속 work item | 어느 작업에서 나왔는지 |
| provenance | 누가(agent/user)·언제 만들었는지 |

이 문서의 JSON 예시 블록은 가독성을 위해 `schema`/`work_item`/`produced_by`/`produced_at`라는 *스펙 표기*를 쓴다. 이는 wire format이 아니라 위 정보의 자리표시이며, 실제 저장 형식은 §0.2의 바인딩이 정한다.

```json
{
  "schema": "acg.<name>.v1",
  "work_item": "wi_xxxxxxxxx",
  "produced_by": "agent|user",
  "produced_at": "2026-06-03T00:00:00Z"
}
```

> 예시의 `produced_at` 등 타임스탬프는 산출 시점에 런타임이 채운다.

### 0.2 DITTO 바인딩 표 (필드·envelope·evidence·재사용 매핑)

스펙 표기가 DITTO 실제 스키마로 내려가는 방식의 단일 출처다. v0 구현은 이 표를 코드로 옮긴다.

**envelope 매핑:**

| 스펙 정보 | DITTO 필드 | 비고 |
|---|---|---|
| 산출물 종류 | `schema_version`(const) + 스키마별 `kind`/`$id` | DITTO는 버전을 `schema_version`으로 분리 |
| 소속 work item | `work_item_id` (`^wi_…`) | 스펙 `work_item` → DITTO `work_item_id` |
| provenance(누구) | `produced_by` 또는 산출물별 행위자 필드(reviewer 등) | 스키마별 기존 필드 우선 |
| provenance(언제) | 기존 타임스탬프 필드 | 런타임이 채움 |
| 산출물 식별자 | `id` (`^rv_…` 등 prefix) | DITTO 산출물은 자체 id 보유 |

**`ReviewGraph` ← `reviewer-output` 확장 (OBJ-36):** ReviewGraph는 별도 wire format이 아니라 reviewer-output에 거버넌스 분류를 더한 뷰다.

| ReviewGraph(스펙) | reviewer-output(DITTO) 바인딩 |
|---|---|
| `files[].path` | finding의 위치(파일) |
| `files[].role`/`risk`/`risk_reason` | finding에 거버넌스 분류 필드로 추가(확장점) |
| `files[].evidence` | reviewer-output `evidence[]` 재사용 |
| 미해소 항목 | reviewer-output `unverified[]` 재사용 |
| `human_review_set` | high-risk·unresolved 집계 뷰(파생) |

> reviewer-output이 `additionalProperties:false`면, 거버넌스 필드는 별도 확장 객체(예: `acg_review`) 또는 reviewer-output 스키마에 옵셔널 필드 추가로 싣는다 — 어느 쪽인지는 v0에서 확정.

**evidence 종류 매핑 (OBJ-38):** 스펙 `evidence_kind`(test/build/log/diff/screen/manual/e2e) ↔ DITTO `evidenceRef.kind`(command/file/artifact/url/note).

| 스펙 evidence_kind | DITTO evidenceRef.kind |
|---|---|
| test / build | `command` (실행 명령 + 결과) |
| log / diff / screen | `artifact` 또는 `file` |
| manual | `note` |
| e2e | `artifact`, ref는 `JourneyRun`(아래) |

> ReviewGraph evidence의 `unresolved`는 evidenceRef.kind가 아니다 — 증거 부재 표식이므로 evidence 칸을 비우고 별도 unresolved marker로 싣는다.

**`JourneyRun` ← `e2eJourney` 매핑 (OBJ-39):**

| JourneyRun(스펙) | e2eJourney(DITTO) 바인딩 |
|---|---|
| `journey_id` | `journey`(이름)에 JourneySpec.id를 싣거나 신규 `journey_id` 필드 추가 |
| `outcome`: pass/fail/flaky/skipped | `result`: pass/fail/blocked → pass=pass, fail=fail, **blocked→skipped**. `flaky`는 스펙 outcome이나 **현 e2eJourney는 산출하지 않는다**(result enum에 없음) — 향후 e2e가 재시도 탐지를 추가하면 매핑, 그 전까지 DITTO 바인딩은 pass/fail/skipped만 낸다 |
| `step_results` | e2eJourney `steps[]` |
| `artifacts` | e2eJourney `artifacts.{screenshots,trace,console,network}` |

---

## 1. ChangeContract

**역할.** Design by Contract를 변경에 적용한 산출물. 변경의 사전조건(허용 범위)·사후조건(불변식 보존)·금지영역을 명세한다. IntentContract의 *변경 시점 투영*이며, 거대한 독립 계약이 아니라 work item sidecar로 얇게 유지한다.

> **원전과의 차이.** Meyer의 DbC는 *함수* 호출의 pre/post/invariant를 다룬다. ACG는 같은 구조를 *변경 행위*에 적용한다 — "이 변경을 적용하기 전 무엇이 참이어야 하고, 적용 후 무엇이 여전히 참이어야 하며, 무엇은 절대 건드리면 안 되는가". 검증 주체도 다르다: 함수 계약은 런타임이, 변경 계약은 단계 6의 게이트가 검사한다.
>
> **용어 정밀화(OBJ-09 반영).** 엄밀히 말하면 `allowed_scope`/`forbidden_scope`는 형식 검증의 **frame condition(수정 가능 영역 선언, modify clause)** 에 더 가깝다 — "이 변경이 건드릴 수 있는/없는 영역"을 한정한다. 진짜 **postcondition**에 해당하는 것은 `invariants`(변경 후에도 참이어야 할 성질)이고, **precondition**은 work item의 Intent가 담당한다. DbC를 빌린 핵심은 "변경의 효과를 사전에 경계 짓고 사후에 검증한다"는 *구조*이며, 세 필드를 pre/post/invariant에 1:1로 강제 대응시키지는 않는다.

### 스키마

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "acg.change-contract.v1",
  "type": "object",
  "required": ["schema", "purpose", "allowed_scope", "forbidden_scope", "acceptance"],
  "properties": {
    "schema": { "const": "acg.change-contract.v1" },
    "purpose": { "type": "string", "description": "이 변경이 달성하려는 결과(코드가 아니라 의도)" },
    "allowed_scope": {
      "type": "array",
      "description": "변경 사전조건. 이 안의 경로/심볼만 수정 가능.",
      "items": { "$ref": "#/$defs/scopeRef" }
    },
    "forbidden_scope": {
      "type": "array",
      "minItems": 1,
      "description": "변경 불변. 빈 배열 금지 — 무제한 변경 방지.",
      "items": { "$ref": "#/$defs/scopeRef" }
    },
    "invariants": {
      "type": "array",
      "description": "변경 후에도 참이어야 할 성질. 일반화 가능한 것은 단계 8에서 FitnessFunction으로 승격.",
      "items": {
        "type": "object",
        "required": ["statement", "promotable"],
        "properties": {
          "statement": { "type": "string" },
          "promotable": { "type": "boolean", "description": "코드베이스 전역 성질이면 true → Assurance Graph 승격 후보" }
        }
      }
    },
    "acceptance": {
      "type": "array", "minItems": 1,
      "items": {
        "type": "object",
        "required": ["criterion", "evidence_kind"],
        "properties": {
          "criterion": { "type": "string" },
          "evidence_kind": { "enum": ["test", "build", "log", "diff", "screen", "manual", "e2e"] }
        }
      }
    },
    "decision_ref": {
      "type": ["string", "null"],
      "description": "이 변경의 근거가 되는 ADR/결정 id. risk_default가 medium 이상이면 필수(null이면 단계 2 게이트 실패) — 비자명한 변경은 결정을 참조해야 한다."
    },
    "risk_default": { "enum": ["low", "medium", "high"], "default": "low" }
  },
  "$defs": {
    "scopeRef": {
      "type": "object",
      "required": ["kind", "ref"],
      "properties": {
        "kind": { "enum": ["path", "glob", "symbol", "public_surface", "layer"] },
        "ref": { "type": "string" },
        "note": { "type": "string" }
      }
    }
  }
}
```

### 예시 (boxwood)

```json
{
  "schema": "acg.change-contract.v1",
  "purpose": "automation-engine BPMN 런타임의 외부 태스크 재시도 정책을 고정 3회에서 지수 백오프로 변경한다.",
  "allowed_scope": [
    { "kind": "glob", "ref": "automation-engine/**/runtime/**" },
    { "kind": "glob", "ref": "automation-engine/**/test/**/RetryPolicy*" }
  ],
  "forbidden_scope": [
    { "kind": "layer", "ref": "kafka-adapter", "note": "메시지 계약 불변" },
    { "kind": "public_surface", "ref": "external-client task contract" },
    { "kind": "symbol", "ref": "TenantContext", "note": "테넌트 격리 불변" }
  ],
  "invariants": [
    { "statement": "external-client가 받는 태스크 페이로드 형태는 동일하다", "promotable": false },
    { "statement": "재시도 중에도 tenant 격리가 유지된다", "promotable": true }
  ],
  "acceptance": [
    { "criterion": "재시도 간격이 지수 백오프(1s,2s,4s)를 따른다", "evidence_kind": "test" },
    { "criterion": "기존 RetryPolicy 단위 테스트가 통과한다", "evidence_kind": "test" }
  ],
  "decision_ref": "ADR-automation-0007",
  "risk_default": "medium"
}
```

---

## 2. ImpactGraph

**역할.** 변경 대상에서 출발한 영향 전파를 노드로 분류한다. 텍스트 검색이 아니라 심볼/타입/테스트/문서/외부소비자 차원으로 본다. 정적으로 해소 안 되는 것은 `unresolved`로 명시한다(숨기지 않는다).

> **제품 표면으로의 전파([00](00-framework.md) §1.1(2) 반영).** 코드 영향만으로는 "코드는 맞지만 제품이 틀린" 변경을 못 잡는다. 그래서 영향 노드에 `ui_surface`(영향받는 화면·컴포넌트)와 `user_journey`(영향받는 사용자 흐름, `journey_id`로 §2.5 JourneySpec 참조)를 1급 kind로 둔다.

> **순환 차단 — negative obligation(2회차 OBJ-15/17 반영).** "agent가 여정을 못 본다"면서 그 agent에게 journey 노드를 채우라 하면 순환이다(눈먼 자가 가드의 트리거를 쥔다). 그래서 **default-deny**로 뒤집는다: 사용자에 노출되는 변경 — 프론트엔드 route/component, UI가 소비하는 endpoint, 사용자에게 보이는 카피/상태, 또는 `acceptance.evidence_kind`가 `screen`/`e2e`인 변경 — 은 (a) JourneySpec의 `journey_id`에 매핑되거나, (b) `unresolved: journey_unknown`을 **반드시** 방출해야 한다. 매핑도 unresolved도 없는 사용자 노출 diff는 게이트 통과 불가다. 이로써 ImpactGraph 과소 기재가 침묵으로 통과하지 못하고, 누락 자체가 드러난다.

### 스키마

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "acg.impact-graph.v1",
  "type": "object",
  "required": ["schema", "change_target", "change_type", "affected_nodes"],
  "properties": {
    "schema": { "const": "acg.impact-graph.v1" },
    "change_target": { "type": "string" },
    "change_type": { "enum": ["rename", "signature", "behavior", "delete", "add", "move"] },
    "affected_nodes": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["kind"],
        "properties": {
          "kind": { "enum": ["direct_caller", "transitive_caller", "type_contract", "generated_client", "test", "doc", "external_surface", "ui_surface", "user_journey"] },
          "path": { "type": "string", "description": "코드 위치. kind가 ui_surface/user_journey가 아니면 필수." },
          "symbol": { "type": "string" },
          "journey_id": { "type": "string", "description": "JourneySpec.id 참조(§2.5). kind가 ui_surface/user_journey면 필수 — journey는 파일이 아니라 흐름이므로 path 대신 이것으로 가리킨다(OBJ-31)." },
          "reason": { "type": "string" },
          "handled": { "type": "boolean", "default": false }
        },
        "allOf": [
          {
            "if": { "properties": { "kind": { "enum": ["ui_surface", "user_journey"] } } },
            "then": { "required": ["kind", "journey_id"] },
            "else": { "required": ["kind", "path"] }
          }
        ]
      }
    },
    "unresolved": {
      "type": "array",
      "description": "정적으로 해소 불가. 완료 판정에서 unverified risk로 남는다. cross_repo/cross-language dataflow는 deterministic evaluation의 레퍼런스인 CodeQL도 단일 DB 내에서만 추적하므로(부록4) 계약 매칭 후처리가 필요 — ACG cross_repo unresolved와 같은 경계.",
      "items": {
        "type": "object",
        "required": ["kind", "path", "reason"],
        "properties": {
          "kind": { "enum": ["dynamic_call", "reflection", "string_dispatch", "config_driven", "cross_repo", "journey_unknown"] },
          "path": { "type": "string" },
          "reason": { "type": "string" }
        }
      }
    }
  }
}
```

### 예시 (boxwood)

boxwood의 로컬 JAR 의존(`libs/boxwood-domain-model-2.2.48.jar`)은 cross-repo 영향이 정적으로 안 잡히는 대표 사례다.

```json
{
  "schema": "acg.impact-graph.v1",
  "change_target": "boxwood-domain-model: TenantId 타입을 String에서 value class로",
  "change_type": "signature",
  "affected_nodes": [
    { "kind": "type_contract", "path": "boxwood-packages/boxwood-domain-model/.../TenantId.kt", "handled": true },
    { "kind": "direct_caller", "path": "portal-backend/.../TenantInterceptor.kt", "symbol": "resolveTenant", "handled": true },
    { "kind": "test", "path": "portal-backend/.../TenantInterceptorTest.kt", "reason": "TenantId 생성 방식 변경", "handled": false }
  ],
  "unresolved": [
    { "kind": "cross_repo", "path": "automation-engine/libs/boxwood-domain-model-2.2.48.jar", "reason": "로컬 JAR로 고정 의존 — 빌드 시점에만 갱신, 정적 추적 불가" },
    { "kind": "config_driven", "path": "portal-backend/.../753 TenantContext 참조점", "reason": "일부는 런타임 컨텍스트 전파라 호출 그래프로 안 잡힘" }
  ]
}
```

---

## 2.5 JourneySpec — 사용자 여정의 1급 명세

**역할.** [00](00-framework.md) §1.1(2)의 진짜 해법은 enum 라벨이 아니라 *여정을 소유하는 산출물*이다(2회차 OBJ-16/24 반영). JourneySpec은 저장소가 보유한 사용자 여정의 카탈로그로, `ArchitectureSpec`처럼 저장소당 한 번 만들어 `.ditto/knowledge`(또는 `.acg/journeys/`)에 둔다. ImpactGraph·ReviewGraph·FitnessFunction은 자유 텍스트 path가 아니라 **`journey_id`로 이것을 참조**한다 — journey는 파일이 아니라 흐름이므로(OBJ-20), 파일 모양에 욱여넣지 않는다.

> 이것은 1회차 OBJ-02가 Assurance Graph에 한 것과 같은 수다: 프레임워크가 중심이라 선언한 축(여기선 §1.1(2) 제품 축)이 enum으로만 흩어져 있으면 1급 스키마로 소유시킨다.

### 스키마

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "acg.journey-spec.v1",
  "type": "object",
  "required": ["schema", "id", "owner", "steps", "surfaces", "evidence_requirement"],
  "properties": {
    "schema": { "const": "acg.journey-spec.v1" },
    "id": { "type": "string", "description": "안정적 식별자. 타 스키마가 이것으로 참조" },
    "title": { "type": "string" },
    "owner": { "type": "string", "description": "이 여정의 제품 책임자(사람/팀) — freshness·판단의 주체" },
    "steps": {
      "type": "array",
      "description": "여정의 단계. 각 단계는 식별자를 가져 ImpactGraph가 step 단위 영향도 가리킬 수 있다.",
      "items": {
        "type": "object",
        "required": ["step_id", "intent"],
        "properties": {
          "step_id": { "type": "string" },
          "intent": { "type": "string", "description": "이 단계에서 사용자가 달성하려는 것" },
          "expected_outcome": { "type": "string" }
        }
      }
    },
    "surfaces": {
      "type": "array",
      "description": "이 여정이 닿는 코드/제품 표면(route·component·endpoint). 코드 변경→여정 매핑의 근거.",
      "items": { "type": "string" }
    },
    "fixtures": { "type": "array", "items": { "type": "string" }, "description": "재현에 필요한 데이터/상태" },
    "evidence_requirement": {
      "type": "object",
      "required": ["kind"],
      "description": "이 여정을 닫으려면 어떤 증거가 필요한가",
      "properties": {
        "kind": { "enum": ["e2e", "screen", "manual"] },
        "must_pass_steps": { "type": "array", "items": { "type": "string" }, "description": "반드시 통과해야 할 step_id" }
      }
    },
    "freshness": {
      "type": "object",
      "description": "여정 명세의 신선도 — 오래되면 거버넌스가 거짓이 된다",
      "properties": {
        "last_validated": { "type": "string", "format": "date-time" },
        "stale_after_days": { "type": "integer" }
      }
    }
  }
}
```

### JourneyRun — 여정 검증의 증거 아티팩트 (OBJ-19)

`evidence_kind: screen`만으로는 "검증된 여정"이 아니다. 실행된 여정 증거를 타입으로 명명한다. DITTO `e2e` 스킬의 `e2eJourney` 산출물이 이 형태로 매핑된다.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "acg.journey-run.v1",
  "type": "object",
  "required": ["schema", "journey_id", "outcome"],
  "properties": {
    "schema": { "const": "acg.journey-run.v1" },
    "journey_id": { "type": "string", "description": "JourneySpec.id" },
    "outcome": { "enum": ["pass", "fail", "flaky", "skipped"] },
    "step_results": { "type": "array", "items": { "type": "object", "properties": { "step_id": { "type": "string" }, "outcome": { "enum": ["pass", "fail"] } } } },
    "artifacts": { "type": "array", "items": { "type": "string" }, "description": "스크린샷·trace·console·network 경로" }
  }
}
```

> **boxwood 예시.** frontend(906파일 automation 앱)의 "프로세스 인스턴스 생성→실행 모니터링" 여정을 `journey_id: jrn-process-run`으로 명세하고 surfaces에 해당 route/component를 둔다. 그 표면을 건드리는 변경은 ImpactGraph에서 `journey_id: jrn-process-run`에 매핑되거나 `journey_unknown`을 방출해야 하며, 단계 6은 `JourneyRun`(frontend-e2e Playwright 산출물)으로 닫는다.

## 3. ArchitectureSpec

**역할.** Clean Architecture의 Dependency Rule을 선언으로 고정한다. 저장소당 한 번 만들어 `.ditto/knowledge`(또는 repo 루트 `.acg/architecture.yaml`)에 두고 재사용한다. 단계 6의 boundary validation과 단계 8의 적합성 함수가 이를 소비한다.

> **원전과의 차이.** Clean Architecture는 의존 방향을 *설계 지침*으로 제시한다. ACG는 이를 *기계 검증 가능한 선언*으로 만들고, agent 변경마다 자동 검사한다 — agent는 시니어의 암묵적 경계 감각이 없으므로 경계를 명시해야 한다.

### 스키마 (YAML — 사람이 손으로 쓰는 산출물이라 YAML 채택)

```yaml
# .acg/architecture.yaml
schema: acg.architecture-spec.v1
layers:
  controller: { can_call: [service] }
  service:    { can_call: [repository] }
  repository: { can_call: [] }
public_surfaces:
  - portal-backend/**/controller/**     # 45 REST 컨트롤러
  - boxwood-packages/*/src/main/**/api/**
forbidden_dependencies:
  - { from: "automation-engine/**", to: "portal-backend/**", reason: "엔진은 포털을 REST로만 호출, 코드 의존 금지" }
  - { from: "boxwood-domain-model/**", to: "boxwood-rbac/**", reason: "domain-model은 commons만 의존" }
ownership:
  - { module: "automation-engine/**/kafka/**", owner: "automation-team" }
module_invariants:
  - "모든 backend 모듈의 Spring Boot major.minor는 단일하다"   # boxwood 현실: 3.3/3.5/3.5 → 위반
  - "외부 라이브러리는 선언된 의존성으로만 존재한다(로컬 JAR 금지)"  # boxwood 현실: libs/*.jar → 위반

# 스타일/품질 일관성 정책 — §1.1(1)의 집행 근거(OBJ-22). 전부 deterministic 평가자.
conventions:
  formatter: { cmd: "ktlintFormat --check", on_violation: block }   # 포맷 = 결정적
  linter:    { cmd: "detekt", on_violation: block }                 # 품질 규칙 = 결정적
  naming:    { rule: "service 클래스는 *Service 접미사", evaluator: deterministic }
  approved_patterns:                                                # 신규 추상화가 따라야 할 local 패턴
    - "repository 접근은 Exposed DSL, 직접 JDBC 금지"
    - "public API는 내부 순서/상태 파라미터를 받지 않고 domain intent만 받는다"
    - "retry/cache/transaction orchestration은 caller가 아니라 모듈 내부에 숨긴다"
  exceptions:                                                       # 정책 예외는 명시적으로만
    - { rule: "naming", path: "legacy/**", reason: "마이그레이션 전 레거시" }
```

`module_invariants`는 단계 8에서 `FitnessFunction`으로 승격되는 후보다. boxwood의 두 항목은 현재 **위반 상태** — ArchitectureSpec이 현실을 기술하면서 동시에 적합성 목표를 드러낸다.

> **§1.1(1) 일관성의 집행 substrate(OBJ-22 반영).** [00](00-framework.md) §1.1(1)이 "스타일·품질 일관성은 코드베이스가 강제한다"고 한 것의 실체가 이 `conventions`다. 핵심은 **deterministic 평가자**(formatter·linter·naming 규칙·승인 패턴)로 집행한다는 것이다 — 생성 모델은 매번 일관되지 않으므로, 일관성을 모델이 아니라 결정적 도구에 맡긴다. `llm_judged`는 일탈을 *주석*할 수는 있으나 집행 substrate가 아니다(§6에서 llm_judged는 warn 기본). 즉 "당위성 없는 생성"(§1.1(1))은 LLM 판단이 아니라 formatter/linter라는 결정적 게이트가 막는다. [40](40-refactoring-criteria.md) §3의 "기존 local 패턴과 일치"도 이 `approved_patterns`를 근거로 판정한다. Deep Module 기준도 여기에 들어올 수 있다 — 저장소가 "좋은 인터페이스"로 인정하는 반복 패턴을 `approved_patterns`에 두면, agent의 새 모듈/API 설계가 같은 기준을 재사용한다.

---

## 4. SemanticCompatibility

**역할.** 타입 호환성과 의미 호환성을 분리한다. API 변경을 타입 diff가 아니라 semantic diff로 보고, 기존 코드가 암묵적으로 의존하던 도메인 가정을 명시한다. Characterization Test가 의미 보존의 증거다.

> **원전과의 차이.** Feathers의 characterization test는 *레거시 코드의 현재 동작을 고정*하는 기법이다. ACG는 이를 *변경 직전*에 자동 적용한다 — agent가 의미를 바꾸기 전에, 기존 동작을 테스트로 박아 "의미가 바뀌었는지"를 기계적으로 판정한다. behavior test가 없으면 후보를 생성해 "미검증"으로 남긴다.

> **결정론 보강(레퍼런스: CodeQL).** 보안/데이터 흐름 성격의 의미는 characterization test 없이도 **변경 전후 dataflow diff**로 결정론 검증할 수 있다 — source→sink 집합이 불변이면 그 차원의 의미가 보존된 것이다([00](00-framework.md) §3.1; [reports/codeql](../../codeql/codeql-research-ko.md) 부록3가 리팩토링 `67b27ccf` 전후로 실증). **단 동등성 key는 raw `file:line`이 아니라 정규화한 식별자(rule id + source/sink semantic symbol + enclosing function + normalized path hash)여야 한다 — line number는 표시용이지 동등성 key가 아니다.** raw 라인으로 비교하면 코드 이동만으로 거짓 NEW/REMOVED가 생긴다(부록3: 4 added/4 removed가 실은 0 순변화였음). 그리고 이는 taint 경로 보존만 본다 — 도메인 의미 전체는 여전히 characterization/llm_judged 몫이다.

### 스키마

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "acg.semantic-compatibility.v1",
  "type": "object",
  "required": ["schema", "change", "old_meaning", "compatibility", "verdict"],
  "properties": {
    "schema": { "const": "acg.semantic-compatibility.v1" },
    "change": {
      "type": "object",
      "required": ["before", "after"],
      "properties": { "before": { "type": "string" }, "after": { "type": "string" } }
    },
    "old_meaning": { "type": "string", "description": "기존 시그니처가 표현하던 도메인 의미" },
    "business_assumptions": {
      "type": "array",
      "items": { "type": "string" },
      "description": "호출자가 암묵적으로 의존하던 가정(예: null=미존재→온보딩 분기)"
    },
    "compatibility": { "enum": ["compatible", "additive", "breaking"] },
    "characterization": {
      "type": "object",
      "properties": {
        "exists": { "type": "boolean" },
        "test_ref": { "type": ["string", "null"] },
        "candidate": { "type": ["string", "null"], "description": "behavior test가 없을 때 생성한 후보" }
      }
    },
    "verdict": {
      "type": "object",
      "required": ["type_safe", "semantic_safe"],
      "properties": {
        "type_safe": { "type": "boolean" },
        "semantic_safe": { "enum": ["yes", "no", "unverified"] },
        "intended_breaking": { "type": "boolean" }
      }
    }
  }
}
```

`type_safe`와 `semantic_safe`를 분리한 verdict가 이 스키마의 핵심이다. "타입상 안전"과 "의미상 안전"은 다른 판정이다.

### 예시 (정전 사례 + boxwood)

```json
{
  "schema": "acg.semantic-compatibility.v1",
  "change": { "before": "getUser(id): User?", "after": "getUser(id): User" },
  "old_meaning": "null은 '해당 테넌트에 사용자가 존재하지 않음'을 표현했다.",
  "business_assumptions": [
    "호출자는 null일 때 온보딩 플로우로 분기했다",
    "automation-engine의 LLM task가 미존재 사용자에 대해 graceful degrade 한다"
  ],
  "compatibility": "breaking",
  "characterization": {
    "exists": false,
    "test_ref": null,
    "candidate": "getUser_returnsNull_whenTenantHasNoUser() — automation-engine 커버리지 2.7%라 기존 테스트 없음, 후보 생성"
  },
  "verdict": { "type_safe": true, "semantic_safe": "no", "intended_breaking": false }
}
```

타입은 맞지만(`type_safe: true`) 의미가 깨졌다(`semantic_safe: no`). 이 변경은 단계 6 게이트에서 차단된다.

---

## 5. ReviewGraph

**역할.** Review by Exception. 변경을 위험도로 분류하고 사람이 봐야 할 최소 집합을 만든다. DITTO의 reviewer output을 확장해 재사용한다 — 신설이 아니다.

### 스키마

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "acg.review-graph.v1",
  "type": "object",
  "required": ["schema", "files", "human_review_set"],
  "properties": {
    "schema": { "const": "acg.review-graph.v1" },
    "files": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["risk", "risk_reason"],
        "properties": {
          "path": { "type": "string", "description": "코드 위치. role이 ui/user_journey가 아니면 필수." },
          "journey_id": { "type": "string", "description": "JourneySpec.id 참조(§2.5). role이 ui/user_journey면 필수 — journey는 파일이 아니라 흐름이므로 path 대신 이것으로 가리킨다(OBJ-52)." },
          "role": { "enum": ["test_fixture", "private_helper", "service_logic", "public_api", "migration", "auth", "payment", "data_deletion", "config", "ui", "user_journey"] },
          "risk": { "enum": ["low", "medium", "high"] },
          "risk_reason": { "type": "string", "description": "비면 분류 무효" },
          "evidence": {
            "type": "object",
            "description": "증거. unresolved=true면 비울 수 있다.",
            "properties": {
              "kind": { "enum": ["test", "build", "log", "diff", "screen", "manual", "e2e"] },
              "ref": { "type": "string", "description": "e2e면 JourneyRun(acg.journey-run.v1) 참조" }
            }
          },
          "unresolved": { "type": "boolean", "default": false, "description": "증거 부재 표식(OBJ-53). evidenceRef.kind가 *아니라* 별도 marker다 — §0.2 바인딩에서 evidence를 비우고 이 플래그로 싣는다. high-risk인데 evidence 없이 이 플래그만 있으면 human_review_set에 오른다." }
        },
        "allOf": [
          {
            "if": { "properties": { "role": { "enum": ["ui", "user_journey"] } }, "required": ["role"] },
            "then": { "required": ["journey_id"] },
            "else": { "required": ["path"] }
          }
        ]
      }
    },
    "human_review_set": {
      "type": "array",
      "description": "사람이 판단해야 할 exception. 전체 diff가 아님.",
      "items": { "type": "string" }
    }
  }
}
```

### 위험도 규칙 (기본값)

- public API·migration·auth·payment·data deletion → 기본 **high**.
- 사용자 여정(`user_journey`)에 닿는 변경 → 기본 **high**, UI 표면(`ui`) 변경 → 최소 **medium**. 코드 검증만으로는 제품 회귀를 못 잡으므로([00](00-framework.md) §1.1(2)), 이 역할의 high/medium은 실행 증거(screen·e2e)를 요구한다.
- production behavior와 연결된 테스트 변경 → 최소 **medium**.
- `risk_reason`이 없는 분류는 **무효**(통과 불가).
- high-risk에는 evidence 또는 explicit `unresolved` marker가 **필수**.

[50-change-map.md](50-change-map.md)가 이 ReviewGraph를 사람용 시각 표기로 렌더한다.

---

## 6. FitnessFunction

**역할.** ACG가 진짜로 신설하는 핵심. 코드베이스가 시간에 걸쳐 지켜야 할 성질을 실행 가능한 술어로 표현하고, 변경마다 + 주기적으로 평가한다. Assurance Graph는 이 함수들의 시계열이다.

> **원전과의 차이.** *Building Evolutionary Architectures*의 fitness function은 주로 CI에서 주기 실행되는 아키텍처 테스트다. ACG는 두 가지를 더한다: (1) **변경마다(per-change) 평가** — 이 변경이 적합성을 깨는지 즉시 검사, (2) **추세(drift) 추적** — 통과/실패만이 아니라 통과율 기울기를 본다. boxwood의 SB 버전 분기처럼 "한 번에 깨지지 않고 서서히 침식되는" 품질을 잡기 위해서다.

> **세 kind의 추가 동기([00](00-framework.md) §1.1).** `duplication`·`complexity`는 **SLOP 증식**(§1.1(3))을 추세로 잡는다 — 중복도·복잡도가 변경을 가로질러 늘면 감지한다(개별 변경은 정당해도 누적이 침식이다). `user_journey`는 **코드↔제품 갭**(§1.1(2))의 지속 버전으로, JourneySpec(§2.5)에 정의된 핵심 사용자 흐름이 깨지지 않음을 `JourneyRun`(e2e)으로 검증한다. 이때 evaluator는 `mode: executed`다 — e2e는 호출이 결정적이어도 증거가 flaky·비싸므로 deterministic과 구분하고, `execution.selection: risk_tiered`로 매 변경 전수 실행하지 않는다(OBJ-18, Q4). 즉 §1.1의 (2)(3) 결함이 이 kind들로 Assurance Graph에 상주하되, 비용은 risk-tiered 실행으로 통제한다.

### 스키마

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "acg.fitness-function.v1",
  "type": "object",
  "required": ["schema", "id", "statement", "kind", "evaluator", "cadence", "on_violation"],
  "properties": {
    "schema": { "const": "acg.fitness-function.v1" },
    "id": { "type": "string" },
    "statement": { "type": "string", "description": "지켜야 할 성질(사람이 읽는 형태)" },
    "kind": { "enum": ["architectural", "dependency", "semantic", "coverage", "consistency", "performance", "duplication", "complexity", "user_journey"] },
    "evaluator": {
      "type": "object",
      "required": ["mode", "spec"],
      "properties": {
        "mode": { "enum": ["deterministic", "llm_judged", "executed"], "description": "정적분석/쿼리 = deterministic; 의미판단 = llm_judged; 실행 증거(e2e 등) = executed. executed는 호출은 결정적이어도 증거가 flaky/비용 큼(OBJ-18) — deterministic과 구분한다" },
        "spec": { "type": "string", "description": "deterministic이면 명령/쿼리, llm_judged면 판정 프롬프트와 재현 조건" },
        "reproducibility": {
          "type": "object",
          "description": "llm_judged일 때만. 재현 가능한 판정을 위한 고정 조건(OBJ-07 반영).",
          "properties": {
            "model_version": { "type": "string", "description": "판정 모델 ID 고정 (예: claude-opus-4-8). 미고정 시 판정 비교 불가" },
            "prompt_hash": { "type": "string", "description": "판정 프롬프트 해시 — 프롬프트 변경 추적" },
            "votes": { "type": "integer", "minimum": 1, "description": "독립 판정 횟수(다수결 N)" },
            "tie_break": { "enum": ["fail_closed", "fail_open", "escalate"], "description": "표가 갈릴 때 규칙. 기본 fail_closed(보수적으로 위반 간주)" },
            "input_fixing": { "type": "string", "description": "프롬프트에 고정 투입하는 입력(예: 변경 diff 전체)" }
          }
        },
        "execution": {
          "type": "object",
          "description": "mode=executed일 때만. 실행 증거의 flaky·비용 특성을 명시적으로 다룬다(OBJ-18). 정적 술어에는 없는 정책.",
          "properties": {
            "environment": { "type": "string", "description": "실행 환경(브라우저·OS·테스트 DB 등)" },
            "timeout_s": { "type": "integer" },
            "retries": { "type": "integer", "description": "flaky 완화 재시도 횟수" },
            "flake_policy": { "enum": ["quarantine", "fail", "retry"], "description": "flaky 판정 시 처리. quarantine=격리(차단 안 함)" },
            "selection": { "enum": ["per_change", "risk_tiered", "sampled", "periodic"], "description": "비싼 journey fitness는 risk_tiered/sampled 기본 — 매 변경 전수 실행 금지(Q4 비용)" },
            "budget": { "type": "string", "description": "실행 예산 상한(시간/횟수)" }
          }
        }
      }
    },
    "baseline": {
      "type": "object",
      "description": "기존 부채(현재 위반 상태)를 표현. 점진 집행의 기계적 정의(OBJ-03). duplication/complexity 같은 metric kind는 시점 간 비교를 위해 typed baseline 필수(OBJ-21).",
      "properties": {
        "metric": { "type": "string", "description": "측정 지표 이름(예: duplicated_lines, cyclomatic_complexity). metric kind에서 필수 — 비교의 동일성 근거" },
        "scope": { "type": "string", "description": "측정 범위(모듈/파일군)" },
        "threshold": { "type": "number", "description": "허용 임계" },
        "comparator": { "enum": ["lte", "gte", "eq"], "description": "threshold 비교 방향" },
        "violation_identity": { "type": "string", "description": "같은 위반을 시점 간 식별하는 키(예: 파일경로+심볼+구조해시) — 레거시 부채가 신규 위반으로 오독되는 것을 막는다" },
        "snapshot": { "type": "string", "description": "도입 시점의 위반 식별자 집합/카운트 — 이 이하는 허용(기존 부채)" },
        "delta_only": { "type": "boolean", "description": "true면 violation_identity로 비교해 snapshot에 없던 *신규* 위반만 on_violation 적용. 기존 부채는 track" },
        "window": { "type": "string", "description": "추세 집계 구간(예: 최근 8 스냅샷)" }
      }
    },
    "cadence": {
      "type": "object",
      "properties": {
        "per_change": { "type": "boolean", "description": "변경 시점 평가 여부" },
        "periodic": { "enum": ["none", "daily", "weekly", "on_release"] }
      }
    },
    "on_violation": { "enum": ["block", "warn", "track"], "description": "block=변경 차단, warn=경고, track=추세만 기록" },
    "source_change": { "type": "string", "description": "이 함수를 승격시킨 work item/ChangeContract" }
  }
}
```

### evaluator의 deterministic/llm_judged 경계

[00](00-framework.md) §9 열린질문 1의 1차 답이다.

- **deterministic**: ArchitectureSpec 위반, 의존성 존재, 버전 일치, 커버리지 임계 — 명령이나 정적 쿼리로 참/거짓이 결정된다. 기본 선택. **레퍼런스 구현은 CodeQL taint(path-problem) 쿼리**([00](00-framework.md) §3.1) — `spec`에 `.ql` 쿼리나 `codeql database analyze` 명령을 두고, "새 source→sink path = 0"을 결정론으로 판정한다(PoC 실증: [reports/codeql](../../codeql/codeql-research-ko.md) F-2).
- **llm_judged**: 의미 호환성, 추상화 적절성처럼 판단이 필요한 것. 재현성을 위해 `reproducibility`에 (a) 판정 근거를 구조화 산출물로 강제, (b) 다수결(N회 독립 판정), (c) 변경 diff를 프롬프트에 고정하는 방식을 명시한다. llm_judged는 기본 `on_violation: warn`(차단 아님) — LLM 판정의 불확실성을 차단 권한과 분리한다.

### 예시 (boxwood — 두 함수)

```json
[
  {
    "schema": "acg.fitness-function.v1",
    "id": "ff-backend-sb-version-single",
    "statement": "모든 backend 모듈의 Spring Boot major.minor 버전은 단일하다",
    "kind": "consistency",
    "evaluator": {
      "mode": "deterministic",
      "spec": "portal-backend/build.gradle, automation-engine/pom.xml, external-client/pom.xml에서 SB 버전 추출 → distinct set"
    },
    "baseline": { "snapshot": "{3.3.13, 3.5.7, 3.5.5} — 도입 시점 3종 분기(기존 부채)", "delta_only": true },
    "cadence": { "per_change": true, "periodic": "weekly" },
    "on_violation": "block",
    "source_change": "wi_acg_bootstrap"
  },
  {
    "schema": "acg.fitness-function.v1",
    "id": "ff-no-local-jar",
    "statement": "외부 라이브러리는 선언된 의존성으로만 존재한다(libs/*.jar 직접 의존 금지)",
    "kind": "dependency",
    "evaluator": { "mode": "deterministic", "spec": "find */libs -name '*.jar' | count == 0" },
    "cadence": { "per_change": true, "periodic": "on_release" },
    "on_violation": "block",
    "source_change": "wi_acg_bootstrap"
  }
]
```

첫 함수는 현재 **위반**(SB 3종)이지만 즉시 전면 차단하면 코드베이스가 멈춘다. 그래서 `baseline.snapshot`에 기존 3종을 부채로 기록하고 `delta_only: true`로 둔다 — 그러면 `on_violation: block`이어도 **기존 부채는 추세로만 track되고, snapshot에 없던 새 버전을 추가하는 변경만 차단**된다. 이것이 "새 분기만 막는다"의 기계적 정의다(prose 주장이 아니라 baseline/delta 필드로). 둘째 함수는 baseline 없이(=신규 부채 0 목표) 모든 로컬 JAR 추가를 차단한다.

## 6.5 AssuranceSnapshot — 적합성의 시계열 (Assurance Graph)

**역할.** [00](00-framework.md) §4의 다섯째 그래프인 Assurance Graph를 표현한다. `FitnessFunction`이 *개별 술어의 정의*라면, AssuranceSnapshot은 *그 술어들의 평가 이력*이다. Assurance Graph는 별도 자료구조가 아니라 **이 스냅샷들의 시계열 집계 뷰**이며, 드리프트([00](00-framework.md) §8의 `fitness drift` 지표 = 통과율 기울기)는 이 위에서 계산된다(OBJ-02 반영).

### 스키마

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "acg.assurance-snapshot.v1",
  "type": "object",
  "required": ["schema", "at", "trigger", "results"],
  "properties": {
    "schema": { "const": "acg.assurance-snapshot.v1" },
    "at": { "type": "string", "format": "date-time", "description": "평가 시점" },
    "trigger": { "enum": ["per_change", "periodic"], "description": "변경 시점 평가인지 주기 평가인지" },
    "change_ref": { "type": ["string", "null"], "description": "per_change면 해당 work item/ChangeContract" },
    "results": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["function_id", "outcome"],
        "properties": {
          "function_id": { "type": "string", "description": "FitnessFunction.id" },
          "outcome": { "enum": ["pass", "fail", "skip"] },
          "violations": { "type": "integer", "description": "위반 건수(baseline 대비 비교용, 표시/추세용)" },
          "new_violations": { "type": "integer", "description": "baseline.snapshot에 없던 신규 위반 건수 — delta_only 함수의 차단 판정 근거" },
          "violation_ids": { "type": "array", "items": { "type": "string" }, "description": "현 시점 위반의 violation_identity 집합(FitnessFunction.baseline.violation_identity로 산출한 키). 카운트가 아니라 *집합*이라야 시점 간 동일 위반을 식별하고 delta를 재계산·감사할 수 있다(OBJ-32)." },
          "new_violation_ids": { "type": "array", "items": { "type": "string" }, "description": "violation_ids 중 baseline.snapshot에 없던 키 — 레거시 부채와 신규 위반을 기계적으로 가른다. delta_only 차단은 이 집합이 비지 않을 때만 발동." }
        }
      }
    }
  }
}
```

### 드리프트 계산 (파생, 별도 저장 아님)

Assurance Graph는 함수별로 `results[].outcome`과 `violations`를 시점순으로 모은 시계열이다. 두 가지를 파생한다:
- **통과율 기울기**: 최근 N개 스냅샷에서 함수별 pass 비율의 추세. 음의 기울기 = 침식.
- **위반 추세**: `violations` 시계열. baseline 대비 증가 = 부채 누적(boxwood SB 버전이 늘고 있는가). 신규 vs 레거시 구분은 `new_violation_ids`(violation_identity 집합)로 감사한다 — 카운트만으로는 레거시가 신규로 오독될 수 있다(OBJ-32).

이로써 "한 번에 깨지지 않고 서서히 침식되는" 품질([00](00-framework.md) §2.2)이 측정 가능해진다 — 단일 스냅샷의 pass/fail이 아니라 시계열의 기울기로 본다.

> **boxwood 예시.** `ff-backend-sb-version-single`의 weekly 스냅샷에서 `violations`가 3→3→4로 가면, delta_only 차단이 새 분기를 막았어야 하는데 뚫린 것이다. 통과율 기울기가 평탄해도 위반 추세가 오르면 부채 누적 경보가 된다.

## 7. 스키마 간 관계

```text
ChangeContract.invariants[promotable=true] ──승격──> FitnessFunction
ChangeContract.allowed/forbidden_scope ──검사──> 단계5 diff
ImpactGraph.affected_nodes ──입력──> ReviewGraph.files
ImpactGraph.unresolved ──표시──> ReviewGraph(unresolved marker)
SemanticCompatibility.verdict ──게이트──> 단계6 통과/차단
ArchitectureSpec.module_invariants ──승격──> FitnessFunction
FitnessFunction ──평가이력──> AssuranceSnapshot ──시계열집계──> Assurance Graph(드리프트)
ReviewGraph ──렌더──> Change Map (50)
```

DSL이 ChangeContract를 컴파일하는 방식은 [30-intent-change-dsl.md](30-intent-change-dsl.md)에서, ReviewGraph의 시각화는 [50-change-map.md](50-change-map.md)에서 잇는다.
