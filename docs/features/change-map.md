# change-map — 한 work item의 변경 계약·영향·리뷰를 하나의 텍스트 정본으로 렌더링하는 read-only 뷰어

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준: HEAD `c2d2e16`, 대상 소스 최종 수정 커밋 `2a26fa1`(2026-07-13), 작성일 2026-07-19.

## 1. 이 기능이 실현하려는 설계 의도 (개념)

`ditto change-map`은 한 work item에 대해 **이미 만들어진 세 산출물**을 사람이 한눈에 읽을 수 있는 단일 텍스트로 합쳐 보여주는 뷰어다. 세 산출물은:

- **ChangeContract**(필수): 이 변경이 *무엇을 목표로*, *어디까지 건드려도 되고(allow)*, *무엇은 절대 못 건드리며(forbid)*, *무엇으로 완료를 증명하는가(acceptance)*를 담은 변경 계약 (`src/schemas/acg-change-contract.ts:33`).
- **ImpactGraph**(선택): 이 변경이 정적 분석상 *어떤 노드에 파급되는가*, 그리고 *정적으로 못 푼 파급(unresolved)*은 무엇인가 (`src/schemas/acg-impact-graph.ts:68`).
- **ReviewGraph**(선택): 변경된 파일/흐름을 위험도로 분류하고 증거 유무를 기록한 리뷰 원장 (`src/schemas/acg-review-graph.ts:70`).

즉 이 커맨드 자체는 계약·영향·리뷰를 *생산하지 않는다*. 각각 `ditto change-contract`, `ditto impact`, 리뷰 파이프라인이 만든 것을 **읽어서 그린다**(read-only producer). 커맨드 주석이 이를 명시한다: "read-only producer"(`src/cli/commands/change-map.ts:12`).

핵심 개념은 **"텍스트가 정본, 다이어그램은 파생"**이다. 사람이 리뷰에서 읽는 단일 change_node 텍스트가 진실의 표현이고, Mermaid 다이어그램은 같은 입력에서 파생한 시각화일 뿐이다. 렌더러 주석이 명시한다: "텍스트가 정본이고, Mermaid 다이어그램(§3)은 같은 입력에서 파생한다"(`src/acg/change-map/render.ts:10`), "텍스트 정본과 불일치하면 텍스트가 이긴다"(`render.ts:139`).

DITTO 4축에서의 위치: 이 기능은 ACG(Agentic Change Governance) 바인딩 계층에 속한다. `src/schemas/acg-common.ts:5`가 ACG를 "DITTO binding of the ACG spec layer"로 정의한다. 즉 의도(ChangeContract)·오케스트레이션(ImpactGraph의 파급, ReviewGraph의 리뷰 게이트)을 가로지르는 **거버넌스 표면의 사람용 렌더링**이다. (4축 중 특정 하나에 배타적으로 귀속시키는 근거는 코드에서 확인하지 못함 — "거버넌스 표면"이라는 위치까지가 확인 가능한 범위다.)

## 2. 코드 위치와 진입점

| 경로 | 역할 |
| --- | --- |
| `src/cli/commands/change-map.ts` | CLI 진입. 세 입력을 store에서 읽고 출력 포맷 분기 |
| `src/acg/change-map/index.ts` | `render`/`renderMermaid`/`summarize` re-export만 (`index.ts:1`) |
| `src/acg/change-map/render.ts` | 실제 렌더러(텍스트·Mermaid·json 요약) — 순수 함수 |
| `src/acg/change-map/render.test.ts` | 라인 형식·enum 토큰·ReviewGraph 폴백 동작 검증 |
| `src/core/change-contract-store.ts` | change-contract.json 읽기(진입에서 사용) |
| `src/core/acg-review-store.ts` | acg-review.json 읽기(진입에서 사용) |
| `src/schemas/acg-change-contract.ts` / `acg-impact-graph.ts` / `acg-review-graph.ts` | 세 입력의 스키마(계약, SoT — ADR-0002) |

CLI 등록: `src/cli/index.ts:83`에서 `'change-map': changeMapCommand`.

### 서브커맨드·인자

서브커맨드는 없다. 단일 커맨드에 인자 2개(`src/cli/commands/change-map.ts:22`):

| 인자 | 타입 | 필수 | 기본값 | 설명 |
| --- | --- | --- | --- | --- |
| `--work-item` | string | 예 | — | work item id |
| `--output` | string | 아니오 | `human` | 출력 포맷: `human` \| `json` \| `mermaid` |

- `human`: §2.1 텍스트 정본(`render`).
- `json`: 요약 객체(`summarize`).
- `mermaid`: 파생 다이어그램(`renderMermaid`).

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

이 커맨드는 **아무것도 저장하지 않는다.** stdout으로만 출력한다.

읽는 상태 파일(모두 `.ditto/local/work-items/<wi>/` 아래):

| 파일 | 스키마 | 이 커맨드에서 | 생산자(별도 커맨드) |
| --- | --- | --- | --- |
| `change-contract.json` | `acg.change-contract.v1` | **필수** — 없으면 종료 | `ditto change-contract`(ICL 컴파일, `src/cli/commands/change-contract.ts:93`) |
| `impact-graph.json` | `acg.impact-graph.v1` | 선택 — 없거나 스키마 위반이면 무시 | `ditto impact`(`src/cli/commands/impact.ts:129`) |
| `acg-review.json` | `acg.review-graph.v1` | 선택 — 없으면 무시 | 리뷰 파이프라인(AcgReviewStore 기록; 진입 커맨드는 미확인) |

흐름:

```
--work-item <wi>
   │
   ├─ ChangeContractStore.read(wi)  ─ 필수, null이면 USAGE_ERROR로 종료
   │     (src/cli/commands/change-map.ts:47-52)
   ├─ readJson(impact-graph.json)   ─ 선택, try/catch로 실패시 undefined
   │     (change-map.ts:56-63)
   └─ AcgReviewStore.exists?→get    ─ 선택, 없으면 undefined
         (change-map.ts:65-68)
   │
   ▼  세 값을 render/renderMermaid/summarize에 그대로 전달
   ├─ --output human   → render(contract, impact?, review?)      → writeHuman
   ├─ --output json    → summarize(contract, impact?, review?)   → writeJson
   └─ --output mermaid → renderMermaid(contract, impact?, review?)→ writeHuman
         (change-map.ts:70-76)
```

주의: 세 렌더 함수는 모두 `contract`를 **필수 인자**, `impact`/`review`를 **선택 인자**로 받는 순수 함수다(`src/acg/change-map/render.ts:62,82,141`). 부수효과가 없다.

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

### 4-1. 텍스트가 정본, 다이어그램은 파생 (single source, derived view)

같은 세 입력에서 텍스트(`render`)와 Mermaid(`renderMermaid`)를 각각 그리되, 둘이 어긋나면 텍스트가 이긴다(`render.ts:139`). 다이어그램을 별도 진실원으로 두지 않아 렌더 로직의 drift를 구조적으로 막는다. 두 렌더러가 같은 헬퍼(`resolveRisk`, `nodeRef`, `evidenceBadge`)를 공유해 위험색·증거뱃지 계산이 한 곳에 있다(`render.ts:27,38,51`).

### 4-2. 토큰은 스키마 enum과 정확히 일치

렌더러 주석: "토큰은 스키마 enum과 정확히 일치한다"(`render.ts:10`). impact 노드의 `kind`(예: `direct_caller`, `config_driven`)를 가공 없이 그대로 출력한다(`render.ts:102,105`). 사람이 보는 텍스트와 계약 스키마의 어휘를 일치시켜, 텍스트에서 본 토큰으로 스키마를 곧장 역추적할 수 있게 한 결정으로 보인다(추론).

### 4-3. 위험 뱃지의 출처 우선순위 (ReviewGraph > ChangeContract)

`resolveRisk`는 ReviewGraph가 있고 파일이 하나라도 있으면 **분류된 파일들의 최고위험**을 따르고, 없으면 `ChangeContract.risk_default`로 폴백한다(`render.ts:27-35`). 이유는 주석에 있다: "§1 위험 색은 ReviewGraph 출처". 즉 계약이 선언한 기본 위험보다, 실제 변경 파일을 리뷰해 산출한 위험이 더 신뢰할 만하다는 우선순위. `render.test.ts:100`이 이 폴백을 검증한다(risk_default가 medium이어도 리뷰에 high 파일이 있으면 🔴[high]).

### 4-4. 증거 뱃지 3-상태 (☑/☐/⚠)

`evidenceBadge`(`render.ts:51-56`): 같은 ref의 ReviewGraph 파일이 `unresolved`면 ⚠, `evidence`가 있으면 ☑, 그 외(또는 ReviewGraph 없음)면 ☐. `unresolved`가 evidence보다 먼저 판정된다 — 증거-부재 마커를 증거보다 앞세워, 미해소 위험이 증거로 가려지지 않게 한다. `unresolved`는 스키마상 별도 boolean 플래그이지 evidence.kind가 아니다(`acg-review-graph.ts:49`).

### 관련 결정

`.ditto/knowledge/adr/`에서 change-map을 직접 다루는 ADR은 grep으로 찾지 못했다(미확인). 근거로 인용 가능한 것은:

- ADR-0002 — 스키마가 SoT. 이 렌더러가 스키마 enum을 정본으로 삼는 근거.
- ADR-0005 — 런타임 산출물은 per-entity 파일. 세 입력이 `.ditto/local/work-items/<wi>/`에 파일로 놓이는 근거(`change-contract-store.ts:1-6`, `acg-review-store.ts:5-8`가 명시 인용).
- ADR-0012 — 개인 tier는 `.ditto/local`. 세 입력이 `localDir(...)` 아래인 근거.

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

### `changeMapCommand.run` (진입, `src/cli/commands/change-map.ts:30-77`)

- **출력 포맷 분기**: `mermaid`는 `parseOutputFormat`(human/json만 아는 파서)을 우회하려고 `isMermaid` 플래그로 별도 처리(`change-map.ts:31-42`). 주석: "mermaid는 텍스트 정본의 파생 다이어그램(§3) — human/json과 별도 분기". 효과: `parseOutputFormat`을 확장하지 않고 파생 포맷을 끼워 넣는다. (미묘한 결정: mermaid 경로는 `parseOutputFormat` 검증을 타지 않으므로, 잘못된 output 문자열이라도 `mermaid`가 아니면 파서로, `mermaid`면 바로 렌더로 간다.)
- **필수 계약 게이트**: `contract`가 null이면 `USAGE_ERROR_EXIT`로 종료(`change-map.ts:48-52`). 이 커맨드가 성립하려면 최소 계약은 있어야 한다는 강제.
- **선택 입력의 fail-open**: impact 읽기는 try/catch로 감싸 실패시 `undefined`(`change-map.ts:56-63`), review는 `exists()` 확인 후에만 `get()`(`change-map.ts:65-68`). 효과: 부재/스키마 위반이 렌더를 막지 않는다(주석: "부재/위반이면 무시").

### `render` (텍스트 정본, `render.ts:82-115`)

입력 → 하는 일 → 산출:

- 헤더 `◆ <id> <riskBadge> "<purpose>"`(`render.ts:89`), `decision:` 줄은 `decision_ref ?? '—'`(`render.ts:92`).
- scope 블록: `allow ─ <ref들 콤마결합>`, `forbid ✕ <ref들 "  ✕ " 결합>`(`render.ts:95-96`).
- impact 블록: impact가 있고 affected나 unresolved가 하나라도 있을 때만 그린다(`render.ts:98`). affected는 `→ <kind> <ref> <증거뱃지>`, unresolved는 `⚠ unresolved: <kind> <path> — <reason>`(`render.ts:102,105`).
- accept 블록: **모든 acceptance를 무조건 ☐(열림)로** 출력(`render.ts:110-111`). 증거뱃지 로직을 타지 않는다 — accept은 항상 미해소로 표시된다. 이는 `summarize`의 `open_accept` 주석과 일관된다: "§2.1에서 모든 accept이 ☐(열림)이므로 acceptance 전체 개수다"(`render.ts:60`).

### `renderMermaid` (파생 다이어그램, `render.ts:141-173`)

- 중심 노드 `C`(위험색), `forbidden_scope`는 점선 red 엣지(`✕ forbid`), `affected_nodes`는 실선 엣지(`<kind> <증거뱃지>`), `unresolved`는 점선 grey 엣지(`render.ts:148-165`).
- **라벨 안전화** `label()`: 따옴표→작은따옴표, 개행→공백(`render.ts:118-120`). Mermaid 라벨 파싱이 깨지지 않게 하는 가드.
- **노드 id 안전화** `nodeId()`: 변경노드 외 노드는 `F0`,`A1`,`U0`처럼 인덱스 기반 id를 쓴다(`render.ts:123-125`). 주석: "ref에 경로·점·슬래시가 섞여도 Mermaid id 안전". ref를 id로 직접 쓰면 Mermaid 문법이 깨지므로 인덱스로 우회.

주의: `render`(텍스트)는 forbidden_scope를 scope 블록에 넣지만, `renderMermaid`는 forbidden_scope를 **엣지**로 그리고 allowed_scope는 그리지 않는다. 두 뷰가 같은 입력을 다르게 투영한다(불일치 아님 — 표현 차이).

### `summarize` (json 요약, `render.ts:62-80`)

`change_id`(=work_item_id), `risk`(resolveRisk), `impact`(affected 수), `unresolved`(unresolved 수), `open_accept`(=acceptance 전체 개수). 렌더 텍스트를 재파싱하지 않고 입력에서 직접 계수한다.

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위(세 소스 파일 + render.test.ts + 세 스키마 + 두 store)에서:

- **텍스트=정본, 다이어그램=파생**: `render`/`renderMermaid`가 같은 헬퍼로 위험·증거를 계산하므로 코드상 일관. 다만 "불일치하면 텍스트가 이긴다"는 **런타임에 강제되는 불변식이 아니라 두 함수가 같은 입력을 받는다는 구조적 보장**이다. 두 렌더러가 실제로 같은 결과를 내는지 비교하는 테스트는 확인 못 함(render.test.ts는 `render`만 검증, `renderMermaid`·`summarize` 테스트는 이 파일에 없음 — 미검증).
- **ReviewGraph 위험 폴백**: 의도대로 동작(`render.test.ts:100-104`가 실증).
- **accept 항상 ☐**: 의도(주석)와 코드 일치(`render.ts:110-111`).
- **선택 입력 fail-open**: impact는 try/catch, review는 exists-gate로 의도대로 무시된다(`change-map.ts:56-68`).

갭/미검증 지점:

- `renderMermaid`와 `summarize`는 이 확인 범위 내 단위 테스트가 없다(render.test.ts는 `render`만 import). 회귀 보호가 텍스트 렌더러에만 있다.
- `resolveRisk`가 ReviewGraph를 볼 때 `review.files.length > 0` 조건이라, **파일이 빈 ReviewGraph는 계약 risk_default로 폴백**한다(`render.ts:28`). 이것이 의도인지(빈 리뷰=리뷰 안 함) 갭인지는 주석만으로 단정 못 함 — 동작은 확인, 의도는 미확인.

## 7. 잠재 위험·부작용·재설계 시 고려점

- **§ 참조의 drift 위험**: 코드 주석이 "§2.1", "§2.1b EBNF", "§3", "§1"을 참조한다(`render.ts:8,10,60,139`, `change-map.ts:14,31`). 이 절 번호가 가리키는 사양 문서가 코드와 별도로 관리되면(charter §4-11의 drift) 렌더 형식의 진실원이 애매해진다. 텍스트 라인 형식의 실질 정본은 지금 `render.test.ts`가 고정하는 기대 문자열이다 — 재설계 시 이 테스트가 형식 계약임을 인지해야 한다.
- **텍스트↔다이어그램 정합의 미강제**: "텍스트가 이긴다"는 규범이지 코드가 검증하지 않는다. `render`와 `renderMermaid`가 각자 로직을 두므로(예: 미래에 한쪽만 필드 추가), 두 뷰가 조용히 어긋날 수 있다. 재설계 시 보존해야 할 불변식: **두 뷰는 같은 입력·같은 계산 헬퍼에서 나와야 한다**(현재 `resolveRisk`/`nodeRef`/`evidenceBadge` 공유가 그 장치).
- **매칭이 ref 문자열 동등성에 의존**: `evidenceBadge`는 impact 노드의 ref(journey_id 또는 path)와 ReviewGraph 파일의 ref를 **정확 문자열 일치**로 매칭한다(`render.ts:51-52,38-44`). 경로 표기가 미세하게 다르면(상대/절대, 정규화 차이) 증거뱃지가 조용히 ☐로 떨어진다. 정규화 로직이 없다 — 확장 시 취약점.
- **선택 입력 fail-open의 양면성**: impact-graph.json이 스키마 위반이어도 조용히 undefined로 무시된다(`change-map.ts:56-63`). 뷰어로서는 견고하지만, 손상된 산출물을 사용자에게 알리지 않는다. 진단이 필요하면 별도 신호가 없다는 점을 고려.
- **accept 항상 열림**: acceptance 증거 상태를 change-map은 반영하지 않는다(항상 ☐). acceptance 완료 현황을 이 뷰에 넣으려면 새 입력(completion/verify 산출물)을 엮어야 하며, 현재는 의도적으로 계약의 선언만 보여준다.
- **동시성**: 이 커맨드는 read-only stdout 뷰어라 쓰기 경합은 없다. 다만 세 입력이 서로 다른 시점 산출물이므로(계약은 컴파일 시점, impact는 impact 실행 시점, review는 리뷰 시점) **한 뷰 안에 시점이 다른 스냅샷이 섞일 수 있다**. 정합성 보장 장치는 확인 못 함.
