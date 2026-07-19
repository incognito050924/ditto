# bridge — 지식·지침을 호스트 표면(CLAUDE.md)으로 단방향 투영하고 drift를 검출하는 커맨드

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준 커밋: `c2d2e16` (2026-07-19).

## 1. 이 기능이 실현하려는 설계 의도 (개념)

DITTO는 두 호스트에서 동작한다(ADR-0016). Codex는 저장소 루트의 `AGENTS.md`를 지침 원본으로 **직접** 읽지만, Claude Code는 `CLAUDE.md`를 읽는다. 같은 지침을 두 파일에 손으로 이중 관리하면 시간이 지나며 어긋난다(drift). `bridge`는 이 문제를 **단일 원본(SoT) + 결정론적 단방향 투영 + sha256 drift 검출**로 푼다.

- `AGENTS.md`가 지침의 원본(source), `CLAUDE.md`가 투영본(projection). 방향은 항상 source → projection 단방향이다(`src/core/instruction-bridge.ts:152-160`이 codex 어댑터를 source, claude-code 어댑터를 projection으로 로드).
- 투영본에는 원본 내용을 그대로 담되, `<!-- ditto:managed:start ... sha256=... -->` … `<!-- ditto:managed:end -->` 마커로 감싼 **관리 블록(managed block)** 안에만 쓴다. 블록 바깥의 사용자 작성 내용은 절대 건드리지 않는다(`bridge-sync.ts:70-74`).
- 마커에 원본의 정규화 sha256을 박아, 원본이 바뀌었는지를 해시 비교만으로 판정한다 — 이것이 drift 검출의 핵심.

이는 charter §4-11("권위는 코드에 있다 / drift 방지")의 직접 구현이다: 문서를 경로로 가리켜 이중화하지 않고, 원본 내용을 투영본에 직접 담되 해시로 동기 상태를 강제한다.

두 번째 서브커맨드 `bridge knowledge`는 같은 투영 메커니즘을 `.ditto/knowledge/`의 durable knowledge(CONTEXT/glossary/ADR)에 적용해, 그 요약을 `CLAUDE.md`의 **별도 마커 계열**(`ditto:knowledge:*`) 블록으로 투영한다.

DITTO 4축 기준으로 이 기능은 **지식(knowledge) 축과 배포/거버넌스**에 걸친다: 지침·지식이라는 산출물을 호스트별 실행 표면으로 배포하는 seam이다.

## 2. 코드 위치와 진입점

| 경로 | 역할 |
|---|---|
| `src/cli/commands/bridge.ts` | CLI 진입점. `bridge sync`·`bridge knowledge` 두 서브커맨드 정의, 종료코드 매핑 |
| `src/core/bridge-sync.ts` | `syncClaudeCodeProjection` — AGENTS.md → CLAUDE.md 관리 블록 upsert |
| `src/core/instruction-bridge.ts` | 마커 정규식, 정규화·해시, source/projection 로더, drift 비교(`check*`/`compare*`), `checkInstructionsForHosts` |
| `src/core/knowledge-bridge.ts` | `syncKnowledgeProjection` — knowledge 요약을 `ditto:knowledge:*` 블록으로 투영 |
| `src/core/managed-resource.ts` | `buildManagedBlock` 등 순수 블록 문자열 변환(sync/setup/teardown 공유) |
| `src/core/hosts/codex.ts`·`claude-code.ts` | 어댑터. `loadInstructions`가 각 호스트의 지침 표면(role=source/projection) 반환 |

서브커맨드·인자:

| 서브커맨드 | 인자 | 기본값 | 설명 |
|---|---|---|---|
| `bridge sync` | `--host` | `claude-code` | 투영 대상. `claude-code`만 허용(그 외 usage error) |
| | `--check` | `false` | dry-run. 파일 안 쓰고 drift만 판정 |
| | `--output` | `human` | `human`\|`json` |
| `bridge knowledge` | `--check` | `false` | dry-run drift check |
| | `--output` | `human` | `human`\|`json` |

`bridge.ts:30-34`: `--host`가 `claude-code`가 아니면 "codex reads AGENTS.md directly" 메시지와 함께 usage error(exit 2)로 거부한다. 이는 §1의 단방향 원칙을 CLI 계약으로 못 박은 것 — codex 방향으로는 투영하지 않는다(codex가 원본을 직접 읽으므로).

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

### bridge sync

```
AGENTS.md (source, repoRoot 루트)
  └─(codex 어댑터 loadInstructions, role=source)─> loadSource()
        └─ normalizeInstructionText → normalizedSha256
CLAUDE.md (projection)
  └─(claude-code 어댑터, role=projection)─> loadProjection()
        └─ MANAGED_BLOCK_RE_G로 관리 블록 파싱 → {missing|no_marker|multiple_markers|ok}
  buildManagedBlock(source.content)  ← 마커 + 해시 스탬프
  → projection 종류에 따라 create / append / replace / refuse
  → atomicWriteText(CLAUDE.md)  (check=true면 안 씀)
  → BridgeSyncResult { path, action, oldSha256, newSha256 }
```

- 읽는 상태: `AGENTS.md`(원본), `CLAUDE.md`(투영본). 둘 다 `repoRoot`(`resolveRepoRootForCreate()`) 기준.
- 쓰는 상태: `CLAUDE.md`. 원자적 쓰기(`atomicWriteText`, `bridge-sync.ts:37`).

### bridge knowledge

```
.ditto/knowledge/CONTEXT.md, glossary.json, adr/*.md
  └─ loadKnowledgeSources()  ← ADR·glossary 헤드라인만 요약(본문은 경로 참조로 남김)
  └─ renderKnowledgeSummary()  ← 요약 본문 텍스트
  └─ knowledgeSummarySha256()  ← 요약의 정규화 sha256(= drift key)
  └─ knowledgeBlock()  ← <!-- ditto:knowledge:start sha256=... --> 블록
CLAUDE.md
  └─ loadKnowledgeProjection()  ← KNOWLEDGE_BLOCK_RE_G로 파싱
  → create / append / replace / refuse → atomicWriteText
  → KnowledgeSyncResult { path, action, oldSha256, newSha256 }
```

- 읽는 상태: `.ditto/knowledge/CONTEXT.md`·`glossary.json`·`adr/ADR-*.md`. glossary는 zod `glossarySummarySchema`로 파싱해 `term`(+ agreed 아닌 status) 헤드라인 정렬(`knowledge-bridge.ts:97-101`). ADR은 `ADR-\d{4}.*\.md` 파일명 필터 후 `# ` 제목·`상태:`/`status:`로 헤드라인 구성(`adrHeadline`, :72-81).
- 쓰는 상태: `CLAUDE.md`의 `ditto:knowledge:*` 블록.

두 서브커맨드 모두 결과 스키마가 동형이다(`action`, `oldSha256`, `newSha256`, 선택적 `message`). `action` 값: `created`/`updated`/`unchanged`/`would-create`/`would-update`/`would-be-unchanged`/`refused-multiple-markers`.

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

### (a) 단일 원본 + 단방향 투영 (ADR-0016)

`AGENTS.md`가 원본이고 codex는 이를 직접 읽는다(ADR-0016 D2, `codex.ts:120-130`이 `AGENTS.md`를 role=source로 로드). Claude만 투영이 필요하므로 `bridge sync`는 `--host claude-code`만 받는다. 대안(양방향 동기, 자동 host 감지)은 원본이 둘이 되어 drift를 되레 만든다 — 단방향이 결정론적이고 SoT를 하나로 유지한다.

### (b) 마커 + sha256 = drift 검출 계약

관리 블록 마커는 `source=<name>`과 `sha256=<64 hex>`를 담는다(`instruction-bridge.ts:11-15`). 투영 시 원본 정규화 sha를 마커에 스탬프하고(`managed-resource.ts:79`), 검사 시 (1) 마커 sha가 원본 sha와 같은지, (2) 블록 실제 내용의 재계산 sha가 원본 sha와 같은지를 모두 비교한다(`compareClaudeProjection`, `instruction-bridge.ts:275-298`). 두 검사가 분리된 이유: 마커만 위조되고 내용이 다를 수도, 내용만 손대고 마커를 안 고쳤을 수도 있어 둘 다 잡아야 한다.

### (c) 정규화 후 해시 (드리프트 오탐 방지)

`normalizeInstructionText`(`instruction-bridge.ts:96-103`)가 CRLF→LF, 행 끝 공백 제거를 한 뒤 해시한다. 줄바꿈·트레일링 공백 차이만으로 drift로 오판하지 않게 하려는 정규화다.

### (d) knowledge는 별도 마커 계열이어야 한다 (하드 제약)

`knowledge-bridge.ts:8-22` 주석이 명시: instruction bridge는 `ditto:managed` 블록이 2개 이상이면 **하드 거부**한다. `CLAUDE.md`는 이미 AGENTS.md발 `ditto:managed` 블록을 정확히 1개 갖고 있으므로, knowledge 요약은 반드시 `ditto:knowledge:*`라는 **다른 마커 계열**로 써야 두 투영이 충돌하지 않는다. `syncKnowledgeProjection`은 `ditto:managed` 블록을 절대 건드리지 않고 그 아래에 append한다(:229-233).

### (e) 위임 조항 존재성 검사 (§4-9 앵커)

`instruction-bridge.ts:28-36, 197-212`: sha/content 일치 검사는 원본과 투영본 **양쪽에서** 조항을 지워도 여전히 일치하므로 못 잡는다. 그래서 원본이 charter(`Agent Behavior Charter` 마커 포함)일 때 한정으로, 위임 규율 조항 앵커 문자열 `위임으로 컨텍스트를 지킨다`의 **존재**를 별도로 단언한다. 이 검사는 `ditto doctor instructions` seam에서 돌아 `DITTO_SKIP_HOOKS` kill-switch와 독립적이다(주석 :33-35).

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

### `syncClaudeCodeProjection` (`bridge-sync.ts:23-87`)

입력: `repoRoot`, `{check}`. 하는 일:
- `loadSource`로 AGENTS.md를 읽고, 없으면 즉시 throw("cannot sync Claude projection", :28) — 원본 부재는 복구 불가로 보고 fail한다.
- `buildManagedBlock(source.content)`로 블록 생성. 주석(:31-32)이 밝히듯 sync와 setup/teardown이 **같은 빌더**를 써야 임베드 개행 규율·해시 대상이 어긋나지 않는다.
- projection 종류별 분기:
  - `missing`: 새 파일에 블록만 쓰고 `created`/`would-create`.
  - `no_marker`: 기존 내용 뒤에 구분자 + 블록 append(`updated`). 구분자는 기존이 `\n`로 끝나면 `\n`, 아니면 `\n\n`(:48) — 블록이 앞 내용에 붙지 않게 하는 개행 규율.
  - `multiple_markers`: **쓰지 않고** `refused-multiple-markers` 반환(:60-68). 관리 블록이 2개 이상이면 어느 걸 교체할지 모호하므로 fail-closed.
  - `ok`: `startIndex..endIndex` 구간만 새 블록으로 치환(:70-72). 바깥 내용 보존. 결과가 기존과 같으면 `unchanged`.

산출 효과: `CLAUDE.md`의 관리 블록만 원본과 동기화. `check=true`면 파일을 안 쓰고 `would-*` action만 돌려줘 drift 판정 dry-run으로 쓰인다.

### 종료코드 매핑 (`bridge.ts:14-15, 45-50`)

- `refused-multiple-markers` → exit 1(`DRIFT_EXIT`).
- `--check`이면서 `would-create`/`would-update` → exit 1. 즉 **check 모드에서 drift가 있으면 non-zero** — CI·doctor가 drift를 실패로 감지할 수 있게 하는 계약.
- `InvalidOutputFormatError` → exit 2(usage), 그 외 런타임 오류 → exit 70(`BRIDGE_RUNTIME_ERROR_EXIT`).

`bridge knowledge`(:70-95)도 종료코드 규칙이 동일하다.

### `buildManagedBlock` (`managed-resource.ts:69-81`)

원본 본문을 정규화하고, 끝에 개행이 없으면 **강제로 하나 붙인 뒤**(bodyWithBreak) 그 post-break 본문으로 sha를 계산한다. 주석(:75-79)이 밝히는 미묘한 결정: 리더는 마커 사이 바이트(강제 개행 포함)로 actualSha를 재계산하므로, pre-break 본문으로 해시하면 트레일링 개행 없는 원본에서 마커 sha와 리더가 불일치한다. 이 순서 의존성이 drift 오탐을 막는다.

### `compareClaudeProjection` (`instruction-bridge.ts:214-300`)

source/projection을 받아 finding 배열 반환. `source_missing`/`projection_missing`/`marker_missing`/`multiple_markers`를 먼저 처리하고, `ok`면 (1) `markerSource !== 'AGENTS.md'` → `source_mismatch`, (2) 마커 sha ≠ 원본 sha → `sha256_mismatch`, (3) 재계산 sha ≠ 원본 sha → `content_mismatch`를 각각 독립 finding으로 push. findings 비면 status=`ok`, 아니면 `drift`(`resultStatus`, :302-304).

### `checkInstructionsForAdapters` (`instruction-bridge.ts:351-384`)

source 표면이 검사 대상 어댑터에 없으면 다른 등록 어댑터에서 찾고, 그래도 없으면 `AGENTS.md`를 missing으로 합성한다(:357-367). codex source엔 `checkCodexInstructions`(마커 개수) + `checkRequiredClauses`(§4-9 조항 존재)를, claude projection엔 `compareClaudeProjection`을 적용. 이 함수가 `bridge`가 아니라 **`ditto doctor instructions`**(`doctor.ts:172`)의 검사 엔진이다 — `bridge sync --check`은 쓰기 관점 drift, `doctor`는 읽기 전용 진단 관점.

### knowledge 로더의 fail-open 이중성 (`knowledge-bridge.ts`)

- `loadKnowledgeSources`의 glossary 파싱은 `JSON.parse`가 가드 없이 노출(:96) — 주석(:129)이 이를 "unguarded"로 명시.
- 반면 `loadGlossaryVocab`(:135-155)은 try/catch + safeParse + `onMalformed` 콜백으로 **fail-open by construction**: malformed glossary가 인터뷰 게이트를 죽이지 못하게, `[]` 반환 + 경고(`warnMalformedGlossary`, :162-166). 두 로더의 실패 정책이 다른 것은 의도적이다(호출처의 치명도가 다름).

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위(위 6개 파일 + doctor/doctor-fix 소비처, 커밋 `c2d2e16`)에서 의도와 코드가 일치한다:

- 단방향(§1, ADR-0016 D2): `bridge sync`가 `--host claude-code`만 허용(:30-34), codex는 원본 직접 읽음. 일치.
- 별도 마커 계열로 이중 투영 충돌 방지(§4-d): `ditto:managed`와 `ditto:knowledge`가 서로 다른 정규식(`MANAGED_BLOCK_RE_G` vs `KNOWLEDGE_BLOCK_RE_G`)을 쓰고 knowledge sync가 managed 블록을 건드리지 않음. 일치.
- check 모드 drift→non-zero(§5): `bridge.ts:48-50`·`86-88`. 일치.

미확인/주의 지점:
- **위임 조항 검사는 `bridge` 경로가 아니라 doctor 경로에서만 발화**한다(`checkRequiredClauses`는 `checkInstructionsForAdapters`→`checkInstructionsForHosts`→`doctor.ts:172`에서만 호출). `bridge sync`는 이 조항 존재를 검사하지 않는다 — sync는 원본을 그대로 투영할 뿐. 이는 설계 주석(:33-35)과 일치하나, "bridge가 조항까지 지킨다"고 오해하면 갭. 미확인: doctor 외 다른 호출처 존재 여부는 grep 범위(src)에서 doctor뿐이었다.
- `bridge knowledge`에는 `--host` 인자가 없다(항상 CLAUDE.md 대상). codex용 knowledge 투영은 없다 — 확인 범위에서 의도된 부재(codex는 별도 knowledge 투영을 안 받음)로 보이나, 이를 명시한 ADR 조항은 확인하지 못함(미확인).

## 7. 잠재 위험·부작용·재설계 시 고려점

- **동시성**: `atomicWriteText`는 원자적 쓰기지만 read-modify-write 구간(로드 → 블록 계산 → 쓰기) 전체가 원자적이진 않다. 두 프로세스가 동시에 `bridge sync`하면 마지막 쓰기가 이긴다(last-write-wins). 관리 블록만 결정론적으로 재생성되므로 손실은 없으나, 동시 실행 중 하나가 `multiple_markers`를 만들면 이후 sync가 refuse된다.
- **`multiple_markers` fail-closed의 대가**: 관리 블록이 우연히 2개가 되면(과거 double-wrap, 수동 편집) sync가 멈추고 사람이 정리해야 한다(:66 메시지). 자동 복구 없음 — 안전하지만 운영 부담. `managed-resource.ts`의 `upsertManagedBlock`은 stacked 블록을 하나로 collapse하는 경로가 있으나(`locateManagedSpan`, :52-66), `bridge-sync.ts`는 이 관대한 경로를 쓰지 않고 엄격히 refuse한다 — sync와 setup/teardown의 관용도가 다른 점은 재설계 시 통일 검토 대상.
- **정규화 의존 drift**: 해시가 `normalizeInstructionText`에 의존하므로, 정규화 규칙(현재 CRLF·트레일링 공백만)을 바꾸면 기존 투영본 전부가 일제히 drift로 뜬다. 정규화 변경은 파괴적 마이그레이션이다.
- **원본 부재 시 throw**: `AGENTS.md`가 없으면 `syncClaudeCodeProjection`이 예외를 던진다(:28). doctor-fix가 이를 부를 때(`doctor-fix.ts:141`) 예외 처리 여부는 이 문서 확인 범위 밖(미확인).
- **재설계 시 보존해야 할 불변식**: ① source→projection 단방향, ② `CLAUDE.md`에 `ditto:managed` 정확히 1개, ③ knowledge는 별도 마커 계열, ④ 마커 sha는 임베드된(강제 개행 포함) 본문으로 계산, ⑤ check 모드 drift는 non-zero exit. 특히 ②④는 깨면 drift 검출 자체가 false-green으로 무력화된다.
- **재고 가능한 결정**: `bridge sync`의 `--host` 화이트리스트(현재 claude-code만). 세 번째 호스트가 생기면(ADR-0016 철회 조건) 이 하드코딩과 codex source 전제를 다시 봐야 한다.
