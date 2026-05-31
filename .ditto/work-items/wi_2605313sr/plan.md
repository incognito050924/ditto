# Plan — wi_v04evidence_record_sidecar (wi_2605313sr)

## 배경

설계서 §6.7(line 619-652)은 evidence의 **freshness**와 **portability**를 분리하라고 규정한다: raw artifact(`.ditto/runs/`, logs, screenshots, traces)는 계속 gitignore로 두되, **커밋 가능한 evidence ledger**를 따로 둬서 "증거가 있다"와 "이 clone/세션에서 raw를 열 수 있다"를 구분한다.

현재 코드의 갭(fresh 확인):
- `src/schemas/evidence-record.ts` **부재**. `evidenceRef`(`common.ts`)는 `kind/path/url/command/sha256/lines/summary`만 — freshness/portability/artifact_available 없음.
- `.ditto/work-items/<id>/evidence-index.json` **ledger 없음**. `EvidenceStore`는 `commands.jsonl`(gitignored evidence/ 하위)만 다룸.
- 설계서 §6.7 line 633-645가 `EvidenceRecord` shape를 못박아 둠(권위 출처).

## 새 용어 도입 (사용자가 처음 보는 것)

| 이름 | 1줄 정의 |
|---|---|
| `EvidenceRecord` (= 증거 한 건을 freshness/portability로 감싼 sidecar 레코드) | `evidenceRef`를 `ref`로 품고 `captured_at`/`freshness`/`portability`/`artifact_available`/`exit_code`/`key_lines`를 더한 것. evidenceRef 자체는 안 바꾼다(설계서 line 629). |
| `evidence-index.json` (= work item별 커밋 가능 evidence ledger) | `.ditto/work-items/<id>/` 루트에 두는 append-only EvidenceRecord 모음. raw가 없어도 summary/sha256/exit_code/key_lines로 판정 가능. `evidence/` 하위(gitignore)와 달리 **커밋 대상**. |

## EvidenceRecord shape (설계서 line 633-645 그대로)

```jsonc
{
  "ref": { "kind": "command", "command": "bun test", "summary": "passed" },
  "captured_at": "2026-05-26T00:00:00.000Z",
  "freshness": "fresh|stale",
  "stale_reason": null,
  "portability": "committed|local-artifact",
  "artifact_available": true,
  "exit_code": 0,
  "key_lines": []
}
```

## AC (work-item.json과 동일, 요약)

- **AC-1** `evidence-record.ts` 신규: `evidenceRecord`(위 shape) + 커밋 파일 envelope `evidenceIndex = { schema_version, work_item_id, records: evidenceRecord[] }`.
- **AC-2** cross-field(superRefine): stale⇒stale_reason 필수 / fresh⇒stale_reason=null / committed⇒artifact_available=true.
- **AC-3** 두 schema를 barrel + export registry + sidecar-registration 테스트 세 곳 등록 + JSON schema 생성.
- **AC-4** `EvidenceStore.appendRecord`/`readIndex` — `evidence-index.json`(work-item 루트, 커밋 대상) append-only, atomic, schema 검증.
- **AC-5** `acceptanceVerdict.evidence_records`(optional, default [], backward compat) + conformance(cross-field·round-trip·artifact_available=false fallback) + 회귀 + 문서.

## [DECIDED] (메모리 project_v04_runtime_wiring에서 — 그대로 적용)

- sidecar는 기존 `evidenceRef`와 **공존**(backward compat). `evidence`(bare ref 배열) **폐기 X**, `evidence_records`(freshness 래핑)는 additive optional.
- raw artifact는 계속 gitignore(`.ditto/work-items/*/evidence/`). ledger(`evidence-index.json`)만 커밋.
- `exit_code`/`key_lines`는 raw 없이 판정 가능하게 하는 메타(설계서 line 698·650). exit_code는 command 외 evidence엔 null 허용.

## 변경 대상

| 파일 | 변경 | AC | 유형 |
|---|---|---|---|
| `src/schemas/evidence-record.ts` (신규) | evidenceRecord + evidenceIndex + superRefine | AC-1, AC-2 | 구조적 |
| `src/schemas/index.ts` | barrel `export * from './evidence-record'` | AC-3 | 구조적 |
| `scripts/export-schemas.ts` | registry에 evidence-record·evidence-index | AC-3 | 구조적 |
| `tests/schemas/sidecar-registration.test.ts` | NEW_SIDECARS 2건 추가 | AC-3 | 구조적 |
| `schemas/evidence-record.schema.json`·`evidence-index.schema.json` (신규) | JSON schema 생성 | AC-3 | 구조적 |
| `src/core/evidence-store.ts` | appendRecord/readIndex + evidenceIndexPath | AC-4 | 동작적 |
| `src/schemas/completion-contract.ts` | acceptanceVerdict.evidence_records optional default [] | AC-5 | 동작적 |
| `schemas/completion-contract.schema.json` | 재생성 | AC-5 | 동작적 |
| `tests/conformance/m3.conformance.test.ts` | EvidenceRecord cross-field + ledger round-trip + fallback | AC-5 | 동작적 |
| `tests/core/evidence-store.test.ts` | appendRecord/readIndex 단위 | AC-4 | 동작적 |
| matrix + plan §M3 | M3 케이스 수 + EvidenceRecord 한 줄 | AC-5 | 검증 전용 |

## Tidy First 분리 (예상 commits)

구조적 먼저:
1. `refactor(M3): add evidenceRecord/evidenceIndex schema + register in barrel/registry (구조적)` — schema 파일 + barrel + registry + sidecar-registration 테스트 + JSON schema. 런타임 미사용.

동작적:
2. `feat(M3): EvidenceStore evidence-index.json ledger (appendRecord/readIndex) (동작적)` — AC-4 + 단위 테스트.
3. `feat(M3): completion acceptance carries optional evidence_records (backward-compat) (동작적)` — AC-5 contract field + JSON schema 재생성.
4. `feat(M3): conformance — EvidenceRecord cross-field + ledger round-trip + artifact_available fallback (동작적)` — AC-5 conformance.
5. `docs(v0): conformance matrix + plan §M3 reflect wi_v04evidence_record_sidecar (검증 전용)`.
6. `docs(ditto): close wi_v04evidence_record_sidecar — AC-1..AC-5 pass`.

## 검증

```
bun test
bun test tests/schemas/sidecar-registration.test.ts
bun test tests/core/evidence-store.test.ts
bun test tests/conformance/m3.conformance.test.ts
bun run schemas:export   # JSON schema drift 0
bun run lint
```

## 위험 / 되돌리기

- `evidence_records` default [] → 기존 completion fixture/artifact 마이그레이션 불필요(backward compat). 되돌리려면 field 제거 + JSON schema 재생성.
- evidence/evidence_records 표면상 중복 → 역할 분리 주석으로 명시(legacy bare ref vs freshness 래핑).

## 범위 밖

- 기존 `evidenceRef` 폐기/변경 (설계서 line 629 금지).
- 누가 EvidenceRecord를 쓰는가(verifier·PostToolUse runtime 행동) — driver는 schema+store만 결정론으로 제공, 기록 주체·내용은 LLM 위임.
- commands.jsonl → evidence-index 자동 승격, dialectic/handoff 연동(③ 이후).
- KnowledgeContract projection (⑤), browser artifact 실제 capture (⑥).
