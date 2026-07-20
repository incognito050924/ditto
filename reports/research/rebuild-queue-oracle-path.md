# Queue-oracle path 조사 — `--json-schema` structured_output vs JSON 사이드카

GitHub #53 / rebuild RESEARCH. 라이브 Claude Code CLI가 매 반복 outer drive-loop에
`BoundaryEnvelope.queue`를 어떻게 신뢰성 있게 넘기는가.

## TL;DR

두 경로 **모두 실재하고 동작한다** (라이브 CLI로 실측). seam은 둘 다 노출:
`driveStep()→{sessionId, boundary}` = 경로(a), `readSidecar<T>(path, schema)` = 경로(b).

- (a) `--output-format json` + `--json-schema` → 결과 JSON의 `structured_output` 필드에
  스키마-준수 객체를 강제 tool_use로 반환. **실측 확정.**
- (b) 서브에이전트가 JSON 파일 기록 → outer가 zod로 fail-closed 검증. 메커니즘 자명, 실측 불요.

## 대상 shape (seam이 각 경로에서 만들어야 하는 것)

- `BoundaryEnvelope` = `{ queue: QueueItem[], gate?: GateResult }` `.strict()`
  — `rebuild/seam/host-adapter.ts:7-13`
- `QueueItem` = `{ id, kind: 'found-defect'|'in-scope-residual'|'unverified-ac', exit?: 'resolved'|'new-scope-deferral'|'escape' }` `.strict()`
  — `rebuild/schemas/queue-item.ts:20-26`
- `GateResult` = `{ decision:'pass'|'block', grounds? }` `.strict()`
  — `rebuild/schemas/gate-result.ts:7-12`
- `driveStep` 계약: `sessionId`(=`--output-format json`의 session_id, 다음 `--resume`용) +
  `boundary`(이미 zod 검증됨; **queue oracle은 오직 여기서만**) — `host-adapter.ts:24-27`
- 서브에이전트 자유텍스트는 `AgentText` = opaque, 큐 oracle로 절대 못 씀 — `host-adapter.ts:15-18`

## 증거 (Evidence)

### 설치된 CLI 능력 (`claude --help`, v2.1.215)

- `--json-schema <schema>` — "JSON Schema for structured output validation."
- `--output-format <format>` — `text` | `json`(single result) | `stream-json`. "only works with --print"
- `-r, --resume [value]` — "Resume a conversation by session ID"
- `-p, --print` — headless.
- `structured_output` 플래그는 help에 별도 노출 없음 — 결과 JSON의 *필드*로 나옴(아래 실측).

### 라이브 실측 — `--json-schema` structured_output

명령 (haiku, BoundaryEnvelope-형 JSON Schema, `additionalProperties:false`):

```
claude --print --output-format json --json-schema '{"type":"object",...,"queue":{...items: id/kind/exit enum...}}' \
  --model haiku 'Return a queue with two items: id "a1" kind "unverified-ac" no exit, and id "b2" kind "found-defect" exit "resolved".'
```

결과 JSON(발췌, 그대로):

```
"stop_reason":"tool_use",
"session_id":"3c1317fe-1eec-4ebd-9281-b0da06ca002f",
"result":"{\"queue\":[{\"id\":\"a1\",\"kind\":\"unverified-ac\"},{\"id\":\"b2\",\"kind\":\"found-defect\",\"exit\":\"resolved\"}]}",
"structured_output":{"queue":[{"id":"a1","kind":"unverified-ac"},{"id":"b2","kind":"found-defect","exit":"resolved"}]}
"is_error":false, "api_error_status":null
```

확인된 사실:
1. `structured_output`가 스키마-준수 객체를 그대로 담는다 — enum 준수, optional `exit` 생략 존중, 추가 키 없음.
2. `stop_reason:"tool_use"` — 강제 tool_use로 스키마 검증됨(초안 §6.4 주장과 일치).
3. 같은 결과 JSON이 `session_id`(→`--resume`)를 함께 담는다 — **큐 oracle과 세션 id를 한 번의 원자적 읽기로** 얻는다.
4. `result`에도 동일 JSON이 문자열로 중복 존재. `is_error`/`api_error_status` 필드로 실패 판별 가능.

→ 반환된 `structured_output`은 `boundaryEnvelope.parse()`를 그대로 통과한다(strict + optional gate).

## 신뢰성·실패 모드

### (a) `--json-schema` top-level structured_output — 큐 oracle

- **임의 스키마 payload를 나른다** (Claude 봉투가 아님). 실측이 정확히 그것을 보였다.
  API의 forced tool_use가 스키마를 검증 → 추가 키/enum 위반은 API 층에서 거부.
- outer가 받는 데이터가 driveStep 결과 JSON 하나에 다 있음(session_id + boundary) → **파일시스템 레이스 없음**, 단일 소스.
- 실패 모드:
  - 모델 거부/API 오류 시 `stop_reason≠tool_use`이고 `structured_output` 부재 가능 → outer는 `is_error`/필드 부재에 **fail-closed** 필요. [INFERRED — 실패 케이스는 실측 안 함]
  - JSON Schema는 outer 프롬프트에 전달하는 값이고 zod가 진짜 SoT → **zod↔JSON-Schema drift** 위험. 완화: JSON Schema를 zod에서 생성(zod-to-json-schema)해 단일 출처 유지. [INFERRED]
  - 큐를 만드는 것은 그 CLI 스텝의 **메인 턴**이다(서브에이전트 자유텍스트는 opaque). 즉 outer가 현재 큐 상태를 프롬프트로 넣고 갱신 큐를 structured_output으로 받는 형태여야 함. [INFERRED — 배선 설계]
  - forced tool_use로 num_turns가 +1(실측 num_turns:2), 소량 지연·비용. [VERIFIED]

### (b) JSON 사이드카 — 서브에이전트 산출

- 검증 권위가 **100% 로컬 zod(SoT)** — CC의 스키마 집행이나 zod↔JSON-Schema 변환에 의존 안 함.
  `readSidecar`가 `schema.parse(JSON.parse(raw))`로 fail-closed(`fake-host.ts:63-69`).
- 더 견고한 축: outer가 스키마 진실을 독점(CC 밖). 대용량 산출을 outer 턴의 structured_output로 부풀리지 않음.
- 실패 모드 (파일 부작용은 forced tool_use보다 **집행이 약함**):
  - 에이전트가 파일 미기록/부분 기록/잘못된 경로 → outer는 부재·파싱실패에 fail-closed(현 FakeHost가 throw). [VERIFIED — FakeHost 동작; 라이브 에이전트 기록 신뢰도는 INFERRED]
  - 이전 런의 **stale 파일** 재사용 레이스 → 경로에 런/노드 스코프 네임스페이스 필요. [INFERRED]
  - flush/부분쓰기 타이밍. [INFERRED]

## 초안 §6.5 자체 주장 (docs/redesign/ditto-rebuild-draft.md)

- §6.4(393행): top-level `--json-schema`가 `structured_output`에 스키마-준수 객체 반환을 "실측 확정".
  → **이번 조사가 재현·확인함.**
- §6.5(399행): 경로를 둘로 나눔 — (a) 구조 필요 경계는 outer가 CLI `--json-schema`로, (b) 서브에이전트 산출은 file-sidecar(에이전트 JSON 기록→DITTO가 zod fail-closed). "어느 쪽도 SDK 불필요." gap-2 = 배선 선택은 미결로 둠.
- §5.10(339행): queue mutation은 구조 경계에서만 읽고, 서브에이전트 자유텍스트를 oracle로 쓰면 §2.1 손-JSON 병 재발이라 금지.

## 권고 (결정 아님 — recommendation)

**큐 oracle(매 반복 outer가 읽는 `BoundaryEnvelope`)은 경로(a) `--json-schema` structured_output로 받아라.**
근거: session_id와 함께 driveStep 결과 하나에 원자적으로 담기고, forced tool_use가 API 경계에서 스키마를 강제하며, 파일시스템 레이스가 없다. **JSON Schema는 zod SoT에서 생성**해 drift를 없애고, `is_error`/`stop_reason≠tool_use`/`structured_output` 부재에 **fail-closed**한다.
경로(b) 사이드카는 서브에이전트가 생산하는(메인 턴이 아닌) 또는 outer 턴 structured_output을 부풀릴 대용량 산출에 국한해 병용하라 — seam이 둘 다 노출하는 것과 정합. gap-2는 "둘 중 택1"이 아니라 **역할 분담**으로 닫는 것을 권한다.
