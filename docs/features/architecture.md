# architecture — ACG ArchitectureSpec의 관측 제안·사람 비준·형제모듈 선언 도구

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준 커밋: `c2d2e16`, 날짜: 2026-07-19.

## 1. 이 기능이 실현하려는 설계 의도 (개념)

`ditto architecture`는 ACG(Agentic Change Governance, 에이전트 변경 거버넌스)의 **ArchitectureSpec** 카탈로그 아티팩트를 만들고 손보는 CLI다. ArchitectureSpec은 Clean Architecture의 의존성 규칙(Dependency Rule)을 저장소당 1회 선언해 **기계로 검사 가능한 형태**로 고정한 것이다(`src/schemas/acg-architecture-spec.ts:4-8`).

이 커맨드가 존재하는 이유는 두 종류의 사실을 분리해서 다루기 위해서다.

- **관측된 현실**(현재 코드의 layer 구조, 실제로 층 경계를 넘는 import 대상)은 에이전트가 자동으로 뽑을 수 있다.
- **의도된 규칙**(어떤 층이 무엇을 부를 수 있는가, 무엇이 금지된 의존인가)은 사람만 선언할 수 있다.

핵심 설계 결정은 이 둘을 절대 섞지 않는 것이다. 현재 코드를 그대로 규칙으로 박제하면, 이미 존재하는 위반을 "정상"으로 동결하거나 우연한 부재를 강제 규칙으로 만든다(ADR-0004, `.ditto/knowledge/adr/ADR-0004-q3-q4-architecture-fitness.md:18`). 그래서 `propose`는 관측만 하고 비권위(non-authoritative) candidate를 내며, `ratify`가 사람의 명시적 행위로 그것을 권위 스펙으로 승급시킨다. 규칙(`forbidden_dependencies`)은 오직 `ratify --forbid`에서만 채워진다.

DITTO 4축 분류상 이 기능은 **거버넌스 계층**(ACG)에 속한다. 4축(의도/오케스트레이션/E2E/지식) 어디에도 직접 들지 않고, 그 위에서 "변경이 선언된 경계를 넘지 않는가"를 집행하는 스펙 계층의 생산 도구다. 산출물(ArchitectureSpec)은 boundary 게이트·PreToolUse 훅·fitness가 소비한다(§3).

## 2. 코드 위치와 진입점

| 경로 | 역할 |
| --- | --- |
| `src/cli/commands/architecture.ts` | CLI 진입. `propose`/`ratify`/`internal-packages` 3개 서브커맨드 정의·인자 파싱·출력 |
| `src/acg/architecture/propose.ts` | 관측 코어. import 그래프에서 layer·public_surface를 관측하고 candidate 스펙을 조립(순수 `buildCandidateSpec` + impure `observeArchitecture`) |
| `src/acg/architecture/ratify.ts` | 비준 코어. candidate(agent) → 권위 스펙(user) 승급, `forbidden_dependencies` 주입(순수 `ratifyCandidateSpec`) |
| `src/acg/internal-packages.ts` | 형제모듈(JAR) cross_repo 선언·JVM 가드 코어(`withInternalPackages`, `evaluateInternalPackages`, `scanLocalJars` 등) |
| `src/schemas/acg-architecture-spec.ts` | ArchitectureSpec zod 스키마 (SoT, ADR-0002) |
| `src/schemas/acg-common.ts` | 카탈로그 envelope(`acgCatalogEnvelope`), `produced_by` enum |

소비처(이 커맨드가 쓰는 스펙을 읽는 쪽): `src/acg/boundary/boundary.ts`(경계 게이트), `src/hooks/pre-tool-use.ts`(forbidden_scope 집행), `src/acg/scope/resolve.ts`(layer/public_surface 해소), `src/cli/commands/boundary.ts`·`impact.ts`·`review.ts`·`refactor.ts`.

### 서브커맨드·인자

**`architecture propose`** — 관측 candidate 제안 (`architecture.ts:68-119`)

| 인자 | 기본값 | 뜻 |
| --- | --- | --- |
| `--source-root` | `<repo>/src` | 분석 소스 루트 |
| `--output` | `json` | 출력 형식 `human`\|`json` |
| `--write` | `false` | `.ditto/architecture-spec.json`에도 저장 (layer/surface 집행 입력) |

**`architecture ratify`** — candidate → 권위 스펙 승급 (`architecture.ts:120-197`)

| 인자 | 기본값 | 뜻 |
| --- | --- | --- |
| `--spec` | `.ditto/architecture-spec.json` | candidate 스펙 경로 |
| `--forbid` | (없음) | 금지 의존 `"from,to,reason"` (반복 가능). 규칙은 사람 몫 — 관측에서 자동 도출 안 함 |
| `--output` | `human` | 출력 형식 |

**`architecture internal-packages`** — 형제모듈 descriptor 선언 (`architecture.ts:198-277`)

| 인자 | 기본값 | 뜻 |
| --- | --- | --- |
| `--glob` | (없음) | 패키지명 glob(쉼표 구분), 예 `"kr.co.ecoletree.boxwood.domain.**"` — cross_repo 분류용 |
| `--path` | (없음) | 로컬 형제 아티팩트 glob(쉼표 구분), 예 `"libs/*.jar"` — JVM 가드 커버리지 |
| `--spec` | `.ditto/architecture-spec.json` | 스펙 경로 |
| `--output` | `human` | 출력 형식 |

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

세 서브커맨드는 하나의 상태 파일 `.ditto/architecture-spec.json`(스키마: `acgArchitectureSpec`)을 중심으로 돈다.

### propose — 관측 → candidate

```
소스 파일 walk(sourceRoot)          observeArchitecture (propose.ts:76)
      │  .ts/.tsx 파일, test 제외
      ▼
CodeqlEdgeAnalyzer.edges()          층 경계 넘는 import edge 추출
      │
      ▼
layers = top-level src dir 집합      publicSurfaces = 층 넘는 to 대상
      ▼
buildCandidateSpec (propose.ts:41)   produced_by=agent, forbidden=[], can_call=[]
      ▼
stdout(json|human)  [+ --write 시 .ditto/architecture-spec.json]
```

입력은 파일시스템(소스 트리) + CodeQL 기반 edge 분석기이고, 산출은 비권위 candidate JSON이다. `--write` 없이는 stdout에만 나가 **권위 스펙을 덮지 않는다**(`architecture.ts:60`, `propose.ts:12`).

### ratify — candidate → 권위 스펙

```
읽기: .ditto/architecture-spec.json (candidate, produced_by=agent)
  +   --forbid "from,to,reason" (사람이 선언한 규칙)
      ▼
ratifyCandidateSpec (ratify.ts:31)   produced_by=user, forbidden_dependencies=forbidden
      │  layers/public_surfaces는 그대로 통과, can_call 자동도출 안 함
      ▼
쓰기: 같은 경로에 권위 스펙 덮어쓰기 (architecture.ts:180)
```

읽은 스펙이 이미 `produced_by=user`면 거부한다 — 사람이 소유한 스펙을 조용히 덮지 않기 위해서다(`ratify.ts:35-37`).

### internal-packages — 형제모듈 descriptor 병합

```
--glob → {type:'glob', value}   --path → {type:'path', value}   (architecture.ts:230-239)
      ▼
기존 스펙 optional 로드 → withInternalPackages (internal-packages.ts:87)
      │  기존 있으면 나머지 필드 보존 + internal_packages만 교체
      │  없으면 produced_by=user 최소 스펙 생성
      ▼
쓰기: .ditto/architecture-spec.json
```

여기 선언된 `internal_packages`는 나중에 JVM(java/kotlin) CodeQL 분석 시 `evaluateInternalPackages`가 소비해, 로컬 JAR이 있는데 선언에 누락이 있으면 impact/boundary를 **차단**한다(`internal-packages.ts:45-80`).

### 소비 (이 커맨드 밖, 산출물의 목적)

- `boundary.ts:checkEdge`가 변경이 만든 의존 edge를 `forbidden_dependencies`·layer `can_call`과 대조해 위반을 낸다(`boundary.ts:72-101`).
- `pre-tool-use.ts`가 ChangeContract의 `forbidden_scope`를 집행할 때, `layer`/`public_surface` 종류의 scopeRef를 스펙의 `layers`·`public_surfaces`로 해소해 편집 대상 파일이 금지 범위에 드는지 판정한다(`resolve.ts:30-34`, `pre-tool-use.ts:527-585`). 스펙이 없으면 layer/surface는 해소 불가 → 조용히 skip(fail-open, `resolve.ts:9-11`).

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

### 관측(candidate) vs 규칙(사람) 분리 — 하이브리드 부트스트랩

가장 load-bearing한 결정. ADR-0004 Q3는 ArchitectureSpec을 **`produced_by=user` 권위 기본**의 수동 카탈로그로 두되, 에이전트는 관측 가능한 `layers`/`public_surfaces`만 비권위 candidate로 제안하고 사람 비준 시 권위화한다고 정했다(ADR-0004:16-17).

기각된 대안 두 개(ADR-0004:51-52):
- **전자동 추출**: 현재 코드를 의도된 경계로 박제 → 위반 동결. 기각.
- **전수동만**: 암묵적 경계에서 빈 산출물·낙후 위험. 기각.

하이브리드가 양쪽을 막는다. 코드가 강제하는 불변식(`propose.ts:41-53`):
- `produced_by='agent'` 항상 (candidate, 권위 아님)
- `forbidden_dependencies=[]` 항상 — "자동 금지는 현재 코드를 의도된 경계로 화석화한다"(`propose.ts:16-18`)
- `layers`는 이름만, `can_call=[]` (관측 구조지 규칙 아님, `propose.ts:47`)

`ratify`도 같은 불변식을 반대편에서 지킨다: `forbidden_dependencies`는 오직 사람의 `--forbid`에서만, layer/public_surface는 그대로 통과, `can_call` 자동도출 안 함(`ratify.ts:11-16, 38-44`).

### 활성 선결조건 (agent 경로는 기본 비활성)

ADR-0004는 이 agent candidate 경로를 **deferred(목표상태)**로 두고, 활성 전 선결조건을 걸었다: layer 자동분류 정밀도 PoC, 그리고 "관측된 현실 vs 의도된 규칙"의 기계 판독 표현(ADR-0004:19-23). 즉 코드는 존재하나, 소비처인 boundary 게이트가 이를 신뢰하기 전에 분류 정확도 검증이 전제다(`propose.ts:20-22`).

### fitness·boundary·impact와의 관계 (ACG 스펙 계층)

ArchitectureSpec은 스펙 계층의 카탈로그이고, 세 소비처가 각기 다른 필드를 쓴다.
- **boundary**: `forbidden_dependencies` + layer `can_call` → 변경 edge 위반 검사(`boundary.ts:72-101`).
- **impact / cross_repo**: `internal_packages` → JVM 형제모듈 JAR이 ImpactGraph에서 조용히 빠지는 것을 fail-loud로 막음(ADR-0007, `internal-packages.ts:1-10`).
- **fitness**: `module_invariants`(일반화 가능한 불변식)를 FitnessFunction 승급 후보로 둠(`acg-architecture-spec.ts:70-73`). ADR-0004 Q4는 fitness 비용 정책만 닫았고 runner는 분리된 fast-follow다(ADR-0004:41, 61-66).

### 스키마가 SoT

신규 스키마를 만들지 않고 기존 `produced_by`(agent|user) enum 등 스키마가 이미 두 결정을 수용한다(ADR-0004:45, `acg-common.ts:20`). ArchitectureSpec은 `acgCatalogEnvelope`를 쓰는 카탈로그(work_item_id 없음, `acg-common.ts:40-47`)로, change-time 아티팩트와 구분된다.

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

### `observeArchitecture` (propose.ts:76-100) — 관측

입력: repoRoot, sourceRoot, edgeAnalyzer. 하는 일: `walkTsFiles`로 소스 트리를 훑어(test/spec·`.`·node_modules 제외, `propose.ts:56-70`) 파일 목록을 만들고, edgeAnalyzer로 import edge를 뽑는다. layer는 top-level src dir 집합. public_surface는 **층 경계를 넘는** edge의 to 대상만 모은다:

```ts
const toLayer = layerOf(`${e.to}.ts`); // edge.to has no extension
if (fromLayer && toLayer && fromLayer !== toLayer) publicSurfaces.add(e.to);
```

미묘한 결정: `e.to`에 확장자가 없어 `layerOf`에 넣기 전 `.ts`를 붙인다(`propose.ts:95`). `layerOf`는 `src/<layer>/…` 3세그먼트 이상만 layer로 인정한다(`propose.ts:31-34`) — `src/foo.ts`(직속 파일)는 layer 없음. 이 때문에 `${e.to}.ts` 보정이 없으면 층 판정이 어긋난다.

### `buildCandidateSpec` (propose.ts:41-54) — 순수 조립 + 불변식 집행

입력을 무엇으로 받든 candidate 불변식을 강제한다. `Object.fromEntries(...sort().map(l => [l, {can_call: []}]))`로 layer 이름만 넣고, `forbidden_dependencies:[]`, `module_invariants:[]`를 상수로 박는다. **효과**: 호출자가 규칙을 넣으려 해도 이 함수를 거치면 규칙이 비워진다. 정렬(`sort()`)로 결정적 출력 → 재실행 diff 안정.

### `ratifyCandidateSpec` (ratify.ts:31-45) — 승급 게이트

`candidate.produced_by === 'user'`면 throw(`ratify.ts:35-37`). **효과**: 이미 권위인 스펙을 재비준하려 하면 실패해, 사람이 손으로 채운 `forbidden_dependencies`를 조용히 날리는 사고를 막는다. 통과 시 `produced_by:'user'`, `forbidden_dependencies:opts.forbidden`으로 덮되 나머지(layers/public_surfaces/internal_packages)는 스프레드로 그대로 통과. `acgArchitectureSpec.parse(...)`로 재검증해 산출이 스키마를 만족함을 보장.

### `parseForbidden` (architecture.ts:42-52) — `--forbid` 파싱

`"from,to,reason"`을 쉼표로 쪼개되 앞 2개만 분리하고 나머지를 reason으로 재결합한다(`rest.join(',')`). **효과**: reason에 쉼표가 들어가도 깨지지 않는다. 세 필드 하나라도 비면 throw → CLI가 `USAGE_ERROR_EXIT`로 잡는다(`architecture.ts:150-153`).

### `withInternalPackages` (internal-packages.ts:87-101) — set 의미 병합

기존 스펙 있으면 `{...base, internal_packages: entries}`로 **교체**(누적 아님). 없으면 `produced_by:'user'` 최소 스펙 생성. **효과**: internal-packages 선언은 다른 필드를 건드리지 않고 형제모듈 descriptor만 갱신한다. CLI는 기존 스펙을 optional 로드(`readArchitectureSpec` 실패 시 `undefined`, `architecture.ts:250-255`)해 이 함수에 넘긴다.

### `evaluateInternalPackages` (internal-packages.ts:45-80) — JVM 가드 판정(순수)

비JVM 언어면 즉시 `ok`(형제 JAR 개념 없음). JVM인데 로컬 JAR이 있고 (glob 미선언 OR path로 안 덮인 JAR)이면 `block`. glob 미선언(로컬 JAR 없음)이면 `warn`. **효과**: 단일모듈 CodeQL DB가 형제 JAR 타입 의존을 fromSource에서 놓쳐 ImpactGraph에서 조용히 사라지는 것(`internal-packages.ts:4-6`)을 fail-loud로 막는다. 정책은 "로컬 JAR 있는데 누락 → 차단, 그 외 미선언 → 경고"(사용자 합의, `internal-packages.ts:9`).

### CLI 오류 경로 (architecture.ts)

`parseOutputFormat`·`parseForbidden` 실패는 `USAGE_ERROR_EXIT`, 런타임 실패는 `RUNTIME_ERROR_EXIT`. ratify에서 candidate를 못 읽으면 "`ditto architecture propose --write` 먼저" 안내(`architecture.ts:162-167`). 순서 의존성: `propose --write` → `ratify` → (JVM이면) `internal-packages`.

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위: 세 서브커맨드의 CLI 배선·코어 함수·스키마·주 소비처(boundary/scope/pre-tool-use)의 정적 읽기. 테스트 실행·CodeQL 실제 호출은 하지 않았다(미검증).

- **관측/규칙 분리 불변식**: 코드가 의도대로 강제한다. `buildCandidateSpec`(propose.ts:41-53)과 `ratifyCandidateSpec`(ratify.ts:38-44) 양쪽에서 `forbidden_dependencies`가 각각 상수 `[]` / `opts.forbidden`으로만 세팅됨을 확인. 관측이 규칙으로 새는 경로 없음.
- **재비준 clobber 방지**: `ratify.ts:35-37`의 user-guard가 의도(ADR-0004:18)와 일치.
- **agent 경로 비활성 상태와의 정합**: ADR-0004는 이 경로를 활성 선결조건(layer 분류 PoC 등, ADR-0004:21-23) 충족 전 비활성으로 둔다. 코드는 완전히 구현돼 실행 가능하나, 소비처 boundary 게이트가 이 candidate를 신뢰하기 전 PoC가 전제라는 점은 **코드가 아니라 운영 규율**로만 담긴다 — 코드에 "PoC 없이는 propose를 신뢰 말라"는 게이트는 없다(미확인: PoC 수행 여부). 이는 갭이라기보다 ADR이 명시한 deferred 상태다.
- **internal-packages `produced_by=user` 최소 스펙**: `withInternalPackages`가 기존 스펙 없을 때 `produced_by:'user'`로 만든다(internal-packages.ts:97). propose가 만드는 `agent` candidate와 달리, 형제모듈 선언은 그 자체로 사람의 권위 행위로 취급된다 — 의도적이나 스펙 하나가 propose→ratify를 거치지 않고 곧장 user 권위가 되는 경로가 열려 있다(§7에서 재론).

확인 범위에서 관측/규칙 분리에 대한 불일치 없음.

## 7. 잠재 위험·부작용·재설계 시 고려점

- **`propose --write`의 candidate가 권위 스펙을 덮을 수 있는가**: `propose --write`는 `.ditto/architecture-spec.json`에 candidate(`produced_by=agent`)를 **무조건 덮어쓴다**(`architecture.ts:101-108`) — ratify와 달리 기존 user 스펙 보호 가드가 없다. 이미 비준된 권위 스펙이 있는 상태에서 `propose --write`를 다시 돌리면 사람의 `forbidden_dependencies`가 agent candidate로 사라진다. (미확인: 이 시나리오를 막는 상위 훅이 있는지는 이 커맨드 밖.) 재설계 시 propose --write에도 user-guard를 두는 것을 고려.
- **두 진입으로 갈라지는 `produced_by`**: 권위 스펙은 `ratify`(user)와 `internal-packages`(신규 시 user)의 두 경로로 생긴다. internal-packages는 propose→ratify 흐름을 건너뛰므로, layer/surface가 빈 채 권위화될 수 있다. 형제모듈 선언과 layer/surface 비준은 독립적이라는 게 의도로 보이나, 재설계 시 "권위 스펙 = 언제나 사람이 layer/규칙을 본 것"이라는 불변식을 원한다면 이 우회가 깨는 지점이다.
- **동시성/정합성**: 세 커맨드가 같은 파일에 `writeJsonFile`로 쓴다. 원자성·락은 이 커맨드 코드에서 확인 안 됨(미확인 — `core/fs`의 writeJson 구현 미조사). 병렬 세션이 같은 스펙을 쓰면 last-write-wins 위험.
- **관측 정확도 의존**: public_surface 판정이 `layerOf`의 3세그먼트 규칙과 `${e.to}.ts` 확장자 보정에 의존한다(`propose.ts:31-34, 95`). src 직속 파일(`src/x.ts`)이나 비표준 디렉터리 배치는 layer로 안 잡혀 관측에서 빠진다. 다른 저장소 레이아웃(비-`src/` 루트)에 이식 시 이 가정이 깨진다.
- **재설계 시 보존해야 할 불변식**: (1) 관측은 규칙이 될 수 없다 — `forbidden_dependencies`/`can_call`은 사람 선언에서만. (2) 이미 권위인 스펙의 사람 소유 규칙을 조용히 덮지 않는다. (3) JVM 형제모듈 손실은 fail-loud(block). 이 세 개는 ADR-0004·ADR-0007의 안전 결정이라 재고 대상이 아니다.
- **재고 가능한 결정**: agent 경로 활성 선결조건(layer 분류 PoC)이 아직 코드 게이트가 아니라 문서 규율이라는 점. boundary 게이트가 candidate를 신뢰하기 전 정확도 검증을 코드로 강제할지 여부는 재설계 여지가 있다(ADR-0004의 철회 조건 §57-58 참조).
