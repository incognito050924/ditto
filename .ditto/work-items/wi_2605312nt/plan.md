# Plan — wi_v04knowledge_curator (wi_2605312nt) — KnowledgeContract design-lock

## 핵심 결정 (권위 문서 ↔ 메모리 충돌 해소)

메모리 ⑤ 노트는 "agents/knowledge-curator.md 본문 + /ditto:knowledge-update skill"을 제안했다. 그러나:
- 설계서 §0(line 33), line 830: **knowledge base는 post-v0(M6)** — "v0는 M0~M2까지." E2E/knowledge/PM은 후속 분리.
- `tests/conformance/m1.conformance.test.ts` **M1.5b**가 `agents/knowledge-curator.md`의 **v0 부재를 단언**.

헌장 §2(도메인/저장소 규칙 > 메모리) + 사용자 "상세 설계까지" 범위 → **agent runtime 미생성**, `KnowledgeContract` schema + per-contract 설계문서로 **design-lock**. M1.5b invariant 보존.

## 전달물 (post-v0 contract design-lock)

- `src/schemas/knowledge-record.ts`: `knowledgeRecord`(프로젝트 지식·용어 ref·ADR 결정·반복 학습) + `knowledgeDecision`/`knowledgePattern`/`knowledgeLearning`. cross-field: superseded ⇒ superseded_by.
- 등록: barrel + export-schemas registry + sidecar-registration NEW_SIDECARS. JSON schema 생성.
- `reports/design/contracts/knowledge-contract.md`: curator 책임 + /ditto:knowledge-update 절차 + `.ditto/knowledge/* → CLAUDE.md` projection(bridge-sync 확장, AGENTS.md와 동형) + closure 직전 knowledge 노드 권장. **runtime은 M6**임을 명시.
- conformance: schema parse(실제 glossary+ADR fixture)/reject + 회귀(M1.5b 포함) + matrix post-v0 design-lock 섹션.

## [DECIDED]

- glossary schema 재정의 금지 — `glossary_path`로 참조(중복·얕은 추상화 금지).
- projection runtime은 `bridge-sync.ts` 확장으로 M6에서(기존 AGENTS.md projection과 동형). 본 wi는 설계로만 박음.
- 신규 schema는 v0 conformance 합계에 더하지 않음(post-v0). matrix에 별도 design-lock 섹션.

## 범위 밖
- knowledge-curator agent 파일, /ditto:knowledge-update skill 파일 (M6 runtime).
- CLAUDE.md projection 실제 구현 (M6).
- glossary schema 변경.
