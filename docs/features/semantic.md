# semantic — 내보낸 시그니처 변경을 관찰하고 "타입 안전 ≠ 의미 안전" 판정으로 게이트하는 SemanticCompatibility producer

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준 커밋: `c2d2e16` (2026-07-19).

## 1. 이 기능이 실현하려는 설계 의도 (개념)

`ditto semantic`은 ACG(Agentic Change Governance) 파이프라인의 **단계6 = SemanticCompatibility**를 생산하는 커맨드다. 존재 이유는 하나의 구분이다:

- **타입 안전(type_safe)과 의미 안전(semantic_safe)은 다른 판정이다.** 시그니처가 타입상 호환돼도 도메인 의미는 깨질 수 있다. 대표 예시가 `User | null → User`: 타입은 더 좁아져 컴파일은 통과하지만, "없을 수 있다"는 원래 의미가 사라진 파손이다 (`src/hooks/stop.ts:369-371`, `src/schemas/acg-semantic-compatibility.ts:5-9`).

이 구분을 코드로 강제하기 위해 기능을 **정적층(static)과 의미층(resolver)으로 쪼갠다** (`src/acg/semantic/semantic-produce.ts:10-19`):

- **정적층**: 시그니처 쌍(before/after)이라는 *사실*만 결정론적으로 추출한다. 도메인 의미는 판단하지 않고 `unverified`(미검증)로 남긴다.
- **의미층(resolver)**: 에이전트/사람이 의미 판정을 내려 주입한다. **ditto는 LLM을 직접 호출하지 않으므로**(ADR-0001) 판정은 CLI 인자로 외부에서 들어온다 (`src/cli/commands/semantic.ts:38-42`).

DITTO 4축 관점에서는 **거버넌스(governance)** 축에 속한다. 완료 게이트(단계6)의 입력을 생산하며, 게이트 자체는 `stop` 훅이 소비한다(§3). "완료는 증거로만"이라는 기조를 시그니처-의미 차원에서 구현한 것이다.

## 2. 코드 위치와 진입점

| 경로 | 역할 |
|---|---|
| `src/cli/commands/semantic.ts` | 진입점. 4개 서브커맨드 정의(scan/observe/detect/verdict) + I/O·검증 |
| `src/acg/semantic/semantic-produce.ts` | producer 코어. `buildSemanticSeed`(정적층) + `applySemanticVerdict`(의미층) |
| `src/acg/semantic/signature-codeql.ts` | CodeQL로 내보낸 시그니처 추출·diff (ADR-0006 "사실 추출") |
| `src/acg/semantic/scan-observation.ts` | 비게이트 관측용 순수 헬퍼(base 후보, fingerprint, 관측 빌드) |
| `src/schemas/acg-semantic-compatibility.ts` | 게이트되는 blocking 아티팩트 스키마(SoT, ADR-0002) |
| `src/schemas/acg-semantic-scan-observation.ts` | 비게이트 관측 아티팩트 스키마 |
| `src/hooks/stop.ts:379` | 소비 게이트 `semanticForcesContinuation` — 계속 진행을 강제하는 사유 산출 |
| `src/hooks/semantic-nudge.ts` | Stop-time 비차단 넛지(무거운 스캔 대신 값싼 안내) |

### 서브커맨드

| 서브커맨드 | 층 | 자동/수동 | 하는 일 | 산출 파일 |
|---|---|---|---|---|
| `scan` | 정적 | 자동 | base ref 대비 내보낸 시그니처 변경을 CodeQL로 탐지 → **blocking** seed | `semantic-compatibility.json` |
| `observe` | 정적 | 자동 | 같은 탐지를 하되 **비게이트** 관측만 기록(게이트 안 걸림) | `semantic-scan-observation.json` |
| `detect` | 정적 | 수동 | 명시한 시그니처 쌍을 **blocking** seed로 등록(scan이 못 잡을 때 탈출구) | `semantic-compatibility.json` |
| `verdict` | 의미 | 수동 | seed에 의미 판정(yes/no/unverified)을 주입해 데드락 해소 | `semantic-compatibility.json` |

주요 인자(전 서브커맨드 공통: `--work-item` 필수, `--output human|json`):

- `scan`: `--base`(필수), `--language`(기본 javascript), `--source-root`(기본 src)
- `observe`: `--base`(생략 시 fallback), `--language`, `--source-root`
- `detect`: `--file --symbol --before --after`(모두 필수)
- `verdict`: `--semantic-safe`(필수), `--before/--after`(쌍 2개 이상일 때 대상 선택), `--old-meaning`, `--intended-breaking`, `--compatibility`, `--model-version`, `--characterization-test`, `--characterization-adequacy`, `--type-safe`

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

두 개의 아티팩트가 서로 다른 경로에 쓰이고, 그중 하나만 게이트된다.

```
[변경된 워킹트리]
     │
     ├── scan ──(CodeQL diff)──▶ buildSemanticSeed ──▶ semantic-compatibility.json  ◀── (blocking)
     ├── detect ─(명시 쌍)──────▶ buildSemanticSeed ──▶ semantic-compatibility.json  ◀── (blocking)
     │                                                          │
     │                            verdict ─(의미 판정)─▶ applySemanticVerdict ─┘ (같은 파일 갱신)
     │                                                          │
     └── observe ─(CodeQL diff)─▶ buildScanObservation ─▶ semantic-scan-observation.json (NON-gated)
                                                                │
                                                                ▼
                                     stop 훅: readArtifact(semantic-compatibility.json)
                                                  → semanticForcesContinuation()
                                                  → reasons[] (비면 통과, 있으면 계속 강제)
```

- 두 상태 파일 모두 work item 디렉터리에 저장: `localDir(repoRoot, 'work-items', <wi>, 'semantic-compatibility.json' | 'semantic-scan-observation.json')` (`src/cli/commands/semantic.ts:44-50`). `localDir`은 개인 tier(`.ditto/local/...`, gitignored)로 추정 — 파일명은 확인, 실제 절대 경로 prefix는 미확인.
- **게이트 소비는 오직 `semantic-compatibility.json`.** stop 훅이 이 파일만 읽고(`src/hooks/stop.ts:781-785`), 관측 파일은 게이트가 절대 읽지 않는다(`src/schemas/acg-semantic-scan-observation.ts:10-14`).
- 스키마가 계약의 SoT(ADR-0002). 쓰기 시 `writeJsonFile(path, acgSemanticCompatibility, artifact)`로 재검증하므로, 근거 없는 판정은 **쓰기 시점에 fail-closed**된다(`src/cli/commands/semantic.ts:225` 및 주석 226-227).

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

### (1) 정적/의미 분리 + seed는 기본적으로 차단

seed는 의미를 모른 채 만들어지므로 **보수적 기본값**을 박는다: `old_meaning = __unverified__` 센티넬, `compatibility = 'breaking'`, `semantic_safe = 'unverified'` (`src/acg/semantic/semantic-produce.ts:34-47`). 그 결과 seed가 존재하기만 해도 게이트가 계속 진행을 강제한다 — "시그니처 변경이 조용히 통과할 수 없다"는 불변식이다(fail-closed).

### (2) blocking(scan/detect) vs non-gated(observe) 분리

autowiring dialectic(reviews/dialectic-1, OBJ-3)이 **자동 스캔은 blocking 아티팩트를 쓰면 안 된다**고 결정했다. 자동 스캔이 나타나는 즉시 게이트가 걸리면, 사용자가 미처 판단하기 전에 진행이 막히기 때문. 그래서 `observe`는 비게이트 관측만 기록하고, blocking 승격은 명시적 행위(`detect`/`verdict`)로만 한다 (`src/schemas/acg-semantic-scan-observation.ts:10-15`).

### (3) 관계 추출은 CodeQL "사실 추출"로 (ADR-0006)

1차 구현은 TS 컴파일러 API에 직접 결합돼 있었고, 비-TS 저장소에서 **빈 결과를 "깨끗함"으로 오판**했다. ADR-0006이 이를 CodeQL 단일 엔진으로 통일하기로 결정했다:

- D1: 구조·관계·데이터흐름 추출을 CodeQL로 통일.
- D3: alert(SARIF)이 아니라 custom `.ql`로 시그니처를 `select`하는 "사실 추출" 경로.
- 기각된 대안: LLM 구조 추론(규모 비례 부정확), 언어별 네이티브 분석기 유지(N배 유지비/leak), TS fast-path 2-tier(동등성 영구 보증 부담).
- 변경 조건(ADR을 다시 열 때): CodeQL이 관계를 실용 비용으로 못 뽑거나, DB 빌드 비용이 캐시로도 게이트 UX를 해치면.

`signature-codeql.ts`는 이 결정의 구현이다: 언어별 쿼리 바인딩 + **미바인딩 언어는 loud하게 실패**(`signatureQuery`, `src/acg/semantic/signature-codeql.ts:151-160`) — 조용한 빈 결과 재발 방지.

### (4) agent yes는 이중 기계-증거 의무 (스키마 강제)

`produced_by='agent'`이면서 `semantic_safe='yes'`인 판정은 두 증거를 반드시 동반해야 한다(`superRefine`, `src/schemas/acg-semantic-compatibility.ts:72-114`):

1. `reproducibility.model_version` — 판정을 내린 judge 모델을 고정(LLM 판정 재현성, dialectic-1 O5).
2. `characterization` — 의미가 보존됨을 *증언*하는 통과하는 behavior 테스트. 단순 존재가 아니라 **adequacy가 `l1_met`(변경 영역을 실행) 또는 `l2_passed`(old↔new 차분 통과)** 여야 한다(OBJ-11). 단순 ref만으로는 불충분.

반면 `produced_by='user'`의 yes는 인간 증언으로 간주해 둘 다 면제(`intended_breaking` 인간 override와 동형).

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

### `buildSemanticSeed` / `buildSeedChange` (semantic-produce.ts:34-58)

입력: 시그니처 쌍 배열. 하는 일: 각 쌍을 보수적 미검증 change로 변환. 효과: seed가 쓰이면 그 자체로 게이트가 걸린다. 다중 쌍(G4)을 배열로 담아 **모든 파손 쌍이 게이트에 도달**하도록 한다(첫 쌍만이 아니라).

### `applySemanticVerdict` / `selectChangeIndex` (semantic-produce.ts:88-141)

입력: seed + 판정. 하는 일: 대상 쌍 하나에만 판정을 주입(나머지는 불변). `selectChangeIndex`는 쌍이 2개 이상인데 `target`이 없거나 매칭 안 되면 **throw** — 판정이 엉뚱한 쌍에 조용히 착지하는 것을 차단(`src/acg/semantic/semantic-produce.ts:90-101`). 효과: 한 쌍을 resolve해도 미해결 쌍은 계속 차단(G4).
반환은 후보일 뿐 검증하지 않는다. 검증은 caller의 `writeJsonFile`이 스키마로 수행 → 근거 없는 yes/센티넬 잔존은 쓰기에서 fail-closed(주석 104-108).

### `scanSignatureChanges` (signature-codeql.ts:260-310)

입력: repoRoot, baseRef, language, sourceRoot. 하는 일:

- base sha로 CodeQL DB를 **캐시**하고, 없을 때만 detached worktree를 체크아웃해 빌드(`needWorktree`, `:270-289`). after DB는 워킹트리에서 **매번 새로** 빌드해 미커밋 변경을 반영하고 곧바로 폐기(`:291-309`).
- 두 맵을 `diffSignatureMaps`로 비교. 추가/삭제된 export는 시그니처-형태 변경이 아니므로 제외(양쪽 맵에 다 있고 텍스트가 다른 것만, `:195-207`).

숨은 결정: 시그니처 키는 `file::symbol`(`rowsToSignatureMap`, `:177-189`) — 다른 파일의 동명 export를 구별. 단, 같은 파일 내 오버로드는 마지막만 남는 best-effort 갭(주석 `:83-85`).

언어별 쿼리 특성:
- JS/TS: `name(paramTypes): ret` 재구성, 타입 annotation 없으면 `?` (`:41-71`).
- Java/Kotlin: public 타입의 public 메서드 시그니처. Kotlin은 java 추출기 재사용(`:138-144`).
- Python: 동적 타입이라 **파라미터 이름의 순서**(arity+names)만 추출 — 타입 annotation은 caller를 안 깨므로 제외(false negative 회피, `:107-135`).

### `semanticForcesContinuation` (stop.ts:379-391)

입력: 파싱된 아티팩트. 하는 일: 각 change 순회하며

- `unverified` → 사유 1건("검증하거나 의도된 변경으로 선언하라").
- `no` ∧ `intended_breaking !== true` → 사유 1건(의도치 않은 파손, old_meaning 표시).
- `yes`, 또는 `no`∧`intended_breaking` → 사유 없음(통과).

효과: default-deny. 선언된 의도적 파손과 검증된 안전 변경만 게이트를 통과한다.

### `semanticScanNudge` (semantic-nudge.ts:47-64)

무거운 CodeQL 스캔을 stop 훅에서 돌리지 않기 위한 값싼 안내(git diff + 파일 읽기만). 소스 변경이 있는데 fresh 관측이 없으면 `observe` 실행을 권하고, 관측에 변경이 있는데 아직 blocking으로 승격 안 됐으면 `detect`/`verdict`를 권한다. 비차단(exit 0 불변).

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위: `semantic.ts`, `semantic-produce.ts`, `signature-codeql.ts`, 두 스키마, `stop.ts`의 소비부, `semantic-nudge.ts`, CLI 테스트 케이스 목록.

- **정적/의미 분리, seed=차단, agent yes 이중 증거, 다중 쌍(G4)**: 코드와 스키마가 일관되게 강제. `tests/cli/semantic-cli.test.ts`가 각각을 케이스로 검증한다(예: `yes WITHOUT model-version fail-closes`, `yes WITH model-version but WITHOUT characterization fail-closes`, 다중 쌍 타겟 resolve/미지정 fail-close) — 의도대로 동작함이 테스트로 뒷받침됨.
- **blocking vs non-gated 분리**: `stop.ts:781-785`가 오직 `semantic-compatibility.json`만 읽고 관측 파일은 안 읽음 — 의도와 일치.
- **미바인딩 언어 loud 실패**: `signatureQuery`가 throw — ADR-0006 D2의 "빈 결과=거짓 깨끗함" 방지와 일치.
- **CodeQL 실제 실행 검증은 이 문서 범위에서 미검증**: `scanSignatureChanges`가 실제 CodeQL을 돌려 정확한 diff를 내는지는 `tests/acg/signature-codeql-e2e.test.ts`가 다룰 것으로 보이나(제목 기준, 내용 미확인) 본 조사에서 실행하지 않음 — **미검증**.

확인 범위에서 설계-동작 불일치는 발견하지 못함.

## 7. 잠재 위험·부작용·재설계 시 고려점

- **오버로드/동명 심볼 충돌**: `file::name` 키라 같은 파일 내 오버로드는 마지막만 남는다(`signature-codeql.ts:83-85`, 177-189). 오버로드 시그니처 변경이 조용히 누락될 수 있음 — 재설계 시 파라미터 형태까지 키에 포함할지 재고 가능.
- **scan 재실행 clobber 방지**: `scan`은 아티팩트가 이미 있으면 fail-close(`semantic.ts:314-320`). 부분 resolve 후 재스캔이 verdict를 덮어쓰는 것을 막는 의도적 가드지만, 워크플로 상 "먼저 지우거나 resolve하라"는 수동 개입을 요구한다. `detect`는 append, `scan`은 fresh-seed 전용이라는 비대칭을 유지해야 함(불변식).
- **CodeQL 비용/의존**: after DB를 매 스캔 새로 빌드(캐시 미스 시 초~분 단위, ADR-0006 비용절). `observe`의 fingerprint 스킵(`scan-observation.ts:26-28`)은 이 비용을 줄이지만 `scan`에는 그 스킵이 없다 — 재설계 시 scan에도 fingerprint 재사용을 넣을지 고려 가능(현재는 미적용).
- **DB build 없는 컴파일 언어의 false-clean**: Java는 `build-mode=none` 강제(`semantic.ts:284`, 413). 외부 의존 호출이 unresolved될 수 있음(ADR-0006 검증 §의 한계). 시그니처 추출은 소스 심볼만 보므로 영향은 제한적이나, 재설계 시 완전성은 실제 바인딩 autobuild에서만 보장됨을 유지해야 함.
- **정합성(동시성)**: 두 아티팩트 모두 work item 디렉터리의 단일 파일. 동일 work item에 대한 동시 scan/verdict 경합은 파일 단위 마지막-쓰기-승리 — 별도 락은 확인되지 않음(미확인). 개인 tier(gitignored로 추정)라 커밋 정합성 위험은 낮으나, 동시 세션에서의 경합은 재설계 시 점검 대상.
- **보존해야 할 핵심 불변식**: (a) seed 존재만으로 차단(fail-closed), (b) agent yes의 이중 기계-증거, (c) 다중 쌍 전수 게이트 도달(G4), (d) 자동 스캔은 non-gated(observe), 승격은 명시적, (e) 미바인딩 언어 loud 실패.
