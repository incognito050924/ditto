# init — 대상 프로젝트에 `.ditto/` 워크스페이스 골격을 멱등하게 scaffold하는 커맨드

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준: git main `c2d2e16`, 작성일 2026-07-19.

## 1. 이 기능이 실현하려는 설계 의도 (개념)

`ditto init`은 임의의 사용자 프로젝트 안에 DITTO가 상태를 저장할 `.ditto/` 디렉터리 구조를 처음 만들어 주는 부트스트랩 커맨드다. DITTO의 다른 모든 기능(work item, autopilot, knowledge, memory 등)은 `.ditto/` 아래의 파일 store에 상태를 읽고 쓴다. init이 하는 일은 그 store들이 안착할 **뼈대(skeleton)를 미리 깔고**, 어떤 부분이 팀과 공유되고 어떤 부분이 개발자 개인 것인지를 **디렉터리 배치와 `.gitignore`로 못박는** 것이다.

핵심 개념은 ADR-0012의 **3계층 격리**다:
- 제품 표면(배포되는 플러그인) — init 범위 밖.
- 프로젝트 전역 거버넌스(git 공유) — `.ditto/knowledge/`, `.ditto/agents/`.
- 개인 런타임 트레일(개발자별, gitignored) — `.ditto/local/` 아래 전부.

DITTO 4축(의도/오케스트레이션/E2E/지식) 중 특정 기능 축이 아니라, 그 축들이 동작하기 위한 **하부 골격·배포/격리 계약**에 속한다. "무엇을 어디에 두고 무엇을 공유하는가"라는 정합성·격리 문제를 푸는 인프라 커맨드다(init-scaffold.ts:37-51, ditto-paths.ts:3-13).

## 2. 코드 위치와 진입점

| 파일 | 역할 |
|------|------|
| `src/cli/commands/init.ts` | CLI 진입점. 인자 파싱, repoRoot 해석, 결과 출력(human/json). |
| `src/core/init-scaffold.ts` | 실제 scaffold 로직 `initScaffold()`. 디렉터리 생성·시드 파일 작성·멱등 판정. |
| `src/core/ditto-paths.ts` | 3계층 경로 헬퍼(`dittoDir`, `localDir`, `committedWorkItemDir`). init이 직접 import하진 않으나 같은 격리 규약을 공유. |
| `src/core/fs.ts` | `resolveRepoRootForCreate`, `ensureDir`, `atomicWriteText`, `writeJson` 등 파일 I/O 원자. |
| `src/schemas/glossary.ts` | 시드하는 `glossary.json`의 zod 스키마(SoT, ADR-0002). |

서브커맨드는 없다. CLI 인자(init.ts:12-19):

| 인자 | 타입 | 기본값 | 의미 |
|------|------|--------|------|
| `dir` | string | (없음) | scaffold 대상 디렉터리. 없으면 가장 가까운 `.ditto`/`.git` 루트 또는 cwd. |
| `output` | string | `human` | 출력 형식. `human` 또는 `json`. |

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

```
CLI args(dir, output)
  → repoRoot 결정
       dir 주어짐 → resolve(dir)
       없음        → resolveRepoRootForCreate()  (fs.ts:86, .ditto/.git 상향 탐색, 없으면 cwd)
  → initScaffold(repoRoot, now)              (init-scaffold.ts:98)
       ├ alreadyInitialized = fileExists(.ditto/knowledge/glossary.json)  ← 정본 마커
       ├ ensureDir: .ditto + SCAFFOLD_DIRS 9개                            (없던 것만 createdDirs)
       └ seedFileIfAbsent × 3:
            .ditto/knowledge/glossary.json   (glossary 스키마 검증 후 writeJson)
            .ditto/knowledge/CONTEXT.md      (atomicWriteText, 빈 컨텍스트)
            .ditto/.gitignore                (atomicWriteText, DITTO_GITIGNORE)
  → InitScaffoldResult { repoRoot, createdDirs, createdFiles, skippedFiles, alreadyInitialized }
  → 출력: json이면 그대로 writeJson; human이면 요약 + '+ 생성 / = 유지' 목록
```

생성되는 디렉터리(SCAFFOLD_DIRS, init-scaffold.ts:25-35), 전부 repoRoot 기준 상대경로로 보고됨:
- 개인 tier: `local/work-items`, `local/runs`, `local/handoff`, `local/sessions`, `local/logs`, `local/cache`
- 전역 tier: `agents`, `knowledge`, `knowledge/adr`

시드 파일 3개:
- `knowledge/glossary.json` — `schema_version: '0.1.0'`, `project_name`(=repoRoot basename), `updated_at`(now.toISOString()), `entries: []`. glossary 스키마로 검증(init-scaffold.ts:118-123).
- `knowledge/CONTEXT.md` — 빈 컨텍스트 시드 문구(init-scaffold.ts:53-63).
- `.ditto/.gitignore` — `local/` ignore + `knowledge/`·`agents/` un-ignore(init-scaffold.ts:44-51).

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

### 멱등성 (idempotent)
init은 여러 번 실행해도 기존 파일을 덮어쓰지 않는다. `seedFileIfAbsent`가 파일이 있으면 `skippedFiles`에 넣고 write를 건너뛴다(init-scaffold.ts:81-89). 디렉터리도 `ensureDirTracked`가 존재 여부를 먼저 확인해 이미 있던 것은 `createdDirs`에 넣지 않는다(init-scaffold.ts:65-73). meta.description에도 "idempotent" 명시(init.ts:10).

`alreadyInitialized`의 정본 마커는 `knowledge/glossary.json`의 존재다(init-scaffold.ts:104-105). glossary가 있으면 "이미 초기화됨"으로 본다.

### 3계층 격리를 디렉터리·gitignore로 집행 (ADR-0012)
ADR-0012 D2: `.ditto/.gitignore`가 3계층 경계를 집행한다. init이 시드하는 gitignore는 `local/` 한 줄만 ignore하고 `knowledge/`·`agents/`는 추적한다. 결과적으로 개인 트레일은 커밋되지 않고(개발자·머신별), 거버넌스는 팀과 git으로 공유된다(init-scaffold.ts:44-51, ADR-0012:28-31). scaffold가 개인 tier를 전부 `local/` 아래로 모으는 것도 같은 결정(ADR-0012 D1, init-scaffold.ts:25-35).

주석에 명시된 의도적 경계(init-scaffold.ts:41-42): 이 gitignore는 `.ditto/` 안에 스코프되어 있어 **대상 프로젝트의 루트 `.gitignore`는 절대 건드리지 않는다.**

### per-entity 파일 저장 (ADR-0005)
DITTO는 런타임 산출물을 공유 DB가 아니라 per-entity JSON 파일로 저장한다(ADR-0005 D1). init은 그 파일들이 안착할 디렉터리 골격만 미리 깔고, 각 store가 자기 경로를 lazily `ensureDir`하도록 남겨둔다 — SCAFFOLD_DIRS는 "모든 leaf가 아니라 뼈대만" 덮으면 된다는 주석이 이를 명시(init-scaffold.ts:19-24).

### 스키마가 SoT (ADR-0002)
시드하는 `glossary.json`은 손으로 만든 리터럴이 아니라 `writeJson(path, glossary, {...})`로 zod 스키마 검증을 통과한 값만 쓴다(init-scaffold.ts:118-123, fs.ts:161-170). 스키마와 어긋난 시드는 write 전에 `SchemaValidationError`로 실패한다.

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

### `initCommand.run` (init.ts:20-45)
- repoRoot 해석: `args.dir ? resolve(args.dir) : await resolveRepoRootForCreate()`(init.ts:23). dir을 주면 그 경로를 절대화, 안 주면 상향 탐색.
- `initScaffold(repoRoot, new Date())` 호출 — `now`를 주입해 시드 타임스탬프를 결정론적으로 만들 수 있게 함(테스트 용이, init.ts:24).
- 출력 분기: json이면 result 객체 통째로 stdout(init.ts:26-29). human이면 초기화 여부 한 줄 + `dirs/files` 요약 + 생성 파일은 `+`, 유지 파일은 `= ... (kept)`로 나열(init.ts:31-40).
- 실패 시 `writeError` 후 `process.exit(RUNTIME_ERROR_EXIT)`(init.ts:41-44).

### `resolveRepoRootForCreate` (fs.ts:86-95)
`findRepoRoot`(`.ditto` → `.git` 상향 탐색, `$HOME`에서 상향 캡)를 시도하고, 아무 마커도 못 찾으면 throw 대신 `resolve(start)`(cwd)로 fallback한다. 효과: 완전히 새 디렉터리에서도 init이 실패하지 않고 "여기에 새로 만든다"로 동작. 상향 탐색이 `$HOME` 위로 새어 홈 트리 전체를 루트로 잡는 것은 `isAtOrAboveHome` 캡이 막는다(fs.ts:48-50, 68-69; ADR-0011 session-rooting).

### `initScaffold` (init-scaffold.ts:98-147)
1. `alreadyInitialized` 먼저 판정(glossary 존재, init-scaffold.ts:104-105) — 디렉터리 생성보다 앞서 읽어야 "이번 실행이 처음인가"를 정확히 잡는다(순서 의존성).
2. `.ditto`와 SCAFFOLD_DIRS 9개를 `ensureDirTracked`로 생성. 없던 것만 `createdDirs`에 기록(init-scaffold.ts:107-110).
3. `projectName = basename(repoRoot) || 'project'`(init-scaffold.ts:112) — basename이 빈 문자열이면(루트 등) `'project'`로 fallback.
4. glossary.json, CONTEXT.md, .gitignore를 각각 `seedFileIfAbsent`로 시드. 있으면 skip.
5. 결과 객체 반환(init-scaffold.ts:146).

### `atomicWriteText` (fs.ts:105-122)
sibling 임시 파일에 쓰고 `rename`으로 교체한다. 효과: crash가 나도 반쪽짜리 타깃 파일은 남지 않는다(fail-safe 쓰기). CONTEXT.md·.gitignore 시드와 glossary(writeJson 내부, fs.ts:168)가 이 경로를 탄다.

### 미묘한 결정
- 반환 경로는 전부 **repoRoot 상대경로**(`join('.ditto', ...)`)로 보고된다(init-scaffold.ts:9-10 주석). 머신마다 다른 절대경로가 출력에 새지 않게 하려는 의도.
- `surfaces.json`은 **일부러 시드하지 않는다**(init-scaffold.ts:93-97 주석): 그 카탈로그는 설치된 DITTO 플러그인 자신의 표면을 기술하며, self-host(repoRoot == 플러그인)에서만 의미가 있기 때문.

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위(위 5개 파일 + ADR-0012/0005)에서:

- 멱등성: `seedFileIfAbsent`/`ensureDirTracked`가 기존 파일·디렉터리를 보존 — 의도와 일치(init-scaffold.ts:65-89).
- 3계층 gitignore: `local/` ignore + `knowledge`/`agents` 추적은 ADR-0012 D2와 일치(init-scaffold.ts:44-51).
- 루트 `.gitignore` 불가침: 코드가 `.ditto/.gitignore`만 쓰고 루트를 건드리지 않음 — 주석 의도와 일치.

**불일치·갭 지점:**

1. **ADR-0012 D2의 루트 `.gitignore` 관리 부재 (미확인).** ADR-0012:31은 "레포 루트 `.gitignore`도 `.ditto/local/`만 ignore한다"고 하나, `initScaffold`는 루트 `.gitignore`를 만들거나 갱신하지 않는다(코드상 `.ditto/.gitignore`만 작성). 누가 루트 `.gitignore`를 관리하는지는 이 조사 범위 밖 — install 스크립트 등 별도 경로일 수 있으나 **미확인**. 재설계 시 "대상 프로젝트가 `.ditto/local/`을 루트에서 ignore하지 않으면 개인 트레일이 커밋될 수 있다"는 위험이 init 단독으로는 닫히지 않는다.

2. **committed work-item(Record) 디렉터리를 scaffold하지 않음.** ADR-20260706(ADR-0012 D1 부분 supersede)은 work item을 Record(`.ditto/work-items/<id>/`, 커밋·공유)와 Run(`.ditto/local/work-items/<id>/`, 개인)으로 쪼갰다(ditto-paths.ts:36-38, ADR-0012:22). SCAFFOLD_DIRS는 `local/work-items`만 만들고 committed `.ditto/work-items/`는 만들지 않는다(init-scaffold.ts:26). 기능상 문제는 아닐 가능성이 높다 — store가 쓸 때 lazily `ensureDir`하고, gitignore가 `local/`만 ignore하므로 committed work-items는 추적 대상이다. 다만 "뼈대를 self-documenting하게 미리 깐다"는 주석 의도(init-scaffold.ts:19-24)와 비교하면 Record tier 디렉터리는 뼈대에서 빠져 있다(비대칭). **동작 결함은 미확인**(store의 lazy ensureDir로 커버된다는 것은 추론).

3. **`alreadyInitialized`와 부분 초기화의 불일치 (사소).** 마커가 glossary.json 하나뿐이라, glossary는 있고 CONTEXT.md는 지워진 상태로 재실행하면 `alreadyInitialized=true`를 보고하면서도 CONTEXT.md를 새로 생성한다(init-scaffold.ts:104-105 vs 128-135). "이미 초기화됨"과 "파일 생성함"이 한 실행에 공존 — 출력이 살짝 모순으로 읽힐 수 있으나 멱등성 자체는 깨지지 않음.

## 7. 잠재 위험·부작용·재설계 시 고려점

- **gitignore의 redundant 라인 (관찰).** DITTO_GITIGNORE는 `local/`만 ignore하는데 `!knowledge/`·`!agents/` un-ignore 라인을 둔다(init-scaffold.ts:49-50). 아무것도 그것들을 ignore하지 않으므로 이 negation은 현재 no-op(방어적/문서적). 재설계로 ignore 규칙을 넓히면 이 라인들이 의미를 갖게 되지만, 현 상태에선 오해를 부를 수 있다.
- **멱등 마커 단일점.** 초기화 판정이 glossary.json 하나에 걸려 있어(init-scaffold.ts:104-105), 그 파일만 있고 나머지가 손상된 "부분 초기화" 상태를 init이 감지·복구하지 못한다(6-3 참조). 재설계 시 마커를 "필수 시드 파일 전부 존재"로 강화하는 것을 고려할 수 있다.
- **루트 `.gitignore` 격리 갭(6-1).** init 단독으로는 개인 트레일 커밋 위험을 완전히 닫지 못한다. 재설계 시 init이 루트 `.gitignore`에 `.ditto/local/`을 (멱등하게, 루트 파일 불가침 원칙과 절충하며) 보강할지 결정 필요.
- **반드시 보존할 불변식:**
  - `.ditto/.gitignore`의 `local/` ignore(개인/공유 경계 집행, ADR-0012 D2).
  - 기존 파일 non-clobber(멱등, `seedFileIfAbsent`).
  - 시드 값의 스키마 검증(ADR-0002, glossary는 writeJson 경유).
  - 반환 경로의 repoRoot-상대성(머신 독립 출력).
  - `atomicWriteText`의 원자 쓰기(부분 파일 방지).
- **재고 가능한 결정:** SCAFFOLD_DIRS 목록(어느 디렉터리를 미리 깔지)은 순수 편의이며 store의 lazy ensureDir이 실제 안전망이므로, 목록 자체는 재설계 시 자유롭게 조정 가능(단 gitignore 경계와 정합 유지).
