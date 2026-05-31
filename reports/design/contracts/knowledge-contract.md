---
kind: design-detail
last_updated: 2026-06-01 KST
owns: "§6 KnowledgeContract의 'how' (지식 레코드 구조 · KnowledgeCurator 책임 · /ditto:knowledge-update 절차 · .ditto/knowledge → CLAUDE.md projection · ADR 생애주기)"
sources:
  - reports/design/ditto-claude-code-harness-design.md   # §0 v0 범위, §6 line 144 KnowledgeContract, §8 layout .ditto/knowledge, §7.4 knowledge-curator
status: design-locked (schema 등록 완료, runtime post-v0/M6)
---

# KnowledgeContract — per-contract 상세 설계

> **이 문서의 위치.** 메인 설계문서 §6(line 144 "KnowledgeContract: 프로젝트 지식, 용어, 결정, 반복 학습")과 §8 layout(`.ditto/knowledge/`)의 *how*를 소유한다. per-contract 상세 문서의 네 번째 사례다(선행: deep-interview, autopilot, dialectic).

## 0. v0 상태 — design-locked, runtime은 M6

설계서 §0(line 33)과 line 830은 knowledge base를 **post-v0(M6)**로 명시한다("v0는 M0~M2까지 … project-management integration은 후속으로 분리", "E2E/knowledge placeholder도 post-v0라 v0 skeleton에 두지 않는다"). 따라서:

- **이번에 박는 것(v0-safe)**: `KnowledgeContract` schema(`src/schemas/knowledge-record.ts`, 등록 완료) + 본 설계문서.
- **M6으로 보존하는 것**: `agents/knowledge-curator.md` 본문, `/ditto:knowledge-update` skill, `.ditto/knowledge → CLAUDE.md` projection runtime.
- `tests/conformance/m1.conformance.test.ts` **M1.5b가 `agents/knowledge-curator.md`의 v0 부재를 단언**하므로, 본 design-lock은 그 invariant를 깨지 않는다(agent 파일 미생성).

## 1. 목적과 경계

### 1.1 한 문장
하네스 사용 중 생긴 **재사용 가능한 프로젝트 지식**(용어, 기술 결정, 반복 학습, 패턴)을 `.ditto/knowledge/`에 durable하게 누적하고, 그 일부를 host 지침(CLAUDE.md)으로 **projection**해 다음 세션이 별도 조회 없이 쓰게 한다.

### 1.2 인접 계약과의 경계 (무엇이 KnowledgeContract가 *아닌가*)

| 인접 | 경계 |
|---|---|
| Glossary (`glossary.ts`) | ubiquitous-language는 자체 schema를 유지한다. KnowledgeContract는 glossary를 **재정의하지 않고 `glossary_path`로 참조**한다(중복·얕은 추상화 금지). |
| `hooks/runtime-log.jsonl` | runtime log는 durable knowledge가 아니다(설계서 §8 "runtime log와 durable knowledge를 섞지 않는다"). KnowledgeContract에 들어가지 않는다. |
| EvidenceRecord (`evidence-record.ts`) | evidence는 한 work item의 완료 근거. knowledge는 work item을 넘어 재사용되는 지식. learning은 evidence를 *참조*할 수 있으나 evidence ledger 자체는 아니다. |
| ADR 파일(`.ditto/knowledge/adr/*.md`) | 사람이 읽는 본문. `knowledgeDecision`은 그 **인덱스**(id/title/status/rationale/change_condition/path)다. |

## 2. 레코드 구조 (`knowledgeRecord`)

```jsonc
{
  "schema_version": "0.1.0",
  "project_name": "ditto",
  "updated_at": "2026-06-01T00:00:00.000Z",
  "context_path": ".ditto/knowledge/CONTEXT.md",       // 산문 컨텍스트
  "glossary_path": ".ditto/knowledge/glossary.json",   // glossary schema 가 검증
  "project_map_path": null,
  "decisions": [                                        // ADR 인덱스
    { "id": "ADR-0001", "title": "...", "status": "accepted",
      "rationale": "근거", "change_condition": "변경 조건",
      "path": ".ditto/knowledge/adr/ADR-0001-...md", "superseded_by": null }
  ],
  "patterns": [ { "name": "...", "summary": "...", "path": null } ],
  "learnings": [ { "summary": "...", "evidence": [], "learned_at": "..." } ],
  "projected_to_claude_md": false
}
```

- **ADR 생애주기**: `proposed → accepted → (superseded | deprecated)`. `status=superseded` ⇒ `superseded_by`(대체 ADR id) 필수(schema cross-field). 모든 결정은 `rationale`(근거)와 `change_condition`(변경 조건)을 남긴다(설계서 line 786).
- `learnings`는 반복 학습으로, `evidence`(evidenceRef)로 뒷받침될 수 있다.

## 3. KnowledgeCurator (M6 runtime 설계)

`agents/knowledge-curator.md`(M6 생성 예정). 책임:
- 합의된 용어만 glossary로 승격(설계서 §8 "합의된 용어만").
- 기술 결정을 ADR로 기록(근거 + 변경 조건).
- 반복 학습/패턴을 durable knowledge로 승격, runtime log와 분리.
- 권한: `docs write allowed`(설계서 line 916) — knowledge 디렉터리 쓰기만. 코드 변경 금지.

`/ditto:knowledge-update` skill(M6): curator를 spawn해 `knowledgeRecord`를 갱신하고 ADR/패턴/학습을 append한다. `nodeKind=knowledge` 노드의 owner는 이미 `knowledge-curator`로 매핑되어 있다(`autopilot-graph.ts` `KIND_TO_OWNER`, nodeOwner enum). work item closure 직전 knowledge update 노드를 autopilot에 권장한다.

## 4. CLAUDE.md projection (M6 runtime 설계)

설계서 §8: "Claude memory에는 projection만 넣고 원본은 `.ditto/knowledge`에 둔다." 현재 host 지침 projection은 `AGENTS.md`(charter) → `CLAUDE.md`만이다. M6에서 `bridge-sync.ts`를 확장해 `.ditto/knowledge/CONTEXT.md`·`glossary.json`·`adr/`의 **요약 projection**을 CLAUDE.md(또는 host memory)에 추가한다. 기존 AGENTS.md projection과 **동형**(원본은 `.ditto/knowledge`, projection은 파생)이며, `knowledgeRecord.projected_to_claude_md`가 projection 여부를 기록한다.

projection은 **요약만** 싣는다(원본 전체가 아니라 용어/결정 헤드라인 + 경로). 큰 본문은 path 참조로 둔다(컨텍스트 누적 최소화, EvidenceRecord 원칙과 동형).

## 5. 적합성 (현재 / M6)

- **현재(v0, design-lock)**: schema parse(실제 glossary+ADR 모델 fixture)/cross-field reject + barrel/registry/sidecar-registration 등록 + M1.5b(agent 부재) 유지. → `tests/schemas/knowledge-record.test.ts`.
- **M6(runtime)**: curator spawn 흐름, `/ditto:knowledge-update` 산출물, projection drift(원본↔CLAUDE.md) 0, `nodeKind=knowledge` 노드 owner 매핑 검증.
