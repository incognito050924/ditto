# knowledge — 지속 지식(축4) 큐레이션의 기계 검증 가능한 게이트·ADR 뼈대·정합 검사 CLI

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준: 커밋 `c2d2e16`, 2026-07-19.

## 1. 이 기능이 실현하려는 설계 의도 (개념)

`ditto knowledge`는 DITTO 4축 중 **지식(축4)** 축에 속한다. 이 축의 목표는 한 work item에서 얻은 것 중 "다음에도 쓸모 있는" 세 종류 — (a) 사용자와 합의한 용어, (b) 근거·기각안·철회조건을 가진 기술 결정(ADR), (c) 반복 학습/패턴 — 을 runtime 로그가 아니라 durable knowledge로 승격하고, 그 요약을 `CLAUDE.md`에 투영해 이후 에이전트가 본문을 다시 읽지 않고도 들고 다니게 하는 것이다 (`src/core/knowledge-bridge.ts:8-22`, `agents/knowledge-curator.md:16-20`).

이 CLI가 푸는 구체적 문제는 두 가지다.

1. **"기록할 만한 변화인가"를 산문 휴리스틱에서 기계 검증 가능한 표면으로 바꾼다.** 무엇을 durable knowledge로 남길지는 원래 큐레이터(LLM)의 판단이었다. `knowledge gate`는 큐레이터가 "어떤 계기가 켜졌다"고 선언한 것과 "무엇을 실제로 기록했다"는 것을 대조해, 누락(under-recording)과 노이즈(over-recording)를 둘 다 잡는다 (`src/cli/commands/knowledge.ts:18-26`, `src/core/gates.ts:894-920`).
2. **ADR 식별자를 생성 시점에 불변·충돌내성으로 박는다.** `adr-new`는 `ADR-YYYYMMDD-<slug>.md` 뼈대를, `adr-check`는 파일명 형식·식별자 유니크성 정합을 만든다 (ADR-20260624 결정의 집행 표면).

주의: **CLAUDE.md 투영 자체는 `ditto knowledge`가 아니라 `ditto bridge knowledge`가 담당한다** (`src/cli/commands/bridge.ts:60-88`, `syncKnowledgeProjection`). `knowledge` 커맨드의 서브커맨드는 `gate`·`adr-new`·`adr-check` 셋뿐이다 (`src/cli/commands/knowledge.ts:292-302`). 큐레이션 개념은 `knowledge-bridge.ts` 모듈 전체에 걸쳐 있지만, `knowledge` CLI가 노출하는 표면은 그 일부(게이트+ADR 파일 관리)다.

## 2. 코드 위치와 진입점

핵심 파일:

- `src/cli/commands/knowledge.ts` — CLI 진입점. `gate`/`adr-new`/`adr-check` 세 서브커맨드 정의, `createAdrSkeleton`·`checkAdrConsistency` 순수 로직 포함.
- `src/core/gates.ts:865-920` — `knowledgeUpdateGate`(계기↔기록 정합 게이트)와 그 입력 타입(`KnowledgeTriggers`, `KnowledgeRecordDelta`).
- `src/core/knowledge-bridge.ts` — CLAUDE.md 투영(`syncKnowledgeProjection`), 지식 소스 로드(`loadKnowledgeSources`), glossary opaque-vocab 로드(`loadGlossaryVocab`). `knowledge` CLI가 아니라 `bridge` CLI와 인터뷰 게이트가 소비한다.
- `src/schemas/adr-id.ts` — ADR 식별자 문법(정규식) 단일 출처. schemas·core·cli가 공유.
- `src/schemas/knowledge-record.ts` — durable knowledge 레코드 계약(`knowledgeRecord`).
- `src/schemas/glossary.ts` — 용어집 계약(`glossary`, `glossaryEntry`).
- `src/schemas/knowledge-gate-carrier.ts` — 게이트 입력을 디스크에 영속하는 carrier(Stop 훅 재집행용).
- `src/hooks/stop.ts:411-421` — `knowledgeForcesContinuation`, 런타임에 carrier로 게이트 재집행.
- `agents/knowledge-curator.md` — 이 CLI를 사용하는 autopilot owner subagent.

서브커맨드·인자:

| 서브커맨드 | 인자 | 필수 | 역할 | 실패 exit |
|---|---|---|---|---|
| `gate` | `--json` (triggers+delta JSON), `--output human\|json` | `--json` | 계기↔기록 정합 검사(under/over-recording) | 65(usage)/1(fail) |
| `adr-new` | `--slug`, `--output` | `--slug` | `ADR-YYYYMMDD-<slug>.md` 뼈대 생성 | 65/1 |
| `adr-check` | `--output` | — | `adr/` 디렉터리 파일명 형식·id 유니크성 검사 | 65/1 |

(exit 상수: `USAGE_ERROR_EXIT=65`, `RUNTIME_ERROR_EXIT=1` — `src/cli/util.ts:36-37`.)

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

### 3.1 `gate` — 순수 검사, 상태 없음

```
--json {triggers, delta}
  → JSON.parse → gateInput.safeParse (zod)      (knowledge.ts:65-81)
  → knowledgeUpdateGate(triggers, delta)         (gates.ts:904)
  → {pass, reasons[]}  → stdout(human/json)
  → pass=false 이면 exit 1                        (knowledge.ts:89)
```

파일을 읽거나 쓰지 않는다. 입력은 전부 `--json`으로 들어오고, 큐레이터가 선언한 `triggers`(3개 불리언)와 `delta`(4개 카운트)만으로 판정한다.

### 3.2 `adr-new` — 파일 생성

```
--slug → resolveRepoRootForCreate()
  → createAdrSkeleton({repoRoot, slug})          (knowledge.ts:145-163)
      ADR_SLUG_RE 검증 → id = ADR-<UTC YYYYMMDD>-<slug>
      → 대상 존재하면 throw(덮어쓰기 거부)
      → writeFile(.ditto/knowledge/adr/<id>.md, 뼈대본문)
  → {id, path} → stdout
```

쓰는 파일: `.ditto/knowledge/adr/ADR-YYYYMMDD-<slug>.md` (뼈대 본문은 `상태: proposed`·컨텍스트·결정·근거·변경 조건 섹션 — `knowledge.ts:108-131`).

### 3.3 `adr-check` — 디렉터리 스캔 검사

```
findRepoRoot()
  → checkAdrConsistency(repoRoot)                (knowledge.ts:183-217)
      readdir(.ditto/knowledge/adr) → *.md 정렬
      각 파일: adrIdFromFilename(f)              (adr-id.ts:69-72)
        null → "malformed filename" 위반
        id → idToFiles 버킷에 누적
      버킷 size>1 → "duplicate identifier" 위반
  → {ok, violations[]} → stdout
  → ok=false 이면 exit 1                          (knowledge.ts:248)
```

읽는 상태: `.ditto/knowledge/adr/*.md` 파일명만. 본문은 읽지 않는다. **별도 인덱스(예전 `knowledge.json` `decisions[]`)와 대조하지 않는다** — 그 인덱스는 폐기됨(§4).

### 3.4 (인접) CLAUDE.md 투영 — `ditto bridge knowledge`

```
loadKnowledgeSources(repoRoot)                    (knowledge-bridge.ts:87-119)
  CONTEXT.md 경로 + glossary.json 용어 headline + adr/*.md headline
  → renderKnowledgeSummary → normalizeInstructionText
  → sha256 → <!-- ditto:knowledge:start sha256=... --> 블록
  → CLAUDE.md 에 upsert (ditto:managed 블록은 건드리지 않음)
```

이건 `knowledge` CLI 밖이지만 같은 개념군이라 §5.5에서 인과를 설명한다.

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

### 4.1 계기↔기록 정합 게이트 (under ∧ over-recording)

큐레이터가 세 계기 중 무엇이 켜졌는지 선언하고(`adr_worthy_decision`/`new_agreed_term`/`repeated_pattern`), 자신이 실제 기록한 델타(`decisions`/`glossary_terms`/`patterns`/`learnings`)를 함께 낸다. 게이트는 둘의 불일치를 잡는다 (`gates.ts:894-920`):

- **under-recording**: 계기가 켜졌는데 대응 기록이 0 → FAIL.
- **over-recording**: 켜진 계기가 하나도 없는데 뭔가 기록됨 → FAIL.
- **유효한 명시적 skip**: 계기 0 + 기록 0 → PASS(아무것도 안 남기는 게 정답인 work item).

계기→기록 매핑은 `decision→decisions`, `term→glossary_terms`, `pattern→patterns∪learnings` (`gates.ts:901`, `916`). 이 설계는 "가치 있는 durable 변화"를 순수 큐레이터 휴리스틱에서 명시적·검증 가능한 표면으로 옮긴다 (`gates.ts:867-871`). ADR-0010(b)에 근거해 게이트는 "무언가를 기록하라"가 아니라 "선언한 계기 ↔ 실제 기록의 정합"만 강제한다 (`stop.ts:405-409`).

### 4.2 ADR 식별자 = 불변 파일명 (ADR-20260624)

`adr-new`/`adr-check`는 ADR-20260624의 집행 표면이다. 결정: 새 ADR의 id는 파일명 `ADR-YYYYMMDD-<slug>.md` **전체**이고 불변, 별도 순차번호·uid 없음 (`.ditto/knowledge/adr/ADR-20260624-adr-identifier-policy.md:11-17`).

- **채택 이유**: 순차번호는 동시 개발에서 조용히 충돌한다(다른 브랜치가 같은 `ADR-0026`을 slug 다르게 찍으면 git 머지가 충돌을 안 냄). 진짜 충돌(같은 날짜+같은 slug)은 같은 파일명이 되어 git이 감지한다 (ADR:23-25). `createAdrSkeleton`이 **랜덤 접미사 없이** 날짜+slug만으로 id를 만들고 충돌 시 재시도하지 않고 throw하는 것이 이 결정의 직접 구현 (`knowledge.ts:141-143`, `158-160`).
- **기각된 대안**: opaque-uid-only(가독성 상실), uid+seq 분리(여전히 renumber 필요), 기존 파일 rename(전 참조 전수-수정 재앙) → grandfather로 보존 (ADR:27-30).
- **철회 조건**: 중앙 번호 레지스트리가 생기면 순차번호 재고 가능 (ADR:32-36).

### 4.3 인덱스 폐기 — SoT는 `adr/*.md` 파일 자체

`adr-check`가 원래 하던 세 번째 검사("index↔file 일관성")는 2026-06-25 철회됐다 (ADR-20260624 amendment, `ADR-20260624-...:19`). 근거: ① 그 `knowledge.json` `decisions[]` 인덱스를 읽는 런타임 소비자가 0이었다(투영·memory 수집·ADR-0020 가드는 전부 `adr/*.md`를 직접 읽음), ② 자기참조 검사였다, ③ `adr/*.md`가 SoT인데 손-인덱스 재색인 = 헌장 §4-11(이중화=drift) 위반. 그래서 현재 `checkAdrConsistency`는 파일명만 보고 인덱스와 대조하지 않는다 (`knowledge.ts:176-182` 주석). `knowledgeRecord` 스키마에도 `decisions[]` 필드가 없다 (`knowledge-record.ts:10-16`).

### 4.4 스키마 = 단일 출처 (ADR-0002)

ADR id 문법은 `src/schemas/adr-id.ts` 한 곳에만 산다. 이 모듈은 `src/core`를 import하지 않는 leaf 계층에 일부러 놓여, core와 cli가 의존 방향을 뒤집지 않고 함께 쓸 수 있다 (`adr-id.ts:5-8`). anchored 검증기와 unanchored 추출기의 정규식 alternation 순서가 다른 것이 load-bearing이다: 추출기는 8자리 날짜 branch를 먼저 둬야 `ADR-20260624-x`가 `ADR-2026`으로 잘리지 않는다 (`adr-id.ts:16-22`, `39-45`).

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

### 5.1 `knowledgeGate.run` (`knowledge.ts:56-90`)

입력 `--json` → `parseOutputFormat` 검증(실패 시 exit 65) → `JSON.parse`(실패 시 exit 65) → `gateInput.safeParse`(zod, 실패 시 이슈별로 stderr 출력 후 exit 65). 통과하면 `knowledgeUpdateGate` 호출, `pass=false`면 exit 1. **효과**: 잘못된 입력(usage 65)과 정합 실패(runtime 1)를 exit 코드로 구분해, autopilot/CI가 "입력이 틀렸다"와 "기록이 불일치한다"를 다르게 라우팅할 수 있다.

### 5.2 `createAdrSkeleton` (`knowledge.ts:145-163`)

```
const id = `ADR-${ymdCompact(now)}-${opts.slug}`;
if (await fileExists(path)) throw new Error(`refusing to overwrite existing ADR: ${path}`);
```

숨은 결정:
- `now`가 주입 가능한 시계 seam(`generateId` 관례 미러) → 테스트에서 날짜 결정적 (`knowledge.ts:133-144` 주석).
- 날짜는 **UTC** (`ymdCompact`가 `getUTCFullYear/Month/Date` 사용 — `knowledge.ts:99-101`). 로컬 자정 근처 실행에서 날짜가 바뀌는 비결정성 제거.
- **fail-closed 이중**: slug가 `ADR_SLUG_RE`에 안 맞으면 throw(절대 쓰지 않음), 대상 파일이 이미 있으면 throw(덮어쓰기 거부). 같은 날+같은 slug 충돌은 "진짜 충돌"이므로 조용히 재롤하지 않고 표면화 (§4.2).

### 5.3 `checkAdrConsistency` (`knowledge.ts:183-217`)

```
const id = adrIdFromFilename(f);           // 파일명 whole-match → prefix 추출, malformed면 null
if (id === null) violations.push('malformed ADR filename: ...');
// idToFiles 버킷 누적 후
if (owners.length > 1) violations.push('duplicate ADR identifier ...');
```

숨은 결정·가드:
- `readdir` 실패(디렉터리 없음)를 `catch`로 삼켜 `files=[]` → 위반 0(빈 프로젝트는 clean). fail-open이지만, 검사 대상이 없을 뿐이라 안전 (`knowledge.ts:187-192`).
- **번호 시퀀스 갭은 검사하지 않는다** — legacy `ADR-NNNN` 파일도 그대로 통과. 이건 grandfather 정책의 직접 구현(빠진 번호를 위반으로 오탐하지 않음) (`knowledge.ts:180-182` 주석).
- 유니크성은 파일명이 아니라 **추출된 id** 기준. legacy `ADR-0026-a.md`와 `ADR-0026-b.md`는 파일명이 달라도 id가 같아 duplicate로 잡힌다 (`knowledge.ts:200-214`).

### 5.4 `adrIdFromFilename` (`adr-id.ts:69-72`)

whole-filename 검증(`ADR_FILENAME_RE`) 후 prefix 추출(`ADR_ID_EXTRACT_RE`). bare `ADR-0026.md`(slug 없음)나 `ADR-xyz.md`는 malformed로 null. **효과**: `adr-check`와 bridge의 `adrHeadline`이 같은 판정을 공유(drop-in).

### 5.5 `syncKnowledgeProjection` (`knowledge-bridge.ts:234-300`) — 인접 표면

`loadKnowledgeSources`가 glossary 용어 headline과 `adr/*.md` headline을 모아 요약 본문을 만들고, sha256을 마커에 박아 CLAUDE.md에 upsert. 인과:
- **별도 마커 family** `ditto:knowledge:start/end`를 쓴다 — instruction bridge가 `ditto:managed` 블록 2개 이상을 HARD-REFUSE하는데 CLAUDE.md엔 이미 AGENTS.md 소스의 `ditto:managed` 블록이 하나 있기 때문 (`knowledge-bridge.ts:11-18`).
- 마커가 2개 이상이면 `refused-multiple-markers` → 쓰지 않고 exit(drift) (`knowledge-bridge.ts:274-282`, `bridge.ts:83-85`).
- sha256이 소스와 일치하면 `unchanged`(drift 0), 아니면 재작성 (`knowledge-bridge.ts:284-306`). 이 sha256이 CLAUDE.md 요약이 소스와 동기화됐는지 판정하는 drift key.

### 5.6 `loadGlossaryVocab` (`knowledge-bridge.ts:135-155`) — 인접 표면

glossary의 `forbidden_abbreviations`(사용자향 출력에서 거부돼야 하는 약어)를 인터뷰의 opaque-vocab 검출기로 읽는다. **fail-open by construction**: 파일 없으면 `[]`, malformed면 `onMalformed()` 호출 후 `[]`(floor만 적용). 깨진 glossary가 인터뷰 게이트를 크래시시키지 못한다 (`knowledge-bridge.ts:121-134` 주석). 이 소비자는 `knowledge` CLI가 아니라 deep-interview·interview-driver·prism store다 (grep: `deep-interview.ts:630`, `interview-driver.ts:392`, `prism/store.ts:159`).

### 5.7 런타임 재집행: `knowledgeForcesContinuation` (`stop.ts:411-421`)

큐레이터가 낸 `{triggers, delta}`는 CLI 검사만이 아니라 `knowledge-gate.json`(`knowledgeGateCarrier`, `knowledge-gate-carrier.ts`)로도 영속돼, Stop 훅이 런타임에 게이트를 재집행한다. 그래프에 **terminal knowledge 노드**(`kind==='knowledge'` 또는 `owner==='knowledge-curator'`)가 있을 때만 활성, carrier 부재면 inert(유효한 skip), malformed면 상류에서 fail-closed (`stop.ts:401-410`). **효과**: 큐레이터가 CLI 게이트를 우회해도 완료 시점에 같은 정합 규칙이 다시 걸린다.

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위: `knowledge` CLI 세 서브커맨드 + 그 순수 로직(`knowledgeUpdateGate`·`createAdrSkeleton`·`checkAdrConsistency`·`adrIdFromFilename`) + 인접 소비자(bridge 투영·Stop 재집행·glossary vocab). 정적 읽기만 했고 명령을 실행하진 않았다(테스트 미실행 — 미검증).

- **게이트 정합 규칙**: `knowledgeUpdateGate`의 under/over-recording 분기가 §4.1 의도와 일치 (`gates.ts:904-920`). 단, "명시적 skip" 케이스(계기 0+기록 0)는 게이트가 PASS를 반환하지만 이건 의도된 동작(ADR-0010 b).
- **ADR id 불변·충돌내성**: `createAdrSkeleton`이 랜덤 접미사 없이 날짜+slug로 id를 만들고 덮어쓰기 거부 → ADR-20260624 결정과 일치.
- **인덱스 폐기 정합**: `checkAdrConsistency`가 인덱스를 참조하지 않고, `knowledgeRecord`에 `decisions[]`가 없음 → amendment와 일치. 죽은 인덱스 경로 없음.
- **개념 표면 분산(문서화 시 혼동 지점)**: `ditto knowledge` 커맨드는 게이트+ADR 파일 관리만 노출하고, "CLAUDE.md 투영"과 "knowledge.json 레코드 쓰기"는 각각 `ditto bridge knowledge`와 knowledge-curator 에이전트가 담당한다. 즉 개념(축4 큐레이션)은 하나인데 집행 표면이 CLI·bridge·agent·Stop 훅 4곳에 흩어져 있다. 불일치는 아니지만 재설계 시 응집도 재고 대상.
- **미확인**: `knowledgeRecord`가 실제로 `.ditto/knowledge/knowledge.json`에 쓰이는 경로는 이 CLI에 없다(에이전트가 Write로 직접 쓴다 — `knowledge-curator.md:24`). 그 쓰기가 스키마 검증을 거치는지는 에이전트 런타임 밖이라 코드로 확인 불가(미검증).

## 7. 잠재 위험·부작용·재설계 시 고려점

- **게이트는 카운트만 본다, 내용은 안 본다.** `delta.decisions=1`이면 통과하지만 그 ADR이 실제로 근거·철회조건을 담았는지는 검사하지 않는다. 큐레이터가 빈 뼈대만 만들고 `decisions=1`로 선언해도 게이트는 PASS. 정합은 "선언 vs 카운트"이지 "카운트 vs 품질"이 아니다. 재설계 시 이 경계를 명확히 유지하거나, 품질 검사를 별도 게이트로 추가할지 결정해야 한다.
- **선언 신뢰(self-report) 의존.** triggers·delta 둘 다 큐레이터가 자기신고한 값이다. 게이트는 둘의 내부 정합만 보증하고, 신고가 실제 work item 사실과 맞는지는 보증하지 못한다. Stop 훅 재집행도 같은 carrier(같은 자기신고)를 읽으므로 이 한계는 두 집행 지점 모두 공유.
- **`fileExists` 체크와 `writeFile` 사이 TOCTOU.** `createAdrSkeleton`은 존재 검사 후 쓰기 사이에 원자성이 없다(`knowledge.ts:158-161`). 같은 slug·같은 날 동시 두 프로세스가 둘 다 "없음"을 보고 쓰면 하나가 덮인다. 단일 사용자 CLI 맥락에선 실질 위험 낮음. `atomicWriteText`(bridge가 쓰는)와 달리 여기선 평범한 `writeFile`.
- **UTC 날짜 vs 사용자 로컬 인식.** id의 날짜가 UTC라, 로컬 시간대에서 "오늘"과 파일명 날짜가 하루 어긋날 수 있다(자정 근처). 결정성을 위한 의도된 트레이드오프지만, 사용자가 파일명 날짜를 로컬 날짜로 오해할 여지.
- **투영 drift는 별도 명령이 잡는다.** CLAUDE.md 요약이 소스와 어긋나도 `knowledge` CLI는 모른다 — `ditto bridge knowledge --check`(또는 doctor 파이프라인)가 sha256 drift를 잡아야 한다. 재설계 시 이 두 표면(기록/투영)의 호출 순서 의존성을 문서화해야 한다.

재설계 시 보존해야 할 불변식:
1. ADR id = 불변 파일명, 랜덤 접미사 없음, 충돌은 표면화(재롤 금지) — ADR-20260624 본체.
2. `adr/*.md`가 결정 SoT, 손-인덱스 재도입 금지 — 헌장 §4-11.
3. 게이트는 "record something"이 아니라 "선언 계기 ↔ 실제 기록 정합" — ADR-0010(b). 계기 0+기록 0은 유효한 PASS.
4. knowledge 투영은 `ditto:knowledge:*` 마커, `ditto:managed` 블록 불침범(2개 이상 refuse).

재고 가능한 결정:
- 게이트 입력을 자기신고 대신 실제 기록물(파일 diff)에서 파생할 수 있는지.
- 집행 표면 4곳(CLI·bridge·agent·Stop)의 응집도.
