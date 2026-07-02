# DITTO E2E 여정 DSL 작성 가이드 (v2)

> **목적**: 자기가 만든 웹 기능을 E2E로 검증하려는 개발자가, 사용자 여정(서비스를 쓰는 사람이 밟는 화면 흐름)을 **풍부한 컨텍스트와 함께** 전용 마크업(DSL)으로 적는 법을 알려준다. 이렇게 적은 여정은 결정론적 어댑터가 공식 Playwright plan(`specs/*.plan.md`)으로 투영하고, 공식 playwright-test-generator가 실제 브라우저로 Playwright 스펙을 작성한다 — 여러분이 Playwright 코드를 직접 쓸 필요는 없다.
> **소비자**: DITTO 사용자(개발자). 여정의 의도·제약·엣지·실패·인증은 여러분이 내고, 코드 사실(셀렉터·경로)은 에이전트가 조사해 채운다.
> **갱신 조건**: DSL 문법(front-matter 필드, 단계 동사, 확인 문형, 조건·블록·케이스 규칙)이 바뀔 때 이 문서를 함께 갱신한다. 문법 버전: `ditto_journey: v2`. 문법의 권위 원본은 코드/스키마(`src/schemas/journey-dsl.ts`, `src/core/e2e/plan-adapter.ts`, `src/core/e2e/assertion-mapping.ts`)이며, 이 문서는 그것을 설명할 뿐이다.
>
> **v1과의 clean break**: v2는 v1과 호환되지 않는다. 기존 `ditto_journey: v1` 파일은 더 이상 파싱되지 않고 `"DSL v1 no longer supported — re-author as v2 (clean break, no auto-migration)"` 메시지로 거부된다. 자동 마이그레이션은 없다 — v1 여정은 v2로 다시 저작한다.

---

## 0. 무엇이 달라졌나 (v1 → v2)

v2의 핵심은 **여정에 풍부한 컨텍스트를 붙여, 변환 에이전트가 더 정확한 스펙을 쓰게** 하는 것이다. 무엇을(단계) 만이 아니라 **왜·어떤 제약 아래·어떤 엣지와 실패를 다루며·어떤 인증/초기상태/시드 위에서** 도는지를 front-matter에 선언한다.

| 자리 | v1 | v2 |
|---|---|---|
| front-matter | 7개 필드(문법 버전·id·이름·설명·surfaces·블록·flaky) | 위 7개 + **구현 의도·제약·엣지케이스와 처리·실패 상태·비밀변수·인증·초기상태·시드** |
| 본문(body) | 단계·케이스표·블록·조건 | **동일** (구조만 담는다 — 단계 id, `블록:` 호출, `## 케이스` 표) |
| 확인(assertion) 문형 | `<대상> contains <텍스트>` (대상이 앞) | **키워드가 앞** — `contains <설명>` (§4, 매핑표가 이 순서를 요구) |
| 변환기 | e2e-scripter 에이전트가 추측 | **공식 playwright-test-generator가 실브라우저로 관측**; 브라우저 없으면 e2e-scripter로 강등 |

풍부한 컨텍스트는 전부 **front-matter**에 담긴다(기계가 검증·투영). 본문은 v1처럼 **구조만** 담는다 — 단계 의미(동사·목적어)는 사람이 읽는 것이고 기계가 해석하지 않는다(ADR-0014 경계).

## 1. 시작하기 — 첫 여정 파일 만들기

여정 하나 = 마크다운 파일 하나. 대상 프로젝트 저장소의 `e2e/journeys/` 아래에 만든다.

```
e2e/
  journeys/
    checkout-coupon.journey.md    ← 여정 파일 (사람이 쓴다)
    blocks/
      blk-add-to-cart.block.md    ← 재사용 블록 (사람이 쓴다, §6)
  generated/
    checkout-coupon.spec.ts       ← 생성된 스펙 (DITTO가 쓴다 — 직접 수정 금지)
specs/
  checkout-coupon.plan.md         ← 어댑터가 투영한 공식 plan (기계가 쓴다)
  checkout-coupon.plan.map.json   ← plan-단계 ↔ DSL-단계 join (기계가 쓴다)
  checkout-coupon.assertion-map.md← 확인↔실제 assertion 매핑표 (기계가 쓴다, 사람이 대조)
```

- 여정 파일 이름: `<아무 이름>.journey.md`
- 파일 구조: 맨 위 front-matter(`---`로 감싼 정보 블록) + 본문(번호 매긴 단계 목록) + 필요하면 `## 케이스` 표

가장 작은 여정은 이렇게 생겼다.

```markdown
---
ditto_journey: v2
id: jrn-login-basic
name: 기본 로그인
description: 등록된 사용자가 이메일·비밀번호로 로그인할 수 있다. 깨지면 모든 사용자가 서비스에 못 들어온다.
surfaces:
  - page:/login
implementation_intent: >
  등록된 사용자가 로그인 페이지에서 이메일·비밀번호를 입력하고 로그인하면
  대시보드로 이동한다. 잘못된 자격증명은 대시보드로 보내지 않는다.
---

1. [s1] 방문: /login
2. [s2] 입력: "이메일" 칸에 user@example.com
3. [s3] 클릭: "로그인" 버튼
4. [s4] 확인: url contains /dashboard
```

`implementation_intent`까지가 **항상 필요한** 최소 구성이다(§2a). 직접 처음부터 쓸 필요는 없다 — DITTO가 **단계별로 각 항목을 설명하며 함께 작성**하는 것이 기본 흐름이다. 여정의 의도(무엇을·왜·어떤 제약)는 여러분이 내고, 코드 사실(셀렉터·경로)은 에이전트가 조사해 채운다.

## 2. front-matter — 컨텍스트 선언

front-matter는 세 묶음이다: **항상 필요한 것**(§2a) · **풍부한 컨텍스트**(§2b) · **비밀·인증·초기상태·시드**(§2c). 모든 필드는 `.strict()` 검증이라 **오타나 없는 필드는 조용히 무시되지 않고 검증에서 거부된다**.

### 2a. 항상 필요한 6개

| 필드 | 뜻 | 예 |
|---|---|---|
| `ditto_journey` | 문법 버전 표식. 항상 `v2` | `ditto_journey: v2` |
| `id` | 안정 식별자. `jrn-` + 소문자-하이픈(kebab). 한번 정하면 바꾸지 않는다 | `jrn-checkout-coupon` |
| `name` | 사람이 보고 식별하는 이름 (plan 제목·시나리오명에 쓰인다) | `쿠폰 적용 결제` |
| `description` | 이 여정의 목적·가치 — **왜 깨지면 안 되는가** | `쿠폰 할인이 결제 금액에 반영된다. 깨지면 매출 직결.` |
| `surfaces` | 이 여정이 지나가는 표면 목록(≥1). `page:<경로>` / `api:<METHOD> <경로>` / `component:<저장소 경로\|glob>` 세 형태만. **코드 변경과의 기계 교차(영향 추림)는 `component:`만 한다** — 값은 컴포넌트 이름이 아니라 저장소 파일 경로/glob이어야 매치된다 | `- page:/checkout` `- api:POST /api/coupons/validate` `- component:src/components/coupon/**` |
| `implementation_intent` | **plan의 Application Overview가 되는 산문 의도.** 공식 generator가 여정 전체를 이해하는 근거. "무엇을 어떻게 동작시키려는가"를 한 문단으로 | (아래 §8 예시 참조) |

### 2b. 풍부한 컨텍스트 (없으면 빈 목록으로 생략 가능)

이 세 필드는 **왜 여정을 이렇게 검증하는지**를 담아 plan을 풍부하게 만든다. 안 쓰면 아예 빼거나 빈 목록(`[]`)으로 둔다.

| 필드 | 뜻 | plan 어디로 가나 |
|---|---|---|
| `constraints` | 지켜야 할 불변식·제약(문자열 목록) | Application Overview의 `**Constraints:**` 불릿 |
| `edge_cases` | 경계 조건과 그 처리. 항목마다 `{case, handling}` | 각 항목이 **독립 시나리오**(`### N. <case>`)로, Expected = `handling` |
| `failure_states` | 실패 경로와 기대 동작. 항목마다 `{trigger, expected}` | 각 항목이 **독립 시나리오**(`### N. <trigger>`)로, Expected = `expected` |

```yaml
constraints:
  - 할인은 서버(POST /api/coupons/validate)가 계산한다 — 클라이언트에서 재계산하지 않는다
  - 만료 쿠폰은 결제를 막지 않고 안내만 띄운다
edge_cases:
  - case: 최소 주문금액에 정확히 걸치는 쿠폰(MIN5000)
    handling: 경계값에서 쿠폰이 적용되고 할인 금액이 정확히 반영된다
failure_states:
  - trigger: 쿠폰 검증 API가 5xx를 반환
    expected: "결제를 진행할 수 없습니다" 오류를 띄우고 결제 버튼을 비활성화한다
```

### 2c. 비밀·인증·초기상태·시드 (선택)

**자격증명(비밀번호·토큰 등)은 절대 파일에 리터럴로 쓰지 않는다.** 인증 값은 오직 `env:VAR` / `secret:VAR` 참조로만 적고, 실행 시점에 `process.env`에서 읽힌다. 참조 이름은 대문자·숫자·밑줄(SCREAMING_SNAKE) — `env:E2E_BUYER_PASSWORD` 형식.

| 필드 | 모양 | 뜻 |
|---|---|---|
| `secret_vars` | `[열이름]` | **케이스표 열 중 비밀값을 담은 열 이름 목록.** plan/스펙으로 투영될 때 그 값이 `<env:열이름>`으로 가려진다(§5의 표에는 값이 있되, 산출물에서는 마스킹) |
| `auth` | `{credentials, login_block?, storage_state?}` | 인증 컨텍스트. `credentials`는 `역할 → env/secret 참조`(리터럴 금지, 기본 `{}`). `login_block`은 로그인 절차 블록 id. `storage_state`는 저장된 Playwright storageState 파일(저장소 상대경로) |
| `initial_state` | `{description, setup_ref?}` | 첫 단계 전 가정하는 시작 상태. `description`은 사람이 읽는 설명, `setup_ref`는 그 상태를 만드는 스텝/스크립트 참조 |
| `seed` | `{spec_ref, data_ref?}` | 데이터 시딩. `spec_ref`는 여정 전에 도는 seed 스펙(기본 `e2e/seed.spec.ts`), `data_ref`는 시드 데이터 출처(`env:VAR` 또는 저장소 상대경로) |

```yaml
secret_vars:
  - card_number
auth:
  credentials:
    buyer: env:E2E_BUYER_PASSWORD
  storage_state: e2e/.auth/buyer.json
initial_state:
  description: 구매자로 로그인되어 있고 카탈로그에 "기본 티셔츠"(10,000원)가 있어야 한다
  setup_ref: e2e/seed.spec.ts
seed:
  spec_ref: e2e/seed.spec.ts
  data_ref: env:E2E_SEED_FIXTURE
```

`auth`/`initial_state`/`seed`는 plan의 Overview에 `Precondition: …` 불릿과 각 시나리오의 `**Seed:**` 줄로 투영된다. 권장 패턴: seed 스펙이 `env:E2E_BUYER_PASSWORD`로 한 번 로그인해 `e2e/.auth/buyer.json`(storageState)을 저장하고, 여정은 `auth.storage_state`로 그 세션을 복원한다 — 이러면 비밀번호가 본문에 한 번도 등장하지 않는다.

> **비밀 처리 요약**: 진짜 자격증명은 `auth.credentials`의 `env:/secret:` 참조로(값이 파일에 없음). 케이스표 열에 담긴 값 중 가릴 것은 `secret_vars`로(값은 표에 있되 산출물에서 마스킹). storageState 파일과 `.env*`는 저장소에 커밋하지 않는다(어댑터가 아니라 gitignore로 막는다).

### 2d. 블록·flaky 이력

| 필드 | 뜻 | 예 |
|---|---|---|
| `uses_blocks` | 본문에서 참조하는 재사용 블록 id 목록. 안 쓰면 생략/`[]` | `- blk-add-to-cart` |
| `flaky_history` | 간헐 실패(flaky) 판정 이력. **DITTO가 기록**하므로 직접 채우지 않는다(새 여정은 생략/`[]`). digest 계산에서 제외되므로 기록이 쌓여도 스펙 재생성이 필요 없다 | (직접 쓰지 않음) |

## 3. 본문 — 단계 줄 쓰는 법

본문 문법은 v1과 같다. 단계 한 줄의 모양:

```
N. [s<번호>] (조건)? <동사>: <목적어>
```

- `N.` — 마크다운 번호 목록.
- `[s<번호>]` — 단계의 안정 id (`[s1]`, `[s2]`, …). 실패가 "어느 단계에서"로 보고되고, 생성 스펙의 `// @step` 마커가 이 id로 이어진다. **id는 유일해야 한다**(중복은 파싱 거부). 단계를 중간에 끼워 넣어도 기존 id는 바꾸지 않는다.
- `(조건)` — 선택. 이 단계를 특정 케이스·변수 상황에서만 실행한다 (§7).
- `<동사>: <목적어>` — 아래 7개 동사 중 하나 + 콜론 + 목적어.

### 동사 7개

| 동사 | 뜻 | 예 |
|---|---|---|
| `방문` | 페이지로 이동한다 | `방문: /checkout` |
| `클릭` | 요소를 클릭한다 | `클릭: "결제하기" 버튼` |
| `입력` | 입력칸에 값을 친다 | `입력: "쿠폰 코드" 칸에 {coupon}` |
| `선택` | 드롭다운·라디오 등에서 고른다 | `선택: "배송 방법"에서 택배` |
| `대기` | 요소나 상태가 나타날 때까지 기다린다 | `대기: "주문 요약" 영역` |
| `확인` | 기대 결과를 검증한다 — 목적어는 §4의 확인 5형 중 하나 | `확인: contains "총 결제금액" 영역에 {expected_total}` |
| `블록` | 재사용 블록을 통째로 실행한다 (§6) | `블록: blk-add-to-cart (product=기본 티셔츠)` |

### 대상(target) 적는 법 — 3가지

클릭·입력·확인 등의 목적어에서 화면 요소를 가리킬 때:

| 방식 | 예 | 언제 |
|---|---|---|
| 사람 라벨 (따옴표) | `"로그인" 버튼`, `"쿠폰 코드" 칸` | **기본값.** 화면에 보이는 그대로 적는다 — 실제 셀렉터는 공식 generator가 살아있는 페이지에서 관측해 정한다 |
| `[data-testid=…]` | `[data-testid=coupon-input]` | 개발자가 테스트 식별자를 달아 둔 경우 (가장 안정적) |
| CSS 셀렉터 | `#summary .total` | 셀렉터를 아는 경우만. 모르면 사람 라벨로 충분하다 |

## 4. 확인(assertion) — 5가지 문형 (**키워드가 앞에 온다**)

`확인:` 동사의 목적어는 반드시 아래 5개 **키워드 중 하나로 시작**한다. 키워드 뒤에는 대상·기대값을 사람이 읽을 수 있게 이어 쓴다. 자유 문장(예: "결제가 잘 된다")이나 키워드가 앞에 없는 형태는 매핑표(§아래·ac-6)가 그 확인을 **인식하지 못해 검증에서 조용히 빠진다** — 반드시 키워드로 시작한다.

| 문형 | 뜻 | 예 |
|---|---|---|
| `contains <설명>` | 요소가 해당 텍스트를 포함한다. `{변수}` 사용 가능 | `확인: contains "총 결제금액" 영역에 {expected_total}` |
| `visible <설명>` | 요소가 화면에 보인다 | `확인: visible "주문 완료" 메시지` |
| `hidden <설명>` | 요소가 화면에 안 보인다 | `확인: hidden "로딩 스피너"` |
| `present <설명>` | 요소가 존재한다 | `확인: present [data-testid=order-id]` |
| `url contains <텍스트>` | 현재 주소(URL)에 텍스트가 포함된다 | `확인: url contains /orders/` |

> **왜 키워드가 앞인가**: 생성 스펙의 각 `확인`은 `specs/<slug>.assertion-map.md` 매핑표에서 실제 Playwright matcher와 대조된다(약한 확인·기대값 과적합 방지, ac-6). 매핑기는 목적어의 **맨 앞 키워드**로 확인의 종류를 판별한다. 키워드가 앞에 없으면 그 확인은 매핑표에 아예 오르지 않아, 매핑표가 "빠짐없음"을 잘못 보고할 수 있다(SoT: `src/core/e2e/assertion-mapping.ts`의 `detectForm`).

## 5. 데이터 케이스 — 한 여정을 여러 데이터로 검증

같은 여정을 다른 입력값(유효 쿠폰/만료 쿠폰/쿠폰 없음…)으로 반복 검증하려면, 본문 아래에 `## 케이스` 제목과 마크다운 표를 둔다. 케이스마다 별도 시나리오 케이스(`#### N.M <케이스>`)로 plan에 투영되고, 실패도 케이스 단위로 보고된다.

표 규칙:

- **첫 열** = 케이스 이름 (사람이 읽는 식별자). 선언한 모든 케이스는 생성 스펙에 반드시 존재해야 한다 — 변환에서 케이스가 빠지면 정합성 검사가 실패한다
- **가운데 열들** = 변수. 열 이름이 곧 변수 이름이고, 본문에서 `{변수이름}`으로 치환된다
- **마지막 열** = `유형` — `성공`/`실패`/`경계` 중 하나(사람 가독용 관례; 기계는 첫 열만 케이스 이름으로 읽는다)
- `—` = 그 케이스에서 변수를 설정하지 않음 (미설정)

```markdown
## 케이스

| 케이스 | coupon | expected_total | 유형 |
|---|---|---|---|
| 유효 쿠폰 | WELCOME10 | 9,000원 | 성공 |
| 만료 쿠폰 | EXPIRED99 | — | 실패 |
| 쿠폰 없음 | — | 10,000원 | 성공 |
```

### 변수 규칙

- 변수는 **케이스표에서만 정의**한다. 본문에서는 `{coupon}`처럼 치환해 쓰기만 한다.
- 본문에서 새 변수를 만들거나 값을 바꾸는 문법은 없다 (의도된 제한).
- 케이스표가 없는 여정에는 `{변수}`를 쓸 수 없다. 케이스표가 없으면 여정은 `기본` 케이스 하나로 투영된다.
- 비밀값을 담은 열은 `secret_vars`에 이름을 올린다(§2c) — 그러면 plan/스펙 투영 시 `<env:열이름>`으로 가려진다.

## 6. 재사용 블록 — 공통 절차를 한 번만 정의

로그인·장바구니 담기처럼 여러 여정에 반복되는 절차는 블록으로 뽑는다.

### 블록 정의

위치: `e2e/journeys/blocks/<블록 id>.block.md`. 단계 id는 `b` 접두를 쓴다.

```markdown
---
ditto_block: v2
id: blk-add-to-cart
name: 장바구니 담기
params:
  - product
---

1. [b1] 방문: /products
2. [b2] 클릭: "{product}" 상품 카드
3. [b3] 클릭: "장바구니 담기" 버튼
4. [b4] 확인: visible "장바구니에 담김" 메시지
```

- `ditto_block: v2` — 블록 문법 버전 표식
- `id` — `blk-` 접두 권장, **파일 이름(stem)과 반드시 일치** — 불일치는 정합성 검사가 거부한다
- `params` — 블록이 받는 매개변수 선언(기본 `[]`). 본문에서 `{product}`처럼 쓴다

### 블록 참조

여정 본문에서 `블록` 동사로 호출하고, 매개변수를 `(이름=값, …)`으로 넘긴다. 값 자리에는 고정값도 `{변수}`도 올 수 있다.

```markdown
1. [s1] 블록: blk-add-to-cart (product=기본 티셔츠)
```

참조하는 블록은 front-matter의 `uses_blocks`에도 반드시 올린다 — 영향 추림과 변환이 이 선언을 본다.

> **v2 기본 = 블록 인라인.** plan으로 투영할 때 블록 단계는 여정 시나리오 안에 **펼쳐져** 들어간다(공식 generator에는 블록 개념이 없다). 블록의 각 단계는 자기 `bN` id를 그대로 유지하므로 추적성은 보존된다. 블록을 공유 helper 파일로 분리하는 것은 후속 과제다.

## 7. 선언적 조건 — 단계를 케이스에 따라 켜고 끄기

단계 앞에 `(조건)`을 붙이면 그 단계가 조건이 맞는 케이스에서만 실행된다. 허용되는 조건은 **딱 3형**이다.

| 조건 | 뜻 | 예 |
|---|---|---|
| `(<변수> 있음)` | 이 케이스에서 변수가 설정됨 (`—` 아님) | `(coupon 있음) 입력: "쿠폰 코드" 칸에 {coupon}` |
| `(<변수> 없음)` | 이 케이스에서 변수가 미설정 (`—`) | `(coupon 없음) 확인: hidden "할인" 줄` |
| `(케이스: <이름들>)` | 나열한 케이스에서만 실행 (쉼표로 여러 개) | `(케이스: 만료 쿠폰) 확인: visible "만료된 쿠폰입니다"` |

**이 3형으로 표현 못 하는 분기는 여정을 분리한다.** 중첩 조건, "A이면서 B가 아닐 때", 단계 결과에 따른 갈림 같은 흐름이 필요해지면 — 그것은 하나의 여정이 아니라 두 개의 여정이다. 각각 파일을 나눠 단순하게 쓴다. DSL에 if/else를 흉내 내지 않는다.

## 8. 전체 예시 — 쿠폰 적용 결제 (풍부한 컨텍스트 + 블록 + 케이스)

`e2e/journeys/checkout-coupon.journey.md`. 구현 의도·제약·엣지·실패·비밀·인증·초기상태·시드 + 블록 + 케이스 4개를 갖춘 완전한 v2 여정.

```markdown
---
ditto_journey: v2
id: jrn-checkout-coupon
name: 쿠폰 적용 결제
description: 쿠폰 할인이 결제 금액에 정확히 반영되고, 잘못된 쿠폰은 거부된다. 깨지면 매출·정산에 직결.
surfaces:
  - page:/checkout
  - api:POST /api/coupons/validate
  - component:src/components/coupon/**
implementation_intent: >
  로그인한 구매자가 장바구니에 담은 상품을 결제할 때 쿠폰 코드를 적용하면
  서버가 쿠폰을 검증해 할인을 계산하고 최종 결제 금액에 반영한다. 유효하지 않은
  쿠폰(만료·미달)은 주문을 막지 않되 할인 없이 원가로 결제된다.
constraints:
  - 할인은 서버(POST /api/coupons/validate)가 계산한다 — 클라이언트에서 재계산하지 않는다
  - 만료 쿠폰은 결제를 막지 않고 안내만 띄운다
edge_cases:
  - case: 최소 주문금액에 정확히 걸치는 쿠폰(MIN5000)
    handling: 경계값에서 쿠폰이 적용되고 할인 금액이 정확히 반영된다
failure_states:
  - trigger: 쿠폰 검증 API가 5xx를 반환
    expected: "결제를 진행할 수 없습니다" 오류를 띄우고 결제 버튼을 비활성화한다
secret_vars:
  - card_number
auth:
  credentials:
    buyer: env:E2E_BUYER_PASSWORD
  storage_state: e2e/.auth/buyer.json
initial_state:
  description: 구매자로 로그인되어 있고 카탈로그에 "기본 티셔츠"(10,000원)가 있어야 한다
  setup_ref: e2e/seed.spec.ts
seed:
  spec_ref: e2e/seed.spec.ts
  data_ref: env:E2E_SEED_FIXTURE
uses_blocks:
  - blk-add-to-cart
---

1. [s1] 블록: blk-add-to-cart (product=기본 티셔츠)
2. [s2] 방문: /checkout
3. [s3] (coupon 있음) 입력: "쿠폰 코드" 칸에 {coupon}
4. [s4] (coupon 있음) 클릭: "쿠폰 적용" 버튼
5. [s5] (케이스: 만료 쿠폰) 확인: visible "사용할 수 없는 쿠폰입니다"
6. [s6] (coupon 없음) 확인: hidden "할인" 줄
7. [s7] 입력: "카드 번호" 칸에 {card_number}
8. [s8] (케이스: 유효 쿠폰, 쿠폰 없음, 최소금액 경계) 클릭: "결제하기" 버튼
9. [s9] (케이스: 유효 쿠폰, 쿠폰 없음, 최소금액 경계) 확인: url contains /orders/
10. [s10] (케이스: 유효 쿠폰, 쿠폰 없음, 최소금액 경계) 확인: contains "총 결제금액" 영역에 {expected_total}

## 케이스

| 케이스 | coupon | card_number | expected_total | 유형 |
|---|---|---|---|---|
| 유효 쿠폰 | WELCOME10 | 4242424242424242 | 9,000원 | 성공 |
| 만료 쿠폰 | EXPIRED99 | 4242424242424242 | — | 실패 |
| 쿠폰 없음 | — | 4242424242424242 | 10,000원 | 성공 |
| 최소금액 경계 | MIN5000 | 4242424242424242 | 5,000원 | 경계 |
```

읽는 법:

- 본문 여정은 plan의 **시나리오 1**이 되고, 케이스 4개가 각각 `#### 1.1 유효 쿠폰` … `#### 1.4 최소금액 경계`로 투영된다. `edge_cases` 항목은 **시나리오 2**, `failure_states` 항목은 **시나리오 3**으로 따로 선다.
- "만료 쿠폰" 케이스는 s5에서 오류 메시지를 확인하고 끝난다(결제 단계 s8~s10은 그 케이스에 포함되지 않음). "쿠폰 없음" 케이스는 s3·s4를 건너뛰고 s6에서 할인 줄이 없는 것을 확인한다.
- `card_number`는 `secret_vars`라서 케이스표에는 값이 있어도 `specs/*.plan.md`·생성 스펙에는 `<env:card_number>`로 가려진다.
- `blk-add-to-cart`의 단계(b1~b4)는 시나리오 1에 인라인으로 펼쳐지고, 각 `bN` 마커로 추적된다.

## 9. 자주 하는 실수

| 실수 | 왜 안 되는가 | 대신 |
|---|---|---|
| `ditto_journey: v1`로 두거나 v1 여정을 그대로 재사용 | v2는 clean break — v1은 파싱 거부(`DSL v1 no longer supported`) | v2 문법으로 다시 저작한다. 자동 마이그레이션은 없다 |
| `확인:`에서 키워드를 뒤에 두기 — `확인: "총 결제금액" contains 9,000원` | 매핑기는 맨 앞 키워드로 확인 종류를 판별한다. 키워드가 앞에 없으면 매핑표에서 조용히 빠져 검증 공백이 생긴다 | 키워드를 앞에 — `확인: contains "총 결제금액" 영역에 9,000원` (§4) |
| `확인:`에 자유 문장 — `확인: 결제가 잘 된다` | 기계가 종류를 판정할 수 없어 매핑되지 않는다 | §4의 5형 중 하나로 — `확인: visible "주문 완료" 메시지` |
| 비밀번호·토큰을 본문·케이스표에 리터럴로 | 산출물(plan·스펙)이 저장소에 커밋된다 | `auth.credentials`에 `env:VAR`로 선언(값은 실행 시 `process.env`에서). 케이스 열 비밀값은 `secret_vars`에 올려 마스킹 |
| `implementation_intent`를 비우거나 대충 | plan의 Application Overview가 비어 공식 generator가 여정 의도를 못 읽는다 | 한 문단으로 "무엇을 어떻게 동작시키려는가"를 적는다 |
| 범용 언어처럼 쓰기 — `만약 X면 … 아니면 …`, 본문 변수 대입, 반복문 흉내 | DSL은 프로그래밍 언어가 아니다. 조건은 §7의 3형뿐 | 케이스표로 데이터를 나누거나, 여정 파일을 분리 |
| `e2e/generated/` 아래 생성 스펙을 직접 수정 | 생성물은 DSL에서 파생된다(`@ditto-generated` 표식). 직접 고친 내용은 재생성 때 사라지고, digest/마커 누락으로 정합성 검사가 잡는다 | 여정 `.journey.md`를 고치고 DITTO에게 재생성을 맡긴다 |
| `surfaces`를 비우거나 대충 | 코드 변경 시 영향받는 테스트를 이 선언으로 추린다. 빠지면 깨진 여정이 검증 없이 통과할 수 있다 | 페이지·API·컴포넌트를 접두(`page:`/`api:`/`component:`)와 함께. 기계 추림에 걸리려면 `component:`에 저장소 경로/glob을 적는다 |
| 블록을 본문에서 쓰고 `uses_blocks`에 누락 | 영향 추림과 변환이 선언을 본다 | `블록:` 호출과 `uses_blocks` 목록을 항상 일치시킨다 |
| 단계 id(`[s3]`) 재번호 매기기 | 실패 보고·이력·`@step` 마커가 단계 id로 연결된다 | 중간에 단계를 끼워도 기존 id는 유지하고 새 번호를 이어 쓴다 (`[s11]` 등) |
| `flaky_history`를 손으로 채우기 | flaky 판정은 사용자 확인을 거쳐 DITTO가 기록한다 | 새 여정은 생략/`[]`로 두고 건드리지 않는다 |
