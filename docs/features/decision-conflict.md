# decision-conflict — 감지된 ADR 충돌을 (kind, level, mode)로 라우팅하고 항상 공개하는 결정적 게이트 표면

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준 커밋: `c2d2e16`, 작성일 2026-07-19.

## 1. 이 기능이 실현하려는 설계 의도 (개념)

`ditto decision-conflict gate`는 ADR(되돌리기 어려운 결정의 영속 기록)과 진행 중인 작업이 충돌할 때, 그 충돌을 **어떻게 처리하고 어떻게 드러낼지**를 결정론으로 정하는 표면이다.

문제의 출발점(ADR-0020 컨텍스트, `.ditto/knowledge/adr/ADR-0020-decision-conflict-guardrail.md:8-12`): ADR은 영속 기록물일 뿐 추론 시점 가드레일로 작동하지 않는다. "A는 ~이유로 하지 않는다"는 결정이 기록돼 있어도, 에이전트가 A를 제안·계획·구현할 때 일관되게 확인되지 않는다. ADR이 에이전트에 닿는 경로(CLAUDE.md 투영, `memory query`, warm-start)는 전부 약하고, `scripts/adr-guard.ts`는 grep으로 잡을 수 있는 위반만 잡는다.

DITTO는 이 문제를 세 갈래로 쪼갠다(ADR-0020 D1·D2·D4):

1. **classify** — 충돌이 존재하는지, 그 `(kind, level)`이 무엇인지 판단(의미 판단이라 결정론 불가 → host LLM에 위임, ADR-0001).
2. **route** — 이미 분류된 충돌을 순수 함수로 라우팅(이 커맨드가 노출하는 부분).
3. **disclose** — 감지된 모든 충돌을 근거와 함께 출력에 드러냄(투명성 불변식).

이 커맨드는 그중 **route + disclose를 담당하는 결정적 표면**이다. "충돌이 있는가"를 판단하지 않는다(`src/cli/commands/decision-conflict.ts:24-26`: "WHETHER a conflict exists and its (kind, level) is the caller's judgement (host-delegated, ADR-0001); this command is the deterministic routing surface").

DITTO 4축 기준으로는 **오케스트레이션 축의 거버넌스 가드레일**에 속한다 — ADR-0020(결정-모순 가드레일)이 "ADR을 추론 시점에 일관 적용"하기 위해 도입한 게이트이고, autopilot 루프와 Stop 훅의 완료·차단 판정에 물려 있다.

## 2. 코드 위치와 진입점

핵심 파일:

| 경로 | 역할 |
| --- | --- |
| `src/cli/commands/decision-conflict.ts` | CLI 진입. `gate` 서브커맨드가 순수 게이트를 노출 |
| `src/core/gates.ts:993-1008` | `decisionConflictGate` — 순수 라우팅 정책(핵심 로직) |
| `src/core/gates.ts:1020-1022` | `decisionConflictRequiresApproval` — intent 충돌 예방 술어 |
| `src/core/gates.ts:930-978` | 타입: `DecisionConflict`, `ConflictRoute`, `ConflictDisposition`, `DecisionConflictResult` |
| `src/schemas/decision-conflict-carrier.ts` | `decisionConflict`(단건)·`decisionConflictCarrier`(영속 봉투) zod 스키마 |
| `src/schemas/direction-fork-carrier.ts` | 자매 스키마 — 이 carrier 패턴을 그대로 모델링한 direction-fork carrier |
| `src/core/autopilot-loop.ts:2234-2253, 3178-3193` | carrier 쓰기(design 노드) + approval 예방 술어 소비 |
| `src/hooks/stop.ts:487-507, 796-800, 1023-1029` | Stop 경계 집행 — force-continue 판정 + 공개 |

서브커맨드·CLI 인자 (`src/cli/commands/decision-conflict.ts:32-46`):

| 커맨드 | 인자 | 설명 |
| --- | --- | --- |
| `decision-conflict gate` | `--json` (필수, string) | `{mode, conflicts[]}` JSON. mode=`interactive`\|`autopilot`(기본 autopilot), conflict=`{adr_id, kind, level, basis}` |
| | `--output` (기본 `human`) | `human`\|`json` |

`gate` 하나만 서브커맨드로 등록돼 있다(`src/cli/commands/decision-conflict.ts:101-103`). 커맨드 자체는 `src/cli/index.ts:70`에서 루트에 배선된다.

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

CLI 경로(이 커맨드가 직접 하는 일)는 **상태 파일을 읽거나 쓰지 않는다** — `--json`으로 받은 충돌 선언을 파싱→검증→순수 게이트에 통과시켜 결과를 stdout으로 낼 뿐이다.

```
--json '{mode, conflicts[]}'
   │  parseOutputFormat(--output)         (실패 → exit 65)
   │  JSON.parse                          (실패 → exit 65)
   │  gateInput.safeParse (zod)           (실패 → exit 65, 이슈별 메시지)
   ▼
decisionConflictGate(conflicts, mode)     ← 순수 함수, 상태 무접근
   ▼
result {dispositions[], blocked, needsApproval, disclose}
   │  status = BLOCKED | NEEDS APPROVAL | DISCLOSE | CLEAR
   ▼
human: "decision-conflict gate: <status>" + disposition별 한 줄
json:  result 그대로
   │
   └ blocked || needsApproval → exit 1 (RUNTIME_ERROR_EXIT)
```

(`src/cli/commands/decision-conflict.ts:47-92`. exit 상수: `src/cli/util.ts:36-37` — USAGE=65, RUNTIME=1)

이 CLI는 **동일한 순수 게이트를 노출하는 여러 소비처 중 하나**다. 실제 파이프라인에서 상태 파일을 읽고 쓰는 것은 CLI가 아니라 autopilot 루프와 Stop 훅이다(§5). 파이프라인이 다루는 상태 파일:

- **`.ditto/local/work-items/<wi>/decision-conflict.json`** — `decisionConflictCarrier` 스키마(`src/schemas/decision-conflict-carrier.ts:33-39`). design 노드가 충돌을 감지하면 여기에 영속화하고, Stop 훅이 다른 ledger처럼 읽는다(absent → inert, malformed → fail-closed).

carrier 스키마(영속 봉투):

```
decisionConflictCarrier = { schema_version, mode: 'interactive'|'autopilot', conflicts: DecisionConflict[] }
DecisionConflict        = { adr_id, kind: forbid|require|prefer, level: intent|method, basis }
```

carrier의 conflict 모양은 `DecisionConflict` 인터페이스와 **정확히 일치**하도록 설계돼, 게이트가 번역 없이 소비한다(`src/schemas/decision-conflict-carrier.ts:14-16`).

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

### method vs intent — 충돌 분류의 축

`level`이 충돌의 처리 권한을 가른다(`src/core/gates.ts:935-941`, ADR-0020 D1):

- **intent 충돌** — work item의 목적(goal/AC) 자체가 ADR 금지를 요구. **사용자만 해결 가능**(align / supersede / drop). 요청 자체가 ADR이 금지한 것을 원하기 때문.
- **method 충돌** — 후보 구현 경로가 ADR을 어김. **에이전트가 ADR대로 재경로(re-route)해 자율 해결**.

이 구분이 자율성과 안전의 경계다. method는 에이전트가 조용히 고쳐도 되지만(단, 공개는 필수), intent는 에이전트가 임의로 축소·우회하면 안 되는 사용자 결정이다.

### 라우팅 정책 (`kind × level × mode`)

```
prefer (any level)        → justify   (soft: 근거만 기록, 절대 차단 안 함)
forbid/require · method   → align     (ADR 자동 준수, 진행)
forbid/require · intent   → ask_user  (interactive) | block (autopilot, fail-closed)
```

(`src/core/gates.ts:997-1001`) 세 줄의 분기가 전체 정책이다. 순서 의존: `prefer`를 먼저 걸러 kind가 soft면 level과 무관하게 justify로 빠지고, 그다음 method면 align, 남은 것(hard·intent)만 mode로 갈린다.

### D2 — 투명성 불변식: 조용한 자동 준수 금지

`disclose`는 충돌이 하나라도 감지되면 true다(`src/core/gates.ts:1006`). method 자동 정렬처럼 사용자 확인을 안 받는 경우에도 근거(`basis`)를 출력에 드러낸다(ADR-0020 D2). "ADR-X를 고려해 이렇게 독자 판단했다"가 사용자 응답·Stop 보고에 보여야 하며, 로그에만 남기는 조용한 준수는 위반이다(기각된 대안 (e), ADR-0020:49). 그래서 `basis`가 `DecisionConflict`부터 `ConflictDisposition`까지 그대로 운반돼 렌더링된다(`src/core/gates.ts:942-949`).

### D3 — autopilot fail-closed (live 대기 금지)

autopilot 중 intent 충돌은 멈춰 서서 사용자 응답을 실시간 대기하지 않는다(무인 진행이라는 ditto 자율성 가치, 기각된 대안 (c)). 대신 노드를 `block` 라우팅해 Stop 경계에서 보고한다(ADR-0020 D3). 예방층으로, intent 충돌은 planner→승인 이음새에서 앞당겨 검출해 autopilot이 충돌을 안고 출발하는 일을 드물게 만든다.

### D4 — 판단은 host LLM, ditto는 라우팅·투명성만

"충돌이 존재하는가, kind/level은 무엇인가"는 의미 판단이라 결정론으로 못 푼다(Rice의 정리; ADR-0020 D4). 그 판단은 host LLM에 위임하고(ADR-0001: provider 직접 호출 금지, ADR-0006: AST 금지), ditto는 검색·순수 라우팅·투명성 정책만 소유한다. 게이트가 충돌을 *만들지* 않는다.

### 무손실 free-text 채널 (`basis`)

`basis`는 "ADR이 무엇을 말하고 현재 작업이 그것을 어떻게 건드리는가"의 증거를 담는 자유 서술 필드다(`src/schemas/decision-conflict-carrier.ts:27-30`, min(1)). ADR-20260628-decisive-class-lossless-channel의 설계 철학과 동형: 결정 클래스는 per-class 구조 필드로 쪼개지 않고 무손실 free-text로 운반하고, 스키마는 *비어있지 않음*만 결정적으로 강제하며 "내용이 충분한가"의 의미 검사는 verifier/review 노드(또는 여기서는 host의 disclosure)에 맡긴다. 근거: free-text 안에 실제로 무엇이 들었는지는 정규식·스키마로 못 잡고, LLM judge로 검사하면 환각으로 SLOP을 만든다(ADR-20260628:24-27).

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

### `decisionConflictGate` (순수 라우팅) — `src/core/gates.ts:993-1008`

입력: `conflicts: DecisionConflict[]`, `mode`. 하는 일: 각 충돌을 위 3분기로 라우팅해 disposition 배열을 만들고, 세 boolean을 fold한다.

```ts
const dispositions = conflicts.map((conflict): ConflictDisposition => {
  if (conflict.kind === 'prefer') return { conflict, route: 'justify' };
  if (conflict.level === 'method') return { conflict, route: 'align' };
  return { conflict, route: mode === 'autopilot' ? 'block' : 'ask_user' };
});
return {
  dispositions,
  blocked: dispositions.some((d) => d.route === 'block'),
  needsApproval: dispositions.some((d) => d.route === 'ask_user'),
  disclose: conflicts.length > 0,
};
```

산출 효과: `blocked`가 autopilot 실패(exit)를, `needsApproval`이 interactive 확인 요구를, `disclose`가 공개 여부를 결정한다. 순수·결정론(ADR-0020 D5: 결정론 1차) — 충돌 존재 여부는 판단하지 않고 분류된 충돌의 처리만 정한다(`src/core/gates.ts:982-983`).

### CLI `run` — `src/cli/commands/decision-conflict.ts:47-92`

입력을 3중 게이팅한다(순서 의존): output 포맷 파싱 실패 → exit 65, `JSON.parse` 실패 → exit 65, `gateInput.safeParse` 실패 → 이슈별 메시지와 exit 65(`src/cli/commands/decision-conflict.ts:48-72`). 셋 다 USAGE_ERROR로, 사용자 입력 오류를 런타임 실패와 구분한다.

게이트 통과 후 `status`를 우선순위로 접는다(`:74-80`): `blocked` → BLOCKED, 아니면 `needsApproval` → NEEDS APPROVAL, 아니면 `disclose` → DISCLOSE, 아니면 CLEAR. human 출력은 disposition마다 `adr_id (kind/level) → route: basis` 한 줄을 찍어 **basis를 반드시 노출**한다(`:85-89`, D2 집행). 끝에서 `blocked || needsApproval`이면 exit 1(`:91`) — 충돌이 조용히 진행되면 안 된다는 신호.

주의: `disclose`만 true인 경우(method align / prefer justify)는 exit 0이다. 공개는 하되 진행을 막지는 않는다 — 자동 정렬은 정상 진행이고, 다만 드러내야 할 뿐이다.

### `decisionConflictRequiresApproval` (예방 술어) — `src/core/gates.ts:1020-1022`

```ts
return conflicts.some((c) => c.kind !== 'prefer' && c.level === 'intent');
```

hard(forbid/require) + intent인 충돌이 하나라도 있으면 true. 이것이 autopilot 승인 게이트에 intent 충돌을 **앞당겨(front-load)** 붙이는 결정적 입력이다. 예방층(mutating 노드가 사용자 해결 전에 돌지 않게)과 Stop 훅 fail-closed 캐치가 짝을 이룬다(`src/core/gates.ts:1015-1019`).

### autopilot 루프 — carrier 쓰기 + 예방 소비

- **쓰기** (`src/core/autopilot-loop.ts:3178-3193`): `design` 노드가 owner-return으로 `decision_conflicts`를 비어있지 않게 반환하면, 루프가 `decision-conflict.json` carrier를 `mode:'autopilot'`으로 영속화한다. 비어있거나 부재면 carrier를 안 쓴다(backward compat — legacy design pass). 즉 감지의 SoT는 design 노드의 LLM 판단이고, 루프는 그것을 파일로 고정만 한다.
- **소비/예방** (`src/core/autopilot-loop.ts:2234-2253`): `planRequiresDecisionApproval`이 carrier를 읽어 `decisionConflictRequiresApproval`로 intent 충돌이면 승인 게이트를 pending으로 만든다. **읽기 실패/malformed → false(fail-open)**: 이 예방층은 일부러 fail-open이고, 진짜 fail-closed는 Stop 훅이 담당한다(`:2230-2232`).

### Stop 훅 — 경계 집행 (`src/hooks/stop.ts`)

- **읽기** (`:796-800`): 다른 ledger처럼 `decision-conflict.json`을 `readArtifact`로 읽어 absent → inert, malformed → fail-closed로 다룬다. malformed면 `:822`의 배열에 실려 `:825-830`에서 exit 2로 완료를 막는다.
- **force-continue 분류** (`decisionConflictForcesContinuation`, `:487-507`): 게이트를 돌려 disposition을 두 갈래로 쪼갠다. `block`·`ask_user` → **reasons**(강제 진행: 조용히 완료되면 안 되는 충돌), 나머지(align·justify) → **advisories**(비차단 공개). advisory도 반드시 출력에 실린다 — D2 투명성이 조용한 자동 준수를 금하기 때문(`:483-484`).
- **예방 캐치** (`:867-872`): pending mutating 노드가 있고 `decisionConflictRequiresApproval`이 true면 exit 0으로 YIELD(P2) — intent 충돌은 사용자만 풀 수 있으므로 완료 cascade를 건너뛰고 승인 화면으로 넘긴다.
- **공개 병합** (`:1023-1029`): `dc.reasons`는 차단 사유로, `dc.advisories`는 비차단 참고로 각각 병합돼 Stop 출력에 실린다.

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위(정적 코드 읽기, 테스트 미실행): CLI 진입, 순수 게이트, carrier 스키마, autopilot 루프의 쓰기·예방 경로, Stop 훅의 읽기·집행 경로.

- **route + disclose 정책**: 게이트 3분기와 CLI status/exit 매핑이 ADR-0020 D1·D2와 일치. `basis`가 인터페이스→disposition→출력까지 끊김 없이 운반된다(§5). 불일치 없음.
- **예방(fail-open) ↔ 캐치(fail-closed) 이중화**: `planRequiresDecisionApproval`은 malformed에서 false(예방 실패 허용), Stop 훅은 malformed에서 exit 2(캐치 fail-closed). 의도한 비대칭이며 주석에 근거가 명시돼 있다(`autopilot-loop.ts:2230-2232`). 일치.
- **CLI ↔ 파이프라인 관계**: **`decision-conflict gate` CLI는 파이프라인 안에서 호출되지 않는다.** grep 결과 loop·stop 훅은 `decisionConflictGate` 함수를 직접 부르고, CLI는 동일 게이트를 노출하는 별도 표면이다(§2 배선 외 호출 0건 확인). 즉 CLI는 host/에이전트가 충돌을 수동으로 라우팅·확인하거나 테스트하는 결정적 표면이지, autopilot 완료 판정 경로 자체는 아니다. 이것이 죽은 코드는 아니지만(루트에 배선·노출됨), "CLI를 부르면 autopilot이 차단된다"는 오해를 부를 수 있는 지점 — 실제 차단은 carrier 파일 + Stop 훅이 한다. (미확인: CLI `gate`의 실제 호출자가 host 지침/문서에서 어떻게 안내되는지는 이 조사 범위 밖.)
- **감지 계층의 부재는 by-design**: 이 커맨드도 게이트도 충돌을 *만들지* 않는다(D4). "충돌이 실제로 감지되는가"는 design 노드/host LLM 판단에 달렸고 코드로 강제되지 않는다 — ADR-20260628과 동형의 의도적 결정(코드 결박은 도달가능성까지, 내용 충분성은 의미 검사에 위임). 갭이 아니라 닫힌 결정.

## 7. 잠재 위험·부작용·재설계 시 고려점

- **감지 누락은 코드가 못 막는다.** 전체 가드레일은 host LLM이 충돌을 실제로 감지·선언해야 작동한다(D4). LLM이 충돌을 놓치면 carrier가 안 써지고, 게이트·Stop 훅은 조용히 통과시킨다. 이건 설계상 코드 영역 밖이지만, 재설계 시 감지율을 올리려면 검출 지침(planner/researcher/reviewer/deep-interview)의 품질이 유일한 레버다. `scripts/adr-guard.ts`의 grep 가드가 상보적 백스톱(단, 문법적 위반만).
- **`basis`의 내용 품질은 미검증.** 스키마는 `min(1)`만 강제(비어있지 않음). "근거가 충분한가"는 결정론 불가라 검사하지 않는다(ADR-20260628 철학). 빈약한 basis도 통과하므로, 공개의 실효성은 작성 품질에 의존한다(ADR-0020 D5의 "효과-형태 회귀는 작성 품질에 의존"과 동형). 재설계 시 보존해야 할 불변식: **basis를 per-class 구조 필드로 쪼개지 말 것** — free-text 무손실 채널이 의도된 설계이고, 구조화는 "산문엔 있는데 필드엔 누락"의 새 유실 표면을 만든다(ADR-20260628:31).
- **예방 fail-open의 의존성.** `planRequiresDecisionApproval`이 malformed carrier에서 false를 반환해도 안전한 이유는 오직 Stop 훅 fail-closed가 살아있기 때문이다(`autopilot-loop.ts:2230-2232`). 재설계로 Stop 훅의 malformed→exit2 캐치를 약화시키면 예방층의 fail-open이 실제 우회 구멍이 된다. **이 비대칭은 함께 보존해야 하는 불변식.**
- **mode 하드코딩.** 루프의 carrier 쓰기는 `mode:'autopilot'` 고정(`autopilot-loop.ts:3189`). interactive 경로에서 carrier를 통한 `ask_user` 라우팅이 실제로 파일 경유로 흐르는지는 이 조사에서 확인 못 함(미확인) — CLI로는 `--json`에 interactive를 넘길 수 있지만, autopilot 루프의 파일 쓰기 경로는 autopilot만 쓴다.
- **철회 조건(ADR-0020:38-41)**: intent false positive가 빈발하면 method 자동정렬 범위 확대 또는 검출 임계 상향. host LLM 분류 신뢰도가 낮아지면 typed constraint 필드(kind/scope/enforced_by)를 knowledge-record 스키마에 가산적으로 추가. 재설계 시 이 방향들이 열려 있다.
